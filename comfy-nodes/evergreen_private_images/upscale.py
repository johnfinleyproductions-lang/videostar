"""Pinned local SeedVR2 adapter. Never downloads, repairs or writes model files."""
import hashlib
import inspect
import json
import os
from pathlib import Path
import struct
from types import FunctionType

WORKFLOW = "seedvr2-private-upscale-2x-v1"
MODEL = "seedvr2-7b-sharp-fp8"
MAX_INPUT_PIXELS = 3_000_000
MAX_OUTPUT_PIXELS = 12_000_000
MIN_SIDE = 16
MAX_SIDE = 8192
DIT = "seedvr2_ema_7b_sharp_fp8_e4m3fn.safetensors"
VAE = "ema_vae_fp16.safetensors"
# Installed SeedVR2 2.5.24 / 4490bd1f. Re-review the no-download boundary before
# accepting another upstream implementation. These are public code/asset facts.
EXECUTE_SHA256 = "30d144924af59d6f8f57a5867f748f6003eb0a6910ebd11c3e481f6a44bfeeac"
ASSET_BYTES = {DIT: 8_239_729_704, VAE: 501_324_814}
EMBEDDING_SHA256 = {
    "pos_emb.pt": "fa07a14844314772266b66c3b95deb0027696d8fe7065721263db5176f45d799",
    "neg_emb.pt": "6a43e5800ef2354f1c156d27535834da055cbec8248298b8923492bba2076581",
}


def validate_dimensions(width, height):
    if (type(width) is not int or type(height) is not int
            or not MIN_SIDE <= width <= MAX_SIDE or not MIN_SIDE <= height <= MAX_SIDE
            or width * height > MAX_INPUT_PIXELS):
        raise ValueError("Private 2x upscale input exceeds its dimensions")


def validate_asset(path, expected_bytes):
    """Bounded readiness check, not a substitute for the release inference test."""
    with open(path, "rb") as stream:
        stat = os.fstat(stream.fileno())
        if stat.st_size != expected_bytes or (hasattr(stat, "st_blocks") and stat.st_blocks * 512 < stat.st_size):
            raise ValueError("Pinned upscale model is incomplete")
        raw = stream.read(8)
        if len(raw) != 8:
            raise ValueError("Invalid upscale model header")
        length = struct.unpack("<Q", raw)[0]
        if not 2 <= length <= 1024 * 1024 or length + 8 >= stat.st_size:
            raise ValueError("Invalid upscale model header")
        header = json.loads(stream.read(length))
        tensors = [v for k, v in header.items() if k != "__metadata__"]
        if not tensors or len(tensors) > 10000:
            raise ValueError("Invalid upscale model tensors")
        data_bytes = stat.st_size - length - 8
        for tensor in tensors:
            offsets = tensor.get("data_offsets")
            if (not isinstance(offsets, list) or len(offsets) != 2
                    or any(type(x) is not int for x in offsets)
                    or not 0 <= offsets[0] < offsets[1] <= data_bytes):
                raise ValueError("Invalid upscale model offsets")
        if max(t["data_offsets"][1] for t in tensors) != data_bytes or not any(stream.read(4096)):
            raise ValueError("Empty upscale model data")


def checked_implementation(node):
    fn = getattr(getattr(node, "execute", None), "__func__", None)
    if not isinstance(fn, FunctionType):
        raise ValueError("Pinned upscale implementation unavailable")
    path = inspect.getsourcefile(fn)
    if not path or hashlib.sha256(Path(path).read_bytes()).hexdigest() != EXECUTE_SHA256:
        raise ValueError("Upscale implementation needs compatibility review")
    required = {"cls", "image", "dit", "vae", "seed", "resolution", "max_resolution", "batch_size",
        "uniform_batch_size", "color_correction", "temporal_overlap", "prepend_frames", "input_noise_scale",
        "latent_noise_scale", "offload_device", "enable_debug"}
    if set(inspect.signature(fn).parameters) != required:
        raise ValueError("Upscale implementation inputs changed")
    download = fn.__globals__.get("download_weight")
    finder = getattr(download, "__globals__", {}).get("find_model_file")
    if not callable(finder):
        raise ValueError("Upscale model resolver unavailable")
    for name, size in ASSET_BYTES.items():
        validate_asset(finder(name), size)
    root = Path(path).resolve().parents[2]
    for name, digest in EMBEDDING_SHA256.items():
        embedding = root / name
        if not embedding.is_file() or embedding.stat().st_size > 1024 * 1024:
            raise ValueError("Upscale embeddings unavailable")
        if hashlib.sha256(embedding.read_bytes()).hexdigest() != digest:
            raise ValueError("Upscale embeddings changed")
    return fn, finder


def ready(node):
    try:
        checked_implementation(node)
        return True
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        return False


def run(node, image, manifest):
    width, height = manifest["width"], manifest["height"]
    validate_dimensions(width, height)
    if manifest.get("operation") != "upscale" or manifest.get("workflow") != WORKFLOW:
        raise ValueError("Invalid pinned upscale operation")
    if tuple(image.shape) != (1, height, width, 3):
        raise ValueError("Invalid upscale input tensor")
    fn, finder = checked_implementation(node)

    def installed_only(dit_model, vae_model, model_dir=None, debug=None):
        if dit_model != DIT or vae_model != VAE:
            raise ValueError("Unpinned upscale model")
        for name, size in ASSET_BYTES.items():
            validate_asset(finder(name), size)
        return True

    # Upstream always calls download_weight, which can DELETE and redownload a
    # corrupt file. Clone its reviewed function with one local global replaced;
    # never monkeypatch the shared module or invoke its downloader.
    local_globals = {**fn.__globals__, "download_weight": installed_only}
    invoke = FunctionType(fn.__code__, local_globals, fn.__name__, fn.__defaults__, fn.__closure__)
    invoke.__kwdefaults__ = fn.__kwdefaults__
    dit = {"model": DIT, "device": "cuda:0", "offload_device": "cpu", "cache_model": False,
        "blocks_to_swap": 0, "swap_io_components": False, "attention_mode": "sdpa",
        "torch_compile_args": None, "node_id": manifest["id"] + ":dit"}
    vae = {"model": VAE, "device": "cuda:0", "offload_device": "cpu", "cache_model": False,
        "encode_tiled": True, "encode_tile_size": 512, "encode_tile_overlap": 64,
        "decode_tiled": True, "decode_tile_size": 512, "decode_tile_overlap": 64,
        "tile_debug": "false", "torch_compile_args": None, "node_id": manifest["id"] + ":vae"}
    output = invoke(node, image=image, dit=dit, vae=vae, seed=manifest["seed"],
        resolution=2 * min(width, height), max_resolution=2 * max(width, height),
        batch_size=1, uniform_batch_size=False, color_correction="lab", temporal_overlap=0,
        prepend_frames=0, input_noise_scale=0.0, latent_noise_scale=0.0,
        offload_device="cpu", enable_debug=False)
    if (getattr(output, "ui", None) or getattr(output, "expand", None)
            or getattr(output, "block_execution", None)):
        raise ValueError("Private upscale must return pixels only")
    pixels = output[0]
    if tuple(pixels.shape) != (1, height * 2, width * 2, 3):
        raise ValueError("Private upscale output dimensions changed")
    return pixels
