// Report builders: plain text (for the notes), CSV (raw data, one row per measurement) and JSON (everything,
// including landmark coordinates). Pure functions — no DOM — so they are tested in Node.
// Nothing here knows who the patient is: the loader never keeps identifying data, so none can end up in a report.
import { STATUS_LABEL, EVIDENCE_LABEL } from '../measure/core.js';
import { refList, VERIFY_LABEL } from '../measure/refs.js';

const STATUS_MARK = { good: '[ok]', borderline: '[borderline]', out: '[OUTSIDE]', info: '[info]', pending: '[not measured]' };

/** bundle = { name, protocol, ctx, results, findings, appraisal, scale: { text }, extraResults: [] } */
export function buildText(bundles, decision, opts = {}) {
  const L = [];
  L.push('RSA Check — radiographic assessment');
  L.push(`Study type: ${opts.implantLabel || ''}`.trim());
  L.push('Not a medical device. Measurements depend on landmark placement and image quality; verify against the images.');
  L.push('');
  const refs = new Set();
  for (const b of bundles) {
    L.push('='.repeat(72));
    L.push(`${b.name} — ${b.protocol.title}`);
    if (b.scale && b.scale.text) L.push(`Scale: ${b.scale.text}`);
    L.push('');
    const a = b.appraisal;
    L.push(`APPRAISAL: ${a.verdict.headline}${a.verdict.detail ? ' ' + a.verdict.detail : ''}`);
    for (const e of a.extra) L.push(`  ${STATUS_MARK[e.status]} ${e.title}: ${e.text}`);
    const sect = (title, items) => {
      if (!items.length) return;
      L.push('');
      L.push(`${title}:`);
      for (const x of items) L.push(`  - ${x.label}: ${x.text}${x.provisional ? ' (provisional — landmark not confirmed)' : ''}. ${x.say}`);
    };
    sect('Outside the published range', a.concerns);
    sect('Borderline', a.borderline);
    sect('Within range', a.reassuring);
    sect('Descriptive (no validated cut-off)', a.descriptive);
    if (a.caveats.length) {
      L.push('');
      L.push('Limits of this assessment:');
      for (const c of a.caveats) L.push(`  - ${c}`);
    }
    L.push('');
    L.push('RAW DATA');
    let group = '';
    for (const r of [...b.results, ...(b.extraResults || [])]) {
      if (r.group !== group) { group = r.group; L.push(`  ${group}`); }
      const tgt = r.target ? ` (reference: ${r.target})` : '';
      L.push(`    ${STATUS_MARK[r.status].padEnd(14)} ${r.label}: ${r.text}${tgt}${r.tag ? ` — ${r.tag}` : ''}${r.provisional ? ' [provisional]' : ''}`);
      for (const k of r.refs || []) refs.add(k);
    }
    const answered = b.findings.filter((f) => f.answered);
    if (answered.length) {
      L.push('  Graded by the reader');
      for (const f of answered) { L.push(`    ${STATUS_MARK[f.status].padEnd(14)} ${f.label}: ${f.optionLabel}`); for (const k of f.refs || []) refs.add(k); }
    }
    L.push('');
  }
  if (decision && decision.verdict !== 'insufficient') {
    L.push('='.repeat(72));
    L.push('ANATOMIC VERSUS REVERSE REPLACEMENT');
    L.push(decision.headline);
    for (const f of decision.factors) {
      L.push(`  ${f.points > 0 ? 'reverse +' : 'anatomic '}${Math.abs(f.points).toFixed(1).padStart(3)}  ${f.label}: ${f.text}`);
      for (const k of f.refs || []) refs.add(k);
    }
    L.push(`  Net score ${decision.score.toFixed(1)} (positive favours reverse).`);
    for (const c of decision.caveats) L.push(`  - ${c}`);
    L.push('');
  }
  const list = refList([...refs]);
  if (list.length) {
    L.push('REFERENCES');
    for (const r of list) L.push(`  ${r.cite}${r.doi ? ` doi:${r.doi}` : ''} [${VERIFY_LABEL[r.v]}]`);
  }
  return L.join('\n');
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function buildCsv(bundles) {
  const rows = [['image', 'protocol', 'group', 'id', 'measurement', 'value', 'unit', 'status', 'band', 'reference', 'evidence', 'provisional']];
  for (const b of bundles) {
    for (const r of [...b.results, ...(b.extraResults || [])]) {
      rows.push([b.name, b.protocol.id, r.group, r.id, r.label, Number.isFinite(r.value) ? +r.value.toFixed(3) : '', r.unit === 'ratio' ? '' : r.unit,
        STATUS_LABEL[r.status], r.tag || '', r.target || '', EVIDENCE_LABEL[r.evidence] || '', r.provisional ? 'yes' : '']);
    }
    for (const f of b.findings) {
      rows.push([b.name, b.protocol.id, f.group, f.id, f.label, f.answered ? f.optionLabel : '', '', STATUS_LABEL[f.status], '', '', 'Graded by the reader', '']);
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const round = (v) => (typeof v === 'number' ? +v.toFixed(3) : Array.isArray(v) ? v.map(round) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v);

export function buildJson(bundles, decision, opts = {}) {
  return {
    tool: 'RSA Check',
    studyType: opts.implant || '',
    note: 'Coordinates are image pixels (radiographs: x right, y down) or patient millimetres (CT, LPS). No patient identifiers are stored.',
    images: bundles.map((b) => ({
      name: b.name,
      protocol: b.protocol.id,
      scale: b.scale || null,
      landmarks: round(b.ctx.L),
      landmarkSource: b.ctx.state,
      measurements: [...b.results, ...(b.extraResults || [])].map((r) => ({
        id: r.id, label: r.label, value: Number.isFinite(r.value) ? +r.value.toFixed(3) : null, unit: r.unit, status: r.status, band: r.tag,
        reference: r.target, evidence: r.evidence, provisional: r.provisional, comment: r.say, references: r.refs,
      })),
      findings: b.findings.map((f) => ({ id: f.id, label: f.label, value: f.answered ? f.value : null, status: f.status })),
      appraisal: { status: b.appraisal.verdict.status, headline: b.appraisal.verdict.headline, combined: b.appraisal.extra, caveats: b.appraisal.caveats },
    })),
    anatomicVersusReverse: decision && decision.verdict !== 'insufficient'
      ? { verdict: decision.verdict, headline: decision.headline, score: +decision.score.toFixed(2), factors: decision.factors.map((f) => ({ label: f.label, points: f.points, text: f.text })), caveats: decision.caveats }
      : null,
  };
}
