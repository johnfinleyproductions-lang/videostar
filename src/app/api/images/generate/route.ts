// POST /api/images/generate - Queue a local image generation.

import { NextRequest, NextResponse } from "next/server";
import {
  queueFluxPrompt,
  getFluxPreflight,
  resolveFluxComfyBase,
  uploadFluxInputImage,
} from "@/lib/flux-client";
import { buildFluxWorkflow } from "@/lib/flux-workflow-builder";
import {
  getLensPreflight,
  isLensModel,
  queueLensPrompt,
} from "@/lib/lens-client";
import { getMingPreflight, isMingModel, queueMingPrompt } from "@/lib/ming-client";

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

  if (isMingModel(model)) {
    const preflight = await getMingPreflight();
    return NextResponse.json({
      ok: preflight.ok,
      status: preflight.ok ? "ready" : "unavailable",
      missing: preflight.missing,
      comfyuiUrl: preflight.comfyuiUrl,
      provider: "comfyui",
      ...(preflight.hint ? { hint: preflight.hint } : {}),
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
      referenceImage2,
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

    if (referenceImage2 !== undefined && (requestedModel !== "qwen-image-edit" || typeof referenceImage !== "string" ||
        !referenceImage.startsWith("data:image/") || typeof referenceImage2 !== "string" || !referenceImage2.startsWith("data:image/"))) {
      return NextResponse.json({ error: "Two-image Qwen editing requires source and reference image data." }, { status: 400 });
    }

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
    // Ming-Image design lane: a different box (Framerstation ComfyUI 0.38
    // gpu-flex lane) and a "ming-" job id, so it never touches the Flux path.
    if (isMingModel(requestedModel)) {
      if (referenceImage !== undefined || referenceImage2 !== undefined) {
        return NextResponse.json(
          { error: "Ming-Image design is text-to-image only here (its edit mode is not wired yet)" },
          { status: 400 },
        );
      }
      const mingPreflight = await getMingPreflight();
      if (!mingPreflight.ok) {
        return NextResponse.json(
          {
            error: "Ming-Image is not ready on the Framerstation comfyui-ming lane",
            missing: mingPreflight.missing,
            comfyuiUrl: mingPreflight.comfyuiUrl,
            ...(mingPreflight.hint ? { hint: mingPreflight.hint } : {}),
          },
          { status: 503 },
        );
      }
      const queued = await queueMingPrompt({
        prompt,
        width,
        height,
        seed,
        steps,
        transparent: body.transparent === true || body.background === "transparent",
      });
      return NextResponse.json({
        prompt_id: queued.jobId,
        client_id: queued.jobId,
        status: "processing",
        provider: "comfyui",
        seed: queued.seed,
        width: queued.width,
        height: queued.height,
      });
    }

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

    // Image Studio sends reference images as base64 data URLs; ComfyUI's
    // LoadImage only accepts files already in its input directory. Upload
    // the data URL to the resolved worker and swap in the stored filename.
    let resolvedReferenceImage = referenceImage;
    if (
      typeof referenceImage === "string" &&
      referenceImage.startsWith("data:")
    ) {
      resolvedReferenceImage = await uploadFluxInputImage(
        fluxBase,
        referenceImage,
      );
    }
    const resolvedReferenceImage2 = typeof referenceImage2 === "string"
      ? await uploadFluxInputImage(fluxBase, referenceImage2) : referenceImage2;

    const workflow = buildFluxWorkflow({
      prompt,
      negativePrompt,
      width,
      height,
      steps,
      cfg,
      seed,
      referenceImage: resolvedReferenceImage,
      referenceImage2: resolvedReferenceImage2,
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
