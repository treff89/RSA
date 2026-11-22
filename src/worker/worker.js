// Web Worker: reading, anonymising, decoding and automatic detection all happen here, on the user's own machine.
// The worker inherits the page's Content-Security-Policy (connect-src 'none'), so it cannot open a network connection.
//
// main → worker                                        worker → main
//   {type:'scan', files}                                 {type:'scanned', result}
//   {type:'xray', id}            (DICOM 'x…' / raster 'r…')   {type:'xray', id, image, det}
//   {type:'ct', seriesId}                                {type:'ct', seriesId, volume, det}
//   {type:'sample', modality, kind}                      {type:'xray'|'ct', …, sample:true}
//   {type:'detect', reqId, image}                        {type:'detected', reqId, det}
// plus {type:'progress', scope, fraction, label} and {type:'error', scope, message}
import { Intake, setWasmBinaries } from '../dicom/index.js';
import { detectXray } from '../detect/radiograph.js';
import { grayWithoutOverlay } from '../detect/overlay.js';
import * as cdet from '../detect/ct.js';
import { makePhantom } from '../sample/xray-phantom.js';
import { makeCtPhantom } from '../sample/ct-phantom.js';
import charlsWasm from '@cornerstonejs/codec-charls/decodewasm';
import openjpegWasm from '@cornerstonejs/codec-openjpeg/decodewasm';

setWasmBinaries({ charls: charlsWasm, openjpeg: openjpegWasm });

// one intake per batch of files: a later batch (e.g. the pre-operative film) is added without disturbing the first.
// Ids handed to the page carry the batch number: "<batch>:<id>".
let intakes = [new Intake()];
const split = (id) => { const k = String(id).indexOf(':'); return k < 0 ? [intakes[0], String(id)] : [intakes[Number(String(id).slice(0, k))], String(id).slice(k + 1)]; };
const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const progress = (scope, fraction, label) => post({ type: 'progress', scope, fraction, label });
// Error messages come from our own modules and never contain file names or header values.
const fail = (scope, err) => post({ type: 'error', scope, message: (err && err.message) || String(err) });

export function detectCt(volume) {
  const out = { metal: null, reverse: null, head: null, error: null };
  try {
    out.metal = cdet.detectMetal(volume);
    if (out.metal && out.metal.present) out.reverse = cdet.detectReverse(volume);
    if (!out.reverse) {
      const mode = out.metal && out.metal.present ? 'auto' : 'bone';
      out.head = cdet.detectHeadSphere(volume, { mode });
    }
  } catch (e) {
    out.error = 'Automatic detection failed on this scan; place the landmarks by hand.';
  }
  return JSON.parse(JSON.stringify(out, (k, v) => (ArrayBuffer.isView(v) ? undefined : v)));
}

async function decodeRaster(bytes) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') throw new Error('This browser cannot decode ordinary image files in the background. Use DICOM files or a current browser.');
  const bmp = await createImageBitmap(new Blob([bytes]));
  const MAX = 4096;
  const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const cv = new OffscreenCanvas(w, h);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  // coloured viewer overlay (names, dates, IDs) is blanked here, before anything else sees the picture
  const { gray: data, blanked } = grayWithoutOverlay(g.getImageData(0, 0, w, h).data, w, h);
  return {
    width: w, height: h, data, min: 0, max: 255, window: { center: 127.5, width: 255 },
    pixelSpacing: { mm: null, row: null, col: null, source: null, magnification: null, detectorPlane: false, note: '' },
    meta: { modality: 'IMG', bodyPart: '', laterality: '', viewPosition: '', description: '', burnedInRisk: true, photometric: '', transferSyntax: '' },
    warnings: [
      'Ordinary image file: no pixel size is stored, so distances need the implant size.',
      blanked > 200
        ? 'Coloured overlay text (names, dates, IDs from the viewer) was blanked from this picture as it was opened. White or grey text burned into the film cannot be recognised and would remain — check before exporting an annotated image.'
        : 'Screenshots and photos can carry the patient\'s name in the picture itself. Coloured overlay text is blanked automatically; white or grey text is not recognised and would appear in an exported annotated image.',
    ],
  };
}

/** Display window from the 1st–99th percentile of a sample of the pixels, so saturated metal does not flatten the bone. */
function softWindow(d) {
  const step = Math.max(1, Math.floor(d.length / 60000));
  const v = [];
  for (let i = 0; i < d.length; i += step) v.push(d[i]);
  v.sort((x, y) => x - y);
  const lo = v[Math.floor(v.length * 0.01)], hi = v[Math.floor(v.length * 0.99)];
  return { center: (lo + hi) / 2, width: Math.max(1e-6, (hi - lo) * 1.15) };
}

async function onScan(files, append = false) {
  const sources = files.map((f) => ({ name: f.webkitRelativePath || f.name, size: f.size, read: () => f.arrayBuffer() }));
  if (!append) { for (const i of intakes) i.reset(); intakes = []; }
  const intake = new Intake();
  intakes.push(intake);
  const b = intakes.length - 1;
  const result = await intake.scan(sources, (p) => progress('scan', p.total ? p.done / p.total : 0, p.message || 'Reading and anonymising files…'));
  for (const r of result.radiographs) r.id = `${b}:${r.id}`;
  for (const r of result.rasters) r.id = `${b}:${r.id}`;
  if (result.ct) {
    for (const sr of result.ct.series) sr.id = `${b}:${sr.id}`;
    if (result.ct.recommendedId != null) result.ct.recommendedId = `${b}:${result.ct.recommendedId}`;
  }
  post({ type: 'scanned', result, append });
}

async function onXray(id, implant) {
  progress('load', 0.2, 'Decoding image…');
  const [intake, lid] = split(id);
  const image = lid.startsWith('r') ? await decodeRaster(await intake.readRaster(lid)) : await intake.loadRadiograph(lid);
  progress('load', 0.6, 'Looking for the implant…');
  const det = detectXray(image, { implant });
  post({ type: 'xray', id, image, det }, [image.data.buffer]);
}

async function onCt(seriesId) {
  const [intake, sid] = split(seriesId);
  const volume = await intake.buildVolume(sid, (p) => progress('load', p.total ? 0.85 * (p.done / p.total) : 0, 'Loading slices…'));
  progress('load', 0.9, 'Looking for the implant and the humeral head…');
  const det = detectCt(volume);
  post({ type: 'ct', seriesId, volume, det }, [volume.data.buffer]);
}

function onSample(modality, kind) {
  progress('load', 0.3, 'Building a synthetic example…');
  if (modality === 'ct') {
    const { volume, truth } = makeCtPhantom({ kind, side: 'R', versionDeg: kind === 'native' ? -17 : -6, inclinationDeg: kind === 'reverse' ? -4 : 7, subluxationPct: kind === 'native' ? 68 : 54, fat: { supraspinatus: 0.22, infraspinatus: 0.12, subscapularis: 0.04, teresMinor: 0.08, deltoid: 0.05 } });
    volume.info = { description: 'Synthetic phantom', warnings: [] };
    const det = detectCt(volume);
    post({ type: 'ct', seriesId: `sample-${kind}`, volume, det, sample: true, truth: JSON.parse(JSON.stringify(truth, (k, v) => (ArrayBuffer.isView(v) ? undefined : v))) }, [volume.data.buffer]);
    return;
  }
  const ph = makePhantom({ kind, side: 'R', seed: 7 });
  const d = ph.image.data;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < d.length; i++) { if (d[i] < min) min = d[i]; if (d[i] > max) max = d[i]; }
  const image = {
    width: ph.image.width, height: ph.image.height, data: d, min, max, window: softWindow(d),
    pixelSpacing: { mm: ph.mmPerPx, row: ph.mmPerPx, col: ph.mmPerPx, source: 'PixelSpacing', magnification: null, detectorPlane: false, note: 'Synthetic image: the stored pixel size is exact.' },
    meta: { modality: 'DX', bodyPart: 'SHOULDER', laterality: 'R', viewPosition: 'AP', description: 'Synthetic phantom', burnedInRisk: false, photometric: 'MONOCHROME2', transferSyntax: '' },
    warnings: [],
  };
  const det = detectXray(image, { implant: { reverse: 'reverse', hemi: 'pyc', native: 'native' }[kind] });
  post({ type: 'xray', id: `sample-${kind}`, image, det, sample: true, truth: JSON.parse(JSON.stringify(ph.truth, (k, v) => (ArrayBuffer.isView(v) ? undefined : v))) }, [image.data.buffer]);
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof WorkerGlobalScope !== 'undefined') {
  self.onmessage = async (e) => {
    const m = e.data;
    try {
      if (m.type === 'scan') await onScan(m.files, !!m.append);
      else if (m.type === 'xray') await onXray(m.id, m.implant);
      else if (m.type === 'ct') await onCt(m.seriesId);
      else if (m.type === 'sample') onSample(m.modality, m.kind);
      else if (m.type === 'detect') post({ type: 'detected', reqId: m.reqId, det: detectXray(m.image, { lateralSign: m.lateralSign, implant: m.implant }) });
      else if (m.type === 'reset') { for (const i of intakes) i.reset(); intakes = [new Intake()]; }
    } catch (err) {
      if (m.type === 'scan' && err && err.code === 'NOTHING_USABLE') post({ type: 'error', scope: 'scan', message: err.message, result: err.result || null });
      else fail(m.type === 'scan' ? 'scan' : 'load', err);
    }
  };
}
