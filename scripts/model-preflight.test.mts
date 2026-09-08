/* Model preflight: a lane must not be dispatched to a worker that cannot run
 * it (ticket comfy-workflow-model-preflight — the "two-comfy landmine": weights
 * or custom nodes installed on a DIFFERENT ComfyUI than the one serving the
 * lane; measured 2026-09-08, 7 of 37 lanes answer differently by worker).
 *
 * Drives the REAL queuePrompt seam against mock ComfyUIs, so "nothing was
 * queued" is asserted from the mock's own request log rather than assumed.
 * No live service is touched. */
import { createServer, type Server } from "node:http";
import { queuePrompt } from "../src/lib/comfyui-client";
import {
  isModelPreflightError,
  clearPreflightCache,
  extractModelRefs,
  preflightWorkflow,
  readEnum,
} from "../src/lib/model-preflight";

let fail = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.log("FAIL " + msg);
  } else console.log("pass " + msg);
}

interface Mock {
  server: Server;
  base: string;
  /** Every path the mock was asked for — proves what was and was not called. */
  hits: string[];
}

/**
 * Mock ComfyUI. `objectInfo` maps class_type -> payload; a class_type absent
 * from the map answers `200 {}`, which is exactly what a real ComfyUI does for
 * a node pack it does not have installed.
 */
function mockComfy(objectInfo: Record<string, unknown>): Promise<Mock> {
  return new Promise((resolve) => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      hits.push(url);
      if (url.startsWith("/object_info/")) {
        const ct = decodeURIComponent(url.slice("/object_info/".length));
        const payload =
          ct in objectInfo ? { [ct]: objectInfo[ct] } : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }
      if (url === "/prompt") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ prompt_id: "p1", number: 1, node_errors: {} }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, hits });
    });
  });
}

/** Classic enum shape: [[...files...], {...}] */
function classicNode(field: string, files: string[]) {
  return { input: { required: { [field]: [files, {}] } } };
}
/** Newer COMBO shape: ["COMBO", { options: [...] }] — 7 of our field types. */
function comboNode(field: string, files: string[]) {
  return {
    input: { required: { [field]: ["COMBO", { options: files, multiselect: false }] } },
  };
}

const WF_UNET = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "wanted.safetensors" } },
};

async function main() {
  delete process.env.FRAMEFORGE_MODEL_PREFLIGHT;

  // --- extraction ---------------------------------------------------------
  const refs = extractModelRefs({
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "a.safetensors", steps: 8, latent: ["2", 0] },
    },
    "2": { class_type: "RIFE VFI", inputs: { ckpt_name: "rife47.pth" } },
    "3": { class_type: "SaveImage", inputs: { filename_prefix: "out" } },
  });
  check(refs.length === 2, "extract: finds 2 model refs, ignores non-weight inputs");
  check(
    refs.some((r) => r.classType === "RIFE VFI" && r.file === "rife47.pth"),
    "extract: handles a class_type containing a space",
  );
  check(
    !refs.some((r) => typeof r.file !== "string"),
    "extract: never treats a link array ([node, slot]) as a filename",
  );
  check(
    extractModelRefs({ nodes: [{ type: "UNETLoader" }] }).length === 0,
    "extract: UI-format graph yields no refs (gate becomes a no-op, fail open)",
  );

  // --- both enum shapes ----------------------------------------------------
  check(
    readEnum(classicNode("unet_name", ["a.safetensors"]), "unet_name")?.has(
      "a.safetensors",
    ) === true,
    "readEnum: classic shape [[files], {}]",
  );
  check(
    readEnum(comboNode("unet_name", ["a.safetensors"]), "unet_name")?.has(
      "a.safetensors",
    ) === true,
    "readEnum: COMBO shape ['COMBO', {options}] — the silent fail-open landmine",
  );

  // --- 1. POSITIVE control -------------------------------------------------
  clearPreflightCache();
  const ok = await mockComfy({
    UNETLoader: classicNode("unet_name", ["wanted.safetensors"]),
  });
  const res = await queuePrompt(ok.base, WF_UNET, "c1");
  check(res.prompt_id === "p1", "positive: models present → prompt is queued");
  check(ok.hits.includes("/prompt"), "positive: the POST actually happened");
  ok.server.close();

  // --- 2. NEGATIVE control: missing FILE -----------------------------------
  clearPreflightCache();
  const missFile = await mockComfy({
    UNETLoader: classicNode("unet_name", ["something-else.safetensors"]),
  });
  let err: unknown = null;
  try {
    await queuePrompt(missFile.base, WF_UNET, "c2");
  } catch (e) {
    err = e;
  }
  check(isModelPreflightError(err), "missing file: throws ModelPreflightError");
  const msg = err instanceof Error ? err.message : "";
  check(msg.includes("wanted.safetensors"), "missing file: message names the FILE");
  check(msg.includes(missFile.base), "missing file: message names the WORKER");
  check(msg.includes("models/unet"), "missing file: message names the SUBDIR");
  check(
    !missFile.hits.includes("/prompt"),
    "missing file: NOTHING was queued (proved from the mock's request log)",
  );
  missFile.server.close();

  // --- 3. NEGATIVE control: node not installed -----------------------------
  clearPreflightCache();
  const missNode = await mockComfy({}); // every class_type answers 200 {}
  let err2: unknown = null;
  try {
    await queuePrompt(missNode.base, WF_UNET, "c3");
  } catch (e) {
    err2 = e;
  }
  check(
    isModelPreflightError(err2),
    "missing node: throws (graph cannot run on this worker at all)",
  );
  check(
    (err2 instanceof Error ? err2.message : "").includes("not installed"),
    "missing node: message says the NODE TYPE is not installed",
  );
  check(!missNode.hits.includes("/prompt"), "missing node: NOTHING was queued");
  missNode.server.close();

  // --- 4. DEGRADATION control: unreachable probe → FAIL OPEN ---------------
  clearPreflightCache();
  const dead = await mockComfy({});
  const deadBase = dead.base;
  await new Promise<void>((r) => dead.server.close(() => r()));
  let threw = false;
  try {
    await queuePrompt(deadBase, WF_UNET, "c4");
  } catch (e) {
    // A connection-refused POST is the pre-existing failure surface; what must
    // NOT happen is the PREFLIGHT deciding to block on an unreachable probe.
    threw = isModelPreflightError(e);
  }
  check(!threw, "degradation: unreachable /object_info does NOT block (fail open)");

  const rep = await preflightWorkflow(deadBase, WF_UNET, 1500);
  check(
    rep.undeterminable.length === 1 && rep.ok,
    "degradation: unreachable probe is reported undeterminable, ok stays true",
  );

  // --- 5. kill switch ------------------------------------------------------
  clearPreflightCache();
  process.env.FRAMEFORGE_MODEL_PREFLIGHT = "off";
  const off = await mockComfy({});
  await queuePrompt(off.base, WF_UNET, "c5");
  check(
    !off.hits.some((h) => h.startsWith("/object_info/")),
    "kill switch: FRAMEFORGE_MODEL_PREFLIGHT=off probes nothing",
  );
  check(off.hits.includes("/prompt"), "kill switch: dispatch proceeds untouched");
  off.server.close();
  delete process.env.FRAMEFORGE_MODEL_PREFLIGHT;

  // --- 6. URL-encoding a spaced class_type --------------------------------
  clearPreflightCache();
  const spaced = await mockComfy({ "RIFE VFI": classicNode("ckpt_name", ["rife47.pth"]) });
  await queuePrompt(
    spaced.base,
    { "1": { class_type: "RIFE VFI", inputs: { ckpt_name: "rife47.pth" } } },
    "c6",
  );
  check(
    spaced.hits.some((h) => h === "/object_info/RIFE%20VFI"),
    "spaced class_type: probed as /object_info/RIFE%20VFI",
  );
  spaced.server.close();

  console.log(fail === 0 ? `\nALL CHECKS PASS` : `\n${fail} CHECK(S) FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
