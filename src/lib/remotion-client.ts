// FrameForge — Remotion render service client (MG-TYPE lane executor)
//
// The MG-TYPE lane renders on ANOTHER machine: think (192.168.4.200) runs a
// small dependency-free HTTP wrapper (~/evergreen-remotion/server.mjs, port
// 3070) around the existing Remotion project's render.mjs. This module is
// FrameForge's client for that service:
//
//   POST /render        { composition, props, seed? } → { jobId }
//   GET  /jobs/<jobId>  → { status: queued|rendering|completed|failed,
//                           filename?, previewFilename?, error? }
//   GET  /files/<jobId>[?file=preview] → streams the rendered file
//   GET  /health        → { ok, compositions[] }
//
// DELIVERABLES (mirrors render.mjs on think):
//   LowerThird → ProRes 4444 + alpha .mov (NLE deliverable) PLUS a VP8 alpha
//                webm preview (browsers cannot play ProRes; vp8/yuva420p
//                verified on the installed Remotion 4.0.489, alpha_mode=1).
//   TitleCard  → h264 .mp4.
//
// The composition catalog below is HARDCODED (mirrors src/Root.tsx on think
// and the COMPOSITIONS table in server.mjs — three copies of one truth, all
// annotated to each other) rather than fetched from /health at request time:
// the lane manifest (GET /api/lanes) must stay serveable when think is down,
// and the generate route needs the props schema to 400 clearly BEFORE
// dispatch. The service still validates authoritatively on its side.

// Remotion renders are CPU renders on think — no GPU, no ComfyUI, no VRAM
// sweep. Never point this at the ComfyUI box.
const REMOTION_SERVICE_URL =
  process.env.REMOTION_SERVICE_URL || "http://192.168.4.200:3070";

/** Actionable copy for a down service, used by the generate-route 503. */
export const REMOTION_SERVICE_DOWN_MESSAGE =
  `Remotion render service unreachable at ${REMOTION_SERVICE_URL} — ` +
  'start it on think: ssh think "~/evergreen-remotion/start-service.sh" ' +
  "(or systemctl start remotion-render if the unit is installed)";

export interface RemotionCompositionSpec {
  id: string;
  description: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** True → primary deliverable carries an alpha channel (+ webm preview). */
  alpha: boolean;
  /** Primary deliverable container ("mov" = ProRes 4444 alpha, "mp4" = h264). */
  container: "mov" | "mp4";
  /** Prop name → human description. */
  requiredProps: Record<string, string>;
  optionalProps: Record<string, string>;
}

export const REMOTION_COMPOSITIONS: readonly RemotionCompositionSpec[] = [
  {
    id: "LowerThird",
    description:
      "Name/role lower third: gold accent bar + dark glass panel slides in, " +
      "serif title + tracked gold subtitle, fades out. TRANSPARENT background.",
    width: 1920,
    height: 1080,
    fps: 32,
    durationInFrames: 160, // 5.0s
    alpha: true,
    container: "mov",
    requiredProps: {
      title: 'Main line, serif (e.g. "Alex Hormozi")',
      subtitle: 'Tracked upper-case kicker (e.g. "FOUNDER, ACQUISITION.COM")',
    },
    optionalProps: {
      accentColor:
        'CSS color for the bar + subtitle (default Evergreen gold "#d4a94e")',
    },
  },
  {
    id: "TitleCard",
    description:
      "Full-frame episode/section title card on the deep-teal radial house " +
      "background: gold rule, serif title, tracked subtitle + optional credit. OPAQUE.",
    width: 1920,
    height: 1080,
    fps: 32,
    durationInFrames: 192, // 6.0s
    alpha: false,
    container: "mp4",
    requiredProps: {
      title: 'Big serif title (e.g. "The Real Story of Alex Hormozi")',
      subtitle: 'Tracked upper-case gold subtitle (e.g. "HE GAVE IT ALL AWAY")',
    },
    optionalProps: {
      credit: "Small bottom credit line (omitted = no credit row)",
    },
  },
];

export const REMOTION_COMPOSITION_IDS = REMOTION_COMPOSITIONS.map(
  (c) => c.id,
) as readonly string[];

export function getRemotionComposition(
  id: string,
): RemotionCompositionSpec | undefined {
  return REMOTION_COMPOSITIONS.find((c) => c.id === id.trim());
}

/**
 * Collect + validate the composition props from a generate-request body.
 * Accepts EITHER a nested `props` object or the flat documented body params
 * (title, subtitle, accentColor, credit) — flat params fill any key the
 * nested object omitted, so both call styles work. Returns the clean props,
 * or an error string for the route's 400.
 */
export function buildRemotionProps(
  comp: RemotionCompositionSpec,
  body: Record<string, unknown>,
): { props: Record<string, string> } | { error: string } {
  const known = [
    ...Object.keys(comp.requiredProps),
    ...Object.keys(comp.optionalProps),
  ];

  const nested = body.props;
  if (
    nested !== undefined &&
    (typeof nested !== "object" || nested === null || Array.isArray(nested))
  ) {
    return { error: "props must be a JSON object of composition props" };
  }

  const props: Record<string, string> = {};
  for (const key of known) {
    const value =
      nested && (nested as Record<string, unknown>)[key] !== undefined
        ? (nested as Record<string, unknown>)[key]
        : body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      return { error: `Composition prop "${key}" must be a string` };
    }
    if (value.trim()) props[key] = value;
  }

  // Typo guard on the nested object only (flat body keys share a namespace
  // with the generic generate params, so unknown flat keys stay ignorable).
  if (nested) {
    for (const key of Object.keys(nested as Record<string, unknown>)) {
      if (!known.includes(key)) {
        return {
          error:
            `Unknown prop "${key}" for ${comp.id} — required: ` +
            `${Object.keys(comp.requiredProps).join(", ")}; optional: ` +
            `${Object.keys(comp.optionalProps).join(", ") || "(none)"}`,
        };
      }
    }
  }

  const missing = Object.keys(comp.requiredProps).filter((key) => !props[key]);
  if (missing.length) {
    return {
      error:
        `The MG-TYPE lane's ${comp.id} composition requires ` +
        `${missing.map((k) => `"${k}"`).join(" and ")} — pass ` +
        `${missing.join(", ")} as body params (or inside a props object). ` +
        `Required: ${Object.keys(comp.requiredProps).join(", ")}; optional: ` +
        `${Object.keys(comp.optionalProps).join(", ") || "(none)"}.`,
    };
  }

  return { props };
}

/** Thrown when the render service cannot be reached (network-level failure). */
export class RemotionServiceUnreachableError extends Error {
  constructor(cause: unknown) {
    super(REMOTION_SERVICE_DOWN_MESSAGE);
    this.name = "RemotionServiceUnreachableError";
    this.cause = cause;
  }
}

export interface RemotionJobStatus {
  jobId: string;
  status: "queued" | "rendering" | "completed" | "failed";
  composition?: string;
  error?: string;
  filename?: string;
  contentType?: string;
  /** VP8 alpha webm preview (alpha compositions; absent when it failed). */
  previewFilename?: string;
  previewError?: string;
}

/** Control-plane calls (health/render/jobs) answer in milliseconds. */
const CONTROL_TIMEOUT_MS = 30_000;
/**
 * File fetches need a LONG timeout: AbortSignal.timeout() on fetch aborts the
 * whole response INCLUDING the body stream, and /api/output pipes the body
 * through to the browser at the CLIENT's pace — a 30s signal would truncate
 * any ProRes .mov (100MB+) download that takes longer than 30s end-to-end.
 * Unreachability is still detected instantly (connect errors reject the fetch
 * regardless of the signal); the signal only bounds a wedged transfer.
 */
const FILE_TIMEOUT_MS = 15 * 60_000;

async function serviceFetch(
  path: string,
  init?: RequestInit,
  timeoutMs: number = CONTROL_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(`${REMOTION_SERVICE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new RemotionServiceUnreachableError(error);
  }
}

/** POST /render on think → the remote jobId. Non-2xx → Error with the service's message. */
export async function createRemotionRender(
  composition: string,
  props: Record<string, string>,
  seed?: number,
): Promise<{ jobId: string }> {
  const res = await serviceFetch("/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ composition, props, seed }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    jobId?: string;
    error?: string;
  };
  if (!res.ok || !data.jobId) {
    throw new Error(
      `Remotion render dispatch failed (${res.status}): ${data.error ?? "no jobId returned"}`,
    );
  }
  return { jobId: data.jobId };
}

/** GET /jobs/<jobId> on think. Returns null on 404 (job unknown to the service). */
export async function getRemotionJob(
  jobId: string,
): Promise<RemotionJobStatus | null> {
  const res = await serviceFetch(`/jobs/${encodeURIComponent(jobId)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Remotion job status failed (${res.status})`);
  }
  return (await res.json()) as RemotionJobStatus;
}

/**
 * GET /files/<jobId> on think — the raw Response for /api/output to stream
 * through (Range header forwarded so browser video seeking works).
 */
export async function fetchRemotionFile(
  jobId: string,
  variant: "primary" | "preview",
  rangeHeader?: string | null,
): Promise<Response> {
  const suffix = variant === "preview" ? "?file=preview" : "";
  return serviceFetch(
    `/files/${encodeURIComponent(jobId)}${suffix}`,
    { headers: rangeHeader ? { Range: rangeHeader } : undefined },
    FILE_TIMEOUT_MS,
  );
}
