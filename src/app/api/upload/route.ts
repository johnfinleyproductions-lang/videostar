// POST /api/upload — Upload a source image to ComfyUI for image-to-video

import { NextRequest, NextResponse } from "next/server";
import { uploadImage } from "@/lib/comfyui-client";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("image") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await uploadImage(buffer, file.name);

    return NextResponse.json({
      filename: result.name,
      subfolder: result.subfolder,
      type: result.type,
    });
  } catch (error) {
    console.error("Upload error:", error);
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
