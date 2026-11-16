// Axillary lateral radiograph — humeral head centring and (with stated limits) glenoid version.
// One definition serves native shoulders and hemiarthroplasties; only the wording of the head differs.
import { shape } from '../core.js';
import { C, sub, add, mul, dot, cross, unit, perp, mid, DEG } from './xray-common.js';

/** Walch subluxation index on a 2D slice/projection: % of the head lying posterior to the glenoid's perpendicular bisector. */
export function subluxationIndex2D(head, ga, gp) {
  const post = unit(sub(gp, ga));
  const p = dot(sub(C(head), mid(ga, gp)), post);
  return (head.r + p) / (2 * head.r) * 100;
}

/** Friedman-type version on a 2D image: + anteversion, − retroversion. axis = line from medial scapula to the glenoid. */
export function version2D(ga, gp, axisMedial, axisLateral) {
  const d = unit(sub(axisLateral, axisMedial));
  let n = perp(unit(sub(gp, ga)));
  if (dot(n, d) < 0) n = mul(n, -1);
  let ant = perp(d);
  if (dot(ant, sub(ga, gp)) < 0) ant = mul(ant, -1);
  return Math.atan2(dot(n, ant), dot(n, d)) * DEG;
}

export const SUBLUX_BANDS = [
  { upTo: 35, status: 'out', tag: 'Anterior', say: 'The head lies clearly anterior to the glenoid centre (Walch type D territory when under 40%).' },
  { upTo: 45, status: 'borderline', tag: 'Slightly anterior', say: 'The head lies slightly anterior to the glenoid centre.' },
  { upTo: 55.0001, status: 'good', tag: 'Centred', say: 'The head is centred on the glenoid (45–55%).' },
  { upTo: 70, status: 'borderline', tag: 'Posterior subluxation', say: 'Static posterior subluxation (over 55%).' },
  { upTo: 80, status: 'out', tag: 'Marked posterior subluxation', say: 'Marked posterior subluxation (70% or more — one of the criteria for a Walch B3 glenoid). Posterior decentring is the main driver of glenoid component loosening and instability after anatomic replacement.' },
  { status: 'out', tag: 'Severe posterior subluxation', say: 'Severe posterior subluxation (over 80%) — the level at which the largest biconcave-glenoid series is quoted as finding most of its dislocations after anatomic replacement.' },
];

function make({ id, implant, title, short, headLabel }) {
  return {
    id, title, short, modality: 'xray', implant, view: 'axillary',
    calibration: null,
    landmarks: [
      { id: 'head', kind: 'circle', label: headLabel, group: 'Humerus', help: 'Circle fitted to the articular surface of the head on the axillary view.', auto: true },
      { id: 'ga', kind: 'point', label: 'Anterior glenoid rim', group: 'Scapula', help: 'Anterior edge of the glenoid face (the coracoid side).' },
      { id: 'gp', kind: 'point', label: 'Posterior glenoid rim', group: 'Scapula', help: 'Posterior edge of the glenoid face (the acromion / scapular spine side).' },
      { id: 'scapAx', kind: 'line', label: 'Scapular body axis', group: 'Scapula', optional: true, help: 'A line along the scapular body towards the glenoid: one end as far medial on the scapular blade as it can be seen, the other at the centre of the glenoid. Needed only for version.' },
    ],
    metrics: [
      {
        id: 'sublux', label: 'Humeral head subluxation index', unit: '%', group: 'Centring',
        needs: ['head', 'ga', 'gp'],
        compute: ({ L }) => subluxationIndex2D(L.head, L.ga, L.gp),
        target: '45–55%', gauge: { min: 20, max: 100 }, evidence: 'published', refs: ['walch1999', 'bercik2016', 'walch2012'],
        what: 'Share of the humeral head lying posterior to the perpendicular bisector of the glenoid line (Walch). 50% = centred.',
        caveat: 'On an axillary radiograph the value shifts with arm position and beam angle; CT is the reference. The 55% limit is a convention and the ">80%" figure is quoted second-hand.',
        bands: SUBLUX_BANDS,
        draw: ({ L }) => {
          const m = mid(L.ga, L.gp), n = perp(unit(sub(L.gp, L.ga)));
          const k = L.head.r * 2.2;
          return [shape.line(L.ga, L.gp), shape.line(add(m, mul(n, -k)), add(m, mul(n, k)), { dash: true })];
        },
      },
      {
        id: 'version', label: 'Glenoid version (radiographic)', unit: '°', group: 'Glenoid',
        needs: ['ga', 'gp', 'scapAx'],
        compute: ({ L }) => {
          const m = mid(L.ga, L.gp);
          const [med, lat] = Math.hypot(L.scapAx.a.x - m.x, L.scapAx.a.y - m.y) > Math.hypot(L.scapAx.b.x - m.x, L.scapAx.b.y - m.y) ? [L.scapAx.a, L.scapAx.b] : [L.scapAx.b, L.scapAx.a];
          return version2D(L.ga, L.gp, med, lat);
        },
        format: (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'anteversion' : 'retroversion'}`,
        gauge: { min: -40, max: 15 }, evidence: 'published', refs: ['friedman1992', 'nyffeler2003', 'bercik2016'],
        what: 'Angle between the glenoid line and the perpendicular to the scapular axis, as in the Friedman method but on the axillary film.',
        caveat: 'Unreliable by design: against CT, axillary radiographs overestimated retroversion in 86% of shoulders, by 6.5° on average and up to 21°. Use it to decide whether a CT is needed, not to plan from.',
        bands: [
          { upTo: -25, status: 'out', tag: 'Severe retroversion', say: 'Severe retroversion on the radiograph. Even allowing for the usual overestimate this needs CT: beyond about 25° an anatomic glenoid cannot be seated without augmentation or grafting.' },
          { upTo: -15, status: 'borderline', tag: 'Retroverted', say: 'Retroversion of 15° or more on the radiograph — the level at which correction or augmentation is usually considered. Confirm on CT.' },
          { upTo: 5, status: 'good', tag: 'Near neutral', say: 'Close to neutral version (controls average about 2° of anteversion).' },
          { status: 'borderline', tag: 'Anteverted', say: 'Anteversion — unusual; with anterior subluxation it defines a Walch type D glenoid.' },
        ],
        draw: ({ L }) => [shape.ray(L.scapAx.a, L.scapAx.b, { dash: true }), shape.line(L.ga, L.gp)],
      },
    ],
    findings: [],
    caveats() {
      return ['An axillary radiograph is a screening view for centring and version. Plan glenoid work from CT.'];
    },
  };
}

export const nativeAx = make({ id: 'native-ax', implant: 'native', title: 'Native shoulder — axillary radiograph', short: 'Native · axillary', headLabel: 'Humeral head outline' });
export const pycAx = make({ id: 'pyc-ax', implant: 'pyc', title: 'Pyrocarbon hemiarthroplasty — axillary radiograph', short: 'Hemi · axillary', headLabel: 'Prosthetic head outline' });

export { cross };
