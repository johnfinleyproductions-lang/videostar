// FrameForge - LTX Desktop backend adapter

import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import type { GenerateRequest } from "./types";
import type { VideoModelProfile } from "./models";

const LTX_DESKTOP_URL = process.env.LTX_DESKTOP_URL?.replace(/\/$/, "");
const LTX_DESKTOP_AUTH_TOKEN = process.env.LTX_DESKTOP_AUTH_TOKEN;
const LTX_DESKTOP_OUTPUT_DIR = process.env.LTX_DESKTOP_OUTPUT_DIR;
const LTX_DESKTOP_HEALTH_TIMEOUT_MS = 5_000;
const LTX_DESKTOP_PROGRESS_TIMEOUT_MS = 5_000;

type LtxDesktopResolution = "540p" | "720p" | "1080p" | "1440p" | "2160p";
type LtxDesktopDuration = 5 | 6 | 8 | 10 | 12 | 14 | 16 | 18 | 20;
type LtxDesktopFps = 24 | 25 | 48 | 50;

interface LtxDesktopGenerateCompleteResponse {
  status: "complete";
  video_path: string;
}

interface LtxDesktopGenerateCancelledResponse {
  status: "cancelled";
}

type LtxDesktopGenerateResponse =
  | LtxDesktopGenerateCompleteResponse
  | LtxDesktopGenerateCancelledResponse;

export interface LtxDesktopGenerationResult {
  videoPath: string;
  filename: string;
  duration: number;
  fps: number;
}

export interface LtxDesktopGenerationProgress {
  status: "idle" | "running" | "complete" | "cancelled" | "error" | string;
  phase?: string;
  progress?: number;
  currentStep?: number;
  totalSteps?: number;
}

export function isLtxDesktopConfigured(): boolean {
  return Boolean(LTX_DESKTOP_URL && LTX_DESKTOP_OUTPUT_DIR);
}

export function getLtxDesktopSetupError(): string {
  if (!LTX_DESKTOP_URL && !LTX_DESKTOP_OUTPUT_DIR) {
    return "LTX Desktop requires LTX_DESKTOP_URL and LTX_DESKTOP_OUTPUT_DIR.";
  }
  if (!LTX_DESKTOP_URL) {
    return "LTX Desktop requires LTX_DESKTOP_URL.";
  }
  return "LTX Desktop requires LTX_DESKTOP_OUTPUT_DIR.";
}

export function buildLtxDesktopOutputUrl(appUrl: string, videoPath: string): string {
  const params = new URLSearchParams({
    provider: "ltx-desktop",
    path: videoPath,
  });
  return `${appUrl}/api/output?${params.toString()}`;
}

export async function generateLtxDesktopVideo(
  req: GenerateRequest,
  profile: VideoModelProfile,
): Promise<LtxDesktopGenerationResult> {
  if (!isLtxDesktopConfigured()) {
    throw new Error(getLtxDesktopSetupError());
  }

  await assertLtxDesktopHealthy();

  const startedAtMs = Date.now();
  const model = profile.ltxDesktopPipeline ?? "fast";
  const duration = toLtxDesktopDuration(req.duration);
  const fps = toLtxDesktopFps(req.fps, model);
  let res: Response;

  try {
    res = await fetch(`${LTX_DESKTOP_URL}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LTX_DESKTOP_AUTH_TOKEN
          ? { Authorization: `Bearer ${LTX_DESKTOP_AUTH_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        prompt: req.prompt,
        resolution: toLtxDesktopResolution(req.width, req.height),
        model,
        cameraMotion: "none",
        negativePrompt: process.env.LTX_DESKTOP_NEGATIVE_PROMPT || "",
        duration,
        fps,
        localGenerationMode: profile.ltxDesktopRuntimeMode ?? "auto",
        audio: false,
        imagePath: null,
        audioPath: null,
        aspectRatio: req.height > req.width ? "9:16" : "16:9",
      }),
    });
  } catch (error) {
    if (isConnectionFailure(error)) {
      throw new Error(getLtxDesktopUnavailableError(error));
    }

    const fallback = await waitForNewestLtxDesktopOutput(startedAtMs);
    if (fallback) {
      return fallback;
    }
    throw error;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LTX Desktop generation failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as LtxDesktopGenerateResponse;
  if (data.status === "cancelled") {
    throw new Error("LTX Desktop generation was cancelled.");
  }

  const videoPath = normalizeLtxDesktopOutputPath(data.video_path);

  return {
    videoPath,
    filename: path.basename(videoPath),
    duration,
    fps,
  };
}

export async function getLtxDesktopOutputFile(videoPath: string): Promise<{
  body: Buffer;
  filename: string;
}> {
  if (!LTX_DESKTOP_OUTPUT_DIR) {
    throw new Error("LTX_DESKTOP_OUTPUT_DIR is not configured.");
  }

  const outputRoot = path.resolve(LTX_DESKTOP_OUTPUT_DIR);
  const resolvedPath = path.resolve(normalizeLtxDesktopOutputPath(videoPath));
  const relative = path.relative(outputRoot, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Requested LTX Desktop output is outside LTX_DESKTOP_OUTPUT_DIR.");
  }

  return {
    body: await readFile(resolvedPath),
    filename: path.basename(resolvedPath),
  };
}

async function assertLtxDesktopHealthy(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LTX_DESKTOP_HEALTH_TIMEOUT_MS);

  try {
    const res = await fetch(`${LTX_DESKTOP_URL}/health`, {
      method: "GET",
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`health returned ${res.status}`);
    }
  } catch (error) {
    throw new Error(getLtxDesktopUnavailableError(error));
  } finally {
    clearTimeout(timeout);
  }
}

function getLtxDesktopUnavailableError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `LTX Desktop is not reachable at ${LTX_DESKTOP_URL}. Start the Evergreen LTX Desktop task, then retry. (${detail})`;
}

function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /abort|connect|connection|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(message);
}

async function waitForNewestLtxDesktopOutput(
  startedAtMs: number,
): Promise<LtxDesktopGenerationResult | null> {
  const deadline = Date.now() + 10 * 60_000;

  while (Date.now() < deadline) {
    const output = await findNewestLtxDesktopOutput(startedAtMs);
    if (output) {
      return output;
    }
    await sleep(2_000);
  }

  return null;
}

export async function findNewestLtxDesktopOutput(
  startedAtMs: number,
): Promise<LtxDesktopGenerationResult | null> {
  if (!LTX_DESKTOP_OUTPUT_DIR) {
    return null;
  }

  try {
    const outputRoot = path.resolve(LTX_DESKTOP_OUTPUT_DIR);
    const entries = await readdir(outputRoot, { withFileTypes: true });
    let newest: { path: string; mtimeMs: number } | null = null;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mp4")) {
        continue;
      }

      const candidate = path.join(outputRoot, entry.name);
      const info = await stat(candidate);
      if (info.mtimeMs < startedAtMs - 5_000) {
        continue;
      }

      if (!newest || info.mtimeMs > newest.mtimeMs) {
        newest = { path: candidate, mtimeMs: info.mtimeMs };
      }
    }

    if (!newest) {
      return null;
    }

    return {
      videoPath: newest.path,
      filename: path.basename(newest.path),
      duration: 5,
      fps: 24,
    };
  } catch {
    return null;
  }
}

export async function getLtxDesktopGenerationProgress(): Promise<
  LtxDesktopGenerationProgress | null
> {
  if (!LTX_DESKTOP_URL) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LTX_DESKTOP_PROGRESS_TIMEOUT_MS);

  try {
    const res = await fetch(`${LTX_DESKTOP_URL}/api/generation/progress`, {
      method: "GET",
      signal: controller.signal,
    });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as LtxDesktopGenerationProgress;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLtxDesktopOutputPath(videoPath: string): string {
  if (process.platform !== "win32") {
    return videoPath;
  }

  const wslMount = videoPath.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (!wslMount) {
    return videoPath;
  }

  const [, driveLetter, rest] = wslMount;
  return `${driveLetter.toUpperCase()}:\\${rest.replaceAll("/", "\\")}`;
}

function toLtxDesktopResolution(width: number, height: number): LtxDesktopResolution {
  const edge = Math.max(width, height);
  if (edge >= 3840) return "2160p";
  if (edge >= 2560) return "1440p";
  if (edge >= 1920) return "1080p";
  if (edge >= 1280) return "720p";
  return "540p";
}

function toLtxDesktopDuration(duration: number): LtxDesktopDuration {
  const allowed: LtxDesktopDuration[] = [5, 6, 8, 10, 12, 14, 16, 18, 20];
  return allowed.reduce((best, candidate) =>
    Math.abs(candidate - duration) < Math.abs(best - duration) ? candidate : best,
  );
}

function toLtxDesktopFps(
  fps: number,
  model: VideoModelProfile["ltxDesktopPipeline"] = "fast",
): LtxDesktopFps {
  // The local fast pipeline currently rejects 25 fps at 540p/720p even
  // though the public schema lists it. Keep VideoStar on the proven path.
  if (model === "fast") {
    return 24;
  }

  const allowed: LtxDesktopFps[] = [24, 25, 48, 50];
  return allowed.reduce((best, candidate) =>
    Math.abs(candidate - fps) < Math.abs(best - fps) ? candidate : best,
  );
}
