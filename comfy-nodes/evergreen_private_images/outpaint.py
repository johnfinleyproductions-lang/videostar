"""Bounded structural outpainting with installed Qwen and Comfy mask nodes."""
import io

from PIL import Image

WORKFLOW = "qwen-image-edit-2509-private-expand-masked-v1"
STEPS = 20
MASK_POLARITY = "white-edit-black-protect"


def validate_image(image, width, height, mask=False):
    if (image.format != "PNG" or getattr(image, "n_frames", 1) != 1
            or image.size != (width, height) or image.mode not in ({"L", "RGB"} if mask else {"RGB"})):
        raise ValueError("Outpaint requires matching canonical RGB source and opaque grayscale mask")
    image.load()
    if mask:
        # Extrema alone miss interior gray values. A bounded palette scan also
        # rejects colored masks, empty edits and fully unprotected canvases.
        colors = image.getcolors(maxcolors=2)
        expected = {0, 255} if image.mode == "L" else {(0, 0, 0), (255, 255, 255)}
        if colors is None or {color for _count, color in colors} != expected:
            raise ValueError("Outpaint mask must contain only black protected pixels and white editable pixels")


def validate_inputs(source, mask, width, height):
    # Store checks encoded byte and dimension bounds before calling this.
    for data, is_mask in [(source, False), (mask, True)]:
        try:
            with Image.open(io.BytesIO(data)) as image:
                validate_image(image, width, height, is_mask)
        except (OSError, SyntaxError) as error:
            raise ValueError("Invalid canonical outpaint PNG") from error


def ready(node_classes):
    """Fail closed if an installed node's required mask contract changes."""
    try:
        encoder = node_classes["VAEEncode"].INPUT_TYPES()["required"]
        masked = node_classes["SetLatentNoiseMask"].INPUT_TYPES()["required"]
        channels = node_classes["ImageToMask"].INPUT_TYPES()["required"]
        channel = channels["channel"]
        options = channel[0] if isinstance(channel[0], (list, tuple)) else channel[1].get("options", [])
        return (encoder["pixels"][0] == "IMAGE" and encoder["vae"][0] == "VAE"
            and masked["samples"][0] == "LATENT" and masked["mask"][0] == "MASK"
            and channels["image"][0] == "IMAGE" and "red" in options)
    except (AttributeError, KeyError, IndexError, TypeError, ValueError):
        return False
