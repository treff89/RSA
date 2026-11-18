// Native shoulder — scapular Y radiograph: posterior acromial morphology (Meyer, Gerber et al.).
// A high, flat acromion with little posterior cover gives the humeral head less bony restraint posteriorly; it is
// associated with posterior instability and with static posterior subluxation / eccentric (B2, C) glenoid wear.
import { shape } from '../core.js';
import { sub, add, mul, dot, unit, dist, DEG } from './xray-common.js';

const G = 'Posterior acromial morphology';

/** Reference line: inferior angle of the scapula → centre of the Y, pointing superior. */
function ref(L) { return unit(sub(L.yc, L.ia)); }
const angleTo = (u, v) => Math.acos(Math.max(-1, Math.min(1, dot(u, unit(v))))) * DEG;

/** Posterior acromial height (px): from the centre of the Y, along the reference line, to the foot of the perpendicular from the posterior acromion. */
export function pah(L) { return dot(sub(L.pa, L.yc), ref(L)); }
/** Posterior acromial tilt (°): reference line vs the line from the posterior to the anterior point of the acromial undersurface. */
export function pat(L) { return angleTo(ref(L), sub(L.aa, L.pa)); }
/** Posterior acromial coverage (°): reference line vs the line from the centre of the Y to the posterior acromion. */
export function pac(L) { return angleTo(ref(L), sub(L.pa, L.yc)); }

export const nativeY = {
  id: 'native-y',
  title: 'Native shoulder — scapular Y radiograph',
  short: 'Native · Y-view',
  modality: 'xray',
  implant: 'native',
  view: 'y',
  calibration: null,
  landmarks: [
    { id: 'yc', kind: 'point', label: 'Centre of the Y', group: 'Scapula', help: 'Centre of the intersection of the small arms of the scapular "Y" — where the scapular spine/acromion arm, the coracoid arm and the scapular body meet (the glenoid seen end-on).' },
    { id: 'ia', kind: 'point', label: 'Inferior angle of the scapula', group: 'Scapula', help: 'The lowest point of the scapular body (the tail of the Y). Together with the centre of the Y it defines the reference line.' },
    { id: 'pa', kind: 'point', label: 'Acromion — posterior undersurface point', group: 'Acromion', help: 'The most posterior point of the inferior aspect of the acromion (the back end of its undersurface, on the scapular-spine side).' },
    { id: 'aa', kind: 'point', label: 'Acromion — anterior undersurface point', group: 'Acromion', help: 'The most anterior point of the inferior aspect of the acromion (its front tip, on the coracoid side).' },
  ],
  metrics: [
    {
      id: 'pah', label: 'Posterior acromial height (PAH)', unit: 'mm', group: G, scale: true,
      needs: ['yc', 'ia', 'pa'],
      compute: (ctx) => pah(ctx.L) * ctx.mm,
      target: '< 23 mm', gauge: { min: 0, max: 45 }, evidence: 'published', refs: ['meyer2019', 'beeler2021', 'arner2023', 'acromReview2025'],
      what: 'How high the back of the acromion sits above the glenoid: the distance from the centre of the Y, along the reference line (inferior scapular angle → centre of the Y), to the foot of the perpendicular dropped from the most posterior point of the acromial undersurface.',
      caveat: 'Needs a true Y-view; scapular rotation changes it. Carries the film magnification unless calibrated. The 23 mm cut-off separated posterior instability from controls and anterior instability in one case-control series; CT and MRI studies confirm the direction but give lower absolute values with their own methods.',
      bands: [
        { upTo: 23, status: 'good', tag: 'Normal', say: 'Under 23 mm, like the control and anterior-instability shoulders of the original series (means about 20 mm).' },
        { status: 'out', tag: 'High posterior acromion', say: 'Above 23 mm: in the original series a posterior acromial height above this level carried an odds ratio of 39 for posterior instability (posterior instability averaged 31 mm). A high acromion gives the head less posterior bony restraint — relevant for posterior instability, static posterior subluxation and posterior glenoid wear.' },
      ],
      draw: ({ L }) => {
        const r = ref(L);
        const foot = add(L.yc, mul(r, pah(L)));
        return [shape.ray(L.ia, L.yc, { dash: true }), shape.dim(L.yc, foot), shape.line(L.pa, foot, { dash: true })];
      },
    },
    {
      id: 'pat', label: 'Posterior acromial tilt', unit: '°', group: G,
      needs: ['yc', 'ia', 'pa', 'aa'],
      compute: (ctx) => pat(ctx.L),
      target: '< 60°', gauge: { min: 35, max: 90 }, evidence: 'pragmatic', refs: ['meyer2019', 'meyer2019b', 'beeler2021', 'acromReview2025'],
      what: 'Angle between the reference line and the line from the posterior to the anterior point of the acromial undersurface. Small = a steep "Swiss chalet roof" acromion that covers the back of the head; large = a flat, horizontal roof.',
      caveat: 'Group means overlap widely: about 56° in controls against 64° in posterior instability, and 56° against 61° for concentric versus eccentric (B2/C) osteoarthritis. The 60° boundary is a pragmatic midpoint between them, not a cut-off.',
      bands: [
        { upTo: 60, status: 'good', tag: 'Steep', say: 'A steep acromial roof, as in control shoulders (about 56°). A steep roof virtually excluded recurrent posterior instability in the original series.' },
        { status: 'borderline', tag: 'Flat', say: 'A flat acromial roof, closer to the means of posterior instability (64°) and of eccentric posterior glenoid wear (61°) than to controls (56°).' },
      ],
      draw: ({ L }) => [shape.ray(L.ia, L.yc, { dash: true }), shape.ray(L.pa, L.aa)],
    },
    {
      id: 'pac', label: 'Posterior acromial coverage', unit: '°', group: G,
      needs: ['yc', 'ia', 'pa'],
      compute: (ctx) => pac(ctx.L),
      target: '≥ 55°', gauge: { min: 30, max: 85 }, evidence: 'pragmatic', refs: ['meyer2019', 'beeler2021', 'acromReview2025'],
      what: 'Angle at the centre of the Y between the reference line and the line to the most posterior point of the acromial undersurface: how far back the acromion reaches over the head.',
      caveat: 'Group means: controls about 62°, posterior instability about 49° (SD 8.5°). The 55° boundary is a pragmatic midpoint, and the group values are quoted from a review rather than the paper itself.',
      bands: [
        { upTo: 55, status: 'borderline', tag: 'Short posteriorly', say: 'Less posterior cover than control shoulders (about 62°), towards the mean of posterior instability (about 49°): the acromion stops short of the back of the head.' },
        { status: 'good', tag: 'Covering', say: 'Posterior acromial cover like that of control shoulders.' },
      ],
      draw: ({ L }) => [shape.ray(L.ia, L.yc, { dash: true }), shape.line(L.yc, L.pa), shape.arc(L.yc, add(L.yc, mul(ref(L), dist(L.yc, L.pa))), L.pa)],
    },
  ],
  findings: [],
  synthesis(m) {
    const bits = [];
    if (m.pah.status === 'out') bits.push(`a high posterior acromion (${m.pah.text})`);
    if (m.pat.status === 'borderline') bits.push(`a flat roof (tilt ${m.pat.text})`);
    if (m.pac.status === 'borderline') bits.push(`little posterior cover (${m.pac.text})`);
    const measured = ['pah', 'pat', 'pac'].filter((k) => m[k].status !== 'pending').length;
    if (!measured) return [];
    if (!bits.length) return [{ title: 'Posterior acromial morphology', status: 'good', text: `None of the ${measured} measured features of a posteriorly uncovering acromion is present.` }];
    return [{
      title: 'Posterior acromial morphology',
      status: m.pah.status === 'out' || bits.length >= 2 ? 'out' : 'borderline',
      text: `This acromion shows ${bits.join(', ')} — the pattern Gerber's group linked with posterior instability, static posterior subluxation and eccentric posterior glenoid wear. It is an association with wide overlap between groups, not a diagnosis; read it with the glenoid version (CT), the subluxation index and the history.`,
    }];
  },
  caveats() {
    return [
      'Needs a true scapular Y-view: the scapular body seen edge-on with the glenoid at the centre of the Y. Scapular rotation shifts tilt and coverage by several degrees.',
      'Meyer et al. also combined glenoid version (from CT) with the acromial slope: version minus slope below about −27° predicted a B2 or C glenoid. Measure version on CT to apply it.',
    ];
  },
};
