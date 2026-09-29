// FrameForge — REVOICE lane runner (Chatterbox VC in WSL, NOT ComfyUI).
//
// The one lane whose deliverable shares its VIDEO BITSTREAM with its input:
// Chatterbox VC is voice CONVERSION (source speech tokens kept, only the
// speaker condition swapped), so the converted track has the original timing,
// phrasing and cadence — the mouth movements already in the footage stay
// valid, nothing needs re-syncing, and revoice.py remuxes with `-c:v copy`.
// The picture is not "preserved", it is literally unmodified (verified by a
// video-stream MD5 compare inside the script, which FAILS the job rather than
// delivering a re-encode).
//
// This CANNOT be a ComfyUI graph: every graph has to end in a frame saver
// (VHS_VideoCombine), which decodes and re-encodes the picture and would
// destroy the stream copy that is the lane's entire reason to exist. So it
// follows the src/lib/lens-client.ts pattern instead — write a job JSON,
// pre-write a status sidecar, spawn a DETACHED `wsl.exe … python script job`,
// and let the status route poll the sidecar.
//
// DELIVERY (verified the hard way 2026-09-26): the deliverable is served
// through /api/output?revoice=<jobId>, NOT as a static /outputs/... path.
// `next start` scans public/ ONCE AT BOOT, so a file written by a job while the
// server is running 404s until the next restart — measured live: a fresh job's
// mp4 404'd, then returned 200 after a restart with no rebuild. (The lens image
// lane still delivers via a static /outputs/lens/ URL and therefore has this
// same latent bug; its PNGs only resolve because they predate the last boot.)
// Serving from the API route also gets real Range support, which browsers need
// to seek a 50MB mp4.
//
// Licensing, deliberately: chatterbox-tts and the ResembleAI/chatterbox
// weights are MIT, so lane output is commercially usable. VoxStation's XTTS is
// Coqui CPML — non-commercial, and CPML restricts the OUTPUT, not just the
// weights — so it must never back this lane.

import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REVOICE_WSL_DISTRO = process.env.REVOICE_WSL_DISTRO || "Ubuntu-24.04";
const REVOICE_WSL_EXE = process.env.REVOICE_WSL_EXE || "wsl.exe";
const REVOICE_PYTHON =
  process.env.REVOICE_PYTHON || "/home/evergreen/venvs/revoice/bin/python";
const REVOICE_SCRIPT =
  process.env.REVOICE_SCRIPT || "/home/evergreen/revoice/revoice.py";
/**
 * CPU by design. The venv pins torch 2.6.0, which predates Blackwell sm_120 —
 * "cuda" there fails at kernel launch on this box's RTX PRO 4500. It is a ~1GB
 * audio model, so CPU costs minutes and, more valuably, contends for no VRAM:
 * a REVOICE job can run while a Wan/H3 render owns the GPU.
 */
const REVOICE_DEVICE = process.env.REVOICE_DEVICE || "cpu";

const REVOICE_JOBS_DIR =
  process.env.REVOICE_JOBS_DIR ||
  path.join(/* turbopackIgnore: true */ process.cwd(), "data", "revoice-jobs");
const REVOICE_OUTPUT_DIR =
  process.env.REVOICE_OUTPUT_DIR ||
  path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "public",
    "outputs",
    "revoice",
  );
const REVOICE_PUBLIC_BASE_URL = (
  process.env.REVOICE_PUBLIC_BASE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  ""
).replace(/\/$/, "");

/** Chatterbox VC degrades past ~40s per call; revoice.py splits on silence. */
export const REVOICE_MAX_SECONDS = 600;
/** Below this the target-voice reference is too short to characterise a timbre. */
export const REVOICE_MIN_VOICE_SECONDS = 3;

/** The WSL runtime (venv / script / ffmpeg) is not usable on this box. */
export class RevoiceRuntimeUnavailableError extends Error {
  constructor(missing: string[]) {
    super(
      `The REVOICE runtime is not available on this host: ${missing.join("; ")}. ` +
        `Runbook: the venv is ${REVOICE_PYTHON} (python -m pip install chatterbox-tts — ` +
        `NEVER bare pip, the copied venv's pip shebang points at another interpreter) ` +
        `and the script is ${REVOICE_SCRIPT}.`,
    );
    this.name = "RevoiceRuntimeUnavailableError";
  }
}

export interface RevoiceJobParams {
  /** Source clip bytes — the picture that will be stream-copied, untouched. */
  video: Buffer;
  /** Source filename, for the input file's extension only. */
  videoFilename: string;
  /** Target-voice reference bytes (a clean 5-15s sample of the NEW voice). */
  targetVoice: Buffer;
  targetVoiceFilename: string;
  /** AAC bitrate for the muxed track (the video is never re-encoded). */
  audioBitrate?: string;
  /** Also emit the converted audio alone, alongside the mp4. */
  keepAudio?: boolean;
}

export interface RevoiceJobStatus {
  id?: string;
  provider?: string;
  status?: string;
  stage?: string;
  progress?: number;
  filename?: string;
  url?: string;
  error?: string;
  source_duration?: number;
  output_duration?: number;
  chunks?: number;
  output_sr?: number;
  video_stream_md5?: string;
  video_stream_copied?: boolean;
}

/** Windows path → WSL path (C:\x\y → /mnt/c/x/y). Mirrors lens-client. */
function toWslPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) {
    return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }
  return normalized;
}

/**
 * Job ids are generated here as `revoice-<uuid>`, but they arrive back from a
 * URL query param, so they are UNTRUSTED at the read path: anchor the shape
 * before it is ever joined onto a filesystem path (a bare path.join would let
 * `?revoice=../../../.env` escape the output directory).
 */
const REVOICE_JOB_ID_RE = /^revoice-[0-9a-fA-F-]{36}$/;

export function isRevoiceJobId(value: string): boolean {
  return REVOICE_JOB_ID_RE.test(value);
}

/**
 * Public URL for a finished job. Deliberately the /api/output proxy and NOT a
 * static /outputs/... path — see the DELIVERY note at the top of this file.
 */
function revoiceOutputUrl(jobId: string): string {
  const relative = `/api/output?revoice=${encodeURIComponent(jobId)}`;
  return REVOICE_PUBLIC_BASE_URL
    ? `${REVOICE_PUBLIC_BASE_URL}${relative}`
    : relative;
}

/**
 * On-disk path of a finished job's deliverable. Throws on a job id that does
 * not match the generated shape, so the caller cannot be walked out of the
 * output directory.
 */
export function revoiceOutputPath(
  jobId: string,
  variant: "primary" | "audio" = "primary",
): string {
  if (!isRevoiceJobId(jobId)) {
    throw new Error(`Not a REVOICE job id: ${jobId}`);
  }
  const ext = variant === "audio" ? ".wav" : ".mp4";
  return path.join(REVOICE_OUTPUT_DIR, `${jobId}${ext}`);
}

async function ensureRevoiceDirs(): Promise<void> {
  await fs.mkdir(REVOICE_JOBS_DIR, { recursive: true });
  await fs.mkdir(REVOICE_OUTPUT_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------
// This lane is the heaviest disk consumer in the app and the only one that
// stores a FULL COPY of its input: a job writes <id>.source.mp4 (the caller's
// whole clip) beside its deliverable, so one 50MB clip costs ~100MB. Seventeen
// jobs reached 605MB with nothing reclaiming it. Two mechanisms, because they
// fail differently:
//
//   1. Per-job input cleanup (cleanup_inputs in the job JSON): revoice.py
//      deletes the copied source + voice reference as soon as the output is
//      verified. They are pure duplicates of what the caller sent and nothing
//      reads them afterwards — the status route reads only the sidecar and
//      /api/output serves only from the output dir. On FAILURE they are kept,
//      because that is exactly when someone needs to reproduce the job.
//   2. Age + size sweep (below), which also catches the failure leftovers and
//      the deliverables themselves.
//
// Deliberate consequence: a swept deliverable makes an OLD history item's url
// 404. That is the right trade (the alternative is unbounded growth) and
// /api/output answers with a retention-aware message rather than a bare 404.
const RETENTION_DAYS = Number(process.env.REVOICE_RETENTION_DAYS || 14);
const RETENTION_MAX_GB = Number(process.env.REVOICE_RETENTION_MAX_GB || 5);
/** Never touch anything this new — a job in flight must not be swept. */
const RETENTION_FLOOR_MS = 60 * 60 * 1000;

interface SweepEntry {
  file: string;
  size: number;
  mtimeMs: number;
}

async function listWithStats(dir: string): Promise<SweepEntry[]> {
  const out: SweepEntry[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const s = await fs.stat(file);
      if (s.isFile()) out.push({ file, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // vanished between readdir and stat — nothing to sweep
    }
  }
  return out;
}

/**
 * Reclaim disk from finished jobs. Age first, then oldest-first until under the
 * size cap. Never throws: a sweep failure must not fail a dispatch — the job
 * the caller asked for matters more than the housekeeping.
 *
 * Returns a summary for logging, so a sweep is never silent.
 */
export async function sweepRevoiceRetention(): Promise<{
  removed: number;
  freedBytes: number;
  reason: string[];
}> {
  const removed: string[] = [];
  let freedBytes = 0;
  const reason: string[] = [];

  try {
    const now = Date.now();
    const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const all = [
      ...(await listWithStats(REVOICE_JOBS_DIR)),
      ...(await listWithStats(REVOICE_OUTPUT_DIR)),
    ].filter((e) => now - e.mtimeMs > RETENTION_FLOOR_MS);

    const drop = async (e: SweepEntry) => {
      try {
        await fs.unlink(e.file);
        removed.push(e.file);
        freedBytes += e.size;
      } catch {
        // already gone / locked — skip
      }
    };

    const aged = all.filter((e) => e.mtimeMs < cutoff);
    for (const e of aged) await drop(e);
    if (aged.length) reason.push(`${aged.length} file(s) older than ${RETENTION_DAYS}d`);

    // Size cap over what survives the age pass, oldest first.
    const survivors = all
      .filter((e) => !removed.includes(e.file))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = survivors.reduce((n, e) => n + e.size, 0);
    const cap = RETENTION_MAX_GB * 1024 ** 3;
    let capped = 0;
    for (const e of survivors) {
      if (total <= cap) break;
      await drop(e);
      total -= e.size;
      capped++;
    }
    if (capped) reason.push(`${capped} file(s) over the ${RETENTION_MAX_GB}GB cap`);
  } catch (error) {
    reason.push(`sweep aborted: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { removed: removed.length, freedBytes, reason };
}

async function wslCheck(args: string[]): Promise<boolean> {
  try {
    await execFileAsync(
      REVOICE_WSL_EXE,
      ["-d", REVOICE_WSL_DISTRO, "--", ...args],
      { timeout: 8000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify the runtime BEFORE accepting a job. Without this a missing venv is
 * discovered only by a detached child that dies silently, leaving the job
 * "processing" forever (the sidecar is never updated because the interpreter
 * never started). ffmpeg is checked too: it is the lane's only hard external
 * dependency and the ONE ffmpeg dependency anywhere in this app.
 */
export async function getRevoicePreflight(): Promise<{
  ok: boolean;
  missing: string[];
  runtime: string;
}> {
  const missing: string[] = [];
  await ensureRevoiceDirs();

  const checks: Array<[string, string[]]> = [
    [`Chatterbox venv python (${REVOICE_PYTHON})`, ["test", "-f", REVOICE_PYTHON]],
    [`revoice.py (${REVOICE_SCRIPT})`, ["test", "-f", REVOICE_SCRIPT]],
    ["ffmpeg on the WSL PATH", ["sh", "-c", "command -v ffmpeg"]],
    ["ffprobe on the WSL PATH", ["sh", "-c", "command -v ffprobe"]],
  ];

  for (const [label, args] of checks) {
    if (!(await wslCheck(args))) missing.push(`${label} is missing`);
  }

  return {
    ok: missing.length === 0,
    missing,
    runtime: `wsl:${REVOICE_WSL_DISTRO} (${REVOICE_DEVICE})`,
  };
}

/**
 * Materialise both inputs on the Windows side (WSL reads them through /mnt),
 * write the job + status sidecar, then spawn the detached converter.
 *
 * Returns the job id, which the caller records as the history item's
 * remoteJobId — the same handle shape the remotion lane uses.
 */
export async function queueRevoiceJob(
  id: string,
  params: RevoiceJobParams,
): Promise<{ jobId: string; filename: string; url: string }> {
  const preflight = await getRevoicePreflight();
  if (!preflight.ok) {
    throw new RevoiceRuntimeUnavailableError(preflight.missing);
  }

  const jobId = `revoice-${id}`;
  const filename = `${jobId}.mp4`;
  const videoExt = path.extname(params.videoFilename) || ".mp4";
  const voiceExt = path.extname(params.targetVoiceFilename) || ".wav";

  const videoPath = path.join(REVOICE_JOBS_DIR, `${jobId}.source${videoExt}`);
  const voicePath = path.join(REVOICE_JOBS_DIR, `${jobId}.voice${voiceExt}`);
  const inputPath = path.join(REVOICE_JOBS_DIR, `${jobId}.input.json`);
  const statusPath = path.join(REVOICE_JOBS_DIR, `${jobId}.json`);
  const outputPath = path.join(REVOICE_OUTPUT_DIR, filename);
  const audioOutPath = params.keepAudio
    ? path.join(REVOICE_OUTPUT_DIR, `${jobId}.wav`)
    : undefined;
  const url = revoiceOutputUrl(jobId);

  // Reclaim disk BEFORE writing this job's ~2x input copy, so a long-running
  // box cannot fill up between jobs. Never fatal (see sweepRevoiceRetention).
  const swept = await sweepRevoiceRetention();
  if (swept.removed > 0) {
    console.log(
      `[FrameForge] REVOICE retention swept ${swept.removed} file(s), `
        + `${(swept.freedBytes / 1024 ** 2).toFixed(0)}MB freed — ${swept.reason.join("; ")}`,
    );
  }

  await fs.writeFile(videoPath, params.video);
  await fs.writeFile(voicePath, params.targetVoice);

  const job = {
    id: jobId,
    provider: "revoice",
    filename,
    video_path: toWslPath(videoPath),
    target_voice_path: toWslPath(voicePath),
    output_path: toWslPath(outputPath),
    audio_out_path: audioOutPath ? toWslPath(audioOutPath) : undefined,
    status_path: toWslPath(statusPath),
    device: REVOICE_DEVICE,
    audio_bitrate: params.audioBitrate || "192k",
    public_url: url,
    // Drop this job's copied inputs once the output is VERIFIED — they are
    // duplicates of what the caller sent and nothing reads them afterwards.
    // Kept on failure, which is when they are needed to reproduce it.
    cleanup_inputs: true,
  };

  // Pre-write the sidecar so a poll landing between spawn and the script's
  // first write sees "processing", never a 404-shaped unknown.
  await fs.writeFile(
    statusPath,
    JSON.stringify(
      {
        id: jobId,
        provider: "revoice",
        status: "processing",
        stage: "queued",
        progress: 0,
        filename,
        url,
      },
      null,
      2,
    ),
  );
  await fs.writeFile(inputPath, JSON.stringify(job, null, 2));

  const child = spawn(
    REVOICE_WSL_EXE,
    [
      "-d",
      REVOICE_WSL_DISTRO,
      "--",
      REVOICE_PYTHON,
      REVOICE_SCRIPT,
      "--job",
      toWslPath(inputPath),
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();

  if (!child.pid) {
    throw new Error("Revoice conversion process did not start");
  }

  return { jobId, filename, url };
}

export async function getRevoiceJobStatus(
  jobId: string,
): Promise<RevoiceJobStatus> {
  const statusPath = path.join(REVOICE_JOBS_DIR, `${jobId}.json`);
  try {
    const raw = await fs.readFile(statusPath, "utf-8");
    return JSON.parse(raw) as RevoiceJobStatus;
  } catch {
    // Sidecar unreadable (mid-write is impossible — the script writes via
    // os.replace — so this means it is genuinely absent): report progress
    // rather than inventing a failure the converter has not reported.
    return { id: jobId, provider: "revoice", status: "processing", stage: "unknown" };
  }
}
