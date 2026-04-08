// FrameForge — ComfyUI Workflow JSON Builder
// Constructs the LTX-Video 2.3 API-format workflow from user parameters
//
// Node graph (text-to-video):
//   1:CheckpointLoaderSimple → 7:LoraLoaderModelOnly (optional)
//   2:LTXAVTextEncoderLoader → 4:CLIPTextEncode(+) / 5:CLIPTextEncode(-)
//   3:LTXVAudioVAELoader
//   4+5 → 6:LTXVConditioning
//   8:EmptyLTXVLatentVideo + 9:LTXVEmptyLatentAudio → 10:LTXVConcatAVLatent
//   6 → 14:CFGGuider ← 7(model)
//   10 → 15:SamplerCustomAdvanced ← 14(guider) + 13(sampler) + 12(sigmas) + 11(noise)
//   15 → 16:LTXVSeparateAVLatent → 17:VAEDecode + 18:LTXVAudioVAEDecode
//   17+18 → 19:VHS_VideoCombine

import type { GenerateRequest } from "./types";
import { durationToFrames } from "./models";

// ---------------------------------------------------------------------------
// Model file names — must match what is on disk in ComfyUI/models/
// ---------------------------------------------------------------------------
// Using fp8 checkpoint for faster generation and lower VRAM usage.
// Blackwell (sm_120) has native fp8 tensor cores — this is the optimal path.
// The full-precision checkpoint (ltx-2.3-22b-dev.safetensors) is also available
// if higher quality is needed.
const CHECKPOINT = "ltx-2.3-22b-dev-fp8.safetensors";
const GEMMA_ENCODER = "comfy_gemma_3_12B_it.safetensors";
const DISTILLED_LORA = "ltxv/ltx2/ltx-2.3-22b-distilled-lora-384.safetensors";

const NEGATIVE_PROMPT =
  "pc game, console game, video game, cartoon, childish, ugly, blurry, low quality, watermark";

// ---------------------------------------------------------------------------
// Text → Video
// ---------------------------------------------------------------------------
export function buildTextToVideoWorkflow(req: GenerateRequest) {
  const frames = durationToFrames(req.duration, req.fps);
  const seed = req.seed ?? Math.floor(Math.random() * 2147483647);
  const fpsInt = Math.round(req.fps);

  return {
    prompt: {
      // ── Model loading ────────────────────────────────────────────────
      // 1: Load the LTX-2.3 AV checkpoint (outputs MODEL, CLIP, VAE)
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: CHECKPOINT },
      },

      // 2: Load Gemma 3 12B text encoder (outputs CLIP for text encoding)
      //    text_encoder → file in models/text_encoders/
      //    ckpt_name    → same AV checkpoint (needed for tokenizer config)
      "2": {
        class_type: "LTXAVTextEncoderLoader",
        inputs: {
          text_encoder: GEMMA_ENCODER,
          ckpt_name: CHECKPOINT,
          device: "default",
        },
      },

      // 3: Load audio VAE from the same checkpoint
      "3": {
        class_type: "LTXVAudioVAELoader",
        inputs: { ckpt_name: CHECKPOINT },
      },

      // ── Text encoding ────────────────────────────────────────────────
      // 4: Positive prompt
      "4": {
        class_type: "CLIPTextEncode",
        inputs: { text: req.prompt, clip: ["2", 0] },
      },

      // 5: Negative prompt
      "5": {
        class_type: "CLIPTextEncode",
        inputs: { text: NEGATIVE_PROMPT, clip: ["2", 0] },
      },

      // 6: Wrap conditioning with frame rate for LTX-Video
      "6": {
        class_type: "LTXVConditioning",
        inputs: {
          frame_rate: req.fps,
          positive: ["4", 0],
          negative: ["5", 0],
        },
      },

      // ── LoRA (distilled for faster generation) ───────────────────────
      // 7: Apply distilled LoRA to model (strength 0.5 for distilled mode)
      "7": {
        class_type: "LoraLoaderModelOnly",
        inputs: {
          model: ["1", 0],
          lora_name: DISTILLED_LORA,
          strength_model: 0.5,
        },
      },

      // ── Latent creation ──────────────────────────────────────────────
      // 8: Empty video latent at requested resolution
      "8": {
        class_type: "EmptyLTXVLatentVideo",
        inputs: {
          width: req.width,
          height: req.height,
          length: frames,
          batch_size: 1,
        },
      },

      // 9: Empty audio latent (matched to video duration)
      "9": {
        class_type: "LTXVEmptyLatentAudio",
        inputs: {
          frames_number: frames,
          frame_rate: fpsInt,
          batch_size: 1,
          audio_vae: ["3", 0],
        },
      },

      // 10: Concatenate video + audio latents for the AV model
      "10": {
        class_type: "LTXVConcatAVLatent",
        inputs: {
          video_latent: ["8", 0],
          audio_latent: ["9", 0],
        },
      },

      // ── Sampling ─────────────────────────────────────────────────────
      // 11: Random noise
      "11": {
        class_type: "RandomNoise",
        inputs: { noise_seed: seed },
      },

      // 12: LTX-Video scheduler (generates sigma schedule)
      "12": {
        class_type: "LTXVScheduler",
        inputs: {
          steps: 20,
          max_shift: 2.05,
          base_shift: 0.95,
          stretch: true,
          terminal: 0.1,
          latent: ["10", 0],
        },
      },

      // 13: Sampler selection
      "13": {
        class_type: "KSamplerSelect",
        inputs: { sampler_name: "euler" },
      },

      // 14: CFG Guider — drives the denoising with positive/negative conditioning
      "14": {
        class_type: "CFGGuider",
        inputs: {
          cfg: 3,
          model: ["7", 0],
          positive: ["6", 0],
          negative: ["6", 1],
        },
      },

      // 15: Run the sampler
      "15": {
        class_type: "SamplerCustomAdvanced",
        inputs: {
          noise: ["11", 0],
          guider: ["14", 0],
          sampler: ["13", 0],
          sigmas: ["12", 0],
          latent_image: ["10", 0],
        },
      },

      // ── Decode ───────────────────────────────────────────────────────
      // 16: Separate the AV latent back into video + audio
      "16": {
        class_type: "LTXVSeparateAVLatent",
        inputs: { av_latent: ["15", 0] },
      },

      // 17: Decode video latent → images
      "17": {
        class_type: "VAEDecode",
        inputs: {
          samples: ["16", 0],
          vae: ["1", 2],
        },
      },

      // 18: Decode audio latent → audio
      "18": {
        class_type: "LTXVAudioVAEDecode",
        inputs: {
          samples: ["16", 1],
          audio_vae: ["3", 0],
        },
      },

      // ── Output ───────────────────────────────────────────────────────
      // 19: Combine into final MP4
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
          audio: ["18", 0],
        },
      },
    },
    extra_data: { seed },
  };
}

// ---------------------------------------------------------------------------
// Image → Video
// ---------------------------------------------------------------------------
export function buildImageToVideoWorkflow(
  req: GenerateRequest & { sourceImage: string }
) {
  const base = buildTextToVideoWorkflow(req);
  const workflow = base.prompt as Record<string, Record<string, unknown>>;
  const frames = durationToFrames(req.duration, req.fps);

  // 50: Load the source image
  workflow["50"] = {
    class_type: "LoadImage",
    inputs: { image: req.sourceImage, upload: "image" },
  };

  // 51: Preprocess image for LTX-Video (resize to correct aspect)
  //     img_compression: JPEG quality for preprocessing (0-100, 65 = good balance)
  workflow["51"] = {
    class_type: "LTXVPreprocess",
    inputs: {
      image: ["50", 0],
      target_tokens: 18,
      img_compression: 65,
    },
  };

  // 52: Condition the video latent on the source image
  //     bypass=false means we ARE using the image (I2V mode)
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

  // Re-route: ConcatAVLatent now takes image-conditioned latent instead of empty
  (workflow["10"].inputs as Record<string, unknown>).video_latent = ["52", 0];

  return base;
}
