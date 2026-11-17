// The real-film landmarking pipeline, checked on synthetic radiographs with known geometry. (It was developed on
// clinical films, which are not and must not be in this repository; the phantoms guard against regressions.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePhantom } from '../../src/sample/xray-phantom.js';
import { autoLandmarks, nativeLandmarks } from '../../src/detect/auto.js';
import { detectHead } from '../../src/detect/xray.js';
import { grayWithoutOverlay } from '../../src/detect/overlay.js';

const ang = (l) => { let a = Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]) * 180 / Math.PI; if (a < 0) a += 180; return a; };
const dAng = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };
const RSA_IDS = ['sgt', 'igr', 'acr', 'acu', 'ssf', 'gts', 'gtl', 'canalM', 'stemM', 'canalD', 'stemD'];
const HEMI_IDS = ['pcA', 'pcB', 'pcC', 'gts', 'acu', 'sgt', 'igr', 'canalM', 'stemM', 'canalD', 'stemD'];

for (const o of [{ side: 'R', seed: 1 }, { side: 'L', seed: 2 }, { side: 'R', seed: 3, width: 2400, height: 2900, mmPerPx: 0.12 }, { side: 'L', seed: 4, width: 1000, height: 1200, mmPerPx: 0.28 }]) {
  test(`reverse ${JSON.stringify(o)}: implant geometry and a full set of landmarks`, () => {
    const ph = makePhantom({ kind: 'reverse', ...o });
    const r = autoLandmarks(ph.image);
    assert.ok(r, 'implant found');
    assert.equal(r.kind, 'reverse');
    const g = r.reverse.glenosphere, t = ph.truth.glenosphere, mm = ph.mmPerPx;
    assert.ok(Math.hypot(g.cx - t.cx, g.cy - t.cy) * mm < 1, 'glenosphere centre within 1 mm');
    assert.ok(Math.abs(g.r - t.r) * mm < 0.7, 'radius within 0.7 mm');
    assert.ok(dAng(ang(g.face), ang(t.face)) < 6, `face angle (${dAng(ang(g.face), ang(t.face)).toFixed(1)}°)`);
    assert.ok(g.face.a[1] < g.face.b[1], 'face.a is the superior end');
    assert.ok(dAng(ang(r.stem), ang(ph.truth.stem)) < 1.5, 'stem axis within 1.5°');
    assert.ok(r.stem.a[1] < r.stem.b[1], 'stem.a is proximal');
    assert.equal(r.side, ph.truth.stem.a[0] < t.cx ? 'left-of-glenoid' : 'right-of-glenoid');
    const e = r.estimates['rsa-ap'];
    for (const id of RSA_IDS) assert.ok(e[id], `landmark ${id} is placed`);
    for (const id of ['sgt', 'igr', 'acr', 'acu', 'ssf', 'gts', 'gtl', 'canalM', 'canalD']) assert.ok(e[id].confidence < 0.8, `${id} is offered as an estimate`);
    assert.ok(e.stemM.confidence >= 0.8 && e.stemD.confidence >= 0.8, 'stem widths are measurements');
    // estimates land in the right neighbourhood of the true anatomy
    const d = (p, q) => Math.hypot(p.x - q[0], p.y - q[1]) * mm;
    assert.ok(d(e.acr, ph.truth.acr) < 10, `acromion ${d(e.acr, ph.truth.acr).toFixed(1)} mm`);
    assert.ok(d(e.sgt, ph.truth.sgt) < 10 && d(e.gts, ph.truth.gts) < 10);
  });
}

test('hemiarthroplasty: head circle, stem and landmarks; native shoulder: no implant is invented', () => {
  for (const side of ['R', 'L']) {
    const h = makePhantom({ kind: 'hemi', side, seed: 11 });
    const r = autoLandmarks(h.image, { headFinder: detectHead });
    assert.ok(r && r.kind === 'hemi', 'hemi recognised');
    assert.ok(Math.hypot(r.head.cx - h.truth.head.cx, r.head.cy - h.truth.head.cy) * h.mmPerPx < 1.2);
    assert.ok(dAng(ang(r.stem), ang(h.truth.stem)) < 1.5);
    for (const id of HEMI_IDS) assert.ok(r.estimates['pyc-ap'][id], `landmark ${id} is placed`);
    const n = makePhantom({ kind: 'native', side, seed: 12 });
    assert.equal(autoLandmarks(n.image, { headFinder: detectHead }), null);
    const head = detectHead(n.image);
    const e = nativeLandmarks(n.image, head, side === 'R' ? -1 : 1);
    for (const id of ['sgt', 'igr', 'acr', 'acu', 'gtl', 'ssf']) assert.ok(e[id], `native landmark ${id} is placed`);
  }
});

test('coloured overlay text is blanked from a screenshot, grey film is kept', () => {
  const w = 60, h = 40, rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = 120; rgba[4 * i + 3] = 255; }
  for (let y = 10; y < 14; y++) for (let x = 10; x < 30; x++) { const p = 4 * (y * w + x); rgba[p] = 0; rgba[p + 1] = 160; rgba[p + 2] = 230; }   // cyan "text"
  const { gray, blanked } = grayWithoutOverlay(rgba, w, h);
  assert.ok(blanked >= 80);
  assert.equal(gray[12 * w + 20], 0, 'text pixel blanked');
  assert.equal(gray[8 * w + 20], 0, 'fringe blanked');
  assert.ok(Math.abs(gray[30 * w + 45] - 120) < 0.5, 'film untouched');
});
