# Private Evergreen image jobs

This companion plugin runs on the **existing** serving Comfy process. It does not
start another GPU tenant. Qwen image editing is a non-text model, so the existing
Comfy modality remains the model runtime.

## Release state

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
`cryptography`, Pillow, numpy, torch and aiohttp must be available in that exact
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
  repeated admission, signed two-image graph, disabled sampler callbacks,
  output digest acknowledgement, erasure and reserved websocket denial.
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
