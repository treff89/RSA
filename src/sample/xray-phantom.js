// Deterministic synthetic AP shoulder radiographs with ground truth.
//
// Used by the detector tests and by the app's "load a synthetic example"
// button. These are schematic phantoms, NOT anatomically exact: soft tissue,
// scapula / glenoid / acromion / clavicle / ribs, a humerus with cortex and
// canal, and one of three situations (reverse arthroplasty, stemmed
// hemiarthroplasty with a pyrocarbon or metal head, native shoulder).
//
// Geometry is built in a canonical millimetre frame: origin at the centre of
// the bony glenoid, +x lateral, +y inferior. side 'L' maps lateral to image
// right, side 'R' (default) to image left, as on a conventional AP view.
// Output intensities follow the app convention: higher = more attenuating.

import { gaussianBlur } from '../detect/image.js';

const DEG = Math.PI / 180;
const MU = 0.018; // attenuation per mm of cortical-equivalent bone (normalised units)
const CANC = 0.3; // cancellous / marrow density relative to cortex
const AX = 7; // humeral frame: lateral offset of the shaft axis from the head centre (mm)

/** Levels (fraction t along the stem a→b) used for the stem / canal width landmarks. */
export const STEM_LEVELS = { metaphyseal: 0.3, distal: 0.85 };

export const PHANTOM_DEFAULTS = Object.freeze({
  kind: 'reverse',
  width: 1400,
  height: 1700,
  mmPerPx: 0.2,
  side: 'R',
  seed: 1,
  originFrac: [0.45, 0.34], // position of the glenoid centre (for side 'L'; mirrored for 'R')
  // glenoid / reverse
  glenosphereDiameter: 38, // mm
  tilt: 0, // deg; + = glenosphere axis points superiorly (superior tilt)
  overhang: 3, // mm the glenosphere extends below the inferior bony glenoid rim
  domeFraction: 0.56, // dome height / sphere diameter (0.5 hemisphere … 0.67)
  linerThickness: 5, // mm polyethylene between dome and metal tray
  trayOverlap: 0, // mm; > 0 makes the metal tray overlap the dome (overrides linerThickness)
  neckShaftAngle: 145, // deg (reverse humeral component)
  stemVarus: 0, // deg; + = stem tip towards lateral
  stemLength: 110, // mm (proximal-most metal → tip, along the stem axis)
  stemWidthProx: 13,
  stemWidthTip: 9,
  abduction: 12, // deg of arm abduction (shaft axis vs vertical)
  // head (hemi / native)
  headDiameter: 46, // mm; prosthetic head (hemi) / native head
  nativeHeadDiameter: null, // native anatomical circle (defaults to headDiameter)
  headMaterial: 'pyc', // 'pyc' | 'metal'
  headCapFraction: 0.62, // prosthetic head height / diameter
  headOffset: [0, 0], // mm, prosthetic centre vs native centre (humeral frame: lateral, distal)
  migration: 0, // mm superior migration of the humeral head (hemi / native)
  osteophyte: 0, // mm size of an inferior humeral osteophyte (native)
  acromionLateral: 27, // mm lateral extent of the acromion from the glenoid centre
  // image formation
  noise: 0.012, // sd of additive noise (fraction of full scale)
  trabecular: 0.3, // relative amplitude of trabecular texture in bone (real bone is never uniform)
  blurMm: 0.3,
  vignette: 0.1,
  metalLevel: 1,
  bits: 12,
  invert: false,
  range: null, // [lo, hi] float output range instead of integer bits
  marker: false, // metal side marker letter
  cerclage: 0, // number of cerclage wires around the shaft
  collimation: 0, // fraction of the image width shown as a white collimator border
});

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rot = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const add = (a, b, k = 1) => [a[0] + k * b[0], a[1] + k * b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function sdCapsule(x, y, a, b, ra, rb) {
  const bx = b[0] - a[0], by = b[1] - a[1];
  const px = x - a[0], py = y - a[1];
  const l2 = bx * bx + by * by;
  const t = l2 > 0 ? clamp01((px * bx + py * by) / l2) : 0;
  return Math.hypot(px - t * bx, py - t * by) - (ra + t * (rb - ra));
}

function sdBox(x, y, c, u, hl, ht) {
  const px = x - c[0], py = y - c[1];
  const a = Math.abs(px * u[0] + py * u[1]) - hl;
  const b = Math.abs(-px * u[1] + py * u[0]) - ht;
  return Math.min(Math.max(a, b), 0) + Math.hypot(Math.max(a, 0), Math.max(b, 0));
}

// signed distance to an arbitrary simple polygon (negative inside)
function sdPoly(x, y, v) {
  const n = v.length;
  let d = Infinity, s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const ex = v[j][0] - v[i][0], ey = v[j][1] - v[i][1];
    const wx = x - v[i][0], wy = y - v[i][1];
    const t = clamp01((wx * ex + wy * ey) / (ex * ex + ey * ey));
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = y >= v[i][1], c2 = y < v[j][1], c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

function bbox(pts, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

// tube / sphere projection thickness: cortical shell + cancellous core
function shellThickness(d, Ro, Ri) {
  if (d >= Ro) return 0;
  const o = 2 * Math.sqrt(Ro * Ro - d * d);
  const i = d < Ri ? 2 * Math.sqrt(Ri * Ri - d * d) : 0;
  return o - i + CANC * i;
}

// humeral shaft radii (humeral frame, hy = distance distal to the head centre)
function shaftRadii(hy) {
  const s = Math.max(hy, 5) - 5;
  const Ro = 12 + 5 * Math.exp(-s / 22);
  const Ri = Ro - (1.5 + 3.2 * (1 - Math.exp(-s / 30)));
  return [Ro, Ri];
}

/**
 * Build a synthetic AP shoulder radiograph.
 * @param {Partial<typeof PHANTOM_DEFAULTS>} options
 * @returns {{ image:{width:number,height:number,data:Float32Array}, mmPerPx:number, truth:object, params:object }}
 */
export function makePhantom(options = {}) {
  const p = { ...PHANTOM_DEFAULTS, ...options };
  const W = p.width, H = p.height, mm = p.mmPerPx;
  const sx = p.side === 'L' ? 1 : -1;
  const ox = (p.side === 'L' ? p.originFrac[0] : 1 - p.originFrac[0]) * (W - 1);
  const oy = p.originFrac[1] * (H - 1);
  const toPx = (q) => [ox + (sx * q[0]) / mm, oy + q[1] / mm];
  const N = W * H;
  const att = new Float32Array(N);
  const metal = new Float32Array(N);
  const cov = (sd) => clamp01(0.5 - sd / mm);

  function paint(layer, box, fn, useMax) {
    let pa = ox + (sx * box[0]) / mm, pb = ox + (sx * box[2]) / mm;
    if (pa > pb) [pa, pb] = [pb, pa];
    const ix0 = Math.max(0, Math.floor(pa) - 1), ix1 = Math.min(W - 1, Math.ceil(pb) + 1);
    const iy0 = Math.max(0, Math.floor(oy + box[1] / mm) - 1);
    const iy1 = Math.min(H - 1, Math.ceil(oy + box[3] / mm) + 1);
    for (let iy = iy0; iy <= iy1; iy++) {
      const y = (iy - oy) * mm;
      for (let ix = ix0; ix <= ix1; ix++) {
        const v = fn(sx * (ix - ox) * mm, y);
        if (v > 0) {
          const i = iy * W + ix;
          if (useMax) { if (v > layer[i]) layer[i] = v; } else layer[i] += v;
        }
      }
    }
  }
  const paintMetal = (box, sdf) => paint(metal, box, (x, y) => cov(sdf(x, y)), true);
  const bottomMm = (H - oy) * mm + 5;

  // ---------------------------------------------------------------- glenoid
  const isRev = p.kind === 'reverse';
  const tau = (isRev ? p.tilt : 0) * DEG;
  const u = [Math.cos(tau), -Math.sin(tau)]; // out of the glenoid face (lateral)
  const v = [Math.sin(tau), Math.cos(tau)]; // along the face, inferior
  const GH = 18; // half height of the bony glenoid
  const sgt = add([0, 0], v, -GH);
  const igr = add([0, 0], v, GH);
  const ssfA = [-62, -24], ssfB = [-7, -14];
  const acrTip = [p.acromionLateral, -35];
  const acrA0 = [-22, -40], acrA1 = [acrTip[0] - 6.5, -35];

  // scapular body (thin plate) with a denser lateral border and neck
  const body = [sgt, igr, [-8, 30], [-50, 120], [-62, 128], [-118, -30], [-100, -48], [-30, -30]];
  paint(att, bbox(body, 3), (x, y) => {
    const sd = sdPoly(x, y, body);
    if (sd > 1) return 0;
    return MU * (2.2 * clamp01(0.5 - sd) + 2.5 * Math.exp(-(sd * sd) / 3));
  });
  const neck = [sgt, igr, [-24, 20], [-28, -14]];
  paint(att, bbox(neck, 6), (x, y) => {
    const sd = sdPoly(x, y, neck);
    return sd < 4 ? MU * 9 * clamp01(0.5 - sd / 2) * (1 + 0.5 * Math.exp(-(sd * sd) / 2)) : 0;
  });
  const tubes = [
    [add(igr, [-6, 6]), [-52, 118], 5.5, 4, 0.55], // lateral border
    [[-115, -38], [-20, -36], 6, 6, 0.6], // scapular spine
    [acrA0, acrA1, 6.5, 6.5, 0.62], // acromion
    [[-150, -62], [-16, -46], 7, 7.5, 0.6], // clavicle
  ];
  for (const [a, b, ra, rb, ri] of tubes) {
    paint(att, bbox([a, b], Math.max(ra, rb) + 1), (x, y) => {
      const bx = b[0] - a[0], by = b[1] - a[1];
      const t = clamp01(((x - a[0]) * bx + (y - a[1]) * by) / (bx * bx + by * by));
      const R = ra + t * (rb - ra);
      return MU * shellThickness(Math.hypot(x - a[0] - t * bx, y - a[1] - t * by), R, R * ri);
    });
  }
  // coracoid
  paint(att, [-27, -38, -3, -20], (x, y) => {
    const q = ((x + 15) / 10) ** 2 + ((y + 29) / 7.5) ** 2;
    return q < 1 ? MU * 9 * Math.sqrt(1 - q) : 0;
  });
  // sclerotic lines: floor of the supraspinatus fossa, subchondral glenoid
  for (const [a, b, wd, amp] of [[ssfA, ssfB, 1.0, 0.11], [sgt, igr, 0.8, 0.06]]) {
    paint(att, bbox([a, b], 4), (x, y) => {
      const d = sdCapsule(x, y, a, b, 0, 0);
      return d < 4 ? amp * Math.exp(-(d * d) / (2 * wd * wd)) : 0;
    });
  }
  // ribs (cosmetic)
  for (let i = 0; i < 6; i++) {
    const c = [-235, -60 + 36 * i], R = 150;
    paint(att, [c[0], c[1] - 60, c[0] + R + 8, c[1] + R], (x, y) => {
      const dx = x - c[0], dy = y - c[1];
      const ang = Math.atan2(dy, dx);
      if (ang < -0.3 || ang > 0.85) return 0;
      const d = Math.abs(Math.hypot(dx, dy) - R);
      return d < 5.5 ? MU * (2.2 * clamp01(5 - d) + 2 * Math.exp(-((d - 4.2) ** 2))) : 0;
    });
  }

  // ---------------------------------------------------------------- humerus
  const beta = p.abduction * DEG;
  const l = [Math.cos(beta), -Math.sin(beta)]; // humeral frame lateral axis (canonical)
  const e = [Math.sin(beta), Math.cos(beta)]; // humeral frame distal axis (canonical)
  const rn = (p.nativeHeadDiameter ?? p.headDiameter) / 2;
  const r = p.glenosphereDiameter / 2;

  // implant frame inside the humerus (humeral coordinates)
  let Hpos; // canonical position of the humeral-frame origin (native head centre)
  let clipN = null, clipD = 0; // bone removed where q·clipN > -clipD (humeral frame)
  let rev = null, hemi = null;
  if (isRev) {
    const phi = p.stemVarus * DEG;
    const es = [Math.sin(phi), Math.cos(phi)]; // stem distal direction
    const perp = [es[1], -es[0]]; // lateral perpendicular
    const n = rot([-es[0], -es[1]], -(180 - p.neckShaftAngle) * DEG); // cup axis (towards the sphere)
    const m = [-n[1], n[0]];
    const Tc = [AX, 0];
    const tT = 5, hw = 17;
    const liner = p.trayOverlap > 0 ? -p.trayOverlap : p.linerThickness;
    const cupC = add(Tc, n, tT + liner + r);
    const sA = Math.min(dot(add(add(Tc, n, tT), m, hw), es), dot(add(add(Tc, n, tT), m, -hw), es)) - dot(Tc, es);
    const sTip = sA + p.stemLength;
    rev = { es, perp, n, m, Tc, tT, hw, cupC, sA, sTip };
    clipN = n; clipD = -dot(Tc, n);
    // glenosphere placement
    const d = (2 * p.domeFraction - 1) * r;
    const half = Math.sqrt(r * r - d * d);
    const fb = add(igr, v, p.overhang);
    const fa = add(fb, v, -2 * half);
    const c = add(add(fa, v, half), u, d);
    rev.c = c; rev.fa = fa; rev.fb = fb; rev.d = d;
    const ch = cupC;
    Hpos = [c[0] - (ch[0] * l[0] + ch[1] * e[0]), c[1] - (ch[0] * l[1] + ch[1] * e[1])];
  } else {
    Hpos = [rn + 3, -p.migration];
    if (p.kind === 'hemi') {
      const nh = rot([0, -1], -45 * DEG);
      const mh = [-nh[1], nh[0]];
      const hr = p.headDiameter / 2;
      const Hp = [p.headOffset[0], p.headOffset[1]];
      const dn = hr * (2 * p.headCapFraction - 1);
      const Fc = add(Hp, nh, -dn); // centre of the flat back face
      hemi = { nh, mh, hr, Hp, dn, Fc };
      clipN = nh; clipD = -dot(Fc, nh);
    }
  }
  const toCan = (q) => [Hpos[0] + q[0] * l[0] + q[1] * e[0], Hpos[1] + q[0] * l[1] + q[1] * e[1]];
  const toHum = (x, y) => {
    const dx = x - Hpos[0], dy = y - Hpos[1];
    return [dx * l[0] + dy * l[1], dx * e[0] + dy * e[1]];
  };
  const GT = { c: [21.5, -4], a: 6.5, b: 9.8 };

  paint(att, [Hpos[0] - 70, Hpos[1] - 45, Hpos[0] + 120, bottomMm], (x, y) => {
    const [hx, hy] = toHum(x, y);
    let t = 0;
    const [Ro, Ri] = shaftRadii(hy);
    t = shellThickness(hy >= 5 ? Math.abs(hx - AX) : Math.hypot(hx - AX, hy - 5), Ro, Ri);
    const hd = Math.hypot(hx, hy);
    if (hd < rn) t = Math.max(t, shellThickness(hd, rn, rn - 1.6));
    if (clipN && t > 0) t *= clamp01(0.5 - (hx * clipN[0] + hy * clipN[1] + clipD) / mm);
    const q = ((hx - GT.c[0]) / GT.a) ** 2 + ((hy - GT.c[1]) / GT.b) ** 2;
    if (q < 1) t += 13 * Math.sqrt(1 - q);
    if (p.osteophyte > 0 && p.kind === 'native') {
      const oc = [-0.64 * (rn + 0.3 * p.osteophyte), 0.77 * (rn + 0.3 * p.osteophyte)];
      const oq = ((hx - oc[0]) / p.osteophyte) ** 2 + ((hy - oc[1]) / (0.7 * p.osteophyte)) ** 2;
      if (oq < 1) t += 10 * Math.sqrt(1 - oq);
    }
    return MU * t;
  });

  // ---------------------------------------------------------------- implants
  let humeralSd = null; // canonical signed distance of the humeral metal (stem etc.)
  let stemAxis = null; // canonical { a, b, dir, perp }
  if (isRev) {
    const { es, perp, n, m, Tc, tT, hw, sA, sTip, c, d } = rev;
    // glenosphere dome, baseplate, peg and screws
    paintMetal([c[0] - r - 1, c[1] - r - 1, c[0] + r + 1, c[1] + r + 1], (x, y) => {
      const dx = x - c[0], dy = y - c[1];
      return Math.max(Math.hypot(dx, dy) - r, -(dx * u[0] + dy * u[1] + d));
    });
    const faceMid = add(c, u, -d);
    const bpC = add(faceMid, u, -2.5);
    paintMetal(bbox([bpC], 18), (x, y) => sdBox(x, y, bpC, v, 13.5, 2.6));
    const screws = [
      [add(faceMid, u, -4), add(faceMid, u, -24), 4, 3.2],
      [add(add(faceMid, v, -8), u, -4), add(add(faceMid, v, -8), rot([-u[0], -u[1]], sx * 0 + 20 * DEG), 30), 2.3, 2.1],
      [add(add(faceMid, v, 8), u, -4), add(add(faceMid, v, 8), rot([-u[0], -u[1]], -15 * DEG), 34), 2.3, 2.1],
    ];
    for (const [a, b, ra, rb] of screws) paintMetal(bbox([a, b], 5), (x, y) => sdCapsule(x, y, a, b, ra, rb));
    // humeral component: tray, metaphyseal body, tapered stem
    const Rp = p.stemWidthProx / 2, Rt = p.stemWidthTip / 2;
    const trayC = toCan(add(Tc, n, tT / 2));
    const mC = [m[0] * l[0] + m[1] * e[0], m[0] * l[1] + m[1] * e[1]];
    const quad = [add(Tc, m, 15), add(Tc, m, -15), add(add(Tc, es, 30), perp, -Rp), add(add(Tc, es, 30), perp, Rp)].map(toCan);
    const s0 = toCan(add(Tc, es, 6)), s1 = toCan(add(Tc, es, sTip - Rt));
    const RpAdj = Rp, RtAdj = Rt;
    humeralSd = (x, y) => Math.min(sdBox(x, y, trayC, mC, hw, tT / 2), sdPoly(x, y, quad), sdCapsule(x, y, s0, s1, RpAdj, RtAdj));
    paintMetal(bbox([...quad, s0, s1, add(trayC, mC, hw), add(trayC, mC, -hw)], 9), humeralSd);
    const a = toCan(add(Tc, es, sA)), b = toCan(add(Tc, es, sTip));
    stemAxis = { a, b, s0: sA, tc: Tc, es, perp };
  } else if (p.kind === 'hemi') {
    const { nh, mh, hr, Hp, dn, Fc } = hemi;
    const hc = toCan(Hp);
    const nC = [nh[0] * l[0] + nh[1] * e[0], nh[0] * l[1] + nh[1] * e[1]];
    const headSd = (x, y) => {
      const dx = x - hc[0], dy = y - hc[1];
      return Math.max(Math.hypot(dx, dy) - hr, -(dx * nC[0] + dy * nC[1] + dn));
    };
    const hb = [hc[0] - hr - 1, hc[1] - hr - 1, hc[0] + hr + 1, hc[1] + hr + 1];
    if (p.headMaterial === 'metal') paintMetal(hb, headSd);
    else {
      paint(att, hb, (x, y) => {
        const dd = Math.hypot(x - hc[0], y - hc[1]);
        if (dd >= hr) return 0;
        // pyrocarbon: moderately radiodense shell + body (denser than bone, well below metal)
        return (0.13 * cov(dd - hr) + 0.006 * 2 * Math.sqrt(hr * hr - dd * dd)) * cov(-(((x - hc[0]) * nC[0] + (y - hc[1]) * nC[1]) + dn));
      });
    }
    const es = [0, 1], perp = [1, 0];
    const Rp = p.stemWidthProx / 2, Rt = p.stemWidthTip / 2;
    const quad = [add(Fc, mh, 9), add(Fc, mh, -9), [AX - Rp, 28], [AX + Rp, 28]].map(toCan);
    const sA = Math.min(dot(add(Fc, mh, 9), es), dot(add(Fc, mh, -9), es));
    const sTip = sA + p.stemLength;
    const s0 = toCan([AX, 14]), s1 = toCan([AX, sTip - Rt]);
    humeralSd = (x, y) => Math.min(sdPoly(x, y, quad), sdCapsule(x, y, s0, s1, Rp, Rt));
    paintMetal(bbox([...quad, s0, s1], 9), humeralSd);
    stemAxis = { a: toCan([AX, sA]), b: toCan([AX, sTip]), s0: sA, tc: [AX, 0], es, perp };
  }

  // cerclage wires (thin metal loops around the shaft)
  const wires = [];
  for (let i = 0; i < p.cerclage; i++) {
    const hy = 62 + 16 * i;
    const a = shaftRadii(hy)[0] + 1.2, b = 3.5;
    wires.push(hy);
    const cc = toCan([AX, hy]);
    paintMetal([cc[0] - a - 6, cc[1] - a - 6, cc[0] + a + 6, cc[1] + a + 6], (x, y) => {
      const [hx, hy2] = toHum(x, y);
      const X = hx - AX, Y = hy2 - hy;
      const q = Math.hypot(X / a, Y / b);
      if (q < 1e-6) return 5;
      const g = Math.hypot(X / (a * a), Y / (b * b)) / q;
      return Math.abs(q - 1) / g - 0.8;
    });
  }
  // metal side marker letter (not mirrored)
  let markerBox = null;
  if (p.marker) {
    const mk = [96, -88];
    const S = (dx, dy) => [mk[0] + sx * dx, mk[1] + dy];
    const strokes = p.side === 'L'
      ? [[S(0, 0), S(0, 13)], [S(0, 13), S(8, 13)]]
      : [[S(0, 0), S(0, 13)], [S(0, 0), S(5, 0.5)], [S(5, 0.5), S(7, 3.2)], [S(7, 3.2), S(5, 6)], [S(5, 6), S(0, 6.5)], [S(2.5, 6.5), S(7.5, 13)]];
    for (const [a, b] of strokes) paintMetal(bbox([a, b], 3), (x, y) => sdCapsule(x, y, a, b, 1.4, 1.4));
    markerBox = bbox(strokes.flat(), 2);
  }

  // ---------------------------------------------------------------- soft tissue (coarse grid)
  const cell = 4;
  const gw = Math.ceil((W * mm) / cell) + 3, gh = Math.ceil((H * mm) / cell) + 3;
  let soft = new Float32Array(gw * gh);
  const hC = toCan([8, 4]);
  const armC = toCan([AX, 170]);
  const blobs = [
    [-175, 170, 150, 340, 1.0],
    [-110, -55, 160, 70, 0.8],
    [hC[0] - 6, hC[1] + 6, 64, 70, 0.78],
    [armC[0], armC[1], 52, 230, 0.72],
  ];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x = sx * ((gx - 1) * cell / mm - ox) * mm, y = ((gy - 1) * cell / mm - oy) * mm;
      let t = 0;
      for (const [bx, by, ra, rb, T] of blobs) {
        const q = ((x - bx) / ra) ** 2 + ((y - by) / rb) ** 2;
        if (q < 1) t = Math.max(t, T * Math.sqrt(1 - q));
      }
      const ql = ((x + 195) / 105) ** 2 + ((y - 160) / 200) ** 2; // lung
      if (ql < 1) t -= 0.3 * Math.sqrt(1 - ql);
      soft[gy * gw + gx] = t;
    }
  }
  soft = gaussianBlur(soft, gw, gh, 1.6);

  // ---------------------------------------------------------------- trabecular texture
  // Band-limited random field on a 1.4 mm lattice (its own random stream, so nothing else in the picture changes).
  const tcell = 1.4, tw = Math.ceil((W * mm) / tcell) + 3, th = Math.ceil((H * mm) / tcell) + 3;
  const trnd = mulberry32(p.seed * 104729 + 7);
  let tex = new Float32Array(tw * th);
  for (let i = 0; i < tex.length; i++) tex[i] = trnd() * 2 - 1;
  tex = gaussianBlur(tex, tw, th, 0.7);
  { let m = 0; for (let i = 0; i < tex.length; i++) m = Math.max(m, Math.abs(tex[i])); for (let i = 0; i < tex.length; i++) tex[i] /= m || 1; }
  const texAt = (ix, iy) => {
    const gxf = (ix * mm) / tcell + 1, gyf = (iy * mm) / tcell + 1, x0 = Math.floor(gxf), y0 = Math.floor(gyf), fx = gxf - x0, fy = gyf - y0, g = y0 * tw + x0;
    return (tex[g] * (1 - fx) + tex[g + 1] * fx) * (1 - fy) + (tex[g + tw] * (1 - fx) + tex[g + tw + 1] * fx) * fy;
  };

  // ---------------------------------------------------------------- compose
  const out = new Float32Array(N);
  const cxm = (W - 1) / 2, cym = (H - 1) / 2, rr = cxm * cxm + cym * cym;
  for (let iy = 0; iy < H; iy++) {
    const gyf = (iy * mm) / cell + 1, gy0 = Math.floor(gyf), fy = gyf - gy0;
    for (let ix = 0; ix < W; ix++) {
      const gxf = (ix * mm) / cell + 1, gx0 = Math.floor(gxf), fx = gxf - gx0;
      const g = gy0 * gw + gx0;
      const s = (soft[g] * (1 - fx) + soft[g + 1] * fx) * (1 - fy) + (soft[g + gw] * (1 - fx) + soft[g + gw + 1] * fx) * fy;
      const i = iy * W + ix;
      let t = 0.04 + 0.34 * Math.max(0, s) + att[i] * (1 + p.trabecular * texAt(ix, iy));
      t *= 1 - p.vignette * (((ix - cxm) ** 2 + (iy - cym) ** 2) / rr);
      if (t > 0.8) t = 0.8 + 0.12 * (1 - Math.exp(-(t - 0.8) / 0.12));
      const mc = metal[i];
      out[i] = mc > 0 ? t * (1 - mc) + mc * p.metalLevel : t;
    }
  }
  let data = gaussianBlur(out, W, H, Math.max(0.5, p.blurMm / mm));
  const rnd = mulberry32(p.seed * 7919 + 13);
  if (p.noise > 0) {
    for (let i = 0; i < N; i += 2) {
      const a = Math.sqrt(-2 * Math.log(1 - rnd())) * p.noise, b = 2 * Math.PI * rnd();
      data[i] += a * Math.cos(b);
      if (i + 1 < N) data[i + 1] += a * Math.sin(b);
    }
  }
  if (p.collimation > 0) {
    const bw = Math.round(p.collimation * W);
    for (let iy = 0; iy < H; iy++) {
      for (let ix = 0; ix < W; ix++) {
        const skew = Math.round(0.01 * iy);
        if (ix < bw + skew || ix >= W - bw || iy < bw || iy >= H - bw) data[iy * W + ix] = 1;
      }
    }
  }
  const lo = p.range ? p.range[0] : 0;
  const hi = p.range ? p.range[1] : 2 ** p.bits - 1;
  for (let i = 0; i < N; i++) {
    let t = clamp01(data[i]);
    if (p.invert) t = 1 - t;
    t = lo + t * (hi - lo);
    data[i] = p.range ? t : Math.round(t);
  }

  // ---------------------------------------------------------------- ground truth
  const P = (q) => toPx(q);
  const L = (a, b) => ({ a: toPx(a), b: toPx(b) });
  const truth = { sgt: P(sgt), igr: P(igr), acr: P(acrTip), ssf: L(ssfA, ssfB) };
  // greater tuberosity extremes (canonical: superior = -y, lateral = +x)
  const ellExt = (dir) => {
    const dh = [dir[0] * l[0] + dir[1] * l[1], dir[0] * e[0] + dir[1] * e[1]];
    const k = Math.hypot(GT.a * dh[0], GT.b * dh[1]);
    return toCan([GT.c[0] + (GT.a * GT.a * dh[0]) / k, GT.c[1] + (GT.b * GT.b * dh[1]) / k]);
  };
  const gts = ellExt([0, -1]);
  let gtl = ellExt([1, 0]);
  for (let hy = 5; hy < 60; hy += 0.25) {
    const q = toCan([AX + shaftRadii(hy)[0], hy]);
    if (q[0] > gtl[0]) gtl = q;
  }
  truth.gts = P(gts);
  truth.gtl = P(gtl);
  {
    const x = Math.min(Math.max(gts[0], acrA0[0]), acrA1[0]);
    const t = (x - acrA0[0]) / (acrA1[0] - acrA0[0]);
    truth.acu = P([x, acrA0[1] + t * (acrA1[1] - acrA0[1]) + 6.5]);
  }
  if (stemAxis) {
    const { a, b } = stemAxis;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let lat = [dir[1], -dir[0]];
    if (lat[0] < 0) lat = [-lat[0], -lat[1]]; // lateral = +x in the canonical frame
    const march = (c, d, inside) => {
      let s = 0;
      while (s < 80 && inside(c[0] + d[0] * (s + 0.02), c[1] + d[1] * (s + 0.02))) s += 0.02;
      return [c[0] + d[0] * s, c[1] + d[1] * s];
    };
    const inMetal = (x, y) => humeralSd(x, y) < 0;
    const inCanal = (x, y) => {
      const [hx, hy] = toHum(x, y);
      return Math.abs(hx - AX) < shaftRadii(hy)[1];
    };
    const section = (t, inside) => {
      const c = add(a, dir, t * len);
      const lp = march(c, lat, inside), mp = march(c, [-lat[0], -lat[1]], inside);
      return { t, c: P(c), m: P(mp), l: P(lp), width: Math.hypot(lp[0] - mp[0], lp[1] - mp[1]) / mm };
    };
    truth.stem = L(a, b);
    truth.stemProfile = [];
    truth.canalProfile = [];
    for (let k = 5; k <= 97; k++) {
      truth.stemProfile.push(section(k / 100, inMetal));
      truth.canalProfile.push(section(k / 100, inCanal));
    }
    const line = (s) => ({ a: s.m, b: s.l });
    truth.stemM = line(section(STEM_LEVELS.metaphyseal, inMetal));
    truth.stemD = line(section(STEM_LEVELS.distal, inMetal));
    truth.canalM = line(section(STEM_LEVELS.metaphyseal, inCanal));
    truth.canalD = line(section(STEM_LEVELS.distal, inCanal));
  }
  if (isRev) {
    const { c, fa, fb } = rev;
    const cp = P(c);
    truth.glenosphere = {
      cx: cp[0], cy: cp[1], r: r / mm,
      face: L(fa, fb),
      axis: [sx * u[0], u[1]],
    };
  } else {
    const hc = P(toCan(p.kind === 'hemi' ? hemi.Hp : [0, 0]));
    truth.head = { cx: hc[0], cy: hc[1], r: (p.kind === 'hemi' ? hemi.hr : rn) / mm };
    const nc = P(toCan([0, 0]));
    truth.nativeCircle = { cx: nc[0], cy: nc[1], r: rn / mm };
    truth.shaft = L(toCan([AX, 40]), toCan([AX, 140]));
    if (p.kind === 'hemi') {
      const { nh, mh } = hemi;
      const dn0 = -clipD; // plane: q·nh = -clipD
      const hh = Math.sqrt(Math.max(0, rn * rn - dn0 * dn0));
      truth.pcA = P(toCan([rn * Math.cos(8 * DEG), rn * Math.sin(8 * DEG)]));
      truth.pcB = P(toCan(add([nh[0] * dn0, nh[1] * dn0], mh, -hh)));
      truth.pcC = P(toCan(add([nh[0] * dn0, nh[1] * dn0], mh, hh)));
    } else if (p.osteophyte > 0) {
      const k = rn + 1.3 * p.osteophyte;
      truth.osteophyte = { tip: P(toCan([-0.64 * k, 0.77 * k])), size: p.osteophyte / mm };
    }
  }
  if (markerBox) {
    const a = toPx([markerBox[0], markerBox[1]]), b = toPx([markerBox[2], markerBox[3]]);
    truth.marker = { x0: Math.min(a[0], b[0]), y0: a[1], x1: Math.max(a[0], b[0]), y1: b[1] };
  }
  if (wires.length) truth.cerclage = wires.map((hy) => P(toCan([AX, hy])));

  return { image: { width: W, height: H, data }, mmPerPx: mm, truth, params: p };
}
