/* Adversarial probe tests against REAL container fixtures generated with
 * ffmpeg (run: npx tsx scripts/video-probe.test.mts). Mirrors the
 * lane-matrix.test.mts check() style. Covers: h264 mp4 24fps, mp4 60fps
 * (the exact case the 30fps cap assumption silently truncated), vp9 webm
 * 24fps, an audio-only mp4 negative case, truncated heads (faststart vs
 * tail-moov), and garbage input. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ProbeError,
  probeVideoHeader,
  type VideoProbeResult,
} from "../src/lib/video-probe";
import { matteFrameCap, MATTE_MAX_SECONDS } from "../src/lib/workflow-builder";

let fail = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.log("FAIL " + msg);
  } else console.log("pass " + msg);
}

function near(actual: number | undefined, expected: number, tol: number): boolean {
  return actual !== undefined && Math.abs(actual - expected) <= tol;
}

function expectProbeError(buffer: Buffer, msg: string) {
  try {
    const result = probeVideoHeader(buffer);
    check(false, `${msg} (got ${JSON.stringify(result)} instead of ProbeError)`);
  } catch (error) {
    check(error instanceof ProbeError, `${msg} (threw ${(error as Error).name})`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures: tiny real files rendered by ffmpeg into a scratch dir.
// ---------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "video-probe-"));
function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

const mp4_24 = path.join(dir, "h264-24fps.mp4");
const mp4_60 = path.join(dir, "h264-60fps.mp4");
const mp4_nofaststart = path.join(dir, "h264-tailmoov.mp4");
const webm_24 = path.join(dir, "vp9-24fps.webm");
const mp4_audio = path.join(dir, "audio-only.mp4");

try {
  ffmpeg(["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=24",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4_24]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=60",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4_60]);
  // Default mux = moov at the tail (no faststart) — the fallback-path fixture.
  ffmpeg(["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=24",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4_nofaststart]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=24",
    "-c:v", "libvpx-vp9", "-b:v", "200k", webm_24]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac", mp4_audio]);

  // -------------------------------------------------------------------------
  // MP4 24fps (faststart)
  // -------------------------------------------------------------------------
  const p24 = probeVideoHeader(readFileSync(mp4_24));
  check(p24.container === "mp4", "mp4-24: container is mp4");
  check(near(p24.durationSeconds, 2, 0.1), `mp4-24: duration ~2s (got ${p24.durationSeconds})`);
  check(near(p24.fps, 24, 0.01), `mp4-24: fps 24 real, not guessed (got ${p24.fps})`);
  check(p24.width === 320 && p24.height === 240, `mp4-24: 320x240 (got ${p24.width}x${p24.height})`);
  check(p24.frameCount === 48, `mp4-24: 48 samples (got ${p24.frameCount})`);

  // -------------------------------------------------------------------------
  // MP4 60fps — THE bug case: the 30fps assumption halved the usable length
  // -------------------------------------------------------------------------
  const p60 = probeVideoHeader(readFileSync(mp4_60));
  check(near(p60.durationSeconds, 2, 0.1), `mp4-60: duration ~2s (got ${p60.durationSeconds})`);
  check(near(p60.fps, 60, 0.01), `mp4-60: fps 60 detected (got ${p60.fps})`);
  check(p60.frameCount === 120, `mp4-60: 120 samples (got ${p60.frameCount})`);
  // The route's cap math with the REAL fps: a full 30s @60fps clip loads
  // 1800 frames, not the 900 the old 30fps assumption produced.
  check(
    matteFrameCap(Math.min(30, MATTE_MAX_SECONDS), p60.fps) === 1800,
    "mp4-60: frame cap with real fps covers the whole 30s (1800 frames)",
  );

  // -------------------------------------------------------------------------
  // Faststart head-only probe (what the Range fetch hands the route)
  // -------------------------------------------------------------------------
  const head = readFileSync(mp4_24).subarray(0, 8192);
  const pHead = probeVideoHeader(Buffer.from(head));
  check(
    near(pHead.durationSeconds, 2, 0.1) && near(pHead.fps, 24, 0.01) && pHead.width === 320,
    "mp4-24: probing only the first 8KB (faststart moov) works",
  );

  // -------------------------------------------------------------------------
  // Tail-moov head → ProbeError (route falls back, never downloads the tail)
  // -------------------------------------------------------------------------
  const tailHead = readFileSync(mp4_nofaststart).subarray(0, 4096);
  expectProbeError(Buffer.from(tailHead), "mp4 tail-moov head throws ProbeError");
  // ...but the full file (url/path uploads buffer everything) still probes.
  const pTail = probeVideoHeader(readFileSync(mp4_nofaststart));
  check(near(pTail.fps, 24, 0.01), `mp4 tail-moov FULL file probes fine (fps ${pTail.fps})`);

  // -------------------------------------------------------------------------
  // WebM VP9 24fps
  // -------------------------------------------------------------------------
  const webmBytes = readFileSync(webm_24);
  const pWebm = probeVideoHeader(webmBytes);
  check(pWebm.container === "webm", "webm: container is webm");
  check(near(pWebm.durationSeconds, 2, 0.1), `webm: duration ~2s (got ${pWebm.durationSeconds})`);
  check(pWebm.width === 320 && pWebm.height === 240, `webm: 320x240 (got ${pWebm.width}x${pWebm.height})`);
  // fps contract: real value or undefined — NEVER a fabricated number.
  check(
    pWebm.fps === undefined || near(pWebm.fps, 24, 0.01),
    `webm: fps is 24 or (honestly) undefined — never invented (got ${pWebm.fps})`,
  );
  console.log(`     webm DefaultDuration-derived fps: ${pWebm.fps ?? "absent (VFR mux)"}`);
  // Head-only probe (Info+Tracks precede the first Cluster).
  const pWebmHead = probeVideoHeader(Buffer.from(webmBytes.subarray(0, 4096)));
  check(
    near(pWebmHead.durationSeconds, 2, 0.1) && pWebmHead.width === 320,
    "webm: probing only the first 4KB works",
  );

  // -------------------------------------------------------------------------
  // Audio-only MP4 — negative case: duration yes, video facts NO
  // -------------------------------------------------------------------------
  const pAudio = probeVideoHeader(readFileSync(mp4_audio));
  check(near(pAudio.durationSeconds, 2, 0.15), `audio-only mp4: duration ~2s (got ${pAudio.durationSeconds})`);
  check(
    pAudio.fps === undefined &&
      pAudio.width === undefined &&
      pAudio.height === undefined &&
      pAudio.frameCount === undefined,
    "audio-only mp4: fps/width/height/frameCount all undefined (no video track, nothing guessed)",
  );

  // -------------------------------------------------------------------------
  // Garbage / truncated inputs → ProbeError, never a bogus result
  // -------------------------------------------------------------------------
  expectProbeError(Buffer.from("not a video at all, sorry"), "garbage buffer throws ProbeError");
  expectProbeError(Buffer.alloc(0), "empty buffer throws ProbeError");
  expectProbeError(
    Buffer.from(webmBytes.subarray(0, 24)),
    "truncated webm EBML header throws ProbeError",
  );
  expectProbeError(
    readFileSync(mp4_24).subarray(0, 20), // ftyp only, moov cut off
    "mp4 cut inside ftyp/moov throws ProbeError",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fail > 0) {
  console.log(`\n${fail} FAILURE(S)`);
  process.exit(1);
}
console.log("\nall video-probe checks passed");
