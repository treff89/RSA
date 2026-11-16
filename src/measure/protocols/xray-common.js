// Helpers shared by the radiograph protocols.
//
// ctx = {
//   L: { id: value }       landmark values — point {x,y}; line {a:{x,y}, b:{x,y}}; circle {cx,cy,r}   (image pixels, y down)
//   state: { id: 'auto'|'estimated'|'manual' }
//   mm: millimetres per pixel (null when uncalibrated)
//   lateralSign: +1 when the humerus is on the image's right of the glenoid, −1 when on its left
// }
// The image is assumed upright (superior = up). Every signed quantity is defined from landmarks plus that assumption.

import { sub, add, mul, dot, cross, unit, perp, mid, dist, DEG, lineIntersection, circleFrom3 } from '../geom.js';

export const UP = { x: 0, y: -1 };
export const lateral = (ctx) => ({ x: ctx.lateralSign || 1, y: 0 });
export const C = (circle) => ({ x: circle.cx, y: circle.cy });
export const mm = (ctx, px) => px * ctx.mm;

/** A line ordered so that `a` is its superior end. */
export function supInf(line) {
  return line.a.y <= line.b.y ? line : { a: line.b, b: line.a };
}

/** A line ordered so that `a` is its medial end. */
export function medLat(line, ctx) {
  const s = ctx.lateralSign || 1;
  return (line.b.x - line.a.x) * s >= 0 ? line : { a: line.b, b: line.a };
}

/** Unit normal of a (roughly cranio-caudal) line, pointing lateral. */
export function lateralNormal(line, ctx) {
  let n = perp(unit(sub(line.b, line.a)));
  if (dot(n, lateral(ctx)) < 0) n = mul(n, -1);
  return n;
}

/**
 * Tilt of a glenoid-side face (bony glenoid line or implant back face) relative to the perpendicular to the
 * floor of the supraspinatus fossa. 0° = face perpendicular to the fossa floor; + = the face looks upward
 * (superior tilt); − = inferior tilt. This is the convention of Boileau's "RSA angle". Papers read the β-angle
 * from different sides of the line, so the app reports this signed tilt instead of β itself.
 */
export function tiltVsFossa(faceLine, fossaLine, ctx) {
  const n = lateralNormal(faceLine, ctx);
  const f = medLat(fossaLine, ctx);
  const d = unit(sub(f.b, f.a));
  return -(ctx.lateralSign || 1) * Math.atan2(cross(d, n), dot(d, n)) * DEG;
}

/** Humeral shaft axis from two canal-width lines: through their midpoints, pointing distal. */
export function shaftAxis(canalProx, canalDist) {
  let a = mid(canalProx.a, canalProx.b), b = mid(canalDist.a, canalDist.b);
  if (a.y > b.y) [a, b] = [b, a];
  return { a, b, dir: unit(sub(b, a)) };
}

/** A line ordered proximal → distal (proximal = superior on an upright film). */
export function proxDist(line) {
  return line.a.y <= line.b.y ? line : { a: line.b, b: line.a };
}

/** Varus (+) / valgus (−) angle of an axis relative to the shaft axis. Varus = the distal end points lateral. */
export function varusAngle(axisLine, shaft, ctx) {
  const t = proxDist(axisLine);
  const d = unit(sub(t.b, t.a));
  return -(ctx.lateralSign || 1) * Math.atan2(cross(shaft.dir, d), dot(shaft.dir, d)) * DEG;
}

export function anatomicCircle(ctx) {
  const { pcA, pcB, pcC } = ctx.L;
  if (!pcA || !pcB || !pcC) return null;
  return circleFrom3(pcA, pcB, pcC);
}

export { sub, add, mul, dot, cross, unit, perp, mid, dist, DEG, lineIntersection };

// ───────────────────────── text shared by several protocols ─────────────────────────
export const HELP = {
  sgt: 'Superior glenoid tubercle: the top corner of the bony glenoid (supraglenoid tubercle), where the glenoid face meets the superior neck.',
  igr: 'Inferior glenoid rim: the lowest point of the bony glenoid face (not the glenosphere, not an osteophyte or a notch defect).',
  acr: 'Most lateral point of the acromion on the AP view.',
  acu: 'Undersurface of the acromion: the dense inferior cortex of the acromion, at the point directly above the humerus.',
  gtl: 'Most lateral point of the greater tuberosity.',
  gts: 'Most superior point of the greater tuberosity.',
  ssf: 'Floor of the supraspinatus fossa: the sclerotic line running medially from the glenoid. Put one end near the glenoid and one as far medial as the line is clearly seen.',
  canalM: 'Humeral canal width at the metaphysis: inner (endosteal) cortex to inner cortex, perpendicular to the stem, at the level of the metaphyseal part of the stem.',
  canalD: 'Humeral canal width near the stem tip: inner cortex to inner cortex, perpendicular to the stem, about 1 cm above the tip.',
  stemM: 'Stem width at the metaphysis: metal edge to metal edge at the same level as the canal line.',
  stemD: 'Stem width near the tip: metal edge to metal edge at the same level as the distal canal line.',
};

export const STEM_FINDINGS = [
  {
    id: 'humLucency', label: 'Humeral radiolucent lines', group: 'Humeral component', refs: ['sperling2000', 'sanchezsotelo2001'],
    help: 'Lucent lines at the stem–bone or cement–bone interface, by zone.',
    options: [
      { v: 'none', label: 'None', status: 'good', say: 'No radiolucent lines around the stem.' },
      { v: 'few', label: 'Lines < 2 mm, or in fewer than 3 zones', status: 'borderline', say: 'Incomplete radiolucent lines around the stem — not a criterion for loosening, but a baseline to compare on the next film.' },
      { v: 'atrisk', label: 'Lines ≥ 2 mm in 3 or more zones', status: 'out', say: 'Radiolucent lines of 2 mm or more in at least three zones meet the published definition of a humeral component "at risk" of loosening.' },
      { v: 'loose', label: 'Subsidence or change of position', status: 'out', say: 'Subsidence or tilt of the stem compared with earlier films is the radiographic definition of a loose humeral component.' },
    ],
  },
  {
    id: 'stressShield', label: 'Stress shielding / tuberosity resorption', group: 'Humeral component', refs: ['schnetzke2016', 'raiss2019'],
    options: [
      { v: 'none', label: 'None', status: 'good', say: 'No proximal bone resorption.' },
      { v: 'mild', label: 'Cortical thinning or osteopenia', status: 'borderline', say: 'Proximal cortical thinning — low-grade adaptive change; usually without clinical consequence, worth following.' },
      { v: 'marked', label: 'Marked resorption (cortex or tuberosity lost)', status: 'out', say: 'Marked proximal bone loss or tuberosity resorption — high-grade stress shielding; relevant for cuff/deltoid function and for any future revision.' },
    ],
  },
];
