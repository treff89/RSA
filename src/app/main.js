// RSA Check — main thread: study state, landmark placement, live measurement, appraisal and export.
// File reading, anonymisation, decoding and automatic detection run in the worker (see ../worker/worker.js).
import workerSource from 'worker-source';
import { ImageView } from './imageview.js';
import { Mpr } from './mpr.js';
import { IMPLANTS, protocolFor, viewsFor, VIEW_LABEL } from '../measure/protocols/index.js';
import { evaluate, evaluateFindings, appraise } from '../measure/core.js';
import { circleFrom3, v3, scapularFrame } from '../measure/geom.js';
import { anatomicVsReverse } from '../measure/decision.js';
import { compareFilms } from '../measure/compare.js';
import { neutralise, neutralNote, HUMERAL, rotatePolylines, rotateHumerus } from '../measure/neutral.js';
import { seedXray, lateralSignOf, ssfPrior } from '../measure/seed.js';
import { frames as learnedFrames, placeLearned } from '../detect/learned.js';
import MODEL from '../detect/model.json' with { type: 'json' };
import { MUSCLES, sampleRoi, roiStats, muscleResults } from '../measure/muscle.js';
import { detectHeadSphere } from '../detect/ct.js';
import * as panel from './panel.js';
import * as training from './training.js';
import { buildText, buildCsv, buildJson } from './report.js';

const $ = (id) => document.getElementById(id);
const STATUS_COLOR = { good: '#4ecb8f', borderline: '#f2c14e', out: '#ff7b72', info: '#7fa7d6', pending: '#6f7b8a' };
const LM_COLOR = { auto: '#4ecb8f', estimated: '#f2c14e', manual: '#6aa9f2' };
const ACTIVE = '#f0a23b';
const SHORT = {
  gs: 'GS', face: 'face', stem: 'stem', sgt: 'SGT', igr: 'IGR', acr: 'ACR', acu: 'ACU', ssf: 'SSF', gts: 'GT top', gtl: 'GT lat',
  canalM: 'canal', canalD: 'canal', stemM: '', stemD: '', head: 'head', pcA: '1', pcB: '2', pcC: '3', gmid: 'G mid', osteo: 'osteophyte',
  dtO: 'outer', dtI: 'inner', ga: 'Ant', gp: 'Post', scapAx: 'axis', post: 'post', tri: 'TS', ia: 'IA', gsup: 'Sup', ginf: 'Inf', sgr: 'Sup',
  dtu: 'DT', acLine: 'acromion', hcl: 'shaft', shaftD: 'd', yc: 'Y', pa: 'post', aa: 'ant',
};

const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));

const state = {
  implant: 'reverse',
  items: [],
  cur: -1,
  report: null,            // anonymisation report of the last scan
  tab: 'landmarks',
  active: null,            // landmark being placed
  pending: [],             // clicks collected for the landmark being placed
  guided: false,
  showLines: true,
  selMetric: null,
  drawing: null,           // CT muscle outline in progress
  clinical: { age: '', cuff: 'unknown', pseudoparesis: false, inflammatory: false },
  neutral: 'off',          // arm-position normalisation for AP radiographs: 'off' | 'vertical' | 'scapula'
  queue: [],               // items still to load
  seq: 0,
};

let xview = null;          // ImageView for radiographs
let mpr = null;            // Mpr for the current CT
let panelTimer = 0;

const cur = () => state.items[state.cur] || null;
const proto = (item = cur()) => (item ? protocolFor(item.implant || state.implant, item.kind, item.view) : null);
/** Study type of an image: each image carries its own (a pre-operative native film next to a post-operative reverse). */
const typeOf = (item = cur()) => (item && item.implant) || state.implant;

// ───────────────────────── worker messaging ─────────────────────────
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') onProgress(m);
  else if (m.type === 'scanned') onScanned(m.result, m.append);
  else if (m.type === 'xray') onXray(m);
  else if (m.type === 'ct') onCt(m);
  else if (m.type === 'detected') onDetected(m);
  else if (m.type === 'error') onError(m);
};
worker.onerror = (e) => onError({ scope: 'worker', message: e.message || 'Unexpected error in the processing engine.' });

function onProgress(m) {
  const pct = `${Math.round(Math.max(0, Math.min(1, m.fraction || 0)) * 100)}%`;
  if (m.scope === 'scan' && !$('workspace').hidden) m = { ...m, scope: 'load' };
  if (m.scope === 'scan') {
    $('scan-status').hidden = false; $('scan-bar').style.width = pct; $('scan-label').textContent = m.label || 'Reading and anonymising files…';
  } else {
    $('progress').hidden = false; $('progress-bar').style.width = pct; $('progress-label').textContent = m.label || 'Working…';
  }
}

function onError(m) {
  $('progress').hidden = true; $('scan-status').hidden = true;
  if (m.scope === 'scan' || !state.items.length) {
    showIntro();
    const el = $('intro-error');
    el.textContent = m.message; el.hidden = false;
  } else {
    const el = $('viewer-error');
    el.textContent = m.message; el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 9000);
    loadNext();
  }
}

function onScanned(result, append = false) {
  $('scan-status').hidden = true;
  if (append && state.report) {
    // a later batch (e.g. the pre-operative film): one combined anonymisation record
    const a = state.report, r = result.report;
    state.report = { ...a, filesScanned: a.filesScanned + r.filesScanned, totalElementsDiscarded: a.totalElementsDiscarded + r.totalElementsDiscarded,
      identifiersFound: [...(a.identifiersFound || []), ...(r.identifiersFound || [])], burnedInRisk: (a.burnedInRisk || 0) + (r.burnedInRisk || 0) };
  } else state.report = result.report;
  if (!append) { state.items = []; state.cur = -1; state.queue = []; state.autoCompared = false; }
  const role = append ? state.addRole : null;
  state.addRole = null;
  let n = append ? state.items.length : 0;
  for (const r of result.radiographs) {
    if (!r.supported) continue;
    const bits = [r.viewPosition, r.laterality, r.description].filter(Boolean).join(' ');
    state.queue.push({ type: 'xray', id: r.id, role, name: role === 'preop' ? `Pre-op ${bits ? `· ${bits}` : ''}`.trim() : `X-ray ${++n}${bits ? ` · ${bits}` : ''}` });
  }
  for (const r of result.rasters) state.queue.push({ type: 'xray', id: r.id, role, name: role === 'preop' ? 'Pre-op' : `Image ${++n}` });
  if (result.ct) {
    const pick = result.ct.series.find((s) => s.id === result.ct.recommendedId) || result.ct.series.find((s) => s.supported);
    if (pick) state.queue.push({ type: 'ct', seriesId: pick.id, name: `CT${pick.description ? ` · ${pick.description}` : ''}` });
    state.ctSeries = result.ct.series;
  }
  if (!state.queue.length) { onError({ scope: append ? 'load' : 'scan', message: 'The files were read, but none of the images can be decoded here (unsupported compression).' }); return; }
  state.queueTotal = state.queue.length + (append ? state.items.length : 0);
  showWorkspace();
  if (append) state.selectNew = true;
  loadNext();
}

function loadNext() {
  const q = state.queue.shift();
  if (!q) { $('progress').hidden = true; autoCompare(); return; }
  state.loadingName = q.name;
  onProgress({ scope: 'load', fraction: 0.05, label: `Opening ${q.name}…` });
  state.loadingImplant = q.role === 'preop' ? 'native' : state.implant;
  state.loadingRole = q.role || null;
  worker.postMessage(q.type === 'ct' ? { type: 'ct', seriesId: q.seriesId } : { type: 'xray', id: q.id, implant: state.loadingImplant });
  renderItems();
}

function onXray(m) {
  const det = m.det || {};
  // a reverse study opened with several films: a film with no implant on it is taken as the pre-operative film
  // and analysed as a native shoulder (its type can be changed back on its own tab)
  if (!state.loadingRole && state.loadingImplant === 'reverse' && det.kind === 'native' && state.queueTotal > 1) {
    state.loadingImplant = 'native'; state.loadingRole = 'preop';
    state.loadingName = `Pre-op${state.loadingName ? ` (${state.loadingName})` : ''}`;
  }
  const lat = m.image.meta && m.image.meta.laterality;
  const item = {
    uid: ++state.seq, implant: state.loadingImplant || state.implant, role: state.loadingRole || null, kind: 'xray', name: m.sample ? 'Synthetic X-ray' : state.loadingName || 'X-ray', image: m.image, det, sample: !!m.sample,
    view: /AX/i.test((m.image.meta && m.image.meta.viewPosition) || '') ? 'axillary' : 'ap',
    lateralSign: lateralSignOf(det, lat),
    calib: { size: null }, lm: {}, findings: {}, rimAngle: {}, truth: m.truth || null,
    film: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  addItem(item);
}

function onCt(m) {
  const item = {
    uid: ++state.seq, implant: state.loadingImplant || state.implant, kind: 'ct', name: m.sample ? 'Synthetic CT' : state.loadingName || 'CT', volume: m.volume, det: m.det || {}, sample: !!m.sample,
    view: 'ct', lm: {}, findings: {}, rois: [], truth: m.truth || null,
  };
  addItem(item);
}

function addItem(item) {
  state.loadingName = null;
  $('progress').hidden = true;
  state.items.push(item);
  if (state.selectNew && item.role === 'preop') {
    // the pre-operative film was added from the Comparison tab: pair it and stay on the post-operative film
    state.selectNew = false;
    const post = cur();
    if (post) { post.compareWith = item.uid; post.compareOrder = 'thisLater'; state.tab = 'compare'; }
    renderItems(); refresh();
    toast('Pre-op film added — check its landmarks on its own tab.');
  } else if (state.cur < 0) {
    // First image: if the detector is confident the study type is different from the one picked, follow it.
    // Only a positively identified implant changes the type: "no implant found" may simply be a missed detection.
    // the reader chooses the study type; the image is analysed as that type (see redetect on a change of type)
    select(state.items.length - 1);
  } else renderItems();
  loadNext();
}

function onDetected(m) {
  const item = state.items.find((i) => i.uid === m.reqId);
  if (!item) return;
  item.det = m.det || {};
  if (item.det.side) item.lateralSign = item.det.side === 'right-of-glenoid' ? 1 : -1;
  delete item.lm[proto(item).id];
  $('progress').hidden = true;
  if (item === cur()) { seed(item); focusLandmarks(item); refresh(); }
}

// ───────────────────────── landmarks ─────────────────────────
/** Landmark set of an item for the current protocol; seeded from automatic detection the first time. */
function lmSet(item = cur()) {
  const p = proto(item);
  if (!item.lm[p.id]) seed(item);
  return item.lm[p.id];
}

function seed(item) {
  const p = proto(item);
  const set = { values: {}, state: {} };
  item.lm[p.id] = set;
  const put = (id, value, st) => { if (p.landmarks.some((l) => l.id === id) && value) { set.values[id] = value; set.state[id] = st; } };
  const d = item.det || {};
  if (item.kind === 'xray') {
    const s = seedXray(p, d);
    Object.assign(set.values, s.values); Object.assign(set.state, s.state);
    if (s.prior) set.prior = s.prior;
    const kind = training.kindOf(p.id);
    // landmarks this reader has corrected before are placed with the model adapted to those corrections
    const ids = kind ? training.adaptedIds(kind) : null;
    if (ids && ids.size) { try { relandmark(item, true, ids); } catch { /* keep the detector's estimates */ } }
  } else {
    if (p.id === 'rsa-ct' && d.reverse) {
      const g = d.reverse.glenosphere;
      put('gs', { c: g.center, r: g.radius }, 'auto');
      put('post', d.reverse.post || v3.sub(g.center, v3.mul(g.axis, 20)), d.reverse.post ? 'auto' : 'estimated');
      if (d.reverse.stem) put('stem', { a: d.reverse.stem.a, b: d.reverse.stem.b }, 'auto');
    }
    if (p.id !== 'rsa-ct' && d.head) put('head', { c: d.head.center, r: d.head.radius }, d.head.inlierFraction >= 0.5 ? 'auto' : 'estimated');
  }
}

function scaleInfo(item, p, set) {
  if (item.kind === 'ct') return { mm: 1, source: 'ct', text: 'CT — true size in millimetres' };
  const ps = item.image.pixelSpacing || {};
  const cal = p.calibration;
  const obj = cal ? set.values[cal.landmark] : null;
  if (cal && obj && item.calib.size > 0) {
    const mm = item.calib.size / (2 * obj.r);
    return { mm, source: 'implant', dicomMm: ps.mm || null, nominal: item.calib.size, text: `${mm.toFixed(4)} mm per pixel, from the ${item.calib.size} mm ${cal.label.toLowerCase().replace(' diameter', '')}` };
  }
  if (ps.mm > 0) {
    const exact = item.sample;
    return {
      mm: ps.mm, source: 'dicom', dicomMm: ps.mm, nominal: null,
      text: `${ps.mm.toFixed(4)} mm per pixel, from the image file (${ps.source})`,
      note: exact ? '' : `Distances use the pixel spacing stored in the image${ps.detectorPlane ? ' at the detector plane' : ''}. Unless the film was calibrated, they include its magnification (typically 5–15% too large).${cal ? ` Enter the ${cal.label.toLowerCase()} to remove it.` : ''}`,
    };
  }
  return { mm: null, source: null, text: '' };
}

/** Everything derived from an item: protocol, context, graded results, findings and appraisal. */
function assess(item) {
  const p = proto(item);
  const set = lmSet(item);
  const sc = scaleInfo(item, p, set);
  let ctx = { L: set.values, state: set.state, mm: sc.mm, mmSource: sc.source, dicomMm: sc.dicomMm, nominal: sc.nominal, scaleNote: sc.note || '', lateralSign: item.lateralSign || 1 };
  let neutral = null;
  if (state.neutral !== 'off' && item.kind === 'xray' && p.view === 'ap') {
    neutral = neutralise(p, ctx, state.neutral);
    if (neutral.ok) ctx = { ...ctx, L: neutral.L, raw: { ...ctx }, neutral, neutralNote: neutralNote(neutral, p) };
  }
  const labels = Object.fromEntries(p.landmarks.map((l) => [l.id, l.label]));
  const results = evaluate(p, ctx).map((r) => ({ ...r, missingLabels: labels }));
  if (!item.findings[p.id]) item.findings[p.id] = {};
  const findings = evaluateFindings(p, item.findings[p.id]);
  const extraResults = item.kind === 'ct' ? muscleAll(item) : [];
  const appraisal = appraise(p, [...results, ...extraResults], findings, ctx);
  // muscle results are never "not measured" items — drop them from that list if empty
  return { name: item.name, protocol: p, ctx, results, findings, appraisal, scale: sc, extraResults, item, neutral };
}

function muscleAll(item) {
  const out = [];
  for (const m of MUSCLES) {
    const a = item.rois.find((r) => r.muscle === m.id && r.kind === 'muscle');
    const b = item.rois.find((r) => r.muscle === m.id && r.kind === 'pre');
    if (a) out.push(...muscleResults(m, a.stats, b ? b.stats : null));
  }
  return out;
}

function decision() {
  const natives = state.items.filter((i) => typeOf(i) === 'native');
  if (!natives.length || (cur() && typeOf() !== 'native')) return null;
  const inp = { ...state.clinical, age: state.clinical.age === '' ? NaN : Number(state.clinical.age), fat: {} };
  for (const item of natives) {
    const b = assess(item);
    const by = Object.fromEntries(b.results.map((r) => [r.id, r]));
    const val = (id) => (by[id] && by[id].status !== 'pending' ? by[id].value : undefined);
    const f = item.findings[b.protocol.id] || {};
    if (b.protocol.id === 'native-ap') {
      if (val('ahd') !== undefined) inp.ahd = val('ahd');
      if (val('csa') !== undefined) inp.csa = val('csa');
      if (val('incl') !== undefined) inp.inclAp = val('incl');
      if (f.hamada) inp.hamada = f.hamada;
      if (f.favard) inp.favard = f.favard;
    } else if (b.protocol.id === 'native-ct') {
      if (val('version') !== undefined) { inp.version = val('version'); inp.versionSource = 'ct'; }
      if (val('sublux') !== undefined) inp.sublux = val('sublux');
      if (f.walch) inp.walch = f.walch;
      for (const m of ['ss', 'is', 'ssc', 'tm']) {
        const roi = item.rois.find((r) => r.muscle === m && r.kind === 'muscle');
        if (roi) inp.fat[m] = roi.stats.fatFraction * 100;
      }
    } else if (b.protocol.id === 'native-ax') {
      if (val('version') !== undefined && inp.versionSource !== 'ct') { inp.version = val('version'); inp.versionSource = 'xray'; }
      if (val('sublux') !== undefined && inp.sublux === undefined) inp.sublux = val('sublux');
    }
  }
  return anatomicVsReverse(inp);
}

// ───────────────────────── comparison with another film ─────────────────────────
const comparable = (item) => item.kind === 'xray' && item.view === 'ap';
function compareCandidates(item) { return state.items.filter((x) => x !== item && comparable(x)); }

const isPreop = (x) => x.role === 'preop' || typeOf(x) === 'native';

/** Once every film is in: a reverse film and a pre-op film → open their comparison. */
function autoCompare() {
  if (state.autoCompared) return;
  const post = state.items.find((x) => comparable(x) && typeOf(x) === 'reverse');
  const pre = post && state.items.find((x) => x !== post && comparable(x) && isPreop(x));
  if (!pre) return;
  state.autoCompared = true;
  post.compareWith = pre.uid; post.compareOrder = 'thisLater';
  select(state.items.indexOf(post));
  state.tab = 'compare'; refresh();
  toast('Pre-op and post-op films paired: comparison at matched arm position.');
}

/**
 * The comparison shown for an item. A reverse film is compared with the pre-operative film by default; the later
 * film's humerus is turned to the earlier film's arm position before anything is measured.
 */
function comparisonFor(item) {
  if (!comparable(item)) return null;
  const others = compareCandidates(item);
  if (!others.length) return null;
  const before = others.filter((x) => state.items.indexOf(x) < state.items.indexOf(item));
  const other = others.find((x) => x.uid === item.compareWith)
    || (typeOf(item) === 'reverse' && others.find(isPreop)) || before.pop() || others[0];
  // a pre-operative film is always the earlier one, whichever of the pair is being viewed
  const itemPre = isPreop(item) && !isPreop(other);
  const preop = (isPreop(other) && !isPreop(item)) || itemPre;
  const thisLater = !itemPre && (preop || item.compareOrder !== 'thisEarlier');
  const [e, c] = thisLater ? [other, item] : [item, other];
  const res = compareFilms(assess(e), assess(c), { months: item.compareMonths > 0 ? item.compareMonths : null, match: item.compareMatch || 'toEarlier' });
  return { ...res, other, preop, earlierName: e.name, currentName: c.name, thisLater, months: item.compareMonths || '' };
}

/** Comparisons the reader asked for (opened the Compare tab on), for the report. */
function comparisons() {
  return state.items.filter((i) => i.compareWith !== undefined && comparable(i)).map((i) => comparisonFor(i)).filter(Boolean);
}

// ───────────────────────── overlays: radiograph ─────────────────────────
function lmColor(id, set) { return id === state.active ? ACTIVE : LM_COLOR[set.state[id]] || LM_COLOR.manual; }

function xrayOverlay(item, b) {
  const set = lmSet(item), p = b.protocol;
  const handles = [], shapes = [];
  for (const lm of p.landmarks) {
    const v = set.values[lm.id];
    if (!v) continue;
    const color = lmColor(lm.id, set), dashed = set.state[lm.id] === 'estimated', label = SHORT[lm.id] ?? lm.id;
    if (lm.kind === 'point') handles.push({ key: lm.id, x: v.x, y: v.y, color, dashed, label, active: lm.id === state.active });
    else if (lm.kind === 'line') {
      shapes.push({ type: 'line', a: v.a, b: v.b, color, width: 1.5, dash: dashed, alpha: 0.85 });
      handles.push({ key: `${lm.id}.a`, x: v.a.x, y: v.a.y, color, dashed, small: true, label });
      handles.push({ key: `${lm.id}.b`, x: v.b.x, y: v.b.y, color, dashed, small: true });
    } else if (lm.kind === 'circle') {
      const ang = item.rimAngle[lm.id] ?? -Math.PI / 4;
      shapes.push({ type: 'circle', c: { x: v.cx, y: v.cy }, r: v.r, color, width: 1.6, dash: dashed, cross: true, alpha: 0.9 });
      handles.push({ key: `${lm.id}.c`, x: v.cx, y: v.cy, color, dashed, small: true, label });
      handles.push({ key: `${lm.id}.r`, x: v.cx + v.r * Math.cos(ang), y: v.cy + v.r * Math.sin(ang), color, dashed, small: true });
    }
  }
  // the humerus as measured, when it has been turned: by the arm-position setting, or to match the pre-op film
  let ghost = b.ctx.neutral ? { n: b.ctx.neutral, V: b.ctx.L, label: `${Math.abs(b.ctx.neutral.deg).toFixed(0)}°` } : null;
  if (state.tab === 'compare') {
    const cmp = comparisonFor(item);
    const n = cmp && cmp.match && cmp.match.ok ? cmp.match.per[cmp.thisLater ? 'current' : 'earlier'] : null;
    const to = cmp && cmp.match && cmp.match.mode === 'standard' ? 'standard' : cmp && cmp.preop ? (cmp.thisLater ? 'pre-op' : 'post-op') : 'other film';
    ghost = n ? { n, V: rotateHumerus(set.values, n.centre, n.deg), label: `${Math.abs(n.deg).toFixed(0)}° to ${to}` } : null;
  }
  if (ghost) {
    const G = '#c79bff', { n, V } = ghost;
    const hum = item.det && item.det.humerus;
    if (hum) {
      for (const pl of rotatePolylines([...(hum.outline || []), ...(hum.metal || [])], n.centre, n.deg)) if (pl.length > 1) shapes.push({ type: 'poly', pts: pl, closed: false, color: G, width: 2.2, alpha: 0.95 });
    }
    for (const lm of p.landmarks) {
      const v = V[lm.id];
      if (!v || !HUMERAL.has(lm.id) || lm.id === 'head') continue;
      if (lm.kind === 'point') shapes.push({ type: 'circle', c: v, r: 5, color: G, width: 2, alpha: 1, screen: true });
      else if (lm.kind === 'line') shapes.push({ type: 'line', a: v.a, b: v.b, color: G, width: lm.id === 'stem' || lm.id === 'hcl' ? 2.4 : 1.4, dash: !(lm.id === 'stem' || lm.id === 'hcl'), alpha: 0.95 });
    }
    const id = V.stem ? 'stem' : V.hcl ? 'hcl' : null;
    if (id && set.values[id]) {
      const far = (l) => (Math.hypot(l.a.x - n.centre.x, l.a.y - n.centre.y) > Math.hypot(l.b.x - n.centre.x, l.b.y - n.centre.y) ? l.a : l.b);
      shapes.push({ type: 'line', a: far(set.values[id]), b: far(V[id]), color: G, width: 1.4, dash: true, alpha: 1, label: ghost.label });
    }
  }
  if (state.showLines) {
    for (const r of b.results) {
      if (r.status === 'pending') continue;
      const m = p.metrics.find((x) => x.id === r.id);
      if (!m || !m.draw) continue;
      if (r.status === 'info' && state.selMetric !== r.id) continue;   // descriptive lines only on request: keeps the film readable
      let drawn;
      try { drawn = m.draw(b.ctx) || []; } catch { drawn = []; }
      const color = STATUS_COLOR[r.status];
      const sel = state.selMetric === r.id;
      let labelled = false;
      const short = r.text.replace(/\s*\(.*\)$/, '');
      for (const s of drawn) {
        const o = { ...s, color, width: sel ? 2.6 : s.dash ? 1.1 : 1.5, alpha: sel ? 1 : state.selMetric ? 0.35 : 0.8 };
        if (!labelled && (s.type === 'arc' || s.type === 'dim')) { o.label = short; labelled = true; }
        shapes.push(o);
      }
    }
  }
  return { handles, shapes };
}

function rubberXray(pt) {
  const lm = proto().landmarks.find((l) => l.id === state.active);
  if (!lm || !state.pending.length) return [];
  const [a, b] = state.pending;
  if (lm.kind === 'line') return [{ type: 'line', a, b: pt, color: ACTIVE, dash: true }];
  if (lm.kind === 'circle') {
    if (!b) return [{ type: 'line', a, b: pt, color: ACTIVE, dash: true }];
    const c = circleFrom3(a, b, pt);
    return c ? [{ type: 'circle', c: { x: c.cx, y: c.cy }, r: c.r, color: ACTIVE, dash: true }] : [];
  }
  return [];
}

function setLm(id, value, st = 'manual') {
  const set = lmSet();
  set.values[id] = value; set.state[id] = st;
}

function placeXray(pt) {
  const lm = proto().landmarks.find((l) => l.id === state.active);
  if (!lm) return;
  if (lm.kind === 'point') { setLm(lm.id, { x: pt.x, y: pt.y }); donePlacing(); return; }
  state.pending.push({ x: pt.x, y: pt.y });
  if (lm.kind === 'line' && state.pending.length === 2) { setLm(lm.id, { a: state.pending[0], b: state.pending[1] }); donePlacing(); return; }
  if (lm.kind === 'circle' && state.pending.length === 3) {
    const c = circleFrom3(...state.pending);
    if (c) { setLm(lm.id, c); donePlacing(); } else { state.pending.pop(); toast('Those three points are in a line — click a third point elsewhere on the rim.'); }
    return;
  }
  refresh({ light: true });
}

function dragXray(key, pt, phase) {
  const [id, part] = key.split('.');
  const set = lmSet(), v = set.values[id];
  if (!v || !pt) return;
  if (!part) set.values[id] = { x: pt.x, y: pt.y };
  else if (part === 'a' || part === 'b') set.values[id] = { ...v, [part]: { x: pt.x, y: pt.y } };
  else if (part === 'c') set.values[id] = { ...v, cx: pt.x, cy: pt.y };
  else if (part === 'r') {
    set.values[id] = { ...v, r: Math.max(2, Math.hypot(pt.x - v.cx, pt.y - v.cy)) };
    cur().rimAngle[id] = Math.atan2(pt.y - v.cy, pt.x - v.cx);
  }
  set.state[id] = 'manual';
  if (phase !== 'move' && !part && training.isOn()) {
    const item = cur(), kind = training.kindOf(proto(item).id);
    if (kind && training.record(item.film, kind, id, pt, set.values, item.lateralSign, item.image)) {
      toast(`Correction saved for training (${training.count(kind)} for ${kind === 'hemi' ? 'hemiarthroplasty' : kind} films).`);
    }
  }
  if (phase !== 'move' && (id === 'sgt' || id === 'igr')) ssfPrior(proto(), set, cur().lateralSign);
  refresh({ light: phase === 'move' });
  if (phase !== 'move' && IMPLANT_LM.has(id)) relandmark();
}

const IMPLANT_LM = new Set(['gs', 'face', 'stem', 'head']);

/**
 * The reader has corrected the implant: place the bony landmarks again around it with the learned model. Only
 * landmarks that are still estimates (or missing) move; anything the reader placed or confirmed stays put.
 */
function relandmark(item = cur(), quiet = false, only = null) {
  if (!item || item.kind !== 'xray') return;
  const p = proto(item), set = lmSet(item);
  const kind = training.kindOf(p.id);
  // the shipped model, adapted to this reader's own corrections when training mode has recorded any
  const m = kind && training.modelFor(kind);
  const c = kind === 'reverse' ? set.values.gs : set.values.head;
  if (!m || !c) return;
  const A = (q) => [q.x, q.y];
  const st = set.values.stem ? [A(set.values.stem.a), A(set.values.stem.b)].sort((u, v) => u[1] - v[1]) : null;
  const face = kind === 'reverse' && set.values.face ? { a: A(set.values.face.a), b: A(set.values.face.b) } : null;
  const F = learnedFrames({ centre: [c.cx, c.cy], r: c.r, face, stem: st ? { a: st[0], b: st[1] } : null }, item.lateralSign);
  if (!F) return;
  const est = placeLearned({ width: item.image.width, height: item.image.height, data: item.image.data }, F, m);
  let moved = 0;
  for (const lm of p.landmarks) {
    const e = est[lm.id];
    if (!e || IMPLANT_LM.has(lm.id) || set.state[lm.id] === 'manual' || set.state[lm.id] === 'auto' || (only && !only.has(lm.id))) continue;
    set.values[lm.id] = e.a ? { a: { x: e.a[0], y: e.a[1] }, b: { x: e.b[0], y: e.b[1] } } : { x: e.x, y: e.y };
    set.state[lm.id] = 'estimated';
    moved++;
  }
  ssfPrior(p, set, item.lateralSign);
  if (quiet) return;
  if (moved) { refresh(); toast(`${moved} estimated landmark${moved === 1 ? '' : 's'} re-placed around the corrected implant.`); }
}

// ───────────────────────── overlays: CT ─────────────────────────
function ctOverlay(item, paneId, pane) {
  const set = lmSet(item), p = proto(item);
  const handles = [], shapes = [];
  const near = Math.max(1.2, pane.step * 0.75);
  const hp = (key, w, color, opts = {}) => {
    const q = mpr.toPane(pane, w);
    const on = Math.abs(q.depth) <= near;
    handles.push({ key, x: q.x, y: q.y, color, ...opts, ghost: !on, fixed: !on, small: opts.small || !on, label: on ? opts.label : '' });
    return q;
  };
  for (const lm of p.landmarks) {
    const v = set.values[lm.id];
    if (!v) continue;
    const color = lmColor(lm.id, set), dashed = set.state[lm.id] === 'estimated', label = SHORT[lm.id] ?? lm.id;
    if (lm.kind === 'point') {
      const q = mpr.toPane(pane, v);
      if (Math.abs(q.depth) < 45) hp(lm.id, v, color, { dashed, label });
    } else if (lm.kind === 'sphere') {
      const q = mpr.toPane(pane, v.c);
      if (Math.abs(q.depth) < v.r) {
        const re = Math.sqrt(v.r * v.r - q.depth * q.depth);
        shapes.push({ type: 'circle', c: { x: q.x, y: q.y }, r: re / pane.s, color, width: 1.5, dash: dashed, alpha: 0.9 });
        if (Math.abs(q.depth) < 0.85 * v.r) handles.push({ key: `${lm.id}.r`, x: q.x + (re / pane.s) * Math.SQRT1_2, y: q.y - (re / pane.s) * Math.SQRT1_2, color, small: true, dashed });
      }
      if (Math.abs(q.depth) < v.r + 20) hp(`${lm.id}.c`, v.c, color, { dashed, label, small: true });
    } else if (lm.kind === 'line') {
      const a = hp(`${lm.id}.a`, v.a, color, { dashed, label, small: true }), bq = hp(`${lm.id}.b`, v.b, color, { dashed, small: true });
      shapes.push({ type: 'line', a: { x: a.x, y: a.y }, b: { x: bq.x, y: bq.y }, color, width: 1.3, alpha: 0.6, dash: true });
    }
  }
  const samePlane = (pl) => Math.abs(v3.dot(pl.N, pane.N)) > 0.9995 && Math.abs(v3.dot(pl.U, pane.U)) > 0.9995 && Math.abs(mpr.toPane(pane, pl.centre).depth) <= pane.step * 0.6 + 0.2;
  for (const roi of item.rois) {
    if (!samePlane(roi.plane)) continue;
    const pts = roi.world.map((w) => { const q = mpr.toPane(pane, w); return { x: q.x, y: q.y }; });
    const m = MUSCLES.find((x) => x.id === roi.muscle);
    shapes.push({ type: 'poly', pts, closed: true, fill: roi.kind === 'muscle', color: roi.kind === 'muscle' ? '#ff9db0' : '#9fd0ff', width: 1.4, dash: roi.kind === 'pre', label: `${m.short}${roi.kind === 'pre' ? ' premorbid' : ''}` });
  }
  if (state.drawing && state.drawing.pane === paneId && state.drawing.pts.length) {
    shapes.push({ type: 'poly', pts: state.drawing.pts, closed: false, color: ACTIVE, width: 1.6 });
    for (const q of state.drawing.pts) handles.push({ key: 'roi', x: q.x, y: q.y, color: ACTIVE, small: true, fixed: true });
  }
  if (state.pending.length && state.active) for (const w of state.pending) hp('pending', w, ACTIVE, { small: true });
  return { handles, shapes };
}

function placeCt(world, paneId, pt) {
  if (state.drawing) { roiClick(paneId, pt); return; }
  const lm = proto().landmarks.find((l) => l.id === state.active);
  if (!lm) return;
  if (lm.kind === 'point') { setLm(lm.id, world); donePlacing(); return; }
  state.pending.push(world);
  if (state.pending.length === 2) {
    const [a, b] = state.pending;
    if (lm.kind === 'sphere') setLm(lm.id, { c: a, r: Math.max(2, v3.dist(a, b)) });
    else setLm(lm.id, { a, b });
    donePlacing();
    return;
  }
  refresh({ light: true });
}

function dragCt(key, world, phase) {
  const [id, part] = key.split('.');
  const set = lmSet(), v = set.values[id];
  if (!v || !world) return;
  if (!part) set.values[id] = world;
  else if (part === 'a' || part === 'b') set.values[id] = { ...v, [part]: world };
  else if (part === 'c') set.values[id] = { ...v, c: world };
  else if (part === 'r') set.values[id] = { ...v, r: Math.max(2, v3.dist(world, v.c)) };
  set.state[id] = 'manual';
  refresh({ light: phase === 'move' });
}

/** Scapular frame for the Y-view: trigonum + the best available lateral reference. */
function scapFrame(item) {
  const L = lmSet(item).values;
  if (!L.tri) return null;
  const ref = L.gs ? L.gs.c : L.ga && L.gp ? v3.mid(L.ga, L.gp) : L.head ? L.head.c : null;
  if (!ref) return null;
  const f = scapularFrame(L.tri, ref, L.ia || null);
  return f ? { ...f, ref } : null;
}

function updateOblique(item) {
  const f = scapFrame(item);
  if (!f || !mpr) return;
  mpr.setOblique({ title: 'Y-view (⟂ scapular axis)', N: f.lat, U: v3.mul(f.ant, -1), V: v3.mul(f.sup, -1), anchor: v3.sub(f.ref, v3.mul(f.sup, 30)), fov: 220 });
}

// ── muscle outlines ──
function roiStart(muscle, kind) {
  if (state.drawing && state.drawing.muscle === muscle && state.drawing.kind === kind) { roiClose(); return; }
  disarm();
  state.drawing = { muscle, kind, pane: null, pts: [], plane: null };
  mpr.arm(true, (pt, paneId) => (state.drawing && state.drawing.pane === paneId && state.drawing.pts.length
    ? [{ type: 'line', a: state.drawing.pts[state.drawing.pts.length - 1], b: pt, color: ACTIVE, dash: true }] : []));
  refresh();
}

function roiClick(paneId, pt) {
  const d = state.drawing;
  if (!d.pane) { d.pane = paneId; d.plane = mpr.planeOf(paneId); }
  if (d.pane !== paneId) { toast('Keep the outline on one pane.'); return; }
  const last = d.pts[d.pts.length - 1];
  if (last && Math.hypot(last.x - pt.x, last.y - pt.y) < 1.5) return;        // second click of a double-click
  const first = d.pts[0];
  if (first && d.pts.length >= 3 && Math.hypot(first.x - pt.x, first.y - pt.y) < 5) { roiClose(); return; }
  d.pts.push({ x: pt.x, y: pt.y });
  mpr.refreshOverlay(paneId);
}

function roiClose() {
  const d = state.drawing;
  state.drawing = null;
  mpr.arm(false);
  if (d && d.pts.length >= 3) {
    const item = cur();
    const pane = mpr.panes[d.pane];
    const raster = mpr.samplePlane(d.plane, null, true);   // nearest voxel: see Mpr.samplePlane
    const values = sampleRoi(raster, d.pts.map((q) => [q.x, q.y]));
    const stats = roiStats(values, d.plane.s * d.plane.s);
    // keep the outline in world mm so it survives pane changes
    const save = mpr.cursor.slice();
    const world = d.pts.map((q) => {
      const u = (q.x - (d.plane.w - 1) / 2) * d.plane.s, v = (q.y - (d.plane.h - 1) / 2) * d.plane.s;
      return [0, 1, 2].map((i) => d.plane.centre[i] + u * d.plane.U[i] + v * d.plane.V[i]);
    });
    void save; void pane;
    item.rois = item.rois.filter((r) => !(r.muscle === d.muscle && r.kind === d.kind));
    item.rois.push({ muscle: d.muscle, kind: d.kind, plane: d.plane, world, stats });
  } else if (d) toast('An outline needs at least three points.');
  refresh();
}

/** Synthetic examples only: put every remaining landmark at its known true position, to show a complete assessment. */
function fillFromTruth() {
  const item = cur(), t = item.truth;
  if (!t) return;
  const p = proto(item), set = lmSet(item);
  const pt = (a) => (item.kind === 'xray' ? { x: a[0], y: a[1] } : a);
  const alias = item.kind === 'xray'
    ? { gs: t.glenosphere, face: t.glenosphere && t.glenosphere.face, hcl: t.shaft }
    : { gs: t.glenosphere && { c: t.glenosphere.center, r: t.glenosphere.radius }, head: t.headCenter && { c: t.headCenter, r: t.headRadius }, igr: t.ginf, sgr: t.gsup };
  for (const lm of p.landmarks) {
    if (set.values[lm.id] && set.state[lm.id] !== 'estimated') continue;
    const v = alias[lm.id] || t[lm.id];
    if (!v) continue;
    let val = null;
    if (lm.kind === 'point') val = Array.isArray(v) ? pt(v) : null;
    else if (lm.kind === 'line') val = v.a && v.b ? { a: pt(v.a), b: pt(v.b) } : null;
    else if (lm.kind === 'circle') val = v.r ? { cx: v.cx, cy: v.cy, r: v.r } : null;
    else if (lm.kind === 'sphere') val = v.c ? v : null;
    if (val) { set.values[lm.id] = val; set.state[lm.id] = 'manual'; }
  }
  disarm();
  refresh();
  toast('Example only: the remaining landmarks were put at the phantom\'s known positions.');
}

// ───────────────────────── placement flow ─────────────────────────
function arm(id, guided = false) {
  if (state.drawing) { state.drawing = null; if (mpr) mpr.arm(false); }
  state.active = id; state.pending = []; state.guided = guided;
  const item = cur();
  if (item.kind === 'xray') xview.setArmed(true, rubberXray);
  else mpr.arm(true, null);
  if (state.tab !== 'landmarks') setTab('landmarks'); else refresh();
}

function disarm() {
  state.active = null; state.pending = []; state.guided = false;
  if (xview) xview.setArmed(false);
  if (mpr) mpr.arm(false);
}

function nextMissing(includeOptional = false) {
  const p = proto(), set = lmSet();
  return p.landmarks.find((l) => !set.values[l.id] && (includeOptional || !l.optional)) || null;
}

function donePlacing() {
  if (state.active && IMPLANT_LM.has(state.active)) setTimeout(relandmark, 0);
  if ((state.active === 'sgt' || state.active === 'igr') && cur().kind === 'xray') ssfPrior(proto(), lmSet(), cur().lateralSign);
  const guided = state.guided;
  const next = guided ? nextMissing() : null;
  if (next) arm(next.id, true);
  else { disarm(); refresh(); if (guided) toast('All required landmarks are placed. Check the estimated ones, then open Measurements.'); }
}

// ───────────────────────── rendering ─────────────────────────
function showIntro() {
  $('intro').hidden = false; $('workspace').hidden = true; $('btn-new').hidden = true;
  document.body.classList.remove('working');
}

function showWorkspace() {
  $('intro').hidden = true; $('workspace').hidden = false; $('btn-new').hidden = false; $('intro-error').hidden = true;
  document.body.classList.add('working');
}

function select(i) {
  disarm();
  state.cur = i; state.selMetric = null;
  const item = cur();
  const isCt = item.kind === 'ct';
  $('xray-view').hidden = isCt; $('ct-view').hidden = !isCt;
  $('tools-xray').hidden = isCt; $('tools-ct').hidden = !isCt;
  if (mpr) { mpr.destroy(); mpr = null; }
  if (isCt) {
    mpr = new Mpr($('ct-view'), item.volume);
    mpr.overlay = (paneId, pane) => ctOverlay(item, paneId, pane);
    mpr.onPlace = placeCt;
    mpr.onHandleDrag = dragCt;
    for (const id of Object.keys(mpr.panes)) mpr.panes[id].el.addEventListener('dblclick', () => { if (state.drawing) roiClose(); });
    const set = lmSet(item);
    const focus = set.values.gs ? set.values.gs.c : set.values.head ? set.values.head.c : null;
    updateOblique(item);
    if (focus) mpr.setCursor(focus);
    mpr.setActive('axial');
    if (state.tab === 'decision' && typeOf(item) !== 'native') state.tab = 'landmarks';
  } else {
    if (!xview) {
      xview = new ImageView($('xray-view'));
      xview.onPlace = placeXray;
      xview.onHandleDrag = dragXray;
      xview.onClick = (pt, key) => { if (key) { const id = key.split('.')[0]; state.selLm = id; } };
    }
    xview.fitted = true;
    xview.setRaster(item.image, item.image.window);
    focusLandmarks(item);
    $('view').value = item.view;
    if (state.tab === 'muscle') state.tab = 'landmarks';
  }
  if (state.tab === 'compare' && (!comparable(item) || (!compareCandidates(item).length && typeOf(item) !== 'reverse'))) state.tab = 'landmarks';
  refresh();
}

/** Zoom a radiograph to the landmarks that were placed: screenshots are mostly black border. */
function focusLandmarks(item) {
  const vals = Object.values(lmSet(item).values);
  if (vals.length < 3) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const v of vals) {
    if (v.r !== undefined) { add(v.cx - v.r, v.cy - v.r); add(v.cx + v.r, v.cy + v.r); } else if (v.a) { add(v.a.x, v.a.y); add(v.b.x, v.b.y); } else add(v.x, v.y);
  }
  const im = item.image;
  // only worth it when the landmarks occupy a small part of the picture
  if ((x1 - x0) * 1.6 < im.width * 0.8 || (y1 - y0) * 1.6 < im.height * 0.8) xview.showRegion(x0, y0, x1, y1, 0.3);
}

function renderItems() {
  const el = $('items');
  const mixed = new Set(state.items.map((it) => typeOf(it))).size > 1;
  const TYPE_SHORT = { reverse: 'Reverse', pyc: 'Hemi', native: 'Native' };
  let html = state.items.map((it, i) => `<button class="item${i === state.cur ? ' on' : ''}" role="tab" data-item="${i}"><span class="k">${it.kind === 'ct' ? 'CT' : 'X-ray'}${mixed ? ` · ${TYPE_SHORT[typeOf(it)]}` : ''}</span>${panel.esc(it.name.replace(/^(X-ray|CT|Image)\s*/, '') || String(i + 1))}</button>`).join('');
  if (state.loadingName) html += `<span class="item loading">${panel.esc(state.loadingName)}…</span>`;
  el.innerHTML = html;
}

function renderStudy(item, b) {
  const T = typeOf(item);
  for (const btn of $('implant').querySelectorAll('button')) btn.classList.toggle('on', btn.dataset.implant === T);
  const notes = [];
  const d = item.det || {};
  if (d.error) notes.push(`<span>${panel.esc(d.error)}</span>`);
  if (item.kind === 'xray') {
    const weak = d.reverse && d.reverse.glenosphere.score < 0.6;
    if (weak && T === 'reverse') notes.push('<span>The glenosphere was found with low confidence. Check its circle before reading any number: drag the centre and the edge handle, or place it again with three clicks on the dome outline.</span>');
    if (!d.reverse && !d.error && T === 'reverse' && d.implant === 'reverse') notes.push('<span>The implant could not be found automatically on this image. Place the glenosphere by hand: press + next to "Glenosphere outline" and click three points on the dome; the bony landmarks are then estimated around it when you press Detect again.</span>');
    if (T === 'pyc' && !d.head && !d.error && d.implant === 'pyc') notes.push('<span>The prosthetic head could not be found automatically. Place it by hand with three clicks on its outline.</span>');
    for (const w of item.image.warnings || []) notes.push(`<span>${panel.esc(w)}</span>`);
  } else {
    if (T === 'reverse' && !d.reverse) notes.push('<span>No glenosphere was found automatically in this scan. Place the glenosphere by hand, or switch the study type.</span>');
    if (d.metal && d.metal.saturated) notes.push('<span class="info">Metal is clipped at the scanner\'s maximum CT number; implant edges are taken at half-maximum and may read slightly large.</span>');
    for (const w of (item.volume.info && item.volume.info.warnings) || []) notes.push(`<span>${panel.esc(w)}</span>`);
  }
  $('detect-note').innerHTML = notes.join('');
  // calibration
  const cal = b.protocol.calibration;
  let html = '';
  if (item.kind === 'xray') {
    if (cal) {
      const known = cal.sizes.includes(item.calib.size);
      html += `<div class="calib-row"><label for="cal-size" title="${panel.esc(cal.hint)}">${panel.esc(cal.label)}</label>
        <select id="cal-size"><option value="">Unknown</option>${cal.sizes.map((s) => `<option value="${s}"${item.calib.size === s ? ' selected' : ''}>${s} mm</option>`).join('')}<option value="other"${item.calib.size && !known ? ' selected' : ''}>Other…</option></select>
        ${item.calib.size && !known ? `<input id="cal-custom" type="number" min="20" max="70" step="0.5" value="${item.calib.size}"> mm` : ''}</div>`;
    }
    if (b.protocol.view === 'ap') {
      const n = b.neutral;
      const btn = (v, t) => `<button data-neutral="${v}" class="${state.neutral === v ? 'on' : ''}">${t}</button>`;
      html += `<div class="calib-row neutral-row"><span class="lbl">Arm position</span><div class="seg" role="group" aria-label="Arm position normalisation">${btn('off', 'As taken')}${btn('vertical', 'Arm vertical')}${btn('scapula', 'To scapula')}</div></div>
        ${state.neutral === 'off' ? '' : `<span class="help">${n && n.ok ? `Humerus turned <b>${Math.abs(n.deg).toFixed(1)}°</b> about the centre of rotation (${n.kind === 'shara' ? 'SHARA' : 'HARA'} ${n.before.toFixed(0)}° → ${n.want.toFixed(0)}°); purple outline.` : `Not normalised: ${panel.esc(n ? n.reason : '')}`}</span>`}`;
    }
    html += b.scale.mm
      ? `<span class="scale">Scale: <b>${panel.esc(b.scale.text)}</b>${b.scale.source === 'dicom' && !item.sample ? ' — includes film magnification' : ''}</span>`
      : `<span class="scale none">Not calibrated: angles and ratios only.${cal ? ` Enter the ${panel.esc(cal.label.toLowerCase())} to get millimetres.` : ' This image has no pixel spacing; distances cannot be given.'}</span>`;
  } else {
    const v = item.volume;
    html += `<span class="scale">${v.dims.join(' × ')} voxels · ${v.spacing.map((s) => s.toFixed(2)).join(' × ')} mm · measurements in 3D, true size</span>`;
  }
  $('calib').innerHTML = html;
  $('anon-body').innerHTML = panel.anonView(item.sample ? null : state.report);
  const views = viewsFor(T);
  $('view-field').hidden = views.length < 2;
  const sel = $('view');
  if (sel.dataset.views !== views.join()) { sel.innerHTML = views.map((v) => `<option value="${v}">${VIEW_LABEL[v]}</option>`).join(''); sel.dataset.views = views.join(); }
  sel.value = item.view;
  $('btn-flip').textContent = `Humerus: ${item.lateralSign > 0 ? 'right' : 'left'} of image`;
  $('btn-lines').classList.toggle('on', state.showLines);
}

function renderTabs(b) {
  const item = b.item;
  const tabs = document.querySelectorAll('.tabs button');
  for (const t of tabs) {
    if (t.dataset.tab === 'muscle') t.hidden = item.kind !== 'ct';
    if (t.dataset.tab === 'decision') t.hidden = typeOf(item) !== 'native';
    if (t.dataset.tab === 'compare') t.hidden = !comparable(item) || (!compareCandidates(item).length && typeOf(item) !== 'reverse');
    t.classList.toggle('on', t.dataset.tab === state.tab);
    if (t.dataset.tab === 'measure') {
      const c = b.appraisal.counts;
      const badge = c.out ? `<span class="n out">${c.out}</span>` : c.borderline ? `<span class="n borderline">${c.borderline}</span>` : c.good ? `<span class="n good">${c.good}</span>` : '';
      t.innerHTML = `Measurements${badge}`;
    }
  }
  for (const id of ['landmarks', 'measure', 'muscle', 'decision', 'compare', 'appraisal']) $(`tab-${id}`).hidden = id !== state.tab;
}

function renderPanel(b) {
  const item = b.item, set = lmSet(item), p = b.protocol;
  renderTabs(b);
  if (state.tab === 'landmarks') {
    const lm = p.landmarks.find((l) => l.id === state.active);
    const need = lm ? (lm.kind === 'circle' ? 3 : lm.kind === 'point' ? 1 : 2) : 0;
    const placing = lm ? (need > 1 ? `click ${state.pending.length + 1} of ${need}` : 'click the image') : '';
    $('lm-list').innerHTML = panel.landmarkList(p, set.values, set.state, state.active, placing);
    const req = p.landmarks.filter((l) => !l.optional);
    const done = req.filter((l) => set.values[l.id]).length;
    const est = p.landmarks.filter((l) => set.state[l.id] === 'estimated' && set.values[l.id]).length;
    $('lm-count').textContent = `${done} / ${req.length}${est ? ` · ${est} to check` : ''}`;
    $('btn-guide').textContent = state.active ? 'Stop placing' : nextMissing() ? 'Place the next one' : nextMissing(true) ? 'Place optional ones' : 'All placed';
    $('btn-guide').disabled = !state.active && !nextMissing(true);
    $('btn-confirm-all').hidden = !est;
    $('btn-redetect').hidden = item.kind !== 'xray';
    $('btn-demo').hidden = !item.truth || !p.landmarks.some((l) => !set.values[l.id] || set.state[l.id] === 'estimated');
    renderTraining(item, p);
  } else if (state.tab === 'measure') {
    $('m-list').innerHTML = panel.measurementList(b.results, state.selMetric);
    $('f-list').innerHTML = panel.findingsForm(p, item.findings[p.id], b.findings);
    panel.applyGeometry($('tab-measure'));
  } else if (state.tab === 'muscle') {
    $('mu-list').innerHTML = panel.muscleView(item.rois, b.extraResults, state.drawing);
    panel.applyGeometry($('tab-muscle'));
  } else if (state.tab === 'decision') {
    $('decision').innerHTML = panel.decisionView(decision(), state.clinical);
    panel.applyGeometry($('tab-decision'));
  } else if (state.tab === 'compare') {
    const cmp = comparisonFor(item);
    if (cmp && item.compareWith === undefined) item.compareWith = cmp.other.uid;
    $('compare').innerHTML = panel.compareView(cmp, compareCandidates(item), typeOf(item) === 'reverse');
  } else if (state.tab === 'appraisal') {
    let html = panel.appraisalView(b.appraisal);
    $('appraisal').innerHTML = html;
    panel.applyGeometry($('tab-appraisal'));
  }
}

function renderStatus(b) {
  const item = b.item, p = b.protocol;
  const lm = p.landmarks.find((l) => l.id === state.active);
  let html;
  if (state.drawing) {
    const m = MUSCLES.find((x) => x.id === state.drawing.muscle);
    html = `<span class="armed">Outline ${panel.esc(state.drawing.kind === 'pre' ? m.premorbid : m.label)}</span><span class="hint">Click round the edge on one pane; double-click or <kbd>Enter</kbd> to close, <kbd>Esc</kbd> to cancel.</span>`;
  } else if (lm) {
    const how = lm.kind === 'circle' ? `Click three points on its outline (${state.pending.length}/3).` : lm.kind === 'line' ? `Click its two ends (${state.pending.length}/2).` : lm.kind === 'sphere' ? (state.pending.length ? 'Now click a point on its surface.' : 'Click its centre, then a point on its surface.') : 'Click it.';
    html = `<span class="armed">${panel.esc(lm.label)}</span><span class="hint">${panel.esc(lm.help)} ${how} <kbd>Esc</kbd> cancels.</span>`;
  } else if (item.kind === 'ct') {
    html = '<span>Click to move the crosshair · scroll through slices · <kbd>Ctrl</kbd>+scroll zooms · drag pans · right-drag changes the window · drag a landmark to adjust it</span>';
  } else {
    html = '<span>Drag a landmark to adjust it (a magnifier appears) · scroll zooms · drag pans · right-drag changes brightness and contrast · double-click fits</span>';
  }
  $('statusbar').innerHTML = html;
}

/** Re-evaluate the current item and redraw. `light` = during a drag: overlay now, panel shortly after. */
function refresh(opts = {}) {
  const item = cur();
  if (!item) return;
  const b = assess(item);
  if (item.kind === 'xray') xview.setOverlay(xrayOverlay(item, b));
  else { updateOblique(item); mpr.refreshOverlays(); }
  if (opts.light) {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => { const bb = assess(cur()); renderPanel(bb); renderStatus(bb); }, 90);
    return;
  }
  renderItems();
  renderStudy(item, b);
  renderPanel(b);
  renderStatus(b);
}

function setTab(tab) { state.tab = tab; refresh(); }

function renderTraining(item, p) {
  const kind = item.kind === 'xray' ? training.kindOf(p.id) : null;
  $('train').hidden = !kind;
  if (!kind) return;
  $('train-on').checked = training.isOn();
  const n = training.count(kind), all = training.count();
  const name = kind === 'hemi' ? 'hemiarthroplasty' : kind;
  $('train-info').textContent = training.isOn()
    ? `Drag a misplaced landmark to where it belongs; the correction is learned. ${n} saved for ${name} films${n ? ', used to place landmarks' : ''}.`
    : n ? `${n} saved corrections for ${name} films are used to place landmarks.` : 'Teach the detector with your own corrections.';
  $('train-export').hidden = $('train-clear').hidden = !all;
}

function toast(text) {
  const el = $('toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 4200);
}

// ───────────────────────── exports ─────────────────────────
function bundles() { return state.items.map((it) => assess(it)); }

function save(name, mime, content) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function reportText() {
  const types = [...new Set(state.items.map((i) => typeOf(i)))];
  return buildText(bundles(), decision(), { implantLabel: types.map((t) => IMPLANTS.find((x) => x.id === t).label).join(' + '), comparisons: comparisons() });
}

async function copyReport() {
  const text = reportText();
  try { await navigator.clipboard.writeText(text); toast('Report copied to the clipboard.'); } catch { save('shoulder-assessment.txt', 'text/plain', text); }
}

function exportPng() {
  const item = cur();
  const canvas = item.kind === 'xray' ? xview.snapshot() : mpr.panes[mpr.active].view.snapshot(1600);
  if (!canvas) return;
  if (item.kind === 'xray' && item.image.meta && item.image.meta.burnedInRisk) toast('Check the exported picture for a name or date burned into the image before sharing it.');
  canvas.toBlob((blob) => blob && save('shoulder-annotated.png', 'image/png', blob), 'image/png');
}

// ───────────────────────── intake ─────────────────────────
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      try { out.push(await new Promise((res, rej) => entry.file(res, rej))); } catch { /* unreadable: skip */ }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

/** Add images to the open study (the pre-operative film for the Comparison tab). */
function addFiles(files, role) {
  if (!files || !files.length) return;
  state.addRole = role;
  onProgress({ scope: 'scan', fraction: 0, label: 'Reading and anonymising files…' });
  worker.postMessage({ type: 'scan', files: [...files], append: true });
}

function open(files) {
  if (!files || !files.length) return;
  $('intro-error').hidden = true;
  state.autoSwitched = false;
  onProgress({ scope: 'scan', fraction: 0, label: 'Reading and anonymising files…' });
  worker.postMessage({ type: 'scan', files: [...files] });
}

function openSample(modality) {
  state.report = null; state.items = []; state.cur = -1; state.queue = []; state.autoSwitched = false; state.implantLocked = true;
  showWorkspace();
  state.loadingName = modality === 'ct' ? 'Synthetic CT' : 'Synthetic X-ray';
  state.loadingImplant = state.implant;
  renderItems();
  worker.postMessage({ type: 'sample', modality, kind: { reverse: 'reverse', pyc: 'hemi', native: 'native' }[state.implant] });
}

function setImplant(id, lock = true) {
  state.implant = id;
  if (lock) state.implantLocked = true;
  state.autoSwitched = false;
  for (const t of document.querySelectorAll('.type')) { t.classList.toggle('on', t.dataset.implant === id); t.setAttribute('aria-checked', String(t.dataset.implant === id)); }
  const detail = {
    reverse: 'Lateralisation and distalisation angles, acromion–tuberosity distance, glenosphere tilt and overhang, notching and stem fit — and the change from the pre-op film, at the same arm position.',
    pyc: 'Overstuffing (centre of rotation, head size and height), glenoid erosion and medialisation, stem fit — and change between films.',
    native: 'Critical shoulder angle, acromiohumeral distance, glenoid inclination and version, posterior acromial shape — and anatomic versus reverse.',
  }[id];
  if (detail && $('type-detail')) $('type-detail').textContent = detail;
  if (cur()) {
    disarm(); state.selMetric = null;
    const item = cur();
    item.implant = id;
    if (item.kind === 'xray' && !viewsFor(id).includes(item.view)) item.view = 'ap';
    if ((state.tab === 'decision' && id !== 'native') || (state.tab === 'muscle' && item.kind !== 'ct')) state.tab = 'landmarks';
    refresh();
    // the radiograph was analysed as another type: analyse it again as the one now chosen
    if (item.kind === 'xray' && item.det && item.det.implant && item.det.implant !== id) redetect();
  }
}

// ───────────────────────── events ─────────────────────────
function bind() {
  for (const t of document.querySelectorAll('.type')) t.addEventListener('click', () => setImplant(t.dataset.implant));
  $('implant').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setImplant(b.dataset.implant); });
  document.querySelector('.panel').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="add-preop"]')) $('in-preop').click();
    const mb = e.target.closest('[data-cmp-match]');
    if (mb && cur()) { cur().compareMatch = mb.dataset.cmpMatch; refresh(); }
  });
  $('in-preop').addEventListener('change', (e) => { addFiles(e.target.files, 'preop'); e.target.value = ''; });
  $('calib').addEventListener('click', (e) => { const b = e.target.closest('[data-neutral]'); if (b) { state.neutral = b.dataset.neutral; refresh(); } });
  const drop = $('drop');
  $('btn-files').addEventListener('click', (e) => { e.stopPropagation(); $('in-files').click(); });
  $('btn-folder').addEventListener('click', (e) => { e.stopPropagation(); $('in-folder').click(); });
  drop.addEventListener('click', (e) => { if (e.target.closest('button')) return; $('in-files').click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('in-files').click(); } });
  for (const id of ['in-files', 'in-folder']) $(id).addEventListener('change', (e) => { open(e.target.files); e.target.value = ''; });
  for (const b of document.querySelectorAll('[data-sample]')) b.addEventListener('click', () => openSample(b.dataset.sample));
  window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  window.addEventListener('dragleave', () => drop.classList.remove('over'));
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer) open(await filesFromDrop(e.dataTransfer));
  });
  $('btn-new').addEventListener('click', () => {
    disarm(); if (mpr) { mpr.destroy(); mpr = null; }
    state.items = []; state.cur = -1; state.queue = []; state.implantLocked = false;
    worker.postMessage({ type: 'reset' });
    showIntro();
  });

  $('items').addEventListener('click', (e) => { const b = e.target.closest('[data-item]'); if (b) select(Number(b.dataset.item)); });
  $('view').addEventListener('change', (e) => { disarm(); cur().view = e.target.value; refresh(); });
  $('btn-flip').addEventListener('click', () => { cur().lateralSign *= -1; refresh(); });
  $('btn-lines').addEventListener('click', () => { state.showLines = !state.showLines; refresh(); });
  $('btn-fit').addEventListener('click', () => xview.fit());
  $('btn-invert').addEventListener('click', () => {
    const item = cur(), im = item.image, d = im.data, s = im.min + im.max;
    for (let i = 0; i < d.length; i++) d[i] = s - d[i];
    im.window = { center: s - im.window.center, width: im.window.width };
    xview.setRaster(im, im.window);
    redetect();
  });
  $('ct-window').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !mpr) return;
    for (const x of $('ct-window').querySelectorAll('button')) x.classList.toggle('on', x === b);
    mpr.setWindow(b.dataset.win);
  });
  $('btn-yview').addEventListener('click', () => {
    const f = scapFrame(cur());
    if (!f) { toast('Mark the trigonum spinae and the glenoid (or glenosphere) first — the Y-view is built from them.'); return; }
    mpr.setCursor(v3.sub(f.ref, v3.mul(f.lat, typeOf() === 'reverse' ? 30 : 18)));
    mpr.setActive('oblique');
    toast('Scroll in the Y-view pane to the most lateral slice where the scapular spine still joins the body.');
  });

  document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.tab = b.dataset.tab; refresh(); } });
  $('btn-guide').addEventListener('click', () => {
    if (state.active) { disarm(); refresh(); return; }
    const n = nextMissing() || nextMissing(true);
    if (n) arm(n.id, true);
  });
  $('btn-confirm-all').addEventListener('click', () => {
    const set = lmSet();
    for (const id of Object.keys(set.state)) if (set.state[id] === 'estimated') set.state[id] = 'manual';
    refresh();
  });
  $('btn-redetect').addEventListener('click', redetect);
  $('train-on').addEventListener('change', (e) => {
    training.setOn(e.target.checked);
    refresh();
    toast(e.target.checked ? 'Training mode on: drag any misplaced landmark to its true position and the correction is learned.' : 'Training mode off: corrections are no longer recorded (the ones saved are still used).');
  });
  $('train-export').addEventListener('click', () => save('rsa-check-training.json', 'application/json', training.exportText()));
  $('train-import').addEventListener('click', () => $('in-train').click());
  $('in-train').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { const n = training.importText(await f.text()); toast(`${n} correction${n === 1 ? '' : 's'} imported.`); refresh(); } catch (err) { toast(err.message || 'Could not read that file.'); }
  });
  $('train-clear').addEventListener('click', () => {
    if (!confirm('Delete every saved landmark correction from this browser?')) return;
    training.clear(); refresh(); toast('Saved corrections deleted.');
  });
  $('btn-demo').addEventListener('click', fillFromTruth);

  document.querySelector('.panel').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      const id = act.dataset.lm, set = cur() ? lmSet() : null;
      switch (act.dataset.act) {
        case 'lm-place': arm(id); break;
        case 'lm-clear': delete set.values[id]; delete set.state[id]; if (state.active === id) disarm(); refresh(); break;
        case 'lm-confirm': set.state[id] = 'manual'; refresh(); break;
        case 'lm-go': goTo(id); break;
        case 'switch': setImplant(act.dataset.implant); break;
        case 'roi': roiStart(act.dataset.muscle, act.dataset.kind); break;
        case 'roi-clear': cur().rois = cur().rois.filter((r) => r.muscle !== act.dataset.muscle); refresh(); break;
      }
      return;
    }
    const head = e.target.closest('.m-head');
    if (head && state.tab === 'measure') {
      const id = head.parentElement.dataset.metric;
      state.selMetric = state.selMetric === id ? null : id;
      refresh();
    }
  });
  document.querySelector('.panel').addEventListener('change', (e) => {
    const t = e.target, item = cur();
    if (t.dataset.finding) { item.findings[proto().id][t.dataset.finding] = t.value; refresh(); }
    else if (t.dataset.clin) { state.clinical[t.dataset.clin] = t.type === 'checkbox' ? t.checked : t.value; refresh(); }
    else if (t.dataset.cmp === 'other') { item.compareWith = Number(t.value); refresh(); }
    else if (t.dataset.cmp === 'order') { item.compareOrder = t.value; refresh(); }
    else if (t.dataset.cmp === 'months') { const v = Number(t.value); item.compareMonths = v > 0 ? v : null; refresh(); }
    else if (t.id === 'cal-size') { item.calib.size = t.value === 'other' ? 37 : t.value ? Number(t.value) : null; refresh(); }
    else if (t.id === 'cal-custom') { const v = Number(t.value); item.calib.size = v >= 20 && v <= 70 ? v : null; refresh(); }
  });

  $('btn-copy').addEventListener('click', copyReport);
  $('btn-txt').addEventListener('click', () => save('shoulder-assessment.txt', 'text/plain', reportText()));
  $('btn-csv').addEventListener('click', () => save('shoulder-measurements.csv', 'text/csv', buildCsv(bundles())));
  $('btn-json').addEventListener('click', () => save('shoulder-assessment.json', 'application/json', JSON.stringify(buildJson(bundles(), decision(), { implant: state.implant, comparisons: comparisons() }), null, 2)));
  $('btn-png').addEventListener('click', exportPng);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.drawing) { state.drawing = null; mpr.arm(false); refresh(); } else if (state.active) { disarm(); refresh(); }
    } else if (e.key === 'Enter' && state.drawing) { e.preventDefault(); roiClose(); }
  });
}

function goTo(id) {
  const item = cur(), v = lmSet().values[id];
  if (!v) { arm(id); return; }
  if (item.kind === 'xray') {
    const p = v.cx !== undefined ? { x: v.cx, y: v.cy } : v.a ? { x: (v.a.x + v.b.x) / 2, y: (v.a.y + v.b.y) / 2 } : v;
    xview.centerOn(p, Math.min(2.5, xview.view.scale * 1.0001 < 1 ? 1 : xview.view.scale));
  } else {
    const w = v.c || (v.a ? v3.mid(v.a, v.b) : v);
    mpr.setCursor(w, { centre: true });
  }
}

function redetect() {
  const item = cur();
  if (!item) return;
  if (item.kind === 'ct') {
    const set = lmSet();
    const near = set.values.head ? set.values.head.c : mpr.cursor;
    const h = detectHeadSphere(item.volume, { near, mode: typeOf(item) === 'pyc' ? 'implant' : 'bone' });
    if (h) { setLm('head', { c: h.center, r: h.radius }, 'auto'); refresh(); } else toast('No sphere found near the crosshair.');
    return;
  }
  onProgress({ scope: 'load', fraction: 0.5, label: 'Looking for the implant…' });
  const im = item.image;
  item.det = { ...(item.det || {}), implant: typeOf(item) };
  worker.postMessage({ type: 'detect', reqId: item.uid, implant: typeOf(item), image: { width: im.width, height: im.height, data: im.data, pixelSpacing: im.pixelSpacing } });
}

bind();
// Test hook: lets the end-to-end test read state without scraping the DOM. Holds no patient identifiers.
window.__rsa = {
  state, setNeutral: (v) => { state.neutral = v; refresh(); }, assess: () => (cur() ? assess(cur()) : null), decision, setLm: (id, v) => { setLm(id, v); refresh(); }, select, reportText,
  csv: () => buildCsv(bundles()), json: () => buildJson(bundles(), decision(), { implant: state.implant, comparisons: comparisons() }), compare: () => (cur() ? comparisonFor(cur()) : null),
  screen: (p) => { const r = xview.canvas.getBoundingClientRect(), q = xview.toScreen(p); return { x: r.left + q.x, y: r.top + q.y }; },
  ctScreen: (paneId, w) => { const pane = mpr.panes[paneId], r = pane.view.canvas.getBoundingClientRect(), q = pane.view.toScreen(mpr.toPane(pane, w)); return { x: r.left + q.x, y: r.top + q.y }; },
  ctCursor: (w) => mpr.setCursor(w),
};
