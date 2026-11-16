// Minimal DICOM writer for tests: Part 10 file with an explicit-VR-LE meta header and a dataset in explicit or
// implicit VR little endian. Elements are [tag 'ggggeeee', vr, value]; value is a string (multi-valued: array joined
// with '\'), number(s) for binary VRs, a typed array for OB/OW/UN, an array of items (each an element list) for SQ,
// or { fragments: [Uint8Array] } for encapsulated pixel data.

const LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'SQ', 'UT', 'UN', 'UC', 'UR']);
const BIN = { US: [2, 'setUint16'], SS: [2, 'setInt16'], UL: [4, 'setUint32'], SL: [4, 'setInt32'], FL: [4, 'setFloat32'], FD: [8, 'setFloat64'] };

function concat(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u16 = (v) => new Uint8Array([v & 255, v >> 8]);
const u32 = (v) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24]);
const tagBytes = (tag) => concat([u16(parseInt(tag.slice(0, 4), 16)), u16(parseInt(tag.slice(4), 16))]);

function valueBytes(vr, value, implicit) {
  if (vr === 'SQ') {
    return concat(value.map((item) => {
      const body = dataset(item, implicit);
      return concat([tagBytes('fffee000'), u32(body.length), body]);
    }));
  }
  if (BIN[vr]) {
    const [size, fn] = BIN[vr];
    const arr = Array.isArray(value) ? value : [value];
    const out = new Uint8Array(arr.length * size);
    const dv = new DataView(out.buffer);
    arr.forEach((v, i) => dv[fn](i * size, v, true));
    return out;
  }
  if (ArrayBuffer.isView(value)) {
    const b = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return b.length & 1 ? concat([b, new Uint8Array(1)]) : b;
  }
  const s = Array.isArray(value) ? value.join('\\') : String(value);
  const b = Buffer.from(s, 'latin1');
  return b.length & 1 ? concat([b, new Uint8Array([vr === 'UI' ? 0 : 0x20])]) : new Uint8Array(b);
}

function element([tag, vr, value], implicit) {
  if (value && value.fragments) {   // encapsulated pixel data: empty offset table + one item per fragment
    const items = [concat([tagBytes('fffee000'), u32(0)])];
    for (const f of value.fragments) {
      const b = f.length & 1 ? concat([f, new Uint8Array(1)]) : f;
      items.push(concat([tagBytes('fffee000'), u32(b.length), b]));
    }
    items.push(concat([tagBytes('fffee0dd'), u32(0)]));
    return concat([tagBytes(tag), Buffer.from('OB'), u16(0), u32(0xffffffff), ...items]);
  }
  const v = valueBytes(vr, value, implicit);
  if (implicit) return concat([tagBytes(tag), u32(v.length), v]);
  if (LONG_VR.has(vr)) return concat([tagBytes(tag), Buffer.from(vr), u16(0), u32(v.length), v]);
  return concat([tagBytes(tag), Buffer.from(vr), u16(v.length), v]);
}

function dataset(elements, implicit) {
  const sorted = [...elements].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return concat(sorted.map((e) => element(e, implicit)));
}

export const TS = { implicit: '1.2.840.10008.1.2', explicit: '1.2.840.10008.1.2.1', rle: '1.2.840.10008.1.2.5', jpegBaseline: '1.2.840.10008.1.2.4.50' };

/** Build a Part 10 file. opts: { implicit, ts, sopClass, sopInstance }. */
export function writeDicom(elements, opts = {}) {
  const implicit = !!opts.implicit;
  const ts = opts.ts || (implicit ? TS.implicit : TS.explicit);
  const meta = dataset([
    ['00020001', 'OB', new Uint8Array([0, 1])],
    ['00020002', 'UI', opts.sopClass || '1.2.840.10008.5.1.4.1.1.1'],
    ['00020003', 'UI', opts.sopInstance || '1.3.6.1.4.1.99999.1.2.3'],
    ['00020010', 'UI', ts],
    ['00020012', 'UI', '1.3.6.1.4.1.99999.0.1'],
  ], false);
  const groupLength = element(['00020000', 'UL', meta.length], false);
  const preamble = new Uint8Array(132);
  preamble.set([0x44, 0x49, 0x43, 0x4d], 128);
  return concat([preamble, groupLength, meta, dataset(elements, implicit)]);
}

/** PackBits with literal runs only (valid RLE segment data). */
export function packBitsLiteral(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 128) {
    const chunk = bytes.subarray(i, Math.min(i + 128, bytes.length));
    parts.push(new Uint8Array([chunk.length - 1]), chunk);
  }
  const out = concat(parts);
  return out.length & 1 ? concat([out, new Uint8Array([0x80])]) : out;
}

/** DICOM RLE frame from byte-plane segments (most significant first). */
export function rleFrame(segments) {
  const packed = segments.map(packBitsLiteral);
  const header = new Uint8Array(64);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, packed.length, true);
  let off = 64;
  packed.forEach((p, i) => { dv.setUint32(4 + 4 * i, off, true); off += p.length; });
  return concat([header, ...packed]);
}
