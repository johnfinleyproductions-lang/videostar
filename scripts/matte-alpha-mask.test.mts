/* MATTE -> WAN-REPLACE mask hand-off (ticket videostar-matte-lane-drops-alpha).
 * Run: npx tsx scripts/matte-alpha-mask.test.mts
 * Optional: MATTE_REAL=/path/to/matte_000NN.webm adds a check on a REAL
 * MATTE deliverable pulled from a worker.
 *
 * Covers, on REAL ffmpeg fixtures:
 *  1. probeVideoHeader flags a VP9 yuva420p webm as alpha, and does NOT flag
 *     a plain vp9 webm or an h264 mp4.
 *  2. The decoder trap: ffmpeg's NATIVE vp9 decoder reports yuv420p and
 *     alphaextract fails on a file that DOES carry alpha; libvpx-vp9 reads it.
 *  3. NEGATIVE CONTROL for the pre-fix hand-off: the template's red-channel
 *     read of an alpha webm is the SOURCE PICTURE, not the matte.
 *  4. buildWanReplace's alpha branch: VHS_LoadVideoFFmpeg(mask) -> InvertMask
 *     under the same node id, both consumers still linked, nothing dangling;
 *     the non-alpha build is byte-identical to the legacy red-channel graph. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeVideoHeader } from "../src/lib/video-probe";
import {
  buildWanReplace,
  loadTemplate,
  WAN_REPLACE_TEMPLATE_TITLES as T,
} from "../src/lib/workflow-builder";

let fail = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.log("FAIL " + msg);
  } else console.log("pass " + msg);
}

const dir = mkdtempSync(path.join(tmpdir(), "matte-alpha-"));
function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}
function ffmpegOut(args: string[]): Buffer {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "-f", "rawvideo", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
}
function pixFmt(file: string, libvpx: boolean): string {
  return execFileSync("ffprobe", [
    "-v", "error", ...(libvpx ? ["-c:v", "libvpx-vp9"] : []), "-i", file,
    "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0",
  ]).toString().trim();
}
function meanAbsDiff(a: Buffer, b: Buffer): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

const W = 320;
const H = 240;
const alphaWebm = path.join(dir, "matte-like.webm");
const plainWebm = path.join(dir, "plain.webm");
const mp4 = path.join(dir, "plain.mp4");
const truthMask = path.join(dir, "truth.png");
// Subject = a disc; the PICTURE is testsrc (like MATTE: original footage in
// RGB, matte in alpha).
const disc = `geq=lum='if(lt(hypot(X-160,Y-120),70),255,0)':cb=128:cr=128`;

try {
  ffmpeg(["-f", "lavfi", "-i", `nullsrc=s=${W}x${H}:r=24:d=1,${disc},format=gray`, "-frames:v", "1", truthMask]);
  ffmpeg([
    "-f", "lavfi", "-i", `testsrc=duration=1:size=${W}x${H}:rate=24`,
    "-f", "lavfi", "-i", `nullsrc=s=${W}x${H}:r=24:d=1,${disc},format=gray`,
    "-filter_complex", "[0:v][1:v]alphamerge,format=yuva420p",
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-crf", "20", "-b:v", "0",
    alphaWebm,
  ]);
  ffmpeg(["-f", "lavfi", "-i", `testsrc=duration=1:size=${W}x${H}:rate=24`,
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", plainWebm]);
  ffmpeg(["-f", "lavfi", "-i", `testsrc=duration=1:size=${W}x${H}:rate=24`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);

  // 1. Header probe -------------------------------------------------------
  const pa = probeVideoHeader(readFileSync(alphaWebm));
  check(pa.alpha === true, `yuva420p vp9 webm probes alpha=true (got ${JSON.stringify(pa)})`);
  const pp = probeVideoHeader(readFileSync(plainWebm));
  check(pp.alpha === undefined, `plain vp9 webm has no alpha flag (got ${JSON.stringify(pp)})`);
  const pm = probeVideoHeader(readFileSync(mp4));
  check(pm.alpha === undefined, `h264 mp4 has no alpha flag (got ${JSON.stringify(pm)})`);
  const head = readFileSync(alphaWebm).subarray(0, 4096);
  check(probeVideoHeader(head).alpha === true, "alpha flag found from a 4KB head alone (Range-fetch path)");

  // 2. The decoder trap ---------------------------------------------------
  check(pixFmt(alphaWebm, false) === "yuv420p",
    `native vp9 decoder HIDES the alpha (reports ${pixFmt(alphaWebm, false)})`);
  check(pixFmt(alphaWebm, true) === "yuva420p",
    `libvpx-vp9 decoder sees it (reports ${pixFmt(alphaWebm, true)})`);

  // 3. Negative control + the fixed read ----------------------------------
  const truth = ffmpegOut(["-i", truthMask, "-vf", "format=gray"]);
  const alphaRead = ffmpegOut(["-c:v", "libvpx-vp9", "-i", alphaWebm,
    "-vf", "select=eq(n\\,12),alphaextract,format=gray", "-frames:v", "1"]);
  const redRead = ffmpegOut(["-i", alphaWebm,
    "-vf", "select=eq(n\\,12),format=gbrp,extractplanes=r", "-frames:v", "1"]);
  const dAlpha = meanAbsDiff(alphaRead, truth);
  const dRed = meanAbsDiff(redRead, truth);
  check(dAlpha < 3, `alpha-plane read matches the subject mask (mean abs diff ${dAlpha.toFixed(2)}/255)`);
  check(dRed > 40, `NEG CONTROL: red-channel read (pre-fix template) is NOT the mask (mean abs diff ${dRed.toFixed(2)}/255)`);

  // 4. Builder ------------------------------------------------------------
  const template = loadTemplate("wan_replace.json");
  const base = {
    template, videoName: "jobs/x/clip.mp4", referenceName: "jobs/x/ref.png",
    maskName: "jobs/x/mask.webm", positive: "p", seed: 1, frames: 65,
  };
  const legacy = buildWanReplace(base);
  const explicitFalse = buildWanReplace({ ...base, maskHasAlpha: false });
  check(JSON.stringify(legacy) === JSON.stringify(explicitFalse),
    "maskHasAlpha:false builds the exact legacy graph");
  const byTitle = (wf: Record<string, { class_type: string; _meta?: { title?: string } }>, t: string) =>
    Object.entries(wf).find(([, n]) => n._meta?.title === t);
  const [lMaskId, lMask] = byTitle(legacy, T.mask)!;
  const [, lConv] = byTitle(legacy, T.maskConvert)!;
  check(lMask.class_type === "LoadVideo" && lConv.class_type === "ImageToMask",
    `legacy mask branch = LoadVideo -> ImageToMask (got ${lMask.class_type} -> ${lConv.class_type})`);

  const wf = buildWanReplace({ ...base, maskHasAlpha: true });
  const [maskId, mask] = byTitle(wf, T.mask)! as [string, { class_type: string; inputs: Record<string, unknown> }];
  const [convId, conv] = byTitle(wf, T.maskConvert)! as [string, { class_type: string; inputs: Record<string, unknown> }];
  check(maskId === lMaskId, "alpha branch keeps the FF Mask Video node id");
  check(mask.class_type === "VHS_LoadVideoFFmpeg" && mask.inputs.video === base.maskName,
    `alpha branch loads the mask with VHS_LoadVideoFFmpeg (got ${mask.class_type}, video=${String(mask.inputs.video)})`);
  check(mask.inputs.force_rate === 0 && mask.inputs.frame_load_cap === 0 && mask.inputs.start_time === 0,
    "alpha branch loads every frame at the file's own rate");
  check(conv.class_type === "InvertMask" && JSON.stringify(conv.inputs.mask) === JSON.stringify([maskId, 1]),
    `FF Mask Convert = InvertMask(<mask>.1 = 1-alpha) (got ${conv.class_type} ${JSON.stringify(conv.inputs)})`);
  check(!byTitle(wf, T.maskComponents), "FF Mask Components removed on the alpha branch");
  const consumers = Object.entries(wf).filter(([, n]) =>
    Object.values((n as { inputs?: Record<string, unknown> }).inputs ?? {}).some(
      (v) => Array.isArray(v) && v[0] === convId,
    ),
  ).map(([, n]) => n._meta?.title);
  check(consumers.includes("FF Replace") && consumers.includes("FF Background Blackout"),
    `character_mask + background blackout still wired to the mask (${consumers.join(", ")})`);
  const ids = new Set(Object.keys(wf));
  const dangling = Object.entries(wf).flatMap(([id, n]) =>
    Object.values((n as { inputs?: Record<string, unknown> }).inputs ?? {})
      .filter((v) => Array.isArray(v) && typeof v[0] === "string" && !ids.has(v[0]))
      .map((v) => `${id}->${(v as string[])[0]}`),
  );
  check(dangling.length === 0, `no dangling links (${dangling.join(", ") || "none"})`);
  check(JSON.stringify(template).includes('"ImageToMask"'), "template object not mutated by the alpha build");

  // Optional: a REAL MATTE deliverable ------------------------------------
  const real = process.env.MATTE_REAL;
  if (real && existsSync(real)) {
    const pr = probeVideoHeader(readFileSync(real));
    check(pr.alpha === true, `REAL MATTE deliverable ${path.basename(real)} probes alpha=true (${JSON.stringify(pr)})`);
  } else {
    console.log("skip REAL MATTE check (set MATTE_REAL=<path> to run it)");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nRESULT: ${fail} FAILURES` : "\nALL PASS");
process.exit(fail ? 1 : 0);
