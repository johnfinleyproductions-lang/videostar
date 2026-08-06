// POST /api/finish — Dispatch an upscale "finisher" job on an already-rendered
// clip that lives in the ComfyUI OUTPUT directory.
//
// Two tiers, both template lanes (patched by _meta.title, like every other
// FrameForge lane):
//   - "review": FlashVSR Ultra-Fast 2x   (flashvsr_review.json — fast pass)
//   - "hero":   SeedVR2 v2.5 7B-sharp    (seedvr2_hero.json — 1080p quality)
//
// Body: {
//   fileUrl?: string;     // an /api/output?filename=..&subfolder=.. URL
//   filename?: string;    // OR the raw output filename ...
//   subfolder?: string;   // ... plus its output subfolder ("" ok)
//   tier?: "review" | "hero";   // default "review"
//   fps?: number;         // MUST match the input clip's fps; default 32
//                         // (RIFE'd Wan finals; raw Wan = 16, LTX Flash = 24)
//   worker?: string;      // fleet worker NAME whose output dir holds the
//                         // clip (default: the default worker — pre-fleet
//                         // behavior; the upscale runs on that same worker)
// }
//
// Contract (same shape as /api/generate): returns
//   { id, comfyPromptId, clientId, status: "processing" }.
// The job is recorded in history with kind "finish" so /api/status/[id] polls
// it to completion like any main-stage job WITHOUT submitting the RIFE post
// job (finishers are single-stage; see the kind gate in the status route).

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  freeComfyMemory,
  queuePrompt,
  toAnnotatedOutputPath,
  unloadOllamaModels,
} from "@/lib/comfyui-client";
import { addToHistory } from "@/lib/history";
import { getEnabledWorkers, getWorker } from "@/lib/fleet";
import { loadTemplate, patchByTitle } from "@/lib/workflow-builder";
import type { ComfyWorkflow, VideoGenerationItem } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

type FinishTier = "review" | "hero";

const DEFAULT_TIER: FinishTier = "review";
/** Default fps for finisher output: RIFE'd Wan finals are 16 × 2 = 32. */
const DEFAULT_FPS = 32;

const TIER_CONFIG: Record<
  FinishTier,
  { templateFile: string; modelName: string }
> = {
  review: {
    templateFile: "flashvsr_review.json",
    modelName: "FlashVSR 2x (review finish)",
  },
  hero: {
    templateFile: "seedvr2_hero.json",
    modelName: "SeedVR2 7B sharp 1080p (hero finish)",
  },
};

/** Reject path components that could escape the ComfyUI output directory. */
function isSafePathComponent(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("..") &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.includes("[") // would corrupt the "<path> [output]" annotation
  );
}

/**
 * Resolve the input clip from the request body: either an explicit
 * filename(+subfolder) pair, or a fileUrl carrying them as query params
 * (the shape of every URL this app hands out: /api/output?filename=..&
 * subfolder=..; ComfyUI's own /view URLs match too).
 */
function resolveInputClip(body: {
  fileUrl?: unknown;
  filename?: unknown;
  subfolder?: unknown;
}): { filename: string; subfolder: string } | { error: string } {
  if (typeof body.filename === "string" && body.filename.trim()) {
    return {
      filename: body.filename.trim(),
      subfolder: typeof body.subfolder === "string" ? body.subfolder.trim() : "",
    };
  }

  if (typeof body.fileUrl === "string" && body.fileUrl.trim()) {
    let url: URL;
    try {
      url = new URL(body.fileUrl.trim());
    } catch {
      return { error: "fileUrl is not a valid URL" };
    }
    const filename = url.searchParams.get("filename");
    if (!filename) {
      return {
        error:
          "fileUrl must carry filename (and optionally subfolder) query params — e.g. an /api/output URL",
      };
    }
    return { filename, subfolder: url.searchParams.get("subfolder") || "" };
  }

  return { error: "Provide fileUrl, or filename (+ optional subfolder)" };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // ------------------------------------------------------------------
    // Validate inputs
    // ------------------------------------------------------------------
    const clip = resolveInputClip(body);
    if ("error" in clip) {
      return NextResponse.json({ error: clip.error }, { status: 400 });
    }
    if (
      !isSafePathComponent(clip.filename) ||
      (clip.subfolder !== "" && !isSafePathComponent(clip.subfolder))
    ) {
      return NextResponse.json(
        { error: "Invalid filename/subfolder" },
        { status: 400 },
      );
    }

    const tier: FinishTier =
      body.tier === undefined ? DEFAULT_TIER : (body.tier as FinishTier);
    if (tier !== "review" && tier !== "hero") {
      return NextResponse.json(
        { error: 'tier must be "review" or "hero"' },
        { status: 400 },
      );
    }

    // Output fps must MATCH the input clip's fps (the upscalers are
    // frame-count-preserving; a wrong rate changes playback speed).
    const fps = body.fps === undefined ? DEFAULT_FPS : Number(body.fps);
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
      return NextResponse.json(
        { error: "fps must be a positive number (the input clip's fps)" },
        { status: 400 },
      );
    }

    // Fleet worker whose OUTPUT DIR holds the input clip — the finisher must
    // run there (the annotated "[output]" path is box-local). Omitted =
    // default worker (pre-fleet behavior, and where all legacy renders
    // live). An explicit unknown name is a caller error, not a fallback.
    let workerName: string | undefined;
    if (body.worker !== undefined) {
      if (typeof body.worker !== "string" || !body.worker.trim()) {
        return NextResponse.json(
          { error: "worker must be a fleet worker name (e.g. \"vidbox\")" },
          { status: 400 },
        );
      }
      workerName = body.worker.trim();
      if (!getEnabledWorkers().some((w) => w.name === workerName)) {
        return NextResponse.json(
          {
            error:
              `Unknown/disabled worker "${workerName}" — enabled workers: ` +
              getEnabledWorkers().map((w) => w.name).join(", "),
          },
          { status: 400 },
        );
      }
    }
    const worker = getWorker(workerName);
    const comfyBase = worker.comfyBase as string;

    // ------------------------------------------------------------------
    // Build the workflow from the tier template
    // ------------------------------------------------------------------
    const id = uuidv4();
    const config = TIER_CONFIG[tier];
    const template = loadTemplate(config.templateFile);
    const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

    // VHS_LoadVideo resolves ComfyUI "annotated" paths — point it at the
    // finished clip in the output directory.
    patchByTitle(workflow, "FF Load").node.inputs.video =
      toAnnotatedOutputPath(clip);

    const save = patchByTitle(workflow, "FF Output");
    save.node.inputs.frame_rate = fps;
    save.node.inputs.filename_prefix = `video/finish/${tier}-${id}`;

    // ------------------------------------------------------------------
    // Dispatch (same VRAM sweep as every other video dispatch)
    // ------------------------------------------------------------------
    console.log(
      `[FrameForge] Pre-dispatch VRAM sweep (worker=${worker.name}, lane=finish-${tier}, job=${id})`,
    );
    await Promise.all([freeComfyMemory(comfyBase), unloadOllamaModels()]);

    const clientId = uuidv4();
    const comfyResponse = await queuePrompt(
      comfyBase,
      workflow as unknown as Record<string, unknown>,
      clientId,
    );
    console.log(
      `[FrameForge] Finish job (${tier}) queued for ${id}: prompt ${comfyResponse.prompt_id} (input ${toAnnotatedOutputPath(clip)}, fps ${fps})`,
    );

    // ------------------------------------------------------------------
    // History entry — kind "finish": the status route polls it to
    // completion as a main-stage job and never submits the RIFE post job.
    // ------------------------------------------------------------------
    const item: VideoGenerationItem = {
      id,
      status: "processing",
      prompt: `Finish (${tier}): ${clip.subfolder ? `${clip.subfolder}/` : ""}${clip.filename}`,
      comfyPromptId: comfyResponse.prompt_id,
      kind: "finish",
      tier,
      // Source clip dimensions aren't known here; the upscaler preserves the
      // frame count and the output resolution is recipe-determined.
      width: 0,
      height: 0,
      fps,
      frames: 0,
      duration: 0,
      resolution: tier === "hero" ? "SeedVR2 1080p" : "FlashVSR 2x",
      model: `finish-${tier}`,
      modelName: config.modelName,
      worker: worker.name,
      createdAt: new Date().toISOString(),
      sourceImageUrl: undefined,
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
    console.error("Finish error:", error);
    const message = error instanceof Error ? error.message : "Finish failed";
    // ComfyUI /prompt validation failures (node_errors) come through here
    // with the per-node details already formatted by queuePrompt.
    const status = message.includes("ComfyUI queue failed") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
