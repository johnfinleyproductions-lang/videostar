/* Ming-Image design lane: graph recipe, canvas clamps, job ids, worker gating.
 * Run: npx tsx scripts/ming-client.test.mts */
import {
  MING_FILES,
  MING_RGBA_PREFIX,
  buildMingWorkflow,
  isMingJobId,
  isMingModel,
  mingCanvas,
  resolveMingWorker,
} from "../src/lib/ming-client";

let fail = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.log("FAIL " + msg);
  } else console.log("pass " + msg);
}

type Node = { class_type: string; inputs: Record<string, unknown> };
const nodes = (wf: Record<string, unknown>) => Object.values(wf) as Node[];
const byClass = (wf: Record<string, unknown>, cls: string) => nodes(wf).filter((n) => n.class_type === cls);

// model + job id gates
check(isMingModel("ming-image-design"), "ming-image-design is the Ming model id");
check(!isMingModel("flux2-fast") && !isMingModel(undefined), "other models are not Ming");
check(isMingJobId("ming-abc123"), "ming- prefixed ids are Ming jobs");
check(!isMingJobId("ming-") && !isMingJobId("abc123") && !isMingJobId("lens-1-x"), "bare prefix / other ids are not");

// the proven recipe
const built = buildMingWorkflow({ prompt: "  A poster  ", width: 1664, height: 2496, seed: 7001 });
const wf = built.workflow;
check(byClass(wf, "UNETLoader")[0]?.inputs.unet_name === MING_FILES.unet, "bf16 Ming DiT");
check(byClass(wf, "CLIPLoader")[0]?.inputs.clip_name === MING_FILES.textEncoder, "int8 Ling text encoder");
check(byClass(wf, "VAELoader")[0]?.inputs.vae_name === MING_FILES.vae, "Ming 4-channel VAE");
const ms = byClass(wf, "ModelSamplingFlux")[0]?.inputs;
check(ms?.max_shift === 1.35 && ms?.base_shift === 0.5 && ms?.width === 1024 && ms?.height === 1024, "mu pinned at 1.35 (1024 token count)");
const sched = byClass(wf, "BasicScheduler")[0]?.inputs;
check(sched?.scheduler === "simple" && sched?.steps === 12, "simple / 12 steps by default");
check(byClass(wf, "KSamplerSelect")[0]?.inputs.sampler_name === "euler", "euler sampler");
check(byClass(wf, "BasicGuider").length === 1 && byClass(wf, "CFGGuider").length === 0, "guider-only, CFG 1, no negative");
check(byClass(wf, "RandomNoise")[0]?.inputs.noise_seed === 7001 && built.seed === 7001, "seed honored");
const lat = byClass(wf, "EmptyLatentImage")[0]?.inputs;
check(lat?.width === 1664 && lat?.height === 2496 && built.width === 1664 && built.height === 2496, "2:3 bucket kept exactly");
check(byClass(wf, "CLIPTextEncode")[0]?.inputs.text === "A poster", "prompt trimmed, no prefix when opaque");
check(byClass(wf, "SaveImage").length === 1, "one SaveImage (PNG keeps alpha)");

// every link points at a real node
const ids = new Set(Object.keys(wf));
let dangling = 0;
for (const n of nodes(wf)) for (const v of Object.values(n.inputs)) if (Array.isArray(v) && typeof v[0] === "string" && !ids.has(v[0])) dangling++;
check(dangling === 0, "no dangling links");

// transparency prefix
const rgba = buildMingWorkflow({ prompt: "A badge", transparent: true });
check(
  (byClass(rgba.workflow, "CLIPTextEncode")[0]?.inputs.text as string) === `${MING_RGBA_PREFIX}\nA badge`,
  "transparent=true prepends the single fixed RGBA phrase",
);

// canvas rules
const c1 = mingCanvas(undefined, undefined);
check(c1.width === 2048 && c1.height === 2048, "defaults to 2048x2048");
const c2 = mingCanvas(1000, 100);
check(c2.width / c2.height <= 4.01, `aspect clamped to 4:1 (${c2.width}x${c2.height})`);
const c3 = mingCanvas(4000, 4000);
check(c3.width * c3.height <= 4_600_000 && c3.width <= 2560, `area capped (${c3.width}x${c3.height})`);
const c4 = mingCanvas(1001, 777);
check(c4.width % 16 === 0 && c4.height % 16 === 0, `16 px grid (${c4.width}x${c4.height})`);
const steps = buildMingWorkflow({ prompt: "x", steps: 99 }).steps;
check(steps === 30, "steps clamped to 30");

// worker gating (fleet reads env per call)
delete process.env.MING_COMFYUI_URL;
check(resolveMingWorker() === null, "no MING_COMFYUI_URL -> worker disabled (route 503s)");
process.env.MING_COMFYUI_URL = "http://192.168.4.180:8198/";
const w = resolveMingWorker();
check(w?.name === "framerstation-ming" && w?.comfyBase === "http://192.168.4.180:8198", "MING_COMFYUI_URL enables framerstation-ming (exclusive)");

console.log(fail ? `\nRESULT: ${fail} FAILURES` : "\nRESULT: MING CLIENT PASSES");
process.exit(fail ? 1 : 0);
