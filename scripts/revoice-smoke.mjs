/**
 * REVOICE lane smoke — proves the lane's ONE load-bearing claim: the delivered
 * clip's VIDEO BITSTREAM is byte-identical to the source, while the voice has
 * actually changed. Run: node scripts/revoice-smoke.mjs
 *
 * Black-box on purpose. It drives the RUNNING service over HTTP and never
 * imports the app's own modules, so it tests the DEPLOYED build rather than the
 * source tree — which matters here: src/lib/models.ts changes only take effect
 * after `next build`, so a source-importing test would pass against a stale
 * server. It is plain .mjs (not .mts) for the same "must actually run" reason:
 * `tsx` is NOT installed on this box, so every scripts/*.mts needs a network
 * fetch of tsx before it will start, while node runs this directly — the
 * validate-lanes.mjs precedent.
 *
 * All media work goes through the WSL ffmpeg/ffprobe via wsl.exe rather than a
 * Windows ffmpeg, because (a) that is the exact dependency the lane declares
 * and getRevoicePreflight() checks, and (b) there is NO ffmpeg on the Windows
 * PATH on this box (which is also why scripts/video-probe.test.mts cannot run
 * here — it shells out to a bare `ffmpeg`).
 *
 * Fixtures are generated, not staged: a 3s testsrc+sine mp4 and a 6s sine wav.
 * Chatterbox VC converts a tone happily (verified), and the invariant under
 * test is a property of the VIDEO stream, so synthetic audio costs the test
 * nothing and makes it hermetic — no dependency on assets surviving in
 * /home/evergreen/revoice/in.
 *
 * Tiers, and what each is for:
 *   1 CONTRACT   the served lane manifest still describes this lane correctly
 *   2 GUARDS     bad requests are refused with useful, DISTINGUISHABLE 400s
 *   2b INSTRUMENT the test's own md5 measurement is proven to discriminate
 *   3 LIVE       a real conversion, delivered, with the invariant measured
 *   3b AUDIO     the voice ACTUALLY CHANGED (see below — this is the one that
 *                an adversarial review proved was missing)
 *   4 MUTATION   a deliberately re-encoding copy of revoice.py MUST fail —
 *                without this, tier 3 proves only that md5(x) == md5(x), and a
 *                lane that silently re-encoded would still pass every check
 *   5 IDENTITY   with REAL SPEECH, the speaker moved toward the target voice
 *
 * WHY 3b AND 5 EXIST (read before trimming them). A review of the first version
 * of this file demonstrated, on the box, that three separately broken lanes all
 * passed 100% of tier 3: one that muxed the untouched source audio back in
 * (zero conversion), one that delivered pure silence, and one whose audio
 * stopped 40% of the way through. The original audio assertions could not fail:
 * "output audio md5 != source audio md5" is true of ANY re-mux (the mux always
 * re-encodes to AAC), and "output is 24kHz mono" is equally true of the source,
 * which revoice.py extracts at exactly 24kHz mono. Measured separations now
 * used instead (real ... broken):
 *   mean volume          -44 dB ... -91 dB (silence)
 *   final-second volume  -45 dB ... -91 dB (truncated/dropped chunk)
 *   content similarity    0.61 synthetic / 0.78 speech ... 0.99+ (bypass)
 *   speaker->target       0.96 ... 0.52 unmoved (bypass, real speech only)
 * Thresholds sit in the middle of those gaps, not at their edges.
 *
 * Env: REVOICE_SMOKE_BASE (default http://192.168.4.196:3060)
 *      REVOICE_SMOKE_DISTRO (default Ubuntu-24.04)
 *      REVOICE_SMOKE_SKIP_LIVE=1      skip tiers 3-5 (contract/guards only)
 *      REVOICE_SMOKE_SKIP_MUTATION=1  skip tier 4 only
 *      REVOICE_SMOKE_SPEECH_VIDEO     real-speech clip for tier 5
 *      REVOICE_SMOKE_SPEECH_VOICE     real-speech target reference for tier 5
 *      REVOICE_SMOKE_ALLOW_SKIP=1     let a run with SKIPs still exit 0
 *      REVOICE_SMOKE_TIMEOUT_MS       per-job poll ceiling (default 600000)
 *
 * A run with any SKIP exits NON-ZERO unless REVOICE_SMOKE_ALLOW_SKIP=1. A CI
 * job that sets SKIP_LIVE to dodge the two CPU conversions would otherwise read
 * green while the invariant, the delivery route and the mutation control all
 * went unmeasured.
 *
 * Leaves its jobs in data/history.json and its outputs in
 * public/outputs/revoice/ on purpose: that IS the evidence trail.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Env reader that TRIMS. This is not defensive padding: on Windows the usual
 * way to set a variable for one command is `set VAR=1 && node ...`, and cmd.exe
 * assigns everything up to the `&&` — including the space — so VAR becomes
 * "1 ", not "1". An exact-equality flag check silently does nothing there,
 * which means a run the operator believed was skipping a tier would quietly
 * execute it (or worse, the inverse). Caught live while testing the skip path.
 */
function env(name, fallback = "") {
  const raw = process.env[name];
  return (raw === undefined ? fallback : String(raw)).trim();
}

/** Accepts 1/true/yes in any case, so the flags behave the way operators expect. */
function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(env(name));
}

const BASE = (env("REVOICE_SMOKE_BASE") || "http://192.168.4.196:3060").replace(/\/$/, "");
const DISTRO = env("REVOICE_SMOKE_DISTRO") || "Ubuntu-24.04";
const WSL = env("REVOICE_SMOKE_WSL") || "wsl.exe";
const SKIP_LIVE = envFlag("REVOICE_SMOKE_SKIP_LIVE");
const SKIP_MUTATION = envFlag("REVOICE_SMOKE_SKIP_MUTATION");
const ALLOW_SKIP = envFlag("REVOICE_SMOKE_ALLOW_SKIP");
const JOB_TIMEOUT_MS = Number(env("REVOICE_SMOKE_TIMEOUT_MS") || 600000);
const SCRIPT = env("REVOICE_SCRIPT") || "/home/evergreen/revoice/revoice.py";
const PYTHON = env("REVOICE_PYTHON") || "/home/evergreen/venvs/revoice/bin/python";
/** Ships next to this file; measures whether the voice actually changed. */
const AUDIO_CHECK = env("REVOICE_SMOKE_AUDIO_CHECK")
  || "/mnt/v/Evergreen/apps/videostar/scripts/revoice-audio-check.py";
/** Real speech for tier 5. A tone has no timbre, so identity needs real voices. */
const SPEECH_VIDEO = env("REVOICE_SMOKE_SPEECH_VIDEO") || "/home/evergreen/revoice/in/revoice_src.mp4";
const SPEECH_VOICE = env("REVOICE_SMOKE_SPEECH_VOICE") || "/home/evergreen/revoice/in/target_voice.wav";

// Thresholds sit mid-gap between measured real and measured broken values (see
// the header table), so they discriminate without sitting on either edge.
const MIN_MEAN_VOLUME_DB = -80;   // real -44 … silence -91
const MIN_TAIL_VOLUME_DB = -80;   // real -45 … truncated -91
const MAX_CONTENT_SIMILARITY = 0.95; // real 0.61/0.78 … bypass 0.987/0.9995
const MIN_SPEAKER_GAIN = 0.15;    // output→target must beat source→target by this

let fail = 0;
let skipped = 0;

function check(cond, msg) {
  if (cond) {
    console.log("pass " + msg);
  } else {
    fail++;
    console.log("FAIL " + msg);
  }
}

/** Loud by design: a skipped tier must never read as a passing one. */
function skip(msg) {
  skipped++;
  console.log("SKIP " + msg);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ---------------------------------------------------------------------------
// WSL plumbing (mirrors toWslPath in src/lib/revoice-client.ts)
// ---------------------------------------------------------------------------
function toWsl(winPath) {
  const normalized = winPath.replace(/\\/g, "/");
  const m = normalized.match(/^([A-Za-z]):\/(.*)$/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : normalized;
}

function wsl(args) {
  return execFileSync(WSL, ["-d", DISTRO, "--", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Run in WSL, never throwing: returns {status, stdout, stderr}.
 *
 * spawnSync, NOT execFileSync — execFileSync only hands back stdout on success,
 * and ffmpeg writes the measurements this suite depends on (volumedetect's
 * mean_volume) to STDERR while exiting 0. An earlier version of this helper
 * dropped stderr on success, which made every volume reading silently null and
 * two real assertions unevaluable.
 */
function wslTry(args) {
  const r = spawnSync(WSL, ["-d", DISTRO, "--", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || String(r.error?.message || ""),
  };
}

function ffmpeg(args) {
  return wsl(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args]);
}

/**
 * MD5 of the VIDEO BITSTREAM alone — container and audio excluded. `-c copy`
 * hashes the coded packets, so a re-encode changes this even when the picture
 * looks identical. This is the lane's invariant made measurable, and it is the
 * same measurement revoice.py gates itself on.
 */
function videoStreamMd5(winPath) {
  const out = wsl(["ffmpeg", "-v", "error", "-i", toWsl(winPath), "-map", "0:v", "-c", "copy", "-f", "md5", "-"]);
  return out.trim().split("=").pop();
}

function audioStreamMd5(winPath) {
  const out = wsl(["ffmpeg", "-v", "error", "-i", toWsl(winPath), "-map", "0:a", "-c", "copy", "-f", "md5", "-"]);
  return out.trim().split("=").pop();
}

/** Video packet count + duration, read off the real container. */
function videoFacts(winPath) {
  const out = wsl([
    "ffprobe", "-v", "error", "-select_streams", "v",
    "-count_packets", "-show_entries", "stream=nb_read_packets,duration",
    "-of", "csv=p=0", toWsl(winPath),
  ]);
  const [duration, packets] = out.trim().split(",");
  return { packets: Number(packets), duration: Number(duration) };
}

/**
 * Audio sample rate + channel count. NOTE this proves nothing about WHOSE voice
 * it is: revoice.py extracts the source at 24kHz mono before converting, so
 * 24000/1 is equally true of an unconverted passthrough. Kept only as a format
 * assertion; the voice itself is tested in tiers 3b and 5.
 */
function audioFacts(winPath) {
  const out = wsl([
    "ffprobe", "-v", "error", "-select_streams", "a",
    "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", toWsl(winPath),
  ]);
  const [sampleRate, channels] = out.trim().split(",");
  return { sampleRate: Number(sampleRate), channels: Number(channels) };
}

/**
 * mean_volume in dB over the whole track, or over a window when `seek`/`dur` are
 * given. Silence reads about -91 dB, real content about -45, so this separates
 * "there is audio here" from "there is not" with a wide margin.
 */
function meanVolumeDb(winPath, seek, dur) {
  const args = ["ffmpeg", "-hide_banner"];
  if (seek !== undefined) args.push("-ss", String(seek));
  if (dur !== undefined) args.push("-t", String(dur));
  args.push("-i", toWsl(winPath), "-map", "0:a", "-af", "volumedetect", "-f", "null", "-");
  const r = wslTry(args);
  const m = (r.stderr + r.stdout).match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
}

/** Run the versioned audio checker; returns its JSON or {ok:false,...}. */
function audioCheck(sourceWin, outputWin, targetWin) {
  const args = [PYTHON, AUDIO_CHECK, "--source", toWsl(sourceWin), "--output", toWsl(outputWin)];
  if (targetWin) args.push("--target", toWsl(targetWin));
  const r = wslTry(args);
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: `unparseable output (status ${r.status}): ${(r.stderr || line || "").slice(-300)}` };
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
/**
 * fetch with one retry on a TRANSPORT error (never on an HTTP status).
 *
 * Needed because this suite has long model-bound gaps between requests: Node's
 * http server closes an idle keep-alive socket after ~5s, while undici keeps it
 * pooled, so the first request after a ~40s conversion can die with ECONNRESET
 * against a perfectly healthy server. Observed exactly that, and because the
 * throw was uncaught it discarded every result the run had already produced.
 * `connection: close` avoids pooling; the retry covers the rest. An HTTP error
 * status is passed through untouched — those are findings, not flakes.
 */
async function http(url, init = {}, timeoutMs = 120000) {
  const opts = {
    ...init,
    headers: { connection: "close", ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  };
  try {
    return await fetch(url, opts);
  } catch (first) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    } catch (second) {
      throw new Error(`fetch ${url} failed twice: ${first.message} / ${second.message}`);
    }
  }
}

async function postGenerate(body) {
  let res;
  try {
    res = await http(`${BASE}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Report as a status-0 result rather than throwing: one dead request must
    // not abort the suite and lose the findings already gathered.
    return { status: 0, json: { error: error.message } };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body (e.g. an HTML error page) — keep json null, report status
  }
  return { status: res.status, json };
}

async function pollJob(id) {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const res = await http(`${BASE}/api/status/${id}`, {}, 30000);
    last = await res.json();
    if (last.status === "completed" || last.status === "failed") return last;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { ...(last || {}), status: "timeout" };
}

/** Text of an error field, lowercased, safe on any shape. */
function errText(json) {
  return String((json && json.error) || "").toLowerCase();
}

/**
 * Serve a directory so the lane can be driven through its DOCUMENTED
 * videoUrl/audioUrl interface instead of the local-path shortcut.
 *
 * BINDS LOOPBACK ONLY, and this is not a detail — an earlier version bound
 * 0.0.0.0 and Windows responded by auto-creating two "Query User" BLOCK rules
 * for node.exe (TCP + UDP, Public profile) because a listening socket appeared
 * with no interactive user to approve the prompt. Those rules are PROGRAM-wide
 * and block rules beat allow rules, so they silently took VideoStar's own port
 * 3060 off the LAN while leaving it fine on localhost — a firewall change
 * caused by a test run. The app and this script always share a host (the lane
 * spawns WSL locally), so loopback is both sufficient and side-effect-free.
 * Never widen this bind.
 */
function serveDir(rootDir) {
  const server = createServer((req, res) => {
    const name = path.basename(decodeURIComponent((req.url || "").split("?")[0]));
    const file = path.join(rootDir, name);
    // Serve only plain basenames out of the fixture dir — no traversal.
    if (!name || name.startsWith(".") || path.dirname(file) !== rootDir) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, {
        "content-type": name.endsWith(".wav") ? "audio/wav" : "video/mp4",
        "content-length": String(body.length),
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  // listen() is async — resolve only once the port is actually assigned.
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Tier 0 — environment. A missing dependency must say so, not masquerade as a
// lane failure.
// ---------------------------------------------------------------------------
section("tier 0: environment");

const wslProbe = wslTry(["sh", "-c", "command -v ffmpeg && command -v ffprobe"]);
if (wslProbe.status !== 0) {
  console.log(`FAIL cannot reach ffmpeg/ffprobe in wsl:${DISTRO} — ${wslProbe.stderr.trim()}`);
  console.log("\nABORT: the smoke needs the same WSL ffmpeg the lane itself requires.");
  process.exit(1);
}
check(true, `wsl:${DISTRO} has ffmpeg + ffprobe`);

let lanes = null;
try {
  const res = await http(`${BASE}/api/lanes`, {}, 20000);
  const body = await res.json();
  lanes = Array.isArray(body) ? body : body.lanes;
  check(res.status === 200 && Array.isArray(lanes), `GET /api/lanes reachable at ${BASE} (${res.status})`);
} catch (error) {
  console.log(`FAIL GET /api/lanes at ${BASE}: ${error.message}`);
  console.log("\nABORT: VideoStar is not answering — start it before running the smoke.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Tier 1 — lane contract, as SERVED (not as written in source)
// ---------------------------------------------------------------------------
section("tier 1: lane contract");

const lane = (lanes || []).find((l) => l.laneKey === "REVOICE");
check(Boolean(lane), "REVOICE present in the served lane manifest");

if (lane) {
  check(lane.kind === "revoice", `kind is "revoice" (got ${JSON.stringify(lane.kind)})`);
  check(lane.executor === "generate", `executor is "generate" (got ${JSON.stringify(lane.executor)})`);
  check(lane.endpoint === "/api/generate", `endpoint is /api/generate (got ${JSON.stringify(lane.endpoint)})`);
  check(lane.modelId === "revoice", `modelId is "revoice" (got ${JSON.stringify(lane.modelId)})`);
  check(lane.outputFormat === "mp4", `outputFormat is mp4 (got ${JSON.stringify(lane.outputFormat)})`);
  // A TRANSFORM of real footage: an image must never be accepted here, or the
  // reroute in resolveVideoModelId would swap the dub for a generated clip.
  check(lane.requiresImage === false && lane.acceptsImage === false, "takes no image (requiresImage/acceptsImage both false)");
  check(lane.supportsAudio === true, "supportsAudio true (the deliverable IS audio + untouched picture)");

  const params = new Map((lane.extraParams || []).map((p) => [p.name, p]));
  check(params.get("videoUrl")?.required === true, "videoUrl is a REQUIRED param");
  check(params.get("audioUrl")?.required === true, "audioUrl is a REQUIRED param");
  check(params.has("keepAudio"), "keepAudio param documented");
  // The documented confusion hazard: LIP-SYNC also takes audioUrl but means
  // the opposite by it. If this wording is ever lost, callers will mix them up.
  const audioDoc = String(params.get("audioUrl")?.description || "");
  check(/lip-sync/i.test(audioDoc), "audioUrl doc distinguishes this lane from LIP-SYNC");
}

// ---------------------------------------------------------------------------
// Tier 2 — request guards. Every one of these must be a 400 naming the
// problem, never a 500 and never a silent success.
// ---------------------------------------------------------------------------
section("tier 2: request guards");

const dir = mkdtempSync(path.join(tmpdir(), "revoice-smoke-"));
const clip = path.join(dir, "clip.mp4");
const voice = path.join(dir, "voice.wav");
const shortVoice = path.join(dir, "short.wav");

try {
  // 3s of real h264 + a real aac track; 6s mono 24k reference; 1s too-short ref.
  ffmpeg(["-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=200:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-shortest", "-movflags", "+faststart", toWsl(clip)]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:duration=6",
    "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", toWsl(voice)]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:duration=1",
    "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", toWsl(shortVoice)]);
  console.log(`fixtures in ${dir}`);

  const noInputs = await postGenerate({ laneKey: "REVOICE" });
  check(noInputs.status === 400 && /video/.test(errText(noInputs.json)),
    `no inputs → 400 naming the video (got ${noInputs.status})`);
  // The prompt-optional rule: this lane has no text anywhere in its pipeline,
  // so a missing prompt must never be what stops the request.
  check(!/prompt is required/.test(errText(noInputs.json)),
    "no inputs → does NOT complain about a missing prompt (prompt-optional lane)");

  // These two guards must be told APART, not just seen to 400. The missing-video
  // message contains the phrase "re-voice" and the missing-voice message contains
  // "reference", so loose patterns let each guard pass on the OTHER one's error —
  // meaning a broken videoPath resolver would silently satisfy both. Match on
  // text unique to each.
  const noVoice = await postGenerate({ laneKey: "REVOICE", videoPath: clip });
  check(noVoice.status === 400 && /requires a target-voice reference/.test(errText(noVoice.json)),
    `video but no target voice → 400 SPECIFICALLY about the voice reference (got ${noVoice.status}: ${errText(noVoice.json).slice(0, 80)})`);

  const tooShort = await postGenerate({ laneKey: "REVOICE", videoPath: clip, audioPath: shortVoice });
  check(tooShort.status === 400 && /is only \d/.test(errText(tooShort.json)) && /at least/.test(errText(tooShort.json)),
    `1s voice reference → 400 quoting the measured length and the minimum (got ${tooShort.status}: ${errText(tooShort.json).slice(0, 80)})`);

  // Path traversal on the delivery route: the job id is regex-anchored BEFORE
  // it is ever joined onto a filesystem path.
  const traversal = await http(`${BASE}/api/output?revoice=${encodeURIComponent("../../.env")}`, {}, 20000);
  check(traversal.status === 400, `/api/output?revoice=../../.env → 400 (got ${traversal.status})`);

  // A traversal payload that DOES carry the `revoice-` prefix: the shape an
  // over-permissive regex would actually admit. `../../.env` alone is rejected
  // on the prefix and so proves nothing about the anchoring.
  const prefixedTraversal = await http(
    `${BASE}/api/output?revoice=${encodeURIComponent("revoice-../../../../Windows/win.ini")}`, {}, 20000);
  check(prefixedTraversal.status === 400,
    `prefixed traversal (revoice-../../..) → 400 (got ${prefixedTraversal.status})`);

  // A well-formed but unknown job id must 404, not 500.
  const unknown = await http(`${BASE}/api/output?revoice=revoice-00000000-0000-0000-0000-000000000000`, {}, 20000);
  check(unknown.status === 404, `unknown job id → 404 (got ${unknown.status})`);

  // ---------------------------------------------------------------------
  // Tier 2b — the test's own instrument. Tier 3 compares two md5s and
  // expects equality; equality is ALSO what a broken measurement returns
  // (`"" === ""` passes). Tier 4 validates revoice.py's md5 function, not
  // this file's, so without this the invariant could be measured with a
  // stuck instrument and still read green.
  // ---------------------------------------------------------------------
  section("tier 2b: measurement instrument");

  const selfMd5 = videoStreamMd5(clip);
  check(/^[0-9a-f]{32}$/.test(String(selfMd5)),
    `videoStreamMd5 returns a real 32-hex digest (got ${JSON.stringify(selfMd5)})`);

  // Same picture, re-encoded: the instrument MUST see a different bitstream.
  const reencoded = path.join(dir, "reencoded.mp4");
  ffmpeg(["-i", toWsl(clip), "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-movflags", "+faststart", toWsl(reencoded)]);
  check(videoStreamMd5(reencoded) !== selfMd5,
    "videoStreamMd5 DISCRIMINATES: a re-encode of the same picture hashes differently");
  // And it is stable on repeat, or tier 3's equality would be luck.
  check(videoStreamMd5(clip) === selfMd5, "videoStreamMd5 is stable across calls");

  // -------------------------------------------------------------------------
  // Tier 3 — live conversion end to end
  // -------------------------------------------------------------------------
  section("tier 3: live conversion");

  if (SKIP_LIVE) {
    skip("tier 3 live conversion (REVOICE_SMOKE_SKIP_LIVE=1) — THE INVARIANT WAS NOT MEASURED");
    skip("tier 4 mutation control (implied by SKIP_LIVE) — the guard was not exercised");
  } else {
    const srcVideoMd5 = videoStreamMd5(clip);
    const srcAudioMd5 = audioStreamMd5(clip);
    const srcFacts = videoFacts(clip);
    console.log(`source: video-md5=${srcVideoMd5} packets=${srcFacts.packets} duration=${srcFacts.duration}`);

    // Dispatch over the lane's DOCUMENTED interface (videoUrl + audioUrl, the
    // two params the manifest marks required) rather than the videoPath/audioPath
    // shortcut the guard tier uses. Those are three disjoint resolver branches,
    // and the url branch is the one real callers hit — it also exercises the
    // URL-derived filename/extension inference that decides what extension
    // Chatterbox is handed. keepAudio is sent as the STRING "true", which is the
    // form the descriptor documents.
    const served = await serveDir(dir);
    console.log(`fixture server on ${served.base}`);
    const dispatch = await postGenerate({
      laneKey: "REVOICE",
      videoUrl: `${served.base}/clip.mp4`,
      audioUrl: `${served.base}/voice.wav`,
      keepAudio: "true",
    });
    check(dispatch.status === 200, `dispatch → 200 (got ${dispatch.status} ${JSON.stringify(dispatch.json).slice(0, 200)})`);
    // Uniform response shape: the non-ComfyUI lanes still answer the same
    // contract, with the ComfyUI fields present and empty.
    check(dispatch.json?.status === "processing", "dispatch status is processing");
    check(dispatch.json?.comfyPromptId === "" && dispatch.json?.clientId === "",
      "dispatch returns empty comfyPromptId/clientId (non-ComfyUI lane, uniform shape)");

    const id = dispatch.json?.id;
    check(Boolean(id), "dispatch returned a job id");

    if (id) {
      const final = await pollJob(id);
      check(final.status === "completed",
        `job completed (got ${final.status}${final.error ? ": " + String(final.error).slice(0, 200) : ""})`);

      if (final.status === "completed") {
        check(typeof final.url === "string" && final.url.length > 0, "completed status carries a url");
        // Delivery must NOT be a static /outputs/... path: `next start` scans
        // public/ only at boot, so a file written mid-session 404s as a static
        // path until the next restart. This assertion is the regression guard
        // for that bug (which is still live in the Lens image lane).
        check(/\/api\/output\?revoice=/.test(String(final.url)),
          `url goes through /api/output (not a boot-scanned static path): ${final.url}`);

        const got = await http(String(final.url), {}, 300000);
        check(got.status === 200, `GET deliverable → 200 (got ${got.status})`);
        check(String(got.headers.get("content-type")).includes("video/mp4"),
          `deliverable content-type is video/mp4 (got ${got.headers.get("content-type")})`);

        const outPath = path.join(dir, "delivered.mp4");
        writeFileSync(outPath, Buffer.from(await got.arrayBuffer()));
        check(readFileSync(outPath).length > 0, "deliverable is non-empty");

        // ---------------- THE INVARIANT ----------------
        const outVideoMd5 = videoStreamMd5(outPath);
        check(outVideoMd5 === srcVideoMd5,
          `VIDEO STREAM BYTE-IDENTICAL: ${srcVideoMd5} (source) === ${outVideoMd5} (delivered)`);

        const outFacts = videoFacts(outPath);
        check(outFacts.packets === srcFacts.packets,
          `video packet count unchanged (${srcFacts.packets} → ${outFacts.packets})`);
        check(Math.abs(outFacts.duration - srcFacts.duration) < 0.05,
          `duration parity (${srcFacts.duration} → ${outFacts.duration})`);

        // Format only — NOT evidence about the voice (see audioFacts' comment:
        // the extracted source is also 24kHz mono, so this cannot distinguish a
        // conversion from a passthrough). The real evidence is tier 3b.
        const outAudioMd5 = audioStreamMd5(outPath);
        check(outAudioMd5 !== srcAudioMd5,
          `audio stream bytes differ (weak: any re-mux satisfies this) (${srcAudioMd5} → ${outAudioMd5})`);
        const outAudio = audioFacts(outPath);
        check(outAudio.sampleRate === 24000 && outAudio.channels === 1,
          `delivered audio is 24kHz mono (got ${outAudio.sampleRate}Hz/${outAudio.channels}ch)`);

        // -------------------------------------------------------------------
        // Tier 3b — did the voice ACTUALLY change? Each check below was
        // validated against a deliberately broken build that the previous
        // version of this suite passed (see the header).
        // -------------------------------------------------------------------
        section("tier 3b: the voice actually changed");

        const meanDb = meanVolumeDb(outPath);
        check(meanDb !== null && meanDb > MIN_MEAN_VOLUME_DB,
          `delivered audio is not silence: mean ${meanDb} dB > ${MIN_MEAN_VOLUME_DB} dB`);

        // The last second specifically: -af apad pads a short track back to the
        // video's length, so a dropped or truncated chunk is INVISIBLE to any
        // duration check and shows up only as a silent tail.
        const tailDb = meanVolumeDb(outPath, Math.max(0, srcFacts.duration - 1), 1);
        check(tailDb !== null && tailDb > MIN_TAIL_VOLUME_DB,
          `audio runs to the END (final second mean ${tailDb} dB > ${MIN_TAIL_VOLUME_DB} dB — catches a dropped chunk that apad would hide)`);

        // Extract the source audio the same way revoice.py does, then compare
        // CONTENT. A lane that muxed the source audio back in (zero conversion)
        // scores ~0.99 here; a real conversion scores far lower.
        const srcAudioWav = path.join(dir, "src-audio.wav");
        ffmpeg(["-i", toWsl(clip), "-vn", "-ac", "1", "-ar", "24000",
          "-c:a", "pcm_s16le", toWsl(srcAudioWav)]);
        const ac = audioCheck(srcAudioWav, outPath);
        check(ac.ok === true, `audio checker ran (${ac.ok ? "ok" : ac.error})`);
        if (ac.ok) {
          console.log(`content_similarity=${ac.content_similarity}`);
          check(typeof ac.content_similarity === "number"
            && ac.content_similarity < MAX_CONTENT_SIMILARITY,
            `delivered audio is NOT the source audio re-muxed: content similarity ${ac.content_similarity} < ${MAX_CONTENT_SIMILARITY} (a bypass measures ~0.99)`);
        }

        section("tier 3c: delivery details");

        // Range support — a browser cannot seek a large mp4 without it. Assert
        // the BYTES too, not just the headers: an off-by-one in the read stream
        // produces a perfectly correct Content-Range over the wrong bytes.
        const ranged = await http(String(final.url), { headers: { Range: "bytes=100-199" } }, 60000);
        check(ranged.status === 206, `Range request → 206 (got ${ranged.status})`);
        check(/^bytes 100-199\/\d+$/.test(String(ranged.headers.get("content-range"))),
          `Content-Range correct (got ${ranged.headers.get("content-range")})`);
        const rangedBytes = Buffer.from(await ranged.arrayBuffer());
        const expectBytes = readFileSync(outPath).subarray(100, 200);
        check(rangedBytes.length === 100 && rangedBytes.equals(expectBytes),
          `ranged BYTES match the file at that offset (${rangedBytes.length} bytes, equal=${rangedBytes.equals(expectBytes)})`);

        // keepAudio companion — probed, not just status-checked. The route sets
        // content-type from the query param, so a 200 + "audio/wav" is true even
        // if it served the mp4; only probing the stream can tell.
        const wavUrl = `${String(final.url)}&variant=audio`;
        const wav = await http(wavUrl, {}, 120000);
        check(wav.status === 200, `keepAudio companion → 200 (got ${wav.status})`);
        const wavPath = path.join(dir, "companion.wav");
        writeFileSync(wavPath, Buffer.from(await wav.arrayBuffer()));
        check(readFileSync(wavPath).length > 1000, `companion is non-trivial (${readFileSync(wavPath).length} bytes)`);
        const wavProbe = wslTry(["ffprobe", "-v", "error", "-show_entries",
          "stream=codec_type,codec_name", "-of", "csv=p=0", toWsl(wavPath)]);
        check(/audio/.test(wavProbe.stdout) && !/video/.test(wavProbe.stdout),
          `companion really is AUDIO-ONLY, not the mp4 relabelled (${wavProbe.stdout.trim().replace(/\n/g, " ")})`);
      }
    }
    served.server.close();

    // -----------------------------------------------------------------------
    // Tier 4 — mutation control. THE test that gives tier 3 its meaning.
    //
    // Tier 3 compares md5(source) with md5(delivered) and expects equality —
    // but equality is also what you get from a broken test that measures the
    // same file twice, or from a lane that never touched the video at all. So:
    // take the REAL revoice.py, change ONLY `-c:v copy` to `-c:v libx264`, run
    // it in LANE mode, and require that it FAILS and that the failure reaches
    // the status sidecar the API actually reads. The shipped script is never
    // modified — the mutant is a copy in a temp dir.
    // -----------------------------------------------------------------------
    section("tier 4: mutation control (a re-encoding revoice.py MUST fail)");

    if (SKIP_MUTATION) {
      skip("tier 4 mutation control (REVOICE_SMOKE_SKIP_MUTATION=1) — tier 3's equality is unproven");
    } else {
      // Echo the resolved config so a run is self-describing in the log.
      console.log(`mutating ${SCRIPT} (interpreter ${PYTHON})`);
      const mutant = `${toWsl(dir)}/mutant.py`;
      const mutantOut = `${toWsl(dir)}/mutant-out.mp4`;
      const mutantStatus = path.join(dir, "mutant-status.json");
      const mutantJob = path.join(dir, "mutant-job.json");

      // sed only the mux flag; everything else is the shipped logic.
      wsl(["sh", "-c",
        `sed 's/"-c:v", "copy"/"-c:v", "libx264"/' ${JSON.stringify(SCRIPT)} > ${JSON.stringify(mutant)}`]);
      const mutated = wslTry(["sh", "-c", `grep -c '"-c:v", "libx264"' ${JSON.stringify(mutant)}`]);
      check(mutated.status === 0 && Number(mutated.stdout.trim()) === 1,
        "mutant created: exactly one `-c:v copy` → `-c:v libx264` substitution");

      writeFileSync(mutantJob, JSON.stringify({
        id: "revoice-mutation-control",
        provider: "revoice",
        filename: "mutant-out.mp4",
        video_path: toWsl(clip),
        target_voice_path: toWsl(voice),
        output_path: mutantOut,
        status_path: toWsl(mutantStatus),
        device: process.env.REVOICE_DEVICE || "cpu",
        audio_bitrate: "192k",
        public_url: "http://example.invalid/mutation-control",
      }, null, 2));

      const run = wslTry([PYTHON, mutant, "--job", toWsl(mutantJob)]);
      // status 127/126 = the interpreter or script was never found; that is an
      // environment failure, and counting it as "the guard fired" would be the
      // worst kind of false pass in this whole suite.
      check(run.status !== 0 && run.status !== 126 && run.status !== 127,
        `mutant exits NONZERO for a real reason, not a missing interpreter (got ${run.status})`);
      check(/not copied byte-for-byte/i.test(run.stderr + run.stdout),
        "mutant's failure names the broken invariant (\"not copied byte-for-byte\")");

      // And the failure must reach the channel the status route reads, or the
      // API would happily report a re-encoded job as completed.
      let sidecar = null;
      try {
        sidecar = JSON.parse(readFileSync(mutantStatus, "utf8"));
      } catch (error) {
        check(false, `mutant status sidecar readable (${error.message})`);
      }
      if (sidecar) {
        check(sidecar.status === "failed",
          `mutant sidecar reports failed (got ${JSON.stringify(sidecar.status)}) — the shape the status route reads`);
        check(/not copied byte-for-byte/i.test(String(sidecar.error || "")),
          "mutant sidecar error names the broken invariant");
        // Not `!== true`: the failure path writes no such key at all, so that
        // would pass on any shape. Require the key to be genuinely absent.
        check(!("video_stream_copied" in sidecar),
          `mutant sidecar omits video_stream_copied entirely (got ${JSON.stringify(sidecar.video_stream_copied)})`);
      }

      // The mutant is run directly, so the assertions above prove revoice.py's
      // behaviour — NOT that checkRevoiceJob maps a failed sidecar to a failed
      // API job. Cover that separately and through the real endpoint: a clip
      // with NO AUDIO TRACK passes route validation (the header prober cannot
      // see audio streams) and revoice.py rejects it, so this is a genuine
      // API-level failure path.
      section("tier 4b: API failure path (silent clip → failed job)");

      const silent = path.join(dir, "silent.mp4");
      ffmpeg(["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=24",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", toWsl(silent)]);
      const silentServed = await serveDir(dir);
      const sd = await postGenerate({
        laneKey: "REVOICE",
        videoUrl: `${silentServed.base}/silent.mp4`,
        audioUrl: `${silentServed.base}/voice.wav`,
      });
      if (sd.status === 400) {
        // Acceptable and better: refused up front. Only valid if it says WHY.
        check(/audio/.test(errText(sd.json)),
          `silent clip refused at dispatch with an audio-specific 400 (${errText(sd.json).slice(0, 90)})`);
      } else {
        check(sd.status === 200, `silent clip dispatched (got ${sd.status}) — expect a FAILED job`);
        if (sd.json?.id) {
          const sf = await pollJob(sd.json.id);
          check(sf.status === "failed",
            `silent clip job reports FAILED through /api/status (got ${sf.status}) — proves checkRevoiceJob maps a failed sidecar`);
          check(/no audio stream/i.test(String(sf.error || "")),
            `failure reason reaches the API verbatim (got ${String(sf.error || "").slice(0, 110)})`);
        }
      }
      silentServed.server.close();
    }

    // ---------------------------------------------------------------------
    // Tier 5 — speaker identity: the lane's actual PRODUCT claim. Needs REAL
    // SPEECH, because a sine tone has no timbre to move. Asserted
    // DIRECTIONALLY — the delivered voice must sit closer to the target than
    // the source ever did — which is precisely what a bypass fails.
    // ---------------------------------------------------------------------
    section("tier 5: speaker identity (real speech)");

    const haveSpeech = wslTry(["sh", "-c",
      `test -f ${JSON.stringify(SPEECH_VIDEO)} && test -f ${JSON.stringify(SPEECH_VOICE)}`]).status === 0;

    if (!haveSpeech) {
      skip("tier 5 speaker identity — no real-speech fixtures at "
        + `${SPEECH_VIDEO} + ${SPEECH_VOICE}. THE LANE'S PRODUCT CLAIM (the voice `
        + "becomes the target speaker) IS UNPROVEN in this run. Point "
        + "REVOICE_SMOKE_SPEECH_VIDEO / _VOICE at a real clip and voice reference.");
    } else {
      wsl(["sh", "-c",
        `cp ${JSON.stringify(SPEECH_VIDEO)} ${toWsl(dir)}/speech.mp4 && `
        + `cp ${JSON.stringify(SPEECH_VOICE)} ${toWsl(dir)}/speech-voice.wav`]);
      const speechServed = await serveDir(dir);

      const sDispatch = await postGenerate({
        laneKey: "REVOICE",
        videoUrl: `${speechServed.base}/speech.mp4`,
        audioUrl: `${speechServed.base}/speech-voice.wav`,
      });
      check(sDispatch.status === 200, `real-speech dispatch → 200 (got ${sDispatch.status})`);

      if (sDispatch.status === 200 && sDispatch.json?.id) {
        const sFinal = await pollJob(sDispatch.json.id);
        check(sFinal.status === "completed",
          `real-speech job completed (got ${sFinal.status}${sFinal.error ? ": " + String(sFinal.error).slice(0, 160) : ""})`);

        if (sFinal.status === "completed") {
          const sOut = path.join(dir, "speech-out.mp4");
          const r = await http(String(sFinal.url), {}, 600000);
          writeFileSync(sOut, Buffer.from(await r.arrayBuffer()));

          // The invariant again, on REAL footage this time — a much larger,
          // longer, multi-keyframe h264 stream than the synthetic fixture.
          const sSrcMd5 = videoStreamMd5(path.join(dir, "speech.mp4"));
          check(videoStreamMd5(sOut) === sSrcMd5,
            `real-footage video stream byte-identical too (${sSrcMd5})`);

          const sSrcWav = path.join(dir, "speech-src.wav");
          ffmpeg(["-i", `${toWsl(dir)}/speech.mp4`, "-vn", "-ac", "1", "-ar", "24000",
            "-c:a", "pcm_s16le", toWsl(sSrcWav)]);

          const idc = audioCheck(sSrcWav, sOut, path.join(dir, "speech-voice.wav"));
          check(idc.ok === true, `speaker check ran (${idc.ok ? "ok" : idc.error})`);
          if (idc.ok && idc.speaker_error) {
            check(false, `speaker embeddings unavailable: ${idc.speaker_error}`);
          } else if (idc.ok) {
            console.log(`speaker: src->tgt=${idc.speaker_source_to_target} `
              + `out->tgt=${idc.speaker_output_to_target} out->src=${idc.speaker_output_to_source}`);
            check(idc.speaker_output_to_target > idc.speaker_source_to_target + MIN_SPEAKER_GAIN,
              `VOICE MOVED TO THE TARGET: out->tgt ${idc.speaker_output_to_target} > src->tgt ${idc.speaker_source_to_target} + ${MIN_SPEAKER_GAIN}`);
            check(idc.speaker_output_to_target > idc.speaker_output_to_source,
              `delivered voice resembles the TARGET more than the ORIGINAL speaker (${idc.speaker_output_to_target} > ${idc.speaker_output_to_source})`);
          }
        }
      }
      speechServed.server.close();
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
section("result");
if (fail > 0) {
  console.log(`\n${fail} FAILURE(S)`);
  process.exit(1);
}
if (skipped > 0) {
  console.log(`\n${skipped} TIER(S) SKIPPED — the checks that ran all passed, but this `
    + "run did NOT prove everything the suite can prove (see the SKIP lines above).");
  if (!ALLOW_SKIP) {
    // Exit 3, not 0: a green exit code from a run that skipped the invariant,
    // the delivery route or the mutation control is exactly the false
    // confidence this suite exists to prevent. Set REVOICE_SMOKE_ALLOW_SKIP=1
    // to accept a partial run deliberately.
    console.log("Exiting 3 (partial run). Set REVOICE_SMOKE_ALLOW_SKIP=1 to accept this.");
    process.exit(3);
  }
  console.log("REVOICE_SMOKE_ALLOW_SKIP=1 — accepting the partial run.");
  process.exit(0);
}
console.log("\nall revoice smoke checks passed");
