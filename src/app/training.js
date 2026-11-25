// Training mode: the reader's corrections to automatically placed bony landmarks, kept in this browser only
// (localStorage), used to adapt the learned landmark model, and exportable as a file that
// test/corpus/merge-training.mjs folds into the model shipped with the app.
//
// A record holds no image and nothing identifying: the landmark, the implant type, its corrected position in the
// implant's own frame (units of the glenosphere / head radius) and a small normalised appearance patch at that spot.
import { frames as learnedFrames, toFrame, patch, adapt } from '../detect/learned.js';
import MODEL from '../detect/model.json' with { type: 'json' };

const KEY = 'rsa-check-training-v1';
const MAX = 2000;

function read() {
  try { const t = JSON.parse(localStorage.getItem(KEY) || '{}'); return { on: !!t.on, rec: Array.isArray(t.rec) ? t.rec : [] }; } catch { return { on: false, rec: [] }; }
}
let T = read();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(T)); } catch { /* storage full or blocked: in memory only */ } };

export const isOn = () => T.on;
export function setOn(v) { T.on = !!v; save(); }
export const count = (type) => (type ? T.rec.filter((r) => r.type === type).length : T.rec.length);

export const kindOf = (pid) => (pid === 'rsa-ap' ? 'reverse' : pid === 'pyc-ap' ? 'hemi' : pid === 'native-ap' ? 'native' : null);

/** Implant frames from the current landmark values (the same construction the detector uses). */
export function framesFor(kind, values, lateralSign) {
  const c = kind === 'reverse' ? values.gs : values.head;
  if (!c || !(c.r > 0)) return null;
  const A = (q) => [q.x, q.y];
  const st = values.stem ? [A(values.stem.a), A(values.stem.b)].sort((u, v) => u[1] - v[1]) : null;
  const face = kind === 'reverse' && values.face ? { a: A(values.face.a), b: A(values.face.b) } : null;
  return learnedFrames({ centre: [c.cx, c.cy], r: c.r, face, stem: st ? { a: st[0], b: st[1] } : null }, lateralSign);
}

/** The model for a type with this reader's corrections folded in (the shipped model when there are none). */
export function modelFor(kind) {
  const m = MODEL.types && MODEL.types[kind];
  if (!m || !T.rec.length) return m;
  return adapt(m, T.rec, kind);
}

/** Landmarks of a type whose placement this reader's corrections change. */
export function adaptedIds(kind) {
  const m = modelFor(kind);
  return new Set(m && m.landmarks ? Object.entries(m.landmarks).filter(([, l]) => l.adapted).map(([id]) => id) : []);
}

/**
 * Record (or replace) the correction of one landmark on one film. Returns true when recorded. Only landmarks the
 * learned model knows, and only point landmarks.
 */
export function record(film, kind, id, pt, values, lateralSign, image) {
  if (!T.on) return false;
  const m = MODEL.types && MODEL.types[kind] && MODEL.types[kind].landmarks[id];
  if (!m || !pt) return false;
  const F = framesFor(kind, values, lateralSign);
  const Fr = F && F[m.frame];
  if (!Fr) return false;
  const q = toFrame(Fr, [pt.x, pt.y]).map((v) => Math.round(v * 1000) / 1000);
  let p = null;
  if (m.patch && image) {
    const v = patch({ width: image.width, height: image.height, data: image.data }, Fr, q, m.patch.N, m.patch.half);
    if (v) p = Array.from(v, (x) => Math.round(x * 1000) / 1000);
  }
  T.rec = T.rec.filter((r) => !(r.film === film && r.id === id));
  T.rec.push({ film, type: kind, id, frame: m.frame, q, patch: p, t: Date.now() });
  if (T.rec.length > MAX) T.rec = T.rec.slice(-MAX);
  save();
  return true;
}

export function clear() { T.rec = []; save(); }

/** Export file: records without the per-film keys (which only serve to replace a repeated correction). */
export function exportText() {
  return JSON.stringify({ app: 'rsa-check', kind: 'landmark-corrections', version: 1, model: MODEL.version || null, records: T.rec.map(({ film, ...r }) => r) }, null, 0);
}

export function importText(text) {
  const j = JSON.parse(text);
  if (!j || j.kind !== 'landmark-corrections' || !Array.isArray(j.records)) throw new Error('Not an RSA Check training file.');
  let n = 0;
  for (const r of j.records) {
    if (!r || typeof r.id !== 'string' || !Array.isArray(r.q) || r.q.length !== 2 || !r.q.every(Number.isFinite)) continue;
    T.rec.push({ film: `import-${Date.now()}-${n}`, type: r.type, id: r.id, frame: r.frame, q: r.q, patch: Array.isArray(r.patch) ? r.patch : null, t: r.t || Date.now() });
    n++;
  }
  if (T.rec.length > MAX) T.rec = T.rec.slice(-MAX);
  save();
  return n;
}
