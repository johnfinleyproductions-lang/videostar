// Ming-Image-0.1-Design image lane (inclusionAI: 6B DiT + Ling-mini-2.0 text
// encoder) — design-focused text-to-image: UI mockups, slides, posters,
// infographics, covers, with NATIVE RGBA output (its VAE is 4-channel).
//
// Runs ONLY on Framerstation's ComfyUI >= 0.38 (fleet worker
// "framerstation-ming", env MING_COMFYUI_URL), which Core starts on demand as
// the gpu-flex lane "comfyui-ming". Kept out of flux-client /
// flux-workflow-builder on purpose (the Lens / Revoice pattern): a different
// box, a different ComfyUI version, and a "ming-" job-id prefix so the
// stateless status route finds the box again without any session state.
//
// Recipe (measured 2026-10-03 on Framerstation's RTX PRO 4500: 30-38 s per
// 2K-class image, 16/16 renders clean): bf16 DiT + int8 Ling text encoder
// (CLIPLoader `type` is ignored — ComfyUI detects Ming by its keys),
// ModelSamplingFlux max_shift 1.35 / base_shift 0.5 evaluated at a 1024x1024
// token count (= the reference pipeline's fixed mu 1.35 for every >= 1024
// bucket), EmptyLatentImage, BasicGuider (CFG 1, no negative), euler, simple,
// 12 steps, VAEDecode -> SaveImage (PNG keeps the alpha channel).
// Prompts work best as the reference "Figma-style" JSON caption
// (canvas_settings + layers); plain prose works too. Transparent output is
// requested with ONE fixed phrase at the very start of the prompt.

import { randomUUID } from "node:crypto";
import { comfyFetch } from "./comfy-auth";
import { resolveWorkerForLane, type FleetWorker } from "./fleet";
import { extractFluxImageFilename, getFluxHistory, queueFluxPrompt } from "./flux-client";

export const MING_MODEL_ID = "ming-image-design";
export const MING_LANE = "ming-image";
export const MING_WORKER = "framerstation-ming";
const JOB_PREFIX = "ming-";

export const MING_FILES = {
  unet: "ming_image_0.1_design_bf16.safetensors",
  textEncoder: "ming_image_0.1_ling_mini_2.0_int8_convrot.safetensors",
  vae: "ming_image_vae_bf16.safetensors",
} as const;

/** The reference's transparency trigger: one fixed phrase, at the prompt start. */
export const MING_RGBA_PREFIX = "RGBA, 4-channel, transparent background";

const DEFAULT_SIDE = 2048;
const MIN_SIDE = 512;
const MAX_SIDE = 2560;
/** 1824x2432 (4.43 MP) rendered clean in the 2026-10-03 trial. */
const MAX_AREA = 4_500_000;
const DEFAULT_STEPS = 12;

export function isMingModel(model: unknown): boolean {
  return model === MING_MODEL_ID;
}

export function isMingJobId(id: string): boolean {
  return id.startsWith(JOB_PREFIX) && id.length > JOB_PREFIX.length;
}

/** The enabled Ming worker, or null when MING_COMFYUI_URL is unset. */
export function resolveMingWorker(): FleetWorker | null {
  const [first] = resolveWorkerForLane(MING_LANE);
  return first && first.name === MING_WORKER && first.comfyBase ? first : null;
}

const snap16 = (v: number) => Math.max(16, Math.round(v / 16) * 16);

/**
 * Canvas for a request: 16 px grid (VAE 8 x patch 2), each side clamped to
 * 512..2560, aspect clamped to Ming's 1:4..4:1 range, area capped at ~4.5 MP
 * (scaled down proportionally). Missing sides default to 2048.
 */
export function mingCanvas(width?: unknown, height?: unknown): { width: number; height: number } {
  let w = typeof width === "number" && Number.isFinite(width) && width > 0 ? width : DEFAULT_SIDE;
  let h = typeof height === "number" && Number.isFinite(height) && height > 0 ? height : DEFAULT_SIDE;
  if (w / h > 4) h = w / 4;
  if (h / w > 4) w = h / 4;
  const area = w * h;
  if (area > MAX_AREA) {
    const k = Math.sqrt(MAX_AREA / area);
    w *= k;
    h *= k;
  }
  w = Math.min(MAX_SIDE, Math.max(MIN_SIDE, w));
  h = Math.min(MAX_SIDE, Math.max(MIN_SIDE, h));
  return { width: snap16(w), height: snap16(h) };
}

export interface MingWorkflowParams {
  prompt: string;
  width?: unknown;
  height?: unknown;
  seed?: unknown;
  steps?: unknown;
  transparent?: boolean;
}

export interface MingWorkflow {
  workflow: Record<string, unknown>;
  seed: number;
  width: number;
  height: number;
  steps: number;
}

export function buildMingWorkflow(params: MingWorkflowParams): MingWorkflow {
  const { width, height } = mingCanvas(params.width, params.height);
  const seed =
    typeof params.seed === "number" && Number.isInteger(params.seed) && params.seed >= 0
      ? params.seed
      : Math.floor(Math.random() * 2_147_483_647);
  const steps =
    typeof params.steps === "number" && Number.isFinite(params.steps)
      ? Math.min(30, Math.max(4, Math.round(params.steps)))
      : DEFAULT_STEPS;
  const body = params.prompt.trim();
  const text = params.transparent ? `${MING_RGBA_PREFIX}\n${body}` : body;
  const workflow: Record<string, unknown> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: MING_FILES.unet, weight_dtype: "default" } },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: MING_FILES.textEncoder, type: "qwen_image", device: "default" },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: MING_FILES.vae } },
    "4": { class_type: "CLIPTextEncode", inputs: { text, clip: ["2", 0] } },
    "5": {
      class_type: "ModelSamplingFlux",
      // 1024x1024 token count on purpose: it pins mu at max_shift (1.35), the
      // reference value for every >= 1024 bucket, independent of the canvas.
      inputs: { model: ["1", 0], max_shift: 1.35, base_shift: 0.5, width: 1024, height: 1024 },
    },
    "6": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "7": { class_type: "BasicGuider", inputs: { model: ["5", 0], conditioning: ["4", 0] } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "9": {
      class_type: "BasicScheduler",
      inputs: { model: ["5", 0], scheduler: "simple", steps, denoise: 1.0 },
    },
    "10": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "11": {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: ["10", 0], guider: ["7", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["6", 0] },
    },
    "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["3", 0] } },
    "13": { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: "FrameForge/ming" } },
  };
  return { workflow, seed, width, height, steps };
}

type ObjectInfo = Record<string, { input?: { required?: Record<string, unknown[]> } }>;

/** Combo options from object_info, in either the legacy or the COMBO schema. */
function comboOptions(info: ObjectInfo | null, node: string, input: string): string[] {
  const spec = info?.[node]?.input?.required?.[input];
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].filter((v): v is string => typeof v === "string");
  const opts = (spec[1] as { options?: unknown } | undefined)?.options;
  return Array.isArray(opts) ? opts.filter((v): v is string => typeof v === "string") : [];
}

export interface MingPreflight {
  ok: boolean;
  missing: string[];
  comfyuiUrl: string | null;
  hint?: string;
}

export async function getMingPreflight(): Promise<MingPreflight> {
  const worker = resolveMingWorker();
  if (!worker) {
    return {
      ok: false,
      missing: ["MING_COMFYUI_URL (the framerstation-ming worker is not configured)"],
      comfyuiUrl: null,
    };
  }
  const base = worker.comfyBase as string;
  const fetchInfo = async (node: string): Promise<ObjectInfo | null> => {
    const res = await comfyFetch(`${base}/object_info/${node}`, { signal: AbortSignal.timeout(5_000) });
    return res.ok ? ((await res.json()) as ObjectInfo) : null;
  };
  try {
    const [unet, clip, vae] = await Promise.all([fetchInfo("UNETLoader"), fetchInfo("CLIPLoader"), fetchInfo("VAELoader")]);
    const missing: string[] = [];
    if (!comboOptions(unet, "UNETLoader", "unet_name").includes(MING_FILES.unet)) missing.push(`diffusion_models/${MING_FILES.unet}`);
    if (!comboOptions(clip, "CLIPLoader", "clip_name").includes(MING_FILES.textEncoder)) missing.push(`text_encoders/${MING_FILES.textEncoder}`);
    if (!comboOptions(vae, "VAELoader", "vae_name").includes(MING_FILES.vae)) missing.push(`vae/${MING_FILES.vae}`);
    return { ok: missing.length === 0, missing, comfyuiUrl: base };
  } catch {
    return {
      ok: false,
      missing: ["the Framerstation comfyui-ming lane is not running"],
      comfyuiUrl: base,
      hint: worker.restartHint,
    };
  }
}

export interface MingQueued {
  jobId: string;
  seed: number;
  width: number;
  height: number;
}

export async function queueMingPrompt(params: MingWorkflowParams): Promise<MingQueued> {
  const worker = resolveMingWorker();
  if (!worker) throw new Error("MING_COMFYUI_URL is not set — the framerstation-ming worker is disabled");
  const built = buildMingWorkflow(params);
  const res = await queueFluxPrompt(worker.comfyBase as string, built.workflow, randomUUID());
  return { jobId: `${JOB_PREFIX}${res.prompt_id}`, seed: built.seed, width: built.width, height: built.height };
}

export interface MingJobStatus {
  id: string;
  status: "processing" | "completed" | "failed";
  url?: string;
  filename?: string;
  provider?: "comfyui";
  error?: string;
}

export async function getMingJobStatus(id: string): Promise<MingJobStatus> {
  const worker = resolveMingWorker();
  if (!worker) return { id, status: "failed", error: "The framerstation-ming worker is not configured (MING_COMFYUI_URL)" };
  const history = await getFluxHistory(worker.comfyBase as string, id.slice(JOB_PREFIX.length));
  if (!history) return { id, status: "processing" };
  if (history.status.completed) {
    const output = extractFluxImageFilename(history);
    if (!output) return { id, status: "failed", error: "No output image found" };
    const query = new URLSearchParams({
      filename: output.filename,
      subfolder: output.subfolder,
      type: "output",
      worker: MING_WORKER,
    });
    // /api/output streams it from the worker that rendered it (?worker=).
    return { id, status: "completed", url: `/api/output?${query}`, filename: output.filename, provider: "comfyui" };
  }
  if (history.status.status_str === "error") return { id, status: "failed", error: "ComfyUI workflow error" };
  return { id, status: "processing" };
}
