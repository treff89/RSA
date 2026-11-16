// Pixel data extraction & decoding -> stored sample words -> Hounsfield units (Int16).

import dicomParser from 'dicom-parser';
import { decodeJpegLossless } from './jpegll.js';
import { tsInfo } from './transfer-syntax.js';
import { decodeJpegLS, decodeJ2K } from './codecs.js';

// ------------------------------ encapsulated frames ------------------------------

function isFrameStart(b, off) {
  // JPEG SOI, J2K codestream SOC, JP2 signature box
  return (b[off] === 0xff && (b[off + 1] === 0xd8 || b[off + 1] === 0x4f)) ||
    (b[off + 4] === 0x6a && b[off + 5] === 0x50 && b[off + 6] === 0x20 && b[off + 7] === 0x20);
}

/** Return the compressed bytes of frame `f` (Uint8Array). */
export function encapsulatedFrame(ds, el, f, numFrames) {
  const frags = el.fragments || [];
  if (!frags.length) throw new Error('compressed pixel data has no fragments');
  if (numFrames === 1) {
    if (frags.length === 1) return ds.byteArray.subarray(frags[0].position, frags[0].position + frags[0].length);
    return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, 0, frags.length);
  }
  if (el.basicOffsetTable && el.basicOffsetTable.length === numFrames) {
    return dicomParser.readEncapsulatedImageFrame(ds, el, f);
  }
  if (frags.length === numFrames) {
    const fr = frags[f];
    return ds.byteArray.subarray(fr.position, fr.position + fr.length);
  }
  // no (usable) offset table: frames start at fragments that begin with a codestream marker
  const starts = [];
  for (let i = 0; i < frags.length; i++) if (isFrameStart(ds.byteArray, frags[i].position)) starts.push(i);
  if (starts.length !== numFrames) throw new Error('cannot locate frames in compressed pixel data');
  const s = starts[f];
  const e = f + 1 < starts.length ? starts[f + 1] : frags.length;
  return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, s, e - s);
}

// ------------------------------ RLE (PackBits) ------------------------------

export function unpackBits(src, start, end, out, outStart, outStep, count) {
  let p = start;
  let o = outStart;
  let written = 0;
  while (p < end && written < count) {
    let n = src[p++];
    if (n < 128) {
      n += 1;
      for (let i = 0; i < n && written < count; i++) { out[o] = src[p++]; o += outStep; written++; }
    } else if (n > 128) {
      n = 257 - n;
      const v = src[p++];
      for (let i = 0; i < n && written < count; i++) { out[o] = v; o += outStep; written++; }
    }
    // n === 128: no-op
  }
  return written;
}

/** RLE Lossless frame -> Uint8Array (8-bit) or Uint16Array (16-bit) of samples (single component). */
export function decodeRLE(frame, rows, cols, bitsAllocated) {
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const nseg = dv.getUint32(0, true);
  const bytesPer = bitsAllocated >> 3;
  if (nseg !== bytesPer) throw new Error('unsupported RLE segment layout');
  const offs = [];
  for (let i = 0; i < nseg; i++) offs.push(dv.getUint32(4 + 4 * i, true));
  const n = rows * cols;
  const tmp = new Uint8Array(n * bytesPer);
  for (let s = 0; s < nseg; s++) {
    const start = offs[s];
    const end = s + 1 < nseg ? offs[s + 1] : frame.length;
    // segment 0 is the most significant byte; write into little-endian words
    const byteIdx = bytesPer - 1 - s;
    unpackBits(frame, start, end, tmp, byteIdx, bytesPer, n);
  }
  if (bytesPer === 1) return tmp;
  if (bytesPer === 2) return new Uint16Array(tmp.buffer);
  throw new Error('unsupported RLE bit depth');
}

// ------------------------------ frame decode ------------------------------

/**
 * Decode frame f of a fully parsed dataSet into an array of raw stored sample words (length rows*cols),
 * typed Uint8Array / Int8Array / Uint16Array / Int16Array. Values are interpreted later with bitsStored masking.
 */
export async function decodeFrame(ds, rec, f) {
  const el = ds.elements.x7fe00010;
  if (!el) throw new Error('no pixel data');
  const ts = tsInfo(rec.ts);
  const { rows, cols, bitsAllocated } = rec;
  const n = rows * cols;
  const bytes = bitsAllocated >> 3;
  if (rec.spp !== 1) throw new Error('colour images are not supported');
  if (bitsAllocated !== 8 && bitsAllocated !== 16) throw new Error(`${bitsAllocated}-bit images are not supported`);
  const b = ds.byteArray;

  if (ts.codec === 'raw') {
    if (el.encapsulatedPixelData || el.hadUndefinedLength) throw new Error('unexpected compressed data in uncompressed file');
    const start = el.dataOffset + f * n * bytes;
    if (start + n * bytes > b.length) throw new Error('pixel data truncated');
    if (bytes === 1) return b.subarray(start, start + n);
    if (ts.bigEndian) {
      const out = new Uint16Array(n);
      for (let i = 0, p = start; i < n; i++, p += 2) out[i] = (b[p] << 8) | b[p + 1];
      return out;
    }
    if (((b.byteOffset + start) & 1) === 0) return new Uint16Array(b.buffer, b.byteOffset + start, n);
    return new Uint16Array(b.slice(start, start + 2 * n).buffer);
  }

  const frame = encapsulatedFrame(ds, el, f, rec.numFrames);
  switch (ts.codec) {
    case 'raw-encap': {
      if (bytes === 1) return frame.subarray(0, n);
      return new Uint16Array(frame.slice(0, 2 * n).buffer);
    }
    case 'rle':
      return decodeRLE(frame, rows, cols, bitsAllocated);
    case 'jpegll': {
      const out = decodeJpegLossless(frame);
      if (out.length !== n) throw new Error('JPEG Lossless frame size mismatch');
      return out;
    }
    case 'jpegls':
      return checkSize(await decodeJpegLS(frame), rows, cols);
    case 'j2k':
      return checkSize(await decodeJ2K(frame), rows, cols);
    default:
      throw new Error(`${ts.name} compression is not supported`);
  }
}

function checkSize({ pixels, width, height }, rows, cols) {
  if (width !== cols || height !== rows) throw new Error('decoded image size does not match header');
  return pixels;
}

// ------------------------------ HU conversion ------------------------------

/**
 * Build a lookup table raw word -> HU (Int16) for 8- or 16-bit samples.
 * Applies HighBit/BitsStored masking, sign extension, padding (value or range) -> -1024, rescale, rounding, clamp.
 */
export function buildLUT(p) {
  const size = p.bitsAllocated === 8 ? 256 : 65536;
  const lut = new Int16Array(size);
  const bs = Math.min(p.bitsStored || p.bitsAllocated, p.bitsAllocated);
  const hb = p.highBit ?? bs - 1;
  const shift = Math.max(0, hb - bs + 1);
  const mask = bs >= 32 ? 0xffffffff : (2 ** bs) - 1;
  const signBit = 2 ** (bs - 1);
  const full = 2 ** bs;
  let padLo = null, padHi = null;
  if (Number.isFinite(p.padding)) {
    padLo = p.padding; padHi = p.padding;
    if (Number.isFinite(p.paddingLimit)) { padLo = Math.min(p.padding, p.paddingLimit); padHi = Math.max(p.padding, p.paddingLimit); }
  }
  const slope = Number.isFinite(p.slope) && p.slope !== 0 ? p.slope : 1;
  const icpt = Number.isFinite(p.intercept) ? p.intercept : 0;
  for (let w = 0; w < size; w++) {
    let v = (w >>> shift) & mask;
    if (p.pixelRep === 1 && v >= signBit) v -= full;
    let hu;
    if (padLo !== null && v >= padLo && v <= padHi) hu = -1024;
    else {
      // padding values are given in the stored representation; for unsigned data a negative padding value
      // (written as SS) must be compared modulo 2^bs as well
      hu = Math.round(v * slope + icpt);
      if (hu < -1024) hu = -1024;
      else if (hu > 32767) hu = 32767;
    }
    lut[w] = hu;
  }
  if (padLo !== null && p.pixelRep !== 1 && padLo < 0) {
    // unsigned data with a negative padding value written as SS: compare as wrapped unsigned
    const pv = ((padLo % full) + full) % full;
    const ph = ((padHi % full) + full) % full;
    for (let w = 0; w < size; w++) { const v = (w >>> shift) & mask; if (v >= Math.min(pv, ph) && v <= Math.max(pv, ph)) lut[w] = -1024; }
  }
  return lut;
}

/** Write raw sample words through the LUT into out[outOffset ...]. */
export function applyLUT(samples, lut, out, outOffset, n) {
  if (samples instanceof Int16Array) samples = new Uint16Array(samples.buffer, samples.byteOffset, samples.length);
  else if (samples instanceof Int8Array) samples = new Uint8Array(samples.buffer, samples.byteOffset, samples.length);
  else if (!(samples instanceof Uint16Array) && !(samples instanceof Uint8Array)) {
    // generic (e.g. Int32Array from a codec): wrap into 16 bits
    for (let i = 0; i < n; i++) out[outOffset + i] = lut[samples[i] & (lut.length - 1)];
    return;
  }
  const m = lut.length - 1;
  for (let i = 0; i < n; i++) out[outOffset + i] = lut[samples[i] & m];
}
