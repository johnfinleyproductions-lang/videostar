// FrameForge — Lane Manifest
//
// Machine-readable catalog of the named creative lanes, for callers (the
// Evergreen Core cockpit, agents, scripts) that need to ENUMERATE lanes and
// pick one per cue without knowing profile ids. Served by GET /api/lanes;
// POST /api/generate accepts an optional "laneKey" that resolves through
// this manifest (an explicit "model" always wins — laneKey is additive and
// the public response contract is unchanged).
//
// A lane is a routing intent ("cinematic image motion", "humans/presenters",
// "transparent element") that maps onto one models.ts profile — or, for
// HV-HUMANS, onto a text profile plus an image-mode profile. One entry is a
// descriptor rather than an /api/generate lane:
//   - FINISH-STACK: the upscale finishers behind POST /api/finish
//                   (tier "review" = FlashVSR 2x, tier "hero" = SeedVR2
//                   1080p). Takes a rendered clip, not a prompt.
// MG-TYPE (Remotion motion graphics) used to be descriptor-only too; since
// 2026-07-16 it is a REAL /api/generate lane (profile "mg-type", kind
// "remotion") — the generate route proxies to the think render service
// (192.168.4.200:3070) and the status route polls it (see
// src/lib/remotion-client.ts). The render still happens on ANOTHER machine.
//
// DESIGN DECISION (hero variants): hv15-i2v is modeled as the imageMode of
// the single HV-HUMANS lane (imageModelId) rather than a separate lane — a
// caller picks "humans" once and the image decides t2v vs i2v, matching how
// resolveVideoModelId already treats the pair. Wan hero/FLF profiles are
// listed as `variants` of WAN-CINE (same locked recipe; the generate route
// auto-upgrades to FLF2V when an end image arrives).
//
// NOTE: this module imports workflow-builder (node:fs) for the camera-pose
// enum — treat it as server-side. Browsers should read GET /api/lanes.

import {
  DEFAULT_I2V_MODEL_ID,
  DEFAULT_VIDEO_MODEL_ID,
  VIDEO_MODEL_PROFILES,
  type VideoModelId,
  type VideoModelProfile,
} from "./models";
import type { VideoProfileKind } from "./types";
import { REMOTION_COMPOSITION_IDS } from "./remotion-client";
import {
  DEFAULT_CAMERA_POSE,
  FOLEY_MAX_SECONDS,
  MUSIC_DEFAULT_SECONDS,
  MUSIC_MAX_SECONDS,
  WAN_CAMERA_POSES,
} from "./workflow-builder";

export type LaneKey =
  | "WAN-CINE"
  | "WAN-CAMERA"
  | "VACE"
  | "LTX-FLASH"
  | "LTX-MASTER"
  | "LIP-SYNC"
  | "MG-TYPE"
  | "MG-ALPHA"
  | "MATTE"
  | "FOLEY"
  | "MUSIC"
  | "HV-HUMANS"
  | "FINISH-STACK";

/** How a lane is executed. */
export type LaneExecutor =
  | "generate" // POST /api/generate on this app (ComfyUI lanes + the
  //              Remotion MG-TYPE proxy lane — the render runs on think but
  //              the dispatch/status contract is this app's)
  | "finish"; // POST /api/finish on this app (upscale finishers)

/** An extra request parameter a lane understands beyond the shared body. */
export interface LaneExtraParam {
  name: string;
  type: "enum" | "string" | "number";
  /** Legal values when type === "enum". */
  values?: readonly string[];
  default?: string | number;
  /** The lane 400s without it (e.g. LIP-SYNC's audioUrl). Omitted = optional. */
  required?: boolean;
  description: string;
}

export interface LaneDescriptor {
  laneKey: LaneKey;
  title: string;
  /** One line: what it is and when to use it. */
  description: string;
  /** models.ts profile kind, or the descriptor-only "finish". */
  kind: VideoProfileKind | "finish";
  executor: LaneExecutor;
  /** App endpoint that runs the lane; null for external lanes. */
  endpoint: "/api/generate" | "/api/finish" | null;
  /** models.ts profile the lane maps to; null for descriptor-only lanes. */
  modelId: VideoModelId | null;
  /**
   * Image-mode profile: when the request carries a start image AND the lane
   * defines this, laneKey resolution picks it instead of modelId
   * (HV-HUMANS + imageUrl → hv15-i2v).
   */
  imageModelId?: VideoModelId;
  /** Sibling profiles sharing the lane's recipe, for explicit "model" calls. */
  variants?: { modelId: VideoModelId; when: string }[];
  /** Lane cannot run without a start image. */
  requiresImage: boolean;
  /** Lane can condition on a start image (requiresImage implies true). */
  acceptsImage: boolean;
  /** Lane ignores images entirely — prompt-only. */
  textOnly: boolean;
  supportsAudio: boolean;
  /**
   * Deliverable container: "audio-mp3" = an AUDIO file (MUSIC lane), no video
   * stream at all; "per-composition" = MG-TYPE, where the composition decides
   * (LowerThird → ProRes 4444 alpha .mov + alpha webm preview, TitleCard →
   * h264 mp4 — see the lane's `composition` extraParam).
   */
  outputFormat: "mp4" | "webm-alpha" | "audio-mp3" | "per-composition";
  /** Rough wall-clock estimate for a default-length clip (single 5090-class GPU). */
  typicalRenderMinutes: number;
  extraParams?: LaneExtraParam[];
}

/**
 * Look up a models.ts profile at module load — throws immediately if a
 * manifest modelId ever drifts from VIDEO_MODEL_PROFILES (belt to the
 * compile-time VideoModelId braces and the validate-lanes.mjs suspenders).
 */
function profile(id: VideoModelId): VideoModelProfile {
  const found = VIDEO_MODEL_PROFILES.find((p) => p.id === id);
  if (!found) {
    throw new Error(`lanes.ts: modelId "${id}" has no profile in models.ts`);
  }
  return found;
}

export const LANES: readonly LaneDescriptor[] = [
  {
    laneKey: "WAN-CINE",
    title: "Wan 2.2 Cinematic I2V",
    description:
      "Default image-to-video: bring a still to life with cinematic motion (Wan 2.2 14B distill recipe, 1280x720 @ 16fps + RIFE to 32fps).",
    kind: "wan-i2v",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "wan22-i2v-cinematic",
    variants: [
      {
        modelId: "wan22-i2v-hero",
        when: "Hero/product shots — same locked recipe, hero prompt framing.",
      },
      {
        modelId: "wan22-flf2v",
        when: "Start AND end frame supplied — the generate route auto-routes here when endImageUrl/endImage arrives.",
      },
    ],
    requiresImage: profile("wan22-i2v-cinematic").requiresImage === true,
    acceptsImage: true,
    textOnly: false,
    supportsAudio: profile("wan22-i2v-cinematic").includeAudio === true,
    outputFormat: "mp4",
    typicalRenderMinutes: 4,
  },
  {
    laneKey: "WAN-CAMERA",
    title: "Wan 2.2 Camera Move",
    description:
      "Deliberate camera motion on a still (pan / zoom / orbit): Wan 2.2 fun-camera experts with pose presets — use when the cue names a camera move.",
    kind: "wan-i2v",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "wan22-camera",
    variants: [
      {
        modelId: "wan22-camera-draft",
        when: "Fast 4-step draft (official lightx2v lora pair, cfg 1, ~4 min) to iterate on cameraMove/framing — reduced motion dynamics, re-run the main lane for the final.",
      },
    ],
    requiresImage: profile("wan22-camera").requiresImage === true,
    acceptsImage: true,
    textOnly: false,
    supportsAudio: profile("wan22-camera").includeAudio === true,
    outputFormat: "mp4",
    typicalRenderMinutes: 12,
    extraParams: [
      {
        name: "cameraMove",
        type: "enum",
        values: WAN_CAMERA_POSES,
        default: DEFAULT_CAMERA_POSE,
        description:
          'Camera pose preset. Friendly synonyms accepted ("push in", "orbit left", "ccw"); unknown values fall back to "Zoom In" — pass "Static" explicitly for a locked-off shot.',
      },
    ],
  },
  {
    // DESIGN DECISION (editing mode): the VACE footage-editing mode is a
    // VARIANT (vace-inpaint) of the one VACE lane rather than a second lane —
    // same experts, same recipe, one routing intent ("VACE it"). laneKey
    // "VACE" resolves to the reference mode; editing is requested with an
    // explicit model: "vace-inpaint" + videoUrl + maskUrl (an explicit model
    // always wins over laneKey, so callers pass both safely). The
    // videoUrl/maskUrl extraParams below document the editing contract.
    laneKey: "VACE",
    title: "Wan 2.2 Fun VACE (Identity Ref + Footage Edit)",
    description:
      "Two moves, one lane. REFERENCE-TO-VIDEO (default): a reference image of a person/product + a prompt → a NEW scene preserving that exact identity — the recurring-host lane (imageUrl is the identity reference, NOT a start frame; background-removed references lock identity best — the MATTE lane produces them). FOOTAGE EDITING (model \"vace-inpaint\"): an existing clip + a mask (white = regenerate) + a prompt → the masked region regenerated motion-matched (inpaint; outpaint via border mask), 16fps in/out, no RIFE.",
    kind: "wan-vace",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "vace-ref",
    variants: [
      {
        modelId: "vace-ref-draft",
        when: "Fast 4-step draft (official lightx2v 4-step lora pair, cfg 1) to iterate on prompt/framing — reduced motion dynamics, re-run vace-ref for the final.",
      },
      {
        modelId: "vace-inpaint",
        when: "FOOTAGE EDITING mode — pass model \"vace-inpaint\" with videoUrl AND maskUrl (see extraParams). Output stays 16fps (no RIFE) so the edit conforms back into the source timeline.",
      },
    ],
    requiresImage: profile("vace-ref").requiresImage === true,
    acceptsImage: true,
    textOnly: false,
    supportsAudio: profile("vace-ref").includeAudio === true,
    outputFormat: "mp4",
    typicalRenderMinutes: 12,
    extraParams: [
      {
        name: "videoUrl",
        type: "string",
        description:
          "vace-inpaint variant ONLY (400s without it there; ignored elsewhere): the footage to edit — an http-fetchable mp4/webm, or use `video` for a ComfyUI ref (input-dir path like \"jobs/<id>/clip.mp4\", or an annotated \"<subfolder>/<file> [output]\" path to edit one of our own renders). Input is resampled to Wan-native 16fps, wall-clock duration preserved.",
      },
      {
        name: "maskUrl",
        type: "string",
        description:
          "vace-inpaint variant ONLY (400s without it there): the edit mask — WHITE = regenerate, BLACK = keep. A mask VIDEO by default; a still image (png/jpg/webp) is applied to every frame automatically. `mask` accepts ComfyUI refs like `video` does.",
      },
    ],
  },
  {
    laneKey: "LTX-FLASH",
    title: "LTX 2.3 Flash AV",
    description:
      "Default text-to-video with native audio: fast single-stage distilled pass at 960x544 @ 24fps — the everyday text-only lane (optional start image).",
    kind: "ltx-template",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "ltx23-flash",
    requiresImage: false,
    acceptsImage: true,
    textOnly: false,
    supportsAudio: profile("ltx23-flash").includeAudio === true,
    outputFormat: "mp4",
    typicalRenderMinutes: 2,
  },
  {
    laneKey: "LTX-MASTER",
    title: "LTX 2.3 Master AV",
    description:
      "Hero text-to-video with native audio: two-stage distilled render (base + x2 latent-upsample refine) at 1920x1088 @ 24fps — pick for flagship AV cues, never a default.",
    kind: "ltx-template",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "ltx23-master",
    requiresImage: false,
    acceptsImage: true,
    textOnly: false,
    supportsAudio: profile("ltx23-master").includeAudio === true,
    outputFormat: "mp4",
    typicalRenderMinutes: 10,
  },
  {
    laneKey: "LIP-SYNC",
    title: "LTX 2.3 Lip-Sync AV",
    description:
      "Talking head from a presenter still + a voiceover file: LTX 2.3 audio-conditioned i2v pins the real VO in the AV latent and generates lip motion that matches it, 960x544 @ 24fps — duration comes from the audio (max 5.0s per clip for v1), the output mp4 carries the ORIGINAL VO. Pair with HV-HUMANS stills and VoxStation TTS.",
    kind: "ltx-template",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "ltx23-lipsync",
    requiresImage: profile("ltx23-lipsync").requiresImage === true,
    acceptsImage: true,
    textOnly: false,
    supportsAudio: profile("ltx23-lipsync").includeAudio === true,
    outputFormat: "mp4",
    typicalRenderMinutes: 3,
    extraParams: [
      {
        name: "audioUrl",
        type: "string",
        required: true,
        description:
          "REQUIRED http-fetchable voiceover, WAV or MP3, max 5.0s (121 frames @ 24fps) — the clip length derives from it and the original audio is muxed into the output. audioBase64 / audioPath are accepted alternatives. Longer VO → 400: split into lines and stitch.",
      },
    ],
  },
  {
    // MG-TYPE is a PROXY lane: /api/generate validates composition + props
    // here, dispatches to the think render service (192.168.4.200:3070,
    // ~/evergreen-remotion/server.mjs wrapping render.mjs), and /api/status
    // polls it via the history item's remoteJobId. The composition enum
    // below is the hardcoded mirror of the service's /health catalog (which
    // stays authoritative at dispatch time) — see REMOTION_COMPOSITIONS in
    // src/lib/remotion-client.ts for why it is not fetched per request.
    laneKey: "MG-TYPE",
    title: "Remotion Motion Graphics",
    description:
      "Typography / kinetic-text motion graphics rendered by Remotion on think (CPU, ~1 min): composition \"LowerThird\" = name/role lower third with REAL alpha (ProRes 4444 .mov deliverable + browser-playable VP8 alpha webm preview via previewUrl) — composite over any footage; composition \"TitleCard\" = opaque episode/section title card (h264 mp4) on the deep-teal house background. 1920x1080 @ 32fps, house teal/gold/cream design baked in. Deterministic render: the props ARE the content (prompt not used), no seed, perfectly repeatable.",
    kind: "remotion",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "mg-type",
    requiresImage: false,
    acceptsImage: false,
    textOnly: true,
    supportsAudio: false,
    outputFormat: "per-composition",
    typicalRenderMinutes: 1,
    extraParams: [
      {
        name: "composition",
        type: "enum",
        values: REMOTION_COMPOSITION_IDS,
        required: true,
        description:
          'Which Remotion composition to render (no default — the lane 400s without it). "LowerThird": 5s transparent name/role third (delivers ProRes 4444 alpha .mov + alpha webm preview). "TitleCard": 6s opaque title card (delivers h264 mp4). The live list: GET http://192.168.4.200:3070/health.',
      },
      {
        name: "title",
        type: "string",
        required: true,
        description:
          'Main serif line — the person\'s name (LowerThird, e.g. "Alex Hormozi") or the episode title (TitleCard, e.g. "The Real Story of Alex Hormozi").',
      },
      {
        name: "subtitle",
        type: "string",
        required: true,
        description:
          'Tracked upper-case kicker under the title — role/company (LowerThird, e.g. "FOUNDER, ACQUISITION.COM") or the hook line (TitleCard, e.g. "HE GAVE IT ALL AWAY").',
      },
      {
        name: "accentColor",
        type: "string",
        description:
          'LowerThird only (ignored by TitleCard): CSS color for the accent bar + subtitle. Default = Evergreen gold "#d4a94e".',
      },
      {
        name: "credit",
        type: "string",
        description:
          "TitleCard only (ignored by LowerThird): small tracked credit line at the bottom of the frame. Omitted = no credit row.",
      },
    ],
  },
  {
    laneKey: "MG-ALPHA",
    title: "Wan-Alpha RGBA Elements",
    description:
      "Transparent overlay elements (logo stings, smoke/glass/glow, particles, wipes): dual RGB+alpha VAE decode to VP9 webm with real alpha — pick when the clip must composite over other footage.",
    kind: "wan-alpha",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "wan-alpha-rgba",
    requiresImage: false,
    acceptsImage: false,
    textOnly: true,
    supportsAudio: profile("wan-alpha-rgba").includeAudio === true,
    outputFormat: "webm-alpha",
    typicalRenderMinutes: 10,
  },
  {
    laneKey: "MATTE",
    title: "MatAnyone Matte (Footage → Alpha)",
    description:
      "Real-footage keying, no green screen: an existing video of a person/subject → a transparent-background VP9 webm with REAL alpha, source fps and audio preserved end-to-end. The first-frame seed mask is OPTIONAL: omit it and the graph auto-masks the subject (first frame → BiRefNet person/subject segmentation → MatAnyone2 seed); supply one (white = subject, black = background; a rough brush-over works — MatAnyone2 regenerates a clean matte during warmup, then propagates it) to pick a specific subject. A TRANSFORM lane: no prompt needed, never RIFE'd. Feeds the VACE reference lane (background-removed identity refs) and any composite.",
    kind: "matte",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "matanyone-matte",
    requiresImage: false,
    acceptsImage: false,
    textOnly: false,
    supportsAudio: profile("matanyone-matte").includeAudio === true,
    outputFormat: "webm-alpha",
    typicalRenderMinutes: 4,
    extraParams: [
      {
        name: "videoUrl",
        type: "string",
        required: true,
        description:
          "REQUIRED: the footage to matte — an http-fetchable mp4/webm, or use `video` for a ComfyUI ref (input-dir path like \"jobs/<id>/clip.mp4\", or an annotated \"<subfolder>/<file> [output]\" path to matte one of our own renders). videoPath (local file on the FrameForge host) also accepted. Max 30s per clip (longer → 400: cut it first).",
      },
      {
        name: "maskUrl",
        type: "string",
        description:
          "Optional first-frame seed mask — auto person-mask when omitted (first loaded frame → BiRefNetRMBG BiRefNet-general salient person/subject segmentation → MatAnyone2 seed; first-ever auto run downloads the 885MB weights from HF once). Supply one to pick a SPECIFIC subject: a STILL image (png/jpg/webp/bmp; a video mask → 400), WHITE = subject, BLACK = background. Only a seed: MatAnyone2's warmup regenerates a clean matte from it before propagating, so rough coverage of the subject in frame 1 is enough. maskPath / mask (ComfyUI ref) also accepted.",
      },
      {
        name: "fps",
        type: "number",
        description:
          "Optional resample rate (1-60). Omitted = the source fps is preserved end-to-end (frame_rate is wired from the clip's own VideoInfo inside the graph — no probe needed). NOTE: without fps the defensive 30s cap assumes 30fps (900 frames), so a 60fps source gets ~15s — pass fps=60 to keep it native-rate for the full 30s, or fps=30 to resample it.",
      },
      {
        name: "duration",
        type: "number",
        default: 30,
        description:
          "Optional trim (seconds from the start; frame_load_cap patched). Values above 30 → 400 (MATTE_MAX_SECONDS) — cut longer footage before matting.",
      },
    ],
  },
  {
    laneKey: "FOLEY",
    title: "HunyuanVideo-Foley SFX (Footage → Footage + Sound)",
    description:
      "Sound design for existing footage: a (usually silent) clip → the SAME clip back as an mp4 with synchronized sound effects/ambience muxed on (HunyuanVideo-Foley, 48kHz, frame-accurate sync via Synchformer @25fps + SigLIP2 content analysis). The prompt is an OPTIONAL HINT — a short phrase like \"boots crunching on gravel\" or \"rain on a tin roof\" steers the SFX; omit it entirely for pure video-driven foley. The generated track REPLACES any source audio (layer under dialogue in the edit instead). Source fps preserved end-to-end; frames re-encoded once (h264 crf 19). Scores renders from every other lane — pair with MUSIC for a bed.",
    kind: "foley",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "foley-sfx",
    requiresImage: false,
    acceptsImage: false,
    textOnly: false,
    supportsAudio: profile("foley-sfx").includeAudio === true,
    outputFormat: "mp4",
    // 50-step sampler on the ~10GB bf16 model; first-EVER run adds the
    // one-time SigLIP2+CLAP HF download (~3.5GB) on top.
    typicalRenderMinutes: 4,
    extraParams: [
      {
        name: "videoUrl",
        type: "string",
        required: true,
        description:
          `REQUIRED: the footage to score — an http-fetchable mp4/webm, or use \`video\` for a ComfyUI ref (input-dir path like "jobs/<id>/clip.mp4", or an annotated "<subfolder>/<file> [output]" path to foley one of our own renders). videoPath (local file on the FrameForge host) also accepted. Max ${FOLEY_MAX_SECONDS}s per clip (HunyuanVideo-Foley's ~15s training window; longer → 400: cut it first).`,
      },
      {
        name: "prompt",
        type: "string",
        description:
          "OPTIONAL sound hint (unlike every generation lane, no prompt is fine here): a short SFX/ambience phrase — \"boots crunching on gravel\", \"gentle rain, distant thunder\". Omitted/empty = pure video-driven foley: the model reads the motion and content of the frames alone. negativePrompt also accepted (default \"noisy, harsh\").",
      },
      {
        name: "duration",
        type: "number",
        default: FOLEY_MAX_SECONDS,
        description:
          `Optional trim (seconds from the start; frame_load_cap patched — the generated audio length follows the loaded frames automatically). Values above ${FOLEY_MAX_SECONDS} → 400 (FOLEY_MAX_SECONDS) — cut longer footage before scoring it.`,
      },
    ],
  },
  {
    laneKey: "MUSIC",
    title: "ACE-Step 1.5 Music Bed",
    description:
      "Local music generation — the AUDIO lane: style/genre tags (the prompt) + optional lyrics → an mp3 music bed (up to 240s, default 60s; instrumental unless lyrics are passed). ACE-Step 1.5 turbo, 8-step recipe. The deliverable is an AUDIO file, not video — score renders from the other lanes with it in the edit.",
    kind: "audio",
    executor: "generate",
    endpoint: "/api/generate",
    // TEMPORARY DEFAULT SWAP (adversarial verify, 2026-07-14): the intended
    // quality default is music-bed (9.5GB XL turbo), but the box's current
    // ComfyUI build cannot shape-detect the XL checkpoint — UNETLoader dies
    // with a size mismatch (2560 vs 2048; reproduced live, see ACE15_MODELS
    // in models.ts). Defaulting the lane to XL would make every plain
    // laneKey-MUSIC dispatch fail at execution, so the WORKING 4.5GB base
    // turbo is the lane default until the next ComfyUI update on vidbox.
    // After the update: verify music-bed loads, then swap modelId back to
    // "music-bed" and restore music-bed-draft as the variant.
    modelId: "music-bed-draft",
    variants: [
      {
        modelId: "music-bed",
        when: "The quality final bed on the 9.5GB XL turbo model (same 8-step recipe). BLOCKED until the next ComfyUI update on the box — the current build cannot shape-detect the XL checkpoint (UNETLoader size mismatch, reproduced live 2026-07-14; see ACE15_MODELS in models.ts). Until then every MUSIC render runs on the default 4.5GB base turbo.",
      },
    ],
    requiresImage: false,
    acceptsImage: false,
    textOnly: true,
    supportsAudio: profile("music-bed").includeAudio === true,
    outputFormat: "audio-mp3",
    typicalRenderMinutes: 2,
    extraParams: [
      {
        name: "lyrics",
        type: "string",
        description:
          "Optional lyrics with [Verse]/[Chorus]/[Bridge]-style structure markers (official ACE-Step convention). Omitted → \"[instrumental]\" — a clean vocals-free music bed. Language is template-locked to English tags/lyrics conditioning.",
      },
      {
        name: "duration",
        type: "number",
        default: MUSIC_DEFAULT_SECONDS,
        description:
          `Seconds of music (1..${MUSIC_MAX_SECONDS}; above ${MUSIC_MAX_SECONDS} → 400). Patched onto the audio latent AND the encoder's duration conditioning in lockstep. Longer beds: generate sections and crossfade in the edit.`,
      },
    ],
  },
  {
    laneKey: "HV-HUMANS",
    title: "HunyuanVideo 1.5 Humans",
    description:
      "Best local human faces/presenters + short legible in-video text (ByT5 glyph encoder), 1280x720 @ 24fps — text-to-video by default; send imageUrl to animate a person from a still (auto-switches to the I2V profile).",
    kind: "hv-template",
    executor: "generate",
    endpoint: "/api/generate",
    modelId: "hv15-t2v",
    imageModelId: "hv15-i2v",
    variants: [
      {
        modelId: "hv15-hero",
        when: "Flagship presenter cues — same base recipe + the official 1080p SR distilled second stage (1920x1080, corrected faces, ~2x render time). Explicit model pick, never the lane default.",
      },
      {
        modelId: "hv15-hero-i2v",
        when: "Hero 1080p SR from a start image — pass model \"hv15-hero-i2v\" WITH imageUrl (the SR stage re-pins the start frame at 1080p, which is the face-correction mechanism).",
      },
    ],
    requiresImage: false,
    acceptsImage: true,
    textOnly: false,
    supportsAudio: profile("hv15-t2v").includeAudio === true,
    outputFormat: "mp4",
    typicalRenderMinutes: 15,
  },
  {
    laneKey: "FINISH-STACK",
    title: "Finish Stack (Upscale Finishers)",
    description:
      "Post pass on an ALREADY-RENDERED clip via POST /api/finish: tier \"review\" = FlashVSR 2x fast check, tier \"hero\" = SeedVR2 7B-sharp 1080p delivery — takes a fileUrl, not a prompt.",
    kind: "finish",
    executor: "finish",
    endpoint: "/api/finish",
    modelId: null,
    requiresImage: false,
    acceptsImage: false,
    textOnly: false,
    supportsAudio: false,
    outputFormat: "mp4",
    typicalRenderMinutes: 6,
    extraParams: [
      {
        name: "tier",
        type: "enum",
        values: ["review", "hero"],
        default: "review",
        description:
          "review = FlashVSR 2x (~2 min, fast check); hero = SeedVR2 v2.5 1080p (~10 min, delivery quality).",
      },
      {
        name: "fps",
        type: "number",
        default: 32,
        description:
          "MUST match the input clip's fps (RIFE'd Wan finals = 32, raw Wan = 16, LTX/HV = 24) — the finishers preserve frame count.",
      },
    ],
  },
];

/** Default lane picks, mirroring models.ts routing defaults. */
export const DEFAULT_TEXT_LANE: LaneKey = "LTX-FLASH";
export const DEFAULT_IMAGE_LANE: LaneKey = "WAN-CINE";

// Sanity: the lane defaults must stay aligned with the models.ts defaults.
if (
  profile(DEFAULT_VIDEO_MODEL_ID).id !==
    LANES.find((l) => l.laneKey === DEFAULT_TEXT_LANE)?.modelId ||
  profile(DEFAULT_I2V_MODEL_ID).id !==
    LANES.find((l) => l.laneKey === DEFAULT_IMAGE_LANE)?.modelId
) {
  throw new Error("lanes.ts: DEFAULT_*_LANE out of sync with models.ts defaults");
}

/** Case-insensitive lane lookup ("hv-humans" works). */
export function getLane(laneKey: string): LaneDescriptor | undefined {
  const key = laneKey.trim().toUpperCase();
  return LANES.find((lane) => lane.laneKey === key);
}

/**
 * Resolve a lane to the models.ts profile id to request, given whether the
 * request carries a start image (HV-HUMANS + image → hv15-i2v). Returns null
 * for the descriptor-only lane (FINISH-STACK) — callers must reject it
 * before dispatching to /api/generate. The result still flows through
 * resolveVideoModelId(), so lane picks obey the same image-routing rules as
 * explicit model ids.
 */
export function resolveLaneModelId(
  lane: LaneDescriptor,
  hasImage: boolean,
): VideoModelId | null {
  if (!lane.modelId) return null;
  if (hasImage && lane.imageModelId) return lane.imageModelId;
  return lane.modelId;
}
