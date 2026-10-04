/* WAN-ANIMATE / WAN-REPLACE driver-length sizing (ticket
 * videostar-wan-replace-ignores-source-length). Real container fixtures made
 * with ffmpeg, probed through the SAME probe + helper the route uses
 * (run: npx tsx scripts/wan-frames.test.mts [optional real clip.mp4]).
 * Negative control first: the pre-fix path (wanAnimateLength(undefined))
 * pads a 65-frame driver to 81. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeVideoHeader, VIDEO_PROBE_HEAD_BYTES } from "../src/lib/video-probe";
import {
  WAN_ANIMATE_DEFAULT_LENGTH,
  WAN_ANIMATE_MAX_LENGTH,
  wanAnimateLength,
  wanFramesFromSource,
} from "../src/lib/workflow-builder";

let fail = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.log("FAIL " + msg);
  } else console.log("pass " + msg);
}

const dir = mkdtempSync(path.join(tmpdir(), "wan-frames-"));
function make(name: string, frames: number, fps: number, codecArgs: string[]): Buffer {
  const out = path.join(dir, name);
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=320x176:rate=${fps}`,
    "-frames:v", String(frames), ...codecArgs, out,
  ]);
  return readFileSync(out).subarray(0, VIDEO_PROBE_HEAD_BYTES);
}
const mp4 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
const webm = ["-c:v", "libvpx-vp9", "-b:v", "200k"];

try {
  // Negative control: the pre-fix behaviour.
  check(wanAnimateLength(undefined) === 81, "NEG CONTROL pre-fix: frames absent -> 81 regardless of driver");

  const p65 = probeVideoHeader(make("d65.mp4", 65, 24, mp4));
  const d65 = wanFramesFromSource(undefined, p65, "WAN-REPLACE");
  check(d65.ok && d65.frames === 65 && d65.basis === "probed", `65-frame mp4 driver -> 65 (got ${JSON.stringify(d65)})`);

  const d65x = wanFramesFromSource(33, p65, "WAN-REPLACE");
  check(d65x.ok && d65x.frames === 33 && d65x.basis === "explicit", `explicit frames=33 wins over probed 65 (got ${JSON.stringify(d65x)})`);
  const d65x81 = wanFramesFromSource(81, p65, "WAN-REPLACE");
  check(d65x81.ok && d65x81.frames === 81 && d65x81.basis === "explicit", "explicit frames=81 still wins (caller's call)");

  const p67 = probeVideoHeader(make("d67.mp4", 67, 24, mp4));
  const d67 = wanFramesFromSource(undefined, p67, "WAN-REPLACE");
  check(d67.ok && d67.frames === 65 && d67.sourceFrames === 67, `67-frame driver snaps DOWN to 65, never pads to 69 (got ${JSON.stringify(d67)})`);

  const pw = probeVideoHeader(make("d49.webm", 49, 24, webm));
  const dw = wanFramesFromSource(undefined, pw, "WAN-ANIMATE");
  check(dw.ok && dw.frames === 49, `49-frame vp9 webm (no stts; duration x fps) -> 49 (got ${JSON.stringify(dw)}, probe ${JSON.stringify(pw)})`);

  const p200 = probeVideoHeader(make("d200.mp4", 200, 24, mp4));
  const d200 = wanFramesFromSource(undefined, p200, "The WAN-REPLACE lane");
  check(!d200.ok && /200 frames/.test(d200.error) && /161/.test(d200.error), `200-frame driver refused honestly (got ${JSON.stringify(d200)})`);
  const d200x = wanFramesFromSource(161, p200, "The WAN-REPLACE lane");
  check(d200x.ok && d200x.frames === 161, "200-frame driver + explicit frames=161 renders the head");

  const pmax = probeVideoHeader(make("d161.mp4", WAN_ANIMATE_MAX_LENGTH, 24, mp4));
  const dmax = wanFramesFromSource(undefined, pmax);
  check(dmax.ok && dmax.frames === 161, "exactly-161-frame driver accepted at 161");

  const p3 = probeVideoHeader(make("d3.mp4", 3, 24, mp4));
  const d3 = wanFramesFromSource(undefined, p3);
  check(!d3.ok, "3-frame driver refused (< 5)");

  const dnone = wanFramesFromSource(undefined, undefined);
  check(dnone.ok && dnone.frames === WAN_ANIMATE_DEFAULT_LENGTH && dnone.basis === "default", "unprobeable driver -> 81 default, flagged basis=default");
  const dnan = wanFramesFromSource(Number.NaN, p65);
  check(dnan.ok && dnan.frames === 65, "NaN frames treated as absent -> probed 65");
  const dshort = wanFramesFromSource(undefined, { durationSeconds: 2.0416, fps: 24 });
  check(dshort.ok && dshort.sourceFrames === 49, "webm duration a hair under 49 frames (2.0416s @24) still counts 49");

  const real = process.argv[2];
  if (real) {
    const pr = probeVideoHeader(readFileSync(real).subarray(0, VIDEO_PROBE_HEAD_BYTES));
    const dr = wanFramesFromSource(undefined, pr, "WAN-REPLACE");
    check(dr.ok && dr.frames === 65, `REAL café driver ${path.basename(real)} -> ${JSON.stringify(dr)} (probe ${JSON.stringify(pr)})`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
