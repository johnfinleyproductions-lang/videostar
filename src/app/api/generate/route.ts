// POST /api/generate — Queue a video generation to ComfyUI

import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  queuePrompt,
  unloadOllamaModels,
} from "@/lib/comfyui-client";
import { buildTextToVideoWorkflow, buildImageToVideoWorkflow } from "@/lib/workflow-builder";
import { addToHistory } from "@/lib/history";
import { LTX_VIDEO_MODEL, durationToFrames } from "@/lib/models";
import type { GenerateRequest, VideoGenerationItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const req: GenerateRequest = {
      prompt: body.prompt || "",
      width: body.width || LTX_VIDEO_MODEL.defaultParams.width,
      height: body.height || LTX_VIDEO_MODEL.defaultParams.height,
      fps: body.fps || LTX_VIDEO_MODEL.defaultParams.fps,
      duration: body.duration || 4,
      seed: body.seed,
      sourceImage: body.sourceImage,
    };

    if (!req.prompt.trim()) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }

    // Unload Ollama models to free VRAM
    await unloadOllamaModels();

    // Build workflow
    const clientId = uuidv4();
    const workflow = req.sourceImage
      ? buildImageToVideoWorkflow({ ...req, sourceImage: req.sourceImage })
      : buildTextToVideoWorkflow(req);

    // Queue to ComfyUI
    const comfyResponse = await queuePrompt(workflow.prompt as Record<string, unknown>, clientId);

    const id = uuidv4();
    const frames = durationToFrames(req.duration, req.fps);
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
      createdAt: new Date().toISOString(),
      sourceImageUrl: req.sourceImage,
      progress: 0,
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
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
