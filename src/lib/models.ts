// FrameForge — LTX-Video Model Configuration

import type { ResolutionPreset, VideoModelParams } from "./types";

export const LTX_VIDEO_MODEL = {
  id: "ltx-video-2.3",
  name: "LTX-Video 2.3",
  description: "Local video + audio generation with Lightricks LTX-Video 2.3",
  supportsImageInput: true,
  supportsAudio: true,
  defaultParams: {
    width: 768,
    height: 512,
    fps: 25,
    frames: 105,
    steps: 20,
    cfg: 3,
  } satisfies VideoModelParams,
  resolutionPresets: [
    { label: "512p", width: 768, height: 512 },
    { label: "720p", width: 1280, height: 720 },
    { label: "1080p", width: 1920, height: 1080 },
  ] satisfies ResolutionPreset[],
  durationPresets: [4, 6, 8, 10, 15, 20],
  fpsOptions: [24, 25, 30],
};

/** Calculate frame count from duration (seconds) and fps */
export function durationToFrames(seconds: number, fps: number): number {
  return fps * seconds + 1;
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
