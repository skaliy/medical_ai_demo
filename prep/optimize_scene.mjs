// Post-process app/assets/brain_tumor.glb written by prepare_assets.py.
//
//   npm install @gltf-transform/core@4 @gltf-transform/functions@4 @gltf-transform/extensions@4 meshoptimizer
//   node prep/optimize_scene.mjs app/assets/brain_tumor.glb app/assets/brain_tumor.glb
//
// Welds vertices, simplifies the HEAD mesh only (the tumor carries the measurement
// and keeps every triangle), quantizes positions with KHR_mesh_quantization (decoded
// natively by <model-viewer>, no runtime decoder, fully offline), and adds what
// trimesh cannot express: the unlit extension on the MRI slice plane. Colours,
// translucency and roughness are authored in prepare_assets.py only.
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { weld, simplifyPrimitive, quantize, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import fs from 'node:fs';

const [, , src, dst, ratioArg] = process.argv;
if (!src || !dst) { console.error('usage: node optimize_scene.mjs <in.glb> <out.glb> [head-ratio=0.25]'); process.exit(1); }
const ratio = Number(ratioArg || 0.25);

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
const doc = await io.read(src);
const root = doc.getRoot();
const byName = (n) => root.listMeshes().find((m) => m.getName() === n);
const head = byName('brain'), tumor = byName('tumor'), slice = byName('slice');
if (!head || !tumor || !slice) throw new Error('expected meshes named brain, tumor and slice');
const tris = (m) => m.listPrimitives()[0].getIndices().getCount() / 3;
const headBefore = tris(head), tumorBefore = tris(tumor);

await MeshoptSimplifier.ready;
await doc.transform(weld());
for (const p of head.listPrimitives()) simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio, error: 0.001 });
await doc.transform(quantize({ quantizePosition: 14, quantizeTexcoord: 12 }), prune());

for (const p of head.listPrimitives()) {
  // Colour, alpha and roughness come from prepare_assets.py; BLEND is re-asserted
  // as a safety net because an OPAQUE head would hide the tumor entirely.
  p.getMaterial().setName('head').setAlphaMode('BLEND').setDoubleSided(false);
}
tumor.listPrimitives()[0].getMaterial().setName('tumor');
const unlit = doc.createExtension(KHRMaterialsUnlit);
for (const p of slice.listPrimitives()) {
  p.getMaterial().setName('slice').setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true)
    .setExtension('KHR_materials_unlit', unlit.createUnlit());
}
await io.write(dst, doc);
if (tris(tumor) !== tumorBefore) throw new Error('tumor mesh changed');
console.log(`head ${headBefore} -> ${tris(head)} triangles, tumor ${tris(tumor)} unchanged, ` +
  `${(fs.statSync(src).size / 1e6).toFixed(2)} MB -> ${(fs.statSync(dst).size / 1e6).toFixed(2)} MB`);
