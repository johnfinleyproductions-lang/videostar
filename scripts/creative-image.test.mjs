// Run: node --test scripts/creative-image.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function compile(file, mocks = {}, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => name in mocks ? mocks[name] : require(name), process, console, URL, URLSearchParams, Headers, ...globals });
  return exports;
}
const builder = compile('src/lib/flux-workflow-builder.ts');
const enumReader = compile('src/lib/model-preflight.ts', { './comfy-auth': {} });
function client(fetch) {
  return compile('src/lib/flux-client.ts', {
    './comfy-auth': { comfyFetch: fetch, isPrivateHistory: () => false },
    './fleet': { getWorkerComfyBase: () => 'http://vidbox:8188', resolveWorkerForLane: () => [{ comfyBase: 'http://frame:8188' }] },
    './flux-workflow-builder': builder, './model-preflight': enumReader,
  });
}
test('FLUX 3 uses its native encoder, prompt expansion, shifted 128-channel sampling and separate VAE', () => {
  const w = builder.buildFluxWorkflow({ model: 'flux3-klein', prompt: 'A sign reading EVERGREEN', width: 1280, height: 720, seed: 42 });
  assert.equal(w['1'].inputs.unet_name, builder.CREATIVE_IMAGE_FILES.flux);
  assert.equal(w['2'].inputs.type, 'flux3');
  assert.equal(w['10'].inputs.clip_name, builder.CREATIVE_IMAGE_FILES.upsampler);
  assert.equal(w['11'].inputs['sampling_mode.seed'], 42);
  assert.match(w['11'].inputs.prompt, /^TARGET CANVAS: 1280:720/);
  assert.equal(w['12'].inputs.base_shift, Math.log(16));
  assert.equal(w['3'].inputs.vae_name, 'flux3/flux2-vae.safetensors');
  assert.equal(w['6'].class_type, 'EmptyFlux2LatentImage');
  assert.equal(w['6'].inputs.height, 720);
  assert.equal(w['7'].inputs.steps, 16);
  assert.equal(w['7'].inputs.cfg, 1);
});
test('MOSS uses the local HF loader and official shift, skip-layer and Euler/SGM recipe', () => {
  const w = builder.buildFluxWorkflow({ model: 'moss-image-sft', prompt: 'A bilingual poster' });
  assert.equal(w['1'].class_type, 'MOSSImageHFLoader');
  assert.equal(w['12'].inputs.shift, 5);
  assert.equal(w['13'].inputs.single_layers, '22');
  assert.equal(w['7'].inputs.steps, 50);
  assert.equal(w['7'].inputs.cfg, 3);
  assert.equal(w['7'].inputs.scheduler, 'sgm_uniform');
  assert.deepEqual(Array.from(w['8'].inputs.vae), ['1', 2]);
  for (const n of Object.values(w)) for (const v of Object.values(n.inputs)) if (Array.isArray(v)) assert.ok(w[v[0]], `link ${v[0]} exists`);
});
test('new text-only profiles refuse references; old Flux 2 still uses its existing recipe', () => {
  assert.throws(() => builder.buildFluxWorkflow({ model: 'flux3-klein', prompt: 'x', referenceImage: 'x.png' }), /text prompts only/);
  const old = builder.buildFluxWorkflow({ model: 'flux2-fast', prompt: 'x' });
  assert.equal(old['1'].class_type, 'UnetLoaderGGUF');
  assert.equal(old['3'].inputs.vae_name, 'flux2-vae.safetensors');
});
test('creative jobs stay on Vidbox while legacy stills keep their fleet and override behavior', () => {
  const c = client();
  assert.equal(c.resolveFluxComfyBase('flux3-klein'), 'http://vidbox:8188');
  assert.equal(c.resolveFluxComfyBase('moss-image-sft'), 'http://vidbox:8188');
  assert.equal(c.resolveFluxComfyBase(), process.env.FLUX_COMFYUI_URL || 'http://frame:8188');
  const id = 'vidbox-image-c737f732-0424-491f-b407-47f51ab59bf6';
  assert.ok(c.isCreativeImageJob(id));
  assert.ok(!c.isCreativeImageJob('vidbox-image-../../x'));
  const url = new URL(c.fluxOutputUrl('http://vidbox:8188', 'proof.png', '', 'vidbox'), 'http://local');
  assert.equal(url.searchParams.get('worker'), 'vidbox');
  assert.equal(url.searchParams.get('stills'), null);
});
test('preflight rejects old FLUX runtimes, missing upsamplers and incomplete MOSS directories', async () => {
  const nodes = Object.fromEntries(['CLIPTextEncode','EmptyFlux2LatentImage','KSampler','VAEDecode','SaveImage','UNETLoader','CLIPLoader','VAELoader','TextGenerate','ModelSamplingFlux','MOSSImageHFLoader','ModelSamplingSD3','SkipLayerGuidanceDiTSimple'].map(n => [n, {}]));
  nodes.UNETLoader = { input: { required: { unet_name: [[builder.CREATIVE_IMAGE_FILES.flux]] } } };
  nodes.CLIPLoader = { input: { required: { clip_name: ['COMBO', { options: [builder.CREATIVE_IMAGE_FILES.encoder, builder.CREATIVE_IMAGE_FILES.upsampler] }], type: [['flux3']] } } };
  nodes.VAELoader = { input: { required: { vae_name: [[builder.CREATIVE_IMAGE_FILES.vae]] } } };
  nodes.DiffusersLoader = { input: { required: { model_path: [["MOSS-Image-SFT"]] } } };
  const fetch = async () => ({ ok: true, json: async () => nodes });
  assert.equal((await client(fetch).getFluxPreflight('http://vidbox:8188', 'flux3-klein')).ok, true);
  nodes.CLIPLoader.input.required.type = [['flux2']];
  assert.equal((await client(fetch).getFluxPreflight('http://vidbox:8188', 'flux3-klein')).ok, false);
  nodes.CLIPLoader.input.required.clip_name[1].options.pop();
  assert.match((await client(fetch).getFluxPreflight('http://vidbox:8188', 'flux3-klein')).missing.join(), /upsampler/);
  assert.equal((await client(fetch).getFluxPreflight('http://vidbox:8188', 'moss-image-sft')).ok, true);
  nodes.DiffusersLoader.input.required.model_path = [[]];
  assert.equal((await client(fetch).getFluxPreflight('http://vidbox:8188', 'moss-image-sft')).ok, false);
});
