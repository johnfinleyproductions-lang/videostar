"""Exercise real HTTP/routes with a synthetic queue. No GPU/models/photos."""
import asyncio
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
import uuid

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image
import numpy as np


class PrivateHTTP(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.key = self.base / "key"
        self.key.write_text("ab" * 32)
        self.key.chmod(0o600)
        self.auth = {"Authorization": "Bearer " + "ab" * 32}
        self.queued = []
        self.sample_calls = []
        app = web.Application()
        server = SimpleNamespace(app=app, routes=web.RouteTableDef(), number=0, client_id=None,
            send_sync=lambda *args: None, prompt_queue=SimpleNamespace(put=self.queued.append, get_history=lambda **kwargs: {}))

        class Executor:
            def execute(self, *args):
                pass
            def handle_execution_error(self, *args):
                pass

        async def validate(identity, graph, partial):
            self.assertFalse(any(n["class_type"] in {"LoadImage", "SaveImage", "KSampler"} for n in graph.values()))
            self.assertNotIn("Change the face", json.dumps(graph))
            return True, None, ["9"], {}

        def mod(name, **values):
            result = ModuleType(name)
            result.__dict__.update(values)
            sys.modules[name] = result
            return result

        sample = mod("comfy.sample", fix_empty_latent_channels=lambda model, latent, *args: latent,
            prepare_noise=lambda *args: "noise", sample=lambda *args, **kw: self.sample_calls.append(kw) or np.zeros((1, 4, 8, 8)))
        mod("comfy", sample=sample)
        mod("torch", from_numpy=lambda data: data)
        mod("execution", validate_prompt=validate, PromptExecutor=Executor)
        mod("server", PromptServer=SimpleNamespace(instance=server))
        assets = {"diffusion_models": "qwen_image_edit_2509_fp8_e4m3fn.safetensors",
            "text_encoders": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "vae": "qwen_image_vae.safetensors",
            "checkpoints": "sam3.1_multiplex_fp16.safetensors"}
        self.gguf = self.base / "qwen-image-edit-2511-Q6_K.gguf"
        self.gguf.write_bytes(b"GGUF\x03\x00\x00\x00")
        mod("folder_paths", get_filename_list=lambda folder: [assets[folder]],
            get_full_path=lambda folder, name: str(self.gguf),
            get_input_directory=lambda: str(self.base / "public-input"), get_output_directory=lambda: str(self.base / "public-output"))
        mod("nodes", NODE_CLASS_MAPPINGS={"TextEncodeQwenImageEditPlus": SimpleNamespace(INPUT_TYPES=lambda: {"optional": {"image2": ("IMAGE",), "image3": ("IMAGE",)}})},
            KSampler=SimpleNamespace(INPUT_TYPES=lambda: {"required": {}}))
        sys.modules["nodes"].NODE_CLASS_MAPPINGS["CFGNorm"] = object()
        for name in ["SAM3_Detect", "CheckpointLoaderSimple", "CLIPTextEncode"]:
            sys.modules["nodes"].NODE_CLASS_MAPPINGS[name] = object()
        sys.modules["nodes"].NODE_CLASS_MAPPINGS["UnetLoaderGGUF"] = SimpleNamespace(INPUT_TYPES=lambda: {
            "required": {"unet_name": (["qwen-image-edit-2511-Q6_K.gguf"],)}})
        os.environ.pop("EVERGREEN_PRIVATE_IMAGE_KEY_FILE", None)
        os.environ.pop("EVERGREEN_PRIVATE_IMAGE_ROOT", None)
        package = Path(__file__).resolve().parents[1] / "comfy-nodes/evergreen_private_images"
        spec = importlib.util.spec_from_file_location("http_private", package / "__init__.py", submodule_search_locations=[str(package)])
        plugin = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = plugin
        spec.loader.exec_module(plugin)
        plugin.JOBS = plugin.PrivateJobs(self.base / "jobs", self.key)
        plugin.start_routes(plugin.JOBS)
        self.plugin = plugin
        self.app = app
        server.routes.get("/system_stats")(lambda request: web.json_response({"ok": True}))
        app.add_routes(server.routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        image = io.BytesIO()
        Image.new("RGB", (768, 768), "blue").save(image, format="PNG")
        self.png = image.getvalue()
        self.id = str(uuid.uuid4())
        self.payload = {"id": self.id, "source": base64.b64encode(self.png).decode(),
            "reference": base64.b64encode(self.png).decode(), "instruction": "Change the face from image two", "seed": 42, "width": 768, "height": 768}

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    async def test_auth_queue_signed_nodes_output_and_exact_ack(self):
        base = "/evergreen-private/images"
        self.assertEqual((await self.client.get(base)).status, 401)
        self.assertEqual((await self.client.get(base, headers={"Authorization": "Bearer wrong"})).status, 401)
        capabilities = await (await self.client.get(base, headers=self.auth)).json()
        self.assertEqual(capabilities["protocol"], "evergreen-private-images-v1")
        self.assertTrue(capabilities["twoImages"])
        for _ in range(2):
            response = await self.client.post(base, headers=self.auth, json=self.payload)
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())["prompt_id"], self.id)
        self.assertEqual(len(self.queued), 1)
        graph = self.queued[0][2]
        self.assertEqual(self.queued[0][3]["client_id"], "evergreen-private:" + self.id)
        self.assertEqual(graph["4"]["inputs"]["image2"], ["11", 0])
        self.assertEqual(graph["5"]["inputs"]["image1"], ["10", 0])
        self.assertEqual(graph["5"]["inputs"]["image2"], ["11", 0])
        self.assertEqual(graph["14"], {"class_type": "CFGNorm", "inputs": {"model": ["12", 0], "strength": 1}})
        self.assertEqual(graph["7"]["inputs"]["model"], ["14", 0])
        authorization = graph["10"]["inputs"]["authorization"]
        source = self.plugin.PrivateImage().load(self.id, "source", authorization, graph)[0]
        self.assertEqual(source.shape, (1, 768, 768, 3))
        self.assertEqual(self.plugin.PrivateInstruction().load(self.id, authorization, graph)[0], self.payload["instruction"])
        self.plugin.PrivateSampler().sample(self.id, authorization, graph, object(), 42, 20, 2.5,
            "euler", "simple", object(), object(), {"samples": np.zeros((1, 4, 8, 8))})
        self.assertIsNone(self.sample_calls[0]["callback"])
        self.assertTrue(self.sample_calls[0]["disable_pbar"])
        self.plugin.JOBS.complete(self.id, self.png)
        digest = hashlib.sha256(self.png).hexdigest()
        self.assertEqual((await (await self.client.get(base + "/" + self.id, headers=self.auth)).json())["sha256"], digest)
        self.assertEqual(await (await self.client.get(base + "/" + self.id + "/output", headers=self.auth)).read(), self.png)
        self.assertEqual((await self.client.post(base + "/" + self.id + "/ack", headers=self.auth, json={"sha256": "0" * 64})).status, 409)
        for _ in range(2):
            self.assertEqual((await self.client.post(base + "/" + self.id + "/ack", headers=self.auth, json={"sha256": digest})).status, 200)
        self.assertEqual((await self.client.get(base + "/" + self.id + "/output", headers=self.auth)).status, 404)
        self.assertFalse(list((self.base / "jobs").rglob("*.sealed")))

    async def test_reference_capability_matches_encoder_inputs(self):
        base = "/evergreen-private/images"
        sys.modules["nodes"].NODE_CLASS_MAPPINGS["TextEncodeQwenImageEditPlus"] = SimpleNamespace(INPUT_TYPES=lambda: {"required": {}})
        capabilities = await (await self.client.get(base, headers=self.auth)).json()
        self.assertTrue(capabilities["ok"])
        self.assertFalse(capabilities["twoImages"])
        self.assertEqual((await self.client.post(base, headers=self.auth, json=self.payload)).status, 503)
        self.assertFalse(self.queued)

    async def test_three_images_are_encrypted_conditioned_and_identity_bound(self):
        base = "/evergreen-private/images"
        capabilities = await (await self.client.get(base, headers=self.auth)).json()
        self.assertTrue(capabilities["threeImages"])
        self.assertEqual(capabilities["maxReferences"], 2)
        payload = {**self.payload, "reference2": self.payload["source"]}
        response = await self.client.post(base, headers=self.auth, json=payload)
        self.assertEqual(response.status, 200)
        graph = self.queued[0][2]
        for node in ["4", "5"]:
            self.assertEqual(graph[node]["inputs"]["image3"], ["15", 0])
        self.assertEqual(graph["15"]["inputs"]["slot"], "reference2")
        self.assertEqual(self.plugin.JOBS.read_blob(self.id, "reference2"), self.png)
        self.assertEqual((await self.client.post(base, headers=self.auth, json=self.payload)).status, 400)
        self.assertEqual((await self.client.post(base, headers=self.auth, json=payload)).status, 200)
        self.assertEqual(len(self.queued), 1)

    async def test_third_input_fail_closed_and_viewpoint_uses_only_pinned_2511(self):
        base = "/evergreen-private/images"
        encoder = sys.modules["nodes"].NODE_CLASS_MAPPINGS["TextEncodeQwenImageEditPlus"]
        sys.modules["nodes"].NODE_CLASS_MAPPINGS["TextEncodeQwenImageEditPlus"] = SimpleNamespace(INPUT_TYPES=lambda: {"optional": {"image2": ("IMAGE",)}})
        self.assertEqual((await self.client.post(base, headers=self.auth, json={**self.payload, "reference2": self.payload["source"]})).status, 503)
        sys.modules["nodes"].NODE_CLASS_MAPPINGS["TextEncodeQwenImageEditPlus"] = encoder
        payload = {**{k: v for k, v in self.payload.items() if k != "reference"}, "operation": "viewpoint"}
        self.assertEqual((await self.client.post(base, headers=self.auth, json=payload)).status, 200)
        graph = self.queued[0][2]
        self.assertEqual(graph["1"], {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "qwen-image-edit-2511-Q6_K.gguf"}})
        self.assertFalse(any("Lora" in n["class_type"] for n in graph.values()))
        self.assertEqual((await self.client.post(base, headers=self.auth, json={k:v for k,v in payload.items() if k != "operation"})).status, 400)
        sys.modules["nodes"].NODE_CLASS_MAPPINGS.pop("UnetLoaderGGUF")
        capabilities = await (await self.client.get(base, headers=self.auth)).json()
        self.assertFalse(capabilities["viewpoints"]["ready"])
        self.assertEqual((await self.client.post(base, headers=self.auth, json={**payload, "id":str(uuid.uuid4())})).status, 503)

    async def test_sparse_truncated_or_missing_viewpoint_asset_is_unavailable(self):
        base = "/evergreen-private/images"
        payload = {**{k:v for k,v in self.payload.items() if k != "reference"}, "operation":"viewpoint"}
        for contents in [b"\x00" * 32, b"GGUF", b"GGUF\xff\x00\x00\x00"]:
            self.gguf.write_bytes(contents)
            capabilities = await (await self.client.get(base, headers=self.auth)).json()
            self.assertFalse(capabilities["viewpoints"]["ready"])
            self.assertTrue(capabilities["selections"]["ready"])
            self.assertEqual((await self.client.post(base, headers=self.auth, json=payload)).status,503)
        self.gguf.unlink()
        self.assertFalse((await (await self.client.get(base, headers=self.auth)).json())["viewpoints"]["ready"])
        self.assertEqual(len(self.queued),0)

    async def test_selection_authenticated_queued_geometry_and_ack(self):
        selection = "/evergreen-private/selections"
        base = "/evergreen-private/images/" + self.id
        payload = {"id": self.id, "source": self.payload["source"], "width":768, "height":768, "query":"person"}
        self.assertEqual((await self.client.post(selection, json=payload)).status, 401)
        for _ in range(2):
            self.assertEqual((await self.client.post(selection, headers=self.auth, json=payload)).status, 200)
        self.assertEqual(len(self.queued), 1)
        graph = self.queued[0][2]
        self.assertNotIn("person", json.dumps(graph))
        self.assertEqual(graph["1"]["inputs"]["ckpt_name"], "sam3.1_multiplex_fp16.safetensors")
        self.assertEqual(graph["7"]["class_type"], "SAM3_Detect")
        self.assertTrue(graph["7"]["inputs"]["individual_masks"])
        tag = graph["13"]["inputs"]["authorization"]
        self.assertEqual(self.plugin.PrivateInstruction().load(self.id, tag, graph)[0], "person:12")
        mask = np.zeros((1,768,768), np.float32)
        mask[0,100:500,100:500] = 1
        mask[0,200:300,200:300] = 0
        tensor = SimpleNamespace(detach=lambda: SimpleNamespace(cpu=lambda: SimpleNamespace(numpy=lambda: mask)))
        self.plugin.PrivateSelectionOutput().save(tensor, [[{"score":0.9}]], self.id, tag, graph)
        status = await (await self.client.get(base, headers=self.auth)).json()
        self.assertEqual(status["contentType"], "application/json")
        response = await self.client.get(base + "/output", headers=self.auth)
        self.assertEqual(response.content_type, "application/json")
        raw = await response.read()
        data = json.loads(raw)
        self.assertTrue(data["approximate"])
        self.assertEqual(data["query"], "person")
        shapes = data["suggestions"][0]["shapes"]
        self.assertEqual([shape["operation"] for shape in shapes], ["add", "subtract"])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), status["sha256"])
        self.assertEqual((await self.client.post(base + "/ack", headers=self.auth, json={"sha256":status["sha256"]})).status, 200)
        self.assertEqual((await self.client.get(base + "/output", headers=self.auth)).status, 404)
        self.assertFalse(list((self.base / "jobs").rglob("*.sealed")))

    async def test_selection_category_limits_and_model_readiness(self):
        path = "/evergreen-private/selections"
        payload = {"id": self.id, "source": self.payload["source"], "width":768, "height":768, "query":"person"}
        for query in ["", "person:100000", "person,cup", "a"*121]:
            self.assertEqual((await self.client.post(path, headers=self.auth, json={**payload,"query":query})).status, 400)
        self.assertEqual((await self.client.post(path, headers=self.auth, json={**payload,"reference":self.payload["source"]})).status, 400)
        sys.modules["nodes"].NODE_CLASS_MAPPINGS.pop("SAM3_Detect")
        capabilities = await (await self.client.get("/evergreen-private/images", headers=self.auth)).json()
        self.assertFalse(capabilities["selections"]["ready"])
        self.assertEqual((await self.client.post(path, headers=self.auth, json=payload)).status, 503)
        self.assertFalse(self.queued)

    async def test_single_image_has_matching_visual_conditioning(self):
        payload = {key: value for key, value in self.payload.items() if key != "reference"}
        response = await self.client.post("/evergreen-private/images", headers=self.auth, json=payload)
        self.assertEqual(response.status, 200)
        graph = self.queued[0][2]
        for identity in ["4", "5"]:
            self.assertEqual(graph[identity]["inputs"]["image1"], ["10", 0])
            self.assertNotIn("image2", graph[identity]["inputs"])
        self.assertNotIn("11", graph)

    async def test_erasure_tombstone_and_reserved_websocket_are_closed(self):
        base = "/evergreen-private/images"
        await self.client.post(base, headers=self.auth, json=self.payload)
        self.assertEqual((await self.client.delete(base + "/" + self.id, headers=self.auth)).status, 200)
        with self.assertRaises(ValueError):
            self.plugin.JOBS.complete(self.id, self.png)
        await self.client.post(base, headers=self.auth, json=self.payload)
        self.assertEqual(len(self.queued), 1)
        self.assertEqual((await self.client.get("/ws?clientId=evergreen-private:" + self.id, headers=self.auth)).status, 403)
        self.assertEqual((await self.client.post(base, headers=self.auth, json={**self.payload, "seed": 44})).status, 400)


if __name__ == "__main__":
    unittest.main()
