/* LIVE evidence for the model preflight (ticket comfy-workflow-model-preflight).
 *
 * Runs the SHIPPED module — no reimplementation — against:
 *   A. a live ComfyUI (PREFLIGHT_LIVE_BASE, default the LAN-reachable vidbox
 *      :8188) using real lane workflows off disk;
 *   B. captured /object_info payloads from the loopback-only workers
 *      (:8190 sidecar, :8193 gm), replayed through a local server so the real
 *      module produces real verdicts on real worker data. Those two boxes are
 *      not reachable off-box by design, so this is REPLAY of live data and is
 *      labelled as such — it is not an on-box dispatch test.
 *
 * Usage:
 *   npx tsx scripts/model-preflight-live.mts [captured.json ...]
 * where each captured file is `{ "<ClassType>": <object_info payload>, ... }`
 * named <something>-<port>.json.
 */
import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  clearPreflightCache,
  extractModelRefs,
  preflightWorkflow,
} from "../src/lib/model-preflight";

const LIVE_BASE =
  process.env.PREFLIGHT_LIVE_BASE ?? "http://192.168.4.196:8188";
const WF_DIR = resolve(import.meta.dirname, "../src/workflows");

function lanes(): { name: string; graph: unknown }[] {
  return readdirSync(WF_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      name: f,
      graph: JSON.parse(readFileSync(resolve(WF_DIR, f), "utf8")) as unknown,
    }));
}

/** Replay a captured /object_info map as a local ComfyUI. */
function replay(captured: Record<string, unknown>): Promise<{ server: Server; base: string }> {
  return new Promise((r) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/object_info/")) {
        const ct = decodeURIComponent(url.slice("/object_info/".length));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(ct in captured ? { [ct]: captured[ct] } : {}));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      r({ server, base: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}` });
    });
  });
}

async function report(label: string, base: string) {
  let refs = 0, present = 0, missFile = 0, missNode = 0, unk = 0;
  const detail: string[] = [];
  for (const lane of lanes()) {
    clearPreflightCache();
    const r = await preflightWorkflow(base, lane.graph, 15000);
    refs += r.checked.length;
    present += r.checked.filter((c) => c.verdict === "present").length;
    missFile += r.missingFiles.length;
    missNode += r.missingNodes.length;
    unk += r.undeterminable.length;
    for (const m of r.missingFiles) {
      detail.push(`    ${lane.name}: MISSING FILE ${m.file} (${m.classType}.${m.field})`);
    }
    for (const n of [...new Set(r.missingNodes.map((m) => m.classType))]) {
      detail.push(`    ${lane.name}: NODE NOT INSTALLED ${n}`);
    }
  }
  console.log(
    `${label}\n  refs=${refs} present=${present} missing_file=${missFile} ` +
      `node_missing=${missNode} undeterminable=${unk}`,
  );
  if (detail.length) console.log(detail.join("\n"));
  return { refs, present, missFile, missNode, unk };
}

async function main() {
  console.log(`lanes on disk: ${lanes().length}\n`);

  console.log("=== A. LIVE worker (real HTTP, real ComfyUI) ===");
  const live = await report(`  ${LIVE_BASE}`, LIVE_BASE);

  console.log("\n=== A2. LIVE negative control: inject a model that cannot exist ===");
  clearPreflightCache();
  const real = lanes().find((l) => extractModelRefs(l.graph).length > 0);
  if (!real) throw new Error("no lane with model refs");
  const graph = JSON.parse(JSON.stringify(real.graph)) as Record<string, Record<string, Record<string, unknown>>>;
  const ref = extractModelRefs(real.graph)[0];
  graph[ref.nodeId].inputs[ref.field] = "definitely-not-a-real-model-xyz.safetensors";
  const neg = await preflightWorkflow(LIVE_BASE, graph, 15000);
  console.log(`  lane ${real.name}, patched ${ref.classType}.${ref.field}`);
  console.log(`  ok=${neg.ok} missing_file=${neg.missingFiles.length}`);
  for (const m of neg.missingFiles) console.log(`    -> ${m.file}`);

  for (const file of process.argv.slice(2)) {
    const port = basename(file).replace(/\D+/g, "") || "?";
    const captured = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const { server, base } = await replay(captured);
    console.log(`\n=== B. REPLAY of captured live :${port} payloads (loopback-only worker) ===`);
    await report(`  captured :${port}`, base);
    server.close();
  }

  console.log(
    `\nSUMMARY: live ${LIVE_BASE} → ${live.missFile} missing file(s), ` +
      `${live.missNode} missing node(s), ${live.unk} undeterminable.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
