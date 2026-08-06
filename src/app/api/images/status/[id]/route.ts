// GET /api/images/status/[id] - Check local image generation status.

import { NextRequest, NextResponse } from "next/server";
import {
  getFluxHistory,
  extractFluxImageFilename,
  fluxOutputUrl,
  resolveFluxComfyBase,
} from "@/lib/flux-client";
import { getLensJobStatus, isLensJobId } from "@/lib/lens-client";

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

    // Same deterministic stills worker the dispatch used (see flux-client).
    const fluxBase = resolveFluxComfyBase();
    const history = await getFluxHistory(fluxBase, id);

    if (!history) {
      return NextResponse.json({
        id,
        status: "processing",
      });
    }

    if (history.status.completed) {
      const output = extractFluxImageFilename(history);

      if (output) {
        return NextResponse.json({
          id,
          status: "completed",
          url: fluxOutputUrl(fluxBase, output.filename, output.subfolder),
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

    if (history.status.status_str === "error") {
      return NextResponse.json({
        id,
        status: "failed",
        error: "ComfyUI workflow error",
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
