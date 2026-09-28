#!/usr/bin/env python3
"""
revoice — re-voice an existing clip WITHOUT touching a single video frame.

Why this shape: Chatterbox VC is VOICE CONVERSION, not TTS. It keeps the source
speech tokens and swaps only the speaker condition, so the output preserves the
original timing, phrasing and cadence. Because the timing survives, the mouth
movements already in the footage stay valid — there is nothing to re-sync, and
the video bitstream is remuxed with `-c:v copy`, i.e. copied bit-for-bit rather
than re-encoded. That is the whole point of the lane: the picture is not
"preserved", it is literally unmodified.

Contrast with the paths that do NOT do this:
  - WanInfiniteTalkToVideo has no video input at all (start_image + audio only),
    so it regenerates the performance rather than dubbing it.
  - Wan S2V's control_video expects a POSE sequence, not the raw plate, and
    re-renders identity + background from one ref_image.
Both replace the picture. This does not.

Licensing: chatterbox-tts is MIT (Resemble AI) and ResembleAI/chatterbox weights
are MIT, so output is commercially usable. This deliberately does NOT use XTTS,
which VoxStation currently runs under the Coqui Public Model License (CPML) —
CPML is non-commercial and restricts the OUTPUT, not just the weights.

Chatterbox applies a Perth audio watermark to its output by design.

Two entry points:
  CLI  : --video/--target-voice/--out  (standalone use)
  LANE : --job <job.json>              (VideoStar REVOICE lane; writes a status
         sidecar the Next.js status route polls — see src/lib/revoice-client.ts)
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback

CHUNK_MAX_SEC = 40.0   # Chatterbox VC degrades / bloats memory past ~40s per call
SILENCE_DB = -32       # silencedetect threshold for choosing split points
SILENCE_MIN = 0.35     # minimum silence length (s) to qualify as a split point
# Minimum target-voice reference. The API also checks this, but ONLY for WAV and
# MP3 — audio-probe.ts can read no other container, and the route skips the guard
# when it cannot probe. So an m4a voice memo (the most likely real-world
# reference) reaches here unvalidated. ffprobe reads every format, so this is the
# one place the rule can actually be enforced for all of them; it runs before the
# ~1GB model load so a bad reference fails in seconds, not minutes.
MIN_VOICE_SEC = 3.0


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def probe_duration(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", path]).stdout.strip()
    return float(out)


def has_audio(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "a",
               "-show_entries", "stream=codec_name", "-of", "csv=p=0", path]).stdout.strip()
    return bool(out)


def video_stream_md5(path):
    """MD5 of the VIDEO BITSTREAM alone (container/audio excluded).

    This is the lane's invariant made checkable: `-c copy` hashes the coded
    packets, so a re-encode — or any accidental filter in the mux step — changes
    this value even when the picture looks identical.
    """
    out = run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:v", "-c", "copy",
               "-f", "md5", "-"]).stdout.strip()
    return out.split("=", 1)[1] if "=" in out else out


def extract_audio(video, wav_out):
    # 24 kHz mono PCM: Chatterbox resamples to 16k internally for tokenising, and
    # a mono intermediate avoids it silently collapsing a stereo VO mid-pipeline.
    run(["ffmpeg", "-y", "-v", "error", "-i", video,
         "-vn", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", wav_out])
    return wav_out


def find_silences(wav):
    """Return [(start,end)] of silence windows, used to pick safe split points."""
    # check=False on purpose: silencedetect writes its report to stderr and a
    # non-zero exit here should degrade to "no split points", not kill the run.
    p = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", wav, "-af",
         f"silencedetect=noise={SILENCE_DB}dB:d={SILENCE_MIN}", "-f", "null", "-"],
        capture_output=True, text=True, check=False)
    log = p.stderr
    starts = [float(m) for m in re.findall(r"silence_start: ([0-9.]+)", log)]
    ends = [float(m) for m in re.findall(r"silence_end: ([0-9.]+)", log)]
    return list(zip(starts, ends))


def plan_chunks(duration, wav):
    """Split on the silence nearest each target boundary; never mid-word."""
    if duration <= CHUNK_MAX_SEC:
        return [(0.0, duration)]
    sil = find_silences(wav)
    # midpoint of each silence window is the safest cut
    cuts = [(s + e) / 2.0 for s, e in sil if 0.0 < s < duration]
    bounds, pos = [0.0], 0.0
    n = max(1, math.ceil(duration / CHUNK_MAX_SEC))
    target = duration / n
    while pos + CHUNK_MAX_SEC < duration:
        want = pos + target
        near = [c for c in cuts if pos + 2.0 < c < min(pos + CHUNK_MAX_SEC, duration)]
        cut = min(near, key=lambda c: abs(c - want)) if near else min(pos + CHUNK_MAX_SEC, duration)
        bounds.append(cut)
        pos = cut
    bounds.append(duration)
    return [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]


class Status:
    """Job status sidecar writer (lane mode). A no-op in CLI mode.

    Written atomically via a temp file + os.replace so the status route can
    never read a half-serialised JSON document mid-write.
    """

    def __init__(self, path, base):
        self.path = path
        self.state = dict(base)
        if path:
            self.write()

    def write(self, **fields):
        self.state.update(fields)
        if not self.path:
            return
        tmp = f"{self.path}.tmp"
        with open(tmp, "w") as fh:
            json.dump(self.state, fh, indent=2)
        os.replace(tmp, self.path)


def convert(video, target_voice, out, device, audio_bitrate, audio_out, status):
    """Re-voice `video` with the timbre of `target_voice`; picture stream-copied."""
    for p in (video, target_voice):
        if not os.path.exists(p):
            raise FileNotFoundError(f"missing input: {p}")
    if not has_audio(video):
        raise ValueError("source video has no audio stream — nothing to re-voice")
    if not has_audio(target_voice):
        raise ValueError(f"target voice reference has no audio stream: {target_voice}")
    voice_dur = probe_duration(target_voice)
    if voice_dur < MIN_VOICE_SEC:
        raise ValueError(
            f"target voice reference is {voice_dur:.2f}s — at least {MIN_VOICE_SEC}s "
            "(5-15s is ideal) of clean single-speaker audio is needed to characterise "
            "a timbre; shorter references produce a wobbling, half-converted voice")

    import torchaudio
    from chatterbox.vc import ChatterboxVC

    work = tempfile.mkdtemp(prefix="revoice_")
    try:
        status.write(stage="extracting", progress=5)
        src_wav = extract_audio(video, os.path.join(work, "src.wav"))
        vid_dur = probe_duration(video)
        aud_dur = probe_duration(src_wav)
        src_v_md5 = video_stream_md5(video)
        chunks = plan_chunks(aud_dur, src_wav)
        print(f"[revoice] video={vid_dur:.3f}s audio={aud_dur:.3f}s "
              f"chunks={len(chunks)} device={device}", flush=True)

        status.write(stage="loading-model", progress=10)
        model = ChatterboxVC.from_pretrained(device)
        model.set_target_voice(target_voice)
        sr = model.sr
        print(f"[revoice] model loaded, output sr={sr}", flush=True)

        pieces = []
        for i, (s, e) in enumerate(chunks):
            # 15..85% of the bar belongs to conversion, the slow part.
            status.write(stage="converting", progress=15 + int(70 * i / len(chunks)))
            piece_in = os.path.join(work, f"in_{i:03d}.wav")
            run(["ffmpeg", "-y", "-v", "error", "-i", src_wav,
                 "-ss", f"{s:.3f}", "-to", f"{e:.3f}",
                 "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", piece_in])
            wav = model.generate(audio=piece_in)          # target voice already set
            piece_out = os.path.join(work, f"out_{i:03d}.wav")
            torchaudio.save(piece_out, wav, sr)
            pieces.append(piece_out)
            print(f"[revoice]   chunk {i+1}/{len(chunks)} {s:.2f}-{e:.2f}s -> {piece_out}",
                  flush=True)

        if len(pieces) == 1:
            conv = pieces[0]
        else:
            lst = os.path.join(work, "concat.txt")
            with open(lst, "w") as fh:
                for p in pieces:
                    fh.write(f"file '{p}'\n")
            conv = os.path.join(work, "converted.wav")
            run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                 "-i", lst, "-c", "copy", conv])

        # THE load-bearing step: -c:v copy is a stream copy, so the video bitstream
        # in the output is byte-identical to the source. apad + -shortest pads the
        # new audio with silence to the video's length so a marginally shorter
        # converted track can never truncate a frame.
        status.write(stage="muxing", progress=88)
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        run(["ffmpeg", "-y", "-v", "error", "-i", video, "-i", conv,
             "-map", "0:v:0", "-map", "1:a:0",
             "-c:v", "copy", "-c:a", "aac", "-b:a", audio_bitrate,
             "-af", "apad", "-shortest", "-movflags", "+faststart", out])

        # Self-check, not decoration: a silent re-encode is the ONE failure mode
        # that would otherwise ship looking correct. If the bitstream moved, the
        # lane did not do what it promises, so fail loudly rather than deliver.
        status.write(stage="verifying", progress=95)
        out_v_md5 = video_stream_md5(out)
        if out_v_md5 != src_v_md5:
            raise RuntimeError(
                "video stream was NOT copied byte-for-byte "
                f"(source {src_v_md5} != output {out_v_md5}) — refusing to "
                "deliver a re-encoded picture from a stream-copy lane")

        # Only NOW is the standalone track published. Copying it before the check
        # above meant a job that FAILED verification still left a servable .wav
        # next to the rejected mp4 — /api/output?…&variant=audio would happily
        # serve audio from a job the API reports as failed.
        if audio_out:
            shutil.copy(conv, audio_out)

        out_dur = probe_duration(out)
        return {
            "ok": True,
            "out": out,
            "source_duration": round(vid_dur, 3),
            "output_duration": round(out_dur, 3),
            "chunks": len(chunks),
            "output_sr": sr,
            "video_stream_md5": out_v_md5,
            "video_stream_copied": True,
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Re-voice a clip; video stream copied bit-for-bit.")
    ap.add_argument("--job", help="job JSON (lane mode); supplies every field below")
    ap.add_argument("--video", help="source clip (video kept untouched)")
    ap.add_argument("--target-voice", help="5-10s clean reference of the target voice")
    ap.add_argument("--out", help="output mp4")
    ap.add_argument("--audio-out", help="also write the converted audio here (wav)")
    ap.add_argument("--device", default="cpu", help="cpu | cuda")
    ap.add_argument("--audio-bitrate", default="192k")
    args = ap.parse_args()

    job, status_path, public_url, job_id, filename = {}, None, None, None, None
    if args.job:
        with open(args.job) as fh:
            job = json.load(fh)
        status_path = job.get("status_path")
        public_url = job.get("public_url")
        job_id = job.get("id")
        filename = job.get("filename")
        args.video = job.get("video_path", args.video)
        args.target_voice = job.get("target_voice_path", args.target_voice)
        args.out = job.get("output_path", args.out)
        args.device = job.get("device", args.device)
        args.audio_bitrate = job.get("audio_bitrate", args.audio_bitrate)
        args.audio_out = job.get("audio_out_path", args.audio_out)

    missing = [n for n, v in (("--video", args.video), ("--target-voice", args.target_voice),
                              ("--out", args.out)) if not v]
    if missing:
        sys.exit(f"missing required argument(s): {', '.join(missing)}")

    status = Status(status_path, {
        "id": job_id,
        "provider": "revoice",
        "status": "processing",
        "stage": "queued",
        "progress": 0,
        "filename": filename,
        "url": public_url,
    })

    try:
        result = convert(args.video, args.target_voice, args.out, args.device,
                         args.audio_bitrate, args.audio_out, status)
    except Exception as exc:                      # noqa: BLE001 — the sidecar IS the error channel
        detail = f"{type(exc).__name__}: {exc}"
        print(f"[revoice] FAILED {detail}", file=sys.stderr, flush=True)
        traceback.print_exc()
        status.write(status="failed", stage="failed", error=detail)
        sys.exit(1)

    status.write(status="completed", stage="done", progress=100,
                 source_duration=result["source_duration"],
                 output_duration=result["output_duration"],
                 chunks=result["chunks"],
                 output_sr=result["output_sr"],
                 video_stream_md5=result["video_stream_md5"],
                 video_stream_copied=True)
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
