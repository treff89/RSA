// Fold training-mode exports (rsa-check-training.json from the app's Landmarks tab) into the shipped landmark
// model:  node test/corpus/merge-training.mjs <export.json>… [--weight 3] [--dry]
// Each correction counts --weight times one annotated corpus film (see adapt() in src/detect/learned.js).
import fs from 'node:fs';
import { adapt } from '../../src/detect/learned.js';

const args = process.argv.slice(2);
const wi = args.indexOf('--weight');
const weight = wi >= 0 ? Number(args.splice(wi, 2)[1]) : 3;
const dry = args.includes('--dry');
const files = args.filter((a) => a !== '--dry');
if (!files.length) { console.error('usage: node test/corpus/merge-training.mjs <export.json>… [--weight 3] [--dry]'); process.exit(1); }
const path = new URL('../../src/detect/model.json', import.meta.url);
const model = JSON.parse(fs.readFileSync(path, 'utf8'));
const rec = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (j.kind !== 'landmark-corrections' || !Array.isArray(j.records)) throw new Error(`${f}: not an RSA Check training export`);
  rec.push(...j.records);
}
for (const [type, m] of Object.entries(model.types)) {
  const a = adapt(m, rec, type, weight);
  for (const [id, l] of Object.entries(a.landmarks)) {
    if (!l.adapted) continue;
    const o = m.landmarks[id];
    console.log(`${type} ${id}: ${l.adapted} corrections; q ${o.q.map((v) => v.toFixed(3))} → ${l.q.map((v) => v.toFixed(3))}${o.method !== l.method ? `; ${o.method} → ${l.method}` : ''}`);
    delete l.adapted;
  }
  model.types[type] = a;
}
model.note = `${model.note || ''}${model.note ? ' ' : ''}Merged ${rec.length} reader corrections (${new Date().toISOString().slice(0, 10)}).`;
if (!dry) fs.writeFileSync(path, JSON.stringify(model));
console.log(dry ? 'dry run: model.json not changed' : 'model.json updated');
