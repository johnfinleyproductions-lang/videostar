import { comfyFetch, isPrivateHistory } from "./comfy-auth";
// FrameForge â€” Flux 2 ComfyUI Client
//
// MULTI-WORKER (2026-07): like comfyui-client.ts, this module is now
// base-agnostic — the network helpers take the target worker's ComfyUI base
// as their FIRST parameter. The stills path resolves its worker through
// resolveFluxComfyBase(): the FLUX_COMFYUI_URL env override still wins (the
// pre-fleet contract), otherwise the first enabled "flux-image" lane worker
// from the fleet (framerstation when active, else the default vidbox).
// Resolution is DETERMINISTIC (first candidate, no availability ping): the
// images API is stateless (the client holds only a prompt_id), so dispatch
// and status polling must land on the same worker every time.

import { resolveWorkerForLane, getWorkerComfyBase } from "./fleet";
import { isCreativeImageModel, CREATIVE_IMAGE_FILES } from "./flux-workflow-builder";
import { readEnum } from "./model-preflight";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** ComfyUI base for the FLUX/Z-Image stills lane (see module note above). */
export const CREATIVE_IMAGE_JOB_PREFIX = "vidbox-image-";
export function isCreativeImageJob(id: string): boolean {
  return /^vidbox-image-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
}
export function resolveFluxComfyBase(model?: string): string {
  if (isCreativeImageModel(model)) return getWorkerComfyBase("vidbox");
  if (process.env.FLUX_COMFYUI_URL) return process.env.FLUX_COMFYUI_URL;
  const [first] = resolveWorkerForLane("flux-image");
  // resolveWorkerForLane always includes the default worker, whose comfyBase
  // is always set (vidbox falls back to http://127.0.0.1:8188).
  return first?.comfyBase ?? "http://127.0.0.1:8188";
}

/**
 * Browser-facing base for /view URLs handed to the client (fluxOutputUrl).
 * Env overrides win; the final fallback is the internal base passed in.
 */
export function resolveFluxPublicBase(internalBase: string): string {
  if (process.env.FLUX_COMFYUI_PUBLIC_URL) return process.env.FLUX_COMFYUI_PUBLIC_URL;
  if (process.env.NEXT_PUBLIC_COMFYUI_URL) return process.env.NEXT_PUBLIC_COMFYUI_URL;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      url.port = "8188";
      return url.toString().replace(/\/$/, "");
    } catch {
      // Fall through to the internal URL below.
    }
  }

  return internalBase;
}

interface FluxPromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

interface FluxHistoryItem {
  outputs: Record<
    string,
    {
      images?: Array<{
        filename: string;
        subfolder: string;
        type: string;
      }>;
    }
  >;
  status: {
    status_str: string;
    completed: boolean;
  };
}

type ObjectInfoNode = {
  input?: {
    required?: Record<string, unknown>;
  };
};

type ZImageProfile =
  | "z-image-base-amateur-photo-8step"
  | "z-image-turbo-amateur-photo";

type FluxPreflightProfile = {
  loaderClass: "UnetLoaderGGUF" | "UNETLoader";
  fileKey: "unet_name";
  modelFile: string;
  clipName: string;
};

const FLUX_DEV_ENCODER = "mistral_3_small_flux2_fp8.safetensors";
const FLUX_KLEIN_ENCODER = "qwen_3_8b_fp8mixed.safetensors";
const FLUX_VAE = "flux2-vae.safetensors";
const Z_IMAGE_TEXT_ENCODER = "qwen_3_4b_fp4_mixed.safetensors";
const Z_IMAGE_VAE = "ae.safetensors";
const Z_IMAGE_AMATEUR_PHOTO_LORA =
  "z-image/deedee_amateur_photography_zimage_base_and_turbo_v1.safetensors";
const Z_IMAGE_DISTILL_8STEP_LORA =
  "z-image/Z-Image-Fun-Lora-Distill-8-Steps-2603-ComfyUI.safetensors";

const Z_IMAGE_PREFLIGHT: Record<
  ZImageProfile,
  {
    diffusionModel: string;
    loras: string[];
  }
> = {
  "z-image-base-amateur-photo-8step": {
    diffusionModel: "z_image_bf16.safetensors",
    loras: [Z_IMAGE_DISTILL_8STEP_LORA, Z_IMAGE_AMATEUR_PHOTO_LORA],
  },
  "z-image-turbo-amateur-photo": {
    diffusionModel: "z_image_turbo_nvfp4.safetensors",
    loras: [Z_IMAGE_AMATEUR_PHOTO_LORA],
  },
};

function extractComboValues(node: ObjectInfoNode | undefined, inputName: string): string[] {
  const inputConfig = node?.input?.required?.[inputName];
  if (!Array.isArray(inputConfig)) return [];
  const values = inputConfig[0];
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

function getFluxPreflightProfile(model?: string): FluxPreflightProfile {
  if (model === "q5" || model === "flux2-hq") {
    return {
      loaderClass: "UnetLoaderGGUF",
      fileKey: "unet_name",
      modelFile: "flux2-dev-Q3_K_M.gguf",
      clipName: FLUX_DEV_ENCODER,
    };
  }

  if (model === "fp8") {
    return {
      loaderClass: "UNETLoader",
      fileKey: "unet_name",
      modelFile: "flux2_dev_fp8mixed.safetensors",
      clipName: FLUX_DEV_ENCODER,
    };
  }

  if (model === "flux2-klein-true-v2") {
    return {
      loaderClass: "UnetLoaderGGUF",
      fileKey: "unet_name",
      modelFile: "Flux2-Klein-9B-True-v2-Q4_K.gguf",
      clipName: FLUX_KLEIN_ENCODER,
    };
  }

  return {
    loaderClass: "UnetLoaderGGUF",
    fileKey: "unet_name",
    modelFile: "flux2-dev-Q3_K_M.gguf",
    clipName: FLUX_DEV_ENCODER,
  };
}

export async function getFluxPreflight(
  base: string,
  model?: string,
): Promise<{
  ok: boolean;
  missing: string[];
  comfyuiUrl: string;
}> {
  let res: Response;
  try {
    res = await comfyFetch(`${base}/object_info`, {
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      missing: [`ComfyUI unreachable at ${base}`],
      comfyuiUrl: base,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      missing: [`ComfyUI object_info returned ${res.status}`],
      comfyuiUrl: base,
    };
  }

  const objectInfo = (await res.json()) as Record<string, ObjectInfoNode>;
  const missing: string[] = [];
  if (isCreativeImageModel(model)) {
    const nodes = ["CLIPTextEncode", "EmptyFlux2LatentImage", "KSampler", "VAEDecode", "SaveImage",
      ...(model === "flux3-klein" ? ["UNETLoader", "CLIPLoader", "VAELoader", "TextGenerate", "ModelSamplingFlux"]
        : ["MOSSImageHFLoader", "ModelSamplingSD3", "SkipLayerGuidanceDiTSimple"])];
    for (const name of nodes) if (!objectInfo[name]) missing.push(`${name} node is unavailable`);
    if (model === "flux3-klein") {
      for (const [cls, field, value] of [
        ["UNETLoader", "unet_name", CREATIVE_IMAGE_FILES.flux],
        ["CLIPLoader", "clip_name", CREATIVE_IMAGE_FILES.encoder],
        ["CLIPLoader", "clip_name", CREATIVE_IMAGE_FILES.upsampler],
        ["CLIPLoader", "type", "flux3"],
        ["VAELoader", "vae_name", CREATIVE_IMAGE_FILES.vae],
      ]) if (!readEnum(objectInfo[cls], field)?.has(value)) missing.push(`${value} is not available in ${cls}`);
    } else {
      // FrameForge runs on Windows and the model is on the same host's WSL disk.
      // Read both shard indexes and verify every referenced shard before queuing.
      const root = process.platform === "win32"
        ? "\\\\wsl.localhost\\Ubuntu-24.04\\srv\\comfyui\\models\\diffusers\\MOSS-Image-SFT"
        : CREATIVE_IMAGE_FILES.moss;
      try {
        await access(path.join(root, "model_index.json"));
        for (const [dir, index] of [["transformer", "diffusion_pytorch_model.safetensors.index.json"], ["text_encoder", "model.safetensors.index.json"]]) {
          const data = JSON.parse(await readFile(path.join(root, dir, index), "utf8")) as { weight_map: Record<string, string> };
          await Promise.all([...new Set(Object.values(data.weight_map))].map(file => access(path.join(root, dir, file))));
        }
        await access(path.join(root, "vae", "diffusion_pytorch_model.safetensors"));
        await access(path.join(root, "tokenizer", "tokenizer.json"));
      } catch { missing.push("MOSS-Image-SFT local model directory is incomplete or unavailable"); }
    }
    return { ok: missing.length === 0, missing, comfyuiUrl: base };
  }
  const zImageProfile = isZImageProfile(model) ? model : null;
  if (zImageProfile) {
    return getZImagePreflight(base, objectInfo, zImageProfile);
  }

  const fluxProfile = getFluxPreflightProfile(model);
  const modelLoader = objectInfo[fluxProfile.loaderClass];
  const vaeLoader = objectInfo.VAELoader;
  const clipLoader = objectInfo.CLIPLoader;

  if (!modelLoader) {
    missing.push(`${fluxProfile.loaderClass} node is unavailable`);
  } else if (
    !extractComboValues(modelLoader, fluxProfile.fileKey).includes(
      fluxProfile.modelFile,
    )
  ) {
    missing.push(
      `${fluxProfile.modelFile} is not visible to ${fluxProfile.loaderClass}`,
    );
  }

  if (!clipLoader) {
    missing.push("CLIPLoader node is unavailable");
  } else if (
    !extractComboValues(clipLoader, "clip_name").includes(fluxProfile.clipName)
  ) {
    missing.push(`${fluxProfile.clipName} is not visible to CLIPLoader`);
  }

  if (!vaeLoader) {
    missing.push("VAELoader node is unavailable");
  } else if (!extractComboValues(vaeLoader, "vae_name").includes(FLUX_VAE)) {
    missing.push(`${FLUX_VAE} is not visible to VAELoader`);
  }

  return {
    ok: missing.length === 0,
    missing,
    comfyuiUrl: base,
  };
}

function isZImageProfile(model: string | undefined): model is ZImageProfile {
  return (
    model === "z-image-base-amateur-photo-8step" ||
    model === "z-image-turbo-amateur-photo"
  );
}

function getZImagePreflight(
  base: string,
  objectInfo: Record<string, ObjectInfoNode>,
  profileId: ZImageProfile,
): {
  ok: boolean;
  missing: string[];
  comfyuiUrl: string;
} {
  const profile = Z_IMAGE_PREFLIGHT[profileId];
  const missing: string[] = [];
  const unetLoader = objectInfo.UNETLoader;
  const vaeLoader = objectInfo.VAELoader;
  const clipLoader = objectInfo.CLIPLoader;
  const loraLoader = objectInfo.LoraLoader;

  if (!unetLoader) {
    missing.push("UNETLoader node is unavailable");
  } else if (
    !extractComboValues(unetLoader, "unet_name").includes(profile.diffusionModel)
  ) {
    missing.push(`${profile.diffusionModel} is not visible to UNETLoader`);
  }

  if (!clipLoader) {
    missing.push("CLIPLoader node is unavailable");
  } else if (
    !extractComboValues(clipLoader, "clip_name").includes(Z_IMAGE_TEXT_ENCODER)
  ) {
    missing.push(`${Z_IMAGE_TEXT_ENCODER} is not visible to CLIPLoader`);
  }

  if (!vaeLoader) {
    missing.push("VAELoader node is unavailable");
  } else if (!extractComboValues(vaeLoader, "vae_name").includes(Z_IMAGE_VAE)) {
    missing.push(`${Z_IMAGE_VAE} is not visible to VAELoader`);
  }

  if (!loraLoader) {
    missing.push("LoraLoader node is unavailable");
  } else {
    const loraNames = extractComboValues(loraLoader, "lora_name");
    for (const lora of profile.loras) {
      if (!loraNames.includes(lora)) {
        missing.push(`${lora} is not visible to LoraLoader`);
      }
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    comfyuiUrl: base,
  };
}

export async function queueFluxPrompt(
  base: string,
  workflow: Record<string, unknown>,
  clientId: string,
): Promise<FluxPromptResponse> {
  const res = await comfyFetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: workflow,
      client_id: clientId,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flux ComfyUI queue failed (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Upload a base64 data-URL reference image into the target worker ComfyUI's
 * input directory and return the stored filename for LoadImage. The images
 * API receives references as data URLs (the Image Studio contract), but
 * ComfyUI's LoadImage only accepts files already in its input folder.
 */
export async function uploadFluxInputImage(
  base: string,
  dataUrl: string,
): Promise<string> {
  const match = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) {
    throw new Error("Reference image must be a base64 image data URL");
  }
  const [, mime, encoded] = match;
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime.toLowerCase()) || encoded.length > 28 * 1024 * 1024) {
    throw new Error("Reference image must be a PNG, JPEG or WebP up to 20 MB");
  }
  const ext = mime === "image/jpeg" ? "jpg" : mime.slice("image/".length);
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("Reference image exceeds 20 MB");
  const filename = `frameforge-ref-${randomUUID()}.${ext}`;
  const form = new FormData();
  form.append(
    "image",
    new Blob([bytes], { type: mime }),
    filename,
  );
  form.append("overwrite", "false");

  const res = await comfyFetch(`${base}/upload/image`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Flux ComfyUI reference upload failed (${res.status}): ${text}`,
    );
  }
  const data = (await res.json()) as { name?: string; subfolder?: string };
  if (!data.name) {
    throw new Error("Flux ComfyUI reference upload returned no filename");
  }
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export async function getFluxHistory(
  base: string,
  promptId: string,
): Promise<FluxHistoryItem | null> {
  const res = await comfyFetch(`${base}/history/${promptId}`);
  if (!res.ok) return null;
  const data = await res.json();
  return isPrivateHistory(data[promptId]) ? null : data[promptId] || null;
}

export function fluxOutputUrl(
  internalBase: string,
  filename: string,
  subfolder: string,
  worker?: "vidbox",
): string {
  const params = new URLSearchParams({
    filename,
    subfolder,
    type: "output",
  });
  if (worker) params.set("worker", worker);
  return `/api/output?${params}${worker ? "" : "&stills=true"}`;
}

export function extractFluxImageFilename(
  history: FluxHistoryItem,
): { filename: string; subfolder: string } | null {
  for (const nodeOutput of Object.values(history.outputs)) {
    const images = nodeOutput.images;
    if (images && images.length > 0) {
      return {
        filename: images[0].filename,
        subfolder: images[0].subfolder || "",
      };
    }
  }
  return null;
}
