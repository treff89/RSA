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
import { shape } from '../core.js';

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

/**
 * Humeral shaft direction (unit, pointing distal) from the best landmarks available: the two canal-width lines,
 * else a drawn humeral centre line ('hcl'), else the stem axis. Returns { dir, a, b, from } or null.
 */
export function humeralLine(ctx) {
  const { canalM, canalD, hcl, stem } = ctx.L;
  if (canalM && canalD) { const s = shaftAxis(canalM, canalD); return { dir: s.dir, a: s.a, b: s.b, from: 'canal' }; }
  const l = hcl || stem;
  if (!l) return null;
  const t = proxDist(l);
  return { dir: unit(sub(t.b, t.a)), a: t.a, b: t.b, from: hcl ? 'hcl' : 'stem' };
}

/** Humeral abduction resting angle: shaft vs the image vertical; + = abducted (distal humerus lateral). */
export function hara(ctx) {
  const h = humeralLine(ctx);
  if (!h) return NaN;
  return Math.atan2(dot(h.dir, lateral(ctx)), h.dir.y) * DEG;
}

/** Scapulohumeral abduction resting angle: angle between the distal shaft direction and the fossa line pointing medial. */
export function shara(ctx) {
  const h = humeralLine(ctx);
  if (!h || !ctx.L.ssf) return NaN;
  const f = medLat(ctx.L.ssf, ctx);
  const med = unit(sub(f.a, f.b));
  return Math.acos(Math.max(-1, Math.min(1, dot(h.dir, med)))) * DEG;
}

const G_POSTURE = 'Arm position';
/** HARA and SHARA as protocol metrics (shared by the AP protocols). */
export function postureMetrics(needs) {
  const hcl = needs || ['stem'];
  return [
    {
      id: 'hara', label: 'Humeral abduction resting angle (HARA)', unit: '°', group: G_POSTURE,
      needs: [], softNeeds: hcl,
      compute: (ctx) => hara(ctx.raw || ctx),
      format: (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'abduction' : 'adduction'}`,
      gauge: { min: -10, max: 45 }, evidence: 'descriptive', refs: ['shao2025', 'mitrousias2026', 'shekhbihi2026'],
      what: 'Angle between the humeral shaft centre line and the vertical of the image (the plumb line on a standing film). It records how far the arm hung away from the body when the film was taken — always as taken, even when the other measurements are normalised to a standard arm position.',
      caveat: 'Assumes the image is upright as taken: a rotated or cropped picture, or a supine film, invalidates it. The shaft line comes from the canal lines if placed, else from the stem (or a drawn centre line).',
      bands: [
        { upTo: 20, status: 'info', tag: 'Arm at the side', say: (v) => `The arm rests in ${Math.abs(v).toFixed(0)}° of ${v >= 0 ? 'abduction' : 'adduction'} (standing films: mean 7–12°, range 0–43°). Lateralisation and distalisation angles are only comparable between films with a similar HARA: from 10° to 30° of HARA the DSA fell by about 9° and the LSA rose by about 5° in a 3D model.` },
        { status: 'info', tag: 'Abducted', say: (v) => `The arm rests in ${v.toFixed(0)}° of abduction — more than on most standing films. This lowers the DSA and raises the LSA (about −4.5° and +2.5° per 10° of HARA in a 3D model), so read those angles with that in mind.` },
      ],
      draw: (ctx) => {
        const h = humeralLine(ctx.raw || ctx);
        if (!h) return [];
        const len = Math.hypot(h.b.x - h.a.x, h.b.y - h.a.y);
        return [shape.line(h.a, h.b), shape.line(h.a, { x: h.a.x, y: h.a.y + len }, { dash: true }), shape.arc(h.a, { x: h.a.x, y: h.a.y + len }, h.b)];
      },
    },
    {
      id: 'shara', label: 'Scapulohumeral abduction angle (SHARA)', unit: '°', group: G_POSTURE,
      needs: ['ssf'], softNeeds: hcl,
      compute: (ctx) => shara(ctx.raw || ctx),
      format: (v) => `${v.toFixed(1)}° (RSA-HARA ${(v - 90).toFixed(1)}°)`,
      gauge: { min: 80, max: 150 }, evidence: 'descriptive', refs: ['shao2025', 'mitrousias2026', 'shekhbihi2026'],
      what: 'Angle between the humeral shaft and the supraspinatus fossa line (pointing medially): the arm\'s abduction relative to the scapula, so independent of how the patient stood. RSA-HARA = SHARA − 90°.',
      caveat: 'Descriptive: standing pre-operative films averaged 116 ± 10° (range 90–144°). In a planning study a larger RSA-HARA increased simulated impingement-free motion, so it matters most for planning and for comparing films.',
      bands: [{ status: 'info', tag: '', say: (v) => `The humerus lies ${v.toFixed(0)}° from the fossa line (${(v - 90).toFixed(0)}° from its perpendicular). Compare it between films: a change of more than about 10° means the films were taken with the arm in different positions relative to the scapula.` }],
      draw: (ctx) => {
        const h = humeralLine(ctx.raw || ctx);
        if (!h) return [];
        return [shape.ray(ctx.L.ssf.a, ctx.L.ssf.b, { dash: true }), shape.line(h.a, h.b)];
      },
    },
  ];
}

/**
 * Rough supraspinatus-fossa line from the glenoid rim points, for films where it cannot be learned: medial from
 * the glenoid line about half-way up, rising ~15° medially (median of annotated native films; reverse films ~0°).
 * Returned as an estimate only — it must be checked.
 */
export function ssfFromGlenoid(sgt, igr, lateralSign, riseDeg = 15) {
  const H = dist(sgt, igr);
  if (!(H > 0)) return null;
  const up = unit(sub(sgt, igr));
  let lat = perp(up);
  if (lat.x * (lateralSign || 1) < 0) lat = mul(lat, -1);
  const m = mid(sgt, igr);
  const a = add(m, mul(up, 0.35 * H));
  const r = riseDeg / DEG;
  const medDir = add(mul(lat, -Math.cos(r)), mul(up, Math.sin(r)));
  return { a, b: add(a, mul(medDir, 2.1 * H)) };
}

// ───────────────────────── text shared by several protocols ─────────────────────────
export const HELP = {
  sgt: 'Superior glenoid tubercle: the top corner of the bony glenoid (supraglenoid tubercle), where the glenoid face meets the superior neck.',
  igr: 'Inferior glenoid rim: the lowest point of the bony glenoid face (not the glenosphere, not an osteophyte or a notch defect).',
  acr: 'Most lateral point of the acromion on the AP view.',
  acu: 'Undersurface of the acromion: the dense inferior cortex of the acromion, at the point directly above the humerus.',
  gtl: 'Most lateral point of the greater tuberosity.',
  gts: 'Most superior point of the greater tuberosity.',
  ssf: 'Floor of the supraspinatus fossa: the sclerotic line running medially from the glenoid. Put one end near the glenoid and one as far medial as the line is clearly seen.',
  dtu: 'Midpoint of the deltoid tuberosity: the middle of the roughened lateral bulge on the humeral shaft where the deltoid inserts, about a third of the way down the shaft. Often off the bottom of a shoulder film; leave it out then.',
  hcl: 'Humeral shaft centre line: a line down the middle of the humeral diaphysis, from just below the surgical neck to as far down the shaft as the film shows.',
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
