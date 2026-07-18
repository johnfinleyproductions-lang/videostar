// GET /api/status/[id] — Check generation status via ComfyUI history
//
// Two-job pipeline for the Wan lanes: when the stage-1 generation completes,
// a RIFE interpolation post job (wan22_post_rife.json) is submitted under the
// SAME public job id. The status stays "processing" until the post job
// finishes; the final url/filename point at the interpolated output. If the
// post job fails, the stage-1 clip is returned with a `warning` field.

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  extractOutputFilename,
  freeComfyMemory,
  getHistory,
  queuePrompt,
  toAnnotatedOutputPath,
  unloadOllamaModels,
  type ComfyUIHistoryItem,
} from "@/lib/comfyui-client";
import { getHistoryItem, updateHistoryItem } from "@/lib/history";
import {
  getRemotionJob,
  REMOTION_SERVICE_DOWN_MESSAGE,
} from "@/lib/remotion-client";
import { getVideoModelProfile } from "@/lib/models";
import { loadTemplate, patchByTitle } from "@/lib/workflow-builder";
import type { ComfyWorkflow, VideoGenerationItem } from "@/lib/types";
import {
  buildLtxDesktopOutputUrl,
  findNewestLtxDesktopOutput,
  getLtxDesktopGenerationProgress,
} from "@/lib/ltx-desktop-client";

export const dynamic = "force-dynamic";

const POST_TEMPLATE_FILE = "wan22_post_rife.json";
const POST_STAGE_PROGRESS = 90;

function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://192.168.4.176:3060";
}

function buildOutputUrl(output: { filename: string; subfolder: string }): string {
  return `${getAppUrl()}/api/output?filename=${encodeURIComponent(
    output.filename,
  )}&subfolder=${encodeURIComponent(output.subfolder)}`;
}

/** History error signal ("error" status_str, or completed with no files). */
function historyErrored(history: ComfyUIHistoryItem): boolean {
  return history.status?.status_str === "error";
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const item = await getHistoryItem(id);

    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (item.status === "failed" && item.model?.startsWith("ltx-desktop") && !item.url) {
      const recovered = await recoverLtxDesktopOutput(id, item);
      if (recovered) {
        return NextResponse.json(recovered);
      }
    }

    // If already completed or failed, return cached status
    if (item.status === "completed" || item.status === "failed") {
      return NextResponse.json({
        id: item.id,
        status: item.status,
        url: item.url,
        filename: item.filename,
        error: item.error,
        warning: item.warning,
        // MG-TYPE LowerThird only: browser-playable alpha webm preview
        // alongside the ProRes .mov url (additive; undefined elsewhere).
        previewUrl: item.previewUrl,
        progress: item.status === "completed" ? 100 : undefined,
      });
    }

    // ------------------------------------------------------------------
    // Remotion MG-TYPE jobs poll the think render service, not ComfyUI
    // ------------------------------------------------------------------
    // kind "remotion" items carry a remoteJobId instead of a comfyPromptId
    // (this branch must sit BEFORE the "No ComfyUI prompt ID" fallback).
    // On completion the url proxies the file straight from think via
    // /api/output?remotion=<remoteJobId> — no local download-and-cache, the
    // service keeps outputs under service-jobs/<jobId>/ and jobs.json makes
    // the pointers survive its restarts.
    if (item.kind === "remotion") {
      return NextResponse.json(await checkRemotionJob(id, item));
    }

    if (!item.comfyPromptId && item.model?.startsWith("ltx-desktop")) {
      const recovered = await recoverLtxDesktopOutput(id, item);
      if (recovered) {
        return NextResponse.json(recovered);
      }

      const ltxProgress = await getLtxDesktopGenerationProgress();
      return NextResponse.json({
        id: item.id,
        status: "processing",
        progress: Math.max(item.progress || 0, ltxProgress?.progress || 0),
      });
    }

    // Check ComfyUI for current status
    if (!item.comfyPromptId) {
      return NextResponse.json({
        id: item.id,
        status: "failed",
        error: "No ComfyUI prompt ID",
      });
    }

    // ------------------------------------------------------------------
    // Post-processing stage (RIFE job already submitted for this id)
    // ------------------------------------------------------------------
    if (item.stage === "post" && item.postPromptId) {
      return NextResponse.json(await checkPostStage(id, item));
    }

    // ------------------------------------------------------------------
    // Main generation stage
    // ------------------------------------------------------------------
    const comfyHistory = await getHistory(item.comfyPromptId);

    if (!comfyHistory) {
      // prompt_id key absent from /history → still queued or executing.
      return NextResponse.json({
        id: item.id,
        status: "processing",
        progress: item.progress || 0,
      });
    }

    const output = extractOutputFilename(comfyHistory);

    if (output) {
      const profile = getVideoModelProfile(item.model);

      // Wan lanes get a RIFE interpolation pass before the job is done.
      // ONLY kinds "wan-i2v" and "wan-vace": the LTX template lane
      // ("ltx-template", e.g. ltx23-flash) is 24fps native WITH an audio
      // track — the RIFE post job's VHS re-encode would strip the audio, so
      // it must never be submitted for that lane. Its SaveVideo output lands
      // under the history `images` key, which extractOutputFilename handles.
      //
      // The Wan-Alpha lane (kind === "wan-alpha", VHS webm output under the
      // history `gifs` key) is likewise excluded BY DESIGN: RIFE's mp4
      // re-encode would destroy the alpha channel. Never widen this gate to
      // a startsWith("wan") style check.
      //
      // item.kind === "finish" (FlashVSR/SeedVR2 upscale jobs from
      // /api/finish) is explicitly exempt too: those are single-stage
      // follow-on jobs on an ALREADY-finished clip (usually already RIFE'd)
      // and must complete directly. getVideoModelProfile falls back to the
      // default LTX profile for their unknown model ids, which would already
      // skip this branch — but the explicit gate keeps that from silently
      // breaking if the default profile ever changes.
      //
      // "wan-vace" (VACE reference-to-video) is INCLUDED by design: 16fps
      // Wan-native output, same delivery contract as WAN-CINE → RIFE to 32.
      // "wan-vace-edit" (VACE footage editing) is EXCLUDED by design: the
      // output must stay fps-coherent with the source clip (16fps in/out,
      // wall-clock duration preserved) so the edit conforms back into a
      // timeline without desyncing external audio.
      if (
        (profile.kind === "wan-i2v" || profile.kind === "wan-vace") &&
        item.kind !== "finish"
      ) {
        const stageOneUrl = buildOutputUrl(output);
        const postPromptId = await submitPostJob(item, output);

        if (postPromptId) {
          await updateHistoryItem(id, {
            stage: "post",
            postPromptId,
            stageOneUrl,
            stageOneFilename: output.filename,
            progress: POST_STAGE_PROGRESS,
          });
          return NextResponse.json({
            id: item.id,
            status: "processing",
            progress: POST_STAGE_PROGRESS,
          });
        }

        // Post submission failed → degrade gracefully to the stage-1 clip.
        const warning =
          "Post-processing (RIFE) could not be submitted; returning the un-interpolated stage-1 clip.";
        await updateHistoryItem(id, {
          status: "completed",
          url: stageOneUrl,
          filename: output.filename,
          warning,
          progress: 100,
        });
        return NextResponse.json({
          id: item.id,
          status: "completed",
          url: stageOneUrl,
          filename: output.filename,
          warning,
          progress: 100,
        });
      }

      // Non-Wan lanes complete directly.
      const videoUrl = buildOutputUrl(output);
      await updateHistoryItem(id, {
        status: "completed",
        url: videoUrl,
        filename: output.filename,
        progress: 100,
      });
      return NextResponse.json({
        id: item.id,
        status: "completed",
        url: videoUrl,
        filename: output.filename,
        progress: 100,
      });
    }

    // History exists but no output file.
    if (historyErrored(comfyHistory) || comfyHistory.status?.completed) {
      const error = historyErrored(comfyHistory)
        ? "ComfyUI workflow error"
        : "No output file found in ComfyUI results";
      await updateHistoryItem(id, { status: "failed", error });
      return NextResponse.json({
        id: item.id,
        status: "failed",
        error,
      });
    }

    // Still processing
    return NextResponse.json({
      id: item.id,
      status: "processing",
      progress: item.progress || 0,
    });
  } catch (error) {
    console.error("Status check error:", error);
    return NextResponse.json(
      { error: "Status check failed" },
      { status: 500 }
    );
  }
}

/**
 * Poll the think render service for an MG-TYPE job. Progress mapping is
 * coarse by design (the service has no per-frame progress): queued 5,
 * rendering 60, completed 100. An unreachable service keeps the job
 * "processing" with a warning (transient network ≠ failed render — the
 * render continues on think either way); an UNKNOWN remote job id (the
 * service lost it, e.g. jobs.json wiped) fails honestly.
 */
async function checkRemotionJob(id: string, item: VideoGenerationItem) {
  if (!item.remoteJobId) {
    const error = "No remote Remotion job id recorded";
    await updateHistoryItem(id, { status: "failed", error });
    return { id: item.id, status: "failed" as const, error };
  }

  let remote;
  try {
    remote = await getRemotionJob(item.remoteJobId);
  } catch (error) {
    console.warn(
      `[FrameForge] Remotion status poll failed for ${id}:`,
      error instanceof Error ? error.message : error,
    );
    return {
      id: item.id,
      status: "processing" as const,
      progress: item.progress || 0,
      warning: REMOTION_SERVICE_DOWN_MESSAGE,
    };
  }

  if (!remote) {
    const error =
      `Remotion job ${item.remoteJobId} is unknown to the render service ` +
      "(it may have lost its job table) — resubmit the generation";
    await updateHistoryItem(id, { status: "failed", error });
    return { id: item.id, status: "failed" as const, error };
  }

  if (remote.status === "failed") {
    const error = remote.error || "Remotion render failed on think";
    await updateHistoryItem(id, { status: "failed", error });
    return { id: item.id, status: "failed" as const, error };
  }

  if (remote.status === "completed") {
    const url = `${getAppUrl()}/api/output?remotion=${encodeURIComponent(item.remoteJobId)}`;
    const previewUrl = remote.previewFilename
      ? `${url}&variant=preview`
      : undefined;
    // Preview failure on think is non-fatal there; surface it as a warning
    // here so an alpha-lane caller knows why previewUrl is missing.
    const warning = remote.previewError
      ? `Alpha webm preview failed on think (${remote.previewError}); the ProRes .mov deliverable is unaffected.`
      : undefined;
    await updateHistoryItem(id, {
      status: "completed",
      url,
      filename: remote.filename,
      previewUrl,
      warning,
      progress: 100,
    });
    return {
      id: item.id,
      status: "completed" as const,
      url,
      filename: remote.filename,
      previewUrl,
      warning,
      progress: 100,
    };
  }

  const progress = remote.status === "rendering" ? 60 : 5;
  if ((item.progress || 0) !== progress) {
    await updateHistoryItem(id, { progress });
  }
  return {
    id: item.id,
    status: "processing" as const,
    progress: Math.max(item.progress || 0, progress),
  };
}

/**
 * Submit the RIFE interpolation post job for a finished Wan stage-1 clip.
 * Returns the new ComfyUI prompt id, or null when submission failed (the
 * caller degrades gracefully to the stage-1 output).
 */
async function submitPostJob(
  item: VideoGenerationItem,
  stageOneOutput: { filename: string; subfolder: string },
): Promise<string | null> {
  try {
    const template = loadTemplate(POST_TEMPLATE_FILE);
    const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

    // VHS_LoadVideo resolves ComfyUI "annotated" paths — "<subfolder>/<name>
    // [output]" points it at the output directory where stage 1 saved.
    patchByTitle(workflow, "LOAD_VIDEO").node.inputs.video =
      toAnnotatedOutputPath(stageOneOutput);

    // Output fps = stage-1 fps × RIFE multiplier (16 × 2 = 32 by default).
    const rife = patchByTitle(workflow, "RIFE_VFI");
    const multiplier = Number(rife.node.inputs.multiplier) || 2;
    const save = patchByTitle(workflow, "SAVE_VIDEO");
    save.node.inputs.frame_rate = (item.fps || 16) * multiplier;
    // Keep final outputs under video/wan/, one file family per public job id.
    save.node.inputs.filename_prefix = `video/wan/final-${item.id}`;

    // Free the Wan experts before the RIFE pass (best-effort) + keep the
    // Ollama eviction, same as any other video dispatch.
    console.log(
      `[FrameForge] Pre-dispatch VRAM sweep (lane=post-rife, job=${item.id})`,
    );
    await Promise.all([freeComfyMemory(), unloadOllamaModels()]);

    const response = await queuePrompt(
      workflow as unknown as Record<string, unknown>,
      randomUUID(),
    );
    console.log(
      `[FrameForge] RIFE post job queued for ${item.id}: prompt ${response.prompt_id}`,
    );
    return response.prompt_id;
  } catch (error) {
    console.error(
      `[FrameForge] RIFE post job submission failed for ${item.id}:`,
      error,
    );
    return null;
  }
}

/** Poll the RIFE post job; finish, degrade, or keep processing. */
async function checkPostStage(id: string, item: VideoGenerationItem) {
  const postHistory = item.postPromptId
    ? await getHistory(item.postPromptId)
    : null;

  if (!postHistory) {
    return {
      id: item.id,
      status: "processing" as const,
      progress: Math.max(item.progress || 0, POST_STAGE_PROGRESS),
    };
  }

  const output = extractOutputFilename(postHistory);

  if (output) {
    const videoUrl = buildOutputUrl(output);
    await updateHistoryItem(id, {
      status: "completed",
      url: videoUrl,
      filename: output.filename,
      progress: 100,
    });
    return {
      id: item.id,
      status: "completed" as const,
      url: videoUrl,
      filename: output.filename,
      progress: 100,
    };
  }

  if (historyErrored(postHistory) || postHistory.status?.completed) {
    // Post job failed → DEGRADE GRACEFULLY: hand back the stage-1 clip.
    const warning =
      "Post-processing (RIFE) failed; returning the un-interpolated stage-1 clip.";
    console.warn(`[FrameForge] ${warning} (job ${id})`);
    await updateHistoryItem(id, {
      status: "completed",
      url: item.stageOneUrl,
      filename: item.stageOneFilename,
      warning,
      progress: 100,
    });
    return {
      id: item.id,
      status: "completed" as const,
      url: item.stageOneUrl,
      filename: item.stageOneFilename,
      warning,
      progress: 100,
    };
  }

  return {
    id: item.id,
    status: "processing" as const,
    progress: Math.max(item.progress || 0, POST_STAGE_PROGRESS),
  };
}

async function recoverLtxDesktopOutput(
  id: string,
  item: NonNullable<Awaited<ReturnType<typeof getHistoryItem>>>,
) {
  const startedAtMs = new Date(item.createdAt).getTime();
  const ltxOutput = await findNewestLtxDesktopOutput(startedAtMs);

  if (!ltxOutput) {
    return null;
  }

  const appUrl = getAppUrl();
  const videoUrl = buildLtxDesktopOutputUrl(appUrl, ltxOutput.videoPath);

  await updateHistoryItem(id, {
    status: "completed",
    url: videoUrl,
    filename: ltxOutput.filename,
    fps: ltxOutput.fps,
    frames: item.frames,
    duration: item.duration,
    progress: 100,
  });

  return {
    id: item.id,
    status: "completed",
    url: videoUrl,
    filename: ltxOutput.filename,
    progress: 100,
  };
}
