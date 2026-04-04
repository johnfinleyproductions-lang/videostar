// FrameForge — Type Definitions

export type VideoGenerationStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

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
  seed?: number;
  filename?: string;
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
}

export interface GenerateResponse {
  id: string;
  comfyPromptId: string;
  status: VideoGenerationStatus;
}

export interface StatusResponse {
  id: string;
  status: VideoGenerationStatus;
  progress?: number;
  url?: string;
  filename?: string;
  error?: string;
}
