// FrameForge - Lens-Turbo WSL runner.

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LENS_WSL_DISTRO = process.env.LENS_WSL_DISTRO || "Ubuntu-24.04";
const LENS_WSL_EXE = process.env.LENS_WSL_EXE || "wsl.exe";
const LENS_PYTHON =
  process.env.LENS_PYTHON || "/home/evergreen/lens/.venv/bin/python";
const LENS_GENERATOR =
  process.env.LENS_GENERATOR || "/home/evergreen/lens/generate_lens_turbo.py";
const LENS_REPO_ROOT =
  process.env.LENS_REPO_ROOT || "/home/evergreen/lens/Lens";
const LENS_TURBO_MODEL_ROOT =
  process.env.LENS_TURBO_MODEL_ROOT || "/home/evergreen/lens/models/Lens-Turbo";

const LENS_JOBS_DIR =
  process.env.LENS_JOBS_DIR ||
  path.join(/* turbopackIgnore: true */ process.cwd(), "data", "lens-jobs");
const LENS_OUTPUT_DIR =
  process.env.LENS_OUTPUT_DIR ||
  path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "public",
    "outputs",
    "lens",
  );
const LENS_PUBLIC_BASE_URL = (
  process.env.LENS_PUBLIC_BASE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  ""
).replace(/\/$/, "");

const LENS_MODEL_IDS = new Set([
  "lens-turbo",
  "frameforge/lens-turbo",
  "microsoft/Lens-Turbo",
  "Lens-Turbo",
]);

export interface LensWorkflowParams {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  model?: string;
  repoId?: string;
  baseResolution?: number;
  aspectRatio?: string;
  dtype?: string;
}

export interface LensPromptResponse {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
}

export function isLensModel(model?: string | null): boolean {
  return typeof model === "string" && LENS_MODEL_IDS.has(model);
}

export function isLensJobId(id: string): boolean {
  return id.startsWith("lens-");
}

function toWslPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) {
    return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }
  return normalized;
}

function lensOutputUrl(filename: string): string {
  const relative = `/outputs/lens/${filename}`;
  return LENS_PUBLIC_BASE_URL ? `${LENS_PUBLIC_BASE_URL}${relative}` : relative;
}

function clampDimension(value: number | undefined, fallback: number): number {
  const resolved = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(1440, Math.max(256, Math.round(resolved / 32) * 32));
}

async function ensureLensDirs(): Promise<void> {
  await fs.mkdir(LENS_JOBS_DIR, { recursive: true });
  await fs.mkdir(LENS_OUTPUT_DIR, { recursive: true });
}

async function wslPathExists(wslPath: string, type: "file" | "directory"): Promise<boolean> {
  const testFlag = type === "file" ? "-f" : "-d";
  try {
    await execFileAsync(
      LENS_WSL_EXE,
      ["-d", LENS_WSL_DISTRO, "--", "test", testFlag, wslPath],
      { timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

export async function getLensPreflight(): Promise<{
  ok: boolean;
  missing: string[];
  runtime: string;
}> {
  const missing: string[] = [];

  await ensureLensDirs();

  const checks: Array<[string, string, "file" | "directory"]> = [
    ["Lens Python", LENS_PYTHON, "file"],
    ["Lens generator", LENS_GENERATOR, "file"],
    ["Lens source repo", LENS_REPO_ROOT, "directory"],
    ["Lens-Turbo model", LENS_TURBO_MODEL_ROOT, "directory"],
  ];

  for (const [label, wslPath, type] of checks) {
    if (!(await wslPathExists(wslPath, type))) {
      missing.push(`${label} is missing at ${wslPath}`);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    runtime: `wsl:${LENS_WSL_DISTRO}`,
  };
}

export async function queueLensPrompt(
  params: LensWorkflowParams,
): Promise<LensPromptResponse> {
  await ensureLensDirs();

  const id = `lens-${Date.now()}-${randomUUID()}`;
  const filename = `${id}.png`;
  const inputPath = path.join(LENS_JOBS_DIR, `${id}.input.json`);
  const statusPath = path.join(LENS_JOBS_DIR, `${id}.json`);
  const outputPath = path.join(LENS_OUTPUT_DIR, filename);
  const logPath = path.join(LENS_JOBS_DIR, `${id}.log`);
  const width = clampDimension(params.width, 1024);
  const height = clampDimension(params.height, 1024);

  const job = {
    id,
    provider: "lens",
    model: params.model || "microsoft/Lens-Turbo",
    repo_id: params.repoId || LENS_TURBO_MODEL_ROOT,
    prompt: params.prompt,
    negative_prompt: params.negativePrompt || "",
    width,
    height,
    base_resolution: params.baseResolution,
    aspect_ratio: params.aspectRatio,
    steps: params.steps ?? 4,
    cfg: params.cfg ?? 1,
    seed: params.seed,
    dtype: params.dtype || "bfloat16",
    offload: process.env.LENS_CPU_OFFLOAD !== "false",
    output_path: toWslPath(outputPath),
    status_path: toWslPath(statusPath),
    log_path: toWslPath(logPath),
    public_url: lensOutputUrl(filename),
  };

  await fs.writeFile(
    statusPath,
    JSON.stringify(
      {
        id,
        provider: "lens",
        status: "processing",
        stage: "queued",
        filename,
        url: lensOutputUrl(filename),
      },
      null,
      2,
    ),
  );
  await fs.writeFile(inputPath, JSON.stringify(job, null, 2));

  const child = spawn(
    LENS_WSL_EXE,
    [
      "-d",
      LENS_WSL_DISTRO,
      "--",
      LENS_PYTHON,
      LENS_GENERATOR,
      toWslPath(inputPath),
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();

  if (!child.pid) {
    throw new Error("Lens generation process did not start");
  }

  return {
    prompt_id: id,
    number: 0,
    node_errors: {},
  };
}

export async function getLensJobStatus(id: string): Promise<Record<string, unknown>> {
  const statusPath = path.join(LENS_JOBS_DIR, `${id}.json`);
  try {
    const raw = await fs.readFile(statusPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      id,
      provider: "lens",
      status: "processing",
      stage: "unknown",
    };
  }
}
