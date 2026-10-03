"""Authenticated, private Qwen image jobs on the existing Comfy runtime.

Installation requires owner-only key/storage paths. Generic Comfy HTTP is
restricted to loopback or the shared credential; /system_stats stays probeable.
No private media enters Comfy input/output folders, /view, graph history, or
latent previews. See README.md before enabling on a shared runtime.
"""
import base64
import io
import ipaddress
import json
import os
import threading

import numpy as np
import torch
from PIL import Image
from aiohttp import web
import comfy.sample
import execution
import folder_paths
import nodes
from server import PromptServer
from .store import PrivateJobs, canonical, job_id
from .runtime import install_runtime_boundary
from .selections import describe_masks

KEY_FILE = os.environ.get("EVERGREEN_PRIVATE_IMAGE_KEY_FILE")
ROOT = os.environ.get("EVERGREEN_PRIVATE_IMAGE_ROOT")
JOBS = None
MAX_BODY = 86 * 1024 * 1024
PROTOCOL = "evergreen-private-images-v1"


def verify(identity, authorization, prompt):
    if JOBS is None:
        raise ValueError("Private image jobs are not configured")
    return JOBS.verify_graph(identity, authorization, prompt)


class PrivateImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"identity": ("STRING",), "slot": (["source", "reference", "reference2"],), "authorization": ("STRING",)}, "hidden": {"prompt": "PROMPT"}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Even an otherwise identical graph must re-authorize and re-read.
        return float("nan")

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "load"
    CATEGORY = "Evergreen/private"

    def load(self, identity, slot, authorization, prompt):
        manifest = verify(identity, authorization, prompt)
        contents = JOBS.read_blob(identity, slot)
        with Image.open(io.BytesIO(contents)) as image:
            if image.format != "PNG" or getattr(image, "n_frames", 1) != 1 or image.width * image.height > 2_500_000:
                raise ValueError("Invalid canonical private input")
            if slot == "source" and (image.width != manifest["width"] or image.height != manifest["height"]):
                raise ValueError("Source dimensions do not match the pinned request")
            pixels = np.array(image.convert("RGB"), dtype=np.float32) / 255.0
        return (torch.from_numpy(pixels)[None, ...],)


class PrivateInstruction:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"identity": ("STRING",), "authorization": ("STRING",)}, "hidden": {"prompt": "PROMPT"}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    RETURN_TYPES = ("STRING",)
    FUNCTION = "load"
    CATEGORY = "Evergreen/private"

    def load(self, identity, authorization, prompt):
        manifest = verify(identity, authorization, prompt)
        text = JOBS.read_blob(identity, "instruction").decode()
        # Native SAM3 defaults to one instance. Keep its category/count syntax
        # server-owned; the request validator admits a single short description.
        return (text + ":12" if manifest.get("operation") == "selection" else text,)


class PrivateSampler:
    @classmethod
    def INPUT_TYPES(cls):
        inputs = nodes.KSampler.INPUT_TYPES()
        inputs["required"] = {**inputs["required"], "identity": ("STRING",), "authorization": ("STRING",)}
        inputs["hidden"] = {"prompt": "PROMPT"}
        return inputs

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "sample"
    CATEGORY = "Evergreen/private"

    def sample(self, identity, authorization, prompt, model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent_image, denoise=1.0):
        verify(identity, authorization, prompt)
        latent = latent_image["samples"]
        latent = comfy.sample.fix_empty_latent_channels(model, latent,
            latent_image.get("downscale_ratio_spacial"), latent_image.get("downscale_ratio_temporal"))
        noise = comfy.sample.prepare_noise(latent, seed, latent_image.get("batch_index"))
        # Do not use common_ksampler: its callback sends decodable private
        # latent previews to every connected public websocket client.
        samples = comfy.sample.sample(model, noise, steps, cfg, sampler_name, scheduler, positive, negative, latent,
            denoise=denoise, noise_mask=latent_image.get("noise_mask"), callback=None, disable_pbar=True, seed=seed)
        result = latent_image.copy()
        result.pop("downscale_ratio_spacial", None)
        result.pop("downscale_ratio_temporal", None)
        result["samples"] = samples
        return (result,)


class PrivateOutput:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "identity": ("STRING",), "authorization": ("STRING",)}, "hidden": {"prompt": "PROMPT"}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "save"
    CATEGORY = "Evergreen/private"

    def save(self, images, identity, authorization, prompt):
        manifest = verify(identity, authorization, prompt)
        if manifest.get("operation") == "selection":
            raise ValueError("Selections require private geometry output")
        if len(images) != 1 or images.shape[2] != manifest["width"] or images.shape[1] != manifest["height"]:
            raise ValueError("Private output dimensions changed")
        pixels = np.clip(images[0].cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
        output = io.BytesIO()
        Image.fromarray(pixels).save(output, format="PNG")
        JOBS.complete(identity, output.getvalue())
        # No SaveImage filename, workflow metadata, preview image or /view URL.
        return {"ui": {"private_receipt": [identity]}}


class PrivateSelectionOutput:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"masks": ("MASK",), "bboxes": ("BOUNDING_BOX",), "identity": ("STRING",),
            "authorization": ("STRING",)}, "hidden": {"prompt": "PROMPT"}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "save"
    CATEGORY = "Evergreen/private"

    def save(self, masks, bboxes, identity, authorization, prompt):
        manifest = verify(identity, authorization, prompt)
        if manifest.get("operation") != "selection":
            raise ValueError("Geometry output requires a selection job")
        if len(bboxes) != 1 or not isinstance(bboxes[0], list):
            raise ValueError("Invalid selection instances")
        data = describe_masks(masks.detach().cpu().numpy(), bboxes[0],
            JOBS.read_blob(identity, "instruction").decode(), manifest["width"], manifest["height"])
        encoded = canonical(data)
        if len(encoded) > 1024 * 1024:
            raise ValueError("Private geometry exceeds its bound")
        JOBS.complete(identity, encoded)
        return {"ui": {"private_receipt": [identity]}}


NODE_CLASS_MAPPINGS = {"EvergreenPrivateImage": PrivateImage, "EvergreenPrivateInstruction": PrivateInstruction,
    "EvergreenPrivateSampler": PrivateSampler, "EvergreenPrivateOutput": PrivateOutput,
    "EvergreenPrivateSelectionOutput": PrivateSelectionOutput}


def build_graph(manifest):
    identity = manifest["id"]
    private = {"identity": identity, "authorization": ""}
    if manifest.get("operation") == "selection":
        return {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sam3.1_multiplex_fp16.safetensors"}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["1", 1], "text": ["13", 0]}},
            "7": {"class_type": "SAM3_Detect", "inputs": {"model": ["1", 0], "image": ["10", 0],
                "conditioning": ["4", 0], "threshold": 0.5, "refine_iterations": 2, "individual_masks": True}},
            "9": {"class_type": "EvergreenPrivateSelectionOutput", "inputs": {**private, "masks": ["7", 0], "bboxes": ["7", 1]}},
            "10": {"class_type": "EvergreenPrivateImage", "inputs": {**private, "slot": "source"}},
            "13": {"class_type": "EvergreenPrivateInstruction", "inputs": private.copy()},
        }
    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_edit_2509_fp8_e4m3fn.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "cpu"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "4": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["2", 0], "prompt": ["13", 0], "vae": ["3", 0], "image1": ["10", 0]}},
        "5": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["2", 0], "prompt": "", "vae": ["3", 0], "image1": ["10", 0]}},
        "6": {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": ["3", 0]}},
        "7": {"class_type": "EvergreenPrivateSampler", "inputs": {**private, "model": ["14", 0], "positive": ["4", 0],
            "negative": ["5", 0], "latent_image": ["6", 0], "seed": manifest["seed"], "steps": 20, "cfg": 2.5,
            "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "EvergreenPrivateOutput", "inputs": {**private, "images": ["8", 0]}},
        "10": {"class_type": "EvergreenPrivateImage", "inputs": {**private, "slot": "source"}},
        "12": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.0}},
        "13": {"class_type": "EvergreenPrivateInstruction", "inputs": private.copy()},
        "14": {"class_type": "CFGNorm", "inputs": {"model": ["12", 0], "strength": 1}},
    }
    if manifest["reference"]:
        graph["11"] = {"class_type": "EvergreenPrivateImage", "inputs": {**private, "slot": "reference"}}
        graph["4"]["inputs"]["image2"] = ["11", 0]
        graph["5"]["inputs"]["image2"] = ["11", 0]
    if manifest.get("reference2"):
        graph["15"] = {"class_type": "EvergreenPrivateImage", "inputs": {**private, "slot": "reference2"}}
        graph["4"]["inputs"]["image3"] = ["15", 0]
        graph["5"]["inputs"]["image3"] = ["15", 0]
    if manifest.get("operation") == "viewpoint":
        graph["1"] = {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "qwen-image-edit-2511-Q6_K.gguf"}}
    return graph


def supports_reference(slot="image2"):
    encoder = nodes.NODE_CLASS_MAPPINGS.get("TextEncodeQwenImageEditPlus")
    if encoder is None:
        return False
    try:
        inputs = encoder.INPUT_TYPES()
        return slot in {**inputs.get("required", {}), **inputs.get("optional", {})}
    except (AttributeError, TypeError, ValueError):
        return False


def ready_assets(operation=None):
    if operation == "selection":
        return ("sam3.1_multiplex_fp16.safetensors" in folder_paths.get_filename_list("checkpoints")
            and all(name in nodes.NODE_CLASS_MAPPINGS for name in ["SAM3_Detect", "CheckpointLoaderSimple", "CLIPTextEncode"]))
    if operation == "viewpoint":
        loader = nodes.NODE_CLASS_MAPPINGS.get("UnetLoaderGGUF")
        if loader is None:
            return False
        try:
            choices = loader.INPUT_TYPES()["required"]["unet_name"][0]
            return ("qwen-image-edit-2511-Q6_K.gguf" in choices
                and "qwen_2.5_vl_7b_fp8_scaled.safetensors" in folder_paths.get_filename_list("text_encoders")
                and "qwen_image_vae.safetensors" in folder_paths.get_filename_list("vae")
                and all(name in nodes.NODE_CLASS_MAPPINGS for name in ["TextEncodeQwenImageEditPlus", "CFGNorm"]))
        except (AttributeError, KeyError, TypeError, ValueError):
            return False
    required = {"diffusion_models": "qwen_image_edit_2509_fp8_e4m3fn.safetensors",
        "text_encoders": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "vae": "qwen_image_vae.safetensors"}
    return (all(name in folder_paths.get_filename_list(folder) for folder, name in required.items())
        and all(name in nodes.NODE_CLASS_MAPPINGS for name in ["TextEncodeQwenImageEditPlus", "CFGNorm"]))


def start_routes(jobs):
    server = PromptServer.instance
    install_runtime_boundary(server, execution.PromptExecutor)

    @web.middleware
    async def authentication(request, handler):
        try:
            loopback = ipaddress.ip_address(request.remote or "").is_loopback
        except ValueError:
            loopback = False
        credential = jobs.authenticated(request.headers.get("Authorization"))
        private = request.path.startswith("/evergreen-private/")
        if request.path == "/ws" and request.query.get("clientId", "").startswith("evergreen-private:"):
            return web.json_response({"error": "Private jobs do not expose websocket streams"}, status=403)
        probe = request.method == "GET" and request.path == "/system_stats"
        # Never trust forwarded-for headers, LAN addresses, or a proxy peer.
        if (private and not credential) or (not private and not loopback and not credential and not probe):
            return web.json_response({"error": "Authentication required"}, status=401)
        return await handler(request)

    server.app.middlewares.append(authentication)
    routes = server.routes
    headers = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}

    @routes.get("/evergreen-private/images")
    async def capabilities(request):
        return web.json_response({"protocol": PROTOCOL, "ok": ready_assets(), "twoImages": supports_reference(), "steps": 20,
            "encryptedStorage": True, "noPublicPreviews": True,
            "threeImages": supports_reference("image3"), "maxReferences": 2 if supports_reference("image3") else (1 if supports_reference() else 0),
            "selections": {"ready": ready_assets("selection"), "model": "sam3.1"},
            "viewpoints": {"ready": ready_assets("viewpoint"), "model": "qwen-image-edit-2511-q6"},
            "layers": {"ready": False}}, headers=headers)

    @routes.post("/evergreen-private/images")
    async def create(request):
        return await create_job(request, selection=False)

    @routes.post("/evergreen-private/selections")
    async def create_selection(request):
        return await create_job(request, selection=True)

    async def create_job(request, selection):
        max_body = 29 * 1024 * 1024 if selection else MAX_BODY
        if request.content_length and request.content_length > max_body:
            return web.json_response({"error": "Image payload too large"}, status=413, headers=headers)
        payload = bytearray()
        try:
            async for chunk in request.content.iter_chunked(64 * 1024):
                payload.extend(chunk)
                if len(payload) > max_body:
                    return web.json_response({"error": "Image payload too large"}, status=413, headers=headers)
            body = json.loads(payload)
            allowed = {"id", "source", "query", "width", "height"} if selection else {
                "id", "source", "reference", "reference2", "instruction", "seed", "width", "height", "operation"}
            if not isinstance(body, dict) or set(body) - allowed:
                raise ValueError("Unexpected private job fields")
            operation = "selection" if selection else body.get("operation")
            if not selection and operation not in {None, "viewpoint"}:
                raise ValueError("Invalid image operation")
            if not ready_assets(operation):
                return web.json_response({"error": "Pinned private model unavailable"}, status=503, headers=headers)
            if body.get("reference") and not supports_reference():
                return web.json_response({"error": "Second image input unavailable"}, status=503, headers=headers)
            if body.get("reference2") and not supports_reference("image3"):
                return web.json_response({"error": "Third image input unavailable"}, status=503, headers=headers)
            source = base64.b64decode(body["source"], validate=True)
            reference = base64.b64decode(body["reference"], validate=True) if body.get("reference") else None
            reference2 = base64.b64decode(body["reference2"], validate=True) if body.get("reference2") else None
            manifest, fresh = jobs.reserve(body["id"], source, reference, body["query"] if selection else body["instruction"],
                0 if selection else body["seed"], body["width"], body["height"], reference2=reference2, operation=operation)
            if fresh:
                graph = build_graph(manifest)
                # Validate without logging private inputs or instructions.
                valid = await execution.validate_prompt(manifest["id"], graph, None)
                if not valid[0]:
                    jobs.erase(manifest["id"], "failed")
                    return web.json_response({"error": "Pinned image workflow unavailable"}, status=503, headers=headers)
                authorization = jobs.authorize_graph(manifest["id"], graph)
                for node in graph.values():
                    if node["class_type"].startswith("EvergreenPrivate"):
                        node["inputs"]["authorization"] = authorization
                number = server.number
                server.number += 1
                server.prompt_queue.put((number, manifest["id"], graph, {"client_id": "evergreen-private:" + manifest["id"]}, valid[2], {}))
            return web.json_response({"prompt_id": manifest["id"]}, headers=headers)
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "Invalid private image job"}, status=400, headers=headers)
        except Exception:
            return web.json_response({"error": "Private job receipt is uncertain"}, status=503, headers=headers)

    @routes.get("/evergreen-private/images/{identity}")
    async def status(request):
        try:
            identity = job_id(request.match_info["identity"])
            manifest = jobs.status(identity)
            state = manifest["state"]
            history = server.prompt_queue.get_history(prompt_id=identity)
            if state == "processing" and identity in history and history[identity].get("status", {}).get("status_str") == "error":
                jobs.erase(identity, "failed")
                state = "failed"
            if state == "consumed":
                return web.json_response({"status": "consumed"}, headers=headers)
            if state == "completed":
                return web.json_response({"status": "completed", "sha256": manifest["outputSha256"],
                    "contentType": "application/json" if manifest.get("operation") == "selection" else "image/png"}, headers=headers)
            return web.json_response({"status": "processing" if state in {"reserved", "processing"} else "failed"}, headers=headers)
        except (ValueError, KeyError):
            return web.json_response({"status": "failed"}, headers=headers)

    @routes.get("/evergreen-private/images/{identity}/output")
    async def output(request):
        try:
            identity = job_id(request.match_info["identity"])
            manifest = jobs.status(identity)
            if manifest["state"] != "completed":
                raise KeyError("Output unavailable")
            return web.Response(body=jobs.read_blob(identity, "output"),
                content_type="application/json" if manifest.get("operation") == "selection" else "image/png", headers=headers)
        except (ValueError, KeyError, FileNotFoundError):
            return web.json_response({"error": "Private output unavailable"}, status=404, headers=headers)

    @routes.post("/evergreen-private/images/{identity}/ack")
    async def acknowledge(request):
        try:
            identity = job_id(request.match_info["identity"])
            if request.content_length and request.content_length > 1024:
                raise ValueError("Invalid receipt")
            body = await request.content.read(1025)
            if len(body) > 1024:
                raise ValueError("Invalid receipt")
            jobs.acknowledge(identity, json.loads(body)["sha256"])
            return web.json_response({"removed": True}, headers=headers)
        except (ValueError, KeyError):
            return web.json_response({"error": "Private output receipt mismatch"}, status=409, headers=headers)

    @routes.delete("/evergreen-private/images/{identity}")
    async def erase(request):
        try:
            jobs.erase(job_id(request.match_info["identity"]), "expired")
            return web.json_response({"removed": True}, headers=headers)
        except KeyError:
            return web.json_response({"removed": True}, headers=headers)
        except ValueError:
            return web.json_response({"error": "Invalid private job identity"}, status=400, headers=headers)

    def cleanup_loop():
        while True:
            threading.Event().wait(60)
            try:
                jobs.expire()
            except Exception:
                # Fail closed in job reads; do not print inputs or credentials.
                pass

    threading.Thread(target=cleanup_loop, name="private-image-cleanup", daemon=True).start()


if KEY_FILE and ROOT:
    JOBS = PrivateJobs(ROOT, KEY_FILE)
    for public_directory in [folder_paths.get_input_directory(), folder_paths.get_output_directory()]:
        if os.path.commonpath([os.path.abspath(ROOT), os.path.abspath(public_directory)]) == os.path.abspath(public_directory):
            raise ValueError("Private image storage must be outside Comfy media directories")
    start_routes(JOBS)
