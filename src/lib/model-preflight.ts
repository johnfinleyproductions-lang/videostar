// FrameForge — ComfyUI model preflight (ticket comfy-workflow-model-preflight)
//
// THE PROBLEM (the "two-comfy landmine"): a lane can be dispatched to a worker
// whose ComfyUI does not have the models — or even the custom NODES — that the
// lane's workflow references. The job queues, then dies late with an opaque
// error. This has bitten Image Studio twice (Klein weights landed on
// framerstation's serving comfy, not vidbox's; then the Qwen-edit checkpoint).
//
// Measured on 2026-09-08 across the real lanes and all three live workers:
// 7 of 37 lanes answer DIFFERENTLY depending on which worker runs them.
//
// WHAT THIS DOES: after the worker is resolved and before the prompt is POSTed,
// walk the graph, collect every model reference, and ask THAT worker's
// /object_info whether it can actually satisfy them.
//
// FOUR OUTCOMES, deliberately:
//   present          — the file is in the node's enum.
//   missing_file     — the node exists, the file is not in its enum. FAIL CLOSED.
//   node_missing     — the class_type is absent from /object_info, so the graph
//                      cannot run here at all. FAIL CLOSED. (In our fleet this
//                      is the MORE common failure — a missing custom-node pack,
//                      not a missing weight.)
//   undeterminable   — the field has no enum we can read, or the probe errored.
//                      FAIL OPEN: today's behaviour, never block on ignorance.
//
// The gate is TOTAL by construction: anything it cannot definitively prove
// wrong is waved through, so a preflight outage can never take the render
// plane down. Kill switch with no rebuild: FRAMEFORGE_MODEL_PREFLIGHT=off.

/** Weight-file extensions. A model reference is detected by VALUE, not by a
 *  class_type allowlist — that is what catches custom nodes automatically
 *  (HunyuanDependenciesLoader, SeedVR2LoadDiTModel, "RIFE VFI", …) without a
 *  hand-maintained table that silently rots as lanes are added. */
const WEIGHT_EXTENSIONS = [
  ".safetensors",
  ".ckpt",
  ".pt",
  ".pth",
  ".bin",
  ".gguf",
  ".sft",
  ".onnx",
] as const;

/** Where a missing file most likely belongs, for the operator-facing message.
 *  Best-effort hint only — never used for the pass/fail decision. */
const SUBDIR_HINTS: Record<string, string> = {
  ckpt_name: "models/checkpoints",
  unet_name: "models/unet (or models/diffusion_models)",
  lora_name: "models/loras",
  vae_name: "models/vae",
  clip_name: "models/clip (or models/text_encoders)",
  clip_name1: "models/clip (or models/text_encoders)",
  clip_name2: "models/clip (or models/text_encoders)",
  text_encoder: "models/text_encoders",
  control_net_name: "models/controlnet",
  model_name: "models/upscale_models",
  style_model_name: "models/style_models",
  synchformer_name: "models/hunyuan (per the node pack's docs)",
};

export type RefVerdict =
  | "present"
  | "missing_file"
  | "node_missing"
  | "undeterminable";

export interface ModelRef {
  nodeId: string;
  classType: string;
  field: string;
  file: string;
}

export interface CheckedRef extends ModelRef {
  verdict: RefVerdict;
  /** Why it could not be determined — only set for `undeterminable`. */
  reason?: string;
}

export interface PreflightReport {
  base: string;
  checked: CheckedRef[];
  missingFiles: CheckedRef[];
  missingNodes: CheckedRef[];
  undeterminable: CheckedRef[];
  /** True when nothing was definitively wrong (the dispatch may proceed). */
  ok: boolean;
}

/** Brand used instead of `instanceof` — see isModelPreflightError below. */
const PREFLIGHT_BRAND = "__frameforgeModelPreflightError" as const;

/** Thrown when the resolved worker definitively cannot satisfy the graph.
 *  Routes map this to 503 — the same honest "this box cannot take this job"
 *  surface as FleetWorkerUnavailableError, not a 500. */
export class ModelPreflightError extends Error {
  /** Brand property; see isModelPreflightError. */
  readonly [PREFLIGHT_BRAND] = true;
  readonly report: PreflightReport;
  constructor(message: string, report: PreflightReport) {
    super(message);
    this.name = "ModelPreflightError";
    this.report = report;
  }
}

/**
 * Use THIS, never `instanceof ModelPreflightError`, at a module boundary.
 *
 * A bundler (or a script runner — tsx demonstrably does) can instantiate this
 * module twice, producing two distinct class objects. `instanceof` then returns
 * false for a genuine preflight error, the route's 503 mapping silently never
 * fires, and every refusal surfaces as a 500 — a gate that looks like it works
 * while reporting the wrong thing. A branded property is identity-independent
 * and cannot fail that way.
 */
export function isModelPreflightError(
  error: unknown,
): error is ModelPreflightError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>)[PREFLIGHT_BRAND] === true
  );
}

function isWeightFile(value: string): boolean {
  const lower = value.toLowerCase();
  return WEIGHT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Collect every model reference in an API-format workflow
 * (`{ nodeId: { class_type, inputs } }`).
 *
 * UI-format graphs (`{ nodes: [...] }`) are NOT parsed: all 40 lanes in
 * src/workflows are API-format, so supporting UI-format would be speculative
 * code on an untested path. An unrecognised shape yields zero refs, which
 * makes the gate a no-op — fail open, per the module contract.
 */
export function extractModelRefs(workflow: unknown): ModelRef[] {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    return [];
  }
  const graph = workflow as Record<string, unknown>;
  if ("nodes" in graph) return []; // UI-format — deliberately unhandled.

  const refs: ModelRef[] = [];
  for (const [nodeId, rawNode] of Object.entries(graph)) {
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) {
      continue;
    }
    const node = rawNode as Record<string, unknown>;
    const classType = node.class_type;
    const inputs = node.inputs;
    if (typeof classType !== "string") continue;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;

    for (const [field, value] of Object.entries(
      inputs as Record<string, unknown>,
    )) {
      // A link is ["nodeId", slot] — only literal strings name a file.
      if (typeof value !== "string") continue;
      if (!isWeightFile(value)) continue;
      refs.push({ nodeId, classType, field, file: value });
    }
  }
  return refs;
}

type EnumLookup = Set<string> | "node_missing" | "no_enum";

/**
 * Read the option list for one input field out of an /object_info payload.
 *
 * LANDMINE: ComfyUI serves TWO enum shapes and seven of our field types use
 * the newer one. Handling only the classic shape marks them undeterminable and
 * silently fails the gate OPEN — the exact false confidence a gate must not
 * have.
 *   classic : ["<file>", "<file>", …]  wrapped as  [ [...], {…} ]
 *   COMBO   : ["COMBO", { options: [...], … }]
 */
export function readEnum(
  nodeInfo: unknown,
  field: string,
): Set<string> | null {
  if (!nodeInfo || typeof nodeInfo !== "object") return null;
  const input = (nodeInfo as Record<string, unknown>).input;
  if (!input || typeof input !== "object") return null;

  for (const section of ["required", "optional"] as const) {
    const bucket = (input as Record<string, unknown>)[section];
    if (!bucket || typeof bucket !== "object") continue;
    const spec = (bucket as Record<string, unknown>)[field];
    if (!Array.isArray(spec) || spec.length === 0) continue;

    // classic
    if (Array.isArray(spec[0])) {
      return new Set(spec[0].filter((v): v is string => typeof v === "string"));
    }
    // COMBO
    if (spec[0] === "COMBO" && spec[1] && typeof spec[1] === "object") {
      const options = (spec[1] as Record<string, unknown>).options;
      if (Array.isArray(options)) {
        return new Set(
          options.filter((v): v is string => typeof v === "string"),
        );
      }
    }
  }
  return null;
}

/** Per-(base, class_type) enum cache. Short TTL so a freshly dropped model is
 *  picked up quickly — ComfyUI itself lists new weight files without a restart
 *  (the mtime-cache behaviour we rely on when staging weights). */
const CACHE_TTL_MS = 30_000;
const enumCache = new Map<string, { at: number; value: EnumLookup }>();

/** Test seam: drop cached probes (used by the proof harness). */
export function clearPreflightCache(): void {
  enumCache.clear();
}

async function lookupEnum(
  base: string,
  classType: string,
  field: string,
  timeoutMs: number,
): Promise<EnumLookup> {
  const key = `${base} ${classType} ${field}`;
  const hit = enumCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  // "RIFE VFI" is a real class_type — with a space. Always URL-encode.
  const url = `${base}/object_info/${encodeURIComponent(classType)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`object_info HTTP ${res.status}`);
  const body: unknown = await res.json();

  let value: EnumLookup;
  if (!body || typeof body !== "object") {
    value = "no_enum";
  } else {
    const nodeInfo = (body as Record<string, unknown>)[classType];
    if (nodeInfo === undefined) {
      // ComfyUI answers 200 {} for a class_type it does not have installed.
      value = "node_missing";
    } else {
      const options = readEnum(nodeInfo, field);
      value = options ?? "no_enum";
    }
  }
  enumCache.set(key, { at: Date.now(), value });
  return value;
}

function preflightEnabled(): boolean {
  const raw = (process.env.FRAMEFORGE_MODEL_PREFLIGHT ?? "").trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

/**
 * Check a workflow against ONE worker. Never throws: every failure to probe
 * degrades to `undeterminable`.
 */
export async function preflightWorkflow(
  base: string,
  workflow: unknown,
  timeoutMs = 8000,
): Promise<PreflightReport> {
  const refs = extractModelRefs(workflow);
  const checked: CheckedRef[] = [];

  for (const ref of refs) {
    let verdict: RefVerdict;
    let reason: string | undefined;
    try {
      const options = await lookupEnum(base, ref.classType, ref.field, timeoutMs);
      if (options === "node_missing") {
        verdict = "node_missing";
      } else if (options === "no_enum") {
        verdict = "undeterminable";
        reason = "field has no readable option list";
      } else {
        verdict = options.has(ref.file) ? "present" : "missing_file";
      }
    } catch (error) {
      // Unreachable worker, timeout, malformed JSON — never block on this.
      verdict = "undeterminable";
      reason = error instanceof Error ? error.message : String(error);
    }
    checked.push({ ...ref, verdict, reason });
  }

  const missingFiles = checked.filter((c) => c.verdict === "missing_file");
  const missingNodes = checked.filter((c) => c.verdict === "node_missing");
  const undeterminable = checked.filter((c) => c.verdict === "undeterminable");
  return {
    base,
    checked,
    missingFiles,
    missingNodes,
    undeterminable,
    ok: missingFiles.length === 0 && missingNodes.length === 0,
  };
}

function formatReport(report: PreflightReport): string {
  const lines: string[] = [];
  if (report.missingNodes.length > 0) {
    const nodes = [...new Set(report.missingNodes.map((r) => r.classType))];
    lines.push(
      `node type(s) not installed on this worker: ${nodes.join(", ")} — ` +
        `the workflow cannot run here at all, install the custom-node pack ` +
        `that provides them (or dispatch this lane to a worker that has it)`,
    );
  }
  for (const ref of report.missingFiles) {
    const hint = SUBDIR_HINTS[ref.field] ?? "the matching models/ subdirectory";
    lines.push(
      `missing model file "${ref.file}" for ${ref.classType}.${ref.field} ` +
        `(node ${ref.nodeId}) — put it in ${hint} on this worker`,
    );
  }
  return lines.join("; ");
}

/**
 * Dispatch gate. Call with the RESOLVED worker's base immediately before
 * POSTing the prompt — a preflight against any other ComfyUI is worthless,
 * which is the whole point of the ticket.
 *
 * Throws ModelPreflightError only on a definitive miss. Returns the report
 * otherwise (including when the gate is disabled or could not determine
 * anything) so callers can log it.
 */
export async function assertModelsPresent(
  base: string,
  workflow: unknown,
  timeoutMs = 8000,
): Promise<PreflightReport | null> {
  if (!preflightEnabled()) return null;

  const report = await preflightWorkflow(base, workflow, timeoutMs);
  if (report.checked.length === 0) return report;

  if (!report.ok) {
    throw new ModelPreflightError(
      `Model preflight failed for ${base}: ${formatReport(report)}`,
      report,
    );
  }

  if (report.undeterminable.length > 0) {
    console.warn(
      `[FrameForge] model preflight: ${report.undeterminable.length}/` +
        `${report.checked.length} ref(s) undeterminable on ${base} — ` +
        `dispatching anyway (fail-open)`,
    );
  }
  return report;
}
