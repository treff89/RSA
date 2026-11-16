// CT protocols. Every measurement is computed in 3D from landmarks in patient millimetres, in a scapular coordinate
// frame built from the landmarks themselves — so the result does not depend on how the patient lay in the scanner
// or on which slice was picked (the weakness of 2D Friedman measurements).
//
// ctx = { L: { id: value }, state, mm: 1 }
//   point  [x,y,z]            sphere  { c:[x,y,z], r }            line  { a:[x,y,z], b:[x,y,z] }
import { v3, scapularFrame, versionInclination } from '../geom.js';
import { SUBLUX_BANDS } from './axillary.js';

const HELP3 = {
  tri: 'Trigonum spinae: where the scapular spine meets the medial border of the scapula. If the scan stops short of it, use the most medial point of the scapular body at the level of the spine (and expect a few degrees of error in version).',
  ia: 'Inferior angle of the scapula. Often outside a shoulder scan — leave it out if so; inclination then uses the scanner\'s vertical axis instead of the scapular plane.',
};

const fmtVersion = (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'anteversion' : 'retroversion'}`;
const fmtTilt = (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'superior' : 'inferior'} tilt`;

// ───────────────────────────── reverse ─────────────────────────────
/** Glenosphere axis (unit, pointing lateral out of the dome): from the central post / screw tip to the sphere centre. */
export function glenosphereAxis(L) {
  return v3.unit(v3.sub(L.gs.c, L.post));
}
function rsaFrame(L) {
  return scapularFrame(L.tri, L.gs.c, L.ia || null);
}
/** Inferior direction lying in the glenosphere's back-face plane. */
function faceInferior3(L) {
  const axis = glenosphereAxis(L);
  const f = L.tri ? rsaFrame(L) : null;
  const sup = f ? f.sup : [0, 0, 1];
  return v3.mul(v3.unit(v3.reject(sup, axis)), -1);
}

const VERSION_NOTE = 'Version is given in the scapular frame (Friedman axis: trigonum → glenosphere centre). A truncated scapula, or a trigonum placed a centimetre off, changes it by several degrees.';

export const rsaCt = {
  id: 'rsa-ct',
  title: 'Reverse shoulder arthroplasty — CT',
  short: 'Reverse · CT',
  modality: 'ct',
  implant: 'reverse',
  view: 'ct',
  landmarks: [
    { id: 'gs', kind: 'sphere', label: 'Glenosphere', group: 'Implant', auto: true, help: 'Sphere fitted to the glenosphere dome. To set it by hand: click the centre, then a point on the dome surface.' },
    { id: 'post', kind: 'point', label: 'Central post / screw tip', group: 'Implant', auto: true, help: 'A point on the central axis of the baseplate, medial to the glenosphere: the tip of the central post or central screw. The line from here to the glenosphere centre is the glenoid component axis.' },
    { id: 'stem', kind: 'line', label: 'Humeral stem axis', group: 'Implant', auto: true, optional: true, help: 'Centre line of the humeral stem: proximal end, then distal tip.' },
    { id: 'tri', kind: 'point', label: 'Trigonum spinae', group: 'Scapula', help: HELP3.tri },
    { id: 'ia', kind: 'point', label: 'Inferior angle', group: 'Scapula', optional: true, help: HELP3.ia },
    { id: 'igr', kind: 'point', label: 'Inferior glenoid rim (bone)', group: 'Scapula', optional: true, help: 'Lowest point of the bony glenoid, on the coronal view under the glenosphere.' },
    { id: 'sgr', kind: 'point', label: 'Superior glenoid rim (bone)', group: 'Scapula', optional: true, help: 'Highest point of the bony glenoid face (supraglenoid tubercle).' },
  ],
  metrics: [
    {
      id: 'version', label: 'Glenosphere version', unit: '°', group: 'Glenoid component',
      needs: ['gs', 'post', 'tri'],
      compute: ({ L }) => { const f = rsaFrame(L); return f ? versionInclination(f, glenosphereAxis(L)).version : NaN; },
      format: fmtVersion, target: 'within 10° of neutral', gauge: { min: -35, max: 25 }, evidence: 'pragmatic', refs: ['friedman1992', 'budge2011'],
      what: 'Angle between the glenoid component axis and the scapular (Friedman) axis in the transverse plane of the scapula.',
      caveat: `${VERSION_NOTE} There is no outcome-derived target for reverse baseplate version; ±10° is the usual planning window.`,
      bands: [
        { upTo: -20, status: 'out', tag: 'Marked retroversion', say: 'More than 20° of retroversion. This limits impingement-free internal rotation and puts the posterior screws and the central post at risk of leaving the vault; check baseplate seating on the axial images.' },
        { upTo: -10, status: 'borderline', tag: 'Retroverted', say: 'Between 10° and 20° of retroversion — outside the usual planning window, commonly accepted when it avoids over-reaming a retroverted glenoid.' },
        { upTo: 10.0001, status: 'good', tag: 'Near neutral', say: 'Within 10° of neutral version.' },
        { status: 'borderline', tag: 'Anteverted', say: 'More than 10° of anteversion — outside the usual planning window; it reduces impingement-free external rotation.' },
      ],
    },
    {
      id: 'tilt', label: 'Glenosphere inclination', unit: '°', group: 'Glenoid component',
      needs: ['gs', 'post', 'tri'],
      compute: ({ L }) => { const f = rsaFrame(L); return f ? versionInclination(f, glenosphereAxis(L)).inclination : NaN; },
      format: fmtTilt, target: 'neutral to 10° inferior', gauge: { min: -30, max: 30 }, evidence: 'pragmatic', refs: ['boileau2019', 'levigne2011', 'tashjian2018', 'bechtold2021'],
      what: 'Angle between the glenoid component axis and the scapular axis within the plane of the scapula. Positive = the glenosphere looks upward.',
      caveat: 'Measured against the Friedman axis, which is not the same reference as the supraspinatus fossa floor used on radiographs; the two differ by a few degrees. Without the inferior angle the scapular plane is unknown and the scanner\'s vertical is used.',
      bands: [
        { upTo: -15, status: 'borderline', tag: 'Marked inferior tilt', say: 'More than 15° of inferior tilt — usually the price of heavy inferior reaming; check inferior seating.' },
        { upTo: 5, status: 'good', tag: 'Neutral / inferior', say: 'Neutral to inferior tilt, the orientation generally aimed for.' },
        { upTo: 10, status: 'borderline', tag: 'Mild superior tilt', say: 'A few degrees of superior tilt — on the unfavourable side of neutral.' },
        { status: 'out', tag: 'Superior tilt', say: 'Superior tilt of 10° or more: more shear and less compression at the baseplate, and the position linked to notching and, in one series, to instability.' },
      ],
    },
    {
      id: 'gsDiam', label: 'Glenosphere diameter (measured)', unit: 'mm', group: 'Glenoid component',
      needs: ['gs'],
      compute: ({ L }) => 2 * L.gs.r,
      evidence: 'descriptive', gauge: { min: 30, max: 48 },
      what: 'Diameter of the sphere fitted to the dome. CT is true to size, so this should match the implanted glenosphere.',
      caveat: 'Metal blooming makes dense implants read up to about 1 mm large.',
      bands: [{ status: 'info', tag: '', say: 'Compare with the implanted size: a mismatch of more than about 1.5 mm means the sphere fit is off (check the circle on all three views) rather than the implant.' }],
    },
    {
      id: 'overhang', label: 'Inferior glenosphere overhang', unit: 'mm', group: 'Glenoid component',
      needs: ['gs', 'post', 'igr'],
      compute: ({ L }) => { const d = faceInferior3(L); return v3.dot(v3.sub(v3.add(L.gs.c, v3.mul(d, L.gs.r)), L.igr), d); },
      target: '≥ 3.5 mm', gauge: { min: -6, max: 12 }, evidence: 'published', refs: ['collotte2021', 'levigne2011', 'dewilde2010'],
      what: 'How far the glenosphere extends below the inferior bony glenoid rim, measured in the plane of the glenosphere back face.',
      caveat: 'Assumes a hemispherical (or larger) glenosphere whose equator is its widest point. The cut-off comes from 155° Grammont-style implants on radiographs.',
      bands: [
        { upTo: 0, status: 'out', tag: 'High-riding', say: 'The glenosphere sits above the inferior glenoid rim, leaving bone exposed to the liner.' },
        { upTo: 3.5, status: 'borderline', tag: 'Flush / small', say: 'Flush or under 3.5 mm of overhang.' },
        { status: 'good', tag: 'Adequate', say: 'At least 3.5 mm of inferior overhang, the amount associated with less scapular notching.' },
      ],
    },
    {
      id: 'corLat', label: 'Centre of rotation lateral to glenoid bone', unit: 'mm', group: 'Glenoid component',
      needs: ['gs', 'post', 'igr', 'sgr'],
      compute: ({ L }) => v3.dot(v3.sub(L.gs.c, v3.mid(L.sgr, L.igr)), glenosphereAxis(L)),
      evidence: 'descriptive', gauge: { min: -5, max: 15 }, refs: ['werthel2019'],
      what: 'Distance from the glenosphere centre to the midpoint of the bony glenoid rim, along the component axis; positive = lateral to bone.',
      caveat: 'Descriptive: it reflects the implant design (Grammont-style at the bone; lateralised glenospheres, augments and grafts further out).',
      bands: [
        { upTo: 3, status: 'info', tag: 'Medialised glenoid', say: 'The centre of rotation is at the glenoid bone, as in a Grammont-style construct.' },
        { status: 'info', tag: 'Lateralised glenoid', say: 'The centre of rotation is lateral to the glenoid bone (lateralised glenosphere, augment or graft).' },
      ],
    },
  ],
  findings: [
    {
      id: 'seating', label: 'Baseplate seating', group: 'Glenoid component', refs: [],
      help: 'Scroll the axial and coronal views along the back of the baseplate.',
      options: [
        { v: 'full', label: 'Fully seated on bone', status: 'good', say: 'The baseplate is fully seated on bone.' },
        { v: 'partial', label: 'Partial gap (< 50%)', status: 'borderline', say: 'Part of the baseplate is unsupported — acceptable when the central post and screws have purchase, but it concentrates load on the supported part.' },
        { v: 'poor', label: 'Largely unsupported or lucent', status: 'out', say: 'Most of the baseplate is unsupported or surrounded by lucency — fixation is at risk.' },
      ],
    },
    {
      id: 'screws', label: 'Post and screws', group: 'Glenoid component', refs: [],
      options: [
        { v: 'in', label: 'Contained in bone', status: 'good', say: 'The central post and screws are contained in bone.' },
        { v: 'perf', label: 'Perforating (post or screw tip outside the vault)', status: 'borderline', say: 'A screw or the post perforates the vault — note its relation to the suprascapular nerve at the spinoglenoid notch for posterior and superior screws.' },
        { v: 'broken', label: 'Broken or backed out', status: 'out', say: 'A screw is broken or has backed out — a sign of baseplate micromotion.' },
      ],
    },
    {
      id: 'notching', label: 'Scapular notching', group: 'Glenoid component', refs: ['sirveaux2004'],
      options: [
        { v: '0', label: 'None', status: 'good', say: 'No scapular notching.' },
        { v: '1', label: 'Grade 1 — pillar only', status: 'borderline', say: 'Grade 1 notching, confined to the pillar.' },
        { v: '2', label: 'Grade 2 — reaches the inferior screw', status: 'borderline', say: 'Grade 2 notching, reaching the inferior screw.' },
        { v: '3', label: 'Grade 3 — beyond the inferior screw', status: 'out', say: 'Grade 3 notching, extending beyond the inferior screw.' },
        { v: '4', label: 'Grade 4 — reaches the central post', status: 'out', say: 'Grade 4 notching, reaching the central post.' },
      ],
    },
    {
      id: 'acromion', label: 'Acromion / scapular spine fracture', group: 'Complications', refs: ['levy2013', 'crosby2011'],
      help: 'CT is the reference for these; radiographs miss many.',
      options: [
        { v: 'none', label: 'None', status: 'good', say: 'No acromial or scapular spine fracture on CT.' },
        { v: 'I', label: 'Levy type I', status: 'out', say: 'Acromial fracture, Levy type I (part of the anterior and middle deltoid origin).' },
        { v: 'II', label: 'Levy type II', status: 'out', say: 'Acromial fracture, Levy type II (entire middle and part of the posterior deltoid origin).' },
        { v: 'III', label: 'Levy type III', status: 'out', say: 'Scapular spine fracture, Levy type III (entire middle and posterior deltoid origin).' },
      ],
    },
  ],
  caveats(ctx) {
    const c = ['Metal artefact hides bone next to the implant and inflates the apparent size of dense parts. Read lucency and seating with a wide (metal) window.'];
    if (ctx.L.tri && !ctx.L.ia) c.push('The inferior angle was not marked, so "superior" is taken from the scanner axis rather than the scapular plane. If the patient lay tilted, inclination is off by that tilt.');
    c.push('Humeral component version is not measured: it needs the epicondylar axis, which a shoulder CT does not include.');
    return c;
  },
};

// ───────────────────────── native shoulder / hemiarthroplasty ─────────────────────────
/** Glenoid frame and face geometry from rim landmarks. */
export function glenoidGeometry(L) {
  const have = [L.ga, L.gp, L.gsup, L.ginf].filter(Boolean);
  if (!L.ga || !L.gp || !L.tri) return null;
  const centre = have.reduce((s, p) => v3.add(s, p), [0, 0, 0]).map((x) => x / have.length);
  const frame = scapularFrame(L.tri, centre, L.ia || null);
  if (!frame) return null;
  return { centre, frame };
}

/** Version of the glenoid face: the anterior–posterior rim line projected into the scapular transverse plane. */
export function glenoidVersion(L) {
  const g = glenoidGeometry(L);
  if (!g) return NaN;
  const w = v3.reject(v3.sub(L.gp, L.ga), g.frame.sup);
  let n = v3.unit(v3.cross(g.frame.sup, w));
  if (v3.dot(n, g.frame.lat) < 0) n = v3.mul(n, -1);
  return Math.atan2(v3.dot(n, g.frame.ant), v3.dot(n, g.frame.lat)) * 180 / Math.PI;
}

/** Inclination of the glenoid face: the superior–inferior rim line projected into the scapular plane. */
export function glenoidInclination(L) {
  const g = glenoidGeometry(L);
  if (!g || !L.gsup || !L.ginf) return NaN;
  const w = v3.reject(v3.sub(L.gsup, L.ginf), g.frame.ant);
  let n = v3.unit(v3.cross(g.frame.ant, w));
  if (v3.dot(n, g.frame.lat) < 0) n = v3.mul(n, -1);
  return Math.atan2(v3.dot(n, g.frame.sup), v3.dot(n, g.frame.lat)) * 180 / Math.PI;
}

/** Walch (glenoid-referenced) subluxation index in the scapular transverse plane. */
export function subluxGlenoid(L) {
  const g = glenoidGeometry(L);
  if (!g) return NaN;
  let post = v3.unit(v3.reject(v3.sub(L.gp, L.ga), g.frame.sup));
  if (v3.dot(post, g.frame.ant) > 0) post = v3.mul(post, -1);
  const p = v3.dot(v3.sub(L.head.c, v3.mid(L.ga, L.gp)), post);
  return (L.head.r + p) / (2 * L.head.r) * 100;
}

/** Scapula-referenced subluxation index: head position relative to the scapular (Friedman) axis. */
export function subluxScapular(L) {
  const g = glenoidGeometry(L);
  if (!g) return NaN;
  const p = -v3.dot(v3.sub(L.head.c, g.centre), g.frame.ant);
  return (L.head.r + p) / (2 * L.head.r) * 100;
}

function glenoidCt({ id, implant, title, short, headLabel, headHelp, extraFindings = [], extraMetrics = [] }) {
  return {
    id, title, short, modality: 'ct', implant, view: 'ct',
    landmarks: [
      { id: 'head', kind: 'sphere', label: headLabel, group: 'Humerus', auto: true, help: headHelp },
      { id: 'ga', kind: 'point', label: 'Anterior glenoid rim', group: 'Glenoid', help: 'Anterior edge of the glenoid face, on the axial view at mid-glenoid height (just below the coracoid tip).' },
      { id: 'gp', kind: 'point', label: 'Posterior glenoid rim', group: 'Glenoid', help: 'Posterior edge of the glenoid face on the same axial slice. In a biconcave (B2) glenoid this is the edge of the posterior, eroded facet.' },
      { id: 'gsup', kind: 'point', label: 'Superior glenoid rim', group: 'Glenoid', optional: true, help: 'Top of the glenoid face (supraglenoid tubercle), on the coronal view. Needed for inclination.' },
      { id: 'ginf', kind: 'point', label: 'Inferior glenoid rim', group: 'Glenoid', optional: true, help: 'Bottom of the glenoid face, on the coronal view. Needed for inclination.' },
      { id: 'tri', kind: 'point', label: 'Trigonum spinae', group: 'Scapula', help: HELP3.tri },
      { id: 'ia', kind: 'point', label: 'Inferior angle', group: 'Scapula', optional: true, help: HELP3.ia },
    ],
    metrics: [
      {
        id: 'version', label: 'Glenoid version (3D, scapular frame)', unit: '°', group: 'Glenoid',
        needs: ['ga', 'gp', 'tri'],
        compute: ({ L }) => glenoidVersion(L),
        format: fmtVersion, gauge: { min: -40, max: 15 }, evidence: 'published', refs: ['friedman1992', 'budge2011', 'bercik2016', 'ho2013', 'walch2012'],
        what: 'Friedman version computed in 3D: the angle between the anterior–posterior glenoid line and the perpendicular to the scapular axis, in the transverse plane of the scapula.',
        caveat: `${VERSION_NOTE} On uncorrected 2D slices version differs from this by 5–10° in a third of shoulders.`,
        bands: [
          { upTo: -25, status: 'out', tag: 'Severe retroversion', say: 'Retroversion beyond 25°. An anatomic glenoid cannot be seated here without an augment or graft; the largest biconcave-glenoid series is quoted as finding loosening or instability in over 40% above 27°. This is reverse (or augment) territory.' },
          { upTo: -15, status: 'borderline', tag: 'Retroverted', say: 'Retroversion of 15° or more — a Walch B3 criterion when the glenoid is monoconcave, and the level at which a glenoid component left retroverted showed about five times the odds of osteolysis. Correction or augmentation is needed for an anatomic implant.' },
          { upTo: 5, status: 'good', tag: 'Near neutral', say: 'Version close to neutral (controls average about 2° of anteversion; arthritic shoulders about 11° of retroversion).' },
          { status: 'borderline', tag: 'Anteverted', say: 'Anteversion — with anterior subluxation this is a Walch type D glenoid.' },
        ],
      },
      {
        id: 'incl', label: 'Glenoid inclination (3D)', unit: '°', group: 'Glenoid',
        needs: ['ga', 'gp', 'gsup', 'ginf', 'tri'],
        compute: ({ L }) => glenoidInclination(L),
        format: fmtTilt, gauge: { min: -15, max: 35 }, evidence: 'pragmatic', refs: ['boileau2019', 'maurer2012'],
        what: 'Tilt of the superior–inferior glenoid line relative to the perpendicular to the scapular axis, within the scapular plane. Positive = the glenoid faces upward.',
        caveat: 'Referenced to the Friedman axis, not the supraspinatus fossa floor. Without the inferior angle the scapular plane is taken from the scanner axis.',
        bands: [
          { upTo: 10, status: 'good', tag: 'Usual range', say: 'Within the usual range of glenoid inclination.' },
          { upTo: 15, status: 'borderline', tag: 'Superior tilt', say: 'More superior tilt than usual — suggests superior wear.' },
          { status: 'out', tag: 'Marked superior tilt', say: 'Marked superior tilt: superior glenoid erosion, the coronal-plane counterpart of cuff insufficiency.' },
        ],
      },
      {
        id: 'sublux', label: 'Subluxation index — glenoid-referenced (Walch)', unit: '%', group: 'Centring',
        needs: ['head', 'ga', 'gp', 'tri'],
        compute: ({ L }) => subluxGlenoid(L),
        target: '45–55%', gauge: { min: 20, max: 100 }, evidence: 'published', refs: ['walch1999', 'bercik2016', 'walch2012'],
        what: 'Share of the head lying posterior to the perpendicular bisector of the glenoid line, in the scapular transverse plane.',
        caveat: 'Uses the fitted sphere, not a single slice. The 55% limit is a convention; the ">80%" figure is quoted second-hand from the original series.',
        bands: SUBLUX_BANDS,
      },
      {
        id: 'subluxScap', label: 'Subluxation index — scapula-referenced', unit: '%', group: 'Centring',
        needs: ['head', 'ga', 'gp', 'tri'],
        compute: ({ L }) => subluxScapular(L),
        gauge: { min: 20, max: 100 }, evidence: 'descriptive', refs: ['bercik2016'],
        what: 'Share of the head lying posterior to the scapular (Friedman) axis. Unlike the glenoid-referenced index it does not "follow" a retroverted glenoid.',
        caveat: 'Normal ranges depend on the method (about 49–61% for 3D scapula-referenced measurement). A head centred on a retroverted glenoid is still posterior to the scapular axis.',
        bands: [
          { upTo: 45, status: 'info', tag: 'Anterior', say: 'The head lies anterior to the scapular axis.' },
          { upTo: 61, status: 'info', tag: 'Centred', say: 'The head is centred on the scapular axis (within the range reported for normal shoulders with 3D methods).' },
          { status: 'info', tag: 'Posterior', say: 'The head lies posterior to the scapular axis. Compare with the glenoid-referenced index: posterior here but centred there means the head has followed a retroverted glenoid.' },
        ],
      },
      {
        id: 'headDiam', label: `${headLabel} — diameter`, unit: 'mm', group: 'Centring',
        needs: ['head'],
        compute: ({ L }) => 2 * L.head.r,
        gauge: { min: 34, max: 60 }, evidence: 'descriptive', refs: ['iannotti1992'],
        what: 'Diameter of the fitted sphere, true to size.',
        caveat: 'A native head is spherical only over its articular part; the fit uses that part.',
        bands: [{ status: 'info', tag: '', say: implant === 'pyc'
          ? 'Compare with the implanted head size; a mismatch over about 1.5 mm means the sphere fit needs checking.'
          : 'For templating: native radius of curvature averages 24 mm (diameter 48 mm).' }],
      },
      ...extraMetrics,
    ],
    findings: [
      {
        id: 'walch', label: 'Walch glenoid type', group: 'Glenoid', refs: ['walch1999', 'bercik2016'],
        help: 'The software suggests a type from version and subluxation; biconcavity and erosion are yours to judge.',
        options: [
          { v: 'A1', label: 'A1 — centred, minor erosion', status: 'good', say: 'Walch A1: centred head, minor central erosion.' },
          { v: 'A2', label: 'A2 — centred, major central erosion', status: 'info', say: 'Walch A2: centred head with major central erosion — medialisation to plan for, but a concentric joint.' },
          { v: 'B1', label: 'B1 — posterior subluxation, no erosion', status: 'borderline', say: 'Walch B1: posterior subluxation with posterior joint narrowing but no bony erosion.' },
          { v: 'B2', label: 'B2 — biconcave', status: 'borderline', say: 'Walch B2: biconcave glenoid with posterior erosion. Anatomic replacement here needs corrective reaming, an augment or a graft, and carries more glenoid complications than in type A.' },
          { v: 'B3', label: 'B3 — monoconcave, retroversion ≥ 15° or subluxation ≥ 70%', status: 'out', say: 'Walch B3: monoconcave, posteriorly worn glenoid with at least 15° of retroversion or 70% subluxation. The type for which reverse arthroplasty is most often chosen despite an intact cuff.' },
          { v: 'C', label: 'C — dysplastic, retroversion > 25°', status: 'out', say: 'Walch C: dysplastic glenoid with retroversion over 25° not caused by erosion.' },
          { v: 'D', label: 'D — anteversion or anterior subluxation', status: 'borderline', say: 'Walch D: glenoid anteversion or anterior subluxation of the head.' },
        ],
      },
      ...extraFindings,
    ],
    synthesis(m) {
      const out = [];
      if (m.version.status !== 'pending' && m.sublux.status !== 'pending') {
        const v = m.version.value, s = m.sublux.value;
        let sug;
        if (v > 5 || s < 40) sug = 'D (anteversion or anterior subluxation)';
        else if (v <= -15 || s >= 70) sug = 'B2 if the glenoid is biconcave, B3 if it is monoconcave with posterior wear, C if the retroversion is over 25° and dysplastic rather than erosive';
        else if (s > 55) sug = 'B1 if there is no posterior erosion, B2 if the glenoid is biconcave';
        else sug = 'A1 or A2, depending on the depth of central erosion';
        out.push({ title: 'Walch type suggested by the numbers', status: 'info', text: `Version ${m.version.text} with a subluxation index of ${m.sublux.text} points to type ${sug}. The software cannot see biconcavity or erosion — set the type yourself.` });
      }
      return out;
    },
    caveats(ctx) {
      const c = [];
      if (ctx.L.tri && !ctx.L.ia) c.push('The inferior angle was not marked, so the transverse plane of the scapula is taken from the scanner axis. Version then matches a conventional 2D Friedman measurement on straight axial slices rather than a fully 3D-corrected one.');
      c.push('Version is measured to the rim points you place. In a biconcave glenoid, rim-to-rim gives the "intermediate" glenoid; place the posterior point at the ridge to measure the paleoglenoid instead.');
      return c;
    },
  };
}

export const nativeCt = glenoidCt({
  id: 'native-ct', implant: 'native', title: 'Native shoulder — CT', short: 'Native · CT',
  headLabel: 'Humeral head', headHelp: 'Sphere fitted to the articular surface of the humeral head. To set it by hand: click the centre, then a point on the articular surface.',
  extraFindings: [
    {
      id: 'boneLoss', label: 'Glenoid bone stock', group: 'Glenoid', refs: [],
      options: [
        { v: 'ok', label: 'Adequate vault', status: 'good', say: 'The glenoid vault is adequate for a standard component.' },
        { v: 'limited', label: 'Medialised / limited', status: 'borderline', say: 'The glenoid is medialised with limited vault depth — a standard anatomic component may perforate; consider augmentation or a baseplate with a long post.' },
        { v: 'severe', label: 'Severe loss', status: 'out', say: 'Severe glenoid bone loss — grafting or a custom/augmented baseplate.' },
      ],
    },
  ],
});

export const pycCt = glenoidCt({
  id: 'pyc-ct', implant: 'pyc', title: 'Pyrocarbon hemiarthroplasty — CT', short: 'Hemi · CT',
  headLabel: 'Prosthetic head', headHelp: 'Sphere fitted to the prosthetic head. To set it by hand: click the centre, then a point on the head surface.',
  extraFindings: [
    {
      id: 'glenoidErosion', label: 'Glenoid erosion', group: 'Glenoid', refs: ['sperling2004', 'garret2024', 'boileau2026'],
      options: [
        { v: 'none', label: 'None', status: 'good', say: 'No glenoid erosion on CT.' },
        { v: 'mild', label: 'Mild — subchondral', status: 'borderline', say: 'Mild glenoid erosion into the subchondral bone.' },
        { v: 'moderate', label: 'Moderate — medialised', status: 'out', say: 'Moderate glenoid erosion with medialisation of the head.' },
        { v: 'severe', label: 'Severe — to the coracoid base', status: 'out', say: 'Severe glenoid erosion reaching the coracoid base.' },
      ],
    },
    {
      id: 'tuberosity', label: 'Greater tuberosity', group: 'Humerus', refs: ['pycReview2023'],
      options: [
        { v: 'normal', label: 'Normal thickness', status: 'good', say: 'The greater tuberosity has kept its thickness.' },
        { v: 'thin', label: 'Thinned', status: 'borderline', say: 'The greater tuberosity is thinned.' },
        { v: 'fracture', label: 'Fractured or resorbed', status: 'out', say: 'The greater tuberosity is fractured or resorbed.' },
      ],
    },
  ],
});
