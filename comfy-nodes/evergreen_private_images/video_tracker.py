"""Pinned SAM2 video tracking with private, lazy, in-memory frame decoding.

No from_pretrained, codecs, temporary JPEGs, compilation or global predictor
cache. SAM2 supplies segmentation masks, not hair-quality alpha matting.
"""
from collections import OrderedDict
import gc
import hashlib
import importlib
import inspect
import io
from pathlib import Path
import sys
import types

import numpy as np
from PIL import Image

from .video_store import validate_png, MODEL_SHA256, IMPLEMENTATION_SHA256

CHECKPOINT = "sam2.1_hiera_small.pt"
CHECKPOINT_BYTES = 184416285
CHECKPOINT_SHA256 = MODEL_SHA256
SOURCE_SHA256 = IMPLEMENTATION_SHA256
CONFIG = "configs/sam2.1/sam2.1_hiera_s.yaml"
_verified_assets = None


def asset_paths():
    import folder_paths
    root = Path(folder_paths.__file__).resolve().parent
    return root / "custom_nodes/ComfyUI-RMBG/models/sam2", root / "models/sam2" / CHECKPOINT


def verified_assets():
    """Cache public asset hashes only; changed inode/size/mtime forces recheck."""
    global _verified_assets
    source, checkpoint = asset_paths()
    files = sorted(p for p in source.rglob("*") if p.suffix in {".py", ".yaml"})
    if len(files) != 27 or not checkpoint.is_file() or checkpoint.stat().st_size != CHECKPOINT_BYTES:
        raise ValueError("Pinned private tracker assets unavailable")
    paths = [*files, checkpoint]
    if any(p.is_symlink() or not p.is_file() or any(parent.is_symlink() for parent in p.parents) for p in paths):
        raise ValueError("Pinned tracker assets cannot be linked")
    signature = tuple((str(p), p.stat().st_ino, p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ctime_ns) for p in paths)
    if _verified_assets != signature:
        rows = [str(p.relative_to(source)) + ":" + hashlib.sha256(p.read_bytes()).hexdigest() for p in files]
        if hashlib.sha256(("\n".join(rows) + "\n").encode()).hexdigest() != SOURCE_SHA256:
            raise ValueError("Pinned tracker implementation changed")
        with checkpoint.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != CHECKPOINT_SHA256:
                raise ValueError("Pinned tracker checkpoint changed")
        _verified_assets = signature
    return source, checkpoint


def ready():
    try:
        verified_assets()
        return True
    except (OSError, ValueError, AttributeError, ImportError):
        return False


def clone_function(function, overrides):
    """Inject a private loader/progress iterator without patching shared code."""
    original = inspect.unwrap(function)
    return types.FunctionType(original.__code__, {**original.__globals__, **overrides},
        original.__name__, original.__defaults__, original.__closure__)


class PrivateFrames:
    def __init__(self, jobs, identity, request, image_size):
        self.jobs, self.identity, self.request = jobs, identity, request
        self.image_size = image_size
        self.cache = OrderedDict()

    def __len__(self):
        return len(self.request["frames"])

    def __getitem__(self, local_index):
        import torch
        if type(local_index) is not int or not 0 <= local_index < len(self):
            raise IndexError("Private frame index unavailable")
        if local_index not in self.cache:
            frame = self.request["frames"][local_index]
            data = self.jobs.read_blob(self.identity, f"frame-{frame['index']}")
            if hashlib.sha256(data).hexdigest() != frame["sha256"]:
                raise ValueError("Private frame receipt changed")
            validate_png(data, self.request["width"], self.request["height"], "frame")
            with Image.open(io.BytesIO(data)) as image:
                # Matches the pinned SAM2 RGB loader, with no JPEG conversion.
                pixels = np.array(image.resize((self.image_size, self.image_size)), dtype=np.float32) / 255.0
            tensor = torch.from_numpy(pixels).permute(2, 0, 1)
            tensor = (tensor - torch.tensor([0.485, 0.456, 0.406])[:, None, None]) / torch.tensor([0.229, 0.224, 0.225])[:, None, None]
            self.cache[local_index] = tensor
            while len(self.cache) > 2:
                self.cache.popitem(last=False)
        return self.cache[local_index]

    def clear(self):
        self.cache.clear()
        self.jobs = self.request = None


def create_predictor(source, checkpoint, device):
    import torch
    from hydra.utils import instantiate
    from omegaconf import OmegaConf
    # RMBG loads this package already in the serving process. The fallback path
    # is server-owned and source-hash-verified, never supplied by a request.
    if "sam2" not in sys.modules:
        sys.path.insert(0, str(source.parent))
        try:
            importlib.import_module("sam2")
        finally:
            sys.path.remove(str(source.parent))
    if Path(sys.modules["sam2"].__file__).resolve() != source / "__init__.py":
        raise ValueError("Unexpected SAM2 package implementation")
    cfg = OmegaConf.load(source / CONFIG)
    cfg.model._target_ = "sam2.sam2_video_predictor.SAM2VideoPredictor"
    cfg.model.compile_image_encoder = False
    cfg.model.fill_hole_area = 0  # no optional compiled extension or fallback
    cfg.model.binarize_mask_from_pts_for_mem_enc = True
    cfg.model.sam_mask_decoder_extra_args = {
        "dynamic_multimask_via_stability": True,
        "dynamic_multimask_stability_delta": 0.05,
        "dynamic_multimask_stability_thresh": 0.98,
    }
    model = instantiate(cfg.model, _recursive_=True)
    weights = torch.load(checkpoint, map_location="cpu", weights_only=True)["model"]
    model.load_state_dict(weights, strict=True)
    del weights
    return model.eval().to(device)


def track(jobs, identity):
    import torch
    import comfy.model_management
    source, checkpoint = verified_assets()
    request = jobs.request(identity)
    device = comfy.model_management.get_torch_device()
    if device.type != "cuda":
        raise ValueError("The private video tracker requires its configured GPU")
    # Normal Comfy memory admission on its serialized GPU queue; no tenant
    # launcher, public workflow, network call or model download is involved.
    comfy.model_management.free_memory(6 * 1024 ** 3, device)
    model = state = frames = generator = None
    try:
        model = create_predictor(source, checkpoint, device)
        frames = PrivateFrames(jobs, identity, request, model.image_size)

        def private_loader(**kwargs):
            if kwargs.get("video_path") is not frames or not kwargs.get("offload_video_to_cpu"):
                raise ValueError("Private frame loader binding changed")
            return frames, request["height"], request["width"]

        init = clone_function(type(model).init_state, {"load_video_frames": private_loader})
        propagate = clone_function(type(model).propagate_in_video, {"tqdm": lambda values, **kwargs: values})
        seed_data = jobs.read_blob(identity, "seed")
        if hashlib.sha256(seed_data).hexdigest() != request["seed"]["sha256"]:
            raise ValueError("Private seed receipt changed")
        validate_png(seed_data, request["width"], request["height"], "seed")
        with Image.open(io.BytesIO(seed_data)) as image:
            seed = np.array(image, dtype=np.uint8)[:, :, 0]
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            state = init(model, frames, offload_video_to_cpu=True, offload_state_to_cpu=True, async_loading_frames=False)
            model.add_new_mask(state, frame_idx=0, obj_id=1, mask=torch.from_numpy(seed == 255))
            jobs.progress(identity, 0)
            generator = propagate(model, state, start_frame_idx=0, max_frame_num_to_track=len(frames), reverse=False)
            received = 0
            for local_index, object_ids, logits in generator:
                if local_index != received or list(object_ids) != [1] or tuple(logits.shape) != (1, 1, request["height"], request["width"]):
                    raise ValueError("Private tracker frame correspondence changed")
                if not torch.isfinite(logits).all().item():
                    raise ValueError("Private tracker produced nonfinite masks")
                # Keep the exact reviewed seed; predicted empty masks on later
                # occluded frames are legitimate and never become full-frame.
                pixels = seed if local_index == 0 else (logits[0, 0] > 0).to(torch.uint8).cpu().numpy() * 255
                output = io.BytesIO()
                Image.fromarray(pixels).save(output, format="PNG")
                jobs.save_mask(identity, request["startFrame"] + local_index, output.getvalue())
                received += 1
                jobs.progress(identity, received)
            if received != len(frames):
                raise ValueError("Private tracker omitted a frame")
        jobs.finish_video(identity)
    finally:
        if generator is not None:
            generator.close()
        if state is not None:
            state.clear()
        if frames is not None:
            frames.clear()
        model = state = generator = frames = None
        gc.collect()
        comfy.model_management.soft_empty_cache()
