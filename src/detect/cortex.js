// Humeral cortex tracing along a known axis (the stem of an implant, or the shaft line of a native humerus).
// At levels along the axis, an intensity profile across the bone is read on each side, at full resolution:
//   metal edge     the strongest fall near the axis (implants only);
//   outer cortex   scanning in from the soft tissue, the first sustained rise into bone (periosteal edge);
//   inner cortex   between the two, the strongest rise from canal (medulla, cement) into cortex (endosteal edge);
//                  when there is none, the stem fills the canal and the inner cortex is the metal edge.
// Each side's series is median-filtered along the axis, which rejects the odd level fooled by a screw, a rib or a
// label. Returns the canal widths at requested levels and the outer bone outline (for display), or null.
import { sample, intensitySpan } from './learned.js';

const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/**
 * g: full-resolution grey image; axis: { a: [x,y] proximal, b: [x,y] distal }; R: scale (implant radius, px).
 * opts: { metal: boolean, levels: { id: fraction from proximal (0–1) }, from, to: fractions of the axis traced }.
 */
export function traceCortex(g, axis, R, opts = {}) {
  const [ax, ay] = axis.a, [bx, by] = axis.b;
  const len = Math.hypot(bx - ax, by - ay);
  if (!(len > 4) || !(R > 3)) return null;
  const d = [(bx - ax) / len, (by - ay) / len], n = [-d[1], d[0]];
  const span = intensitySpan(g);
  const step = Math.max(0.5, R / 60), U = 1.5 * R;
  const from = opts.from ?? 0.05, to = opts.to ?? 1.0;
  const rows = [];
  for (let t = from; t <= to + 1e-9; t += 0.025) {
    const c = [ax + d[0] * len * t, ay + d[1] * len * t];
    const row = { t, c, sides: [] };
    for (const sg of [1, -1]) {
      const p = [];
      for (let u = 0; u <= U; u += step) p.push(sample(g, c[0] + sg * n[0] * u, c[1] + sg * n[1] * u));
      row.sides.push(profileEdges(p, step, span, !!opts.metal, R));
    }
    rows.push(row);
  }
  if (rows.length < 5) return null;
  // median filter each side's series along the axis (window of 7 levels)
  for (const key of ['metal', 'inner', 'outer']) {
    for (let s = 0; s < 2; s++) {
      const raw = rows.map((r) => r.sides[s][key]);
      rows.forEach((r, i) => { r.sides[s][key + 'F'] = med(raw.slice(Math.max(0, i - 3), i + 4)); });
    }
  }
  // robust quadratic along the axis for each side's inner and outer edge: a level more than 0.1 R off the curve is
  // treated as misread (a wire, a rib, soft tissue) and replaced by the curve
  for (const key of ['inner', 'outer']) {
    for (let sd = 0; sd < 2; sd++) {
      const fit = robustQuad(rows.map((r) => r.t), rows.map((r) => r.sides[sd][key + 'F']), 0.1 * R);
      rows.forEach((r) => {
        const e = r.sides[sd];
        if (!fit) { e[key + 'F'] = NaN; return; }
        const v = fit.f(r.t);
        e[key + 'Ok'] = Number.isFinite(e[key + 'F']) && Math.abs(e[key + 'F'] - v) <= 0.1 * R;
        e[key + 'F'] = e[key + 'Ok'] ? e[key + 'F'] : (fit.support >= 0.6 ? v : NaN);
      });
    }
  }
  const at = (frac) => {
    let best = rows[0];
    for (const r of rows) if (Math.abs(r.t - frac) < Math.abs(best.t - frac)) best = r;
    return best;
  };
  const point = (r, s, u) => [r.c[0] + (s === 0 ? 1 : -1) * n[0] * u, r.c[1] + (s === 0 ? 1 : -1) * n[1] * u];
  const canal = {};
  for (const [id, frac] of Object.entries(opts.levels || {})) {
    const r = at(frac);
    const [L, Rt] = r.sides;
    if (!Number.isFinite(L.innerF) || !Number.isFinite(Rt.innerF)) continue;
    // agreement between the raw and filtered edge says how trustworthy this level is
    const dev = Math.max(Math.abs(L.inner - L.innerF) || 0, Math.abs(Rt.inner - Rt.innerF) || 0);
    canal[id] = { a: point(r, 0, L.innerF), b: point(r, 1, Rt.innerF), confidence: dev < 0.04 * R ? 0.6 : 0.4 };
  }
  const outline = [0, 1].map((s) => rows.filter((r) => r.sides[s].outerOk).map((r) => point(r, s, r.sides[s].outerF)));
  const metal = [0, 1].map((s) => rows.filter((r) => Number.isFinite(r.sides[s].metalF)).map((r) => point(r, s, r.sides[s].metalF)));
  return { canal, outline, metal };
}

/** Edges along one outward profile p (index × step = distance from the axis). */
function profileEdges(p, step, span, metal, R) {
  const N = p.length;
  if (p.some((v) => !Number.isFinite(v))) {
    // off the image: keep only the part inside
    const k = p.findIndex((v) => !Number.isFinite(v));
    p = p.slice(0, k);
  }
  if (p.length < 10) return { metal: NaN, inner: NaN, outer: NaN };
  const s = p.map((_, i) => (p[Math.max(0, i - 1)] + p[i] + p[Math.min(p.length - 1, i + 1)]) / 3);
  const grad = s.map((_, i) => (i > 0 && i < s.length - 1 ? (s[i + 1] - s[i - 1]) / 2 : 0));
  const kMax = Math.min(s.length - 2, Math.round((0.9 * R) / step));
  // metal edge: the strongest fall within reach of the axis
  let um = 0;
  if (metal) {
    let bv = 0;
    for (let i = 1; i < kMax; i++) if (-grad[i] > bv) { bv = -grad[i]; um = i; }
    if (bv < 0.04 * span) return { metal: NaN, inner: NaN, outer: NaN };
  }
  // outer edge: scanning in from the far end, the first rise of at least 6% of the range that stays up
  let uo = -1;
  const rise = 0.06 * span, k = 3;
  for (let i = s.length - 1 - k; i > um + k; i--) {
    const outside = (s[i + 1] + s[Math.min(s.length - 1, i + 2)] + s[Math.min(s.length - 1, i + k)]) / 3;
    const inside = (s[i - 1] + s[i - 2] + s[i - k]) / 3;
    if (inside - outside >= rise) {
      // settle on the steepest point nearby
      let bi = i, bg = -grad[i];
      for (let j = Math.max(um + 1, i - 4); j <= Math.min(s.length - 2, i + 4); j++) if (-grad[j] > bg) { bg = -grad[j]; bi = j; }
      uo = bi;
      break;
    }
  }
  if (uo < 0) return { metal: metal ? um * step : NaN, inner: NaN, outer: NaN };
  // inner edge: strongest rise going outward between the canal and the outer edge
  // the canal is the darkest stretch between the metal (or the axis) and the outer cortex; the endosteal edge is the
  // steepest rise after it
  const lo = metal ? um + 2 : Math.max(2, Math.round(uo * 0.2));
  let imin = -1, vmin = Infinity;
  for (let i = lo; i < uo - 1; i++) if (s[i] < vmin) { vmin = s[i]; imin = i; }
  let ui = -1, gv = 0, peak = -Infinity;
  if (imin >= 0) for (let i = imin; i < uo; i++) { if (grad[i] > gv) { gv = grad[i]; ui = i; } peak = Math.max(peak, s[i]); }
  if (ui < 0 || peak - vmin < 0.02 * span) ui = metal ? um : -1;   // no canal visible: the stem fills it
  void N;
  return { metal: metal ? um * step : NaN, inner: ui >= 0 ? ui * step : NaN, outer: uo * step };
}

/** Least-squares quadratic v(t) refitted without points more than `tol` from it. Returns { f, support } or null. */
function robustQuad(ts, vs, tol) {
  let use = ts.map((_, i) => Number.isFinite(vs[i]));
  let co = null;
  for (let it = 0; it < 4; it++) {
    const idx = use.map((u, i) => (u ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 4) return null;
    // normal equations for v = c0 + c1 t + c2 t²
    const S = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
    for (const i of idx) {
      const b = [1, ts[i], ts[i] * ts[i]];
      for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) S[r][c] += b[r] * b[c]; S[r][3] += b[r] * vs[i]; }
    }
    co = solve3(S);
    if (!co) return null;
    const f = (t) => co[0] + co[1] * t + co[2] * t * t;
    const next = ts.map((t, i) => Number.isFinite(vs[i]) && Math.abs(vs[i] - f(t)) <= tol * (it < 2 ? 2 : 1));
    if (next.every((u, i) => u === use[i])) break;
    use = next;
  }
  const f = (t) => co[0] + co[1] * t + co[2] * t * t;
  const n = ts.filter((t, i) => Number.isFinite(vs[i])).length;
  const support = ts.filter((t, i) => Number.isFinite(vs[i]) && Math.abs(vs[i] - f(t)) <= tol).length / Math.max(1, n);
  return { f, support };
}

function solve3(M) {
  const A = M.map((r) => r.slice());
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const k = A[r][c] / A[c][c]; for (let j = c; j < 4; j++) A[r][j] -= k * A[c][j]; }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}
