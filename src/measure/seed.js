// Detection result → landmark set for a radiograph protocol. Pure (no DOM), shared by the app and the evaluation
// harness so that both measure exactly the same thing.
import { ssfFromGlenoid } from './protocols/xray-common.js';

const P2 = (a) => ({ x: a[0], y: a[1] });
const line = (l) => (l && l.a && l.b ? { a: P2(l.a), b: P2(l.b) } : null);
export const MIN_ESTIMATE = 0.2;   // every landmark the detector proposes is placed; weak ones are marked "estimated"

/** @returns {{ values: Object, state: Object }} */
export function seedXray(protocol, det) {
  const set = { values: {}, state: {} };
  const p = protocol, d = det || {};
  const put = (id, value, st) => { if (p.landmarks.some((l) => l.id === id) && value) { set.values[id] = value; set.state[id] = st; } };
  if (p.id === 'rsa-ap' && d.reverse) {
    // A weak dome fit is offered as an estimate to be checked, never as a detection.
    const g = d.reverse.glenosphere, st = g.score >= 0.6 ? 'auto' : 'estimated';
    put('gs', { cx: g.cx, cy: g.cy, r: g.r }, st);
    put('face', line(g.face), st);
    put('stem', line(d.reverse.stem), st);
  }
  if (p.id !== 'rsa-ap' && d.head && p.view === 'ap') {
    const implantHead = d.head.kind === 'implant';
    if ((p.implant === 'pyc') === implantHead) put('head', { cx: d.head.cx, cy: d.head.cy, r: d.head.r }, d.head.score >= 0.6 ? 'auto' : 'estimated');
    if (p.implant === 'pyc' && d.stem) put('stem', line(d.stem), 'auto');
  }
  const est = (d.estimates && d.estimates[p.id]) || {};
  for (const [id, e] of Object.entries(est)) {
    if (set.values[id] || !(e.confidence >= MIN_ESTIMATE)) continue;
    const measured = (id === 'stemM' || id === 'stemD') && e.confidence >= 0.8;
    put(id, e.a ? line(e) : { x: e.x, y: e.y }, measured ? 'auto' : 'estimated');
  }
  ssfPrior(p, set, lateralSignOf(d, null));
  acromionLinePrior(p, set);
  return set;
}

/** Estimated acromial undersurface line (native films): through the undersurface point and on to the lateral tip. */
export function acromionLinePrior(p, set) {
  if (!p.landmarks.some((l) => l.id === 'acLine') || set.values.acLine) return;
  const { acu, acr } = set.values;
  if (!acu || !acr || Math.hypot(acr.x - acu.x, acr.y - acu.y) < 3) return;
  set.values.acLine = { a: { x: acu.x - 0.6 * (acr.x - acu.x), y: acu.y - 0.6 * (acr.y - acu.y) }, b: { x: acr.x, y: acr.y } };
  set.state.acLine = 'estimated';
}

/**
 * Where the fossa line could not be learned (hemi and native films), estimate it from the glenoid rim points.
 * Only fills a missing line, or replaces one that is itself such an estimate (set.prior.ssf).
 */
export function ssfPrior(p, set, lateralSign) {
  if (!p.landmarks.some((l) => l.id === 'ssf') || p.implant === 'reverse') return;
  const { sgt, igr, ssf } = set.values;
  if (!sgt || !igr) return;
  if (ssf && !(set.prior && set.prior.ssf && set.state.ssf === 'estimated')) return;
  const l = ssfFromGlenoid(sgt, igr, lateralSign, 15);
  if (!l) return;
  set.values.ssf = l; set.state.ssf = 'estimated';
  set.prior = { ...(set.prior || {}), ssf: true };
}

/** Which side of the image the humerus is on (+1 right of the glenoid, −1 left), from detection or laterality. */
export function lateralSignOf(det, laterality) {
  if (det && det.side === 'right-of-glenoid') return 1;
  if (det && det.side === 'left-of-glenoid') return -1;
  return laterality === 'L' ? 1 : -1;
}
