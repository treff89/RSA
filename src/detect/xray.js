// Classical (no ML, no network) analysis of AP shoulder radiographs.
//
// What can honestly be found automatically is chiefly the metal implant. The
// detectors below work on a box-downsampled copy (~512 px on the smaller
// side) and refine every reported edge at full resolution. They return
// null / low scores rather than guess when the evidence is weak.
//
// Image convention: { width, height, data: Float32Array }, HIGHER = MORE
// attenuating (metal brightest). Coordinates: x right, y down, pixel centres
// at integers, full-resolution pixels. Pass { invert: true } if a caller has
// an image of the opposite polarity; { mmPerPx } tightens the radius limits.

import {
  downsample, gaussianBlur, sobel, percentiles, median, connectedComponents, multiOtsu,
  principalAxes, distanceTransformSq, open as morphOpen, bilinear, fitCircle, fitLine,
} from './image.js';

/** Stem levels (fraction t along stem a→b) used for the stem / canal width landmarks. */
export const STEM_LEVELS = Object.freeze({ metaphyseal: 0.3, distal: 0.85 });

const TARGET = 512; // working size of the smaller image side
const MIN_STEP = 0.11; // min mean neighbour step (fraction of range) for a "metal" class
const cache = new WeakMap();

// ------------------------------------------------------------------ context

function prepare(img, opts = {}) {
  const invert = !!opts.invert;
  const hit = cache.get(img);
  if (hit && hit.invert === invert && hit.data === img.data) {
    if (opts.mmPerPx) hit.mmPerPx = opts.mmPerPx;
    return hit;
  }
  const minSide = Math.min(img.width, img.height);
  const f = Math.max(1, Math.round(minSide / TARGET));
  const ws = downsample(img, f);
  const w = ws.width, h = ws.height, u = ws.data;
  const sgn = invert ? -1 : 1;
  if (invert) for (let i = 0; i < u.length; i++) u[i] = -u[i];
  const [lo, hi] = percentiles(u, [0.5, 99.9]);
  const span = hi - lo > 0 ? hi - lo : 1;
  for (let i = 0; i < u.length; i++) {
    const t = (u[i] - lo) / span;
    u[i] = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const W = img.width, H = img.height, data = img.data;
  const ctx = {
    img, data, invert, sgn, f, w, h, u, lo, span, flat: !(hi - lo > 0), minSide, W, H,
    mmPerPx: opts.mmPerPx || null,
    /** normalised full-resolution sample (0 ≈ darkest, 1 ≈ metal) */
    sample(x, y) { return (sgn * bilinear(data, W, H, x, y) - lo) / span; },
    toFull: (v) => (v + 0.5) * f - 0.5,
    toWork: (v) => (v + 0.5) / f - 0.5,
  };
  cache.set(img, ctx);
  return ctx;
}

function gradients(ctx) {
  if (!ctx.grad) {
    ctx.ub = gaussianBlur(ctx.u, ctx.w, ctx.h, 1);
    ctx.grad = sobel(ctx.ub, ctx.w, ctx.h);
  }
  return ctx.grad;
}

// ------------------------------------------------------------------ metal

function metalInfo(ctx) {
  if (ctx.metal) return ctx.metal;
  const { u, w, h } = ctx;
  const n = w * h;
  const none = (score = 0) => (ctx.metal = {
    present: false, T: 1, mask: new Uint8Array(n), fraction: 0, score, comps: [], labels: null, depth: null,
  });
  if (ctx.flat || w < 16 || h < 16) return none();
  // For every level T: number of 4-neighbour pairs straddling T and their
  // mean step. In the gap between bone and metal only the metal boundary
  // straddles T, so the mean step there is large; in bone it stays small.
  const C = new Float64Array(258), S = new Float64Array(258), hist = new Float64Array(256);
  const pair = (a, b) => {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const k0 = Math.floor(lo * 255) + 1, k1 = Math.floor(hi * 255);
    if (k1 >= k0) { const d = hi - lo; C[k0]++; C[k1 + 1]--; S[k0] += d; S[k1 + 1] -= d; }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = u[i];
      hist[Math.floor(a * 255)]++;
      if (x + 1 < w) pair(a, u[i + 1]);
      if (y + 1 < h) pair(a, u[i + w]);
    }
  }
  for (let k = 1; k < 258; k++) { C[k] += C[k - 1]; S[k] += S[k - 1]; }
  const N = new Float64Array(257);
  for (let k = 255; k >= 0; k--) N[k] = N[k + 1] + hist[k];
  const m = new Float64Array(256);
  for (let k = 0; k < 256; k++) m[k] = C[k] >= 24 ? S[k] / C[k] : 0;
  let kb = -1, mb = 0;
  for (let k = 77; k <= 247; k++) {
    const fr = N[k] / n;
    if (fr < 3e-4 || fr > 0.3) continue;
    const v = (m[k - 2] + m[k - 1] + m[k] + m[k + 1] + m[k + 2]) / 5;
    if (v > mb) { mb = v; kb = k; }
  }
  let T;
  if (kb < 0 || mb < MIN_STEP) {
    // No clean level gap. That is the rule on real, display-processed radiographs: implants are round, so their
    // brightness falls off towards the edges instead of forming a plateau, and edge enhancement blurs the gap.
    // Fall back to the top class of a multi-level Otsu split and accept it only if it is a solid, bright body that
    // stands well clear of its surroundings (see solidBrightBody).
    T = solidBrightBody(u, w, h, hist, n);
    if (T === null) return none(mb);
  } else {
    let ka = kb, kc = kb;
    while (ka > 60 && m[ka - 1] >= 0.8 * mb) ka--;
    while (kc < 250 && m[kc + 1] >= 0.8 * mb) kc++;
    T = (ka + kc) / 2 / 255;
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = u[i] > T ? 1 : 0;
  const cc = connectedComponents(mask, w, h, 8);
  // collimator borders: components hugging a long stretch of an image side
  const drop = new Uint8Array(cc.count + 1);
  for (let k = 1; k <= cc.count; k++) {
    const s = cc.stats[k], b = s.border;
    if (b.left > 0.3 * h || b.right > 0.3 * h || b.top > 0.3 * w || b.bottom > 0.3 * w) drop[k] = 1;
  }
  const depth = distanceTransformSq(mask, w, h, 0);
  const maxDepth = new Float32Array(cc.count + 1);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const k = cc.labels[i];
    if (!k) continue;
    if (drop[k]) { mask[i] = 0; continue; }
    area++;
    if (depth[i] > maxDepth[k]) maxDepth[k] = depth[i];
  }
  const rSolid = Math.max(1.2, 0.004 * Math.min(w, h));
  const comps = [];
  for (let k = 1; k <= cc.count; k++) {
    if (drop[k]) continue;
    const s = cc.stats[k];
    s.depth = Math.sqrt(maxDepth[k]);
    if (s.depth >= rSolid && s.area >= 12) comps.push(s);
  }
  if (!comps.length) return none(mb);
  return (ctx.metal = { present: true, T, mask, fraction: area / n, score: mb, comps, labels: cc.labels, depth });
}

/**
 * Threshold (0..1) of a solid bright body, or null. Candidates are the upper thresholds of 3- and 4-class Otsu
 * splits; one is accepted when the pixels above it form at least one thick component (not a thin cortex or a
 * line of text) that is clearly brighter than the ring of tissue around it and reasonably uniform inside.
 */
function solidBrightBody(u, w, h, hist, n) {
  const cands = [];
  const t3 = multiOtsu(hist, 3), t4 = multiOtsu(hist, 4);
  if (t3.length === 2) cands.push(t3[1]);
  if (t4.length === 3) cands.push(t4[2], t4[1]);
  const minDepth = Math.max(2.5, 0.014 * Math.min(w, h));
  let best = null;
  for (const bin of cands) {
    const T = (bin + 0.5) / 255;
    if (T < 0.55 || T > 0.97) continue;
    const mask = new Uint8Array(n);
    let area = 0;
    for (let i = 0; i < n; i++) if (u[i] > T) { mask[i] = 1; area++; }
    const fr = area / n;
    if (fr < 0.003 || fr > 0.3) continue;
    const depth = distanceTransformSq(mask, w, h, 0);
    // thick core = pixels at least minDepth inside the mask
    let core = 0, sIn = 0, s2In = 0;
    for (let i = 0; i < n; i++) if (depth[i] >= minDepth * minDepth) { core++; sIn += u[i]; s2In += u[i] * u[i]; }
    if (core < 0.0015 * n) continue;
    const mIn = sIn / core, sdIn = Math.sqrt(Math.max(0, s2In / core - mIn * mIn));
    // ring just outside the mask (2–6 working px away)
    const out = distanceTransformSq(mask, w, h, 1);
    let ring = 0, sOut = 0;
    for (let i = 0; i < n; i++) if (!mask[i] && out[i] >= 4 && out[i] <= 36) { ring++; sOut += u[i]; }
    if (!ring) continue;
    const contrast = mIn - sOut / ring;
    const score = contrast - sdIn;
    // 0.83: dense native bone forms solid bodies too, but sits lower in the range than an implant (0.78 on the
    // native phantom against 0.87 on a real reverse film). A false alarm here is cheap — the dome and stem tests
    // that follow reject bone — whereas a missed implant is not.
    if (mIn >= 0.83 && T >= 0.6 && contrast >= 0.2 && sdIn <= 0.12 && (!best || score > best.score)) best = { T, score };
  }
  return best ? best.T : null;
}

/**
 * Metal = the brightest compact class, separated from bone by a level gap
 * that only sharp boundaries straddle. Does not fire on dense native bone.
 * @returns {{present:boolean, threshold:number, fraction:number, mask:Uint8Array, scale:number, width:number, height:number, score:number}}
 *   mask is at working scale (width × height, 1 working px = scale full px).
 */
export function detectMetal(img, opts = {}) {
  const ctx = prepare(img, opts);
  const M = metalInfo(ctx);
  return {
    present: M.present,
    threshold: ctx.sgn * (ctx.lo + M.T * ctx.span),
    fraction: M.fraction,
    mask: M.mask,
    scale: ctx.f,
    width: ctx.w,
    height: ctx.h,
    score: M.score,
  };
}

// ------------------------------------------------------------------ edges

/**
 * Strongest edge along a ray through (x0,y0) in direction (dx,dy), searched
 * within ±half full-res px. sign +1 = rising (dark→bright) along the
 * direction, -1 = falling. tw = number of parallel rays on each side that are
 * averaged. Returns the sub-pixel position or null.
 */
function edgeAlong(ctx, x0, y0, dx, dy, half, sign, tw = 1, first = 0) {
  const step = Math.max(0.5, half / 60);
  const hn = Math.ceil(half / step);
  const n = 2 * hn + 1;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = (i - hn) * step;
    let s = 0;
    for (let k = -tw; k <= tw; k++) s += ctx.sample(x0 + dx * o - dy * k, y0 + dy * o + dx * k);
    g[i] = s / (2 * tw + 1);
  }
  const k = Math.max(1, Math.round(Math.max(1, 0.5 * ctx.f) / step));
  let best = 0, bi = -1;
  const d = new Float32Array(n);
  for (let i = k; i < n - k; i++) {
    d[i] = sign * (g[i + k] - g[i - k]);
    if (d[i] > best) { best = d[i]; bi = i; }
  }
  if (bi < 0) return null;
  if (first > 0) {
    // first local maximum (from the start of the ray) reaching `first` × the global maximum
    for (let i = k + 1; i < n - k - 1; i++) {
      if (d[i] >= first * best && d[i] >= d[i - 1] && d[i] >= d[i + 1]) { bi = i; break; }
    }
  }
  const pk = d[bi];
  let sw = 0, sp = 0;
  for (let i = bi; i >= k && d[i] > 0.5 * pk; i--) { sw += d[i]; sp += d[i] * i; }
  for (let i = bi + 1; i < n - k && d[i] > 0.5 * pk; i++) { sw += d[i]; sp += d[i] * i; }
  const pos = (sp / sw - hn) * step;
  return {
    pos, strength: pk, x: x0 + dx * pos, y: y0 + dy * pos,
    atLimit: bi <= k + 1 || bi >= n - k - 2,
  };
}

function robustCircle(pts, minTol) {
  let keep = pts, fit = null;
  for (let it = 0; it < 4; it++) {
    fit = fitCircle(keep);
    if (!fit) return null;
    const res = [];
    for (let i = 0; i < pts.length; i += 2) res.push(Math.abs(Math.hypot(pts[i] - fit.cx, pts[i + 1] - fit.cy) - fit.r));
    const tol = Math.max(minTol, 2.5 * 1.4826 * median(res));
    const next = [];
    for (let i = 0; i < pts.length; i += 2) if (res[i >> 1] <= tol) next.push(pts[i], pts[i + 1]);
    if (next.length < 10) return null;
    if (next.length === keep.length && it > 0) break;
    keep = next;
  }
  fit = fitCircle(keep);
  if (!fit) return null;
  fit.inliers = keep.length >> 1;
  fit.pts = keep;
  return fit;
}

// Gradient-direction Hough transform for circles whose inside is brighter.
function houghCircles(ctx, P, rmin, rmax, maxPeaks) {
  const { w, h } = ctx;
  const { px, py, nx, ny, wt, n } = P;
  const acc = new Float32Array(w * h);
  rmin = Math.max(3, Math.floor(rmin));
  rmax = Math.ceil(rmax);
  for (let i = 0; i < n; i++) {
    for (let r = rmin; r <= rmax; r++) {
      const x = Math.round(px[i] + nx[i] * r), y = Math.round(py[i] + ny[i] * r);
      if (x >= 0 && y >= 0 && x < w && y < h) acc[y * w + x] += wt[i];
    }
  }
  const sm = gaussianBlur(acc, w, h, 1.3);
  const out = [];
  const sup = Math.max(4, Math.round(rmin * 0.6));
  let first = 0;
  for (let p = 0; p < maxPeaks; p++) {
    let bi = -1, bv = 0;
    for (let i = 0; i < sm.length; i++) if (sm[i] > bv) { bv = sm[i]; bi = i; }
    if (bi < 0 || bv <= 0) break;
    if (p === 0) first = bv;
    else if (bv < 0.2 * first) break;
    const cx = bi % w, cy = (bi - cx) / w;
    for (let y = Math.max(0, cy - sup); y <= Math.min(h - 1, cy + sup); y++) {
      for (let x = Math.max(0, cx - sup); x <= Math.min(w - 1, cx + sup); x++) sm[y * w + x] = 0;
    }
    const hist = new Float32Array(rmax + 3);
    for (let i = 0; i < n; i++) {
      const dx = cx - px[i], dy = cy - py[i];
      const t = dx * nx[i] + dy * ny[i];
      if (t < rmin - 1 || t > rmax + 1) continue;
      if (Math.abs(dx * ny[i] - dy * nx[i]) > 2 + 0.05 * t) continue;
      hist[Math.round(t)] += wt[i];
    }
    let br = rmin, bh = -1;
    for (let r = rmin; r <= rmax; r++) {
      const v = hist[r - 1] + 2 * hist[r] + hist[r + 1];
      if (v > bh) { bh = v; br = r; }
    }
    // least-squares polish on the supporting points
    const pts = [];
    for (let i = 0; i < n; i++) {
      const dx = cx - px[i], dy = cy - py[i];
      const dd = Math.hypot(dx, dy);
      if (Math.abs(dd - br) > 2.5 || dx * nx[i] + dy * ny[i] < 0.85 * dd) continue;
      pts.push(px[i], py[i]);
    }
    let c = { cx, cy, r: br };
    if (pts.length >= 16) {
      const fit = fitCircle(pts);
      if (fit && Math.hypot(fit.cx - cx, fit.cy - cy) < 4 && fit.r >= rmin * 0.9 && fit.r <= rmax * 1.1) c = fit;
    }
    out.push({ cx: c.cx, cy: c.cy, r: c.r, votes: bh / 4 });
  }
  return out;
}

function radiusRange(ctx, opts, mmLo, mmHi, frLo, frHi) {
  const mmPerPx = opts.mmPerPx || ctx.mmPerPx;
  if (opts.rRange) return [opts.rRange[0] / ctx.f, opts.rRange[1] / ctx.f];
  if (mmPerPx > 0) return [mmLo / mmPerPx / ctx.f, mmHi / mmPerPx / ctx.f];
  return [(frLo * ctx.minSide) / ctx.f, (frHi * ctx.minSide) / ctx.f];
}

function maskBoundary(ctx, mask) {
  const { w, h } = ctx;
  const g = gradients(ctx);
  const px = [], py = [], nx = [], ny = [], wt = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!mask[i] || (mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w])) continue;
      const mg = g.mag[i];
      if (mg < 1e-4) continue;
      px.push(x); py.push(y); nx.push(g.gx[i] / mg); ny.push(g.gy[i] / mg); wt.push(1);
    }
  }
  return { px, py, nx, ny, wt, n: px.length };
}

// per-degree classification of a circle against a mask:
// 1 = arc (metal inside, not outside), 2 = occluded (metal on both sides), 0 = off
function classifyArc(mask, w, h, cx, cy, r, delta) {
  const cls = new Uint8Array(360);
  const at = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    return x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0;
  };
  for (let k = 0; k < 360; k++) {
    const c = Math.cos((k * Math.PI) / 180), s = Math.sin((k * Math.PI) / 180);
    const inn = at(cx + (r - delta) * c, cy + (r - delta) * s) && at(cx + (r - 2 * delta) * c, cy + (r - 2 * delta) * s);
    if (!inn) continue;
    cls[k] = at(cx + (r + delta) * c, cy + (r + delta) * s) ? 2 : 1;
  }
  return cls;
}

// longest run of "arc" degrees, bridging small gaps; occluded ends are trimmed
function domeRun(cls) {
  const c = Uint8Array.from(cls);
  // bridge short "off" gaps
  let zeros = 0;
  for (let k = 0; k < 360; k++) if (!c[k]) zeros++;
  if (zeros === 0) return { full: true, start: 0, len: 360, arc: cls.reduce((a, v) => a + (v === 1), 0) };
  let k0 = 0;
  while (c[k0]) k0++; // start at a zero
  for (let i = 0; i < 360;) {
    const k = (k0 + i) % 360;
    if (c[k]) { i++; continue; }
    let len = 0;
    while (len < 360 && !c[(k + len) % 360]) len++;
    if (len <= 5) for (let j = 0; j < len; j++) c[(k + j) % 360] = 2;
    i += len;
  }
  zeros = 0;
  for (let k = 0; k < 360; k++) if (!c[k]) zeros++;
  if (zeros === 0) return { full: true, start: 0, len: 360, arc: cls.reduce((a, v) => a + (v === 1), 0) };
  k0 = 0;
  while (c[k0]) k0++;
  let best = null;
  for (let i = 0; i < 360;) {
    const k = (k0 + i) % 360;
    if (!c[k]) { i++; continue; }
    let len = 0, arc = 0;
    while (len < 360 && c[(k + len) % 360]) { if (c[(k + len) % 360] === 1) arc++; len++; }
    if (!best || arc > best.arc) best = { start: k, len, arc };
    i += len;
  }
  if (!best || best.arc === 0) return null;
  let { start, len } = best;
  let trimA = 0, trimB = 0;
  while (len > 0 && c[start % 360] !== 1) { start++; len--; trimA++; }
  while (len > 0 && c[(start + len - 1) % 360] !== 1) { len--; trimB++; }
  return { full: false, start: start % 360, len, arc: best.arc, trimA, trimB };
}

// ------------------------------------------------------------------ reverse: dome

function refineDome(ctx, M, cand) {
  const { f, w, h } = ctx;
  const delta = Math.max(1.5, 0.07 * cand.r);
  let cls = classifyArc(M.mask, w, h, cand.cx, cand.cy, cand.r, delta);
  let run = domeRun(cls);
  if (!run || run.full || run.len < 110 || run.len > 300 || run.arc < 90) return null;
  // --- circle at full resolution, on un-occluded arc degrees
  let cx = ctx.toFull(cand.cx), cy = ctx.toFull(cand.cy), r = cand.r * f;
  let fit = null, tried = 0, strength = 0;
  for (let pass = 0; pass < 2; pass++) {
    const pts = [], str = [];
    tried = 0;
    const half = Math.max(3, (pass ? 0.07 : 0.14) * r);
    for (let j = 5; j < run.len - 5; j++) {
      const k = (run.start + j) % 360;
      if (cls[k] !== 1 || cls[(k + 2) % 360] !== 1 || cls[(k + 358) % 360] !== 1) continue;
      tried++;
      const c = Math.cos((k * Math.PI) / 180), s = Math.sin((k * Math.PI) / 180);
      const e = edgeAlong(ctx, cx + r * c, cy + r * s, c, s, half, -1, 1);
      if (!e || e.atLimit) continue;
      pts.push(e.x, e.y); str.push(e.strength);
    }
    if (pts.length < 60) return null;
    strength = median(str);
    const good = [];
    for (let i = 0; i < str.length; i++) if (str[i] >= 0.45 * strength) good.push(pts[2 * i], pts[2 * i + 1]);
    fit = robustCircle(good, Math.max(0.6, 0.012 * r));
    if (!fit) return null;
    cx = fit.cx; cy = fit.cy; r = fit.r;
  }
  if (tried < 60 || fit.inliers < 0.5 * tried) return null;
  // --- arc ends on the refined circle
  cls = classifyArc(M.mask, w, h, ctx.toWork(cx), ctx.toWork(cy), r / f, delta);
  run = domeRun(cls);
  if (!run || run.full || run.len < 110 || run.len > 300) return null;
  const a1 = (run.start * Math.PI) / 180, a2 = ((run.start + run.len - 1) * Math.PI) / 180;
  const mid = (a1 + a2) / 2;
  let ux = Math.cos(mid), uy = Math.sin(mid);
  let P1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  let P2 = [cx + r * Math.cos(a2), cy + r * Math.sin(a2)];
  // --- flat back face: rising edges (bone → metal) along the axis near the chord
  const L = Math.hypot(P2[0] - P1[0], P2[1] - P1[1]);
  const tx = (P2[0] - P1[0]) / L, ty = (P2[1] - P1[1]) / L;
  // axis estimate perpendicular to the chord, on the arc side
  if (-ty * ux + tx * uy > 0) { ux = -ty; uy = tx; } else { ux = ty; uy = -tx; }
  const step = Math.max(1.5, L / 150);
  const fp = [], fq = [];
  for (let q = 0.02 * L; q <= 0.98 * L; q += step) {
    const x = P1[0] + tx * q, y = P1[1] + ty * q;
    const e = edgeAlong(ctx, x, y, ux, uy, 0.2 * r, 1, 1);
    if (!e || e.atLimit || e.strength < 0.4 * strength) continue;
    fp.push(e.x, e.y); fq.push(q / L);
  }
  let face = null, faceEnds = 0;
  const nf = fq.length;
  if (nf >= 6) {
    const tol = Math.max(1, 0.02 * r);
    let bestN = 0, bestPair = null;
    const stride = Math.max(1, Math.floor((nf * nf) / 8000));
    let cnt = 0;
    for (let i = 0; i < nf; i++) {
      for (let j = i + 1; j < nf; j++) {
        if (fq[j] - fq[i] < 0.12) continue;
        if (cnt++ % stride) continue;
        const dx = fp[2 * j] - fp[2 * i], dy = fp[2 * j + 1] - fp[2 * i + 1];
        const dl = Math.hypot(dx, dy);
        // the face is roughly parallel to the chord estimate
        if (Math.abs(dx * tx + dy * ty) < 0.9 * dl) continue;
        let c = 0, lo = 0, hi = 0;
        for (let k = 0; k < nf; k++) {
          const e = Math.abs((fp[2 * k] - fp[2 * i]) * dy - (fp[2 * k + 1] - fp[2 * i + 1]) * dx) / dl;
          if (e <= tol) { c++; if (fq[k] < 0.4) lo++; else if (fq[k] > 0.6) hi++; }
        }
        const sc = c + 3 * Math.min(lo, hi);
        if (sc > bestN) { bestN = sc; bestPair = [i, j, lo, hi]; }
      }
    }
    if (bestPair) {
      const [i, j] = bestPair;
      const dx = fp[2 * j] - fp[2 * i], dy = fp[2 * j + 1] - fp[2 * i + 1];
      const dl = Math.hypot(dx, dy);
      const inl = [];
      for (let k = 0; k < nf; k++) {
        const e = Math.abs((fp[2 * k] - fp[2 * i]) * dy - (fp[2 * k + 1] - fp[2 * i + 1]) * dx) / dl;
        if (e <= tol) inl.push(fp[2 * k], fp[2 * k + 1]);
      }
      const ln = inl.length >= 6 ? fitLine(inl) : null;
      if (ln) {
        // intersect with the circle
        const ox = ln.px - cx, oy = ln.py - cy;
        const b = ox * ln.dx + oy * ln.dy;
        const disc = b * b - (ox * ox + oy * oy - r * r);
        if (disc > 0) {
          const s1 = -b - Math.sqrt(disc), s2 = -b + Math.sqrt(disc);
          P1 = [ln.px + ln.dx * s1, ln.py + ln.dy * s1];
          P2 = [ln.px + ln.dx * s2, ln.py + ln.dy * s2];
          let nxn = -ln.dy, nyn = ln.dx;
          if (nxn * ux + nyn * uy < 0) { nxn = -nxn; nyn = -nyn; }
          ux = nxn; uy = nyn;
          face = ln;
          faceEnds = (bestPair[2] >= 2 ? 1 : 0) + (bestPair[3] >= 2 ? 1 : 0);
        }
      }
    }
  }
  const dOff = (cx - P1[0]) * ux + (cy - P1[1]) * uy; // centre in front of the face by dOff
  const frac = (r + dOff) / (2 * r);
  if (frac < 0.3 || frac > 0.85) return null;
  // --- how much of the dome region is metal
  let inD = 0, inM = 0;
  const cwx = ctx.toWork(cx), cwy = ctx.toWork(cy), rw = r / f;
  for (let y = Math.max(0, Math.floor(cwy - rw)); y <= Math.min(h - 1, Math.ceil(cwy + rw)); y++) {
    for (let x = Math.max(0, Math.floor(cwx - rw)); x <= Math.min(w - 1, Math.ceil(cwx + rw)); x++) {
      const dx = x - cwx, dy = y - cwy;
      if (dx * dx + dy * dy > (rw - 1) * (rw - 1) || dx * ux + dy * uy < -dOff / f + 1) continue;
      inD++;
      if (M.mask[y * w + x]) inM++;
    }
  }
  const fill = inD ? inM / inD : 0;
  if (fill < 0.7) return null;
  const sArc = fit.inliers / tried;
  const sVis = run.arc / run.len;
  const sSpan = Math.min(1, Math.max(0, (run.len - 110) / 40), Math.max(0, (300 - run.len) / 35));
  const sFit = Math.max(0, 1 - fit.rms / (0.03 * r + 0.5));
  const sFace = face ? (faceEnds === 2 ? 1 : 0.8) : 0.6;
  const sFill = Math.min(1, (fill - 0.6) / 0.3);
  const score = sArc * (0.5 + 0.5 * sVis) * sSpan * sFit * sFace * sFill;
  const sup = P1[1] <= P2[1] ? [P1, P2] : [P2, P1];
  return {
    cx, cy, r, score,
    face: { a: sup[0], b: sup[1] },
    axis: [ux, uy],
    arcSpanDeg: run.len, visibleArcDeg: run.arc, faceFitted: !!face, faceEnds, fill, edgeStrength: strength,
    occludedEnd: (run.trimA || 0) > 6 || (run.trimB || 0) > 6,
  };
}

// ------------------------------------------------------------------ elongated metal bodies / stem

function openedMask(ctx, M) {
  if (!M.opened) {
    M.openR = Math.max(1.2, 0.006 * Math.min(ctx.w, ctx.h));
    M.opened = morphOpen(M.mask, ctx.w, ctx.h, M.openR);
  }
  return M.opened;
}

// connected bodies of the opened metal mask, optionally with a disc removed
function metalBodies(ctx, M, disc) {
  const { w, h } = ctx;
  let mo = openedMask(ctx, M);
  if (disc) {
    mo = Uint8Array.from(mo);
    const r2 = disc.r * disc.r;
    for (let y = Math.max(0, Math.floor(disc.cy - disc.r)); y <= Math.min(h - 1, Math.ceil(disc.cy + disc.r)); y++) {
      for (let x = Math.max(0, Math.floor(disc.cx - disc.r)); x <= Math.min(w - 1, Math.ceil(disc.cx + disc.r)); x++) {
        if ((x - disc.cx) ** 2 + (y - disc.cy) ** 2 <= r2) mo[y * w + x] = 0;
      }
    }
  }
  const cc = connectedComponents(mo, w, h, 8);
  const bodies = [];
  for (let k = 1; k <= cc.count; k++) {
    const s = cc.stats[k];
    if (s.area < 20) continue;
    const ax = principalAxes(s);
    bodies.push({ ...s, ax, length: ax.length, elong: ax.length / Math.max(1, ax.width) });
  }
  return { labels: cc.labels, bodies, mask: mo };
}

function bodyPixels(ctx, labels, label, s) {
  const { w } = ctx;
  const xs = [], ys = [];
  for (let y = s.minY; y <= s.maxY; y++) {
    for (let x = s.minX; x <= s.maxX; x++) if (labels[y * w + x] === label) { xs.push(x); ys.push(y); }
  }
  return { xs, ys };
}

// Centre-line of an elongated metal body. `near` (working px) marks the proximal side.
function stemAxis(ctx, pix, body, near) {
  const { f } = ctx;
  const { xs, ys } = pix;
  const n = xs.length;
  let ox = body.cx, oy = body.cy, dx = body.ax.ux, dy = body.ax.uy;
  const orient = () => {
    let smin = Infinity, smax = -Infinity;
    for (let i = 0; i < n; i++) {
      const s = (xs[i] - ox) * dx + (ys[i] - oy) * dy;
      if (s < smin) smin = s;
      if (s > smax) smax = s;
    }
    const dA = Math.hypot(ox + dx * smin - near[0], oy + dy * smin - near[1]);
    const dB = Math.hypot(ox + dx * smax - near[0], oy + dy * smax - near[1]);
    if (dB < dA) { dx = -dx; dy = -dy; return [-smax, -smin]; }
    return [smin, smax];
  };
  let [smin, smax] = orient();
  let sel = null;
  for (let it = 0; it < 2; it++) {
    const nb = Math.ceil(smax - smin) + 1;
    const tmin = new Float32Array(nb).fill(Infinity), tmax = new Float32Array(nb).fill(-Infinity);
    for (let i = 0; i < n; i++) {
      const rx = xs[i] - ox, ry = ys[i] - oy;
      const b = Math.round(rx * dx + ry * dy - smin);
      const t = -rx * dy + ry * dx;
      if (t < tmin[b]) tmin[b] = t;
      if (t > tmax[b]) tmax[b] = t;
    }
    const wd = [];
    for (let b = Math.floor(nb / 2); b < nb - 2; b++) if (tmax[b] >= tmin[b]) wd.push(tmax[b] - tmin[b]);
    if (wd.length < 4) return null;
    const wmed = median(wd);
    const pts = [];
    sel = [];
    for (let b = 2; b < Math.floor(nb * 0.96); b++) {
      if (!(tmax[b] >= tmin[b]) || tmax[b] - tmin[b] > 1.3 * wmed + 1) continue;
      const s = b + smin, t = (tmin[b] + tmax[b]) / 2;
      pts.push(ox + dx * s - dy * t, oy + dy * s + dx * t);
      sel.push({ s, t, hw: (tmax[b] - tmin[b] + 1) / 2 });
    }
    if (sel.length < 6) return null;
    const ln = fitLine(pts);
    if (!ln) return null;
    const flip = ln.dx * dx + ln.dy * dy < 0 ? -1 : 1;
    // keep sel in sync with the frame they were measured in
    sel.frame = { ox, oy, dx, dy };
    ox = ln.px; oy = ln.py; dx = flip * ln.dx; dy = flip * ln.dy;
    [smin, smax] = orient();
  }
  // full-resolution refinement of the section mid-points
  const fr = sel.frame;
  const win = Math.max(3, 1.5 * f);
  const pts = [], str = [];
  const stride = Math.max(1, Math.floor(sel.length / 48));
  const nxw = -fr.dy, nyw = fr.dx;
  for (let i = 0; i < sel.length; i += stride) {
    const q = sel[i];
    const cxw = fr.ox + fr.dx * q.s + nxw * q.t, cyw = fr.oy + fr.dy * q.s + nyw * q.t;
    const X = ctx.toFull(cxw), Y = ctx.toFull(cyw), hw = q.hw * f;
    const e1 = edgeAlong(ctx, X + nxw * hw, Y + nyw * hw, nxw, nyw, win, -1, 1);
    const e2 = edgeAlong(ctx, X - nxw * hw, Y - nyw * hw, -nxw, -nyw, win, -1, 1);
    if (!e1 || !e2 || e1.atLimit || e2.atLimit) continue;
    pts.push((e1.x + e2.x) / 2, (e1.y + e2.y) / 2);
    str.push(Math.min(e1.strength, e2.strength));
  }
  let fo = [ctx.toFull(ox), ctx.toFull(oy)], fd = [dx, dy];
  let edgeStrength = 0;
  if (pts.length >= 8) {
    edgeStrength = median(str);
    const good = [];
    for (let i = 0; i < str.length; i++) if (str[i] >= 0.5 * edgeStrength) good.push(pts[2 * i], pts[2 * i + 1]);
    // Section mid-points run proximal → distal. The proximal ones sit in the metaphyseal flare and under the tray,
    // where the metal is not symmetric about the stem axis, so the fit is grown from the clean distal 60%: fit
    // that, then repeatedly take in every mid-point that lies on the line and refit.
    let ln = fitLine(good);
    if (ln && good.length >= 16) {
      const nG = good.length / 2;
      const distal = good.slice(2 * Math.floor(0.4 * nG));
      let cur = fitLine(distal) || ln;
      for (let it = 0; it < 4; it++) {
        const keep = [];
        const tol = Math.max(0.8, 3 * cur.rms);
        for (let i = 0; i < good.length; i += 2) {
          if (Math.abs((good[i] - cur.px) * -cur.dy + (good[i + 1] - cur.py) * cur.dx) <= tol) keep.push(good[i], good[i + 1]);
        }
        if (keep.length < 16) break;
        const next = fitLine(keep);
        if (!next) break;
        cur = next;
      }
      ln = cur;
    }
    if (ln) {
      const flip = ln.dx * dx + ln.dy * dy < 0 ? -1 : 1;
      fo = [ln.px, ln.py]; fd = [flip * ln.dx, flip * ln.dy];
    }
  }
  // extent along the refined axis
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = (ctx.toFull(xs[i]) - fo[0]) * fd[0] + (ctx.toFull(ys[i]) - fo[1]) * fd[1];
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  lo -= f / 2; hi += f / 2;
  const truncated = body.minX <= 0 || body.minY <= 0 || body.maxX >= ctx.w - 1 || body.maxY >= ctx.h - 1;
  if (!truncated) {
    const e = edgeAlong(ctx, fo[0] + fd[0] * hi, fo[1] + fd[1] * hi, fd[0], fd[1], Math.max(4, 3 * f), -1, 2);
    if (e && !e.atLimit) hi += e.pos;
  }
  return {
    a: [fo[0] + fd[0] * lo, fo[1] + fd[1] * lo],
    b: [fo[0] + fd[0] * hi, fo[1] + fd[1] * hi],
    dir: fd, length: hi - lo, edgeStrength, truncated,
  };
}

// metal width perpendicular to the stem at fraction t (full-resolution edges)
function widthAt(ctx, mo, stem, t, glen) {
  const { f, w, h } = ctx;
  const [dx, dy] = stem.dir;
  const nx = -dy, ny = dx;
  const cx = stem.a[0] + (stem.b[0] - stem.a[0]) * t, cy = stem.a[1] + (stem.b[1] - stem.a[1]) * t;
  const at = (X, Y) => {
    const x = Math.round(ctx.toWork(X)), y = Math.round(ctx.toWork(Y));
    return x >= 0 && y >= 0 && x < w && y < h ? mo[y * w + x] : 0;
  };
  if (!at(cx, cy)) return null;
  const lim = 0.2 * ctx.minSide;
  const out = [];
  for (const sg of [1, -1]) {
    let d = 0;
    while (d < lim && at(cx + sg * nx * (d + f / 2), cy + sg * ny * (d + f / 2))) d += f / 2;
    if (d >= lim) return null;
    const ex = cx + sg * nx * d, ey = cy + sg * ny * d;
    if (glen && Math.hypot(ex - glen.cx, ey - glen.cy) < glen.r + 2 * f) return null; // merged with the dome
    const e = edgeAlong(ctx, ex, ey, sg * nx, sg * ny, Math.max(3, 1.6 * f), -1, 1);
    if (!e || e.atLimit || e.strength < 0.35 * (stem.edgeStrength || 0.1)) return null;
    out.push([e.x, e.y]);
  }
  return { t, c: [cx, cy], p: out[0], q: out[1], width: Math.hypot(out[0][0] - out[1][0], out[0][1] - out[1][1]) };
}

// robust against thin crossing objects (cerclage wires): median of 5 nearby sections
function robustWidthAt(ctx, mo, stem, t, glen) {
  const c = [];
  for (const o of [0, -0.012, 0.012, -0.024, 0.024]) {
    const s = widthAt(ctx, mo, stem, t + o, glen);
    if (s) c.push(s);
  }
  if (c.length < 3) return null;
  const med = median(c.map((s) => s.width));
  const tol = Math.max(1, 0.04 * med);
  if (c[0].t === t && Math.abs(c[0].width - med) <= tol) return c[0];
  let best = null;
  for (const s of c) if (!best || Math.abs(s.width - med) < Math.abs(best.width - med)) best = s;
  return Math.abs(best.width - med) <= tol ? best : null;
}

function orientSection(s, toward) {
  // m = edge on the side of `toward` (the glenoid), l = the other (lateral) edge
  const dp = Math.hypot(s.p[0] - toward[0], s.p[1] - toward[1]);
  const dq = Math.hypot(s.q[0] - toward[0], s.q[1] - toward[1]);
  const [m, l] = dp <= dq ? [s.p, s.q] : [s.q, s.p];
  return { t: s.t, c: s.c, m, l, width: s.width };
}

// ------------------------------------------------------------------ reverse

function reverseInfo(ctx, opts = {}) {
  const key = `rev:${opts.mmPerPx || ctx.mmPerPx || 0}:${opts.rRange || ''}`;
  if (ctx[key] !== undefined) return ctx[key];
  const M = metalInfo(ctx);
  const res = (ctx[key] = { result: null, hemiPattern: false });
  if (!M.present) return res;
  const { f, w, h } = ctx;
  const [rmin, rmax] = radiusRange(ctx, opts, 15, 26, 0.02, 0.12);
  const B = maskBoundary(ctx, M.mask);
  if (B.n < 30) return res;
  const cands = houghCircles(ctx, B, rmin, rmax, 8);
  const domes = [];
  for (const c of cands) {
    if (c.r < rmin * 0.9 || c.r > rmax * 1.1) continue;
    const d = refineDome(ctx, M, c);
    if (d && d.r / f >= rmin * 0.9 && d.r / f <= rmax * 1.1) domes.push(d);
  }
  domes.sort((a, b) => b.score - a.score);
  for (const g of domes.slice(0, 3)) {
    const cw = [ctx.toWork(g.cx), ctx.toWork(g.cy)], rw = g.r / f;
    const { labels, bodies, mask: mo } = metalBodies(ctx, M, { cx: cw[0], cy: cw[1], r: rw + 1.5 });
    let stemBody = null, back = false;
    for (const b of bodies) {
      if (b.length < 2 * rw || b.elong < 2.2) continue;
      // which side of the face is the part of the body nearest to the dome?
      const pix = bodyPixels(ctx, labels, b.label, b);
      let dmin = Infinity;
      for (let i = 0; i < pix.xs.length; i++) {
        const d = Math.hypot(pix.xs[i] - cw[0], pix.ys[i] - cw[1]);
        if (d < dmin) dmin = d;
      }
      if (dmin > 2.6 * rw) continue; // not related to this dome
      let sum = 0, cnt = 0;
      for (let i = 0; i < pix.xs.length; i++) {
        const ddx = pix.xs[i] - cw[0], ddy = pix.ys[i] - cw[1];
        if (Math.hypot(ddx, ddy) > dmin + 1.2 * rw) continue;
        sum += ddx * g.axis[0] + ddy * g.axis[1];
        cnt++;
      }
      const side = cnt ? sum / cnt : 0;
      if (side < -0.15 * rw) {
        // a long metal body attached behind the flat face: stemmed head, not a glenosphere
        if (b.length >= 2.5 * rw) back = true;
        continue;
      }
      if (!stemBody || b.length > stemBody.length) { stemBody = b; stemBody.pix = pix; }
    }
    if (back && !stemBody) { res.hemiPattern = true; continue; }
    let stem = null;
    if (stemBody) {
      const ax = stemAxis(ctx, stemBody.pix, stemBody, cw);
      if (ax) {
        const widths = [];
        for (let i = 0; i <= 17; i++) {
          const t = Math.round((0.1 + 0.05 * i) * 100) / 100;
          const s = robustWidthAt(ctx, mo, ax, t, g);
          if (s) widths.push(orientSection(s, [g.cx, g.cy]));
        }
        stem = { a: ax.a, b: ax.b, widths, truncated: ax.truncated };
        res.stemInternal = { ...ax, mo };
      }
    }
    const ref = stem ? (stem.a[0] + stem.b[0]) / 2 - g.cx : g.axis[0];
    const { edgeStrength, ...glenosphere } = g;
    res.result = {
      glenosphere,
      stem,
      side: ref < 0 ? 'left-of-glenoid' : 'right-of-glenoid',
      metalFraction: M.fraction,
    };
    res.hemiPattern = false;
    return res;
  }
  return res;
}

/**
 * Reverse shoulder arthroplasty: glenosphere dome (circle + flat back face)
 * and humeral stem. Returns null when no convincing dome is found (native
 * shoulder, stemmed head prosthesis, unrelated metal).
 * @param {{width:number,height:number,data:Float32Array}} img
 * @param {{mmPerPx?:number, invert?:boolean, rRange?:[number,number]}} [opts]
 */
export function detectReverse(img, opts = {}) {
  const r = reverseRaw(img, opts);
  // Canonical orientation: the stem-axis tracker is slightly direction-dependent (up to ~3° between an image and
  // its mirror), so an image with the humerus on the right of the glenoid is analysed mirrored and mapped back.
  // That makes the result exactly independent of which shoulder is shown.
  if (r && r.side === 'right-of-glenoid') {
    const rm = reverseRaw(mirrored(img), opts);
    if (rm && rm.side === 'left-of-glenoid') return mirrorReverse(rm, img.width);
  }
  return r;
}

function reverseRaw(img, opts = {}) {
  const ctx = prepare(img, opts);
  const g = reverseInfo(ctx, opts).result;
  return g && g.glenosphere.score >= (opts.minScore ?? 0.3) ? g : null;
}

const mirrorCache = new WeakMap();
function mirrored(img) {
  const hit = mirrorCache.get(img);
  if (hit && hit.src === img.data) return hit.img;
  const { width: w, height: h, data } = img;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = data[row + w - 1 - x];
  }
  const m = { width: w, height: h, data: out };
  mirrorCache.set(img, { src: data, img: m });
  return m;
}

const mx = (p, w) => [w - 1 - p[0], p[1]];
function mirrorReverse(r, w) {
  const g = r.glenosphere;
  const out = {
    ...r,
    glenosphere: { ...g, cx: w - 1 - g.cx, face: { a: mx(g.face.a, w), b: mx(g.face.b, w) }, axis: [-g.axis[0], g.axis[1]] },
    side: r.side === 'left-of-glenoid' ? 'right-of-glenoid' : 'left-of-glenoid',
  };
  if (r.stem) {
    out.stem = { ...r.stem, a: mx(r.stem.a, w), b: mx(r.stem.b, w) };
    if (r.stem.dir) out.stem.dir = [-r.stem.dir[0], r.stem.dir[1]];
    if (Array.isArray(r.stem.widths)) out.stem.widths = r.stem.widths.map((s) => ({ ...s, c: s.c && mx(s.c, w), m: s.m && mx(s.m, w), l: s.l && mx(s.l, w) }));
  }
  return out;
}

function mirrorEstimates(est, w) {
  const out = {};
  for (const [id, e] of Object.entries(est)) out[id] = e.a ? { ...e, a: mx(e.a, w), b: mx(e.b, w) } : { ...e, x: w - 1 - e.x };
  return out;
}

// ------------------------------------------------------------------ head

// per-degree edge support of a circle in the (blurred) working image
function arcSupport(ctx, M, cx, cy, r, minStrength) {
  const { w, h } = ctx;
  const g = gradients(ctx);
  const ub = ctx.ub;
  const sup = new Uint8Array(360); // 1 supported, 2 occluded by metal
  const pts = [];
  const half = Math.max(2, 0.12 * r);
  const mAt = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    return x >= 0 && y >= 0 && x < w && y < h ? M.mask[y * w + x] : 0;
  };
  for (let k = 0; k < 360; k++) {
    const c = Math.cos((k * Math.PI) / 180), s = Math.sin((k * Math.PI) / 180);
    if (M.present && mAt(cx + (r - half) * c, cy + (r - half) * s) && mAt(cx + (r + half) * c, cy + (r + half) * s)) { sup[k] = 2; continue; }
    // strongest inward-brightening radial gradient near r
    let best = 0, bo = 0;
    for (let o = -half; o <= half; o += 0.5) {
      const x = cx + (r + o) * c, y = cy + (r + o) * s;
      if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
      const gxv = bilinear(g.gx, w, h, x, y), gyv = bilinear(g.gy, w, h, x, y);
      const rad = -(gxv * c + gyv * s);
      const mg = Math.hypot(gxv, gyv);
      if (rad > best && rad > 0.8 * mg) { best = rad; bo = o; }
    }
    if (best >= minStrength && Math.abs(bo) < half - 0.25) { sup[k] = 1; pts.push(k, bo, best); }
  }
  void ub;
  return { sup, pts };
}

function refineHead(ctx, cx, cy, r, sup, tw) {
  // full-resolution radial edges on supported degrees → robust circle
  const pts = [], str = [];
  let tried = 0;
  for (let k = 0; k < 360; k++) {
    if (sup[k] !== 1) continue;
    tried++;
    const c = Math.cos((k * Math.PI) / 180), s = Math.sin((k * Math.PI) / 180);
    const e = edgeAlong(ctx, cx + r * c, cy + r * s, c, s, Math.max(3, 0.1 * r), -1, tw);
    if (!e || e.atLimit) continue;
    pts.push(e.x, e.y); str.push(e.strength);
  }
  if (pts.length < 40) return null;
  const ms = median(str);
  const good = [];
  for (let i = 0; i < str.length; i++) if (str[i] >= 0.4 * ms) good.push(pts[2 * i], pts[2 * i + 1]);
  const fit = robustCircle(good, Math.max(0.8, 0.015 * r));
  if (!fit) return null;
  fit.tried = tried;
  return fit;
}

function supportStats(sup) {
  let n1 = 0, n2 = 0, sx = 0, sy = 0;
  for (let k = 0; k < 360; k++) {
    if (sup[k] === 1) { n1++; sx += Math.cos((k * Math.PI) / 180); sy += Math.sin((k * Math.PI) / 180); }
    else if (sup[k] === 2) n2++;
  }
  // longest unsupported gap
  let gap = 0, run = 0;
  for (let k = 0; k < 720; k++) {
    if (sup[k % 360] !== 1) { run++; if (run > gap) gap = run; } else run = 0;
  }
  return { n1, n2, mx: sx / Math.max(1, n1), my: sy / Math.max(1, n1), gap: Math.min(360, gap) };
}

function discMedian(ctx, cx, cy, r0, r1, skipMetal, M) {
  const { w, h, u } = ctx;
  const v = [];
  const stepA = 0.2, stepR = Math.max(1, (r1 - r0) / 6);
  for (let rr = r0 + (r0 === 0 ? stepR : 0); rr <= r1; rr += stepR) {
    for (let a = 0; a < 2 * Math.PI; a += stepA) {
      const x = Math.round(cx + rr * Math.cos(a)), y = Math.round(cy + rr * Math.sin(a));
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (skipMetal && M.mask[y * w + x]) continue;
      v.push(u[y * w + x]);
    }
  }
  return v.length ? median(v) : NaN;
}

function headInfo(ctx, opts = {}) {
  const key = `head:${opts.mmPerPx || ctx.mmPerPx || 0}:${opts.rRange || ''}`;
  if (ctx[key] !== undefined) return ctx[key];
  const M = metalInfo(ctx);
  const { f, w, h } = ctx;
  const g = gradients(ctx);
  const [rmin, rmax] = radiusRange(ctx, opts, 17, 32, 0.04, 0.14);
  const res = (ctx[key] = { result: null, stemLike: false });
  let stemBody = null, bodiesInfo = null;
  if (M.present) {
    bodiesInfo = metalBodies(ctx, M, null);
    for (const b of bodiesInfo.bodies) {
      if (b.length < 0.12 * Math.min(w, h) || b.elong < 2.2) continue;
      if (!stemBody || b.length > stemBody.length) stemBody = b;
    }
    res.stemLike = !!stemBody;
  }
  // ---- prosthetic head attached to a stem
  if (stemBody) {
    const pad = 2.3 * rmax;
    const x0 = Math.max(1, Math.floor(stemBody.minX - pad)), x1 = Math.min(w - 2, Math.ceil(stemBody.maxX + pad));
    const y0 = Math.max(1, Math.floor(stemBody.minY - pad)), y1 = Math.min(h - 2, Math.ceil(stemBody.maxY + pad));
    // metal boundary gradient as the yard-stick for "strong" edges
    const mb = [];
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const i = y * w + x;
        if (M.mask[i] && !(M.mask[i - 1] && M.mask[i + 1] && M.mask[i - w] && M.mask[i + w])) mb.push(g.mag[i]);
      }
    }
    const gm = mb.length ? median(mb) : 0.1;
    const thr = 0.14 * gm;
    const px = [], py = [], nx = [], ny = [], wt = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x, mg = g.mag[i];
        if (mg < thr) continue;
        px.push(x); py.push(y); nx.push(g.gx[i] / mg); ny.push(g.gy[i] / mg); wt.push(Math.min(1, mg / (0.5 * gm)));
      }
    }
    const cands = houghCircles(ctx, { px, py, nx, ny, wt, n: px.length }, rmin, rmax, 8);
    const pix = bodyPixels(ctx, bodiesInfo.labels, stemBody.label, stemBody);
    let best = null;
    for (const c of cands) {
      const li = discMedian(ctx, c.cx, c.cy, 0, 0.55 * c.r, false, M);
      const lo = discMedian(ctx, c.cx, c.cy, 1.15 * c.r, 1.45 * c.r, true, M);
      if (!(li - lo >= 0.07) && !(li >= M.T)) continue; // must be clearly denser than its surroundings
      const as = arcSupport(ctx, M, c.cx, c.cy, c.r, 0.1 * gm);
      const st = supportStats(as.sup);
      if (st.n1 < 150 || st.n1 + st.n2 < 185) continue;
      // nearest stem pixel must be close and must lie on the unsupported (back) side
      let dmin = Infinity, qx = 0, qy = 0;
      for (let i = 0; i < pix.xs.length; i++) {
        const d = Math.hypot(pix.xs[i] - c.cx, pix.ys[i] - c.cy);
        if (d < dmin) { dmin = d; qx = pix.xs[i]; qy = pix.ys[i]; }
      }
      if (dmin > 1.5 * c.r) continue;
      // direction from the centre to the stem body (centroid of the part within 2.5 r)
      let sx = 0, sy = 0, cnt = 0;
      for (let i = 0; i < pix.xs.length; i++) {
        const ddx = pix.xs[i] - c.cx, ddy = pix.ys[i] - c.cy;
        if (Math.hypot(ddx, ddy) > 2.5 * c.r) continue;
        sx += ddx; sy += ddy; cnt++;
      }
      void qx; void qy;
      const sl = Math.hypot(sx, sy) || 1;
      const facing = (st.mx * sx + st.my * sy) / sl; // > 0: the arc faces the stem (reverse dome)
      if (st.n1 < 330 && facing > 0.05) continue;
      const fit = refineHead(ctx, ctx.toFull(c.cx), ctx.toFull(c.cy), c.r * f, as.sup, 1);
      if (!fit || fit.r / f < rmin * 0.9 || fit.r / f > rmax * 1.1) continue;
      const score = Math.min(1, (fit.inliers / 360) * Math.max(0, 1 - fit.rms / (0.03 * fit.r + 0.5)) * 1.25);
      if (!best || score > best.score) best = { cx: fit.cx, cy: fit.cy, r: fit.r, score, kind: 'implant', arcDeg: st.n1 };
    }
    if (best && best.score >= 0.3) { res.result = best; return res; }
  }
  // a reverse prosthesis has no humeral head to find
  if (M.present && reverseInfo(ctx, opts).result) return res;
  if (stemBody) return res; // stemmed implant of unknown type: do not guess a bony head next to it
  // ---- bony head: gradient Hough over the strongest edges
  const mags = [];
  for (let i = 0; i < g.mag.length; i += 3) mags.push(g.mag[i]);
  const [p80, p97] = percentiles(Float32Array.from(mags), [80, 97]);
  if (!(p97 > 0)) return res;
  let near = null;
  if (M.present) { // ignore edges next to small metal objects (markers, anchors)
    near = distanceTransformSq(M.mask, w, h, 1);
  }
  const px = [], py = [], nx = [], ny = [], wt = [];
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x, mg = g.mag[i];
      if (mg < p80 || (near && near[i] < 16)) continue;
      px.push(x); py.push(y); nx.push(g.gx[i] / mg); ny.push(g.gy[i] / mg); wt.push(Math.min(1, mg / p97));
    }
  }
  const cands = houghCircles(ctx, { px, py, nx, ny, wt, n: px.length }, rmin, rmax, 8);
  let best = null;
  const none = { present: false, mask: M.mask };
  for (const c of cands) {
    const as = arcSupport(ctx, near ? M : none, c.cx, c.cy, c.r, 0.6 * p80);
    const st = supportStats(as.sup);
    if (st.n1 < 90) continue;
    const fit = refineHead(ctx, ctx.toFull(c.cx), ctx.toFull(c.cy), c.r * f, as.sup, 2);
    if (!fit || fit.r / f < rmin * 0.9 || fit.r / f > rmax * 1.1) continue;
    // interior must be brighter than the ring outside it
    const cwx = ctx.toWork(fit.cx), cwy = ctx.toWork(fit.cy), rw = fit.r / f;
    const li = discMedian(ctx, cwx, cwy, 0.5 * rw, 0.9 * rw, false, M);
    const lo = discMedian(ctx, cwx, cwy, 1.1 * rw, 1.35 * rw, false, M);
    if (!(li > lo)) continue;
    const score = Math.min(1, (fit.inliers / 360) * Math.max(0, 1 - fit.rms / (0.04 * fit.r + 0.5)));
    if (!best || score > best.score) best = { cx: fit.cx, cy: fit.cy, r: fit.r, score, kind: 'bone', arcDeg: st.n1 };
  }
  if (best && best.score >= 0.2) res.result = best;
  return res;
}

/**
 * Humeral head as a circle: a prosthetic head on a stem (kind 'implant';
 * metal or moderately radiodense pyrocarbon) or the bony head outline of a
 * native shoulder (kind 'bone', weaker confidence). null when not found.
 * @param {{mmPerPx?:number, invert?:boolean, rRange?:[number,number]}} [opts]
 * @returns {{cx:number,cy:number,r:number,score:number,kind:'implant'|'bone',arcDeg:number}|null}
 */
export function detectHead(img, opts = {}) {
  const ctx = prepare(img, opts);
  return headInfo(ctx, opts).result;
}

// ------------------------------------------------------------------ classify

/**
 * @returns {{kind:'reverse'|'hemi'|'native'|'unknown', confidence:number, reverse:object|null, head:object|null, metal:object}}
 */
export function classify(img, opts = {}) {
  const ctx = prepare(img, opts);
  const metal = detectMetal(img, opts);
  let reverse = null, head = null, kind = 'unknown', confidence = 0;
  if (metal.present) {
    reverse = detectReverse(img, opts);
    if (reverse) {
      kind = 'reverse';
      confidence = Math.min(1, reverse.glenosphere.score * (reverse.stem ? 1.1 : 0.7));
    } else {
      const hi = headInfo(ctx, opts);
      head = hi.result;
      if (head && head.kind === 'implant') { kind = 'hemi'; confidence = head.score; }
      else if (hi.stemLike || reverseInfo(ctx, opts).hemiPattern) { kind = 'unknown'; confidence = 0.2; head = null; }
      else { kind = 'native'; confidence = head ? 0.3 + 0.5 * head.score : 0.25; } // only small metal (marker, anchor)
    }
  } else if (!ctx.flat) {
    head = detectHead(img, opts);
    kind = 'native';
    confidence = head ? 0.45 + 0.5 * head.score : 0.3;
  }
  return { kind, confidence, reverse, head, metal };
}

// ------------------------------------------------------------------ landmark estimates

// profile along a ray (full-res), stopping before metal
function rayProfile(ctx, x0, y0, dx, dy, len, T, tw = 2) {
  const step = Math.max(1, ctx.f / 2);
  const n = Math.max(2, Math.floor(len / step));
  const g = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -tw; k <= tw; k++) s += ctx.sample(x0 + dx * i * step - dy * k * step, y0 + dy * i * step + dx * k * step);
    s /= 2 * tw + 1;
    if (s >= T) break;
    g.push(s);
  }
  return { g, step };
}

// edges of a profile: sign +1 rising, -1 falling. mode 'first' | 'strongest' | 'last'
function profileEdge(pr, sign, mode, minStrength, k = 2) {
  const { g, step } = pr;
  const n = g.length;
  if (n < 2 * k + 3) return null;
  const d = new Float32Array(n);
  let mx = 0;
  for (let i = k; i < n - k; i++) { d[i] = sign * (g[i + k] - g[i - k]); if (d[i] > mx) mx = d[i]; }
  if (mx < minStrength) return null;
  let bi = -1;
  if (mode === 'strongest') { for (let i = k; i < n - k; i++) if (d[i] === mx) { bi = i; break; } }
  else {
    const thr = Math.max(minStrength, 0.5 * mx);
    const idx = [];
    for (let i = k + 1; i < n - k - 1; i++) if (d[i] >= thr && d[i] >= d[i - 1] && d[i] >= d[i + 1]) idx.push(i);
    if (!idx.length) return null;
    bi = mode === 'first' ? idx[0] : idx[idx.length - 1];
  }
  return { dist: bi * step, strength: d[bi], rel: d[bi] / mx };
}

/**
 * Best-effort STARTING positions for landmarks (the UI must present them as
 * "estimated — drag to correct"). Geometric priors relative to the implant
 * plus a local edge search. Only stemM / stemD are true measurements.
 * @param {object} det result of classify() or detectReverse()
 * @param {{protocol?:string, mmPerPx?:number, invert?:boolean}} [opts]
 * @returns {Object<string, {x:number,y:number,confidence:number}|{a:number[],b:number[],confidence:number}>}
 */
export function estimateLandmarks(img, det, opts = {}) {
  const rev0 = det && (det.glenosphere ? det : det.reverse);
  if (rev0 && rev0.side === 'right-of-glenoid') {
    // same canonical-orientation rule as detectReverse
    return mirrorEstimates(estimateRaw(mirrored(img), mirrorReverse(rev0, img.width), opts), img.width);
  }
  return estimateRaw(img, det, opts);
}

function estimateRaw(img, det, opts = {}) {
  const out = {};
  const protocol = opts.protocol || 'rsa-ap';
  const rev = det && (det.glenosphere ? det : det.reverse);
  if (protocol !== 'rsa-ap' || !rev || !rev.glenosphere) return out;
  const ctx = prepare(img, opts);
  const M = metalInfo(ctx);
  const T = M.present ? M.T * 0.92 : 2;
  const g = rev.glenosphere;
  const mmPerPx = opts.mmPerPx || ctx.mmPerPx;
  const mm = mmPerPx > 0 ? 1 / mmPerPx : g.r / 19.5; // px per mm (assumes a ~39 mm sphere when uncalibrated)
  const calib = mmPerPx > 0 ? 1 : 0.85;
  const [ux, uy] = g.axis;
  const fa = g.face.a, fb = g.face.b;
  const FL = Math.hypot(fb[0] - fa[0], fb[1] - fa[1]);
  const vx = (fb[0] - fa[0]) / FL, vy = (fb[1] - fa[1]) / FL; // along the face, inferior
  const lat = ux >= 0 ? 1 : -1; // image direction of "lateral"
  const base = g.score * calib;
  const pt = (p, c) => ({ x: p[0], y: p[1], confidence: Math.max(0.05, Math.min(0.95, c)) });
  const minE = 0.02;

  // inferior / superior bony glenoid rim: first bone edge met when walking along
  // a line 2 mm medial to the face from outside the dome towards its middle
  const off = 2 * mm;
  {
    const sx = fb[0] - ux * off + vx * 7 * mm, sy = fb[1] - uy * off + vy * 7 * mm;
    const pr = rayProfile(ctx, sx, sy, -vx, -vy, 7 * mm + 0.45 * FL, T);
    const e = profileEdge(pr, 1, 'strongest', minE);
    if (e) out.igr = pt([sx - vx * e.dist + ux * off, sy - vy * e.dist + uy * off], 0.55 * base);
    else out.igr = pt([fb[0] - vx * 3 * mm, fb[1] - vy * 3 * mm], 0.2 * base);
  }
  {
    const sx = fa[0] - ux * off - vx * 8 * mm, sy = fa[1] - uy * off - vy * 8 * mm;
    const pr = rayProfile(ctx, sx, sy, vx, vy, 8 * mm + 0.4 * FL, T);
    const e = profileEdge(pr, 1, 'strongest', minE);
    if (e) out.sgt = pt([sx + vx * e.dist + ux * off, sy + vy * e.dist + uy * off], 0.5 * base);
    else out.sgt = pt([fa[0] - ux * mm, fa[1] - uy * mm], 0.2 * base);
  }
  const sgt = [out.sgt.x, out.sgt.y];

  // lateral acromion: most lateral bone→soft-tissue edge in a band above the glenoid
  {
    let best = null, strongest = 0;
    const rows = [];
    for (let dy = -30; dy <= -8; dy += 1.5) {
      const y = fa[1] + dy * mm, x0 = fa[0] + lat * 4 * mm;
      const pr = rayProfile(ctx, x0, y, lat, 0, 46 * mm, T);
      const e = profileEdge(pr, -1, 'last', minE);
      if (!e) continue;
      rows.push({ x: x0 + lat * e.dist, y, s: e.strength });
      if (e.strength > strongest) strongest = e.strength;
    }
    for (const r of rows) if (r.s >= 0.5 * strongest && (!best || lat * (r.x - best.x) > 0)) best = r;
    if (best) out.acr = pt([best.x, best.y], 0.4 * base);
    else out.acr = pt([fa[0] + lat * 26 * mm, fa[1] - 17 * mm], 0.15 * base);
  }

  // floor of the supraspinatus fossa: brightest thin line running medially from the superior glenoid
  {
    const md = -lat;
    let best = null;
    const resp = [];
    const dl = 2.5 * mm;
    for (let ang = -15; ang <= 35; ang += 2.5) {
      const a = (ang * Math.PI) / 180;
      const dx = md * Math.cos(a), dy = -Math.sin(a); // ang > 0: rising medially
      const nx = -dy, ny = dx;
      for (let o = -10; o <= 12; o += 0.75) {
        const bx = sgt[0] + md * 5 * mm + nx * o * mm, by = sgt[1] + ny * o * mm;
        let s = 0, cnt = 0;
        for (let t = 2; t <= 46; t += 2) {
          const x = bx + dx * t * mm, y = by + dy * t * mm;
          const c = ctx.sample(x, y);
          if (c >= T) continue;
          s += c - 0.5 * (ctx.sample(x + nx * dl, y + ny * dl) + ctx.sample(x - nx * dl, y - ny * dl));
          cnt++;
        }
        if (cnt < 15) continue;
        s /= cnt;
        resp.push(s);
        if (!best || s > best.s) best = { s, a: [bx + dx * 46 * mm, by + dy * 46 * mm], b: [bx + dx * 2 * mm, by + dy * 2 * mm] };
      }
    }
    if (best && best.s > 0.004) {
      const contrast = Math.min(1, (best.s - median(resp)) / 0.03);
      out.ssf = { a: best.a, b: best.b, confidence: Math.max(0.05, 0.45 * base * contrast) };
    } else {
      const a = (10 * Math.PI) / 180;
      const b = [sgt[0] + md * 7 * mm, sgt[1] + 4 * mm];
      out.ssf = { a: [b[0] + md * 44 * mm * Math.cos(a), b[1] - 44 * mm * Math.sin(a)], b, confidence: 0.1 * base };
    }
  }

  // humeral side: needs the stem
  const st = rev.stem;
  if (st) {
    const SL = Math.hypot(st.b[0] - st.a[0], st.b[1] - st.a[1]);
    const dx = (st.b[0] - st.a[0]) / SL, dy = (st.b[1] - st.a[1]) / SL;
    let nx = -dy, ny = dx; // lateral normal: away from the glenosphere
    if ((g.cx - st.a[0]) * nx + (g.cy - st.a[1]) * ny > 0) { nx = -nx; ny = -ny; }
    // skip metal along a ray, then return the start of non-metal
    const skipMetal = (x, y, ddx, ddy, max) => {
      const step = Math.max(1, ctx.f / 2);
      let clear = 0;
      for (let d = 0; d < max; d += step) {
        if (ctx.sample(x + ddx * d, y + ddy * d) < T) { clear += step; if (clear >= 1.2 * mm) return d; } else clear = 0;
      }
      return -1;
    };
    // greater tuberosity: outer bone edge lateral to the proximal stem
    {
      const cand = [];
      for (let s = -8; s <= 36; s += 1.5) {
        const x = st.a[0] + dx * s * mm, y = st.a[1] + dy * s * mm;
        const d0 = skipMetal(x, y, nx, ny, 40 * mm);
        if (d0 < 0) continue;
        const pr = rayProfile(ctx, x + nx * d0, y + ny * d0, nx, ny, 30 * mm, T);
        const e = profileEdge(pr, -1, 'strongest', minE);
        if (e) cand.push({ x: x + nx * (d0 + e.dist), y: y + ny * (d0 + e.dist), s: e.strength });
      }
      const ms = cand.length ? median(cand.map((c) => c.s)) : 0;
      let best = null;
      for (const c of cand) if (c.s >= 0.5 * ms && (!best || lat * (c.x - best.x) > 0)) best = c;
      if (best) out.gtl = pt([best.x, best.y], 0.45 * base);
    }
    {
      const cand = [];
      for (let k = 5; k <= 27; k += 1.5) {
        const x = st.a[0] + dx * 12 * mm + nx * k * mm, y = st.a[1] + dy * 12 * mm + ny * k * mm;
        const d0 = skipMetal(x, y, 0, -1, 30 * mm);
        if (d0 < 0) continue;
        const pr = rayProfile(ctx, x, y - d0, 0, -1, 34 * mm, T);
        const e = profileEdge(pr, -1, 'first', minE);
        if (e) cand.push({ x, y: y - d0 - e.dist, s: e.strength });
      }
      const ms = cand.length ? median(cand.map((c) => c.s)) : 0;
      let best = null;
      for (const c of cand) if (c.s >= 0.5 * ms && (!best || c.y < best.y)) best = c;
      if (best) out.gts = pt([best.x, best.y], 0.4 * base);
    }
    // acromion undersurface above the tuberosity
    if (out.gts) {
      let x = out.gts.x;
      if (out.acr && lat * (x - out.acr.x) > -3 * mm) x = out.acr.x - lat * 4 * mm;
      const y0 = out.gts.y - 2.5 * mm;
      const pr = rayProfile(ctx, x, y0, 0, -1, Math.min(70 * mm, y0 - 2), T);
      const e = profileEdge(pr, 1, 'first', minE);
      if (e) out.acu = pt([x, y0 - e.dist], 0.4 * base);
    }
    // stem widths (true detections) and canal widths at two levels
    const ri = reverseInfo(ctx, opts);
    const si = ri.stemInternal;
    const mo = si ? si.mo : openedMask(ctx, M);
    const geom = si || { a: st.a, b: st.b, dir: [dx, dy], edgeStrength: 0.1 };
    for (const [id, t] of [['M', STEM_LEVELS.metaphyseal], ['D', STEM_LEVELS.distal]]) {
      const raw = robustWidthAt(ctx, mo, geom, t, g);
      if (!raw) continue;
      const s = orientSection(raw, [g.cx, g.cy]);
      out['stem' + id] = { a: s.m, b: s.l, confidence: Math.min(0.95, 0.6 + 0.4 * g.score) };
      // inner cortex on each side: rising edge (canal → cortex) before the outer cortex edge
      const ends = [];
      let conf = 0.5;
      for (const [p, sg] of [[s.m, -1], [s.l, 1]]) {
        const ex = sg * nx, ey = sg * ny;
        const start = 0.8 * mm;
        const pr = rayProfile(ctx, p[0] + ex * start, p[1] + ey * start, ex, ey, 22 * mm, T);
        const outer = profileEdge(pr, -1, 'strongest', minE);
        let inner = null;
        if (outer) {
          const cut = { g: pr.g.slice(0, Math.max(0, Math.round(outer.dist / pr.step) + 1)), step: pr.step };
          inner = profileEdge(cut, 1, 'strongest', 0.012);
        }
        if (inner) ends.push([p[0] + ex * (start + inner.dist), p[1] + ey * (start + inner.dist)]);
        else { ends.push([p[0], p[1]]); conf = 0.25; } // stem against the cortex, or no visible endosteal edge
      }
      out['canal' + id] = { a: ends[0], b: ends[1], confidence: conf * base };
    }
  }
  return out;
}
