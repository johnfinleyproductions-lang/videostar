# LTX-BEATS `[start-end]` proportional weighting — proof (2026-08-11)

Ticket: `videostar-ltx-weighted-beats-test` (evergreen-core ops/QUEUE.md).
Question: the LTX-BEATS lane shipped with equal-weight beats only tested — do
PromptRelay `[n-m]` weight tags actually change beat timing through the lane?

**Verdict: YES — weights hold.** Same-seed A/B moved the first beat switch by
18 frames (0.75 s) and the weighted render landed within ~4 points of the
requested 25/50/25 split.

## Method

Two renders, lane `LTX-BEATS` (kind `ltx-sidecar`, vidbox WSL ComfyUI-v30
:8190), identical seed `424242`, identical beat text, 97 frames @ 24 fps
(template default), only the weight tags differ:

- `equal.mp4` — `a man in a red shirt stands perfectly still, arms at his sides | the man in the red shirt waves both arms high overhead | the man in the red shirt crouches down into a low squat`
- `weighted.mp4` — same three beats tagged `[0-50] | [50-150] | [150-200]`
  (= requested 25% / 50% / 25%)

Beat-switch frames measured two independent ways:

1. **Filmstrips** — `*_sheet.png` (every 4th frame, 5×5, tile k = frame 4k)
   and 1-frame-step transition strips `*_t1_f24-47.png` / `*_t2_f60-83.png`
   (tile k = first frame + k).
2. **Motion signal** — ffprobe `signalstats` per-frame YDIF (`*_ydif.csv`);
   switch = onset of sustained YDIF > 2.5 out of the quiet ~1.2 baseline.

## Parser ground truth (sidecar node source)

`ComfyUI-PromptRelay/parser.py::parse_smart_prompt` on the weighted prompt
returns weights **50 / 100 / 50** (proportional), equal prompt **1 / 1 / 1**.
`PromptRelaySmartEncode` converts weights to proportional segment lengths.
The videostar side passes the prompt string verbatim into the node
(`buildLtxSidecar` → `smart_prompt` of node "FF Beats").

## Measurements (97 frames)

| render   | beat1→beat2 switch | beat2→beat3 switch | beat layout | requested |
|----------|--------------------|--------------------|-------------|-----------|
| equal    | ~f46 (film f46-48, YDIF ramp f44-47) | ~f74 | **48 / 30 / 22 %** | 33/33/33 |
| weighted | ~f28 (film f29-30, YDIF ramp f24-31) | ~f76 | **29 / 48 / 23 %** | 25/50/25 |

Reading:

- Weights demonstrably drive beat scheduling: 18-frame first-switch shift on
  the same seed, and the weighted layout is within ~4 points/beat of request.
- Expect ~4–5 frames of motion latency at each switch (the conditioning
  changes on schedule; the subject takes a few frames to start moving).
- The final beat compresses in BOTH renders (~22% regardless of weights) when
  it is a large motion (crouch) — the model spends frames finishing the
  previous action. Budget the last beat generously.
- The equal-weight control drifted long on a static opening beat (48% for
  "stands still") — if beat 1 is low-motion, weights are the fix, not hope.

## Repro

```
evctl gen --lane LTX-BEATS --seed 424242 --prompt "<beats as above>"
evctl wait <id>
ffprobe -f lavfi "movie=<out>.mp4,signalstats" -show_entries frame_tags=lavfi.signalstats.YDIF -of csv
```
