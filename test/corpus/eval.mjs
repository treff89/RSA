// Evaluate automatic landmarking on a corpus of real radiographs (not part of the repo: see test/corpus/README.md).
//   node test/corpus/eval.mjs <corpus-dir> <out-dir> [--only id,id] [--filter substring]
// Reads every <corpus-dir>/*/manifest.jsonl, runs the same code path as the app on each image (overlay blanking →
// detection → landmark seeding → protocol measurement), and writes
//   <out-dir>/results.jsonl   one line per image: detection, landmarks, measurements, comparison with stated values
//   <out-dir>/report.md       accuracy summary
// Then `python3 -I test/corpus/draw.py <out-dir>` renders overlays and contact sheets.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grayWithoutOverlay } from '../../src/detect/overlay.js';
import { detectXray } from '../../src/detect/radiograph.js';
import { PROTOCOLS } from '../../src/measure/protocols/index.js';
import { evaluate } from '../../src/measure/core.js';
import { seedXray, lateralSignOf } from '../../src/measure/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const [corpus, out, ...rest] = process.argv.slice(2);
// optional: --annot <dir> with <id>.json ground-truth landmark files (see the annotation spec)
if (!corpus || !out) { console.error('usage: node test/corpus/eval.mjs <corpus-dir> <out-dir> [--only ids] [--filter text]'); process.exit(2); }
const arg = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
const filter = arg('--filter');
const annotDir = arg('--annot');
const annotOnly = rest.includes('--annotated-only');
mkdirSync(out, { recursive: true });

const PROTO_FOR_KIND = { reverse: 'rsa-ap', hemi: 'pyc-ap', native: 'native-ap' };
const EXPECT_KIND = { reverse: 'reverse', pyc_hemi: 'hemi', hemi_other: 'hemi', resurfacing: 'hemi', anatomic_tsa: 'hemi', native: 'native' };

/** Published value → our metric (with any conversion). Returns { id, ours→comparable } or null. */
function mapMeasure(name, protoId) {
  const n = name.toLowerCase().replace(/[^a-z_]/g, '');
  if (protoId === 'rsa-ap') {
    if (n === 'lsa') return { id: 'lsa', f: (v) => v };
    if (n === 'dsa') return { id: 'dsa', f: (v) => v };
    // our tilt: 0 = face perpendicular to the fossa floor, + superior. β (Maurer) ≈ 90° − inclination.
    if (n === 'beta_angle') return { id: 'tilt', f: (v) => 90 - v, note: 'β compared as 90° − tilt' };
    if (['glenosphere_tilt', 'rsa_angle', 'glenoid_inclination'].includes(n)) return { id: 'tilt', f: (v) => v };
    if (n === 'inferior_overhang_mm') return { id: 'overhang', f: (v) => v, mm: true };
    if (n === 'acromion_greater_tuberosity_distance_mm' || n === 'acromiohumeral_distance_mm') return { id: 'ahd', f: (v) => v, mm: true };
    if (n === 'lateral_humeral_offset_mm') return { id: 'lho', f: (v) => v, mm: true };
    if (n === 'filling_ratio') return { id: 'frM', f: (v) => v };
  }
  if (protoId === 'native-ap') {
    if (n === 'csa') return { id: 'csa', f: (v) => v };
    if (n === 'acromion_index') return { id: 'ai', f: (v) => v };
    if (n === 'beta_angle') return { id: 'incl', f: (v) => 90 - v, note: 'β compared as 90° − tilt' };
    if (n === 'rsa_angle') return { id: 'rsaAngle', f: (v) => v };
    if (n === 'glenoid_inclination') return { id: 'incl', f: (v) => v };
    if (n === 'acromiohumeral_distance_mm') return { id: 'ahd', f: (v) => v, mm: true };
  }
  if (protoId === 'pyc-ap') {
    if (n === 'cor_deviation_mm') return { id: 'corDev', f: (v) => v, mm: true };
    if (n === 'head_height_mm') return { id: 'hh', f: (v) => v, mm: true };
    if (n === 'acromiohumeral_distance_mm') return { id: 'ahd', f: (v) => v, mm: true };
    if (n === 'stem_alignment') return { id: 'stemAlign', f: (v) => v };
    if (n === 'filling_ratio') return { id: 'frM', f: (v) => v };
  }
  return null;
}

function decode(file) {
  const buf = execFileSync('python3', ['-I', join(here, 'decode.py'), file], { maxBuffer: 1 << 30 });
  const w = buf.readUInt32LE(0), h = buf.readUInt32LE(4);
  return { w, h, rgba: new Uint8Array(buf.buffer, buf.byteOffset + 8, w * h * 4) };
}

const entries = [];
for (const d of readdirSync(corpus, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const mf = join(corpus, d.name, 'manifest.jsonl');
  if (!existsSync(mf)) continue;
  for (const line of readFileSync(mf, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); e._dir = join(corpus, d.name); entries.push(e); } catch { /* skip malformed */ }
  }
}
const annotOf = (id) => { if (!annotDir) return null; const f = join(annotDir, `${id}.json`); try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; } catch { return null; } };
const todo = entries.filter((e) => (!only || only.has(e.id)) && (!filter || JSON.stringify(e).includes(filter)) && e.file && !['axillary', 'scapular_y'].includes(e.view) && (!annotOnly || annotOf(e.id)));

/** Annotation JSON → landmark values in the app's format (points {x,y}, lines {a,b}, circles {cx,cy,r}). */
function annotValues(a) {
  const v = {};
  for (const [id, x] of Object.entries((a && a.landmarks) || {})) {
    if (!x || x.q === 'absent') continue;
    if (Number.isFinite(x.r)) v[id] = { cx: x.cx, cy: x.cy, r: x.r };
    else if (x.a && x.b && x.a[0] != null && x.b[0] != null) v[id] = { a: { x: x.a[0], y: x.a[1] }, b: { x: x.b[0], y: x.b[1] } };
    else if (Number.isFinite(x.x) && Number.isFinite(x.y)) v[id] = { x: x.x, y: x.y };
  }
  return v;
}
const ptOf = (v) => (v.r !== undefined ? [v.cx, v.cy] : v.a ? [(v.a.x + v.b.x) / 2, (v.a.y + v.b.y) / 2] : [v.x, v.y]);
/** Distance between two landmark values; lines: max end-point distance (ends matched either way), circles: centre. */
function lmDist(p, q) {
  if (p.r !== undefined && q.r !== undefined) return Math.hypot(p.cx - q.cx, p.cy - q.cy);
  if (p.a && q.a) {
    const d = (u, w) => Math.hypot(u.x - w.x, u.y - w.y);
    return Math.min(Math.max(d(p.a, q.a), d(p.b, q.b)), Math.max(d(p.a, q.b), d(p.b, q.a)));
  }
  const [x1, y1] = ptOf(p), [x2, y2] = ptOf(q);
  return Math.hypot(x1 - x2, y1 - y2);
}
const lineAng = (l) => { let a = Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x) * 180 / Math.PI; if (a < 0) a += 180; return a; };
console.log(`${entries.length} manifest entries, ${todo.length} AP-type radiographs to evaluate`);

const results = [];
let n = 0;
for (const e of todo) {
  n++;
  const file = join(e._dir, e.file);
  const r = { id: e.id, file, implant: e.implant, view: e.view, design: e.design || '', annotated: !!e.annotated, quality: e.quality || '' };
  try {
    const { w, h, rgba } = decode(file);
    const { gray, blanked } = grayWithoutOverlay(rgba, w, h);
    const image = { width: w, height: h, data: gray, pixelSpacing: { mm: null } };
    const t0 = performance.now();
    const det = detectXray(image);
    r.ms = Math.round(performance.now() - t0);
    r.size = [w, h]; r.blanked = blanked;
    r.kind = det.kind; r.confidence = det.confidence; r.side = det.side; r.error = det.error;
    r.expectKind = EXPECT_KIND[e.implant] || null;
    r.kindOk = r.expectKind ? r.kind === r.expectKind : null;
    const protoId = PROTO_FOR_KIND[det.kind] || PROTO_FOR_KIND[r.expectKind] || null;
    if (protoId) {
      const p = PROTOCOLS[protoId];
      const set = seedXray(p, det);
      // calibrate from the implant size when the source states it
      let mm = null;
      const sz = e.implant_sizes || {};
      const ref = protoId === 'rsa-ap' ? set.values.gs : set.values.head;
      const nominal = protoId === 'rsa-ap' ? sz.glenosphere_mm : sz.head_mm;
      if (ref && nominal > 0) mm = nominal / (2 * ref.r);
      const ctx = { L: set.values, state: set.state, mm, lateralSign: lateralSignOf(det, e.side === 'L' ? 'L' : e.side === 'R' ? 'R' : '') };
      const res = evaluate(p, ctx);
      r.protocol = protoId;
      r.landmarks = set.values; r.landmarkState = set.state;
      r.metrics = Object.fromEntries(res.filter((x) => Number.isFinite(x.value)).map((x) => [x.id, +x.value.toFixed(2)]));
      r.mmPerPx = mm;
      // ── ground-truth landmarks, when annotated ──
      const an = annotOf(e.id);
      if (an && an.view_ok !== false) {
        const tv = annotValues(an);
        const ref = tv.gs || tv.head;
        const unit = ref ? ref.r : Math.min(w, h) / 10;            // errors in implant radii (≈ 18–24 mm)
        r.annot = { unit: +unit.toFixed(1), lm: {}, metrics: {} };
        for (const [id, t] of Object.entries(tv)) {
          const a = set.values[id];
          const o = { truth: t, auto: a || null, err: a ? +(lmDist(a, t) / unit).toFixed(3) : null, state: set.state[id] || 'missing' };
          if (a && a.a && t.a) { const d = Math.abs(lineAng(a) - lineAng(t)) % 180; o.angErr = +Math.min(d, 180 - d).toFixed(1); }
          if (a && a.r !== undefined && t.r !== undefined) o.rErr = +((a.r - t.r) / unit).toFixed(3);
          r.annot.lm[id] = o;
        }
        const tctx = { L: tv, state: {}, mm, lateralSign: ctx.lateralSign };
        for (const x of evaluate(p, tctx)) if (Number.isFinite(x.value)) r.annot.metrics[x.id] = +x.value.toFixed(2);
      }
      r.compare = [];
      for (const m of e.measurements || []) {
        if (m.applies_to !== 'this_image' || !Number.isFinite(+m.value)) continue;
        const map = mapMeasure(m.name, protoId);
        if (!map) { r.compare.push({ name: m.name, stated: +m.value, ours: null, note: 'no matching metric' }); continue; }
        if (map.mm && !mm) { r.compare.push({ name: m.name, stated: +m.value, ours: null, note: 'needs a scale' }); continue; }
        const ours = r.metrics[map.id];
        const target = map.f(+m.value);
        const fromAnnot = r.annot ? r.annot.metrics[map.id] : undefined;
        r.compare.push({ name: m.name, metric: map.id, stated: +m.value, target: +target.toFixed(2), ours: ours ?? null, err: Number.isFinite(ours) ? +(ours - target).toFixed(2) : null,
          annot: fromAnnot ?? null, annotErr: Number.isFinite(fromAnnot) ? +(fromAnnot - target).toFixed(2) : null, note: map.note || '' });
      }
    }
  } catch (err) {
    r.fatal = String(err && err.message || err).slice(0, 200);
  }
  results.push(r);
  if (n % 10 === 0) console.log(`  ${n}/${todo.length}`);
}
writeFileSync(join(out, 'results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ── report ──
const L = [];
const by = (k) => { const m = {}; for (const r of results) (m[r[k]] = m[r[k]] || []).push(r); return m; };
L.push(`# Corpus evaluation — ${new Date().toISOString().slice(0, 16)}Z`, '', `${results.length} radiographs (AP-type).`, '');
L.push('## Implant type', '', '| expected | n | detected as … |', '|---|---|---|');
for (const [k, rs] of Object.entries(by('implant'))) {
  const c = {};
  for (const r of rs) c[r.kind || r.fatal ? (r.kind || 'error') : 'none'] = (c[r.kind || 'none'] || 0) + 1;
  L.push(`| ${k} | ${rs.length} | ${Object.entries(c).map(([a, b]) => `${a} ${b}`).join(', ')} |`);
}
const cmp = results.flatMap((r) => (r.compare || []).map((c) => ({ ...c, id: r.id })));
L.push('', '## Stated per-image values vs ours', '');
const byName = {};
for (const c of cmp) (byName[c.name] = byName[c.name] || []).push(c);
L.push('| measure | n | compared | mean abs error | median abs error | within 5 | within 10 |', '|---|---|---|---|---|---|---|');
for (const [k, cs] of Object.entries(byName)) {
  const errs = cs.filter((c) => Number.isFinite(c.err)).map((c) => Math.abs(c.err)).sort((a, b) => a - b);
  const mean = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN;
  const med = errs.length ? errs[Math.floor(errs.length / 2)] : NaN;
  L.push(`| ${k} | ${cs.length} | ${errs.length} | ${mean.toFixed(1)} | ${med.toFixed(1)} | ${errs.filter((x) => x <= 5).length} | ${errs.filter((x) => x <= 10).length} |`);
}
L.push('', '| id | measure | stated | compared as | auto | error | from annotation | error | note |', '|---|---|---|---|---|---|---|---|---|');
for (const c of cmp) L.push(`| ${c.id} | ${c.name} | ${c.stated} | ${c.target ?? ''} | ${c.ours ?? '—'} | ${c.err ?? ''} | ${c.annot ?? '—'} | ${c.annotErr ?? ''} | ${c.note || ''} |`);
// ── landmark accuracy against annotations ──
const ann = results.filter((r) => r.annot);
if (ann.length) {
  L.push('', `## Landmarks vs annotation (${ann.length} images; error in implant radii, ≈ 20 mm each)`, '');
  L.push('| landmark | annotated | auto placed | median err | 75th pct | ≤0.15 R | ≤0.3 R | line angle median ° |', '|---|---|---|---|---|---|---|---|');
  const ids = [...new Set(ann.flatMap((r) => Object.keys(r.annot.lm)))];
  for (const id of ids) {
    const xs = ann.map((r) => r.annot.lm[id]).filter(Boolean);
    const errs = xs.filter((x) => x.err !== null).map((x) => x.err).sort((a, b) => a - b);
    const angs = xs.filter((x) => x.angErr !== undefined).map((x) => x.angErr).sort((a, b) => a - b);
    const q = (a, f) => (a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))].toFixed(2) : '—');
    L.push(`| ${id} | ${xs.length} | ${errs.length} | ${q(errs, 0.5)} | ${q(errs, 0.75)} | ${errs.filter((v) => v <= 0.15).length} | ${errs.filter((v) => v <= 0.3).length} | ${angs.length ? q(angs, 0.5) : ''} |`);
  }
  L.push('', '### Metrics: automatic vs from annotated landmarks', '', '| metric | n | median abs diff | 75th pct |', '|---|---|---|---|');
  const mids = [...new Set(ann.flatMap((r) => Object.keys(r.annot.metrics)))];
  for (const m of mids) {
    const d = ann.filter((r) => Number.isFinite(r.annot.metrics[m]) && Number.isFinite((r.metrics || {})[m])).map((r) => Math.abs(r.metrics[m] - r.annot.metrics[m])).sort((a, b) => a - b);
    if (d.length) L.push(`| ${m} | ${d.length} | ${d[Math.floor(d.length / 2)].toFixed(2)} | ${d[Math.min(d.length - 1, Math.floor(0.75 * d.length))].toFixed(2)} |`);
  }
}
const fails = results.filter((r) => r.fatal || !r.kind || r.kind === 'unknown');
L.push('', `## Failures (${fails.length})`, '');
for (const r of fails) L.push(`- ${r.id}: ${r.fatal || r.error || 'nothing detected'} (${r.implant}, ${r.quality})`);
writeFileSync(join(out, 'report.md'), L.join('\n') + '\n');
console.log(L.slice(0, 40).join('\n'));
