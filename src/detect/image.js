// Small, dependency-free image helpers for the classical (non-ML) detectors.
// Everything here is a pure function on typed arrays. An "image" is
// { width, height, data: Float32Array } in row-major order; a "mask" is a
// Uint8Array of 0/1 with the same layout.

/**
 * Downsample by an integer factor using a box average. Trailing rows/columns
 * that do not fill a whole box are dropped.
 * @returns {{width:number,height:number,data:Float32Array,factor:number}}
 */
export function downsample(img, factor) {
  const f = Math.max(1, Math.floor(factor));
  const { width: W, height: H, data } = img;
  if (f === 1) return { width: W, height: H, data: Float32Array.from(data), factor: 1 };
  const w = Math.floor(W / f);
  const h = Math.floor(H / f);
  const out = new Float32Array(w * h);
  const row = new Float64Array(w);
  const inv = 1 / (f * f);
  for (let y = 0; y < h; y++) {
    row.fill(0);
    for (let dy = 0; dy < f; dy++) {
      let p = (y * f + dy) * W;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dx = 0; dx < f; dx++) s += data[p++];
        row[x] += s;
      }
    }
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = row[x] * inv;
  }
  return { width: w, height: h, data: out, factor: f };
}

/** Normalised 1-D Gaussian kernel with radius ceil(3 sigma). */
export function gaussianKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    s += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/** Separable Gaussian blur with edge replication. Returns a new Float32Array. */
export function gaussianBlur(src, w, h, sigma) {
  if (!(sigma > 0)) return Float32Array.from(src);
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  // horizontal
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (x >= r && x < w - r) {
        const b = o + x - r;
        for (let i = 0; i < k.length; i++) s += k[i] * src[b + i];
      } else {
        for (let i = -r; i <= r; i++) {
          let xx = x + i;
          if (xx < 0) xx = 0;
          else if (xx >= w) xx = w - 1;
          s += k[i + r] * src[o + xx];
        }
      }
      tmp[o + x] = s;
    }
  }
  // vertical
  for (let y = 0; y < h; y++) {
    const o = y * w;
    if (y >= r && y < h - r) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let b = o + x - r * w;
        for (let i = 0; i < k.length; i++, b += w) s += k[i] * tmp[b];
        out[o + x] = s;
      }
    } else {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          let yy = y + i;
          if (yy < 0) yy = 0;
          else if (yy >= h) yy = h - 1;
          s += k[i + r] * tmp[yy * w + x];
        }
        out[o + x] = s;
      }
    }
  }
  return out;
}

/**
 * Sobel gradient. gx/gy point towards increasing intensity; scaled so that a
 * unit ramp has gradient magnitude 1 per pixel. Border pixels are zero.
 */
export function sobel(src, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = src[i - w - 1], b = src[i - w], c = src[i - w + 1];
      const d = src[i - 1], f = src[i + 1];
      const g = src[i + w - 1], hh = src[i + w], k = src[i + w + 1];
      const sx = (c + 2 * f + k - a - 2 * d - g) * 0.125;
      const sy = (g + 2 * hh + k - a - 2 * b - c) * 0.125;
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return { gx, gy, mag };
}

/** Histogram of values in [lo, hi] (values outside are clamped into the end bins). */
export function histogram(data, lo, hi, bins = 256, stride = 1) {
  const hist = new Float64Array(bins);
  const scale = hi > lo ? bins / (hi - lo) : 0;
  for (let i = 0; i < data.length; i += stride) {
    let b = Math.floor((data[i] - lo) * scale);
    if (b < 0) b = 0;
    else if (b >= bins) b = bins - 1;
    hist[b]++;
  }
  return hist;
}

/**
 * Otsu threshold on a histogram. Returns the bin index t such that class 0 is
 * bins [0..t] and class 1 is bins (t..end]; -1 when the histogram is empty.
 */
export function otsu(hist) {
  const n = hist.length;
  let total = 0, sum = 0;
  for (let i = 0; i < n; i++) { total += hist[i]; sum += i * hist[i]; }
  if (total === 0) return -1;
  let w0 = 0, s0 = 0, best = -1, bestT = 0;
  for (let t = 0; t < n - 1; t++) {
    w0 += hist[t];
    s0 += t * hist[t];
    const w1 = total - w0;
    if (w0 === 0 || w1 === 0) continue;
    const m0 = s0 / w0, m1 = (sum - s0) / w1;
    const v = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (v > best) { best = v; bestT = t; }
  }
  return bestT;
}

/**
 * Multi-level Otsu (exhaustive; classes 2..4) on a histogram.
 * Returns classes-1 ascending bin thresholds (class k is bins (t[k-1]..t[k]]).
 */
export function multiOtsu(hist, classes = 3) {
  const n = hist.length;
  if (classes <= 2) return [otsu(hist)];
  const P = new Float64Array(n + 1), S = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { P[i + 1] = P[i] + hist[i]; S[i + 1] = S[i] + i * hist[i]; }
  // between-class term for bins [a, b)
  const term = (a, b) => {
    const w = P[b] - P[a];
    if (w <= 0) return 0;
    const s = S[b] - S[a];
    return (s * s) / w;
  };
  let best = -1, bt = [];
  if (classes === 3) {
    for (let t1 = 0; t1 < n - 2; t1++) {
      const a = term(0, t1 + 1);
      for (let t2 = t1 + 1; t2 < n - 1; t2++) {
        const v = a + term(t1 + 1, t2 + 1) + term(t2 + 1, n);
        if (v > best) { best = v; bt = [t1, t2]; }
      }
    }
    return bt;
  }
  // 4 classes: coarse exhaustive search on a reduced histogram, then map back
  const step = Math.max(1, Math.floor(n / 64));
  for (let t1 = 0; t1 < n - 3; t1 += step) {
    const a = term(0, t1 + 1);
    for (let t2 = t1 + step; t2 < n - 2; t2 += step) {
      const b = a + term(t1 + 1, t2 + 1);
      for (let t3 = t2 + step; t3 < n - 1; t3 += step) {
        const v = b + term(t2 + 1, t3 + 1) + term(t3 + 1, n);
        if (v > best) { best = v; bt = [t1, t2, t3]; }
      }
    }
  }
  return bt;
}

/**
 * Robust percentiles (ps in 0..100) from at most maxSamples regularly spaced
 * samples. Non-finite values are ignored.
 */
export function percentiles(data, ps, maxSamples = 200000) {
  const stride = Math.max(1, Math.floor(data.length / maxSamples));
  const n = Math.ceil(data.length / stride);
  const buf = new Float32Array(n);
  let m = 0;
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i];
    if (v === v && v !== Infinity && v !== -Infinity) buf[m++] = v;
  }
  const s = buf.subarray(0, m).sort();
  return ps.map((p) => {
    if (m === 0) return NaN;
    const q = Math.min(m - 1, Math.max(0, (p / 100) * (m - 1)));
    const i = Math.floor(q), f = q - i;
    return i + 1 < m ? s[i] * (1 - f) + s[i + 1] * f : s[i];
  });
}

/** Median of a plain array / typed array (copy; does not mutate). */
export function median(values) {
  const n = values.length;
  if (n === 0) return NaN;
  const s = Float64Array.from(values).sort();
  return n & 1 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/**
 * Connected components (8- or 4-connectivity) of a binary mask.
 * labels are 1-based (0 = background). stats[label] holds area, bounding box,
 * centroid, central second moments and how many pixels touch each border.
 */
export function connectedComponents(mask, w, h, connectivity = 8) {
  const labels = new Int32Array(w * h);
  const stats = [null];
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    count++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = count;
    let area = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    let minX = w, maxX = -1, minY = h, maxY = -1;
    let bl = 0, br = 0, bt = 0, bb = 0;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      area++;
      sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x === 0) bl++;
      if (x === w - 1) br++;
      if (y === 0) bt++;
      if (y === h - 1) bb++;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (connectivity === 4 && dx && dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !labels[j]) { labels[j] = count; stack[sp++] = j; }
        }
      }
    }
    const cx = sx / area, cy = sy / area;
    stats.push({
      label: count, area, minX, maxX, minY, maxY, cx, cy,
      mxx: sxx / area - cx * cx, mxy: sxy / area - cx * cy, myy: syy / area - cy * cy,
      border: { left: bl, right: br, top: bt, bottom: bb },
    });
  }
  return { labels, count, stats };
}

/**
 * Principal axes from central second moments {mxx,mxy,myy}.
 * Returns the unit major axis, eigenvalues (variances) l1 >= l2 and the
 * approximate full length / width of an equivalent uniform bar (sqrt(12 l)).
 */
export function principalAxes({ mxx, mxy, myy }) {
  const tr = mxx + myy;
  const det = mxx * myy - mxy * mxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
  let ux, uy;
  if (Math.abs(mxy) > 1e-12) { ux = l1 - myy; uy = mxy; }
  else if (mxx >= myy) { ux = 1; uy = 0; }
  else { ux = 0; uy = 1; }
  const n = Math.hypot(ux, uy) || 1;
  return { ux: ux / n, uy: uy / n, l1, l2, length: Math.sqrt(12 * l1), width: Math.sqrt(12 * l2) };
}

const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
    } while (s <= z[k] && --k >= 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

/**
 * Exact squared Euclidean distance (Felzenszwalb & Huttenlocher) from every
 * pixel to the nearest pixel where mask === target (default: nearest 0 pixel,
 * i.e. the depth inside the foreground).
 */
export function distanceTransformSq(mask, w, h, target = 0) {
  const out = new Float32Array(w * h);
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = mask[y * w + x] === target ? 0 : INF;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = out[o + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[o + x] = d[x];
  }
  return out;
}

/** Erode with a disc of the given radius (pixels outside the image count as foreground). */
export function erode(mask, w, h, radius) {
  if (!(radius > 0)) return Uint8Array.from(mask);
  const d = distanceTransformSq(mask, w, h, 0);
  const r2 = radius * radius;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i] > r2 ? 1 : 0;
  return out;
}

/** Dilate with a disc of the given radius. */
export function dilate(mask, w, h, radius) {
  if (!(radius > 0)) return Uint8Array.from(mask);
  const d = distanceTransformSq(mask, w, h, 1);
  const r2 = radius * radius;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= r2 ? 1 : 0;
  return out;
}

/** Morphological opening (erode then dilate) with a disc. */
export function open(mask, w, h, radius) {
  return dilate(erode(mask, w, h, radius), w, h, radius);
}

/** Morphological closing (dilate then erode) with a disc. */
export function close(mask, w, h, radius) {
  const d = dilate(mask, w, h, radius);
  // erode treating outside as foreground so closing never shrinks at borders
  return erode(d, w, h, radius);
}

/** Bilinear sample with edge clamping. */
export function bilinear(data, w, h, x, y) {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const a = data[y0 * w + x0], b = data[y0 * w + x1];
  const c = data[y1 * w + x0], d = data[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * Least-squares circle through points (algebraic Kåsa fit followed by a few
 * Gauss-Newton geometric iterations). pts is a flat [x0,y0,x1,y1,...] array;
 * optional weights. Returns null for degenerate input.
 */
export function fitCircle(pts, weights) {
  const n = pts.length >> 1;
  if (n < 3) return null;
  let sw = 0, mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    const wt = weights ? weights[i] : 1;
    sw += wt; mx += wt * pts[2 * i]; my += wt * pts[2 * i + 1];
  }
  if (!(sw > 0)) return null;
  mx /= sw; my /= sw;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i++) {
    const wt = weights ? weights[i] : 1;
    const u = pts[2 * i] - mx, v = pts[2 * i + 1] - my;
    suu += wt * u * u; suv += wt * u * v; svv += wt * v * v;
    suuu += wt * u * u * u; svvv += wt * v * v * v;
    suvv += wt * u * v * v; svuu += wt * v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9 * (suu + svv) * (suu + svv) + 1e-12) return null;
  const bu = 0.5 * (suuu + suvv), bv = 0.5 * (svvv + svuu);
  let cx = (bu * svv - bv * suv) / det, cy = (bv * suu - bu * suv) / det;
  let r = Math.sqrt(cx * cx + cy * cy + (suu + svv) / sw);
  cx += mx; cy += my;
  // geometric refinement
  for (let it = 0; it < 8; it++) {
    let a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0, b1 = 0, b2 = 0, b3 = 0;
    for (let i = 0; i < n; i++) {
      const wt = weights ? weights[i] : 1;
      const dx = pts[2 * i] - cx, dy = pts[2 * i + 1] - cy;
      const d = Math.hypot(dx, dy) || 1e-9;
      const jx = -dx / d, jy = -dy / d, res = d - r;
      a11 += wt * jx * jx; a12 += wt * jx * jy; a13 -= wt * jx;
      a22 += wt * jy * jy; a23 -= wt * jy; a33 += wt;
      b1 -= wt * jx * res; b2 -= wt * jy * res; b3 += wt * res;
    }
    const sol = solve3(a11, a12, a13, a12, a22, a23, a13, a23, a33, b1, b2, b3);
    if (!sol) break;
    cx += sol[0]; cy += sol[1]; r += sol[2];
    if (Math.abs(sol[0]) + Math.abs(sol[1]) + Math.abs(sol[2]) < 1e-6) break;
  }
  if (!(r > 0) || !Number.isFinite(cx + cy + r)) return null;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const wt = weights ? weights[i] : 1;
    const e = Math.hypot(pts[2 * i] - cx, pts[2 * i + 1] - cy) - r;
    ss += wt * e * e;
  }
  return { cx, cy, r, rms: Math.sqrt(ss / sw) };
}

function solve3(a, b, c, d, e, f, g, h, i, x, y, z) {
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  return [
    (x * (e * i - f * h) - b * (y * i - f * z) + c * (y * h - e * z)) / det,
    (a * (y * i - f * z) - x * (d * i - f * g) + c * (d * z - y * g)) / det,
    (a * (e * z - y * h) - b * (d * z - y * g) + x * (d * h - e * g)) / det,
  ];
}

/**
 * Total-least-squares line through points (flat array, optional weights).
 * Returns a point on the line, its unit direction and the RMS distance.
 */
export function fitLine(pts, weights) {
  const n = pts.length >> 1;
  if (n < 2) return null;
  let sw = 0, mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    const wt = weights ? weights[i] : 1;
    sw += wt; mx += wt * pts[2 * i]; my += wt * pts[2 * i + 1];
  }
  if (!(sw > 0)) return null;
  mx /= sw; my /= sw;
  let mxx = 0, mxy = 0, myy = 0;
  for (let i = 0; i < n; i++) {
    const wt = weights ? weights[i] : 1;
    const u = pts[2 * i] - mx, v = pts[2 * i + 1] - my;
    mxx += wt * u * u; mxy += wt * u * v; myy += wt * v * v;
  }
  const ax = principalAxes({ mxx: mxx / sw, mxy: mxy / sw, myy: myy / sw });
  return { px: mx, py: my, dx: ax.ux, dy: ax.uy, rms: Math.sqrt(ax.l2) };
}
