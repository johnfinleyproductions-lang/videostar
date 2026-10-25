// GET /api/images/status/[id] - Check local image generation status.

import { NextRequest, NextResponse } from "next/server";
import {
  getFluxHistory,
  extractFluxImageFilename,
  fluxOutputUrl,
  resolveFluxComfyBase,
  isCreativeImageJob,
  CREATIVE_IMAGE_JOB_PREFIX,
} from "@/lib/flux-client";
import { getLensJobStatus, isLensJobId } from "@/lib/lens-client";
import { getMingJobStatus, isMingJobId } from "@/lib/ming-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (isLensJobId(id)) {
      return NextResponse.json(await getLensJobStatus(id));
    }
    if (isMingJobId(id)) {
      return NextResponse.json(await getMingJobStatus(id));
    }

    // Same deterministic stills worker the dispatch used (see flux-client).
    const creative = isCreativeImageJob(id);
    if (id.startsWith(CREATIVE_IMAGE_JOB_PREFIX) && !creative) {
      return NextResponse.json({ error: "Invalid image job id" }, { status: 400 });
    }
    const fluxBase = resolveFluxComfyBase(creative ? "flux3-klein" : undefined);
    const history = await getFluxHistory(fluxBase, creative ? id.slice(CREATIVE_IMAGE_JOB_PREFIX.length) : id);

    if (!history) {
      return NextResponse.json({
        id,
        status: "processing",
      });
    }

    if (history.status.status_str === "error") {
      return NextResponse.json({ id, status: "failed", error: "ComfyUI workflow error" });
    }
    if (history.status.completed) {
      const output = extractFluxImageFilename(history);

      if (output) {
        return NextResponse.json({
          id,
          status: "completed",
          url: fluxOutputUrl(fluxBase, output.filename, output.subfolder, creative ? "vidbox" : undefined),
          filename: output.filename,
          provider: "comfyui",
        });
      }

      return NextResponse.json({
        id,
        status: "failed",
        error: "No output image found",
      });
    }

    return NextResponse.json({
      id,
      status: "processing",
    });
  } catch (error) {
    console.error("Image status error:", error);
    return NextResponse.json({ error: "Status check failed" }, { status: 500 });
  }
}
