// FrameForge — Video Model Configuration
// Two ComfyUI lanes + one sidecar lane:
//   - "wan-i2v":     Wan 2.2 14B image-to-video (template lane, recipe-locked)
//   - "ltx":         LTX-Video 2.3 text-to-video (repaired two-stage distilled)
//   - "ltx-desktop": LTX Desktop sidecar (untouched)
//
// ROUTING RULE: a request WITH an input image goes to the Wan 2.2 I2V lane;
// a request WITHOUT an image goes to the repaired LTX lane (we only have Wan
// I2V experts, no Wan T2V). See resolveVideoModelId().

import type {
  ResolutionPreset,
  VideoModelParams,
  VideoProfileKind,
} from "./types";

export type VideoModelId =
  // Wan 2.2 lane
  | "wan22-i2v-cinematic"
  | "wan22-i2v-hero"
  | "wan22-flf2v"
  | "wan22-camera"
  | "wan22-camera-draft"
  // Wan 2.2 Fun VACE lane (identity reference-to-video + footage editing;
  // explicit selection only, never a default)
  | "vace-ref"
  | "vace-ref-draft"
  | "vace-inpaint"
  // Wan-Alpha RGBA transparent-element lane (Wan 2.1 T2V 14B + alpha LoRA;
  // explicit selection only, never a default)
  | "wan-alpha-rgba"
  // MatAnyone MATTE lane (real footage + first-frame seed mask → transparent
  // alpha webm, no green screen; transform lane — explicit selection only,
  // never a default)
  | "matanyone-matte"
  // HunyuanVideo-Foley FOLEY lane (an existing — usually silent — clip +
  // optional text hint → the same clip as an mp4 with synchronized 48kHz
  // SFX/ambience muxed on; transform-of-footage lane — explicit selection
  // only, never a default)
  | "foley-sfx"
  // ACE-Step 1.5 MUSIC lane (style/genre tags + optional lyrics → mp3 music
  // bed; the only AUDIO-output lane — explicit selection only, never a
  // default)
  | "music-bed"
  | "music-bed-draft"
  // HunyuanVideo 1.5 720p lane (best local human faces/presenters + short
  // in-video text via the ByT5 glyph encoder; explicit selection only,
  // never a default)
  | "hv15-t2v"
  | "hv15-i2v"
  // HunyuanVideo 1.5 HERO lane: same 720p base pass + the official 1080p SR
  // distilled second stage → 1920x1080 presenter clips with corrected faces
  // (explicit selection only, never a default)
  | "hv15-hero"
  | "hv15-hero-i2v"
  // LTX template lane (single-stage Flash AV distilled, API-format template)
  | "ltx23-flash"
  // LTX template lane (two-stage Master AV: distilled base + x2 latent
  // upsample refine — explicitly selected hero lane, never a default)
  | "ltx23-master"
  // LTX template lane (audio-conditioned i2v lip-sync: presenter still +
  // voiceover in, talking-head clip out; explicit selection only)
  | "ltx23-lipsync"
  // Remotion MG-TYPE lane (typography/motion-graphics; renders on the think
  // render service, NOT ComfyUI — explicit selection only, never a default)
  | "mg-type"
  // LTX ComfyUI lane (repaired, programmatic graph — legacy selectable)
  | "ltx23-prompt-faithful"
  // LTX Desktop sidecar (untouched)
  | "ltx-desktop-full-vram"
  | "ltx-desktop-streaming"
  // Legacy ids kept alive as aliases of the repaired LTX profile
  | "ltx23-fast-fp8"
  | "ltx23-full-quality"
  | "ltx23-av-audio";

export type LtxDesktopRuntimeMode =
  | "auto"
  | "full_models_loading"
  | "streaming_models_loading";

export interface VideoModelProfile {
  id: VideoModelId;
  name: string;
  shortName: string;
  description: string;
  /** Which generation lane this profile drives. Defaults to the ComfyUI LTX lane. */
  kind?: VideoProfileKind;
  backend?: "comfyui" | "ltx-desktop";
  checkpoint: string;
  textEncoder: string;
  textEncoderLoader?: "ltx-av" | "legacy-gemma";
  guidanceMode?: "classic-cfg" | "multimodal";
  ltxDesktopPipeline?: "fast" | "pro";
  ltxDesktopRuntimeMode?: LtxDesktopRuntimeMode;
  steps: number;
  videoCfg: number;
  audioCfg: number;
  loraName?: string;
  loraStrength?: number;
  includeAudio?: boolean;
  // --- Wan template lane ---
  /** Workflow template filename under src/workflows/ (API-format JSON). */
  templateFile?: string;
  /** Native fps of the lane (Wan 2.2 = 16). */
  fps?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  /** Default frame count (Wan grid 4n+1 → 81 = ~5s @ 16fps). */
  defaultLength?: number;
  /** Whether the template accepts an end-frame image (FLF2V). */
  supportsEndImage?: boolean;
  /** Requires an input image (no T2V fallback inside the lane). */
  requiresImage?: boolean;
  /**
   * Requires an input voiceover (LIP-SYNC lane): the generate route must
   * receive audioUrl (or audioBase64/audioPath) and 400s without it — there
   * is no silent fallback, the lane is meaningless without the audio.
   */
  requiresAudio?: boolean;
  /**
   * Requires an input video (VACE footage-editing lane, the MatAnyone
   * MATTE lane, AND the FOLEY lane): the generate route must receive
   * videoUrl/video/videoPath and 400s without it — there is no fallback,
   * these lanes are meaningless without the footage. The mask differs per
   * lane: VACE editing ALSO requires maskUrl/mask/maskPath (400 without);
   * MATTE's mask is OPTIONAL (omitted → buildMatAnyone auto-derives the
   * seed via BiRefNet) and when supplied must be a STILL image — the
   * first-frame seed; FOLEY takes no mask at all (a stray one is ignored).
   * The route enforces all three rules.
   */
  requiresVideo?: boolean;
  // --- Repaired LTX two-stage distilled ---
  /** Run the second distilled refine pass after the main pass. */
  twoStage?: boolean;
  /** Steps for the refine pass (distilled recipe: 3). */
  stageBSteps?: number;
  /** Sampler override for the ComfyUI LTX lane (distilled: euler_ancestral). */
  samplerName?: string;
}

// NOTE: the templates were repaired 2026-07-14 to use the official
// comfy_gemma packaging. The old gemma-3-12b-it-fp8/gemma_3_12B_it_fp8_e4m3fn
// file is a foreign fp8 quant (never part of the Lightricks/Comfy-Org LTX
// packaging) that loads silently wrong and produced prompt-ignoring output.
const GEMMA_ENCODER = "comfy_gemma_3_12B_it.safetensors";
const FRAMESTATION_GEMMA_ENCODER = "comfy_gemma_3_12B_it.safetensors";
// v1.1 lora (2026-04-27) — REQUIRED with the distilled-1.1 base transformer.
// The v1.0 file (same name minus "-1.1", identical byte size) on the 1.1 base
// causes stiff motion + color drift; verified by sha256 2026-07-14.
const DISTILLED_LORA =
  "ltxv/ltx2/ltx-2.3-22b-distilled-lora-384-1.1.safetensors";

/**
 * Wan 2.2 14B model files (paths relative to the ComfyUI models folders).
 * These are referenced by the workflow templates in src/workflows/.
 */
export const WAN22_MODELS = {
  highNoiseUnet: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
  lowNoiseUnet: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
  // Fun-camera experts (camera-move lane) — both verified present in the live
  // UNETLoader enum on 192.168.4.196:8188 (2026-07-14).
  funCameraHighNoiseUnet:
    "wan2.2_fun_camera_high_noise_14B_fp8_scaled.safetensors",
  funCameraLowNoiseUnet:
    "wan2.2_fun_camera_low_noise_14B_fp8_scaled.safetensors",
  // Fun-VACE experts (VACE lane: reference-to-video + footage editing) —
  // DOWNLOADING to /srv/comfyui/models/diffusion_models/ at build time
  // (2026-07-14, lanes-downloads round 5; high-noise was ~7/14GB). Re-check
  // the live UNETLoader enum before first dispatch — until both files land,
  // ComfyUI /prompt answers a per-node validation 400 (surfaced verbatim by
  // the generate route).
  funVaceHighNoiseUnet: "wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors",
  funVaceLowNoiseUnet: "wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors",
  textEncoder: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  vae: "wan_2.1_vae.safetensors",
  distillHighLora:
    "wan22-distill-v1022/wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors",
  distillLowLora:
    "wan22-distill-v1022/wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors",
  // Official lightx2v 4-step v1 pair (the exact loras the Comfy-Org
  // fun_control/fun_camera templates ship over the FUN experts for their
  // Lightning variants) — used by wan22-camera-draft and vace-ref-draft.
  // Verified in the live LoraLoaderModelOnly enum 2026-07-14.
  fourStepHighLora:
    "wan22-4step-v1/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
  fourStepLowLora:
    "wan22-4step-v1/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
} as const;

/**
 * HunyuanVideo 1.5 model files (paths relative to the ComfyUI models
 * folders). Referenced by src/workflows/hv15_t2v.json / hv15_i2v.json /
 * hv15_hero.json / hv15_hero_i2v.json. Base + SR UNETs verified in the live
 * UNETLoader enum on 192.168.4.196:8188 (2026-07-14). The 1080p latent
 * upsampler is in the live LatentUpscaleModelLoader enum (2026-07-14): the
 * running ComfyUI (~/ComfyUI) maps /srv/comfyui folders via
 * extra_model_paths.yaml which lacks a latent_upscale_models entry, so the
 * model was symlinked into ~/ComfyUI/models/latent_upscale_models/ — add
 * the yaml mapping at the next ComfyUI restart for durability.
 */
export const HV15_MODELS = {
  t2vUnet: "hunyuanvideo1.5_720p_t2v_fp16.safetensors",
  i2vUnet: "hunyuanvideo1.5_720p_i2v_fp16.safetensors",
  /** 1080p SR distilled second-stage UNET (fp8, ~8.3GB on disk). */
  srUnet: "hunyuanvideo1.5_1080p_sr_distilled_fp8_scaled.safetensors",
  /** 1080p latent upsampler (LatentUpscaleModelLoader, ~0.2GB). */
  latentUpsampler: "hunyuanvideo15_latent_upsampler_1080p.safetensors",
  textEncoder: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
  glyphEncoder: "byt5_small_glyphxl_fp16.safetensors",
  vae: "hunyuanvideo15_vae_fp16.safetensors",
} as const;

/**
 * ACE-Step 1.5 model files (MUSIC lane; paths relative to the ComfyUI models
 * folders), from Comfy-Org/ace_step_1.5_ComfyUI_files split_files — the
 * exact packaging the official audio_ace_step_1_5_split template loads
 * (UNETLoader + DualCLIPLoader(0.6b + 1.7b, type "ace") + VAELoader).
 * ALL FIVE FILES verified in the live loader enums on 192.168.4.196:8188
 * (2026-07-14, post lanes-downloads round 6). NOTE: the round-6 list missed
 * qwen_0.6b_ace15.safetensors — the official split template's clip_name1,
 * REQUIRED: comfy/sd.py routes CLIPType.ACE for 1.5 (ace15.te) only through
 * the two-file branch (the single-CLIP ACE branch loads the v1 AceT5) — so
 * it was gap-filled from the same HF repo during this build (logged in
 * ~/lanes-downloads.log) and enum-verified.
 *
 * XL BLOCKER (verified live 2026-07-14): the box's ComfyUI build (f21f6b22)
 * hardcodes the BASE ace1.5 dims — model_detection.py returns an empty
 * dit_config for audio_model "ace1.5", so loading the XL checkpoint dies
 * with "size mismatch ... 2560 vs 2048" at UNETLoader time. Upstream master
 * already shape-detects hidden_size/num_heads from the state dict; the XL
 * profile (music-bed) starts working at the NEXT ComfyUI update, no code
 * change here. Until then dispatch music-bed-draft — its 10s live smoke
 * passed end-to-end (scripts/music-smoke.mts, real mp3 delivered).
 */
export const ACE15_MODELS = {
  /** Quality default (music-bed): XL turbo bf16, ~9.5GB. */
  xlUnet: "acestep_v1.5_xl_turbo_bf16.safetensors",
  /** Draft (music-bed-draft): base turbo, ~4.5GB — same 8-step recipe. */
  draftUnet: "acestep_v1.5_turbo.safetensors",
  textEncoderSmall: "qwen_0.6b_ace15.safetensors",
  textEncoderLarge: "qwen_1.7b_ace15.safetensors",
  vae: "ace_1.5_vae.safetensors",
} as const;

// Text-only default: LTX 2.3 Flash AV template lane (24fps native + audio).
// "ltx23-prompt-faithful" stays selectable as the legacy programmatic lane
// and remains the target of the legacy id aliases below.
export const DEFAULT_VIDEO_MODEL_ID: VideoModelId = "ltx23-flash";
/** Default lane when the request carries an input image. */
export const DEFAULT_I2V_MODEL_ID: VideoModelId = "wan22-i2v-cinematic";

/**
 * Legacy profile ids that used to be separate (broken) LTX recipes.
 * They now resolve to the repaired two-stage distilled profile so existing
 * registry dispatches keep working instead of 404ing.
 */
export const LEGACY_MODEL_ALIASES: Readonly<
  Partial<Record<VideoModelId, VideoModelId>>
> = {
  "ltx23-fast-fp8": "ltx23-prompt-faithful",
  "ltx23-full-quality": "ltx23-prompt-faithful",
  "ltx23-av-audio": "ltx23-prompt-faithful",
};

// Shared Wan 2.2 recipe values (template-locked; never user-tunable).
const WAN22_BASE = {
  kind: "wan-i2v" as VideoProfileKind,
  backend: "comfyui" as const,
  checkpoint: WAN22_MODELS.highNoiseUnet,
  textEncoder: WAN22_MODELS.textEncoder,
  // Recipe totals for display only — the template hard-codes the 3-sampler chain.
  steps: 8,
  videoCfg: 3.5,
  audioCfg: 0,
  includeAudio: false,
  fps: 16,
  defaultWidth: 1280,
  defaultHeight: 720,
  defaultLength: 81, // 4n+1 grid, ~5s @ 16fps
  requiresImage: true,
};

export const VIDEO_MODEL_PROFILES: VideoModelProfile[] = [
  {
    ...WAN22_BASE,
    id: "wan22-i2v-cinematic",
    name: "Wan 2.2 Cinematic I2V",
    shortName: "Wan I2V",
    description:
      "Default image-to-video: Wan 2.2 14B, 3-sampler MoE distill (lightx2v v1022) recipe, 1280x720 @ 16fps.",
    templateFile: "wan22-i2v.json",
  },
  {
    ...WAN22_BASE,
    id: "wan22-i2v-hero",
    name: "Wan 2.2 Hero Shot I2V",
    shortName: "Wan Hero",
    description:
      "Same locked Wan 2.2 recipe, tuned prompt framing for hero/product shots.",
    templateFile: "wan22-i2v.json",
  },
  {
    ...WAN22_BASE,
    id: "wan22-camera",
    name: "Wan 2.2 Camera Move",
    shortName: "Wan Camera",
    description:
      "Camera-move image-to-video: Wan 2.2 fun-camera experts + WanCameraEmbedding pose presets (pan / zoom / orbit), 2-sampler recipe cfg 3.5, 1280x720 @ 16fps. Pass cameraMove (e.g. \"push in\", \"orbit left\", \"Pan Up\").",
    templateFile: "wan22_camera.json",
    // Display-only mirrors of the template-locked fun-camera recipe (the
    // camera lane runs the fun_camera UNETs, not the distill-LoRA experts).
    checkpoint: WAN22_MODELS.funCameraHighNoiseUnet,
    steps: 20,
  },
  {
    ...WAN22_BASE,
    id: "wan22-camera-draft",
    name: "Wan 2.2 Camera Move (Draft)",
    shortName: "Wan Camera Draft",
    description:
      "Fast draft of the camera lane: same fun-camera experts with the official lightx2v 4-step LoRA pair (4 steps, cfg 1). Reduced motion dynamics — use to iterate on the cameraMove/framing, then re-run wan22-camera for the final.",
    templateFile: "wan22_camera_draft.json",
    checkpoint: WAN22_MODELS.funCameraHighNoiseUnet,
    steps: 4,
  },
  {
    // Wan 2.2 Fun VACE reference-to-video — TEMPLATE lane. A reference image
    // (person/product; the input image IS the reference, not a start frame)
    // plus a prompt → a NEW scene preserving that exact identity (recurring
    // host/character across scenes). Graph: WanVaceToVideo(reference_image
    // only) → 2-expert fun sampling → TrimVideoLatent(trim_latent link).
    // Recipe is template-locked in vace_ref.json: shift 8, 20 steps, cfg 3.5,
    // euler/simple, high 0-10 / low 10-end — the official Comfy-Org Wan2.2
    // Fun family recipe. kind "wan-vace" IS RIFE-gated on purpose (16→32fps
    // delivery like the other Wan lanes). Explicit selection only.
    ...WAN22_BASE,
    id: "vace-ref",
    name: "Wan 2.2 Fun VACE Reference",
    shortName: "VACE Ref",
    description:
      "Identity reference-to-video: a reference image of a person/product + a prompt → a new scene with that exact identity (Wan 2.2 Fun VACE experts, 20 steps cfg 3.5, 1280x720 @ 16fps + RIFE to 32). The imageUrl is the IDENTITY REFERENCE, not a start frame; background-removed references lock identity best.",
    kind: "wan-vace",
    templateFile: "vace_ref.json",
    checkpoint: WAN22_MODELS.funVaceHighNoiseUnet,
    steps: 20,
  },
  {
    ...WAN22_BASE,
    id: "vace-ref-draft",
    name: "Wan 2.2 Fun VACE Reference (Draft)",
    shortName: "VACE Ref Draft",
    description:
      "Fast draft of the VACE reference lane: same VACE experts with the official lightx2v 4-step LoRA pair (4 steps, cfg 1) — the exact Lightning pattern the official fun_control template ships. Reduced motion dynamics; iterate here, re-run vace-ref for the final.",
    kind: "wan-vace",
    templateFile: "vace_ref_draft.json",
    checkpoint: WAN22_MODELS.funVaceHighNoiseUnet,
    steps: 4,
  },
  {
    // Wan 2.2 Fun VACE footage editing — TEMPLATE lane. An existing clip +
    // a mask (video or still; WHITE = regenerate) + a prompt → VACE
    // regenerates the masked region motion-matched to the surrounding
    // footage (inpaint; outpaint via a border mask). Input video is
    // resampled to Wan-native 16fps (VHS_LoadVideo force_rate; wall-clock
    // duration preserved) and the output stays 16fps: kind "wan-vace-edit"
    // must NEVER join the RIFE gate — fps continuity with the source clip
    // is the whole contract, and interpolation would break the round-trip
    // (and desync any external audio conform).
    ...WAN22_BASE,
    id: "vace-inpaint",
    name: "Wan 2.2 Fun VACE Edit",
    shortName: "VACE Edit",
    description:
      "Footage editing (inpaint/outpaint): an existing video + a mask (white = regenerate) + a prompt → the masked region is regenerated motion-matched (Wan 2.2 Fun VACE experts, 20 steps cfg 3.5, 16fps in/out, no RIFE). Requires videoUrl AND maskUrl; set duration ≈ the clip length (max window 81 frames ≈ 5s).",
    kind: "wan-vace-edit",
    templateFile: "vace_inpaint.json",
    checkpoint: WAN22_MODELS.funVaceHighNoiseUnet,
    steps: 20,
    requiresImage: false,
    requiresVideo: true,
  },
  {
    ...WAN22_BASE,
    id: "wan22-flf2v",
    name: "Wan 2.2 First+Last Frame",
    shortName: "Wan FLF",
    description:
      "Interpolates between a start and end frame with Wan 2.2 (FLF2V template).",
    templateFile: "wan22-flf2v.json",
    supportsEndImage: true,
  },
  {
    // Wan-Alpha RGBA — transparent-element TEMPLATE lane (logo stings, smoke,
    // glass, glow, particles, wipes). Wan 2.1 T2V 14B base + the Wan-Alpha
    // LoRA; ONE latent is decoded twice (RGB VAE + alpha VAE) and joined into
    // RGBA frames, saved as VP9 webm with pix_fmt yuva420p so transparency
    // survives end-to-end. Recipe is template-locked in wan_alpha.json —
    // UNDISTILLED (no Wan 2.1 T2V lightx2v/CausVid LoRA on disk): 24 steps,
    // cfg 5, uni_pc/simple, shift 8. NOT a default anywhere; explicit
    // selection only. kind "wan-alpha" must never become "wan-i2v" — the RIFE
    // post job would re-encode to mp4 and destroy the alpha channel.
    id: "wan-alpha-rgba",
    name: "Wan-Alpha RGBA Elements",
    shortName: "Wan Alpha",
    description:
      "Transparent video elements (logo stings, smoke/glass/glow, particles, wipes): Wan 2.1 T2V 14B + Wan-Alpha LoRA, dual RGB/alpha VAE decode → VP9 webm with real alpha, 832x480 @ 16fps (1280x720 hero via width/height, slower). Text-only; describe the element on a transparent background.",
    kind: "wan-alpha",
    backend: "comfyui",
    templateFile: "wan_alpha.json",
    // Display-only mirrors of the template-locked recipe values.
    checkpoint: "wan2.1_t2v_14B_fp8_scaled.safetensors",
    textEncoder: WAN22_MODELS.textEncoder,
    steps: 24,
    videoCfg: 5,
    audioCfg: 0,
    loraName: "wan-alpha/epoch-13-1500_changed.safetensors",
    loraStrength: 1.0,
    includeAudio: false,
    fps: 16,
    defaultWidth: 832,
    defaultHeight: 480,
    defaultLength: 81, // 4n+1 grid, ~5s @ 16fps
    requiresImage: false,
    supportsEndImage: false,
  },
  {
    // MatAnyone MATTE — real-footage keying TEMPLATE lane. An existing video
    // of a person/subject + an OPTIONAL first-frame seed mask (white subject
    // on black; only a SEED — MatAnyone2's warmup regenerates a clean matte,
    // then propagates it through the clip) → a transparent-background VP9
    // webm (yuva420p, real alpha) with the source clip's audio muxed through.
    // Mask omitted → buildMatAnyone swaps the LoadImage branch for an auto
    // person/subject seed: first loaded frame (ImageFromBatch idx 0) →
    // BiRefNetRMBG (BiRefNet-general, 1038lab/ComfyUI-RMBG; weights
    // auto-download from HF 1038lab/BiRefNet on first use) MASK output →
    // MatAnyone2.foreground_MASK.
    // A TRANSFORM lane, not generation: NO prompt (the generate route makes
    // prompt optional for kind "matte" only), no sampler, no seed, no size
    // params — resolution and fps come from the source clip (VHS_LoadVideo
    // force_rate 0 + frame_rate link-wired from FF Video Info; an explicit
    // fps param resamples instead). Graph is template-locked in
    // matanyone.json: MatAnyone2 matte output (white = subject) →
    // ImageToMask → InvertMask (JoinImageWithAlpha computes alpha = 1-mask,
    // same load-bearing polarity as wan_alpha.json) → JoinImageWithAlpha
    // over the original frames → VHS webm. kind "matte" must never become
    // "wan-i2v"/"wan-vace": the RIFE post job's mp4 re-encode would destroy
    // the alpha AND break source-fps continuity. Never a default; explicit
    // selection only. Defensive 30s cap (MATTE_MAX_SECONDS).
    id: "matanyone-matte",
    name: "MatAnyone Matte (Footage → Alpha)",
    shortName: "Matte",
    description:
      "Real-footage keying, no green screen: an existing video of a person/subject → a transparent-background VP9 webm with real alpha, source fps + audio preserved. Requires videoUrl; maskUrl (still image, white = subject) is OPTIONAL — omitted = auto person/subject seed mask (first frame → BiRefNet). Prompt not used. Max 30s per clip.",
    kind: "matte",
    backend: "comfyui",
    templateFile: "matanyone.json",
    // Display-only: the lane runs the pq-yang MatAnyone2 checkpoint inside
    // the FuouM/ComfyUI-MatAnyone pack — no diffusion model, no text encoder.
    checkpoint: "ComfyUI-MatAnyone/checkpoint/matanyone2.pth",
    textEncoder: "none (transform lane — no prompt)",
    steps: 0,
    videoCfg: 0,
    audioCfg: 0,
    // Audio passthrough: the source clip's track is muxed into the webm.
    includeAudio: true,
    requiresImage: false,
    requiresVideo: true,
    supportsEndImage: false,
  },
  {
    // HunyuanVideo-Foley FOLEY — sound-design TEMPLATE lane (kind "foley").
    // An existing (usually silent) clip + an OPTIONAL text hint → the SAME
    // clip delivered as an h264 mp4 with synchronized 48kHz SFX/ambience
    // muxed on IN-GRAPH (VHS_VideoCombine over the original frames +
    // generated AUDIO — the LIP-SYNC "ready deliverable" pattern, no
    // external re-mux). The generated track REPLACES any source audio;
    // layering under dialogue is an edit job. Graph is template-locked in
    // hunyuan_foley.json: VHS_LoadVideo (force_rate 0, source fps
    // preserved) → HunyuanModelLoader(bf16) + HunyuanDependenciesLoader →
    // HunyuanFoleySampler (cfg 4.5, 50 steps, euler — pack defaults; fps
    // AND duration link-wired from FF Video Info so audio length always
    // equals the loaded frame window) → VHS_VideoCombine h264/yuv420p with
    // frame_rate from the same VideoInfo link. Prompt OPTIONAL (a hint like
    // "boots on gravel" steers the SFX; empty = pure video-driven — the
    // route makes prompt optional for kind "foley" like it does for
    // "matte"). Capped at FOLEY_MAX_SECONDS (15s) per pass via
    // frame_load_cap sized by the header probe — the node widget allows 30s
    // but the model is trained/documented around ~15s clips. First run on a
    // fresh box downloads SigLIP2 + CLAP encoders from HF (~3.5GB, see the
    // template's FF Foley Deps note). kind "foley" must never become
    // "wan-i2v"/"wan-vace": the RIFE post gate keys on those kinds and
    // interpolation would retime the frames the audio was synced against.
    // Never a default; explicit selection only. The optional
    // HunyuanFoleyTorchCompile node (~30% faster after a ~2min first
    // compile, recompiles when duration/batch change) is DELIBERATELY not
    // in the v1 template — a per-duration compile penalty is wrong for a
    // lane whose duration follows each source clip; revisit if a
    // fixed-duration batch workflow appears.
    id: "foley-sfx",
    name: "HunyuanVideo-Foley SFX (Video → Video+Audio)",
    shortName: "Foley",
    description:
      "Sound design for existing footage: a (usually silent) clip → the same clip as an mp4 with synchronized sound effects/ambience (HunyuanVideo-Foley, 48kHz, video-synced via Synchformer). Requires videoUrl; prompt is an OPTIONAL hint (\"boots crunching on gravel\") — omit it for pure video-driven foley. Replaces any source audio track. Max 15s per clip; source fps preserved.",
    kind: "foley",
    backend: "comfyui",
    templateFile: "hunyuan_foley.json",
    // Display-only mirrors of the template-locked recipe values.
    checkpoint: "hunyuanfoley/hunyuanvideo_foley.pth",
    textEncoder:
      "laion/larger_clap_general (CLAP text) + google/siglip2-base-patch16-512 (visual) — runtime HF fetches",
    steps: 50,
    videoCfg: 4.5,
    audioCfg: 4.5,
    // The whole point: the delivered mp4 carries the generated audio.
    includeAudio: true,
    requiresImage: false,
    requiresVideo: true,
    supportsEndImage: false,
  },
  {
    // ACE-Step 1.5 MUSIC — the AUDIO-output TEMPLATE lane (kind "audio"):
    // style/genre tags (the prompt) + optional lyrics → an mp3 music bed.
    // Recipe is template-locked in acestep_music.json, verbatim from the
    // official Comfy-Org audio_ace_step_1_5_split template: UNETLoader +
    // DualCLIPLoader(qwen 0.6b + 1.7b, type "ace") + VAELoader →
    // TextEncodeAceStepAudio1.5 → ConditioningZeroOut negative →
    // ModelSamplingAuraFlow shift 3 → KSampler 8 steps / cfg 1 / euler /
    // simple (TURBO) → VAEDecodeAudio → SaveAudioMP3 (V0). Duration:
    // request seconds → latent seconds + encoder duration in lockstep
    // (default 60s, cap 240s → 400). No lyrics → "[instrumental]".
    // imageUrl/videoUrl are IGNORED (kind "audio" is exempt from the image
    // reroute in resolveVideoModelId, like "matte" — rerouting would swap
    // an mp3 deliverable for a generated mp4). Never RIFE'd (no frames),
    // never a default; explicit selection only (model or laneKey "MUSIC").
    id: "music-bed",
    name: "ACE-Step 1.5 Music Bed",
    shortName: "Music",
    description:
      "Local music generation: style/genre tags (+ optional lyrics via the `lyrics` body param) → an mp3 music bed, up to 240s (default 60s). ACE-Step 1.5 XL turbo, 8 steps cfg 1. Instrumental by default; pass lyrics for vocals. Prompt = the style tags. BLOCKED on the box's current ComfyUI build (the XL checkpoint fails at UNETLoader, size mismatch — see ACE15_MODELS): dispatch music-bed-draft (the lane default) until the next ComfyUI update.",
    kind: "audio",
    backend: "comfyui",
    templateFile: "acestep_music.json",
    // Display-only mirrors; checkpoint doubles as the "FF Model" UNET patch
    // value (buildAceStep unetName), which is what makes the draft variant
    // a one-string profile swap instead of a second template file.
    checkpoint: ACE15_MODELS.xlUnet,
    textEncoder: `${ACE15_MODELS.textEncoderSmall} + ${ACE15_MODELS.textEncoderLarge} (DualCLIPLoader "ace")`,
    steps: 8,
    videoCfg: 1,
    audioCfg: 1,
    includeAudio: true,
    requiresImage: false,
    supportsEndImage: false,
  },
  {
    // Fast draft of the MUSIC lane: identical template + recipe, the 4.5GB
    // base turbo UNET patched onto "FF Model" instead of the 9.5GB XL
    // (builder-side swap — see buildAceStep; deliberately NOT a second
    // template file, unlike the LoRA-restructured camera/VACE drafts).
    id: "music-bed-draft",
    name: "ACE-Step 1.5 Music Bed (Draft)",
    shortName: "Music Draft",
    description:
      "Fast draft of the MUSIC lane: same 8-step turbo recipe on the 4.5GB base model — iterate on tags/structure here, re-run music-bed (XL) for the final.",
    kind: "audio",
    backend: "comfyui",
    templateFile: "acestep_music.json",
    checkpoint: ACE15_MODELS.draftUnet,
    textEncoder: `${ACE15_MODELS.textEncoderSmall} + ${ACE15_MODELS.textEncoderLarge} (DualCLIPLoader "ace")`,
    steps: 8,
    videoCfg: 1,
    audioCfg: 1,
    includeAudio: true,
    requiresImage: false,
    supportsEndImage: false,
  },
  {
    // HunyuanVideo 1.5 720p T2V — TEMPLATE lane for the best local human
    // faces/presenters and short legible in-video text (ByT5 glyph encoder).
    // Recipe is template-locked in hv15_t2v.json, mirroring the official
    // Comfy-Org workflow: fp16 UNET + DualCLIPLoader(qwen2.5-vl 7B fp8 +
    // byt5 glyph, "hunyuan_video_15") + shift 7, euler/simple, 20 steps,
    // cfg 6, 1280x720x121 @ 24fps native (frames on the 4n+1 grid).
    // 24fps output is delivery-ready: kind "hv-template" must never become
    // "wan-i2v" — the RIFE post gate keys on that kind and interpolation
    // would only soften faces. NOT a default anywhere; explicit selection
    // only. (Hunyuan's own full-quality table is cfg 6 / shift 9 / 50 steps
    // for 720p t2v; the ComfyUI template ships shift 7 / 20 steps for speed
    // and that is what the template locks.)
    id: "hv15-t2v",
    name: "HunyuanVideo 1.5 Humans T2V",
    shortName: "HV Humans",
    description:
      "Human faces/presenters + short in-video text, text-to-video: HunyuanVideo 1.5 720p fp16 with the ByT5 glyph encoder, 20 steps cfg 6, 1280x720 @ 24fps. Explicit selection only.",
    kind: "hv-template",
    backend: "comfyui",
    templateFile: "hv15_t2v.json",
    // Display-only mirrors of the template-locked recipe values.
    checkpoint: HV15_MODELS.t2vUnet,
    textEncoder: HV15_MODELS.textEncoder,
    steps: 20,
    videoCfg: 6,
    audioCfg: 0,
    includeAudio: false,
    fps: 24,
    defaultWidth: 1280,
    defaultHeight: 720,
    defaultLength: 121, // 4n+1 grid, 5s @ 24fps
    requiresImage: false,
    supportsEndImage: false,
  },
  {
    // HunyuanVideo 1.5 720p I2V — same locked recipe on the I2V UNET
    // (HunyuanVideo15ImageToVideo conditioning). Used only when the model is
    // EXPLICITLY "hv15-i2v" and a start image is present; an image alone
    // still routes to the Wan 2.2 I2V default. Without an image the request
    // falls back to the text-only default (resolveVideoModelId).
    id: "hv15-i2v",
    name: "HunyuanVideo 1.5 Humans I2V",
    shortName: "HV Humans I2V",
    description:
      "Human faces/presenters + short in-video text, image-to-video: HunyuanVideo 1.5 720p fp16 I2V, 20 steps cfg 6, 1280x720 @ 24fps. Explicit selection only.",
    kind: "hv-template",
    backend: "comfyui",
    templateFile: "hv15_i2v.json",
    // Display-only mirrors of the template-locked recipe values.
    checkpoint: HV15_MODELS.i2vUnet,
    textEncoder: HV15_MODELS.textEncoder,
    steps: 20,
    videoCfg: 6,
    audioCfg: 0,
    includeAudio: false,
    fps: 24,
    defaultWidth: 1280,
    defaultHeight: 720,
    defaultLength: 121, // 4n+1 grid, 5s @ 24fps
    requiresImage: true,
    supportsEndImage: false,
  },
  {
    // HunyuanVideo 1.5 HERO T2V — two-stage 1080p SR TEMPLATE lane. Stage 1
    // is the exact hv15_t2v recipe (20 steps cfg 6 shift 9 @ 1280x720); the
    // official SR distilled second stage (extracted from the SR subchain the
    // Comfy-Org 720p templates ship) then latent-upsamples to 1920x1080 and
    // resamples with the sr_distilled fp8 UNET: ONE 8-step simple schedule
    // split at sigma index 4 — high half with fresh template-locked noise at
    // shift 2 / cfg 1 under the SR concat-latent conditioning (noise-aug
    // 0.7), low half continuing via DisableNoise on the un-shifted UNET with
    // the raw text conditioning — then VAEDecodeTiled. Requested
    // width/height are the FINAL size; buildHv15 detects the SR chain and
    // patches stage 1 at size/1.5 (see HV15_SR_FACTOR). ~2x the render time
    // of hv15-t2v. kind "hv-template": 24fps delivery-ready, never RIFE'd.
    // Explicit selection only, never a default.
    id: "hv15-hero",
    name: "HunyuanVideo 1.5 Hero 1080p SR",
    shortName: "HV Hero",
    description:
      "Flagship presenter clips, text-to-video: HunyuanVideo 1.5 720p base pass + the official 1080p SR distilled second stage (8 steps split at sigma 4, cfg 1, noise-aug 0.7) → 1920x1072 @ 24fps (1080 floors to the 16px latent grid; request 1920x1088 for an exact 16-divisible frame) with corrected faces. ~2x hv15-t2v render time. Explicit selection only.",
    kind: "hv-template",
    backend: "comfyui",
    templateFile: "hv15_hero.json",
    // Display-only mirrors of the template-locked recipe values (stage-1
    // 20-step base; the SR stage runs its own locked 8-step split schedule).
    checkpoint: HV15_MODELS.t2vUnet,
    textEncoder: HV15_MODELS.textEncoder,
    steps: 20,
    videoCfg: 6,
    audioCfg: 0,
    includeAudio: false,
    fps: 24,
    defaultWidth: 1920,
    defaultHeight: 1080,
    defaultLength: 121, // 4n+1 grid, 5s @ 24fps
    requiresImage: false,
    supportsEndImage: false,
  },
  {
    // HunyuanVideo 1.5 HERO I2V — same two-stage 1080p SR chain on the I2V
    // base pass. The SR conditioning stage additionally re-pins the start
    // image at 1080p (HunyuanVideo15SuperResolution vae + start_image +
    // sigclip clip_vision_output — the full official i2v SR wiring), which
    // is what corrects presenter faces through the upscale. Explicit
    // selection only; requires a start image (falls back to the text
    // default without one, like hv15-i2v).
    id: "hv15-hero-i2v",
    name: "HunyuanVideo 1.5 Hero 1080p SR I2V",
    shortName: "HV Hero I2V",
    description:
      "Flagship presenter clips from a still: HunyuanVideo 1.5 720p I2V base pass + the official 1080p SR distilled second stage (start image re-pinned at 1080p) → 1920x1072 @ 24fps (1080 floors to the 16px latent grid; request 1920x1088 for an exact 16-divisible frame) with corrected faces. Explicit selection only.",
    kind: "hv-template",
    backend: "comfyui",
    templateFile: "hv15_hero_i2v.json",
    // Display-only mirrors of the template-locked recipe values.
    checkpoint: HV15_MODELS.i2vUnet,
    textEncoder: HV15_MODELS.textEncoder,
    steps: 20,
    videoCfg: 6,
    audioCfg: 0,
    includeAudio: false,
    fps: 24,
    defaultWidth: 1920,
    defaultHeight: 1080,
    defaultLength: 121, // 4n+1 grid, 5s @ 24fps
    requiresImage: true,
    supportsEndImage: false,
  },
  {
    // LTX 2.3 Flash AV — single-stage distilled TEMPLATE lane. The recipe is
    // template-locked in src/workflows/ltx23_flash.json (ManualSigmas 8-step
    // schedule, cfg 1, euler_ancestral_cfg_pp, AV concat latent path, tiled
    // VAE decode, SaveVideo mp4/h264). Only prompt/seed/size/length and the
    // i2v bypass are patched at dispatch (see buildLtxTemplate).
    id: "ltx23-flash",
    name: "LTX 2.3 Flash AV",
    shortName: "LTX Flash",
    description:
      "Default text-to-video: single-stage LTX 2.3 distilled template with native audio, 960x544 @ 24fps. Optional start image (i2v condition).",
    kind: "ltx-template",
    backend: "comfyui",
    templateFile: "ltx23_flash.json",
    // Display-only mirrors of the template-locked recipe values.
    checkpoint: "ltx-2.3-22b-dev-fp8.safetensors",
    textEncoder: GEMMA_ENCODER,
    steps: 8,
    videoCfg: 1,
    audioCfg: 1,
    loraName: DISTILLED_LORA,
    loraStrength: 0.5,
    includeAudio: true,
    fps: 24,
    defaultWidth: 960,
    defaultHeight: 544,
    defaultLength: 121, // 8n+1 grid, ~5s @ 24fps
    requiresImage: false,
    supportsEndImage: false,
  },
  {
    // LTX 2.3 Master AV — two-stage distilled TEMPLATE lane, built from the
    // official two-stage workflow (src/workflows/ltx23_master.json). Stage 1
    // samples at half resolution, then the x2 spatial latent upsampler
    // (ltx-2.3-spatial-upscaler-x2-1.1) feeds a 3-step refine pass with a
    // fresh template-locked noise node ("Fresh Noise S2"). defaultWidth /
    // defaultHeight are the FINAL output size — buildLtxTemplate detects the
    // upsampler and patches the stage-1 latent at size/2 (1920x1088 out →
    // 960x544 stage-1). NOT a default lane anywhere: explicitly selected only.
    id: "ltx23-master",
    name: "LTX 2.3 Master AV",
    shortName: "LTX Master",
    description:
      "Hero text-to-video: two-stage LTX 2.3 distilled template (base pass + x2 latent-upsample refine) with native audio, 1920x1088 @ 24fps. Optional start image (i2v condition).",
    kind: "ltx-template",
    backend: "comfyui",
    templateFile: "ltx23_master.json",
    // Display-only mirrors of the template-locked recipe values (stage-1
    // 8-step ManualSigmas + stage-2 3-step refine, cfg 1, LoRA 0.5).
    checkpoint: "ltx-2.3-22b-dev-fp8.safetensors",
    textEncoder: GEMMA_ENCODER,
    steps: 8,
    videoCfg: 1,
    audioCfg: 1,
    loraName: DISTILLED_LORA,
    loraStrength: 0.5,
    includeAudio: true,
    fps: 24,
    defaultWidth: 1920,
    defaultHeight: 1088,
    defaultLength: 121, // 8n+1 grid, ~5s @ 24fps
    requiresImage: false,
    supportsEndImage: false,
  },
  {
    // LTX 2.3 LIP-SYNC — audio-conditioned image-to-video TEMPLATE lane.
    // A presenter still + a voiceover (wav/mp3) in → a talking-head clip
    // whose lip motion matches the audio out. Recipe is template-locked in
    // src/workflows/ltx23_lipsync.json: the VO is VAE-encoded
    // (LTXVAudioVAEEncode) and concatenated as the AV latent's audio half,
    // then LTXVSetAudioVideoMaskByTime pins it with an all-zero audio noise
    // mask (mask_audio=false, init 0) while the video half is generated
    // (mask_video=true over the full range, multiplied by the i2v
    // first-frame mask) — inpainting-style audio conditioning, so the model
    // generates lips attending to the REAL audio tokens at every step. The
    // output mp4 muxes the ORIGINAL LoadAudio output via CreateVideo.audio
    // (never a re-synthesis; the sampled audio latent is discarded).
    // Duration is derived from the audio length (ceil'd to the 8n+1 grid),
    // capped at 121 frames = 5.0s @ 24fps for v1 — longer VO → 400.
    // kind "ltx-template" must never change: the RIFE post gate keys on
    // kind === "wan-i2v" and interpolation would smear the mouth motion AND
    // strip the audio track. Explicit selection only, never a default.
    id: "ltx23-lipsync",
    name: "LTX 2.3 Lip-Sync AV",
    shortName: "LTX Lip-Sync",
    description:
      "Talking-head lip-sync: presenter still + voiceover (wav/mp3, max 5.0s) → LTX 2.3 audio-conditioned i2v, 960x544 @ 24fps, original VO muxed into the mp4. Requires BOTH imageUrl and audioUrl.",
    kind: "ltx-template",
    backend: "comfyui",
    templateFile: "ltx23_lipsync.json",
    // Display-only mirrors of the template-locked recipe values (same
    // single-stage distilled recipe as Flash: ManualSigmas 8-step, cfg 1,
    // euler_ancestral_cfg_pp, LoRA 0.5 — plus the AV mask conditioning).
    checkpoint: "ltx-2.3-22b-dev-fp8.safetensors",
    textEncoder: GEMMA_ENCODER,
    steps: 8,
    videoCfg: 1,
    audioCfg: 1,
    loraName: DISTILLED_LORA,
    loraStrength: 0.5,
    includeAudio: true,
    fps: 24,
    defaultWidth: 960,
    defaultHeight: 544,
    defaultLength: 121, // 8n+1 grid cap — actual length derives from the VO
    requiresImage: true,
    requiresAudio: true,
    supportsEndImage: false,
  },
  {
    // Remotion MG-TYPE — the EXTERNAL motion-graphics executor (kind
    // "remotion"): deterministic React/Remotion CPU renders on the think
    // render service (192.168.4.200:3070, ~/evergreen-remotion — see
    // src/lib/remotion-client.ts), not ComfyUI on this box. Request shape:
    // composition ("LowerThird" | "TitleCard") + its props (title, subtitle,
    // accentColor/credit); prompt optional (the props ARE the content).
    // Deliverables: LowerThird → ProRes 4444 + alpha .mov for the NLE PLUS a
    // VP8 alpha webm preview (proxied via /api/output?remotion=...);
    // TitleCard → h264 mp4. The status route polls think via remoteJobId
    // (kind "remotion" branch) — no comfyPromptId, no RIFE (interpolation
    // would smear typography; the gate keys on the Wan kinds anyway), no
    // VRAM sweep (CPU render on another machine). Exempt from the image
    // reroute in resolveVideoModelId (a stray image is ignored — rerouting
    // would swap a typographic deliverable for a generated clip). Never a
    // default; explicit selection only (model "mg-type" or laneKey "MG-TYPE").
    id: "mg-type",
    name: "Remotion Motion Graphics (MG-TYPE)",
    shortName: "MG Type",
    description:
      "Typography/kinetic-text motion graphics rendered by Remotion on think: composition \"LowerThird\" (name/role lower third, ProRes 4444 alpha .mov + alpha webm preview, 5s) or \"TitleCard\" (episode title card, h264 mp4, 6s), 1920x1080 @ 32fps. Pass composition + title/subtitle (accentColor / credit optional). Deterministic render — no seed, no sampler.",
    kind: "remotion",
    // Display-only: there is no model — a deterministic React render.
    checkpoint: "evergreen-remotion (Remotion 4.0.489 on think:3070)",
    textEncoder: "none (deterministic React render — no model, no prompt)",
    steps: 0,
    videoCfg: 0,
    audioCfg: 0,
    includeAudio: false,
    fps: 32,
    defaultWidth: 1920,
    defaultHeight: 1080,
    // Composition-locked (LowerThird 160 / TitleCard 192) — recorded per job
    // from the composition spec, not from this display default.
    defaultLength: 160,
    requiresImage: false,
    supportsEndImage: false,
  },
  {
    // REPAIRED: was distilled-lora 0.5 / 20 steps / cfg 3 — now the two-stage
    // distilled recipe (stage A 8 steps + stage B 3 steps, cfg 1,
    // euler_ancestral, lora 1.0, 1280x704 @ 25fps, frames on the 8n+1 grid).
    id: "ltx23-prompt-faithful",
    name: "LTX 2.3 Distilled",
    shortName: "LTX Distilled",
    description:
      "Repaired text-to-video: single-stage distilled (8 steps, cfg 1, euler_ancestral, lora 1.0).",
    kind: "ltx",
    checkpoint: "ltx-2.3-22b-dev-fp8.safetensors",
    textEncoder: FRAMESTATION_GEMMA_ENCODER,
    guidanceMode: "classic-cfg",
    steps: 8,
    videoCfg: 1,
    audioCfg: 7,
    loraName: DISTILLED_LORA,
    loraStrength: 1.0,
    // The distilled two-stage pass is video-only; the old AV concat path was
    // part of the broken recipe and regressed quality.
    includeAudio: false,
    // Single-stage distilled: the hand-reconstructed stage-B refine graph
    // produced garbled output in the 2026-07-10 live smoke. 8-step CFG-1
    // LoRA-1.0 single-stage is the documented recipe; re-enable two-stage
    // only after diffing against the pack's own distilled workflow JSON.
    twoStage: false,
    stageBSteps: 0,
    samplerName: "euler_ancestral",
    fps: 25,
    defaultWidth: 1280,
    defaultHeight: 704,
    defaultLength: 121, // 8n+1 grid (121 or 201)
  },
  {
    id: "ltx-desktop-full-vram",
    name: "LTX Desktop Full VRAM",
    shortName: "LTX Full",
    description:
      "Blackwell default: keeps the local model resident on GPU for the fastest 32 GB path.",
    kind: "ltx-desktop",
    backend: "ltx-desktop",
    checkpoint: "ltx-desktop",
    textEncoder: "ltx-desktop",
    ltxDesktopPipeline: "fast",
    ltxDesktopRuntimeMode: "full_models_loading",
    steps: 0,
    videoCfg: 0,
    audioCfg: 0,
    includeAudio: false,
  },
  {
    id: "ltx-desktop-streaming",
    name: "LTX Desktop Streamed Low VRAM",
    shortName: "LTX Stream",
    description:
      "Forces layer/model streaming from host RAM for lower VRAM and bigger-model experiments.",
    kind: "ltx-desktop",
    backend: "ltx-desktop",
    checkpoint: "ltx-desktop",
    textEncoder: "ltx-desktop",
    ltxDesktopPipeline: "fast",
    ltxDesktopRuntimeMode: "streaming_models_loading",
    steps: 0,
    videoCfg: 0,
    audioCfg: 0,
    includeAudio: false,
  },
];

export function getVideoModelProfile(modelId?: string): VideoModelProfile {
  const resolved =
    (modelId && LEGACY_MODEL_ALIASES[modelId as VideoModelId]) || modelId;
  return (
    VIDEO_MODEL_PROFILES.find((profile) => profile.id === resolved) ??
    VIDEO_MODEL_PROFILES.find(
      (profile) => profile.id === DEFAULT_VIDEO_MODEL_ID,
    ) ??
    VIDEO_MODEL_PROFILES[0]
  );
}

/**
 * Apply the lane routing rule to a requested model id.
 * - No/unknown model: image → Wan I2V default, no image → LTX default.
 * - Explicit Wan model without an image: falls back to the LTX default
 *   (there is no Wan T2V expert installed).
 * - Explicit LTX-template / LTX-desktop model: honored as requested even with
 *   an image (the Flash template conditions on a start frame natively).
 * - Explicit Wan-Alpha model: honored as requested even with an image (the
 *   lane is text-only; a stray image is ignored, never rerouted — rerouting
 *   would silently swap an RGBA deliverable for an opaque mp4).
 * - Explicit HV 1.5 model: honored as requested. hv15-i2v runs only when a
 *   start image is present (requiresImage falls back to the text-only
 *   default otherwise); hv15-t2v with a stray image ignores it.
 * - Explicit VACE model: honored as requested. vace-ref/-draft need the image
 *   (as the identity reference) — the generate route 400s BEFORE this
 *   function when it is missing, so the requiresImage fallback below is only
 *   a safety net. vace-inpaint takes video+mask (route-guarded), never the
 *   Wan I2V reroute.
 * - Explicit MATTE model: honored as requested even with a stray image (the
 *   lane takes video+mask, route-guarded 400s handle the missing inputs —
 *   rerouting to Wan I2V would silently swap an alpha-webm transform for an
 *   opaque generated mp4).
 * - Explicit FOLEY model: honored as requested even with a stray image (the
 *   lane takes a video, route-guarded 400 handles a missing one — rerouting
 *   to Wan I2V would silently swap a scored-footage deliverable for a
 *   generated clip).
 * - Explicit MUSIC model (kind "audio"): honored as requested even with a
 *   stray image — the lane is tags-only and its deliverable is an mp3;
 *   rerouting to Wan I2V would silently swap an audio file for a video.
 * - Explicit MG-TYPE model (kind "remotion"): honored as requested even with
 *   a stray image — the lane is composition-props-only (typography), and
 *   rerouting would silently swap a motion-graphics deliverable rendered on
 *   think for a ComfyUI-generated clip.
 * - Other explicit models with an image: routed to the Wan I2V default.
 */
export function resolveVideoModelId(
  requested: string | undefined,
  hasImage: boolean,
): VideoModelId {
  const aliased =
    (requested && LEGACY_MODEL_ALIASES[requested as VideoModelId]) || requested;
  const known = VIDEO_MODEL_PROFILES.find((p) => p.id === aliased);

  if (!known) {
    return hasImage ? DEFAULT_I2V_MODEL_ID : DEFAULT_VIDEO_MODEL_ID;
  }
  if (known.requiresImage && !hasImage) {
    return DEFAULT_VIDEO_MODEL_ID;
  }
  if (
    hasImage &&
    known.kind !== "wan-i2v" &&
    known.kind !== "wan-alpha" &&
    known.kind !== "wan-vace" &&
    known.kind !== "wan-vace-edit" &&
    known.kind !== "matte" &&
    known.kind !== "foley" &&
    known.kind !== "audio" &&
    known.kind !== "remotion" &&
    known.kind !== "ltx-template" &&
    known.kind !== "hv-template" &&
    known.kind !== "ltx-desktop"
  ) {
    // Image present on a ComfyUI request → Wan 2.2 I2V lane per routing rule.
    return DEFAULT_I2V_MODEL_ID;
  }
  return known.id;
}

export const LTX_VIDEO_MODEL = {
  id: "ltx-video-2.3",
  name: "LTX-Video 2.3",
  description: "Local video + audio generation with Lightricks LTX-Video 2.3",
  supportsImageInput: true,
  supportsAudio: true,
  defaultParams: {
    // Repaired distilled defaults: 1280x704 @ 25fps, 121 frames (8n+1 grid).
    width: 1280,
    height: 704,
    fps: 25,
    frames: 121,
    steps: getVideoModelProfile().steps,
    cfg: getVideoModelProfile().videoCfg,
  } satisfies VideoModelParams,
  resolutionPresets: [
    { label: "704p", width: 1280, height: 704 },
    { label: "720p", width: 1280, height: 720 },
    { label: "512p", width: 768, height: 512 },
    { label: "1080p", width: 1920, height: 1080 },
  ] satisfies ResolutionPreset[],
  durationPresets: [4, 6, 8, 10, 15, 20],
  fpsOptions: [16, 24, 25, 30],
};

/** Wan 2.2 lane display metadata (mirror of LTX_VIDEO_MODEL for the Wan lane). */
export const WAN_VIDEO_MODEL = {
  id: "wan-2.2-i2v",
  name: "Wan 2.2 I2V 14B",
  description: "Image-to-video with Wan 2.2 MoE experts + lightx2v v1022 distill LoRAs",
  supportsImageInput: true,
  supportsAudio: false,
  defaultParams: {
    width: 1280,
    height: 720,
    fps: 16,
    frames: 81,
    steps: 8,
    cfg: 3.5,
  } satisfies VideoModelParams,
  resolutionPresets: [
    { label: "720p", width: 1280, height: 720 },
  ] satisfies ResolutionPreset[],
  durationPresets: [3, 4, 5],
  fpsOptions: [16],
};

/** Calculate frame count from duration (seconds) and fps */
export function durationToFrames(seconds: number, fps: number): number {
  return Math.round(fps * seconds) + 1;
}

/** Calculate duration from frame count and fps */
export function framesToDuration(frames: number, fps: number): number {
  return (frames - 1) / fps;
}

/** Get VRAM estimate label for a resolution */
export function getVramEstimate(width: number, height: number): string {
  const pixels = width * height;
  if (pixels <= 768 * 512) return "~12GB";
  if (pixels <= 1280 * 720) return "~20GB";
  if (pixels <= 1920 * 1080) return "~28GB";
  return "~32GB+";
}
