"""Private video protocol/lifecycle tests; no GPU or user clips."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

from PIL import Image

package = Path(__file__).resolve().parents[1] / "comfy-nodes/evergreen_private_images"
spec = importlib.util.spec_from_file_location("private_video", package / "video_store.py", submodule_search_locations=[str(package)])
video = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = video
spec.loader.exec_module(video)
routes_spec = importlib.util.spec_from_file_location("private_video.video_routes", package / "video_routes.py")
routes = importlib.util.module_from_spec(routes_spec)
routes_spec.loader.exec_module(routes)


def png(mode="RGB", color="blue", seed=False, size=(32, 24)):
    image = Image.new(mode, size, color)
    if seed:
        image.paste(255 if mode == "L" else (255, 255, 255), (8, 4, 24, 20))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def request(identity, source, seed, start=0):
    return {"id": identity, "version": 1, "workflow": video.WORKFLOW, "sourceSha256": "a" * 64,
        "width": 32, "height": 24, "timeBase": {"num": 1, "den": 1000},
        "clipStartPts": 0, "clipEndPts": 150, "frameCount": 3, "startFrame": start,
        "frames": [{"index": i, "pts": [0, 40, 100][i], "duration": [40, 60, 50][i],
            "sha256": hashlib.sha256(source).hexdigest(), "byteLength": len(source)} for i in range(start, 3)],
        "seed": {"sha256": hashlib.sha256(seed).hexdigest(), "byteLength": len(seed)}}


class VideoStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.key = self.base / "key"
        self.key.write_text("ab" * 32)
        self.key.chmod(0o600)
        self.now = [100.0]
        self.jobs = video.VideoJobs(self.base / "video", self.key, clock=lambda: self.now[0])
        self.identity = str(uuid.uuid4())
        self.source = png()
        self.seed = png(color="black", seed=True)
        self.mask = png("L", color=0, seed=True)
        self.body = request(self.identity, self.source, self.seed)

    def tearDown(self):
        self.temp.cleanup()

    def upload(self):
        manifest, _ = self.jobs.reserve_video(self.body)
        for frame in self.body["frames"]:
            self.jobs.upload(self.identity, self.source, frame["index"])
        self.jobs.upload(self.identity, self.seed)
        return manifest

    def active(self):
        graph = routes.build_graph(self.upload())
        tag = self.jobs.authorize_graph(self.identity, graph)
        graph["9"]["inputs"]["authorization"] = tag
        return graph, tag

    def complete(self):
        self.active()
        for frame in self.body["frames"]:
            self.jobs.save_mask(self.identity, frame["index"], self.mask)
        self.jobs.finish_video(self.identity)

    def test_encrypted_round_trip_exact_identity_and_signed_graph(self):
        graph, tag = self.active()
        self.jobs.verify_graph(self.identity, tag, graph)
        self.assertEqual(self.jobs.request(self.identity), self.body)
        for file in self.jobs.root.rglob("*"):
            self.assertEqual(file.stat().st_mode & 0o077, 0)
            if file.is_file():
                self.assertNotIn(self.source, file.read_bytes())
                self.assertNotIn(self.seed, file.read_bytes())
                self.assertNotIn(b'"sourceSha256"', file.read_bytes())
        changed = copy.deepcopy(graph)
        changed["10"] = {"class_type": "SaveImage", "inputs": {}}
        with self.assertRaises(ValueError):
            self.jobs.verify_graph(self.identity, tag, changed)
        self.assertFalse(self.jobs.reserve_video(self.body)[1])
        for key, value in [("workflow", "other"), ("sourceSha256", "b" * 64), ("clipEndPts", 151)]:
            with self.assertRaises(ValueError):
                self.jobs.reserve_video({**self.body, key: value})

    def test_upload_receipts_timing_and_mask_bounds(self):
        self.jobs.reserve_video(self.body)
        with self.assertRaises(ValueError):
            self.jobs.upload(self.identity, png(color="red"), 0)
        with self.assertRaises(ValueError):
            self.jobs.authorize_graph(self.identity, routes.build_graph(self.jobs.status(self.identity)))
        for changes in [{"width": 641}, {"height": True}, {"frameCount": 91}, {"clipStartPts": 1},
                {"clipEndPts": 3001}, {"startFrame": 3}, {"timeBase": {"num": 0, "den": 1000}},
                {"path": "/tmp/file"}, {"reference": "anything"}]:
            with self.assertRaises(ValueError):
                video.validate_request({**self.body, **changes})
        for field, value in [("pts", 41), ("index", 0), ("duration", 0), ("byteLength", video.MAX_FRAME_BYTES + 1)]:
            bad = copy.deepcopy(self.body)
            bad["frames"][1][field] = value
            with self.assertRaises(ValueError):
                video.validate_request(bad)
        for data in [png(color="white"), png(color="black"), png(color="red", seed=True), png("RGBA", seed=True), png(size=(33, 24), seed=True)]:
            with self.assertRaises(ValueError):
                video.validate_png(data, 32, 24, "seed")
        for color in [0, 255]:
            video.validate_png(png("L", color), 32, 24, "mask")

    def test_single_suffix_correction_keeps_absolute_indices_and_timing(self):
        self.body = request(self.identity, self.source, self.seed, start=2)
        self.complete()
        result = json.loads(self.jobs.read_blob(self.identity, "output"))
        self.assertEqual(result["startFrame"], 2)
        self.assertEqual(result["frameCount"], 3)
        self.assertEqual([(m["index"], m["pts"], m["duration"]) for m in result["masks"]], [(2, 100, 50)])
        with self.assertRaises(FileNotFoundError):
            self.jobs.read_blob(self.identity, "mask-0")

    def test_every_mask_required_empty_occlusion_valid_and_durable_ack(self):
        self.active()
        self.jobs.save_mask(self.identity, 0, self.mask)
        with self.assertRaises(FileNotFoundError):
            self.jobs.finish_video(self.identity)
        for i in [1, 2]:
            self.jobs.save_mask(self.identity, i, png("L", 0))
        self.jobs.finish_video(self.identity)
        result_bytes = self.jobs.read_blob(self.identity, "output")
        result = json.loads(result_bytes)
        self.assertEqual(len(result["masks"]), 3)
        for mask in result["masks"]:
            data = self.jobs.read_blob(self.identity, f"mask-{mask['index']}")
            self.assertEqual(hashlib.sha256(data).hexdigest(), mask["sha256"])
        self.assertEqual({p.name for p in (self.jobs.root / self.identity).iterdir()},
            {"manifest.json", "output.sealed", "mask-0.sealed", "mask-1.sealed", "mask-2.sealed"})
        restarted = video.VideoJobs(self.jobs.root, self.key, clock=lambda: self.now[0])
        self.assertEqual(restarted.read_blob(self.identity, "output"), result_bytes)
        with self.assertRaises(ValueError):
            restarted.acknowledge(self.identity, "f" * 64)
        sha = hashlib.sha256(result_bytes).hexdigest()
        restarted.acknowledge(self.identity, sha)
        restarted.acknowledge(self.identity, sha)
        self.assertEqual(list((self.jobs.root / self.identity).glob("*.sealed")), [])
        self.assertEqual(restarted.status(self.identity)["state"], "consumed")

    def test_crash_upload_resume_processing_fail_and_completed_input_cleanup(self):
        self.upload()
        restarted = video.VideoJobs(self.jobs.root, self.key, clock=lambda: self.now[0])
        self.assertEqual(restarted.status(self.identity)["state"], "uploading")
        graph = routes.build_graph(restarted.status(self.identity))
        restarted.authorize_graph(self.identity, graph)
        restarted = video.VideoJobs(self.jobs.root, self.key, clock=lambda: self.now[0])
        self.assertEqual(restarted.status(self.identity)["state"], "failed")
        self.assertEqual(list((self.jobs.root / self.identity).glob("*.sealed")), [])
        self.identity = str(uuid.uuid4())
        self.body = request(self.identity, self.source, self.seed)
        self.complete()
        self.jobs._write_blob(self.identity, "frame-0", self.source)
        restarted = video.VideoJobs(self.jobs.root, self.key, clock=lambda: self.now[0])
        self.assertFalse((self.jobs.root / self.identity / "frame-0.sealed").exists())
        self.assertEqual(restarted.read_blob(self.identity, "mask-0"), self.mask)

    def test_delete_fences_late_publish_and_quota_expiry(self):
        self.active()
        self.jobs.erase(self.identity, "expired")
        with self.assertRaises(ValueError):
            self.jobs.save_mask(self.identity, 0, self.mask)
        for i in range(video.MAX_LIVE_JOBS):
            body = request(str(uuid.uuid4()), self.source, self.seed)
            self.jobs.reserve_video(body)
        with self.assertRaises(ValueError):
            self.jobs.reserve_video(request(str(uuid.uuid4()), self.source, self.seed))
        self.now[0] += video.UPLOAD_TTL + 1
        self.jobs.expire()
        self.assertEqual(list(self.jobs.root.rglob("*.sealed")), [])
        self.assertTrue(self.jobs.reserve_video(request(str(uuid.uuid4()), self.source, self.seed))[1])


if __name__ == "__main__":
    unittest.main()
