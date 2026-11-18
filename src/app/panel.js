// HTML builders for the side panel. They return strings built only from the app's own text plus screened, escaped
// values. The page's CSP forbids inline styles, so positions are emitted as data-attributes and applied by
// applyGeometry() after insertion.
import { STATUS_LABEL, EVIDENCE_LABEL, bandFor } from '../measure/core.js';
import { refList, VERIFY_LABEL } from '../measure/refs.js';
import { MUSCLES } from '../measure/muscle.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function applyGeometry(root) {
  for (const el of root.querySelectorAll('[data-l]')) el.style.left = `${el.dataset.l}%`;
  for (const el of root.querySelectorAll('[data-w]')) el.style.width = `${el.dataset.w}%`;
}

const chip = (status, text) => `<span class="st ${status}">${esc(text || STATUS_LABEL[status])}</span>`;

const SOURCE_LABEL = { auto: 'Detected', estimated: 'Estimated — check', manual: 'Placed', missing: 'Not placed' };

export function landmarkList(protocol, values, states, activeId, placing) {
  let html = '', group = '';
  for (const lm of protocol.landmarks) {
    if (lm.group !== group) { group = lm.group; html += `<h3>${esc(group)}</h3>`; }
    const st = values[lm.id] ? states[lm.id] || 'manual' : 'missing';
    const active = lm.id === activeId;
    html += `<div class="lm ${st}${active ? ' active' : ''}" data-lm="${lm.id}">
      <button class="lm-main" data-act="lm-go" data-lm="${lm.id}" title="${esc(lm.help)}">
        <span class="dot ${st}"></span>
        <span class="lm-label">${esc(lm.label)}${lm.optional ? ' <em>optional</em>' : ''}</span>
        <span class="lm-state">${active && placing ? esc(placing) : SOURCE_LABEL[st]}</span>
      </button>
      <span class="lm-actions">
        ${st === 'estimated' ? `<button class="mini ok" data-act="lm-confirm" data-lm="${lm.id}" title="This position is right">✓</button>` : ''}
        <button class="mini" data-act="lm-place" data-lm="${lm.id}" title="${values[lm.id] ? 'Place again' : 'Place on the image'}">${values[lm.id] ? '↻' : '+'}</button>
        ${values[lm.id] ? `<button class="mini" data-act="lm-clear" data-lm="${lm.id}" title="Remove">×</button>` : ''}
      </span>
      ${active ? `<p class="lm-help">${esc(lm.help)}</p>` : ''}
    </div>`;
  }
  return html;
}

function gauge(r) {
  if (!r.gauge || !Number.isFinite(r.value)) return '';
  const { min, max } = r.gauge;
  const pos = (v) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  let zones = '';
  if (r.bands) {
    let lo = min;
    for (const b of r.bands) {
      const hi = b.upTo === undefined ? max : Math.min(max, b.upTo);
      if (hi > lo) zones += `<span class="z ${b.status}" data-l="${pos(lo).toFixed(2)}" data-w="${(pos(hi) - pos(lo)).toFixed(2)}"></span>`;
      lo = Math.max(lo, hi);
    }
  }
  return `<div class="gauge" aria-hidden="true">${zones}<i class="mk ${r.status}" data-l="${pos(r.value).toFixed(2)}"></i></div>`;
}

function refsHtml(keys) {
  const list = refList(keys || []);
  if (!list.length) return '';
  return `<ul class="refs">${list.map((r) => `<li>${esc(r.cite)}${r.doi ? ` <span class="doi">doi:${esc(r.doi)}</span>` : ''} <span class="ver ${r.v}">${VERIFY_LABEL[r.v]}</span>${r.note ? `<br><span class="ref-note">${esc(r.note)}</span>` : ''}</li>`).join('')}</ul>`;
}

export function measurementRow(r, selected) {
  let body;
  if (r.status === 'pending') {
    const why = r.needsScale ? 'needs a calibrated image (enter the implant size)' : r.missing.length ? `needs: ${r.missing.map((m) => esc(r.missingLabels?.[m] || m)).join(', ')}` : 'cannot be computed from these landmarks';
    body = `<div class="m-head"><span class="m-label">${esc(r.label)}</span><span class="m-value none">—</span></div><p class="m-why">${why}</p>`;
  } else {
    body = `<div class="m-head"><span class="m-label">${esc(r.label)}</span><span class="m-value">${esc(r.text)}</span></div>
      <div class="m-sub">${chip(r.status, r.tag || STATUS_LABEL[r.status])}${r.target ? `<span class="m-target">reference ${esc(r.target)}</span>` : ''}${r.provisional ? '<span class="st prov">provisional</span>' : ''}</div>
      ${gauge(r)}
      ${r.say ? `<p class="m-say">${esc(r.say)}</p>` : ''}`;
  }
  return `<div class="m ${r.status}${selected ? ' sel' : ''}" data-metric="${esc(r.id)}">
    ${body}
    <details><summary>Definition, limits and sources</summary>
      <p><b>What it is.</b> ${esc(r.what)}</p>
      ${r.caveat ? `<p><b>Limits.</b> ${esc(r.caveat)}</p>` : ''}
      <p class="ev"><b>Evidence.</b> ${esc(EVIDENCE_LABEL[r.evidence] || '')}</p>
      ${refsHtml(r.refs)}
    </details>
  </div>`;
}

export function measurementList(results, selectedId) {
  let html = '', group = null;
  for (const r of results) {
    if (r.group !== group) { group = r.group; html += `<h3>${esc(group)}</h3>`; }
    html += measurementRow(r, r.id === selectedId);
  }
  return html;
}

export function findingsForm(protocol, state, findings) {
  if (!(protocol.findings || []).length) return '';
  let html = '<h3>Graded by you</h3><p class="note">The software does not grade these. Choose what you see; each choice feeds the appraisal.</p>';
  for (const f of protocol.findings) {
    const cur = findings.find((x) => x.id === f.id);
    html += `<label class="finding ${cur && cur.answered ? cur.status : 'pending'}">
      <span class="f-label">${esc(f.label)}</span>
      <select data-finding="${f.id}">
        <option value="">Not graded</option>
        ${f.options.map((o) => `<option value="${esc(o.v)}"${state[f.id] === o.v ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
      ${f.help ? `<span class="f-help">${esc(f.help)}</span>` : ''}
    </label>`;
  }
  return html;
}

const VERDICT_WORD = { out: 'Concern', borderline: 'Borderline', good: 'Within range', pending: 'Nothing measured', info: 'Descriptive' };

export function appraisalView(a, title) {
  const list = (heading, cls, items) => (items.length
    ? `<section class="ap-sec ${cls}"><h3>${heading}</h3><ul>${items.map((x) => `<li><b>${esc(x.label)}: ${esc(x.text)}.</b> ${esc(x.say)}${x.provisional ? ' <span class="st prov">provisional</span>' : ''}</li>`).join('')}</ul></section>`
    : '');
  return `<div class="verdict ${a.verdict.status}">
      <span class="verdict-word">${VERDICT_WORD[a.verdict.status]}</span>
      <p class="verdict-head">${esc(a.verdict.headline)}</p>
      ${a.verdict.detail ? `<p class="verdict-detail">${esc(title ? `${title}: ` : '')}${esc(a.verdict.detail)}</p>` : ''}
      <div class="tally">${['out', 'borderline', 'good', 'info'].map((s) => `<span class="st ${s}">${a.counts[s]} ${STATUS_LABEL[s].toLowerCase()}</span>`).join('')}</div>
    </div>
    ${a.extra.length ? `<section class="ap-sec combined"><h3>Combined assessment</h3>${a.extra.map((e) => `<div class="combo ${e.status}"><b>${esc(e.title)}</b><p>${esc(e.text)}</p></div>`).join('')}</section>` : ''}
    ${list('Outside the published range', 'out', a.concerns)}
    ${list('Borderline', 'borderline', a.borderline)}
    ${list('Within range', 'good', a.reassuring)}
    ${list('Descriptive — no validated cut-off', 'info', a.descriptive)}
    ${a.caveats.length ? `<section class="ap-sec caveats"><h3>What this assessment cannot tell you</h3><ul>${a.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></section>` : ''}`;
}

export function decisionView(d, clinical) {
  const sel = (id, opts) => `<select data-clin="${id}">${opts.map(([v, t]) => `<option value="${v}"${String(clinical[id]) === v ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
  const form = `<div class="clin">
      <label><span>Age</span><input type="number" min="18" max="110" data-clin="age" value="${esc(clinical.age)}" placeholder="years"></label>
      <label><span>Rotator cuff (from ultrasound, MRI or CT arthrogram)</span>${sel('cuff', [['unknown', 'Not assessed'], ['intact', 'Intact'], ['partial', 'Partial-thickness tear'], ['full', 'Full-thickness tear'], ['massive', 'Massive / irreparable tear']])}</label>
      <label class="check"><input type="checkbox" data-clin="pseudoparesis"${clinical.pseudoparesis ? ' checked' : ''}><span>Pseudoparesis (active elevation under 90°, passive free)</span></label>
      <label class="check"><input type="checkbox" data-clin="inflammatory"${clinical.inflammatory ? ' checked' : ''}><span>Inflammatory arthritis</span></label>
    </div>`;
  if (!d) return form;
  const factors = d.factors.map((f) => `<tr class="${f.points > 0 ? 'rev' : 'ana'}"><td class="pts">${f.points > 0 ? '+' : '−'}${Math.abs(f.points).toFixed(1)}</td><td><b>${esc(f.label)}</b>${f.strong ? ' <span class="st out">decisive</span>' : ''}<br>${esc(f.text)}</td></tr>`).join('');
  const pos = Math.max(2, Math.min(98, 50 + d.score * 5));
  return `${form}
    <div class="verdict ${d.status}">
      <span class="verdict-word">${{ reverse: 'Reverse', 'lean-reverse': 'Leaning reverse', grey: 'Grey zone', anatomic: 'Anatomic', insufficient: 'Not enough data' }[d.verdict]}</span>
      <p class="verdict-head">${esc(d.headline)}</p>
      ${d.verdict !== 'insufficient' ? `<div class="balance" aria-hidden="true"><span class="bal-l">Anatomic</span><div class="gauge wide"><span class="z good" data-l="0" data-w="42.5"></span><span class="z borderline" data-l="42.5" data-w="32.5"></span><span class="z out" data-l="75" data-w="25"></span><i class="mk ${d.status}" data-l="${pos.toFixed(1)}"></i></div><span class="bal-r">Reverse</span></div>
      <p class="verdict-detail">Net score ${d.score > 0 ? '+' : ''}${d.score.toFixed(1)} — positive points favour a reverse.</p>` : ''}
    </div>
    ${factors ? `<table class="factors"><tbody>${factors}</tbody></table>` : ''}
    <section class="ap-sec caveats"><h3>Read this before relying on it</h3><ul>${d.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></section>
    ${refsHtml(d.factors.flatMap((f) => f.refs))}`;
}

export function muscleView(rois, results, drawing) {
  let html = `<p class="note">Outline each muscle on one slice — best on the <b>Y-view</b> pane, at the most lateral slice where the scapular spine still joins the body. Click to add points; double-click or press Enter to close. Fat fraction, attenuation and area come from the Hounsfield values inside your outline (fat −190 to −30 HU; muscle −29 to +166 HU). Adding the premorbid outline — the fossa or the envelope the muscle used to fill — adds atrophy and the Terrier degeneration ratio.</p>`;
  for (const m of MUSCLES) {
    const has = (kind) => rois.some((r) => r.muscle === m.id && r.kind === kind);
    const mine = results.filter((r) => r.id.startsWith(`${m.id}-`));
    const isDrawing = (kind) => drawing && drawing.muscle === m.id && drawing.kind === kind;
    html += `<div class="muscle">
      <div class="mu-head"><b>${esc(m.label)}</b><span class="mu-where">${esc(m.where)}</span></div>
      <div class="mu-actions">
        <button class="btn small${isDrawing('muscle') ? ' primary' : ''}" data-act="roi" data-muscle="${m.id}" data-kind="muscle">${isDrawing('muscle') ? 'Drawing… (Enter to close)' : has('muscle') ? 'Redraw muscle' : 'Outline muscle'}</button>
        ${m.premorbid ? `<button class="btn small${isDrawing('pre') ? ' primary' : ''}" data-act="roi" data-muscle="${m.id}" data-kind="pre">${isDrawing('pre') ? 'Drawing… (Enter to close)' : has('pre') ? 'Redraw premorbid outline' : 'Outline premorbid area'}</button>` : ''}
        ${has('muscle') || has('pre') ? `<button class="btn small ghost" data-act="roi-clear" data-muscle="${m.id}">Clear</button>` : ''}
      </div>
      ${mine.map((r) => measurementRow(r, false)).join('')}
    </div>`;
  }
  return html;
}

export function anonView(report) {
  if (!report) return '<p class="note">Synthetic example — no patient file was read.</p>';
  const rows = (report.identifiersFound || []).map((r) => `<tr><td>${esc(r.category)}</td><td>${r.elements}</td></tr>`).join('');
  return `<p>${report.filesScanned} file${report.filesScanned === 1 ? '' : 's'} read on this device; ${report.totalElementsDiscarded} identifying or unneeded data elements discarded as the files were read. Nothing was uploaded — this page cannot open a network connection.</p>
    ${rows ? `<table><tbody>${rows}</tbody></table>` : ''}
    ${report.burnedInRisk ? `<p class="warn">${report.burnedInRisk} image${report.burnedInRisk === 1 ? '' : 's'} may carry text burned into the picture itself (screenshots, secondary captures). That stays on this device, but it would appear in an exported annotated image.</p>` : ''}`;
}

export function compareView(c, candidates) {
  const opts = candidates.map((x) => `<option value="${x.uid}"${x === c.other ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  const form = `<div class="clin cmp-form">
      <label><span>Compare with</span><select data-cmp="other">${opts}</select></label>
      <label><span>The film on screen is the</span><select data-cmp="order"><option value="thisLater"${c.thisLater ? ' selected' : ''}>later film</option><option value="thisEarlier"${c.thisLater ? '' : ' selected'}>earlier film</option></select></label>
      <label><span>Months between the films (optional)</span><input type="number" min="0" max="600" step="1" data-cmp="months" value="${esc(c.months)}" placeholder="months"></label>
    </div>`;
  const row = (r) => `<tr class="${r.status}"><td><b>${esc(r.label)}</b><br><span class="cmp-say">${esc(r.say)}</span></td><td class="num">${esc(r.earlierText)}</td><td class="num">${esc(r.currentText)}</td><td class="num">${chip(r.status, r.changeText)}</td></tr>`;
  const frow = (f) => `<tr class="${f.status}"><td><b>${esc(f.label)}</b><br><span class="cmp-say">${esc(f.say)}</span></td><td>${esc(f.earlierText)}</td><td>${esc(f.currentText)}</td><td>${chip(f.status, f.status === 'good' ? 'same' : 'changed')}</td></tr>`;
  const table = c.rows.length || c.findings.length
    ? `<table class="cmp"><thead><tr><th></th><th>Earlier</th><th>Current</th><th>Change</th></tr></thead><tbody>${c.rows.map(row).join('')}${c.findings.map(frow).join('')}</tbody></table>`
    : '<p class="note">Nothing can be compared yet: the same landmarks must be placed on both films.</p>';
  return `${form}
    <p class="note"><b>Earlier:</b> ${esc(c.earlierName)} · <b>Current:</b> ${esc(c.currentName)}. ${esc(c.typeText)}</p>
    <p class="note">${esc(c.scale.text)}</p>
    ${c.notes.map((n) => `<p class="alert warn">${esc(n)}</p>`).join('')}
    ${table}
    <p class="note">Changes are graded only where a threshold has been published or is a stated convention (arm lengthening 0–2 cm; migration ≥ 5 mm or ≥ 5° as a change of position). Both films must be true AP views in the same rotation; differences in arm position alone move most of these numbers.</p>
    ${refsHtml(['ladermann2014', 'ladermann2012', 'otto2013', 'schippers2026', 'mitrousias2026', 'sanchezsotelo2001', 'rhee2025'])}`;
}

export { bandFor };
