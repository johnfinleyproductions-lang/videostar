/* Adversarial lane-resolution matrix: every laneKey x {image, no image}
 * through the exact functions the generate route uses. */
import { LANES, getLane, resolveLaneModelId } from "../src/lib/lanes";
import { resolveVideoModelId, getVideoModelProfile } from "../src/lib/models";

let fail = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.log("FAIL " + msg);
  } else console.log("pass " + msg);
}

// case-insensitive lookup
check(getLane("hv-humans")?.laneKey === "HV-HUMANS", "getLane is case-insensitive");
check(getLane("  wan-cine ")?.laneKey === "WAN-CINE", "getLane trims");
check(getLane("NOPE") === undefined, "unknown laneKey -> undefined (route 400s)");

for (const lane of LANES) {
  for (const hasImage of [false, true]) {
    const resolved = resolveLaneModelId(lane, hasImage);
    if (resolved === null) {
      check(
        lane.laneKey === "FINISH-STACK",
        `${lane.laneKey} img=${hasImage}: null only for the descriptor lane`,
      );
      continue;
    }
    // then through the route's routing rule
    const finalId = resolveVideoModelId(resolved, hasImage);
    const profile = getVideoModelProfile(finalId);
    console.log(
      `     ${lane.laneKey} img=${hasImage} -> lane:${resolved} -> final:${finalId} (kind=${profile.kind})`,
    );
    // invariants
    if (lane.laneKey === "HV-HUMANS") {
      check(
        finalId === (hasImage ? "hv15-i2v" : "hv15-t2v"),
        `HV-HUMANS img=${hasImage} resolves to ${hasImage ? "hv15-i2v" : "hv15-t2v"}`,
      );
    }
    if (lane.laneKey === "WAN-CINE" || lane.laneKey === "WAN-CAMERA") {
      if (hasImage)
        check(profile.kind === "wan-i2v", `${lane.laneKey}+image stays wan-i2v`);
      else
        check(
          finalId === "ltx23-flash",
          `${lane.laneKey} w/o image falls back to text default (documented)`,
        );
    }
    if (lane.laneKey === "MG-ALPHA") {
      check(
        finalId === "wan-alpha-rgba",
        `MG-ALPHA img=${hasImage} never rerouted off wan-alpha`,
      );
    }
    if (lane.laneKey === "MATTE") {
      // A stray image must never swap the alpha-webm transform for an opaque
      // Wan I2V mp4 (the "matte" kind is exempt in resolveVideoModelId).
      check(
        finalId === "matanyone-matte",
        `MATTE img=${hasImage} never rerouted off matanyone-matte`,
      );
    }
    if (lane.laneKey === "MG-TYPE") {
      // A stray image must never swap the think-rendered motion-graphics
      // deliverable for a generated Wan I2V mp4 (the "remotion" kind is
      // exempt in resolveVideoModelId, same contract as "matte"/"audio").
      check(
        finalId === "mg-type",
        `MG-TYPE img=${hasImage} never rerouted off mg-type`,
      );
    }
    if (lane.laneKey === "FOLEY") {
      // A stray image must never swap the scored-footage transform for a
      // generated Wan I2V mp4 (the "foley" kind is exempt in
      // resolveVideoModelId, same contract as "matte"/"audio").
      check(
        finalId === "foley-sfx",
        `FOLEY img=${hasImage} never rerouted off foley-sfx`,
      );
    }
    // a lane pick must never land on a profile that then requires an image it lacks
    check(
      !(profile.requiresImage && !hasImage),
      `${lane.laneKey} img=${hasImage}: final profile never demands a missing image`,
    );
  }
}

// explicit model beats laneKey is route logic (requestedModel short-circuit) — assert manifest agreement instead:
for (const lane of LANES) {
  if (lane.modelId) {
    check(
      getVideoModelProfile(lane.modelId).id === lane.modelId,
      `${lane.laneKey}.modelId ${lane.modelId} is a real profile`,
    );
  }
  if (lane.imageModelId) {
    check(
      getVideoModelProfile(lane.imageModelId).id === lane.imageModelId,
      `${lane.laneKey}.imageModelId ${lane.imageModelId} is a real profile`,
    );
  }
  for (const v of lane.variants ?? []) {
    check(
      getVideoModelProfile(v.modelId).id === v.modelId,
      `${lane.laneKey} variant ${v.modelId} is a real profile`,
    );
  }
}

console.log(fail ? `\nRESULT: ${fail} FAILURES` : "\nRESULT: MATRIX PASSES");
process.exit(fail ? 1 : 0);
