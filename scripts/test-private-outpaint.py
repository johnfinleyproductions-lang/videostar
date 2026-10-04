"""Outpaint admission and installed-node contracts; no GPU or private photos."""
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest

from PIL import Image

spec = importlib.util.spec_from_file_location("private_outpaint", Path(__file__).resolve().parents[1] / "comfy-nodes/evergreen_private_images/outpaint.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def png(image):
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class OutpaintTests(unittest.TestCase):
    def setUp(self):
        self.source = png(Image.new("RGB", (768, 768), "blue"))
        self.mask = Image.new("L", (768, 768), 255)
        self.mask.paste(0, (100, 50, 700, 750))

    def test_binary_l_and_rgb_masks_preserve_white_edit_polarity(self):
        for mode in ["L", "RGB"]:
            mask = png(self.mask.convert(mode))
            module.validate_inputs(self.source, mask, 768, 768)
            with Image.open(io.BytesIO(mask)) as image:
                self.assertEqual(image.convert("RGB").getpixel((0, 0))[0] / 255, 1)
                self.assertEqual(image.convert("RGB").getpixel((100, 50))[0] / 255, 0)

    def test_rejects_gray_colored_transparent_empty_and_mismatched_masks(self):
        gray = self.mask.copy(); gray.putpixel((1, 1), 128)
        colored = self.mask.convert("RGB"); colored.putpixel((1, 1), (255, 0, 0))
        masks = [gray, colored, self.mask.convert("RGBA"), self.mask.resize((769, 768)),
            Image.new("L", (768, 768), 0), Image.new("L", (768, 768), 255), self.mask.convert("P")]
        for mask in masks:
            with self.subTest(mode=mask.mode, size=mask.size):
                with self.assertRaises(ValueError):
                    module.validate_inputs(self.source, png(mask), 768, 768)
        for raw in [b"not a png", png(self.mask)[:40]]:
            with self.assertRaises(ValueError):
                module.validate_inputs(self.source, raw, 768, 768)

    def test_source_must_be_actual_canonical_rgb_and_match_the_mask(self):
        for image in [Image.new("RGB", (800, 768)), Image.new("RGBA", (768, 768)), self.mask]:
            with self.assertRaises(ValueError):
                module.validate_inputs(png(image), png(self.mask), 768, 768)
        animated = io.BytesIO()
        Image.new("RGB", (768, 768), "red").save(animated, format="PNG", save_all=True,
            append_images=[Image.new("RGB", (768, 768), "blue")], duration=1)
        with self.assertRaises(ValueError):
            module.validate_inputs(animated.getvalue(), png(self.mask), 768, 768)

    def test_readiness_requires_exact_installed_mask_contract(self):
        nodes = {
            "VAEEncode": SimpleNamespace(INPUT_TYPES=lambda: {"required": {"pixels": ("IMAGE",), "vae": ("VAE",)}}),
            "SetLatentNoiseMask": SimpleNamespace(INPUT_TYPES=lambda: {"required": {"samples": ("LATENT",), "mask": ("MASK",)}}),
            "ImageToMask": SimpleNamespace(INPUT_TYPES=lambda: {"required": {"image": ("IMAGE",), "channel": ("COMBO", {"options": ["red", "green", "blue", "alpha"]})}}),
        }
        self.assertTrue(module.ready(nodes))
        for name in nodes:
            self.assertFalse(module.ready({key: value for key, value in nodes.items() if key != name}))
        nodes["ImageToMask"] = SimpleNamespace(INPUT_TYPES=lambda: {"required": {"image": ("IMAGE",), "channel": (["red"],)}})
        self.assertTrue(module.ready(nodes))
        nodes["ImageToMask"] = SimpleNamespace(INPUT_TYPES=lambda: {"required": {"image": ("IMAGE",), "channel": (["alpha"],)}})
        self.assertFalse(module.ready(nodes))
        nodes["SetLatentNoiseMask"] = SimpleNamespace(INPUT_TYPES=lambda: {"required": {"samples": ("IMAGE",), "mask": ("MASK",)}})
        self.assertFalse(module.ready(nodes))


if __name__ == "__main__":
    unittest.main()
