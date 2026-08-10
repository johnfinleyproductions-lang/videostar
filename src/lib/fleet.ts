// FrameForge — Worker Fleet (multi-box ComfyUI routing)
//
// One FrameForge app, several ComfyUI boxes ("workers"). Every dispatch picks
// a worker for the job's lane, uploads the job's inputs to THAT worker, queues
// there, and stamps the worker's NAME (never a URL) onto the history item so
// the status/output routes poll and proxy the right box for the job's whole
// lifetime (including the RIFE post job, which must run where stage 1 saved
// its output).
//
// BACKWARD COMPATIBILITY (the cardinal rule): with only vidbox enabled —
// today's deployed env, COMFYUI_URL=http://127.0.0.1:8188 and neither
// FRAMERSTATION_COMFYUI_URL nor THINK_COMFYUI_URL set — every code path
// behaves exactly like the single-base production build: one candidate per
// lane (vidbox), no availability ping (single-candidate selection short-
// circuits), the same bases, the same URLs. History items WITHOUT a `worker`
// field (all pre-fleet history) resolve to the default worker.
//
// A worker is ENABLED iff its comfyBase is set. vidbox always has a base
// (COMFYUI_URL || http://127.0.0.1:8188 — IMPORTANT: 127.0.0.1, never
// localhost; IPv6 issue on CachyOS), so the fleet always has a default.
// framerstation/think stay disabled until their env URLs are set.
//
// Lane vocabulary: a worker's `lanes` list matches the models.ts profile
// `kind` strings ("wan-i2v", "hv-template", "audio", "matte", …) plus two
// pseudo-lanes for dispatches that have no video profile kind:
//   - "flux-image": the FLUX/Z-Image stills path (/api/images/*)
//   - "finish":     the /api/finish upscalers
// "*" matches every lane (the catch-all default worker).
//
// EVCTL-style JSON env override: set FRAMEFORGE_FLEET to a JSON array of
// partial worker objects to override/extend the embedded defaults, e.g.
//   FRAMEFORGE_FLEET='[{"name":"framerstation","comfyBase":"http://192.168.4.204:8188","lanes":["flux-image","hv-template","audio"]}]'
// Entries merge BY NAME over the embedded defaults (fields you set win;
// omitted fields keep the embedded value); unknown names append new workers.
// Invalid JSON is logged and ignored — a bad override must never take down
// dispatching.

export interface FleetWorker {
  /** Stable worker name — the value stamped into history (never a URL). */
  name: string;
  /** ComfyUI HTTP base ("http://host:8188"). Unset = worker DISABLED. */
  comfyBase?: string;
  /** ComfyUI websocket base ("ws://host:8188/ws"); derived from comfyBase when unset. */
  wsBase?: string;
  /** Lanes this worker serves: profile kinds / pseudo-lanes, or "*" for all. */
  lanes: "*" | readonly string[];
  /** The legacy/default worker — the fallback for every lane and all old history. */
  isDefault?: boolean;
  /**
   * This worker is the ONLY box that can run its lanes — when it is down,
   * dispatch must FAIL LOUDLY (FleetWorkerUnavailableError → 503) instead of
   * falling back to another worker. Born 2026-08-09: the sidecar died and an
   * svi-chain draft silently dispatched to the live 8188 box, which happened
   * to work only because live KJNodes also had the node.
   */
  exclusive?: boolean;
  /** Operator runbook line appended to the unavailable error (how to restart). */
  restartHint?: string;
}

/**
 * Thrown by pickWorker when an `exclusive` worker's lane is dispatched while
 * that worker is down. The generate route answers it with an honest 503 (the
 * RemotionServiceUnreachableError precedent) — never a silent fallback.
 */
export class FleetWorkerUnavailableError extends Error {
  readonly workerName: string;

  constructor(worker: FleetWorker, lane?: string) {
    const laneNote = lane ? ` for lane "${lane}"` : "";
    super(
      `Fleet worker "${worker.name}" (${worker.comfyBase}) is required${laneNote} ` +
        `but did not answer /system_stats — job NOT dispatched (no fallback: ` +
        `only this worker can run the lane).` +
        (worker.restartHint ? ` ${worker.restartHint}` : ""),
    );
    this.name = "FleetWorkerUnavailableError";
    this.workerName = worker.name;
  }
}

const FLEET_ENV_OVERRIDE = "FRAMEFORGE_FLEET";

/** Strip a trailing slash so `${base}/prompt` style joins stay clean. */
function cleanBase(base: string | undefined): string | undefined {
  const trimmed = base?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "");
}

/**
 * Embedded fleet defaults. Evaluated per call (not at module load) so env
 * behavior matches the pre-fleet clients, which also read process.env at
 * import time of a per-request route module — and so tests can vary env.
 */
function embeddedFleet(): FleetWorker[] {
  return [
    {
      // The app's own box — the legacy single-base production target.
      name: "vidbox",
      comfyBase: cleanBase(process.env.COMFYUI_URL) ?? "http://127.0.0.1:8188",
      // Preserved verbatim from the pre-fleet /api/ws route; when unset the
      // ws base derives from comfyBase (identical result for the default env).
      wsBase: cleanBase(process.env.COMFYUI_WS_URL),
      lanes: "*",
      isDefault: true,
    },
    {
      // The ComfyUI v0.30 SIDECAR on this same box (~/ComfyUI-v30, port 8190,
      // loopback-only — FrameForge runs on the box, so 127.0.0.1 reaches it).
      // The ONLY worker with MiniMax-H3 nodes/weights; the live 0.18.1 box
      // cannot run that lane. EXCLUSIVE: its lanes never fall back to the
      // default box — a down sidecar means a 503 with the restart runbook,
      // not a dispatch to 8188 that only works by node-overlap luck.
      // Start it with:
      //   cd ~/ComfyUI-v30 && setsid ~/venvs/comfyui-v30/bin/python \
      //     main.py --listen 127.0.0.1 --port 8190
      // Other lanes are unaffected: this worker never matches them and is
      // not a catch-all, so their candidate list stays [vidbox] (no pings).
      name: "vidbox-sidecar",
      comfyBase:
        cleanBase(process.env.SIDECAR_COMFYUI_URL) ?? "http://127.0.0.1:8190",
      lanes: ["minimax-h3"],
      exclusive: true,
      restartHint:
        'Restart it on vidbox: schtasks /Run /TN "Evergreen ComfyUI Sidecar" ' +
        "(then retry once http://127.0.0.1:8190/system_stats answers).",
    },
    {
      // FLUX stills + HV-HUMANS + MUSIC offload box (not active yet —
      // enabled the moment FRAMERSTATION_COMFYUI_URL is set).
      name: "framerstation",
      comfyBase: cleanBase(process.env.FRAMERSTATION_COMFYUI_URL),
      wsBase: cleanBase(process.env.FRAMERSTATION_COMFYUI_WS_URL),
      lanes: ["flux-image", "hv-template", "audio"],
    },
    {
      // Light utility box (not active yet — enabled via THINK_COMFYUI_URL).
      // NOTE: distinct from the think REMOTION render service (:3070) — this
      // entry is a ComfyUI runtime on that host, used only when configured.
      name: "think",
      comfyBase: cleanBase(process.env.THINK_COMFYUI_URL),
      wsBase: cleanBase(process.env.THINK_COMFYUI_WS_URL),
      lanes: ["matte"],
    },
  ];
}

/**
 * Normalize an override's `lanes` value (runtime JSON — any shape). Returns
 * "*", a clean string array, or undefined for an invalid shape (caller keeps
 * the embedded value). Valid JSON with a hostile shape (lanes as a bare
 * string / number / null, non-string elements) must degrade with a warning,
 * never crash resolveWorkerForLane on every subsequent dispatch.
 */
function normalizeLanes(
  value: unknown,
  workerName: string,
): "*" | string[] | undefined {
  if (value === "*") return "*";
  if (Array.isArray(value)) {
    const lanes = value.filter(
      (l): l is string => typeof l === "string" && l.trim().length > 0,
    );
    if (lanes.length !== value.length) {
      console.warn(
        `[FrameForge] ${FLEET_ENV_OVERRIDE}: dropped non-string lane entries for worker "${workerName}"`,
      );
    }
    return lanes.map((l) => l.trim());
  }
  console.warn(
    `[FrameForge] ${FLEET_ENV_OVERRIDE}: worker "${workerName}" lanes must be "*" or a string array — ignored`,
  );
  return undefined;
}

/**
 * Normalize an override's base URL value (runtime JSON — any shape).
 * A string cleans as usual; null explicitly UNSETS the base (disables the
 * worker); any other type warns and unsets — a number/object must never
 * String() into a garbage base like "null".
 */
function normalizeBase(
  value: unknown,
  field: string,
  workerName: string,
): string | undefined {
  if (typeof value === "string") return cleanBase(value);
  if (value !== null) {
    console.warn(
      `[FrameForge] ${FLEET_ENV_OVERRIDE}: worker "${workerName}" ${field} must be a string (or null to disable) — treating as unset`,
    );
  }
  return undefined;
}

/** Parse the FRAMEFORGE_FLEET JSON override; [] when unset/invalid. */
function envFleetOverride(): Partial<FleetWorker>[] {
  const raw = process.env[FLEET_ENV_OVERRIDE];
  if (!raw || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[FrameForge] ${FLEET_ENV_OVERRIDE} must be a JSON array — ignored`);
      return [];
    }
    return parsed.filter(
      (entry): entry is Partial<FleetWorker> =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string" &&
        ((entry as { name: string }).name.trim().length > 0),
    );
  } catch (error) {
    console.warn(
      `[FrameForge] ${FLEET_ENV_OVERRIDE} is not valid JSON — ignored:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/** The full fleet: embedded defaults merged (by name) with the env override. */
export function getFleet(): FleetWorker[] {
  const fleet = embeddedFleet();
  for (const override of envFleetOverride()) {
    const name = (override.name as string).trim();
    const existing = fleet.find((w) => w.name === name);
    if (existing) {
      if (override.comfyBase !== undefined) {
        existing.comfyBase = normalizeBase(override.comfyBase, "comfyBase", name);
      }
      if (override.wsBase !== undefined) {
        existing.wsBase = normalizeBase(override.wsBase, "wsBase", name);
      }
      if (override.lanes !== undefined) {
        // Invalid shape → keep the embedded lanes (normalizeLanes warned).
        const lanes = normalizeLanes(override.lanes, name);
        if (lanes !== undefined) existing.lanes = lanes;
      }
      if (override.isDefault !== undefined) {
        existing.isDefault = Boolean(override.isDefault);
      }
      if (override.exclusive !== undefined) {
        existing.exclusive = Boolean(override.exclusive);
      }
      if (override.restartHint !== undefined) {
        existing.restartHint =
          typeof override.restartHint === "string"
            ? override.restartHint
            : undefined;
      }
    } else {
      fleet.push({
        name,
        comfyBase:
          override.comfyBase === undefined
            ? undefined
            : normalizeBase(override.comfyBase, "comfyBase", name),
        wsBase:
          override.wsBase === undefined
            ? undefined
            : normalizeBase(override.wsBase, "wsBase", name),
        lanes:
          override.lanes === undefined
            ? []
            : (normalizeLanes(override.lanes, name) ?? []),
        isDefault: Boolean(override.isDefault),
        exclusive: Boolean(override.exclusive),
        restartHint:
          typeof override.restartHint === "string"
            ? override.restartHint
            : undefined,
      });
    }
  }
  return fleet;
}

/** Workers that can actually take jobs (comfyBase set). */
export function getEnabledWorkers(): FleetWorker[] {
  return getFleet().filter((w) => Boolean(w.comfyBase));
}

/**
 * The default worker — the legacy single-base target. Every history item
 * without a `worker` field belongs to it. vidbox always has a comfyBase, so
 * this only throws if a FRAMEFORGE_FLEET override explicitly breaks it.
 */
export function getDefaultWorker(): FleetWorker {
  const enabled = getEnabledWorkers();
  const byFlag = enabled.find((w) => w.isDefault);
  const chosen = byFlag ?? enabled[0];
  if (!chosen) {
    throw new Error(
      "FrameForge fleet has no enabled workers — check COMFYUI_URL / FRAMEFORGE_FLEET",
    );
  }
  return chosen;
}

/**
 * Resolve a worker NAME (as stamped in history) to a worker. Missing name →
 * default worker (legacy history contract). An unknown or currently-disabled
 * name ALSO falls back to the default with a warning — old jobs must keep
 * resolving somewhere rather than 500 if a worker is renamed/unplugged.
 */
export function getWorker(name?: string | null): FleetWorker {
  if (!name) return getDefaultWorker();
  const match = getEnabledWorkers().find((w) => w.name === name);
  if (match) return match;
  const fallback = getDefaultWorker();
  if (name !== fallback.name) {
    console.warn(
      `[FrameForge] worker "${name}" is unknown/disabled — falling back to "${fallback.name}"`,
    );
  }
  return fallback;
}

/** ComfyUI HTTP base for a stamped worker name (missing → default worker). */
export function getWorkerComfyBase(name?: string | null): string {
  // getWorker only returns enabled workers, so comfyBase is always set here.
  return getWorker(name).comfyBase as string;
}

/** Websocket base for a worker: explicit wsBase, else derived from comfyBase. */
export function getWorkerWsBase(worker: FleetWorker): string {
  if (worker.wsBase) return worker.wsBase;
  const base = worker.comfyBase ?? "http://127.0.0.1:8188";
  return `${base.replace(/^http/, "ws")}/ws`;
}

/**
 * Ordered dispatch candidates for a lane (a models.ts profile `kind`, or a
 * pseudo-lane like "flux-image"/"finish"): lane-specific enabled workers
 * first (fleet order), then the default worker, then any other enabled
 * catch-all ("*") workers. With only vidbox enabled this is always [vidbox].
 *
 * EXCLUSIVE lanes: when any lane-specific match is `exclusive`, the list is
 * ONLY the lane-specific matches — no default, no catch-alls. pickWorker
 * then health-gates the pick and throws FleetWorkerUnavailableError rather
 * than dispatching the lane to a box that can't (reliably) run it.
 */
export function resolveWorkerForLane(laneOrKind: string): FleetWorker[] {
  const lane = laneOrKind.trim().toLowerCase();
  const enabled = getEnabledWorkers();
  const candidates: FleetWorker[] = [];
  const push = (worker: FleetWorker | undefined) => {
    if (worker && !candidates.some((c) => c.name === worker.name)) {
      candidates.push(worker);
    }
  };

  for (const worker of enabled) {
    // Array.isArray + typeof guards: worker.lanes is normalized at parse
    // time, but a dispatch crash on every job is the one failure mode this
    // module must never have — guard at the use site too.
    if (
      worker.lanes !== "*" &&
      Array.isArray(worker.lanes) &&
      worker.lanes.some((l) => typeof l === "string" && l.toLowerCase() === lane)
    ) {
      push(worker);
    }
  }
  if (candidates.some((c) => c.exclusive)) {
    return candidates;
  }
  push(getDefaultWorker());
  for (const worker of enabled) {
    if (worker.lanes === "*") push(worker);
  }
  return candidates;
}

/** One /system_stats availability ping (2s timeout). */
async function workerAnswers(worker: FleetWorker): Promise<boolean> {
  try {
    const res = await fetch(`${worker.comfyBase}/system_stats`, {
      signal: AbortSignal.timeout(2_000),
    });
    // Drain/cancel so undici doesn't hold the connection open.
    await res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pick the dispatch worker from an ordered candidate list.
 *
 * Single NON-exclusive candidate (today's vidbox-only fleet): returned
 * immediately, NO availability ping — the request pattern stays
 * byte-identical to the pre-fleet build, and a down box surfaces exactly
 * today's queue error.
 *
 * Single EXCLUSIVE candidate (a lane only one box can run): health-gated —
 * ping /system_stats; a dead worker THROWS FleetWorkerUnavailableError
 * (route → 503 with the restart hint) instead of dispatching anywhere.
 *
 * Multiple candidates: ping GET /system_stats down the list (2s timeout
 * each); the first responder wins. If NONE respond: exclusive head throws
 * (its lane has no legal fallback); otherwise return the first candidate
 * anyway and let the dispatch fail with today's error — an honest queue
 * failure beats inventing a new error contract.
 */
export async function pickWorker(
  candidates: FleetWorker[],
  lane?: string,
): Promise<FleetWorker> {
  if (candidates.length === 0) {
    // resolveWorkerForLane always appends the default for non-exclusive
    // lanes; reaching this means the fleet itself is broken — same failure
    // getDefaultWorker reports.
    return getDefaultWorker();
  }
  if (candidates.length === 1) {
    const only = candidates[0];
    if (!only.exclusive) return only;
    if (await workerAnswers(only)) return only;
    throw new FleetWorkerUnavailableError(only, lane);
  }

  for (const worker of candidates) {
    if (await workerAnswers(worker)) return worker;
    console.warn(
      `[FrameForge] worker "${worker.name}" (${worker.comfyBase}) did not answer /system_stats — trying next candidate`,
    );
  }

  if (candidates[0].exclusive) {
    // An all-exclusive candidate list (resolveWorkerForLane never mixes
    // exclusive and fallback workers): nothing here may take the lane's job.
    throw new FleetWorkerUnavailableError(candidates[0], lane);
  }
  console.warn(
    `[FrameForge] no fleet worker answered /system_stats — dispatching to "${candidates[0].name}" anyway (legacy error surface)`,
  );
  return candidates[0];
}
