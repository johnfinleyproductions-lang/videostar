// FrameForge — ComfyUI Workflow JSON Builder
// Constructs the LTX-Video 2.3 API-format workflow from user parameters

import type { GenerateRequest } from "./types";
import { durationToFrames } from "./models";

const NEGATIVE_PROMPT =
  "blurry, low quality, still frame, frames, watermark, overlay, titles, has blurbox, has subtitles";

const CHECKPOINT_NAME = "ltx-av-step-1751000_vocoder_24K.safetensors";
const GEMMA_PATH =
  "gemma-3-12b-it-qat-q4_0-unquantized_readout_proj/model/model.safetensors";

export function buildTextToVideoWorkflow(req: GenerateRequest) {
  const frames = durationToFrames(req.duration, req.fps);
  const seed = req.seed ?? Math.floor(Math.random() * 2147483647);
  const fpsInt = Math.round(req.fps);

  return {
    prompt: {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: CHECKPOINT_NAME },
      },
      "2": {
        class_type: "LTXVGemmaCLIPModelLoader",
        inputs: {
          gemma_path: GEMMA_PATH,
          ltxv_path: CHECKPOINT_NAME,
          max_length: 1024,
        },
      },
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: req.prompt, clip: ["2", 0] },
      },
      "4": {
        class_type: "CLIPTextEncode",
        inputs: { text: NEGATIVE_PROMPT, clip: ["2", 0] },
      },
      "8": {
        class_type: "KSamplerSelect",
        inputs: { sampler_name: "euler" },
      },
      "9": {
        class_type: "LTXVScheduler",
        inputs: {
          steps: 20,
          max_shift: 2.05,
          base_shift: 0.95,
          stretch: true,
          terminal: 0.1,
          latent: ["28", 0],
        },
      },
      "11": {
        class_type: "RandomNoise",
        inputs: { noise_seed: seed },
      },
      "12": {
        class_type: "VAEDecode",
        inputs: { samples: ["29", 0], vae: ["1", 2] },
      },
      "13": {
        class_type: "LTXVAudioVAELoader",
        inputs: { ckpt_name: CHECKPOINT_NAME },
      },
      "14": {
        class_type: "LTXVAudioVAEDecode",
        inputs: { samples: ["29", 1], audio_vae: ["13", 0] },
      },
      "15": {
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
          images: ["12", 0],
          audio: ["14", 0],
        },
      },
      "17": {
        class_type: "MultimodalGuider",
        inputs: {
          skip_blocks: "29",
          model: ["28", 1],
          positive: ["22", 0],
          negative: ["22", 1],
          parameters: ["18", 0],
        },
      },
      "18": {
        class_type: "GuiderParameters",
        inputs: {
          modality: "VIDEO",
          cfg: 3,
          stg: 0,
          rescale: 0,
          modality_scale: 3,
          parameters: ["19", 0],
        },
      },
      "19": {
        class_type: "GuiderParameters",
        inputs: {
          modality: "AUDIO",
          cfg: 7,
          stg: 0,
          rescale: 0,
          modality_scale: 3,
        },
      },
      "22": {
        class_type: "LTXVConditioning",
        inputs: {
          frame_rate: req.fps,
          positive: ["3", 0],
          negative: ["4", 0],
        },
      },
      "26": {
        class_type: "LTXVEmptyLatentAudio",
        inputs: {
          frames_number: frames,
          frame_rate: fpsInt,
          batch_size: 1,
        },
      },
      "28": {
        class_type: "LTXVConcatAVLatent",
        inputs: {
          video_latent: ["43", 0],
          audio_latent: ["26", 0],
          model: ["44", 0],
        },
      },
      "29": {
        class_type: "LTXVSeparateAVLatent",
        inputs: { av_latent: ["41", 0], model: ["28", 1] },
      },
      "41": {
        class_type: "SamplerCustomAdvanced",
        inputs: {
          noise: ["11", 0],
          guider: ["17", 0],
          sampler: ["8", 0],
          sigmas: ["9", 0],
          latent_image: ["28", 0],
        },
      },
      "43": {
        class_type: "EmptyLTXVLatentVideo",
        inputs: {
          width: req.width,
          height: req.height,
          length: frames,
          batch_size: 1,
        },
      },
      "44": {
        class_type: "LTXVSequenceParallelMultiGPUPatcher",
        inputs: {
          torch_compile: true,
          disable_backup: false,
          model: ["1", 0],
        },
      },
    },
    extra_data: { seed },
  };
}

export function buildImageToVideoWorkflow(
  req: GenerateRequest & { sourceImage: string }
) {
  // Start from the text-to-video workflow and add image conditioning
  const base = buildTextToVideoWorkflow(req);
  const workflow = base.prompt;

  // Add LoadImage node
  (workflow as Record<string, unknown>)["50"] = {
    class_type: "LoadImage",
    inputs: { image: req.sourceImage, upload: "image" },
  };

  // Add LTXVImgToVideo conditioning node
  const frames = durationToFrames(req.duration, req.fps);
  (workflow as Record<string, unknown>)["51"] = {
    class_type: "LTXVImgToVideoLatent",
    inputs: {
      image: ["50", 0],
      vae: ["1", 2],
      width: req.width,
      height: req.height,
      length: frames,
      batch_size: 1,
    },
  };

  // Replace the empty latent with image-conditioned latent
  // Point node 43 replacement: node 28's video_latent from node 51 instead of 43
  (
    (workflow as Record<string, Record<string, unknown>>)["28"]
      .inputs as Record<string, unknown>
  ).video_latent = ["51", 0];

  return base;
}
