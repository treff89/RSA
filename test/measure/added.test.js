// HARA / SHARA, deltoid geometry, Schippers' frame, lateral acromial angle, posterior acromial morphology and the
// comparison of two films. Each scene is built on both sides of the image (mirrored) to check the sign conventions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOLS, protocolFor, viewsFor } from '../../src/measure/protocols/index.js';
import { evaluate, evaluateFindings } from '../../src/measure/core.js';
import { compareFilms, commonScale } from '../../src/measure/compare.js';
import { ssfFromGlenoid } from '../../src/measure/protocols/xray-common.js';
import { seedXray } from '../../src/measure/seed.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r]));
const rad = (d) => d * Math.PI / 180;

/** Mirror a landmark set about x = 500 (point, line or circle values). */
function mirror(L) {
  const m = (p) => ({ x: 1000 - p.x, y: p.y });
  return Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.cx !== undefined ? { ...v, cx: 1000 - v.cx } : v.a ? { a: m(v.a), b: m(v.b) } : m(v)]));
}
const ctxOf = (L, side, mm = 0.2, src = 'implant') => ({ L: side > 0 ? L : mirror(L), state: {}, mm, mmSource: src, lateralSign: side });

test('HARA and SHARA: arm at the side, abducted, on both sides', () => {
  for (const side of [1, -1]) {
    // humerus on the image's right of the glenoid (side +1); stem tilted so the distal end points lateral by 15°
    const top = { x: 600, y: 300 }, len = 400;
    const L = {
      gs: { cx: 560, cy: 280, r: 90 }, face: { a: { x: 470, y: 190 }, b: { x: 470, y: 370 } },
      stem: { a: top, b: { x: top.x + len * Math.sin(rad(15)), y: top.y + len * Math.cos(rad(15)) } },
      ssf: { a: { x: 450, y: 200 }, b: { x: 150, y: 200 } },
    };
    const r = byId(evaluate(PROTOCOLS['rsa-ap'], ctxOf(L, side)));
    near(r.hara.value, 15, 1e-6, `HARA side ${side}`);
    assert.match(r.hara.text, /abduction/);
    near(r.shara.value, 105, 1e-6, `SHARA side ${side}`);   // 90° to a horizontal fossa line + 15° abduction
    assert.match(r.shara.text, /RSA-HARA 15\.0°/);
  }
});

test('deltoid moment arm and wrapping angle (Rhee)', () => {
  for (const side of [1, -1]) {
    const L = {
      gs: { cx: 500, cy: 300, r: 90 }, acr: { x: 700, y: 150 }, gtl: { x: 760, y: 300 }, dtu: { x: 700, y: 900 },
    };
    const r = byId(evaluate(PROTOCOLS['rsa-ap'], ctxOf(L, side, 0.2)));
    near(r.dma.value, 260 * 0.2, 1e-6, 'DMA');
    const a = Math.atan2(60, 150) + Math.atan2(60, 600);   // angles of the two arms from the vertical at gtl
    near(r.dwa.value, 180 - a * 180 / Math.PI, 1e-6, 'DWA');
    assert.equal(r.dwa.status, 'info');
  }
});

test('Schippers frame: OX and OY as a share of the shaft diameter', () => {
  for (const side of [1, -1]) {
    const L = {
      head: { cx: 650, cy: 320, r: 100 },
      ssf: { a: { x: 600, y: 300 }, b: { x: 200, y: 300 } },   // horizontal fossa line
      acr: { x: 780, y: 180 },
      shaftD: { a: { x: 600, y: 700 }, b: { x: 700, y: 700 } },  // d = 100 px
    };
    const r = byId(evaluate(PROTOCOLS['pyc-ap'], ctxOf(L, side)));
    // O = (780, 300); medial head edge at x 550 → OX 230 px; head top at y 220 → OY 80 px
    near(r.schOX.value, 230, 1e-6, `OX side ${side}`);
    near(r.schOY.value, 80, 1e-6, `OY side ${side}`);
    assert.match(r.schOX.text, /46\.0 mm/);
  }
});

test('lateral acromial angle (Banas) and acromion–tuberosity distance on a native film', () => {
  for (const side of [1, -1]) {
    for (const slope of [0, 20]) {
      const s = Math.tan(rad(slope));
      const L = {
        sgt: { x: 500, y: 300 }, igr: { x: 500, y: 500 },
        acLine: { a: { x: 520, y: 200 }, b: { x: 720, y: 200 + 200 * s } },   // lateral end lower by `slope`
        acu: { x: 650, y: 210 }, gts: { x: 680, y: 330 },
      };
      const r = byId(evaluate(PROTOCOLS['native-ap'], ctxOf(L, side, 0.2, 'dicom')));
      near(r.laa.value, 90 - slope, 1e-6, `LAA slope ${slope} side ${side}`);
      assert.equal(r.laa.status, slope === 20 ? 'out' : 'good');
      near(r.atd.value, Math.hypot(30, 120) * 0.2, 1e-6);
    }
  }
});

test('posterior acromial height, tilt and coverage on the Y-view (Meyer)', () => {
  assert.equal(protocolFor('native', 'xray', 'y').id, 'native-y');
  assert.deepEqual(viewsFor('native'), ['ap', 'axillary', 'y']);
  assert.deepEqual(viewsFor('reverse'), ['ap']);
  // reference line vertical through the centre of the Y; the image may be either way round
  for (const flip of [1, -1]) {
    const L = { yc: { x: 500, y: 500 }, ia: { x: 500, y: 900 }, pa: { x: 500 - flip * 150, y: 375 }, aa: { x: 500 + flip * 100, y: 300 } };
    const r = byId(evaluate(PROTOCOLS['native-y'], { L, state: {}, mm: 0.2, lateralSign: 1 }));
    near(r.pah.value, 125 * 0.2, 1e-6, 'PAH');
    assert.equal(r.pah.status, 'out');                                   // 25 mm > 23 mm
    near(r.pac.value, Math.atan2(150, 125) * 180 / Math.PI, 1e-6, 'PAC');
    near(r.pat.value, Math.acos(75 / Math.hypot(250, 75)) * 180 / Math.PI, 1e-6, 'PAT');
    const s = PROTOCOLS['native-y'].synthesis(r);
    assert.equal(s[0].status, 'out');
  }
});

test('SSF estimate from the glenoid rim is medial, rising and tied to the rim', () => {
  for (const side of [1, -1]) {
    const sgt = { x: 500, y: 300 }, igr = { x: 500, y: 500 };
    const l = ssfFromGlenoid(sgt, igr, side, 15);
    assert.ok((l.b.x - l.a.x) * side < 0, 'runs medially');
    assert.ok(l.b.y < l.a.y, 'rises medially');
    near(Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y), 2.1 * 200, 1e-6);
  }
  // seeding fills it on hemi films from the estimated rim points, and never on reverse films
  const det = { side: 'right-of-glenoid', estimates: { 'pyc-ap': { sgt: { x: 500, y: 300, confidence: 0.4 }, igr: { x: 500, y: 500, confidence: 0.4 } } } };
  const s = seedXray(PROTOCOLS['pyc-ap'], det);
  assert.ok(s.values.ssf && s.state.ssf === 'estimated');
  const s2 = seedXray(PROTOCOLS['rsa-ap'], { side: 'right-of-glenoid', estimates: { 'rsa-ap': { sgt: { x: 500, y: 300, confidence: 0.4 }, igr: { x: 500, y: 500, confidence: 0.4 } } } });
  assert.equal(s2.values.ssf, undefined);
});

// ── comparison ──
const bundle = (pid, L, side, mm, src, findings = {}) => {
  const p = PROTOCOLS[pid];
  const ctx = ctxOf(L, side, mm, src);
  return { protocol: p, ctx, results: evaluate(p, ctx), findings: evaluateFindings(p, findings) };
};

test('comparison: pre-operative native film against a reverse, scale carried over by glenoid height', () => {
  for (const side of [1, -1]) {
    // pre-op film at half the pixel size of the post-op film (different magnification), uncalibrated
    const pre = {
      head: { cx: 290, cy: 160, r: 50 }, sgt: { x: 250, y: 140 }, igr: { x: 250, y: 220 }, acr: { x: 320, y: 100 }, acu: { x: 300, y: 104 },
      gts: { x: 315, y: 135 }, gtl: { x: 335, y: 160 },
    };
    const post = {
      gs: { cx: 520, cy: 360, r: 90 }, face: { a: { x: 500, y: 280 }, b: { x: 500, y: 440 } }, stem: { a: { x: 600, y: 420 }, b: { x: 600, y: 900 } },
      sgt: { x: 500, y: 280 }, igr: { x: 500, y: 440 }, acr: { x: 640, y: 200 }, acu: { x: 600, y: 208 },
      gts: { x: 630, y: 330 }, gtl: { x: 690, y: 380 },
    };
    const e = bundle('native-ap', pre, side, null, null);
    const c = bundle('rsa-ap', post, side, 0.2, 'implant');
    const sc = commonScale(e, c);
    assert.equal(sc.mode, 'glenoid');
    near(sc.f[1], 0.2, 1e-9); near(sc.f[0], 0.4, 1e-9);   // glenoid height 160 px × 0.2 = 32 mm = 80 px × 0.4
    const r = compareFilms(e, c);
    assert.equal(r.type, 'preop-reverse');
    const atd = r.rows.find((x) => x.id === 'atd');
    near(atd.earlier, Math.hypot(15, 31) * 0.4, 1e-6);
    near(atd.current, Math.hypot(30, 122) * 0.2, 1e-6);
    assert.equal(atd.status, atd.change >= 0 && atd.change <= 20 ? 'good' : atd.change < 0 ? 'out' : 'borderline');
    assert.match(atd.label, /lengthening/i);
    assert.ok(r.rows.find((x) => x.id === 'lsa') && r.rows.find((x) => x.id === 'dsa'));
  }
});

test('comparison: reverse follow-up flags acromion–tuberosity rise, baseplate tilt and notching progression', () => {
  const base = {
    gs: { cx: 520, cy: 360, r: 90 }, face: { a: { x: 500, y: 280 }, b: { x: 500, y: 440 } }, stem: { a: { x: 600, y: 420 }, b: { x: 600, y: 900 } },
    sgt: { x: 500, y: 280 }, igr: { x: 500, y: 440 }, acr: { x: 640, y: 200 }, acu: { x: 600, y: 208 }, ssf: { a: { x: 480, y: 290 }, b: { x: 200, y: 290 } },
    gts: { x: 630, y: 330 }, gtl: { x: 690, y: 380 },
  };
  const later = JSON.parse(JSON.stringify(base));
  later.acu = { x: 600, y: 168 };                                         // acromion 40 px = 8 mm higher
  const t = rad(12);                                                       // face tilted 12°
  later.face = { a: { x: 500 - 80 * Math.sin(t), y: 360 - 80 * Math.cos(t) }, b: { x: 500 + 80 * Math.sin(t), y: 360 + 80 * Math.cos(t) } };
  for (const side of [1, -1]) {
    const e = bundle('rsa-ap', base, side, 0.2, 'implant', { notching: '1' });
    const c = bundle('rsa-ap', later, side, 0.2, 'implant', { notching: '3' });
    const r = compareFilms(e, c, { months: 12 });
    const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    assert.equal(r.type, 'followup-reverse');
    assert.equal(r.scale.mode, 'implant');
    near(by.atd.change, Math.hypot(30, 162) * 0.2 - Math.hypot(30, 122) * 0.2, 1e-6);
    assert.equal(by.atd.status, 'out');
    near(Math.abs(by.tilt.change), 12, 1e-6);
    assert.equal(by.tilt.status, 'out');
    assert.equal(by.gtCor.status, 'good');
    const n = r.findings.find((f) => f.id === 'notching');
    assert.equal(n.status, 'out');
    assert.match(n.say, /Progressed/);
  }
});

test('comparison: Schippers medialisation graded by rate when the interval is given', () => {
  const mk = (cx) => ({
    head: { cx, cy: 320, r: 100 }, ssf: { a: { x: 600, y: 300 }, b: { x: 200, y: 300 } }, acr: { x: 780, y: 180 },
    shaftD: { a: { x: 600, y: 700 }, b: { x: 700, y: 700 } }, stem: { a: { x: 650, y: 420 }, b: { x: 650, y: 900 } },
  });
  for (const side of [1, -1]) {
    const e = bundle('pyc-ap', mk(650), side, null, null), c = bundle('pyc-ap', mk(630), side, null, null);   // 20 px = 20% of d
    const slow = compareFilms(e, c, { months: 60 }), fast = compareFilms(e, c, { months: 12 }), none = compareFilms(e, c);
    const ox = (r) => r.rows.find((x) => x.id === 'schOX');
    near(ox(slow).change, 20, 1e-6);
    assert.equal(ox(slow).status, 'good');        // 0.33% a month
    assert.equal(ox(fast).status, 'out');         // 1.67% a month
    assert.equal(ox(none).status, 'borderline');  // 20%: measurable, under mean + SD
    assert.equal(none.scale.mode, 'none');        // no rim points, no calibration: distances skipped
    assert.ok(!none.rows.some((x) => x.id === 'ahdHead'));
  }
});

test('comparison warns when arm position differs by more than 10°', () => {
  const mk = (deg) => ({
    gs: { cx: 520, cy: 360, r: 90 }, face: { a: { x: 500, y: 280 }, b: { x: 500, y: 440 } },
    stem: { a: { x: 600, y: 420 }, b: { x: 600 + 400 * Math.sin(rad(deg)), y: 420 + 400 * Math.cos(rad(deg)) } },
    sgt: { x: 500, y: 280 }, igr: { x: 500, y: 440 }, acr: { x: 640, y: 200 }, gts: { x: 630, y: 330 }, gtl: { x: 690, y: 380 },
  });
  const r = compareFilms(bundle('rsa-ap', mk(5), 1, 0.2, 'implant'), bundle('rsa-ap', mk(25), 1, 0.2, 'implant'));
  near(r.rows.find((x) => x.id === 'hara').change, 20, 1e-6);
  assert.ok(r.notes.some((n) => /abducted/.test(n)));
});
