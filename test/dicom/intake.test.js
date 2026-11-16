import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { zipSync } from 'fflate';
import { Intake, StudyLoader } from '../../src/dicom/index.js';
import { dirSources, FIXTURES, manifest, expected } from './helpers.js';
import { xray, ramp, src, leaks, PHI_STRINGS, phiElements, META_DISCARDED } from './xr-helpers.js';

const M = manifest();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5]);
const FILE_NAMES = ['Mustermann_Erika', 'xr_ap_right', 'export_for_dr_house', 'outlet_view', 'screenshot_erika', 'notes_patient', 'IM0001'];

const apFile = () => xray({
  n: 1, seriesNumber: 2, instanceNumber: 1, description: 'SHOULDER AP Mustermann',
  extra: [['00280030', 'DS', ['0.15', '0.15']], ['00200062', 'CS', 'R'], ['00185101', 'CS', 'AP']],
});
const yFile = () => xray({
  n: 2, seriesNumber: 1, instanceNumber: 4, modality: 'DX', photometric: 'MONOCHROME1', implicit: true, description: 'Y VIEW',
  sopClass: '1.2.840.10008.5.1.4.1.1.1.1',
  extra: [['00181164', 'DS', ['0.2', '0.2']], ['00181114', 'DS', '1.25'], ['00200060', 'CS', 'R'], ['00185101', 'CS', 'LL']],
});

async function mixedDrop() {
  const ct = dirSources(path.join(FIXTURES, 'explicit_le'));
  const zip = zipSync({ 'Mustermann_Erika/outlet_view.dcm': yFile(), 'Mustermann_Erika/screenshot_erika.png': PNG });
  const sources = [
    src('Mustermann_Erika/xr_ap_right.dcm', apFile()),
    ...ct,
    src('export_for_dr_house.zip', zip),
    src('notes_patient.txt', new TextEncoder().encode('MUSTERMANN ERIKA 12.08.1964')),
  ];
  const intake = new Intake();
  const events = [];
  const scan = await intake.scan(sources, (e) => events.push(e));
  return { intake, scan, events };
}

describe('Intake', () => {
  test('mixed drop: CT series + two radiographs + PNG are classified', async () => {
    const { intake, scan, events } = await mixedDrop();
    assert.deepEqual(Object.keys(scan), ['ct', 'radiographs', 'rasters', 'report', 'skippedFiles']);
    // CT
    assert.equal(scan.ct.series.length, 1);
    assert.equal(scan.ct.recommendedId, 's1');
    assert.equal(scan.ct.series[0].numSlices, 10);
    assert.deepEqual(scan.ct.rejected, [], 'radiographs are not listed as rejected CT series');
    // radiographs, ordered by series / instance number (not drop order)
    assert.deepEqual(scan.radiographs.map((x) => x.id), ['x1', 'x2']);
    const [y, ap] = scan.radiographs;
    assert.deepEqual([y.modality, y.seriesNumber, y.viewPosition, y.laterality, y.description], ['DX', 1, 'LL', 'R', 'Y VIEW']);
    assert.deepEqual([ap.modality, ap.seriesNumber, ap.viewPosition, ap.laterality, ap.description], ['CR', 2, 'AP', 'R', '']);
    assert.deepEqual([ap.width, ap.height, ap.bodyPart, ap.burnedInRisk, ap.supported], [12, 8, 'SHOULDER', false, true]);
    assert.equal(y.pixelSpacing.source, 'ImagerPixelSpacing');
    assert.equal(y.pixelSpacing.magnification, 1.25);
    assert.equal(ap.pixelSpacing.mm, 0.15);
    assert.ok(Array.isArray(ap.warnings));
    // raster
    assert.deepEqual(scan.rasters, [{ id: 'r1', type: 'png' }]);
    // combined report: 10 CT + 2 radiographs; txt skipped, png not
    assert.equal(scan.report.dicomFiles, 12);
    assert.equal(scan.report.filesScanned, 14);
    assert.equal(scan.skippedFiles, 1);
    assert.equal(scan.report.descriptorsCleaned, 1);
    const by = Object.fromEntries(scan.report.identifiersFound.map((c) => [c.category, c]));
    assert.equal(by['Patient name'].files, 12);
    assert.ok(scan.report.kept.includes('View position (screened)'));
    assert.ok(events.some((e) => e.phase === 'scan' && e.done === e.total));

    // lazy loads
    const img = await intake.loadRadiograph('x1');
    const px = ramp(8, 12);
    assert.deepEqual([...img.data], [...px].map((v) => 4095 - v));
    assert.equal(img.meta.viewPosition, 'LL');
    assert.deepEqual(img.pixelSpacing, y.pixelSpacing);
    const img2 = await intake.loadRadiograph('x2');
    assert.deepEqual([...img2.data], [...px]);
    assert.deepEqual([...(await intake.readRaster('r1'))], [...PNG]);
    const vol = await intake.buildVolume(scan.ct.recommendedId);
    assert.deepEqual(vol.dims, M.cases.explicit_le.dims);
    assert.deepEqual([...vol.data], [...expected('base')]);
    await assert.rejects(intake.loadRadiograph('x9'), /no longer available/);
    await assert.rejects(intake.readRaster('x1'), /no longer available/);
  });

  test('nothing identifying (values, UIDs, file names) is returned or retained', async () => {
    const { intake, scan } = await mixedDrop();
    const strings = [...PHI_STRINGS, ...M.phiStrings, ...FILE_NAMES];
    const imgs = [];
    for (const x of scan.radiographs) { const { data, ...rest } = await intake.loadRadiograph(x.id); imgs.push(rest); }
    const { data, ...vol } = await intake.buildVolume('s1');
    const outputs = { scan, imgs, vol };
    assert.deepEqual(leaks(outputs, strings), []);
    assert.ok(!/\b\d+(\.\d+){5,}\b/.test(JSON.stringify(outputs)), 'no UIDs of any kind in outputs');
    const state = intake._debugState();
    assert.ok(state.radiographs.length === 2 && state.records.some(Boolean), 'debug state is populated');
    assert.deepEqual(leaks(state, strings), []);
    const uids = JSON.stringify(state).match(/\b\d+(\.\d+){5,}\b/g) || [];
    assert.deepEqual(uids.filter((u) => !u.startsWith('1.2.840.10008.')), [], 'only standard syntax UIDs retained');
    // own enumerable state of the objects themselves (closures aside)
    assert.deepEqual(leaks({ a: intake, b: intake._loader._files.map((f) => f && Object.keys(f)) }, strings), []);
  });

  test('anonymisation report for one radiograph: every non-whitelisted element is counted, whitelisted ones are not', async () => {
    const file = xray({
      modality: 'DX', description: 'ERIKA AP',
      extra: [['00181164', 'DS', ['0.2', '0.2']], ['00181114', 'DS', '1.1'], ['00181110', 'DS', '1100'], ['00181111', 'DS', '1000'],
        ['00182010', 'DS', ['0.2', '0.2']], ['00280030', 'DS', ['0.18', '0.18']], ['00280a02', 'CS', 'GEOMETRY'],
        ['00200060', 'CS', 'L'], ['00200062', 'CS', 'L'], ['00185101', 'CS', 'AP'], ['00200020', 'CS', ['L', 'F']],
        ['00281050', 'DS', '2000'], ['00281051', 'DS', '4000'], ['00281056', 'CS', 'LINEAR'], ['20500020', 'CS', 'IDENTITY'],
        ['00281040', 'CS', 'LOG'], ['00281041', 'SS', -1], ['00080068', 'CS', 'FOR PRESENTATION'], ['00280301', 'CS', 'NO'],
        ['00281052', 'DS', '0'], ['00281053', 'DS', '1'], ['00281054', 'LO', 'US']],
    });
    const scan = await new Intake().scan([src('Mustermann_Erika.dcm', file)]);
    assert.equal(scan.ct, null);
    assert.equal(scan.radiographs.length, 1);
    assert.equal(scan.radiographs[0].description, '');
    const r = scan.report;
    assert.equal(r.totalElementsDiscarded, phiElements().length + META_DISCARDED);
    assert.equal(r.descriptorsCleaned, 1);
    const by = Object.fromEntries(r.identifiersFound.map((c) => [c.category, c.elements]));
    assert.deepEqual(by, {
      'Patient name': 1, 'Patient ID': 1, 'Dates of birth': 1, 'Patient demographics': 1, 'Study/series dates & times': 2,
      'Institution & staff': 2, 'Accession & order numbers': 1, 'Device identifiers': 1, 'UIDs': 4,
      'Free-text descriptions': 2, 'Private vendor tags': 1,
    });
  });

  test('radiographs or rasters alone do not throw; unsupported files are listed as such', async () => {
    const jpegDicom = xray({ bits: 8, ts: '1.2.840.10008.1.2.4.50', pixels: { fragments: [new Uint8Array([0xff, 0xd8, 0xff, 0xd9])] } });
    const rgb = xray({ modality: 'OT', sopClass: '1.2.840.10008.5.1.4.1.1.7', spp: 3, bits: 8, photometric: 'RGB', pixels: new Uint8Array(96 * 3).fill(9) });
    const intake = new Intake();
    const scan = await intake.scan([src('a', jpegDicom), src('b', rgb)]);
    assert.equal(scan.ct, null);
    const [j, c] = scan.radiographs;
    assert.equal(j.supported, false);
    assert.match(j.warnings[0], /JPEG Baseline decoding needs a browser/);
    await assert.rejects(intake.loadRadiograph(j.id), /cannot be decoded.*JPEG Baseline/);
    assert.deepEqual([c.supported, c.burnedInRisk, c.modality], [true, true, 'OT']);
    assert.equal(scan.report.burnedInRisk, 1);
    const img = await intake.loadRadiograph(c.id);
    assert.ok(Math.abs(img.data[0] - 9) < 1e-4);
    await assert.rejects(intake.buildVolume('s1'), /no longer available/);

    const jpg = new Uint8Array(20); jpg.set([0xff, 0xd8, 0xff, 0xe0]);
    const tif = new Uint8Array(20); tif.set([0x49, 0x49, 0x2a, 0]);
    const webp = new Uint8Array(20); webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const bmp = new Uint8Array(60); bmp.set([0x42, 0x4d, 60, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40]);
    const only = await new Intake().scan([src('1', jpg), src('2', tif), src('3', webp), src('4', bmp)]);
    assert.deepEqual(only.rasters.map((r) => r.type), ['jpeg', 'tiff', 'webp', 'bmp']);
    assert.deepEqual([only.ct, only.radiographs.length, only.report.dicomFiles, only.skippedFiles], [null, 0, 0, 0]);
  });

  test('NOTHING_USABLE only when there is no CT series, radiograph or raster; message has no file names', async () => {
    const intake = new Intake();
    const sources = [src('Mustermann_notes.txt', new TextEncoder().encode('hello there, nothing here')), src('junk.bin', new Uint8Array(300).fill(7))];
    await assert.rejects(intake.scan(sources), (e) => {
      assert.equal(e.code, 'NOTHING_USABLE');
      assert.match(e.message, /No usable images were found in the 2 files provided/);
      assert.deepEqual(leaks({ m: e.message, r: e.result }, ['Mustermann', 'junk']), []);
      assert.equal(e.result.ct, null);
      assert.equal(e.result.skippedFiles, 2);
      return true;
    });
    // too few CT slices and nothing else: still nothing usable, reasons reported
    const few = dirSources(path.join(FIXTURES, 'explicit_le')).slice(0, 3);
    await assert.rejects(new Intake().scan(few), (e) => e.code === 'NOTHING_USABLE' && /too few slices/.test(e.message));
  });

  test('reset() forgets everything; plain StudyLoader behaviour is unchanged', async () => {
    const { intake } = await mixedDrop();
    intake.reset();
    await assert.rejects(intake.loadRadiograph('x1'), /no longer available/);
    assert.deepEqual(intake._debugState().radiographs, []);
    // CT-only loader: radiographs are still rejected as "not CT", PNG skipped, no extra keys
    const L = new StudyLoader();
    const scan = await L.scan([...dirSources(path.join(FIXTURES, 'explicit_le')), src('x', apFile()), src('p', PNG)]);
    assert.deepEqual(Object.keys(scan), ['series', 'recommendedId', 'rejected', 'skippedFiles', 'report']);
    assert.equal(scan.skippedFiles, 1);
    assert.match(scan.rejected[0].reason, /not a CT image \(modality CR\)/);
    await assert.rejects(new StudyLoader().scan([src('x', apFile())]), (e) => e.code === 'NO_CT_SERIES');
  });
});
