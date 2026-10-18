// FrameForge â€” Image Workflow Builder
// Builds ComfyUI API-format workflow JSON for local image generation.

type FluxModel =
  | "gguf"
  | "flux2-fast"
  | "q5"
  | "flux2-hq"
  | "fp8"
  | "flux2-klein-true-v2";
type ZImageProfile =
  | "z-image-base-amateur-photo-8step"
  | "z-image-turbo-amateur-photo";
type ImageModel = FluxModel | ZImageProfile | string;

const FLUX_ENCODER = "mistral_3_small_flux2_fp8.safetensors";
const FLUX_KLEIN_ENCODER = "qwen_3_8b_fp8mixed.safetensors";
const FLUX_VAE = "flux2-vae.safetensors";

const MODEL_CONFIG: Record<
  FluxModel,
  {
    file: string;
    loaderClass: string;
    fileKey: string;
    clipName?: string;
    filenamePrefix?: string;
  }
> = {
  gguf: {
    file: "flux2-dev-Q3_K_M.gguf",
    loaderClass: "UnetLoaderGGUF",
    fileKey: "unet_name",
  },
  "flux2-fast": {
    file: "flux2-dev-Q3_K_M.gguf",
    loaderClass: "UnetLoaderGGUF",
    fileKey: "unet_name",
  },
  q5: {
    file: "flux2-dev-Q3_K_M.gguf",
    loaderClass: "UnetLoaderGGUF",
    fileKey: "unet_name",
  },
  "flux2-hq": {
    file: "flux2-dev-Q3_K_M.gguf",
    loaderClass: "UnetLoaderGGUF",
    fileKey: "unet_name",
  },
  fp8: {
    file: "flux2_dev_fp8mixed.safetensors",
    loaderClass: "UNETLoader",
    fileKey: "unet_name",
  },
  "flux2-klein-true-v2": {
    file: "Flux2-Klein-9B-True-v2-Q4_K.gguf",
    loaderClass: "UnetLoaderGGUF",
    fileKey: "unet_name",
    clipName: FLUX_KLEIN_ENCODER,
    filenamePrefix: "FrameForge_Flux2_Klein_True_V2",
  },
};

const Z_IMAGE_TEXT_ENCODER = "qwen_3_4b_fp4_mixed.safetensors";
const Z_IMAGE_VAE = "ae.safetensors";
const Z_IMAGE_AMATEUR_PHOTO_LORA =
  "z-image/deedee_amateur_photography_zimage_base_and_turbo_v1.safetensors";
const Z_IMAGE_DISTILL_8STEP_LORA =
  "z-image/Z-Image-Fun-Lora-Distill-8-Steps-2603-ComfyUI.safetensors";

const Z_IMAGE_CONFIG: Record<
  ZImageProfile,
  {
    diffusionModel: string;
    loras: Array<{
      name: string;
      strengthModel: number;
      strengthClip: number;
    }>;
    steps: number;
    cfg: number;
    filenamePrefix: string;
  }
> = {
  "z-image-base-amateur-photo-8step": {
    diffusionModel: "z_image_bf16.safetensors",
    loras: [
      {
        name: Z_IMAGE_DISTILL_8STEP_LORA,
        strengthModel: 0.85,
        strengthClip: 0.85,
      },
      {
        name: Z_IMAGE_AMATEUR_PHOTO_LORA,
        strengthModel: 0.85,
        strengthClip: 0.85,
      },
    ],
    steps: 8,
    cfg: 1.0,
    filenamePrefix: "FrameForge_ZImage_Amateur_Base",
  },
  "z-image-turbo-amateur-photo": {
    diffusionModel: "z_image_turbo_nvfp4.safetensors",
    loras: [
      {
        name: Z_IMAGE_AMATEUR_PHOTO_LORA,
        strengthModel: 0.85,
        strengthClip: 0.85,
      },
    ],
    steps: 8,
    cfg: 1.0,
    filenamePrefix: "FrameForge_ZImage_Amateur_Turbo",
  },
};

export interface FluxWorkflowParams {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  referenceImage?: string;
  referenceImage2?: string;
  denoise?: number;
  model?: ImageModel;
}

function clampDimension(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  return Math.min(2048, Math.max(256, Math.round(resolved / 32) * 32));
}

export function buildFluxWorkflow(
  params: FluxWorkflowParams,
): Record<string, unknown> {
  if (isCreativeImageModel(params.model)) {
    return buildCreativeImageWorkflow(params, params.model);
  }

  if (isQwenEditProfile(params.model)) {
    return buildQwenImageEditWorkflow(params);
  }

  if (isZImageProfile(params.model)) {
    return buildZImageWorkflow(params, params.model);
  }

  const {
    prompt,
    negativePrompt = "",
    steps = 28,
    cfg = 1.0,
    seed = Math.floor(Math.random() * 1_000_000_000_000),
    referenceImage,
    denoise,
    model = "gguf",
  } = params;
  const width = clampDimension(params.width, 1024);
  const height = clampDimension(params.height, 1024);

  const fluxModel = isFluxModel(model) ? model : "gguf";
  const config = MODEL_CONFIG[fluxModel] ?? MODEL_CONFIG.gguf;
  const unetLoaderInputs: Record<string, unknown> = {
    [config.fileKey]: config.file,
  };
  if (fluxModel === "fp8") {
    unetLoaderInputs.weight_dtype = "default";
  }

  const workflow: Record<string, unknown> = {
    "1": {
      class_type: config.loaderClass,
      inputs: unetLoaderInputs,
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: config.clipName ?? FLUX_ENCODER,
        type: "flux2",
        device: "cpu",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: {
        vae_name: FLUX_VAE,
      },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: prompt,
        clip: ["2", 0],
      },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: negativePrompt,
        clip: ["2", 0],
      },
    },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
        seed,
        steps,
        cfg,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: referenceImage ? (denoise ?? 0.75) : 1.0,
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["7", 0],
        vae: ["3", 0],
      },
    },
    "9": {
      class_type: "SaveImage",
      inputs: {
        images: ["8", 0],
        filename_prefix: config.filenamePrefix ?? "FrameForge_Flux2",
      },
    },
  };

  if (referenceImage) {
    workflow["10"] = {
      class_type: "LoadImage",
      inputs: {
        image: referenceImage,
      },
    };
    workflow["6"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["10", 0],
        upscale_method: "lanczos",
        width,
        height,
        crop: "center",
      },
    };
    workflow["12"] = {
      class_type: "VAEEncode",
      inputs: {
        pixels: ["6", 0],
        vae: ["3", 0],
      },
    };
    (workflow["7"] as { inputs: Record<string, unknown> }).inputs.latent_image = [
      "12",
      0,
    ];
  } else {
    workflow["6"] = {
      class_type: "EmptyLatentImage",
      inputs: {
        width,
        height,
        batch_size: 1,
      },
    };
  }

  return workflow;
}

function isFluxModel(model: ImageModel | undefined): model is FluxModel {
  return (
    model === "gguf" ||
    model === "flux2-fast" ||
    model === "q5" ||
    model === "flux2-hq" ||
    model === "fp8" ||
    model === "flux2-klein-true-v2"
  );
}

function isZImageProfile(model: ImageModel | undefined): model is ZImageProfile {
  return (
    model === "z-image-base-amateur-photo-8step" ||
    model === "z-image-turbo-amateur-photo"
  );
}

function buildZImageWorkflow(
  params: FluxWorkflowParams,
  profileId: ZImageProfile,
): Record<string, unknown> {
  const profile = Z_IMAGE_CONFIG[profileId];
  const {
    prompt,
    negativePrompt = "",
    seed = Math.floor(Math.random() * 1_000_000_000_000),
  } = params;
  const width = clampDimension(params.width, 1024);
  const height = clampDimension(params.height, 1024);
  const steps = params.steps ?? profile.steps;
  const cfg = params.cfg ?? profile.cfg;

  const workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    "1": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: profile.diffusionModel,
        weight_dtype: "default",
      },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: Z_IMAGE_TEXT_ENCODER,
        type: "qwen_image",
        device: "cpu",
      },
    },
    "3": {
      class_type: "VAELoader",
      inputs: {
        vae_name: Z_IMAGE_VAE,
      },
    },
  };

  let modelRef: [string, number] = ["1", 0];
  let clipRef: [string, number] = ["2", 0];

  profile.loras.forEach((lora, index) => {
    const nodeId = String(20 + index);
    workflow[nodeId] = {
      class_type: "LoraLoader",
      inputs: {
        model: modelRef,
        clip: clipRef,
        lora_name: lora.name,
        strength_model: lora.strengthModel,
        strength_clip: lora.strengthClip,
      },
    };
    modelRef = [nodeId, 0];
    clipRef = [nodeId, 1];
  });

  workflow["4"] = {
    class_type: "CLIPTextEncode",
    inputs: {
      text: prompt,
      clip: clipRef,
    },
  };
  workflow["5"] = {
    class_type: "CLIPTextEncode",
    inputs: {
      text: negativePrompt,
      clip: clipRef,
    },
  };
  workflow["6"] = {
    class_type: "EmptyLatentImage",
    inputs: {
      width,
      height,
      batch_size: 1,
    },
  };
  workflow["7"] = {
    class_type: "KSampler",
    inputs: {
      model: modelRef,
      positive: ["4", 0],
      negative: ["5", 0],
      latent_image: ["6", 0],
      seed,
      steps,
      cfg,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1.0,
    },
  };
  workflow["8"] = {
    class_type: "VAEDecode",
    inputs: {
      samples: ["7", 0],
      vae: ["3", 0],
    },
  };
  workflow["9"] = {
    class_type: "SaveImage",
    inputs: {
      images: ["8", 0],
      filename_prefix: profile.filenamePrefix,
    },
  };

  return workflow;
}

// --- Qwen-Image-Edit (image-edit model; added 2026-06-29) ---
// Uses the qwen_2.5_vl encoder + qwen_image_vae (NOT the z-image `ae` VAE).
// TextEncodeQwenImageEditPlus folds the reference image into the conditioning;
// the latent is the VAEEncode of that image so the edit preserves layout.
const QWEN_EDIT_MODEL = "qwen_image_edit_2509_fp8_e4m3fn.safetensors";
const QWEN_EDIT_TEXT_ENCODER = "qwen_2.5_vl_7b_fp8_scaled.safetensors";
const QWEN_EDIT_VAE = "qwen_image_vae.safetensors";

function isQwenEditProfile(
  model: ImageModel | undefined,
): model is "qwen-image-edit" {
  return model === "qwen-image-edit";
}

function buildQwenImageEditWorkflow(
  params: FluxWorkflowParams,
): Record<string, unknown> {
  const {
    prompt,
    negativePrompt = "",
    seed = Math.floor(Math.random() * 1_000_000_000_000),
    referenceImage,
    referenceImage2,
  } = params;
  const width = clampDimension(params.width, 1024);
  const height = clampDimension(params.height, 1024);
  const steps = params.steps ?? 20;
  const cfg = params.cfg ?? 2.5;

  const workflow: Record<
    string,
    { class_type: string; inputs: Record<string, unknown> }
  > = {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: QWEN_EDIT_MODEL, weight_dtype: "default" },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: QWEN_EDIT_TEXT_ENCODER, type: "qwen_image", device: "cpu" },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: QWEN_EDIT_VAE } },
    "12": {
      class_type: "ModelSamplingAuraFlow",
      inputs: { model: ["1", 0], shift: 3.0 },
    },
    "14": {
      class_type: "CFGNorm",
      inputs: { model: ["12", 0], strength: 1 },
    },
    "5": {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: { clip: ["2", 0], prompt: negativePrompt, vae: ["3", 0] },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": {
      class_type: "SaveImage",
      inputs: { images: ["8", 0], filename_prefix: "FrameForge_QwenEdit" },
    },
  };

  if (referenceImage) {
    // Match the native Qwen workflow: both CFG branches see the same photos.
    workflow["5"].inputs.image1 = ["10", 0];
    if (referenceImage2) workflow["5"].inputs.image2 = ["11", 0];
    workflow["10"] = {
      class_type: "LoadImage",
      inputs: { image: referenceImage },
    };
    workflow["4"] = {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: { clip: ["2", 0], prompt, vae: ["3", 0], image1: ["10", 0],
        ...(referenceImage2 ? { image2: ["11", 0] } : {}) },
    };
    if (referenceImage2) workflow["11"] = {
      class_type: "LoadImage", inputs: { image: referenceImage2 },
    };
    workflow["6"] = {
      class_type: "VAEEncode",
      inputs: { pixels: ["10", 0], vae: ["3", 0] },
    };
  } else {
    if (referenceImage2) throw new Error("A second reference requires a source image.");
    workflow["4"] = {
      class_type: "TextEncodeQwenImageEditPlus",
      inputs: { clip: ["2", 0], prompt, vae: ["3", 0] },
    };
    workflow["6"] = {
      class_type: "EmptySD3LatentImage",
      inputs: { width, height, batch_size: 1 },
    };
  }

  workflow["7"] = {
    class_type: "KSampler",
    inputs: {
      model: ["14", 0],
      positive: ["4", 0],
      negative: ["5", 0],
      latent_image: ["6", 0],
      seed,
      steps,
      cfg,
      sampler_name: "euler",
      scheduler: "simple",
      denoise: 1.0,
    },
  };

  return workflow;
}

// Recipes pinned to BFL's FLUX 3 Klein reference workflow (feef60b) and
// OpenMOSS MOSS-Image's ComfyUI example (c1355e6). Both use 128-channel latents.
export type CreativeImageModel = "flux3-klein" | "moss-image-sft";
export function isCreativeImageModel(model?: string): model is CreativeImageModel {
  return model === "flux3-klein" || model === "moss-image-sft";
}
export const CREATIVE_IMAGE_FILES = {
  flux: "flux3-image-klein-bf16.safetensors",
  encoder: "qwen3vl_4b_bf16.safetensors",
  upsampler: "qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors",
  vae: "flux3/flux2-vae.safetensors",
  moss: "/srv/comfyui/models/diffusers/MOSS-Image-SFT",
} as const;
const FLUX3_UPSAMPLER_SYSTEM = "You are the prompt upsampler of a text-to-image model. Expand the user's short request into ONE detailed, self-contained caption: the exact text the image model receives. Output only the caption, with no greetings, explanations, refusals, questions, Markdown, headings, JSON, coordinates, ids or angle-bracket tokens, and no quotes around it. If the input is not clearly an image request, caption a visualization of its concept. The request may begin with a \"TARGET CANVAS: W:H\" line: compose for that canvas (wide spreads content sideways, tall stacks it) and never mention the ratio or the canvas.\n\nFidelity and planning: keep every explicit subject, attribute, count, spatial constraint, style cue and piece of wording; never contradict, substitute, drop or narrow the request, and keep an abstract concept abstract. Decide everything left open as ONE concrete, consistent plan; never offer alternatives or hedge. Never re-express a stated constraint through another mechanism; add camera optics (depth of field, bokeh, blur) only when asked for or implied. Without a stated style, plan an actual photograph and open with the medium convention (\"Full-color outdoor photograph, ...\", \"Full-color indoor photograph, ...\", \"Studio photograph, ...\", \"Close-up photograph, ...\"); keep \"Photorealistic\" for renders, and turn \"photorealistic\" or \"realistic\" requests for photos into the photograph convention. Give a photograph a few ordinary, non-ideal specifics drawn from the scene's own objects instead of the stock-photo ideal. Do not invent names, brands, logos or celebrities; keep user-named ones. A long request keeps its content but not its wording: drop appraisal and sales vocabulary, turn moods into observable physical facts, and add only new concrete content with positions. Time of day is lighting, not rendered text.\n\nCaption format: one continuous prose block in the generative voice, never \"this image shows\", \"we can see\" or \"is visible\". Lead with medium and style, then scene, lighting and camera, then the subjects with concrete colors, materials and state. Every person in focus gets an observable profile: ethnicity, gender, age range, skin tone (\"fair skin\", \"brown skin\"), hair and clothing. Make the layout reconstructable from words: frame-relative positions (frame-left, frame-right, upper, lower, foreground, midground, background), sentence-initial anchors (\"On the left, ...\", \"In the background, ...\"), relations (holds, faces, behind) and a consistent order; describe up to about ten instances one by one, beyond that give the exact count and arrangement. Out-of-focus or distant planes are shapes, colors and silhouettes, never identities or readable text, and the background takes about a sixth of the caption. Be definite: no hedging adverbs, no quality or emotion judgments, no closing sentence about mood; state negations as what is present. Rendered text: transcribe every wording verbatim inside double quotes in its original language and script, keep the line breaks of multi-line text, and give its typography, color and placement; author concrete, domain-correct wording when the request needs text it does not supply, and name canonical structures (calendar, keyboard, periodic table) exactly with their full layout. All prose is English; only quoted text keeps its language. Typical length is 100 to 350 words, more for complex scenes.\n\nOutput only the caption.";

function buildCreativeImageWorkflow(params: FluxWorkflowParams, model: CreativeImageModel): Record<string, unknown> {
  if (params.referenceImage !== undefined || params.referenceImage2 !== undefined) {
    throw new Error("This image profile currently supports text prompts only.");
  }
  const flux = model === "flux3-klein";
  const dimension = (n: number | undefined) => Math.max(256, Math.min(1536,
    Math.round((typeof n === "number" && Number.isFinite(n) ? n : 1024) / 16) * 16));
  const width = dimension(params.width), height = dimension(params.height);
  const seed = typeof params.seed === "number" && Number.isSafeInteger(params.seed) && params.seed >= 0
    ? params.seed : Math.floor(Math.random() * 1_000_000_000_000);
  const steps = Math.max(1, Math.min(50, Math.round(
    typeof params.steps === "number" && Number.isFinite(params.steps) ? params.steps : flux ? 16 : 50)));
  const cfg = typeof params.cfg === "number" && Number.isFinite(params.cfg)
    ? Math.max(1, Math.min(10, params.cfg)) : flux ? 1 : 3;
  const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
  const wf: Record<string, unknown> = {
    "1": flux ? node("UNETLoader", { unet_name: CREATIVE_IMAGE_FILES.flux, weight_dtype: "default" })
      : node("MOSSImageHFLoader", { model_path: CREATIVE_IMAGE_FILES.moss, weight_dtype: "default", text_device: "default" }),
    "4": node("CLIPTextEncode", { clip: [flux ? "2" : "1", flux ? 0 : 1], text: flux ? ["11", 0] : params.prompt }),
    "5": node("CLIPTextEncode", { clip: [flux ? "2" : "1", flux ? 0 : 1], text: params.negativePrompt ?? "" }),
    "6": node("EmptyFlux2LatentImage", { width, height, batch_size: 1 }),
    "7": node("KSampler", { model: [flux ? "12" : "13", 0], positive: ["4", 0], negative: ["5", 0],
      latent_image: ["6", 0], seed, steps, cfg, sampler_name: "euler", scheduler: flux ? "simple" : "sgm_uniform", denoise: 1 }),
    "8": node("VAEDecode", { samples: ["7", 0], vae: [flux ? "3" : "1", flux ? 0 : 2] }),
    "9": node("SaveImage", { images: ["8", 0], filename_prefix: flux ? "FrameForge_FLUX3_Klein" : "FrameForge_MOSS_Image_SFT" }),
  };
  if (flux) {
    wf["2"] = node("CLIPLoader", { clip_name: CREATIVE_IMAGE_FILES.encoder, type: "flux3", device: "default" });
    wf["3"] = node("VAELoader", { vae_name: CREATIVE_IMAGE_FILES.vae });
    wf["10"] = node("CLIPLoader", { clip_name: CREATIVE_IMAGE_FILES.upsampler, type: "flux3", device: "default" });
    wf["11"] = node("TextGenerate", { clip: ["10", 0], prompt: `TARGET CANVAS: ${width}:${height}\n${params.prompt}`,
      max_length: 3584, sampling_mode: "on", "sampling_mode.temperature": 1, "sampling_mode.top_k": 1,
      "sampling_mode.top_p": 0.95, "sampling_mode.min_p": 0, "sampling_mode.repetition_penalty": 1,
      "sampling_mode.seed": seed, "sampling_mode.presence_penalty": 1.5, thinking: false,
      use_default_template: true, mtp: "off", system_prompt: FLUX3_UPSAMPLER_SYSTEM });
    wf["12"] = node("ModelSamplingFlux", { model: ["1", 0], max_shift: Math.log(16), base_shift: Math.log(16), width, height });
  } else {
    wf["12"] = node("ModelSamplingSD3", { model: ["1", 0], shift: 5 });
    wf["13"] = node("SkipLayerGuidanceDiTSimple", { model: ["12", 0], double_layers: "", single_layers: "22", start_percent: 0, end_percent: 1 });
  }
  return wf;
}
