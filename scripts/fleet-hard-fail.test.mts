/* Exclusive-worker hard-fail matrix: a lane whose only capable box is down
 * must throw (route → 503 + restart runbook), NEVER silently fall back to
 * the default box (2026-08-09: svi-chain draft ran on live 8188 because the
 * sidecar had died). Runs the exact functions the generate route uses, with
 * env-pointed bases — no live service is touched. */
import { createServer, type Server } from "node:http";
import {
  FleetWorkerUnavailableError,
  pickWorker,
  resolveWorkerForLane,
} from "../src/lib/fleet";

let fail = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.log("FAIL " + msg);
  } else console.log("pass " + msg);
}

/** Mock healthy ComfyUI: answers 200 on /system_stats. */
function mockComfy(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const DEAD = "http://127.0.0.1:59999"; // nothing listens here

// ---- candidate resolution -------------------------------------------------

// Exclusive lane: candidates are ONLY the sidecar — no default appended.
{
  const names = resolveWorkerForLane("minimax-h3").map((w) => w.name);
  check(
    names.length === 1 && names[0] === "vidbox-sidecar",
    `minimax-h3 candidates = [vidbox-sidecar] only (got ${JSON.stringify(names)})`,
  );
}
{
  const names = resolveWorkerForLane("  MiniMax-H3 ").map((w) => w.name);
  check(
    names.length === 1 && names[0] === "vidbox-sidecar",
    "exclusive short-circuit survives case/whitespace",
  );
}

// Ordinary lane: default-worker fallback list unchanged.
{
  const names = resolveWorkerForLane("wan-i2v").map((w) => w.name);
  check(
    names[0] === "vidbox",
    `wan-i2v still resolves to the default box (got ${JSON.stringify(names)})`,
  );
}

// ---- pickWorker: legacy single-candidate short-circuit --------------------

// A single NON-exclusive candidate returns with NO ping even when the box is
// dead — byte-identical legacy dispatch surface (the down box surfaces
// today's queue error, not a new one).
{
  process.env.COMFYUI_URL = DEAD;
  const worker = await pickWorker(resolveWorkerForLane("wan-i2v"), "wan-i2v");
  check(
    worker.name === "vidbox",
    "single non-exclusive candidate returns un-pinged (legacy surface intact)",
  );
  delete process.env.COMFYUI_URL;
}

// ---- pickWorker: exclusive hard-fail --------------------------------------

// Dead exclusive worker → FleetWorkerUnavailableError with the runbook, and
// the error must carry the lane + worker for the 503 copy.
{
  process.env.SIDECAR_COMFYUI_URL = DEAD;
  let thrown: unknown;
  try {
    await pickWorker(resolveWorkerForLane("minimax-h3"), "minimax-h3");
  } catch (error) {
    thrown = error;
  }
  const err = thrown instanceof FleetWorkerUnavailableError ? thrown : undefined;
  check(err !== undefined, "dead exclusive worker throws FleetWorkerUnavailableError");
  check(err?.workerName === "vidbox-sidecar", "error names the worker");
  check(
    (err?.message ?? "").includes('schtasks /Run /TN "Evergreen ComfyUI Sidecar"'),
    "error message carries the schtasks restart runbook",
  );
  check(
    (err?.message ?? "").includes('lane "minimax-h3"'),
    "error message names the lane",
  );
  check(
    (err?.message ?? "").includes("NOT dispatched"),
    "error message states the job was not dispatched anywhere",
  );
  delete process.env.SIDECAR_COMFYUI_URL;
}

// Healthy exclusive worker → picked normally (the gate opens when it's up).
{
  const { server, base } = await mockComfy();
  process.env.SIDECAR_COMFYUI_URL = base;
  const worker = await pickWorker(resolveWorkerForLane("minimax-h3"), "minimax-h3");
  check(
    worker.name === "vidbox-sidecar" && worker.comfyBase === base,
    "healthy exclusive worker dispatches normally",
  );
  delete process.env.SIDECAR_COMFYUI_URL;
  server.closeAllConnections();
  server.close();
}

// ---- pickWorker: non-exclusive multi-candidate fallback unchanged ---------

// framerstation (audio lane) dead + vidbox healthy → falls back to vidbox
// exactly as before; exclusivity must not leak onto ordinary lanes.
{
  const { server, base } = await mockComfy();
  process.env.FRAMERSTATION_COMFYUI_URL = DEAD;
  process.env.COMFYUI_URL = base;
  const candidates = resolveWorkerForLane("audio");
  check(
    candidates.map((w) => w.name).join(",") === "framerstation,vidbox",
    "audio lane still lists framerstation then vidbox",
  );
  const worker = await pickWorker(candidates, "audio");
  check(
    worker.name === "vidbox",
    "dead NON-exclusive worker still falls back to the default box",
  );
  delete process.env.FRAMERSTATION_COMFYUI_URL;
  delete process.env.COMFYUI_URL;
  server.closeAllConnections();
  server.close();
}

// ---- FRAMEFORGE_FLEET override escape hatch -------------------------------

// exclusive:false via env override restores the old fallback behavior
// without a rebuild (the same merge contract as every other field).
{
  process.env.FRAMEFORGE_FLEET = JSON.stringify([
    { name: "vidbox-sidecar", exclusive: false },
  ]);
  const names = resolveWorkerForLane("minimax-h3").map((w) => w.name);
  check(
    names.includes("vidbox"),
    "FRAMEFORGE_FLEET exclusive:false override restores the fallback list",
  );
  delete process.env.FRAMEFORGE_FLEET;
}

console.log(fail ? `\nRESULT: ${fail} FAILURES` : "\nRESULT: HARD-FAIL MATRIX PASSES");
process.exitCode = fail ? 1 : 0;
