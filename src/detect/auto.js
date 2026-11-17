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
  const ub = gaussianBlur(u, w, h, 1.1);
  return { f, w, h, n, u, ub, flat: !(hi - lo > 0) };
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

// ───────────────────────────── 2. stem ─────────────────────────────
/** Trace the stem from the lowest metal point upward. Returns axis (unit, pointing proximal), tip, proximal end, widths. */
function traceStem(P, M) {
  const { w, h } = P;
  const xs = [], ys = [];
  let ymax = -1, ymin = h, tx = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (M.labels[y * w + x] === M.main && M.mask[y * w + x]) { xs.push(x); ys.push(y); if (y > ymax) { ymax = y; tx = x; } if (y < ymin) ymin = y; }
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
  let rmin = mm ? 15 / mm : stem ? 1.25 * stem.wd : 0.03 * Math.min(P.w, P.h);
  let rmax = mm ? 29 / mm : stem ? 3.4 * stem.wd : 0.2 * Math.min(P.w, P.h);
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
    if (!best || score > best.q) best = { cx: cur.cx, cy: cur.cy, r: cur.r, deg: cov.deg, run, fill: fl, arc, q: score };
  }
  log(`best circle ${best ? `(${best.cx.toFixed(0)},${best.cy.toFixed(0)}) r ${best.r.toFixed(1)} run ${best.run} cov ${best.deg} fill ${best.fill.toFixed(2)}` : 'none'}`);
  if (!best || best.run < 60) return null;
  best.B = B;
  best.score = Math.max(0.3, Math.min(0.95, best.run / 190)) * Math.min(1, best.fill / 0.9);
  return best;
}

/**
 * Straight metal edge inside the circle that faces medially (against `axis`): returns its unit normal pointing
 * lateral, its signed distance medial of the centre, and its support, or null.
 */
function faceLine(B, C, R, axis) {
  const xs = [], ys = [];
  for (let i = 0; i < B.n; i++) {
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
  const M = metalMask(P, log);
  if (!M) { log('no metal'); return null; }
  addNear(P, M);
  const stem = traceStem(P, M);
  log(`metal T ${M.T} fraction ${M.fraction.toFixed(3)} stability ${M.stability.toFixed(3)}; stem ${stem ? `wd ${stem.wd.toFixed(1)} len ${stem.len}` : 'none'}`);
  let circle = findCircle(P, M, stem, opts, log);
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
  let far = 0, fx = 0, fy = 0;
  for (let y = Math.max(0, Math.floor(C[1] - 3 * R)); y <= Math.min(h - 1, Math.ceil(C[1] + 3 * R)); y++) {
    for (let x = Math.max(0, Math.floor(C[0] - 3 * R)); x <= Math.min(w - 1, Math.ceil(C[0] + 3 * R)); x++) {
      if (!M.mask[y * w + x]) continue;
      const dx = x - C[0], dy = y - C[1], dd = Math.hypot(dx, dy);
      if (dd < 1.12 * R || dd > 3 * R) continue;
      if ((dx * ex + dy * ey) < 0.2 * dd) continue;                    // within ~78° of "away from the stem"
      far++; fx += x; fy += y;
    }
  }
  // …or the circle sits well off the stem axis: a prosthetic head rides on its stem (centre within about half a
  // radius of the axis), a glenosphere is a full radius medial to it
  const axisOff = stem ? Math.abs((C[0] - stem.tip[0]) * stem.n[0] + (C[1] - stem.tip[1]) * stem.n[1]) : 0;
  log(`far-side metal ${(far / (Math.PI * R * R)).toFixed(3)} of disc; centre ${(axisOff / R).toFixed(2)} R off the stem axis`);
  const isReverse = !circle.dim && (far > 0.05 * Math.PI * R * R || axisOff > 0.8 * R);
  const toFull = (p) => [(p[0] + 0.5) * f - 0.5, (p[1] + 0.5) * f - 0.5];
  const scaleOut = (est) => {
    const o = {};
    for (const [id, e] of Object.entries(est)) o[id] = e.a ? { a: toFull(e.a), b: toFull(e.b), confidence: e.confidence } : { ...Object.fromEntries([['x', toFull([e.x, e.y])[0]], ['y', toFull([e.x, e.y])[1]]]), confidence: e.confidence };
    return o;
  };
  const stemOut = stem ? { a: toFull(stem.prox), b: toFull(stem.tip) } : null;
  if (isReverse) {
    // axis: from the baseplate/screw metal through the centre, pointing out of the dome (lateral)
    let ax = C[0] - fx / far, ay = C[1] - fy / far;
    const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
    // Refine the direction from the implant's own straight edges: the flat back of the dome where it shows beside
    // the baseplate, and the baseplate's medial edge, are both parallel to the face. (The centroid of the screws
    // alone is off by 15° or more when the screws are not symmetric.)
    const fl = faceLine(circle.B || boundary(P, M), C, R, [ax, ay]);
    log(`axis from screws (${ax.toFixed(2)},${ay.toFixed(2)}); straight back edge ${fl ? `${fl.n} px, normal (${fl.nx.toFixed(2)},${fl.ny.toFixed(2)}), ${fl.d.toFixed(1)} px medial of centre` : 'not found'}`);
    if (fl) { ax = fl.nx; ay = fl.ny; }
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
      head: null, stem: stemOut, estimates: { 'rsa-ap': scaleOut(est) },
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
    stem: stemOut, estimates: { 'pyc-ap': scaleOut(est) },
  };
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
