"""Private BiRefNet cut-out adapter: pinned files, no download, no write. No GPU or real model."""
import hashlib
import importlib.util
import json
import socket
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

spec = importlib.util.spec_from_file_location("private_cutout", Path(__file__).resolve().parents[1] / "comfy-nodes/evergreen_private_images/cutout.py")
cutout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutout)

CONFIG = '''class BiRefNetConfig:
    def __init__(self, bb_pretrained=True, **kwargs):
        self.bb_pretrained = bb_pretrained
'''
# As first published upstream: a relative import that only works inside a package.
MODEL = '''from .BiRefNet_config import BiRefNetConfig
import sys
BUILT = []
class BiRefNet:
    def __init__(self, config):
        if not isinstance(config, BiRefNetConfig) or config.bb_pretrained:
            raise AssertionError("pretrained backbones would be fetched from the network")
        BUILT.append((__name__, "birefnet" in sys.modules, "BiRefNet_config" in sys.modules))
'''


def weights():
    header = json.dumps({"w": {"dtype": "F32", "shape": [2], "data_offsets": [0, 8]}}).encode()
    return struct.pack("<Q", len(header)) + header + b"\x01\x02\x03\x04\x05\x06\x07\x08"


class CutoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.models = Path(self.temp.name) / "models"
        self.directory = cutout.model_directory(self.models)
        self.directory.mkdir(parents=True)
        (self.directory / "BiRefNet_config.py").write_text(CONFIG)
        (self.directory / "birefnet.py").write_text(MODEL)
        (self.directory / cutout.WEIGHTS).write_bytes(weights())
        digests = {name: hashlib.sha256((self.directory / name).read_bytes()).hexdigest() for name in ["birefnet.py", "BiRefNet_config.py"]}
        for target, value in [("CODE_SHA256", digests), ("WEIGHT_BYTES", len(weights()))]:
            patcher = patch.object(cutout, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.manifest = {"id": "job", "operation": "cutout", "workflow": cutout.WORKFLOW, "width": 96, "height": 80}
        self.image = np.zeros((1, 80, 96, 3), dtype=np.float32)
        self.image[..., 0] = 1.0   # a red picture

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self):
        return sorted((str(p.relative_to(self.models)), p.stat().st_mtime_ns, p.stat().st_size) for p in self.models.rglob("*"))

    def test_the_pinned_folder_is_models_rmbg_birefnet(self):
        self.assertEqual(self.directory, self.models / "RMBG" / "BiRefNet")
        self.assertEqual((cutout.MODEL, cutout.WORKFLOW, cutout.WEIGHTS), ("birefnet-portrait", "birefnet-portrait-private-cutout-v1", "BiRefNet-portrait.safetensors"))

    def test_ready_needs_the_exact_code_and_complete_weights(self):
        self.assertTrue(cutout.ready(self.directory))
        before = self.snapshot()
        (self.directory / "birefnet.py").write_text(MODEL + "# one more byte\n")
        self.assertFalse(cutout.ready(self.directory))
        with self.assertRaisesRegex(ValueError, "compatibility review"):
            cutout.checked_files(self.directory)
        (self.directory / "birefnet.py").write_text(MODEL)
        self.assertTrue(cutout.ready(self.directory))
        for damage in [weights()[:-3], b"", weights() + b"\x00", struct.pack("<Q", 5) + b"{}   " + b"\x00" * 8]:
            (self.directory / cutout.WEIGHTS).write_bytes(damage)
            self.assertFalse(cutout.ready(self.directory), repr(damage[:12]))
        (self.directory / cutout.WEIGHTS).unlink()
        self.assertFalse(cutout.ready(self.directory))
        (self.directory / cutout.WEIGHTS).write_bytes(weights())
        (self.directory / "BiRefNet_config.py").unlink()
        self.assertFalse(cutout.ready(self.directory))
        self.assertFalse(cutout.ready(self.models / "nowhere"))
        (self.directory / "BiRefNet_config.py").write_text(CONFIG)
        self.assertTrue(cutout.ready(self.directory))
        self.assertEqual([entry[0] for entry in before], [entry[0] for entry in self.snapshot()], "readiness never adds or removes a file")

    def test_the_real_pins_are_the_reviewed_files(self):
        # Outside setUp's stand-ins the module carries the digests reviewed on vidbox.
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        self.assertEqual(fresh.CODE_SHA256, {
            "birefnet.py": "bd2986cee78b6d649ba7464066a0ba393cc45910ba1cb413ed91ca8fbb226f86",
            "BiRefNet_config.py": "e7b8c2a74f6cea6a59553d517f71d47f2c1d90e670a13416af17c25fe2f3dc52"})
        self.assertEqual(fresh.WEIGHT_BYTES, 884_878_856)
        self.assertFalse(fresh.ready(self.directory), "stand-in files are not the reviewed ones")

    def test_the_model_is_built_from_memory_without_writing_or_leaving_modules(self):
        before = self.snapshot()
        marker = object()
        sys.modules["birefnet"] = marker
        sys.modules.pop("BiRefNet_config", None)
        try:
            sources, path = cutout.checked_files(self.directory)
            self.assertEqual(path, self.directory / cutout.WEIGHTS)
            with patch.object(socket, "socket", side_effect=AssertionError("no network during a private cut-out")):
                model = cutout.build_model(sources)
            self.assertEqual((type(model).__name__, type(model).__module__), ("BiRefNet", "birefnet"))
            self.assertIs(sys.modules["birefnet"], marker, "a module that was there before is put back")
            self.assertNotIn("BiRefNet_config", sys.modules, "a name that was not there is removed")
            # While it ran, both names were present (the model file needs them) and the relative import was fixed in memory.
            self.assertEqual(type(model).__init__.__globals__["BUILT"], [("birefnet", True, True)])
        finally:
            sys.modules.pop("birefnet", None)
        self.assertEqual(before, self.snapshot(), "no file was written, rewritten or touched")
        self.assertIn("from .BiRefNet_config", (self.directory / "birefnet.py").read_text(), "the file on disk keeps its original text")

    def test_a_cutout_is_the_same_size_rgba_with_the_models_matte(self):
        matte = np.zeros((80, 96), dtype=np.float32)
        matte[20:60, 30:70] = 1.0
        matte[20:60, 28:30] = 0.5
        seen = []
        def predictor(rgb):
            seen.append((rgb.shape, str(rgb.dtype), int(rgb[0, 0, 0]), int(rgb[0, 0, 2])))
            return matte
        before = self.snapshot()
        with patch.object(socket, "socket", side_effect=AssertionError("no network during a private cut-out")):
            pixels = cutout.run(self.image, self.manifest, self.directory, predictor)
        self.assertEqual(seen, [((80, 96, 3), "uint8", 255, 0)])
        self.assertEqual(pixels.shape, (1, 80, 96, 4))
        self.assertEqual(str(pixels.dtype), "float32")
        np.testing.assert_array_equal(pixels[0, :, :, 3], matte)
        self.assertTrue(((pixels >= 0) & (pixels <= 1)).all())
        np.testing.assert_allclose(pixels[0, 40, 50, :3], [1, 0, 0], atol=1e-3)   # a solid pixel keeps its colour
        self.assertEqual(before, self.snapshot())

    def test_the_edge_colour_loses_the_old_backgrounds_tint(self):
        image = np.zeros((64, 64, 3), dtype=np.float32)
        image[:, :32] = [1, 0, 0]            # red subject on the left
        image[:, 32:] = [0, 0, 1]            # blue background on the right
        image[:, 30:34] = [0.5, 0, 0.5]      # a soft edge where the two are mixed
        alpha = np.zeros((64, 64), dtype=np.float32)
        alpha[:, :30] = 1.0
        alpha[:, 30:34] = 0.5
        estimate = cutout.estimate_foreground(image, alpha)
        self.assertEqual(estimate.shape, (64, 64, 3))
        self.assertTrue(((estimate >= 0) & (estimate <= 1)).all())
        self.assertGreater(float(estimate[32, 31, 0]), 0.8, "the edge pixel is pulled back toward the subject's red")
        self.assertLess(float(estimate[32, 31, 2]), 0.2, "and away from the background's blue")
        np.testing.assert_allclose(estimate[32, 5], [1, 0, 0], atol=1e-3)
        solid = np.full((32, 32, 3), 0.25, dtype=np.float32)
        np.testing.assert_allclose(cutout.estimate_foreground(solid, np.ones((32, 32), dtype=np.float32)), solid, atol=1e-3)

    def test_wrong_requests_and_wrong_model_answers_fail_closed(self):
        fine = lambda rgb: np.ones(rgb.shape[:2], dtype=np.float32)
        for changes in [{"operation": "upscale"}, {"operation": None}, {"workflow": "other"}, {"width": 97}, {"width": True}, {"height": 63}, {"width": 2000, "height": 2000}]:
            with self.assertRaises(ValueError, msg=str(changes)):
                cutout.run(self.image, {**self.manifest, **changes}, self.directory, fine)
        with self.assertRaises(ValueError):
            cutout.run(np.zeros((1, 80, 96, 4), dtype=np.float32), self.manifest, self.directory, fine)
        with self.assertRaises(ValueError):
            cutout.run(np.zeros((2, 80, 96, 3), dtype=np.float32), self.manifest, self.directory, fine)
        with self.assertRaises(ValueError):
            cutout.run(np.full((1, 80, 96, 3), np.nan, dtype=np.float32), self.manifest, self.directory, fine)
        for answer in [np.ones((96, 80), dtype=np.float32), np.ones((80, 96, 1), dtype=np.float32), np.full((80, 96), np.inf, dtype=np.float32)]:
            with self.assertRaisesRegex(ValueError, "matte"):
                cutout.run(self.image, self.manifest, self.directory, lambda rgb, value=answer: value)
        clipped = cutout.run(self.image, self.manifest, self.directory, lambda rgb: np.full(rgb.shape[:2], 7.0, dtype=np.float32))
        self.assertEqual(float(clipped[0, :, :, 3].max()), 1.0)

    def test_dimensions(self):
        for width, height in [(64, 64), (4096, 610), (1581, 1581)]:
            cutout.validate_dimensions(width, height)
        for width, height in [(63, 64), (64, 4097), (1582, 1581), (True, 64), (64.0, 64), ("64", 64)]:
            with self.assertRaises(ValueError):
                cutout.validate_dimensions(width, height)


if __name__ == "__main__":
    unittest.main()
