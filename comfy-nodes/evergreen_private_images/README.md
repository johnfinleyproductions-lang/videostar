# Private Evergreen image jobs

This companion plugin runs on the **existing** serving Comfy process. It does not
start another GPU tenant. Qwen image editing is a non-text model, so the existing
Comfy modality remains the model runtime.

## Release state

### Structural masked outpaint (release validation pending)

`POST /evergreen-private/images` accepts `operation: "outpaint"` with exactly
one source and one `reference` containing an **opaque binary mask**. The source
must be canonical RGB PNG; the mask may be L or RGB PNG, with only black (0)
and white (255) pixels and both regions present. Both PNGs must have the exact
declared width and height. The existing bounds remain: 768–1536 pixels per
side on a 32-pixel grid, and 20 MiB per image. Profile and third-reference fields
are rejected, including null placeholders. Standard 20 steps is the only mode.

The server pins operation and workflow
`qwen-image-edit-2509-private-expand-masked-v1` into the request hash and
manifest. Same-ID retries cannot change the mask, source, prompt, geometry,
seed or operation. Legacy ordinary/Fast/selection/viewpoint/upscale identities
and graphs retain their prior behavior. The capability is
`outpaint: { ready, workflow, steps: 20, binaryMask: true,
maskPolarity: "white-edit-black-protect" }`; readiness also requires installed
Qwen assets and matching VAEEncode, ImageToMask and SetLatentNoiseMask contracts.
Readiness does not establish visual quality; Core must keep its feature gate off
until the installed workflow passes acceptance.

Core prepares source and mask with **one explicit geometric transform**. Resize
the source with `fit: "fill"` and the mask with the same dimensions using nearest
neighbor; never pass the mask through ordinary photo preparation's cover crop.
Keep the original full-resolution photo and final placement immutable. The
worker does not resize either image: it VAE-encodes the prepared source and
converts the separate mask's red channel through `ImageToMask` into
`SetLatentNoiseMask`. The private sampler passes this noise mask into Comfy:
white allows generation, black preserves the source latent during every step.
The mask is **excluded** from Qwen's positive and negative image conditioning;
only the source image is used there. This uses installed nodes and weights.

The signed graph, private sampler, scalar progress, encrypted payloads,
runtime cache clearing, output digest, ACK/DELETE and crash/expiry cleanup are
unchanged. Neither a public output node nor a public preview callback is added.
Latent preservation is not a promise of exact decoded pixels: Core must still
restore every original RGBA byte at its pinned offset. Before enabling, verify
straight lines, scene continuity and subject size across each new border on a
real photo, plus exact original RGBA and private cleanup. Earlier semantic-mask
experiments reframed the photo and failed this visual gate.

### Private photo upscale (release validation pending)

`POST /evergreen-private/upscales` accepts exactly `id`, `source`, `width`,
`height`, and `seed`. The source is an original-size canonical **RGB PNG**;
Core decodes it in isolation and flattens onto white without Qwen's working-size
resize. Core retains source alpha and restores its deterministic 2× alpha after
verifying the generated RGB. No prompt, references, speed profile, arbitrary
model or scale is accepted. The server pins `operation: "upscale"` and workflow
`seedvr2-private-upscale-2x-v1` in the immutable request identity and manifest.

Capability `upscales` advertises the model `seedvr2-7b-sharp-fp8`, workflow,
`scale: 2`, input sides 16–8192, input at most 3,000,000 pixels, and output at
most 12,000,000 pixels. Stored input and output each retain the existing 20 MiB
bound. Output must be exactly twice both input dimensions, including odd source
dimensions. Oversized sources must be explained by Core; do not silently shrink
them while labeling the result 2×. The enlarged grid is generated detail, not
pixel-identical preservation or recovery of real information that was absent.

The signed graph has only `EvergreenPrivateImage → EvergreenPrivateUpscale →
EvergreenPrivateOutput`. It reuses authenticated private status/output/ACK/DELETE,
encrypted storage, 24-hour expiry, crash cleanup, idempotent same-ID receipts,
no public images, and cleared execution caches. Progress remains indeterminate
`preparing` until `finishing`; the Qwen 12/20 sampling counters do not apply.

The adapter uses the already installed SeedVR2 **2.5.24**, commit
`4490bd1f482e026674543386bb2a4d176da245b9`, with
`seedvr2_ema_7b_sharp_fp8_e4m3fn.safetensors` (8,239,729,704 bytes) and
`ema_vae_fp16.safetensors` (501,324,814 bytes). Read-only live checks confirmed
allocated/nonzero safetensor data and bundled positive/negative embeddings.
Conventional `UpscaleModelLoader` has no installed image models. The official
[SeedVR2 documentation](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler)
describes image support; installed inference and visual quality remain a
separate release check.

Upstream's normal executor calls a downloader that may delete and replace a
corrupt model. **Private execution never calls it.** The adapter clones the
reviewed execute function with a local globals map whose `download_weight`
entry only verifies installed pinned files. It never monkeypatches the shared
module. The execute-file fingerprint and embedding digests must match; unknown
code fails closed pending compatibility review. File size/allocation, bounded
safetensor metadata and nonzero data are admission checks, not full model
checksum or quality claims. Rechecks occur before execution. No model download,
repair, installation, upstream source edit or startup change is permitted here.

Fixed processing uses one frame, CUDA 0, SDPA, no noise injection, LAB color
correction, CPU offload, 512-pixel VAE encode/decode tiles with 64 overlap,
disabled model caching/compilation, and no debug output request. The upstream
pipeline frees its context and embeddings; the existing private execution
boundary clears Comfy caches and suppresses public websocket events. Same-size
detail improvement and 4× enlargement are intentionally later profiles: the
installed upstream rounds odd target dimensions down to even for video.

Before enabling Core, run the full worker tests and independently review an
idle-gated plugin cutover. Then verify one actual RGB photo and transparent
approved-result upscale: exact 2× dimensions, alpha restoration, private
download/digest, refresh/recovery, visual detail and completed ACK cleanup.
Do not claim this local fixture test proves live speed, memory use or quality.

### Experimental fast preview

The optional image request `profile: "fast12-v1"` uses the existing Qwen 2509
model with 12 sampling steps at the same working dimensions. Omit the field for
the unchanged 20-step graph and legacy request identity. The profile is included
in the request hash and encrypted-job manifest; the same ID cannot change speeds.
Capability `speedProfiles: ["fast12-v1"]` allows clients to fail closed on older
workers. Sampling telemetry must match the exact profile total. Selections and
viewpoint requests reject this profile; reference images remain supported.

This is an experiment, not a distilled or Lightning model. The
[Qwen model example](https://huggingface.co/Qwen/Qwen-Image-Edit-2509/blob/main/README.md)
uses 40 steps; the separate
[LightX2V 4/8-step workflows](https://github.com/ModelTC/LightX2V-Qwen-Image-Lightning)
require their matching adapters, which are not installed on this worker.
Reduced-step quality and speed must pass a real paired comparison before release.
Keep the source, references, instruction, seed and working dimensions identical,
measure preparation/sampling/total time, and review subject preservation, reference
likeness and visual artifacts. Do not label fixture timings as model benchmarks.
No model download, dependency install, startup task or security change is included.

### October 3 expansion plan

- [x] Preserve legacy image identities while adding an encrypted third input.
- [x] Add queued, signed SAM3.1 selections with bounded reviewed contours.
- [x] Add an explicit experimental Qwen 2511 viewpoint operation; no angle LoRA claim.
- [x] Cover authentication, input identity, contours, crash recovery and cleanup.
- [ ] Validate on the installed runtime before enabling the corresponding Core UI.

The read-only serving inventory confirms native SAM3 detection, its existing
`sam3.1_multiplex_fp16.safetensors` checkpoint, Qwen 2511 Q6 GGUF, and three image
conditioning inputs. It does not establish output quality. Qwen layered weights
and angle LoRA are absent. Installed Qwen 2.1 remains excluded: its research
license requires a separate commercial license for commercial use. This change
does not install dependencies, download models, or modify Windows startup.

### Installed expansion acceptance, October 3

PR #11 (`1ea0a85`, plugin source `9df929c`) was installed with a rollback copy at
`/home/evergreen/evergreen-worker-backups/20261003-before-9df929c`.
The existing Interactive-only task did not execute when the ordinary restart
command reported success. The operator used the installed `vidbox-mode.ps1 clean`
guard, then launched the unchanged installed worker launcher through the established
detached recovery path. No task registration, startup policy or security changed.

The actual private SAM3.1 job on the fictional two-person acceptance fixture
returned two correct, visually reviewed person outlines (scores 0.983 and 0.977,
78 and 119 vertices). Its output digest matched; acknowledgement returned 404 on
subsequent output reads and left zero sealed payload files. LAN authentication
checks returned 401 for private, queue and history routes and 200 for health.

One real three-input Qwen2509 job completed using that fictional source and
separate blue/gold color references. The right shirt changed to the requested
gold from image three; the model also tightened framing. This verifies the third
input executes, not exact full-image preservation. The output digest matched,
acknowledged output returned 404, and no sealed payloads remained. Core's reviewed
selection/compositing boundary is still necessary when other pixels must stay put.

The first actual viewpoint job failed in `UnetLoaderGGUF`. A CPU metadata check
found the installed 16,852,417,120-byte file was entirely sparse, with an all-zero
header and zero allocated bytes. There was no valid alternative in configured
stores. Viewpoint readiness now requires the pinned GGUF v3 header and fails
closed for missing, truncated or zero-filled assets. This is a quick admission
check, not a substitute for a verified checksum and installed inference.

The proposed repair asset is Apache-2.0
[`unsloth/Qwen-Image-Edit-2511-GGUF`](https://huggingface.co/unsloth/Qwen-Image-Edit-2511-GGUF/blob/0d33d9692b4b26212297240d87b0d4719aa4fd06/qwen-image-edit-2511-Q6_K.gguf),
revision `0d33d9692b4b26212297240d87b0d4719aa4fd06`, SHA256
`fdc28e5b8f7d9cfe0399fd1700c375f25f000fc4159bbdb0d4a809ae898eb759`.
Automatic approval review rejected the live model download before execution;
repair and the viewpoint visual gate await explicit approval. Preserve the
existing asset until a separately staged replacement passes its full checksum.

### Expansion protocol

The protocol remains `evergreen-private-images-v1`. Existing image jobs retain
their exact request hash and graph when new fields are absent. Capabilities add
`threeImages`, `maxReferences`, `selections: {ready, model: "sam3.1"}`,
`viewpoints: {ready, model: "qwen-image-edit-2511-q6"}`, and `layers: {ready:false}`.

- `POST /evergreen-private/images` accepts optional `reference2` (requiring
  `reference`) or single-source `operation: "viewpoint"`. The latter selects the
  installed Qwen 2511 Q6 GGUF with the existing text encoder/VAE and 20-step
  graph. It uses ordinary instructions, not a trained camera-angle adapter.
- `POST /evergreen-private/selections` accepts `{id, source, query, width, height}`.
  Source is a canonical PNG in the existing 768–1536/32 working dimensions.
  Query is one short description (1–120 characters), without comma, colon,
  parentheses or newlines. The private instruction node supplies the native
  SAM3 tokenizer's `:12` detection bound. Model work runs through the same
  signed private queue; no GPU work runs in a route thread.
- Both return `{prompt_id}`. Status/output/ack/DELETE use the existing
  `/evergreen-private/images/{id}` paths. Completed status adds `contentType`;
  selection output is `application/json`, image output remains `image/png`.
- Geometry output is `{version:1,width,height,query,approximate:true,suggestions}`.
  Each suggestion has `{id,label,score,shapes}`; there are at most 12 suggestions,
  each with at most 12 ordered outline shapes and 128 normalized points per
  shape. Holes subtract; nested islands add. Empty or overly fragmented instances
  are omitted. These are editable, approximate suggestions requiring review;
  they are not hair-level alpha mattes or exact original masks.

Operation and third input are included in request identity only when present.
Selection JSON is encrypted, digest-bound, crash-recoverable and erased with
the same lifecycle as image output. Queries and coordinates are absent from
Comfy graph history and public outputs. The existing CPU OpenCV installation
performs contour extraction after the model has completed.

Local storage/runtime tests and synthetic HTTP tests pass. Core production gates
remain closed until installation, ordinary-client regression checks, real model
visual acceptance, and release/deployment checks pass. Tests never use personal
photos or the production database.

The first actual fictional-person face edit failed visual review. A graph audit
found the negative conditioning omitted the source/reference images. Both
conditioning branches now receive the same photos, matching the
[official Comfy Qwen 2509 workflow](https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_edit_2509.json).
The audit also found missing `CFGNorm` guidance normalization. Both workflows
now include it at strength 1 and capabilities require the installed node. CPU
validation passes against the installed runtime; one-input and two-input
conditioning and model routing have focused regressions. The corrected graph
materially improves texture, but the reviewed output still changes head framing
and produces visible seams with the rectangular composite. Real face acceptance
remains open. Synthetic public model experiments
do not verify the private serving boundary; no personal photos were dispatched.

## Installed runtime compatibility

The first installed private edit exposed Comfy’s transient node-level
`is_changed` cache fingerprint. Signatures now ignore only that runtime field;
classes, inputs, links and all other fields remain pinned. Private execution
strips caller fingerprints and clears caches before and after execution, so a
generic signed replay cannot bypass private-node reauthorization through cached
outputs. The focused lifecycle regression covers both normalization and replay.
Production AI editing remains closed until fresh installed inference passes.

## Private boundary

- `/evergreen-private/images` and all job/status/output/ack/DELETE routes always
  require the shared 256-bit bearer credential, including loopback requests.
- Generic Comfy HTTP requires that credential or a loopback peer. Only GET
  `/system_stats` remains reachable without authentication for health probes.
  Forwarded-for headers, LAN addresses, and proxy addresses grant no access.
- Photos and instructions are AES-GCM encrypted outside all Comfy media folders.
  Job graph/history contains identities and graph signatures, without image
  bytes, source paths, or plaintext instructions. Processing failures have
  sanitized history inputs; log details are withheld while private jobs run.
- The entire graph is signed and pinned. Adding SaveImage, redirecting a private
  input, changing nodes, or removing the private output invalidates access.
  A replay through generic prompt dispatch still receives a reserved private
  client identity. Private nodes always reauthorize, bypass cached output reuse, and sampling has
  no public latent preview callback. Reserved private websocket IDs are refused.
- Execution cache references are released after a private graph finishes. This
  does not promise physical RAM/VRAM zeroization. Normal graph caches are retained.
- Inputs/instructions are removed upon completion; output stays recoverable
  until Core publishes its verified composite durably and acknowledges the
  **worker PNG digest**, which can differ from the composite digest.
- A Core crash before acknowledgement leaves a recoverable encrypted output.
  Acknowledgement is idempotent; Core retries it on reopening saved results.
- DELETE persists a tombstone before scrubbing, so a late completion cannot
  republish. Core's offline erasure cleanup retries worker deletion before
  completing a durable cleanup ticket. Worker outage keeps the ticket open.
- All payloads expire after 24 hours with a 60-second sweep. Worker restart
  fails interrupted jobs and scrubs their bytes. Tombstone metadata expires
  after 30 days. Admission is limited to 1000 retained job records.
- Core sends only canonical PNGs after isolated bounded decoding. The plugin
  also bounds payload sizes, dimensions, and output PNG dimensions.

## Configuration and installation

### Private scalar progress

Active job status may include `progress` with `phase` set to `queued`,
`preparing`, `sampling`, or `finishing`. Only sampling includes integer
`completedSteps` and `totalSteps` (20 steps normally; 12 for `fast12-v1`). The ratio
describes sampling only, not total completion time. Model loading, text/image
encoding, decoding, transfer, and Core compositing also take time. Older workers
return `processing` without progress; clients must support that response.

The private sampler callback records only scalar counters in the existing
owner-only manifest. It ignores and does not retain latent tensors, create
previews, log callback payloads, or emit websocket events. Phase/step regressions
are ignored, invalid counters are refused, and completion/erasure/expiry removes
progress. Startup reconciliation still fails interrupted jobs and clears their
private payloads. This uses no additional service, model, credential or port.

Before installing a progress update, inspect authenticated Comfy queue counts
and active private manifests without printing graphs, instructions, credentials,
or photos. Wait for running and pending queues to empty and Core to save pending
results. Back up the installed plugin and stage these tracked files, then use
the existing guarded restart. Never restart for progress while an edit is active.
Afterward verify protected status access and one synthetic edit progressing
through sampling; old saved outputs must remain recoverable. Roll back the
plugin files with the same idle check if necessary.

Read-only compatibility verification on October 3, 2026 confirmed the installed
`comfy/samplers.py` computes `total_steps = len(sigmas) - 1` and invokes the
callback as `(step, denoised, latent, total_steps)`. Synthetic local checks pass
for all 20 callbacks, authenticated status, erasure/restart cleanup and ordinary
client graphs. Installed inference and rollout still need their own receipt.

Set both `EVERGREEN_PRIVATE_IMAGE_KEY_FILE` and `EVERGREEN_PRIVATE_IMAGE_ROOT`
**in the serving Comfy launch environment**. The key file is an absolute,
owner-only regular file containing a fresh 64-character lowercase hexadecimal
secret. The storage root is an absolute owner-only directory with no symlink
ancestors, outside Comfy input/output. Preserve the key across restarts so saved
encrypted outputs can be recovered. Never commit or print the credential.

Install this entire directory under the serving Comfy `custom_nodes` folder.
`cryptography`, Pillow, numpy, torch, OpenCV and aiohttp must be available in that exact
runtime. The verified worker environment already supplies them; do not replace
its GPU dependency stack. Stage the tracked plugin, check queue/tenant state,
then use the established Comfy restart procedure.

The companion VideoStar app uses `EVERGREEN_PRIVATE_IMAGE_KEY_FILE` plus
`EVERGREEN_PRIVATE_COMFY_ORIGIN` to authenticate **only that exact configured
origin**. Windows uses an owner-restricted ACL for its key copy. HTTP redirects
and websocket redirects are refused. Ordinary image results use the existing
VideoStar output proxy; private graphs cannot surface through public status
responses or its public websocket bridge.

Core uses `VISUAL_EDITOR_COMFY_URL` and `VISUAL_EDITOR_IMAGE_WORKER_KEY_FILE`.
It no longer sends private photos through `/api/images/generate`, shared uploads,
worker-reported URLs, or `/view`. Transport must use a trusted protected link
or TLS; this plugin authenticates endpoints and encrypts files, not HTTP packets.
Do not enable Core's production editing flag before the private release checks.

## Verification

From the VideoStar checkout, with the installed runtime's dependencies:

- `python scripts/test-private-images.py` — storage, erasure, crashes, expiry,
  graph signing, failure sanitization and cache release.
- `python scripts/test-private-image-http.py` — actual authenticated HTTP,
  repeated admission, signed three-image/selection/viewpoint graphs,
  numeric-only sampler callbacks, output digest acknowledgement, erasure and reserved
  websocket denial.
- `python scripts/test-private-selections.py` — separate instances, holes,
  nested islands, bounded vertices and refusal of invalid/overcomplex masks.
- `python scripts/test-private-upscale.py` — pinned local assets/implementation,
  no downloader or global mutation, fixed settings and exact output bounds.
- `python scripts/test-private-outpaint.py` — opaque binary mask/source checks,
  white/black polarity and conservative installed-node contracts. Storage and
  HTTP suites also cover the structural graph, sampler mask propagation,
  immutable workflow/mask recovery, signed graph tampering and ACK erasure.
- `node scripts/comfy-auth.test.mjs` — scoped server credentials, redirect
  refusal, private history filtering and unavailable-key behavior.
- `node scripts/qwen-two-image.test.mjs` — existing ordinary Qwen graphs.
- Existing model preflight suite — normal prompt dispatch still works.

Then verify against the installed runtime: unauthorized private reads and
public generic requests are denied; existing ordinary clients work through the
credential/proxy; one synthetic model job has no shared input/output files or
public latent events; its final output is private and acknowledgement removes
ciphertext; a reviewed two-photo face replacement retains the other person's
pixels, source dimensions and alpha. Record exact deployed commits and results.

## Rollback

Disable Core image editing first. Revert the companion app/plugin revision,
then restore the previous Comfy launch environment and restart through its
normal operator path. Keep the encrypted storage/key until cleanup receipts are
resolved; deleting them discards unacknowledged previews.
