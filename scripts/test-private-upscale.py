"""Private SeedVR2 compatibility/no-download tests. No GPU or real models."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import uuid
import numpy as np

spec = importlib.util.spec_from_file_location("private_upscale", Path(__file__).resolve().parents[1] / "comfy-nodes/evergreen_private_images/upscale.py")
upscale = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upscale)


class UpscaleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        interface = self.root / "src/interfaces/video_upscaler.py"
        interface.parent.mkdir(parents=True)
        interface.write_text('''calls = []
def find_model_file(name):
    return str(ROOT / name)
def download_weight(**kwargs):
    raise AssertionError("The original downloader must NEVER run")
class SeedVR2VideoUpscaler:
    @classmethod
    def execute(cls, image, dit, vae, seed, resolution=1080, max_resolution=0,
                batch_size=5, uniform_batch_size=False, temporal_overlap=0, prepend_frames=0,
                color_correction="wavelet", input_noise_scale=0.0, latent_noise_scale=0.0,
                offload_device="none", enable_debug=False):
        download_weight(dit_model=dit["model"], vae_model=vae["model"])
        calls.append({k: v for k, v in locals().items() if k not in {"cls", "image"}})
        return (image.repeat(2, axis=1).repeat(2, axis=2),)
''')
        node_spec = importlib.util.spec_from_file_location("synthetic_seedvr", interface)
        self.module = importlib.util.module_from_spec(node_spec)
        node_spec.loader.exec_module(self.module)
        self.module.ROOT = self.root
        self.node = self.module.SeedVR2VideoUpscaler
        self.original_downloader = self.module.download_weight
        self.assets = {}
        for name in [upscale.DIT, upscale.VAE]:
            header = json.dumps({"weight": {"dtype": "F32", "shape": [16], "data_offsets": [0, 64]}}).encode()
            blob = struct.pack("<Q", len(header)) + header + b"\x01" * 64
            (self.root / name).write_bytes(blob)
            self.assets[name] = len(blob)
        self.embedding = {}
        for name in ["pos_emb.pt", "neg_emb.pt"]:
            data = name.encode(); (self.root / name).write_bytes(data)
            self.embedding[name] = hashlib.sha256(data).hexdigest()
        self.patch = patch.multiple(upscale, ASSET_BYTES=self.assets, EMBEDDING_SHA256=self.embedding,
            EXECUTE_SHA256=hashlib.sha256(interface.read_bytes()).hexdigest())
        self.patch.start()
        self.manifest = {"id": str(uuid.uuid4()), "operation": "upscale", "workflow": upscale.WORKFLOW,
            "width": 17, "height": 19, "seed": 42}
        self.image = np.full((1, 19, 17, 3), .25)

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_readiness_requires_reviewed_code_and_real_assets(self):
        self.assertTrue(upscale.ready(self.node))
        self.assertFalse(upscale.ready(None))
        model = self.root / upscale.DIT
        model.write_bytes(b"\0" * self.assets[upscale.DIT])
        self.assertFalse(upscale.ready(self.node))
        with self.assertRaises(ValueError):
            upscale.run(self.node, self.image, self.manifest)
        self.assertEqual(self.module.calls, [])
        self.assertIs(self.module.download_weight, self.original_downloader)

    def test_private_clone_pins_configuration_and_never_patches_upstream(self):
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        output = upscale.run(self.node, self.image, self.manifest)
        self.assertEqual(output.shape, (1, 38, 34, 3))
        self.assertIs(self.module.download_weight, self.original_downloader)
        settings = self.module.calls[0]
        self.assertEqual(settings["resolution"], 34)
        self.assertEqual(settings["max_resolution"], 38)
        self.assertEqual(settings["batch_size"], 1)
        self.assertEqual(settings["color_correction"], "lab")
        self.assertEqual(settings["seed"], 42)
        self.assertFalse(settings["enable_debug"])
        for config in [settings["dit"], settings["vae"]]:
            self.assertFalse(config["cache_model"])
            self.assertEqual(config["offload_device"], "cpu")
            self.assertIsNone(config["torch_compile_args"])
        self.assertTrue(settings["vae"]["encode_tiled"])
        self.assertTrue(settings["vae"]["decode_tiled"])
        self.assertEqual(settings["dit"]["attention_mode"], "sdpa")
        self.assertEqual(before, sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*")))

    def test_changed_implementation_embeddings_inputs_and_identity_fail_closed(self):
        for changes in [{"operation": "viewpoint"}, {"workflow": "other"}, {"width": 8193}, {"width": True}, {"width": 2000, "height": 2000}]:
            with self.assertRaises(ValueError):
                upscale.run(self.node, self.image, {**self.manifest, **changes})
        with self.assertRaises(ValueError):
            upscale.run(self.node, np.zeros((1, 19, 17, 4)), self.manifest)
        (self.root / "pos_emb.pt").write_bytes(b"changed")
        self.assertFalse(upscale.ready(self.node))
        with patch.object(upscale, "EXECUTE_SHA256", "0" * 64):
            self.assertFalse(upscale.ready(self.node))

    def test_unexpected_output_shape_or_ui_is_refused(self):
        class Result:
            ui = {"images": ["must-not-be-public"]}
        class FakeNode:
            @classmethod
            def execute(cls, **kwargs):
                return Result()
        with patch.object(upscale, "checked_implementation", return_value=(FakeNode.execute.__func__, lambda n: str(self.root / n))):
            with self.assertRaisesRegex(ValueError, "pixels only"):
                upscale.run(FakeNode, self.image, self.manifest)


if __name__ == "__main__":
    unittest.main()
