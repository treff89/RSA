// Pyrocarbon (or any) humeral head hemiarthroplasty — true AP radiograph. Centred on the overstuffing question.
import { shape } from '../core.js';
import { signedDistToLine, projectOnLine } from '../geom.js';
import {
  C, HELP, STEM_FINDINGS, lateral, supInf, shaftAxis, varusAngle, proxDist, anatomicCircle,
  sub, add, mul, dot, unit, dist,
} from './xray-common.js';

const G_OVER = 'Head size & position (overstuffing)';
const G_JOINT = 'Joint';
const G_HUM = 'Stem';

/** Humeral axis pointing distal: shaft axis if the canal lines exist, else the stem axis, else image vertical. */
export function humeralAxis(ctx) {
  const { canalM, canalD, stem } = ctx.L;
  if (canalM && canalD) return shaftAxis(canalM, canalD).dir;
  if (stem) { const t = proxDist(stem); return unit(sub(t.b, t.a)); }
  return { x: 0, y: 1 };
}

/** Deviation of the prosthetic head centre from the anatomic (best-fit) centre, in the humeral frame (px). */
export function corDeviation(ctx) {
  const anat = anatomicCircle(ctx);
  if (!anat) return null;
  const d = sub(C(ctx.L.head), { x: anat.cx, y: anat.cy });
  const ax = humeralAxis(ctx);
  let med = { x: -ax.y, y: ax.x };
  if (dot(med, lateral(ctx)) > 0) med = mul(med, -1);
  return { anat, total: Math.hypot(d.x, d.y), medial: dot(d, med), superior: -dot(d, ax) };
}

const dirWords = (dev, mmPerPx) => {
  const parts = [];
  const m = dev.medial * mmPerPx, s = dev.superior * mmPerPx;
  if (Math.abs(m) >= 0.5) parts.push(`${Math.abs(m).toFixed(1)} mm ${m > 0 ? 'medial' : 'lateral'}`);
  if (Math.abs(s) >= 0.5) parts.push(`${Math.abs(s).toFixed(1)} mm ${s > 0 ? 'superior' : 'inferior'}`);
  return parts.join(', ');
};

export default {
  id: 'pyc-ap',
  title: 'Pyrocarbon hemiarthroplasty — AP radiograph',
  short: 'Hemi · AP',
  modality: 'xray',
  implant: 'pyc',
  view: 'ap',
  calibration: {
    landmark: 'head',
    label: 'Prosthetic head diameter',
    sizes: [37, 39, 40, 41, 42, 43, 44, 45, 46, 48, 50, 52, 54],
    hint: 'From the operation note or implant sticker. The head is a sphere segment, so its outline gives true scale whatever the projection.',
  },
  landmarks: [
    { id: 'head', kind: 'circle', label: 'Prosthetic head outline', group: 'Implant', help: 'Circle fitted to the articular surface of the prosthetic head.', auto: true },
    { id: 'stem', kind: 'line', label: 'Humeral stem axis', group: 'Implant', help: 'Centre line of the stem (leave out for a stemless implant).', auto: true, optional: true },
    { id: 'pcA', kind: 'point', label: 'Best-fit circle 1 — lateral cortex', group: 'Native anatomy', help: 'Lateral cortex of the greater tuberosity at its flare (where the tuberosity meets the shaft). First of three preserved landmarks that define the native head circle.' },
    { id: 'pcB', kind: 'point', label: 'Best-fit circle 2 — cuff footprint', group: 'Native anatomy', help: 'Medial edge of the rotator-cuff footprint on the greater tuberosity (the junction of tuberosity and head / implant collar).' },
    { id: 'pcC', kind: 'point', label: 'Best-fit circle 3 — medial calcar', group: 'Native anatomy', help: 'Medial calcar at the inferior end of the articular margin (where the neck cut meets the medial cortex).' },
    { id: 'gts', kind: 'point', label: 'Greater tuberosity — top', group: 'Native anatomy', help: HELP.gts },
    { id: 'acu', kind: 'point', label: 'Acromion undersurface', group: 'Scapula', help: HELP.acu },
    { id: 'sgt', kind: 'point', label: 'Superior glenoid rim', group: 'Scapula', help: HELP.sgt },
    { id: 'igr', kind: 'point', label: 'Inferior glenoid rim', group: 'Scapula', help: HELP.igr },
    { id: 'canalM', kind: 'line', label: 'Canal width — metaphysis', group: 'Stem fit', help: HELP.canalM, optional: true },
    { id: 'stemM', kind: 'line', label: 'Stem width — metaphysis', group: 'Stem fit', help: HELP.stemM, optional: true, auto: true },
    { id: 'canalD', kind: 'line', label: 'Canal width — near tip', group: 'Stem fit', help: HELP.canalD, optional: true },
    { id: 'stemD', kind: 'line', label: 'Stem width — near tip', group: 'Stem fit', help: HELP.stemD, optional: true, auto: true },
  ],

  metrics: [
    {
      id: 'corDev', label: 'Centre-of-rotation deviation from anatomic', unit: 'mm', group: G_OVER, scale: true,
      needs: ['head', 'pcA', 'pcB', 'pcC'],
      compute: (ctx) => { const d = corDeviation(ctx); return d ? d.total * ctx.mm : NaN; },
      format: (v, ctx) => { const d = corDeviation(ctx); const w = d ? dirWords(d, ctx.mm) : ''; return `${v.toFixed(1)} mm${w ? ` (${w})` : ''}`; },
      target: '≤ 3 mm', gauge: { min: 0, max: 10 }, evidence: 'published', refs: ['alolabi2014', 'cointat2022', 'geervliet2019', 'youderian2014'],
      what: 'Distance between the centre of the prosthetic head and the centre of the native head, reconstructed as the best-fit circle through three preserved landmarks (lateral tuberosity cortex, cuff footprint, medial calcar). The direction is given in the humeral frame.',
      caveat: 'The 3 mm limit was set by the authors of the method as a clinically significant outlier, not derived from outcomes; a pyrocarbon series later found worse function and more revisions beyond it, and a resurfacing series put its revision cut-off at 5.8 mm. Needs a true AP in neutral rotation: a rotated film can fake several millimetres of deviation.',
      bands: [
        { upTo: 3.0001, status: 'good', tag: 'Anatomic', say: 'The prosthetic centre of rotation is within 3 mm of the reconstructed native centre — the usual definition of an anatomic reconstruction (about 70% of pyrocarbon hemiarthroplasties achieved it in one series).' },
        { status: 'out', tag: 'Non-anatomic', say: (v, ctx) => {
          const d = corDeviation(ctx);
          const over = d && (d.medial * ctx.mm > 1.5 || d.superior * ctx.mm > 1.5);
          return `The prosthetic centre of rotation is more than 3 mm from the reconstructed native centre${d ? ` (${dirWords(d, ctx.mm)})` : ''}. ` + (over
            ? 'A centre displaced medially or superiorly means the articular surface stands proud of where the native one was — the geometry of an overstuffed joint.'
            : 'The displacement is not in the medial/superior direction, so it points to a low or lateral head rather than overstuffing.');
        } },
      ],
      draw: (ctx) => {
        const d = corDeviation(ctx);
        if (!d) return [];
        const a = { x: d.anat.cx, y: d.anat.cy };
        return [shape.circle(a, d.anat.r, { dash: true }), shape.dim(a, C(ctx.L.head))];
      },
    },
    {
      id: 'headSize', label: 'Head diameter vs native best-fit circle', unit: 'mm', group: G_OVER, scale: true,
      needs: ['head', 'pcA', 'pcB', 'pcC'],
      compute: (ctx) => { const a = anatomicCircle(ctx); return a ? 2 * (ctx.L.head.r - a.r) * ctx.mm : NaN; },
      format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} mm`,
      target: 'within ±4 mm', gauge: { min: -10, max: 10 }, evidence: 'pragmatic', refs: ['boileau2026', 'youderian2014', 'iannotti1992', 'harryman1995'],
      what: 'Prosthetic head diameter minus the diameter of the native best-fit circle. Positive = the implant curves on a larger circle than the native head did.',
      caveat: 'The ±4 mm band is pragmatic (one or two head sizes; native head radius is 24 ± 2 mm). The published series define oversizing in their own ways, so use this as a flag, not a diagnosis.',
      bands: [
        { upTo: -4, status: 'borderline', tag: 'Smaller', say: 'The head curves on a clearly smaller circle than the native head — undersized, which trades stuffing for a smaller contact area and less cuff tension.' },
        { upTo: 4.0001, status: 'good', tag: 'Matched', say: 'The head diameter matches the native best-fit circle to within one or two sizes.' },
        { status: 'borderline', tag: 'Larger', say: 'The head curves on a clearly larger circle than the native head. Oversizing is what matters most with pyrocarbon: in the largest series an oversized head carried about 3.5 times the odds of glenoid erosion and a revision rate of 25% against 1.3%.' },
      ],
    },
    {
      id: 'hh', label: 'Head height above greater tuberosity', unit: 'mm', group: G_OVER, scale: true,
      needs: ['head', 'gts'],
      compute: (ctx) => {
        const ax = humeralAxis(ctx);
        const apex = add(C(ctx.L.head), mul(ax, -ctx.L.head.r));
        return dot(sub(ctx.L.gts, apex), ax) * ctx.mm;
      },
      target: '5–11 mm', gauge: { min: -5, max: 20 }, evidence: 'descriptive', refs: ['iannotti1992', 'nyffeler2004'],
      what: 'Distance, along the humeral axis, from the top of the prosthetic head down to the top of the greater tuberosity. In native shoulders the head stands about 8 mm (SD 3) above the tuberosity.',
      caveat: 'The bands are the native mean ± 1 and ± 2 SD, not outcome-derived cut-offs. External rotation of the arm hides the tuberosity and inflates the value.',
      bands: [
        { upTo: 2, status: 'out', tag: 'Head low', say: 'The head barely clears, or sits below, the greater tuberosity: the tuberosity will meet the acromion before the head does, and the cuff lever arm is shortened.' },
        { upTo: 5, status: 'borderline', tag: 'Slightly low', say: 'The head stands lower over the tuberosity than in most native shoulders.' },
        { upTo: 11.0001, status: 'good', tag: 'Anatomic', say: 'The head stands above the tuberosity by an anatomic amount.' },
        { upTo: 14.5, status: 'borderline', tag: 'Slightly high', say: 'The head stands higher over the tuberosity than in most native shoulders — a proud stem or a thick head.' },
        { status: 'out', tag: 'Head high', say: 'The head stands far above the tuberosity. In cadaveric work a head set 5 mm too high cost 10° of abduction and 10 mm cost 16°, and it tightens the superior cuff.' },
      ],
      draw: (ctx) => {
        const ax = humeralAxis(ctx);
        const apex = add(C(ctx.L.head), mul(ax, -ctx.L.head.r));
        const foot = add(apex, mul(ax, dot(sub(ctx.L.gts, apex), ax)));
        return [shape.dim(apex, foot), shape.line(foot, ctx.L.gts, { dash: true })];
      },
    },
    {
      id: 'medOff', label: 'Head centre medial to shaft axis', unit: 'mm', group: G_OVER, scale: true,
      needs: ['head', 'canalM', 'canalD'],
      compute: (ctx) => {
        const s = shaftAxis(ctx.L.canalM, ctx.L.canalD);
        return -signedDistToLine(C(ctx.L.head), s.a, s.b, lateral(ctx)) * ctx.mm;
      },
      gauge: { min: -5, max: 20 }, evidence: 'descriptive', refs: ['boileau1997'],
      what: 'Perpendicular distance from the head centre to the humeral shaft axis; positive = medial. The native head centre lies about 7 mm medial to the canal axis.',
      caveat: 'Descriptive. Depends on the two canal-width lines defining the shaft axis well.',
      bands: [{ status: 'info', tag: '', say: 'Compare with the native average of about 7 mm (range roughly 3–11 mm). A much larger medial offset means the head has been pushed towards the glenoid.' }],
    },

    {
      id: 'ahd', label: 'Acromiohumeral distance', unit: 'mm', group: G_JOINT, scale: true,
      needs: ['acu', 'head'],
      compute: (ctx) => (dist(ctx.L.acu, C(ctx.L.head)) - ctx.L.head.r) * ctx.mm,
      target: '≥ 7 mm', gauge: { min: 0, max: 16 }, evidence: 'published', refs: ['saupe2006', 'goutallier2011'],
      what: 'Shortest distance from the undersurface of the acromion to the prosthetic head.',
      caveat: 'The 7 mm cut-off is from native shoulders. After a hemiarthroplasty, a value that falls between films is more telling than the number itself.',
      bands: [
        { upTo: 5, status: 'out', tag: 'Superior migration', say: 'The head has migrated up under the acromion. After a hemiarthroplasty this means the superior cuff is not holding the head down — cuff failure or superior glenoid erosion.' },
        { upTo: 7, status: 'borderline', tag: 'Narrowed', say: 'The subacromial space is narrowed (under 7 mm): early superior migration, or a head set too high.' },
        { status: 'good', tag: 'Maintained', say: 'The subacromial space is maintained.' },
      ],
      draw: (ctx) => {
        const c = C(ctx.L.head);
        const u = unit(sub(ctx.L.acu, c));
        return [shape.dim(add(c, mul(u, ctx.L.head.r)), ctx.L.acu)];
      },
    },
    {
      id: 'glenMed', label: 'Head medial to glenoid rim line', unit: 'mm', group: G_JOINT, scale: true,
      needs: ['head', 'sgt', 'igr'],
      compute: (ctx) => {
        const g = supInf({ a: ctx.L.sgt, b: ctx.L.igr });
        return (ctx.L.head.r - signedDistToLine(C(ctx.L.head), g.a, g.b, lateral(ctx))) * ctx.mm;
      },
      gauge: { min: -5, max: 15 }, evidence: 'descriptive', refs: ['garret2024', 'schippers2026', 'griswold2025'],
      what: 'How far the head surface lies medial to the line joining the superior and inferior glenoid rim. It grows as the head erodes into the glenoid.',
      caveat: 'No normal value: a native glenoid is a few millimetres deep to begin with. Useful only for comparison between films taken the same way.',
      bands: [{ status: 'info', tag: '', say: 'Record it and compare with the next film: an increase is medial glenoid erosion. At six years one pyrocarbon series graded erosion moderate in 24% and severe in 8%, with few revisions for it.' }],
      draw: (ctx) => {
        const g = supInf({ a: ctx.L.sgt, b: ctx.L.igr });
        const c = C(ctx.L.head);
        const foot = projectOnLine(c, g.a, g.b);
        const u = unit(sub(foot, c));
        return [shape.ray(g.a, g.b, { dash: true }), shape.dim(foot, add(c, mul(u, ctx.L.head.r)))];
      },
    },

    {
      id: 'stemAlign', label: 'Stem alignment', unit: '°', group: G_HUM,
      needs: ['stem', 'canalM', 'canalD'],
      compute: (ctx) => varusAngle(ctx.L.stem, shaftAxis(ctx.L.canalM, ctx.L.canalD), ctx),
      format: (v) => (Math.abs(v) < 0.5 ? `${Math.abs(v).toFixed(1)}° (neutral)` : `${Math.abs(v).toFixed(1)}° ${v > 0 ? 'varus' : 'valgus'}`),
      target: 'within 5° of the shaft axis', gauge: { min: -15, max: 15 }, evidence: 'published', refs: ['abdic2021'],
      what: 'Angle between the stem axis and the humeral shaft axis. Varus = stem tip towards the lateral cortex.',
      caveat: 'In an anatomic hemiarthroplasty a varus stem lowers the head and a valgus stem raises it, so read this together with the head height.',
      bands: [
        { upTo: -5, status: 'borderline', tag: 'Valgus', say: 'More than 5° of valgus — this raises and medialises the head, adding to any overstuffing.' },
        { upTo: 5.0001, status: 'good', tag: 'Aligned', say: 'Within 5° of the shaft axis.' },
        { status: 'borderline', tag: 'Varus', say: 'More than 5° of varus — this lowers the head relative to the tuberosity.' },
      ],
      draw: (ctx) => {
        const s = shaftAxis(ctx.L.canalM, ctx.L.canalD), t = proxDist(ctx.L.stem);
        return [shape.ray(s.a, s.b, { dash: true }), shape.line(t.a, t.b)];
      },
    },
    {
      id: 'frM', label: 'Filling ratio — metaphysis', unit: 'ratio', group: G_HUM, needs: ['stemM', 'canalM'],
      compute: ({ L }) => dist(L.stemM.a, L.stemM.b) / dist(L.canalM.a, L.canalM.b),
      target: '< 0.7', gauge: { min: 0.3, max: 1 }, evidence: 'published', refs: ['kramer2024', 'schnetzke2016', 'raiss2019'],
      what: 'Stem width divided by the inner canal width at the metaphysis.',
      caveat: 'The cut-off comes from uncemented short stems.',
      bands: [
        { upTo: 0.7, status: 'good', tag: 'Below 0.7', say: 'Below the filling ratio above which proximal stress shielding became more frequent.' },
        { status: 'borderline', tag: '≥ 0.7', say: 'At or above 0.7 — a risk factor for proximal stress shielding with uncemented stems. Tuberosity thinning is a known finding after pyrocarbon hemiarthroplasty, so follow the tuberosities.' },
      ],
    },
    {
      id: 'frD', label: 'Filling ratio — near tip', unit: 'ratio', group: G_HUM, needs: ['stemD', 'canalD'],
      compute: ({ L }) => dist(L.stemD.a, L.stemD.b) / dist(L.canalD.a, L.canalD.b),
      target: '< 0.7', gauge: { min: 0.3, max: 1 }, evidence: 'published', refs: ['kramer2024', 'schnetzke2016', 'raiss2019'],
      what: 'Stem width divided by the inner canal width near the stem tip.',
      caveat: 'The cut-off comes from uncemented short stems.',
      bands: [
        { upTo: 0.7, status: 'good', tag: 'Below 0.7', say: 'Below the filling ratio above which proximal stress shielding became more frequent.' },
        { status: 'borderline', tag: '≥ 0.7', say: 'At or above 0.7 — a risk factor for proximal stress shielding with uncemented stems.' },
      ],
    },
  ],

  findings: [
    {
      id: 'glenoidErosion', label: 'Glenoid erosion (Sperling-type grading)', group: G_JOINT, refs: ['sperling2004', 'garret2024', 'boileau2026'],
      help: 'Compare with the first post-operative film.',
      options: [
        { v: 'none', label: 'None', status: 'good', say: 'No glenoid erosion.' },
        { v: 'mild', label: 'Mild — into subchondral bone', status: 'borderline', say: 'Mild glenoid erosion, into the subchondral bone. Common after hemiarthroplasty and usually silent; the question is whether it progresses.' },
        { v: 'moderate', label: 'Moderate — medialised, hemispheric deformation', status: 'out', say: 'Moderate glenoid erosion with medialisation of the head and hemispheric deformation of the glenoid.' },
        { v: 'severe', label: 'Severe — bone loss to the coracoid base', status: 'out', say: 'Severe glenoid erosion with bone loss up to the coracoid base — little bone stock left for a later glenoid component.' },
      ],
    },
    {
      id: 'tuberosity', label: 'Greater tuberosity', group: G_JOINT, refs: ['garret2019', 'pycReview2023'],
      options: [
        { v: 'normal', label: 'Normal thickness', status: 'good', say: 'The greater tuberosity has kept its thickness.' },
        { v: 'thin', label: 'Thinned', status: 'borderline', say: 'The greater tuberosity is thinned — reported in about one in ten pyrocarbon hemiarthroplasties in a pooled review; it weakens the cuff insertion and can precede fracture.' },
        { v: 'fracture', label: 'Fractured or resorbed', status: 'out', say: 'The greater tuberosity is fractured or resorbed — the superior and posterior cuff have lost their insertion.' },
      ],
    },
    ...STEM_FINDINGS,
  ],

  synthesis(m, f, ctx) {
    if (m.corDev.status === 'pending' && m.hh.status === 'pending') return [];
    const signs = [], against = [];
    const dev = m.corDev.status !== 'pending' ? corDeviation(ctx) : null;
    if (dev) {
      const proud = dev.medial * ctx.mm > 1.5 || dev.superior * ctx.mm > 1.5;
      if (m.corDev.value > 3 && proud) signs.push(`centre of rotation displaced ${m.corDev.text}`);
      else against.push(`centre of rotation ${m.corDev.value <= 3 ? 'within 3 mm of anatomic' : 'displaced, but not medially or superiorly'}`);
    }
    if (m.headSize.status !== 'pending') {
      if (m.headSize.value > 4) signs.push(`head ${m.headSize.text} larger in diameter than the native circle`);
      else against.push('head diameter not larger than the native circle');
    }
    if (m.hh.status !== 'pending') {
      if (m.hh.value > 11) signs.push(`head ${m.hh.text} above the tuberosity`);
      else against.push('head height over the tuberosity not increased');
    }
    const measured = signs.length + against.length;
    let status, text;
    if (signs.length >= 2) {
      status = 'out';
      text = `Radiographic picture consistent with overstuffing: ${signs.join('; ')}.`;
    } else if (signs.length === 1) {
      status = 'borderline';
      text = `One of ${measured} overstuffing sign${measured === 1 ? '' : 's'} is present (${signs[0]})${against.length ? `; against it: ${against.join('; ')}` : ''}. Equivocal.`;
    } else {
      status = 'good';
      text = `No radiographic sign of overstuffing on the ${measured} criteri${measured === 1 ? 'on' : 'a'} measured (${against.join('; ')}).`;
    }
    text += ' Be aware that experienced shoulder surgeons agree poorly with each other when judging overstuffing by eye on plain films (kappa about 0.25), and that no radiographic criterion has been prospectively validated against outcome. Stiffness, pain and progressive glenoid erosion decide whether it matters.';
    return [{ title: 'Overstuffing', status, text }];
  },

  caveats() {
    return [
      'The best-fit circle method assumes a true AP (Grashey) view in neutral rotation. If the tuberosity is not seen in profile, repeat the film rather than trust the numbers.',
      'Pyrocarbon is only moderately radiodense; make sure the circle follows the articular surface and not the metal neck or the graphite core.',
    ];
  },
};
