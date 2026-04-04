// GET /api/output?filename=...&subfolder=... — Proxy ComfyUI output files

import { NextRequest, NextResponse } from "next/server";
import { getOutputFile } from "@/lib/comfyui-client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const filename = searchParams.get("filename");
    const subfolder = searchParams.get("subfolder") || "";

    if (!filename) {
      return NextResponse.json({ error: "Filename required" }, { status: 400 });
    }

    const comfyResponse = await getOutputFile(filename, subfolder);

    if (!comfyResponse.ok) {
      return NextResponse.json(
        { error: "File not found" },
        { status: 404 }
      );
    }

    const contentType =
      comfyResponse.headers.get("content-type") || "video/mp4";
    const body = await comfyResponse.arrayBuffer();

    return new NextResponse(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("Output proxy error:", error);
    return NextResponse.json(
      { error: "Failed to fetch output" },
      { status: 500 }
    );
  }
}
