// Minimal JPEG Lossless (ITU T.81 process 14, SOF3, Huffman) decoder for single-component DICOM frames.
// Written because jpeg-lossless-decoder-js drops the last pixel when the entropy-coded segment ends on a marker
// (observed with gdcm-encoded data), and for speed. Supports predictors 1-7, point transform, restart intervals,
// precision 2..16. Returns Uint16Array (or Uint8Array for precision <= 8) of width*height samples.

function buildTable(counts, symbols) {
  // 16-bit lookup: entry = (length << 8) | symbol ; 0 = invalid
  const lut = new Uint16Array(65536);
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      const sym = symbols[k++];
      const shift = 16 - len;
      const start = code << shift;
      const end = start + (1 << shift);
      const v = (len << 8) | sym;
      for (let c = start; c < end && c < 65536; c++) lut[c] = v;
      code++;
    }
    code <<= 1;
  }
  return lut;
}

export function decodeJpegLossless(b) {
  let p = 0;
  const u16 = (o) => (b[o] << 8) | b[o + 1];
  if (u16(0) !== 0xffd8) throw new Error('not a JPEG stream');
  p = 2;
  const tables = [];
  let restartInterval = 0;
  let precision = 0, width = 0, height = 0, ncomp = 0;
  let sofSeen = false;
  while (p < b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; }
    p += 2;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd9) break;
    const len = u16(p);
    const seg = p + 2;
    const segEnd = p + len;
    if (marker === 0xc3 || marker === 0xc7 || marker === 0xcb || marker === 0xcf) {
      if (marker !== 0xc3) throw new Error('hierarchical/arithmetic JPEG lossless is not supported');
      precision = b[seg];
      height = u16(seg + 1);
      width = u16(seg + 3);
      ncomp = b[seg + 5];
      sofSeen = true;
    } else if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error('not a lossless JPEG (process 14) stream');
    } else if (marker === 0xc4) {
      let q = seg;
      while (q < segEnd) {
        const th = b[q] & 0x0f;
        const counts = b.subarray(q + 1, q + 17);
        let total = 0;
        for (let i = 0; i < 16; i++) total += counts[i];
        tables[th] = buildTable(counts, b.subarray(q + 17, q + 17 + total));
        q += 17 + total;
      }
    } else if (marker === 0xdd) {
      restartInterval = u16(seg);
    } else if (marker === 0xda) {
      if (!sofSeen) throw new Error('JPEG: scan before frame header');
      const ns = b[seg];
      if (ns !== 1 || ncomp !== 1) throw new Error('multi-component JPEG lossless is not supported');
      const td = b[seg + 2] >> 4;
      const q = seg + 1 + 2 * ns;
      const predictor = b[q];
      const pt = b[q + 2] & 0x0f;
      const lut = tables[td];
      if (!lut) throw new Error('JPEG: missing Huffman table');
      return decodeScan(b, segEnd, lut, width, height, precision, predictor, pt, restartInterval);
    }
    p = segEnd;
  }
  throw new Error('JPEG: no scan found');
}

function decodeScan(b, start, lut, width, height, precision, predictor, pt, restartInterval) {
  const n = width * height;
  const out = precision <= 8 ? new Uint8Array(n) : new Uint16Array(n);
  const omask = precision <= 8 ? 0xff : 0xffff;
  const initPred = 1 << (precision - pt - 1);
  // values before the point-transform shift (needed for prediction)
  const vals = pt ? new Uint16Array(n) : (out instanceof Uint16Array ? out : new Uint16Array(n));
  const len = b.length;
  let pos = start, acc = 0, nbits = 0, markerHit = false;
  let i = 0;
  const ri = restartInterval > 0 ? restartInterval : n;
  for (let r0 = 0; r0 < n; r0 += ri) {
    if (r0 > 0) {
      // restart: discard bits, skip to and over RSTn
      acc = 0; nbits = 0;
      if (!markerHit) while (pos + 1 < len && !(b[pos] === 0xff && b[pos + 1] >= 0xd0 && b[pos + 1] <= 0xd7)) pos++;
      if (pos + 1 < len && b[pos] === 0xff && b[pos + 1] >= 0xd0 && b[pos + 1] <= 0xd7) pos += 2;
      markerHit = false;
    }
    const r1 = Math.min(n, r0 + ri);
    const firstLineEnd = r0 + width;
    let x = r0 % width;
    for (i = r0; i < r1; i++) {
      // refill to > 16 bits
      while (nbits <= 16) {
        let byte = 0;
        if (!markerHit && pos < len) {
          byte = b[pos];
          if (byte === 0xff) {
            const nx = b[pos + 1];
            if (nx === 0x00) pos += 2;
            else if (nx === 0xff) { pos++; continue; }
            else { markerHit = true; byte = 0; }
          } else pos++;
        }
        acc = ((acc << 8) | byte) & 0xffffff;
        nbits += 8;
      }
      const e = lut[(acc >>> (nbits - 16)) & 0xffff];
      if (e === 0) throw new Error('JPEG: corrupt data');
      const sl = e >> 8, s = e & 0xff;
      nbits -= sl;
      let diff = 0;
      if (s === 16) diff = 32768;
      else if (s > 0) {
        while (nbits < s) {
          let byte = 0;
          if (!markerHit && pos < len) {
            byte = b[pos];
            if (byte === 0xff) {
              const nx = b[pos + 1];
              if (nx === 0x00) pos += 2;
              else if (nx === 0xff) { pos++; continue; }
              else { markerHit = true; byte = 0; }
            } else pos++;
          }
          acc = ((acc << 8) | byte) & 0xffffff;
          nbits += 8;
        }
        nbits -= s;
        const v = (acc >>> nbits) & ((1 << s) - 1);
        diff = v < (1 << (s - 1)) ? v - (1 << s) + 1 : v;
      }
      acc &= (1 << nbits) - 1;
      let pred;
      if (i === r0) pred = initPred;
      else if (i < firstLineEnd) pred = vals[i - 1];
      else if (x === 0) pred = vals[i - width];
      else {
        const ra = vals[i - 1], rb = vals[i - width], rc = vals[i - width - 1];
        switch (predictor) {
          case 1: pred = ra; break;
          case 2: pred = rb; break;
          case 3: pred = rc; break;
          case 4: pred = ra + rb - rc; break;
          case 5: pred = ra + ((rb - rc) >> 1); break;
          case 6: pred = rb + ((ra - rc) >> 1); break;
          case 7: pred = (ra + rb) >> 1; break;
          default: pred = ra;
        }
      }
      const v = (pred + diff) & 0xffff;
      vals[i] = v;
      if (vals !== out) out[i] = (v << pt) & omask;
      if (++x === width) x = 0;
    }
  }
  return out;
}
