"""Private video HTTP admission and receipts with the shared synthetic queue."""
import asyncio
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
import uuid

here = Path(__file__).resolve().parent
base_spec = importlib.util.spec_from_file_location("video_http_base", here / "test-private-image-http.py")
base = importlib.util.module_from_spec(base_spec)
base_spec.loader.exec_module(base)
fixture_spec = importlib.util.spec_from_file_location("video_fixtures", here / "test-private-video.py")
fixtures = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixtures)


class VideoHTTP(unittest.IsolatedAsyncioTestCase):
    asyncSetUpBase = base.PrivateHTTP.asyncSetUp
    asyncTearDown = base.PrivateHTTP.asyncTearDown

    async def asyncSetUp(self):
        await self.asyncSetUpBase()
        self.plugin.video_tracker.verified_assets = lambda: (None, None)
        self.video_path = "/evergreen-private/videos"
        self.source = fixtures.png()
        self.seed = fixtures.png(color="black", seed=True)
        self.mask = fixtures.png("L", 0, seed=True)
        self.video_body = fixtures.request(self.id, self.source, self.seed)

    async def uploaded(self):
        result = await self.client.post(self.video_path, headers=self.auth, json=self.video_body)
        self.assertEqual(result.status, 200)
        self.assertEqual(await result.json(), {"id": self.id})
        for frame in self.video_body["frames"]:
            response = await self.client.put(f"{self.video_path}/{self.id}/frames/{frame['index']}", headers=self.auth, data=self.source)
            self.assertEqual(response.status, 200)
        response = await self.client.put(f"{self.video_path}/{self.id}/seed", headers=self.auth, data=self.seed)
        self.assertEqual(response.status, 200)

    async def test_all_routes_require_auth_and_never_public_video_paths(self):
        for method, path in [("get", ""), ("post", ""), ("get", f"/{self.id}"),
                ("put", f"/{self.id}/seed"), ("put", f"/{self.id}/frames/0"),
                ("post", f"/{self.id}/start"), ("get", f"/{self.id}/output"),
                ("get", f"/{self.id}/masks/0"), ("post", f"/{self.id}/ack"), ("delete", f"/{self.id}")]:
            self.assertEqual((await getattr(self.client, method)(self.video_path + path)).status, 401)
        caps = await (await self.client.get(self.video_path, headers=self.auth)).json()
        self.assertTrue(caps["ready"])
        self.assertEqual(caps["workflow"], fixtures.video.WORKFLOW)
        self.assertEqual(caps["maxFrames"], 90)
        self.assertEqual(caps["maxLongEdge"], 640)
        await self.uploaded()
        await self.client.post(f"{self.video_path}/{self.id}/start", headers=self.auth, json={})
        graph = self.queued[0][2]
        self.assertEqual(set(graph), {"9"})
        self.assertEqual(graph["9"]["class_type"], "EvergreenPrivateVideoTrack")
        self.assertEqual(set(graph["9"]["inputs"]), {"identity", "authorization"})
        self.assertNotIn("sourceSha256", json.dumps(graph))
        self.assertNotIn("frame-0", json.dumps(graph))
        self.assertEqual(self.public_events, [])
        self.assertFalse((self.base / "public-input").exists())
        self.assertFalse((self.base / "public-output").exists())
        public = await self.client.get(f"/view?filename=mask-0.sealed&subfolder={self.id}&type=output")
        self.assertEqual(public.status, 404)

    async def test_concurrent_start_queues_once_replays_closed_receipts(self):
        await self.uploaded()
        status = await (await self.client.get(f"{self.video_path}/{self.id}", headers=self.auth)).json()
        self.assertEqual(status, {"status": "uploading", "uploadedFrames": [0, 1, 2], "seedReceived": True})
        results = await asyncio.gather(*[self.client.post(f"{self.video_path}/{self.id}/start", headers=self.auth, json={}) for _ in range(3)])
        self.assertTrue(all(r.status == 200 for r in results))
        self.assertEqual(len(self.queued), 1)
        status = await (await self.client.get(f"{self.video_path}/{self.id}", headers=self.auth)).json()
        self.assertEqual(status, {"status": "processing", "completedFrames": 0, "totalFrames": 3})
        jobs = self.plugin.VIDEO_JOBS
        for i in range(3):
            jobs.save_mask(self.id, i, self.mask)
        jobs.finish_video(self.id)
        status = await (await self.client.get(f"{self.video_path}/{self.id}", headers=self.auth)).json()
        output = await self.client.get(f"{self.video_path}/{self.id}/output", headers=self.auth)
        receipt = await output.read()
        self.assertEqual(output.headers["Cache-Control"], "private, no-store")
        self.assertEqual(hashlib.sha256(receipt).hexdigest(), status["sha256"])
        for mask in json.loads(receipt)["masks"]:
            data = await (await self.client.get(f"{self.video_path}/{self.id}/masks/{mask['index']}", headers=self.auth)).read()
            self.assertEqual(hashlib.sha256(data).hexdigest(), mask["sha256"])
        self.assertEqual((await self.client.get(f"{self.video_path}/{self.id}/masks/3", headers=self.auth)).status, 404)
        self.assertEqual((await self.client.post(f"{self.video_path}/{self.id}/ack", headers=self.auth, json={"sha256": "f" * 64})).status, 409)
        self.assertEqual((await self.client.post(f"{self.video_path}/{self.id}/ack", headers=self.auth, json={"sha256": status["sha256"]})).status, 200)
        self.assertEqual((await self.client.get(f"{self.video_path}/{self.id}/masks/0", headers=self.auth)).status, 404)
        await self.client.post(f"{self.video_path}/{self.id}/start", headers=self.auth, json={})
        self.assertEqual(len(self.queued), 1)
        self.assertEqual(list((jobs.root / self.id).glob("*.sealed")), [])

    async def test_incomplete_mismatch_and_missing_model_fail_closed(self):
        unknown = await self.client.get(f"{self.video_path}/{self.id}", headers=self.auth)
        self.assertEqual(unknown.status, 404)
        self.assertEqual(await unknown.json(), {"status": "missing"})
        await self.client.post(self.video_path, headers=self.auth, json=self.video_body)
        path = f"{self.video_path}/{self.id}"
        self.assertEqual((await self.client.post(path + "/start", headers=self.auth, json={})).status, 409)
        self.assertEqual((await self.client.put(path + "/frames/0", headers=self.auth, data=b"wrong")).status, 409)
        changed = copy.deepcopy(self.video_body)
        changed["sourceSha256"] = "b" * 64
        self.assertEqual((await self.client.post(self.video_path, headers=self.auth, json=changed)).status, 400)
        self.assertEqual(self.queued, [])
        await self.uploaded()
        def unavailable():
            raise ValueError("Missing pinned assets")
        self.plugin.video_tracker.verified_assets = unavailable
        self.assertEqual((await self.client.post(path + "/start", headers=self.auth, json={})).status, 503)
        self.assertEqual(self.queued, [])
        self.assertEqual((await self.client.delete(path, headers=self.auth)).status, 200)
        self.assertEqual(await (await self.client.get(path, headers=self.auth)).json(), {"status": "failed"})
        self.assertEqual(list((self.plugin.VIDEO_JOBS.root / self.id).glob("*.sealed")), [])

    async def test_expired_duplicate_and_malformed_start_never_enqueue(self):
        await self.uploaded()
        path = f"{self.video_path}/{self.id}"
        for changed in [{"workflow": "different"}, {"seed": "new"}, []]:
            response = await self.client.post(path + "/start", headers=self.auth, json=changed)
            self.assertEqual(response.status, 409)
        self.assertEqual(self.queued, [])
        jobs = self.plugin.VIDEO_JOBS
        jobs.clock = lambda: jobs._manifest(self.id)["createdAt"] + fixtures.video.UPLOAD_TTL + 1
        for _ in range(2):
            response = await self.client.post(path + "/start", headers=self.auth, json={})
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"id": self.id})
        self.assertEqual(self.queued, [])
        self.assertEqual(await (await self.client.get(path, headers=self.auth)).json(), {"status": "failed"})
        self.assertEqual(list((jobs.root / self.id).glob("*.sealed")), [])

    async def test_delete_before_reserve_blocks_delayed_request(self):
        path = f"{self.video_path}/{self.id}"
        for _ in range(2):
            self.assertEqual((await self.client.delete(path, headers=self.auth)).status, 200)
        self.assertEqual((await self.client.post(self.video_path, headers=self.auth, json=self.video_body)).status, 400)
        self.assertEqual((await self.client.put(path + "/frames/0", headers=self.auth, data=self.source)).status, 409)
        self.assertEqual((await self.client.post(path + "/start", headers=self.auth, json={})).status, 200)
        self.assertEqual(await (await self.client.get(path, headers=self.auth)).json(), {"status": "failed"})
        self.assertEqual(self.queued, [])
        self.assertEqual(list((self.plugin.VIDEO_JOBS.root / self.id).glob("*.sealed")), [])


if __name__ == "__main__":
    unittest.main()
