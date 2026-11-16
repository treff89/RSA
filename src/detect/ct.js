// Classical (no ML) 3D analysis of shoulder CT volumes: metal, reverse-arthroplasty geometry, humeral head sphere.
// Volume: { dims:[nx,ny,nz], data:Int16Array (HU), origin, stepX, stepY, stepZ, spacing } (see src/dicom/loader.js).
// All input/output points are WORLD (patient LPS) mm.

// ------------------------------------------------------------------------------------------------
// small vector helpers
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------------
// volume geometry
const geomCache = new WeakMap();
function geom(v) {
  let g = geomCache.get(v);
  if (g) return g;
  const sx = v.stepX, sy = v.stepY, sz = v.stepZ;
  const m = [sx[0], sy[0], sz[0], sx[1], sy[1], sz[1], sx[2], sy[2], sz[2]];
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const inv = new Float64Array([
    (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det]);
  g = {
    inv, voxMm3: Math.abs(det),
    sp: [len(sx), len(sy), len(sz)],
    rowN: [Math.hypot(inv[0], inv[1], inv[2]), Math.hypot(inv[3], inv[4], inv[5]), Math.hypot(inv[6], inv[7], inv[8])],
  };
  geomCache.set(v, g);
  return g;
}

/** World mm -> continuous voxel index [i,j,k]. */
export function worldToIndex(volume, p) {
  const { inv } = geom(volume), o = volume.origin;
  const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2];
  return [inv[0] * dx + inv[1] * dy + inv[2] * dz, inv[3] * dx + inv[4] * dy + inv[5] * dz, inv[6] * dx + inv[7] * dy + inv[8] * dz];
}

/** Voxel index (may be fractional) -> world mm. */
export function indexToWorld(volume, i, j, k) {
  const o = volume.origin, a = volume.stepX, b = volume.stepY, c = volume.stepZ;
  return [o[0] + i * a[0] + j * b[0] + k * c[0], o[1] + i * a[1] + j * b[1] + k * c[1], o[2] + i * a[2] + j * b[2] + k * c[2]];
}

function makeSampler(volume) {
  const { inv } = geom(volume), o = volume.origin, data = volume.data;
  const [nx, ny, nz] = volume.dims, nxy = nx * ny;
  const i0m = inv[0], i1m = inv[1], i2m = inv[2], j0m = inv[3], j1m = inv[4], j2m = inv[5], k0m = inv[6], k1m = inv[7], k2m = inv[8];
  const mx = nx - 1, my = ny - 1, mz = nz - 1;
  return (x, y, z) => {
    const dx = x - o[0], dy = y - o[1], dz = z - o[2];
    const fi = i0m * dx + i1m * dy + i2m * dz, fj = j0m * dx + j1m * dy + j2m * dz, fk = k0m * dx + k1m * dy + k2m * dz;
    if (fi < 0 || fj < 0 || fk < 0 || fi > mx || fj > my || fk > mz) return -1024;
    const i = fi | 0, j = fj | 0, k = fk | 0;
    const i1 = i < mx ? i + 1 : i, j1 = j < my ? j + 1 : j, k1 = k < mz ? k + 1 : k;
    const tx = fi - i, ty = fj - j, tz = fk - k;
    const b00 = i + nx * j + nxy * k, b10 = i + nx * j1 + nxy * k, b01 = i + nx * j + nxy * k1, b11 = i + nx * j1 + nxy * k1;
    const c00 = data[b00] + (data[b00 - i + i1] - data[b00]) * tx;
    const c10 = data[b10] + (data[b10 - i + i1] - data[b10]) * tx;
    const c01 = data[b01] + (data[b01 - i + i1] - data[b01]) * tx;
    const c11 = data[b11] + (data[b11 - i + i1] - data[b11]) * tx;
    const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  };
}

/** Trilinear HU at a world point (-1024 outside the volume). */
export function sampleHU(volume, p) {
  let s = samplerCache.get(volume);
  if (!s) { s = makeSampler(volume); samplerCache.set(volume, s); }
  return s(p[0], p[1], p[2]);
}
const samplerCache = new WeakMap();
const getSampler = (v) => { let s = samplerCache.get(v); if (!s) { s = makeSampler(v); samplerCache.set(v, s); } return s; };

function decode(volume, q) {
  const nx = volume.dims[0], ny = volume.dims[1];
  const i = q % nx, r = (q - i) / nx, j = r % ny, k = (r - j) / ny;
  return [i, j, k];
}
function worldOf(volume, q) {
  const [i, j, k] = decode(volume, q);
  return indexToWorld(volume, i, j, k);
}

// ------------------------------------------------------------------------------------------------
// metal: threshold + 6-connected components (sparse, hash-based)
const metalCache = new WeakMap();

function labelSparse(idx, n, nx, ny) {
  const nxy = nx * ny;
  let size = 1; while (size < n * 2) size <<= 1;
  const mask = size - 1;
  const keys = new Int32Array(size).fill(-1), vals = new Int32Array(size);
  const h = (k) => (Math.imul(k, 0x9E3779B1) >>> 7) & mask;
  for (let p = 0; p < n; p++) { let s = h(idx[p]); while (keys[s] !== -1) s = (s + 1) & mask; keys[s] = idx[p]; vals[s] = p; }
  const find = (k) => { let s = h(k); while (keys[s] !== -1) { if (keys[s] === k) return vals[s]; s = (s + 1) & mask; } return -1; };
  const parent = new Int32Array(n); for (let p = 0; p < n; p++) parent[p] = p;
  const root = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const join = (a, b) => { a = root(a); b = root(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } };
  for (let p = 0; p < n; p++) {
    const k = idx[p];
    const i = k % nx, r = (k - i) / nx, j = r % ny, kk = (r - j) / ny;
    if (i > 0) { const o = find(k - 1); if (o >= 0) join(p, o); }
    if (j > 0) { const o = find(k - nx); if (o >= 0) join(p, o); }
    if (kk > 0) { const o = find(k - nxy); if (o >= 0) join(p, o); }
  }
  const label = new Int32Array(n);
  for (let p = 0; p < n; p++) label[p] = root(p);
  return label;
}

/** Internal: threshold + connected components. comps sorted by size desc, each { n, idx:Int32Array }. */
function analyzeMetal(volume, opts = {}) {
  const cacheable = Object.keys(opts).length === 0;
  if (cacheable && metalCache.has(volume)) return metalCache.get(volume);
  const { data, dims: [nx, ny] } = volume;
  const T0 = opts.minHU ?? 2500, minMm3 = opts.minVolumeMm3 ?? 150;
  const nTot = data.length;
  let cap = 1 << 16, idx = new Int32Array(cap), m = 0, max = -32768;
  for (let q = 0; q < nTot; q++) {
    const v = data[q];
    if (v > T0) {
      if (m === cap) { cap *= 2; const t = new Int32Array(cap); t.set(idx); idx = t; }
      idx[m++] = q;
      if (v > max) max = v;
    }
  }
  const res = { thresholdHU: T0, max: m ? max : T0, saturated: false, comps: [], voxels: 0 };
  if (m === 0) { if (cacheable) metalCache.set(volume, res); return res; }
  const T = Math.max(T0, Math.min(opts.maxThresholdHU ?? 3000, 0.45 * max));
  res.thresholdHU = T;
  let w = 0, cntMax = 0;
  for (let p = 0; p < m; p++) { const v = data[idx[p]]; if (v > T) { idx[w++] = idx[p]; if (v === max) cntMax++; } }
  m = w;
  res.saturated = max >= 2800 && cntMax >= 200 && cntMax >= 0.02 * m;
  if (m === 0) { if (cacheable) metalCache.set(volume, res); return res; }
  const label = labelSparse(idx, m, nx, ny);
  const counts = new Map();
  for (let p = 0; p < m; p++) counts.set(label[p], (counts.get(label[p]) || 0) + 1);
  const vox = geom(volume).voxMm3, minVox = Math.max(3, Math.ceil(minMm3 / vox));
  const keep = [...counts.entries()].filter(([, c]) => c >= minVox).sort((a, b) => b[1] - a[1]);
  for (const [lab, c] of keep) {
    const arr = new Int32Array(c); let t = 0;
    for (let p = 0; p < m; p++) if (label[p] === lab) arr[t++] = idx[p];
    res.comps.push({ n: c, idx: arr });
    res.voxels += c;
  }
  if (cacheable) metalCache.set(volume, res);
  return res;
}

/** Metal present? -> { present, thresholdHU, voxels, volumeMm3, bbox:{min,max}, saturated } */
export function detectMetal(volume, opts = {}) {
  const M = analyzeMetal(volume, opts);
  const vox = geom(volume).voxMm3;
  const out = { present: M.comps.length > 0, thresholdHU: M.thresholdHU, voxels: M.voxels, volumeMm3: M.voxels * vox, bbox: { min: [0, 0, 0], max: [0, 0, 0] }, saturated: M.comps.length > 0 && M.saturated };
  if (out.present) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const c of M.comps) for (let p = 0; p < c.n; p++) {
      const w = worldOf(volume, c.idx[p]);
      for (let a = 0; a < 3; a++) { if (w[a] < mn[a]) mn[a] = w[a]; if (w[a] > mx[a]) mx[a] = w[a]; }
    }
    out.bbox = { min: mn, max: mx };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// ray casting for sub-voxel half-maximum edge points
function fibDirs(n) {
  const out = new Float64Array(3 * n), ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n, r = Math.sqrt(1 - z * z), th = ga * i;
    out[3 * i] = r * Math.cos(th); out[3 * i + 1] = r * Math.sin(th); out[3 * i + 2] = z;
  }
  return out;
}

/**
 * From `seed` (inside the object) cast rays; per ray find the exit (HU stays < lo for `win` mm), then the half-maximum
 * crossing between the local plateau (max in the preceding plateauWin mm) and the background (20th percentile 2..5 mm beyond).
 */
function castEdges(S, seed, dirs, o) {
  const { tMax = 70, step = 0.3, lo, win = 2.5, plateauWin = 3, bgLo = 2, bgHi = 5, minContrast = 300 } = o;
  const nDir = dirs.length / 3;
  const wN = Math.ceil(win / step), pN = Math.ceil(plateauWin / step), b0 = Math.ceil(bgLo / step), b1 = Math.ceil(bgHi / step);
  const maxS = Math.floor(tMax / step);
  const buf = new Float32Array(maxS + b1 + 8), tmp = new Float32Array(b1 - b0 + 2);
  const pts = new Float64Array(3 * nDir);
  let cnt = 0;
  for (let r = 0; r < nDir; r++) {
    const dx = dirs[3 * r], dy = dirs[3 * r + 1], dz = dirs[3 * r + 2];
    const v0 = S(seed[0], seed[1], seed[2]);
    if (v0 < lo) break;
    buf[0] = v0;
    let n = 1, run = 0, e = -1;
    for (; n <= maxS; n++) {
      const t = n * step;
      const v = S(seed[0] + dx * t, seed[1] + dy * t, seed[2] + dz * t);
      buf[n] = v;
      if (v < lo) { run++; if (run >= wN) { e = n - run + 1; n++; break; } } else run = 0;
    }
    if (e < 0) continue;
    const end = e + b1;
    for (; n <= end && n < buf.length; n++) {
      const t = n * step;
      buf[n] = S(seed[0] + dx * t, seed[1] + dy * t, seed[2] + dz * t);
    }
    if (n <= end) continue;
    let pk = Math.max(0, e - pN), plateau = buf[pk];
    for (let q = pk + 1; q <= e; q++) if (buf[q] > plateau) { plateau = buf[q]; pk = q; }
    let nb = 0;
    for (let q = e + b0; q <= end; q++) tmp[nb++] = buf[q];
    for (let a = 1; a < nb; a++) { const x = tmp[a]; let b = a - 1; while (b >= 0 && tmp[b] > x) { tmp[b + 1] = tmp[b]; b--; } tmp[b + 1] = x; }
    const bg = tmp[Math.floor(0.2 * (nb - 1))];
    if (plateau - bg < minContrast) continue;
    const level = 0.5 * (plateau + bg);
    let mm = pk + 1;
    while (mm <= end && buf[mm] >= level) mm++;
    if (mm > end) continue;
    const frac = (buf[mm - 1] - level) / (buf[mm - 1] - buf[mm]);
    const t = (mm - 1 + frac) * step;
    pts[3 * cnt] = seed[0] + dx * t; pts[3 * cnt + 1] = seed[1] + dy * t; pts[3 * cnt + 2] = seed[2] + dz * t;
    cnt++;
  }
  return { pts, n: cnt, nRays: nDir };
}

// ------------------------------------------------------------------------------------------------
// sphere fitting
function solve4(A, b) {
  const n = 4, M = [];
  for (let i = 0; i < n; i++) M.push([A[i * 4], A[i * 4 + 1], A[i * 4 + 2], A[i * 4 + 3], b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k]; x[i] = s / M[i][i]; }
  return x;
}

function gnSphere(pts, sel, nSel, c, r) {
  c = c.slice();
  for (let it = 0; it < 8; it++) {
    const A = new Float64Array(16), g = [0, 0, 0, 0];
    for (let s = 0; s < nSel; s++) {
      const p = sel[s] * 3;
      const dx = pts[p] - c[0], dy = pts[p + 1] - c[1], dz = pts[p + 2] - c[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
      const J = [-dx / d, -dy / d, -dz / d, -1], e = d - r;
      for (let a = 0; a < 4; a++) { g[a] -= J[a] * e; for (let b = 0; b < 4; b++) A[a * 4 + b] += J[a] * J[b]; }
    }
    const dlt = solve4(A, g);
    if (!dlt) break;
    c[0] += dlt[0]; c[1] += dlt[1]; c[2] += dlt[2]; r += dlt[3];
    if (Math.abs(dlt[0]) + Math.abs(dlt[1]) + Math.abs(dlt[2]) + Math.abs(dlt[3]) < 1e-5) break;
  }
  return { c, r };
}

function sphere4(p0, p1, p2, p3) {
  const q = [sub(p1, p0), sub(p2, p0), sub(p3, p0)];
  const rhs = q.map((v) => dot(v, v) / 2);
  const [a, b, c] = q;
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (Math.abs(det) < 1e-6) return null;
  const d0 = rhs[0], d1 = rhs[1], d2 = rhs[2];
  const x = (d0 * (b[1] * c[2] - b[2] * c[1]) - a[1] * (d1 * c[2] - b[2] * d2) + a[2] * (d1 * c[1] - b[1] * d2)) / det;
  const y = (a[0] * (d1 * c[2] - b[2] * d2) - d0 * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * d2 - d1 * c[0])) / det;
  const z = (a[0] * (b[1] * d2 - d1 * c[1]) - a[1] * (b[0] * d2 - d1 * c[0]) + d0 * (b[0] * c[1] - b[1] * c[0])) / det;
  return { c: [p0[0] + x, p0[1] + y, p0[2] + z], r: Math.hypot(x, y, z) };
}

/** RANSAC + least-squares sphere with radius limits. pts: Float64Array xyz. */
function fitSphere(pts, n, { minR, maxR, tol, iters = 800, rng }) {
  if (n < 20) return null;
  let best = null, bestCnt = 0;
  const P = (i) => [pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]];
  for (let it = 0; it < iters; it++) {
    const i0 = (rng() * n) | 0, i1 = (rng() * n) | 0, i2 = (rng() * n) | 0, i3 = (rng() * n) | 0;
    if (i0 === i1 || i0 === i2 || i0 === i3 || i1 === i2 || i1 === i3 || i2 === i3) continue;
    const s = sphere4(P(i0), P(i1), P(i2), P(i3));
    if (!s || s.r < minR || s.r > maxR) continue;
    let cnt = 0;
    const [cx, cy, cz] = s.c;
    for (let i = 0; i < n; i++) {
      const dx = pts[3 * i] - cx, dy = pts[3 * i + 1] - cy, dz = pts[3 * i + 2] - cz;
      if (Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - s.r) < tol) cnt++;
    }
    if (cnt > bestCnt) { bestCnt = cnt; best = s; }
  }
  if (!best || bestCnt < 12) return null;
  let { c, r } = best, tolK = tol, sel = new Int32Array(n), nSel = 0, rms = 0;
  for (let round = 0; round < 5; round++) {
    nSel = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(pts[3 * i] - c[0], pts[3 * i + 1] - c[1], pts[3 * i + 2] - c[2]);
      if (Math.abs(d - r) < tolK) sel[nSel++] = i;
    }
    if (nSel < 12) return null;
    ({ c, r } = gnSphere(pts, sel, nSel, c, r));
    let ss = 0;
    for (let s = 0; s < nSel; s++) { const p = sel[s] * 3; const d = Math.hypot(pts[p] - c[0], pts[p + 1] - c[1], pts[p + 2] - c[2]) - r; ss += d * d; }
    rms = Math.sqrt(ss / nSel);
    tolK = Math.min(tol, Math.max(0.4, 2.5 * rms));
  }
  nSel = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(pts[3 * i] - c[0], pts[3 * i + 1] - c[1], pts[3 * i + 2] - c[2]) - r;
    if (Math.abs(d) < tolK) { sel[nSel++] = i; ss += d * d; }
  }
  rms = nSel ? Math.sqrt(ss / nSel) : Infinity;
  return { c, r, rms, sel: sel.subarray(0, nSel), nIn: nSel, tol: tolK };
}

/** Angular coverage (fraction of 128 equal-area cells with >= 2 inliers) and mean cell direction. */
function coverageAxis(pts, sel, c) {
  const NB = 8, NF = 16, cnt = new Int32Array(NB * NF);
  for (let s = 0; s < sel.length; s++) {
    const p = sel[s] * 3;
    const d = unit([pts[p] - c[0], pts[p + 1] - c[1], pts[p + 2] - c[2]]);
    const b = Math.min(NB - 1, Math.floor((d[2] + 1) / 2 * NB));
    const f = Math.min(NF - 1, Math.floor((Math.atan2(d[1], d[0]) + Math.PI) / (2 * Math.PI) * NF));
    cnt[b * NF + f]++;
  }
  let occ = 0; const sum = [0, 0, 0];
  for (let b = 0; b < NB; b++) for (let f = 0; f < NF; f++) {
    if (cnt[b * NF + f] < 2) continue;
    occ++;
    const cz = (b + 0.5) / NB * 2 - 1, ph = (f + 0.5) / NF * 2 * Math.PI - Math.PI, sr = Math.sqrt(1 - cz * cz);
    sum[0] += sr * Math.cos(ph); sum[1] += sr * Math.sin(ph); sum[2] += cz;
  }
  const mean = occ ? mul(sum, 1 / occ) : [0, 0, 0];
  return { coverage: occ / (NB * NF), resultant: len(mean), dir: len(mean) > 1e-6 ? unit(mean) : [0, 0, 1] };
}

// ------------------------------------------------------------------------------------------------
// PCA
function eig3(C) {
  const A = [C.slice(0, 3), C.slice(3, 6), C.slice(6, 9)];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
    if (off < 1e-12) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-14) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const vals = [A[0][0], A[1][1], A[2][2]];
  const order = [0, 1, 2].sort((a, b) => vals[b] - vals[a]);
  return { vals: order.map((i) => vals[i]), vecs: order.map((i) => [V[0][i], V[1][i], V[2][i]]) };
}

function pca(pts, n, sel = null) {
  const m = sel ? sel.length : n;
  const c = [0, 0, 0];
  for (let s = 0; s < m; s++) { const p = (sel ? sel[s] : s) * 3; c[0] += pts[p]; c[1] += pts[p + 1]; c[2] += pts[p + 2]; }
  c[0] /= m; c[1] /= m; c[2] /= m;
  const C = new Array(9).fill(0);
  for (let s = 0; s < m; s++) {
    const p = (sel ? sel[s] : s) * 3;
    const x = pts[p] - c[0], y = pts[p + 1] - c[1], z = pts[p + 2] - c[2];
    C[0] += x * x; C[1] += x * y; C[2] += x * z; C[4] += y * y; C[5] += y * z; C[8] += z * z;
  }
  C[3] = C[1]; C[6] = C[2]; C[7] = C[5];
  for (let i = 0; i < 9; i++) C[i] /= m;
  return { c, ...eig3(C) };
}

// ------------------------------------------------------------------------------------------------
// reverse shoulder arthroplasty
const DIRS_3000 = fibDirs(3000);
const DIRS_2500 = fibDirs(2500);

function compPlateau(volume, comp) {
  const step = Math.max(1, Math.floor(comp.n / 20000)), vals = [];
  for (let p = 0; p < comp.n; p += step) vals.push(volume.data[comp.idx[p]]);
  vals.sort((a, b) => a - b);
  return vals[Math.floor(0.9 * (vals.length - 1))];
}

function compSeed(volume, S, comp, lo) {
  const c = [0, 0, 0];
  const step = Math.max(1, Math.floor(comp.n / 50000));
  let m = 0;
  for (let p = 0; p < comp.n; p += step) { const ijk = decode(volume, comp.idx[p]); c[0] += ijk[0]; c[1] += ijk[1]; c[2] += ijk[2]; m++; }
  c[0] /= m; c[1] /= m; c[2] /= m;
  const sp = geom(volume).sp;
  let bestD = Infinity, bi = -1;
  for (let p = 0; p < comp.n; p += step) {
    const [i, j, k] = decode(volume, comp.idx[p]);
    const d = ((i - c[0]) * sp[0]) ** 2 + ((j - c[1]) * sp[1]) ** 2 + ((k - c[2]) * sp[2]) ** 2;
    if (d < bestD) { bestD = d; bi = p; }
  }
  const w = worldOf(volume, comp.idx[bi]);
  return S(w[0], w[1], w[2]) >= lo ? w : null;
}

function fitDome(volume, S, comp, opts) {
  const minR = opts.minRadiusMm ?? 14, maxR = opts.maxRadiusMm ?? 28;
  const plateau = compPlateau(volume, comp);
  const lo = 0.45 * plateau;
  const seed = compSeed(volume, S, comp, lo);
  if (!seed) return null;
  const E = castEdges(S, seed, DIRS_3000, { tMax: 70, step: 0.3, lo, win: 2.0, minContrast: 0.4 * plateau });
  if (E.n < 150) return null;
  const rng = mulberry32(20240607);
  const fit = fitSphere(E.pts, E.n, { minR, maxR, tol: 0.8, iters: 900, rng });
  if (!fit || fit.nIn < 150) return null;
  const ca = coverageAxis(E.pts, fit.sel, fit.c);
  if (fit.rms > 1.0 || ca.coverage < 0.2 || ca.coverage > 0.7 || ca.resultant < 0.3) return null;
  if (fit.r < minR + 0.3 || fit.r > maxR - 0.3) return null;
  // axis: start from the surface-coverage direction, refine with the metal centroid of the dome cap
  const C = fit.c, R = fit.r;
  const near = [];
  for (let p = 0; p < comp.n; p++) {
    const w = worldOf(volume, comp.idx[p]);
    const d = sub(w, C);
    if (Math.abs(d[0]) < R && Math.abs(d[1]) < R && Math.abs(d[2]) < R) { const r = len(d); if (r < R - 1.2) near.push(d); }
  }
  let axis = ca.dir;
  for (let it = 0; it < 5 && near.length; it++) {
    const s = [0, 0, 0]; let m = 0;
    for (const d of near) if (dot(d, axis) >= 1.5) { s[0] += d[0]; s[1] += d[1]; s[2] += d[2]; m++; }
    if (m < 50) break;
    axis = unit(s);
  }
  return { center: C, radius: R, rmsMm: fit.rms, coverage: ca.coverage, axis, plateau, score: fit.nIn, resultant: ca.resultant };
}

function findPost(S, fit) {
  const { center: C, axis, plateau } = fit;
  const thr = 0.5 * plateau;
  const a = Math.abs(axis[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const u = unit([axis[1] * a[2] - axis[2] * a[1], axis[2] * a[0] - axis[0] * a[2], axis[0] * a[1] - axis[1] * a[0]]);
  const w = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
  const offs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  let lastMetal = 0;
  for (let t = 0; t <= 50; t += 0.5) {
    const p = sub(C, mul(axis, t));
    let hit = false;
    for (const [a1, b1] of offs) {
      const q = add(p, add(mul(u, a1), mul(w, b1)));
      if (S(q[0], q[1], q[2]) > thr) { hit = true; break; }
    }
    if (hit) lastMetal = t; else if (t - lastMetal > 1.6) break;
  }
  if (lastMetal >= 8) return sub(C, mul(axis, lastMetal + 0.25));
  return sub(C, mul(axis, 20));
}

function findStem(volume, M, fit) {
  const { center: C, axis, radius: R } = fit;
  let best = null;
  for (const comp of M.comps) {
    if (comp.n < 300) continue;
    const buf = new Float64Array(3 * comp.n); let m = 0;
    for (let p = 0; p < comp.n; p++) {
      const w = worldOf(volume, comp.idx[p]);
      const d = sub(w, C), r = len(d), s = dot(d, axis);
      if (r < R + 3 || (s < 1 && r < 60)) continue;
      buf[3 * m] = w[0]; buf[3 * m + 1] = w[1]; buf[3 * m + 2] = w[2]; m++;
    }
    if (m > 300 && (!best || m > best.m)) best = { buf, m };
  }
  if (!best) return null;
  const { buf, m } = best;
  let st = pca(buf, m);
  if (Math.sqrt(st.vals[0] / Math.max(st.vals[1], 1e-9)) < 2.2) return null;
  let c0 = st.c, d = st.vecs[0];
  const proj = (i) => { const p = 3 * i; const v = [buf[p] - c0[0], buf[p + 1] - c0[1], buf[p + 2] - c0[2]]; const t = dot(v, d); return [t, len(sub(v, mul(d, t)))]; };
  for (let it = 0; it < 5; it++) {
    let tmin = Infinity, tmax = -Infinity;
    const T = new Float64Array(m), Rr = new Float64Array(m);
    for (let i = 0; i < m; i++) { const [t, r] = proj(i); T[i] = t; Rr[i] = r; if (r < 12) { if (t < tmin) tmin = t; if (t > tmax) tmax = t; } }
    if (!(tmax - tmin > 30)) return null;
    // proximal end = the end nearer the glenosphere
    const pa = add(c0, mul(d, tmin)), pb = add(c0, mul(d, tmax));
    const proxIsMin = len(sub(pa, C)) < len(sub(pb, C));
    const sel = [];
    for (let i = 0; i < m; i++) {
      if (Rr[i] > 9) continue;
      const off = proxIsMin ? T[i] - tmin : tmax - T[i];
      if (off < 15) continue;
      sel.push(i);
    }
    if (sel.length < 200) return null;
    const s2 = pca(buf, m, Int32Array.from(sel));
    c0 = s2.c; d = s2.vecs[0];
    if (dot(d, sub(pb, pa)) < 0) d = mul(d, -1);
  }
  let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < m; i++) { const [t, r] = proj(i); if (r < 12) { if (t < tmin) tmin = t; if (t > tmax) tmax = t; } }
  let a = add(c0, mul(d, tmin)), b = add(c0, mul(d, tmax));
  if (len(sub(b, C)) < len(sub(a, C))) [a, b] = [b, a];
  const ax = unit(sub(b, a));
  return { a, b, axis: ax, lengthMm: len(sub(b, a)) };
}

/**
 * Reverse-arthroplasty geometry or null (native shoulder / hemiarthroplasty / no dome found).
 * opts: { minRadiusMm=14, maxRadiusMm=28, metal:{...analyzeMetal options} }
 */
export function detectReverse(volume, opts = {}) {
  const M = analyzeMetal(volume, opts.metal || {});
  if (!M.comps.length) return null;
  const S = getSampler(volume);
  const vox = geom(volume).voxMm3;
  let best = null;
  for (const comp of M.comps.slice(0, 4)) {
    if (comp.n * vox < 1200) continue;
    const f = fitDome(volume, S, comp, opts);
    if (f && (!best || f.score > best.score)) best = f;
  }
  if (!best) return null;
  const post = findPost(S, best);
  const stem = findStem(volume, M, best);
  return {
    glenosphere: { center: best.center, radius: best.radius, rmsMm: best.rmsMm, coverage: best.coverage, axis: best.axis },
    post,
    stem,
  };
}

// ------------------------------------------------------------------------------------------------
// coarse distance transform for head candidates
function edt1d(f, n, h, out, v, z) {
  let k = 0; v[0] = 0; z[0] = -1e30; z[1] = 1e30;
  for (let q = 1; q < n; q++) {
    let s;
    for (;;) {
      const p = v[k];
      s = ((f[q] + (q * h) * (q * h)) - (f[p] + (p * h) * (p * h))) / (2 * h * (q - p));
      if (s <= z[k]) { k--; if (k < 0) { k = 0; v[0] = q; z[0] = -1e30; z[1] = 1e30; s = null; break; } } else break;
    }
    if (s === null) continue;
    k++; v[k] = q; z[k] = s; z[k + 1] = 1e30;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q * h) k++;
    const dd = (q - v[k]) * h;
    out[q] = dd * dd + f[v[k]];
  }
}

function densityCandidates(volume, thr, region, o) {
  const { data, dims: [nx, ny, nz] } = volume;
  const g = geom(volume);
  let lo = [0, 0, 0], hi = [nx - 1, ny - 1, nz - 1];
  if (region) {
    const ci = worldToIndex(volume, region.center);
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.max(0, Math.floor(ci[a] - region.radius * g.rowN[a]));
      hi[a] = Math.min(volume.dims[a] - 1, Math.ceil(ci[a] + region.radius * g.rowN[a]));
    }
  }
  const st = [1, 1, 1];
  for (let a = 0; a < 3; a++) st[a] = Math.max(1, Math.round(o.cellMm / g.sp[a]));
  const cdim = () => [0, 1, 2].map((a) => Math.floor((hi[a] - lo[a]) / st[a]) + 1);
  for (;;) {
    const d = cdim();
    if (d[0] * d[1] * d[2] <= 6.5e6) break;
    for (let a = 0; a < 3; a++) st[a]++;
  }
  const [cx, cy, cz] = cdim();
  const h = [st[0] * g.sp[0], st[1] * g.sp[1], st[2] * g.sp[2]];
  const f = new Float32Array(cx * cy * cz);
  let any = 0;
  for (let ck = 0; ck < cz; ck++) for (let cj = 0; cj < cy; cj++) {
    const base = (lo[0]) + nx * ((lo[1] + cj * st[1]) + ny * (lo[2] + ck * st[2]));
    let q = (cj + cy * ck) * cx;
    for (let ci = 0; ci < cx; ci++, q++) {
      if (data[base + ci * st[0]] > thr) { f[q] = 1e10; any++; }
    }
  }
  if (!any) return [];
  const n = Math.max(cx, cy, cz) + 2;
  const line = new Float64Array(n), out = new Float64Array(n), vv = new Int32Array(n), zz = new Float64Array(n + 2);
  for (let ck = 0; ck < cz; ck++) for (let cj = 0; cj < cy; cj++) {
    const b = (cj + cy * ck) * cx;
    for (let i = 0; i < cx; i++) line[i] = f[b + i];
    edt1d(line, cx, h[0], out, vv, zz);
    for (let i = 0; i < cx; i++) f[b + i] = out[i];
  }
  for (let ck = 0; ck < cz; ck++) for (let ci = 0; ci < cx; ci++) {
    for (let j = 0; j < cy; j++) line[j] = f[ci + cx * (j + cy * ck)];
    edt1d(line, cy, h[1], out, vv, zz);
    for (let j = 0; j < cy; j++) f[ci + cx * (j + cy * ck)] = out[j];
  }
  for (let cj = 0; cj < cy; cj++) for (let ci = 0; ci < cx; ci++) {
    for (let k = 0; k < cz; k++) line[k] = f[ci + cx * (cj + cy * k)];
    edt1d(line, cz, h[2], out, vv, zz);
    for (let k = 0; k < cz; k++) f[ci + cx * (cj + cy * k)] = out[k];
  }
  const cands = [];
  const minD2 = o.minDt * o.minDt;
  const sepCells = [0, 1, 2].map((a) => Math.ceil(o.sepMm / h[a]));
  for (let c = 0; c < o.maxCand; c++) {
    let bq = -1, bv = minD2;
    for (let q = 0; q < f.length; q++) {
      if (f[q] <= bv) continue;
      if (o.near) {
        // restrict to the search sphere (checked lazily for the running max)
        const ci = q % cx, r = (q - ci) / cx, cj = r % cy, ck = (r - cj) / cy;
        const w = indexToWorld(volume, lo[0] + ci * st[0], lo[1] + cj * st[1], lo[2] + ck * st[2]);
        if (len(sub(w, o.near)) > o.searchRadius) { f[q] = 0; continue; }
      }
      bv = f[q]; bq = q;
    }
    if (bq < 0) break;
    const ci = bq % cx, r = (bq - ci) / cx, cj = r % cy, ck = (r - cj) / cy;
    cands.push({ center: indexToWorld(volume, lo[0] + ci * st[0], lo[1] + cj * st[1], lo[2] + ck * st[2]), dt: Math.sqrt(bv) });
    for (let k = Math.max(0, ck - sepCells[2]); k <= Math.min(cz - 1, ck + sepCells[2]); k++) {
      for (let j = Math.max(0, cj - sepCells[1]); j <= Math.min(cy - 1, cj + sepCells[1]); j++) {
        for (let i = Math.max(0, ci - sepCells[0]); i <= Math.min(cx - 1, ci + sepCells[0]); i++) f[i + cx * (j + cy * k)] = 0;
      }
    }
  }
  return cands;
}

function refineHead(S, c0, cfg) {
  let c = c0, r = null, fit = null, E = null, ca = null;
  const rng = mulberry32(99173);
  for (let pass = 0; pass < 3; pass++) {
    const first = pass === 0;
    E = castEdges(S, c, DIRS_2500, { tMax: first ? cfg.maxR + 22 : r + 8, step: 0.3, lo: cfg.lo, win: 2.5, minContrast: cfg.minContrast });
    if (E.n < 80) return null;
    fit = fitSphere(E.pts, E.n, {
      minR: first ? cfg.minR : Math.max(cfg.minR, r - 4), maxR: first ? cfg.maxR : Math.min(cfg.maxR, r + 4),
      tol: first ? 1.2 : 0.7, iters: 1500, rng,
    });
    if (!fit) return null;
    c = fit.c; r = fit.r;
  }
  ca = coverageAxis(E.pts, fit.sel, fit.c);
  return { center: fit.c, radius: fit.r, rmsMm: fit.rms, inlierFraction: fit.nIn / E.nRays, coverage: ca.coverage, nIn: fit.nIn };
}

function headSearch(volume, S, o, mode) {
  const { near, searchRadiusMm, minR, maxR } = o;
  const region = near ? { center: near, radius: searchRadiusMm + maxR + 5 } : null;
  const implant = mode === 'implant';
  const cands = densityCandidates(volume, implant ? 1400 : 130, region, {
    cellMm: 2.4, minDt: implant ? 0.8 * minR : 0.62 * minR, sepMm: 18, maxCand: implant ? 3 : 5, near, searchRadius: searchRadiusMm,
  });
  let best = null;
  for (const cd of cands) {
    let cfg;
    if (implant) {
      const vals = [];
      for (const dx of [-3, 0, 3]) for (const dy of [-3, 0, 3]) for (const dz of [-3, 0, 3]) vals.push(S(cd.center[0] + dx, cd.center[1] + dy, cd.center[2] + dz));
      vals.sort((a, b) => a - b);
      const P = vals[13];
      if (P < 1400) continue;
      cfg = { minR, maxR, lo: 0.45 * P, minContrast: 0.4 * P };
    } else cfg = { minR, maxR, lo: 180, minContrast: 200 };
    const r = refineHead(S, cd.center, cfg);
    if (!r) continue;
    if (near && len(sub(r.center, near)) > searchRadiusMm) continue;
    const ok = implant ? (r.rmsMm <= 0.8 && r.inlierFraction >= 0.3 && r.coverage >= 0.4) : (r.rmsMm <= 1.2 && r.inlierFraction >= 0.1 && r.coverage >= 0.2);
    if (!ok) continue;
    r.score = r.nIn * (0.4 + r.coverage);
    if (!best || r.score > best.score) best = r;
  }
  if (!best) return null;
  return { center: best.center, radius: best.radius, rmsMm: best.rmsMm, inlierFraction: best.inlierFraction, mode, coverage: best.coverage };
}

/**
 * Humeral head as a sphere. opts: { near?, searchRadiusMm=60, minR=17, maxR=32, mode:'bone'|'implant'|'auto' }
 * -> null | { center, radius, rmsMm, inlierFraction (inliers / rays cast), mode, coverage }
 */
export function detectHeadSphere(volume, opts = {}) {
  const o = { near: opts.near || null, searchRadiusMm: opts.searchRadiusMm ?? 60, minR: opts.minR ?? 17, maxR: opts.maxR ?? 32 };
  const mode = opts.mode ?? 'auto';
  const S = getSampler(volume);
  if (mode === 'implant' || mode === 'auto') {
    const r = headSearch(volume, S, o, 'implant');
    if (r || mode === 'implant') return r;
  }
  return headSearch(volume, S, o, 'bone');
}
