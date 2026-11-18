// Reverse shoulder arthroplasty — true AP (Grashey) radiograph.
import { shape } from '../core.js';
import { angleAt, signedDistToLine, projectOnLine } from '../geom.js';
import {
  C, HELP, STEM_FINDINGS, UP, lateral, lateralNormal, supInf, tiltVsFossa, shaftAxis, varusAngle, proxDist, postureMetrics,
  sub, add, mul, dot, unit, mid, dist,
} from './xray-common.js';

const G_LAT = 'Lateralisation & distalisation';
const G_GLEN = 'Glenoid component';
const G_HUM = 'Humeral component';
const G_DELT = 'Deltoid';

/** Inferior direction along the glenosphere's back face. */
function faceInferior(ctx) {
  const f = supInf(ctx.L.face);
  return unit(sub(f.b, f.a));
}

/** Most inferior extent of the glenosphere measured along its back face. */
function glenosphereInferiorEdge(ctx) {
  const { gs } = ctx.L;
  const f = supInf(ctx.L.face);
  const dInf = faceInferior(ctx);
  // A hemisphere (or more) reaches its full radius at the equator; a shallower dome ends at the face corner.
  const centreOffset = signedDistToLine(C(gs), f.a, f.b, lateral(ctx));
  return centreOffset >= -0.03 * gs.r ? add(C(gs), mul(dInf, gs.r)) : f.b;
}

const glenoidLine = (ctx) => supInf({ a: ctx.L.sgt, b: ctx.L.igr });

export default {
  id: 'rsa-ap',
  title: 'Reverse shoulder arthroplasty — AP radiograph',
  short: 'Reverse · AP',
  modality: 'xray',
  implant: 'reverse',
  view: 'ap',
  calibration: {
    landmark: 'gs',
    label: 'Glenosphere diameter',
    sizes: [33, 34, 35, 36, 38, 39, 40, 41, 42, 44, 46],
    hint: 'From the operation note or implant sticker. The glenosphere is a sphere, so its outline is a true-size ruler whatever the projection.',
  },
  landmarks: [
    { id: 'gs', kind: 'circle', label: 'Glenosphere outline', group: 'Implant', help: 'Circle fitted to the metal dome of the glenosphere. Its centre is the centre of rotation.', auto: true },
    { id: 'face', kind: 'line', label: 'Glenosphere back face', group: 'Implant', help: 'The flat medial face of the glenosphere (where it sits on the baseplate): superior corner to inferior corner.', auto: true },
    { id: 'stem', kind: 'line', label: 'Humeral stem axis', group: 'Implant', help: 'Centre line of the humeral stem, from just below the cup to the tip.', auto: true },
    { id: 'sgt', kind: 'point', label: 'Superior glenoid tubercle', group: 'Scapula', help: HELP.sgt },
    { id: 'igr', kind: 'point', label: 'Inferior glenoid rim', group: 'Scapula', help: HELP.igr },
    { id: 'acr', kind: 'point', label: 'Lateral acromion', group: 'Scapula', help: HELP.acr },
    { id: 'acu', kind: 'point', label: 'Acromion undersurface', group: 'Scapula', help: HELP.acu },
    { id: 'ssf', kind: 'line', label: 'Supraspinatus fossa floor', group: 'Scapula', help: HELP.ssf },
    { id: 'gts', kind: 'point', label: 'Greater tuberosity — top', group: 'Humerus', help: HELP.gts },
    { id: 'gtl', kind: 'point', label: 'Greater tuberosity — lateral', group: 'Humerus', help: HELP.gtl },
    { id: 'dtu', kind: 'point', label: 'Deltoid tuberosity — midpoint', group: 'Humerus', optional: true, help: HELP.dtu },
    { id: 'canalM', kind: 'line', label: 'Canal width — metaphysis', group: 'Stem fit', help: HELP.canalM, optional: true },
    { id: 'stemM', kind: 'line', label: 'Stem width — metaphysis', group: 'Stem fit', help: HELP.stemM, optional: true, auto: true },
    { id: 'canalD', kind: 'line', label: 'Canal width — near tip', group: 'Stem fit', help: HELP.canalD, optional: true },
    { id: 'stemD', kind: 'line', label: 'Stem width — near tip', group: 'Stem fit', help: HELP.stemD, optional: true, auto: true },
  ],

  metrics: [
    {
      id: 'lsa', label: 'Lateralisation shoulder angle (LSA)', unit: '°', group: G_LAT,
      needs: ['sgt', 'acr', 'gtl'],
      compute: ({ L }) => angleAt(L.sgt, L.acr, L.gtl),
      target: '75–95°', gauge: { min: 55, max: 115 }, evidence: 'contested', refs: ['boutsiadis2018', 'imiolczyk2024', 'erickson2022', 'sahin2025', 'okutan2024'],
      what: 'Angle at the lateral acromion between the line to the superior glenoid tubercle and the line to the most lateral point of the greater tuberosity. It rises as the humerus is lateralised (glenoid side, humeral side or both).',
      caveat: 'The 75–95° range comes from one series of 46 cuff-arthropathy shoulders. Larger series since (630 and 203 shoulders) found little or no link between this angle and outcome, a CT study found it tracks true lateralisation only weakly (r = 0.36), and typical values differ by design (about 79° for 145° onlay, 85° for 135° inlay stems). Read it as a reference band, not a target. It also changes with arm abduction and rotation.',
      bands: [
        { upTo: 70, status: 'out', tag: 'Low', say: 'Clearly below the 75–95° range: the humerus sits medial under the acromion. In the original series this went with weaker active external rotation; a medialised construct also loses deltoid wrap and tension on any remaining posterior cuff.' },
        { upTo: 75, status: 'borderline', tag: 'Slightly low', say: 'Just under the 75–95° range — on the medial side, within measurement error of acceptable.' },
        { upTo: 95.0001, status: 'good', tag: 'In range', say: 'Inside the 75–95° band that the original series associated with the best active external rotation.' },
        { upTo: 100, status: 'borderline', tag: 'Slightly high', say: 'Just above the 75–95° range — more lateralised than the cohort the range came from.' },
        { status: 'out', tag: 'High', say: 'Well above the 75–95° range: a heavily lateralised construct. The reported concerns are acromial/scapular spine stress, tight soft tissues and difficulty with internal rotation — none proven to follow from this angle alone.' },
      ],
      draw: ({ L }) => [shape.line(L.acr, L.sgt), shape.line(L.acr, L.gtl), shape.arc(L.acr, L.sgt, L.gtl)],
    },
    {
      id: 'dsa', label: 'Distalisation shoulder angle (DSA)', unit: '°', group: G_LAT,
      needs: ['sgt', 'acr', 'gts'],
      compute: ({ L }) => angleAt(L.acr, L.sgt, L.gts),
      target: '40–65°', gauge: { min: 20, max: 85 }, evidence: 'contested', refs: ['boutsiadis2018', 'imiolczyk2024', 'erickson2022', 'sahin2025', 'okutan2024'],
      what: 'Angle at the superior glenoid tubercle between the line to the lateral acromion and the line to the top of the greater tuberosity. It rises as the humerus is brought down (distalised).',
      caveat: 'Same origin and limits as the LSA: one series of 46 shoulders, not reproduced in larger ones; on CT it did not track true distalisation (r = 0.17). In a 135-shoulder series only 44% of well-functioning reverses fell inside the band. Abducting the arm lowers it markedly.',
      bands: [
        { upTo: 35, status: 'out', tag: 'Low', say: 'Clearly below the 40–65° range: little distalisation. In the original series this went with poorer active elevation and abduction; an under-tensioned deltoid is also the classic setting for instability.' },
        { upTo: 40, status: 'borderline', tag: 'Slightly low', say: 'Just under the 40–65° range — limited distalisation, within measurement error of acceptable.' },
        { upTo: 65.0001, status: 'good', tag: 'In range', say: 'Inside the 40–65° band that the original series associated with the best active elevation and abduction.' },
        { upTo: 70, status: 'borderline', tag: 'Slightly high', say: 'Just above the 40–65° range — more distalised than the cohort the range came from.' },
        { status: 'out', tag: 'High', say: 'Well above the 40–65° range: marked distalisation. Excessive lengthening is the mechanism proposed for acromial stress fractures, deltoid over-tension and traction neurapraxia.' },
      ],
      draw: ({ L }) => [shape.line(L.sgt, L.acr), shape.line(L.sgt, L.gts), shape.arc(L.sgt, L.acr, L.gts)],
    },
    {
      id: 'ahd', label: 'Acromion–tuberosity distance', unit: 'mm', group: G_LAT, scale: true,
      needs: ['acu', 'gts'],
      compute: (ctx) => dist(ctx.L.acu, ctx.L.gts) * ctx.mm,
      gauge: { min: 0, max: 60 }, evidence: 'descriptive', refs: ['jobin2012', 'ladermann2014', 'ladermann2012', 'otto2013'],
      what: 'Straight distance from the undersurface of the acromion to the top of the greater tuberosity — the radiographic surrogate for how far the deltoid has been lengthened.',
      caveat: 'No validated safety cut-off. The change from the pre-operative film (or the other side) matters more than the absolute value — arm lengthening of 0–2 cm is the range usually recommended — and the value shrinks when the arm is abducted.',
      bands: [
        { upTo: 15, status: 'borderline', tag: 'Short', say: 'A short acromion–tuberosity distance for a reverse: little or no deltoid lengthening. Shoulders that ended up shortened elevated less, and the dislocating ones had less lengthening.' },
        { upTo: 38, status: 'info', tag: 'Typical', say: 'Within the usual spread after reverse arthroplasty (reported mean about 23 mm). No cut-off separates good from bad in this range.' },
        { status: 'info', tag: 'Above 38 mm', say: 'Above 38 mm — the distance that predicted at least 135° of active elevation in one series. It is a marker of deltoid tension, not a safety limit: check it against the pre-operative film, because fracture cases showed a larger change in this distance than controls.' },
      ],
      draw: ({ L }) => [shape.dim(L.acu, L.gts)],
    },
    {
      id: 'gtLat', label: 'Tuberosity lateral to acromion', unit: 'mm', group: G_LAT, scale: true,
      needs: ['acr', 'gtl'],
      compute: (ctx) => dot(sub(ctx.L.gtl, ctx.L.acr), lateral(ctx)) * ctx.mm,
      gauge: { min: -20, max: 30 }, evidence: 'descriptive', refs: ['werthel2019'],
      what: 'Horizontal distance from the lateral edge of the acromion to the lateral edge of the greater tuberosity; positive when the tuberosity lies lateral to the acromion. A direct read-out of deltoid wrap.',
      caveat: 'Descriptive; depends on acromial shape and arm rotation. No published target.',
      bands: [
        { upTo: 0, status: 'info', tag: 'Medial to acromion', say: 'The tuberosity lies medial to the acromial edge: the deltoid runs straight down with no wrap around the tuberosity.' },
        { status: 'info', tag: 'Lateral to acromion', say: 'The tuberosity lies lateral to the acromial edge, so the deltoid wraps around it.' },
      ],
      draw: (ctx) => {
        const { acr, gtl } = ctx.L;
        const foot = { x: gtl.x, y: acr.y };
        return [shape.dim(acr, foot), shape.line(foot, gtl, { dash: true })];
      },
    },
    {
      id: 'lho', label: 'Lateral humeral offset (centre of rotation → tuberosity)', unit: 'mm', group: G_LAT, scale: true,
      needs: ['gs', 'gtl'],
      compute: (ctx) => dot(sub(ctx.L.gtl, C(ctx.L.gs)), lateral(ctx)) * ctx.mm,
      gauge: { min: 20, max: 70 }, evidence: 'descriptive', refs: ['werthel2019'],
      what: 'Horizontal distance from the centre of rotation (glenosphere centre) to the lateral edge of the greater tuberosity — the lateral offset contributed by the humeral side plus the glenosphere radius.',
      caveat: 'Descriptive; varies with arm rotation and abduction.',
      bands: [{ status: 'info', tag: '', say: 'Reported for the record and for comparison between films; there is no validated target.' }],
      draw: (ctx) => {
        const c = C(ctx.L.gs), foot = { x: ctx.L.gtl.x, y: c.y };
        return [shape.dim(c, foot), shape.line(foot, ctx.L.gtl, { dash: true })];
      },
    },
    {
      id: 'corLat', label: 'Centre of rotation lateral to glenoid face', unit: 'mm', group: G_LAT, scale: true,
      needs: ['gs', 'sgt', 'igr'],
      compute: (ctx) => {
        const g = glenoidLine(ctx);
        return signedDistToLine(C(ctx.L.gs), g.a, g.b, lateral(ctx)) * ctx.mm;
      },
      gauge: { min: -5, max: 15 }, evidence: 'descriptive', refs: ['werthel2019', 'jobin2012'],
      what: 'Perpendicular distance from the glenosphere centre to the line joining the superior and inferior bony glenoid rim; positive = lateral to the bone. Grammont-style glenospheres put the centre of rotation at the bone; lateralised glenospheres, augments or bone grafts move it out.',
      caveat: 'The rim line is a 2D stand-in for the reamed glenoid surface; reaming depth and rim osteophytes shift it by a few millimetres.',
      bands: [
        { upTo: 3, status: 'info', tag: 'Medialised glenoid', say: 'The centre of rotation is at the glenoid bone, as in a Grammont-style construct: lowest shear on the baseplate, least deltoid wrap, highest notching exposure.' },
        { status: 'info', tag: 'Lateralised glenoid', say: 'The centre of rotation is lateral to the glenoid bone (lateralised glenosphere, augment or graft): more wrap and impingement-free rotation, at the cost of more shear across the baseplate.' },
      ],
      draw: (ctx) => {
        const g = glenoidLine(ctx);
        const c = C(ctx.L.gs);
        return [shape.ray(g.a, g.b, { dash: true }), shape.dim(projectOnLine(c, g.a, g.b), c)];
      },
    },

    {
      id: 'dma', label: 'Deltoid moment arm (centre of rotation → tuberosity)', unit: 'mm', group: G_DELT, scale: true,
      needs: ['gs', 'gtl'],
      compute: (ctx) => dist(C(ctx.L.gs), ctx.L.gtl) * ctx.mm,
      gauge: { min: 30, max: 70 }, evidence: 'descriptive', refs: ['rhee2025', 'werthel2019'],
      what: 'Straight distance from the centre of rotation (glenosphere centre) to the most lateral point of the greater tuberosity, as defined by Rhee et al. — the lever through which the middle deltoid wraps over the tuberosity.',
      caveat: 'Descriptive: post-operative means were 52–54 mm in a series of reverse arthroplasties, with no cut-off tied to outcome. The classic biomechanical moment arm (perpendicular from the centre of rotation to the deltoid line of action) is not the same quantity. Changes with arm rotation and abduction.',
      bands: [
        { upTo: 45, status: 'info', tag: 'Short', say: 'Shorter than the 52–54 mm averages reported after reverse arthroplasty: a medial humerus or a small glenosphere, with less deltoid wrap.' },
        { upTo: 60, status: 'info', tag: 'Typical', say: 'Within the spread reported after reverse arthroplasty (means 52–54 mm, SD about 4 mm).' },
        { status: 'info', tag: 'Long', say: 'Longer than usual after reverse arthroplasty: a lateralised humerus or glenosphere.' },
      ],
      draw: (ctx) => [shape.dim(C(ctx.L.gs), ctx.L.gtl)],
    },
    {
      id: 'dwa', label: 'Deltoid wrapping angle', unit: '°', group: G_DELT,
      needs: ['acr', 'gtl', 'dtu'],
      compute: ({ L }) => angleAt(L.acr, L.gtl, L.dtu),
      gauge: { min: 130, max: 180 }, evidence: 'descriptive', refs: ['rhee2025'],
      what: 'Angle at the most lateral point of the greater tuberosity between the line to the lateral tip of the acromion and the line to the midpoint of the deltoid tuberosity: the path of the middle deltoid as it wraps around the tuberosity. 180° = a straight deltoid with no wrap; the smaller the angle, the more wrap.',
      caveat: 'Descriptive: post-operative means 159–161° (SD 7–10°) in one series. The deltoid tuberosity must be on the film, which needs a longer cassette than many shoulder views.',
      bands: [
        { upTo: 150, status: 'info', tag: 'Marked wrap', say: 'More wrap than the averages reported after reverse arthroplasty (159–161°): the tuberosity stands well lateral to the line of the deltoid.' },
        { upTo: 170, status: 'info', tag: 'Typical', say: 'Within the spread reported after reverse arthroplasty (means 159–161°).' },
        { status: 'info', tag: 'Little wrap', say: 'The deltoid runs almost straight past the tuberosity: little wrap, as with a medialised humerus.' },
      ],
      draw: ({ L }) => [shape.line(L.gtl, L.acr), shape.line(L.gtl, L.dtu), shape.arc(L.gtl, L.acr, L.dtu)],
    },

    {
      id: 'tilt', label: 'Glenosphere inclination', unit: '°', group: G_GLEN,
      needs: ['face', 'ssf'],
      compute: (ctx) => tiltVsFossa(ctx.L.face, ctx.L.ssf, ctx),
      format: (v) => (Math.abs(v) < 0.05 ? '0.0° (neutral)' : `${Math.abs(v).toFixed(1)}° ${v > 0 ? 'superior' : 'inferior'} tilt`),
      target: 'neutral to 10° inferior', gauge: { min: -30, max: 30 }, evidence: 'pragmatic', refs: ['boileau2019', 'maurer2012', 'levigne2011', 'tashjian2018', 'bechtold2021', 'patel2021'],
      what: 'Tilt of the glenosphere back face relative to the perpendicular to the supraspinatus fossa floor (the reference of the β-angle and of Boileau\'s RSA angle). 0° = neutral; superior tilt means the glenosphere looks upward.',
      caveat: 'Radiographic inclination is reproducible to roughly ±5°. The direction of risk (superior tilt) is supported; the cut-offs used here are pragmatic, and studies disagree on whether tilt predicts instability.',
      bands: [
        { upTo: -15, status: 'borderline', tag: 'Marked inferior tilt', say: 'More than 15° of inferior tilt. Inferior tilt is the safer direction, but this much usually means heavy inferior reaming, and in simulation 10° of inferior tilt increased inferior impingement — check seating and notching.' },
        { upTo: 5, status: 'good', tag: 'Neutral / inferior', say: 'Neutral to inferior tilt — the orientation generally aimed for, converting shear into compression at the baseplate.' },
        { upTo: 10, status: 'borderline', tag: 'Mild superior tilt', say: 'A few degrees of superior tilt — within measurement error of neutral, but on the unfavourable side.' },
        { status: 'out', tag: 'Superior tilt', say: 'Superior tilt of 10° or more. Superior tilt and a cranial glenosphere were the positions linked to notching in the largest notching series, and baseplate inclination was associated with instability in one clinical series — another found no effect.' },
      ],
      draw: (ctx) => {
        const f = supInf(ctx.L.face);
        const m = mid(f.a, f.b);
        return [shape.ray(ctx.L.ssf.a, ctx.L.ssf.b, { dash: true }), shape.line(f.a, f.b), shape.line(m, add(m, mul(lateralNormal(f, ctx), dist(f.a, f.b) * 0.8)))];
      },
    },
    {
      id: 'overhang', label: 'Inferior glenosphere overhang', unit: 'mm', group: G_GLEN, scale: true,
      needs: ['gs', 'face', 'igr'],
      compute: (ctx) => dot(sub(glenosphereInferiorEdge(ctx), ctx.L.igr), faceInferior(ctx)) * ctx.mm,
      target: '≥ 3.5 mm', gauge: { min: -6, max: 12 }, evidence: 'published', refs: ['collotte2021', 'levigne2011', 'dewilde2010', 'nyffeler2005', 'simovitch2007'],
      what: 'How far the glenosphere extends below the inferior bony glenoid rim, measured along the glenosphere back face. Negative = the glenosphere sits above the rim.',
      caveat: 'The cut-off comes from 155° Grammont-style implants, where notching is commonest; lateralised 135° designs tolerate less overhang. An existing notch or osteophyte makes the rim hard to place.',
      bands: [
        { upTo: 0, status: 'out', tag: 'High-riding', say: 'The glenosphere sits above the inferior glenoid rim, leaving bone exposed to the humeral liner — the configuration with the highest rate of scapular notching.' },
        { upTo: 3.5, status: 'borderline', tag: 'Flush / small', say: 'Flush or under 3.5 mm of overhang. Most of the mechanical benefit comes in the first 2 mm, but the long-term series that showed less notching used at least 3.5 mm.' },
        { status: 'good', tag: 'Adequate', say: 'At least 3.5 mm of inferior overhang — the amount associated with less scapular notching at long-term follow-up (37% against 82% for flush glenospheres).' },
      ],
      draw: (ctx) => {
        const e = glenosphereInferiorEdge(ctx), d = faceInferior(ctx);
        const foot = add(e, mul(d, -dot(sub(e, ctx.L.igr), d)));
        return [shape.dim(foot, e), shape.line(ctx.L.igr, foot, { dash: true })];
      },
    },
    {
      id: 'corInf', label: 'Centre of rotation below glenoid centre', unit: 'mm', group: G_GLEN, scale: true,
      needs: ['gs', 'sgt', 'igr'],
      compute: (ctx) => {
        const g = glenoidLine(ctx);
        return dot(sub(C(ctx.L.gs), mid(g.a, g.b)), unit(sub(g.b, g.a))) * ctx.mm;
      },
      gauge: { min: -10, max: 15 }, evidence: 'descriptive', refs: ['nyffeler2005'],
      what: 'Position of the glenosphere centre along the glenoid, relative to the midpoint between the superior and inferior rim; positive = inferior placement.',
      caveat: 'Descriptive. Inferior placement is the established way to gain overhang and impingement-free adduction.',
      bands: [
        { upTo: 0, status: 'borderline', tag: 'Superior half', say: 'The glenosphere is centred in the upper half of the glenoid — the position associated with inferior impingement and notching.' },
        { status: 'info', tag: 'Inferior half', say: 'The glenosphere is centred in the lower half of the glenoid, as intended for a reverse.' },
      ],
    },
    {
      id: 'gsApparent', label: 'Glenosphere diameter at image scale', unit: 'mm', group: G_GLEN,
      needs: ['gs'],
      compute: (ctx) => (ctx.dicomMm > 0 ? 2 * ctx.L.gs.r * ctx.dicomMm : NaN),
      evidence: 'descriptive',
      what: 'Diameter of the fitted glenosphere circle using the pixel spacing stored in the image. Compared with the true implant size it gives the magnification of the film.',
      caveat: 'Only shown when the image carries a pixel spacing.',
      bands: [{ status: 'info', tag: '', say: (v, ctx) => (ctx.nominal > 0
        ? `The stored pixel spacing makes the ${ctx.nominal} mm glenosphere measure ${v.toFixed(1)} mm: a magnification of ${(v / ctx.nominal * 100 - 100).toFixed(0)}%. Distances are scaled to the implant, not to the stored spacing.`
        : 'Enter the true glenosphere size to remove film magnification from every distance.') }],
    },

    {
      id: 'stemAlign', label: 'Stem alignment', unit: '°', group: G_HUM,
      needs: ['stem', 'canalM', 'canalD'],
      compute: (ctx) => varusAngle(ctx.L.stem, shaftAxis(ctx.L.canalM, ctx.L.canalD), ctx),
      format: (v) => (Math.abs(v) < 0.5 ? `${Math.abs(v).toFixed(1)}° (neutral)` : `${Math.abs(v).toFixed(1)}° ${v > 0 ? 'varus' : 'valgus'}`),
      target: 'within 5° of the shaft axis', gauge: { min: -15, max: 15 }, evidence: 'published', refs: ['abdic2021'],
      what: 'Angle between the stem axis and the humeral shaft axis (the line through the midpoints of the two canal-width lines). Varus = stem tip towards the lateral cortex.',
      caveat: 'More than 5° is the usual radiographic definition of malalignment; its clinical weight for a reverse is uncertain.',
      bands: [
        { upTo: -5, status: 'borderline', tag: 'Valgus', say: 'More than 5° of valgus: the tip leans on the medial cortex. Meets the usual definition of malalignment; mainly a stress-riser and stress-shielding consideration.' },
        { upTo: 5.0001, status: 'good', tag: 'Aligned', say: 'Within 5° of the shaft axis.' },
        { status: 'borderline', tag: 'Varus', say: 'More than 5° of varus: the tip leans on the lateral cortex. Meets the usual definition of malalignment; mainly a stress-riser and stress-shielding consideration.' },
      ],
      draw: (ctx) => {
        const s = shaftAxis(ctx.L.canalM, ctx.L.canalD), t = proxDist(ctx.L.stem);
        return [shape.ray(s.a, s.b, { dash: true }), shape.line(t.a, t.b)];
      },
    },
    fillingRatio('frM', 'Filling ratio — metaphysis', 'stemM', 'canalM'),
    fillingRatio('frD', 'Filling ratio — near tip', 'stemD', 'canalD'),
    ...postureMetrics(['stem']),
  ],

  findings: [
    {
      id: 'notching', label: 'Scapular notching (Sirveaux)', group: G_GLEN, refs: ['sirveaux2004'],
      help: 'Erosion of the scapular pillar under the glenosphere.',
      options: [
        { v: '0', label: 'Grade 0 — none', status: 'good', say: 'No scapular notching.' },
        { v: '1', label: 'Grade 1 — confined to the pillar', status: 'borderline', say: 'Grade 1 notching, confined to the scapular pillar. Common and usually stable; note it as the baseline.' },
        { v: '2', label: 'Grade 2 — reaches the inferior screw', status: 'borderline', say: 'Grade 2 notching, reaching the inferior screw. Follow for progression.' },
        { v: '3', label: 'Grade 3 — extends over the inferior screw', status: 'out', say: 'Grade 3 notching, extending over the inferior screw. Higher grades have been associated with poorer scores and with radiolucency around the baseplate.' },
        { v: '4', label: 'Grade 4 — reaches the central peg', status: 'out', say: 'Grade 4 notching, extending under the baseplate to the central peg — the baseplate\'s inferior support is being lost.' },
      ],
    },
    {
      id: 'baseplate', label: 'Baseplate fixation', group: G_GLEN, refs: ['sirveaux2004'],
      help: 'Lucency around the baseplate, post and screws; screw breakage; change in baseplate position.',
      options: [
        { v: 'ok', label: 'No lucency, screws intact', status: 'good', say: 'No lucency around the baseplate and intact screws.' },
        { v: 'lucent', label: 'Incomplete lucent line', status: 'borderline', say: 'An incomplete lucent line around the baseplate or a screw — not loosening by itself; compare with the next film.' },
        { v: 'loose', label: 'Complete lucency, broken screw or shift', status: 'out', say: 'Complete lucency, a broken screw or a change in baseplate position — radiographic signs of baseplate loosening.' },
      ],
    },
    ...STEM_FINDINGS,
    {
      id: 'acromion', label: 'Acromion / scapular spine fracture', group: 'Complications', refs: ['levy2013', 'crosby2011'],
      help: 'Look along the whole acromion and scapular spine; compare acromial tilt with earlier films.',
      options: [
        { v: 'none', label: 'None seen', status: 'good', say: 'No acromial or scapular spine fracture seen on this view (an AP film misses some; a persistent lateral shoulder pain warrants CT).' },
        { v: 'I', label: 'Levy type I — anterior/mid acromion', status: 'out', say: 'Acromial fracture, Levy type I (anterior and middle deltoid origin).' },
        { v: 'II', label: 'Levy type II — whole middle deltoid origin', status: 'out', say: 'Acromial fracture, Levy type II (entire middle deltoid origin, part of the posterior).' },
        { v: 'III', label: 'Levy type III — scapular spine', status: 'out', say: 'Scapular spine fracture, Levy type III (middle and posterior deltoid origin) — the type with the worst functional outlook.' },
      ],
    },
    {
      id: 'instability', label: 'Dislocation / component dissociation', group: 'Complications', refs: [],
      options: [
        { v: 'no', label: 'Reduced, components assembled', status: 'good', say: 'The joint is reduced and the components are assembled.' },
        { v: 'yes', label: 'Dislocated or dissociated', status: 'out', say: 'The joint is dislocated or a component has dissociated.' },
      ],
    },
    {
      id: 'ho', label: 'Heterotopic ossification / inferior spur', group: 'Complications', refs: [],
      options: [
        { v: 'none', label: 'None', status: 'good', say: 'No heterotopic ossification.' },
        { v: 'small', label: 'Small spur or islands', status: 'info', say: 'Small inferior spur or islands of heterotopic bone — frequent after reverse arthroplasty and usually of no consequence.' },
        { v: 'large', label: 'Large or bridging', status: 'borderline', say: 'Large or bridging heterotopic ossification — can limit motion.' },
      ],
    },
  ],

  synthesis(m) {
    const out = [];
    const lsa = m.lsa, dsa = m.dsa;
    if (lsa.status !== 'pending' && dsa.status !== 'pending') {
      const word = (r, lo, hi) => (r.value < lo ? 'low' : r.value > hi ? 'high' : 'in range');
      const l = word(lsa, 75, 95), d = word(dsa, 40, 65);
      let text, status = 'good';
      if (l === 'in range' && d === 'in range') {
        text = `Lateralisation (LSA ${lsa.text}) and distalisation (DSA ${dsa.text}) are both inside the ranges associated with the best active motion.`;
      } else {
        status = [lsa.status, dsa.status].includes('out') ? 'out' : 'borderline';
        const bits = [];
        if (l !== 'in range') bits.push(`lateralisation is ${l} (LSA ${lsa.text}, target 75–95°)`);
        else bits.push(`lateralisation is in range (LSA ${lsa.text})`);
        if (d !== 'in range') bits.push(`distalisation is ${d} (DSA ${dsa.text}, target 40–65°)`);
        else bits.push(`distalisation is in range (DSA ${dsa.text})`);
        text = `${bits.join(' and ')}.`;
        text = text[0].toUpperCase() + text.slice(1);
        if (l === 'low' && d === 'low') text += ' A construct that is both medial and short leaves the deltoid slack — the combination to worry about for instability and weak elevation.';
        if (l === 'high' && d === 'high') text += ' A construct that is both lateral and long loads the acromion and the soft tissues from two directions.';
      }
      text += ' Both bands come from a single series of 46 shoulders that larger series have not reproduced, so weigh them accordingly.';
      out.push({ title: 'Lateralisation and distalisation together', status, text });
    }
    if (m.overhang.status !== 'pending' && m.tilt.status !== 'pending') {
      const bad = m.overhang.value < 0 && m.tilt.value >= 5;
      if (bad) out.push({ title: 'Glenosphere position', status: 'out', text: 'The glenosphere is both high on the glenoid and tilted superiorly — each on its own exposes the scapular pillar to the liner; together they are the classic recipe for inferior impingement and notching.' });
    }
    return out;
  },

  caveats() {
    return [
      'All of this assumes a true AP (Grashey) view with the arm at the side in neutral rotation. Abduction, rotation or an oblique beam change the LSA, DSA and every distance.',
      'A single radiograph cannot show version, posterior or anterior overhang, or humeral retroversion. Use CT for those.',
    ];
  },
};

function fillingRatio(id, label, stemId, canalId) {
  return {
    id, label, unit: 'ratio', group: G_HUM,
    needs: [stemId, canalId],
    compute: ({ L }) => dist(L[stemId].a, L[stemId].b) / dist(L[canalId].a, L[canalId].b),
    target: '< 0.7', gauge: { min: 0.3, max: 1 }, evidence: 'published', refs: ['kramer2024', 'schnetzke2016', 'raiss2019'],
    what: 'Stem width divided by the inner canal width at the same level. A stem that fills the canal carries the load past the metaphysis.',
    caveat: 'Cut-offs come from uncemented short stems; they do not apply to cemented stems.',
    bands: [
      { upTo: 0.7, status: 'good', tag: 'Below 0.7', say: 'Below the 0.7 filling ratio above which proximal stress shielding became more frequent with uncemented stems.' },
      { status: 'borderline', tag: '≥ 0.7', say: 'At or above 0.7 — the cut-off above which uncemented stems showed more proximal stress shielding. A risk factor for bone resorption, not a complication in itself: watch the calcar and tuberosities on follow-up films.' },
    ],
    draw: ({ L }) => [shape.line(L[canalId].a, L[canalId].b, { dash: true }), shape.line(L[stemId].a, L[stemId].b)],
  };
}

// UP is re-exported for tests that want the convention.
export { UP };
