import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOLS } from '../../src/measure/protocols/index.js';
import { evaluate, evaluateFindings, appraise } from '../../src/measure/core.js';
import { anatomicVsReverse } from '../../src/measure/decision.js';
import { buildText, buildCsv, buildJson } from '../../src/app/report.js';
import { makePhantom } from '../../src/sample/xray-phantom.js';

function bundle(kind, protocolId, findings = {}) {
  const ph = makePhantom({ kind, side: 'R', seed: 3, width: 700, height: 850, mmPerPx: 0.4 });
  const t = ph.truth, P = (a) => ({ x: a[0], y: a[1] }), LN = (l) => ({ a: P(l.a), b: P(l.b) });
  const L = {};
  const protocol = PROTOCOLS[protocolId];
  for (const lm of protocol.landmarks) {
    const v = lm.id === 'gs' ? t.glenosphere : lm.id === 'face' ? t.glenosphere.face : t[lm.id];
    if (!v) continue;
    L[lm.id] = lm.kind === 'point' ? P(v) : lm.kind === 'line' ? LN(v) : { cx: v.cx, cy: v.cy, r: v.r };
  }
  const ctx = { L, state: { sgt: 'estimated' }, mm: ph.mmPerPx, lateralSign: -1, mmSource: 'dicom' };
  const results = evaluate(protocol, ctx);
  const f = evaluateFindings(protocol, findings);
  return { name: 'X-ray 1', protocol, ctx, results, findings: f, appraisal: appraise(protocol, results, f, ctx), scale: { mm: ph.mmPerPx, text: 'test scale' }, extraResults: [] };
}

test('text report: appraisal, raw data, limits and references for a reverse film', () => {
  const b = bundle('reverse', 'rsa-ap', { notching: '2' });
  const text = buildText([b], null, { implantLabel: 'Reverse replacement' });
  for (const s of ['APPRAISAL:', 'RAW DATA', 'Lateralisation shoulder angle (LSA)', 'Distalisation shoulder angle (DSA)', 'Scapular notching (Sirveaux): Grade 2', 'Limits of this assessment', 'REFERENCES', 'Boutsiadis', 'provisional']) {
    assert.ok(text.includes(s), `report lacks "${s}"`);
  }
  assert.ok(!/undefined|NaN|\[object/.test(text), 'no formatting leftovers');
});

test('CSV has one row per measurement and finding with numeric values', () => {
  const b = bundle('reverse', 'rsa-ap');
  const rows = buildCsv([b]).trim().split('\r\n');
  assert.equal(rows.length, 1 + b.results.length + b.findings.length);
  assert.equal(rows[0].split(',').length, 12);
  const lsa = rows.find((r) => r.includes(',lsa,'));
  assert.match(lsa, /,\d+(\.\d+)?,°,/);
});

test('JSON carries landmarks, measurements and the implant-choice synthesis', () => {
  const b = bundle('native', 'native-ap', { hamada: '3' });
  const d = anatomicVsReverse({ age: 77, hamada: '3', ahd: 3 });
  const j = buildJson([b], d, { implant: 'native' });
  assert.equal(j.images[0].protocol, 'native-ap');
  assert.ok(j.images[0].landmarks.head.r > 0);
  assert.ok(j.images[0].measurements.find((m) => m.id === 'csa').value > 0);
  assert.equal(j.anatomicVersusReverse.verdict, 'reverse');
  assert.doesNotThrow(() => JSON.stringify(j));
  const text = buildText([b], d, { implantLabel: 'Native shoulder' });
  assert.ok(text.includes('ANATOMIC VERSUS REVERSE REPLACEMENT'));
});
