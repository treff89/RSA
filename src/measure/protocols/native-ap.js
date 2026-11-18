// Native shoulder — true AP (Grashey) radiograph. Feeds the anatomic-versus-reverse synthesis (../decision.js).
import { shape } from '../core.js';
import { angleAt, signedDistToLine, projectOnLine } from '../geom.js';
import { C, HELP, lateral, supInf, medLat, tiltVsFossa, postureMetrics, sub, add, mul, dot, unit, mid, dist, DEG } from './xray-common.js';

/** Lateral acromial angle (Banas): glenoid line pointing inferior vs acromial undersurface pointing lateral. 90° = parallel-faced. */
export function lateralAcromialAngle(ctx) {
  const g = supInf({ a: ctx.L.sgt, b: ctx.L.igr });
  const down = unit(sub(g.b, g.a));
  const l = medLat(ctx.L.acLine, ctx);
  const d = unit(sub(l.b, l.a));
  return Math.acos(Math.max(-1, Math.min(1, dot(down, d)))) * DEG;
}

const G_ACR = 'Acromion & cuff';
const G_GLEN = 'Glenoid';
const G_HUM = 'Humerus';

const glenoidLine = (ctx) => supInf({ a: ctx.L.sgt, b: ctx.L.igr });

export default {
  id: 'native-ap',
  title: 'Native shoulder — AP radiograph',
  short: 'Native · AP',
  modality: 'xray',
  implant: 'native',
  view: 'ap',
  calibration: null,   // no object of known size: distances need the image's pixel spacing (and carry its magnification)
  landmarks: [
    { id: 'head', kind: 'circle', label: 'Humeral head outline', group: 'Humerus', help: 'Circle fitted to the articular surface of the humeral head.', auto: true },
    { id: 'sgt', kind: 'point', label: 'Superior glenoid rim', group: 'Scapula', help: HELP.sgt },
    { id: 'igr', kind: 'point', label: 'Inferior glenoid rim', group: 'Scapula', help: HELP.igr },
    { id: 'acr', kind: 'point', label: 'Lateral acromion', group: 'Scapula', help: 'Most inferolateral point of the acromion.' },
    { id: 'acu', kind: 'point', label: 'Acromion undersurface', group: 'Scapula', help: HELP.acu },
    { id: 'ssf', kind: 'line', label: 'Supraspinatus fossa floor', group: 'Scapula', help: HELP.ssf },
    { id: 'acLine', kind: 'line', label: 'Acromial undersurface line', group: 'Scapula', optional: true, help: 'Along the inferior cortex of the acromion: one end at its medial part above the joint, the other at its lateral tip. Defines the lateral acromial angle.' },
    { id: 'gmid', kind: 'point', label: 'Glenoid — fossa-floor intersection', group: 'Scapula', optional: true, help: 'The point on the glenoid articular surface where the line of the supraspinatus fossa floor meets it. Together with the inferior rim it defines the inferior half of the glenoid for the RSA angle.' },
    { id: 'gtl', kind: 'point', label: 'Greater tuberosity — lateral', group: 'Humerus', help: HELP.gtl },
    { id: 'gts', kind: 'point', label: 'Greater tuberosity — top', group: 'Humerus', optional: true, help: HELP.gts },
    { id: 'hcl', kind: 'line', label: 'Humeral shaft centre line', group: 'Humerus', optional: true, help: HELP.hcl },
    { id: 'osteo', kind: 'line', label: 'Inferior humeral osteophyte', group: 'Humerus', optional: true, help: 'Length of the inferior humeral ("goat\'s beard") osteophyte: from its base at the articular margin to its tip. Leave out if there is none.' },
    { id: 'dtO', kind: 'line', label: 'Shaft outer width above deltoid tuberosity', group: 'Bone quality', optional: true, help: 'Outer cortex to outer cortex, directly above the upper end of the deltoid tuberosity, where the outer cortices become parallel.' },
    { id: 'dtI', kind: 'line', label: 'Shaft inner width at the same level', group: 'Bone quality', optional: true, help: 'Inner (endosteal) cortex to inner cortex at the same level.' },
  ],

  metrics: [
    {
      id: 'csa', label: 'Critical shoulder angle', unit: '°', group: G_ACR,
      needs: ['sgt', 'igr', 'acr'],
      compute: ({ L }) => angleAt(L.sgt, L.igr, L.acr),
      target: '30–35°', gauge: { min: 20, max: 45 }, evidence: 'published', refs: ['moor2013', 'watling2018'],
      what: 'Angle at the inferior glenoid rim between the glenoid line (to the superior rim) and the line to the inferolateral acromion. It combines glenoid inclination and lateral acromial extension.',
      caveat: 'Valid only on a true AP with little scapular rotation (ratio of the overlapping glenoid rims). One later case-control study did not reproduce the link with cuff tears.',
      bands: [
        { upTo: 30, status: 'info', tag: 'Low — arthritis type', say: 'Below 30°: the range in which 93% of shoulders in the original series had primary osteoarthritis. The joint force is compressive; the cuff is usually intact.' },
        { upTo: 35.0001, status: 'good', tag: 'Normal', say: 'Within the 30–35° range of control shoulders.' },
        { status: 'borderline', tag: 'High — cuff-tear type', say: 'Above 35°: the range in which 84% of shoulders in the original series had a cuff tear. After an anatomic replacement, each extra degree raised the odds of an at-risk glenoid component by about 20% in one series.' },
      ],
      draw: ({ L }) => [shape.line(L.igr, L.sgt), shape.line(L.igr, L.acr), shape.arc(L.igr, L.sgt, L.acr)],
    },
    {
      id: 'ai', label: 'Acromion index', unit: 'ratio', group: G_ACR,
      needs: ['sgt', 'igr', 'acr', 'gtl'],
      compute: (ctx) => {
        const g = glenoidLine(ctx);
        return signedDistToLine(ctx.L.acr, g.a, g.b, lateral(ctx)) / signedDistToLine(ctx.L.gtl, g.a, g.b, lateral(ctx));
      },
      gauge: { min: 0.4, max: 0.95 }, evidence: 'descriptive', refs: ['nyffeler2006'],
      what: 'Distance from the glenoid plane to the lateral acromion divided by the distance from the glenoid plane to the lateral humerus.',
      caveat: 'Group means, not cut-offs: 0.73 with full-thickness cuff tears, 0.64 in controls, 0.60 with osteoarthritis.',
      bands: [
        { upTo: 0.62, status: 'info', tag: 'Short acromion', say: 'A short lateral acromion, close to the mean of osteoarthritic shoulders (0.60).' },
        { upTo: 0.69, status: 'info', tag: 'Average', say: 'Close to the mean of control shoulders (0.64).' },
        { status: 'info', tag: 'Long acromion', say: 'A long lateral acromion, close to the mean of shoulders with full-thickness cuff tears (0.73).' },
      ],
    },
    {
      id: 'ahd', label: 'Acromiohumeral distance', unit: 'mm', group: G_ACR, scale: true,
      needs: ['acu', 'head'],
      compute: (ctx) => (dist(ctx.L.acu, C(ctx.L.head)) - ctx.L.head.r) * ctx.mm,
      target: '≥ 7 mm', gauge: { min: 0, max: 16 }, evidence: 'published', refs: ['saupe2006', 'goutallier2011', 'hamada1990'],
      what: 'Shortest distance from the undersurface of the acromion to the humeral head.',
      caveat: 'Film magnification inflates it by roughly 5–15% unless the image is calibrated; arm position and beam tilt change it by 1–2 mm.',
      bands: [
        { upTo: 6, status: 'out', tag: 'Cuff-deficient', say: 'Under 6 mm. In the CT-arthrography series this occurred only with a complete infraspinatus tear and advanced fatty infiltration: the cuff no longer centres the head. An anatomic replacement relies on a working cuff.' },
        { upTo: 7.0001, status: 'borderline', tag: 'Narrowed', say: 'At or under 7 mm — the level associated with large, chronic cuff tears. The cuff needs imaging before any anatomic implant is planned.' },
        { status: 'good', tag: 'Maintained', say: 'Above 7 mm: no radiographic sign of superior migration. This does not prove the cuff is intact.' },
      ],
      draw: (ctx) => {
        const c = C(ctx.L.head);
        const u = unit(sub(ctx.L.acu, c));
        return [shape.dim(add(c, mul(u, ctx.L.head.r)), ctx.L.acu)];
      },
    },
    {
      id: 'laa', label: 'Lateral acromial angle', unit: '°', group: G_ACR,
      needs: ['sgt', 'igr', 'acLine'],
      compute: (ctx) => lateralAcromialAngle(ctx),
      target: '≥ 75°', gauge: { min: 55, max: 105 }, evidence: 'published', refs: ['banas1995'],
      what: 'Angle between the glenoid line and the undersurface of the acromion, opening towards the joint (Banas). 90° = the acromial undersurface is perpendicular to the glenoid; a smaller angle means the acromion slopes down laterally and narrows the outlet.',
      caveat: 'Described on oblique coronal MRI (mean 78°, range 64–99°); applying it to an AP radiograph is an adaptation, and the 70° limit comes from eight shoulders. A rotated film changes the apparent acromial slope.',
      bands: [
        { upTo: 70.0001, status: 'out', tag: 'Low', say: 'At or below 70°: in the original series every shoulder at this level had a full-thickness cuff tear. An acromion that slopes this far down laterally crowds the cuff outlet.' },
        { upTo: 75, status: 'borderline', tag: 'Slightly low', say: 'Between 70° and 75° — the range some authors treat as the lower limit of normal.' },
        { status: 'good', tag: 'Normal', say: 'At or above 75°, around or above the original series\' mean of 78°.' },
      ],
      draw: (ctx) => { const g = glenoidLine(ctx); return [shape.ray(g.a, g.b, { dash: true }), shape.ray(ctx.L.acLine.a, ctx.L.acLine.b, { dash: true })]; },
    },
    {
      id: 'atd', label: 'Acromion–tuberosity distance', unit: 'mm', group: G_ACR, scale: true,
      needs: ['acu', 'gts'],
      compute: (ctx) => dist(ctx.L.acu, ctx.L.gts) * ctx.mm,
      gauge: { min: 0, max: 40 }, evidence: 'descriptive', refs: ['ladermann2014', 'jobin2012'],
      what: 'Straight distance from the undersurface of the acromion to the top of the greater tuberosity — the same measurement as on the reverse protocol, so that arm lengthening can be read when this film is compared with a post-operative one.',
      caveat: 'Descriptive. Carries the film magnification unless calibrated; the comparison view rescales it between films.',
      bands: [{ status: 'info', tag: '', say: 'Baseline before surgery. Compared with the post-operative film it gives the deltoid lengthening (0–2 cm is the range usually recommended for a reverse).' }],
      draw: (ctx) => [shape.dim(ctx.L.acu, ctx.L.gts)],
    },
    {
      id: 'supMig', label: 'Head centre above glenoid centre', unit: 'mm', group: G_ACR, scale: true,
      needs: ['head', 'sgt', 'igr'],
      compute: (ctx) => {
        const g = glenoidLine(ctx);
        return -dot(sub(C(ctx.L.head), mid(g.a, g.b)), unit(sub(g.b, g.a))) * ctx.mm;
      },
      gauge: { min: -8, max: 15 }, evidence: 'descriptive', refs: ['hamada1990'],
      what: 'Height of the humeral head centre relative to the midpoint of the glenoid, measured along the glenoid line; positive = the head rides high.',
      caveat: 'Descriptive; no published cut-off. It complements the acromiohumeral distance when the acromion is hard to outline.',
      bands: [{ status: 'info', tag: '', say: 'A well-centred head sits within a few millimetres of the glenoid centre. A head riding clearly above it is static superior migration.' }],
    },

    {
      id: 'incl', label: 'Glenoid inclination', unit: '°', group: G_GLEN,
      needs: ['sgt', 'igr', 'ssf'],
      compute: (ctx) => tiltVsFossa(glenoidLine(ctx), ctx.L.ssf, ctx),
      format: (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? 'superior' : 'inferior'} tilt`,
      gauge: { min: -15, max: 40 }, evidence: 'pragmatic', refs: ['maurer2012', 'boileau2019', 'favard2004'],
      what: 'Tilt of the whole glenoid (superior to inferior rim) relative to the perpendicular to the supraspinatus fossa floor — the β-angle re-expressed as a signed tilt. Positive = the glenoid faces upward.',
      caveat: 'The β-angle is the most reproducible inclination measure on an AP film and tolerates ±20° of scapular rotation; the bands here are pragmatic.',
      bands: [
        { upTo: 15, status: 'good', tag: 'Usual range', say: 'Within the usual range of glenoid inclination.' },
        { upTo: 20, status: 'borderline', tag: 'Superior tilt', say: 'More superior tilt than usual — consistent with superior wear, which goes with cuff insufficiency.' },
        { status: 'out', tag: 'Marked superior tilt', say: 'Marked superior tilt: superior glenoid erosion (Favard E2–E3 pattern). The head will keep escaping upward on an anatomic glenoid; a reverse baseplate would need inferior tilt correction.' },
      ],
      draw: (ctx) => { const g = glenoidLine(ctx); return [shape.ray(ctx.L.ssf.a, ctx.L.ssf.b, { dash: true }), shape.line(g.a, g.b)]; },
    },
    {
      id: 'rsaAngle', label: 'RSA angle (inferior glenoid)', unit: '°', group: G_GLEN,
      needs: ['igr', 'gmid', 'ssf'],
      compute: (ctx) => tiltVsFossa(supInf({ a: ctx.L.gmid, b: ctx.L.igr }), ctx.L.ssf, ctx),
      gauge: { min: -5, max: 45 }, evidence: 'descriptive', refs: ['boileau2019'],
      what: 'Inclination of the inferior half of the glenoid — where a reverse baseplate sits — relative to the perpendicular to the supraspinatus fossa floor.',
      caveat: 'Averages about 25° on radiographs (20° on CT) in cuff-tear arthropathy, roughly 10° more than the whole-glenoid inclination. It is a planning number, not a quality grade.',
      bands: [{ status: 'info', tag: '', say: (v) => `To seat a reverse baseplate at neutral inclination, about ${Math.max(0, v).toFixed(0)}° of superior tilt would have to be corrected by inferior reaming, an augment or a graft. Planning from the whole-glenoid inclination underestimates this.` }],
      draw: (ctx) => [shape.line(ctx.L.gmid, ctx.L.igr)],
    },

    {
      id: 'headDiam', label: 'Humeral head diameter (best-fit circle)', unit: 'mm', group: G_HUM, scale: true,
      needs: ['head'],
      compute: (ctx) => 2 * ctx.L.head.r * ctx.mm,
      gauge: { min: 34, max: 60 }, evidence: 'descriptive', refs: ['iannotti1992'],
      what: 'Diameter of the circle fitted to the articular surface.',
      caveat: 'Carries the film magnification unless the image is calibrated. Native head radius of curvature is 24 ± 2 mm.',
      bands: [{ status: 'info', tag: '', say: 'For templating. The native radius of curvature averages 24 mm (diameter 48 mm); an uncalibrated film typically reads 5–15% large.' }],
    },
    {
      id: 'osteophyte', label: 'Inferior humeral osteophyte (Samilson–Prieto)', unit: 'mm', group: G_HUM, scale: true,
      needs: ['osteo'],
      compute: (ctx) => dist(ctx.L.osteo.a, ctx.L.osteo.b) * ctx.mm,
      gauge: { min: 0, max: 15 }, evidence: 'published', refs: ['samilson1983'],
      what: 'Length of the inferior humeral osteophyte, the basis of the Samilson–Prieto grade.',
      caveat: 'Grades arthritis severity only; it says nothing about which implant suits.',
      bands: [
        { upTo: 3, status: 'info', tag: 'Mild', say: 'Samilson–Prieto mild: osteophyte under 3 mm.' },
        { upTo: 7.0001, status: 'info', tag: 'Moderate', say: 'Samilson–Prieto moderate: osteophyte of 3–7 mm.' },
        { status: 'info', tag: 'Severe', say: 'Samilson–Prieto severe: osteophyte over 7 mm.' },
      ],
      draw: ({ L }) => [shape.dim(L.osteo.a, L.osteo.b)],
    },
    {
      id: 'dti', label: 'Deltoid tuberosity index', unit: 'ratio', group: G_HUM,
      needs: ['dtO', 'dtI'],
      compute: ({ L }) => dist(L.dtO.a, L.dtO.b) / dist(L.dtI.a, L.dtI.b),
      target: '≥ 1.4', gauge: { min: 1, max: 2 }, evidence: 'published', refs: ['spross2015'],
      what: 'Outer cortical diameter divided by inner (endosteal) diameter directly above the deltoid tuberosity. A thin cortex gives a low ratio.',
      caveat: 'The cut-off (1.44) was derived against bone density in proximal humeral fracture patients, on AP films in internal rotation.',
      bands: [
        { upTo: 1.4, status: 'borderline', tag: 'Low bone quality', say: 'Below 1.4: indicates low local bone mineral density. Relevant for stemless or press-fit humeral fixation and for the risk of intra-operative fracture.' },
        { status: 'good', tag: 'Adequate', say: 'At or above 1.4: no radiographic sign of poor humeral bone quality.' },
      ],
      draw: ({ L }) => [shape.line(L.dtO.a, L.dtO.b), shape.line(L.dtI.a, L.dtI.b, { dash: true })],
    },
    ...postureMetrics(['hcl']),
  ],

  findings: [
    {
      id: 'hamada', label: 'Hamada grade (cuff-tear arthropathy)', group: G_ACR, refs: ['hamada1990', 'hamada2011'],
      help: 'Grade 1 and 2 follow from the acromiohumeral distance; the higher grades need your eye.',
      options: [
        { v: '0', label: 'Not applicable — no superior migration', status: 'good', say: 'No radiographic feature of cuff-tear arthropathy.' },
        { v: '1', label: 'Grade 1 — AHD ≥ 6 mm', status: 'good', say: 'Hamada grade 1: acromiohumeral distance preserved.' },
        { v: '2', label: 'Grade 2 — AHD ≤ 5 mm', status: 'out', say: 'Hamada grade 2: acromiohumeral distance of 5 mm or less — a massive, chronic cuff tear.' },
        { v: '3', label: 'Grade 3 — acetabularisation of the acromion', status: 'out', say: 'Hamada grade 3: the acromion is acetabularised by the migrated head.' },
        { v: '4a', label: 'Grade 4A — glenohumeral narrowing, no acetabularisation', status: 'out', say: 'Hamada grade 4A: glenohumeral joint narrowing without acetabularisation.' },
        { v: '4b', label: 'Grade 4B — narrowing with acetabularisation', status: 'out', say: 'Hamada grade 4B: glenohumeral narrowing with acetabularisation — established cuff-tear arthropathy.' },
        { v: '5', label: 'Grade 5 — humeral head collapse', status: 'out', say: 'Hamada grade 5: collapse of the humeral head.' },
      ],
    },
    {
      id: 'favard', label: 'Glenoid erosion in the coronal plane (Favard)', group: G_GLEN, refs: ['favard2004'],
      options: [
        { v: 'E0', label: 'E0 — no erosion', status: 'good', say: 'Favard E0: no glenoid erosion.' },
        { v: 'E1', label: 'E1 — concentric erosion', status: 'info', say: 'Favard E1: concentric (central) erosion.' },
        { v: 'E2', label: 'E2 — superior erosion', status: 'borderline', say: 'Favard E2: erosion of the superior glenoid — the signature of a head that has been riding high.' },
        { v: 'E3', label: 'E3 — superior erosion extending inferiorly', status: 'out', say: 'Favard E3: superior erosion extending to the inferior glenoid, leaving a superiorly tilted face.' },
        { v: 'E4', label: 'E4 — inferior erosion', status: 'info', say: 'Favard E4: predominantly inferior erosion.' },
      ],
    },
    {
      id: 'jointSpace', label: 'Glenohumeral joint space', group: G_GLEN, refs: [],
      options: [
        { v: 'preserved', label: 'Preserved', status: 'good', say: 'Glenohumeral joint space preserved.' },
        { v: 'narrowed', label: 'Narrowed', status: 'info', say: 'Glenohumeral joint space narrowed.' },
        { v: 'obliterated', label: 'Bone on bone', status: 'info', say: 'Glenohumeral joint space obliterated (bone on bone).' },
      ],
    },
  ],

  synthesis(m) {
    const out = [];
    if (m.ahd.status !== 'pending') {
      const v = m.ahd.value;
      out.push({
        title: 'Hamada grade implied by the measurement',
        status: v <= 5 ? 'out' : v < 6 ? 'borderline' : 'good',
        text: v <= 5
          ? `The acromiohumeral distance of ${m.ahd.text} is 5 mm or less: Hamada grade 2 at least. Grades 3–5 depend on acetabularisation, joint narrowing and head collapse, which you grade by eye.`
          : v < 6
            ? `The acromiohumeral distance of ${m.ahd.text} lies between the grade 1 (≥ 6 mm) and grade 2 (≤ 5 mm) definitions — within measurement error of either.`
            : `The acromiohumeral distance of ${m.ahd.text} is 6 mm or more: Hamada grade 1 unless there is glenohumeral narrowing (grade 4A).`,
      });
    }
    return out;
  },

  caveats(ctx) {
    const c = ['These measurements assume a true AP (Grashey) view with the arm in neutral rotation. A plain radiograph cannot show the cuff muscles or glenoid version; it can only show their late consequences.'];
    if (ctx.mm > 0 && ctx.mmSource === 'dicom') c.push('Distances use the pixel spacing stored in the image. Unless the image was calibrated at acquisition, they include the film magnification (typically 5–15% too large).');
    return c;
  },
};

export { projectOnLine };
