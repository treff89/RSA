// Arm-position normalisation for AP radiographs.
//
// The arm hangs in a different amount of abduction on every film, and that alone moves the lateralisation and
// distalisation angles, the acromion–tuberosity distance and every other measurement that mixes humeral and
// scapular landmarks. Here the humerus — bone and implant together — is rotated rigidly, in the plane of the film,
// about the glenohumeral centre of rotation (the glenosphere centre of a reverse; the head centre of a hemi or a
// native shoulder) until it reaches a standard position. Scapular landmarks stay where they are. Measurements are
// then taken on the rotated landmarks; the landmarks you see and drag are never moved.
//
// Targets:
//   'vertical' — the humeral shaft parallel to the image vertical (HARA 0°).
//   'scapula'  — the shaft at a fixed angle to the supraspinatus fossa line (SHARA 104°): the mean scapular
//                orientation of standing films with the arm vertical (Shao 2025: SHARA 116 ± 10°, HARA 12 ± 8°),
//                which also removes scapular rotation on the film.
// What it cannot correct: rotation of the humerus about its own axis, flexion/extension out of the film plane,
// scapular tilt, and the acromiohumeral distance of a native or hemi shoulder (the head turns about its own centre,
// so its distance to the acromion does not change).
import { C, hara, shara, humeralLine } from './protocols/xray-common.js';

export const SHARA_NEUTRAL = 104;
export const TARGETS = {
  vertical: { label: 'Arm vertical (HARA 0°)', short: 'arm vertical' },
  scapula: { label: `Relative to the scapula (SHARA ${SHARA_NEUTRAL}°)`, short: `SHARA ${SHARA_NEUTRAL}°` },
};

/** Landmarks that move with the humerus. */
export const HUMERAL = new Set(['stem', 'gts', 'gtl', 'canalM', 'canalD', 'stemM', 'stemD', 'dtu', 'hcl', 'shaftD', 'pcA', 'pcB', 'pcC', 'osteo', 'dtO', 'dtI', 'head']);

/** Centre of rotation of an AP protocol's landmark set, or null. */
export function rotationCentre(protocol, L) {
  if (protocol.implant === 'reverse') return L.gs ? C(L.gs) : null;
  return L.head ? C(L.head) : null;
}

const rot = (c, cos, sin) => (p) => ({ x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos });

/** Rotate the humeral landmarks of L by deg (image coordinates, y down: + is clockwise on screen) about c. */
export function rotateHumerus(L, c, deg) {
  const a = deg * Math.PI / 180, R = rot(c, Math.cos(a), Math.sin(a));
  const out = { ...L };
  for (const [id, v] of Object.entries(L)) {
    if (!HUMERAL.has(id) || !v) continue;
    if (v.cx !== undefined) { const q = R({ x: v.cx, y: v.cy }); out[id] = { ...v, cx: q.x, cy: q.y }; } else if (v.a) out[id] = { ...v, a: R(v.a), b: R(v.b) };
    else out[id] = { ...v, ...R(v) };
  }
  return out;
}

/**
 * Normalise a radiograph context. Returns { ok: true, L, deg, centre, before, target, from } or { ok: false, reason }.
 * `deg` is the rotation applied; `before` the HARA (or SHARA) of the film as taken.
 */
export function neutralise(protocol, ctx, target = 'vertical') {
  if (protocol.modality !== 'xray' || protocol.view !== 'ap') return { ok: false, reason: 'Only AP radiographs can be normalised.' };
  const c = rotationCentre(protocol, ctx.L);
  if (!c) return { ok: false, reason: protocol.implant === 'reverse' ? 'Needs the glenosphere outline (the centre of rotation).' : 'Needs the humeral head outline (the centre of rotation).' };
  const h = humeralLine(ctx);
  if (!h) return { ok: false, reason: protocol.implant === 'native' ? 'Needs the humeral shaft centre line (Landmarks → Humeral shaft centre line).' : 'Needs the stem axis or the canal lines.' };
  let before, want;
  if (target === 'scapula') {
    if (!ctx.L.ssf) return { ok: false, reason: 'The scapula-referenced position needs the supraspinatus fossa line.' };
    before = shara(ctx); want = SHARA_NEUTRAL;
  } else { before = hara(ctx); want = 0; }
  if (!Number.isFinite(before)) return { ok: false, reason: 'The arm position could not be measured.' };
  // abduction (distal humerus towards the lateral side) is removed by turning the distal end medially
  // (image axes, y down: a positive angle turns the distal end from +x towards −x)
  const deg = (before - want) * (ctx.lateralSign || 1);
  return { ok: true, L: rotateHumerus(ctx.L, c, deg), deg, centre: c, before, want, target, from: h.from };
}

/** One-line description for the appraisal and report. */
export function neutralNote(n, protocol) {
  const what = n.target === 'scapula' ? `SHARA ${n.before.toFixed(0)}° → ${SHARA_NEUTRAL}°` : `HARA ${n.before.toFixed(0)}° → 0°`;
  const ahd = protocol.implant === 'reverse' ? '' : ' The acromiohumeral distance is unchanged by construction (the head turns about its own centre).';
  return `Arm position normalised: the humerus (with its implant) was rotated ${Math.abs(n.deg).toFixed(1)}° about the centre of rotation (${what}) before measuring; the landmarks shown are as placed on the film. This is a rigid in-plane rotation: it does not correct humeral rotation, flexion, or scapular tilt out of the film plane.${ahd}`;
}
