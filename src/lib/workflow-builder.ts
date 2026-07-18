// FrameForge - ComfyUI Workflow JSON Builder
// Two lanes:
//   1. LTX-Video 2.3 (programmatic graph, repaired two-stage distilled recipe)
//   2. Wan 2.2 I2V / FLF2V (template lane: load an API-format workflow JSON
//      from src/workflows/ and patch nodes by their _meta.title)

import fs from "node:fs";
import path from "node:path";
import type {
  AceStepBuildParams,
  ComfyWorkflow,
  ComfyWorkflowNode,
  FoleyBuildParams,
  FrameGridFamily,
  GenerateRequest,
  Hv15BuildParams,
  LtxLipsyncBuildParams,
  LtxTemplateBuildParams,
  MatAnyoneBuildParams,
  VaceInpaintBuildParams,
  VaceRefBuildParams,
  WanAlphaBuildParams,
  WanI2VBuildParams,
} from "./types";
import { durationToFrames, getVideoModelProfile } from "./models";

// ---------------------------------------------------------------------------
// Negative prompts
// ---------------------------------------------------------------------------

/**
 * Canonical Wan 2.2 negative prompt (verbatim, Chinese — this is what the
 * model was trained against; do not translate or "improve" it).
 */
export const WAN_NEGATIVE_PROMPT =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

/** Real negative prompt for the LTX lane (replaces the old junk placeholder). */
export const LTX_NEGATIVE_PROMPT =
  "worst quality, low quality, blurry, out of focus, jpeg artifacts, " +
  "oversaturated, overexposed, washed out, grayish, static, motionless, " +
  "frozen frame, still image, subtitles, captions, text, watermark, logo, " +
  "deformed, disfigured, malformed limbs, fused fingers, extra fingers, " +
  "poorly drawn hands, poorly drawn face, extra limbs, cluttered background, " +
  "crowded background, walking backwards";

// Kept as the internal name used by the LTX builder below.
const NEGATIVE_PROMPT = LTX_NEGATIVE_PROMPT;

type WorkflowNode = ComfyWorkflowNode;
type Workflow = ComfyWorkflow;

// ---------------------------------------------------------------------------
// Frame-grid helpers
// ---------------------------------------------------------------------------

const FRAME_GRID: Record<FrameGridFamily, number> = {
  wan: 4, // Wan 2.2 latents pack 4 frames -> legal counts are 4n+1
  ltx: 8, // LTX-Video packs 8 frames    -> legal counts are 8n+1
  hv: 4, // HunyuanVideo 1.5 packs 4 frames -> legal counts are 4n+1
  //     (EmptyHunyuanVideo15Latent length step 4, verified live object_info)
};

/**
 * Snap a frame count to the nearest legal value for the model family:
 * 4n+1 for Wan, 8n+1 for LTX. Always returns at least one full grid step + 1.
 */
export function validateFrameGrid(
  frames: number,
  family: FrameGridFamily,
): number {
  const grid = FRAME_GRID[family];
  if (!Number.isFinite(frames)) return grid + 1;
  const n = Math.max(1, Math.round((frames - 1) / grid));
  return grid * n + 1;
}

/** Duration (seconds) + fps -> legal frame count on the family's grid. */
export function durationToLegalFrames(
  seconds: number,
  fps: number,
  family: FrameGridFamily,
): number {
  return validateFrameGrid(durationToFrames(seconds, fps), family);
}

// ---------------------------------------------------------------------------
// Template lane (Wan 2.2)
// ---------------------------------------------------------------------------

/** Thrown when a workflow template file cannot be found/parsed. */
export class TemplateLoadError extends Error {
  readonly attemptedPaths: string[];
  constructor(file: string, attemptedPaths: string[], cause?: unknown) {
    super(
      `Workflow template "${file}" could not be loaded. Tried: ${attemptedPaths.join(", ")}` +
        (cause instanceof Error ? ` (${cause.message})` : ""),
    );
    this.name = "TemplateLoadError";
    this.attemptedPaths = attemptedPaths;
  }
}

/** Thrown when required node titles are absent from a workflow template. */
export class MissingTemplateTitlesError extends Error {
  readonly missingTitles: string[];
  constructor(missingTitles: string[]) {
    super(
      `Workflow template is missing required node title(s): ${missingTitles.join(", ")}`,
    );
    this.name = "MissingTemplateTitlesError";
    this.missingTitles = missingTitles;
  }
}

/**
 * Node titles the Wan templates must carry (set as the node title in the
 * ComfyUI editor before exporting in API format — it lands in _meta.title).
 */
export const WAN_TEMPLATE_TITLES = {
  positive: "FF Positive",
  negative: "FF Negative",
  startImage: "FF Start Image",
  endImage: "FF End Image",
  video: "FF Wan Video",
  /** Fun-camera lane only: WanCameraEmbedding node (camera_pose preset). */
  camera: "FF Camera",
  samplerStage1: "FF Sampler S1",
  samplerStage2: "FF Sampler S2",
  samplerStage3: "FF Sampler S3",
  output: "FF Output",
} as const;

// ---------------------------------------------------------------------------
// Camera-move resolution (Wan 2.2 fun-camera lane)
// ---------------------------------------------------------------------------

/**
 * The WanCameraEmbedding camera_pose enum, verbatim from the live ComfyUI
 * object_info (192.168.4.196:8188, verified 2026-07-14). Note the rotation
 * values are the FULL strings — "Anti Clockwise (ACW)" / "ClockWise (CW)",
 * not bare "ACW"/"CW".
 */
export const WAN_CAMERA_POSES = [
  "Static",
  "Pan Up",
  "Pan Down",
  "Pan Left",
  "Pan Right",
  "Zoom In",
  "Zoom Out",
  "Anti Clockwise (ACW)",
  "ClockWise (CW)",
] as const;

export type WanCameraPose = (typeof WAN_CAMERA_POSES)[number];

export const DEFAULT_CAMERA_POSE: WanCameraPose = "Zoom In";

/** Friendly-synonym map (keys are normalized: lowercase, alphanumeric+spaces). */
const CAMERA_POSE_SYNONYMS: Record<string, WanCameraPose> = {
  // Enum values normalize to themselves below; extra friendly names:
  "push in": "Zoom In",
  "push": "Zoom In",
  "dolly in": "Zoom In",
  "zoom": "Zoom In",
  "pull back": "Zoom Out",
  "pull out": "Zoom Out",
  "dolly out": "Zoom Out",
  "orbit": "ClockWise (CW)",
  "orbit right": "ClockWise (CW)",
  "rotate right": "ClockWise (CW)",
  "clockwise": "ClockWise (CW)",
  "cw": "ClockWise (CW)",
  "orbit left": "Anti Clockwise (ACW)",
  "rotate left": "Anti Clockwise (ACW)",
  "anticlockwise": "Anti Clockwise (ACW)",
  "anti clockwise": "Anti Clockwise (ACW)",
  "counterclockwise": "Anti Clockwise (ACW)",
  "counter clockwise": "Anti Clockwise (ACW)",
  "ccw": "Anti Clockwise (ACW)",
  "acw": "Anti Clockwise (ACW)",
  "none": "Static",
  "locked": "Static",
  "still": "Static",
  "tilt up": "Pan Up",
  "tilt down": "Pan Down",
};

function normalizeCameraKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const CAMERA_POSE_LOOKUP: ReadonlyMap<string, WanCameraPose> = new Map([
  // Exact enum values (case/punctuation-insensitive), e.g. "pan left",
  // "anti clockwise acw", "clockwise cw".
  ...WAN_CAMERA_POSES.map(
    (pose) => [normalizeCameraKey(pose), pose] as const,
  ),
  ...Object.entries(CAMERA_POSE_SYNONYMS).map(
    ([key, pose]) => [normalizeCameraKey(key), pose] as const,
  ),
]);

/**
 * Resolve a friendly camera-move string ("push in", "orbit left", "Pan Up",
 * "cw", …) to a valid WanCameraEmbedding camera_pose enum value. Unknown or
 * missing values fall back to DEFAULT_CAMERA_POSE ("Zoom In") — the fun-camera
 * lane always moves; "Static" must be asked for explicitly.
 */
export function resolveCameraPose(move?: string): WanCameraPose {
  if (!move || !move.trim()) return DEFAULT_CAMERA_POSE;
  return CAMERA_POSE_LOOKUP.get(normalizeCameraKey(move)) ?? DEFAULT_CAMERA_POSE;
}

/**
 * Load an API-format workflow template JSON by filename.
 *
 * Search order (first hit wins):
 *   1. <cwd>/src/workflows/<file>   — dev server / plain `next start`
 *   2. <cwd>/workflows/<file>       — Next standalone output (copy the folder
 *      next to server.js, or add it to next.config outputFileTracingIncludes)
 */
export function loadTemplate(file: string): ComfyWorkflow {
  // Never allow the filename to escape the workflows directories.
  const safe = path.basename(file);
  const candidates = [
    path.join(process.cwd(), "src", "workflows", safe),
    path.join(process.cwd(), "workflows", safe),
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("template is not an API-format workflow object");
      }
      return parsed as ComfyWorkflow;
    } catch (error) {
      lastError = error;
      // fall through to the next candidate
    }
  }
  throw new TemplateLoadError(safe, candidates, lastError);
}

function findNodeByTitle(
  workflow: ComfyWorkflow,
  title: string,
): { id: string; node: WorkflowNode } | null {
  for (const [id, node] of Object.entries(workflow)) {
    if (node && node._meta?.title === title) return { id, node };
  }
  return null;
}

/**
 * Find the node with the given _meta.title.
 * Throws MissingTemplateTitlesError (listing the missing title) if absent.
 */
export function patchByTitle(
  workflow: ComfyWorkflow,
  title: string,
): { id: string; node: WorkflowNode } {
  const hit = findNodeByTitle(workflow, title);
  if (!hit) throw new MissingTemplateTitlesError([title]);
  return hit;
}

/**
 * Apply `inputs` patches keyed by node title. Collects ALL missing titles and
 * throws a single MissingTemplateTitlesError so template bugs surface at once.
 */
function applyTitlePatches(
  workflow: ComfyWorkflow,
  patches: Record<string, Record<string, unknown>>,
): void {
  const missing: string[] = [];
  for (const [title, inputPatch] of Object.entries(patches)) {
    const hit = findNodeByTitle(workflow, title);
    if (!hit) {
      missing.push(title);
      continue;
    }
    Object.assign(hit.node.inputs, inputPatch);
  }
  if (missing.length > 0) throw new MissingTemplateTitlesError(missing);
}

/**
 * Build a Wan 2.2 I2V (or FLF2V / fun-camera) prompt graph by patching a
 * loaded template. The sampler chain / cfg / steps / LoRA wiring are
 * template-locked and never touched here — only prompt text, images, frame
 * length, camera pose, and seed are patched.
 *
 * Size/length patch target: when the template carries an "FF Camera" node
 * (WanCameraEmbedding, fun-camera lane) the width/height/length live THERE —
 * "FF Wan Video" (WanCameraImageToVideo) receives them via links from the
 * camera node and must NOT be patched, or the camera trajectory length would
 * desync from the latent. Plain I2V/FLF2V templates have no camera node and
 * are patched on "FF Wan Video" exactly as before.
 *
 * Samplers: S1 is required (it adds the noise). S2/S3 are patched when
 * present — the 3-sampler distill recipe has all three, the fun-camera recipe
 * has only S1+S2. Seeds are kept in lockstep for reproducibility.
 */
export function buildWanI2V(params: WanI2VBuildParams): {
  prompt: ComfyWorkflow;
  extra_data: {
    seed: number;
    length: number;
    width?: number;
    height?: number;
  };
} {
  const {
    template,
    prompt,
    negative,
    imageName,
    endImageName,
    cameraMove,
    length,
    seed,
    width,
    height,
  } = params;

  if (!imageName) {
    throw new Error("buildWanI2V requires imageName (Wan 2.2 is I2V-only)");
  }

  // Deep-clone so the cached/loaded template is never mutated.
  const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

  const legalLength = validateFrameGrid(length, "wan");
  const sizePatch: Record<string, unknown> = { length: legalLength };
  if (typeof width === "number" && width > 0) sizePatch.width = width;
  if (typeof height === "number" && height > 0) sizePatch.height = height;

  const seedPatch = { noise_seed: seed };

  // Fun-camera templates: size/length (and the camera pose) go on FF Camera.
  const cameraNode = findNodeByTitle(workflow, WAN_TEMPLATE_TITLES.camera);
  const sizeTarget = cameraNode
    ? WAN_TEMPLATE_TITLES.camera
    : WAN_TEMPLATE_TITLES.video;
  if (cameraNode) {
    sizePatch.camera_pose = resolveCameraPose(cameraMove);
  }

  applyTitlePatches(workflow, {
    [WAN_TEMPLATE_TITLES.positive]: { text: prompt },
    [WAN_TEMPLATE_TITLES.negative]: {
      text: negative && negative.trim() ? negative : WAN_NEGATIVE_PROMPT,
    },
    [WAN_TEMPLATE_TITLES.startImage]: { image: imageName },
    [sizeTarget]: sizePatch,
    [WAN_TEMPLATE_TITLES.samplerStage1]: seedPatch,
  });

  // Only S1 adds noise, but keep later-stage seeds in lockstep for
  // reproducibility if a template is ever re-staged. Optional: the fun-camera
  // recipe is 2-sampler (no S3); template completeness is enforced per-file
  // by src/workflows/validate-templates.mjs.
  for (const title of [
    WAN_TEMPLATE_TITLES.samplerStage2,
    WAN_TEMPLATE_TITLES.samplerStage3,
  ]) {
    const sampler = findNodeByTitle(workflow, title);
    if (sampler) Object.assign(sampler.node.inputs, seedPatch);
  }

  const endImageNode = findNodeByTitle(workflow, WAN_TEMPLATE_TITLES.endImage);
  if (endImageName) {
    if (!endImageNode) {
      throw new MissingTemplateTitlesError([WAN_TEMPLATE_TITLES.endImage]);
    }
    endImageNode.node.inputs.image = endImageName;
  } else if (endImageNode) {
    throw new Error(
      "This template requires an end image (FLF2V) but no endImageName was provided",
    );
  }

  return {
    prompt: workflow,
    extra_data: { seed, length: legalLength, width, height },
  };
}

// ---------------------------------------------------------------------------
// Wan 2.2 Fun VACE template lane (reference-to-video + footage editing)
// ---------------------------------------------------------------------------

/**
 * Node titles the VACE templates must carry (validated by
 * src/workflows/validate-templates.mjs for vace_ref.json /
 * vace_ref_draft.json / vace_inpaint.json).
 */
export const VACE_TEMPLATE_TITLES = {
  positive: "FF Positive",
  negative: "FF Negative",
  /** ref templates only: LoadImage — the IDENTITY reference, not a start frame. */
  referenceImage: "FF Reference Image",
  /** inpaint template only: VHS_LoadVideo — the footage to edit. */
  controlVideo: "FF Control Video",
  /** inpaint template only: VHS_LoadVideo mask video (white = regenerate). */
  controlMask: "FF Control Mask",
  /** inpaint template only: ImageToMask bridge (rewired for still-image masks). */
  maskConvert: "MASK_CONVERT",
  /** WanVaceToVideo — width/height/length live here. */
  video: "FF Wan Video",
  samplerStage1: "FF Sampler S1",
  samplerStage2: "FF Sampler S2",
  output: "FF Output",
} as const;

/** Still-image mask extensions (drive the LoadImage+RepeatImageBatch swap). */
export const VACE_IMAGE_MASK_RE = /\.(png|jpe?g|webp|bmp)(\s+\[(?:input|output|temp)\])?$/i;

/**
 * Shared size/seed patching for both VACE builders. WanVaceToVideo requires
 * width/height on a 16px grid (live schema: step 16) and length on the Wan
 * 4n+1 grid (step 4 from min 1). Seeds go on BOTH KSamplerAdvanced experts
 * in lockstep (only S1 adds noise; S2 is kept aligned for reproducibility,
 * matching the fun-camera lane).
 */
function applyVaceCommonPatches(
  workflow: ComfyWorkflow,
  params: {
    prompt: string;
    negative?: string;
    length: number;
    seed: number;
    width?: number;
    height?: number;
  },
): { legalLength: number; width?: number; height?: number } {
  const legalLength = validateFrameGrid(params.length, "wan");
  const sizePatch: Record<string, unknown> = { length: legalLength };
  if (typeof params.width === "number" && params.width > 0) {
    sizePatch.width = snapToLatentGrid(params.width);
  }
  if (typeof params.height === "number" && params.height > 0) {
    sizePatch.height = snapToLatentGrid(params.height);
  }

  applyTitlePatches(workflow, {
    [VACE_TEMPLATE_TITLES.positive]: { text: params.prompt },
    [VACE_TEMPLATE_TITLES.negative]: {
      text:
        params.negative && params.negative.trim()
          ? params.negative
          : WAN_NEGATIVE_PROMPT,
    },
    [VACE_TEMPLATE_TITLES.video]: sizePatch,
    [VACE_TEMPLATE_TITLES.samplerStage1]: { noise_seed: params.seed },
    [VACE_TEMPLATE_TITLES.samplerStage2]: { noise_seed: params.seed },
  });

  return {
    legalLength,
    width: sizePatch.width as number | undefined,
    height: sizePatch.height as number | undefined,
  };
}

/**
 * Build a Wan 2.2 Fun VACE REFERENCE-TO-VIDEO graph by patching the
 * vace_ref.json / vace_ref_draft.json template. The mechanism is
 * template-locked: WanVaceToVideo receives reference_image ONLY (no
 * control_video/control_masks → the noise mask defaults to all-ones =
 * generate everything), so the prompt drives a NEW scene while the encoded
 * reference latent — prepended to the sequence and trimmed after sampling by
 * TrimVideoLatent via the trim_latent link — pins the subject's identity.
 * (The official Comfy-Org ref2v template ADDITIONALLY pins the reference as
 * frame 1 via a constructed control video; deliberately omitted — that is
 * the i2v flavor, and this lane exists for recurring hosts in new scenes.)
 * The 2-expert recipe (shift 8, 20 steps cfg 3.5 / draft 4 steps cfg 1 with
 * the lightx2v 4-step LoRA pair) is template-locked. Only prompt text,
 * reference image, size/length, and seed are patched here.
 */
export function buildVaceRef(params: VaceRefBuildParams): {
  prompt: ComfyWorkflow;
  extra_data: {
    seed: number;
    length: number;
    width?: number;
    height?: number;
  };
} {
  const { template, referenceImageName, seed } = params;

  if (!referenceImageName) {
    throw new Error(
      "buildVaceRef requires referenceImageName (the identity reference)",
    );
  }

  // Deep-clone so the cached/loaded template is never mutated.
  const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

  const { legalLength, width, height } = applyVaceCommonPatches(
    workflow,
    params,
  );
  applyTitlePatches(workflow, {
    [VACE_TEMPLATE_TITLES.referenceImage]: { image: referenceImageName },
  });

  return {
    prompt: workflow,
    extra_data: { seed, length: legalLength, width, height },
  };
}

/**
 * Build a Wan 2.2 Fun VACE FOOTAGE-EDITING graph (inpaint/outpaint) by
 * patching the vace_inpaint.json template. Mechanism (template-locked):
 * "FF Control Video" (VHS_LoadVideo, force_rate 16 → input resampled to
 * Wan-native 16fps with wall-clock duration preserved) feeds
 * WanVaceToVideo.control_video, and "FF Control Mask" → ImageToMask(red)
 * feeds control_masks — WHITE = regenerate, BLACK = keep. WanVaceToVideo
 * upscales both to width/height internally and pads/truncates to length, so
 * no manual resize stage is needed. frame_load_cap is patched to the legal
 * length on both loaders so we never decode more frames than the job uses.
 *
 * Mask flexibility: a mask VIDEO is patched straight onto the VHS_LoadVideo
 * node. A STILL-IMAGE mask (maskIsImage) needs surgery, because a 1-frame
 * mask would be padded with ONES by WanVaceToVideo (frames 2..N fully
 * regenerated, ignoring the footage): the "FF Control Mask" node is swapped
 * to LoadImage and a RepeatImageBatch(length) node is inserted before
 * MASK_CONVERT so the mask covers every frame.
 */
export function buildVaceInpaint(params: VaceInpaintBuildParams): {
  prompt: ComfyWorkflow;
  extra_data: {
    seed: number;
    length: number;
    width?: number;
    height?: number;
  };
} {
  const { template, videoName, maskName, maskIsImage, seed } = params;

  if (!videoName) {
    throw new Error("buildVaceInpaint requires videoName (the footage to edit)");
  }
  if (!maskName) {
    throw new Error("buildVaceInpaint requires maskName (the edit mask)");
  }

  // Deep-clone so the cached/loaded template is never mutated.
  const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

  const { legalLength, width, height } = applyVaceCommonPatches(
    workflow,
    params,
  );

  applyTitlePatches(workflow, {
    [VACE_TEMPLATE_TITLES.controlVideo]: {
      video: videoName,
      frame_load_cap: legalLength,
    },
  });

  const maskNode = patchByTitle(workflow, VACE_TEMPLATE_TITLES.controlMask);
  if (maskIsImage) {
    // Still-image mask surgery (see docstring). RepeatImageBatch gets a fresh
    // id that cannot collide with the template's numeric ids.
    const convert = patchByTitle(workflow, VACE_TEMPLATE_TITLES.maskConvert);
    maskNode.node.class_type = "LoadImage";
    maskNode.node.inputs = { image: maskName };
    const repeatId = "vace_mask_repeat";
    workflow[repeatId] = {
      class_type: "RepeatImageBatch",
      inputs: { image: [maskNode.id, 0], amount: legalLength },
      _meta: { title: "MASK_REPEAT" },
    };
    convert.node.inputs.image = [repeatId, 0];
  } else {
    Object.assign(maskNode.node.inputs, {
      video: maskName,
      frame_load_cap: legalLength,
    });
  }

  return {
    prompt: workflow,
    extra_data: { seed, length: legalLength, width, height },
  };
}

// ---------------------------------------------------------------------------
// Wan-Alpha template lane (RGBA transparent elements)
// ---------------------------------------------------------------------------

/**
 * Node titles the Wan-Alpha template must carry (validated by
 * src/workflows/validate-templates.mjs for wan_alpha.json).
 */
export const WAN_ALPHA_TEMPLATE_TITLES = {
  positive: "FF Positive",
  negative: "FF Negative",
  /** EmptyHunyuanLatentVideo (the Wan 2.1 T2V latent) — width/height/length. */
  video: "FF Wan Video",
  /** Stock KSampler — seed input is `seed` (NOT `noise_seed`). */
  sampler: "FF Sampler S1",
  output: "FF Output",
} as const;

/** EmptyHunyuanLatentVideo requires width/height on a 16px grid. */
function snapToLatentGrid(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16);
}

/**
 * Build a Wan-Alpha RGBA element graph by patching the wan_alpha.json
 * template. The RGBA mechanism, sampler recipe (24 steps, cfg 5, uni_pc /
 * simple, shift 8 — UNDISTILLED, no Wan 2.1 T2V distill LoRA on disk), LoRA
 * wiring, dual VAE decode (one latent → RGB VAE decode + alpha VAE decode →
 * ImageToMask → InvertMask → JoinImageWithAlpha), and the VP9 webm/yuva420p
 * output are all template-locked. Only prompt text, frame length, size, and
 * seed are patched here.
 *
 * The InvertMask stage is load-bearing: core JoinImageWithAlpha computes
 * `alpha = 1.0 - mask` (the inverse-mask convention of SplitImageWithAlpha),
 * so feeding the alpha decode straight in would invert transparency.
 */
export function buildWanAlpha(params: WanAlphaBuildParams): {
  prompt: ComfyWorkflow;
  extra_data: {
    seed: number;
    length: number;
    width?: number;
    height?: number;
  };
} {
  const { template, prompt, negative, length, seed, width, height } = params;

  // Deep-clone so the cached/loaded template is never mutated.
  const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

  const legalLength = validateFrameGrid(length, "wan");
  const sizePatch: Record<string, unknown> = { length: legalLength };
  if (typeof width === "number" && width > 0) {
    sizePatch.width = snapToLatentGrid(width);
  }
  if (typeof height === "number" && height > 0) {
    sizePatch.height = snapToLatentGrid(height);
  }

  applyTitlePatches(workflow, {
    [WAN_ALPHA_TEMPLATE_TITLES.positive]: { text: prompt },
    [WAN_ALPHA_TEMPLATE_TITLES.negative]: {
      text: negative && negative.trim() ? negative : WAN_NEGATIVE_PROMPT,
    },
    [WAN_ALPHA_TEMPLATE_TITLES.video]: sizePatch,
    // Stock KSampler (adds its own noise): the seed input is `seed`.
    [WAN_ALPHA_TEMPLATE_TITLES.sampler]: { seed },
  });

  return {
    prompt: workflow,
    extra_data: {
      seed,
      length: legalLength,
      width: sizePatch.width as number | undefined,
      height: sizePatch.height as number | undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// MatAnyone MATTE template lane (real-footage keying → alpha webm)
// ---------------------------------------------------------------------------

/**
 * Node titles the MATTE template must carry (validated by
 * src/workflows/validate-templates.mjs for matanyone.json).
 */
export const MATTE_TEMPLATE_TITLES = {
  /** VHS_LoadVideo — the footage to matte (force_rate 0 = source fps). */
  load: "FF Load",
  /** VHS_VideoInfoLoaded — output 0 (fps) is link-wired into FF Output. */
  videoInfo: "FF Video Info",
  /** LoadImage — the user-supplied first-frame seed mask (white = subject). */
  mask: "FF Mask",
  /** MatAnyone2 — matte propagation (output 0 = matte, white = subject). */
  matanyone: "FF MatAnyone",
  join: "FF RGBA Join",
  output: "FF Output",
} as const;

/**
 * Titles of the nodes buildMatAnyone ADDS when no seed mask is supplied
 * (auto person/subject masking). These must NOT exist in matanyone.json —
 * the validator forbids them so the builder-added nodes can never collide
 * with template nodes.
 */
export const MATTE_AUTO_TITLES = {
  /** ImageFromBatch (core) — plucks loaded frame 0 (matches mask_frame 0). */
  firstFrame: "FF First Frame",
  /** BiRefNetRMBG (1038lab/ComfyUI-RMBG) — MASK output 1 seeds MatAnyone2. */
  autoMask: "FF Auto Mask",
} as const;

/**
 * BiRefNetRMBG model enum value for the auto seed mask (live object_info
 * 2026-07-15: BiRefNet-general / _512x512 / -HR / -portrait / -matting /
 * -HR-matting / _lite / _lite-2K / _dynamic / _lite-matting / _toonout).
 * "BiRefNet-general" (DIS salient-subject) is the pick: the lane's subject
 * may be a person OR a product, and general handles both — "BiRefNet-portrait"
 * is head/torso-tuned and fails on non-person subjects. Same size either way
 * (884.9 MB). Weights AUTO-DOWNLOAD on first use via hf_hub_download from
 * HF repo 1038lab/BiRefNet into ComfyUI/models/RMBG/BiRefNet/ (verified in
 * the installed pack's py/AILab_BiRefNet.py MODEL_CONFIG) — the first
 * auto-matte run pays a one-time ~885 MB download. MIT-licensed weights
 * (the sibling RMBG node's RMBG-2.0 is BRIA non-commercial — avoided).
 */
export const MATTE_AUTO_MASK_MODEL = "BiRefNet-general";

/**
 * Defensive length cap for the MATTE lane: MatAnyone2 walks every frame
 * through the propagation network (plus a two-direction pass when mask_frame
 * is mid-clip), so unbounded inputs are a wall-clock/VRAM hazard. 30 s covers
 * every realistic presenter/subject clip in the portfolio; longer footage
 * should be cut first (the route answers 400 with this guidance).
 */
export const MATTE_MAX_SECONDS = 30;
/**
 * LAST-RESORT assumed fps for the frame cap + history metadata. The generate
 * route now header-probes the source (src/lib/video-probe.ts) and sizes the
 * cap with the REAL fps; this fallback only applies when neither an explicit
 * fps nor a probe result is available (tail-moov/no-faststart head, fetch
 * failure) — in that case a 60 fps source still gets ~15 s, documented on
 * the lane's fps extraParam.
 */
export const MATTE_FALLBACK_FPS = 30;
/** VHS_LoadVideo force_rate is schema-capped at 60 (live object_info). */
export const MATTE_MAX_FPS = 60;

/** duration/fps → VHS frame_load_cap (frames AFTER force_rate resampling). */
export function matteFrameCap(seconds: number, fps?: number): number {
  const s = Math.min(
    Number.isFinite(seconds) && seconds > 0 ? seconds : MATTE_MAX_SECONDS,
    MATTE_MAX_SECONDS,
  );
  return Math.max(1, Math.ceil(s * (fps ?? MATTE_FALLBACK_FPS)));
}

/**
 * Build a MatAnyone MATTE graph (real footage + optional first-frame seed
 * mask → transparent-background VP9 webm) by patching the matanyone.json
 * template. A TRANSFORM lane: no prompt, no sampler, no seed. The keying
 * mechanism is template-locked — VHS_LoadVideo → MatAnyone2(foreground_mask
 * = the seed LoadImage, warmup regenerates then propagates) → matte(0,
 * white=subject) → ImageToMask(red) → InvertMask (load-bearing:
 * JoinImageWithAlpha computes alpha = 1 - mask, the same polarity discovery
 * wan_alpha.json ships) → JoinImageWithAlpha over the ORIGINAL frames →
 * VHS_VideoCombine video/webm + yuva420p with the source audio muxed
 * through (libvorbis).
 *
 * Auto seed mask (maskName OMITTED): the "FF Mask" LoadImage branch is
 * swapped builder-side for ImageFromBatch(FF Load frames, batch_index 0 —
 * the SAME frame mask_frame 0 seeds) → BiRefNetRMBG(BiRefNet-general) whose
 * MASK output (index 1, white = subject — matte polarity matches) wires into
 * MatAnyone2's optional foreground_MASK input (MASK-typed twin of
 * foreground_mask; live object_info 2026-07-15) — no ImageToMask bridge
 * needed and no second template. One graph, two mask branches, both ending
 * at the same MatAnyone2 warmup.
 *
 * fps handling (decided + documented): by default force_rate stays 0 and the
 * output frame_rate stays LINK-WIRED from "FF Video Info" fps — the source
 * rate is preserved end-to-end with no server-side probe (the pack's own
 * example workflow ships this exact wiring). An explicit fps (1..60) patches
 * BOTH force_rate and frame_rate so the clip is resampled coherently
 * (wall-clock duration preserved; audio unchanged, so sync holds).
 */
export function buildMatAnyone(params: MatAnyoneBuildParams): {
  prompt: ComfyWorkflow;
  extra_data: { frameCap: number; fps?: number; autoMask: boolean };
} {
  const { template, videoName, maskName, fps, frameCap } = params;

  if (!videoName) {
    throw new Error("buildMatAnyone requires videoName (the footage to matte)");
  }
  if (fps !== undefined && (!Number.isFinite(fps) || fps < 1 || fps > MATTE_MAX_FPS)) {
    throw new Error(
      `buildMatAnyone: fps must be 1..${MATTE_MAX_FPS} (VHS force_rate range), got ${fps}`,
    );
  }
  if (!Number.isInteger(frameCap) || frameCap < 1) {
    throw new Error(`buildMatAnyone: bad frameCap ${frameCap}`);
  }

  // Deep-clone so the cached/loaded template is never mutated.
  const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

  applyTitlePatches(workflow, {
    [MATTE_TEMPLATE_TITLES.load]: {
      video: videoName,
      frame_load_cap: frameCap,
      // 0 = preserve source fps; an explicit fps resamples the input.
      force_rate: fps ?? 0,
    },
  });

  if (maskName) {
    // Manual branch (today's path): the user's still image seeds the matte.
    applyTitlePatches(workflow, {
      [MATTE_TEMPLATE_TITLES.mask]: { image: maskName },
    });
  } else {
    // Auto branch: swap the LoadImage seed for a first-frame BiRefNet mask.
    const load = patchByTitle(workflow, MATTE_TEMPLATE_TITLES.load);
    const mask = patchByTitle(workflow, MATTE_TEMPLATE_TITLES.mask);
    const matanyone = patchByTitle(workflow, MATTE_TEMPLATE_TITLES.matanyone);

    // Drop the LoadImage node + its IMAGE-typed seed input; the MASK-typed
    // foreground_MASK twin (optional in the live MatAnyone2 schema) takes
    // the segmenter's MASK output instead.
    delete workflow[mask.id];
    delete matanyone.node.inputs.foreground_mask;

    // Fresh ids that can never collide with template ids (numeric "1".."8").
    const nextId =
      Math.max(...Object.keys(workflow).map((k) => Number(k) || 0)) + 1;
    const firstFrameId = String(nextId);
    const autoMaskId = String(nextId + 1);

    // Core ImageFromBatch: loaded frame 0 — the SAME frame MatAnyone2's
    // template-locked mask_frame 0 seeds from, so seed and warmup align.
    workflow[firstFrameId] = {
      class_type: "ImageFromBatch",
      inputs: { image: [load.id, 0], batch_index: 0, length: 1 },
      _meta: { title: MATTE_AUTO_TITLES.firstFrame },
    };
    // BiRefNetRMBG (1038lab/ComfyUI-RMBG): zero-config salient-subject
    // segmentation. MASK output (index 1) is WHITE = subject — exactly the
    // seed polarity MatAnyone2 expects. Optional knobs pinned to schema
    // defaults (mask_blur/offset 0: MatAnyone's warmup does the refining).
    // Weights auto-download from HF 1038lab/BiRefNet on first use — see
    // MATTE_AUTO_MASK_MODEL.
    workflow[autoMaskId] = {
      class_type: "BiRefNetRMBG",
      inputs: {
        image: [firstFrameId, 0],
        model: MATTE_AUTO_MASK_MODEL,
        mask_blur: 0,
        mask_offset: 0,
        invert_output: false,
        refine_foreground: false,
        background: "Alpha",
      },
      _meta: { title: MATTE_AUTO_TITLES.autoMask },
    };
    matanyone.node.inputs.foreground_MASK = [autoMaskId, 1];
  }

  if (fps !== undefined) {
    // Overwrite the VideoInfo fps link with the explicit rate so the encode
    // matches the resampled frames.
    patchByTitle(workflow, MATTE_TEMPLATE_TITLES.output).node.inputs.frame_rate =
      fps;
  }

  return { prompt: workflow, extra_data: { frameCap, fps, autoMask: !maskName } };
}

// ---------------------------------------------------------------------------
// HunyuanVideo-Foley FOLEY template lane (footage + optional hint → video+SFX)
// ---------------------------------------------------------------------------

/**
 * Node titles the FOLEY template must carry (validated by
 * src/workflows/validate-templates.mjs for hunyuan_foley.json). The sampler
 * node ALSO carries "FF Positive" / "FF Seed" as _meta.aliases (the ACE-Step
 * "FF Tags"/"FF Lyrics" idiom — one node owns prompt + seed + recipe); the
 * builder patches by the canonical titles below only.
 */
export const FOLEY_TEMPLATE_TITLES = {
  /** VHS_LoadVideo — the footage to foley (force_rate 0 = source fps). */
  load: "FF Load",
  /**
   * VHS_VideoInfoLoaded — fps (output 0) feeds the sampler's fps AND FF
   * Output's frame_rate; duration (output 2, post-frame_load_cap) feeds the
   * sampler's duration, so the generated audio length always equals the
   * loaded frame window (never patched — the links ARE the contract).
   */
  videoInfo: "FF Video Info",
  /**
   * HunyuanFoleySampler — prompt (the optional hint), negative_prompt, and
   * seed are patched here; cfg 4.5 / 50 steps / euler stay template-locked
   * (pack defaults). Aliases "FF Positive" / "FF Seed".
   */
  foley: "FF Foley",
  /** VHS_VideoCombine h264 mp4 — original frames + generated foley muxed. */
  output: "FF Output",
} as const;

/**
 * Length cap for the FOLEY lane, per pass. VERIFIED 2026-07-16: the live
 * HunyuanFoleySampler schema allows duration up to 30.0s (and, because the
 * template LINKS duration from VideoInfo, ComfyUI's widget validation never
 * even runs on it) — but Tencent trained/documents HunyuanVideo-Foley around
 * ~15s clips, and past the training window sync quality is unverified, so
 * 15s is the honest cap (mirroring MATTE_MAX_SECONDS' role: the route
 * answers 400 above it). Raise toward the 30s schema max only after a live
 * quality check on >15s footage.
 */
export const FOLEY_MAX_SECONDS = 15;
/**
 * LAST-RESORT assumed fps for the frame cap. The generate route header-probes
 * the source (src/lib/video-probe.ts) and sizes the cap with the REAL fps;
 * this fallback only applies when the probe fails (tail-moov head, fetch
 * failure) — a 60fps unprobeable source then gets ~7.5s, same trade-off the
 * MATTE lane documents.
 */
export const FOLEY_FALLBACK_FPS = 30;

/** duration/fps → VHS frame_load_cap for the FOLEY lane (source-fps frames). */
export function foleyFrameCap(seconds: number, fps?: number): number {
  const s = Math.min(
    Number.isFinite(seconds) && seconds > 0 ? seconds : FOLEY_MAX_SECONDS,
    FOLEY_MAX_SECONDS,
  );
  return Math.max(1, Math.ceil(s * (fps ?? FOLEY_FALLBACK_FPS)));
}

/**
 * Build a HunyuanVideo-Foley FOLEY graph (existing footage + optional text
 * hint → the SAME clip as an h264 mp4 with synchronized 48kHz SFX/ambience
 * muxed on) by patching the hunyuan_foley.json template.
 *
 * MUX DECISION (documented in the template's FF Output note): the deliverable
 * is the ready mp4 — VHS_VideoCombine muxes the ORIGINAL loaded frames with
 * the generated AUDIO in-graph, mirroring the LIP-SYNC lane, at the accepted
 * cost of one crf-19 re-encode of the frames. The generated track REPLACES
 * any source audio (FF Load's audio output is deliberately unwired).
 *
 * Only the video ref, frame_load_cap, prompt, negative and seed are patched.
 * fps and duration are NEVER patched: both are link-wired from
 * "FF Video Info" (loaded fps / loaded duration), so the audio length
 * self-corrects to exactly the loaded frame window — frame_load_cap is the
 * single length knob (see foleyFrameCap / FOLEY_MAX_SECONDS).
 *
 * The prompt is ALWAYS patched, even when empty: the pack ships a widget
 * default ("A person walks on frozen ice") that must never leak into a
 * hint-less run. Empty prompt = pure video-driven foley — nodes.py encodes
 * [negative, positive] unconditionally, and the SigLIP2@8fps +
 * Synchformer@25fps visual features carry the conditioning.
 */
export function buildFoley(params: FoleyBuildParams): {
  prompt: ComfyWorkflow;
  extra_data: { seed: number; frameCap: number; hasHint: boolean };
} {
  const { template, videoName, prompt, negative, seed, frameCap } = params;

  if (!videoName) {
    throw new Error("buildFoley requires videoName (the footage to foley)");
  }
  if (!Number.isInteger(frameCap) || frameCap < 1) {
    throw new Error(`buildFoley: bad frameCap ${frameCap}`);
  }

  const hint = prompt?.trim() ?? "";

  // Deep-clone so the cached/loaded template is never mutated.
  const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

  applyTitlePatches(workflow, {
    [FOLEY_TEMPLATE_TITLES.load]: {
      video: videoName,
      frame_load_cap: frameCap,
    },
    [FOLEY_TEMPLATE_TITLES.foley]: {
      prompt: hint,
      // Template-locked pack default ("noisy, harsh") unless the caller
      // supplies a real negative.
      ...(negative && negative.trim()
        ? { negative_prompt: negative }
        : {}),
      seed,
    },
  });

  return {
    prompt: workflow,
    extra_data: { seed, frameCap, hasHint: hint.length > 0 },
  };
}

// ---------------------------------------------------------------------------
// ACE-Step 1.5 MUSIC template lane (style tags + optional lyrics → mp3 bed)
// ---------------------------------------------------------------------------

/**
 * Node titles the MUSIC template must carry (validated by
 * src/workflows/validate-templates.mjs for acestep_music.json). The template
 * ALSO carries "FF Lyrics" / "FF Seed" as _meta.aliases on the encode/sampler
 * nodes (validator-visible names for the inputs that live there) — the
 * builder patches by the canonical titles below only.
 */
export const ACESTEP_TEMPLATE_TITLES = {
  /** UNETLoader — unet_name patched from the profile checkpoint (draft switch). */
  model: "FF Model",
  /**
   * TextEncodeAceStepAudio1.5 — ONE node carries tags + lyrics + seed +
   * duration (plus the template-locked bpm/timesignature/language/keyscale
   * and the audio-codes LLM knobs). Alias "FF Lyrics".
   */
  encode: "FF Tags",
  /** EmptyAceStep1.5LatentAudio — seconds (lockstep with encode.duration). */
  latent: "FF Audio Latent",
  /** Stock KSampler — seed input is `seed` (NOT `noise_seed`). Alias "FF Seed". */
  sampler: "FF Sampler S1",
  /** SaveAudioMP3 — history output lands under the `audio` key. */
  output: "FF Output",
} as const;

/**
 * Duration bounds for the MUSIC lane. The live schemas allow far more
 * (EmptyAceStep1.5LatentAudio seconds max 1000, encoder duration max 2000)
 * but 240 s covers every music-bed use in the portfolio and keeps a single
 * dispatch inside a sane wall-clock/VRAM envelope — the route answers 400
 * above the cap, mirroring MATTE_MAX_SECONDS.
 */
export const MUSIC_MAX_SECONDS = 240;
/** EmptyAceStep1.5LatentAudio live schema: seconds min 1.0. */
export const MUSIC_MIN_SECONDS = 1;
/**
 * Default bed length when the request omits duration. Deliberately NOT the
 * video default (4 s — meaningless for a music bed) and shorter than the
 * official template's 120 s demo songs: 60 s is a full usable underscore
 * loop at roughly half the render time.
 */
export const MUSIC_DEFAULT_SECONDS = 60;
/**
 * Official ACE-Step no-vocals convention (the v1 t2a_instrumentals template
 * ships lyrics "[instrumental]" verbatim; [inst] is the documented short
 * form). Applied whenever the request carries no lyrics — the lane's default
 * deliverable is an instrumental music bed.
 */
export const MUSIC_INSTRUMENTAL_LYRICS = "[instrumental]";

/**
 * Build an ACE-Step 1.5 MUSIC graph (style tags + optional lyrics → mp3
 * music bed) by patching the acestep_music.json template. The recipe is
 * template-locked, verbatim from the official Comfy-Org
 * audio_ace_step_1_5_split workflow template (fetched from the live box's
 * /templates endpoint 2026-07-14): UNETLoader + DualCLIPLoader(qwen_0.6b +
 * qwen_1.7b, type "ace") + VAELoader(ace_1.5_vae) →
 * TextEncodeAceStepAudio1.5 → ConditioningZeroOut (the negative — there is
 * no negative text encode for ACE-Step) → ModelSamplingAuraFlow shift 3 →
 * KSampler TURBO recipe (8 steps, cfg 1, euler/simple, denoise 1) →
 * VAEDecodeAudio → SaveAudioMP3 (V0). Only tags, lyrics, duration, seed,
 * and the UNET filename are patched here.
 *
 * Duration lockstep: `seconds` goes on BOTH the latent (seconds) and the
 * encoder (duration) — the encoder conditions the audio-codes LLM on the
 * clip length, and the official template link-wires the two from one
 * Primitive node for exactly this reason. Seed lockstep likewise: the
 * encoder's LLM pass and the KSampler each take the seed.
 *
 * Draft variant (DESIGN DECISION, documented): ONE template, builder-side
 * UNET swap. The camera/VACE draft lanes ship second template files because
 * their drafts restructure the graph (added LoRA loaders, different
 * steps/cfg); the ACE draft differs by exactly one string
 * (acestep_v1.5_turbo vs acestep_v1.5_xl_turbo_bf16 — same turbo recipe per
 * the official templates, which run the SAME 8-step/cfg-1 chain for both),
 * so a second 200-line JSON would only drift. unetName comes from the
 * models.ts profile checkpoint.
 */
export function buildAceStep(params: AceStepBuildParams): {
  prompt: ComfyWorkflow;
  extra_data: { seed: number; seconds: number; instrumental: boolean };
} {
  const { template, tags, lyrics, seconds, seed, unetName } = params;

  if (!tags || !tags.trim()) {
    throw new Error("buildAceStep requires tags (the style/genre prompt)");
  }
  if (
    !Number.isFinite(seconds) ||
    seconds < MUSIC_MIN_SECONDS ||
    seconds > MUSIC_MAX_SECONDS
  ) {
    throw new Error(
      `buildAceStep: seconds must be ${MUSIC_MIN_SECONDS}..${MUSIC_MAX_SECONDS}, got ${seconds}`,
    );
  }

  // Deep-clone so the cached/loaded template is never mutated.
  const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

  const effectiveLyrics =
    lyrics && lyrics.trim() ? lyrics : MUSIC_INSTRUMENTAL_LYRICS;

  applyTitlePatches(workflow, {
    [ACESTEP_TEMPLATE_TITLES.encode]: {
      tags,
      lyrics: effectiveLyrics,
      seed,
      duration: seconds,
    },
    [ACESTEP_TEMPLATE_TITLES.latent]: { seconds },
    // Stock KSampler (adds its own noise): the seed input is `seed`.
    [ACESTEP_TEMPLATE_TITLES.sampler]: { seed },
  });

  if (unetName) {
    applyTitlePatches(workflow, {
      [ACESTEP_TEMPLATE_TITLES.model]: { unet_name: unetName },
    });
  }

  return {
    prompt: workflow,
    extra_data: {
      seed,
      seconds,
      instrumental: effectiveLyrics === MUSIC_INSTRUMENTAL_LYRICS,
    },
  };
}

// ---------------------------------------------------------------------------
// HunyuanVideo 1.5 template lane (720p T2V / I2V — humans + glyph text)
// ---------------------------------------------------------------------------

/**
 * Node titles the HV 1.5 templates must carry (validated by
 * src/workflows/validate-templates.mjs for hv15_t2v.json / hv15_i2v.json /
 * hv15_hero.json / hv15_hero_i2v.json).
 */
export const HV15_TEMPLATE_TITLES = {
  positive: "FF Positive",
  negative: "FF Negative",
  /** i2v template only: LoadImage start frame. */
  startImage: "FF Start Image",
  /**
   * Size/length carrier: EmptyHunyuanVideo15Latent (t2v) or
   * HunyuanVideo15ImageToVideo (i2v) — both take width/height/length.
   */
  video: "FF HV Video",
  /** RandomNoise — seed input is `noise_seed`. */
  seed: "FF Seed",
  sampler: "FF Sampler S1",
  output: "FF Output",
} as const;

/**
 * Build a HunyuanVideo 1.5 720p graph (t2v or i2v) by patching a loaded
 * template. The recipe is template-locked and mirrors the official Comfy-Org
 * video_hunyuan_video_1.5_720p_* workflow templates: UNETLoader fp16 +
 * DualCLIPLoader(qwen2.5-vl 7B fp8 + byt5 glyph, type "hunyuan_video_15") +
 * ModelSamplingSD3 shift 7 → SamplerCustomAdvanced (euler / simple / 20
 * steps / cfg 6) → VAEDecode → CreateVideo 24fps. Only prompt text, seed,
 * size/length, and the start image are patched here.
 *
 * Negative prompt: HV 1.5 has no canonical negative — the official template
 * ships an empty negative at cfg 6, so empty/omitted stays empty.
 *
 * i2v: the HunyuanVideo15ImageToVideo node re-emits positive/negative
 * conditioning with the encoded start frame plus the latent; the template
 * wires the guider/sampler to those outputs, so patching "FF Start Image"
 * and the size on "FF HV Video" is the complete i2v patch. The official
 * template also feeds a sigclip CLIPVisionEncode into clip_vision_output:
 * the HERO i2v template wires it on both the base i2v conditioning and the
 * SR stage (sigclip_vision_patch14_384 is installed and enum-verified live
 * 2026-07-14); the single-stage hv15_i2v.json predates the model and leaves
 * the optional input unwired.
 *
 * HERO (two-stage 1080p SR) templates additionally carry the official
 * Tencent/Comfy SR chain, extracted verbatim from the SR subchain the
 * official video_hunyuan_video_1.5_720p_* templates ship (bypassed by
 * default there; all node names/inputs re-verified against live
 * object_info 2026-07-14):
 *
 *   LatentUpscaleModelLoader(hunyuanvideo15_latent_upsampler_1080p)
 *     → HunyuanVideo15LatentUpscaleWithModel (bilinear to the FINAL pixel
 *       size — the node resizes the stage-1 latent to width/16 x height/16,
 *       then runs the upsampler network over it)
 *     → HunyuanVideo15SuperResolution (noise_augmentation 0.7: sets the
 *       upscaled latent as concat_latent_image conditioning and passes the
 *       latent through; the i2v hero also wires vae + start_image so the
 *       first frame is re-pinned at 1080p — that is the face-correction
 *       mechanism)
 *     → sr_distilled fp8 UNET sampled in TWO passes over ONE 8-step simple
 *       schedule split at sigma index 4 (SplitSigmas):
 *         S2 = high sigmas, fresh template-locked noise ("Fresh Noise S2"),
 *              CFGGuider cfg 1 on ModelSamplingSD3 shift 2 with the
 *              SR-conditioned positive/negative;
 *         S3 = low sigmas, DisableNoise (continues the S2 latent),
 *              CFGGuider cfg 1 on the UN-shifted SR UNET with the RAW text
 *              conditioning (the official chain drops the SR reference
 *              conditioning and the shift for the final refinement steps).
 *     → VAEDecodeTiled (1080p x 121 frames is too big for a plain decode).
 *
 * Hero sizing contract (mirrors the ltx23_master idiom in
 * buildLtxTemplate): requested width/height are the FINAL output size.
 * When the template carries a HunyuanVideo15LatentUpscaleWithModel node,
 * the stage-1 latent ("FF HV Video") is patched at size/1.5 — the official
 * 720p→1080p SR ratio (1920x1080 → 1280x720 stage 1) — snapped to the 16px
 * grid, and the SR upscale node is patched to the final size snapped to its
 * 8px grid. Single-stage templates are patched exactly as before.
 */

/** Official HV 1.5 SR spatial ratio: 720p base → 1080p SR (1.5x). */
export const HV15_SR_FACTOR = 1.5;

export function buildHv15(params: Hv15BuildParams): {
  prompt: ComfyWorkflow;
  extra_data: {
    seed: number;
    length: number;
    width?: number;
    height?: number;
  };
} {
  const { template, prompt, negative, imageName, length, seed, width, height } =
    params;

  // Deep-clone so the cached/loaded template is never mutated.
  const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

  // Frames snap to the HV 4n+1 grid (121 ≈ 5s @ 24fps native). The SR stage
  // never changes the frame count — the upscale is spatial-only, so length
  // is patched on the stage-1 latent alone.
  const legalLength = validateFrameGrid(length, "hv");

  // Hero (two-stage SR) detection by CLASS, mirroring the upsampler-aware
  // sizing in buildLtxTemplate: requested width/height mean the FINAL output
  // size, and stage 1 renders at size/1.5 (the official 720p→1080p ratio).
  const srUpscaleNodes = Object.values(workflow).filter(
    (node) => node.class_type === "HunyuanVideo15LatentUpscaleWithModel",
  );
  const isHero = srUpscaleNodes.length > 0;

  const sizePatch: Record<string, unknown> = { length: legalLength };
  // Both HV latent nodes require width/height on a 16px grid (live schema).
  if (typeof width === "number" && width > 0) {
    sizePatch.width = snapToLatentGrid(isHero ? width / HV15_SR_FACTOR : width);
  }
  if (typeof height === "number" && height > 0) {
    sizePatch.height = snapToLatentGrid(
      isHero ? height / HV15_SR_FACTOR : height,
    );
  }

  // SR upscale target = the FINAL size, snapped to the node's 8px grid
  // (live schema: width/height step 8 — 1920x1080 passes through verbatim,
  // exactly the values the official template ships).
  const snapSr = (value: number) => Math.max(64, Math.round(value / 8) * 8);
  const finalWidth =
    typeof width === "number" && width > 0 ? snapSr(width) : undefined;
  const finalHeight =
    typeof height === "number" && height > 0 ? snapSr(height) : undefined;
  for (const node of srUpscaleNodes) {
    if (finalWidth !== undefined) node.inputs.width = finalWidth;
    if (finalHeight !== undefined) node.inputs.height = finalHeight;
  }

  // The node floors the SR target to the 16px latent grid (source:
  // comfy_extras/nodes_hunyuan.py — `width // 16, height // 16`), so a
  // 1920x1080 request DECODES at 1920x1072 (verified live 2026-07-14:
  // ffprobe on the hero mini-render = 1920x1072; the official template has
  // the identical behavior). Report the ACTUAL delivered size, not the
  // requested one. Request 1920x1088 if an exact 16-divisible frame matters.
  const decoded = (value: number | undefined) =>
    value === undefined ? undefined : Math.floor(value / 16) * 16;

  applyTitlePatches(workflow, {
    [HV15_TEMPLATE_TITLES.positive]: { text: prompt },
    [HV15_TEMPLATE_TITLES.negative]: {
      text: negative && negative.trim() ? negative : "",
    },
    [HV15_TEMPLATE_TITLES.video]: sizePatch,
    // RandomNoise node — seed input is `noise_seed`.
    [HV15_TEMPLATE_TITLES.seed]: { noise_seed: seed },
  });

  // i2v templates carry "FF Start Image"; t2v templates must not.
  const startImageNode = findNodeByTitle(
    workflow,
    HV15_TEMPLATE_TITLES.startImage,
  );
  if (startImageNode) {
    if (!imageName) {
      throw new Error(
        "This HV 1.5 template requires a start image (hv15-i2v) but no imageName was provided",
      );
    }
    startImageNode.node.inputs.image = imageName;
  }
  // t2v with a stray imageName: explicit selection is honored, image ignored
  // (same policy as the Wan-Alpha text-only lane).

  return {
    prompt: workflow,
    extra_data: {
      seed,
      length: legalLength,
      // Hero: report the FINAL (SR) size as actually decoded — that is what
      // the mp4 delivers (16px latent floor, e.g. 1920x1080 → 1920x1072).
      width: isHero ? decoded(finalWidth) : (sizePatch.width as number | undefined),
      height: isHero
        ? decoded(finalHeight)
        : (sizePatch.height as number | undefined),
    },
  };
}

// ---------------------------------------------------------------------------
// LTX template lane (Flash AV — single-stage distilled, AV latent path)
// ---------------------------------------------------------------------------

/**
 * Node titles the LTX templates must carry (validated by
 * src/workflows/validate-templates.mjs for ltx23_flash.json).
 */
export const LTX_TEMPLATE_TITLES = {
  positive: "FF Positive",
  negative: "FF Negative",
  startImage: "FF Start Image",
  seed: "FF Seed",
  output: "FF Output",
} as const;

/**
 * Build an LTX 2.3 template graph (Flash AV single-stage or Master AV
 * two-stage) by patching a loaded template. The recipe (ManualSigmas
 * schedules, cfg, samplers, LoRA strength, AV concat, tiled decode, SaveVideo
 * container) is template-locked — only prompt text, seed, latent size/length,
 * and the i2v-vs-t2v switch are patched here.
 *
 * Seed: the "FF Seed" title patch targets the STAGE-1 RandomNoise only. The
 * Master template's stage-2 refine pass has its own distinct RandomNoise
 * ("Fresh Noise S2", template-locked seed) which is deliberately NOT patched
 * — the refine noise is part of the locked recipe, not the user seed.
 *
 * i2v switch: the template's LTXVImgToVideoConditionOnly node carries an
 * inline `bypass` flag (BOOLEAN, verified against live object_info). With an
 * imageName we patch "FF Start Image" and force bypass=false; without one we
 * force bypass=true so the graph runs as pure t2v. The LoadImage default
 * ("example.png") is left in place in t2v mode — ComfyUI still validates that
 * the file exists in the input folder (it ships with ComfyUI and is present
 * on the live box).
 */
export function buildLtxTemplate(params: LtxTemplateBuildParams): {
  prompt: ComfyWorkflow;
  extra_data: {
    seed: number;
    length: number;
    width?: number;
    height?: number;
  };
} {
  const { template, prompt, negative, imageName, length, seed, width, height } =
    params;

  // Deep-clone so the cached/loaded template is never mutated.
  const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

  // Frames snap to the LTX 8n+1 grid (e.g. 121, 145, 201).
  const legalLength = validateFrameGrid(length, "ltx");

  applyTitlePatches(workflow, {
    [LTX_TEMPLATE_TITLES.positive]: { text: prompt },
    [LTX_TEMPLATE_TITLES.negative]: {
      text: negative && negative.trim() ? negative : LTX_NEGATIVE_PROMPT,
    },
    // RandomNoise node — seed input is `noise_seed`.
    [LTX_TEMPLATE_TITLES.seed]: { noise_seed: seed },
  });

  // Two-stage (Master) templates carry an LTXVLatentUpsampler whose spatial
  // factor comes from the LatentUpscaleModelLoader model (x2). Stage-2 has NO
  // independent size fields — its latent derives from the upsampler output
  // (verified per the ltx23_master.json link graph: EmptyLTXVLatentVideo →
  // sampler S1 → LTXVSeparateAVLatent → LTXVLatentUpsampler → S2 chain), so
  // patching the single EmptyLTXVLatentVideo is the complete size patch.
  // Requested width/height always mean the FINAL output size: with an
  // upsampler present the stage-1 latent is patched at size/factor (snapped
  // to the 32px grid EmptyLTXVLatentVideo requires). Single-stage templates
  // (Flash) have factor 1 and are patched exactly as before.
  const upscaleFactor = Object.values(workflow)
    .filter((node) => node.class_type === "LatentUpscaleModelLoader")
    .reduce((factor, node) => {
      const match = /-x(\d+)-/.exec(String(node.inputs.model_name ?? ""));
      return factor * (match ? Number(match[1]) : 2);
    }, 1);
  const snapStage1 = (value: number) =>
    upscaleFactor === 1
      ? value // Flash path: byte-identical to the proven lane-2 behavior.
      : Math.max(64, Math.round(value / upscaleFactor / 32) * 32);

  // Latent sizing is patched by CLASS, not title, so recipe variants with
  // differently-titled latent nodes keep working:
  //   - EmptyLTXVLatentVideo: width / height / length (video latent)
  //   - LTXVEmptyLatentAudio: frames_number (audio latent length must stay in
  //     lockstep with the video latent; frame_rate stays template-locked —
  //     temporal length is NOT affected by the spatial upsampler)
  let videoLatents = 0;
  for (const node of Object.values(workflow)) {
    if (node.class_type === "EmptyLTXVLatentVideo") {
      videoLatents++;
      node.inputs.length = legalLength;
      if (typeof width === "number" && width > 0) {
        node.inputs.width = snapStage1(width);
      }
      if (typeof height === "number" && height > 0) {
        node.inputs.height = snapStage1(height);
      }
    } else if (node.class_type === "LTXVEmptyLatentAudio") {
      node.inputs.frames_number = legalLength;
    }
  }
  if (videoLatents === 0) {
    throw new Error(
      "LTX template has no EmptyLTXVLatentVideo node to patch size/length on",
    );
  }

  // i2v ⇄ t2v switch via the inline bypass flag.
  const i2vNodes = Object.values(workflow).filter(
    (node) => node.class_type === "LTXVImgToVideoConditionOnly",
  );
  if (i2vNodes.length === 0) {
    throw new Error(
      "LTX template has no LTXVImgToVideoConditionOnly node (i2v/t2v switch)",
    );
  }
  for (const node of i2vNodes) {
    node.inputs.bypass = !imageName;
  }
  if (imageName) {
    patchByTitle(workflow, LTX_TEMPLATE_TITLES.startImage).node.inputs.image =
      imageName;
  }

  return {
    prompt: workflow,
    extra_data: { seed, length: legalLength, width, height },
  };
}

// ---------------------------------------------------------------------------
// LTX LIP-SYNC template lane (audio-conditioned i2v talking head)
// ---------------------------------------------------------------------------

/**
 * Node titles the LIP-SYNC template must carry (validated by
 * src/workflows/validate-templates.mjs for ltx23_lipsync.json).
 */
export const LTX_LIPSYNC_TEMPLATE_TITLES = {
  positive: "FF Positive",
  negative: "FF Negative",
  startImage: "FF Start Image",
  /** LoadAudio — the input VO; ALSO muxed into the output mp4 by CreateVideo. */
  audio: "FF Audio",
  seed: "FF Seed",
  output: "FF Output",
} as const;

/** The LIP-SYNC lane runs at LTX native 24fps (LTXVConditioning frame_rate). */
export const LTX_LIPSYNC_FPS = 24;
/**
 * Single-window frame cap: the template's EmptyLTXVLatentVideo runs the same
 * 121-frame window as the Flash lane (live schema: length min 1 step 8 →
 * legal counts 8n+1). Longer VO needs the extend-sampler multi-window path —
 * deliberately out of scope for v1 (the route answers 400).
 */
export const LTX_LIPSYNC_MAX_FRAMES = 121;
/** Max VO length the v1 lane accepts: (121-1)/24 = 5.0 seconds exactly. */
export const LTX_LIPSYNC_MAX_SECONDS =
  (LTX_LIPSYNC_MAX_FRAMES - 1) / LTX_LIPSYNC_FPS;

/**
 * Audio length → frame count for the LIP-SYNC lane: ceil(seconds * 24fps) + 1
 * frames, then ceil'd UP to the LTX 8n+1 grid (never down — rounding down
 * would cut lips off the end of the VO; rounding up leaves at most 7 frames
 * ≈ 0.29 s of video past the audio, which CreateVideo handles by simply
 * ending the audio track early). Callers enforce LTX_LIPSYNC_MAX_FRAMES.
 */
export function lipsyncAudioToFrames(audioSeconds: number): number {
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) {
    throw new Error(`lipsyncAudioToFrames: bad audio duration ${audioSeconds}`);
  }
  const rawFrames = Math.ceil(audioSeconds * LTX_LIPSYNC_FPS) + 1;
  const grid = FRAME_GRID.ltx;
  return grid * Math.max(1, Math.ceil((rawFrames - 1) / grid)) + 1;
}

/**
 * Build the LTX 2.3 LIP-SYNC graph (audio-conditioned image-to-video) by
 * patching the ltx23_lipsync.json template. The conditioning mechanism is
 * template-locked and is the whole point of the lane:
 *
 *   LoadAudio → LTXVAudioVAEEncode → LTXVConcatAVLatent (audio half is the
 *   REAL encoded VO, video half is the i2v-conditioned empty latent) →
 *   LTXVSetAudioVideoMaskByTime with mask_audio=false / init 0.0 → the audio
 *   half of the AV noise mask is all zeros, so the sampler keeps the VO
 *   latent fixed at every step (inpainting-style) while the video half
 *   (mask_video=true over the full 0..2000s clamped range, multiplied by the
 *   LTXVImgToVideoConditionOnly first-frame mask) is generated attending to
 *   the real audio tokens — that attention is what moves the lips. The
 *   output mp4 muxes the ORIGINAL LoadAudio output (CreateVideo.audio wires
 *   to the LoadAudio node, NOT to an audio VAE decode), so the delivered
 *   audio track is the input VO byte-for-byte through one AAC encode — never
 *   a re-synthesis.
 *
 * Only prompt text, seed, presenter image, VO filename, and latent
 * size/length are patched here. `length` must come from lipsyncAudioToFrames
 * so video duration covers the VO; both image and audio are REQUIRED.
 */
export function buildLtxLipsync(params: LtxLipsyncBuildParams): {
  prompt: ComfyWorkflow;
  extra_data: {
    seed: number;
    length: number;
    width?: number;
    height?: number;
  };
} {
  const {
    template,
    prompt,
    negative,
    imageName,
    audioName,
    length,
    seed,
    width,
    height,
  } = params;

  if (!imageName) {
    throw new Error("buildLtxLipsync requires imageName (the presenter still)");
  }
  if (!audioName) {
    throw new Error("buildLtxLipsync requires audioName (the voiceover)");
  }

  // Deep-clone so the cached/loaded template is never mutated.
  const workflow = JSON.parse(JSON.stringify(template)) as ComfyWorkflow;

  // Snap to the LTX 8n+1 grid and enforce the single-window cap (the route
  // 400s earlier with a friendlier message; this is the builder's own guard).
  const legalLength = validateFrameGrid(length, "ltx");
  if (legalLength > LTX_LIPSYNC_MAX_FRAMES) {
    throw new Error(
      `buildLtxLipsync: ${legalLength} frames exceeds the single-window cap ` +
        `of ${LTX_LIPSYNC_MAX_FRAMES} (${LTX_LIPSYNC_MAX_SECONDS}s @ ${LTX_LIPSYNC_FPS}fps)`,
    );
  }

  applyTitlePatches(workflow, {
    [LTX_LIPSYNC_TEMPLATE_TITLES.positive]: { text: prompt },
    [LTX_LIPSYNC_TEMPLATE_TITLES.negative]: {
      text: negative && negative.trim() ? negative : LTX_NEGATIVE_PROMPT,
    },
    [LTX_LIPSYNC_TEMPLATE_TITLES.startImage]: { image: imageName },
    // LoadAudio takes "subfolder/name" exactly like LoadImage (annotated
    // filepath in the ComfyUI input dir — see uploadInputAudio).
    [LTX_LIPSYNC_TEMPLATE_TITLES.audio]: { audio: audioName },
    // RandomNoise node — seed input is `noise_seed`.
    [LTX_LIPSYNC_TEMPLATE_TITLES.seed]: { noise_seed: seed },
  });

  // Latent sizing by CLASS, matching the buildLtxTemplate idiom. There is no
  // LTXVEmptyLatentAudio here — the audio latent's length comes from the
  // encoded VO itself, which is exactly the conditioning we want.
  let videoLatents = 0;
  for (const node of Object.values(workflow)) {
    if (node.class_type === "EmptyLTXVLatentVideo") {
      videoLatents++;
      node.inputs.length = legalLength;
      if (typeof width === "number" && width > 0) node.inputs.width = width;
      if (typeof height === "number" && height > 0) node.inputs.height = height;
    }
  }
  if (videoLatents === 0) {
    throw new Error(
      "LIP-SYNC template has no EmptyLTXVLatentVideo node to patch size/length on",
    );
  }

  // The lane is i2v-only: force the conditioning ON (bypass=false) on every
  // LTXVImgToVideoConditionOnly node, mirroring the buildLtxTemplate switch.
  const i2vNodes = Object.values(workflow).filter(
    (node) => node.class_type === "LTXVImgToVideoConditionOnly",
  );
  if (i2vNodes.length === 0) {
    throw new Error(
      "LIP-SYNC template has no LTXVImgToVideoConditionOnly node (presenter conditioning)",
    );
  }
  for (const node of i2vNodes) {
    node.inputs.bypass = false;
  }

  return {
    prompt: workflow,
    extra_data: { seed, length: legalLength, width, height },
  };
}

// ---------------------------------------------------------------------------
// LTX lane — Text -> Video (repaired two-stage distilled recipe)
// ---------------------------------------------------------------------------
export function buildTextToVideoWorkflow(req: GenerateRequest) {
  const profile = getVideoModelProfile(req.model);
  // Snap to the LTX 8n+1 frame grid (e.g. 121 or 201).
  const frames = durationToLegalFrames(req.duration, req.fps, "ltx");
  const seed = req.seed ?? Math.floor(Math.random() * 2147483647);
  const fpsInt = Math.round(req.fps);
  const usesLegacyGemma = profile.textEncoderLoader === "legacy-gemma";
  const usesClassicCfg = profile.guidanceMode === "classic-cfg";
  const usesTwoStage = Boolean(profile.twoStage && (profile.stageBSteps ?? 0) > 0);
  const samplerName = profile.samplerName ?? "euler";
  const modelOutput: [string, number] =
    profile.loraName && profile.loraStrength ? ["7", 0] : ["1", 0];

  const workflow: Workflow = {
    // Model loading
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: profile.checkpoint },
    },
    "2": {
      class_type: usesLegacyGemma
        ? "LTXVGemmaCLIPModelLoader"
        : "LTXAVTextEncoderLoader",
      inputs: usesLegacyGemma
        ? {
            gemma_path: profile.textEncoder,
            ltxv_path: profile.checkpoint,
            max_length: 1024,
          }
        : {
            text_encoder: profile.textEncoder,
            ckpt_name: profile.checkpoint,
            device: "default",
          },
    },

    // Text encoding
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: req.prompt, clip: ["2", 0] },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: NEGATIVE_PROMPT, clip: ["2", 0] },
    },
    "6": {
      class_type: "LTXVConditioning",
      inputs: {
        frame_rate: req.fps,
        positive: ["4", 0],
        negative: ["5", 0],
      },
    },

    // Latent creation
    "8": {
      class_type: "EmptyLTXVLatentVideo",
      inputs: {
        width: req.width,
        height: req.height,
        length: frames,
        batch_size: 1,
      },
    },

    // Sampling — stage A (distilled: 8 steps, cfg 1, euler_ancestral)
    "11": {
      class_type: "RandomNoise",
      inputs: { noise_seed: seed },
    },
    "12": {
      class_type: "LTXVScheduler",
      inputs: {
        steps: profile.steps,
        max_shift: 2.05,
        base_shift: 0.95,
        stretch: true,
        terminal: 0.1,
        latent: ["8", 0],
      },
    },
    "13": {
      class_type: usesClassicCfg || usesLegacyGemma ? "KSamplerSelect" : "ClownSampler_Beta",
      inputs: usesClassicCfg || usesLegacyGemma
        ? { sampler_name: samplerName }
        : {
            eta: 0.25,
            sampler_name: "exponential/res_2s",
            seed,
            bongmath: true,
          },
    },

    // LTX-specific guider. The generic CFGGuider validates, but prompt
    // adherence regressed badly on the AV model path.
    "14": {
      class_type: usesClassicCfg ? "CFGGuider" : "MultimodalGuider",
      inputs: usesClassicCfg
        ? {
            cfg: profile.videoCfg,
            model: modelOutput,
            positive: ["6", 0],
            negative: ["6", 1],
          }
        : {
            skip_blocks: usesLegacyGemma ? "29" : "28",
            model: modelOutput,
            positive: ["6", 0],
            negative: ["6", 1],
            parameters: ["20", 0],
          },
    },
    "15": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["11", 0],
        guider: ["14", 0],
        sampler: ["13", 0],
        sigmas: ["12", 0],
        latent_image: ["8", 0],
      },
    },

    // Decode
    "17": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["15", 0],
        vae: ["1", 2],
      },
    },

    // Output
    "19": {
      class_type: "VHS_VideoCombine",
      inputs: {
        frame_rate: req.fps,
        loop_count: 0,
        filename_prefix: "FrameForge",
        format: "video/h264-mp4",
        pix_fmt: "yuv420p",
        crf: 19,
        save_metadata: true,
        trim_to_audio: false,
        pingpong: false,
        save_output: true,
        images: ["17", 0],
      },
    },
  };

  // Stage B refine pass (distilled recipe: 3 extra steps, no fresh noise).
  // NOTE: validate against the pack's distilled workflow after the ComfyUI
  // restart — scheduler terminal/shift values for the refine pass may differ.
  if (usesTwoStage) {
    workflow["22"] = {
      class_type: "LTXVScheduler",
      inputs: {
        steps: profile.stageBSteps ?? 3,
        max_shift: 2.05,
        base_shift: 0.95,
        stretch: true,
        terminal: 0.1,
        latent: ["8", 0],
      },
    };
    workflow["23"] = {
      class_type: "DisableNoise",
      inputs: {},
    };
    workflow["24"] = {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["23", 0],
        guider: ["14", 0],
        sampler: ["13", 0],
        sigmas: ["22", 0],
        latent_image: ["15", 0], // stage A output latent
      },
    };
    workflow["17"].inputs.samples = ["24", 0];
  }

  const finalSamplerRef: [string, number] = usesTwoStage ? ["24", 0] : ["15", 0];

  if (!usesClassicCfg) {
    workflow["20"] = {
      class_type: "GuiderParameters",
      inputs: {
        modality: "VIDEO",
        cfg: profile.videoCfg,
        stg: usesLegacyGemma ? 0 : 1,
        perturb_attn: true,
        rescale: usesLegacyGemma ? 0 : 0.9,
        modality_scale: 3,
        skip_step: 0,
        cross_attn: true,
        parameters: ["21", 0],
      },
    };
    workflow["21"] = {
      class_type: "GuiderParameters",
      inputs: {
        modality: "AUDIO",
        cfg: profile.audioCfg,
        stg: usesLegacyGemma ? 0 : 1,
        perturb_attn: true,
        rescale: usesLegacyGemma ? 0 : 0.7,
        modality_scale: 3,
        skip_step: 0,
        cross_attn: true,
      },
    };
  }

  if (profile.includeAudio) {
    workflow["3"] = {
      class_type: "LTXVAudioVAELoader",
      inputs: { ckpt_name: profile.checkpoint },
    };
    workflow["9"] = {
      class_type: "LTXVEmptyLatentAudio",
      inputs: {
        frames_number: frames,
        frame_rate: fpsInt,
        batch_size: 1,
        audio_vae: ["3", 0],
      },
    };
    workflow["10"] = {
      class_type: "LTXVConcatAVLatent",
      inputs: {
        video_latent: ["8", 0],
        audio_latent: ["9", 0],
      },
    };
    workflow["12"].inputs.latent = ["10", 0];
    workflow["15"].inputs.latent_image = ["10", 0];
    if (workflow["22"]) {
      workflow["22"].inputs.latent = ["10", 0];
    }
    workflow["16"] = {
      class_type: "LTXVSeparateAVLatent",
      inputs: { av_latent: finalSamplerRef },
    };
    workflow["17"].inputs.samples = ["16", 0];
    workflow["18"] = {
      class_type: "LTXVAudioVAEDecode",
      inputs: {
        samples: ["16", 1],
        audio_vae: ["3", 0],
      },
    };
    workflow["19"].inputs.audio = ["18", 0];
  }

  if (profile.loraName && profile.loraStrength) {
    workflow["7"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["1", 0],
        lora_name: profile.loraName,
        strength_model: profile.loraStrength,
      },
    };
  }

  return {
    prompt: workflow,
    extra_data: {
      seed,
      model: profile.id,
      modelName: profile.name,
    },
  };
}

// ---------------------------------------------------------------------------
// LTX lane — Image -> Video
// ---------------------------------------------------------------------------
export function buildImageToVideoWorkflow(
  req: GenerateRequest & { sourceImage: string },
) {
  const base = buildTextToVideoWorkflow(req);
  const workflow = base.prompt as Workflow;

  workflow["50"] = {
    class_type: "LoadImage",
    inputs: { image: req.sourceImage, upload: "image" },
  };

  workflow["51"] = {
    class_type: "LTXVPreprocess",
    inputs: {
      image: ["50", 0],
      target_tokens: 18,
      // Repaired: 65 crushed the conditioning image; 33 preserves detail.
      img_compression: 33,
    },
  };

  workflow["52"] = {
    class_type: "LTXVImgToVideoConditionOnly",
    inputs: {
      strength: 0.7,
      bypass: false,
      vae: ["1", 2],
      image: ["51", 0],
      latent: ["8", 0],
    },
  };

  if (workflow["10"]) {
    workflow["10"].inputs.video_latent = ["52", 0];
  } else {
    workflow["12"].inputs.latent = ["52", 0];
    workflow["15"].inputs.latent_image = ["52", 0];
    if (workflow["22"]) {
      // Keep the stage-B scheduler's sigma stretch sized to the same latent.
      workflow["22"].inputs.latent = ["52", 0];
    }
  }

  return base;
}
