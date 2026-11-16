import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { StudyLoader } from '../../src/dicom/index.js';
import { dirSources, FIXTURES, injectWasm, expected, manifest, walk } from './helpers.js';

const M = manifest();
before(() => injectWasm());

const results = new Map();   // case -> { scan, vol, loader, sources }

async function load(caseName) {
  if (results.has(caseName)) return results.get(caseName);
  const c = M.cases[caseName];
  const dir = path.join(FIXTURES, c.folder || caseName);
  const sources = dirSources(dir);
  const loader = new StudyLoader();
  const events = [];
  const scan = await loader.scan(sources, (e) => events.push(e));
  const vol = await loader.buildVolume(scan.recommendedId, (e) => events.push(e));
  const r = { scan, vol, loader, sources, events };
  results.set(caseName, r);
  return r;
}

function assertClose(a, b, tol, msg) {
  assert.equal(a.length, b.length, msg);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, `${msg}: [${a}] vs [${b}]`);
}

function assertHU(vol, expName, label) {
  const exp = expected(expName);
  assert.equal(vol.data.length, exp.length, `${label}: voxel count`);
  assert.ok(vol.data instanceof Int16Array);
  let bad = 0, first = -1;
  for (let i = 0; i < exp.length; i++) if (vol.data[i] !== exp[i]) { bad++; if (first < 0) first = i; }
  assert.equal(bad, 0, `${label}: ${bad} voxels differ (first at ${first}: got ${vol.data[first]}, want ${exp[first]})`);
}

function assertGeometry(vol, c, label) {
  assert.deepEqual(vol.dims, c.dims, `${label}: dims`);
  if (c.origin) assertClose(vol.origin, c.origin, 1e-4, `${label}: origin`);
  if (c.stepX) assertClose(vol.stepX, c.stepX, 1e-5, `${label}: stepX`);
  if (c.stepY) assertClose(vol.stepY, c.stepY, 1e-5, `${label}: stepY`);
  if (c.stepZ) assertClose(vol.stepZ, c.stepZ, 1e-4, `${label}: stepZ`);
  const n = (v) => Math.hypot(...v);
  assertClose(vol.spacing, [n(vol.stepX), n(vol.stepY), n(vol.stepZ)], 1e-9, `${label}: spacing`);
}

// ------------------------------------------------------------------ transfer syntaxes
describe('transfer syntaxes decode to exact HU', () => {
  const tsCases = {
    implicit_le: 'Implicit VR Little Endian', explicit_le: 'Explicit VR Little Endian',
    explicit_be: 'Explicit VR Big Endian', deflated: 'Deflated Explicit VR Little Endian', rle: 'RLE Lossless',
    jpeg_lossless_70: 'JPEG Lossless (Process 14, SV1)', jpeg_lossless_57: 'JPEG Lossless (Process 14)',
    jpeg_ls: 'JPEG-LS Lossless', jpeg2000: 'JPEG 2000 Lossless', no_preamble: 'Implicit VR Little Endian',
    signed_padding: 'Explicit VR Little Endian', enhanced: 'Explicit VR Little Endian', zipped: 'JPEG-LS Lossless',
  };
  for (const [name, tsName] of Object.entries(tsCases)) {
    test(name, async () => {
      const { scan, vol } = await load(name);
      const c = M.cases[name];
      assert.equal(scan.series.length, 1);
      const s = scan.series[0];
      assert.equal(s.transferSyntax, tsName);
      assert.equal(s.compressed, !/Endian/.test(tsName));
      assert.equal(s.supported, true);
      assert.equal(scan.recommendedId, 's1');
      assertHU(vol, c.expected, name);
      assertGeometry(vol, c, name);
      assert.equal(vol.info.numSlices, c.dims[2]);
    });
  }
});

// ------------------------------------------------------------------ geometry
describe('geometry', () => {
  test('reversed file order / shuffled names: sorted by position', async () => {
    const { vol, scan } = await load('reversed');
    assertHU(vol, 'base', 'reversed');
    assertGeometry(vol, M.cases.reversed, 'reversed');
    assert.equal(scan.series[0].orientation, 'axial');
  });
  test('oblique orientation', async () => {
    const { vol, scan } = await load('oblique');
    assertHU(vol, 'base', 'oblique');
    assertGeometry(vol, M.cases.oblique, 'oblique');
    assert.equal(scan.series[0].orientation, 'oblique');
  });
  test('gantry tilt: exact sheared stepZ + warning', async () => {
    const { vol, scan } = await load('gantry_tilt');
    assertHU(vol, 'base', 'tilt');
    assertGeometry(vol, M.cases.gantry_tilt, 'tilt');
    assert.ok(scan.series[0].warnings.some((w) => /gantry tilt 15\.0°/.test(w)), scan.series[0].warnings.join());
    assert.equal(scan.series[0].orientation, 'axial');
    // world(i,j,k) = origin + i*stepX + j*stepY + k*stepZ reproduces the file positions
    const k = 7;
    const w = vol.origin.map((o, a) => o + k * vol.stepZ[a]);
    assertClose(w, [-50, -30, 100 + k * 1.25], 1e-4, 'slice 7 position');
  });
  test('missing slice is interpolated onto a uniform grid', async () => {
    const { vol, scan } = await load('missing_slice');
    assertHU(vol, 'missing', 'missing');
    assertGeometry(vol, M.cases.missing_slice, 'missing');
    assert.ok(scan.series[0].warnings.some((w) => /irregular slice spacing/.test(w)));
    assert.equal(scan.series[0].sliceSpacing, 1.25);
  });
  test('multi-phase stack: first acquisition kept, duplicates dropped', async () => {
    const { vol, scan } = await load('multiphase');
    assertHU(vol, 'base', 'multiphase');
    assertGeometry(vol, M.cases.multiphase, 'multiphase');
    const w = scan.series[0].warnings.join(' | ');
    assert.match(w, /multiple acquisitions\/phases/);
    assert.match(w, /1 duplicate slice ignored/);
  });
  test('no ImagePositionPatient: fallback ordering + warning', async () => {
    const { vol, scan } = await load('no_ipp');
    assertHU(vol, 'base', 'no_ipp');
    assert.deepEqual(vol.dims, M.cases.no_ipp.dims);
    assertClose(vol.stepZ, [0, 0, 1.25], 1e-6, 'stepZ');
    assert.ok(scan.series[0].warnings.some((w) => /slice positions missing/.test(w)));
  });
});

// ------------------------------------------------------------------ mixed study / ranking
describe('mixed study', () => {
  test('ranking picks the thin bone series; unusable series rejected with reasons', async () => {
    const { scan, vol } = await load('mixed');
    const c = M.cases.mixed;
    assert.equal(scan.series[0].seriesNumber, c.pickSeriesNumber);
    assert.equal(scan.recommendedId, scan.series[0].id);
    assert.equal(scan.series[0].kernel, 'BONE');
    assertHU(vol, 'mixed_thin', 'mixed thin');
    assert.deepEqual(vol.dims, c.dims);
    // all usable series, best first
    const nums = scan.series.map((s) => s.seriesNumber);
    assert.deepEqual(nums, [3, 4, 6, 2]);           // bone 0.6 > soft 0.6 > MPR 0.5 (derived) > thick 3 mm
    for (let i = 1; i < scan.series.length; i++) assert.ok(scan.series[i - 1].score >= scan.series[i].score);
    assert.deepEqual(scan.series.map((s) => s.id), ['s1', 's2', 's3', 's4']);
    const thick = scan.series.find((s) => s.seriesNumber === 2);
    assert.ok(thick.warnings.includes('thick slices — model will look stepped'));
    const mpr = scan.series.find((s) => s.seriesNumber === 6);
    assert.equal(mpr.orientation, 'coronal');
    // rejected
    assert.equal(scan.rejected.length, c.rejectedCount);
    const reasons = scan.rejected.map((r) => r.reason).join(' | ');
    assert.match(reasons, /localizer/);
    assert.match(reasons, /secondary capture/);
    assert.match(reasons, /too few slices \(5/);
    assert.equal(scan.skippedFiles, c.skippedFiles);
    assert.equal(scan.report.burnedInRisk, c.burnedInRisk);
    assert.equal(scan.report.descriptorsCleaned, c.descriptorsCleaned);
    // descriptors: "BONE DOE JANE" and "SOFT 20240305" blanked, others kept
    assert.equal(scan.series[0].description, '');
    assert.equal(scan.series[1].description, '');
    assert.equal(thick.description, 'THICK 3MM');
    assert.match(scan.series[0].label, /^Series 3 · 16 slices · 0\.60×0\.70×0\.60 mm$/);
  });
  test('progress events flow', async () => {
    const { events } = await load('mixed');
    assert.ok(events.some((e) => e.phase === 'scan' && e.done === e.total));
    assert.ok(events.some((e) => e.phase === 'load' && e.done === e.total));
  });
});

// ------------------------------------------------------------------ anonymisation
function collectStrings(root) {
  const out = [];
  const seen = new Set();
  const visit = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') { out.push(String(v)); return; }
    if (typeof v === 'function') return;
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
      // raw bytes: decode as latin1 so planted text would be visible
      const u8 = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (!(v instanceof Int16Array)) out.push(Buffer.from(u8).toString('latin1'));
      return;
    }
    if (v instanceof Map) { for (const [k, x] of v) { visit(k); visit(x); } return; }
    if (v instanceof Set) { for (const x of v) visit(x); return; }
    for (const k of Object.keys(v)) { out.push(k); visit(v[k]); }
  };
  visit(root);
  return out.join('\n');
}

function phiCheck(text, extra = []) {
  for (const s of [...M.phiStrings, ...extra]) {
    assert.ok(!text.includes(s), `PHI string "${s}" leaked`);
  }
  // no DICOM UIDs at all, other than none (transfer syntax / SOP class UIDs are not exposed either in outputs)
  const uids = text.match(/\b\d+(\.\d+){5,}\b/g) || [];
  const bad = uids.filter((u) => !u.startsWith('1.2.840.10008.'));
  assert.deepEqual(bad, [], 'UID leaked');
}

describe('anonymisation', () => {
  const all = Object.keys(M.cases).filter((c) => !M.cases[c].unsupported);
  for (const name of all) {
    test(`no PHI, UIDs or file names retained: ${name}`, async () => {
      const { scan, vol, loader, sources } = await load(name);
      const nameParts = new Set();
      for (const s of sources) for (const p of s.name.split(/[\\/]/)) if (p.length >= 6 && p !== name) nameParts.add(p);
      if (name === 'zipped') { nameParts.add('DOE_JANE'); nameParts.add('nested.zip'); }
      const { data, ...volRest } = vol;
      const outputs = collectStrings({ scan, volRest });
      phiCheck(outputs, [...nameParts]);
      // public outputs must not even contain technical UIDs
      assert.ok(!/\b\d+(\.\d+){5,}\b/.test(outputs), 'no UIDs of any kind in outputs');
      const retained = collectStrings(loader._debugState()) + collectStrings(loader);
      phiCheck(retained, [...nameParts]);
    });
  }

  test('anonymisation report counts (implicit_le, full planted PHI, 10 files)', async () => {
    const { scan } = await load('implicit_le');
    const r = scan.report;
    assert.equal(r.filesScanned, 10);
    assert.equal(r.dicomFiles, 10);
    const by = Object.fromEntries(r.identifiersFound.map((x) => [x.category, x]));
    const expectCat = {
      'Patient name': 10, 'Patient ID': 20, 'Dates of birth': 10, 'Patient demographics': 40,
      'Study/series dates & times': 70, 'Institution & staff': 60, 'Accession & order numbers': 40,
      'Device identifiers': 10, 'UIDs': 60, 'Free-text descriptions': 30, 'Private vendor tags': 20,
    };
    for (const [cat, n] of Object.entries(expectCat)) {
      assert.ok(by[cat], `category ${cat} missing`);
      assert.equal(by[cat].elements, n, `${cat} elements`);
      assert.equal(by[cat].files, 10, `${cat} files`);
    }
    assert.ok(r.totalElementsDiscarded >= Object.values(expectCat).reduce((a, b) => a + b, 0));
    assert.equal(r.descriptorsCleaned, 0);
    assert.equal(r.burnedInRisk, 0);
    assert.ok(r.kept.includes('Pixel spacing') && r.kept.includes('Rescale slope/intercept'));
    assert.equal(scan.series[0].description, 'BONE 1.25');
  });

  test('mixed study: description blanked counts as cleaned free text', async () => {
    const { scan } = await load('mixed');
    const ft = scan.report.identifiersFound.find((x) => x.category === 'Free-text descriptions');
    assert.ok(ft.elements > 0);
    assert.ok(scan.report.dicomFiles > 0 && scan.report.filesScanned === scan.report.dicomFiles + 3);
  });
});

// ------------------------------------------------------------------ robustness
describe('robustness', () => {
  test('junk-only input: skipped quietly, meaningful error', async () => {
    const L = new StudyLoader();
    const enc = new TextEncoder();
    const sources = [
      { name: 'a.txt', size: 5, read: async () => enc.encode('hello') },
      { name: 'b.bin', size: 300, read: async () => new Uint8Array(300).fill(7) },
      { name: 'c', size: 0, read: async () => new Uint8Array(0) },
      { name: 'd', size: 0, read: async () => { throw new Error('io'); } },
    ];
    await assert.rejects(L.scan(sources), (e) => {
      assert.equal(e.code, 'NO_CT_SERIES');
      assert.match(e.message, /No DICOM images were found/);
      assert.equal(e.result.skippedFiles, 4);
      return true;
    });
  });

  test('unsupported compression: listed as unsupported, buildVolume throws a clear error', async () => {
    const L = new StudyLoader();
    const scan = await L.scan(dirSources(path.join(FIXTURES, 'unsupported_jpeg')));
    assert.equal(scan.series.length, 1);
    assert.equal(scan.series[0].supported, false);
    assert.equal(scan.recommendedId, null);
    assert.match(scan.series[0].warnings[0], /unsupported compression: JPEG Baseline/);
    await assert.rejects(L.buildVolume(scan.series[0].id), /cannot be decoded.*JPEG Baseline/);
  });

  test('a truncated file among good ones does not break the scan', async () => {
    const dir = path.join(FIXTURES, 'explicit_le');
    const sources = dirSources(dir);
    const bytes = fs.readFileSync(walk(dir)[0]);
    sources.push({ name: 'trunc', size: 900, read: async () => new Uint8Array(bytes.subarray(0, 900)) });
    const L = new StudyLoader();
    const scan = await L.scan(sources);
    assert.equal(scan.skippedFiles, 1);
    assert.equal(scan.series[0].numSlices, 10);
  });

  test('ArrayBuffer sources and reset()', async () => {
    const sources = dirSources(path.join(FIXTURES, 'rle')).map((s) => ({ ...s, read: async () => { const u = await s.read(); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); } }));
    const L = new StudyLoader();
    const scan = await L.scan(sources);
    const vol = await L.buildVolume('s1');
    assertHU(vol, 'base', 'arraybuffer');
    L.reset();
    await assert.rejects(L.buildVolume(scan.recommendedId), /no longer available/);
  });
});
