/**
 * Adversarial-verify smoke for Lane 13 FOLEY: builds the graph through the
 * REAL buildFoley (no hand-patching), queues it on live ComfyUI, waits, and
 * reports the output file. Run: npx tsx scripts/foley-smoke.mts
 *
 * Source: FrameForge/ltx23_master_00002_.mp4 (the golden wave, 5.04s @ 24fps,
 * HAS an aac source track — the output must REPLACE it with generated foley).
 * Prompt deliberately EMPTY: exercises the silent-auto path (the pack's
 * "footsteps on frozen ice" widget default must never leak).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFoley, foleyFrameCap, FOLEY_MAX_SECONDS } from "../src/lib/workflow-builder";

const COMFY = "http://192.168.4.196:8188";

const template = JSON.parse(
  readFileSync(join(import.meta.dirname, "../src/workflows/hunyuan_foley.json"), "utf8"),
);

// 5.04s @ 24fps (probed) → cap 121 frames = the whole clip.
const frameCap = foleyFrameCap(5.042, 24);
console.log("frameCap:", frameCap, "| max-seconds sanity:", foleyFrameCap(999, 24), "==", FOLEY_MAX_SECONDS * 24);

const { prompt, extra_data } = buildFoley({
  template,
  videoName: "FrameForge/ltx23_master_00002_.mp4 [output]",
  prompt: "",
  seed: 20260716,
  frameCap,
});
console.log("extra_data:", JSON.stringify(extra_data));

const foleyNode: any = Object.values(prompt).find((n: any) => n._meta?.title === "FF Foley");
console.log("sampler prompt after patch:", JSON.stringify(foleyNode.inputs.prompt), "| neg:", JSON.stringify(foleyNode.inputs.negative_prompt), "| seed:", foleyNode.inputs.seed);
const loadNode: any = Object.values(prompt).find((n: any) => n._meta?.title === "FF Load");
console.log("load:", JSON.stringify({ video: loadNode.inputs.video, frame_load_cap: loadNode.inputs.frame_load_cap, force_rate: loadNode.inputs.force_rate }));

const res = await fetch(`${COMFY}/prompt`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt, client_id: "foley-verify" }),
});
const body = await res.json();
console.log("queue status:", res.status, JSON.stringify(body).slice(0, 600));
if (!res.ok) process.exit(1);
const pid = body.prompt_id;
console.log("prompt_id:", pid);

for (let i = 0; i < 480; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const h = await (await fetch(`${COMFY}/history/${pid}`)).json();
  const item = h[pid];
  if (item?.status?.completed || item?.status?.status_str === "error") {
    console.log("status:", JSON.stringify(item.status.status_str));
    if (item.status.status_str === "error") {
      console.log(JSON.stringify(item.status, null, 2).slice(0, 5000));
      process.exit(1);
    }
    for (const [nid, out] of Object.entries<any>(item.outputs)) {
      for (const key of ["gifs", "videos", "audio"]) {
        if (out[key]) for (const g of out[key]) console.log(`OUTPUT[${key}]:`, nid, JSON.stringify(g));
      }
    }
    process.exit(0);
  }
  if (i % 6 === 0) console.log("waiting...", i * 10, "s");
}
console.error("TIMEOUT");
process.exit(2);
