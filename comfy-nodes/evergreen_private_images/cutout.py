"""Pinned local BiRefNet portrait matting. Never downloads, repairs or writes model files.

The installed ComfyUI-RMBG node is deliberately NOT used for private photos: it
downloads missing files from the network and rewrites the model's Python file
on every load. This adapter reads the same local files, refuses them unless
they are byte-for-byte the reviewed ones, runs them from memory and returns
pixels only. It claims a soft matte, never exact hair-level truth; a person
reviews the edges in Core.
"""
import hashlib
import importlib.abc
import importlib.util
import json
import os
import struct
import sys
import threading
from pathlib import Path

WORKFLOW = "birefnet-portrait-private-cutout-v1"
MODEL = "birefnet-portrait"
MIN_SIDE = 64
MAX_SIDE = 4096
MAX_INPUT_PIXELS = 2_500_000
PROCESS_SIDE = 1024
FOLDER = ("RMBG", "BiRefNet")
WEIGHTS = "BiRefNet-portrait.safetensors"
WEIGHT_BYTES = 884_878_856
# The model's Python is executed, so it is pinned by content: 1038lab/BiRefNet as
# installed on vidbox on 2026-11-13. These are public code facts. Re-review the
# no-download boundary (bb_pretrained stays False) before accepting other bytes.
CODE_SHA256 = {
    "birefnet.py": "bd2986cee78b6d649ba7464066a0ba393cc45910ba1cb413ed91ca8fbb226f86",
    "BiRefNet_config.py": "e7b8c2a74f6cea6a59553d517f71d47f2c1d90e670a13416af17c25fe2f3dc52",
}
MAX_CODE_BYTES = 1024 * 1024
_BUILD = threading.Lock()


class _ReviewedSource(importlib.abc.InspectLoader):
    """Loads a module from text that was already checked against its pinned digest. Never touches disk."""

    def __init__(self, source):
        self.source = source

    def get_source(self, fullname):
        return self.source


def _module(name, source):
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(name, _ReviewedSource(source)))
    sys.modules[name] = module
    module.__spec__.loader.exec_module(module)
    return module


def validate_dimensions(width, height):
    if (type(width) is not int or type(height) is not int
            or not MIN_SIDE <= width <= MAX_SIDE or not MIN_SIDE <= height <= MAX_SIDE
            or width * height > MAX_INPUT_PIXELS):
        raise ValueError("Private cut-out input exceeds its dimensions")


def model_directory(models_dir):
    return Path(models_dir).joinpath(*FOLDER)


def validate_asset(path, expected_bytes):
    """Bounded readiness check (same rule as upscale.validate_asset), not an inference test."""
    with open(path, "rb") as stream:
        stat = os.fstat(stream.fileno())
        if stat.st_size != expected_bytes or (hasattr(stat, "st_blocks") and stat.st_blocks * 512 < stat.st_size):
            raise ValueError("Pinned cut-out model is incomplete")
        raw = stream.read(8)
        if len(raw) != 8:
            raise ValueError("Invalid cut-out model header")
        length = struct.unpack("<Q", raw)[0]
        if not 2 <= length <= 1024 * 1024 or length + 8 >= stat.st_size:
            raise ValueError("Invalid cut-out model header")
        header = json.loads(stream.read(length))
        tensors = [v for k, v in header.items() if k != "__metadata__"]
        if not tensors or len(tensors) > 10000:
            raise ValueError("Invalid cut-out model tensors")
        data_bytes = stat.st_size - length - 8
        for tensor in tensors:
            offsets = tensor.get("data_offsets")
            if (not isinstance(offsets, list) or len(offsets) != 2
                    or any(type(x) is not int for x in offsets)
                    or not 0 <= offsets[0] < offsets[1] <= data_bytes):
                raise ValueError("Invalid cut-out model offsets")
        if max(t["data_offsets"][1] for t in tensors) != data_bytes or not any(stream.read(4096)):
            raise ValueError("Empty cut-out model data")


def checked_files(directory):
    """The reviewed code as text and the weights path, or ValueError. Reads only."""
    directory = Path(directory)
    sources = {}
    for name, digest in CODE_SHA256.items():
        file = directory / name
        if not file.is_file() or file.stat().st_size > MAX_CODE_BYTES:
            raise ValueError("Cut-out model code unavailable")
        data = file.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("Cut-out model code needs compatibility review")
        sources[name] = data.decode("utf-8")
    weights = directory / WEIGHTS
    validate_asset(weights, WEIGHT_BYTES)
    return sources, weights


def ready(directory):
    try:
        checked_files(directory)
        return True
    except (OSError, ValueError, TypeError, AttributeError, KeyError, UnicodeDecodeError):
        return False


def build_model(sources):
    """Run the two reviewed files from memory and construct the network.

    Nothing is written to disk. The model file imports its config by module
    name and registers its backbones through timm by module name, so both names
    are present in sys.modules only while it executes, then put back as found.
    """
    with _BUILD:
        saved = {name: sys.modules.get(name) for name in ("BiRefNet_config", "birefnet")}
        try:
            config = _module("BiRefNet_config", sources["BiRefNet_config.py"])
            module = _module("birefnet", sources["birefnet.py"].replace("from .BiRefNet_config", "from BiRefNet_config"))
            # bb_pretrained=False: the backbone is built empty and filled from the pinned weights only.
            return module.BiRefNet(config.BiRefNetConfig(bb_pretrained=False))
        finally:
            for name, previous in saved.items():
                if previous is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = previous


def _predict_alpha(directory, rgb):
    """rgb: uint8 HxWx3. Returns float32 HxW in 0..1. Loads the pinned model for this one call."""
    import numpy as np
    import torch
    import torch.nn.functional as F
    from safetensors.torch import load_file

    sources, weights = checked_files(directory)
    model = build_model(sources)
    try:
        model.load_state_dict(load_file(str(weights)))
        model.eval()
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
        height, width = rgb.shape[:2]
        pixels = torch.from_numpy(np.ascontiguousarray(rgb)).to(device).permute(2, 0, 1)[None].float() / 255.0
        pixels = F.interpolate(pixels, size=(PROCESS_SIDE, PROCESS_SIDE), mode="bicubic", align_corners=False, antialias=True).clamp(0, 1)
        mean = torch.tensor([0.485, 0.456, 0.406], device=device).view(1, 3, 1, 1)
        std = torch.tensor([0.229, 0.224, 0.225], device=device).view(1, 3, 1, 1)
        pixels = (pixels - mean) / std
        if device != "cpu":
            model = model.half().to(device)
            pixels = pixels.half()
        with torch.no_grad():
            matte = model(pixels)[-1].sigmoid().float()
        matte = F.interpolate(matte, size=(height, width), mode="bicubic", align_corners=False).clamp(0, 1)
        return matte[0, 0].cpu().numpy().astype(np.float32)
    finally:
        del model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def estimate_foreground(rgb, alpha):
    """Colours for the kept pixels with the old background's tint removed from soft edges.

    rgb: float32 HxWx3 in 0..1, alpha: float32 HxW in 0..1. The published
    blur-fusion estimate (two passes); it changes colour only, never the matte.
    """
    import cv2
    import numpy as np

    def fuse(image, foreground, background, matte, radius):
        blurred = cv2.blur(matte, (radius, radius))[:, :, None]
        near = cv2.blur(foreground * matte, (radius, radius)) / (blurred + 1e-5)
        far = cv2.blur(background * (1 - matte), (radius, radius)) / ((1 - blurred) + 1e-5)
        estimate = near + matte * (image - matte * near - (1 - matte) * far)
        return np.clip(estimate, 0, 1), far

    matte = alpha[:, :, None].astype(np.float32)
    image = rgb.astype(np.float32)
    first, behind = fuse(image, image, image, matte, 90)
    return fuse(image, first, behind, matte, 6)[0].astype(np.float32)


def run(image, manifest, directory, predictor=None):
    """image: one RGB picture, shape (1, height, width, 3), values 0..1. Returns (1, height, width, 4)."""
    import numpy as np

    width, height = manifest["width"], manifest["height"]
    validate_dimensions(width, height)
    if manifest.get("operation") != "cutout" or manifest.get("workflow") != WORKFLOW:
        raise ValueError("Invalid pinned cut-out operation")
    if tuple(image.shape) != (1, height, width, 3):
        raise ValueError("Invalid cut-out input tensor")
    tensor = hasattr(image, "cpu")
    source = np.asarray(image[0].cpu() if tensor else image[0], dtype=np.float32)
    if not np.isfinite(source).all():
        raise ValueError("Invalid cut-out input values")
    source = np.clip(source, 0, 1)
    rgb = np.clip(source * 255.0 + 0.5, 0, 255).astype(np.uint8)
    alpha = (predictor or (lambda pixels: _predict_alpha(directory, pixels)))(rgb)
    alpha = np.asarray(alpha, dtype=np.float32)
    if alpha.shape != (height, width) or not np.isfinite(alpha).all():
        raise ValueError("Private cut-out matte dimensions changed")
    alpha = np.clip(alpha, 0, 1)
    colours = estimate_foreground(source, alpha)
    pixels = np.concatenate([colours, alpha[:, :, None]], axis=2).astype(np.float32)[None, ...]
    if pixels.shape != (1, height, width, 4):
        raise ValueError("Private cut-out output dimensions changed")
    if tensor:
        import torch
        return torch.from_numpy(pixels)
    return pixels
