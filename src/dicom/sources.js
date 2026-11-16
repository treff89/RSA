// Source handling: byte normalisation, zip expansion (lazy, entry-by-entry), DICOM sniffing.
// A source is { name, size, read: () => Promise<Uint8Array|ArrayBuffer> }.

import { inflateSync } from 'fflate';

export function toU8(buf) {
  if (buf instanceof Uint8Array) {
    // normalise Node Buffers / subclasses to a plain Uint8Array view (dicom-parser branches on Buffer)
    return Object.getPrototypeOf(buf) === Uint8Array.prototype ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new Error('source.read() must return an ArrayBuffer or Uint8Array');
}

export function isZip(u8) {
  return u8.length >= 22 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5) && (u8[3] === 4 || u8[3] === 6);
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;

/**
 * Parse the zip central directory. Returns [{ name, method, csize, usize, localOffset }] (files only).
 * Throws on a malformed archive.
 */
export function listZip(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65557); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  let count = u16(b, eocd + 10);
  let cdOffset = u32(b, eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;     // zip64 end of central directory locator
    if (loc >= 0 && u32(b, loc) === 0x07064b50) {
      const z64 = u64(b, loc + 8);
      if (u32(b, z64) === 0x06064b50) { count = u64(b, z64 + 32); cdOffset = u64(b, z64 + 48); }
    }
  }
  const dec = new TextDecoder();
  const out = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) throw new Error('zip: bad central directory');
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    let csize = u32(b, p + 20), usize = u32(b, p + 24);
    const nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32);
    let localOffset = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    // zip64 extra field
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = u16(b, x), sz = u16(b, x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = u64(b, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(b, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(b, q); q += 8; }
      }
      x += 4 + sz;
    }
    p = xend + clen;
    if (name.endsWith('/')) continue;
    out.push({ name, method, csize, usize, localOffset, encrypted: !!(flags & 1) });
  }
  return out;
}

export function readZipEntry(b, e) {
  const lo = e.localOffset;
  if (u32(b, lo) !== 0x04034b50) throw new Error('zip: bad local header');
  const start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
  const data = b.subarray(start, start + e.csize);
  if (e.encrypted) throw new Error('zip: encrypted entry');
  if (e.method === 0) return data;
  if (e.method === 8) return inflateSync(data, e.usize ? { out: new Uint8Array(e.usize) } : undefined);
  throw new Error('zip: unsupported compression method');
}

/** Skip obvious OS metadata files inside archives / folders (never DICOM). */
export function isJunkName(name) {
  const n = name.replace(/\\/g, '/');
  const base = n.slice(n.lastIndexOf('/') + 1);
  return n.startsWith('__MACOSX/') || n.includes('/__MACOSX/') || base.startsWith('._') || base === '.DS_Store' ||
    base === 'Thumbs.db' || base === 'desktop.ini';
}

const VRS = new Set(['AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FL', 'FD', 'IS', 'LO', 'LT', 'OB', 'OD', 'OF', 'OL',
  'OV', 'OW', 'PN', 'SH', 'SL', 'SQ', 'SS', 'ST', 'SV', 'TM', 'UC', 'UI', 'UL', 'UN', 'UR', 'US', 'UT', 'UV']);

/**
 * Sniff DICOM. Returns
 *   'part10'   - 128-byte preamble + "DICM"
 *   'meta'     - starts directly with the group 0002 meta header (no preamble)
 *   'explicit' - raw dataset, explicit VR little endian
 *   'implicit' - raw dataset, implicit VR little endian
 *   null       - not DICOM
 */
export function sniffDicom(b) {
  if (b.length >= 132 && b[128] === 0x44 && b[129] === 0x49 && b[130] === 0x43 && b[131] === 0x4d) return 'part10';
  if (b.length < 16) return null;
  const group = u16(b, 0), elem = u16(b, 2);
  const vr = String.fromCharCode(b[4], b[5]);
  if (group === 0x0002 && VRS.has(vr) && elem <= 0x0100) return 'meta';
  if (group > 0x0028 || (group & 1) || ![0x0008, 0x0010, 0x0018, 0x0020, 0x0028].includes(group)) return null;
  if (VRS.has(vr)) return 'explicit';
  const len = u32(b, 4);
  if (len !== 0xffffffff && len > b.length) return null;
  // next tag should also be plausible
  if (len !== 0xffffffff && 8 + len + 4 <= b.length) {
    const g2 = u16(b, 8 + len);
    if (g2 < group || g2 > 0x7fe0) return null;
  }
  return 'implicit';
}
