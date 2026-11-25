// Build-time merge of reader corrections (training/*.json, exported from the app's training mode) into the
// learned landmark model. Used by build.mjs; strict validation, because these files are data from outside the code.
import { adapt } from './learned.js';

const TYPES = new Set(['reverse', 'hemi', 'native']);
const FRAMES = new Set(['scap', 'hum']);

/** Records from one export file that pass validation (anything malformed is dropped, not repaired). */
export function validRecords(j) {
  if (!j || j.kind !== 'landmark-corrections' || !Array.isArray(j.records)) return [];
  const ok = [];
  for (const r of j.records) {
    if (!r || !TYPES.has(r.type) || !FRAMES.has(r.frame) || typeof r.id !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(r.id)) continue;
    if (!Array.isArray(r.q) || r.q.length !== 2 || !r.q.every((v) => Number.isFinite(v) && Math.abs(v) < 10)) continue;
    const patch = Array.isArray(r.patch) && r.patch.length <= 2000 && r.patch.every((v) => Number.isFinite(v) && Math.abs(v) < 50) ? r.patch : null;
    ok.push({ type: r.type, id: r.id, frame: r.frame, q: r.q, patch, t: Number.isFinite(r.t) ? r.t : 0 });
  }
  return ok;
}

/** The model with all records folded in; `merged` lists their keys so the app does not count them twice. */
export function mergeModel(model, records, weight = 3) {
  if (!records.length) return model;
  const out = { ...model, types: { ...model.types } };
  for (const type of Object.keys(out.types)) {
    const a = adapt(out.types[type], records, type, weight);
    for (const l of Object.values(a.landmarks || {})) delete l.adapted;
    out.types[type] = a;
  }
  out.merged = records.map((r) => `${r.type}:${r.id}:${r.t}`);
  return out;
}
