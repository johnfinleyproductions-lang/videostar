"""Bounded private frame transport; it never accepts codecs, paths or prompts.

Each upload and output is authenticated by the immutable request. A separate
directory and quota leave the photo store's limits and identities unchanged.
"""
import hashlib
import io
import json
import re
import secrets
import shutil

import numpy as np
from PIL import Image
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .store import PrivateJobs, TTL_SECONDS, canonical, job_id

PROTOCOL = "evergreen-private-video-v1"
WORKFLOW = "sam2.1-small-private-track-v1"
MODEL = "sam2.1-small"
MODEL_SHA256 = "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38"
IMPLEMENTATION_SHA256 = "d1adec4f4bec6d4edbe8d45bd277c7ddc3573af60cf9bf48dd60d187d2758691"
MAX_FRAME_BYTES = 2 * 1024 * 1024
MAX_SEED_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 120 * 1024 * 1024
MAX_LIVE_JOBS = 4
MAX_JOBS = 1000
MAX_FRAMES = 90
MAX_SIDE = 640
MAX_METADATA_BYTES = 64 * 1024
UPLOAD_TTL = 15 * 60
HEX = re.compile(r"[a-f0-9]{64}")


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("Invalid private video integer")
    return value


def exact_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys.split()):
        raise ValueError("Invalid private video fields")


def digest(value):
    if not isinstance(value, str) or HEX.fullmatch(value) is None:
        raise ValueError("Invalid private video digest")
    return value


def validate_request(value):
    exact_keys(value, "id version workflow sourceSha256 width height timeBase clipStartPts clipEndPts frameCount startFrame frames seed")
    job_id(value["id"])
    if type(value["version"]) is not int or value["version"] != 1 or value["workflow"] != WORKFLOW:
        raise ValueError("Unsupported private video workflow")
    digest(value["sourceSha256"])
    for key in ["width", "height"]:
        integer(value[key], 16, MAX_SIDE)
    exact_keys(value["timeBase"], "num den")
    num = integer(value["timeBase"]["num"], 1, 1_000_000_000)
    den = integer(value["timeBase"]["den"], 1, 1_000_000_000)
    integer(value["clipStartPts"], 0, 0)
    end = integer(value["clipEndPts"], 1, 9_007_199_254_740_991)
    if end * num > 3 * den:
        raise ValueError("Private video exceeds three seconds")
    count = integer(value["frameCount"], 2, MAX_FRAMES)
    start = integer(value["startFrame"], 0, count - 1)
    if not isinstance(value["frames"], list) or len(value["frames"]) != count - start:
        raise ValueError("Private video requires every suffix frame")
    previous_end = None
    total = 0
    for index, frame in enumerate(value["frames"], start):
        exact_keys(frame, "index pts duration sha256 byteLength")
        integer(frame["index"], index, index)
        pts = integer(frame["pts"], 0, end - 1)
        duration = integer(frame["duration"], 1, end)
        if (index == 0 and pts != 0) or (previous_end is not None and pts != previous_end):
            raise ValueError("Private video timing must be contiguous")
        previous_end = pts + duration
        if previous_end > end:
            raise ValueError("Private video frame exceeds clip timing")
        digest(frame["sha256"])
        total += integer(frame["byteLength"], 1, MAX_FRAME_BYTES)
    if previous_end != end or total > MAX_TOTAL_BYTES:
        raise ValueError("Invalid private video extent")
    exact_keys(value["seed"], "sha256 byteLength")
    digest(value["seed"]["sha256"])
    integer(value["seed"]["byteLength"], 1, MAX_SEED_BYTES)
    if len(canonical(value)) > MAX_METADATA_BYTES:
        raise ValueError("Private video metadata exceeds its limit")
    return value


def validate_png(data, width, height, kind):
    limit = MAX_SEED_BYTES if kind in {"seed", "mask"} else MAX_FRAME_BYTES
    if not isinstance(data, bytes) or not data or len(data) > limit or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Private video requires bounded PNGs")
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "PNG" or getattr(image, "n_frames", 1) != 1 or image.size != (width, height):
            raise ValueError("Private video geometry mismatch")
        if image.mode != ("L" if kind == "mask" else "RGB"):
            raise ValueError("Private video requires canonical pixels")
        image.load()
        if kind in {"seed", "mask"}:
            pixels = np.asarray(image)
            if kind == "seed":
                if not np.array_equal(pixels[:, :, 0], pixels[:, :, 1]) or not np.array_equal(pixels[:, :, 0], pixels[:, :, 2]):
                    raise ValueError("Private video seed must be grayscale")
                pixels = pixels[:, :, 0]
            if not np.logical_or(pixels == 0, pixels == 255).all():
                raise ValueError("Private video masks must be binary")
            if kind == "seed" and (not np.any(pixels == 0) or not np.any(pixels == 255)):
                raise ValueError("Review a nonempty subject and background")


class VideoJobs(PrivateJobs):
    def __init__(self, root, key_file, clock=None):
        super().__init__(root, key_file, **({"clock": clock} if clock is not None else {}))
        self.cipher = AESGCM(hashlib.sha256(("video-files:" + self.token).encode()).digest())
        self.sign_key = hashlib.sha256(("video-graphs:" + self.token).encode()).digest()

    @staticmethod
    def _slot_limit(slot):
        if slot in {"request", "output"}:
            return MAX_METADATA_BYTES
        if slot == "seed" or re.fullmatch(r"mask-(?:0|[1-8]?[0-9])", slot):
            return MAX_SEED_BYTES
        if re.fullmatch(r"frame-(?:0|[1-8]?[0-9])", slot):
            return MAX_FRAME_BYTES
        raise ValueError("Invalid private video slot")

    def _write_blob(self, identity, slot, contents):
        if not contents or len(contents) > self._slot_limit(slot):
            raise ValueError("Private video payload exceeds its limit")
        nonce = secrets.token_bytes(12)
        aad = (identity + ":" + slot).encode()
        self._atomic(self._directory(identity) / (slot + ".sealed"), nonce + self.cipher.encrypt(nonce, contents, aad))

    def read_blob(self, identity, slot):
        limit = self._slot_limit(slot)
        with self.lock:
            manifest = self._manifest(identity)
            if manifest["expiresAt"] <= self.clock() or manifest["state"] not in {"uploading", "processing", "completed"}:
                raise KeyError("Private video is unavailable")
            file = self._directory(identity) / (slot + ".sealed")
            if file.is_symlink() or file.stat().st_size > limit + 28:
                raise ValueError("Invalid private video payload")
            encrypted = file.read_bytes()
            return self.cipher.decrypt(encrypted[:12], encrypted[12:], (identity + ":" + slot).encode())

    def request(self, identity):
        manifest = self._manifest(identity)
        if manifest.get("modelSha256") != MODEL_SHA256 or manifest.get("implementationSha256") != IMPLEMENTATION_SHA256:
            raise ValueError("Pinned video model identity changed")
        return validate_request(json.loads(self.read_blob(identity, "request")))

    def reserve_video(self, request):
        validate_request(request)
        identity = request["id"]
        encoded = canonical(request)
        provenance = {"modelSha256": MODEL_SHA256, "implementationSha256": IMPLEMENTATION_SHA256}
        request_hash = hashlib.sha256(canonical({**request, **provenance})).hexdigest()
        with self.lock:
            self.expire()
            directory = self._directory(identity)
            if directory.exists():
                existing = self._manifest(identity)
                if existing["requestHash"] != request_hash:
                    raise ValueError("Video job identity belongs to different inputs")
                return existing, False
            directories = list(self.root.iterdir())
            if len(directories) >= MAX_JOBS or sum(self._manifest(d.name)["state"] in {"uploading", "processing", "completed"} for d in directories) >= MAX_LIVE_JOBS:
                raise ValueError("Private video quota is full")
            directory.mkdir(mode=0o700)
            try:
                self._write_blob(identity, "request", encoded)
                manifest = {"id": identity, "requestHash": request_hash, "state": "uploading", "operation": "video-tracking",
                    **provenance,
                    "workflow": WORKFLOW, "createdAt": self.clock(), "expiresAt": self.clock() + UPLOAD_TTL,
                    "uploadedFrames": [], "seedReceived": False, "totalFrames": len(request["frames"])}
                self._save_manifest(identity, manifest)
                return manifest, True
            except BaseException:
                shutil.rmtree(directory)
                raise

    def upload(self, identity, data, index=None):
        with self.lock:
            manifest = self.status(identity)
            if manifest["state"] != "uploading":
                raise ValueError("Private video upload is closed")
            request = self.request(identity)
            if index is None:
                descriptor, slot, kind = request["seed"], "seed", "seed"
            else:
                integer(index, request["startFrame"], request["frameCount"] - 1)
                descriptor, slot, kind = request["frames"][index - request["startFrame"]], f"frame-{index}", "frame"
            if len(data) != descriptor["byteLength"] or hashlib.sha256(data).hexdigest() != descriptor["sha256"]:
                raise ValueError("Private video upload does not match its receipt")
            validate_png(data, request["width"], request["height"], kind)
            self._write_blob(identity, slot, data)
            if index is None:
                manifest["seedReceived"] = True
            else:
                manifest["uploadedFrames"] = sorted(set(manifest["uploadedFrames"]) | {index})
            self._save_manifest(identity, manifest)

    def authorize_graph(self, identity, graph):
        with self.lock:
            manifest = self.status(identity)
            if manifest["state"] != "uploading":
                raise ValueError("Private video is already queued or closed")
            request = self.request(identity)
            if not manifest["seedReceived"] or manifest["uploadedFrames"] != [f["index"] for f in request["frames"]]:
                raise ValueError("Private video upload is incomplete")
            # Re-read every sealed input before admission; reject corruption or
            # a write interrupted before its manifest receipt was durable.
            for slot, descriptor, kind in [("seed", request["seed"], "seed"), *[(f"frame-{f['index']}", f, "frame") for f in request["frames"]]]:
                data = self.read_blob(identity, slot)
                if len(data) != descriptor["byteLength"] or hashlib.sha256(data).hexdigest() != descriptor["sha256"]:
                    raise ValueError("Private video input changed")
                validate_png(data, request["width"], request["height"], kind)
            manifest["expiresAt"] = self.clock() + TTL_SECONDS
            self._save_manifest(identity, manifest)
            return super().authorize_graph(identity, graph)

    def progress(self, identity, completed_frames):
        with self.lock:
            manifest = self._manifest(identity)
            if manifest["state"] != "processing" or manifest["expiresAt"] <= self.clock():
                raise ValueError("Private video processing is closed")
            integer(completed_frames, 0, manifest["totalFrames"])
            previous = manifest.get("completedFrames", 0)
            if completed_frames < previous:
                raise ValueError("Private video progress cannot go backward")
            manifest["completedFrames"] = completed_frames
            self._save_manifest(identity, manifest)

    def save_mask(self, identity, index, data):
        with self.lock:
            manifest = self._manifest(identity)
            if manifest["state"] != "processing" or manifest["expiresAt"] <= self.clock():
                raise ValueError("Private video output is closed")
            request = self.request(identity)
            integer(index, request["startFrame"], request["frameCount"] - 1)
            validate_png(data, request["width"], request["height"], "mask")
            self._write_blob(identity, f"mask-{index}", data)

    def finish_video(self, identity):
        with self.lock:
            request = self.request(identity)
            output = {key: request[key] for key in ["version", "workflow", "sourceSha256", "width", "height", "timeBase", "clipStartPts", "clipEndPts", "frameCount", "startFrame"]}
            output.update(modelSha256=MODEL_SHA256, implementationSha256=IMPLEMENTATION_SHA256)
            masks = []
            for frame in request["frames"]:
                data = self.read_blob(identity, f"mask-{frame['index']}")
                validate_png(data, request["width"], request["height"], "mask")
                masks.append({"index": frame["index"], "pts": frame["pts"], "duration": frame["duration"],
                    "sha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data)})
            output["masks"] = masks
            super().complete(identity, canonical(output))

    def _remove_payloads(self, identity, keep_output=False):
        for file in self._directory(identity).iterdir():
            keep = keep_output and (file.name == "output.sealed" or re.fullmatch(r"mask-(?:0|[1-8]?[0-9])\.sealed", file.name))
            if file.name != "manifest.json" and not keep:
                if file.is_dir() or file.is_symlink():
                    raise ValueError("Unexpected private video storage object")
                file.unlink()

    def erase(self, identity, state="consumed"):
        with self.lock:
            try:
                return super().erase(identity, state)
            except KeyError:
                # Core may erase while an earlier reserve request is still in
                # flight. Persist a terminal identity even before reservation,
                # so that late request cannot recreate private upload state.
                self.expire()
                if len(list(self.root.iterdir())) >= MAX_JOBS:
                    raise ValueError("Private video tombstone quota is full")
                directory = self._directory(identity)
                directory.mkdir(mode=0o700)
                manifest = {"id": identity, "requestHash": None, "state": state,
                    "operation": "video-tracking", "workflow": WORKFLOW,
                    "createdAt": self.clock(), "expiresAt": self.clock(),
                    "modelSha256": MODEL_SHA256,
                    "implementationSha256": IMPLEMENTATION_SHA256}
                try:
                    self._save_manifest(identity, manifest)
                except BaseException:
                    shutil.rmtree(directory)
                    raise
                return manifest

    def reconcile_restart(self):
        super().reconcile_restart()
        # Completion may have persisted its receipt just before power loss.
        # Keep only committed masks/output; do not retain orphaned input frames.
        with self.lock:
            for directory in self.root.iterdir():
                if self._manifest(directory.name)["state"] == "completed":
                    self._remove_payloads(directory.name, keep_output=True)
