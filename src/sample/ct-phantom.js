// Deterministic synthetic shoulder CT phantoms with ground truth (world LPS mm).
// kind: 'reverse' (metal glenosphere + humeral stem/cup), 'hemi' (pyrocarbon head on metal stem), 'native'.
// Anatomy is deliberately simple but has the structures the detectors/measurements care about:
// scapular plate (spine, neck, glenoid face of known orientation, acromion/coracoid stubs), humerus
// (cortex + cancellous), muscle ellipsoids with a configurable fat fraction, deltoid shell, air outside a body ellipse.
//
// Frame used for truth version/inclination (same as the measurement code):
//   lat = unit(glenoidCenter - tri); ant = unit normal of plane(tri, ia, glenoidCenter) with negative y;
//   sup = ant x lat (flipped so z > 0); version = atan2(dir.ant, dir.lat); inclination = atan2(dir.sup, dir.lat).
// subluxationPct = 100 * ((headCenter - glenoidCenter).ant + R) / (2R)   (50 = centred; < 50 = posterior).

const D2R = Math.PI / 180;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / len(a));

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash01(q, salt) {
  let h = Math.imul(q ^ Math.imul(salt, 0x9E3779B1), 0x85EBCA6B);
  h ^= h >>> 13; h = Math.imul(h, 0xC2B2AE35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function cdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

const METAL = 6000, PYRO = 2200, CORTEX_H = 1300, CANC_H = 250, CORTEX_S = 1200, CANC_S = 300, MUSCLE = 55, FAT = -100, SOFT = 30, POLY = 100;

export function makeCtPhantom(opts = {}) {
  const kind = opts.kind ?? 'reverse';
  if (!['reverse', 'hemi', 'native'].includes(kind)) throw new Error('kind must be reverse|hemi|native');
  const voxel = opts.voxel ?? [0.8, 0.8, 1.0];
  const dims = opts.dims ?? [224, 224, 180];
  const side = opts.side === 'L' ? 'L' : 'R';
  const tiltDeg = opts.tiltDeg ?? 0;
  const seed = opts.seed ?? 1;
  const versionDeg = opts.versionDeg ?? (kind === 'reverse' ? 6 : -8);
  const inclinationDeg = opts.inclinationDeg ?? (kind === 'reverse' ? 4 : 7);
  const subPct = opts.subluxationPct ?? 50;
  const Rg = (opts.glenosphereDiameter ?? 38) / 2;
  const Rh = (opts.headDiameter ?? 46) / 2;
  const clip = opts.clipHU ?? null;
  const bloom = opts.bloom ?? 0;
  const noise = opts.noise ?? 8;
  const fatF = { supraspinatus: 0.1, infraspinatus: 0.1, subscapularis: 0.1, teresMinor: 0.1, deltoid: 0.1, ...(opts.fat || {}) };

  const [nx, ny, nz] = dims;
  const [vx, vy, vz] = voxel;
  const sigVox = 0.29 * (vx + vy + vz) / 3;
  const sigMetal = Math.hypot(sigVox, bloom * 1.0);

  // ---- anatomical frame -------------------------------------------------------------------
  const sgn = side === 'L' ? 1 : -1;               // sign of lateral x
  const c35 = Math.cos(35 * D2R), s35 = Math.sin(35 * D2R);
  const ea = [sgn * c35, -s35, 0], eb = [0, 0, 1], ec = [-sgn * s35, -c35, 0];
  const G = [-12, 33, 85];
  const P = (a, b, c) => [G[0] + (a - 74) * ea[0] + (b - 2) * eb[0] + c * ec[0],
    G[1] + (a - 74) * ea[1] + (b - 2) * eb[1] + c * ec[1],
    G[2] + (a - 74) * ea[2] + (b - 2) * eb[2] + c * ec[2]];
  const toPlate = (x, y, z) => {
    const dx = x - G[0], dy = y - G[1], dz = z - G[2];
    return [74 + dx * ea[0] + dy * ea[1] + dz * ea[2], 2 + dz, dx * ec[0] + dy * ec[1] + dz * ec[2]];
  };
  const tri = P(1.08, 0, 0), ia = P(8, -100, 0), gc = G.slice();
  const lat = unit(sub(gc, tri));
  let ant = unit(cross(sub(ia, tri), sub(gc, tri)));
  if (ant[1] > 0) ant = mul(ant, -1);
  let sup = cross(ant, lat);
  if (sup[2] < 0) sup = mul(sup, -1);
  const tv = Math.tan(versionDeg * D2R), ti = Math.tan(inclinationDeg * D2R);
  const dir = unit(add(add(lat, mul(ant, tv)), mul(sup, ti)));
  const eSup = unit(sub(sup, mul(dir, dot(sup, dir))));
  let eAp = unit(cross(dir, eSup));
  if (dot(eAp, ant) < 0) eAp = mul(eAp, -1);
  const lh = [sgn, 0, 0];                            // world lateral
  const down = [0, 0, -1];

  // ---- grid ---------------------------------------------------------------------------------
  const tl = tiltDeg * D2R, tz = tiltDeg * 0.6 * D2R;
  const rot = (v) => {
    const y1 = v[1] * Math.cos(tl) - v[2] * Math.sin(tl), z1 = v[1] * Math.sin(tl) + v[2] * Math.cos(tl);
    return [v[0] * Math.cos(tz) - y1 * Math.sin(tz), v[0] * Math.sin(tz) + y1 * Math.cos(tz), z1];
  };
  const stepX = rot([vx, 0, 0]), stepY = rot([0, vy, 0]), stepZ = rot([0, 0, vz]);
  const Wc = add(add(G, mul(ea, -7)), [0, 0, -38]);
  const origin = sub(Wc, add(add(mul(stepX, (nx - 1) / 2), mul(stepY, (ny - 1) / 2)), mul(stepZ, (nz - 1) / 2)));
  // inverse (rows) of matrix with columns stepX, stepY, stepZ
  const m = [stepX[0], stepY[0], stepZ[0], stepX[1], stepY[1], stepZ[1], stepX[2], stepY[2], stepZ[2]];
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const inv = [
    (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det];
  const rowN = [Math.hypot(inv[0], inv[1], inv[2]), Math.hypot(inv[3], inv[4], inv[5]), Math.hypot(inv[6], inv[7], inv[8])];
  const N = nx * ny * nz;
  const arr = new Float32Array(N).fill(-1000);

  function paintBox(lo, hi, fn) {
    const i0 = Math.max(0, Math.floor(lo[0])), i1 = Math.min(nx - 1, Math.ceil(hi[0]));
    const j0 = Math.max(0, Math.floor(lo[1])), j1 = Math.min(ny - 1, Math.ceil(hi[1]));
    const k0 = Math.max(0, Math.floor(lo[2])), k1 = Math.min(nz - 1, Math.ceil(hi[2]));
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        let x = origin[0] + i0 * stepX[0] + j * stepY[0] + k * stepZ[0];
        let y = origin[1] + i0 * stepX[1] + j * stepY[1] + k * stepZ[1];
        let z = origin[2] + i0 * stepX[2] + j * stepY[2] + k * stepZ[2];
        let q = i0 + nx * (j + ny * k);
        for (let i = i0; i <= i1; i++, q++) {
          fn(x, y, z, q);
          x += stepX[0]; y += stepX[1]; z += stepX[2];
        }
      }
    }
  }
  function paint(points, rad, fn) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of points) {
      const d = sub(p, origin);
      for (let a = 0; a < 3; a++) {
        const ci = inv[3 * a] * d[0] + inv[3 * a + 1] * d[1] + inv[3 * a + 2] * d[2];
        lo[a] = Math.min(lo[a], ci - rad * rowN[a] - 1);
        hi[a] = Math.max(hi[a], ci + rad * rowN[a] + 1);
      }
    }
    paintBox(lo, hi, fn);
  }
  const mixTo = (q, val, d, sig) => {
    if (d < -4 * sig) return;
    const c = d > 4 * sig ? 1 : cdf(d / sig);
    arr[q] += (val - arr[q]) * c;
  };
  const bone = (points, rad, depth, cortexHU, cancHU, t = 2) => paint(points, rad, (x, y, z, q) => {
    const d = depth(x, y, z);
    if (d < -4 * sigVox) return;
    mixTo(q, cortexHU, d, sigVox);
    mixTo(q, cancHU, d - t, sigVox);
  });
  const solid = (points, rad, depth, val, sig = sigVox) => paint(points, rad, (x, y, z, q) => {
    const d = depth(x, y, z);
    if (d >= -4 * sig) mixTo(q, val, d, sig);
  });
  const capsule = (A, B, r0, r1) => {
    const ab = sub(B, A), L2 = dot(ab, ab);
    return (x, y, z) => {
      const px = x - A[0], py = y - A[1], pz = z - A[2];
      let t = (px * ab[0] + py * ab[1] + pz * ab[2]) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - ab[0] * t, dy = py - ab[1] * t, dz = pz - ab[2] * t;
      return r0 + (r1 - r0) * t - Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
  };
  const sphere = (c, R) => (x, y, z) => R - Math.hypot(x - c[0], y - c[1], z - c[2]);

  // ---- body -------------------------------------------------------------------------------------
  {
    const ax = 84, ay = 74;
    paintBox([0, 0, 0], [nx - 1, ny - 1, nz - 1], (x, y, z, q) => {
      const rho = Math.hypot((x - Wc[0]) / ax, (y - Wc[1]) / ay);
      mixTo(q, SOFT, (1 - rho) * ay, sigVox);
    });
  }

  // ---- head / humerus reference positions ------------------------------------------------------------
  let hc = null, headR = null, S0 = null, Dsh = null, n_t = null, Tpt = null, sdir = null, refC, refR;
  if (kind !== 'reverse') {
    const off = (subPct / 100 - 0.5) * 2 * Rh;
    const L = (Rh - 1.0 - off * dot(ant, dir)) / dot(lat, dir);
    hc = add(add(gc, mul(lat, L)), mul(ant, off));
    headR = Rh;
    S0 = add(hc, [sgn * 14, 0, -24]);
    Dsh = unit([sgn * 0.08, 0, -1]);
    refC = hc; refR = Rh;
  } else {
    const m1 = unit(sub(down, mul(dir, dot(down, dir))));
    n_t = unit(add(mul(dir, Math.cos(50 * D2R)), mul(m1, Math.sin(50 * D2R))));
    const m2 = unit(sub(down, mul(n_t, dot(down, n_t))));
    sdir = unit(add(mul(n_t, Math.cos(35 * D2R)), mul(m2, Math.sin(35 * D2R))));
    Tpt = add(gc, mul(n_t, Rg + 9));
    refC = add(gc, mul(n_t, Rg + 5)); refR = Rg + 9;
  }

  // ---- muscles ----------------------------------------------------------------------------------------
  const muscleDefs = {
    supraspinatus: { c: [34, 22, -11], s: [28, 13, 9] },
    infraspinatus: { c: [34, -30, -11], s: [28, 24, 9] },
    subscapularis: { c: [32, -14, 11], s: [28, 36, 9] },
    teresMinor: { c: [50, -34, -9], s: [8, 20, 6] },
  };
  const muscleSalt = { supraspinatus: 11, infraspinatus: 12, subscapularis: 13, teresMinor: 14, deltoid: 15 };
  const muscles = {};
  const paintMuscle = (name, points, rad, depth) => {
    const f = fatF[name], salt = muscleSalt[name] + seed * 101;
    paint(points, rad, (x, y, z, q) => {
      const d = depth(x, y, z);
      if (d < -4 * sigVox) return;
      mixTo(q, hash01(q, salt) < f ? FAT : MUSCLE, d, sigVox);
    });
  };
  for (const [name, d] of Object.entries(muscleDefs)) {
    const cw = P(d.c[0], d.c[1], d.c[2]);
    const mn = Math.min(...d.s);
    paintMuscle(name, [cw], Math.max(...d.s) + 2, (x, y, z) => {
      const [a, b, c] = toPlate(x, y, z);
      const rho = Math.sqrt(((a - d.c[0]) / d.s[0]) ** 2 + ((b - d.c[1]) / d.s[1]) ** 2 + ((c - d.c[2]) / d.s[2]) ** 2);
      return (1 - rho) * mn;
    });
    muscles[name] = { center: cw, fatFraction: fatF[name] };
  }
  {
    const dc = add(refC, mul(lh, 10)), sa = refR + 14, sb = refR + 16;
    paintMuscle('deltoid', [dc], sb + 4, (x, y, z) => {
      const rho = Math.sqrt(((x - dc[0]) / sa) ** 2 + ((y - dc[1]) / sa) ** 2 + ((z - dc[2]) / sb) ** 2);
      return Math.min((1 - rho) * sa, (x - refC[0]) * lh[0]);
    });
    muscles.deltoid = { center: add(refC, mul(lh, refR + 10)), fatFraction: fatF.deltoid };
  }

  // ---- scapula ----------------------------------------------------------------------------------------
  const poly = [[-1, 30], [8, -100], [22, -100], [40, -60], [66, -14], [68, 12], [45, 36]];
  const polyDepth = (a, b) => {
    let dmin = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i], p1 = poly[(i + 1) % poly.length];
      const ex = p1[0] - p0[0], ey = p1[1] - p0[1];
      const d = (ex * (b - p0[1]) - ey * (a - p0[0])) / Math.hypot(ex, ey);
      if (d < dmin) dmin = d;
    }
    return dmin;
  };
  bone(poly.map(([a, b]) => P(a, b, 0)), 6, (x, y, z) => {
    const [a, b, c] = toPlate(x, y, z);
    return Math.min(polyDepth(a, b), 2.5 - Math.abs(c));
  }, CORTEX_S, CANC_S, 2.5);
  // neck
  const gDepthBase = (semiU, semiW) => (x, y, z) => {
    const px = x - gc[0], py = y - gc[1], pz = z - gc[2];
    const s = px * dir[0] + py * dir[1] + pz * dir[2];
    const u = px * eSup[0] + py * eSup[1] + pz * eSup[2];
    const w = px * eAp[0] + py * eAp[1] + pz * eAp[2];
    const rho = Math.hypot(u / semiU, w / semiW);
    return Math.min((1 - rho) * Math.min(semiU, semiW), -s, s + 22);
  };
  const glSemi = kind === 'reverse' ? [22, 17] : [17, 12];
  bone([add(gc, mul(dir, -11))], 28, gDepthBase(glSemi[0], glSemi[1]), CORTEX_S, CANC_S, 2);
  const neckB = P(52, 2, 0);
  bone([sub(gc, mul(dir, 20)), neckB], 12, capsule(sub(gc, mul(dir, 20)), neckB, 9, 9), CORTEX_S, CANC_S, 2);
  // spine
  {
    const hgt = (a) => Math.min(22, 2 + 0.5 * a);
    const sp = [P(2, 4, -12), P(72, 4, -12)];
    bone(sp, 30, (x, y, z) => {
      const [a, b, c] = toPlate(x, y, z);
      return Math.min(3 - Math.abs(b - 4), hgt(a) - (-c), a - 1, 72 - a, -c + 2);
    }, CORTEX_S, CANC_S, 3);
  }
  // acromion, coracoid
  { const A = P(64, 16, -10), B = P(92, 36, -8); bone([A, B], 8, capsule(A, B, 5, 4), CORTEX_S, CANC_S, 2); }
  { const A = P(60, 14, 6), B = P(76, 20, 30); bone([A, B], 7, capsule(A, B, 4, 3), CORTEX_S, CANC_S, 2); }

  const truth = {
    tri, ia, glenoidCenter: gc.slice(),
    ga: add(gc, mul(eAp, glSemi[1] * (kind === 'reverse' ? 0.7 : 1))), gp: sub(gc, mul(eAp, glSemi[1] * (kind === 'reverse' ? 0.7 : 1))),
    gsup: add(gc, mul(eSup, glSemi[0] * (kind === 'reverse' ? 0.8 : 1))), ginf: sub(gc, mul(eSup, glSemi[0] * (kind === 'reverse' ? 0.8 : 1))),
    headCenter: hc, headRadius: headR, glenosphere: null, post: null, stem: null,
    versionDeg, inclinationDeg, subluxationPct: kind === 'reverse' ? null : subPct, side, kind,
    faceNormal: dir, lat, ant, sup,
    muscles,
  };

  // ---- humerus + implants ------------------------------------------------------------------------------
  if (kind === 'native' || kind === 'hemi') {
    const neck = capsule(hc, S0, 17, 15), shaftEnd = add(S0, mul(Dsh, 170)), shaft = capsule(S0, shaftEnd, 15, 14.5);
    if (kind === 'native') {
      const hs = sphere(hc, Rh);
      bone([hc, S0, shaftEnd], 24, (x, y, z) => Math.max(hs(x, y, z), neck(x, y, z), shaft(x, y, z)), CORTEX_H, CANC_H, 2);
    } else {
      const top = (x, y, z) => (x - S0[0]) * Dsh[0] + (y - S0[1]) * Dsh[1] + (z - S0[2]) * Dsh[2];
      bone([S0, shaftEnd], 20, (x, y, z) => Math.min(shaft(x, y, z), top(x, y, z) + 2), CORTEX_H, CANC_H, 2);
      solid([hc], Rh + 4, sphere(hc, Rh), PYRO);
      const nk = capsule(hc, S0, 6, 6), st = capsule(S0, add(S0, mul(Dsh, 100)), 6, 4.5);
      solid([hc, S0], 10, nk, METAL, sigMetal);
      solid([S0, add(S0, mul(Dsh, 100))], 10, st, METAL, sigMetal);
      truth.stem = { a: S0, b: add(S0, mul(Dsh, 100)) };
    }
  } else {
    const tEnd = add(Tpt, mul(sdir, 170));
    const tapered = (x, y, z) => {
      const px = x - Tpt[0], py = y - Tpt[1], pz = z - Tpt[2];
      const t = px * sdir[0] + py * sdir[1] + pz * sdir[2];
      const rr = Math.hypot(px - sdir[0] * t, py - sdir[1] * t, pz - sdir[2] * t);
      return Math.min(Math.max(14, 19 - (t / 40) * 5) - rr, t + 1);
    };
    bone([Tpt, tEnd], 22, tapered, CORTEX_H, CANC_H, 2.5);
    // glenosphere: hemispherical dome on baseplate with central post and screws
    const C = gc;
    const thetaMax = 42 * D2R;
    const rel = (x, y, z) => [x - C[0], y - C[1], z - C[2]];
    solid([C], Rg + 3, (x, y, z) => {
      const p = rel(x, y, z);
      const r = Math.hypot(p[0], p[1], p[2]);
      return Math.min(Rg - r, p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2]);
    }, METAL, sigMetal);
    solid([C], 18, (x, y, z) => {
      const p = rel(x, y, z);
      const s = p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2];
      const rp = Math.sqrt(Math.max(0, p[0] * p[0] + p[1] * p[1] + p[2] * p[2] - s * s));
      return Math.min(14 - rp, s + 4, 0.5 - s);
    }, METAL, sigMetal);
    const postTip = sub(C, mul(dir, 25));
    solid([C, postTip], 6, capsule(C, postTip, 3.5, 3.5), METAL, sigMetal);
    const nScrews = 2 + (seed % 3);
    for (let k = 0; k < nScrews; k++) {
      const phi = (90 + (360 / nScrews) * k + 15) * D2R;
      const out = add(mul(eSup, Math.cos(phi)), mul(eAp, Math.sin(phi)));
      const Q = add(sub(C, mul(dir, 2)), mul(out, 9));
      const E = add(Q, mul(unit(add(mul(dir, -1), mul(out, 0.3))), 30));
      solid([Q, E], 6, capsule(Q, E, 2.2, 2.2), METAL, sigMetal);
    }
    truth.glenosphere = { center: C.slice(), radius: Rg, axis: dir };
    truth.post = postTip;
    // humeral cup: polyethylene liner + metal tray over the dome, stem below
    const cupDepth = (r0, r1) => (x, y, z) => {
      const p = rel(x, y, z);
      const r = Math.hypot(p[0], p[1], p[2]);
      const ct = Math.max(-1, Math.min(1, (p[0] * n_t[0] + p[1] * n_t[1] + p[2] * n_t[2]) / r));
      return Math.min(r - r0, r1 - r, r * (thetaMax - Math.acos(ct)));
    };
    solid([C], Rg + 12, cupDepth(Rg + 0.6, Rg + 5), POLY);
    solid([C], Rg + 12, cupDepth(Rg + 5, Rg + 9), METAL, sigMetal);
    const stB = add(Tpt, mul(sdir, 100));
    solid([Tpt, stB], 10, capsule(Tpt, stB, 6.5, 4.5), METAL, sigMetal);
    truth.stem = { a: Tpt, b: stB };
  }

  // ---- noise, clip, quantise -------------------------------------------------------------------------------
  const data = new Int16Array(N);
  const rng = mulberry32(seed * 7919 + 13);
  const hiLim = clip == null ? 32767 : Math.min(32767, clip);
  for (let q = 0; q < N; q += 2) {
    let v1 = arr[q], v2 = q + 1 < N ? arr[q + 1] : 0;
    if (noise > 0) {
      const u1 = Math.max(1e-12, rng()), u2 = rng();
      const r = Math.sqrt(-2 * Math.log(u1)) * noise;
      v1 += r * Math.cos(6.283185307 * u2); v2 += r * Math.sin(6.283185307 * u2);
    }
    data[q] = Math.max(-1024, Math.min(hiLim, Math.round(v1)));
    if (q + 1 < N) data[q + 1] = Math.max(-1024, Math.min(hiLim, Math.round(v2)));
  }

  const volume = { dims: [nx, ny, nz], data, origin, stepX, stepY, stepZ, spacing: [vx, vy, vz] };
  return { volume, truth };
}
