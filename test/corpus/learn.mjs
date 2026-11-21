// Learn the bony-landmark model (src/detect/model.json) from annotated radiographs.
//   node test/corpus/learn.mjs <annot-dir> [out=src/detect/model.json] [--frames <results.jsonl from eval.mjs>]
// With --frames, landmark positions are learned relative to the implant as the detector found it (where it found
// it correctly), so systematic differences between detector and annotator conventions are absorbed.
// Annotation files follow the corpus annotation spec ({ id, file, implant, landmarks: {...} }). For every landmark
// the learner measures, by leave-one-out over the annotated films, how well each placement method does — learned
// position ('prior'), template search ('template'), bony-outline extreme ('outline') — and keeps the best. Images are
// read with the same decoding and overlay removal as the app. The model stores positions, spreads and averaged
// local-appearance templates only; no image is stored.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grayWithoutOverlay } from '../../src/detect/overlay.js';
import { frames, toFrame, patch, intensitySpan, outlineExtreme, templateSearch } from '../../src/detect/learned.js';
import { nativeLandmarks } from '../../src/detect/auto.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const fi = argv.indexOf('--frames');
const framesFile = fi >= 0 ? argv[fi + 1] : null;
if (fi >= 0) argv.splice(fi, 2);
const [annotDir, outArg] = argv;
const detected = framesFile ? Object.fromEntries(readFileSync(framesFile, 'utf8').trim().split('\n').map((l) => { const r = JSON.parse(l); return [r.id, r]; })) : null;
if (!annotDir) { console.error('usage: node test/corpus/learn.mjs <annot-dir> [out.json]'); process.exit(2); }
const out = outArg || join(here, '../../src/detect/model.json');
const N = 21, HALF = 0.45;
// template variants tried per landmark: [patch half-width in R, weight of the learned position]
const VARIANTS = [[0.3, 0.15], [0.45, 0.15], [0.65, 0.15], [0.45, 0.05], [0.45, 0.35]];

function load(file) {
  const buf = execFileSync('python3', ['-I', join(here, 'decode.py'), file], { maxBuffer: 1 << 30 });
  const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
  return { width: w, height: h, data: grayWithoutOverlay(new Uint8Array(buf.buffer, buf.byteOffset + 8, w * h * 4), w, h).gray };
}
const pt = (o) => (o && o.q !== 'absent' && Number.isFinite(o.x) ? [o.x, o.y] : null);
const ln = (o) => (o && o.q !== 'absent' && o.a && o.b && o.a[0] != null ? { a: o.a, b: o.b } : null);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const q75 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(0.75 * s.length))]; };

/** Implant geometry from annotations, in the shape frames() takes. */
function implantOf(lm, kind) {
  const c = kind === 'reverse' ? lm.gs : lm.head;
  if (!c || c.q === 'absent' || !(c.r > 0)) return null;
  if (kind === 'native') return { centre: [c.cx, c.cy], r: c.r, face: null, stem: null };
  const stem = ln(lm.stem);
  const face = kind === 'reverse' ? ln(lm.face) : null;
  if (kind === 'reverse' && (!face || !stem)) return null;
  if (kind !== 'reverse' && !stem) return null;
  return { centre: [c.cx, c.cy], r: c.r, face, stem: stem ? { a: stem.a[1] < stem.b[1] ? stem.a : stem.b, b: stem.a[1] < stem.b[1] ? stem.b : stem.a } : null };
}

const GROUPS = {
  reverse: {
    implants: ['reverse'],
    points: { sgt: 'scap', igr: 'scap', acr: 'scap', acu: 'scap', gts: 'hum', gtl: 'hum' },
    outline: { gtl: 'lateral', acr: 'lateral', gts: 'superior' },
    lines: { ssf: 'scap' },
  },
  hemi: {
    implants: ['pyc_hemi', 'hemi_other', 'resurfacing', 'anatomic_tsa'],
    points: { sgt: 'scap', igr: 'scap', acr: 'scap', acu: 'scap', gts: 'hum', pcA: 'hum', pcB: 'hum', pcC: 'hum' },
    outline: { pcA: 'lateral', acr: 'lateral', gts: 'superior', pcB: 'superior' },
    lines: {},
  },
  native: {
    implants: ['native'],
    points: { sgt: 'scap', igr: 'scap', acr: 'scap', acu: 'scap', gts: 'scap', gtl: 'scap' },
    outline: { gtl: 'lateral', acr: 'lateral', gts: 'superior' },
    lines: { ssf: 'scap' },
  },
};

const anns = readdirSync(annotDir).filter((f) => f.endsWith('.json') && !f.startsWith('batch'))
  .map((f) => { try { return JSON.parse(readFileSync(join(annotDir, f), 'utf8')); } catch { return null; } })
  .filter((a) => a && a.view_ok !== false && a.file && existsSync(a.file));

const model = { version: 1, created: new Date().toISOString().slice(0, 10), note: 'Landmark positions in implant frames (units of implant radius), learned from annotated radiographs. See src/detect/learned.js.', types: {} };
for (const [kind, G] of Object.entries(GROUPS)) {
  const films = [];
  for (const a of anns) {
    if (!G.implants.includes(a.implant)) continue;
    let imp = implantOf(a.landmarks, kind);
    if (!imp) continue;
    if (detected) {
      // use the detector's implant geometry when it agrees with the annotation (centre within 0.3 R)
      const r = detected[a.id];
      const L = r && r.landmarks;
      const c = L && (kind === 'reverse' ? L.gs : L.head);
      const P2 = (p) => [p.x, p.y];
      const ok = c && Math.hypot(c.cx - imp.centre[0], c.cy - imp.centre[1]) < 0.3 * imp.r && L.stem && (kind !== 'reverse' || L.face);
      if (ok) {
      const st = [P2(L.stem.a), P2(L.stem.b)].sort((u, v) => u[1] - v[1]);
      imp = { centre: [c.cx, c.cy], r: c.r, face: kind === 'reverse' ? { a: P2(L.face.a), b: P2(L.face.b) } : null, stem: { a: st[0], b: st[1] } };
      }   // else: the annotated implant (the detector missed it on this film)
    }
    // lateral side for heads: the tuberosity side of the head
    const tub = pt(a.landmarks.pcA) || pt(a.landmarks.gtl) || pt(a.landmarks.gts);
    const F = frames(imp, tub ? Math.sign(tub[0] - imp.centre[0]) : 0);
    if (!F) continue;
    films.push({ id: a.id, file: a.file, lm: a.landmarks, F });
  }
  console.log(`\n== ${kind}: ${films.length} annotated films usable`);
  if (films.length < 6) { console.log('   too few to learn from; skipped'); continue; }
  for (const f of films) { f.g = load(f.file); f.span = intensitySpan(f.g); }
  const T = { landmarks: {}, lines: {}, n: films.length };
  for (const [id, fr] of Object.entries(G.points)) {
    const have = films.filter((f) => f.F[fr] && pt(f.lm[id]));
    if (have.length < 5) continue;
    const stats = (train, half = HALF) => {
      const qs = train.map((f) => toFrame(f.F[fr], pt(f.lm[id])));
      const q = [med(qs.map((x) => x[0])), med(qs.map((x) => x[1]))];
      const sd = [0, 1].map((k) => Math.max(0.15, Math.sqrt(qs.reduce((s, x) => s + (x[k] - q[k]) ** 2, 0) / qs.length)));
      const tpl = new Float32Array(N * N);
      let nt = 0;
      for (const f of train) { const p = patch(f.g, f.F[fr], toFrame(f.F[fr], pt(f.lm[id])), N, half); if (p) { for (let t = 0; t < tpl.length; t++) tpl[t] += p[t]; nt++; } }
      for (let t = 0; t < tpl.length; t++) tpl[t] /= nt || 1;
      return { q, sd, template: tpl, patch: { N, half } };
    };
    const err = { prior: [], outline: [], ...(kind === 'native' ? { heuristic: [] } : {}) };
    for (const [h, l] of VARIANTS) err[`template:${h}:${l}`] = [];
    for (const test of have) {
      const train = have.filter((f) => f !== test);
      const m = stats(train);
      const truth = toFrame(test.F[fr], pt(test.lm[id]));
      const d = (q) => Math.hypot(q[0] - truth[0], q[1] - truth[1]);
      err.prior.push(d(m.q));
      const byHalf = {};
      for (const [h, l] of VARIANTS) {
        const mh = byHalf[h] || (byHalf[h] = stats(train, h));
        const t = templateSearch(test.g, test.F[fr], mh, { lambda: l });
        err[`template:${h}:${l}`].push(d(t ? t.q : m.q));
      }
      if (G.outline[id]) { const o = outlineExtreme(test.g, test.F[fr], m.q, m.sd, G.outline[id], test.span); err.outline.push(d(o || m.q)); }
      if (err.heuristic) {
        // the app's hand-written native estimate, from the same (annotated) head circle
        if (!test.heur) { const h = test.lm.head; try { test.heur = nativeLandmarks(test.g, { cx: h.cx, cy: h.cy, r: h.r }, Math.sign(test.F.scap.lat[0])); } catch { test.heur = {}; } }
        const e = test.heur[id];
        err.heuristic.push(e && Number.isFinite(e.x) ? d(toFrame(test.F[fr], [e.x, e.y])) : d(m.q));
      }
    }
    const score = (e) => (e.length ? med(e) + 0.25 * q75(e) : Infinity);
    const best = Object.keys(err).reduce((b, k) => (score(err[k]) < score(err[b]) ? k : b), 'prior');
    const [method, vh, vl] = best.startsWith('template:') ? ['template', +best.split(':')[1], +best.split(':')[2]] : [best];
    const full = stats(have, vh || HALF);
    T.landmarks[id] = {
      frame: fr, method, q: full.q.map((v) => +v.toFixed(3)), sd: full.sd.map((v) => +v.toFixed(3)), n: have.length,
      looMedian: +med(err[best]).toFixed(3),
      ...(method === 'outline' ? { outline: G.outline[id] } : {}),
      ...(method === 'template' ? { template: Array.from(full.template, (v) => +v.toFixed(3)), patch: full.patch, lambda: vl } : {}),
    };
    const tb = Object.keys(err).filter((k) => k.startsWith('template:')).reduce((b, k) => (score(err[k]) < score(err[b]) ? k : b));
    console.log(`  ${id.padEnd(4)} n ${have.length}: prior ${med(err.prior).toFixed(2)} | best template ${med(err[tb]).toFixed(2)} (${tb.slice(9)})${err.outline.length ? ` | outline ${med(err.outline).toFixed(2)}` : ''}${err.heuristic ? ` | heuristic ${med(err.heuristic).toFixed(2)}` : ''}  → ${best}`);
  }
  for (const [id, fr] of Object.entries(G.lines)) {
    const have = films.filter((f) => f.F[fr] && ln(f.lm[id]));
    if (have.length < 5) continue;
    const ends = have.map((f) => { const l = ln(f.lm[id]); return [toFrame(f.F[fr], l.a), toFrame(f.F[fr], l.b)]; });
    // order each line medial → lateral
    const ord = ends.map(([a, b]) => (a[0] <= b[0] ? [a, b] : [b, a]));
    const a = [med(ord.map((e) => e[0][0])), med(ord.map((e) => e[0][1]))], b = [med(ord.map((e) => e[1][0])), med(ord.map((e) => e[1][1]))];
    const angs = ord.map(([p, q]) => Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI);
    const ma = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    T.lines[id] = { frame: fr, a: a.map((v) => +v.toFixed(3)), b: b.map((v) => +v.toFixed(3)), n: have.length, angleSpreadDeg: +med(angs.map((x) => Math.abs(x - ma))).toFixed(1) };
    console.log(`  ${id} n ${have.length}: median angle error of the learned line ${T.lines[id].angleSpreadDeg}°`);
  }
  model.types[kind] = T;
}
writeFileSync(out, JSON.stringify(model) + '\n');
console.log(`\nwrote ${out}`);
