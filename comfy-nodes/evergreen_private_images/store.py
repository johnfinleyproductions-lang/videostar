"""Private job files: encrypted, bounded, idempotent, and removed on ack/expiry.

Only trusted server code calls this store. UUIDs are identities, never paths.
The Comfy graph contains no photo bytes, plaintext instruction, or file names.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import stat
import threading
import time
import uuid
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAX_BYTES = 20 * 1024 * 1024
TTL_SECONDS = 24 * 60 * 60
MAX_JOBS = 1000
SLOTS = {"source", "reference", "reference2", "instruction", "output"}


def job_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Invalid job identity")
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


class PrivateJobs:
    def __init__(self, root, key_file, clock=time.time):
        self.root = Path(root)
        self.key_file = Path(key_file)
        self.clock = clock
        self.lock = threading.RLock()
        self._private_directory(self.root)
        if not self.key_file.is_absolute() or any(parent.is_symlink() for parent in self.key_file.parents):
            raise ValueError("The private image key requires an absolute path without symlink ancestors")
        key_stat = self.key_file.lstat()
        if not stat.S_ISREG(key_stat.st_mode) or key_stat.st_uid != os.getuid() or key_stat.st_mode & 0o077:
            raise ValueError("The private image key must be an owner-only regular file")
        token = self.key_file.read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{64}", token):
            raise ValueError("The private image key must contain a 256-bit token")
        self.token = token
        self.cipher = AESGCM(hashlib.sha256(("image-files:" + token).encode()).digest())
        self.sign_key = hashlib.sha256(("image-graphs:" + token).encode()).digest()
        self.reconcile_restart()

    @staticmethod
    def _private_directory(directory):
        if not directory.is_absolute():
            raise ValueError("Private storage requires an absolute path")
        # Refuse symlinks in every ancestor as well as the root itself.
        for parent in [directory, *directory.parents]:
            if parent.is_symlink():
                raise ValueError("Private storage cannot use symlink directories")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Private storage must be an owner-only directory")

    def authenticated(self, authorization):
        return hmac.compare_digest(authorization or "", "Bearer " + self.token)

    @staticmethod
    def _atomic(file, contents):
        temporary = file.parent / (".writing-" + str(uuid.uuid4()))
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(contents)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, file)
            directory = os.open(file.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)

    def _directory(self, identity):
        directory = self.root / job_id(identity)
        if directory.exists():
            self._private_directory(directory)
        return directory

    def _manifest(self, identity):
        file = self._directory(identity) / "manifest.json"
        if not file.is_file() or file.is_symlink():
            raise KeyError("Private image job not found")
        return json.loads(file.read_bytes())

    def _save_manifest(self, identity, manifest):
        self._atomic(self._directory(identity) / "manifest.json", canonical(manifest))

    def _write_blob(self, identity, slot, contents):
        if slot not in SLOTS or not contents or len(contents) > MAX_BYTES:
            raise ValueError("Private image payload exceeds its limit")
        nonce = secrets.token_bytes(12)
        aad = (identity + ":" + slot).encode()
        self._atomic(self._directory(identity) / (slot + ".sealed"), nonce + self.cipher.encrypt(nonce, contents, aad))

    def read_blob(self, identity, slot):
        if slot not in SLOTS:
            raise ValueError("Invalid private payload")
        with self.lock:
            manifest = self._manifest(identity)
            if manifest["expiresAt"] <= self.clock() or manifest["state"] not in {"reserved", "processing", "completed"}:
                raise KeyError("Private image job is unavailable")
            file = self._directory(identity) / (slot + ".sealed")
            if file.is_symlink() or file.stat().st_size > MAX_BYTES + 28:
                raise ValueError("Private image payload is invalid")
            encrypted = file.read_bytes()
            return self.cipher.decrypt(encrypted[:12], encrypted[12:], (identity + ":" + slot).encode())

    def reserve(self, identity, source, reference, instruction, seed, width, height, reference2=None, operation=None, profile=None):
        job_id(identity)
        if operation not in {None, "selection", "viewpoint"}:
            raise ValueError("Invalid private operation")
        if profile not in {None, "fast12-v1"} or (profile is not None and operation is not None):
            raise ValueError("Invalid private speed profile")
        if reference2 is not None and reference is None:
            raise ValueError("The third image requires the second image")
        if operation is not None and (reference is not None or reference2 is not None):
            raise ValueError("This operation accepts a single source")
        if any(type(value) is not int for value in (seed, width, height)) or not 0 <= seed <= 0x7FFFFFFF or not 768 <= width <= 1536 or not 768 <= height <= 1536 or width % 32 or height % 32:
            raise ValueError("Invalid pinned image settings")
        if not isinstance(instruction, str) or not (1 if operation == "selection" else 10) <= len(instruction) <= (120 if operation == "selection" else 4000):
            raise ValueError("Invalid edit instruction")
        if operation == "selection" and (not instruction.strip() or any(c in instruction for c in ":,()\r\n\x00")):
            raise ValueError("Use one short object description")
        for data in [source, *([reference] if reference is not None else []), *([reference2] if reference2 is not None else [])]:
            if not data or len(data) > MAX_BYTES or not data.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("Private jobs accept only bounded canonical PNGs")
        request = {"source": hashlib.sha256(source).hexdigest(),
            "reference": hashlib.sha256(reference).hexdigest() if reference else None,
            "instruction": instruction, "seed": seed, "width": width, "height": height}
        # Preserve the byte-for-byte legacy identity when additions are absent.
        if reference2 is not None:
            request["reference2"] = hashlib.sha256(reference2).hexdigest()
        if operation is not None:
            request["operation"] = operation
        if profile is not None:
            request["profile"] = profile
        request_hash = hashlib.sha256(canonical(request)).hexdigest()
        with self.lock:
            self.expire()
            directory = self._directory(identity)
            if directory.exists():
                existing = self._manifest(identity)
                if existing["requestHash"] != request_hash:
                    raise ValueError("This job identity belongs to different inputs")
                return existing, False
            if len(list(self.root.iterdir())) >= MAX_JOBS:
                raise ValueError("Private image job quota is full")
            directory.mkdir(mode=0o700)
            try:
                self._write_blob(identity, "source", source)
                if reference is not None:
                    self._write_blob(identity, "reference", reference)
                if reference2 is not None:
                    self._write_blob(identity, "reference2", reference2)
                self._write_blob(identity, "instruction", instruction.encode())
                manifest = {"id": identity, "requestHash": request_hash, "state": "reserved", "createdAt": self.clock(),
                    "expiresAt": self.clock() + TTL_SECONDS, "seed": seed, "width": width, "height": height,
                    "reference": reference is not None}
                if reference2 is not None:
                    manifest["reference2"] = True
                if operation is not None:
                    manifest["operation"] = operation
                if profile is not None:
                    manifest["profile"] = profile
                self._save_manifest(identity, manifest)
                return manifest, True
            except BaseException:
                shutil.rmtree(directory)
                raise

    def authorize_graph(self, identity, graph):
        """Pin the entire graph; removing the output or adding SaveImage invalidates it."""
        with self.lock:
            manifest = self._manifest(identity)
            signature = self.signature(graph)
            manifest["graphSignature"] = signature
            # Write before enqueue. A crash here fails the job at startup, never
            # re-enqueues its same ID or sends the photos through generic upload.
            manifest["state"] = "processing"
            manifest["progress"] = {"phase": "queued"}
            self._save_manifest(identity, manifest)
            return signature

    def progress(self, identity, phase, completed_steps=None, total_steps=None):
        """Only bounded scalar telemetry; never accept images or callback payloads."""
        phases = {"queued": 0, "preparing": 1, "sampling": 2, "finishing": 3}
        if phase not in phases:
            raise ValueError("Invalid private progress phase")
        value = {"phase": phase}
        if phase == "sampling":
            if type(completed_steps) is not int or type(total_steps) is not int or total_steps not in {12, 20} or not 0 <= completed_steps <= total_steps:
                raise ValueError("Invalid private sampling progress")
            value.update(completedSteps=completed_steps, totalSteps=total_steps)
        elif completed_steps is not None or total_steps is not None:
            raise ValueError("Only sampling reports steps")
        with self.lock:
            manifest = self._manifest(identity)
            if manifest["state"] != "processing" or manifest["expiresAt"] <= self.clock():
                return
            if phase == "sampling" and manifest.get("operation") == "selection":
                raise ValueError("Selection jobs do not have sampling steps")
            if phase == "sampling" and total_steps != (12 if manifest.get("profile") == "fast12-v1" else 20):
                raise ValueError("Sampling steps do not match the pinned profile")
            previous = manifest.get("progress", {})
            if phases.get(previous.get("phase"), -1) > phases[phase]:
                return
            if phase == previous.get("phase") == "sampling" and previous["completedSteps"] > completed_steps:
                return
            if previous != value:
                manifest["progress"] = value
                self._save_manifest(identity, manifest)

    def signature(self, graph):
        # Comfy adds this transient cache fingerprint during execution. It is
        # not a workflow input; every class, input, link and other field is pinned.
        unsigned = {key: {**{k: v for k, v in node.items() if k != "is_changed"},
                          "inputs": {k: v for k, v in node["inputs"].items() if k != "authorization"}}
                    for key, node in graph.items()}
        return hmac.new(self.sign_key, canonical(unsigned), hashlib.sha256).hexdigest()

    def verify_graph(self, identity, authorization, graph):
        with self.lock:
            manifest = self._manifest(identity)
            if manifest["state"] != "processing" or manifest["expiresAt"] <= self.clock():
                raise ValueError("Private image job is no longer active")
            expected = self.signature(graph)
            if not hmac.compare_digest(authorization, expected) or not hmac.compare_digest(expected, manifest.get("graphSignature", "")):
                raise ValueError("Unauthorized private image graph")
            return manifest

    def complete(self, identity, data):
        with self.lock:
            manifest = self._manifest(identity)
            if manifest["state"] != "processing" or manifest["expiresAt"] <= self.clock():
                raise ValueError("Private image job expired before completion")
            self._write_blob(identity, "output", data)
            manifest["state"] = "completed"
            manifest.pop("progress", None)
            manifest["outputSha256"] = hashlib.sha256(data).hexdigest()
            self._save_manifest(identity, manifest)
            self._remove_payloads(identity, keep_output=True)

    def _remove_payloads(self, identity, keep_output=False):
        for file in self._directory(identity).iterdir():
            if file.name != "manifest.json" and not (keep_output and file.name == "output.sealed"):
                if file.is_dir() or file.is_symlink():
                    raise ValueError("Unexpected private storage object")
                file.unlink()

    def erase(self, identity, state="consumed"):
        with self.lock:
            manifest = self._manifest(identity)
            # Persist the tombstone first, preventing a late worker from
            # publishing after cleanup. Repetition removes any crash leftovers.
            manifest["state"] = state
            manifest.pop("progress", None)
            manifest.pop("graphSignature", None)
            self._save_manifest(identity, manifest)
            self._remove_payloads(identity)
            return manifest

    def acknowledge(self, identity, sha256):
        with self.lock:
            manifest = self._manifest(identity)
            if manifest["state"] not in {"completed", "consumed"} or manifest.get("outputSha256") != sha256:
                raise ValueError("The saved output receipt does not match")
            return self.erase(identity)

    def status(self, identity):
        with self.lock:
            self.expire()
            return self._manifest(identity)

    def expire(self):
        with self.lock:
            for directory in self.root.iterdir():
                if not directory.is_dir() or directory.is_symlink():
                    raise ValueError("Unexpected private job directory")
                identity = job_id(directory.name)
                try:
                    manifest = self._manifest(identity)
                except KeyError:
                    # Interrupted staging was never admitted to a queue.
                    shutil.rmtree(directory)
                    continue
                if manifest["state"] in {"failed", "consumed", "expired"}:
                    self._remove_payloads(identity)
                elif manifest["expiresAt"] <= self.clock():
                    self.erase(identity, "expired")
                # Keep tombstones long enough for Core receipt recovery, then
                # remove non-media metadata at 30 days to bound disk usage.
                if self.clock() > manifest["createdAt"] + 30 * TTL_SECONDS:
                    shutil.rmtree(directory)

    def reconcile_restart(self):
        with self.lock:
            self.expire()
            for directory in self.root.iterdir():
                manifest = self._manifest(directory.name)
                if manifest["state"] in {"reserved", "processing"}:
                    self.erase(directory.name, "failed")
