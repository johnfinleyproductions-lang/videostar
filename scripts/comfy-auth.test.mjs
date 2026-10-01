import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = mkdtempSync(path.join(os.tmpdir(), "comfy-auth-test-"));
const token = randomBytes(32).toString("hex"), keyFile = path.join(root, "key");
writeFileSync(keyFile, token, { mode: 0o600 });
const source = readFileSync(new URL("../src/lib/comfy-auth.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {}, calls = [], testProcess = { platform: process.platform, getuid: process.getuid, env: {
  EVERGREEN_PRIVATE_IMAGE_KEY_FILE: keyFile, EVERGREEN_PRIVATE_COMFY_ORIGIN: "http://configured.test:8188",
} };
vm.runInNewContext(compiled, { exports, Headers, URL, process: testProcess, require: createRequire(import.meta.url),
  fetch: async (url, init) => { calls.push({ url, init }); return Response.json({ ok: true }); } });
try {
  const header = await exports.comfyHeaders("http://configured.test:8188/object_info");
  assert.equal(header.Authorization, `Bearer ${token}`);
  assert.equal((await exports.comfyHeaders("ws://configured.test:8188/ws")).Authorization, `Bearer ${token}`);
  for (const raw of ["http://configured.test:8189", "http://untrusted.test:8188", "http://user@configured.test:8188", "https://configured.test:8188"]) {
    assert.equal(Object.keys(await exports.comfyHeaders(raw)).length, 0);
  }
  await exports.comfyFetch("http://configured.test:8188/prompt", { headers: { "Content-Type": "application/json" } });
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.get("Authorization"), `Bearer ${token}`);
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/json");
  assert.equal(exports.isPrivateHistory({ prompt: [0, "id", { "9": { class_type: "EvergreenPrivateOutput" } }] }), true);
  assert.equal(exports.isPrivateHistory({ prompt: [0, "id", { "9": { class_type: "SaveImage" } }] }), false);
  chmodSync(keyFile, 0o644);
  await assert.rejects(exports.comfyHeaders("http://configured.test:8188"), /credential is unavailable/);
  testProcess.env = {};
  assert.equal(Object.keys(await exports.comfyHeaders("http://configured.test:8188")).length, 0);
  console.log("Comfy origin credentials, redirect refusal, private history and missing-key checks passed");
} finally { rmSync(root, { recursive: true, force: true }); }
