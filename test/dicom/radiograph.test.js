import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRadiograph } from '../../src/dicom/index.js';
import { canDecodeJpegBaseline } from '../../src/dicom/radiograph.js';
import { xray, ramp, PHI_STRINGS, leaks } from './xr-helpers.js';
import { TS, rleFrame } from './dicom-writer.js';

const close = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

describe('greyscale radiographs', () => {
  test('CR explicit VR: geometry, masked + rescaled values, window, spacing, meta', async () => {
    const rows = 8, cols = 12;
    const px = ramp(rows, cols);
    px[5] |= 0xf000;                       // bits above BitsStored must be masked off
    const r = await parseRadiograph(xray({
      rows, cols, pixels: px, description: 'SHOULDER AP',
      extra: [['00280030', 'DS', ['0.15', '0.15']], ['00281050', 'DS', ['500', '600']], ['00281051', 'DS', ['400', '800']],
        ['00281052', 'DS', '-10'], ['00281053', 'DS', '2'], ['00200062', 'CS', 'R'], ['00185101', 'CS', 'AP']],
    }));
    assert.equal(r.width, cols);
    assert.equal(r.height, rows);
    assert.ok(r.data instanceof Float32Array);
    assert.equal(r.data.length, rows * cols);
    for (let i = 0; i < r.data.length; i++) assert.equal(r.data[i], (100 + i * 37) * 2 - 10, `pixel ${i}`);
    assert.equal(r.min, 190);
    assert.equal(r.max, (100 + 95 * 37) * 2 - 10);
    assert.deepEqual(r.window, { center: 500, width: 400 });
    assert.equal(r.pixelSpacing.mm, 0.15);
    assert.equal(r.pixelSpacing.source, 'PixelSpacing');
    assert.equal(r.pixelSpacing.magnification, null);
    assert.equal(r.meta.modality, 'CR');
    assert.equal(r.meta.bodyPart, 'SHOULDER');
    assert.equal(r.meta.laterality, 'R');
    assert.equal(r.meta.viewPosition, 'AP');
    assert.equal(r.meta.description, 'SHOULDER AP');
    assert.equal(r.meta.bitsStored, 12);
    assert.equal(r.meta.photometric, 'MONOCHROME2');
    assert.equal(r.meta.transferSyntax, 'Explicit VR Little Endian');
    assert.equal(r.meta.burnedInRisk, false);
    assert.equal(r.meta.inverted, false);
    assert.deepEqual(leaks({ ...r, data: null }, PHI_STRINGS), []);
  });

  test('DX implicit VR, MONOCHROME1 (+ redundant INVERSE): inverted once; ImagerPixelSpacing / magnification factor', async () => {
    const px = ramp(8, 12);
    const r = await parseRadiograph(xray({
      modality: 'DX', photometric: 'MONOCHROME1', implicit: true, pixels: px, sopClass: '1.2.840.10008.5.1.4.1.1.1.1',
      description: 'Schulter Mustermann',
      extra: [['00181164', 'DS', ['0.2', '0.2']], ['00181114', 'DS', '1.25'], ['00281050', 'DS', '1000'], ['00281051', 'DS', '2000'],
        ['20500020', 'CS', 'INVERSE'], ['00200060', 'CS', 'L'], ['00185101', 'CS', 'ERIKA'], ['00200020', 'CS', ['L', 'F']]],
    }));
    assert.equal(r.meta.transferSyntax, 'Implicit VR Little Endian');
    assert.equal(r.meta.inverted, true);
    for (let i = 0; i < px.length; i++) assert.equal(r.data[i], 4095 - px[i]);     // (lo + hi) - v for 12 bits stored
    assert.equal(r.max, 4095 - 100);
    assert.deepEqual(r.window, { center: 4095 - 1000, width: 2000 });
    assert.equal(r.pixelSpacing.source, 'ImagerPixelSpacing');
    assert.equal(r.pixelSpacing.magnification, 1.25);
    close(r.pixelSpacing.mm, 0.16);
    close(r.pixelSpacing.row, 0.16);
    assert.equal(r.pixelSpacing.detectorPlane, false);
    assert.match(r.pixelSpacing.note, /magnification 1\.250/);
    assert.equal(r.meta.laterality, 'L');
    assert.equal(r.meta.description, '', 'description containing the surname is blanked');
    assert.equal(r.meta.viewPosition, '', 'view position containing the given name is blanked');
    assert.deepEqual(r.meta.patientOrientation, ['L', 'F']);
    assert.deepEqual(leaks({ ...r, data: null }, PHI_STRINGS), []);
  });

  test('SID/SOD magnification, anisotropic spacing, MONOCHROME2 + INVERSE, percentile window', async () => {
    const rows = 20, cols = 50;
    const px = new Uint16Array(rows * cols);
    for (let i = 0; i < px.length; i++) px[i] = i;                    // 0..999
    const r = await parseRadiograph(xray({
      rows, cols, pixels: px, modality: 'DX',
      extra: [['00181164', 'DS', ['0.33', '0.22']], ['00181110', 'DS', '1100'], ['00181111', 'DS', '1000'], ['20500020', 'CS', 'INVERSE']],
    }));
    close(r.pixelSpacing.magnification, 1.1);
    close(r.pixelSpacing.row, 0.3);
    close(r.pixelSpacing.col, 0.2);
    close(r.pixelSpacing.mm, 0.2);                                    // rows/cols differ by more than 1%: mm = col
    assert.equal(r.meta.inverted, true);
    assert.equal(r.data[0], 4095);
    assert.equal(r.min, 4095 - 999);
    // 0.5% .. 99.5% of a uniform ramp of 1000 values
    close(r.window.center, 4095 - 499.5, 2);
    close(r.window.width, 990, 4);
  });

  test('spacing sources: detector plane without magnification, nominal scanned, none', async () => {
    const a = await parseRadiograph(xray({ modality: 'DX', extra: [['00181164', 'DS', ['0.139', '0.139']]] }));
    assert.equal(a.pixelSpacing.mm, 0.139);
    assert.equal(a.pixelSpacing.magnification, null);
    assert.equal(a.pixelSpacing.detectorPlane, true);
    assert.match(a.pixelSpacing.note, /detector plane, not corrected/);
    assert.ok(a.warnings.some((w) => /detector plane/.test(w)));
    const b = await parseRadiograph(xray({ modality: 'DX', extra: [['00181164', 'DS', ['0.139', '0.139']], ['00280030', 'DS', ['0.125', '0.125']], ['00280a02', 'CS', 'GEOMETRY']] }));
    assert.equal(b.pixelSpacing.source, 'PixelSpacing');
    assert.equal(b.pixelSpacing.mm, 0.125);
    assert.equal(b.pixelSpacing.detectorPlane, false);
    const c = await parseRadiograph(xray({ modality: 'OT', sopClass: '1.2.840.10008.5.1.4.1.1.7', extra: [['00182010', 'DS', ['0.1', '0.1']]] }));
    assert.equal(c.pixelSpacing.source, 'NominalScannedPixelSpacing');
    assert.equal(c.meta.burnedInRisk, true);                           // secondary capture
    const d = await parseRadiograph(xray({ modality: 'RF' }));
    assert.deepEqual([d.pixelSpacing.mm, d.pixelSpacing.row, d.pixelSpacing.col, d.pixelSpacing.source], [null, null, null, null]);
    assert.ok(d.warnings.some((w) => /no pixel spacing/.test(w)));
    assert.equal(d.meta.laterality, '');
  });

  test('FOR PROCESSING: Pixel Intensity Relationship Sign decides the polarity', async () => {
    const px = ramp(8, 12);
    const mk = (sign, photometric) => parseRadiograph(xray({ modality: 'DX', pixels: px, photometric,
      extra: [['00080068', 'CS', 'FOR PROCESSING'], ['00281040', 'CS', 'LIN'], ['00281041', 'SS', sign]] }));
    assert.equal((await mk(1, 'MONOCHROME2')).data[0], 4095 - px[0]);   // low value = more attenuation -> inverted
    assert.equal((await mk(-1, 'MONOCHROME1')).data[0], px[0]);
    // FOR PRESENTATION: the sign is ignored, the display convention decides
    const p = await parseRadiograph(xray({ modality: 'DX', pixels: px, extra: [['00281041', 'SS', 1]] }));
    assert.equal(p.data[0], px[0]);
  });

  test('8-bit, signed 16-bit with pixel padding, RLE', async () => {
    const p8 = ramp(8, 12, 8);
    const a = await parseRadiograph(xray({ bits: 8, pixels: p8 }));
    assert.deepEqual([...a.data], [...p8]);
    const s = new Int16Array(96);
    for (let i = 0; i < 96; i++) s[i] = i * 10 - 300;
    s[0] = -2000; s[95] = -2000;                                         // padding
    const b = await parseRadiograph(xray({ pixels: new Uint16Array(s.buffer), bitsStored: 16, pixelRep: 1, extra: [['00280120', 'SS', -2000]] }));
    assert.equal(b.min, -290);
    assert.equal(b.data[0], -290, 'padding becomes the least attenuating value');
    assert.equal(b.data[50], 200);
    const px = ramp(8, 12);
    const hi = Uint8Array.from(px, (v) => v >> 8), lo = Uint8Array.from(px, (v) => v & 255);
    const c = await parseRadiograph(xray({ ts: TS.rle, pixels: { fragments: [rleFrame([hi, lo])] } }));
    assert.deepEqual([...c.data], [...px]);
    assert.equal(c.meta.transferSyntax, 'RLE Lossless');
  });

  test('multi-frame: first frame used, with a warning', async () => {
    const px = new Uint16Array(96 * 2);
    for (let i = 0; i < px.length; i++) px[i] = i;
    const r = await parseRadiograph(xray({ modality: 'XA', pixels: px, extra: [['00280008', 'IS', '2']] }));
    assert.equal(r.data[95], 95);
    assert.equal(r.data.length, 96);
    assert.ok(r.warnings.some((w) => /multi-frame/.test(w)));
  });
});

describe('colour secondary captures', () => {
  const sc = { modality: 'OT', sopClass: '1.2.840.10008.5.1.4.1.1.7', spp: 3, bits: 8 };
  const n = 96;
  const rgb = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0; i < n; i++) { rgb[0][i] = i * 2; rgb[1][i] = 255 - i; rgb[2][i] = (i * 7) % 256; }
  const lum = (i) => 0.299 * rgb[0][i] + 0.587 * rgb[1][i] + 0.114 * rgb[2][i];
  const check = (r) => {
    for (let i = 0; i < n; i++) close(r.data[i], lum(i), 1e-3);
    assert.equal(r.meta.burnedInRisk, true);
    assert.ok(r.warnings.some((w) => /burned-in text/.test(w)));
    assert.equal(r.meta.inverted, false);
    assert.ok(r.window.width > 0 && r.window.center > r.min && r.window.center < r.max);
  };

  test('RGB interleaved and planar -> luminance, burnedInRisk', async () => {
    const inter = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { inter[3 * i] = rgb[0][i]; inter[3 * i + 1] = rgb[1][i]; inter[3 * i + 2] = rgb[2][i]; }
    check(await parseRadiograph(xray({ ...sc, photometric: 'RGB', pixels: inter, extra: [['00280006', 'US', 0]] })));
    const planar = new Uint8Array(n * 3);
    planar.set(rgb[0], 0); planar.set(rgb[1], n); planar.set(rgb[2], 2 * n);
    check(await parseRadiograph(xray({ ...sc, photometric: 'RGB', pixels: planar, extra: [['00280006', 'US', 1]] })));
    check(await parseRadiograph(xray({ ...sc, photometric: 'RGB', ts: TS.rle, pixels: { fragments: [rleFrame(rgb)] } })));
  });

  test('16-bit RGB, YBR_FULL (Y is the luminance), PALETTE COLOR', async () => {
    const w = new Uint16Array(n * 3);
    for (let i = 0; i < n; i++) { w[3 * i] = rgb[0][i] * 100; w[3 * i + 1] = rgb[1][i] * 100; w[3 * i + 2] = rgb[2][i] * 100; }
    const a = await parseRadiograph(xray({ ...sc, bits: 16, bitsStored: 16, photometric: 'RGB', pixels: w }));
    for (let i = 0; i < n; i++) close(a.data[i], lum(i) * 100, 0.01);
    const ybr = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { ybr[3 * i] = i; ybr[3 * i + 1] = 128; ybr[3 * i + 2] = 128; }
    const b = await parseRadiograph(xray({ ...sc, photometric: 'YBR_FULL', pixels: ybr }));
    for (let i = 0; i < n; i++) assert.equal(b.data[i], i);
    // palette: 4 entries, 16-bit; index image
    const lut = (vals) => new Uint16Array(vals.map((v) => v * 257));
    const idx = Uint8Array.from({ length: n }, (_, i) => i % 4);
    const c = await parseRadiograph(xray({
      ...sc, spp: 1, photometric: 'PALETTE COLOR', pixels: idx,
      extra: [['00281101', 'US', [4, 0, 16]], ['00281102', 'US', [4, 0, 16]], ['00281103', 'US', [4, 0, 16]],
        ['00281201', 'OW', lut([0, 255, 10, 20])], ['00281202', 'OW', lut([0, 255, 100, 20])], ['00281203', 'OW', lut([0, 255, 200, 20])]],
    }));
    close(c.data[0], 0); close(c.data[1], 255, 1e-3); close(c.data[2], 0.299 * 10 + 0.587 * 100 + 0.114 * 200, 1e-3); close(c.data[3], 20, 1e-3);
    assert.equal(c.meta.burnedInRisk, true);
  });
});

describe('JPEG Baseline', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0xff, 0xd9]);       // never really decoded in these tests
  const file = () => xray({ bits: 8, rows: 2, cols: 3, ts: TS.jpegBaseline, pixels: { fragments: [jpeg] } });

  test('Node (no createImageBitmap): clear error', async () => {
    assert.equal(canDecodeJpegBaseline(), false);
    await assert.rejects(parseRadiograph(file()), /JPEG Baseline decoding needs a browser/);
  });

  test('platform decoder is used when present', async () => {
    const rgba = new Uint8ClampedArray(2 * 3 * 4);
    for (let i = 0; i < 6; i++) rgba.set([i * 40, i * 40, i * 40, 255], i * 4);
    let seen = null;
    globalThis.createImageBitmap = async (blob, opts) => { seen = { type: blob.type, size: blob.size, opts }; return { width: 3, height: 2, close() {} }; };
    globalThis.OffscreenCanvas = class { getContext() { return { drawImage() {}, getImageData: () => ({ data: rgba }) }; } };
    try {
      const r = await parseRadiograph(file());
      assert.deepEqual([...r.data], [0, 40, 80, 120, 160, 200]);
      assert.equal(seen.type, 'image/jpeg');
      assert.equal(seen.size, jpeg.length);
      assert.equal(seen.opts.colorSpaceConversion, 'none');
      assert.ok(r.warnings.some((w) => /lossy compression \(JPEG Baseline\)/.test(w)));
    } finally {
      delete globalThis.createImageBitmap;
      delete globalThis.OffscreenCanvas;
    }
  });
});
