// FrameForge — Type Definitions

export type VideoGenerationStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

/**
 * Which generation lane a model profile drives.
 * - "wan-i2v":      Wan 2.2 image-to-video (native ComfyUI Wan nodes, template lane)
 * - "wan-alpha":    Wan 2.1 T2V 14B + Wan-Alpha LoRA RGBA transparent elements
 *                   (template lane; dual RGB/alpha VAE decode → VP9 webm with
 *                   a real alpha channel). MUST stay distinct from "wan-i2v":
 *                   the RIFE post job gates on kind === "wan-i2v" and its VHS
 *                   re-encode to mp4 would destroy the alpha channel.
 * - "ltx":          LTX-Video 2.3 on ComfyUI (programmatic graph builder)
 * - "ltx-template": LTX 2.3 template lane (API-format workflow JSON patched by
 *                   title, like the Wan lane — e.g. the single-stage Flash AV
 *                   distilled recipe with native audio at 24fps)
 * - "hv-template":  HunyuanVideo 1.5 720p template lane (best local human
 *                   faces/presenters + short in-video text via the ByT5 glyph
 *                   encoder). 24fps native, delivery-ready — MUST stay
 *                   distinct from "wan-i2v": the RIFE post job gates on
 *                   kind === "wan-i2v" and interpolating 24fps→32fps output
 *                   would only soften faces. Explicit selection only.
 * - "wan-vace":     Wan 2.2 Fun VACE reference-to-video (template lane; a
 *                   reference image pins the identity of a person/product
 *                   while the prompt drives a NEW scene). 16fps Wan-native
 *                   output — the RIFE post gate DELIBERATELY includes this
 *                   kind (16→32fps), matching the other Wan delivery lanes.
 * - "wan-vace-edit": Wan 2.2 Fun VACE footage editing (inpaint/outpaint an
 *                   existing clip via control_video + control_masks). MUST
 *                   stay distinct from "wan-vace"/"wan-i2v": the output has
 *                   to stay fps-continuous with the source clip (input is
 *                   resampled to 16fps, wall-clock duration preserved) — a
 *                   RIFE pass would change the fps away from the edit
 *                   round-trip contract, so the post gate excludes it.
 * - "matte":        MatAnyone2 real-footage keying (template lane; existing
 *                   video + first-frame seed mask → transparent-background
 *                   VP9 webm with real alpha, no green screen). A TRANSFORM
 *                   lane, not generation: no prompt, no sampler, no seed —
 *                   the source clip's fps and audio pass straight through.
 *                   MUST stay distinct from "wan-i2v"/"wan-vace": the RIFE
 *                   post gate keys on those kinds, and its VHS mp4 re-encode
 *                   would both destroy the alpha channel and break the
 *                   source-fps continuity that is this lane's whole contract.
 * - "foley":        HunyuanVideo-Foley sound design (FOLEY lane, template
 *                   lane): an existing (usually silent) video + an OPTIONAL
 *                   text hint in, the SAME clip delivered as an mp4 with
 *                   synchronized 48kHz SFX/ambience muxed on. A TRANSFORM of
 *                   footage like "matte" (video required, never a default,
 *                   exempt from the image reroute) but with a SAMPLER in the
 *                   graph (prompt/seed/cfg exist — the prompt is an optional
 *                   hint, not required). MUST stay distinct from
 *                   "wan-i2v"/"wan-vace": the RIFE post gate keys on those
 *                   kinds, and interpolating would change the frame timing
 *                   the generated audio was synced against (and the VHS
 *                   re-encode would strip the new track).
 * - "audio":        ACE-Step 1.5 local music generation (MUSIC lane, template
 *                   lane): style/genre tags (+ optional lyrics) in, an mp3
 *                   music bed out — the only lane whose deliverable is an
 *                   AUDIO file, not video. Prompt required (the tags);
 *                   imageUrl/videoUrl are ignored, never rerouted (exempt
 *                   from the image reroute in resolveVideoModelId, like
 *                   "matte" — rerouting would silently swap an mp3
 *                   deliverable for a generated mp4). MUST never join the
 *                   RIFE post gate: there are no frames to interpolate, and
 *                   the gate keys on the Wan kinds anyway. Never a default;
 *                   explicit selection only.
 * - "ltx-desktop":  LTX Desktop sidecar process (non-ComfyUI backend)
 * - "remotion":     Remotion motion-graphics executor (MG-TYPE lane): a
 *                   deterministic React/Remotion CPU render on think
 *                   (192.168.4.200:3070 — see src/lib/remotion-client.ts),
 *                   NOT ComfyUI and NOT this box. Composition props (title,
 *                   subtitle, …) in; LowerThird → ProRes 4444 alpha .mov
 *                   (+ VP8 alpha webm preview), TitleCard → h264 mp4 out.
 *                   Exempt from the image reroute (a stray image is ignored
 *                   — rerouting would swap a typographic deliverable for a
 *                   generated clip) and MUST never join the RIFE post gate:
 *                   motion-graphics interpolation would smear the typography,
 *                   and the .mov/.webm deliverables live on think, not in the
 *                   ComfyUI output dir. Never a default; explicit selection
 *                   only.
 */
export type VideoProfileKind =
  | "wan-i2v"
  | "wan-alpha"
  | "wan-vace"
  | "wan-vace-edit"
  | "matte"
  | "foley"
  | "audio"
  | "ltx"
  | "ltx-template"
  | "hv-template"
  | "ltx-desktop"
  | "remotion";

/**
 * Frame-grid family: Wan needs 4n+1 frame counts, LTX needs 8n+1, and
 * HunyuanVideo 1.5 needs 4n+1 (EmptyHunyuanVideo15Latent length step 4,
 * default 25 — verified against live object_info).
 */
export type FrameGridFamily = "wan" | "ltx" | "hv";

// ---------------------------------------------------------------------------
// ComfyUI graph shapes (API format)
// ---------------------------------------------------------------------------

export interface ComfyWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  /** ComfyUI API-format exports carry the UI node title here. */
  _meta?: { title?: string };
}

export type ComfyWorkflow = Record<string, ComfyWorkflowNode>;

/** Parameters for building a Wan 2.2 I2V / FLF2V graph from a template. */
export interface WanI2VBuildParams {
  /** Parsed workflow template (API format) — see loadTemplate(). */
  template: ComfyWorkflow;
  prompt: string;
  /** Falls back to the canonical Wan negative prompt when empty/omitted. */
  negative?: string;
  /** Filename already present in the ComfyUI input folder (start frame). */
  imageName: string;
  /** Optional last frame — requires a template with an end-image node (FLF2V). */
  endImageName?: string;
  /**
   * Optional camera move (fun-camera lane). Friendly synonyms are resolved to
   * the WanCameraEmbedding camera_pose enum (see resolveCameraPose); applied
   * only when the template carries an "FF Camera" node, otherwise ignored.
   */
  cameraMove?: string;
  /** Frame count; snapped to the Wan 4n+1 grid. */
  length: number;
  seed: number;
  /** Optional overrides; the template's locked 1280x720 is used when omitted. */
  width?: number;
  height?: number;
}

/** Parameters for building a Wan-Alpha RGBA element graph from a template. */
export interface WanAlphaBuildParams {
  /** Parsed workflow template (API format) — see loadTemplate(). */
  template: ComfyWorkflow;
  prompt: string;
  /** Falls back to the canonical Wan negative prompt when empty/omitted. */
  negative?: string;
  /** Frame count; snapped to the Wan 4n+1 grid. */
  length: number;
  seed: number;
  /** Optional overrides (snapped to the 16px latent grid); template-locked 832x480 when omitted. */
  width?: number;
  height?: number;
}

/** Parameters for building a Wan 2.2 Fun VACE reference-to-video graph. */
export interface VaceRefBuildParams {
  /** Parsed workflow template (API format) — see loadTemplate(). */
  template: ComfyWorkflow;
  prompt: string;
  /** Falls back to the canonical Wan negative prompt when empty/omitted. */
  negative?: string;
  /**
   * REQUIRED identity reference (filename in the ComfyUI input folder) —
   * a person/product image, NOT a start frame. Background-removed references
   * lock identity better (usage guidance; removal is out of scope here).
   */
  referenceImageName: string;
  /** Frame count; snapped to the Wan 4n+1 grid. */
  length: number;
  seed: number;
  /** Optional overrides (snapped to the 16px WanVaceToVideo grid); template-locked 1280x720 when omitted. */
  width?: number;
  height?: number;
}

/** Parameters for building a Wan 2.2 Fun VACE footage-editing graph. */
export interface VaceInpaintBuildParams {
  /** Parsed workflow template (API format) — see loadTemplate(). */
  template: ComfyWorkflow;
  prompt: string;
  /** Falls back to the canonical Wan negative prompt when empty/omitted. */
  negative?: string;
  /**
   * REQUIRED footage to edit: a VHS_LoadVideo-resolvable ref — either an
   * input-dir path ("jobs/<id>/clip.mp4", uploaded via uploadInputVideo) or
   * an annotated "<subfolder>/<file> [output]" path for editing our own
   * renders (see toAnnotatedOutputPath).
   */
  videoName: string;
  /**
   * REQUIRED edit mask: WHITE = regenerate, BLACK = keep. A mask VIDEO by
   * default; when maskIsImage is true this is a still image and the builder
   * swaps the loader to LoadImage + RepeatImageBatch(length).
   */
  maskName: string;
  /** True when maskName is a still image (png/jpg/webp/bmp), not a video. */
  maskIsImage: boolean;
  /** Frame count; snapped to the Wan 4n+1 grid. */
  length: number;
  seed: number;
  /** Optional overrides (snapped to the 16px WanVaceToVideo grid); template-locked 1280x720 when omitted. */
  width?: number;
  height?: number;
}

/** Parameters for building a MatAnyone matte graph (MATTE transform lane). */
export interface MatAnyoneBuildParams {
  /** Parsed workflow template (API format) — see loadTemplate(). */
  template: ComfyWorkflow;
  /**
   * REQUIRED footage to matte: a VHS_LoadVideo-resolvable ref — either an
   * input-dir path ("jobs/<id>/clip.mp4", uploaded via uploadInputVideo) or
   * an annotated "<subfolder>/<file> [output]" path for matting our own
   * renders (same contract as the VACE edit lane).
   */
  videoName: string;
  /**
   * OPTIONAL first-frame seed mask: a STILL image (filename in the ComfyUI
   * input folder), WHITE = subject, BLACK = background. Only a seed —
   * MatAnyone2's warmup regenerates a clean matte before propagating.
   * When OMITTED the builder swaps the LoadImage branch for an auto
   * person/subject mask: ImageFromBatch(first loaded frame) → BiRefNetRMBG
   * (BiRefNet-general) MASK output → MatAnyone2.foreground_MASK.
   */
  maskName?: string;
  /**
   * Optional explicit fps (1..60, the VHS_LoadVideo force_rate range). When
   * set, the input is RESAMPLED to this rate (force_rate) and the output webm
   * is encoded at it (frame_rate patched over the VideoInfo link) — wall-clock
   * duration preserved, original audio untouched. When omitted, the source
   * fps is preserved end-to-end: force_rate stays 0 and the template's
   * frame_rate link from "FF Video Info" carries the real loaded fps.
   */
  fps?: number;
  /**
   * REQUIRED frame_load_cap for the loader (defensive length cap — see
   * matteFrameCap / MATTE_MAX_SECONDS). Counts frames AFTER force_rate.
   */
  frameCap: number;
}

/** Parameters for building a HunyuanVideo-Foley graph (FOLEY sound-design lane). */
export interface FoleyBuildParams {
  /** Parsed workflow template (API format) — see loadTemplate(). */
  template: ComfyWorkflow;
  /**
   * REQUIRED footage to foley: a VHS_LoadVideo-resolvable ref — either an
   * input-dir path ("jobs/<id>/clip.mp4", uploaded via uploadInputVideo) or
   * an annotated "<subfolder>/<file> [output]" path for scoring one of our
   * own renders (same contract as the VACE edit / MATTE lanes).
   */
  videoName: string;
  /**
   * OPTIONAL text hint steering the SFX ("boots crunching on gravel",
   * "rain on a tin roof"). Omitted/empty → pure video-driven foley: the
   * sampler encodes the empty string unconditionally and the SigLIP2 +
   * Synchformer visual features carry the conditioning (verified in the
   * pack's nodes.py). ALWAYS patched — the template ships prompt "" so the
   * pack's widget default can never leak in.
   */
  prompt?: string;
  /**
   * Optional negative hint. Omitted/empty keeps the template-locked pack
   * default ("noisy, harsh").
   */
  negative?: string;
  /**
   * Patched onto the sampler `seed` (drives both the flow-matching noise —
   * a torch.Generator in the pack — and reproducibility).
   */
  seed: number;
  /**
   * REQUIRED frame_load_cap for the loader (defensive length cap — see
   * foleyFrameCap / FOLEY_MAX_SECONDS). The sampler's fps AND duration stay
   * LINK-WIRED from "FF Video Info", so capping the loaded frames is the
   * single knob that caps the generated audio too.
   */
  frameCap: number;
}

/** Parameters for building an ACE-Step 1.5 MUSIC graph (audio lane). */
export interface AceStepBuildParams {
  /** Parsed workflow template (API format) — see loadTemplate(). */
  template: ComfyWorkflow;
  /**
   * Style/genre tags — the request prompt, verbatim (comma phrases or free
   * prose both work; the official templates ship both styles). REQUIRED.
   */
  tags: string;
  /**
   * Optional lyrics with [Verse]/[Chorus]-style structure markers. Omitted /
   * empty → "[instrumental]" (the official ACE-Step no-vocals convention,
   * shipped verbatim by the v1 t2a_instrumentals template) so the default
   * deliverable is a clean instrumental music bed.
   */
  lyrics?: string;
  /**
   * Clip length in seconds (MUSIC_MIN_SECONDS..MUSIC_MAX_SECONDS). Patched
   * onto BOTH the EmptyAceStep1.5LatentAudio seconds and the
   * TextEncodeAceStepAudio1.5 duration input — the encoder conditions the
   * audio-codes LLM on the length, so the two must stay in lockstep (the
   * official template link-wires them from one Primitive for the same
   * reason).
   */
  seconds: number;
  /**
   * Patched onto the stock KSampler `seed` AND the encoder's own `seed`
   * (the audio-codes LLM samples with it) — lockstep for reproducibility.
   */
  seed: number;
  /**
   * UNET filename patched onto "FF Model" (the draft-variant switch):
   * profile checkpoint — acestep_v1.5_xl_turbo_bf16 (music-bed) or
   * acestep_v1.5_turbo (music-bed-draft). Omitted = template default (XL).
   */
  unetName?: string;
}

/** Parameters for building a HunyuanVideo 1.5 720p graph from a template. */
export interface Hv15BuildParams {
  /** Parsed workflow template (API format) — see loadTemplate(). */
  template: ComfyWorkflow;
  prompt: string;
  /**
   * Optional negative prompt. HV 1.5 has no canonical negative — the official
   * ComfyUI template ships an empty negative at cfg 6, so empty/omitted stays
   * empty (no Wan/LTX-style fallback).
   */
  negative?: string;
  /**
   * Start frame (filename in the ComfyUI input folder). REQUIRED when the
   * template carries an "FF Start Image" node (hv15_i2v.json); ignored by the
   * t2v template (explicit selection is honored, a stray image is dropped).
   */
  imageName?: string;
  /** Frame count; snapped to the HV 4n+1 grid (121 ≈ 5s @ 24fps). */
  length: number;
  seed: number;
  /** Optional overrides (snapped to the 16px latent grid); template-locked 1280x720 when omitted. */
  width?: number;
  height?: number;
}

/** Parameters for building an LTX template-lane graph (Flash/Master). */
export interface LtxTemplateBuildParams {
  /** Parsed workflow template (API format) — see loadTemplate(). */
  template: ComfyWorkflow;
  prompt: string;
  /** Falls back to the canonical LTX negative prompt when empty/omitted. */
  negative?: string;
  /**
   * Optional start frame (filename in the ComfyUI input folder). When present
   * the template's LTXVImgToVideoConditionOnly bypass is forced OFF (i2v);
   * when absent it is forced ON (pure t2v).
   */
  imageName?: string;
  /** Frame count; snapped to the LTX 8n+1 grid. */
  length: number;
  seed: number;
  /** Optional overrides; the template's locked 960x544 is used when omitted. */
  width?: number;
  height?: number;
}

/** Parameters for building the LTX 2.3 LIP-SYNC graph (audio-conditioned i2v). */
export interface LtxLipsyncBuildParams {
  /** Parsed workflow template (API format) — see loadTemplate(). */
  template: ComfyWorkflow;
  prompt: string;
  /** Falls back to the canonical LTX negative prompt when empty/omitted. */
  negative?: string;
  /** REQUIRED presenter still (filename in the ComfyUI input folder). */
  imageName: string;
  /**
   * REQUIRED voiceover (filename in the ComfyUI input folder, wav/mp3 —
   * uploaded via uploadInputAudio). Patched onto the "FF Audio" LoadAudio
   * node; the SAME loaded audio is muxed into the output mp4 by CreateVideo,
   * so the delivered audio track is the original VO, not a re-synthesis.
   */
  audioName: string;
  /**
   * Frame count derived from the audio duration (see lipsyncAudioToFrames):
   * ceil'd to the LTX 8n+1 grid so the video covers the whole VO. Callers
   * must have enforced the LTX_LIPSYNC_MAX_FRAMES cap already.
   */
  length: number;
  seed: number;
  /** Optional overrides; the template's locked 960x544 is used when omitted. */
  width?: number;
  height?: number;
}

export interface VideoModelParams {
  width: number;
  height: number;
  fps: number;
  frames: number;
  steps: number;
  cfg: number;
}

export interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
}

export interface VideoGenerationItem {
  id: string;
  status: VideoGenerationStatus;
  prompt: string;
  url?: string;
  thumbnailUrl?: string;
  error?: string;
  createdAt: string;
  comfyPromptId?: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
  resolution: string;
  progress?: number;
  sourceImageUrl?: string;
  /** End-frame image (FLF2V lane), filename in the ComfyUI input folder. */
  endImageUrl?: string;
  /** Voiceover source (LIP-SYNC lane): the request's audioUrl, or the uploaded audio ref. */
  sourceAudioUrl?: string;
  /** Footage source (VACE edit lane): the request's videoUrl, or the resolved video ref. */
  sourceVideoUrl?: string;
  /** Edit mask source (VACE edit lane): the request's maskUrl, or the resolved mask ref. */
  sourceMaskUrl?: string;
  seed?: number;
  filename?: string;
  model?: string;
  modelName?: string;
  // --- Finisher jobs (/api/finish: FlashVSR / SeedVR2 upscale) ---
  /**
   * Job family. "finish" = a follow-on upscale job on an already-rendered
   * clip; the status route MUST NOT submit the RIFE post job for these
   * (they are single-stage — see the kind gate in /api/status/[id]).
   * "remotion" = an MG-TYPE job running on the think render service; the
   * status route polls think (via remoteJobId) instead of ComfyUI history,
   * and the RIFE gate never sees it.
   */
  kind?: "finish" | "remotion";
  // --- Remotion jobs (MG-TYPE lane on the think render service) ---
  /** think render-service job id (GET :3070/jobs/<remoteJobId>). */
  remoteJobId?: string;
  /**
   * Browser-playable VP8 alpha webm preview (LowerThird only — the primary
   * url is a ProRes 4444 .mov browsers cannot decode). Additive field; the
   * public {id,status,progress,url,filename} contract is unchanged.
   */
  previewUrl?: string;
  /** Finisher tier: "review" = FlashVSR fast pass, "hero" = SeedVR2 quality. */
  tier?: "review" | "hero";
  // --- Two-job pipeline (Wan lanes: generate → RIFE post-process) ---
  /** Which pipeline stage this job is in ("main" = generation, "post" = RIFE). */
  stage?: "main" | "post";
  /** ComfyUI prompt id of the post-processing (RIFE) job, once submitted. */
  postPromptId?: string;
  /** Stage-1 output URL kept as the graceful-degradation fallback. */
  stageOneUrl?: string;
  /** Stage-1 output filename kept as the graceful-degradation fallback. */
  stageOneFilename?: string;
  /** Non-fatal problem (e.g. post-processing failed; stage-1 clip returned). */
  warning?: string;
}

export interface VideoCreation {
  id: string;
  url: string;
  thumbnailUrl?: string;
  prompt?: string;
  createdAt: string;
  status?: VideoGenerationStatus;
  error?: string;
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  duration?: number;
  resolution?: string;
  progress?: number;
  sourceImageUrl?: string;
  seed?: number;
  filename?: string;
  model?: string;
  modelName?: string;
  isSessionItem?: boolean;
}

export interface GenerateRequest {
  prompt: string;
  width: number;
  height: number;
  fps: number;
  duration: number; // seconds
  seed?: number;
  sourceImage?: string; // filename in ComfyUI input folder
  /** Optional last-frame image (filename in ComfyUI input folder) → FLF2V lane. */
  endImage?: string;
  /**
   * Optional camera move for the Wan 2.2 fun-camera lane ("wan22-camera").
   * Friendly names ("push in", "orbit left", …) resolve to the
   * WanCameraEmbedding camera_pose enum; unknown values default to "Zoom In".
   */
  cameraMove?: string;
  model?: string;
}

export interface GenerateResponse {
  id: string;
  comfyPromptId: string;
  /** ComfyUI websocket client id ("" for the LTX Desktop sidecar lane). */
  clientId: string;
  status: VideoGenerationStatus;
}

export interface StatusResponse {
  id: string;
  status: VideoGenerationStatus;
  progress?: number;
  url?: string;
  filename?: string;
  error?: string;
  /** Non-fatal problem (e.g. RIFE post failed; stage-1 clip returned). */
  warning?: string;
  /** MG-TYPE LowerThird only: browser-playable VP8 alpha webm preview. */
  previewUrl?: string;
}
