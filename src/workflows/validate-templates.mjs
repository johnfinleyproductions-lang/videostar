#!/usr/bin/env node
/**
 * validate-templates.mjs — dependency-free structural validator for the
 * ComfyUI API-format workflow templates in this directory.
 *
 * Checks, per template:
 *   1. File parses as JSON and every node has class_type + inputs.
 *   2. Every required patch-target title exists exactly once
 *      (a node matches a title via _meta.title OR _meta.aliases[]).
 *   3. Every link ([nodeId, outputIndex]) references an existing node id,
 *      is not a self-reference, and outputIndex is a non-negative integer.
 *
 * Usage: node validate-templates.mjs
 * Exits non-zero if any template fails.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

// Titles buildWanI2V() patches (see WAN_TEMPLATE_TITLES in
// src/lib/workflow-builder.ts). These are the SHIPPING templates: models.ts
// templateFile points at the hyphenated files, and the app patches them by
// these exact _meta.title strings.
const FF_I2V_TITLES = [
  "FF Positive", "FF Negative", "FF Start Image", "FF Wan Video",
  "FF Sampler S1", "FF Sampler S2", "FF Sampler S3", "FF Output",
];

const TEMPLATES = {
  // --- Shipping templates (loaded by the app via models.ts templateFile) ---
  // NOTE: forbidden titles matter — buildWanI2V() throws at runtime if a
  // non-FLF template carries "FF End Image" (endImageName is never passed).
  "wan22-i2v.json": {
    required: FF_I2V_TITLES,
    forbidden: ["FF End Image"],
  },
  "wan22-flf2v.json": {
    required: [...FF_I2V_TITLES, "FF End Image"],
  },
  // RIFE post job — patched by title in src/app/api/status/[id]/route.ts.
  "wan22_post_rife.json": {
    required: ["LOAD_VIDEO", "RIFE_VFI", "SAVE_VIDEO"],
  },

  // Wan-Alpha RGBA element lane — patched by buildWanAlpha() (see
  // WAN_ALPHA_TEMPLATE_TITLES). Stock-node graph: Wan 2.1 T2V 14B UNET +
  // wan-alpha LoRA, ONE KSampler latent decoded twice (RGB VAE + alpha VAE),
  // ImageToMask → InvertMask → JoinImageWithAlpha (which computes
  // alpha = 1 - mask, hence the invert), VHS_VideoCombine video/webm with
  // pix_fmt yuva420p so the alpha channel survives encoding. All node
  // schemas + model/lora/vae enums verified against 192.168.4.196:8188
  // object_info 2026-07-14. Text-only lane: FF Start/End Image forbidden.
  "wan_alpha.json": {
    required: [
      "FF Positive", "FF Negative", "FF Wan Video", "FF Sampler S1",
      "FF RGBA Join", "FF Output",
    ],
    forbidden: ["FF Start Image", "FF End Image", "FF Camera"],
  },

  // MatAnyone MATTE lane (real-footage keying → alpha webm) — patched by
  // buildMatAnyone() (see MATTE_TEMPLATE_TITLES). Transform graph, no
  // sampler/prompt/seed: VHS_LoadVideo (force_rate 0 = source fps preserved;
  // frame_load_cap always patched — 30s defensive cap) → MatAnyone2
  // (foreground_mask = the seed LoadImage directly, matching the pack's own
  // example workflow; output 0 "matte" is the alpha as IMAGE, WHITE =
  // subject per run.py: gb = matte*src + (1-matte)*solid) → ImageToMask →
  // InvertMask (JoinImageWithAlpha computes alpha = 1-mask — same
  // load-bearing polarity as wan_alpha.json) → JoinImageWithAlpha over the
  // ORIGINAL frames → VHS_VideoCombine video/webm + yuva420p with the source
  // AUDIO muxed through (FF Load output 2 → audio input; webm audio_pass =
  // libvorbis) and frame_rate LINK-WIRED from VHS_VideoInfoLoaded fps
  // (output 0) so the source rate round-trips with no probe — buildMatAnyone
  // overwrites the link with a number only for an explicit fps resample.
  // MatAnyone/MatAnyone2 schemas + the VHS webm pix_fmt enum verified
  // against 192.168.4.196:8188 object_info 2026-07-14.
  //
  // ONE template, TWO mask branches: the template ships the manual branch
  // ("FF Mask" LoadImage → foreground_mask). When no seed mask is supplied,
  // buildMatAnyone swaps it builder-side: deletes "FF Mask", adds
  // "FF First Frame" (core ImageFromBatch, loaded frame 0 = the same frame
  // mask_frame 0 seeds) → "FF Auto Mask" (BiRefNetRMBG BiRefNet-general,
  // 1038lab/ComfyUI-RMBG @7f0668e; MASK output 1, white = subject) wired
  // into MatAnyone2's optional MASK-typed foreground_MASK input (schemas
  // verified live 2026-07-15; BiRefNet weights auto-download from HF
  // 1038lab/BiRefNet on first use). The auto titles are FORBIDDEN here so
  // the builder-added nodes can never collide with template nodes.
  "matanyone.json": {
    required: [
      "FF Load", "FF Video Info", "FF Mask", "FF MatAnyone",
      "FF RGBA Join", "FF Output",
    ],
    // No text conditioning, no generation inputs, and no auto-mask branch
    // (builder-added only) anywhere in this graph.
    forbidden: [
      "FF Positive", "FF Negative", "FF Start Image", "FF End Image",
      "FF Camera", "FF Sampler S1", "FF First Frame", "FF Auto Mask",
    ],
  },

  // HunyuanVideo-Foley FOLEY lane (footage + optional hint → footage+SFX mp4)
  // — patched by buildFoley() (see FOLEY_TEMPLATE_TITLES). Graph:
  // VHS_LoadVideo ("FF Load"; force_rate 0 = source fps preserved;
  // frame_load_cap always patched — 15s cap, FOLEY_MAX_SECONDS) →
  // VHS_VideoInfoLoaded ("FF Video Info") whose fps (out 0) feeds BOTH the
  // sampler's fps and FF Output's frame_rate, and whose duration (out 2,
  // post-cap) feeds the sampler's duration — LINKS, never patched, so the
  // generated audio length always equals the loaded frame window →
  // HunyuanModelLoader(hunyuanvideo_foley.pth bf16) +
  // HunyuanDependenciesLoader(vae_128d_48k + synchformer_state_dict; ALSO
  // runtime-fetches google/siglip2-base-patch16-512 + laion/
  // larger_clap_general from HF on first use, ~3.5GB one-time — verified in
  // the pack's nodes.py) → HunyuanFoleySampler ("FF Foley", aliases
  // "FF Positive"/"FF Seed" — ONE node carries prompt/negative/seed/recipe;
  // prompt ALWAYS patched, "" = video-driven, so the pack's footsteps-on-ice
  // widget default can never leak; cfg 4.5 / 50 steps / euler / batch 1 /
  // force_offload template-locked = pack defaults) → VHS_VideoCombine
  // video/h264-mp4 yuv420p crf 19 ("FF Output") muxing the ORIGINAL frames
  // (FF Load out 0) with the GENERATED audio (the in-graph mux IS the
  // deliverable, LIP-SYNC style; FF Load's own audio out 2 deliberately
  // unwired — foley replaces any source track). All node schemas
  // (HunyuanFoleySampler, HunyuanModelLoader, HunyuanDependenciesLoader —
  // aistudynow/Comfyui-HunyuanFoley @88c3a1e) + all three model files in the
  // loader enums verified against 192.168.4.196:8188 object_info 2026-07-16.
  // HunyuanFoleyTorchCompile (~30% faster, ~2min recompile per new
  // duration/batch signature) deliberately absent from v1 — wrong trade for
  // per-clip-length dispatches.
  "hunyuan_foley.json": {
    required: [
      "FF Load", "FF Video Info", "FF Foley Model", "FF Foley Deps",
      "FF Foley", "FF Positive", "FF Seed", "FF Output",
    ],
    // A transform-of-footage lane: no image/mask/camera inputs, no separate
    // CLIPTextEncode pair (the sampler owns the text), no RIFE-style
    // multi-sampler chain.
    forbidden: [
      "FF Negative", "FF Start Image", "FF End Image", "FF Camera",
      "FF Mask", "FF Sampler S1",
    ],
  },

  // ACE-Step 1.5 MUSIC lane (style tags + optional lyrics → mp3 music bed)
  // — patched by buildAceStep() (see ACESTEP_TEMPLATE_TITLES). Recipe is
  // verbatim from the official Comfy-Org audio_ace_step_1_5_split template
  // (fetched from the live box's /templates endpoint 2026-07-14):
  // UNETLoader("FF Model" — unet_name ALWAYS patched from the profile
  // checkpoint; the draft lane swaps in the 4.5GB turbo, ONE template for
  // both) + DualCLIPLoader(qwen_0.6b + qwen_1.7b, type "ace") +
  // VAELoader(ace_1.5_vae) → TextEncodeAceStepAudio1.5 ("FF Tags", alias
  // "FF Lyrics" — ONE node carries tags/lyrics/seed/duration; bpm 120,
  // timesig 4, en, C major, generate_audio_codes true template-locked) →
  // ConditioningZeroOut negative → ModelSamplingAuraFlow shift 3 →
  // KSampler 8 steps / cfg 1 / euler / simple ("FF Sampler S1", alias
  // "FF Seed" — stock KSampler, seed input `seed`) → VAEDecodeAudio →
  // SaveAudioMP3 V0 ("FF Output"; lands under the history `audio` key —
  // SavedAudios.as_dict in comfy_api/latest/_ui.py). All node schemas
  // (TextEncodeAceStepAudio1.5, EmptyAceStep1.5LatentAudio, SaveAudioMP3,
  // VAEDecodeAudio) AND all five model files verified against
  // 192.168.4.196:8188 object_info loader enums 2026-07-14 (qwen_0.6b_ace15
  // was missing from download round 6 and gap-filled during this build —
  // the ace15 CLIP path in comfy/sd.py REQUIRES both encoder files).
  "acestep_music.json": {
    required: [
      "FF Model", "FF Tags", "FF Lyrics", "FF Seed", "FF Audio Latent",
      "FF Sampler S1", "FF Output",
    ],
    // Audio-only generation: no image/video/camera inputs and no
    // CLIPTextEncode positive/negative pair anywhere in this graph.
    forbidden: [
      "FF Positive", "FF Negative", "FF Start Image", "FF End Image",
      "FF Camera",
    ],
  },

  // --- HunyuanVideo 1.5 720p lane (HV-HUMANS: faces/presenters + glyph
  // text) — patched by buildHv15() (see HV15_TEMPLATE_TITLES). Stock-node
  // graphs mirroring the official Comfy-Org video_hunyuan_video_1.5_720p_*
  // templates: UNETLoader fp16 + DualCLIPLoader(qwen2.5-vl 7B fp8 + byt5
  // glyph, type "hunyuan_video_15") + ModelSamplingSD3 shift 7 →
  // SamplerCustomAdvanced (euler/simple/20 steps/cfg 6) → VAEDecode →
  // CreateVideo 24fps → SaveVideo mp4/h264. All node schemas + loader enums
  // verified against 192.168.4.196:8188 object_info 2026-07-14. Frames on
  // the 4n+1 grid (EmptyHunyuanVideo15Latent length step 4).
  "hv15_t2v.json": {
    required: [
      "FF Positive", "FF Negative", "FF HV Video", "FF Seed",
      "FF Sampler S1", "FF Output",
    ],
    // Text-only: buildHv15 throws if "FF Start Image" exists without an
    // imageName, so the t2v template must never carry one.
    forbidden: ["FF Start Image", "FF End Image", "FF Camera"],
  },
  "hv15_i2v.json": {
    required: [
      "FF Positive", "FF Negative", "FF Start Image", "FF HV Video",
      "FF Seed", "FF Sampler S1", "FF Output",
    ],
    forbidden: ["FF End Image", "FF Camera"],
  },
  // HERO two-stage 1080p SR variants — stage 1 is the exact hv15_t2v/_i2v
  // recipe, then the official SR chain (extracted verbatim from the
  // bypassed SR subchain in the Comfy-Org 720p templates; all node
  // schemas — HunyuanVideo15LatentUpscaleWithModel,
  // HunyuanVideo15SuperResolution, SplitSigmas, DisableNoise,
  // VAEDecodeTiled — verified against 192.168.4.196:8188 object_info
  // 2026-07-14): LatentUpscaleModelLoader(hunyuanvideo15_latent_upsampler
  // _1080p) → LatentUpscaleWithModel(bilinear → 1920x1080) →
  // SuperResolution(noise_aug 0.7) → sr_distilled fp8 UNET over ONE 8-step
  // simple schedule split at sigma index 4: "FF Sampler S2" (high sigmas,
  // "Fresh Noise S2" template-locked — buildHv15 patches the user seed
  // onto stage-1 "FF Seed" only, matching the ltx23_master idiom) then
  // "FF Sampler S3" (low sigmas, DisableNoise, raw text conds on the
  // un-shifted UNET) → VAEDecodeTiled → CreateVideo 24fps.
  // NOTE (resolved 2026-07-14): the latent upsampler initially did not show
  // in the live LatentUpscaleModelLoader enum. Root cause was NOT a stale
  // cache: the running ComfyUI (~/ComfyUI on the box) maps /srv/comfyui
  // model folders via extra_model_paths.yaml, which has no
  // latent_upscale_models entry — the model was symlinked into
  // ~/ComfyUI/models/latent_upscale_models/ and the enum picked it up live
  // (no restart). Add the yaml mapping for durability at the next restart.
  "hv15_hero.json": {
    required: [
      "FF Positive", "FF Negative", "FF HV Video", "FF Seed",
      "Fresh Noise S2", "FF Sampler S1", "FF Sampler S2", "FF Sampler S3",
      "FF Output",
    ],
    forbidden: ["FF Start Image", "FF End Image", "FF Camera"],
  },
  // i2v hero: the SR conditioning stage ALSO takes vae + start_image (the
  // official i2v SR wiring — re-pins the start frame at 1080p; that is the
  // face-correction mechanism). clip_vision_output IS wired on both stages
  // (SigCLIP Vision → SigCLIP Encode Start → HunyuanVideo15ImageToVideo +
  // HunyuanVideo15SuperResolution), exactly matching the official i2v
  // template — sigclip_vision_patch14_384 landed on the live box
  // 2026-07-14 and is in the live CLIPVisionLoader enum. (The single-stage
  // hv15_i2v.json predates the model and still leaves it unwired.)
  "hv15_hero_i2v.json": {
    required: [
      "FF Positive", "FF Negative", "FF Start Image", "FF HV Video",
      "FF Seed", "Fresh Noise S2", "FF Sampler S1", "FF Sampler S2",
      "FF Sampler S3", "FF Output",
    ],
    forbidden: ["FF End Image", "FF Camera"],
  },

  // --- LTX 2.3 templates (FrameForge FLASH/MASTER lanes) ---
  // Converted to API format from the official Lightricks example workflows
  // (ComfyUI-LTXVideo example_workflows/2.3). Patched by _meta.title.
  // T2V mode = patch the LTXVImgToVideoConditionOnly bypass input to true
  // (there is deliberately no "FF End Image" in either).
  "ltx23_flash.json": {
    required: [
      "FF Positive", "FF Negative", "FF Start Image", "FF Seed",
      "FF Sampler S1", "FF Output",
    ],
    forbidden: ["FF End Image", "FF Sampler S2"],
  },
  // LIP-SYNC lane (audio-conditioned i2v talking head) — patched by
  // buildLtxLipsync() (see LTX_LIPSYNC_TEMPLATE_TITLES). Same single-stage
  // distilled recipe as flash, plus: "FF Audio" (LoadAudio, the input VO) →
  // LTXVAudioVAEEncode → LTXVConcatAVLatent, then LTXVSetAudioVideoMaskByTime
  // (mask_audio=false, init 0.0 — template-locked, no patch target) pins the
  // encoded VO with an all-zero audio noise mask while the video half is
  // generated. CreateVideo.audio wires to the LoadAudio node DIRECTLY so the
  // output mp4 carries the original VO (never the sampled audio latent). All
  // node schemas verified against 192.168.4.196:8188 object_info 2026-07-14
  // (LTXVSetAudioVideoMaskByTime is from ComfyUI-LTXVideo @ 2026-03-06;
  // LTXVConcatAVLatent nested noise-mask propagation is core nodes_lt.py).
  "ltx23_lipsync.json": {
    required: [
      "FF Positive", "FF Negative", "FF Start Image", "FF Audio",
      "FF Seed", "FF Sampler S1", "FF Output",
    ],
    forbidden: ["FF End Image", "FF Sampler S2"],
  },
  // "Fresh Noise S2" is required so the stage-2 refine keeps its OWN
  // RandomNoise node: buildLtxTemplate patches the user seed onto "FF Seed"
  // (stage-1) only — the refine noise stays template-locked, and the two
  // titles being unique guarantees they are distinct nodes.
  "ltx23_master.json": {
    required: [
      "FF Positive", "FF Negative", "FF Start Image", "FF Seed",
      "Fresh Noise S2", "FF Sampler S1", "FF Sampler S2", "FF Output",
    ],
    forbidden: ["FF End Image"],
  },

  // --- Wan 2.2 Fun VACE lane (VACE: reference-to-video + footage editing) ---
  // Patched by buildVaceRef() / buildVaceInpaint() (see VACE_TEMPLATE_TITLES).
  // Stock-node graphs fusing the official Comfy-Org Wan2.1 VACE templates
  // (video_wan_vace_14B_ref2v / video_wan_vace_inpainting: WanVaceToVideo →
  // sampler → TrimVideoLatent with trim_amount wired from trim_latent) with
  // the official Wan2.2 Fun family two-expert recipe
  // (video_wan2_2_14B_fun_control: shift 8, 20 steps, cfg 3.5, euler/simple,
  // high 0-10 / low 10-end). Node schemas (WanVaceToVideo, TrimVideoLatent,
  // VHS_LoadVideo, ImageToMask) verified against 192.168.4.196:8188
  // object_info 2026-07-14; the fun_vace UNET weights were still downloading
  // at build time (see models.ts note).
  //
  // vace_ref: reference_image ONLY — pure identity R2V. The official ref2v
  // template ADDITIONALLY pins the reference as frame 1 via a constructed
  // control video+mask (i2v flavor); deliberately omitted here — the lane is
  // for a recurring host/product in NEW prompt-driven scenes.
  "vace_ref.json": {
    required: [
      "FF Positive", "FF Negative", "FF Reference Image", "FF Wan Video",
      "FF Sampler S1", "FF Sampler S2", "FF Output",
    ],
    forbidden: [
      "FF Start Image", "FF End Image", "FF Camera",
      "FF Control Video", "FF Control Mask",
    ],
  },
  // Draft variant: + the official lightx2v 4-step lora pair over the VACE
  // experts (4 steps, cfg 1, split at 2) — the exact pattern the official
  // Comfy-Org fun_control template ships for its Lightning variant.
  "vace_ref_draft.json": {
    required: [
      "FF Positive", "FF Negative", "FF Reference Image", "FF Wan Video",
      "FF Sampler S1", "FF Sampler S2", "FF Output",
    ],
    forbidden: [
      "FF Start Image", "FF End Image", "FF Camera",
      "FF Control Video", "FF Control Mask",
    ],
  },
  // Footage editing (inpaint/outpaint): control_video + control_masks
  // (white = regenerate). MASK_CONVERT is the ImageToMask bridge that
  // buildVaceInpaint rewires when the mask arrives as a still image
  // (LoadImage + RepeatImageBatch surgery).
  "vace_inpaint.json": {
    required: [
      "FF Positive", "FF Negative", "FF Control Video", "FF Control Mask",
      "MASK_CONVERT", "FF Wan Video", "FF Sampler S1", "FF Sampler S2",
      "FF Output",
    ],
    forbidden: [
      "FF Start Image", "FF End Image", "FF Camera", "FF Reference Image",
    ],
  },

  // Wan 2.2 Fun-Camera i2v (camera_pose preset patched on "FF Camera").
  // Node schemas validated against 192.168.4.196:8188 object_info (core 0.18.1:
  // WanCameraImageToVideo + WanCameraEmbedding both present).
  "wan22_camera.json": {
    required: [
      "FF Positive", "FF Negative", "FF Start Image", "FF Camera",
      "FF Wan Video", "FF Seed", "FF Sampler S1", "FF Sampler S2", "FF Output",
    ],
    forbidden: ["FF End Image"],
  },
  // SeedVR2 v2.5 hero upscale finisher ("FF Load".video patched with an
  // '<file> [output]' annotated path). SeedVR2* schemas validated live.
  "seedvr2_hero.json": {
    required: ["FF Load", "FF Upscale", "FF Output"],
  },
  // FlashVSR fast review upscale. FlashVSRNode authored from the GitHub
  // source of lihaoyun6/ComfyUI-FlashVSR_Ultra_Fast — verified present in
  // live object_info after the 2026-07-14 ComfyUI restart.
  "flashvsr_review.json": {
    required: ["FF Load", "FF Upscale", "FF Output"],
  },

  // --- Reference variants (NOT loaded by any code path; kept as documented
  // recipe references. Their POS_PROMPT/... titles are NOT patchable by
  // buildWanI2V — do not point models.ts templateFile at them as-is.) ---
  "wan22_i2v_3sampler.json": {
    required: [
      "POS_PROMPT", "NEG_PROMPT", "INPUT_IMAGE", "SEED", "LENGTH", "SAVE_VIDEO",
      "MODEL_HIGH", "MODEL_LOW", "LORA_HIGH", "LORA_LOW",
      "SAMPLER_1", "SAMPLER_2", "SAMPLER_3",
    ],
  },
  "wan22_i2v_hero.json": {
    required: [
      "POS_PROMPT", "NEG_PROMPT", "INPUT_IMAGE", "SEED", "LENGTH", "SAVE_VIDEO",
      "MODEL_HIGH", "MODEL_LOW", "SAMPLER_1", "SAMPLER_2",
    ],
  },
  "wan22_flf2v.json": {
    required: [
      "POS_PROMPT", "NEG_PROMPT", "INPUT_IMAGE", "END_IMAGE", "SEED", "LENGTH",
      "SAVE_VIDEO", "MODEL_HIGH", "MODEL_LOW", "LORA_HIGH", "LORA_LOW",
      "SAMPLER_1", "SAMPLER_2", "SAMPLER_3",
    ],
  },
};

/** A link is exactly [string nodeId, integer outputIndex]. */
function isLink(v) {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "string" &&
    typeof v[1] === "number"
  );
}

function titlesOf(node) {
  const meta = node._meta ?? {};
  const t = [];
  if (typeof meta.title === "string") t.push(meta.title);
  if (Array.isArray(meta.aliases)) {
    for (const a of meta.aliases) if (typeof a === "string") t.push(a);
  }
  return t;
}

let anyFailed = false;

for (const [file, spec] of Object.entries(TEMPLATES)) {
  const requiredTitles = spec.required;
  const forbiddenTitles = spec.forbidden ?? [];
  const errors = [];
  let graph;
  try {
    graph = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  } catch (err) {
    console.log(`FAIL  ${file}: cannot load/parse — ${err.message}`);
    anyFailed = true;
    continue;
  }

  const ids = new Set(Object.keys(graph));
  let linkCount = 0;

  for (const [id, node] of Object.entries(graph)) {
    if (typeof node?.class_type !== "string" || node.class_type.length === 0) {
      errors.push(`node ${id}: missing class_type`);
    }
    if (typeof node?.inputs !== "object" || node.inputs === null) {
      errors.push(`node ${id}: missing inputs object`);
      continue;
    }
    for (const [inputName, value] of Object.entries(node.inputs)) {
      if (!isLink(value)) continue;
      linkCount++;
      const [target, outIdx] = value;
      if (!ids.has(target)) {
        errors.push(`node ${id}.${inputName}: link to missing node "${target}"`);
      }
      if (target === id) {
        errors.push(`node ${id}.${inputName}: self-referencing link`);
      }
      if (!Number.isInteger(outIdx) || outIdx < 0) {
        errors.push(`node ${id}.${inputName}: bad output index ${outIdx}`);
      }
    }
  }

  const titleMap = new Map(); // title -> [nodeIds]
  for (const [id, node] of Object.entries(graph)) {
    for (const t of titlesOf(node)) {
      if (!titleMap.has(t)) titleMap.set(t, []);
      titleMap.get(t).push(id);
    }
  }
  for (const title of requiredTitles) {
    const owners = titleMap.get(title) ?? [];
    if (owners.length === 0) errors.push(`required title missing: ${title}`);
    if (owners.length > 1) {
      errors.push(`title ${title} not unique (nodes ${owners.join(", ")})`);
    }
  }
  for (const title of forbiddenTitles) {
    const owners = titleMap.get(title) ?? [];
    if (owners.length > 0) {
      errors.push(
        `forbidden title present: ${title} (nodes ${owners.join(", ")}) — ` +
          `buildWanI2V() throws when this template is used without an end image`
      );
    }
  }

  if (errors.length === 0) {
    console.log(
      `PASS  ${file}: ${ids.size} nodes, ${linkCount} links, ` +
        `${requiredTitles.length}/${requiredTitles.length} required titles`
    );
  } else {
    anyFailed = true;
    console.log(`FAIL  ${file}:`);
    for (const e of errors) console.log(`      - ${e}`);
  }
}

console.log(anyFailed ? "\nRESULT: FAIL" : "\nRESULT: ALL TEMPLATES PASS");
process.exit(anyFailed ? 1 : 0);
