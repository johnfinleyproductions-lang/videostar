"""Authenticated private video receipts on the existing serialized GPU queue."""
import asyncio
import json

from aiohttp import web

from .store import job_id
from .video_store import (PROTOCOL, WORKFLOW, MODEL, MAX_FRAME_BYTES,
    MAX_SEED_BYTES, MAX_METADATA_BYTES, MAX_FRAMES, MAX_SIDE, MODEL_SHA256, IMPLEMENTATION_SHA256)


def build_graph(manifest):
    if manifest.get("operation") != "video-tracking" or manifest.get("workflow") != WORKFLOW:
        raise ValueError("Unsupported private video workflow")
    return {"9": {"class_type": "EvergreenPrivateVideoTrack", "inputs": {
        "identity": manifest["id"], "authorization": ""}}}


async def bounded_body(request, limit):
    if request.content_length is not None and request.content_length > limit:
        raise ValueError("Private video request exceeds its limit")
    parts, size = [], 0
    async for part in request.content.iter_chunked(64 * 1024):
        size += len(part)
        if size > limit:
            raise ValueError("Private video request exceeds its limit")
        parts.append(part)
    return b"".join(parts)


def install_routes(server, jobs, ready, validate_prompt):
    routes = server.routes
    headers = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
    admission_lock = asyncio.Lock()

    @routes.get("/evergreen-private/videos")
    async def capabilities(request):
        return web.json_response({"protocol": PROTOCOL, "ok": True, "ready": ready(),
            "workflow": WORKFLOW, "model": MODEL, "maxFrames": MAX_FRAMES,
            "modelSha256": MODEL_SHA256, "implementationSha256": IMPLEMENTATION_SHA256,
            "maxDurationSeconds": 3, "maxLongEdge": MAX_SIDE,
            "encryptedStorage": True, "noPublicPreviews": True}, headers=headers)

    @routes.post("/evergreen-private/videos")
    async def reserve(request):
        try:
            body = json.loads(await bounded_body(request, MAX_METADATA_BYTES))
            manifest, _ = await asyncio.to_thread(jobs.reserve_video, body)
            return web.json_response({"id": manifest["id"]}, headers=headers)
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "Invalid private video request"}, status=400, headers=headers)
        except Exception:
            return web.json_response({"error": "Private video receipt is uncertain"}, status=503, headers=headers)

    @routes.put("/evergreen-private/videos/{identity}/frames/{index}")
    @routes.put("/evergreen-private/videos/{identity}/seed")
    async def upload(request):
        try:
            identity = job_id(request.match_info["identity"])
            raw_index = request.match_info.get("index")
            index = int(raw_index) if raw_index is not None else None
            if raw_index is not None and str(index) != raw_index:
                raise ValueError("Invalid private frame index")
            data = await bounded_body(request, MAX_FRAME_BYTES if index is not None else MAX_SEED_BYTES)
            await asyncio.to_thread(jobs.upload, identity, data, index)
            return web.json_response({"id": identity}, headers=headers)
        except (ValueError, KeyError, TypeError, OSError):
            return web.json_response({"error": "Private video upload did not match its receipt"}, status=409, headers=headers)
        except Exception:
            return web.json_response({"error": "Private video upload is uncertain"}, status=503, headers=headers)

    @routes.post("/evergreen-private/videos/{identity}/start")
    async def start(request):
        try:
            identity = job_id(request.match_info["identity"])
            if json.loads(await bounded_body(request, 1024)) != {}:
                raise ValueError("Private video settings are immutable")
            # Validation awaits; serialize its entire admission window so two
            # simultaneous same-ID starts can never enqueue the job twice.
            async with admission_lock:
                manifest = jobs.status(identity)
                if manifest["state"] != "uploading":
                    return web.json_response({"id": identity}, headers=headers)
                if not ready():
                    return web.json_response({"error": "Private video tracker unavailable"}, status=503, headers=headers)
                graph = build_graph(manifest)
                valid = await validate_prompt(identity, graph, None)
                if not valid[0]:
                    return web.json_response({"error": "Pinned video workflow unavailable"}, status=503, headers=headers)
                authorization = await asyncio.to_thread(jobs.authorize_graph, identity, graph)
                graph["9"]["inputs"]["authorization"] = authorization
                number = server.number
                server.number += 1
                server.prompt_queue.put((number, identity, graph, {"client_id": "evergreen-private:" + identity}, valid[2], {}))
            return web.json_response({"id": identity}, headers=headers)
        except (ValueError, KeyError, TypeError, OSError):
            return web.json_response({"error": "Private video inputs are incomplete or closed"}, status=409, headers=headers)
        except Exception:
            return web.json_response({"error": "Private video queue receipt is uncertain"}, status=503, headers=headers)

    @routes.get("/evergreen-private/videos/{identity}")
    async def status(request):
        try:
            identity = job_id(request.match_info["identity"])
            manifest = jobs.status(identity)
            state = manifest["state"]
            history = server.prompt_queue.get_history(prompt_id=identity)
            if state == "processing" and identity in history and history[identity].get("status", {}).get("status_str") == "error":
                jobs.erase(identity, "failed")
                state = "failed"
            if state == "uploading":
                result = {"status": state, "uploadedFrames": manifest["uploadedFrames"], "seedReceived": manifest["seedReceived"]}
            elif state == "processing":
                result = {"status": state, "completedFrames": manifest.get("completedFrames", 0), "totalFrames": manifest["totalFrames"]}
            elif state == "completed":
                result = {"status": state, "sha256": manifest["outputSha256"]}
            else:
                result = {"status": "consumed" if state == "consumed" else "failed"}
            return web.json_response(result, headers=headers)
        except KeyError:
            return web.json_response({"status": "missing"}, status=404, headers=headers)
        except ValueError:
            return web.json_response({"error": "Invalid private video identity"}, status=400, headers=headers)

    @routes.get("/evergreen-private/videos/{identity}/output")
    @routes.get("/evergreen-private/videos/{identity}/masks/{index}")
    async def output(request):
        try:
            identity = job_id(request.match_info["identity"])
            if jobs.status(identity)["state"] != "completed":
                raise KeyError("Private video output unavailable")
            raw_index = request.match_info.get("index")
            slot = "output"
            if raw_index is not None:
                index = int(raw_index)
                if str(index) != raw_index:
                    raise ValueError("Invalid mask index")
                # Pin the downloadable slots to the completed result receipt.
                receipt = json.loads(jobs.read_blob(identity, "output"))
                if index not in [mask["index"] for mask in receipt["masks"]]:
                    raise KeyError("Private mask unavailable")
                slot = f"mask-{index}"
            data = jobs.read_blob(identity, slot)
            return web.Response(body=data, content_type="application/json" if slot == "output" else "image/png", headers=headers)
        except (ValueError, KeyError, FileNotFoundError):
            return web.json_response({"error": "Private video output unavailable"}, status=404, headers=headers)

    @routes.post("/evergreen-private/videos/{identity}/ack")
    async def acknowledge(request):
        try:
            body = json.loads(await bounded_body(request, 1024))
            if set(body) != {"sha256"}:
                raise ValueError("Invalid private receipt")
            jobs.acknowledge(job_id(request.match_info["identity"]), body["sha256"])
            return web.json_response({"removed": True}, headers=headers)
        except (ValueError, KeyError, TypeError):
            return web.json_response({"error": "Private video receipt mismatch"}, status=409, headers=headers)

    @routes.delete("/evergreen-private/videos/{identity}")
    async def erase(request):
        try:
            jobs.erase(job_id(request.match_info["identity"]), "expired")
            return web.json_response({"removed": True}, headers=headers)
        except KeyError:
            return web.json_response({"removed": True}, headers=headers)
        except ValueError:
            return web.json_response({"error": "Invalid private video identity"}, status=400, headers=headers)
