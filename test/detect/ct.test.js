// Automatic detection on synthetic CT volumes with known geometry, checked through the measurement protocols.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCtPhantom } from '../../src/sample/ct-phantom.js';
import { detectMetal, detectReverse, detectHeadSphere, sampleHU, worldToIndex, indexToWorld } from '../../src/detect/ct.js';
import { PROTOCOLS } from '../../src/measure/protocols/index.js';
import { evaluate } from '../../src/measure/core.js';
import { v3 } from '../../src/measure/geom.js';
import { roiStats } from '../../src/measure/muscle.js';

const by = (rs) => Object.fromEntries(rs.map((r) => [r.id, r.value]));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} ± ${tol}, got ${a}`);
const angle = (a, b) => Math.acos(Math.min(1, v3.dot(a, b))) * 180 / Math.PI;

const REVERSE = [
  { versionDeg: -6, inclinationDeg: -4, side: 'R' },
  { versionDeg: -15, inclinationDeg: 8, side: 'L', clipHU: 3071, seed: 2 },
  { versionDeg: 10, inclinationDeg: -12, side: 'R', tiltDeg: 8, clipHU: 3071, bloom: 0.5, seed: 3 },
  { versionDeg: 0, inclinationDeg: 0, side: 'L', bloom: 1, seed: 4, glenosphereDiameter: 42 },
  { versionDeg: -20, inclinationDeg: 12, side: 'R', voxel: [0.7, 0.7, 1.25], seed: 5, glenosphereDiameter: 36 },
];

for (const o of REVERSE) {
  test(`reverse CT ${JSON.stringify(o)}: glenosphere, axis, stem, and the measurements that follow`, () => {
    const { volume, truth: t } = makeCtPhantom({ kind: 'reverse', ...o });
    assert.equal(detectMetal(volume).present, true);
    const r = detectReverse(volume);
    assert.ok(r, 'glenosphere detected');
    const g = r.glenosphere;
    near(v3.dist(g.center, t.glenosphere.center), 0, 0.8, 'centre');
    near(g.radius, t.glenosphere.radius, 0.6, 'radius');
    near(angle(g.axis, t.glenosphere.axis), 0, 2, 'axis');
    assert.ok(r.stem, 'stem detected');
    const ts = v3.unit(v3.sub(t.stem.b, t.stem.a));
    near(Math.min(angle(r.stem.axis, ts), angle(v3.mul(r.stem.axis, -1), ts)), 0, 2.5, 'stem axis');
    const L = { gs: { c: g.center, r: g.radius }, post: r.post || v3.sub(g.center, v3.mul(g.axis, 20)), tri: t.tri, ia: t.ia };
    const m = by(evaluate(PROTOCOLS['rsa-ct'], { L, state: {}, mm: 1 }));
    near(m.version, o.versionDeg, 2, 'version from detection');
    near(m.tilt, o.inclinationDeg, 2, 'inclination from detection');
    near(m.gsDiam, 2 * t.glenosphere.radius, 1.2, 'diameter');
  });
}

for (const o of [{ versionDeg: -17, inclinationDeg: 7, subluxationPct: 68, side: 'R' }, { versionDeg: -3, inclinationDeg: 2, subluxationPct: 50, side: 'L', tiltDeg: 6 }, { versionDeg: -28, inclinationDeg: 12, subluxationPct: 82, side: 'L', voxel: [0.7, 0.7, 1.25] }]) {
  test(`native and hemiarthroplasty CT ${JSON.stringify(o)}: head sphere, version, inclination, subluxation`, () => {
    for (const kind of ['native', 'hemi']) {
      const { volume, truth: t } = makeCtPhantom({ kind, ...o });
      assert.equal(detectMetal(volume).present, kind === 'hemi');
      if (kind === 'hemi') assert.equal(detectReverse(volume), null, 'a prosthetic head is not a glenosphere');
      const h = detectHeadSphere(volume, { mode: kind === 'hemi' ? 'auto' : 'bone' });
      assert.ok(h, `${kind} head found`);
      near(v3.dist(h.center, t.headCenter), 0, 1.2, `${kind} head centre`);
      near(h.radius, t.headRadius, 0.8, `${kind} head radius`);
      const L = { head: { c: h.center, r: h.radius }, ga: t.ga, gp: t.gp, gsup: t.gsup, ginf: t.ginf, tri: t.tri, ia: t.ia };
      const m = by(evaluate(PROTOCOLS[kind === 'hemi' ? 'pyc-ct' : 'native-ct'], { L, state: {}, mm: 1 }));
      near(m.version, o.versionDeg, 0.5, 'version');
      near(m.incl, o.inclinationDeg, 0.5, 'inclination');
      near(m.subluxScap, o.subluxationPct, 2, 'scapula-referenced subluxation');
      assert.ok(m.sublux > 40 && m.sublux < m.subluxScap + 1, 'glenoid-referenced index is the smaller one on a retroverted glenoid');
    }
  });
}

test('index/world helpers round-trip and muscle fat fractions are recoverable from HU', () => {
  const fat = { supraspinatus: 0.3, infraspinatus: 0.05, subscapularis: 0.12, teresMinor: 0.2, deltoid: 0.08 };
  const { volume, truth: t } = makeCtPhantom({ kind: 'native', tiltDeg: 7, fat });
  const w = indexToWorld(volume, 10.5, 20.25, 30.75);
  const ijk = worldToIndex(volume, w);
  near(ijk[0], 10.5, 1e-6, 'i'); near(ijk[1], 20.25, 1e-6, 'j'); near(ijk[2], 30.75, 1e-6, 'k');
  const [nx, ny] = volume.dims;
  for (const [name, m] of Object.entries(t.muscles)) {
    // native voxels, not interpolated: interpolation blends fat and muscle into intermediate values (see Mpr.samplePlane)
    const c = worldToIndex(volume, m.center).map(Math.round);
    const vals = [];
    for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) for (let k = -4; k <= 4; k++) vals.push(volume.data[(c[0] + i) + nx * ((c[1] + j) + ny * (c[2] + k))]);
    const s = roiStats(Float32Array.from(vals), 1);
    near(s.fatFraction, m.fatFraction, 0.04, `${name} fat fraction`);
    // and the interpolated value at the same place is within the muscle range, so sampleHU is wired correctly
    const hu = sampleHU(volume, m.center);
    assert.ok(hu > -190 && hu < 166, `${name} HU ${hu}`);
  }
});

test('a 320 × 320 × 240 volume is analysed in reasonable time', () => {
  const { volume } = makeCtPhantom({ kind: 'reverse', dims: [320, 320, 240], voxel: [0.6, 0.6, 0.8] });
  const t0 = performance.now();
  const r = detectReverse(volume);
  const ms = performance.now() - t0;
  assert.ok(r);
  assert.ok(ms < 12000, `took ${ms.toFixed(0)} ms`);
});
