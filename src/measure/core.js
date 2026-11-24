// Protocol engine: turns placed landmarks into measurements, grades each against its published reference bands
// and composes a plain-language appraisal. Protocols (./protocols/*.js) are declarative; this file is generic.
//
// Status vocabulary (drives the colour coding everywhere):
//   good        within the published target / typical range
//   borderline  outside the target but short of a level tied to worse outcomes, or evidence is mixed
//   out         outside the range in the direction the literature links to a problem
//   info        descriptive only — no validated cut-off exists; shown for the record, not judged
//   pending     cannot be computed yet (landmark or calibration missing)

export const STATUS_ORDER = { out: 0, borderline: 1, good: 2, info: 3, pending: 4 };
export const STATUS_LABEL = { good: 'Within range', borderline: 'Borderline', out: 'Outside range', info: 'Descriptive', pending: 'Not measured' };

export const EVIDENCE_LABEL = {
  published: 'Published cut-off',
  contested: 'Published range — not reproduced by later studies',
  descriptive: 'Descriptive norm',
  pragmatic: 'Pragmatic — no validated cut-off',
};

/** Format a value with its unit; angles and percentages to 1 decimal by default, ratios to 2. */
export function fmt(value, unit, decimals) {
  if (!Number.isFinite(value)) return '—';
  const d = decimals ?? (unit === '' || unit === 'ratio' ? 2 : 1);
  const s = value.toFixed(d);
  if (unit === '°') return `${s}°`;
  if (unit === '%') return `${s}%`;
  if (unit === 'ratio' || unit === '') return s;
  return `${s} ${unit}`;
}

/** Population reference range: norm = { mean, sd, n, src }. Returns { lo, hi, z, inside, text } or null. */
export function normRange(norm, value) {
  if (!norm || !(norm.sd > 0)) return null;
  const lo = norm.mean - 1.96 * norm.sd, hi = norm.mean + 1.96 * norm.sd;
  const r = { lo, hi };
  if (!Number.isFinite(value)) return r;
  const z = (value - norm.mean) / norm.sd, inside = value >= lo && value <= hi;
  const f = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));
  const sign = z >= 0 ? '+' : '−';
  return { ...r, z, inside, text: `${inside ? 'Within' : 'Outside'} the range of 95% of reverse shoulders in ${norm.src}: ${f(lo)}–${f(hi)} (mean ${f(norm.mean)} ± ${f(norm.sd)}, n = ${norm.n}). This film: ${sign}${Math.abs(z).toFixed(1)} SD.` };
}

/** The band a value falls in. Bands are ordered by ascending `upTo` (exclusive upper bound); the last has none. */
export function bandFor(bands, value) {
  if (!bands || !bands.length || !Number.isFinite(value)) return null;
  for (const b of bands) if (b.upTo === undefined || value < b.upTo) return b;
  return bands[bands.length - 1];
}

const has = (ctx, id) => ctx.L[id] !== undefined && ctx.L[id] !== null;

/** Evaluate every metric of a protocol. ctx = { L: {id: value}, state: {id: 'auto'|'estimated'|'manual'}, mm, ... }. */
export function evaluate(protocol, ctx) {
  return protocol.metrics.map((m) => evaluateMetric(m, ctx));
}

export function evaluateMetric(m, ctx) {
  const base = {
    id: m.id, label: m.label, unit: m.unit, group: m.group, target: m.target || '', evidence: m.evidence || 'descriptive',
    what: m.what || '', caveat: m.caveat || '', refs: m.refs || [], gauge: m.gauge || null, bands: m.bands || null,
    norm: m.norm || null,
    value: NaN, text: '—', status: 'pending', tag: '', say: '', missing: [], provisional: false, needsScale: false,
  };
  const missing = (m.needs || []).filter((id) => !has(ctx, id));
  if (missing.length) return { ...base, missing };
  if (m.scale && !(ctx.mm > 0)) return { ...base, needsScale: true };
  let value;
  try { value = m.compute(ctx); } catch { value = NaN; }
  if (value === null || value === undefined || !Number.isFinite(value)) return { ...base, missing: m.softNeeds ? m.softNeeds.filter((id) => !has(ctx, id)) : [] };
  const band = bandFor(m.bands, value);
  const provisional = (m.needs || []).some((id) => ctx.state && ctx.state[id] === 'estimated');
  const say = band ? (typeof band.say === 'function' ? band.say(value, ctx) : band.say || '') : '';
  let status = band ? band.status : 'info', tag = band ? band.tag || '' : '';
  // population reference: where the value sits among published shoulders (mean ± 1.96 SD holds 95% of them).
  // Metrics with no outcome-linked cut-off are graded by it: inside → typical, outside → unusual.
  const nr = normRange(m.norm, value);
  if (nr && status === 'info') { status = nr.inside ? 'good' : 'borderline'; tag = nr.inside ? 'Typical' : 'Unusual'; }
  return {
    ...base,
    value,
    text: m.format ? m.format(value, ctx) : fmt(value, m.unit, m.decimals),
    status,
    tag,
    say,
    normText: nr ? nr.text : '',
    provisional,
  };
}

/** Evaluate the user-graded findings (dropdowns). findingsState = { id: optionValue }. */
export function evaluateFindings(protocol, findingsState) {
  return (protocol.findings || []).map((f) => {
    const v = findingsState ? findingsState[f.id] : undefined;
    const opt = f.options.find((o) => o.v === v);
    return {
      id: f.id, label: f.label, refs: f.refs || [], help: f.help || '', group: f.group || 'Findings',
      value: v, answered: !!opt && v !== '', optionLabel: opt ? opt.label : '', status: opt ? opt.status || 'info' : 'pending',
      say: opt ? opt.say || '' : '',
    };
  });
}

/**
 * Compose the appraisal. Returns
 *   { verdict: { status, headline, detail }, counts, concerns[], borderline[], reassuring[], descriptive[], notMeasured[], caveats[], extra[] }
 * Each list item is { label, text, say, status, provisional }.
 * A protocol may add `synthesis(byId, findingsById, ctx)` → [{ title, status, text }] for conclusions that combine several
 * measurements (e.g. an overstuffing verdict), and `caveats(ctx)` for view-specific limitations.
 */
export function appraise(protocol, results, findings, ctx) {
  const all = [
    ...results.map((r) => ({ kind: 'metric', label: r.label, text: r.text, say: r.normText ? `${r.say} ${r.normText}`.trim() : r.say, status: r.status, provisional: r.provisional, tag: r.tag, id: r.id })),
    ...findings.filter((f) => f.answered).map((f) => ({ kind: 'finding', label: f.label, text: f.optionLabel, say: f.say, status: f.status, provisional: false, tag: '', id: f.id })),
  ];
  const pick = (s) => all.filter((x) => x.status === s);
  const concerns = pick('out'), borderline = pick('borderline'), reassuring = pick('good'), descriptive = pick('info');
  const notMeasured = results.filter((r) => r.status === 'pending');
  const unanswered = findings.filter((f) => !f.answered);
  const judged = concerns.length + borderline.length + reassuring.length;

  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const fById = Object.fromEntries(findings.map((f) => [f.id, f]));
  const extra = protocol.synthesis ? protocol.synthesis(byId, fById, ctx) || [] : [];

  const caveats = [];
  const provisional = results.filter((r) => r.provisional && r.status !== 'pending');
  if (provisional.length) {
    caveats.push(`${provisional.length} measurement${provisional.length === 1 ? ' rests' : 's rest'} on landmark positions that were only estimated by the software and not yet checked by you (${provisional.map((r) => r.label).join('; ')}). Treat those numbers as placeholders until each landmark has been dragged into place or confirmed.`);
  }
  if (results.some((r) => r.needsScale)) {
    caveats.push('The image is not calibrated, so distances in millimetres are not reported. Angles and ratios are unaffected. Enter the implant size or use an image with pixel spacing to get distances.');
  }
  if (ctx.scaleNote) caveats.push(ctx.scaleNote);
  if (ctx.neutralNote) caveats.push(ctx.neutralNote);
  if (protocol.caveats) caveats.push(...protocol.caveats(ctx));
  if (notMeasured.length) {
    caveats.push(`Not measured: ${notMeasured.map((r) => r.label).join('; ')}. The summary only covers what was measured.`);
  }
  if (unanswered.length && (protocol.findings || []).length) {
    caveats.push(`Not graded by you: ${unanswered.map((f) => f.label).join('; ')}. The software does not grade these automatically.`);
  }

  let status = 'pending', headline = 'Nothing has been measured yet.', detail = '';
  const worstExtra = extra.reduce((w, e) => (STATUS_ORDER[e.status] < STATUS_ORDER[w] ? e.status : w), 'pending');
  if (judged || extra.length) {
    if (concerns.length || worstExtra === 'out') {
      status = 'out';
      const n = concerns.length;
      headline = n
        ? `${n} of ${judged} graded item${judged === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} outside the published range.`
        : 'The combined assessment raises a concern.';
    } else if (borderline.length || worstExtra === 'borderline') {
      status = 'borderline';
      headline = borderline.length
        ? `Nothing is clearly outside range, but ${borderline.length} item${borderline.length === 1 ? ' is' : 's are'} borderline.`
        : 'Nothing is clearly outside range, but the combined assessment is borderline.';
    } else {
      status = 'good';
      headline = `All ${judged} graded item${judged === 1 ? '' : 's'} ${judged === 1 ? 'is' : 'are'} within the published ranges.`;
    }
    const total = results.length + (protocol.findings || []).length;
    const done = results.filter((r) => r.status !== 'pending').length + findings.filter((f) => f.answered).length;
    detail = `${done} of ${total} items assessed` + (provisional.length ? `, ${provisional.length} of them provisional` : '') + '.';
  }
  return {
    verdict: { status, headline, detail },
    counts: { out: concerns.length, borderline: borderline.length, good: reassuring.length, info: descriptive.length, pending: notMeasured.length },
    concerns, borderline, reassuring, descriptive, notMeasured, caveats, extra,
  };
}

/** Shapes helper for protocol draw() functions. Coordinates are image pixels. */
export const shape = {
  line: (a, b, o = {}) => ({ type: 'line', a, b, ...o }),
  ray: (a, b, o = {}) => ({ type: 'line', a, b, extend: true, ...o }),
  circle: (c, r, o = {}) => ({ type: 'circle', c, r, ...o }),
  arc: (c, a, b, o = {}) => ({ type: 'arc', c, a, b, ...o }),   // angle marker at c between directions to a and b
  text: (p, text, o = {}) => ({ type: 'text', p, text, ...o }),
  dim: (a, b, text, o = {}) => ({ type: 'dim', a, b, text, ...o }), // dimension line with end ticks
};
