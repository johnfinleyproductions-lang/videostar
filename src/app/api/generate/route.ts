// POST /api/generate — Queue a video generation to ComfyUI
//
// Routing rule: request WITH an input image → Wan 2.2 I2V template lane;
// request WITHOUT an image → LTX 2.3 Flash AV template lane (24fps + audio).
// An explicitly requested LTX profile is honored either way (Flash conditions
// on a start frame natively). Public contract unchanged:
// returns { id, comfyPromptId, clientId, status: "processing" }.
//
// Optional "laneKey" (additive, see GET /api/lanes + src/lib/lanes.ts):
// resolves to the lane's mapped profile before the normal routing rule runs.
// An explicit "model"/"profile" always wins over laneKey; the response shape
// is identical either way.

import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import {
  freeComfyMemory,
  getFileHeadBytes,
  queuePrompt,
  unloadOllamaModels,
  uploadInputAudio,
  uploadInputImage,
  uploadInputVideo,
} from "@/lib/comfyui-client";
import {
  buildTextToVideoWorkflow,
  buildImageToVideoWorkflow,
  buildAceStep,
  buildFoley,
  buildHv15,
  buildLtxLipsync,
  buildLtxTemplate,
  buildMatAnyone,
  buildVaceInpaint,
  buildVaceRef,
  buildWanAlpha,
  buildWanI2V,
  VACE_IMAGE_MASK_RE,
  durationToLegalFrames,
  FOLEY_FALLBACK_FPS,
  FOLEY_MAX_SECONDS,
  foleyFrameCap,
  lipsyncAudioToFrames,
  loadTemplate,
  LTX_LIPSYNC_FPS,
  LTX_LIPSYNC_MAX_FRAMES,
  LTX_LIPSYNC_MAX_SECONDS,
  MATTE_FALLBACK_FPS,
  MATTE_MAX_FPS,
  MATTE_MAX_SECONDS,
  matteFrameCap,
  MUSIC_DEFAULT_SECONDS,
  MUSIC_MAX_SECONDS,
  MUSIC_MIN_SECONDS,
} from "@/lib/workflow-builder";
import { probeAudioDurationSeconds } from "@/lib/audio-probe";
import {
  probeVideoHeader,
  VIDEO_PROBE_HEAD_BYTES,
  type VideoProbeResult,
} from "@/lib/video-probe";
import { addToHistory, updateHistoryItem } from "@/lib/history";
import {
  LTX_VIDEO_MODEL,
  WAN_VIDEO_MODEL,
  durationToFrames,
  framesToDuration,
  getVideoModelProfile,
  resolveVideoModelId,
  type VideoModelProfile,
} from "@/lib/models";
import { getLane, resolveLaneModelId } from "@/lib/lanes";
import { pickWorker, resolveWorkerForLane, type FleetWorker } from "@/lib/fleet";
import {
  buildRemotionProps,
  createRemotionRender,
  getRemotionComposition,
  REMOTION_COMPOSITION_IDS,
  RemotionServiceUnreachableError,
} from "@/lib/remotion-client";
import {
  buildLtxDesktopOutputUrl,
  generateLtxDesktopVideo,
} from "@/lib/ltx-desktop-client";
import type { GenerateRequest, VideoGenerationItem } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

/** How an input image may arrive on the request body. */
interface ImageSource {
  url?: unknown;
  base64?: unknown;
  /** Local path on the FrameForge host (Windows box). */
  path?: unknown;
}

/**
 * Resolve an image source (http URL / base64 / local path) to a Buffer plus
 * a sensible filename. Returns null when no source is provided.
 */
async function resolveImageBuffer(
  source: ImageSource,
  fallbackName: string,
): Promise<{ buffer: Buffer; filename: string } | null> {
  if (typeof source.url === "string" && source.url.trim()) {
    const url = source.url.trim();
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      throw new Error(`Failed to fetch input image (${res.status}): ${url}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    let filename = fallbackName;
    try {
      const base = path.basename(new URL(url).pathname);
      if (base && /\.(png|jpe?g|webp|bmp|gif)$/i.test(base)) filename = base;
    } catch {
      // keep fallback name
    }
    if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(filename)) {
      const contentType = res.headers.get("content-type") || "";
      filename += contentType.includes("jpeg") ? ".jpg" : ".png";
    }
    return { buffer, filename };
  }

  if (typeof source.base64 === "string" && source.base64.trim()) {
    // Accept both raw base64 and data: URIs.
    const raw = source.base64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length === 0) throw new Error("imageBase64 decoded to 0 bytes");
    return { buffer, filename: `${fallbackName}.png` };
  }

  if (typeof source.path === "string" && source.path.trim()) {
    const filePath = source.path.trim();
    const buffer = await readFile(filePath);
    return { buffer, filename: path.basename(filePath) || `${fallbackName}.png` };
  }

  return null;
}

/** How an input voiceover may arrive on the request body (LIP-SYNC lane). */
interface AudioSource {
  url?: unknown;
  base64?: unknown;
  /** Local path on the FrameForge host (Windows box). */
  path?: unknown;
}

/**
 * Resolve an audio source (http URL / base64 / local path) to a Buffer plus
 * a sensible filename (wav/mp3). Mirrors resolveImageBuffer; returns null
 * when no source is provided.
 */
async function resolveAudioBuffer(
  source: AudioSource,
  fallbackName: string,
): Promise<{ buffer: Buffer; filename: string } | null> {
  if (typeof source.url === "string" && source.url.trim()) {
    const url = source.url.trim();
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      throw new Error(`Failed to fetch input audio (${res.status}): ${url}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    let filename = fallbackName;
    try {
      const base = path.basename(new URL(url).pathname);
      if (base && /\.(wav|mp3)$/i.test(base)) filename = base;
    } catch {
      // keep fallback name
    }
    if (!/\.(wav|mp3)$/i.test(filename)) {
      const contentType = res.headers.get("content-type") || "";
      filename += contentType.includes("mpeg") ? ".mp3" : ".wav";
    }
    return { buffer, filename };
  }

  if (typeof source.base64 === "string" && source.base64.trim()) {
    // Accept both raw base64 and data: URIs.
    const raw = source.base64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length === 0) throw new Error("audioBase64 decoded to 0 bytes");
    return { buffer, filename: `${fallbackName}.wav` };
  }

  if (typeof source.path === "string" && source.path.trim()) {
    const filePath = source.path.trim();
    const buffer = await readFile(filePath);
    return {
      buffer,
      filename: path.basename(filePath) || `${fallbackName}.wav`,
    };
  }

  return null;
}

/** How an input video / mask may arrive on the request body (VACE edit lane). */
interface VideoSource {
  url?: unknown;
  /** Local path on the FrameForge host (Windows box). */
  path?: unknown;
  /**
   * Pass-through ComfyUI file ref: an input-dir path ("jobs/<id>/clip.mp4")
   * or an annotated "<subfolder>/<file> [output]" path pointing at one of our
   * own renders (the same form /api/finish uses) — handed to VHS_LoadVideo
   * verbatim, no fetch/upload.
   */
  ref?: unknown;
}

/**
 * Resolve a video/mask source to a ComfyUI file ref VHS_LoadVideo (or
 * LoadImage, for still-image masks) can consume. http URLs and local paths
 * are fetched/read server-side and uploaded into the job's input subfolder
 * (mirroring resolveImageBuffer + uploadInputImage); `ref` strings pass
 * through untouched. When the bytes passed through this process (url/path
 * sources) they are returned as `bytes` so the MATTE lane can header-probe
 * them without re-downloading; pass-through refs return no bytes (the probe
 * Range-fetches the head via getFileHeadBytes instead). Returns null when
 * no source is provided.
 */
async function resolveVideoRef(
  comfyBase: string,
  source: VideoSource,
  fallbackName: string,
  subfolder: string,
  label: string,
): Promise<{ ref: string; bytes?: Buffer } | null> {
  if (typeof source.ref === "string" && source.ref.trim()) {
    return { ref: source.ref.trim() };
  }

  let buffer: Buffer | undefined;
  let filename = fallbackName;
  const KNOWN_EXT = /\.(mp4|webm|mov|mkv|png|jpe?g|webp|bmp)$/i;

  if (typeof source.url === "string" && source.url.trim()) {
    const url = source.url.trim();
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      throw new Error(`Failed to fetch input ${label} (${res.status}): ${url}`);
    }
    buffer = Buffer.from(await res.arrayBuffer());
    try {
      const base = path.basename(new URL(url).pathname);
      if (base && KNOWN_EXT.test(base)) filename = base;
    } catch {
      // keep fallback name
    }
    if (!KNOWN_EXT.test(filename)) {
      const contentType = res.headers.get("content-type") || "";
      filename += contentType.startsWith("image/")
        ? ".png"
        : contentType.includes("webm")
          ? ".webm"
          : ".mp4";
    }
  } else if (typeof source.path === "string" && source.path.trim()) {
    const filePath = source.path.trim();
    buffer = await readFile(filePath);
    filename = path.basename(filePath) || `${fallbackName}.mp4`;
  }

  if (!buffer) return null;
  if (buffer.length === 0) throw new Error(`Input ${label} is 0 bytes`);

  // Namespace by role: video and mask share the job subfolder and are
  // uploaded with overwrite=true, so identical source basenames (e.g. a mask
  // exported next to its clip as "shot.mp4") would silently clobber each
  // other — the job would then edit the mask with itself as the mask.
  if (!filename.startsWith(fallbackName)) {
    filename = `${fallbackName}-${filename}`;
  }

  const uploaded = await uploadInputVideo(comfyBase, buffer, filename, subfolder);
  console.log(`[FrameForge] Uploaded ${label} → ${uploaded.videoRef}`);
  return { ref: uploaded.videoRef, bytes: buffer };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const prompt: string = body.prompt || "";
    // Prompt is required for every GENERATION lane. Two exceptions:
    //   - The MATTE lane (matanyone-matte / laneKey "MATTE") is a TRANSFORM —
    //     video + seed mask in, alpha webm out, no text conditioning anywhere
    //     in the graph.
    //   - The FOLEY lane (foley-sfx / laneKey "FOLEY") — the prompt is an
    //     OPTIONAL hint steering the SFX; empty = pure video-driven foley
    //     (the sampler's visual features carry the conditioning).
    //   - The MG-TYPE lane (mg-type / laneKey "MG-TYPE") — a deterministic
    //     Remotion render: the composition props (title, subtitle, …) ARE
    //     the content, there is no text conditioning to prompt.
    // All follow the same rule: an explicit model always wins over laneKey,
    // mirroring the routing below, so a non-exempt model with laneKey
    // "MATTE"/"FOLEY"/"MG-TYPE" still requires a prompt.
    const rawModel: string | undefined =
      typeof body.model === "string" && body.model
        ? body.model
        : typeof body.profile === "string" && body.profile
          ? body.profile
          : undefined;
    const rawLaneKey: string | undefined =
      typeof body.laneKey === "string" && body.laneKey.trim()
        ? body.laneKey.trim().toUpperCase()
        : undefined;
    const promptOptional =
      rawModel === "matanyone-matte" ||
      rawModel === "foley-sfx" ||
      rawModel === "mg-type" ||
      (!rawModel &&
        (rawLaneKey === "MATTE" ||
          rawLaneKey === "FOLEY" ||
          rawLaneKey === "MG-TYPE"));
    if (!prompt.trim() && !promptOptional) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }

    // Public job id — also used as the ComfyUI input subfolder for uploads.
    const id = uuidv4();

    // A request that can ONLY resolve to the Remotion MG-TYPE lane (explicit
    // "mg-type" model, or laneKey "MG-TYPE" with no overriding model — the
    // same shape as the promptOptional rule above) must skip the ComfyUI
    // image-upload path entirely: kind "remotion" ignores images (exempt from
    // the image reroute), and uploading a stray imageUrl to the ComfyUI box
    // first would 500 an otherwise-valid MG-TYPE dispatch whenever that box
    // is down even though the render runs on think.
    const wantsRemotion =
      rawModel === "mg-type" || (!rawModel && rawLaneKey === "MG-TYPE");
    if (
      wantsRemotion &&
      (body.imageUrl || body.imageBase64 || body.imagePath ||
        body.endImageUrl || body.endImageBase64 || body.endImagePath)
    ) {
      // Additive contract: stray images on this lane are ignored, never fatal.
      console.log(
        "[FrameForge] imageUrl ignored — the MG-TYPE lane is composition-props-only (typography render on think)",
      );
    }

    // ------------------------------------------------------------------
    // Resolve input images (start frame + optional end frame)
    // ------------------------------------------------------------------
    // New-style sources are fetched/decoded server-side into BUFFERS here;
    // the actual ComfyUI upload is DEFERRED until after the fleet worker is
    // chosen below, so input files always land on the box that runs the job.
    // Legacy `sourceImage` / `endImage` are filenames already in the input
    // folder (uploaded via /api/upload) and pass through untouched.
    let imageName: string | undefined;
    let endImageName: string | undefined;

    const startSource = wantsRemotion
      ? null
      : await resolveImageBuffer(
          { url: body.imageUrl, base64: body.imageBase64, path: body.imagePath },
          "start",
        );
    if (!startSource && typeof body.sourceImage === "string" && body.sourceImage) {
      imageName = body.sourceImage;
    }
    // Forgiving alias: `image` / `startImage` / `inputImage` are the intuitive
    // (and previously silent-failing) ways to name an already-uploaded input
    // frame. Accept a bare string filename OR the { filename } shape that
    // /api/upload returns, mapping to sourceImage — an I2V request must never
    // be quietly rerouted to the no-image LTX lane because the field was named
    // slightly wrong.
    if (!startSource && !imageName) {
      const alias = body.image ?? body.startImage ?? body.inputImage;
      if (typeof alias === "string" && alias.trim()) {
        imageName = alias.trim();
      } else if (
        alias &&
        typeof alias === "object" &&
        typeof (alias as { filename?: unknown }).filename === "string"
      ) {
        imageName = (alias as { filename: string }).filename;
      }
    }

    const endSource = wantsRemotion
      ? null
      : await resolveImageBuffer(
          {
            url: body.endImageUrl,
            base64: body.endImageBase64,
            path: body.endImagePath,
          },
          "end",
        );
    if (!endSource && typeof body.endImage === "string" && body.endImage) {
      endImageName = body.endImage;
    }

    // ------------------------------------------------------------------
    // Lane routing (image → Wan 2.2 I2V, no image → repaired LTX)
    // ------------------------------------------------------------------
    // Presence-based: a resolved-but-not-yet-uploaded buffer counts exactly
    // like the pre-fleet uploaded ref did.
    const hasImage = Boolean(startSource) || Boolean(imageName);
    // If the caller clearly meant to send a start image but nothing resolved,
    // say so loudly instead of silently producing a text-to-video clip.
    if (!hasImage) {
      const strayImageKey = [
        "image",
        "startImage",
        "inputImage",
        "imageUrl",
        "imageBase64",
        "imagePath",
        "sourceImage",
      ].find((key) => body[key] != null);
      if (strayImageKey) {
        console.warn(
          `[FrameForge] request carried '${strayImageKey}' but no usable input image resolved — routing WITHOUT an image (text-to-video). For I2V pass imageUrl, imageBase64, imagePath, or an uploaded sourceImage/image filename.`,
        );
      }
    }
    let requestedModel: string | undefined = body.model || body.profile;

    // Optional laneKey (additive; see GET /api/lanes). An explicit model
    // always wins. The lane's mapped profile still flows through
    // resolveVideoModelId below, so lane picks obey the same image-routing
    // rules as explicit model ids (HV-HUMANS + image → hv15-i2v via the
    // lane's imageModelId; WAN-CINE without an image falls back to the
    // text-only default, exactly like an explicit Wan profile would).
    if (!requestedModel && typeof body.laneKey === "string" && body.laneKey.trim()) {
      const lane = getLane(body.laneKey);
      if (!lane) {
        return NextResponse.json(
          { error: `Unknown laneKey "${body.laneKey}" — GET /api/lanes lists the valid lanes` },
          { status: 400 },
        );
      }
      const laneModelId = resolveLaneModelId(lane, hasImage);
      if (!laneModelId) {
        // Descriptor-only lane: FINISH-STACK (MG-TYPE resolves to "mg-type"
        // since 2026-07-16 and runs through the remotion branch below).
        return NextResponse.json(
          {
            error:
              lane.executor === "finish"
                ? `laneKey "${lane.laneKey}" runs via POST /api/finish (it takes a rendered clip, not a prompt)`
                : `laneKey "${lane.laneKey}" is an external ${lane.executor} lane — /api/generate cannot run it`,
          },
          { status: 400 },
        );
      }
      requestedModel = laneModelId;
    }

    // ------------------------------------------------------------------
    // Model resolution (moved ABOVE the prerequisite blocks — a pure
    // function of requestedModel + input PRESENCE, so resolving early is
    // behavior-neutral) — the profile's `kind` drives fleet worker selection
    // below, which must happen BEFORE any input bytes are uploaded.
    // ------------------------------------------------------------------
    const endImagePresent = Boolean(endSource) || Boolean(endImageName);
    let modelId = resolveVideoModelId(requestedModel, hasImage);
    if (hasImage && endImagePresent) {
      // End frame present → FLF2V template unless an explicit Wan profile
      // already supports it. The fun-camera lane is exempt: an explicit
      // camera-move request must not be silently rerouted (the end image is
      // ignored there instead).
      const candidate = getVideoModelProfile(modelId);
      if (
        candidate.kind === "wan-i2v" &&
        !candidate.supportsEndImage &&
        candidate.id !== "wan22-camera"
      ) {
        modelId = "wan22-flf2v";
      }
    }
    const modelProfile = getVideoModelProfile(modelId);

    // ------------------------------------------------------------------
    // Remotion MG-TYPE lane (motion graphics — proxied to think)
    // ------------------------------------------------------------------
    // Explicit selection only (model "mg-type" or laneKey "MG-TYPE"). NOT a
    // ComfyUI dispatch: composition + props are validated here, then POSTed
    // to the think render service (192.168.4.200:3070) and tracked via the
    // history item's remoteJobId (kind "remotion" — the status route polls
    // think instead of ComfyUI history). Sits BEFORE fleet worker selection
    // and the VRAM sweep on purpose: a CPU render on another machine must
    // neither pick a ComfyUI worker nor evict models on one. Stray imageUrl
    // is ignored (kind "remotion" is exempt from the image reroute); prompt
    // is optional (the props ARE the content).
    if (modelProfile.kind === "remotion") {
      const compositionRaw =
        typeof body.composition === "string" ? body.composition.trim() : "";
      const composition = compositionRaw
        ? getRemotionComposition(compositionRaw)
        : undefined;
      if (!composition) {
        return NextResponse.json(
          {
            error:
              (compositionRaw
                ? `Unknown composition "${compositionRaw}" for the MG-TYPE lane`
                : "The MG-TYPE lane requires a composition") +
              ` — valid compositions: ${REMOTION_COMPOSITION_IDS.join(", ")}` +
              " (live catalog: GET /health on the think render service)",
            compositions: REMOTION_COMPOSITION_IDS,
          },
          { status: 400 },
        );
      }

      const built = buildRemotionProps(composition, body);
      if ("error" in built) {
        return NextResponse.json({ error: built.error }, { status: 400 });
      }

      let remote: { jobId: string };
      try {
        remote = await createRemotionRender(
          composition.id,
          built.props,
          typeof body.seed === "number" ? body.seed : undefined,
        );
      } catch (error) {
        if (error instanceof RemotionServiceUnreachableError) {
          // The one lane whose executor lives on another box: answer an
          // honest 503 with the restart runbook instead of a generic 500.
          return NextResponse.json({ error: error.message }, { status: 503 });
        }
        // The service answered but rejected the job (its own 400 copy —
        // e.g. a prop the hardcoded mirror doesn't know about yet).
        const message =
          error instanceof Error ? error.message : "Remotion dispatch failed";
        return NextResponse.json(
          { error: message },
          { status: message.includes("(400)") ? 400 : 502 },
        );
      }

      const item: VideoGenerationItem = {
        id,
        status: "processing",
        // History display: the composition props are the content.
        prompt:
          prompt.trim() ||
          `${composition.id}: ${built.props.title ?? ""} — ${built.props.subtitle ?? ""}`,
        kind: "remotion",
        remoteJobId: remote.jobId,
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        frames: composition.durationInFrames,
        duration: composition.durationInFrames / composition.fps,
        resolution: `${composition.width}x${composition.height}`,
        seed: typeof body.seed === "number" ? body.seed : undefined,
        model: modelProfile.id,
        modelName: modelProfile.name,
        // No `worker` stamp: the render runs on the think REMOTION service,
        // not a ComfyUI fleet worker (the status route polls remoteJobId).
        createdAt: new Date().toISOString(),
        progress: 0,
      };

      await addToHistory(item);
      console.log(
        `[FrameForge] MG-TYPE dispatched to think: ${composition.id} (remote job ${remote.jobId})`,
      );

      return NextResponse.json({
        id,
        // No ComfyUI prompt / websocket for the remotion lane; keep the
        // public response shape uniform (the LTX Desktop sidecar precedent).
        comfyPromptId: "",
        clientId: "",
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // Fleet worker selection (BEFORE any upload/probe touches a box)
    // ------------------------------------------------------------------
    // Candidates: lane-specific enabled workers first, then the default.
    // With only vidbox enabled (today's deployed env) there is exactly one
    // candidate and pickWorker short-circuits with NO availability ping —
    // request pattern and failure surface stay byte-identical to the
    // single-base build. Every upload, probe, VRAM sweep, and queue below
    // targets THIS worker's base, and the history item records the worker's
    // NAME so the status/output routes follow the job to the same box.
    const worker: FleetWorker = await pickWorker(
      resolveWorkerForLane(modelProfile.kind ?? "ltx"),
    );
    const comfyBase = worker.comfyBase as string;
    console.log(
      `[FrameForge] Dispatch worker: ${worker.name} (${comfyBase}) for kind=${modelProfile.kind ?? "ltx"}, model=${modelProfile.id}`,
    );

    // ------------------------------------------------------------------
    // Upload deferred input images to the CHOSEN worker
    // ------------------------------------------------------------------
    if (startSource) {
      const uploaded = await uploadInputImage(
        comfyBase,
        startSource.buffer,
        startSource.filename,
        `jobs/${id}`,
      );
      imageName = uploaded.imageRef;
      console.log(`[FrameForge] Uploaded start image → ${imageName}`);
    }
    if (endSource) {
      const uploaded = await uploadInputImage(
        comfyBase,
        endSource.buffer,
        endSource.filename,
        `jobs/${id}`,
      );
      endImageName = uploaded.imageRef;
      console.log(`[FrameForge] Uploaded end image → ${endImageName}`);
    }

    // ------------------------------------------------------------------
    // LIP-SYNC prerequisites (ltx23-lipsync via model/profile/laneKey)
    // ------------------------------------------------------------------
    // The lane requires BOTH a presenter still and a voiceover; check here
    // (before any dispatch work, keyed on requestedModel — model resolution
    // itself already ran above) so a missing image answers a clear 400
    // instead of silently falling back to the text-only default. The audio
    // is fetched + duration-probed server-side because the frame count
    // derives from the VO length (audio decides duration; body.duration is
    // ignored for this lane).
    const wantsLipsync = requestedModel === "ltx23-lipsync";
    let audioName: string | undefined;
    let audioSeconds: number | undefined;
    if (wantsLipsync) {
      if (!imageName) {
        return NextResponse.json(
          {
            error:
              "The LIP-SYNC lane (ltx23-lipsync) requires a presenter still — pass imageUrl (or imageBase64 / imagePath / sourceImage)",
          },
          { status: 400 },
        );
      }
      const audioSource = await resolveAudioBuffer(
        { url: body.audioUrl, base64: body.audioBase64, path: body.audioPath },
        "vo",
      );
      if (!audioSource) {
        return NextResponse.json(
          {
            error:
              "The LIP-SYNC lane (ltx23-lipsync) requires a voiceover — pass audioUrl (http-fetchable wav or mp3; audioBase64 / audioPath also accepted)",
          },
          { status: 400 },
        );
      }
      const seconds = probeAudioDurationSeconds(audioSource.buffer);
      if (seconds === null || seconds <= 0) {
        return NextResponse.json(
          {
            error:
              "Could not read the audio duration — the LIP-SYNC lane accepts WAV or MP3 voiceovers",
          },
          { status: 400 },
        );
      }
      if (seconds > LTX_LIPSYNC_MAX_SECONDS + 1e-6) {
        return NextResponse.json(
          {
            error:
              `Voiceover is ${seconds.toFixed(2)}s — the LIP-SYNC lane caps at ` +
              `${LTX_LIPSYNC_MAX_SECONDS.toFixed(1)}s (${LTX_LIPSYNC_MAX_FRAMES} frames @ ` +
              `${LTX_LIPSYNC_FPS}fps, single sampling window) for v1. ` +
              "Split the VO into shorter lines and stitch the clips.",
          },
          { status: 400 },
        );
      }
      const uploadedAudio = await uploadInputAudio(
        comfyBase,
        audioSource.buffer,
        audioSource.filename,
        `jobs/${id}`,
      );
      audioName = uploadedAudio.audioRef;
      audioSeconds = seconds;
      console.log(
        `[FrameForge] Uploaded VO → ${audioName} (${seconds.toFixed(2)}s)`,
      );
    } else if (body.audioUrl || body.audioBase64 || body.audioPath) {
      // Additive contract: audio on any other lane is ignored, never fatal.
      console.log(
        "[FrameForge] audioUrl ignored — only the LIP-SYNC lane (ltx23-lipsync) consumes audio",
      );
    }

    // ------------------------------------------------------------------
    // VACE prerequisites (vace-ref / vace-ref-draft / vace-inpaint)
    // ------------------------------------------------------------------
    // Checked BEFORE any dispatch work, like the LIP-SYNC block above, so
    // a missing input answers a clear 400 instead of silently falling back
    // to a default lane.
    const wantsVaceRef =
      requestedModel === "vace-ref" || requestedModel === "vace-ref-draft";
    const wantsVaceEdit = requestedModel === "vace-inpaint";
    // MATTE lane shares the video+mask plumbing (same body params, same
    // uploadInputVideo path) but its mask MUST be a still image (the
    // first-frame seed) and it carries its own defensive caps.
    const wantsMatte = requestedModel === "matanyone-matte";
    // FOLEY shares the footage plumbing too (same body params, same
    // uploadInputVideo path, same header probe) but takes NO mask and has
    // its own 15s cap — it gets its own branch below to keep the matte/VACE
    // logic untouched.
    const wantsFoley = requestedModel === "foley-sfx";
    const laneLabel = wantsMatte
      ? "The MATTE lane (matanyone-matte)"
      : "The VACE edit lane (vace-inpaint)";
    let videoName: string | undefined;
    let maskName: string | undefined;
    let maskIsImage = false;
    let matteFps: number | undefined;
    let matteSeconds: number | undefined;
    // MATTE only: real duration/fps/dimensions read off the source header
    // BEFORE dispatch (undefined = probe unavailable → legacy fps-param
    // behavior).
    let matteProbe: VideoProbeResult | undefined;
    // FOLEY mirrors of the two matte fields (kept separate on purpose — the
    // caps and error copy differ, and sharing state across lanes is how
    // silent cross-lane bugs happen).
    let foleySeconds: number | undefined;
    let foleyProbe: VideoProbeResult | undefined;

    if (wantsVaceRef && !imageName) {
      return NextResponse.json(
        {
          error:
            "The VACE reference lane (vace-ref / vace-ref-draft) requires an identity reference image — pass imageUrl (or imageBase64 / imagePath / sourceImage). The image is the REFERENCE (person/product identity), not a start frame; background-removed references lock identity best.",
        },
        { status: 400 },
      );
    }

    if (wantsMatte) {
      // Defensive length cap — MatAnyone2 walks every frame through the
      // propagation network, so unbounded inputs are a wall-clock hazard.
      if (typeof body.duration === "number" && body.duration > MATTE_MAX_SECONDS) {
        return NextResponse.json(
          {
            error:
              `The MATTE lane caps at ${MATTE_MAX_SECONDS}s per clip (duration=` +
              `${body.duration}) — cut the footage into ≤${MATTE_MAX_SECONDS}s ` +
              "pieces and matte them separately (the seed mask only needs to " +
              "match each piece's first frame).",
          },
          { status: 400 },
        );
      }
      if (typeof body.duration === "number" && body.duration > 0) {
        matteSeconds = body.duration;
      }
      // Optional explicit resample rate; omitted = source fps preserved via
      // the template's VideoInfo→frame_rate link, with the frame cap sized
      // by the server-side header probe below (fallback: MATTE_FALLBACK_FPS).
      if (body.fps !== undefined && body.fps !== null) {
        const fps = Number(body.fps);
        if (!Number.isFinite(fps) || fps < 1 || fps > MATTE_MAX_FPS) {
          return NextResponse.json(
            {
              error:
                `MATTE fps must be 1..${MATTE_MAX_FPS} (VHS force_rate range) — ` +
                "omit it to preserve the source fps end-to-end",
            },
            { status: 400 },
          );
        }
        matteFps = fps;
      }
    }

    if (wantsVaceEdit || wantsMatte) {
      const videoSource = await resolveVideoRef(
        comfyBase,
        { url: body.videoUrl, path: body.videoPath, ref: body.video },
        "clip",
        `jobs/${id}`,
        "video",
      );
      videoName = videoSource?.ref;
      if (!videoName) {
        return NextResponse.json(
          {
            error:
              `${laneLabel} requires the ${wantsMatte ? "footage to matte" : "footage to edit"} — pass videoUrl (http-fetchable mp4/webm), videoPath (local file), or video (a ComfyUI input-dir ref like \"jobs/<id>/clip.mp4\" or an annotated \"<subfolder>/<file> [output]\" path to one of our own renders)`,
          },
          { status: 400 },
        );
      }
      maskName = (
        await resolveVideoRef(
          comfyBase,
          { url: body.maskUrl, path: body.maskPath, ref: body.mask },
          "mask",
          `jobs/${id}`,
          "mask",
        )
      )?.ref;
      // resolveVideoRef returns null ONLY when no mask source was supplied
      // (a supplied-but-broken maskUrl/maskPath throws → 500 above); so a
      // missing maskName here really means "omitted". VACE editing still
      // requires it; the MATTE lane auto-derives the seed instead
      // (buildMatAnyone: first loaded frame → BiRefNetRMBG person/subject
      // mask → MatAnyone2.foreground_MASK).
      if (!maskName && wantsVaceEdit) {
        return NextResponse.json(
          {
            error:
              "The VACE edit lane (vace-inpaint) requires an edit mask — pass maskUrl (http-fetchable mask VIDEO, or a still image applied to every frame; WHITE = regenerate, BLACK = keep). maskPath / mask (input-dir or annotated ref) also accepted.",
          },
          { status: 400 },
        );
      }
      if (maskName) {
        maskIsImage = VACE_IMAGE_MASK_RE.test(maskName);
        if (wantsMatte && !maskIsImage) {
          return NextResponse.json(
            {
              error:
                "The MATTE lane's mask must be a STILL image (png/jpg/webp/bmp) — it seeds the FIRST frame only; MatAnyone2 propagates it through the clip itself (a mask video belongs to the VACE edit lane instead). Or omit the mask entirely for an auto person/subject seed.",
            },
            { status: 400 },
          );
        }
      }

      // MATTE: header-probe the source BEFORE dispatch so the frame cap uses
      // the REAL fps (the old 30fps assumption silently truncated a 60fps
      // source at ~15s) and history records real fps/width/height. url/path
      // sources were just buffered whole — probe those bytes directly; for
      // pass-through refs (input-dir paths / annotated "[output]" renders)
      // Range-fetch only the leading bytes via ComfyUI /view. Best-effort by
      // design: a tail-moov (no-faststart) head or unreachable file falls
      // back to the pre-probe fps-param behavior — never a whole-file
      // download, never a failed dispatch.
      if (wantsMatte) {
        const headBytes =
          videoSource?.bytes ??
          (await getFileHeadBytes(comfyBase, videoName, VIDEO_PROBE_HEAD_BYTES));
        if (headBytes) {
          try {
            matteProbe = probeVideoHeader(headBytes);
            console.log(
              `[FrameForge] MATTE source probed: ${matteProbe.durationSeconds.toFixed(2)}s` +
                ` @ ${matteProbe.fps ?? "?"}fps` +
                ` ${matteProbe.width ?? "?"}x${matteProbe.height ?? "?"} (${matteProbe.container})`,
            );
          } catch (error) {
            console.log(
              "[FrameForge] MATTE source probe unavailable (" +
                (error instanceof Error ? error.message : String(error)) +
                ") — falling back to fps-param frame cap",
            );
          }
        }
        if (matteProbe) {
          // Real-duration gate: the old check could only see body.duration,
          // so an unbounded 60s upload sailed through and got silently
          // truncated by the frame cap. An explicit duration ≤ cap still
          // opts into matting just the head of a longer clip.
          if (
            matteProbe.durationSeconds > MATTE_MAX_SECONDS + 1e-6 &&
            matteSeconds === undefined
          ) {
            return NextResponse.json(
              {
                error:
                  `Source clip is ${matteProbe.durationSeconds.toFixed(2)}s — the MATTE lane caps at ` +
                  `${MATTE_MAX_SECONDS}s per clip. Cut the footage into ≤${MATTE_MAX_SECONDS}s pieces and ` +
                  "matte them separately (the seed mask only needs to match each piece's first frame), " +
                  `or pass duration ≤ ${MATTE_MAX_SECONDS} to matte just the head of this clip.`,
              },
              { status: 400 },
            );
          }
          matteSeconds = Math.min(
            matteSeconds ?? matteProbe.durationSeconds,
            matteProbe.durationSeconds,
          );
        }
      }
    } else if (wantsFoley) {
      // ----------------------------------------------------------------
      // FOLEY prerequisites (foley-sfx via model/profile/laneKey)
      // ----------------------------------------------------------------
      // Footage in, footage+SFX mp4 out. Mirrors the MATTE flow (resolve →
      // probe → cap) with the FOLEY_MAX_SECONDS (15s) cap: the model is
      // trained around ~15s clips (the node widget allows 30s, and because
      // the template LINKS duration from VideoInfo, ComfyUI would not even
      // validate it — the frame cap here is the real guard).
      if (typeof body.duration === "number" && body.duration > FOLEY_MAX_SECONDS) {
        return NextResponse.json(
          {
            error:
              `The FOLEY lane caps at ${FOLEY_MAX_SECONDS}s per clip (duration=` +
              `${body.duration}) — HunyuanVideo-Foley is trained on ~15s ` +
              "windows; cut the footage and foley the pieces separately " +
              "(ambience joins fine across cuts; place hard SFX inside one piece).",
          },
          { status: 400 },
        );
      }
      if (typeof body.duration === "number" && body.duration > 0) {
        foleySeconds = body.duration;
      }
      if (body.fps !== undefined && body.fps !== null) {
        // No resample support in v1: the whole lane contract is "your clip
        // back, untouched frames + new audio" — fps is derived in-graph.
        console.log(
          "[FrameForge] fps ignored — the FOLEY lane preserves the source fps end-to-end (VideoInfo links)",
        );
      }
      const videoSource = await resolveVideoRef(
        comfyBase,
        { url: body.videoUrl, path: body.videoPath, ref: body.video },
        "clip",
        `jobs/${id}`,
        "video",
      );
      videoName = videoSource?.ref;
      if (!videoName) {
        return NextResponse.json(
          {
            error:
              'The FOLEY lane (foley-sfx) requires the footage to score — pass videoUrl (http-fetchable mp4/webm), videoPath (local file), or video (a ComfyUI input-dir ref like "jobs/<id>/clip.mp4" or an annotated "<subfolder>/<file> [output]" path to one of our own renders). The prompt is optional: a short hint ("boots crunching on gravel") steers the SFX; omit it for pure video-driven foley.',
          },
          { status: 400 },
        );
      }
      if (body.maskUrl || body.maskPath || body.mask) {
        // Additive contract: FOLEY has no mask concept — ignored, never fatal.
        console.log(
          "[FrameForge] maskUrl ignored — the FOLEY lane takes footage only (masks belong to VACE editing / MATTE)",
        );
      }
      // Header-probe the source BEFORE dispatch (same best-effort mechanics
      // as MATTE): the frame cap is sized with the REAL fps and over-length
      // clips answer an honest 400 instead of a silent truncation.
      const headBytes =
        videoSource?.bytes ??
        (await getFileHeadBytes(comfyBase, videoName, VIDEO_PROBE_HEAD_BYTES));
      if (headBytes) {
        try {
          foleyProbe = probeVideoHeader(headBytes);
          console.log(
            `[FrameForge] FOLEY source probed: ${foleyProbe.durationSeconds.toFixed(2)}s` +
              ` @ ${foleyProbe.fps ?? "?"}fps` +
              ` ${foleyProbe.width ?? "?"}x${foleyProbe.height ?? "?"} (${foleyProbe.container})`,
          );
        } catch (error) {
          console.log(
            "[FrameForge] FOLEY source probe unavailable (" +
              (error instanceof Error ? error.message : String(error)) +
              ") — falling back to the assumed-fps frame cap",
          );
        }
      }
      if (foleyProbe) {
        if (
          foleyProbe.durationSeconds > FOLEY_MAX_SECONDS + 1e-6 &&
          foleySeconds === undefined
        ) {
          return NextResponse.json(
            {
              error:
                `Source clip is ${foleyProbe.durationSeconds.toFixed(2)}s — the FOLEY lane caps at ` +
                `${FOLEY_MAX_SECONDS}s per clip (HunyuanVideo-Foley's ~15s training window). ` +
                `Cut the footage into ≤${FOLEY_MAX_SECONDS}s pieces and foley them separately, ` +
                `or pass duration ≤ ${FOLEY_MAX_SECONDS} to score just the head of this clip.`,
            },
            { status: 400 },
          );
        }
        foleySeconds = Math.min(
          foleySeconds ?? foleyProbe.durationSeconds,
          foleyProbe.durationSeconds,
        );
      }
    } else if (body.videoUrl || body.videoPath || body.video || body.maskUrl || body.maskPath || body.mask) {
      // Additive contract: video/mask on any other lane is ignored, never fatal.
      console.log(
        "[FrameForge] videoUrl/maskUrl ignored — only the VACE edit lane (vace-inpaint), the MATTE lane (matanyone-matte), and the FOLEY lane (foley-sfx) consume footage inputs",
      );
    }

    // ------------------------------------------------------------------
    // MUSIC prerequisites (music-bed / music-bed-draft via model/laneKey)
    // ------------------------------------------------------------------
    // Checked BEFORE any dispatch work like the lanes above so a bad
    // request answers a clear 400 before any dispatch work. The lane
    // GENERATES audio — no audioUrl-style inputs; the prompt is the style
    // tags (required by the generic guard at the top), `lyrics` is the one
    // optional extra body param (omitted → instrumental), and `duration`
    // is SECONDS OF MUSIC (default 60, hard cap 240).
    const wantsMusic =
      requestedModel === "music-bed" || requestedModel === "music-bed-draft";
    let musicSeconds = MUSIC_DEFAULT_SECONDS;
    let musicLyrics: string | undefined;
    if (wantsMusic) {
      if (body.duration !== undefined && body.duration !== null) {
        const seconds = Number(body.duration);
        if (
          !Number.isFinite(seconds) ||
          seconds < MUSIC_MIN_SECONDS ||
          seconds > MUSIC_MAX_SECONDS
        ) {
          return NextResponse.json(
            {
              error:
                `The MUSIC lane's duration is seconds of music, ${MUSIC_MIN_SECONDS}..${MUSIC_MAX_SECONDS} ` +
                `(got ${body.duration}) — omit it for the ${MUSIC_DEFAULT_SECONDS}s default. ` +
                "Longer beds: generate in sections and crossfade in the edit.",
            },
            { status: 400 },
          );
        }
        musicSeconds = seconds;
      }
      if (body.lyrics !== undefined && body.lyrics !== null) {
        if (typeof body.lyrics !== "string") {
          return NextResponse.json(
            {
              error:
                "MUSIC lyrics must be a string ([Verse]/[Chorus]-style structure markers welcome) — omit it for an instrumental bed",
            },
            { status: 400 },
          );
        }
        musicLyrics = body.lyrics;
      }
      if (imageName) {
        // Additive contract, mirroring the Wan-Alpha/HV stray-image policy:
        // explicit selection is honored, the image is ignored, never fatal.
        console.log(
          "[FrameForge] imageUrl ignored — the MUSIC lane is tags-only (audio out)",
        );
      }
    } else if (body.lyrics) {
      console.log(
        "[FrameForge] lyrics ignored — only the MUSIC lane (music-bed / music-bed-draft) consumes lyrics",
      );
    }

    // Free VRAM before any video dispatch: ComfyUI model unload on the
    // CHOSEN worker only (best-effort) + the existing app-box Ollama
    // eviction. Never sweep boxes the job will not run on.
    console.log(
      `[FrameForge] Pre-dispatch VRAM sweep (worker=${worker.name}, lane=${modelProfile.kind ?? "ltx"}, model=${modelProfile.id})`,
    );
    await Promise.all([freeComfyMemory(comfyBase), unloadOllamaModels()]);

    const req: GenerateRequest = {
      prompt,
      width: body.width || LTX_VIDEO_MODEL.defaultParams.width,
      height: body.height || LTX_VIDEO_MODEL.defaultParams.height,
      fps: body.fps || LTX_VIDEO_MODEL.defaultParams.fps,
      duration: body.duration || 4,
      seed: body.seed,
      sourceImage: imageName,
      endImage: endImageName,
      // Camera move (fun-camera lane): validated + synonym-mapped inside
      // buildWanI2V via resolveCameraPose; ignored by templates without an
      // "FF Camera" node.
      cameraMove:
        typeof body.cameraMove === "string" && body.cameraMove.trim()
          ? body.cameraMove.trim()
          : undefined,
      model: modelProfile.id,
    };

    // ------------------------------------------------------------------
    // LTX Desktop sidecar lane (untouched behavior)
    // ------------------------------------------------------------------
    if (modelProfile.backend === "ltx-desktop") {
      const resolutionLabel =
        LTX_VIDEO_MODEL.resolutionPresets.find(
          (p) => p.width === req.width && p.height === req.height
        )?.label || `${req.width}x${req.height}`;

      const item: VideoGenerationItem = {
        id,
        status: "processing",
        prompt: req.prompt,
        width: req.width,
        height: req.height,
        fps: req.fps,
        frames: durationToFrames(req.duration, req.fps),
        duration: req.duration,
        resolution: resolutionLabel,
        seed: req.seed,
        model: modelProfile.id,
        modelName: modelProfile.name,
        // No `worker` stamp: the sidecar renders outside ComfyUI (the fleet
        // worker was only VRAM-swept); the status route's ltx-desktop paths
        // never consult item.worker.
        createdAt: new Date().toISOString(),
        progress: 0,
        sourceImageUrl: req.sourceImage,
      };

      await addToHistory(item);
      void completeLtxDesktopGeneration(id, req, modelProfile);

      return NextResponse.json({
        id,
        comfyPromptId: "",
        // No ComfyUI websocket for the sidecar lane, but keep the public
        // response shape ({id, comfyPromptId, clientId, status}) uniform.
        clientId: "",
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // Wan-Alpha RGBA template lane (transparent elements, text-only)
    // ------------------------------------------------------------------
    // Explicit selection only (never a routing default). Any uploaded image
    // is ignored — the lane is pure T2V. Output is VP9 webm with a REAL
    // alpha channel (yuva420p); kind "wan-alpha" ≠ "wan-i2v", so the status
    // route never submits the RIFE post job (its mp4 re-encode would strip
    // the transparency).
    if (modelProfile.kind === "wan-alpha") {
      const alphaFps = modelProfile.fps ?? 16;
      const alphaWidth = body.width || modelProfile.defaultWidth || 832;
      const alphaHeight = body.height || modelProfile.defaultHeight || 480;
      const length = body.duration
        ? durationToLegalFrames(body.duration, alphaFps, "wan")
        : (modelProfile.defaultLength ?? 81);
      const seed = req.seed ?? Math.floor(Math.random() * 2147483647);

      const template = loadTemplate(modelProfile.templateFile ?? "wan_alpha.json");
      const workflow = buildWanAlpha({
        template,
        prompt: req.prompt,
        negative:
          typeof body.negativePrompt === "string" ? body.negativePrompt : undefined,
        length,
        seed,
        width: alphaWidth,
        height: alphaHeight,
      });

      const clientId = uuidv4();
      const comfyResponse = await queuePrompt(
        comfyBase,
        workflow.prompt as unknown as Record<string, unknown>,
        clientId,
      );

      const item: VideoGenerationItem = {
        id,
        status: "processing",
        prompt: req.prompt,
        comfyPromptId: comfyResponse.prompt_id,
        width: workflow.extra_data.width ?? alphaWidth,
        height: workflow.extra_data.height ?? alphaHeight,
        fps: alphaFps,
        frames: workflow.extra_data.length,
        duration: framesToDuration(workflow.extra_data.length, alphaFps),
        resolution: `${workflow.extra_data.width ?? alphaWidth}x${workflow.extra_data.height ?? alphaHeight}`,
        seed,
        model: modelProfile.id,
        modelName: modelProfile.name,
        worker: worker.name,
        createdAt: new Date().toISOString(),
        progress: 0,
        stage: "main",
      };

      await addToHistory(item);

      return NextResponse.json({
        id,
        comfyPromptId: comfyResponse.prompt_id,
        clientId,
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // ACE-Step 1.5 MUSIC template lane (style tags + optional lyrics → mp3)
    // ------------------------------------------------------------------
    // Explicit selection only (never a routing default). The only lane whose
    // deliverable is an AUDIO file: SaveAudioMP3 lands under the history
    // `audio` key (extractOutputFilename handles it) and /api/output serves
    // the .mp3 with audio/mpeg. kind "audio" ≠ the Wan kinds, so the status
    // route never submits the RIFE post job (there are no frames). Stray
    // imageUrl/videoUrl are ignored — the prompt (style tags) drives
    // everything; `lyrics` optional, omitted → "[instrumental]".
    if (modelProfile.kind === "audio") {
      const seed = req.seed ?? Math.floor(Math.random() * 2147483647);
      const template = loadTemplate(
        modelProfile.templateFile ?? "acestep_music.json",
      );
      const workflow = buildAceStep({
        template,
        tags: req.prompt,
        lyrics: musicLyrics,
        seconds: musicSeconds,
        seed,
        // The profile checkpoint IS the "FF Model" UNET patch value — this
        // one string is the whole music-bed vs music-bed-draft difference.
        unetName: modelProfile.checkpoint,
      });

      const clientId = uuidv4();
      const comfyResponse = await queuePrompt(
        comfyBase,
        workflow.prompt as unknown as Record<string, unknown>,
        clientId,
      );

      // Audio job: the frame-oriented fields don't apply — width/height/
      // fps/frames 0 and resolution "audio" (the matte lane's "source"
      // precedent for fields that have no sensible pixel value).
      const item: VideoGenerationItem = {
        id,
        status: "processing",
        prompt: req.prompt,
        comfyPromptId: comfyResponse.prompt_id,
        width: 0,
        height: 0,
        fps: 0,
        frames: 0,
        duration: workflow.extra_data.seconds,
        resolution: "audio",
        seed,
        model: modelProfile.id,
        modelName: modelProfile.name,
        worker: worker.name,
        createdAt: new Date().toISOString(),
        progress: 0,
        stage: "main",
      };

      await addToHistory(item);

      return NextResponse.json({
        id,
        comfyPromptId: comfyResponse.prompt_id,
        clientId,
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // MatAnyone MATTE template lane (real-footage keying → alpha webm)
    // ------------------------------------------------------------------
    // Explicit selection only (never a routing default). A TRANSFORM, not
    // generation: video + OPTIONAL first-frame seed mask in, transparent-
    // background VP9 webm (yuva420p) out — no prompt, no sampler, no seed.
    // Mask omitted → buildMatAnyone derives the seed automatically from the
    // first loaded frame (ImageFromBatch → BiRefNetRMBG BiRefNet-general,
    // MASK output → MatAnyone2.foreground_MASK); mask supplied → today's
    // LoadImage seed path unchanged. Source fps is preserved end-to-end by
    // the graph itself (VHS_LoadVideo force_rate 0 + FF Output frame_rate
    // link-wired from FF Video Info); an explicit fps param resamples
    // instead. The source audio is muxed through into the webm. kind
    // "matte" ≠ "wan-i2v"/"wan-vace", so the status route never submits the
    // RIFE post job (its mp4 re-encode would destroy the alpha AND break
    // the source-fps continuity).
    if (modelProfile.kind === "matte") {
      if (!videoName) {
        // The prerequisites block already 400'd this; belt-and-suspenders.
        return NextResponse.json(
          { error: "The MATTE lane requires the footage to matte" },
          { status: 400 },
        );
      }

      const matteDuration = Math.min(
        matteSeconds ?? MATTE_MAX_SECONDS,
        MATTE_MAX_SECONDS,
      );
      // True frame cap: min(duration, 30s) × the REAL rate. An explicit fps
      // still overrides (force_rate resamples the clip, so the loaded frame
      // count follows the resample rate, not the source rate); otherwise the
      // probed source fps sizes the cap and only an unprobeable source drops
      // to the MATTE_FALLBACK_FPS assumption.
      const frameCap = matteFrameCap(matteDuration, matteFps ?? matteProbe?.fps);
      const template = loadTemplate(
        modelProfile.templateFile ?? "matanyone.json",
      );
      const workflow = buildMatAnyone({
        template,
        videoName,
        maskName,
        fps: matteFps,
        frameCap,
      });

      const clientId = uuidv4();
      const comfyResponse = await queuePrompt(
        comfyBase,
        workflow.prompt as unknown as Record<string, unknown>,
        clientId,
      );

      // History records what the header probe SAW (real fps/width/height and
      // the true duration min'd against the cap); an explicit fps still wins
      // for the fps field (it IS the output rate after force_rate). Only an
      // unprobeable source (tail-moov head, fetch failure) drops back to the
      // old best-effort estimates: fps = MATTE_FALLBACK_FPS, width/height 0,
      // resolution "source". frames stays the frame_load_cap upper bound.
      const item: VideoGenerationItem = {
        id,
        status: "processing",
        prompt,
        comfyPromptId: comfyResponse.prompt_id,
        width: matteProbe?.width ?? 0,
        height: matteProbe?.height ?? 0,
        fps: matteFps ?? matteProbe?.fps ?? MATTE_FALLBACK_FPS,
        frames: frameCap,
        duration: matteDuration,
        resolution:
          matteProbe?.width && matteProbe?.height
            ? `${matteProbe.width}x${matteProbe.height}`
            : "source",
        model: modelProfile.id,
        modelName: modelProfile.name,
        worker: worker.name,
        createdAt: new Date().toISOString(),
        sourceVideoUrl:
          typeof body.videoUrl === "string" && body.videoUrl
            ? body.videoUrl
            : videoName,
        sourceMaskUrl:
          typeof body.maskUrl === "string" && body.maskUrl
            ? body.maskUrl
            : maskName,
        progress: 0,
        stage: "main",
      };

      await addToHistory(item);

      return NextResponse.json({
        id,
        comfyPromptId: comfyResponse.prompt_id,
        clientId,
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // HunyuanVideo-Foley FOLEY template lane (footage → footage + SFX mp4)
    // ------------------------------------------------------------------
    // Explicit selection only (never a routing default). Footage + an
    // OPTIONAL text hint in → the SAME clip out as an h264 mp4 with
    // synchronized 48kHz SFX/ambience muxed on IN-GRAPH (VHS_VideoCombine
    // over the original frames + the generated AUDIO — the LIP-SYNC "ready
    // deliverable" pattern; the generated track REPLACES any source audio).
    // Source fps is preserved end-to-end by the graph itself: the sampler's
    // fps AND duration plus FF Output's frame_rate are all link-wired from
    // FF Video Info, so frame_load_cap (probe-sized, 15s cap) is the single
    // length knob and the audio always matches the loaded frame window.
    // kind "foley" ≠ "wan-i2v"/"wan-vace", so the status route never submits
    // the RIFE post job (interpolation would retime the frames the audio was
    // synced against, and the re-encode would strip the new track). NOTE:
    // the first foley run on a fresh box downloads the SigLIP2 + CLAP
    // encoders from HF (~3.5GB) inside HunyuanDependenciesLoader — expect a
    // slow first dispatch.
    if (modelProfile.kind === "foley") {
      if (!videoName) {
        // The prerequisites block already 400'd this; belt-and-suspenders.
        return NextResponse.json(
          { error: "The FOLEY lane requires the footage to score" },
          { status: 400 },
        );
      }

      const foleyDuration = Math.min(
        foleySeconds ?? FOLEY_MAX_SECONDS,
        FOLEY_MAX_SECONDS,
      );
      // True frame cap: min(duration, 15s) × the REAL probed rate; only an
      // unprobeable source drops to the FOLEY_FALLBACK_FPS assumption.
      const frameCap = foleyFrameCap(foleyDuration, foleyProbe?.fps);
      const seed = req.seed ?? Math.floor(Math.random() * 2147483647);
      const template = loadTemplate(
        modelProfile.templateFile ?? "hunyuan_foley.json",
      );
      const workflow = buildFoley({
        template,
        videoName,
        // Optional hint — buildFoley trims it and patches "" for a pure
        // video-driven run (the pack's widget default must never leak).
        prompt,
        negative:
          typeof body.negativePrompt === "string" ? body.negativePrompt : undefined,
        seed,
        frameCap,
      });

      const clientId = uuidv4();
      const comfyResponse = await queuePrompt(
        comfyBase,
        workflow.prompt as unknown as Record<string, unknown>,
        clientId,
      );

      // History mirrors the MATTE conventions: probed fps/width/height when
      // available (fallback fps = FOLEY_FALLBACK_FPS, resolution "source"),
      // frames = the frame_load_cap upper bound.
      const item: VideoGenerationItem = {
        id,
        status: "processing",
        prompt,
        comfyPromptId: comfyResponse.prompt_id,
        width: foleyProbe?.width ?? 0,
        height: foleyProbe?.height ?? 0,
        fps: foleyProbe?.fps ?? FOLEY_FALLBACK_FPS,
        frames: frameCap,
        duration: foleyDuration,
        resolution:
          foleyProbe?.width && foleyProbe?.height
            ? `${foleyProbe.width}x${foleyProbe.height}`
            : "source",
        seed,
        model: modelProfile.id,
        modelName: modelProfile.name,
        worker: worker.name,
        createdAt: new Date().toISOString(),
        sourceVideoUrl:
          typeof body.videoUrl === "string" && body.videoUrl
            ? body.videoUrl
            : videoName,
        progress: 0,
        stage: "main",
      };

      await addToHistory(item);

      return NextResponse.json({
        id,
        comfyPromptId: comfyResponse.prompt_id,
        clientId,
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // HunyuanVideo 1.5 720p template lane (humans/presenters + glyph text)
    // ------------------------------------------------------------------
    // Explicit selection only (never a routing default): hv15-t2v is pure
    // T2V (a stray image is ignored); hv15-i2v runs only when EXPLICITLY
    // requested with a start image (resolveVideoModelId falls back to the
    // text-only default otherwise). 24fps native output is delivery-ready —
    // kind "hv-template" ≠ "wan-i2v", so the status route never submits the
    // RIFE post job for this lane.
    if (modelProfile.kind === "hv-template") {
      if (modelProfile.requiresImage && !imageName) {
        // resolveVideoModelId should have routed this away already.
        return NextResponse.json(
          { error: "HunyuanVideo 1.5 I2V requires an input image" },
          { status: 400 },
        );
      }

      const hvFps = modelProfile.fps ?? 24;
      const hvWidth = body.width || modelProfile.defaultWidth || 1280;
      const hvHeight = body.height || modelProfile.defaultHeight || 720;
      const length = body.duration
        ? durationToLegalFrames(body.duration, hvFps, "hv")
        : (modelProfile.defaultLength ?? 121);
      const seed = req.seed ?? Math.floor(Math.random() * 2147483647);

      const template = loadTemplate(modelProfile.templateFile ?? "hv15_t2v.json");
      const workflow = buildHv15({
        template,
        prompt: req.prompt,
        negative:
          typeof body.negativePrompt === "string" ? body.negativePrompt : undefined,
        imageName: modelProfile.requiresImage ? imageName : undefined,
        length,
        seed,
        width: hvWidth,
        height: hvHeight,
      });

      const clientId = uuidv4();
      const comfyResponse = await queuePrompt(
        comfyBase,
        workflow.prompt as unknown as Record<string, unknown>,
        clientId,
      );

      const item: VideoGenerationItem = {
        id,
        status: "processing",
        prompt: req.prompt,
        comfyPromptId: comfyResponse.prompt_id,
        width: workflow.extra_data.width ?? hvWidth,
        height: workflow.extra_data.height ?? hvHeight,
        fps: hvFps,
        frames: workflow.extra_data.length,
        duration: framesToDuration(workflow.extra_data.length, hvFps),
        resolution: `${workflow.extra_data.width ?? hvWidth}x${workflow.extra_data.height ?? hvHeight}`,
        seed,
        model: modelProfile.id,
        modelName: modelProfile.name,
        worker: worker.name,
        createdAt: new Date().toISOString(),
        sourceImageUrl: modelProfile.requiresImage
          ? typeof body.imageUrl === "string" && body.imageUrl
            ? body.imageUrl
            : imageName
          : undefined,
        progress: 0,
        stage: "main",
      };

      await addToHistory(item);

      return NextResponse.json({
        id,
        comfyPromptId: comfyResponse.prompt_id,
        clientId,
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // Wan 2.2 Fun VACE template lane (reference-to-video + footage editing)
    // ------------------------------------------------------------------
    // Explicit selection only (never a routing default). Two modes, one lane:
    //   kind "wan-vace"      → REFERENCE-TO-VIDEO: imageUrl is the identity
    //                          reference (person/product), the prompt drives
    //                          a new scene. 16fps → the RIFE post gate in
    //                          /api/status DOES fire for this kind (16→32fps
    //                          delivery, matching the other Wan lanes).
    //   kind "wan-vace-edit" → FOOTAGE EDITING: videoUrl (the clip) + maskUrl
    //                          (white = regenerate) → the masked region is
    //                          regenerated motion-matched. Input is resampled
    //                          to 16fps (duration preserved) and the output
    //                          STAYS 16fps — never RIFE'd, so the edit stays
    //                          fps-coherent for conform back into the edit.
    if (
      modelProfile.kind === "wan-vace" ||
      modelProfile.kind === "wan-vace-edit"
    ) {
      const isEdit = modelProfile.kind === "wan-vace-edit";
      if (!isEdit && !imageName) {
        // The prerequisites block already 400'd this; belt-and-suspenders.
        return NextResponse.json(
          { error: "VACE reference-to-video requires a reference image" },
          { status: 400 },
        );
      }
      if (isEdit && (!videoName || !maskName)) {
        // The prerequisites block already 400'd these; belt-and-suspenders.
        return NextResponse.json(
          { error: "VACE editing requires both a video and a mask" },
          { status: 400 },
        );
      }

      const vaceFps = modelProfile.fps ?? 16;
      const vaceWidth = body.width || modelProfile.defaultWidth || 1280;
      const vaceHeight = body.height || modelProfile.defaultHeight || 720;
      // Wan 4n+1 grid @ 16fps. For edits, duration should be ≈ the input
      // clip's length: frames past the clip's end are unconstrained
      // generation (WanVaceToVideo pads the control video), frames beyond
      // `length` are simply not loaded (frame_load_cap).
      const length = body.duration
        ? durationToLegalFrames(body.duration, vaceFps, "wan")
        : (modelProfile.defaultLength ?? 81);
      const seed = req.seed ?? Math.floor(Math.random() * 2147483647);

      const template = loadTemplate(
        modelProfile.templateFile ?? "vace_ref.json",
      );
      const negative =
        typeof body.negativePrompt === "string" ? body.negativePrompt : undefined;
      const workflow = isEdit
        ? buildVaceInpaint({
            template,
            prompt: req.prompt,
            negative,
            videoName: videoName as string,
            maskName: maskName as string,
            maskIsImage,
            length,
            seed,
            width: vaceWidth,
            height: vaceHeight,
          })
        : buildVaceRef({
            template,
            prompt: req.prompt,
            negative,
            referenceImageName: imageName as string,
            length,
            seed,
            width: vaceWidth,
            height: vaceHeight,
          });

      const clientId = uuidv4();
      const comfyResponse = await queuePrompt(
        comfyBase,
        workflow.prompt as unknown as Record<string, unknown>,
        clientId,
      );

      const item: VideoGenerationItem = {
        id,
        status: "processing",
        prompt: req.prompt,
        comfyPromptId: comfyResponse.prompt_id,
        width: workflow.extra_data.width ?? vaceWidth,
        height: workflow.extra_data.height ?? vaceHeight,
        fps: vaceFps,
        frames: workflow.extra_data.length,
        duration: framesToDuration(workflow.extra_data.length, vaceFps),
        resolution: `${workflow.extra_data.width ?? vaceWidth}x${workflow.extra_data.height ?? vaceHeight}`,
        seed,
        model: modelProfile.id,
        modelName: modelProfile.name,
        worker: worker.name,
        createdAt: new Date().toISOString(),
        sourceImageUrl: !isEdit
          ? typeof body.imageUrl === "string" && body.imageUrl
            ? body.imageUrl
            : imageName
          : undefined,
        sourceVideoUrl: isEdit
          ? typeof body.videoUrl === "string" && body.videoUrl
            ? body.videoUrl
            : videoName
          : undefined,
        sourceMaskUrl: isEdit
          ? typeof body.maskUrl === "string" && body.maskUrl
            ? body.maskUrl
            : maskName
          : undefined,
        progress: 0,
        stage: "main",
      };

      await addToHistory(item);

      return NextResponse.json({
        id,
        comfyPromptId: comfyResponse.prompt_id,
        clientId,
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // Wan 2.2 I2V / FLF2V template lane
    // ------------------------------------------------------------------
    if (modelProfile.kind === "wan-i2v") {
      if (!imageName) {
        // resolveVideoModelId should have routed this away already.
        return NextResponse.json(
          { error: "Wan 2.2 I2V requires an input image" },
          { status: 400 },
        );
      }
      if (modelProfile.supportsEndImage && !endImageName) {
        // The FLF2V template hard-wires an end-image node; without an end
        // frame buildWanI2V would throw (surfacing as a 500). Client error.
        return NextResponse.json(
          {
            error:
              "Wan 2.2 FLF2V requires both a start and an end image (endImage / endImageUrl / endImageBase64 / endImagePath)",
          },
          { status: 400 },
        );
      }

      const wanFps = modelProfile.fps ?? WAN_VIDEO_MODEL.defaultParams.fps;
      // Resolution is template-locked (1280x720); caller width/height for the
      // LTX lane must not leak into the Wan graph.
      const wanWidth =
        modelProfile.defaultWidth ?? WAN_VIDEO_MODEL.defaultParams.width;
      const wanHeight =
        modelProfile.defaultHeight ?? WAN_VIDEO_MODEL.defaultParams.height;
      const length = body.duration
        ? durationToLegalFrames(body.duration, wanFps, "wan")
        : (modelProfile.defaultLength ?? WAN_VIDEO_MODEL.defaultParams.frames);
      const seed = req.seed ?? Math.floor(Math.random() * 2147483647);

      const template = loadTemplate(
        modelProfile.templateFile ?? "wan22-i2v.json",
      );
      const workflow = buildWanI2V({
        template,
        prompt: req.prompt,
        negative: typeof body.negativePrompt === "string" ? body.negativePrompt : undefined,
        imageName,
        endImageName: modelProfile.supportsEndImage ? endImageName : undefined,
        cameraMove: req.cameraMove,
        length,
        seed,
      });

      const clientId = uuidv4();
      const comfyResponse = await queuePrompt(
        comfyBase,
        workflow.prompt as unknown as Record<string, unknown>,
        clientId,
      );

      const item: VideoGenerationItem = {
        id,
        status: "processing",
        prompt: req.prompt,
        comfyPromptId: comfyResponse.prompt_id,
        width: wanWidth,
        height: wanHeight,
        fps: wanFps,
        frames: length,
        duration: framesToDuration(length, wanFps),
        resolution: `${wanWidth}x${wanHeight}`,
        seed,
        model: modelProfile.id,
        modelName: modelProfile.name,
        worker: worker.name,
        createdAt: new Date().toISOString(),
        sourceImageUrl:
          typeof body.imageUrl === "string" && body.imageUrl
            ? body.imageUrl
            : imageName,
        endImageUrl:
          typeof body.endImageUrl === "string" && body.endImageUrl
            ? body.endImageUrl
            : endImageName,
        progress: 0,
        stage: "main",
      };

      await addToHistory(item);

      return NextResponse.json({
        id,
        comfyPromptId: comfyResponse.prompt_id,
        clientId,
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // LTX 2.3 LIP-SYNC template lane (presenter still + VO → talking head)
    // ------------------------------------------------------------------
    // Explicit selection only (model "ltx23-lipsync" or laneKey "LIP-SYNC").
    // Both inputs were validated + uploaded in the prerequisites block above.
    // The frame count derives from the VO length (ceil'd to the 8n+1 grid,
    // capped at one 121-frame sampling window); the output mp4's audio track
    // is the ORIGINAL VO (CreateVideo muxes the LoadAudio output directly).
    // kind "ltx-template" keeps this lane clear of the RIFE post gate.
    if (modelProfile.requiresAudio) {
      if (!imageName || !audioName || !audioSeconds) {
        // The prerequisites block already 400'd these; belt-and-suspenders.
        return NextResponse.json(
          { error: "LIP-SYNC requires both a presenter image and a voiceover" },
          { status: 400 },
        );
      }

      const lipsyncFps = modelProfile.fps ?? LTX_LIPSYNC_FPS;
      const lipsyncWidth = body.width || modelProfile.defaultWidth || 960;
      const lipsyncHeight = body.height || modelProfile.defaultHeight || 544;
      // Audio decides the duration — never body.duration.
      const length = lipsyncAudioToFrames(audioSeconds);
      const seed = req.seed ?? Math.floor(Math.random() * 2147483647);

      const template = loadTemplate(
        modelProfile.templateFile ?? "ltx23_lipsync.json",
      );
      const workflow = buildLtxLipsync({
        template,
        prompt: req.prompt,
        negative:
          typeof body.negativePrompt === "string" ? body.negativePrompt : undefined,
        imageName,
        audioName,
        length,
        seed,
        width: lipsyncWidth,
        height: lipsyncHeight,
      });

      const clientId = uuidv4();
      const comfyResponse = await queuePrompt(
        comfyBase,
        workflow.prompt as unknown as Record<string, unknown>,
        clientId,
      );

      const item: VideoGenerationItem = {
        id,
        status: "processing",
        prompt: req.prompt,
        comfyPromptId: comfyResponse.prompt_id,
        width: lipsyncWidth,
        height: lipsyncHeight,
        fps: lipsyncFps,
        frames: workflow.extra_data.length,
        duration: framesToDuration(workflow.extra_data.length, lipsyncFps),
        resolution: `${lipsyncWidth}x${lipsyncHeight}`,
        seed,
        model: modelProfile.id,
        modelName: modelProfile.name,
        worker: worker.name,
        createdAt: new Date().toISOString(),
        sourceImageUrl:
          typeof body.imageUrl === "string" && body.imageUrl
            ? body.imageUrl
            : imageName,
        sourceAudioUrl:
          typeof body.audioUrl === "string" && body.audioUrl
            ? body.audioUrl
            : audioName,
        progress: 0,
        stage: "main",
      };

      await addToHistory(item);

      return NextResponse.json({
        id,
        comfyPromptId: comfyResponse.prompt_id,
        clientId,
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // LTX 2.3 Flash AV template lane (text-only default; optional i2v)
    // ------------------------------------------------------------------
    // No image required. When one IS provided it was already uploaded above
    // (same path as the Wan lane) and is passed through as the i2v condition
    // frame. 24fps native WITH audio → the RIFE post job is never submitted
    // for this lane (the status route gates it on kind === "wan-i2v"; RIFE's
    // VHS re-encode would strip the audio track).
    if (modelProfile.kind === "ltx-template") {
      const ltxFps = modelProfile.fps ?? 24;
      const ltxWidth =
        body.width || modelProfile.defaultWidth || LTX_VIDEO_MODEL.defaultParams.width;
      const ltxHeight =
        body.height || modelProfile.defaultHeight || LTX_VIDEO_MODEL.defaultParams.height;
      // Frames snap to the LTX 8n+1 grid inside buildLtxTemplate too; compute
      // the legal count here so history records what actually got queued.
      const length = body.duration
        ? durationToLegalFrames(body.duration, ltxFps, "ltx")
        : (modelProfile.defaultLength ?? LTX_VIDEO_MODEL.defaultParams.frames);
      const seed = req.seed ?? Math.floor(Math.random() * 2147483647);

      const template = loadTemplate(
        modelProfile.templateFile ?? "ltx23_flash.json",
      );
      const workflow = buildLtxTemplate({
        template,
        prompt: req.prompt,
        negative:
          typeof body.negativePrompt === "string" ? body.negativePrompt : undefined,
        imageName,
        length,
        seed,
        width: ltxWidth,
        height: ltxHeight,
      });

      const clientId = uuidv4();
      const comfyResponse = await queuePrompt(
        comfyBase,
        workflow.prompt as unknown as Record<string, unknown>,
        clientId,
      );

      const item: VideoGenerationItem = {
        id,
        status: "processing",
        prompt: req.prompt,
        comfyPromptId: comfyResponse.prompt_id,
        width: ltxWidth,
        height: ltxHeight,
        fps: ltxFps,
        frames: workflow.extra_data.length,
        duration: framesToDuration(workflow.extra_data.length, ltxFps),
        resolution: `${ltxWidth}x${ltxHeight}`,
        seed,
        model: modelProfile.id,
        modelName: modelProfile.name,
        worker: worker.name,
        createdAt: new Date().toISOString(),
        sourceImageUrl:
          typeof body.imageUrl === "string" && body.imageUrl
            ? body.imageUrl
            : imageName,
        progress: 0,
        stage: "main",
      };

      await addToHistory(item);

      return NextResponse.json({
        id,
        comfyPromptId: comfyResponse.prompt_id,
        clientId,
        status: "processing",
      });
    }

    // ------------------------------------------------------------------
    // Repaired LTX ComfyUI lane (no input image)
    // ------------------------------------------------------------------
    const clientId = uuidv4();
    const workflow = req.sourceImage
      ? buildImageToVideoWorkflow({ ...req, sourceImage: req.sourceImage })
      : buildTextToVideoWorkflow(req);

    // Queue to ComfyUI
    const comfyResponse = await queuePrompt(comfyBase, workflow.prompt as Record<string, unknown>, clientId);

    // Record the grid-snapped frame count actually queued (8n+1 for LTX),
    // not the raw fps*duration+1 value.
    const frames = durationToLegalFrames(req.duration, req.fps, "ltx");
    const resolutionLabel =
      LTX_VIDEO_MODEL.resolutionPresets.find(
        (p) => p.width === req.width && p.height === req.height
      )?.label || `${req.width}x${req.height}`;

    // Save to history
    const item: VideoGenerationItem = {
      id,
      status: "processing",
      prompt: req.prompt,
      comfyPromptId: comfyResponse.prompt_id,
      width: req.width,
      height: req.height,
      fps: req.fps,
      frames,
      duration: req.duration,
      resolution: resolutionLabel,
      seed: (workflow.extra_data as { seed: number }).seed,
      model: modelProfile.id,
      modelName: modelProfile.name,
      worker: worker.name,
      createdAt: new Date().toISOString(),
      sourceImageUrl: req.sourceImage,
      progress: 0,
      stage: "main",
    };

    await addToHistory(item);

    return NextResponse.json({
      id,
      comfyPromptId: comfyResponse.prompt_id,
      clientId,
      status: "processing",
    });
  } catch (error) {
    console.error("Generate error:", error);
    const message = error instanceof Error ? error.message : "Generation failed";
    // ComfyUI /prompt validation failures (node_errors) come through here
    // with the per-node details already formatted by queuePrompt.
    const status = message.includes("ComfyUI queue failed") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

async function completeLtxDesktopGeneration(
  id: string,
  req: GenerateRequest,
  modelProfile: VideoModelProfile,
) {
  try {
    const ltxResult = await generateLtxDesktopVideo(req, modelProfile);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://192.168.4.176:3060";
    const videoUrl = buildLtxDesktopOutputUrl(appUrl, ltxResult.videoPath);

    await updateHistoryItem(id, {
      status: "completed",
      fps: ltxResult.fps,
      frames: durationToFrames(ltxResult.duration, ltxResult.fps),
      duration: ltxResult.duration,
      progress: 100,
      url: videoUrl,
      filename: ltxResult.filename,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    console.error("LTX Desktop generation error:", error);
    await updateHistoryItem(id, {
      status: "failed",
      error: message,
      progress: 0,
    });
  }
}
