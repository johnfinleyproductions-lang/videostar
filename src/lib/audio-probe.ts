// FrameForge — dependency-free audio duration probe (WAV + MP3).
//
// The LIP-SYNC lane derives its frame count from the voiceover length, so the
// generate route needs the audio duration server-side BEFORE queueing —
// ComfyUI only learns it after LoadAudio runs. WAV and MP3 cover the studio
// sources (VoxStation TTS emits clean WAV; MP3 for anything hand-supplied);
// anything else returns null and the route answers with a clean 400.

/**
 * Best-effort duration (seconds) of a WAV or MP3 buffer.
 * Returns null when the buffer is not parseable as either format.
 */
export function probeAudioDurationSeconds(buffer: Buffer): number | null {
  return probeWavDuration(buffer) ?? probeMp3Duration(buffer);
}

// ---------------------------------------------------------------------------
// WAV (RIFF): duration = data-chunk byte length / fmt-chunk byte rate.
// ---------------------------------------------------------------------------

function probeWavDuration(buffer: Buffer): number | null {
  if (buffer.length < 44) return null;
  if (
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }

  let byteRate: number | null = null;
  let dataBytes: number | null = null;

  // Walk the RIFF chunks ("fmt " carries byteRate, "data" carries the samples).
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt " && offset + 16 <= buffer.length) {
      // fmt chunk layout: format(2) channels(2) sampleRate(4) byteRate(4) ...
      byteRate = buffer.readUInt32LE(offset + 16);
    } else if (chunkId === "data") {
      // A streamed/placeholder size (0 or 0xFFFFFFFF) → use the real remainder.
      dataBytes =
        chunkSize === 0 || chunkSize === 0xffffffff
          ? buffer.length - (offset + 8)
          : Math.min(chunkSize, buffer.length - (offset + 8));
    }
    if (byteRate !== null && dataBytes !== null) break;
    // Chunks are word-aligned (odd sizes are padded with one byte).
    offset += 8 + chunkSize + (chunkSize % 2);
    if (chunkSize === 0xffffffff) break; // malformed size — stop walking
  }

  if (!byteRate || dataBytes === null || dataBytes <= 0) return null;
  return dataBytes / byteRate;
}

// ---------------------------------------------------------------------------
// MP3: walk the frame headers and sum samples-per-frame / sample-rate.
// Handles ID3v2 prefixes, CBR and VBR; Layers I–III, MPEG 1 / 2 / 2.5.
// ---------------------------------------------------------------------------

// Bitrate tables (kbps), indexed [bitrateIndex 1..14]. 0 = free (unsupported).
const BITRATES_V1: Record<number, number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const BITRATES_V2: Record<number, number[]> = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

function probeMp3Duration(buffer: Buffer): number | null {
  let offset = 0;

  // Skip an ID3v2 tag (10-byte header, syncsafe 28-bit size).
  if (buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "ID3") {
    const size =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f);
    offset = 10 + size;
  }

  let seconds = 0;
  let frames = 0;

  while (offset + 4 <= buffer.length) {
    // Frame sync: 11 set bits.
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      if (frames === 0) {
        // Not synced yet — scan forward for the first frame.
        offset++;
        continue;
      }
      break; // trailing junk (ID3v1 tag etc.) after valid frames — done
    }

    const versionBits = (buffer[offset + 1] >> 3) & 0x03; // 3=V1, 2=V2, 0=V2.5
    const layerBits = (buffer[offset + 1] >> 1) & 0x03; // 3=LI, 2=LII, 1=LIII
    const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
    const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
    const padding = (buffer[offset + 2] >> 1) & 0x01;

    const layer = 4 - layerBits; // 1, 2, or 3
    if (
      versionBits === 1 || // reserved version
      layerBits === 0 || // reserved layer
      bitrateIndex === 0 || // "free" bitrate — cannot size the frame
      bitrateIndex === 15 ||
      sampleRateIndex === 3
    ) {
      if (frames === 0) {
        offset++;
        continue;
      }
      break;
    }

    const isV1 = versionBits === 3;
    const bitrate =
      (isV1 ? BITRATES_V1 : BITRATES_V2)[layer][bitrateIndex] * 1000;
    const sampleRate = SAMPLE_RATES[versionBits][sampleRateIndex];
    const samplesPerFrame =
      layer === 1 ? 384 : layer === 2 ? 1152 : isV1 ? 1152 : 576;

    const frameBytes =
      layer === 1
        ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
        : Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
    if (frameBytes <= 4) break; // defensive: never loop in place

    seconds += samplesPerFrame / sampleRate;
    frames++;
    offset += frameBytes;
  }

  return frames > 0 ? seconds : null;
}
