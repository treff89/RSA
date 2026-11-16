import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOLS, protocolFor } from '../../src/measure/protocols/index.js';
import { evaluate, evaluateFindings, appraise, bandFor } from '../../src/measure/core.js';
import { REFS } from '../../src/measure/refs.js';
import { scapularFrame, versionInclination, fitCircle, fitSphere, circleFrom3, v3 } from '../../src/measure/geom.js';
import { glenoidVersion, glenoidInclination, subluxGlenoid, subluxScapular } from '../../src/measure/protocols/ct.js';
import { roiStats, sampleRoi, terrierRatios, muscleResults, MUSCLES, nearestGoutallier } from '../../src/measure/muscle.js';
import { anatomicVsReverse } from '../../src/measure/decision.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);
const P = (x, y) => ({ x, y });
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));
const rad = (d) => d * Math.PI / 180;

test('every protocol is well formed', () => {
  for (const p of Object.values(PROTOCOLS)) {
    const ids = new Set(p.landmarks.map((l) => l.id));
    assert.equal(ids.size, p.landmarks.length, `${p.id}: duplicate landmark ids`);
    for (const m of p.metrics) {
      for (const n of m.needs || []) assert.ok(ids.has(n), `${p.id}.${m.id} needs unknown landmark ${n}`);
      for (const r of m.refs || []) assert.ok(REFS[r], `${p.id}.${m.id} cites unknown reference ${r}`);
      assert.ok(m.what, `${p.id}.${m.id} has no definition`);
      if (m.bands) {
        let last = -Infinity;
        m.bands.forEach((b, i) => {
          assert.ok(['good', 'borderline', 'out', 'info'].includes(b.status), `${p.id}.${m.id} band status`);
          if (i < m.bands.length - 1) { assert.ok(b.upTo > last, `${p.id}.${m.id} bands not ascending`); last = b.upTo; }
          else assert.equal(b.upTo, undefined, `${p.id}.${m.id} last band must be open`);
        });
      }
    }
    for (const f of p.findings || []) for (const r of f.refs || []) assert.ok(REFS[r], `${p.id}.${f.id} cites unknown reference ${r}`);
  }
  assert.equal(protocolFor('reverse', 'xray').id, 'rsa-ap');
  assert.equal(protocolFor('native', 'xray', 'axillary').id, 'native-ax');
  assert.equal(protocolFor('pyc', 'ct').id, 'pyc-ct');
});

test('geometry fits', () => {
  const c = circleFrom3(P(10, 0), P(0, 10), P(-10, 0));
  near(c.cx, 0, 1e-9); near(c.cy, 0, 1e-9); near(c.r, 10, 1e-9);
  const pts = [];
  for (let a = 0.2; a < 2.4; a += 0.1) pts.push(P(50 + 30 * Math.cos(a) + 0.05 * Math.sin(a * 37), 20 + 30 * Math.sin(a) + 0.05 * Math.cos(a * 53)));
  const f = fitCircle(pts);
  near(f.cx, 50, 0.2); near(f.cy, 20, 0.2); near(f.r, 30, 0.2);
  const sp = [];
  for (let a = 0; a < 6; a += 0.7) for (let b = 0.2; b < 1.4; b += 0.3) sp.push([1 + 20 * Math.cos(a) * Math.sin(b), -2 + 20 * Math.sin(a) * Math.sin(b), 3 + 20 * Math.cos(b)]);
  const s = fitSphere(sp);
  near(s.c[0], 1, 1e-6); near(s.c[1], -2, 1e-6); near(s.c[2], 3, 1e-6); near(s.r, 20, 1e-6);
});

// A right shoulder drawn with the humerus on the image's LEFT (as on a standard AP of a right shoulder); 0.2 mm/px.
function rsaScene({ lateralSign = -1, tiltDeg = 0, overhangMm = 4, varusDeg = 0 } = {}) {
  const s = lateralSign, mm = 0.2;
  const X = (x) => 700 + s * x;            // x measured towards lateral
  const R = 19 / mm;                       // 38 mm glenosphere
  const gs = { cx: X(0), cy: 600, r: R };
  // back face through the centre, tilted: + = superior tilt (face normal rotated upward)
  const t = rad(tiltDeg);
  const nrm = { x: s * Math.cos(t), y: -Math.sin(t) };           // lateral, rotated up by t
  const dInf = { x: s * Math.sin(t), y: Math.cos(t) };            // along the face, pointing inferior
  const face = { a: P(gs.cx - dInf.x * R, gs.cy - dInf.y * R), b: P(gs.cx + dInf.x * R, gs.cy + dInf.y * R) };
  const igr = P(face.b.x - dInf.x * overhangMm / mm, face.b.y - dInf.y * overhangMm / mm);
  const sgt = P(igr.x - dInf.x * 36 / mm, igr.y - dInf.y * 36 / mm);
  const ssf = { a: P(X(-250), 600 - 36 / mm), b: P(X(-60), 600 - 36 / mm) };   // horizontal fossa floor
  const acr = P(X(150), 330), acu = P(X(110), 350), gts = P(X(160), 470), gtl = P(X(215), 520);
  const v = rad(varusDeg);
  const shaftTop = P(X(120), 700), shaftDir = { x: 0, y: 1 };
  const stemDir = { x: s * Math.sin(v), y: Math.cos(v) };          // varus: distal end towards lateral
  const stem = { a: P(X(120), 720), b: P(X(120) + stemDir.x * 400, 720 + stemDir.y * 400) };
  const line = (cx, y, w) => ({ a: P(cx - w / 2, y), b: P(cx + w / 2, y) });
  return {
    L: { gs, face, igr, sgt, ssf, acr, acu, gts, gtl, stem,
      canalM: line(shaftTop.x, 800, 100), stemM: line(shaftTop.x, 800, 60), canalD: line(shaftTop.x, 1050, 80), stemD: line(shaftTop.x, 1050, 64) },
    state: {}, mm, lateralSign: s, nrm, shaftDir,
  };
}

test('reverse AP: angles, tilt sign, overhang and stem measures on both sides', () => {
  for (const s of [-1, 1]) {
    const ctx = rsaScene({ lateralSign: s, tiltDeg: 12, overhangMm: 4, varusDeg: 7 });
    const r = byId(evaluate(PROTOCOLS['rsa-ap'], ctx));
    near(r.tilt.value, 12, 1e-6, `tilt side ${s}`);
    assert.equal(r.tilt.status, 'out');
    assert.match(r.tilt.text, /superior/);
    near(r.overhang.value, 4, 1e-6, `overhang side ${s}`);
    assert.equal(r.overhang.status, 'good');
    near(r.stemAlign.value, 7, 1e-6, `varus side ${s}`);
    assert.match(r.stemAlign.text, /varus/);
    near(r.frM.value, 0.6, 1e-9); assert.equal(r.frM.status, 'good');
    near(r.frD.value, 0.8, 1e-9); assert.equal(r.frD.status, 'borderline');
    // LSA / DSA from first principles
    const { sgt, acr, gtl, gts } = ctx.L;
    const ang = (a, b, c) => Math.acos(((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y)) / (Math.hypot(a.x - b.x, a.y - b.y) * Math.hypot(c.x - b.x, c.y - b.y))) * 180 / Math.PI;
    near(r.lsa.value, ang(sgt, acr, gtl), 1e-9);
    near(r.dsa.value, ang(acr, sgt, gts), 1e-9);
    near(r.ahd.value, Math.hypot(ctx.L.acu.x - gts.x, ctx.L.acu.y - gts.y) * 0.2, 1e-9);
    near(r.gtLat.value, (215 - 150) * 0.2, 1e-9, 'tuberosity lateral to acromion');
    near(r.lho.value, 215 * 0.2, 1e-9, 'lateral humeral offset');
  }
  const inf = byId(evaluate(PROTOCOLS['rsa-ap'], rsaScene({ tiltDeg: -8, overhangMm: -2, varusDeg: -9 })));
  near(inf.tilt.value, -8, 1e-6); assert.equal(inf.tilt.status, 'good'); assert.match(inf.tilt.text, /inferior/);
  near(inf.overhang.value, -2, 1e-6); assert.equal(inf.overhang.status, 'out');
  near(inf.stemAlign.value, -9, 1e-6); assert.match(inf.stemAlign.text, /valgus/);
});

test('reverse AP: missing landmarks, missing scale and provisional flags are reported honestly', () => {
  const ctx = rsaScene();
  delete ctx.L.gtl;
  ctx.mm = null;
  ctx.state = { sgt: 'estimated' };
  const res = evaluate(PROTOCOLS['rsa-ap'], ctx);
  const r = byId(res);
  assert.equal(r.lsa.status, 'pending'); assert.deepEqual(r.lsa.missing, ['gtl']);
  assert.equal(r.ahd.status, 'pending'); assert.equal(r.ahd.needsScale, true);
  assert.equal(r.dsa.provisional, true);
  const a = appraise(PROTOCOLS['rsa-ap'], res, evaluateFindings(PROTOCOLS['rsa-ap'], { notching: '3' }), ctx);
  assert.ok(a.caveats.some((c) => /estimated/.test(c)));
  assert.ok(a.caveats.some((c) => /not calibrated/.test(c)));
  assert.ok(a.caveats.some((c) => /Not graded by you/.test(c)));
  assert.equal(a.verdict.status, 'out');
  assert.ok(a.concerns.some((c) => /Grade 3/.test(c.text)));
});

test('hemiarthroplasty AP: centre-of-rotation deviation, head size, head height and the overstuffing verdict', () => {
  const mm = 0.2, s = -1;
  const anat = { cx: 600, cy: 500, r: 24 / mm };
  const onCircle = (deg) => P(anat.cx + anat.r * Math.cos(rad(deg)), anat.cy + anat.r * Math.sin(rad(deg)));
  const build = (dxMedMm, dySupMm, headRmm) => ({
    L: {
      head: { cx: anat.cx - s * dxMedMm / mm, cy: anat.cy - dySupMm / mm, r: headRmm / mm },   // medial = −lateral
      pcA: onCircle(200), pcB: onCircle(250), pcC: onCircle(20),
      gts: P(520, anat.cy - anat.r + 8 / mm),
      acu: P(600, anat.cy - anat.r - 9 / mm),
    },
    state: {}, mm, lateralSign: s,
  });
  let r = byId(evaluate(PROTOCOLS['pyc-ap'], build(0, 0, 24)));
  near(r.corDev.value, 0, 1e-6); assert.equal(r.corDev.status, 'good');
  near(r.headSize.value, 0, 1e-6);
  near(r.hh.value, 8, 1e-6); assert.equal(r.hh.status, 'good');
  near(r.ahd.value, 9, 1e-6); assert.equal(r.ahd.status, 'good');
  let ctx = build(3, 4, 27);
  let res = evaluate(PROTOCOLS['pyc-ap'], ctx);
  r = byId(res);
  near(r.corDev.value, 5, 1e-6); assert.equal(r.corDev.status, 'out');
  assert.match(r.corDev.text, /3\.0 mm medial, 4\.0 mm superior/);
  near(r.headSize.value, 6, 1e-6); assert.equal(r.headSize.status, 'borderline');
  near(r.hh.value, 8 + 4 + 3, 1e-6); assert.equal(r.hh.status, 'out');
  const a = appraise(PROTOCOLS['pyc-ap'], res, [], ctx);
  const over = a.extra.find((e) => e.title === 'Overstuffing');
  assert.equal(over.status, 'out'); assert.match(over.text, /consistent with overstuffing/);
  // lateral / inferior displacement is non-anatomic but is not called overstuffing
  ctx = build(-4, -3, 24);
  const a2 = appraise(PROTOCOLS['pyc-ap'], evaluate(PROTOCOLS['pyc-ap'], ctx), [], ctx);
  assert.equal(a2.extra.find((e) => e.title === 'Overstuffing').status, 'good');
});

test('native AP and axillary: CSA, acromion index, AHD, inclination, subluxation and version', () => {
  const mm = 0.15, s = 1;
  const igr = P(500, 700), sgt = P(500, 460);                 // vertical glenoid, lateral = +x
  const csa = 38;
  const acr = P(500 + 300 * Math.sin(rad(csa)), 700 - 300 * Math.cos(rad(csa)));
  const head = { cx: 500 + 150, cy: 580, r: 160 };
  const ctx = {
    L: { igr, sgt, acr, head, acu: P(650, 580 - 160 - 5 / mm), gtl: P(500 + (acr.x - 500) / 0.7, 600),
      ssf: { a: P(200, 460 + 300 * Math.tan(rad(10))), b: P(500, 460) } },   // floor rising 10° towards lateral
    state: {}, mm, lateralSign: s,
  };
  const r = byId(evaluate(PROTOCOLS['native-ap'], ctx));
  near(r.csa.value, csa, 1e-6); assert.equal(r.csa.status, 'borderline');
  near(r.ai.value, 0.7, 1e-6);
  near(r.ahd.value, 5, 1e-6); assert.equal(r.ahd.status, 'out');
  // The fossa floor rises 10° laterally, so its perpendicular leans 10° and a vertical glenoid faces 10° BELOW it.
  near(r.incl.value, -10, 1e-6);
  near(r.headDiam.value, 48, 1e-6);
  const synth = PROTOCOLS['native-ap'].synthesis(r);
  assert.match(synth[0].text, /grade 2 at least/);

  // axillary: glenoid line vertical (anterior up), head shifted posterior by 30% of its diameter
  const ax = { L: { ga: P(400, 300), gp: P(400, 500), head: { cx: 520, cy: 400 + 0.3 * 200, r: 100 }, scapAx: { a: P(100, 400 + 300 * Math.tan(rad(12))), b: P(400, 400) } }, state: {}, mm: null, lateralSign: 1 };
  const q = byId(evaluate(PROTOCOLS['native-ax'], ax));
  near(q.sublux.value, 80, 1e-6); assert.equal(q.sublux.status, 'out');
  near(Math.abs(q.version.value), 12, 1e-6);
  // The scapular axis comes from posterior-medial, so the glenoid face looks posterior of it: retroversion.
  assert.ok(q.version.value < 0, 'retroversion is negative');
});

test('CT: version, inclination and subluxation in the scapular frame, both sides, tilted patient', () => {
  for (const side of ['R', 'L']) {
    for (const [ver, inc] of [[-18, 6], [4, -9], [-30, 15]]) {
      const sx = side === 'R' ? -1 : 1;                    // lateral is −x (patient right) for a right shoulder
      // scapular frame in a patient lying straight, scapula 35° to the coronal plane
      const a = rad(35);
      let lat = [sx * Math.cos(a), -Math.sin(a), 0], ant = [-sx * Math.sin(a), -Math.cos(a), 0], sup = [0, 0, 1];
      // tilt the whole patient 14° about the x axis to prove independence from scanner axes
      const rot = (v) => { const c = Math.cos(rad(14)), s = Math.sin(rad(14)); return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]]; };
      lat = rot(lat); ant = rot(ant); sup = rot(sup);
      const at = (l, an, s) => [0, 0, 0].map((_, i) => 30 + lat[i] * l + ant[i] * an + sup[i] * s);
      const centre = at(0, 0, 0), tri = at(-105, 0, 0), ia = at(-80, 0, -120);
      const dir = (v, i) => { const cv = Math.cos(rad(v)), sv = Math.sin(rad(v)), ci = Math.cos(rad(i)), si = Math.sin(rad(i)); return v3.unit([cv * ci, sv * ci, si * cv]); };
      // version/inclination as atan2(component, lateral component): build d with exact tangents
      const d = v3.unit([1, Math.tan(rad(ver)), Math.tan(rad(inc))]);       // (lat, ant, sup) components
      const dW = [0, 1, 2].map((i) => lat[i] * d[0] + ant[i] * d[1] + sup[i] * d[2]);
      const f = scapularFrame(tri, centre, ia);
      const vi = versionInclination(f, dW);
      near(vi.version, ver, 1e-6, `${side} version`); near(vi.inclination, inc, 1e-6, `${side} inclination`);
      // rsa-ct protocol: axis from post to sphere centre
      const Lr = { gs: { c: centre, r: 19 }, post: v3.sub(centre, v3.mul(dW, 25)), tri, ia };
      const rr = byId(evaluate(PROTOCOLS['rsa-ct'], { L: Lr, state: {}, mm: 1 }));
      near(rr.version.value, ver, 1e-6); near(rr.tilt.value, inc, 1e-6); near(rr.gsDiam.value, 38, 1e-9);
      // native glenoid: rim points on a face perpendicular to d within the frame
      const inPlane = (u) => v3.unit(v3.reject(u, dW));
      // rim points on the traces of the face in the scapular transverse and coronal planes (what a reformat shows)
      const apDir = inPlane(v3.cross(sup, dW)), siDir = inPlane(v3.cross(ant, dW));
      const apAnt = v3.dot(apDir, ant) > 0 ? apDir : v3.mul(apDir, -1), siSup = v3.dot(siDir, sup) > 0 ? siDir : v3.mul(siDir, -1);
      const ga = v3.add(centre, v3.mul(apAnt, 14)), gp = v3.sub(centre, v3.mul(apAnt, 14));
      const gsup = v3.add(centre, v3.mul(siSup, 18)), ginf = v3.sub(centre, v3.mul(siSup, 18));
      const head = { c: v3.add(v3.add(centre, v3.mul(dW, 22)), v3.mul(apAnt, -0.25 * 48)), r: 24 };   // 25% of the diameter posterior
      const L = { ga, gp, gsup, ginf, tri, ia, head };
      near(glenoidVersion(L), ver, 0.6, `${side} glenoid version`);
      near(glenoidInclination(L), inc, 0.9, `${side} glenoid inclination`);
      near(subluxGlenoid(L), 75, 1.5, `${side} subluxation`);
      assert.ok(Number.isFinite(subluxScapular(L)));
      void dir;
    }
  }
  // without the inferior angle the frame is flagged approximate but still works for a straight patient
  const f = scapularFrame([-100, 20, 0], [0, 0, 0], null);
  assert.equal(f.approximate, true);
  near(versionInclination(f, v3.unit([1, 0.2, 0.1])).inclination, Math.atan2(0.1, Math.hypot(1, 0.2) * Math.cos(Math.atan2(0.2, 1) - Math.atan2(-20, 100))) * 180 / Math.PI, 3);
});

test('muscle statistics follow the published HU classes', () => {
  const vals = new Float32Array([...Array(60).fill(55), ...Array(20).fill(10), ...Array(15).fill(-100), ...Array(5).fill(400)]);
  const s = roiStats(vals, 0.25);
  near(s.fatFraction, 15 / 95, 1e-9); near(s.lowFraction, 20 / 95, 1e-9); near(s.normalFraction, 60 / 95, 1e-9);
  near(s.areaMm2, 25, 1e-9); near(s.effectiveAreaMm2, 20, 1e-9);
  assert.equal(nearestGoutallier(1), 0); assert.equal(nearestGoutallier(12), 2); assert.equal(nearestGoutallier(40), 4);
  const raster = { width: 20, height: 20, data: new Float32Array(400).fill(50) };
  const inside = sampleRoi(raster, [[4.5, 4.5], [14.5, 4.5], [14.5, 14.5], [4.5, 14.5]]);
  assert.equal(inside.length, 100);
  const pre = roiStats(new Float32Array(200).fill(40), 0.25);
  const t = terrierRatios(s, pre);
  near(t.occupation, 0.5, 1e-9); near(t.atrophy, 0.5, 1e-9); near(t.infiltration, 15 * 0.25 / 50, 1e-9); near(t.degeneration, 1 - 20 / 50, 1e-9);
  const res = muscleResults(MUSCLES.find((m) => m.id === 'tm'), s, pre);
  const fat = res.find((r) => r.id === 'tm-fat');
  assert.equal(fat.status, 'borderline');
  assert.ok(res.every((r) => r.refs.every((k) => REFS[k])));
});

test('anatomic versus reverse: decisive cuff findings, grey zones and honesty about unknowns', () => {
  const cta = anatomicVsReverse({ age: 74, ahd: 4, hamada: '3', csa: 39 });
  assert.equal(cta.verdict, 'reverse');
  const oa = anatomicVsReverse({ age: 58, cuff: 'intact', ahd: 10, csa: 27, version: -6, versionSource: 'ct', sublux: 52, walch: 'A1', fat: { ss: 2, is: 3 } });
  assert.equal(oa.verdict, 'anatomic');
  const b3 = anatomicVsReverse({ age: 72, cuff: 'intact', ahd: 9, version: -28, versionSource: 'ct', sublux: 84, walch: 'B3' });
  assert.equal(b3.verdict, 'reverse');
  const unknown = anatomicVsReverse({ age: 60, ahd: 10, csa: 28 });
  assert.equal(unknown.verdict, 'grey');
  assert.ok(unknown.caveats.some((c) => /cuff/.test(c)));
  assert.equal(anatomicVsReverse({}).verdict, 'insufficient');
  for (const d of [cta, oa, b3, unknown]) for (const f of d.factors) for (const k of f.refs) assert.ok(REFS[k], `unknown ref ${k}`);
});

test('bandFor picks bands by exclusive upper bound', () => {
  const bands = [{ upTo: 1, status: 'out' }, { upTo: 2, status: 'good' }, { status: 'borderline' }];
  assert.equal(bandFor(bands, 0.5).status, 'out'); assert.equal(bandFor(bands, 1).status, 'good'); assert.equal(bandFor(bands, 9).status, 'borderline');
});
