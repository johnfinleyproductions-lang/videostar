// POST /api/images/generate - Queue a local image generation.

import { NextRequest, NextResponse } from "next/server";
import {
  queueFluxPrompt,
  getFluxPreflight,
  resolveFluxComfyBase,
} from "@/lib/flux-client";
import { buildFluxWorkflow } from "@/lib/flux-workflow-builder";
import {
  getLensPreflight,
  isLensModel,
  queueLensPrompt,
} from "@/lib/lens-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const model = searchParams.get("model") || undefined;

  if (isLensModel(model)) {
    const preflight = await getLensPreflight();
    return NextResponse.json({
      ok: preflight.ok,
      status: preflight.ok ? "ready" : "unavailable",
      missing: preflight.missing,
      runtime: preflight.runtime,
      provider: "lens",
    });
  }

  const preflight = await getFluxPreflight(resolveFluxComfyBase(), model);
  return NextResponse.json({
    ok: preflight.ok,
    status: preflight.ok ? "ready" : "unavailable",
    missing: preflight.missing,
    comfyuiUrl: preflight.comfyuiUrl,
    provider: "comfyui",
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      prompt,
      negativePrompt,
      width,
      height,
      steps,
      cfg,
      guidance_scale: guidanceScale,
      seed,
      referenceImage,
      denoise,
      model,
      repo_id: repoId,
      base_resolution: baseResolution,
      aspect_ratio: aspectRatio,
      dtype,
    } = body;

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }

    const requestedModel =
      typeof model === "string"
        ? model
        : typeof repoId === "string"
          ? repoId
          : undefined;

    if (isLensModel(requestedModel)) {
      const preflight = await getLensPreflight();
      if (!preflight.ok) {
        return NextResponse.json(
          {
            error: "Lens-Turbo is not ready on this vidbox runtime",
            missing: preflight.missing,
            runtime: preflight.runtime,
          },
          { status: 503 },
        );
      }

      const response = await queueLensPrompt({
        prompt,
        negativePrompt,
        width,
        height,
        steps,
        cfg: cfg ?? guidanceScale,
        seed,
        model: requestedModel,
        repoId,
        baseResolution,
        aspectRatio,
        dtype,
      });

      return NextResponse.json({
        prompt_id: response.prompt_id,
        client_id: response.prompt_id,
        status: "processing",
        provider: "lens",
      });
    }

    // Stills worker: FLUX_COMFYUI_URL override, else the first enabled
    // "flux-image" fleet worker (deterministic — the stateless images API
    // must poll the same box it dispatched to; see flux-client.ts).
    const fluxBase = resolveFluxComfyBase();
    const preflight = await getFluxPreflight(fluxBase, model);
    if (!preflight.ok) {
      return NextResponse.json(
        {
          error: "Image generation profile is not ready on this ComfyUI runtime",
          missing: preflight.missing,
          comfyuiUrl: preflight.comfyuiUrl,
        },
        { status: 503 },
      );
    }

    const workflow = buildFluxWorkflow({
      prompt,
      negativePrompt,
      width,
      height,
      steps,
      cfg,
      seed,
      referenceImage,
      denoise,
      model,
    });

    const clientId = `frameforge-${Date.now()}`;
    const response = await queueFluxPrompt(fluxBase, workflow, clientId);

    return NextResponse.json({
      prompt_id: response.prompt_id,
      client_id: clientId,
      status: "processing",
      provider: "comfyui",
    });
  } catch (error) {
    console.error("Image generate error:", error);
    const message = error instanceof Error ? error.message : "Generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
