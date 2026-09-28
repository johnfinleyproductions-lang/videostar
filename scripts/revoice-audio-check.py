#!/usr/bin/env python3
"""
revoice-audio-check — did the VOICE actually change?

Why this exists: the REVOICE lane's bitstream invariant (the picture is copied
byte-for-byte) is easy to measure and easy to gate on. The lane's actual PRODUCT
claim — that the speaker is now someone else — is neither, and an adversarial
review proved the smoke test's original audio assertions were tautologies:

  * "output audio md5 != source audio md5" is true for ANY re-mux, because the
    mux always re-encodes to AAC at a different bitrate.
  * "output is 24kHz mono" is true of the EXTRACTED SOURCE too, because
    revoice.py extracts at exactly 24kHz mono before converting.

So a lane that muxed the untouched source audio back in — doing zero conversion
— passed every audio check. This script closes that hole with measurements that
cannot be satisfied by the source audio:

  content_similarity  log-mel spectral correlation between the OUTPUT audio and
                      the SOURCE audio. A bypass (source muxed straight back)
                      scores ~1.0; a real conversion scores far lower. This is
                      the bypass detector, and it needs no speech and no model,
                      so it works on synthetic fixtures.

  speaker_*           OPTIONAL, and only meaningful with real speech: cosine
                      similarity of CAMPPlus speaker embeddings — the same
                      encoder Chatterbox itself conditions on. The claim is
                      DIRECTIONAL: the output must sit closer to the TARGET
                      voice than the source ever did. Requires --target.

Prints one JSON object. Exit 0 = measured, 1 = could not measure (never a
verdict: thresholds belong to the caller, not here).
"""
import argparse
import json
import sys


def load(path, sr=16000):
    import librosa
    y, _ = librosa.load(path, sr=sr, mono=True)
    return y


def log_mel(y, sr=16000):
    import librosa
    import numpy as np
    m = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=64, n_fft=1024, hop_length=256)
    return np.log(m + 1e-10)


def content_similarity(a, b):
    """Pearson correlation of log-mel spectra over the overlapping span.

    Gain-insensitive (correlation, not distance) but strongly content-sensitive,
    so re-encoding the same audio still scores ~1.0 while genuinely different
    speech scores much lower.
    """
    import numpy as np
    ma, mb = log_mel(a), log_mel(b)
    n = min(ma.shape[1], mb.shape[1])
    if n < 4:
        return None
    va, vb = ma[:, :n].ravel(), mb[:, :n].ravel()
    va = va - va.mean()
    vb = vb - vb.mean()
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    if denom == 0.0:
        return None
    return float(np.dot(va, vb) / denom)


def speaker_cosines(source, target, output):
    """CAMPPlus speaker-embedding cosines, or None if the model is unavailable."""
    try:
        import torch
        from chatterbox.vc import ChatterboxVC
    except Exception as exc:  # noqa: BLE001 — absence is a valid, reported outcome
        return {"speaker_error": f"{type(exc).__name__}: {exc}"}

    try:
        enc = ChatterboxVC.from_pretrained("cpu").s3gen.speaker_encoder

        def emb(path):
            with torch.no_grad():
                return enc.inference(torch.from_numpy(load(path)).unsqueeze(0)).squeeze()

        def cos(x, y):
            return float(torch.nn.functional.cosine_similarity(x, y, dim=0))

        e_src, e_tgt, e_out = emb(source), emb(target), emb(output)
        return {
            "speaker_source_to_target": round(cos(e_src, e_tgt), 4),
            "speaker_output_to_target": round(cos(e_out, e_tgt), 4),
            "speaker_output_to_source": round(cos(e_out, e_src), 4),
        }
    except Exception as exc:  # noqa: BLE001
        return {"speaker_error": f"{type(exc).__name__}: {exc}"}


def main():
    ap = argparse.ArgumentParser(description="Measure whether the voice actually changed.")
    ap.add_argument("--source", required=True, help="audio/video carrying the ORIGINAL voice")
    ap.add_argument("--output", required=True, help="the delivered clip")
    ap.add_argument("--target", help="reference recording of the TARGET voice (enables speaker_*)")
    args = ap.parse_args()

    result = {}
    try:
        src, out = load(args.source), load(args.output)
        result["source_samples"] = int(src.size)
        result["output_samples"] = int(out.size)
        sim = content_similarity(out, src)
        result["content_similarity"] = None if sim is None else round(sim, 4)
    except Exception as exc:  # noqa: BLE001 — report, do not crash the caller
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        sys.exit(1)

    if args.target:
        result.update(speaker_cosines(args.source, args.target, args.output))

    result["ok"] = True
    print(json.dumps(result))


if __name__ == "__main__":
    main()
