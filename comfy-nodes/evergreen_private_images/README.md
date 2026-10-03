# Private Evergreen image jobs

This companion plugin runs on the **existing** serving Comfy process. It does not
start another GPU tenant. Qwen image editing is a non-text model, so the existing
Comfy modality remains the model runtime.

## Release state

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
  repeated admission, signed three-image/selection/viewpoint graphs, disabled
  sampler callbacks, output digest acknowledgement, erasure and reserved
  websocket denial.
- `python scripts/test-private-selections.py` — separate instances, holes,
  nested islands, bounded vertices and refusal of invalid/overcomplex masks.
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
