// Geometry used by every measurement. Pure functions, no DOM.
//
// 2D points are {x, y} in image pixels (x right, y DOWN). 3D points are [x, y, z] in patient LPS millimetres.
// Angles are returned in degrees unless a name says otherwise.

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

// ───────────────────────────── 2D ─────────────────────────────
export const P = (x, y) => ({ x, y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const perp = (a) => ({ x: -a.y, y: a.x });

export function unit(a) {
  const l = len(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

/** Unsigned angle (0–180°) between two vectors. */
export function angleBetween(u, v) {
  const d = len(u) * len(v);
  if (d < 1e-12) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, dot(u, v) / d))) * DEG;
}

/** Angle at vertex b of the path a–b–c (0–180°). */
export function angleAt(a, b, c) {
  return angleBetween(sub(a, b), sub(c, b));
}

/** Acute angle (0–90°) between two undirected lines given by direction vectors. */
export function lineAngle(u, v) {
  const a = angleBetween(u, v);
  return a > 90 ? 180 - a : a;
}

/** Signed perpendicular distance of p from the line a→b; positive on the side of `positiveDir` if given, else left-hand normal. */
export function signedDistToLine(p, a, b, positiveDir) {
  const d = unit(sub(b, a));
  let n = perp(d);
  if (positiveDir && dot(n, positiveDir) < 0) n = mul(n, -1);
  return dot(sub(p, a), n);
}

export function projectOnLine(p, a, b) {
  const d = unit(sub(b, a));
  return add(a, mul(d, dot(sub(p, a), d)));
}

/** Intersection of infinite lines a1→a2 and b1→b2, or null when parallel. */
export function lineIntersection(a1, a2, b1, b2) {
  const r = sub(a2, a1), s = sub(b2, b1);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(b1, a1), s) / den;
  return add(a1, mul(r, t));
}

/** Circle through three points, or null when collinear. */
export function circleFrom3(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
}

/** Algebraic least-squares circle fit (Kåsa) refined by a few Gauss–Newton steps on geometric distance. */
export function fitCircle(pts) {
  const n = pts.length;
  if (n < 3) return null;
  if (n === 3) return circleFrom3(pts[0], pts[1], pts[2]);
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const den = suu * svv - suv * suv;
  if (Math.abs(den) < 1e-12) return null;
  const rhs1 = (suuu + suvv) / 2, rhs2 = (svvv + svuu) / 2;
  let cx = (rhs1 * svv - rhs2 * suv) / den + mx;
  let cy = (rhs2 * suu - rhs1 * suv) / den + my;
  let r = 0;
  for (let it = 0; it < 12; it++) {
    let sr = 0;
    const ds = pts.map((p) => Math.hypot(p.x - cx, p.y - cy));
    for (const d of ds) sr += d;
    r = sr / n;
    // Gauss–Newton on residuals d_i - r with respect to (cx, cy); r is eliminated as the mean distance.
    let jxx = 0, jxy = 0, jyy = 0, gx = 0, gy = 0, mxn = 0, myn = 0;
    const nx = [], ny = [];
    for (let i = 0; i < n; i++) {
      const d = ds[i] || 1e-9;
      nx[i] = (cx - pts[i].x) / d; ny[i] = (cy - pts[i].y) / d;
      mxn += nx[i]; myn += ny[i];
    }
    mxn /= n; myn /= n;
    for (let i = 0; i < n; i++) {
      const ax = nx[i] - mxn, ay = ny[i] - myn, res = ds[i] - r;
      jxx += ax * ax; jxy += ax * ay; jyy += ay * ay; gx += ax * res; gy += ay * res;
    }
    const dd = jxx * jyy - jxy * jxy;
    if (Math.abs(dd) < 1e-12) break;
    const dx = -(gx * jyy - gy * jxy) / dd, dy = -(gy * jxx - gx * jxy) / dd;
    cx += dx; cy += dy;
    if (Math.hypot(dx, dy) < 1e-7) break;
  }
  let sr = 0;
  for (const p of pts) sr += Math.hypot(p.x - cx, p.y - cy);
  return { cx, cy, r: sr / n };
}

// ───────────────────────────── 3D ─────────────────────────────
export const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  mid: (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
  unit: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
  /** Component of a perpendicular to unit vector n. */
  reject: (a, n) => {
    const d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
    return [a[0] - d * n[0], a[1] - d * n[1], a[2] - d * n[2]];
  },
};

export function angleBetween3(u, v) {
  const d = v3.len(u) * v3.len(v);
  if (d < 1e-12) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, v3.dot(u, v) / d))) * DEG;
}

/**
 * Scapular coordinate frame from landmarks (patient LPS mm):
 *   lat  — scapular (Friedman) axis: trigonum spinae → glenoid centre (points lateral)
 *   ant  — normal of the scapular plane (trigonum, inferior angle, glenoid centre), pointing anterior
 *   sup  — completes the frame, pointing superior
 * Without the inferior angle (often outside the scan) the plane cannot be defined; the frame then falls back to the
 * scanner's cranio-caudal axis for "superior", which assumes the patient lay straight. `approximate` reports that.
 */
export function scapularFrame(tri, glenoidCentre, inferiorAngle) {
  const lat = v3.unit(v3.sub(glenoidCentre, tri));
  if (v3.len(lat) === 0) return null;
  let ant, sup, approximate = false;
  if (inferiorAngle) {
    ant = v3.unit(v3.cross(v3.sub(glenoidCentre, tri), v3.sub(inferiorAngle, tri)));
    if (v3.len(ant) === 0) return null;
    if (ant[1] > 0) ant = v3.mul(ant, -1);            // LPS: +y is posterior, so anterior has negative y
    sup = v3.unit(v3.cross(ant, lat));
    if (sup[2] < 0) sup = v3.mul(sup, -1);            // LPS: +z is superior
    // Re-derive ant so the frame is right-handed whatever the side and landmark order: ant = lat × sup or sup × lat.
    let a2 = v3.cross(lat, sup);
    if (v3.dot(a2, ant) < 0) a2 = v3.mul(a2, -1);
    ant = v3.unit(a2);
  } else {
    approximate = true;
    sup = v3.unit(v3.reject([0, 0, 1], lat));
    if (v3.len(sup) === 0) return null;
    ant = v3.unit(v3.cross(lat, sup));
    if (ant[1] > 0) ant = v3.mul(ant, -1);
  }
  return { lat, ant, sup, origin: glenoidCentre, approximate };
}

/**
 * Version and inclination of a direction (a glenoid face normal or a glenosphere axis, pointing lateral) in a
 * scapular frame. Version: + anteversion, − retroversion (angle in the scapular transverse plane).
 * Inclination: + superior tilt, − inferior tilt (angle in the scapular plane).
 */
export function versionInclination(frame, dir) {
  const l = v3.dot(dir, frame.lat), a = v3.dot(dir, frame.ant), s = v3.dot(dir, frame.sup);
  return { version: Math.atan2(a, l) * DEG, inclination: Math.atan2(s, l) * DEG };
}

/** Least-squares plane through ≥3 points: returns { point (centroid), normal (unit) } — smallest eigenvector by power iteration on the inverse. */
export function fitPlane(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= n; c[1] /= n; c[2] /= n;
  if (n === 3) {
    const nrm = v3.unit(v3.cross(v3.sub(pts[1], pts[0]), v3.sub(pts[2], pts[0])));
    return v3.len(nrm) ? { point: c, normal: nrm } : null;
  }
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of pts) {
    const x = p[0] - c[0], y = p[1] - c[1], z = p[2] - c[2];
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  // The normal is the direction of least variance: pick the best of the three cofactor-based candidates.
  const cands = [
    [yy * zz - yz * yz, xz * yz - xy * zz, xy * yz - xz * yy],
    [xz * yz - xy * zz, xx * zz - xz * xz, xy * xz - yz * xx],
    [xy * yz - xz * yy, xy * xz - yz * xx, xx * yy - xy * xy],
  ];
  let best = cands[0];
  for (const k of cands) if (v3.len(k) > v3.len(best)) best = k;
  const nrm = v3.unit(best);
  return v3.len(nrm) ? { point: c, normal: nrm } : null;
}

/** Algebraic least-squares sphere through ≥4 points. */
export function fitSphere(pts) {
  const n = pts.length;
  if (n < 4) return null;
  // Solve [2x 2y 2z 1] [a b c d]^T = x²+y²+z² in the least-squares sense (normal equations, 4×4).
  const A = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const B = [0, 0, 0, 0];
  for (const p of pts) {
    const row = [2 * p[0], 2 * p[1], 2 * p[2], 1];
    const rhs = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
    for (let i = 0; i < 4; i++) {
      B[i] += row[i] * rhs;
      for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j];
    }
  }
  const s = solve(A, B);
  if (!s) return null;
  const r2 = s[3] + s[0] * s[0] + s[1] * s[1] + s[2] * s[2];
  if (!(r2 > 0)) return null;
  return { c: [s[0], s[1], s[2]], r: Math.sqrt(r2) };
}

/** Gaussian elimination with partial pivoting; returns null for a singular system. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}
