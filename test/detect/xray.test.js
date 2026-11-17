// Automatic detection on synthetic radiographs with known geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePhantom } from '../../src/sample/xray-phantom.js';
import { classify, detectReverse, detectMetal, detectHead, estimateLandmarks } from '../../src/detect/xray.js';

const deg = (v) => Math.atan2(v[1], v[0]) * 180 / Math.PI;
const lineAngle = (l) => { let a = deg([l.b[0] - l.a[0], l.b[1] - l.a[1]]); if (a < 0) a += 180; return a; };
const dAng = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };

const REVERSE = [
  { side: 'R', seed: 1 }, { side: 'L', seed: 2 },
  { side: 'R', seed: 3, width: 1000, height: 1200, mmPerPx: 0.28 },
  { side: 'L', seed: 4, width: 2400, height: 2900, mmPerPx: 0.12 },
  { side: 'R', seed: 5, mmPerPx: 0.16 },
  { side: 'L', seed: 6, mmPerPx: 0.25 },
];

for (const o of REVERSE) {
  test(`reverse phantom ${JSON.stringify(o)}: glenosphere, back face and stem`, () => {
    const ph = makePhantom({ kind: 'reverse', ...o });
    const t = ph.truth.glenosphere, mm = ph.mmPerPx;
    const c = classify(ph.image);
    assert.equal(c.kind, 'reverse');
    const g = c.reverse.glenosphere;
    assert.ok(Math.hypot(g.cx - t.cx, g.cy - t.cy) * mm < 1, `centre off by ${(Math.hypot(g.cx - t.cx, g.cy - t.cy) * mm).toFixed(2)} mm`);
    assert.ok(Math.abs(g.r - t.r) * mm < 0.5, `radius off by ${((g.r - t.r) * mm).toFixed(2)} mm`);
    assert.ok(dAng(lineAngle(g.face), lineAngle(t.face)) < 3, 'face angle');
    assert.ok(g.face.a[1] < g.face.b[1], 'face.a is the superior end');
    // the dome axis points away from the glenoid, towards the humerus
    const humerusLeft = ph.truth.stem.a[0] < t.cx;
    assert.equal(g.axis[0] < 0, humerusLeft);
    assert.equal(c.reverse.side, humerusLeft ? 'left-of-glenoid' : 'right-of-glenoid');
    assert.ok(c.reverse.stem, 'stem found');
    assert.ok(dAng(lineAngle(c.reverse.stem), lineAngle(ph.truth.stem)) < 2, 'stem axis');
    assert.ok(c.reverse.stem.a[1] < c.reverse.stem.b[1], 'stem.a is proximal');
    const est = estimateLandmarks(ph.image, c, { protocol: 'rsa-ap' });
    for (const id of ['stemM', 'stemD']) {
      const w = Math.hypot(est[id].b[0] - est[id].a[0], est[id].b[1] - est[id].a[1]);
      const tw = Math.hypot(ph.truth[id].b[0] - ph.truth[id].a[0], ph.truth[id].b[1] - ph.truth[id].a[1]);
      assert.ok(Math.abs(w - tw) * mm < 1, `${id} width off by ${((w - tw) * mm).toFixed(2)} mm`);
      assert.ok(est[id].confidence >= 0.8);
    }
    // bony landmarks are estimates and must say so
    for (const id of ['sgt', 'igr', 'acr', 'gtl', 'gts']) if (est[id]) assert.ok(est[id].confidence < 0.8, `${id} must not claim to be a measurement`);
  });
}

// The app now uses this module only for detectHead (the fallback head circle); implant classification lives in
// auto.js and is tested in auto.test.js.
test('head circle on hemiarthroplasty and native phantoms; no metal or glenosphere on a native shoulder', () => {
  for (const side of ['R', 'L']) {
    const h = makePhantom({ kind: 'hemi', side, seed: 11 });
    const hh = detectHead(h.image);
    assert.ok(Math.hypot(hh.cx - h.truth.head.cx, hh.cy - h.truth.head.cy) * h.mmPerPx < 1);
    assert.ok(Math.abs(hh.r - h.truth.head.r) * h.mmPerPx < 0.6);
    const n = makePhantom({ kind: 'native', side, seed: 12 });
    const hn = detectHead(n.image);
    assert.equal(detectReverse(n.image), null);
    assert.equal(detectMetal(n.image).present, false);
    assert.ok(Math.hypot(hn.cx - n.truth.head.cx, hn.cy - n.truth.head.cy) * n.mmPerPx < 2);
    assert.ok(Math.abs(hn.r - n.truth.head.r) * n.mmPerPx < 1.5);
  }
});

test('intensity scale does not matter; a blank image yields nothing', () => {
  const ph = makePhantom({ kind: 'reverse', side: 'R', seed: 21 });
  const d = ph.image.data;
  const scaled = { width: ph.image.width, height: ph.image.height, data: Float32Array.from(d, (v) => v * 0.004 + 17) };
  const a = classify(ph.image).reverse.glenosphere, b = classify(scaled).reverse.glenosphere;
  assert.ok(Math.hypot(a.cx - b.cx, a.cy - b.cy) < 1.5 && Math.abs(a.r - b.r) < 1);
  const blank = { width: 600, height: 700, data: new Float32Array(600 * 700).fill(100) };
  const c = classify(blank);
  assert.equal(c.reverse, null);
  assert.notEqual(c.kind, 'reverse');
});

test('a 3000 × 3000 radiograph is analysed in reasonable time', () => {
  const ph = makePhantom({ kind: 'reverse', side: 'R', seed: 31, width: 3000, height: 3000, mmPerPx: 0.1 });
  const t0 = performance.now();
  const c = classify(ph.image);
  const ms = performance.now() - t0;
  assert.equal(c.kind, 'reverse');
  assert.ok(ms < 8000, `took ${ms.toFixed(0)} ms`);
});
