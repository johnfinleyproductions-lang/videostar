# Video Quality Controls

This guide explains which VideoStar / FrameForge knobs change the look, speed, prompt adherence, and reliability of generated videos.

## Baseline Profiles

Keep one known-good profile stable, then make experiments as separate profiles.

| Profile | Use it for | What it protects |
|---|---|---|
| Framestation Classic | Default text-to-video, best known prompt adherence | The April Framestation recipe and verified Gemma encoder |
| LTX 2.3 Modern FP8 | Experimental ComfyUI sampler tests | Newer nodes without risking Classic |
| LTX 2.3 Full Quality | Slower quality tests | Full checkpoint experiments |
| LTX Desktop Streaming | Future bigger/offloaded local runs | LTX Desktop backend and model streaming path |

## Controls

| Control | What it changes | Safe range | Notes |
|---|---|---|---|
| Text encoder | How the model understands the prompt | Keep Classic locked | A wrong-but-valid encoder can ignore the prompt completely. Classic uses `comfy_gemma_3_12B_it.safetensors`, verified against Framestation hash `38c8ca98d01afc93a04f9fb18255755884b9eb52b7b40080076e9c892609751b`. |
| Base checkpoint | Overall model quality, speed, VRAM | fp8 for speed, full for quality tests | The checkpoint and LoRA can match while outputs still fail if the text encoder differs. |
| LoRA | Style, motion behavior, speed, specialty bias | `0.2` subtle, `0.5` strong | The current distilled LoRA is mostly a speed/performance LoRA, not a style LoRA. Add style LoRAs as separate profiles. |
| CFG / guidance | Prompt force and image stability | Start around `3` | Too low can drift. Too high can create artifacts, stiffness, or overcooked details. |
| Sampler | Texture and motion character | Classic uses `euler` | Changing sampler can dramatically change subject adherence. |
| Steps | Detail and temporal refinement | `20` baseline, `30` quality test | More steps cost more time. Not all bad outputs are fixed by more steps. |
| Negative prompt | What the model avoids | Keep concise | Useful for suppressing game/cartoon/watermark/human bias. Overly broad negatives can fight the prompt. |
| Source image | Composition and subject lock | Best practical control | Image-to-video is more predictable than pure text-to-video. Use this for product shots, characters, or exact scene layout. |
| Audio | Audio branch and final mux | Off for silent previews | If audio is not needed, a Classic Silent profile can reduce output noise and avoid some speech/person bias. |
| Resolution / duration | VRAM, speed, failure risk | Start 512p/4s for tests | Raise one dimension at a time after a profile proves prompt adherence. |

## How To Get Different Effects

| Goal | Change first | Avoid changing first |
|---|---|---|
| Better prompt adherence | Prompt wording, source image, Classic text encoder lock | Random text encoder swaps |
| More cinematic look | Add a cinematic style LoRA profile, camera terms, lighting terms | Replacing the base recipe blindly |
| Faster drafts | Use fp8, shorter duration, lower resolution | Higher CFG or more steps |
| Cleaner product/ad video | Source image, product/ad LoRA, stricter negative prompt | Pure text-to-video for exact product shape |
| Better motion | Prompt action clearly, test sampler/profile | Jumping straight to 1080p |
| Better consistency | Image-to-video or a first-frame workflow | Longer pure text clips without anchoring |
| Bigger local model experiments | LTX Desktop Streaming profile | Disturbing Framestation Classic |

## Prompt Pattern

Use this order:

```text
subject, action, setting, camera move, lighting, style, quality constraints
```

Example:

```text
two shiba inu dogs playing over an ice cream cone, sunny forest clearing, handheld cinematic shot, soft natural light, shallow depth of field, realistic fur, playful motion
```

## Testing Rule

Every new model/profile should pass a short smoke test before becoming a default:

1. Generate a 4 second 512p clip.
2. Reuse a known prompt and seed from history.
3. Inspect actual frames, not just whether ComfyUI completed.
4. Record the checkpoint, text encoder hash, LoRA, sampler, steps, CFG, and output filename.

## Current Known-Good Classic Recipe

| Part | Value |
|---|---|
| Checkpoint | `ltx-2.3-22b-dev-fp8.safetensors` |
| Text encoder | `comfy_gemma_3_12B_it.safetensors` |
| Text encoder hash | `38c8ca98d01afc93a04f9fb18255755884b9eb52b7b40080076e9c892609751b` |
| LoRA | `ltxv/ltx2/ltx-2.3-22b-distilled-lora-384.safetensors` |
| LoRA strength | `0.5` |
| Sampler | `euler` |
| Guidance | `CFGGuider`, `cfg: 3` |
| Steps | `20` |
| Audio branch | On |

## LTX Desktop Streaming Notes

LTX Desktop is a separate backend, not a ComfyUI workflow. It exposes a FastAPI server with:

| Endpoint | Purpose |
|---|---|
| `GET /health` | backend health and loaded/downloaded model state |
| `GET /api/gpu-info` | local GPU and VRAM telemetry |
| `POST /api/generate` | local video generation |
| `GET /api/generation/progress` | current generation phase/progress |
| `GET /api/models/*-recommendation` | model download/setup recommendations |

The VideoStar profile should stay gated by:

```bash
LTX_DESKTOP_URL=http://127.0.0.1:8000
LTX_DESKTOP_OUTPUT_DIR=...
```

Classic stays the default until LTX Desktop passes the same smoke-test rule above.
