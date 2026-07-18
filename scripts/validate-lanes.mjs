#!/usr/bin/env node
/**
 * validate-lanes.mjs — dependency-free consistency check between the lane
 * manifest (src/lib/lanes.ts) and the model catalog (src/lib/models.ts).
 *
 * Asserts:
 *   1. Every modelId / imageModelId / variants[].modelId named in lanes.ts
 *      exists as a profile id in VIDEO_MODEL_PROFILES (or is a documented
 *      LEGACY_MODEL_ALIASES key).
 *   2. Every laneKey in the LaneKey union appears exactly once in LANES.
 *
 * (tsc --noEmit already braces this at compile time via the VideoModelId
 * union, and lanes.ts throws at module load on a missing profile — this
 * script is the CI-friendly runtime suspenders, in the spirit of
 * src/workflows/validate-templates.mjs.)
 *
 * Usage: node scripts/validate-lanes.mjs   (exits non-zero on failure)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const modelsSrc = readFileSync(join(ROOT, "src/lib/models.ts"), "utf8");
const lanesSrc = readFileSync(join(ROOT, "src/lib/lanes.ts"), "utf8");

/** Slice src between a start marker and the next top-level `];` / `};`. */
function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`end marker not found after: ${startMarker}`);
  return src.slice(start, end);
}

// --- Known profile ids: VIDEO_MODEL_PROFILES entries + legacy alias keys ---
const profilesBlock = slice(modelsSrc, "export const VIDEO_MODEL_PROFILES", "\n];");
const profileIds = new Set(
  [...profilesBlock.matchAll(/^\s*id: "([a-z0-9.-]+)"/gm)].map((m) => m[1]),
);
const aliasBlock = slice(modelsSrc, "export const LEGACY_MODEL_ALIASES", "\n};");
const aliasIds = new Set(
  [...aliasBlock.matchAll(/^\s*"([a-z0-9.-]+)":/gm)].map((m) => m[1]),
);

// --- Ids referenced by the lane manifest ---
const lanesBlock = slice(lanesSrc, "export const LANES", "\n];");
const referenced = [
  ...lanesBlock.matchAll(/\b(?:modelId|imageModelId): "([a-z0-9.-]+)"/g),
].map((m) => m[1]);

// --- LaneKey union vs LANES entries ---
const laneKeyUnion = [
  ...slice(lanesSrc, "export type LaneKey", ";").matchAll(/"([A-Z0-9-]+)"/g),
].map((m) => m[1]);
const laneKeysInManifest = [
  ...lanesBlock.matchAll(/^\s*laneKey: "([A-Z0-9-]+)"/gm),
].map((m) => m[1]);

const errors = [];

if (profileIds.size === 0) errors.push("parsed 0 profile ids from models.ts");
if (referenced.length === 0) errors.push("parsed 0 modelId refs from lanes.ts");

for (const id of referenced) {
  if (!profileIds.has(id) && !aliasIds.has(id)) {
    errors.push(`lanes.ts references modelId "${id}" — not in VIDEO_MODEL_PROFILES or LEGACY_MODEL_ALIASES`);
  }
}
for (const key of laneKeyUnion) {
  const count = laneKeysInManifest.filter((k) => k === key).length;
  if (count !== 1) {
    errors.push(`LaneKey "${key}" appears ${count}x in LANES (expected exactly 1)`);
  }
}
for (const key of laneKeysInManifest) {
  if (!laneKeyUnion.includes(key)) {
    errors.push(`LANES entry "${key}" missing from the LaneKey union`);
  }
}

if (errors.length) {
  console.log("FAIL  lanes manifest:");
  for (const e of errors) console.log(`      - ${e}`);
  console.log("\nRESULT: FAIL");
  process.exit(1);
}

console.log(
  `PASS  lanes manifest: ${laneKeysInManifest.length} lanes, ` +
    `${referenced.length} model refs all present in models.ts ` +
    `(${profileIds.size} profiles, ${aliasIds.size} aliases)`,
);
console.log("\nRESULT: LANES MANIFEST PASSES");
