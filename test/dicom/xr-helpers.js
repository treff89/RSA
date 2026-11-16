// Synthetic projection radiographs with planted (fake) identifying data, for the radiograph / intake tests.
import { writeDicom } from './dicom-writer.js';

export const UID_ROOT = '1.3.6.1.4.1.99999';
// every identifying string planted in the synthetic files (checked case-insensitively against all outputs)
export const PHI_STRINGS = ['MUSTERMANN', 'ERIKA', 'PID-4711-XY', '19640812', '12081964', 'ELSEWHERE', 'ACC-20991',
  'HOUSE', 'GREGOR', '20250314', '101112', 'SN-778899', 'VENDORSECRET', UID_ROOT];

/** Identifying / non-whitelisted elements (all of them must be discarded). */
export function phiElements(description = 'SHOULDER AP', n = 1) {
  return [
    ['00080018', 'UI', `${UID_ROOT}.5.${n}`],
    ['00080020', 'DA', '20250314'],
    ['00080030', 'TM', '101112'],
    ['00080050', 'SH', 'ACC-20991'],
    ['00080080', 'LO', 'ST ELSEWHERE KLINIK'],
    ['00080090', 'PN', 'HOUSE^GREGOR'],
    ['00081030', 'LO', 'Schulter MUSTERMANN'],
    ['0008103e', 'LO', description],
    ['00091010', 'LO', 'VENDORSECRET'],
    ['00100010', 'PN', 'MUSTERMANN^ERIKA'],
    ['00100020', 'LO', 'PID-4711-XY'],
    ['00100030', 'DA', '19640812'],
    ['00100040', 'CS', 'F'],
    ['00181000', 'LO', 'SN-778899'],
    ['0020000d', 'UI', `${UID_ROOT}.7`],
    ['0020000e', 'UI', `${UID_ROOT}.7.${n}`],
  ];
}
export const META_DISCARDED = 2;    // (0002,0003) SOP instance UID, (0002,0012) implementation class UID

/**
 * Build a greyscale radiograph. o: { rows, cols, pixels (Uint16Array|Uint8Array), bits (allocated), bitsStored,
 * modality, photometric, description, n, seriesNumber, instanceNumber, extra: [elements], implicit, sopClass,
 * pixelRep, noPhi }.
 */
export function xray(o = {}) {
  const rows = o.rows || 8, cols = o.cols || 12, bits = o.bits || 16;
  const pixels = o.pixels || ramp(rows, cols, bits);
  const el = [
    ['00080008', 'CS', ['ORIGINAL', 'PRIMARY']],
    ['00080016', 'UI', o.sopClass || '1.2.840.10008.5.1.4.1.1.1'],
    ['00080060', 'CS', o.modality ?? 'CR'],
    ['00180015', 'CS', o.bodyPart ?? 'SHOULDER'],
    ['00200011', 'IS', String(o.seriesNumber ?? 1)],
    ['00200013', 'IS', String(o.instanceNumber ?? 1)],
    ['00280002', 'US', o.spp || 1],
    ['00280004', 'CS', o.photometric || 'MONOCHROME2'],
    ['00280010', 'US', rows],
    ['00280011', 'US', cols],
    ['00280100', 'US', bits],
    ['00280101', 'US', o.bitsStored || (bits === 16 ? 12 : 8)],
    ['00280102', 'US', (o.bitsStored || (bits === 16 ? 12 : 8)) - 1],
    ['00280103', 'US', o.pixelRep || 0],
    ...(o.extra || []),
    ...(o.noPhi ? [] : phiElements(o.description, o.n || 1)),
    ['7fe00010', bits === 16 ? 'OW' : 'OB', pixels],
  ];
  return writeDicom(el, { implicit: o.implicit, ts: o.ts, sopClass: o.sopClass, sopInstance: `${UID_ROOT}.5.${o.n || 1}` });
}

export function ramp(rows, cols, bits = 16) {
  const a = bits === 16 ? new Uint16Array(rows * cols) : new Uint8Array(rows * cols);
  for (let i = 0; i < a.length; i++) a[i] = bits === 16 ? 100 + i * 37 : (i * 5) % 256;
  return a;
}

export const src = (name, bytes) => ({ name, size: bytes.length, read: async () => bytes });

/** Case-insensitive leak check of JSON.stringify(value) against PHI strings + file-name fragments. */
export function leaks(value, strings) {
  const text = JSON.stringify(value).toLowerCase();
  return strings.filter((s) => text.includes(s.toLowerCase()));
}
