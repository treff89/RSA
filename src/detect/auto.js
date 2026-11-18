// Automatic landmarking of AP shoulder radiographs, built against real clinical films (viewer screenshots and
// DICOM alike): black canvas around a rotated field, round implants without an intensity plateau, a humeral tray
// overlapping the glenosphere so that all the metal forms one body, burned-in side markers, clothing clasps.
//
// Classical image analysis only — no model, no network. The chain is
//   1. metal mask      the brightest solid body, at the threshold where its area is most stable
//   2. stem            traced upward from the lowest metal point: axis, tip, width profile
//   3. circle          the glenosphere dome or prosthetic head: the best-supported convex arc of the metal outline
//   4. implant type    metal beyond the circle on the side away from the stem (baseplate, screws) = reverse
//   5. landmarks       implant landmarks are measured; bony landmarks are placed from anatomical proportions
//                      relative to the implant and then snapped to the nearest matching bone edge where one is found
// Everything bony is returned with confidence < 0.8: it is a starting position for the reader, not a measurement.
//
// Image convention: { width, height, data }, higher = more attenuating. Coordinates returned are full-resolution
// pixels (x right, y down).
import { downsample, gaussianBlur, connectedComponents, distanceTransformSq, percentiles, fitCircle, fitLine, median } from './image.js';
import { frames as learnedFrames, placeLearned } from './learned.js';
import MODEL from './model.json' with { type: 'json' };

const WORK = 640;                    // working size of the shorter image side
const BONY = 0.45, PRIOR = 0.3;      // confidence of a snapped / proportion-only bony landmark

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ───────────────────────────── 1. preparation and metal ─────────────────────────────
function prepare(img) {
  const f = Math.max(1, Math.round(Math.min(img.width, img.height) / WORK));
  const ds = downsample(img, f);
  const w = ds.width, h = ds.height, n = w * h, u = ds.data;
  const [lo, hi] = percentiles(u, [0.5, 99.95]);
  const span = hi - lo > 0 ? hi - lo : 1;
  for (let i = 0; i < n; i++) { const t = (u[i] - lo) / span; u[i] = t < 0 ? 0 : t > 1 ? 1 : t; }
  peelMargins(u, w, h);
  const ub = gaussianBlur(u, w, h, 1.1);
  return { f, w, h, n, u, ub, flat: !(hi - lo > 0) };
}

/**
 * Published figures and screenshots carry uniform margins — a white page background, a frame line, black canvas.
 * Peel rows and columns off each edge while they are uniform and set them to 0 (canvas), so that nothing touching
 * the margin is mistaken for part of the film (a white margin is as bright and flat as metal).
 */
function peelMargins(u, w, h) {
  const uniform = (get, len) => {
    let s = 0, s2 = 0;
    for (let k = 0; k < len; k++) { const v = get(k); s += v; s2 += v * v; }
    const m = s / len;
    return Math.sqrt(Math.max(0, s2 / len - m * m)) < 0.025;
  };
  const maxPeel = (len) => Math.floor(0.25 * len);
  let top = 0, bot = 0, left = 0, right = 0;
  // repeat: peeling one side can make the next row/column of another side uniform
  for (let pass = 0; pass < 3; pass++) {
    const x0 = left, x1 = w - right, y0 = top, y1 = h - bot;
    while (top < maxPeel(h) && uniform((k) => u[top * w + x0 + k], x1 - x0)) top++;
    while (bot < maxPeel(h) && uniform((k) => u[(h - 1 - bot) * w + x0 + k], x1 - x0)) bot++;
    while (left < maxPeel(w) && uniform((k) => u[(y0 + k) * w + left], y1 - y0)) left++;
    while (right < maxPeel(w) && uniform((k) => u[(y0 + k) * w + w - 1 - right], y1 - y0)) right++;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y < top || y >= h - bot || x < left || x >= w - right) u[y * w + x] = 0;
  }
}

/** Metal = components grown from solid, near-maximal cores, at the threshold where their area changes least. */
function metalMask(P, log = () => {}) {
  const { ub, w, h, n } = P;
  const top = new Uint8Array(n);
  for (let i = 0; i < n; i++) top[i] = ub[i] >= 0.86 ? 1 : 0;
  const depth = distanceTransformSq(top, w, h, 0);
  const rc = Math.max(2, 0.006 * Math.min(w, h));
  const seeds = [];
  for (let i = 0; i < n; i++) if (depth[i] >= rc * rc) seeds.push(i);
  if (seeds.length < 12) { log(`only ${seeds.length} seed pixels`); return null; }
  const Ts = [];
  for (let T = 0.9; T >= 0.399; T -= 0.02) Ts.push(+T.toFixed(2));
  const grown = (T) => {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = ub[i] >= T ? 1 : 0;
    const cc = connectedComponents(m, w, h, 8);
    const keep = new Uint8Array(cc.count + 1);
    for (const s of seeds) keep[cc.labels[s]] = 1;
    let area = 0;
    for (let k = 1; k <= cc.count; k++) if (keep[k]) area += cc.stats[k].area;
    return { cc, keep, area };
  };
  const A = Ts.map((T) => grown(T).area);
  // relative growth across ±2 steps; the lowest threshold that is still (nearly) as stable as the best one
  let gmin = Infinity;
  const g = Ts.map((T, i) => {
    if (i < 2 || i > Ts.length - 3 || T > 0.86 || T < 0.46) return Infinity;
    const v = (A[i + 2] - A[i - 2]) / Math.max(1, A[i]);
    if (v < gmin) gmin = v;
    return v;
  });
  log(`seeds ${seeds.length}; areas ${Ts.map((T, i) => `${T}:${A[i]}`).join(' ')}; gmin ${gmin.toFixed(3)}`);
  // The implant is the FIRST stable plateau met coming down from the top. (Lower down there is usually an even
  // flatter one — the whole bone-and-soft-tissue silhouette — which is not what we want.) Walk down that plateau
  // as far as it stays stable and has not grown by more than a quarter, to take in the dimmer rim of a round implant.
  let i0 = -1;
  for (let i = 0; i < Ts.length; i++) if (g[i] < 0.2) { i0 = i; break; }
  if (i0 < 0 || Ts[i0] < 0.6) return null;         // no stable bright body: dense bone just grows steadily
  let pick = i0;
  while (pick + 1 < Ts.length && g[pick + 1] < 0.2 && A[pick + 1] <= 1.25 * A[i0]) pick++;
  gmin = g[pick];
  const T = Ts[pick];
  const { cc, keep } = grown(T);
  // drop small satellites (side markers, clips): keep bodies of at least 5% of the largest
  let big = 0;
  for (let k = 1; k <= cc.count; k++) if (keep[k] && cc.stats[k].area > big) big = cc.stats[k].area;
  const mask = new Uint8Array(n);
  let area = 0, main = 0;
  for (let k = 1; k <= cc.count; k++) { if (keep[k] && cc.stats[k].area < 0.05 * big) keep[k] = 0; if (keep[k] && cc.stats[k].area === big) main = k; }
  for (let i = 0; i < n; i++) if (keep[cc.labels[i]]) { mask[i] = 1; area++; }
  // the field of view (anything that is not black canvas), for a meaningful metal fraction
  let field = 0;
  for (let i = 0; i < n; i++) if (ub[i] > 0.03) field++;
  const frac = area / Math.max(1, field);
  if (frac < 0.002 || frac > 0.45) return null;
  // Metal or dense bone? An implant has a hard edge: one or two pixels inside its outline it is already nearly as
  // bright as in its core (rim/core 0.9 or more on the real films and the phantoms). A dense bone at a threshold fades towards its
  // outline (rim/core 0.65 on the native phantom that passed the stability test).
  const dm = distanceTransformSq(mask, w, h, 0);
  let dmax = 0;
  for (let i = 0; i < n; i++) if (dm[i] > dmax) dmax = dm[i];
  let core = 0, cN = 0, rim = 0, rN = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    if (dm[i] >= 0.36 * dmax) { core += ub[i]; cN++; } else if (dm[i] >= 4 && dm[i] <= 16) { rim += ub[i]; rN++; }     // 2–4 px inside the outline
  }
  core /= Math.max(1, cN); rim /= Math.max(1, rN);
  log(`metal candidate T ${T}: core ${core.toFixed(3)} rim ${rim.toFixed(3)}`);
  if (core < 0.78 || rim < 0.86 * core) return null;
  return { mask, T, area, fraction: frac, labels: cc.labels, main, stability: gmin };
}

function boxMean(a, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h), d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t[row + x] = s / d;
      s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      o[y * w + x] = s / d;
      s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
    }
  }
  return o;
}

/**
 * Metal on display-processed films, where it is grey rather than white and need not be the brightest thing:
 * seed from regions that are bright AND flat (no trabecular texture), keep those bounded by a hard edge (metal
 * steps sharply to its surroundings; smooth soft tissue fades), and grow each at the midpoint between its own
 * brightness and that of its surroundings.
 */
function flatMetalMask(P, log = () => {}) {
  const { u, ub, w, h, n } = P;
  const r = Math.max(2, Math.round(Math.min(w, h) / 160));
  const u2 = new Float32Array(n);
  for (let i = 0; i < n; i++) u2[i] = u[i] * u[i];
  const m1 = boxMean(u, w, h, r), m2 = boxMean(u2, w, h, r);
  const field = [];
  for (let i = 0; i < n; i++) if (u[i] > 0.03) field.push(i);
  if (field.length < 0.05 * n) return null;
  const fu = new Float32Array(field.length), fs = new Float32Array(field.length);
  field.forEach((i, k) => { fu[k] = m1[i]; fs[k] = Math.sqrt(Math.max(0, m2[i] - m1[i] * m1[i])); });
  const [q80] = percentiles(fu, [80]);
  const [s50] = percentiles(fs, [50]);
  const fb = new Uint8Array(n);
  const sdMax = Math.max(0.012, 0.6 * s50);
  for (const i of field) if (m1[i] >= q80 && Math.sqrt(Math.max(0, m2[i] - m1[i] * m1[i])) <= sdMax) fb[i] = 1;
  const cc = connectedComponents(fb, w, h, 8);
  const minArea = 0.0015 * field.length;
  const gx = (i) => ub[i + 1] - ub[i - 1], gy = (i) => ub[i + w] - ub[i - w];
  const mask = new Uint8Array(n);
  const labels = new Int32Array(n);
  let kept = 0, area = 0, main = 0, mainArea = 0;
  for (let k = 1; k <= cc.count; k++) {
    const st = cc.stats[k];
    if (st.area < minArea) continue;
    const b = st.border;
    if (b.left > 0.3 * h || b.right > 0.3 * h || b.top > 0.3 * w || b.bottom > 0.3 * w) continue;
    // inside level and the level of a ring 3–8 px outside the component
    const comp = new Uint8Array(n);
    let ins = [];
    for (let y = st.minY; y <= st.maxY; y++) for (let x = st.minX; x <= st.maxX; x++) { const i = y * w + x; if (cc.labels[i] === k) { comp[i] = 1; ins.push(u[i]); } }
    const dOut = distanceTransformSq(comp, w, h, 1);
    const ring = [];
    const x0 = Math.max(1, st.minX - 9), x1 = Math.min(w - 2, st.maxX + 9), y0 = Math.max(1, st.minY - 9), y1 = Math.min(h - 2, st.maxY + 9);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * w + x; if (dOut[i] >= 9 && dOut[i] <= 64 && u[i] > 0.03) ring.push(u[i]); }
    if (ring.length < 20) continue;
    ins = Float32Array.from(ins); const Im = percentiles(ins, [50])[0], Io = percentiles(Float32Array.from(ring), [50])[0];
    const c = Im - Io;
    if (c < (globalThis.__FLAT_C ?? 0.1)) { log(`flat comp ${k} (${st.cx.toFixed(0)},${st.cy.toFixed(0)}) area ${st.area} low contrast ${c.toFixed(3)}`); continue; }
    // grow at the midpoint; reject if it floods (then the "edge" was not an edge)
    const T = Io + 0.5 * c;
    const grown = new Uint8Array(n), stack = [];
    for (let y = st.minY; y <= st.maxY; y++) for (let x = st.minX; x <= st.maxX; x++) { const i = y * w + x; if (comp[i] && ub[i] >= T) { grown[i] = 1; stack.push(i); } }
    let ga = stack.length;
    while (stack.length && ga <= 4 * st.area) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= n || grown[j] || ub[j] < T) continue;
        const xj = j % w; if (Math.abs(xj - x) > 1 || y < 1 || y > h - 2) continue;
        grown[j] = 1; ga++; stack.push(j);
      }
    }
    if (ga > 4 * st.area) { log(`flat comp ${k} (${st.cx.toFixed(0)},${st.cy.toFixed(0)}) floods at T ${T.toFixed(2)}`); continue; }
    // edge hardness: mean gradient across the grown outline, relative to the contrast (a 1–2 px step gives ≥ 0.25)
    let gs = 0, gn = 0;
    for (let i = w + 1; i < n - w - 1; i++) {
      if (!grown[i] || (grown[i - 1] && grown[i + 1] && grown[i - w] && grown[i + w])) continue;
      gs += Math.hypot(gx(i), gy(i)) / 2; gn++;
    }
    const hard = gn ? gs / gn / c : 0;
    log(`flat comp ${k} (${st.cx.toFixed(0)},${st.cy.toFixed(0)}) area ${st.area}→${ga} in ${Im.toFixed(2)} out ${Io.toFixed(2)} hardness ${hard.toFixed(2)}`);
    if (hard < (globalThis.__FLAT_H ?? 0.22)) continue;
    kept++;
    for (let i = 0; i < n; i++) if (grown[i] && !mask[i]) { mask[i] = 1; labels[i] = kept; area++; }
    if (ga > mainArea) { mainArea = ga; main = kept; }
  }
  if (!kept) return null;
  let fieldN = field.length;
  const frac = area / Math.max(1, fieldN);
  if (frac < 0.002 || frac > 0.45) return null;
  log(`flat metal: ${kept} bodies, fraction ${frac.toFixed(3)}`);
  return { mask, T: 0, area, fraction: frac, labels, main, stability: 0, flat: true };
}

/**
 * Metal as the large, bright object with a crisp outline. Works on display-processed and JPEG films where the metal
 * has no brightness plateau and need not be the brightest thing (annotation arrows and side markers often are).
 *   1. seeds: regions that are bright (top 15% of the field) and flat (no trabecular texture);
 *   2. for each seed, scan the threshold downward and measure the share of the region's outline that lies on a crisp
 *      edge (≥ 3% of the intensity range per pixel); metal has a threshold at which nearly all of it does;
 *   3. take the lowest threshold still near that peak (to include the dimmer rim of a round implant);
 *   4. keep objects much brighter than their surroundings; the implant is the largest, satellites under 5% of it
 *      (markers, arrows, clips) are dropped.
 */
function crispMetalMask(P, log = () => {}) {
  const { u, ub, w, h, n } = P;
  const r = Math.max(2, Math.round(Math.min(w, h) / 160));
  const u2 = new Float32Array(n);
  for (let i = 0; i < n; i++) u2[i] = u[i] * u[i];
  const m1 = boxMean(u, w, h, r), m2 = boxMean(u2, w, h, r);
  const field = [];
  for (let i = 0; i < n; i++) if (u[i] > 0.03) field.push(i);
  if (field.length < 0.05 * n) return null;
  const sdOf = (i) => Math.sqrt(Math.max(0, m2[i] - m1[i] * m1[i]));
  const [q85] = percentiles(Float32Array.from(field, (i) => m1[i]), [85]);
  const [s50] = percentiles(Float32Array.from(field, (i) => sdOf(i)), [50]);
  const sdMax = Math.max(0.012, 0.6 * s50);
  const fb = new Uint8Array(n);
  for (const i of field) if (m1[i] >= q85 && sdOf(i) <= sdMax) fb[i] = 1;
  const cc = connectedComponents(fb, w, h, 8);
  const minSeed = 0.0008 * field.length;
  const seeds = [];
  for (let k = 1; k <= cc.count; k++) {
    const st = cc.stats[k];
    if (st.area < minSeed) continue;
    const b = st.border;
    if (b.left > 0.3 * h || b.right > 0.3 * h || b.top > 0.3 * w || b.bottom > 0.3 * w) continue;
    let px = -1, best = -Infinity, sum = 0;
    for (let y = st.minY; y <= st.maxY; y++) for (let x = st.minX; x <= st.maxX; x++) {
      const i = y * w + x;
      if (cc.labels[i] !== k) continue;
      sum += ub[i];
      const v = m1[i] - 3 * sdOf(i);
      if (v > best) { best = v; px = i; }
    }
    seeds.push({ px, level: sum / st.area, curve: [] });
  }
  if (!seeds.length) return null;
  // outline pixels next to the black canvas do not count: the arm against the canvas is a crisp edge too
  const nearCanvas = new Uint8Array(n);
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
    const i = y * w + x;
    if (u[i - 3] <= 0.03 || u[i + 3] <= 0.03 || u[i - 3 * w] <= 0.03 || u[i + 3 * w] <= 0.03) nearCanvas[i] = 1;
  }
  const G = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; G[i] = Math.hypot(ub[i + 1] - ub[i - 1], ub[i + w] - ub[i - w]) / 2; }
  const top = Math.max(...seeds.map((q) => q.level));
  const Ts = [];
  for (let T = Math.min(0.99, top - 0.01); T >= 0.3; T -= 0.02) Ts.push(+T.toFixed(3));
  const m = new Uint8Array(n);
  for (const T of Ts) {
    for (let i = 0; i < n; i++) m[i] = ub[i] >= T ? 1 : 0;
    const c2 = connectedComponents(m, w, h, 8);
    const out = new Float64Array(c2.count + 1), crisp = new Float64Array(c2.count + 1);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!m[i] || (m[i - 1] && m[i + 1] && m[i - w] && m[i + w]) || nearCanvas[i]) continue;
      const l = c2.labels[i];
      out[l]++; if (G[i] >= 0.03) crisp[l]++;
    }
    for (const q of seeds) {
      if (T > q.level - 0.01 || q.done) continue;
      const l = c2.labels[q.px];
      if (!l) continue;
      const A = c2.stats[l].area;
      if (A > 0.6 * field.length) { q.done = true; continue; }
      q.curve.push({ T, A, f: out[l] > 8 ? crisp[l] / out[l] : 0 });
    }
  }
  const objs = [];
  for (const q of seeds) {
    const c = q.curve;
    if (c.length < 3) continue;
    const fs = c.map((x, i) => (c[Math.max(0, i - 1)].f + 2 * x.f + c[Math.min(c.length - 1, i + 1)].f) / 4);
    let bi = 0;
    for (let i = 1; i < c.length; i++) if (fs[i] > fs[bi]) bi = i;
    if (fs[bi] < 0.62) continue;
    let j = bi;
    while (j + 1 < c.length && fs[j + 1] >= fs[bi] - 0.06 && c[j + 1].A <= 1.35 * c[bi].A) j++;
    objs.push({ px: q.px, T: c[j].T, A: c[j].A, f: +fs[bi].toFixed(2), level: q.level });
  }
  if (!objs.length) { log('crisp: no seed reaches a crisp outline'); return null; }
  // Build each object's region at its own threshold, independently.
  const regions = [];
  for (const o of objs) {
    const reg = [], stack = [o.px], seen = new Uint8Array(n);
    seen[o.px] = 1;
    while (stack.length) {
      const i = stack.pop(); reg.push(i);
      const x = i % w;
      for (const j of [i - 1, i + 1, i - w, i + w, i - w - 1, i - w + 1, i + w - 1, i + w + 1]) {
        if (j < 0 || j >= n || seen[j] || ub[j] < o.T) continue;
        if (Math.abs((j % w) - x) > 1) continue;
        seen[j] = 1; stack.push(j);
      }
    }
    // a region running along the image border is a figure frame, a white margin or the edge of the field
    let onEdge = 0;
    for (const i of reg) { const x = i % w, y = (i - x) / w; if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) onEdge++; }
    if (onEdge > 0.15 * (w + h)) { log(`crisp object at T ${o.T}: runs along the image border (${onEdge} px) — frame or margin, skipped`); continue; }
    const reg8 = new Uint8Array(n); for (const i of reg) reg8[i] = 1;
    const dOut = distanceTransformSq(reg8, w, h, 1);
    const ring = [];
    for (let i = 0; i < n; i++) if (dOut[i] >= 9 && dOut[i] <= 64 && u[i] > 0.03) ring.push(u[i]);
    const Im = percentiles(Float32Array.from(reg, (i) => u[i]), [50])[0], Io = ring.length ? percentiles(Float32Array.from(ring), [50])[0] : 0;
    log(`crisp object at T ${o.T}: area ${reg.length} (${(reg.length / field.length * 100).toFixed(2)}%), outline crisp ${o.f}, inside ${Im.toFixed(2)} outside ${Io.toFixed(2)}`);
    if (Im - Io < 0.12) continue;
    // interior structure: share of pixels at least 3 px inside that sit in textured (non-flat) surroundings, and the
    // spread of brightness inside relative to the contrast with the surroundings
    const dIn = distanceTransformSq(reg8, w, h, 0);
    let tex = 0, deep = 0;
    const inner = [];
    for (const i of reg) if (dIn[i] >= 9) { deep++; inner.push(u[i]); if (sdOf(i) > sdMax) tex++; }
    const [p10, p90] = inner.length ? percentiles(Float32Array.from(inner), [10, 90]) : [0, 0];
    const texture = deep ? tex / deep : 1, spread = (p90 - p10) / Math.max(0.05, Im - Io);
    log(`    interior: textured ${texture.toFixed(2)}, spread ${spread.toFixed(2)}`);
    // Metal is uniform inside (spread 0.02–0.45 on real films and phantoms); bone, and metal leaked into bone, is not
    // (0.9–1.9 on real native films).
    if (spread > 0.55) continue;
    regions.push({ reg, set: reg8, area: reg.length, Im, f: o.f, texture, spread });
  }
  // Metal sits inside bone, never the other way round: a region that contains a markedly brighter region is bone.
  // Regions that are (nearly) the same object are merged into the larger.
  const drop = new Set();
  for (const A of regions) for (const B of regions) {
    if (A === B || drop.has(A) || drop.has(B)) continue;
    let ov = 0;
    for (const i of B.reg) if (A.set[i]) ov++;
    if (ov < 0.85 * B.area) continue;                                   // B is not inside A
    if (A.area <= 1.3 * B.area) { drop.add(A.f > B.f ? B : A); continue; }   // the same object seen from two seeds
    // A is much larger. It is bone (or metal leaked into bone) if the region inside it is markedly brighter or has
    // a crisper outline; otherwise B is just the brighter part of a shaded implant and A is the whole implant.
    if (B.Im >= A.Im + 0.12 || B.f > A.f + 0.1) { drop.add(A); log(`  region of ${A.area} px contains a brighter or crisper one: bone, dropped`); }
    else drop.add(B);
  }
  for (let k = regions.length - 1; k >= 0; k--) if (drop.has(regions[k])) regions.splice(k, 1);
  if (!regions.length) return null;
  const mask = new Uint8Array(n), labels = new Int32Array(n);
  regions.sort((a, b) => b.area - a.area);
  const big = regions[0].area;
  let area = 0, lab = 0;
  for (const g of regions) {
    if (g.area < 0.12 * big) continue;
    lab++;
    for (const i of g.reg) { mask[i] = 1; labels[i] = lab; area++; }
  }
  const frac = area / field.length;
  if (big < 0.003 * field.length || frac > 0.6) { log(`crisp: implant too small or too large (${(frac * 100).toFixed(2)}%)`); return null; }
  log(`crisp metal: ${lab} bodies, fraction ${frac.toFixed(3)}`);
  return { mask, T: 0, area, fraction: frac, labels, main: 1, stability: 0, crisp: true };
}

/**
 * Metal by marker-controlled watershed on the gradient image. Works where the metal is barely brighter than the
 * tissue beside it (heavily processed journal figures) but its outline is still a crisp edge.
 *   markers: each flat, bright region is a candidate (its own label); dark or textured pixels are background
 *   (metal is never textured). Flooding in order of gradient puts every boundary on the strongest edge between
 *   markers. Each candidate region is then judged on its own: a crisp outline, uniform inside, brighter than its
 *   surroundings, not hugging the border. Accepted regions that touch merge into one implant.
 */
function watershedMetal(P, log = () => {}) {
  const { u, ub, w, h, n } = P;
  const r = Math.max(2, Math.round(Math.min(w, h) / 160));
  const u2 = new Float32Array(n);
  for (let i = 0; i < n; i++) u2[i] = u[i] * u[i];
  const m1 = boxMean(u, w, h, r), m2 = boxMean(u2, w, h, r);
  const sdOf = (i) => Math.sqrt(Math.max(0, m2[i] - m1[i] * m1[i]));
  const field = [];
  for (let i = 0; i < n; i++) if (u[i] > 0.03) field.push(i);
  if (field.length < 0.05 * n) return null;
  const [q50, q85] = percentiles(Float32Array.from(field, (i) => m1[i]), [50, 85]);
  const [s50] = percentiles(Float32Array.from(field, (i) => sdOf(i)), [50]);
  const sdMax = Math.max(0.012, 0.6 * s50);
  const fb = new Uint8Array(n);
  for (const i of field) if (m1[i] >= q85 && sdOf(i) <= sdMax) fb[i] = 1;
  const cc = connectedComponents(fb, w, h, 8);
  const minSeed = 0.0008 * field.length;
  const lab = new Int32Array(n);          // 0 unassigned, -1 background, k candidate
  const cands = [null];
  for (let k = 1; k <= cc.count; k++) {
    const st = cc.stats[k];
    if (st.area < minSeed) continue;
    cands.push({ k, area0: st.area });
  }
  if (cands.length < 2) return null;
  const idOf = new Int32Array(cc.count + 1);
  cands.forEach((c, j) => { if (c) idOf[c.k] = j; });
  for (let i = 0; i < n; i++) if (cc.labels[i] && idOf[cc.labels[i]]) lab[i] = idOf[cc.labels[i]];
  // gradient, quantised for a bucket queue
  const G = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; G[i] = Math.hypot(ub[i + 1] - ub[i - 1], ub[i + w] - ub[i - w]) / 2; }
  // Background markers: dark pixels, and textured pixels away from strong edges (next to an edge the local
  // spread is high because of the edge itself, which would plant background just inside the metal rim).
  const edge = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (G[i] >= 0.025) edge[i] = 1;
  const nearEdge = distanceTransformSq(edge, w, h, 1);
  const rr = (r + 2) * (r + 2);
  for (let i = 0; i < n; i++) {
    if (lab[i]) continue;
    if (u[i] <= 0.03 || m1[i] < q50 || (sdOf(i) > 2.5 * sdMax && nearEdge[i] > rr)) lab[i] = -1;
  }
  const NB = 512, gq = (g) => Math.min(NB - 1, Math.floor(g * 4 * NB));
  const buckets = Array.from({ length: NB }, () => []);
  const queued = new Uint8Array(n);
  const push = (j) => { if (!queued[j] && !lab[j]) { queued[j] = 1; buckets[gq(G[j])].push(j); } };
  const nbrs = (i, f) => { const x = i % w; if (x > 0) f(i - 1); if (x < w - 1) f(i + 1); if (i >= w) f(i - w); if (i < n - w) f(i + w); };
  for (let i = 0; i < n; i++) if (lab[i]) nbrs(i, push);
  for (let b = 0; b < NB; b++) {
    const q = buckets[b];
    while (q.length) {
      const i = q.pop();
      // take the label of the neighbour already flooded (first found; ties are rare and harmless)
      let L = 0;
      nbrs(i, (j) => { if (!L && lab[j]) L = lab[j]; });
      lab[i] = L || -1;
      nbrs(i, (j) => { if (!lab[j] && !queued[j]) { queued[j] = 1; const bb = gq(G[j]); (bb < b ? q : buckets[bb]).push(j); } });
    }
  }
  if (globalThis.__WS_DEBUG) globalThis.__WS_DEBUG({ lab, w, h, u, G });
  // judge each candidate region
  const stats = cands.map(() => ({ A: 0, out: 0, crisp: 0, sumG: 0, edge: 0, ins: [] }));
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, L = lab[i];
    if (L <= 0) continue;
    const S = stats[L];
    S.A++;
    if (x <= 2 || y <= 2 || x >= w - 3 || y >= h - 3) S.edge++;
    if (lab[i - 1] !== L || lab[i + 1] !== L || lab[i - w] !== L || lab[i + w] !== L) {
      S.out++; S.sumG += G[i]; if (G[i] >= 0.025) S.crisp++;
    } else if (S.ins.length < 40000) S.ins.push(u[i]);
  }
  const keep = new Uint8Array(cands.length);
  for (let j = 1; j < cands.length; j++) {
    const S = stats[j];
    if (S.A < 0.003 * field.length || S.out < 12) continue;
    const ins = Float32Array.from(S.ins);
    if (ins.length < 20) continue;
    const [p10, p50, p90] = percentiles(ins, [10, 50, 90]);
    // ring 3–6 px outside the region
    const reg = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (lab[i] === j) reg[i] = 1;
    const dOut = distanceTransformSq(reg, w, h, 1);
    const ring = [];
    for (let i = 0; i < n; i++) if (dOut[i] >= 9 && dOut[i] <= 36 && u[i] > 0.03) ring.push(u[i]);
    const Io = ring.length ? percentiles(Float32Array.from(ring), [50])[0] : 0;
    const c = p50 - Io, crisp = S.crisp / S.out, spread = (p90 - p10) / Math.max(0.05, c);
    const ok = crisp >= 0.55 && c >= 0.05 && spread <= 0.65 && S.edge < 0.15 * (w + h);
    log(`watershed region ${j}: area ${S.A} (${(S.A / field.length * 100).toFixed(2)}%), crisp ${crisp.toFixed(2)}, inside ${p50.toFixed(2)} outside ${Io.toFixed(2)}, spread ${spread.toFixed(2)}, border ${S.edge}${ok ? '  KEEP' : ''}`);
    if (ok) keep[j] = 1;
  }
  const mask = new Uint8Array(n);
  let area = 0;
  for (let i = 0; i < n; i++) if (lab[i] > 0 && keep[lab[i]]) { mask[i] = 1; area++; }
  if (!area) return null;
  const c2 = connectedComponents(mask, w, h, 8);
  let big = 0;
  for (let k = 1; k <= c2.count; k++) big = Math.max(big, c2.stats[k].area);
  const labels = new Int32Array(n);
  const order = c2.stats.slice(1).filter((st) => st.area >= 0.12 * big).sort((a, b) => b.area - a.area);
  const rank = new Int32Array(c2.count + 1);
  order.forEach((st, i) => { rank[st.label] = i + 1; });
  area = 0;
  for (let i = 0; i < n; i++) { if (mask[i] && rank[c2.labels[i]]) { labels[i] = rank[c2.labels[i]]; area++; } else mask[i] = 0; }
  const frac = area / field.length;
  if (big < 0.003 * field.length || frac > 0.6) return null;
  log(`watershed metal: ${order.length} bodies, fraction ${frac.toFixed(3)}`);
  return { mask, T: 0, area, fraction: frac, labels, main: 1, stability: 0, watershed: true };
}

/** Union of independently validated metal masks; bodies under 12% of the largest are dropped (markers, clips). */
function unionMasks(P, A, B, log = () => {}) {
  if (!A || !B) return A || B || null;
  const { w, h, n } = P;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = A.mask[i] | B.mask[i];
  const cc = connectedComponents(mask, w, h, 8);
  let big = 0;
  for (let k = 1; k <= cc.count; k++) big = Math.max(big, cc.stats[k].area);
  const order = cc.stats.slice(1).filter((st) => st.area >= 0.12 * big).sort((a, b) => b.area - a.area);
  const rank = new Int32Array(cc.count + 1);
  order.forEach((st, i) => { rank[st.label] = i + 1; });
  const labels = new Int32Array(n);
  let area = 0;
  for (let i = 0; i < n; i++) { if (mask[i] && rank[cc.labels[i]]) { labels[i] = rank[cc.labels[i]]; area++; } else mask[i] = 0; }
  const fraction = area * (A.fraction / Math.max(1, A.area));
  log(`union metal: ${order.length} bodies, ${area} px`);
  return { mask, T: 0, area, fraction, labels, main: 1, stability: 0, union: true };
}

// ───────────────────────────── 2. stem ─────────────────────────────
/** Trace the stem from the lowest metal point upward. Returns axis (unit, pointing proximal), tip, proximal end, widths. */
function traceStem(P, M) {
  const { w, h, n } = P;
  // The stem is traced on the most elongated body (in a reverse the glenosphere with its screws can be the largest),
  // after a small opening that removes thin bright strips (cortex, wires) the mask may have run along.
  const body = stemBody(P, M);
  if (!body) return null;
  const k = Math.max(2, Math.round(0.005 * Math.min(w, h)));
  const dIn = distanceTransformSq(body, w, h, 0);
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = body[i] && dIn[i] >= k * k ? 1 : 0;
  const dCore = distanceTransformSq(core, w, h, 1);
  const opened = new Uint8Array(n);
  for (let i = 0; i < n; i++) opened[i] = body[i] && dCore[i] <= k * k ? 1 : 0;
  // keep the largest piece of the opened body
  const occ = connectedComponents(opened, w, h, 8);
  let bl = 0, ba = 0;
  for (let q = 1; q <= occ.count; q++) if (occ.stats[q].area > ba) { ba = occ.stats[q].area; bl = q; }
  const xs = [], ys = [];
  let ymax = -1, ymin = h, tx = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bl && occ.labels[y * w + x] === bl) { xs.push(x); ys.push(y); if (y > ymax) { ymax = y; tx = x; } if (y < ymin) ymin = y; }
  M.stemMask = (i) => bl && occ.labels[i] === bl;
  const H = ymax - ymin;
  if (xs.length < 60 || H < 12) return null;
  // initial direction: principal axis of the lowest quarter
  const sub = [];
  for (let i = 0; i < xs.length; i++) if (ys[i] >= ymax - 0.25 * H) sub.push(xs[i], ys[i]);
  let ln = fitLine(sub);
  if (!ln) return null;
  let d = ln.dy > 0 ? [-ln.dx, -ln.dy] : [ln.dx, ln.dy];           // pointing up (proximal)
  let o = [ln.px, ln.py];
  let prof = null, sEnd = 0, wd = 0, s0 = 0;
  for (let it = 0; it < 3; it++) {
    const nx = -d[1], ny = d[0];
    let smin = Infinity, smax = -Infinity;
    const S = new Float32Array(xs.length), Tt = new Float32Array(xs.length);
    for (let i = 0; i < xs.length; i++) { const rx = xs[i] - o[0], ry = ys[i] - o[1]; S[i] = rx * d[0] + ry * d[1]; Tt[i] = rx * nx + ry * ny; if (S[i] < smin) smin = S[i]; if (S[i] > smax) smax = S[i]; }
    const nb = Math.ceil(smax - smin) + 2;
    const tmin = new Float32Array(nb).fill(Infinity), tmax = new Float32Array(nb).fill(-Infinity);
    for (let i = 0; i < xs.length; i++) { const b = Math.round(S[i] - smin); if (Tt[i] < tmin[b]) tmin[b] = Tt[i]; if (Tt[i] > tmax[b]) tmax[b] = Tt[i]; }
    const width = (b) => (tmax[b] >= tmin[b] ? tmax[b] - tmin[b] + 1 : 0);
    // distal reference width: slices 15–50% of the way up the lowest quarter
    const q = Math.max(8, 0.25 * H);
    const ref = [];
    for (let b = Math.floor(0.15 * q); b <= Math.floor(0.5 * q) && b < nb; b++) if (width(b) > 0) ref.push(width(b));
    if (ref.length < 3) return null;
    wd = median(ref);
    // the stem ends where the metal becomes clearly wider than the distal stem and stays so
    // A tapered stem widens gradually and symmetrically, so the stem is taken to end where the metal either
    // more than doubles the distal width or shifts off the axis (the tray, the head or the metaphyseal body).
    let end = nb - 1;
    const off = (b) => Math.abs((tmin[b] + tmax[b]) / 2 - (tmin[Math.floor(0.3 * q)] + tmax[Math.floor(0.3 * q)]) / 2);
    for (let b = Math.floor(0.5 * q); b < nb - 3; b++) {
      const wide = width(b) > 2.1 * wd + 1 && width(b + 1) > 2.1 * wd + 1 && width(b + 2) > 2.1 * wd + 1;
      const skew = it > 0 && off(b) > 0.4 * wd + 1 && off(b + 1) > 0.4 * wd + 1 && off(b + 2) > 0.4 * wd + 1;
      if (wide || skew) { end = b - 1; break; }
    }
    const pts = [];
    for (let b = 2; b <= end; b++) {
      if (!width(b)) continue;
      const s = b + smin, t = (tmin[b] + tmax[b]) / 2;
      pts.push(o[0] + d[0] * s + nx * t, o[1] + d[1] * s + ny * t);
    }
    if (pts.length < 12) return null;
    const l2 = fitLine(pts);
    if (!l2) return null;
    prof = { tmin, tmax, smin, nb, nx, ny, o: o.slice(), d: d.slice() };
    sEnd = end; s0 = smin;
    o = [l2.px, l2.py];
    d = l2.dy > 0 ? [-l2.dx, -l2.dy] : [l2.dx, l2.dy];
  }
  // tip and proximal end on the final axis
  let lo = Infinity;
  for (let i = 0; i < xs.length; i++) { const s = (xs[i] - o[0]) * d[0] + (ys[i] - o[1]) * d[1]; if (s < lo) lo = s; }
  const len = sEnd;                                         // stem length in working px (from the tip)
  const tip = [o[0] + d[0] * lo, o[1] + d[1] * lo];
  const prox = [tip[0] + d[0] * len, tip[1] + d[1] * len];
  void tx; void s0;
  return { d, o, tip, prox, len, wd, prof, n: [-d[1], d[0]] };
}

/**
 * Text boxes, panel letters and scale-bar labels in published figures are flat, white and crisp like metal, but they
 * are near-perfect upright rectangles, which no implant is. Remove such bodies from the mask.
 */
function dropLabelBoxes(P, M, log = () => {}) {
  const { w, h, n } = P;
  const cc = connectedComponents(M.mask, w, h, 8);
  let removed = 0;
  for (let k = 1; k <= cc.count; k++) {
    const st = cc.stats[k];
    const bw = st.maxX - st.minX + 1, bh = st.maxY - st.minY + 1;
    // holes (the text inside a label) count as filled: flood the box's non-body pixels from its border
    const outside = new Uint8Array(bw * bh), stack = [];
    const inBody = (x, y) => cc.labels[(st.minY + y) * w + st.minX + x] === k;
    for (let x = 0; x < bw; x++) for (const y of [0, bh - 1]) if (!inBody(x, y) && !outside[y * bw + x]) { outside[y * bw + x] = 1; stack.push(y * bw + x); }
    for (let y = 0; y < bh; y++) for (const x of [0, bw - 1]) if (!inBody(x, y) && !outside[y * bw + x]) { outside[y * bw + x] = 1; stack.push(y * bw + x); }
    while (stack.length) {
      const q = stack.pop(), x = q % bw, y = (q - x) / bw;
      for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
        const j = yy * bw + xx;
        if (!outside[j] && !inBody(xx, yy)) { outside[j] = 1; stack.push(j); }
      }
    }
    let ext = 0;
    for (let q = 0; q < bw * bh; q++) ext += outside[q];
    const fillBox = (bw * bh - ext) / (bw * bh);
    if (fillBox < 0.9 || st.area < 30) continue;
    for (let i = 0; i < n; i++) if (cc.labels[i] === k) { M.mask[i] = 0; M.labels[i] = 0; }
    M.area -= st.area; removed++;
    log(`label box removed at (${st.cx.toFixed(0)},${st.cy.toFixed(0)}), ${bw}×${bh}, fills ${(fillBox * 100).toFixed(0)}% of its box`);
  }
  if (removed) {
    // the largest remaining body becomes the main one
    const areas = new Map();
    for (let i = 0; i < n; i++) if (M.mask[i]) areas.set(M.labels[i], (areas.get(M.labels[i]) || 0) + 1);
    let bl = 0, ba = 0;
    for (const [l, a] of areas) if (a > ba) { ba = a; bl = l; }
    M.main = bl;
  }
}

/** Mask of the metal body most likely to hold the stem: the most elongated of the larger bodies. */
function stemBody(P, M) {
  const { w, h, n } = P;
  const areas = new Map();
  for (let i = 0; i < n; i++) if (M.mask[i] && M.labels[i]) areas.set(M.labels[i], (areas.get(M.labels[i]) || 0) + 1);
  if (!areas.size) return null;
  const big = Math.max(...areas.values());
  let best = 0, bv = -1;
  for (const [l, a] of areas) {
    if (a < 0.2 * big) continue;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) if (M.labels[i] === l && M.mask[i]) { const x = i % w, y = (i - x) / w; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
    const cx = sx / a, cy = sy / a, mxx = sxx / a - cx * cx, mxy = sxy / a - cx * cy, myy = syy / a - cy * cy;
    const tr = mxx + myy, det = mxx * myy - mxy * mxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
    const v = Math.sqrt(l1) * Math.sqrt(l1 / l2);        // long and thin
    if (v > bv) { bv = v; best = l; }
  }
  const body = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (M.labels[i] === best && M.mask[i]) body[i] = 1;
  return body;
}

/** Metal edges across the stem at distance s from the tip (working px), by walking out from the axis. */
function stemSection(P, M, stem, s) {
  const { w, h } = P;
  const c = [stem.tip[0] + stem.d[0] * s, stem.tip[1] + stem.d[1] * s];
  const inM = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < w && y < h && M.mask[y * w + x]; };
  if (!inM(c[0], c[1])) return null;
  const walk = (sg) => { let t = 0; while (t < 4 * stem.wd && inM(c[0] + sg * stem.n[0] * (t + 0.5), c[1] + sg * stem.n[1] * (t + 0.5))) t += 0.5; return [c[0] + sg * stem.n[0] * t, c[1] + sg * stem.n[1] * t]; };
  const p = walk(1), q = walk(-1);
  return { a: p, b: q, width: Math.hypot(p[0] - q[0], p[1] - q[1]), c };
}

// ───────────────────────────── 3. circle ─────────────────────────────
function boundary(P, M) {
  const { w, h, n } = P;
  const mf = new Float32Array(n);
  for (let i = 0; i < n; i++) mf[i] = M.mask[i];
  const mb = gaussianBlur(mf, w, h, 1.6);
  const px = [], py = [], nx = [], ny = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!M.mask[i] || (M.mask[i - 1] && M.mask[i + 1] && M.mask[i - w] && M.mask[i + w])) continue;
      const gx = mb[i + 1] - mb[i - 1], gy = mb[i + w] - mb[i - w], g = Math.hypot(gx, gy);
      if (g < 1e-4) continue;
      px.push(x); py.push(y); nx.push(-gx / g); ny.push(-gy / g);       // outward normal
    }
  }
  return { px, py, nx, ny, n: px.length };
}

/** Angular coverage (2° bins) of a circle by outline points whose outward normal is radial. */
function coverage(B, cx, cy, r, tol) {
  const bins = new Uint8Array(180);
  const idx = [];
  for (let i = 0; i < B.n; i++) {
    const dx = B.px[i] - cx, dy = B.py[i] - cy, dd = Math.hypot(dx, dy);
    if (Math.abs(dd - r) > tol) continue;
    if ((dx * B.nx[i] + dy * B.ny[i]) < 0.8 * dd) continue;
    let a = Math.atan2(dy, dx) * 180 / Math.PI; if (a < 0) a += 360;
    bins[Math.min(179, Math.floor(a / 2))] = 1; idx.push(i);
  }
  let cov = 0;
  for (let k = 0; k < 180; k++) cov += bins[k];
  return { deg: cov * 2, bins, idx };
}

function fill(P, M, cx, cy, r) {
  const { w, h } = P;
  let inside = 0, tot = 0;
  const R = 0.8 * r;
  for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(h - 1, Math.ceil(cy + R)); y++) {
    for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(w - 1, Math.ceil(cx + R)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
      tot++; if (M.mask[y * w + x]) inside++;
    }
  }
  return tot ? inside / tot : 0;
}

/** Longest covered run of a circular 2°-bin coverage, bridging gaps of up to `gap` bins. Returns [startDeg, endDeg]. */
function longestArc(bins, gap = 5) {
  const N = bins.length;
  let best = null;
  for (let s = 0; s < N; s++) {
    if (!bins[s] || bins[(s + N - 1) % N]) continue;                     // start of a run
    let e = s, miss = 0, last = s;
    for (let k = 1; k < N; k++) {
      const j = (s + k) % N;
      if (bins[j]) { last = s + k; miss = 0; } else if (++miss > gap) break;
      e = s + k;
    }
    void e;
    if (!best || last - s > best[1] - best[0]) best = [s, last];
  }
  if (!best) { let any = false; for (let k = 0; k < N; k++) any = any || bins[k]; return any ? [0, N - 1].map((v) => v * 2) : null; }
  return [best[0] * 2, best[1] * 2 + 2];
}

function findCircle(P, M, stem, opts, log = () => {}) {
  const B = boundary(P, M);
  if (B.n < 40) return null;
  const mm = opts.mmPerPx ? opts.mmPerPx * P.f : 0;                       // mm per working px
  // Without a pixel size the stem is the ruler: a glenosphere or head radius is 1.1–3.4 distal stem widths.
  // Without a pixel size the stem is the ruler (a glenosphere or head radius is 1.1–3.4 distal stem widths), but the
  // distal width is over-read when the stem is short or cut off by the film, so the lower limit is generous and
  // bounded by the image.
  const short = Math.min(P.w, P.h);
  let rmin = mm ? 15 / mm : stem ? Math.min(0.75 * stem.wd, 0.06 * short) : 0.03 * short;
  let rmax = mm ? 29 / mm : stem ? Math.min(3.4 * stem.wd, 0.35 * short) : 0.2 * short;
  if (rmax < 2 * rmin) rmax = Math.min(0.35 * short, 2.5 * rmin);
  rmin = Math.max(5, rmin);
  const rng = mulberry32(977);
  const tol = Math.max(1.2, 0.035 * rmin);
  const cands = [];
  // three outline points at a time; the second and third are drawn near the first, because three points spread
  // over the whole implant almost never lie on the same arc
  const nearPick = (a) => {
    for (let t = 0; t < 24; t++) {
      const j = Math.floor(rng() * B.n);
      const d = Math.hypot(B.px[j] - B.px[a], B.py[j] - B.py[a]);
      if (d > 0.35 * rmin && d < 1.9 * rmax) return j;
    }
    return -1;
  };
  for (let it = 0; it < 6000; it++) {
    const a = Math.floor(rng() * B.n), b = nearPick(a), c = nearPick(a);
    if (b < 0 || c < 0 || b === c) continue;
    const ax = B.px[a], ay = B.py[a], bx = B.px[b], by = B.py[b], cx = B.px[c], cy = B.py[c];
    const dd = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(dd) < 1e-6) continue;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ox = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / dd, oy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / dd;
    const r = Math.hypot(ax - ox, ay - oy);
    if (r < rmin || r > rmax) continue;
    // the three samples must themselves lie on a convex metal outline
    if ((ax - ox) * B.nx[a] + (ay - oy) * B.ny[a] < 0.8 * r || (bx - ox) * B.nx[b] + (by - oy) * B.ny[b] < 0.8 * r || (cx - ox) * B.nx[c] + (cy - oy) * B.ny[c] < 0.8 * r) continue;
    const cov = coverage(B, ox, oy, r, tol);
    if (cov.deg < 70) continue;
    cands.push({ cx: ox, cy: oy, r, deg: cov.deg });
  }
  log(`outline ${B.n} px; radius ${rmin.toFixed(1)}–${rmax.toFixed(1)}; ${cands.length} candidates`);
  if (!cands.length) return null;
  cands.sort((p, q) => q.deg - p.deg);
  let best = null;
  const all = [];
  for (const c of cands.slice(0, 40)) {
    // least-squares polish on the supporting outline points, twice
    let cur = c;
    for (let k = 0; k < 2; k++) {
      const cov = coverage(B, cur.cx, cur.cy, cur.r, tol);
      const pts = [];
      for (const i of cov.idx) pts.push(B.px[i], B.py[i]);
      const fit = pts.length >= 16 ? fitCircle(pts) : null;
      if (fit && fit.r >= rmin * 0.9 && fit.r <= rmax * 1.1) cur = { cx: fit.cx, cy: fit.cy, r: fit.r };
    }
    const cov = coverage(B, cur.cx, cur.cy, cur.r, tol);
    const fl = fill(P, M, cur.cx, cur.cy, cur.r);
    if (fl < 0.7) continue;
    const arc = longestArc(cov.bins);
    const run = arc ? arc[1] - arc[0] : 0;
    // a long unbroken convex arc of a metal-filled disc — and not a small one: tray corners and collars are
    // round too, but a dome or head is at least about 1.6 distal stem widths in radius
    const score = run * fl * (stem ? Math.min(1, cur.r / (1.6 * stem.wd)) : 1);
    const cand = { cx: cur.cx, cy: cur.cy, r: cur.r, deg: cov.deg, run, fill: fl, arc, q: score };
    all.push(cand);
    if (!best || score > best.q) best = cand;
  }
  // distinct alternatives (centres more than half a radius apart), best first — the caller chooses among them
  all.sort((a, b) => b.q - a.q);
  const alts = [];
  for (const c of all) {
    if (c.run < 60) continue;
    if (alts.some((a) => Math.hypot(a.cx - c.cx, a.cy - c.cy) < 0.5 * Math.min(a.r, c.r))) continue;
    c.score = Math.max(0.3, Math.min(0.95, c.run / 190)) * Math.min(1, c.fill / 0.9);
    c.B = B;
    alts.push(c);
    if (alts.length >= 6) break;
  }
  log(`best circle ${best ? `(${best.cx.toFixed(0)},${best.cy.toFixed(0)}) r ${best.r.toFixed(1)} run ${best.run} cov ${best.deg} fill ${best.fill.toFixed(2)}` : 'none'}`);
  if (!alts.length) return null;
  return { ...alts[0], alts };
}

/**
 * Straight metal edge inside the circle that faces medially (against `axis`): returns its unit normal pointing
 * lateral, its signed distance medial of the centre, and its support, or null.
 */
function faceLine(B, C, R, axis, onDome = null) {
  const xs = [], ys = [];
  for (let i = 0; i < B.n; i++) {
    if (onDome && !onDome(B.px[i], B.py[i])) continue;
    const dx = B.px[i] - C[0], dy = B.py[i] - C[1], dd = Math.hypot(dx, dy);
    if (dd > 1.25 * R) continue;
    if (dd > 0.9 * R && (dx * B.nx[i] + dy * B.ny[i]) > 0.8 * dd) continue;      // on the dome arc itself
    if (B.nx[i] * axis[0] + B.ny[i] * axis[1] > -0.6) continue;                  // not facing medially
    if (dx * axis[0] + dy * axis[1] > 0.25 * R) continue;                        // lateral half: tray edges, not the face
    xs.push(B.px[i]); ys.push(B.py[i]);
  }
  const n = xs.length;
  if (n < 8) return null;
  const rng = mulberry32(4211);
  let best = null;
  for (let it = 0; it < 600; it++) {
    const a = Math.floor(rng() * n), b = Math.floor(rng() * n);
    const ux = xs[b] - xs[a], uy = ys[b] - ys[a], ul = Math.hypot(ux, uy);
    if (ul < 0.3 * R) continue;
    const nx = -uy / ul, ny = ux / ul;
    if (Math.abs(nx * axis[0] + ny * axis[1]) < 0.77) continue;                  // within 40° of the screw axis
    const idx = [];
    for (let i = 0; i < n; i++) if (Math.abs((xs[i] - xs[a]) * nx + (ys[i] - ys[a]) * ny) <= 1.0) idx.push(i);
    if (!best || idx.length > best.length) best = idx;
  }
  if (!best || best.length < Math.max(8, 0.3 * R)) return null;
  const pts = [];
  for (const i of best) pts.push(xs[i], ys[i]);
  const l = fitLine(pts);
  if (!l) return null;
  let nx = -l.dy, ny = l.dx;
  if (nx * axis[0] + ny * axis[1] < 0) { nx = -nx; ny = -ny; }
  return { nx, ny, d: (C[0] - l.px) * nx + (C[1] - l.py) * ny, n: best.length };
}

// ───────────────────────────── 5. edges ─────────────────────────────
/**
 * First bone edge along a ray: the first place where brightness rises by `step` over a few pixels. The ray stops at
 * metal and outside the image. Returns the distance from the start (working px) or null.
 */
function rayRise(P, M, x0, y0, dx, dy, len, step = 0.05, base = 0.03, sustain = 0) {
  const { ub, w, h } = P;
  const v = [];
  for (let i = 0; i <= len; i++) {
    const x = Math.round(x0 + dx * i), y = Math.round(y0 + dy * i);
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) break;
    if (M && M.near[y * w + x]) break;
    v.push(ub[y * w + x]);
  }
  for (let i = 3; i < v.length - 3; i++) {
    const before = (v[i - 3] + v[i - 2] + v[i - 1]) / 3, after = (v[i + 1] + v[i + 2] + v[i + 3]) / 3;
    if (before < base) continue;                          // black canvas or air: not tissue yet
    if (after - before >= step) {
      // bone stays bright behind its edge; a fat plane or skin fold is a thin line that falls away again
      if (sustain > 0) {
        let m = 0, k = 0;
        for (let j = i + 2; j <= i + 1 + sustain && j < v.length; j++) { m += v[j]; k++; }
        if (k < Math.min(4, sustain) || m / k - before < 0.75 * step) continue;
      }
      // settle on the steepest point of this rise
      let bi = i, bv = v[i + 1] - v[i - 1];
      for (let j = i + 1; j < Math.min(v.length - 1, i + 5); j++) { const g = v[j + 1] - v[j - 1]; if (g > bv) { bv = g; bi = j; } }
      return bi;
    }
  }
  return null;
}

function addNear(P, M) {
  // metal dilated by 2 px: rays must not read the bright halo of the implant as bone
  const { w, h, n } = P;
  const near = new Uint8Array(n);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    if (M.mask[i] || M.mask[i - 2] || M.mask[i + 2] || M.mask[i - 2 * w] || M.mask[i + 2 * w] || M.mask[i - w - 1] || M.mask[i - w + 1] || M.mask[i + w - 1] || M.mask[i + w + 1]) near[i] = 1;
  }
  M.near = near;
}

/**
 * Outer bone outline seen from the lateral side: for each row in [y0, y1], scan from far lateral towards the
 * implant and note the first bone edge. Returns [{x, y}] (rows without an edge are skipped).
 */
function lateralOutline(P, M, L, xFar, xStop, y0, y1, step, sustain = 0) {
  const out = [];
  const len = Math.abs(xFar - xStop);
  for (let y = Math.max(2, Math.round(y0)); y <= Math.min(P.h - 3, Math.round(y1)); y++) {
    const i = rayRise(P, M, xFar, y, -L, 0, len, step, 0.03, sustain);
    if (i !== null) out.push({ x: xFar - L * i, y });
  }
  return out;
}

// ───────────────────────────── landmarks ─────────────────────────────
const pt = (p, c) => ({ x: p[0], y: p[1], confidence: c });
const ln = (a, b, c) => ({ a, b, confidence: c });

function stemLandmarks(P, M, stem, out) {
  // stem and canal width lines at 30% and 85% of the way from the proximal end to the tip
  for (const [id, t] of [['M', 0.3], ['D', 0.85]]) {
    const s = stem.len * (1 - t);
    const sec = stemSection(P, M, stem, Math.max(2, s));
    if (!sec) continue;
    out[`stem${id}`] = ln(sec.a, sec.b, 0.9);
    // endosteal cortex on each side: first rise in brightness beyond the metal
    const ends = [];
    for (const [edge, sg] of [[sec.a, 1], [sec.b, -1]]) {
      const dir = [sg * stem.n[0], sg * stem.n[1]];
      const start = [edge[0] + dir[0] * 3, edge[1] + dir[1] * 3];
      const i = rayRise(P, null, start[0], start[1], dir[0], dir[1], Math.round(1.6 * stem.wd), 0.035);
      const dist = i !== null ? i : 0.45 * stem.wd;
      ends.push({ p: [start[0] + dir[0] * dist, start[1] + dir[1] * dist], found: i !== null });
    }
    out[`canal${id}`] = ln(ends[0].p, ends[1].p, ends[0].found && ends[1].found ? BONY : PRIOR);
  }
}

function reverseLandmarks(P, M, g, stem, L) {
  const out = {};
  const C = [g.cx, g.cy], R = g.r;
  const fa = g.face.a, fb = g.face.b;
  // glenoid rim: hidden by the baseplate, so taken just medial to the corners of the glenosphere face
  const igr = [fb[0] - L * 0.1 * R, fb[1] - 0.1 * R];
  const sgt = [fa[0] - L * 0.1 * R, fa[1] + 0.04 * R];
  out.igr = pt(igr, PRIOR); out.sgt = pt(sgt, PRIOR);
  // supraspinatus fossa floor: runs medially from the top of the glenoid, rising about 12°
  out.ssf = ln([sgt[0] - L * 2.2 * R, sgt[1] - 0.42 * R], [sgt[0] - L * 0.3 * R, sgt[1] - 0.02 * R], PRIOR);
  // humeral outline from the lateral side → greater tuberosity
  const xFar = C[0] + L * 3.5 * R, xStop = C[0];
  const hum = lateralOutline(P, M, L, xFar, xStop, C[1] - 0.9 * R, C[1] + 2.6 * R, 0.05, Math.round(0.14 * R)).filter((q) => (q.x - C[0]) * L > 0.5 * R && (q.x - C[0]) * L < 3.1 * R);
  let gts = null, gtl = null;
  if (hum.length >= 4) {
    // lateral-most point of the tuberosity: among rows no lower than 1.3 R below the centre (below that the
    // outline is the shaft)
    for (const q of hum) if (q.y <= C[1] + 1.3 * R && (!gtl || (q.x - gtl.x) * L > 0)) gtl = q;
    if (!gtl) gtl = hum[0];
    // top of the tuberosity: the highest outline point that belongs to the same contour as the lateral-most one
    const sorted = hum.slice().sort((a, b) => b.y - a.y).filter((q) => q.y <= gtl.y);
    let cur = gtl;
    for (const q of sorted) { if (cur.y - q.y <= 4 && Math.abs(q.x - cur.x) <= 0.45 * R) cur = q; }
    gts = cur;
  }
  if (gtl) out.gtl = pt([gtl.x, gtl.y], BONY); else out.gtl = pt([C[0] + L * 2.3 * R, C[1] + 0.9 * R], PRIOR);
  if (gts && gts !== gtl) out.gts = pt([gts.x, gts.y], BONY); else out.gts = pt([C[0] + L * 1.8 * R, C[1] - 0.1 * R], PRIOR);
  // acromion: the lateral-most bone above the tuberosity
  const yTop = Math.max(2, C[1] - 3.6 * R), yBot = Math.min(out.gts.y - 0.35 * R, C[1] - 1.05 * R);
  // start closer in than for the humerus: the skin edge lies further out and must not be taken for bone
  const acrOut = lateralOutline(P, M, L, C[0] + L * 2.3 * R, C[0] - L * 0.6 * R, yTop, yBot, 0.07, Math.round(0.25 * R));
  let acr = null;
  for (const q of acrOut) if (!acr || (q.x - acr.x) * L > 0) acr = q;
  if (acr && (acr.x - C[0]) * L > -0.3 * R) out.acr = pt([acr.x, acr.y], BONY);
  else out.acr = pt([C[0] + L * 1.0 * R, C[1] - 2.7 * R], PRIOR);
  // acromion undersurface: first bone going up, a little medial to the tip
  const ux = out.acr.x - L * 0.5 * R;
  const uy0 = Math.min(C[1] - R - 3, out.gts.y - 4);
  const iu = rayRise(P, M, ux, uy0, 0, -1, Math.round(3 * R), 0.05, 0.03, Math.round(0.12 * R));
  if (iu !== null && uy0 - iu > out.acr.y - 0.2 * R) out.acu = pt([ux, uy0 - iu], BONY);
  else out.acu = pt([ux, out.acr.y + 0.3 * R], PRIOR);
  if (stem) stemLandmarks(P, M, stem, out);
  return out;
}

function headLandmarks(P, M, c, stem, L, isImplant) {
  const out = {};
  const C = [c.cx, c.cy], R = c.r;
  const at = (lat, up) => [C[0] + L * lat * R, C[1] - up * R];
  // ends of the articular arc: lateral-superior end = cuff footprint edge, medial-inferior end = calcar
  if (isImplant) {
    let pB = at(0.5, 0.9), pC = at(-0.7, -0.75), cB = PRIOR, cC = PRIOR;
    if (c.arc) {
      const e = c.arc.map((a) => [C[0] + R * Math.cos(a * Math.PI / 180), C[1] + R * Math.sin(a * Math.PI / 180)]);
      const latness = (p) => (p[0] - C[0]) * L - (p[1] - C[1]);     // lateral and superior
      const [hi, lo] = latness(e[0]) > latness(e[1]) ? [e[0], e[1]] : [e[1], e[0]];
      if (Math.hypot(hi[0] - pB[0], hi[1] - pB[1]) < 0.9 * R) { pB = hi; cB = BONY; }
      if (Math.hypot(lo[0] - pC[0], lo[1] - pC[1]) < 0.9 * R) { pC = lo; cC = BONY; }
    }
    out.pcB = pt(pB, cB); out.pcC = pt(pC, cC);
  }
  // humeral outline from the lateral side: tuberosity top and lateral cortex
  const xFar = C[0] + L * 2.3 * R;
  const hum = lateralOutline(P, M, L, xFar, C[0] + L * 0.2 * R, C[1] - 1.2 * R, C[1] + 0.6 * R, 0.04, Math.round(0.1 * R)).filter((q) => (q.x - C[0]) * L > 0.45 * R && (q.x - C[0]) * L < 2.2 * R);
  let gtl = null, gts = null;
  for (const q of hum) if (q.y >= C[1] - 0.7 * R && (!gtl || (q.x - gtl.x) * L > 0)) gtl = q;
  if (gtl) {
    let cur = gtl;
    for (const q of hum.slice().sort((a, b) => b.y - a.y)) { if (q.y <= cur.y && cur.y - q.y <= 4 && Math.abs(q.x - cur.x) <= 0.45 * R) cur = q; }
    gts = cur;
  }
  const lat = gtl ? pt([gtl.x, gtl.y], BONY) : pt(at(1.05, 0.2), PRIOR);
  if (isImplant) out.pcA = lat; else out.gtl = lat;
  out.gts = gts && gts !== gtl ? pt([gts.x, gts.y], BONY) : pt(at(0.65, 1.05), PRIOR);
  // acromion undersurface: first bone above the top of the head
  const topX = C[0] + L * 0.15 * R, topY = C[1] - R - 3;
  const iu = rayRise(P, M, topX, topY, 0, -1, Math.round(1.6 * R), 0.035);
  out.acu = iu !== null ? pt([topX, topY - iu], BONY) : pt(at(0.15, 1.35), PRIOR);
  // glenoid rim: first bone edge medial to the head, above and below its centre
  for (const [id, up, pr] of [['sgt', 0.55, at(-1.08, 0.55)], ['igr', -0.6, at(-1.1, -0.6)]]) {
    const a = Math.atan2(-up, -L * 0.85);
    const dx = Math.cos(a), dy = Math.sin(a);
    const st = [C[0] + dx * (R + 3), C[1] + dy * (R + 3)];
    const i = rayRise(P, M, st[0], st[1], dx, dy, Math.round(0.7 * R), 0.035);
    out[id] = i !== null ? pt([st[0] + dx * i, st[1] + dy * i], BONY) : pt(pr, PRIOR);
  }
  if (!isImplant) {
    // lateral acromion and fossa floor for native shoulders
    const acrOut = lateralOutline(P, M, L, xFar, C[0] - L * 0.3 * R, C[1] - 2.4 * R, C[1] - 1.15 * R, 0.06, Math.round(0.2 * R));
    let acr = null;
    for (const q of acrOut) if (!acr || (q.x - acr.x) * L > 0) acr = q;
    out.acr = acr ? pt([acr.x, acr.y], BONY) : pt(at(0.75, 1.5), PRIOR);
    out.ssf = ln([out.sgt.x - L * 2.3 * R, out.sgt.y - 0.45 * R], [out.sgt.x - L * 0.3 * R, out.sgt.y - 0.03 * R], PRIOR);
  }
  if (stem) stemLandmarks(P, M, stem, out);
  return out;
}

// ───────────────────────────── main ─────────────────────────────
/**
 * @returns {null | { kind: 'reverse'|'hemi', confidence, side, metalFraction, reverse?, head?, stem?, estimates }}
 *   null when no implant is found (the caller then falls back to the native-shoulder path).
 */
export function autoLandmarks(img, opts = {}) {
  const P = prepare(img);
  if (P.flat) return null;
  const log = opts.trace || (() => {});
  let M;
  if (opts.metal === 'watershed') M = watershedMetal(P, log);
  else if (opts.metal === 'crisp') M = crispMetalMask(P, log);
  else M = unionMasks(P, crispMetalMask(P, log), watershedMetal(P, log), log);
  M = M || metalMask(P, log) || flatMetalMask(P, log);
  if (!M) { log('no metal'); return null; }
  addNear(P, M);
  dropLabelBoxes(P, M, log);
  if (!M.area) { log('only label boxes'); return null; }
  const stem = traceStem(P, M);
  if (opts.debug) Object.assign(opts.debug, { P, M, stem });
  log(`metal T ${M.T} fraction ${M.fraction.toFixed(3)} stability ${M.stability.toFixed(3)}; stem ${stem ? `wd ${stem.wd.toFixed(1)} len ${stem.len}` : 'none'}`);
  let circle = findCircle(P, M, stem, opts, log);
  if (circle && stem && circle.alts.length) {
    // Choose among the candidate circles with anatomy. Nothing valid sits along the stem (the rounded distal tip
    // is the usual impostor). A prosthetic head rides on the stem's proximal end, centred on its axis; a
    // glenosphere lies beyond it, about a radius off the axis, with baseplate and screws attached on its far side.
    let pick = null, pv = -1;
    for (const c of circle.alts) {
      const along = (c.cx - stem.tip[0]) * stem.d[0] + (c.cy - stem.tip[1]) * stem.d[1];
      const off = Math.abs((c.cx - stem.tip[0]) * stem.n[0] + (c.cy - stem.tip[1]) * stem.n[1]);
      if (along < 0.5 * stem.len) { log(`  circle (${c.cx.toFixed(0)},${c.cy.toFixed(0)}) r ${c.r.toFixed(0)} lies along the stem (${(along / stem.len).toFixed(2)} of its length): rejected`); continue; }
      if (off > 3 * c.r) { log(`  circle (${c.cx.toFixed(0)},${c.cy.toFixed(0)}) r ${c.r.toFixed(0)} is ${(off / c.r).toFixed(1)} R off the stem axis: rejected`); continue; }
      // a head riding on the stem is much larger than the stem is wide; a small round on the axis is a collar or taper
      if (off <= 0.8 * c.r && c.r < 1.3 * stem.wd) { log(`  circle (${c.cx.toFixed(0)},${c.cy.toFixed(0)}) r ${c.r.toFixed(0)} on the axis but smaller than a head: rejected`); continue; }
      let v = c.q * (along >= 0.75 * stem.len ? 1 : 0.6) * (off <= 2.6 * c.r ? 1 : 0.4);
      // the reader has told us what is implanted: a glenosphere lies beyond the stem and off its axis, a head on it
      if (opts.implant === 'reverse') v *= (along >= 0.9 * stem.len ? 1 : 0.3) * (off >= 0.5 * c.r ? 1 : 0.3);
      if (opts.implant === 'hemi') v *= off <= 0.9 * c.r ? 1 : 0.2;
      log(`  circle (${c.cx.toFixed(0)},${c.cy.toFixed(0)}) r ${c.r.toFixed(0)}: ${(along / stem.len).toFixed(2)} up the stem, ${(off / c.r).toFixed(2)} R off its axis, value ${v.toFixed(1)}`);
      if (v > pv) { pv = v; pick = c; }
    }
    circle = pick ? { ...pick, alts: circle.alts } : null;
  }
  if (!circle && stem && opts.headFinder) {
    // A head less dense than the stem (some pyrocarbon heads) is not part of the metal mask. Fall back to a
    // gradient-voted circle and accept it if it sits at the proximal end of the stem.
    const hc = opts.headFinder(img);
    if (hc) {
      const c = { cx: (hc.cx + 0.5) / P.f - 0.5, cy: (hc.cy + 0.5) / P.f - 0.5, r: hc.r / P.f };
      const along = (c.cx - stem.tip[0]) * stem.d[0] + (c.cy - stem.tip[1]) * stem.d[1];
      const off = Math.abs((c.cx - stem.tip[0]) * stem.n[0] + (c.cy - stem.tip[1]) * stem.n[1]);
      log(`fallback head circle (${c.cx.toFixed(0)},${c.cy.toFixed(0)}) r ${c.r.toFixed(1)}: ${along.toFixed(0)} px up the stem axis, ${off.toFixed(0)} px off it`);
      if (along > 0.6 * stem.len && off < 1.2 * c.r) circle = { ...c, score: Math.min(0.75, hc.score || 0.5), run: hc.arcDeg || 0, fill: 0, arc: null, dim: true };
    }
  }
  if (!circle) { log('no circle'); return null; }
  const { w, h, f } = P;
  const C = [circle.cx, circle.cy], R = circle.r;
  // metal beyond the circle on the side away from the stem = baseplate and screws = reverse
  const ref = stem ? stem.prox : [C[0], C[1] + R];
  let ex = C[0] - ref[0], ey = C[1] - ref[1];
  const el = Math.hypot(ex, ey) || 1; ex /= el; ey /= el;
  // only metal connected to the dome itself counts (baseplate and screws are attached to it; separate bodies are not)
  const cnt = new Map();
  for (let y = Math.max(0, Math.floor(C[1] - 0.7 * R)); y <= Math.min(h - 1, Math.ceil(C[1] + 0.7 * R)); y++) {
    for (let x = Math.max(0, Math.floor(C[0] - 0.7 * R)); x <= Math.min(w - 1, Math.ceil(C[0] + 0.7 * R)); x++) {
      const l = M.mask[y * w + x] ? M.labels[y * w + x] : 0;
      if (l) cnt.set(l, (cnt.get(l) || 0) + 1);
    }
  }
  let domeLabel = 0, dl = 0;
  for (const [l, c] of cnt) if (c > dl) { dl = c; domeLabel = l; }
  let far = 0, fx = 0, fy = 0, fxx = 0, fxy = 0, fyy = 0;
  // a glenosphere lies beyond the proximal end of the stem; for a circle below that, "beyond" would point down the
  // stem and count the stem itself
  const alongC = stem ? (C[0] - stem.tip[0]) * stem.d[0] + (C[1] - stem.tip[1]) * stem.d[1] : Infinity;
  if (alongC >= 0.95 * (stem ? stem.len : 0)) for (let y = Math.max(0, Math.floor(C[1] - 3 * R)); y <= Math.min(h - 1, Math.ceil(C[1] + 3 * R)); y++) {
    for (let x = Math.max(0, Math.floor(C[0] - 3 * R)); x <= Math.min(w - 1, Math.ceil(C[0] + 3 * R)); x++) {
      if (!M.mask[y * w + x] || (domeLabel && M.labels[y * w + x] !== domeLabel)) continue;
      const dx = x - C[0], dy = y - C[1], dd = Math.hypot(dx, dy);
      if (dd < 1.12 * R || dd > 3 * R) continue;
      if ((dx * ex + dy * ey) < 0.2 * dd) continue;                    // within ~78° of "away from the stem"
      far++; fx += x; fy += y; fxx += x * x; fxy += x * y; fyy += y * y;
    }
  }
  // …or the circle sits well off the stem axis: a prosthetic head rides on its stem (centre within about half a
  // radius of the axis), a glenosphere is a full radius medial to it
  const axisOff = stem ? Math.abs((C[0] - stem.tip[0]) * stem.n[0] + (C[1] - stem.tip[1]) * stem.n[1]) : 0;
  log(`far-side metal ${(far / (Math.PI * R * R)).toFixed(3)} of disc; centre ${(axisOff / R).toFixed(2)} R off the stem axis`);
  const isReverse = opts.implant ? opts.implant === 'reverse' : !circle.dim && (far > 0.05 * Math.PI * R * R || axisOff > 0.8 * R);
  const toFull = (p) => [(p[0] + 0.5) * f - 0.5, (p[1] + 0.5) * f - 0.5];
  const scaleOut = (est) => {
    const o = {};
    for (const [id, e] of Object.entries(est)) o[id] = e.a ? { a: toFull(e.a), b: toFull(e.b), confidence: e.confidence } : { ...Object.fromEntries([['x', toFull([e.x, e.y])[0]], ['y', toFull([e.x, e.y])[1]]]), confidence: e.confidence };
    return o;
  };
  const stemOut = stem ? { a: toFull(stem.prox), b: toFull(stem.tip) } : null;
  if (isReverse) {
    // axis: from the baseplate/screw metal through the centre, pointing out of the dome (lateral)
    // axis: from the baseplate/screw metal through the centre; without any (reader said reverse, none attached),
    // assume the dome faces the stem's proximal end
    let ax = far ? C[0] - fx / far : (stem ? stem.prox[0] - C[0] : 1), ay = far ? C[1] - fy / far : (stem ? stem.prox[1] - C[1] : 0);
    const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
    // Refine the direction from the implant's own straight edges: the flat back of the dome where it shows beside
    // the baseplate, and the baseplate's medial edge, are both parallel to the face. (The centroid of the screws
    // alone is off by 15° or more when the screws are not symmetric.)
    const fl = faceLine(circle.B || boundary(P, M), C, R, [ax, ay], domeLabel ? (x, y) => M.labels[y * w + x] === domeLabel : null);
    log(`axis from screws (${ax.toFixed(2)},${ay.toFixed(2)}); straight back edge ${fl ? `${fl.n} px, normal (${fl.nx.toFixed(2)},${fl.ny.toFixed(2)}), ${fl.d.toFixed(1)} px medial of centre` : 'not found'}`);
    // Principal direction of the screw/peg metal: screws and the central peg run roughly parallel to the axis, so
    // their main direction is robust where their centroid is not (asymmetric screw placement)
    let pca = null;
    if (far > 30) {
      const mx = fx / far, my = fy / far, cxx = fxx / far - mx * mx, cxy = fxy / far - mx * my, cyy = fyy / far - my * my;
      const tr = cxx + cyy, det = cxx * cyy - cxy * cxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
      let vx = Math.abs(cxy) > 1e-9 ? l1 - cyy : (cxx >= cyy ? 1 : 0), vy = Math.abs(cxy) > 1e-9 ? cxy : (cxx >= cyy ? 0 : 1);
      const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
      if (vx * ax + vy * ay < 0) { vx = -vx; vy = -vy; }
      // only when the metal is clearly elongated and the direction is within 40° of the centroid estimate
      if (l1 > 2.5 * Math.max(1e-9, l2) && vx * ax + vy * ay > 0.77) pca = [vx, vy];
    }
    // Order of preference measured on annotated films (median face-angle error): the dome's straight back edge 5.5°,
    // screw-centroid direction 12°, principal screw direction 19°.
    const mode = opts.axisMode || 'face';
    let how = 'screw centroid';
    if (mode === 'face' && fl) { ax = fl.nx; ay = fl.ny; how = 'back edge'; }
    else if (mode === 'pca' && pca) { ax = pca[0]; ay = pca[1]; how = 'screw direction'; }
    // On an upright AP film the glenoid faces laterally: the axis lies within about 40° of horizontal. An estimate
    // outside that is a misreading of the implant; take the first plausible alternative, else horizontal.
    const plausible = (v) => v && Math.abs(v[1]) <= Math.sin(40 * Math.PI / 180) * Math.hypot(v[0], v[1]);
    if (!plausible([ax, ay])) {
      const alts = [fl ? [fl.nx, fl.ny, 'back edge'] : null, pca ? [pca[0], pca[1], 'screw direction'] : null, far ? [C[0] - fx / far, C[1] - fy / far, 'screw centroid'] : null]
        .filter((v) => v && plausible(v));
      const L0 = stem ? Math.sign(stem.prox[0] - C[0]) || 1 : (ax >= 0 ? 1 : -1);
      const pick = alts.find((v) => Math.sign(v[0]) === L0) || [L0, 0, 'horizontal (implant orientation not readable)'];
      const l = Math.hypot(pick[0], pick[1]); ax = pick[0] / l; ay = pick[1] / l; how = pick[2];
    }
    log(`axis chosen (${ax.toFixed(2)},${ay.toFixed(2)}) by ${how}`);
    const L = ax >= 0 ? 1 : -1;
    // superior in-face direction
    let px = -ay, py = ax; if (py > 0) { px = -px; py = -py; }
    // where the dome gives way to the narrower baseplate on its medial side (measured on the superior side,
    // which the humeral cup does not cover)
    const inM = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < w && y < h && M.mask[y * w + x]; };
    let df = 0;
    for (let t = 0; t <= 0.85 * R; t += 0.5) {
      const qx = C[0] - ax * t, qy = C[1] - ay * t;
      let k = 0; while (k < 1.3 * R && inM(qx + px * (k + 0.5), qy + py * (k + 0.5))) k += 0.5;
      const expect = Math.sqrt(Math.max(0, R * R - t * t));
      if (k < 0.82 * expect - 1) { df = Math.max(0, t - 0.5); break; }
      df = t;
    }
    if (df >= 0.84 * R) df = 0;                                         // never found: assume a hemisphere
    if (fl && fl.d >= 0 && fl.d < 0.5 * R) df = fl.d;                   // the dome's own back edge was seen
    const hh = Math.sqrt(Math.max(1, R * R - df * df));
    const fc = [C[0] - ax * df, C[1] - ay * df];
    const g = { cx: C[0], cy: C[1], r: R, score: circle.score, axis: [ax, ay], face: { a: [fc[0] + px * hh, fc[1] + py * hh], b: [fc[0] - px * hh, fc[1] - py * hh] } };
    const est = reverseLandmarks(P, M, g, stem, L);
    const cf = toFull(C);
    return {
      kind: 'reverse', confidence: circle.score, metalFraction: M.fraction,
      side: L > 0 ? 'right-of-glenoid' : 'left-of-glenoid',
      reverse: {
        glenosphere: { cx: cf[0], cy: cf[1], r: R * f, score: circle.score, axis: [ax, ay], face: { a: toFull(g.face.a), b: toFull(g.face.b) }, arcDeg: circle.run, fill: circle.fill },
        stem: stemOut, side: L > 0 ? 'right-of-glenoid' : 'left-of-glenoid',
      },
      head: null, stem: stemOut, estimates: { 'rsa-ap': withLearned(scaleOut(est), img, 'reverse', { centre: cf, r: R * f, face: { a: toFull(g.face.a), b: toFull(g.face.b) }, stem: stemOut }, L) },
    };
  }
  // hemiarthroplasty: the head faces medially, so lateral is the other way from where the head sits off the stem
  let L = -1;
  if (stem) {
    const off = (C[0] - stem.tip[0]) * stem.n[0] + (C[1] - stem.tip[1]) * stem.n[1];   // signed offset from the stem axis
    const medX = off * stem.n[0];
    L = Math.abs(medX) > 0.05 * R ? (medX > 0 ? -1 : 1) : (C[0] > w / 2 ? 1 : -1);
  }
  const est = headLandmarks(P, M, circle, stem, L, true);
  const cf = toFull(C);
  return {
    kind: 'hemi', confidence: circle.score, metalFraction: M.fraction,
    side: L > 0 ? 'right-of-glenoid' : 'left-of-glenoid',
    reverse: null, head: { cx: cf[0], cy: cf[1], r: R * f, score: circle.score, kind: 'implant', arcDeg: circle.run },
    stem: stemOut, estimates: { 'pyc-ap': withLearned(scaleOut(est), img, 'hemi', { centre: cf, r: R * f, stem: stemOut }, L) },
  };
}

/**
 * Replace proportion-based bony landmarks with the learned model's placement (src/detect/learned.js) where the
 * model covers this implant type. Measured implant landmarks (stem and canal widths) are kept.
 */
function withLearned(est, img, kind, imp, L) {
  const m = MODEL.types && MODEL.types[kind];
  if (!m) return est;
  const F = learnedFrames(imp, L);
  if (!F) return est;
  const g = { width: img.width, height: img.height, data: img.data };
  return { ...est, ...placeLearned(g, F, m) };
}

/** Bony landmark estimates for a native shoulder, given the humeral head circle (full-resolution px). */
export function nativeLandmarks(img, head, lateralSign) {
  const P = prepare(img);
  const M = { mask: new Uint8Array(P.n), near: new Uint8Array(P.n) };
  const c = { cx: (head.cx + 0.5) / P.f - 0.5, cy: (head.cy + 0.5) / P.f - 0.5, r: head.r / P.f };
  const est = headLandmarks(P, M, c, null, lateralSign, false);
  const o = {};
  const toFull = (p) => [(p[0] + 0.5) * P.f - 0.5, (p[1] + 0.5) * P.f - 0.5];
  for (const [id, e] of Object.entries(est)) o[id] = e.a ? { a: toFull(e.a), b: toFull(e.b), confidence: e.confidence } : { x: toFull([e.x, e.y])[0], y: toFull([e.x, e.y])[1], confidence: e.confidence };
  return o;
}
