// Comparison of two radiographs of the same shoulder: an earlier film (pre-operative, or an earlier follow-up) and
// the current one. Pure functions over assessment bundles (see main.js assess()): { protocol, ctx, findings }.
//
// Quantities are recomputed from the landmarks of each film, so a pre-operative native film and a post-operative
// reverse film are compared on the same definitions. Distances need a common scale:
//   1. both films calibrated by their implant           → millimetres
//   2. one calibrated, glenoid height on both           → the calibrated film's glenoid height rescales the other
//   3. both carry a pixel spacing                       → millimetres, including film magnification
//   4. glenoid height on both, no calibration           → percent of glenoid height
// otherwise distances are not compared. Angles and Schippers' ratios need no scale.
import { angleAt, signedDistToLine } from './geom.js';
import { bandFor } from './core.js';
import { C, sub, dot, unit, dist, lateral, supInf, tiltVsFossa, hara, shara, humeralLine, varusAngle, shaftAxis } from './protocols/xray-common.js';
import { schippers } from './protocols/pyc-ap.js';
import { neutralise, SHARA_NEUTRAL } from './neutral.js';

const fmtSigned = (v, unit, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}${unit === '°' ? '°' : unit === '%' ? '%' : ` ${unit}`}`;
const fmtVal = (v, unit, d = 1) => `${v.toFixed(d)}${unit === '°' ? '°' : unit === '%' ? '%' : ` ${unit}`}`;

/** Common scale for two films. Returns { mode, unit, f: [k0, k1] (multiply px), text }. */
export function commonScale(e, c) {
  const gh = (b) => (b.ctx.L.sgt && b.ctx.L.igr ? dist(b.ctx.L.sgt, b.ctx.L.igr) : null);
  const H = [gh(e), gh(c)];
  const cal = [e, c].map((b) => (b.ctx.mm > 0 && b.ctx.mmSource === 'implant' ? b.ctx.mm : null));
  const any = [e, c].map((b) => (b.ctx.mm > 0 ? b.ctx.mm : null));
  if (cal[0] && cal[1]) return { mode: 'implant', unit: 'mm', f: cal, text: 'Distances in mm (both films calibrated by their implant).' };
  if ((cal[0] || cal[1]) && H[0] && H[1]) {
    const i = cal[0] ? 0 : 1, j = 1 - i;
    const f = [0, 0];
    f[i] = cal[i]; f[j] = (H[i] * cal[i]) / H[j];
    return { mode: 'glenoid', unit: 'mm', f, text: `Distances in mm: the ${i === 0 ? 'later' : 'earlier'} film is scaled to the calibrated one by glenoid height (±5%).` };
  }
  if (any[0] && any[1]) {
    return { mode: 'pixel', unit: 'mm', f: any, text: 'Distances in mm from each film\'s pixel size (includes film magnification).' };
  }
  if (H[0] && H[1]) return { mode: 'relative', unit: '% GH', f: [100 / H[0], 100 / H[1]], text: 'Not calibrated: distances as % of glenoid height. Enter the implant size for mm.' };
  return { mode: 'none', unit: '', f: null, text: 'No common scale: distances not compared.' };
}

// ── quantities, each computed on one film from its landmarks; null when not available ──
const L = (b) => b.ctx.L;
// centre of rotation: the glenosphere centre of a reverse, the head centre otherwise
const cor = (b) => (L(b).gs ? C(L(b).gs) : b.protocol.implant !== 'reverse' && L(b).head ? C(L(b).head) : null);
const glenoid = (b) => (L(b).sgt && L(b).igr ? supInf({ a: L(b).sgt, b: L(b).igr }) : null);

const Q = {
  glo: { label: 'Global lateral offset (glenoid line → tuberosity)', kind: 'dist', f: (b) => { const g = glenoid(b); return g && L(b).gtl ? signedDistToLine(L(b).gtl, g.a, g.b, lateral(b.ctx)) : null; } },
  dma: { label: 'Tuberosity to centre of rotation (deltoid moment arm)', kind: 'dist', f: (b) => { const c = cor(b); return c && L(b).gtl ? dist(c, L(b).gtl) : null; } },
  deltL: { label: 'Acromion to deltoid tuberosity (deltoid length)', kind: 'dist', f: (b) => (L(b).acr && L(b).dtu ? dist(L(b).acr, L(b).dtu) : null) },
  atd: { label: 'Acromion–tuberosity distance', kind: 'dist', f: (b) => (L(b).acu && L(b).gts ? dist(L(b).acu, L(b).gts) : null) },
  gtLat: { label: 'Tuberosity lateral to acromion', kind: 'dist', f: (b) => (L(b).acr && L(b).gtl ? dot(sub(L(b).gtl, L(b).acr), lateral(b.ctx)) : null) },
  lsa: { label: 'Lateralisation shoulder angle (LSA)', kind: 'angle', f: (b) => (L(b).sgt && L(b).acr && L(b).gtl ? angleAt(L(b).sgt, L(b).acr, L(b).gtl) : null) },
  dsa: { label: 'Distalisation shoulder angle (DSA)', kind: 'angle', f: (b) => (L(b).sgt && L(b).acr && L(b).gts ? angleAt(L(b).acr, L(b).sgt, L(b).gts) : null) },
  hara: { label: 'Humeral abduction resting angle (HARA, as taken)', kind: 'angle', f: (b) => { const v = hara(b.ctx.raw || b.ctx); return Number.isFinite(v) ? v : null; } },
  tilt: { label: 'Glenosphere inclination (+ superior)', kind: 'angle', f: (b) => (L(b).face && L(b).ssf ? tiltVsFossa(L(b).face, L(b).ssf, b.ctx) : null) },
  corLat: { label: 'Centre of rotation lateral to glenoid', kind: 'dist', f: (b) => { const c = cor(b); if (!c || !L(b).sgt || !L(b).igr) return null; const g = supInf({ a: L(b).sgt, b: L(b).igr }); return signedDistToLine(c, g.a, g.b, lateral(b.ctx)); } },
  corInf: { label: 'Centre of rotation below glenoid centre', kind: 'dist', f: (b) => { const c = cor(b); if (!c || !L(b).sgt || !L(b).igr) return null; const g = supInf({ a: L(b).sgt, b: L(b).igr }); return dot(sub(c, { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 }), unit(sub(g.b, g.a))); } },
  gtCor: {
    label: 'Tuberosity top above the centre of rotation', kind: 'dist',
    f: (b) => { const c = cor(b), h = humeralLine(b.ctx); if (!c || !h || !L(b).gts) return null; return -dot(sub(L(b).gts, c), h.dir); },
  },
  hh: {
    label: 'Head top above the tuberosity', kind: 'dist',
    f: (b) => { const hd = L(b).head, h = humeralLine(b.ctx); if (!hd || !h || !L(b).gts || b.protocol.implant !== 'pyc') return null; const apex = { x: hd.cx - h.dir.x * hd.r, y: hd.cy - h.dir.y * hd.r }; return dot(sub(L(b).gts, apex), h.dir); },
  },
  ahdHead: {
    label: 'Acromiohumeral distance', kind: 'dist',
    f: (b) => { const hd = L(b).head; if (!hd || !L(b).acu || b.protocol.implant === 'reverse') return null; return dist(L(b).acu, C(hd)) - hd.r; },
  },
  glenMed: {
    label: 'Head medial to glenoid rim line', kind: 'dist',
    f: (b) => { const hd = L(b).head; if (!hd || !L(b).sgt || !L(b).igr || b.protocol.implant !== 'pyc') return null; const g = supInf({ a: L(b).sgt, b: L(b).igr }); return hd.r - signedDistToLine(C(hd), g.a, g.b, lateral(b.ctx)); },
  },
  schOX: { label: 'Medialisation (Schippers OX / d)', kind: 'ratio', f: (b) => { if (b.protocol.implant !== 'pyc') return null; const k = schippers(b.ctx); return k ? (k.OX / k.d) * 100 : null; } },
  schOY: { label: 'Upward migration (Schippers OY / d)', kind: 'ratio', f: (b) => { if (b.protocol.implant !== 'pyc') return null; const k = schippers(b.ctx); return k ? (k.OY / k.d) * 100 : null; } },
  stemAlign: { label: 'Stem alignment (+ varus)', kind: 'angle', f: (b) => (L(b).stem && L(b).canalM && L(b).canalD ? varusAngle(L(b).stem, shaftAxis(L(b).canalM, L(b).canalD), b.ctx) : null) },
};

/** Pair type: what is being compared with what. */
export function pairType(e, c) {
  const a = e.protocol.implant, b = c.protocol.implant;
  if (a === 'native' && b === 'reverse') return 'preop-reverse';
  if (a === 'native' && b === 'pyc') return 'preop-hemi';
  if (a === b && a === 'reverse') return 'followup-reverse';
  if (a === b && a === 'pyc') return 'followup-hemi';
  if (a === b && a === 'native') return 'native';
  return 'other';
}

const PAIR_TEXT = {
  'preop-reverse': 'Pre-operative film against a reverse arthroplasty: the changes are what the operation did.',
  'preop-hemi': 'Pre-operative film against a hemiarthroplasty: the changes are what the operation did.',
  'followup-reverse': 'Two films of the same reverse arthroplasty: the changes are what happened in between.',
  'followup-hemi': 'Two films of the same hemiarthroplasty: the changes are what happened in between.',
  native: 'Two films of a native shoulder.',
  other: 'Films of different types: only quantities defined on both are compared.',
};

/**
 * Change grading per pair type. Each returns { status, say } for a change d (in the row's unit; distances in mm
 * only — relative units are not graded), or null for ungraded. `months` is the interval if the reader gave one.
 */
const GRADE = {
  atd: {
    'preop-reverse': (d) => (d < 0
      ? { status: 'out', say: 'The tuberosity is closer to the acromion than before surgery: the arm has been shortened. Shortened arms elevated less in Lädermann\'s series, and under-tensioning is the setting for instability.' }
      : d <= 20 ? { status: 'good', say: 'Lengthened by 0–2 cm — the range usually recommended for a reverse.' }
        : { status: 'borderline', say: 'Lengthened by more than 2 cm. Excessive lengthening is the mechanism proposed for acromial stress fractures and traction neurapraxia; no safe upper limit has been validated.' }),
    'followup-reverse': (d) => (d >= 5
      ? { status: 'out', say: 'The acromion–tuberosity distance has increased by 5 mm or more since the earlier film. Fracture cases showed a larger change in this distance than controls (Otto): look carefully at the acromion and scapular spine, and consider CT.' }
      : d >= 3 ? { status: 'borderline', say: 'A small increase (3–5 mm) — within the error of two films taken in different arm positions, but worth a look at the acromion.' }
        : d <= -5 ? { status: 'borderline', say: 'The tuberosity has come closer to the acromion by 5 mm or more: stem subsidence, liner wear or a different arm position.' }
          : { status: 'good', say: 'Unchanged within 3 mm.' }),
  },
  gtCor: {
    'followup-reverse': (d) => (d >= 5
      ? { status: 'out', say: 'The tuberosity has risen 5 mm or more relative to the centre of rotation: the stem has sunk into the humerus (subsidence; a shift of position is the radiographic definition of a loose stem) — unless the tuberosity itself has changed.' }
      : d >= 2 ? { status: 'borderline', say: 'The tuberosity sits 2–5 mm higher relative to the implant than before: possible early subsidence. Within the error of landmark placement on two films; compare with the next one.' }
        : d <= -3 ? { status: 'borderline', say: 'The tuberosity sits lower relative to the implant: tuberosity resorption or fracture, or a placement difference.' }
          : { status: 'good', say: 'The stem has not moved relative to the tuberosity (within 2 mm).' }),
  },
  hh: {
    'followup-hemi': (d) => (d <= -5
      ? { status: 'out', say: 'The head stands 5 mm or more lower relative to the tuberosity than before: stem subsidence — unless the tuberosity has changed.' }
      : d <= -2 ? { status: 'borderline', say: 'The head stands 2–5 mm lower relative to the tuberosity: possible early subsidence; within placement error.' }
        : { status: 'good', say: 'Head height over the tuberosity unchanged within 2 mm.' }),
  },
  tilt: {
    'followup-reverse': (d) => (Math.abs(d) >= 10
      ? { status: 'out', say: 'The glenosphere has changed inclination by 10° or more: a shift of the baseplate — look for lucency, broken screws and notching.' }
      : Math.abs(d) >= 5 ? { status: 'borderline', say: 'A 5–10° difference in glenosphere inclination: at the limit of measurement error (about ±5°), but a change of baseplate position cannot be excluded.' }
        : { status: 'good', say: 'Glenosphere inclination unchanged within measurement error (5°).' }),
  },
  corInf: {
    'followup-reverse': (d) => (Math.abs(d) >= 5 ? { status: 'out', say: 'The centre of rotation has moved 5 mm or more along the glenoid: baseplate migration.' }
      : Math.abs(d) >= 3 ? { status: 'borderline', say: 'A 3–5 mm shift along the glenoid — at the limit of what two placements of the rim points can explain.' }
        : { status: 'good', say: 'No shift along the glenoid beyond 3 mm.' }),
  },
  corLat: {
    'followup-reverse': (d) => (d <= -3 ? { status: 'borderline', say: 'The centre of rotation is 3 mm or more further medial relative to the glenoid rim: baseplate subsidence, or a difference in where the rim points were put.' }
      : { status: 'good', say: 'No medial shift of the centre of rotation beyond 3 mm.' }),
  },
  ahdHead: {
    'followup-hemi': (d) => (d <= -2 ? { status: 'borderline', say: 'The subacromial space has narrowed by 2 mm or more: upward migration of the head (superior cuff failure or superior erosion).' } : { status: 'good', say: 'Subacromial space maintained within 2 mm.' }),
    native: (d) => (d <= -2 ? { status: 'borderline', say: 'The subacromial space has narrowed by 2 mm or more: progressive superior migration.' } : { status: 'good', say: 'Subacromial space maintained within 2 mm.' }),
  },
  glenMed: {
    'followup-hemi': (d) => (d >= 2 ? { status: 'borderline', say: 'The head surface lies 2 mm or more further medial to the glenoid rim line: medial glenoid erosion. Confirm with Schippers\' medialisation above, which is less sensitive to magnification.' } : { status: 'good', say: 'No medial progression beyond 2 mm.' }),
  },
  stemAlign: {
    'followup-reverse': (d) => stemTilt(d), 'followup-hemi': (d) => stemTilt(d),
  },
};

function stemTilt(d) {
  return Math.abs(d) >= 5 ? { status: 'out', say: 'The stem has tilted by 5° or more relative to the shaft: a change of position, the radiographic definition of a loose humeral component.' }
    : Math.abs(d) >= 3 ? { status: 'borderline', say: 'A 3–5° change in stem alignment: possible tilt, at the limit of measurement error.' }
      : { status: 'good', say: 'Stem alignment unchanged within 3°.' };
}

/** Schippers grading: by rate when the interval is known, else by total change against the published spread. */
function gradeSchippers(d, months, which) {
  const mean = which === 'OX' ? 18 : 13, sd = which === 'OX' ? 17 : 14;
  const word = which === 'OX' ? 'medialisation' : 'upward migration';
  if (months > 0) {
    const rate = d / months;
    const r = `${rate.toFixed(2)}% of the shaft diameter a month`;
    if (rate >= 1) return { status: 'out', say: `${r}: in the top group of Schippers' series (1–2% a month in ${which === 'OX' ? '30' : '17'}% of patients; mean ${which === 'OX' ? '0.57' : '0.44'}%).` };
    if (rate >= 0.5) return { status: 'borderline', say: `${r}: around the series mean of ${which === 'OX' ? '0.57' : '0.44'}% a month — progressive ${word}.` };
    return { status: 'good', say: `${r}: slow, like the ${which === 'OX' ? '39' : '44'}% of patients with almost none.` };
  }
  if (d >= mean + sd) return { status: 'out', say: `More ${word} than the series average plus one SD (${mean + sd}% at a mean 31 months). Enter the interval between the films to grade the rate instead.` };
  if (d >= 5) return { status: 'borderline', say: `Measurable ${word} (series mean ${mean}% at a mean 31 months, SD ${sd}%). Enter the interval between the films to grade the rate.` };
  return { status: 'good', say: `Little or no ${word} (under 5% of the shaft diameter).` };
}

/**
 * Compare two films. e = earlier, c = current (assessment bundles). opts = { months }.
 * Returns { type, typeText, scale, rows: [...], findings: [...], notes: [...] }.
 */
export function compareFilms(e, c, opts = {}) {
  const type = pairType(e, c);
  // matching the arm position. opts.match: 'toEarlier' (or true) turns the current film's humerus to the earlier
  // film's arm position; 'toCurrent' turns the earlier film's humerus to the current one's; 'standard' turns both to
  // the standard position (SHARA 104°, or the arm vertical). Positions are relative to the scapula when both films
  // have the fossa line, else relative to the image vertical. Each humerus turns about its own centre of rotation.
  let match = null;
  if (opts.match) {
    const raw = (b) => (b.ctx.raw ? { ...b, ctx: b.ctx.raw } : b);
    e = raw(e); c = raw(c);
    const mode = opts.match === true ? 'toEarlier' : opts.match;
    const kind = e.ctx.L.ssf && c.ctx.L.ssf ? 'shara' : 'hara';
    const pos = (b) => (kind === 'shara' ? shara(b.ctx) : hara(b.ctx));
    const need = (b) => (b.protocol.implant === 'native' ? 'Place the humeral shaft line' : 'Check the stem axis');
    const turn = (b, deg) => {
      const n = neutralise(b.protocol, b.ctx, { kind, deg });
      return n.ok ? { b: { ...b, ctx: { ...b.ctx, L: n.L, raw: b.ctx, neutral: n } }, n } : { reason: n.reason };
    };
    const per = {};
    let want = null, reason = null;
    if (mode === 'standard') {
      want = kind === 'shara' ? SHARA_NEUTRAL : 0;
      const te = turn(e, want), tc = turn(c, want);
      if (te.n && tc.n) { e = te.b; c = tc.b; per.earlier = te.n; per.current = tc.n; } else reason = te.reason || tc.reason;
    } else {
      const fixed = mode === 'toCurrent' ? c : e;
      want = pos(fixed);
      if (!Number.isFinite(want)) reason = `${need(fixed)} on the ${mode === 'toCurrent' ? 'later' : 'earlier'} film to measure its arm position.`;
      else {
        const t = turn(mode === 'toCurrent' ? e : c, want);
        if (!t.n) reason = t.reason;
        else if (mode === 'toCurrent') { e = t.b; per.earlier = t.n; } else { c = t.b; per.current = t.n; }
      }
    }
    match = reason ? { ok: false, mode, reason } : {
      ok: true, mode, kind, want, per,
      before: { earlier: pos(e.ctx.raw ? { ...e, ctx: e.ctx.raw } : e), current: pos(c.ctx.raw ? { ...c, ctx: c.ctx.raw } : c) },
    };
  }
  const scale = commonScale(e, c);
  const rows = [];
  for (const [id, q] of Object.entries(Q)) {
    const v0 = q.f(e), v1 = q.f(c);
    if (v0 === null || v1 === null || !Number.isFinite(v0) || !Number.isFinite(v1)) continue;
    let unitS, a, b;
    if (q.kind === 'dist') {
      if (!scale.f) continue;
      a = v0 * scale.f[0]; b = v1 * scale.f[1]; unitS = scale.unit;
    } else if (q.kind === 'angle') { a = v0; b = v1; unitS = '°'; } else { a = v0; b = v1; unitS = '%'; }
    const d = b - a;
    let g = null;
    if (id === 'schOX' || id === 'schOY') g = type === 'followup-hemi' ? gradeSchippers(d, opts.months, id === 'schOX' ? 'OX' : 'OY') : null;
    else if (GRADE[id] && GRADE[id][type] && (q.kind !== 'dist' || unitS === 'mm')) g = GRADE[id][type](d);
    let label = q.label;
    if (id === 'atd' && type === 'preop-reverse') label = 'Arm lengthening (acromion–tuberosity distance)';
    if (id === 'gtLat' && type.startsWith('preop')) label = 'Tuberosity lateral to acromion';
    if (id === 'corLat' && type === 'preop-reverse') label = 'Centre of rotation lateral to glenoid line';
    if (id === 'corInf' && type === 'preop-reverse') label = 'Centre of rotation below glenoid centre';
    rows.push({
      id, label, unit: unitS, earlier: a, current: b, change: d,
      earlierText: fmtVal(a, unitS, q.kind === 'ratio' ? 0 : 1), currentText: fmtVal(b, unitS, q.kind === 'ratio' ? 0 : 1), changeText: fmtSigned(d, unitS, q.kind === 'ratio' ? 0 : 1),
      status: g ? g.status : 'info', say: g ? g.say : describe(id, d, type, unitS),
    });
  }
  // findings graded on both films
  const findings = [];
  const fe = Object.fromEntries((e.findings || []).map((f) => [f.id, f]));
  for (const f1 of c.findings || []) {
    const f0 = fe[f1.id];
    if (!f0 || !f0.answered || !f1.answered) continue;
    const def = (c.protocol.findings || []).find((x) => x.id === f1.id);
    const i0 = def.options.findIndex((o) => o.v === f0.value), i1 = def.options.findIndex((o) => o.v === f1.value);
    const ordinal = ['notching', 'glenoidErosion', 'humLucency', 'stressShield', 'baseplate'].includes(f1.id);
    let status = 'info', say;
    if (i1 === i0) { status = 'good'; say = 'Unchanged.'; } else if (ordinal && i1 > i0) { status = f1.status === 'good' ? 'borderline' : f1.status; say = `Progressed from "${f0.optionLabel}".`; } else say = `Was "${f0.optionLabel}".`;
    findings.push({ id: f1.id, label: f1.label, earlierText: f0.optionLabel, currentText: f1.optionLabel, status, say });
  }
  const notes = [];
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  // the acromiohumeral distance as reported around reverse arthroplasty: acromion to head before, acromion to tuberosity after
  if (type === 'preop-reverse' && scale.f && L(e).acu && L(e).head && L(c).acu && L(c).gts) {
    const a = (dist(L(e).acu, C(L(e).head)) - L(e).head.r) * scale.f[0], b = dist(L(c).acu, L(c).gts) * scale.f[1], dd = b - a;
    rows.push({ id: 'ahdR', label: 'Acromiohumeral distance (before: to head; after: to tuberosity)', unit: scale.unit, earlier: a, current: b, change: dd,
      earlierText: fmtVal(a, scale.unit), currentText: fmtVal(b, scale.unit), changeText: fmtSigned(dd, scale.unit), status: 'info',
      say: 'About +22 mm on average after reverse arthroplasty (Rhee).' });
  }
  const ORDER = type === 'preop-reverse' ? ['dsa', 'lsa', 'atd', 'ahdR', 'glo', 'gtLat', 'dma', 'corLat', 'corInf', 'deltL', 'hara'] : null;
  if (ORDER) {
    const rank = (r) => (ORDER.includes(r.id) ? ORDER.indexOf(r.id) : 99);
    rows.sort((x, y) => rank(x) - rank(y));
    for (let i = rows.length - 1; i >= 0; i--) if (!ORDER.includes(rows[i].id)) rows.splice(i, 1);
  }
  const matched = match && match.ok;
  if (match && !match.ok) notes.push(`Arm position not matched: ${match.reason}`);
  const bothNeutral = !matched && e.ctx.neutral && c.ctx.neutral && e.ctx.neutral.target === c.ctx.neutral.target;
  if (bothNeutral) notes.push(`Both films are normalised to the same arm position (${e.ctx.neutral.target === 'scapula' ? 'relative to the scapula' : 'arm vertical'}): the humerus of each was rotated about its centre of rotation (${e.ctx.neutral.deg.toFixed(0)}° and ${c.ctx.neutral.deg.toFixed(0)}°), so differences in how the arm hung are removed from the other rows.`);
  else if (!matched && (e.ctx.neutral || c.ctx.neutral)) notes.push('Only one of the two films could be normalised to a standard arm position, so posture differences are not removed. Place the missing landmark (stem, shaft line or fossa line) on the other film.');
  if (!matched && !bothNeutral && byId.hara && Math.abs(byId.hara.change) > 10 && (byId.lsa || byId.dsa)) {
    notes.push(`The arm hangs ${Math.abs(byId.hara.change).toFixed(0)}° ${byId.hara.change > 0 ? 'more' : 'less'} abducted on the current film. Part of any change in LSA and DSA is posture, not surgery or migration: in every pair of consecutive films in one series the more abducted film had the higher LSA and the lower DSA.`);
  }
  if (type === 'other') notes.push('These films are of different study types (for example a hemiarthroplasty against a reverse); only quantities defined on both are listed and none is graded.');
  if (scale.mode === 'relative') notes.push('Changes in distances are expressed relative to glenoid height and are not graded; calibrate at least one film by its implant to grade them in millimetres.');
  return { type, typeText: PAIR_TEXT[type], scale, rows, findings, notes, match, key: keyResults(byId, c, type, scale) };
}

function describe(id, d, type, unitS) {
  const up = d > 0;
  switch (id) {
    case 'lsa': return up ? 'Humerus more lateral.' : 'Humerus more medial.';
    case 'dsa': return up ? 'Humerus lower.' : 'Humerus higher.';
    case 'gtLat': return type.startsWith('preop') ? 'Humeral lateralisation (about +5 mm on average, Rhee).' : '';
    case 'glo': return up ? 'Lateralised overall.' : 'Medialised overall.';
    case 'dma': return up ? 'Longer deltoid lever arm.' : 'Shorter deltoid lever arm.';
    case 'corLat': return up ? 'Centre of rotation lateralised.' : 'Centre of rotation medialised.';
    case 'corInf': return up ? 'Centre of rotation lowered.' : 'Centre of rotation raised.';
    case 'deltL': return up ? 'Deltoid lengthened.' : 'Deltoid shortened.';
    case 'hara': return 'Arm position as taken (+ = more abducted now).';
    default: return unitS === '% GH' ? 'Relative to glenoid height; not graded.' : '';
  }
}

// Typical change across a reverse arthroplasty, for context on the headline cards.
const TYPICAL = {
  atd: { mean: 21, sd: 10, src: 'Jobin 2012' },     // deltoid lengthening, post-op minus pre-op acromion–tuberosity distance
};

/**
 * The two headline results of a comparison: distalisation (DSA, arm lengthening) and lateralisation (LSA, tuberosity
 * shift). Each card: { id, title, angle: row, dist: row, post: { value, status, tag, target } }.
 */
function keyResults(byId, c, type, scale) {
  if (!['preop-reverse', 'followup-reverse', 'native'].includes(type) && !byId.dsa && !byId.lsa) return [];
  const band = (id, v) => {
    const m = (c.protocol.metrics || []).find((x) => x.id === id);
    if (!m || !Number.isFinite(v)) return null;
    const b = bandFor(m.bands, v);
    return b ? { status: b.status, tag: b.tag || '', target: m.target || '', norm: m.norm || null } : null;
  };
  const card = (id, title, angleId, distId, word) => {
    const a = byId[angleId], d = byId[distId];
    if (!a && !d) return null;
    const post = a ? band(angleId, a.current) : null;
    let typical = null;
    if (d && distId === 'atd' && type === 'preop-reverse' && scale.unit === 'mm') typical = TYPICAL.atd;
    return { id, title, word, angle: a || null, dist: d || null, post, typical };
  };
  return [
    card('dist', 'Distalisation', 'dsa', 'atd', type === 'preop-reverse' ? 'arm lengthening' : 'acromion–tuberosity distance'),
    card('lat', 'Lateralisation', 'lsa', 'gtLat', type === 'preop-reverse' ? 'humeral lateralisation' : 'tuberosity lateral to acromion'),
  ].filter(Boolean);
}
