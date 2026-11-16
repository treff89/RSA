// Projection radiographs (CR / DX / XA / RF and secondary-capture "OT" X-ray exports): classification, header-level
// summary, pixel spacing / magnification handling, and decoding of ONE frame into a Float32 image in which
// HIGHER = MORE ATTENUATING (bone and metal bright), whatever the file's photometric convention.
//
// Privacy: everything here works on the whitelisted record produced by parse.js extractHeader() (rec + rec.xr); the
// only free-text values (description, body part, view position) were screened there. Nothing identifying is read.

import { toU8 } from './sources.js';
import { parseDicomBytes, extractHeader, PALETTE_DATA_TAGS } from './parse.js';
import { decodeFrame, encapsulatedFrame, unpackBits } from './pixels.js';
import { tsInfo } from './transfer-syntax.js';
import { decodeJpegLS, decodeJ2K } from './codecs.js';

export const XR_MODALITIES = new Set(['CR', 'DX', 'DR', 'RG', 'XA', 'RF']);
const NOT_IMAGES = new Set(['ct', 'sr', 'pdf', 'pr', 'rt', 'raw', 'dicomdir']);
export const JPEG_BASELINE = '1.2.840.10008.1.2.4.50';

const isColour = (rec) => rec.spp === 3 || /^(RGB|YBR)/.test(rec.photometric);
const isPalette = (rec) => rec.spp === 1 && rec.photometric === 'PALETTE COLOR';

/** True for a header record that should go down the radiograph path rather than the CT path. */
export function isRadiographCandidate(rec) {
  if (!rec || !rec.xr || NOT_IMAGES.has(rec.kind) || rec.modality === 'CT') return false;
  if (!rec.hasPixels || !rec.rows || !rec.cols) return false;
  if (XR_MODALITIES.has(rec.modality) || rec.kind === 'xr') return true;
  // secondary captures of other modalities (MR/US screenshots...) are not X-rays; 'OT' / unlabelled exports usually are
  return rec.modality === 'OT' || (rec.kind === 'sc' && !rec.modality);
}

/** Platform JPEG decoding (browser main thread or worker). Feature-detected at call time. */
export function canDecodeJpegBaseline() {
  return typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function' && typeof Blob === 'function';
}

/** Can this record be decoded here? Returns { supported, reason, warnings }. */
export function radiographSupport(rec) {
  const ts = tsInfo(rec.ts);
  const warnings = [];
  let reason = '';
  if (rec.bitsAllocated !== 8 && rec.bitsAllocated !== 16) reason = `${rec.bitsAllocated}-bit image data is not supported`;
  else if (rec.spp !== 1 && rec.spp !== 3) reason = `${rec.spp} samples per pixel are not supported`;
  else if (isPalette(rec) && (rec.xr.segmentedPalette || !rec.xr.palette)) reason = 'palette colour image without a usable lookup table';
  else if (rec.ts === JPEG_BASELINE) {
    if (rec.bitsAllocated !== 8) reason = 'JPEG Baseline with more than 8 bits';
    else if (!canDecodeJpegBaseline()) reason = 'JPEG Baseline decoding needs a browser (createImageBitmap / OffscreenCanvas unavailable)';
    warnings.push('lossy compression (JPEG Baseline)');
  } else if (!ts.supported) reason = `unsupported compression: ${ts.name}`;
  else if (isColour(rec) && ts.codec === 'jpegll') reason = 'colour JPEG Lossless is not supported';
  else if (ts.lossy) warnings.push(`lossy compression (${ts.name})`);
  if (reason) warnings.unshift(reason);
  return { supported: !reason, reason, warnings };
}

const r6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);
const sameSpacing = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/**
 * Pixel spacing to measure with. Priority: PixelSpacing (0028,0030) > ImagerPixelSpacing (0018,1164, detector plane,
 * corrected by EstimatedRadiographicMagnificationFactor or SID/SOD when present) > NominalScannedPixelSpacing.
 * row = spacing between rows (vertical), col = spacing between columns (horizontal), both mm.
 * `detectorPlane` (extra field) is true when the value is known or likely to be uncorrected for magnification.
 */
export function pixelSpacingInfo(rec) {
  const xr = rec.xr || {};
  const ps = rec.frames && rec.frames[0] && rec.frames[0].ps;
  let row = null, col = null, source = null, magnification = null, detectorPlane = false, note;
  if (ps && ps[0] > 0 && ps[1] > 0) {
    [row, col] = ps;
    source = 'PixelSpacing';
    if (xr.calibType) note = `calibrated pixel spacing (${xr.calibType.toLowerCase()})`;
    else if (sameSpacing(ps, xr.imagerPs)) {
      detectorPlane = true;
      note = 'Pixel Spacing equals Imager Pixel Spacing: detector plane, not corrected for magnification';
    } else if (!xr.imagerPs && rec.modality === 'CR') {
      // CR images predating ImagerPixelSpacing put the plate spacing in PixelSpacing
      detectorPlane = true;
      note = 'CR Pixel Spacing without calibration: probably the detector plane, not corrected for magnification';
    } else note = 'Pixel Spacing from header (calibration method not stated)';
  } else if (xr.imagerPs) {
    [row, col] = xr.imagerPs;
    source = 'ImagerPixelSpacing';
    let how = '';
    if (xr.emf >= 1 && xr.emf <= 3) { magnification = xr.emf; how = 'estimated radiographic magnification factor'; }
    else if (xr.sid && xr.sod && xr.sid >= xr.sod && xr.sid / xr.sod <= 3) {
      magnification = xr.sid / xr.sod; how = 'source-detector / source-object distances';
    }
    if (magnification) {
      row /= magnification; col /= magnification;
      note = `detector spacing divided by magnification ${magnification.toFixed(3)} (${how}): estimated at the object plane`;
    } else {
      detectorPlane = true;
      note = 'Imager Pixel Spacing: detector plane, not corrected for magnification (true sizes are typically 5-20% smaller)';
    }
  } else if (xr.nominalPs) {
    [row, col] = xr.nominalPs;
    source = 'NominalScannedPixelSpacing';
    detectorPlane = true;
    note = 'scanned film spacing: film plane, not corrected for magnification';
  } else {
    note = 'no pixel spacing in header: calibrate against an object of known size';
  }
  let mm = null;
  if (row && col) mm = Math.abs(row - col) / Math.max(row, col) < 0.01 ? (row + col) / 2 : col;
  return { mm: r6(mm), row: r6(row), col: r6(col), source, magnification: r6(magnification), detectorPlane, note };
}

function burnedIn(rec) {
  if (isColour(rec) || isPalette(rec)) return { risk: true, warning: 'colour image (probably an exported screenshot): may contain burned-in text' };
  if (rec.burnedIn) return { risk: true, warning: 'image flagged as containing burned-in annotation' };
  if (rec.kind === 'sc' || rec.imageType.includes('SECONDARY')) return { risk: true, warning: 'secondary capture: may contain burned-in text' };
  return { risk: false, warning: '' };
}

/** Header-level summary (no pixel decoding). */
export function radiographSummary(rec) {
  const sup = radiographSupport(rec);
  const bi = burnedIn(rec);
  const pixelSpacing = pixelSpacingInfo(rec);
  const warnings = [...sup.warnings];
  if (bi.warning) warnings.push(bi.warning);
  if (!pixelSpacing.source) warnings.push('no pixel spacing in header: calibration needed');
  else if (pixelSpacing.detectorPlane) warnings.push('pixel spacing is at the detector plane: not corrected for magnification');
  if (rec.numFrames > 1) warnings.push(`multi-frame image (${rec.numFrames} frames): only the first frame is used`);
  if (rec.xr.intent === 'FOR PROCESSING') warnings.push('"for processing" (unprocessed) image: contrast may look flat');
  if (rec.xr.modalityLutSeq) warnings.push('modality LUT sequence ignored (rescale values used)');
  return {
    width: rec.cols,
    height: rec.rows,
    modality: rec.modality,
    bodyPart: safe(rec.bodyPart),
    laterality: rec.xr.laterality,
    viewPosition: rec.xr.viewPosition,
    description: rec.description,
    pixelSpacing,
    burnedInRisk: bi.risk,
    supported: sup.supported,
    warnings,
  };
}
const safe = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 _\-]/g, '').slice(0, 16);

/*
 * Polarity rule (which way is "more attenuating"):
 *  1. FOR PRESENTATION images (the default when Presentation Intent Type is absent): radiographs are meant to be
 *     displayed bone-bright, so the display convention decides. MONOCHROME1 (min = white) is inverted.
 *     Presentation LUT Shape INVERSE inverts a MONOCHROME2 image; with MONOCHROME1 it is the redundant form the DX IOD
 *     mandates (MONOCHROME1 shall have INVERSE) and does not invert a second time.
 *  2. FOR PROCESSING images have no display convention, so Pixel Intensity Relationship Sign (0028,1041) decides:
 *     +1 = lower values mean less X-ray intensity at the detector, i.e. MORE attenuation -> invert; -1 -> keep.
 *     Without a sign, rule 1 applies.
 * Inversion maps v -> (lo + hi) - v, where lo/hi is the full modality-LUT output range of the stored bit depth, so
 * values stay in the same range and the file's window centre c maps to (lo + hi) - c (width unchanged).
 */
export function shouldInvert(rec) {
  const xr = rec.xr || {};
  if (xr.intent === 'FOR PROCESSING' && (xr.pirSign === 1 || xr.pirSign === -1)) return xr.pirSign === 1;
  if (rec.photometric === 'MONOCHROME1') return true;
  return xr.lutShape === 'INVERSE';
}

// stored word -> modality value (masking, sign extension, rescale); pad[] marks Pixel Padding values
function modalityLUT(rec) {
  const size = rec.bitsAllocated === 8 ? 256 : 65536;
  const lut = new Float32Array(size);
  const pad = new Uint8Array(size);
  const bs = Math.min(rec.bitsStored || rec.bitsAllocated, rec.bitsAllocated);
  const hb = rec.highBit ?? bs - 1;
  const shift = Math.max(0, hb - bs + 1);
  const mask = 2 ** bs - 1;
  const signBit = 2 ** (bs - 1);
  const full = 2 ** bs;
  const fr = rec.frames[0] || {};
  const slope = Number.isFinite(fr.slope) && fr.slope !== 0 ? fr.slope : 1;
  const icpt = Number.isFinite(fr.intercept) ? fr.intercept : 0;
  let padLo = null, padHi = null;
  if (Number.isFinite(rec.padding)) {
    padLo = rec.padding; padHi = rec.padding;
    if (Number.isFinite(rec.paddingLimit)) { padLo = Math.min(rec.padding, rec.paddingLimit); padHi = Math.max(rec.padding, rec.paddingLimit); }
    if (rec.pixelRep !== 1 && padLo < 0) {   // unsigned data with a padding value written as SS: compare wrapped
      const a = ((padLo % full) + full) % full, b = ((padHi % full) + full) % full;
      padLo = Math.min(a, b); padHi = Math.max(a, b);
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (let w = 0; w < size; w++) {
    let v = (w >>> shift) & mask;
    if (rec.pixelRep === 1 && v >= signBit) v -= full;
    const m = v * slope + icpt;
    lut[w] = m;
    if (m < lo) lo = m;
    if (m > hi) hi = m;
    if (padLo !== null && v >= padLo && v <= padHi) pad[w] = 1;
  }
  return { lut, pad, lo, hi, anyPad: padLo !== null };
}

function unsignedView(s) {
  if (s instanceof Int16Array) return new Uint16Array(s.buffer, s.byteOffset, s.length);
  if (s instanceof Int8Array) return new Uint8Array(s.buffer, s.byteOffset, s.length);
  return s;
}

async function jpegBaselineRGBA(frame, w, h) {
  if (!canDecodeJpegBaseline()) {
    throw new Error('JPEG Baseline decoding needs a browser (createImageBitmap / OffscreenCanvas are not available here)');
  }
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([frame], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch {
    throw new Error('the JPEG Baseline image could not be decoded');
  }
  try {
    if (bmp.width !== w || bmp.height !== h) throw new Error('decoded image size does not match header');
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  } finally {
    if (bmp && typeof bmp.close === 'function') bmp.close();
  }
}

function frame0(ds) {
  const el = ds.elements.x7fe00010;
  if (!el) throw new Error('no pixel data');
  return el;
}

// RLE with several samples per pixel: segments ordered by sample, most significant byte first -> planar samples
function decodeRLEPlanar(frame, n, spp, bytesPer) {
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const nseg = dv.getUint32(0, true);
  if (nseg !== spp * bytesPer) throw new Error('unsupported RLE segment layout');
  const offs = [];
  for (let i = 0; i < nseg; i++) offs.push(dv.getUint32(4 + 4 * i, true));
  const tmp = new Uint8Array(spp * n * bytesPer);
  for (let s = 0; s < nseg; s++) {
    const c = Math.floor(s / bytesPer), k = s % bytesPer;
    const end = s + 1 < nseg ? offs[s + 1] : frame.length;
    unpackBits(frame, offs[s], end, tmp, c * n * bytesPer + (bytesPer - 1 - k), bytesPer, n);
  }
  return bytesPer === 1 ? tmp : new Uint16Array(tmp.buffer);
}

// raw sample words for an uncompressed (or encapsulated-uncompressed) colour frame
function rawColourWords(ds, rec, count) {
  const ts = tsInfo(rec.ts);
  const el = frame0(ds);
  const bytes = rec.bitsAllocated >> 3;
  let src, start;
  if (ts.codec === 'raw') { src = ds.byteArray; start = el.dataOffset; }
  else { src = encapsulatedFrame(ds, el, 0, rec.numFrames); start = 0; }
  if (start + count * bytes > src.length) throw new Error('pixel data truncated');
  if (bytes === 1) return src.subarray(start, start + count);
  const out = new Uint16Array(count);
  if (ts.bigEndian) for (let i = 0, p = start; i < count; i++, p += 2) out[i] = (src[p] << 8) | src[p + 1];
  else for (let i = 0, p = start; i < count; i++, p += 2) out[i] = src[p] | (src[p + 1] << 8);
  return out;
}

// Rec. 601 luma, consistent with the Y of YBR_FULL; screenshots are greyscale X-rays, so this keeps their values
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

async function colourLuminance(ds, rec, out) {
  const n = rec.rows * rec.cols;
  const ts = tsInfo(rec.ts);
  const ybr = /^YBR/.test(rec.photometric);
  if (rec.ts === JPEG_BASELINE) {
    // the browser converts YCbCr to RGB itself
    const rgba = await jpegBaselineRGBA(encapsulatedFrame(ds, frame0(ds), 0, rec.numFrames), rec.cols, rec.rows);
    for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = luma(rgba[p], rgba[p + 1], rgba[p + 2]);
    return;
  }
  let s, planar;
  if (ts.codec === 'raw' || ts.codec === 'raw-encap') {
    if (rec.photometric === 'YBR_FULL_422' || rec.photometric === 'YBR_PARTIAL_422') {
      // two pixels share chroma: Y0 Y1 Cb Cr
      s = rawColourWords(ds, rec, n * 2);
      for (let i = 0; i < n; i++) out[i] = s[4 * (i >> 1) + (i & 1)];
      return;
    }
    s = rawColourWords(ds, rec, n * 3);
    planar = rec.planar === 1;
  } else if (ts.codec === 'rle') {
    s = decodeRLEPlanar(encapsulatedFrame(ds, frame0(ds), 0, rec.numFrames), n, 3, rec.bitsAllocated >> 3);
    planar = true;
  } else if (ts.codec === 'j2k' || ts.codec === 'jpegls') {
    const frame = encapsulatedFrame(ds, frame0(ds), 0, rec.numFrames);
    const d = ts.codec === 'j2k' ? await decodeJ2K(frame) : await decodeJpegLS(frame);
    if (d.width !== rec.cols || d.height !== rec.rows || d.components !== 3) throw new Error('decoded image does not match header');
    // codec output is pixel-interleaved; JPEG 2000 YBR_RCT/ICT come out as RGB
    s = d.pixels; planar = false;
    if (ts.codec === 'j2k') { for (let i = 0; i < n; i++) out[i] = luma(s[3 * i], s[3 * i + 1], s[3 * i + 2]); return; }
  } else {
    throw new Error(`${ts.name} colour images are not supported`);
  }
  if (ybr) { for (let i = 0; i < n; i++) out[i] = planar ? s[i] : s[3 * i]; return; }
  if (planar) for (let i = 0; i < n; i++) out[i] = luma(s[i], s[n + i], s[2 * n + i]);
  else for (let i = 0; i < n; i++) out[i] = luma(s[3 * i], s[3 * i + 1], s[3 * i + 2]);
}

// palette index -> luminance table (entries normalised to 0..255)
function paletteLuminance(ds, rec) {
  const { r, g, b } = rec.xr.palette;
  const read = (tag, desc) => {
    const el = ds.elements[tag];
    if (!el) throw new Error('palette lookup table missing');
    const entries = desc[0] || 65536, bits = desc[2] === 8 ? 8 : 16;
    const out = new Float32Array(entries);
    const max = 2 ** bits - 1;
    if (bits === 8 && el.length === entries) {   // 8-bit entries packed one per byte
      for (let i = 0; i < entries; i++) out[i] = ds.byteArray[el.dataOffset + i] / max * 255;
    } else {
      if (el.length < entries * 2) throw new Error('palette lookup table truncated');
      for (let i = 0; i < entries; i++) out[i] = (ds.uint16(tag, i) & max) / max * 255;
    }
    return out;
  };
  const [tr, tg, tb] = [read(PALETTE_DATA_TAGS[0], r), read(PALETTE_DATA_TAGS[1], g), read(PALETTE_DATA_TAGS[2], b)];
  const first = r[1];
  return (v) => {
    const i = Math.min(Math.max(v - first, 0), tr.length - 1);
    return luma(tr[i], tg[Math.min(i, tg.length - 1)], tb[Math.min(i, tb.length - 1)]);
  };
}

// robust window from the 0.5% / 99.5% percentiles of the (non-padding) values
function percentileWindow(data, skip, min, max) {
  const BINS = 4096;
  if (!(max > min)) return { center: min, width: 1 };
  const hist = new Uint32Array(BINS);
  const k = (BINS - 1) / (max - min);
  let n = 0;
  for (let i = 0; i < data.length; i++) { if (skip && skip[i]) continue; hist[Math.round((data[i] - min) * k)]++; n++; }
  const at = (q) => {
    const target = q * n;
    let c = 0;
    for (let b = 0; b < BINS; b++) { c += hist[b]; if (c >= target) return min + b / k; }
    return max;
  };
  const lo = at(0.005), hi = at(0.995);
  return { center: (lo + hi) / 2, width: Math.max(hi - lo, (max - min) / BINS, 1e-6) };
}

/** Decode frame 0 of a fully parsed dataSet whose header record is `rec` (from extractHeader). */
export async function decodeRadiograph(ds, rec) {
  if (!rec || !rec.xr) throw new Error('not a projection radiograph');
  if (!rec.hasPixels || !rec.rows || !rec.cols) throw new Error('no image data');
  const sup = radiographSupport(rec);
  if (!sup.supported) throw new Error(`This image cannot be decoded (${sup.reason}).`);
  const summary = radiographSummary(rec);
  const width = rec.cols, height = rec.rows, n = width * height;
  const data = new Float32Array(n);
  const warnings = summary.warnings.slice();
  let skip = null, inverted = false, fileWindow = null;
  const xr = rec.xr;
  const ww = Number.isFinite(xr.windowWidth) && xr.windowWidth > 0 ? xr.windowWidth : null;
  const wc = Number.isFinite(xr.windowCenter) ? xr.windowCenter : null;
  try {
    if (isColour(rec)) {
      await colourLuminance(ds, rec, data);
      if (wc !== null && ww !== null) fileWindow = { center: wc, width: ww };
    } else {
      let samples;
      if (rec.ts === JPEG_BASELINE) {
        const rgba = await jpegBaselineRGBA(encapsulatedFrame(ds, frame0(ds), 0, rec.numFrames), width, height);
        samples = new Uint8Array(n);
        for (let i = 0; i < n; i++) samples[i] = rgba[4 * i];
      } else {
        samples = await decodeFrame(ds, rec, 0);
      }
      samples = unsignedView(samples);
      const mlut = modalityLUT(rec);
      const m = mlut.lut.length - 1;
      if (isPalette(rec)) {
        const pal = paletteLuminance(ds, rec);
        // palette indices are the masked stored values (no rescale)
        const cache = new Float32Array(m + 1).fill(NaN);
        for (let i = 0; i < n; i++) {
          const w = samples[i] & m;
          let v = cache[w];
          if (v !== v) { v = pal(Math.round((mlut.lut[w] - (rec.frames[0].intercept || 0)) / (rec.frames[0].slope || 1))); cache[w] = v; }
          data[i] = v;
        }
      } else {
        inverted = shouldInvert(rec);
        const K = mlut.lo + mlut.hi;
        const lut = mlut.lut;
        if (inverted) for (let w = 0; w <= m; w++) lut[w] = K - lut[w];
        if (mlut.anyPad) skip = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          const w = samples[i] & m;
          data[i] = lut[w];
          if (skip && mlut.pad[w]) skip[i] = 1;
        }
        if (wc !== null && ww !== null) fileWindow = { center: inverted ? K - wc : wc, width: ww };
        else if (xr.voiLutSeq) warnings.push('VOI LUT sequence ignored: window estimated from the image');
      }
    }
  } catch (e) {
    const msg = e && e.message ? e.message : 'decode error';
    throw new Error(`Could not decode the radiograph (${tsInfo(rec.ts).name}): ${msg}.`);
  }
  // range over real (non-padding) pixels; padding is set to the least attenuating value (background)
  let min = Infinity, max = -Infinity, padded = 0;
  for (let i = 0; i < n; i++) {
    if (skip && skip[i]) { padded++; continue; }
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  if (padded) for (let i = 0; i < n; i++) if (skip[i]) data[i] = min;
  const window = fileWindow || percentileWindow(data, skip, min, max);
  return {
    width,
    height,
    data,
    min,
    max,
    window: { center: window.center, width: window.width },
    pixelSpacing: summary.pixelSpacing,
    meta: {
      modality: rec.modality,
      bodyPart: summary.bodyPart,
      laterality: summary.laterality,
      viewPosition: summary.viewPosition,
      description: summary.description,
      bitsStored: rec.bitsStored,
      photometric: rec.photometric,
      transferSyntax: tsInfo(rec.ts).name,
      burnedInRisk: summary.burnedInRisk,
      inverted,
      patientOrientation: xr.patientOrientation.slice(),
      numFrames: rec.numFrames,
    },
    warnings,
  };
}

/** Standalone: parse + anonymise + decode one radiograph file (bytes). */
export async function parseRadiograph(bytes) {
  const u8 = toU8(bytes);
  let ds;
  try { ds = parseDicomBytes(u8, false); } catch { ds = null; }
  if (!ds) throw new Error('not a readable DICOM file');
  const { rec } = extractHeader(ds);
  if (!rec.xr) throw new Error('this is a CT image, not a projection radiograph');
  return decodeRadiograph(ds, rec);
}
