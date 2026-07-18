// FrameForge — dependency-free video header probe (MP4/MOV + WebM/MKV).
//
// The MATTE lane derives its frame_load_cap from clip length × fps, but the
// source fps was only known AFTER VHS_LoadVideo ran — the route assumed
// 30fps (MATTE_FALLBACK_FPS), so a 60fps source was silently truncated at
// ~15s and history recorded fps 30 / width 0 best-effort. This probe reads
// the real duration / fps / dimensions server-side from the container header
// BEFORE dispatch, mirroring src/lib/audio-probe.ts for the LIP-SYNC lane.
//
// Only the LEADING bytes are required for faststart MP4s (moov up front) and
// normal WebM muxes (Segment Info + Tracks precede the first Cluster), so
// callers can probe a small Range-fetched head instead of downloading a
// multi-GB render. A tail-moov MP4 head (no faststart) throws ProbeError and
// the caller falls back to the pre-probe fps-param behavior.

/** Thrown when the buffer is not a parseable/complete video header. */
export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

export interface VideoProbeResult {
  container: "mp4" | "webm";
  /** Presentation duration in seconds (movie header / Segment Info). */
  durationSeconds: number;
  /** Real frame rate when the header states or implies one — never guessed. */
  fps?: number;
  width?: number;
  height?: number;
  /** MP4 only: total video samples (Σ stts sample counts). */
  frameCount?: number;
}

/**
 * How many leading bytes a caller should fetch for the probe. 2 MB covers
 * the ftyp+moov of every faststart MP4 in the portfolio (a 30s clip's moov
 * is a few KB) and the WebM EBML/Info/Tracks head with wide margin.
 */
export const VIDEO_PROBE_HEAD_BYTES = 2 * 1024 * 1024;

/**
 * Probe an MP4/MOV or WebM/MKV header. `buffer` may be just the leading
 * bytes of the file. Throws ProbeError when the container is unrecognized
 * or the needed header structures are not inside the buffer (truncated
 * head, tail-moov MP4, unfinalized WebM stream).
 */
export function probeVideoHeader(buffer: Buffer): VideoProbeResult {
  if (isMp4(buffer)) return probeMp4(buffer);
  if (isEbml(buffer)) return probeWebm(buffer);
  throw new ProbeError(
    "Unrecognized video container (expected MP4/MOV or WebM/MKV)",
  );
}

/** Round to 3 decimals so exact rates stay exact (24, not 24.0000002). */
function roundFps(fps: number): number | undefined {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) return undefined;
  return Math.round(fps * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// MP4 / MOV (ISO BMFF): walk boxes → mvhd (movie duration/timescale) + the
// first video trak (tkhd width/height, mdhd timescale, stts sample table).
// ---------------------------------------------------------------------------

/** Top-level box types that mark an ISO BMFF file when no ftyp is present. */
const MP4_TOP_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot", "styp", "moof"]);

function isMp4(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const type = buffer.toString("latin1", 4, 8);
  return MP4_TOP_BOXES.has(type);
}

interface Box {
  type: string;
  /** First byte of the box payload (past the 8/16-byte header). */
  contentStart: number;
  /** One past the last byte of the box (per the DECLARED size). */
  end: number;
}

/**
 * Read one box header at `offset`. Handles 32-bit sizes, size===1 (64-bit
 * largesize) and size===0 (box extends to `fileEnd`). The declared end may
 * exceed the buffer (e.g. an mdat we only have the head of) — callers decide
 * whether that is fatal.
 */
function readBoxHeader(buffer: Buffer, offset: number, fileEnd: number): Box {
  if (offset + 8 > buffer.length) {
    throw new ProbeError("Truncated MP4 box header");
  }
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString("latin1", offset + 4, offset + 8);
  let contentStart = offset + 8;
  let end: number;
  if (size32 === 1) {
    if (offset + 16 > buffer.length) {
      throw new ProbeError("Truncated MP4 64-bit box header");
    }
    const size64 = buffer.readBigUInt64BE(offset + 8);
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProbeError(`Malformed MP4 box size (${type})`);
    }
    contentStart = offset + 16;
    end = offset + Number(size64);
  } else if (size32 === 0) {
    end = fileEnd; // "to end of file"
  } else {
    end = offset + size32;
  }
  if (end < contentStart) {
    throw new ProbeError(`Malformed MP4 box size (${type})`);
  }
  return { type, contentStart, end };
}

/** All fully-in-buffer child boxes of [start, end) with the given type. */
function findBoxes(buffer: Buffer, start: number, end: number, type: string): Box[] {
  const found: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(buffer, offset, end);
    if (box.end > end) break; // child overruns its parent — stop walking
    if (box.type === type) found.push(box);
    if (box.end <= offset) break; // defensive: never loop in place
    offset = box.end;
  }
  return found;
}

function findBox(buffer: Buffer, start: number, end: number, type: string): Box | undefined {
  return findBoxes(buffer, start, end, type)[0];
}

/** Descend a path of nested boxes ("mdia" → "minf" → "stbl"). */
function findPath(buffer: Buffer, start: number, end: number, path: string[]): Box | undefined {
  let scope: Box | undefined;
  let s = start;
  let e = end;
  for (const type of path) {
    scope = findBox(buffer, s, e, type);
    if (!scope) return undefined;
    s = scope.contentStart;
    e = scope.end;
  }
  return scope;
}

/** Guarded big-endian u32 read (ProbeError instead of RangeError). */
function u32(buffer: Buffer, offset: number, what: string): number {
  if (offset + 4 > buffer.length) throw new ProbeError(`Truncated ${what}`);
  return buffer.readUInt32BE(offset);
}

/** Guarded big-endian u64 read, narrowed to a JS number. */
function u64(buffer: Buffer, offset: number, what: string): number {
  if (offset + 8 > buffer.length) throw new ProbeError(`Truncated ${what}`);
  return Number(buffer.readBigUInt64BE(offset));
}

/** version-0/1 timescale+duration pair shared by mvhd and mdhd. */
function readTimescaleDuration(
  buffer: Buffer,
  box: Box,
  what: string,
): { timescale: number; duration: number } {
  if (box.contentStart >= buffer.length) throw new ProbeError(`Truncated ${what}`);
  const version = buffer[box.contentStart];
  // v0: version/flags(4) creation(4) modification(4) timescale(4) duration(4)
  // v1: version/flags(4) creation(8) modification(8) timescale(4) duration(8)
  if (version === 1) {
    return {
      timescale: u32(buffer, box.contentStart + 20, what),
      duration: u64(buffer, box.contentStart + 24, what),
    };
  }
  return {
    timescale: u32(buffer, box.contentStart + 12, what),
    duration: u32(buffer, box.contentStart + 16, what),
  };
}

function probeMp4(buffer: Buffer): VideoProbeResult {
  // Top-level walk: find a COMPLETE moov in the bytes we have.
  let moov: Box | undefined;
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const box = readBoxHeader(buffer, offset, buffer.length);
    if (box.type === "moov") {
      if (box.end > buffer.length) {
        throw new ProbeError(
          "moov box extends past the fetched bytes — fetch a larger head",
        );
      }
      moov = box;
      break;
    }
    if (box.end > buffer.length || box.end <= offset) break; // mdat head etc.
    offset = box.end;
  }
  if (!moov) {
    throw new ProbeError(
      "moov box not found in the available bytes (tail-moov / no-faststart file?)",
    );
  }

  const mvhd = findBox(buffer, moov.contentStart, moov.end, "mvhd");
  if (!mvhd) throw new ProbeError("moov has no mvhd box");
  const movie = readTimescaleDuration(buffer, mvhd, "mvhd");

  // First video trak: hdlr handler_type === "vide".
  let width: number | undefined;
  let height: number | undefined;
  let fps: number | undefined;
  let frameCount: number | undefined;
  let trackSeconds: number | undefined;

  for (const trak of findBoxes(buffer, moov.contentStart, moov.end, "trak")) {
    const mdia = findBox(buffer, trak.contentStart, trak.end, "mdia");
    if (!mdia) continue;
    const hdlr = findBox(buffer, mdia.contentStart, mdia.end, "hdlr");
    if (!hdlr) continue;
    // hdlr payload: version/flags(4) pre_defined(4) handler_type(4) ...
    if (hdlr.contentStart + 12 > buffer.length) throw new ProbeError("Truncated hdlr");
    if (buffer.toString("latin1", hdlr.contentStart + 8, hdlr.contentStart + 12) !== "vide") {
      continue;
    }

    // tkhd → width/height (16.16 fixed-point at the end of the payload).
    const tkhd = findBox(buffer, trak.contentStart, trak.end, "tkhd");
    if (tkhd && tkhd.contentStart < buffer.length) {
      // v0 payload: v/f(4) c(4) m(4) id(4) res(4) dur(4)  → w at +76, h at +80
      // v1 payload: v/f(4) c(8) m(8) id(4) res(4) dur(8)  → w at +88, h at +92
      const base = tkhd.contentStart + (buffer[tkhd.contentStart] === 1 ? 88 : 76);
      if (base + 8 <= tkhd.end && base + 8 <= buffer.length) {
        const w = buffer.readUInt32BE(base) / 65536;
        const h = buffer.readUInt32BE(base + 4) / 65536;
        if (w > 0 && h > 0) {
          width = Math.round(w);
          height = Math.round(h);
        }
      }
    }

    // mdhd (media timescale/duration) + stts (sample table) → fps.
    const mdhd = findBox(buffer, mdia.contentStart, mdia.end, "mdhd");
    const media = mdhd ? readTimescaleDuration(buffer, mdhd, "mdhd") : undefined;
    if (media && media.timescale > 0 && media.duration > 0) {
      trackSeconds = media.duration / media.timescale;
    }

    const stts = findPath(buffer, mdia.contentStart, mdia.end, ["minf", "stbl", "stts"]);
    if (stts && media && media.timescale > 0) {
      const entryCount = u32(buffer, stts.contentStart + 4, "stts");
      let samples = 0;
      let mediaTicks = 0;
      let entriesOk = true;
      for (let i = 0; i < entryCount; i++) {
        const at = stts.contentStart + 8 + i * 8;
        if (at + 8 > stts.end || at + 8 > buffer.length) {
          entriesOk = false; // malformed/overrunning table — don't guess
          break;
        }
        const count = buffer.readUInt32BE(at);
        const delta = buffer.readUInt32BE(at + 4);
        samples += count;
        mediaTicks += count * delta;
      }
      if (entriesOk && samples > 0) {
        frameCount = samples;
        if (mediaTicks > 0) {
          fps = roundFps((samples * media.timescale) / mediaTicks);
        }
      }
    }
    break; // first video track wins
  }

  // Movie duration; fall back to the video track's own media duration.
  let durationSeconds: number | undefined;
  if (movie.timescale > 0 && movie.duration > 0) {
    durationSeconds = movie.duration / movie.timescale;
  } else if (trackSeconds && trackSeconds > 0) {
    durationSeconds = trackSeconds;
  }
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds)) {
    throw new ProbeError(
      "Could not determine MP4 duration (mvhd/mdhd empty — fragmented file?)",
    );
  }

  return { container: "mp4", durationSeconds, fps, width, height, frameCount };
}

// ---------------------------------------------------------------------------
// WebM / MKV (EBML): Segment Info (TimestampScale + Duration) + the first
// video TrackEntry (PixelWidth/PixelHeight, DefaultDuration → fps).
// ---------------------------------------------------------------------------

const EBML_ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DefaultDuration: 0x23e383,
  Cluster: 0x1f43b675,
} as const;

const EBML_TRACK_TYPE_VIDEO = 1;

function isEbml(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32BE(0) === EBML_ID.EBML;
}

interface EbmlElement {
  id: number;
  /** Payload size in bytes; null = unknown size (streaming Segment). */
  size: number | null;
  dataStart: number;
}

/** Leading-zero count of an EBML vint marker byte → total vint length. */
function vintLength(firstByte: number, what: string): number {
  for (let len = 1; len <= 8; len++) {
    if (firstByte & (0x100 >> len)) return len;
  }
  throw new ProbeError(`Malformed EBML vint (${what})`);
}

/** Read one EBML element header (id + size vints) at `offset`. */
function readEbmlElement(buffer: Buffer, offset: number): EbmlElement {
  if (offset >= buffer.length) throw new ProbeError("Truncated EBML element");
  // Element ID: the marker bit is KEPT (matroska ids are quoted that way).
  const idLen = vintLength(buffer[offset], "element id");
  if (idLen > 4 || offset + idLen > buffer.length) {
    throw new ProbeError("Truncated EBML element id");
  }
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + buffer[offset + i];

  // Data size: the marker bit is STRIPPED; all-ones payload = unknown size.
  const sizeAt = offset + idLen;
  if (sizeAt >= buffer.length) throw new ProbeError("Truncated EBML size");
  const sizeLen = vintLength(buffer[sizeAt], "element size");
  if (sizeAt + sizeLen > buffer.length) throw new ProbeError("Truncated EBML size");
  let size = buffer[sizeAt] & (0xff >> sizeLen);
  let allOnes = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    const byte = buffer[sizeAt + i];
    size = size * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { id, size: allOnes ? null : size, dataStart: sizeAt + sizeLen };
}

/** Big-endian EBML unsigned int payload (0–8 bytes). */
function ebmlUint(buffer: Buffer, start: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + buffer[start + i];
  return value;
}

/** EBML float payload (0, 4, or 8 bytes). */
function ebmlFloat(buffer: Buffer, start: number, size: number): number {
  if (size === 4) return buffer.readFloatBE(start);
  if (size === 8) return buffer.readDoubleBE(start);
  return 0;
}

/**
 * Walk the fully-in-buffer children of [start, end), calling `visit` with
 * each element. Unknown-size children stop the walk (only the Segment root
 * is legitimately unknown-size).
 */
function walkEbmlChildren(
  buffer: Buffer,
  start: number,
  end: number,
  visit: (el: EbmlElement) => void,
): void {
  let pos = start;
  while (pos < end) {
    let el: EbmlElement;
    try {
      el = readEbmlElement(buffer, pos);
    } catch {
      return; // ragged tail inside a known-size parent — stop quietly
    }
    if (el.size === null) return;
    const elEnd = el.dataStart + el.size;
    if (elEnd > end || elEnd > buffer.length) return;
    visit(el);
    if (elEnd <= pos) return; // defensive: never loop in place
    pos = elEnd;
  }
}

function probeWebm(buffer: Buffer): VideoProbeResult {
  // EBML header, then the Segment.
  const header = readEbmlElement(buffer, 0);
  if (header.id !== EBML_ID.EBML || header.size === null) {
    throw new ProbeError("Malformed EBML header");
  }
  const segment = readEbmlElement(buffer, header.dataStart + header.size);
  if (segment.id !== EBML_ID.Segment) {
    throw new ProbeError("EBML Segment not found");
  }
  const segEnd =
    segment.size === null
      ? buffer.length
      : Math.min(segment.dataStart + segment.size, buffer.length);

  let timestampScale = 1_000_000; // Matroska default: ns per tick
  let durationTicks: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let fps: number | undefined;
  let sawVideoTrack = false;

  // Segment children: Info and Tracks precede the first Cluster in every
  // normal mux (ffmpeg/VHS write them up front); stop at the Cluster.
  let pos = segment.dataStart;
  while (pos + 2 <= segEnd) {
    let el: EbmlElement;
    try {
      el = readEbmlElement(buffer, pos);
    } catch {
      break;
    }
    if (el.id === EBML_ID.Cluster) break;
    if (el.size === null) break; // unexpected unknown-size non-root
    const elEnd = el.dataStart + el.size;
    if (elEnd > buffer.length) {
      if (el.id === EBML_ID.Info || el.id === EBML_ID.Tracks) {
        throw new ProbeError(
          "WebM Segment Info/Tracks extend past the fetched bytes — fetch a larger head",
        );
      }
      break; // some other large element we only have the head of
    }

    if (el.id === EBML_ID.Info) {
      walkEbmlChildren(buffer, el.dataStart, elEnd, (child) => {
        if (child.id === EBML_ID.TimestampScale && child.size) {
          timestampScale = ebmlUint(buffer, child.dataStart, child.size);
        } else if (child.id === EBML_ID.Duration && child.size) {
          durationTicks = ebmlFloat(buffer, child.dataStart, child.size);
        }
      });
    } else if (el.id === EBML_ID.Tracks && !sawVideoTrack) {
      walkEbmlChildren(buffer, el.dataStart, elEnd, (entry) => {
        if (entry.id !== EBML_ID.TrackEntry || entry.size === null || sawVideoTrack) return;
        let trackType: number | undefined;
        let defaultDuration: number | undefined;
        let pixelWidth: number | undefined;
        let pixelHeight: number | undefined;
        walkEbmlChildren(buffer, entry.dataStart, entry.dataStart + entry.size, (field) => {
          if (field.id === EBML_ID.TrackType && field.size) {
            trackType = ebmlUint(buffer, field.dataStart, field.size);
          } else if (field.id === EBML_ID.DefaultDuration && field.size) {
            defaultDuration = ebmlUint(buffer, field.dataStart, field.size);
          } else if (field.id === EBML_ID.Video && field.size) {
            walkEbmlChildren(buffer, field.dataStart, field.dataStart + field.size, (v) => {
              if (v.id === EBML_ID.PixelWidth && v.size) {
                pixelWidth = ebmlUint(buffer, v.dataStart, v.size);
              } else if (v.id === EBML_ID.PixelHeight && v.size) {
                pixelHeight = ebmlUint(buffer, v.dataStart, v.size);
              }
            });
          }
        });
        if (trackType === EBML_TRACK_TYPE_VIDEO) {
          sawVideoTrack = true;
          width = pixelWidth;
          height = pixelHeight;
          // DefaultDuration = ns per frame; absent for VFR → fps undefined.
          if (defaultDuration && defaultDuration > 0) {
            fps = roundFps(1e9 / defaultDuration);
          }
        }
      });
    }
    if (elEnd <= pos) break; // defensive
    pos = elEnd;
  }

  if (durationTicks === undefined || !Number.isFinite(durationTicks)) {
    throw new ProbeError(
      "WebM Duration not found in Segment Info (unfinalized/streaming file, or head too small)",
    );
  }
  const durationSeconds = (durationTicks * timestampScale) / 1e9;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new ProbeError("WebM Duration is not a positive number");
  }

  return { container: "webm", durationSeconds, fps, width, height };
}
