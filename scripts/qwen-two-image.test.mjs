import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/flux-workflow-builder.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports });
const graph = (referenceImage, referenceImage2) => exports.buildFluxWorkflow({
  model: "qwen-image-edit", prompt: "Replace the selected face", width: 768,
  height: 768, seed: 42, referenceImage, referenceImage2,
});

const single = graph("source.png");
assert.deepEqual(Array.from(single["4"].inputs.image1), ["10", 0]);
assert.equal(single["4"].inputs.image2, undefined);
assert.deepEqual(Array.from(single["5"].inputs.image1), ["10", 0]);
assert.equal(single["5"].inputs.image2, undefined);
assert.deepEqual(Array.from(single["6"].inputs.pixels), ["10", 0]);
assert.equal(single["14"].class_type, "CFGNorm");
assert.equal(single["14"].inputs.strength, 1);
assert.deepEqual(Array.from(single["7"].inputs.model), ["14", 0]);

const dual = graph("source.png", "person.png");
assert.equal(dual["11"].class_type, "LoadImage");
assert.equal(dual["11"].inputs.image, "person.png");
assert.deepEqual(Array.from(dual["4"].inputs.image1), ["10", 0]);
assert.deepEqual(Array.from(dual["4"].inputs.image2), ["11", 0]);
assert.deepEqual(Array.from(dual["5"].inputs.image1), ["10", 0]);
assert.deepEqual(Array.from(dual["5"].inputs.image2), ["11", 0]);
assert.deepEqual(Array.from(dual["6"].inputs.pixels), ["10", 0]);
assert.throws(() => graph(undefined, "person.png"), /requires a source image/);
const textOnly = graph();
assert.equal(textOnly["4"].inputs.image1, undefined);
assert.equal(textOnly["5"].inputs.image1, undefined);
assert.equal(textOnly["6"].class_type, "EmptySD3LatentImage");

console.log("Qwen single and two-image graphs passed");
