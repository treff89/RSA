// Learned bony-landmark placement: positions, spreads and local appearance learned from annotated radiographs
// (test/corpus/learn.mjs writes ./model.json). Shared by the app and the learner so both use identical geometry.
//
// Landmarks are expressed in frames fixed to the implant, in units of its radius R:
//   scap — origin: glenosphere / head centre; lat: normal of the glenosphere back face (towards the humerus);
//          sup: along the face, superior. Scapular landmarks (acromion, glenoid rim, fossa) live here.
//          A native shoulder has no implant axes: the frame is the image's own (lateral = towards the humerus,
//          superior = up), centred on the humeral head.
//   hum  — origin: proximal end of the stem; sup: up the stem axis; lat: perpendicular, towards the lateral side.
//          Humeral landmarks (tuberosity) live here: the arm moves independently of the scapula.
// Per landmark the model says how it is placed: 'prior' (learned position), 'template' (search near the learned
// position for the best match to the averaged local appearance) or 'outline' (the extreme point of the bony
// outline near the learned position, found by scanning in from the soft tissue).

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = (a) => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };

/**
 * Frames from implant geometry (image pixels). imp = { centre:[x,y], r, face?:{a,b}, stem?:{a,b} } where stem.a is
 * the proximal end. For heads without a face line, lat comes from the stem (towards the lateral side) and the
 * glenoid side is opposite. Returns { scap, hum } (hum null without a stem) or null.
 */
export function frames(imp, lateralHint) {
  if (!imp || !imp.centre || !(imp.r > 0)) return null;
  const C = imp.centre, R = imp.r;
  let up = null, prox = null;
  if (imp.stem) {
    let a = imp.stem.a, b = imp.stem.b;
    if (a[1] > b[1]) [a, b] = [b, a];
    up = unit(sub(a, b)); prox = a;
  }
  let lat;
  if (imp.face) {
    const fa = imp.face.a[1] < imp.face.b[1] ? imp.face.a : imp.face.b, fb = fa === imp.face.a ? imp.face.b : imp.face.a;
    const d = unit(sub(fb, fa));
    lat = [-d[1], d[0]];
    const ref = prox ? sub(prox, C) : lateralHint ? [lateralHint, 0] : null;
    if (ref && dot(ref, lat) < 0) lat = [-lat[0], -lat[1]];
  } else if (up) {
    lat = [-up[1], up[0]];
    if (lateralHint && lat[0] * lateralHint < 0) lat = [-lat[0], -lat[1]];
  } else if (lateralHint) {
    lat = [Math.sign(lateralHint), 0];   // native shoulder: no implant axes — the image axes, lateral to the humerus side
  } else return null;
  let sup = [lat[1], -lat[0]];
  if (sup[1] > 0) sup = [-sup[0], -sup[1]];
  const scap = { o: C, u: R, lat, sup };
  let hum = null;
  if (up && prox) {
    let hl = [-up[1], up[0]];
    if (dot(hl, lat) < 0) hl = [-hl[0], -hl[1]];
    hum = { o: prox, u: R, lat: hl, sup: up };
  }
  return { scap, hum };
}

export const toFrame = (F, p) => { const d = sub(p, F.o); return [dot(d, F.lat) / F.u, dot(d, F.sup) / F.u]; };
export const fromFrame = (F, q) => [F.o[0] + (q[0] * F.lat[0] + q[1] * F.sup[0]) * F.u, F.o[1] + (q[0] * F.lat[1] + q[1] * F.sup[1]) * F.u];

/** Bilinear sample of a grey image { width, height, data }; NaN outside. */
export function sample(g, x, y) {
  const w = g.width, h = g.height;
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = x - x0, fy = y - y0, d = g.data;
  return (d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx) * (1 - fy) + (d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx) * fy;
}

/** Contrast-normalised patch (zero mean, unit SD) of N×N samples spanning ±half R around q, in frame axes. */
export function patch(g, F, q, N, half) {
  const v = new Float32Array(N * N);
  let s = 0, s2 = 0, k = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const p = fromFrame(F, [q[0] + (i / (N - 1) * 2 - 1) * half, q[1] - (j / (N - 1) * 2 - 1) * half]);
    const x = sample(g, p[0], p[1]);
    v[j * N + i] = x;
    if (Number.isFinite(x)) { s += x; s2 += x * x; k++; }
  }
  if (k < 0.7 * N * N) return null;
  const m = s / k, sd = Math.sqrt(Math.max(1e-9, s2 / k - m * m));
  for (let t = 0; t < v.length; t++) v[t] = Number.isFinite(v[t]) ? (v[t] - m) / sd : 0;
  return v;
}

/** Robust intensity range of an image (1st–99th percentile), for edge thresholds. */
export function intensitySpan(g) {
  const vals = [];
  const step = Math.max(1, Math.floor(g.data.length / 40000));
  for (let i = 0; i < g.data.length; i += step) vals.push(g.data[i]);
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(0.01 * vals.length)], hi = vals[Math.floor(0.99 * vals.length)];
  return hi - lo || 1;
}

function firstRise(v, k, minStep) {
  for (let i = k; i < v.length - k; i++) {
    if (!Number.isFinite(v[i - k]) || !Number.isFinite(v[i + k])) continue;
    const before = v[i - k];
    if (v[i + k] - before < minStep) continue;
    let m = 0, c = 0;
    for (let j = i + k; j < Math.min(v.length, i + 3 * k); j++) if (Number.isFinite(v[j])) { m += v[j]; c++; }
    if (c && m / c - before >= 0.75 * minStep) return i;
  }
  return -1;
}

/** Extreme point of the bony outline near q0 (frame units): 'lateral' scans inward, 'superior' scans down. */
export function outlineExtreme(g, F, q0, sd, kind, span) {
  const step = 0.02, k = 2, ms = 0.06 * span;
  let best = null;
  const scan = (start, dir, len, better) => {
    const v = [];
    for (let t = 0; t <= len; t += step) { const p = fromFrame(F, [start[0] + dir[0] * t, start[1] + dir[1] * t]); v.push(sample(g, p[0], p[1])); }
    const i = firstRise(v, k, ms);
    if (i < 0) return;
    const q = [start[0] + dir[0] * i * step, start[1] + dir[1] * i * step];
    if (!best || better(q, best)) best = q;
  };
  if (kind === 'lateral') for (let y = q0[1] - 1.5 * sd[1]; y <= q0[1] + 1.5 * sd[1]; y += 0.04) scan([q0[0] + 1.6 * sd[0] + 0.4, y], [-1, 0], 1.6 * sd[0] + 1.2, (q, b) => q[0] > b[0]);
  else if (kind === 'superior') for (let x = q0[0] - 1.5 * sd[0]; x <= q0[0] + 1.5 * sd[0]; x += 0.04) scan([x, q0[1] + 1.6 * sd[1] + 0.4], [0, -1], 1.6 * sd[1] + 1.2, (q, b) => q[1] > b[1]);
  return best;
}

/** Template search near the learned position; λ weighs the learned position against appearance. */
export function templateSearch(g, F, m, opts = {}) {
  const { N, half } = m.patch;
  const lambda = opts.lambda ?? m.lambda ?? 0.15;
  const T = m.template;
  let best = null, bv = -Infinity, bc = 0;
  const [sx, sy] = m.sd;
  for (let dx = -2.5 * sx; dx <= 2.5 * sx; dx += 0.04) for (let dy = -2.5 * sy; dy <= 2.5 * sy; dy += 0.04) {
    const q = [m.q[0] + dx, m.q[1] + dy];
    const p = patch(g, F, q, N, half);
    if (!p) continue;
    let c = 0;
    for (let t = 0; t < T.length; t++) c += p[t] * T[t];
    c /= T.length;
    const v = c - lambda * ((dx / sx) ** 2 + (dy / sy) ** 2) / 2;
    if (v > bv) { bv = v; best = q; bc = c; }
  }
  return best ? { q: best, match: bc } : null;
}

/**
 * Place every landmark the model knows for this implant type. g = full-resolution grey image, F = frames().
 * Returns { id: { x, y, confidence } } (lines as { a, b, confidence }).
 */
export function placeLearned(g, F, model) {
  const out = {};
  if (!model || !F) return out;
  const span = intensitySpan(g);
  for (const [id, m] of Object.entries(model.landmarks || {})) {
    const Fr = F[m.frame];
    if (!Fr || m.method === 'heuristic') continue;   // the hand-written estimate did better in testing: keep it
    let q = m.q, conf = 0.3;
    if (m.method === 'template' && m.template) {
      const r = templateSearch(g, Fr, m);
      if (r) { q = r.q; conf = r.match > 0.3 ? 0.45 : 0.35; }
    } else if (m.method === 'outline') {
      const r = outlineExtreme(g, Fr, m.q, m.sd, m.outline, span);
      if (r) { q = r; conf = 0.45; }
    }
    const p = fromFrame(Fr, q);
    out[id] = { x: p[0], y: p[1], confidence: conf };
  }
  for (const [id, m] of Object.entries(model.lines || {})) {
    const Fr = F[m.frame];
    if (!Fr) continue;
    out[id] = { a: fromFrame(Fr, m.a), b: fromFrame(Fr, m.b), confidence: 0.3 };
  }
  return out;
}

/**
 * Training mode: fold a reader's own corrections into a model. records = [{ type, id, frame, q:[x,y], patch? }],
 * q in frame units, patch = the normalised local appearance at the corrected position (see patch()). Each
 * correction counts `weight` times as much as one annotated corpus film. Positions move to the weighted mean,
 * templates to the weighted mean appearance; a landmark the model left to the hand-written estimate becomes a
 * learned one once there are three corrections. Returns a new model; the input is not changed.
 */
export function adapt(model, records, type, weight = 3) {
  if (!model || !records || !records.length) return model;
  const out = { ...model, landmarks: { ...model.landmarks } };
  const by = new Map();
  for (const r of records) {
    if (r.type !== type || !Array.isArray(r.q) || !out.landmarks[r.id] || out.landmarks[r.id].frame !== r.frame) continue;
    if (!by.has(r.id)) by.set(r.id, []);
    by.get(r.id).push(r);
  }
  for (const [id, rs] of by) {
    const m = out.landmarks[id];
    const n0 = m.method === 'heuristic' ? 0 : Math.max(1, m.n || 1), w = weight * rs.length, W = n0 + w;
    if (m.method === 'heuristic' && rs.length < 3) continue;
    const q = [0, 1].map((k) => (n0 * m.q[k] + weight * rs.reduce((s, r) => s + r.q[k], 0)) / W);
    const nm = { ...m, q, n: (m.n || 0) + rs.length, adapted: rs.length };
    if (m.method === 'heuristic') nm.method = m.template ? 'template' : 'prior';
    const ps = rs.filter((r) => Array.isArray(r.patch) && m.template && r.patch.length === m.template.length);
    if (ps.length && nm.method === 'template') {
      const wp = weight * ps.length, Wp = n0 + wp;
      nm.template = m.template.map((t, k) => (n0 * t + weight * ps.reduce((s, r) => s + r.patch[k], 0)) / Wp);
    }
    out.landmarks[id] = nm;
  }
  return out;
}
