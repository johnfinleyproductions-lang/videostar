// GET /api/status/[id] — Check generation status via ComfyUI history

import { NextRequest, NextResponse } from "next/server";
import { getHistory, extractOutputFilename } from "@/lib/comfyui-client";
import { getHistoryItem, updateHistoryItem } from "@/lib/history";

export const dynamic = "force-dynamic";

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

    // If already completed or failed, return cached status
    if (item.status === "completed" || item.status === "failed") {
      return NextResponse.json({
        id: item.id,
        status: item.status,
        url: item.url,
        filename: item.filename,
        error: item.error,
        progress: item.status === "completed" ? 100 : undefined,
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

    const comfyHistory = await getHistory(item.comfyPromptId);

    if (!comfyHistory) {
      // Still queued or processing
      return NextResponse.json({
        id: item.id,
        status: "processing",
        progress: item.progress || 0,
      });
    }

    if (comfyHistory.status.completed) {
      // Extract output file
      const output = extractOutputFilename(comfyHistory);

      if (output) {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://192.168.4.176:3060";
        const videoUrl = `${appUrl}/api/output?filename=${encodeURIComponent(output.filename)}&subfolder=${encodeURIComponent(output.subfolder)}`;

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
      } else {
        await updateHistoryItem(id, {
          status: "failed",
          error: "No output file found",
        });

        return NextResponse.json({
          id: item.id,
          status: "failed",
          error: "No output file found in ComfyUI results",
        });
      }
    }

    // Check for error status
    if (comfyHistory.status.status_str === "error") {
      await updateHistoryItem(id, {
        status: "failed",
        error: "ComfyUI workflow error",
      });

      return NextResponse.json({
        id: item.id,
        status: "failed",
        error: "ComfyUI workflow error",
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
