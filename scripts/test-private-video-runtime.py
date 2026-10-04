"""Tracker sequencing/failure isolation with a synthetic predictor, no GPU."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

import numpy as np
from PIL import Image

fixture_spec = importlib.util.spec_from_file_location("video_runtime_fixtures", Path(__file__).with_name("test-private-video.py"))
fixtures = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixtures)
spec = importlib.util.spec_from_file_location("private_video.video_tracker", fixtures.package / "video_tracker.py")
tracker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tracker)


class Tensor(np.ndarray):
    def permute(self, *axes):
        return self.transpose(axes)
    def to(self, dtype):
        return self.astype(dtype)
    def cpu(self):
        return self
    def numpy(self):
        return np.asarray(self)


def tensor(value):
    return np.asarray(value).view(Tensor)


# These originals must never be replaced globally by the private adapter.
def load_video_frames(**kwargs):
    raise AssertionError("The public file loader must not be called")


def tqdm(values, **kwargs):
    raise AssertionError("The public progress callback must not be called")


class Predictor:
    image_size = 32
    bad = None
    saved_state = None

    def init_state(self, video_path, offload_video_to_cpu, offload_state_to_cpu, async_loading_frames):
        frames, height, width = load_video_frames(video_path=video_path, offload_video_to_cpu=offload_video_to_cpu)
        assert frames[0].shape == (3, 32, 32)
        assert offload_state_to_cpu and not async_loading_frames
        self.saved_state = {"images": frames, "height": height, "width": width}
        return self.saved_state

    def add_new_mask(self, state, frame_idx, obj_id, mask):
        assert frame_idx == 0 and obj_id == 1
        assert mask.shape == (24, 32)
        state["seed"] = mask

    def propagate_in_video(self, state, start_frame_idx, max_frame_num_to_track, reverse):
        assert start_frame_idx == 0 and not reverse
        for index in tqdm(range(max_frame_num_to_track), desc="unused"):
            logits = tensor(np.full((1, 1, state["height"], state["width"]), -1.0))
            if self.bad == "missing" and index == 2:
                break
            if self.bad == "order" and index == 1:
                index = 2
            if self.bad == "nan":
                logits[:] = np.nan
            yield index, [1], logits


class VideoRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.VideoStoreTests()
        self.fixture.setUp()
        self.fixture.active()
        self.model = Predictor()
        self.model.bad = None
        self.emptied = []
        fake_torch = ModuleType("torch")
        fake_torch.inference_mode = fake_torch.autocast = lambda *args, **kwargs: contextlib.nullcontext()
        fake_torch.from_numpy = fake_torch.tensor = tensor
        fake_torch.isfinite = np.isfinite
        fake_torch.bfloat16 = "bfloat16"
        fake_torch.uint8 = np.uint8
        management = ModuleType("comfy.model_management")
        management.get_torch_device = lambda: SimpleNamespace(type="cuda")
        management.free_memory = lambda *args: None
        management.soft_empty_cache = lambda: self.emptied.append(True)
        comfy = ModuleType("comfy")
        comfy.model_management = management
        self.patches = [patch.dict(sys.modules, {"torch": fake_torch, "comfy": comfy, "comfy.model_management": management}),
            patch.object(tracker, "verified_assets", lambda: (None, None)),
            patch.object(tracker, "create_predictor", lambda *args: self.model)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.fixture.tearDown()

    def test_reviewed_seed_exact_empty_occlusion_and_private_loader_binding(self):
        tracker.track(self.fixture.jobs, self.fixture.identity)
        self.assertEqual(self.model.saved_state, {})
        self.assertEqual(self.emptied, [True])
        with Image.open(io.BytesIO(self.fixture.jobs.read_blob(self.fixture.identity, "mask-0"))) as image:
            with Image.open(io.BytesIO(self.fixture.seed)) as seed:
                self.assertTrue(np.array_equal(np.asarray(image), np.asarray(seed)[:, :, 0]))
        with Image.open(io.BytesIO(self.fixture.jobs.read_blob(self.fixture.identity, "mask-1"))) as image:
            self.assertEqual(np.max(np.asarray(image)), 0)
        with self.assertRaises(AssertionError):
            load_video_frames()
        with self.assertRaises(AssertionError):
            tqdm([])

    def test_wrong_index_nonfinite_or_missing_output_cannot_complete(self):
        for failure in ["order", "nan", "missing"]:
            with self.subTest(failure=failure):
                self.fixture.jobs.erase(self.fixture.identity, "failed")
                self.fixture.identity = str(uuid.uuid4())
                self.fixture.body = fixtures.request(self.fixture.identity, self.fixture.source, self.fixture.seed)
                self.fixture.active()
                self.model.bad = failure
                with self.assertRaises(ValueError):
                    tracker.track(self.fixture.jobs, self.fixture.identity)
                self.assertEqual(self.model.saved_state, {})
                self.assertNotEqual(self.fixture.jobs.status(self.fixture.identity)["state"], "completed")


if __name__ == "__main__":
    unittest.main()
