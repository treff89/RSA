// DICOM parsing (dicom-parser) and WHITELIST extraction of technical attributes.
//
// extractHeader() returns a fresh plain object containing only technical, non-identifying attributes. Identifying
// values are read only transiently (to screen descriptors) and never leave this function. UIDs needed for grouping
// are returned separately in `transient` so the caller can use them as map keys and then drop them.

import dicomParser from 'dicom-parser';
import { inflateSync } from 'fflate';
import { sniffDicom } from './sources.js';
import { IMPLICIT_LE, EXPLICIT_LE, tsInfo } from './transfer-syntax.js';
import { countIdentifiers, identifyingTokens, screenDescriptor, toPrintableAscii } from './anon.js';

const PIXEL_DATA = 'x7fe00010';

function inflater(byteArray, position) {
  const inflated = inflateSync(byteArray.subarray(position));
  const full = new Uint8Array(position + inflated.length);
  full.set(byteArray.subarray(0, position), 0);
  full.set(inflated, position);
  return full;
}

/**
 * Parse a DICOM byte array. Returns dicom-parser DataSet or null if the bytes are not DICOM.
 * Throws if it looks like DICOM but cannot be parsed.
 */
export function parseDicomBytes(u8, headerOnly) {
  const kind = sniffDicom(u8);
  if (!kind) return null;
  let bytes = u8;
  const opts = { inflater };
  if (headerOnly) opts.untilTag = PIXEL_DATA;
  if (kind === 'meta') {
    bytes = new Uint8Array(132 + u8.length);
    bytes.set(u8, 132);
    bytes.set([0x44, 0x49, 0x43, 0x4d], 128);
  } else if (kind === 'implicit') {
    opts.TransferSyntaxUID = IMPLICIT_LE;
  } else if (kind === 'explicit') {
    opts.TransferSyntaxUID = EXPLICIT_LE;
  }
  const attempt = (o) => {
    try {
      return dicomParser.parseDicom(bytes, o);
    } catch (e) {
      // dicom-parser throws { exception, dataSet } — accept a partial parse when pixel data was reached
      const ds = e && e.dataSet;
      if (ds && ds.elements && ds.elements[PIXEL_DATA] && ds.elements.x00280010) return ds;
      throw new Error('unreadable DICOM');
    }
  };
  try {
    return attempt(opts);
  } catch (err) {
    if (kind === 'implicit') return attempt({ ...opts, TransferSyntaxUID: EXPLICIT_LE });
    if (kind === 'explicit') return attempt({ ...opts, TransferSyntaxUID: IMPLICIT_LE });
    throw err;
  }
}

// ---------- value readers (never throw) ----------
const has = (ds, tag) => !!(ds && ds.elements[tag]);
function str(ds, tag) {
  if (!has(ds, tag)) return undefined;
  try {
    const el = ds.elements[tag];
    if (el.length === 0) return '';
    const v = ds.string(tag);
    return v === undefined ? undefined : v;
  } catch { return undefined; }
}
function strAll(ds, tag) {       // full multi-valued string (dataSet.string returns only... the whole string)
  if (!has(ds, tag)) return undefined;
  try {
    const el = ds.elements[tag];
    if (!el.length) return '';
    return dicomParser.readFixedString(ds.byteArray, el.dataOffset, el.length).replace(/[\0 ]+$/, '').trim();
  } catch { return undefined; }
}
function nums(ds, tag) {
  const s = strAll(ds, tag);
  if (!s) return undefined;
  const a = s.split('\\').map((x) => Number(x.trim()));
  return a.length && a.every(Number.isFinite) ? a : undefined;
}
function num(ds, tag) {
  const a = nums(ds, tag);
  return a ? a[0] : undefined;
}
function us(ds, tag) {
  if (!has(ds, tag) || ds.elements[tag].length < 2) return undefined;
  try { return ds.uint16(tag); } catch { return undefined; }
}
function ss(ds, tag) {
  if (!has(ds, tag) || ds.elements[tag].length < 2) return undefined;
  try { return ds.int16(tag); } catch { return undefined; }
}
function item0(ds, tag) {
  const el = ds && ds.elements[tag];
  return el && el.items && el.items[0] ? el.items[0].dataSet : undefined;
}

// --- tags ---
const TAG = {
  transferSyntax: 'x00020010', sopClass: 'x00080016', mediaSopClass: 'x00020002', imageType: 'x00080008',
  modality: 'x00080060', seriesDescription: 'x0008103e', bodyPart: 'x00180015', sliceThickness: 'x00180050',
  kvp: 'x00180060', spacingBetween: 'x00180088', gantryTilt: 'x00181120', kernel: 'x00181210',
  patientPosition: 'x00185100', seriesNumber: 'x00200011', acquisitionNumber: 'x00200012', instanceNumber: 'x00200013',
  ipp: 'x00200032', iop: 'x00200037', sliceLocation: 'x00201041', spp: 'x00280002', photometric: 'x00280004',
  planar: 'x00280006', numFrames: 'x00280008', rows: 'x00280010', cols: 'x00280011', pixelSpacing: 'x00280030',
  bitsAllocated: 'x00280100', bitsStored: 'x00280101', highBit: 'x00280102', pixelRep: 'x00280103',
  padding: 'x00280120', paddingLimit: 'x00280121', intercept: 'x00281052', slope: 'x00281053',
  burnedIn: 'x00280301', shared: 'x52009229', perFrame: 'x52009230',
  // functional group sequences
  pixelMeasures: 'x00289110', planePosition: 'x00209113', planeOrientation: 'x00209116',
  pixelValueTx: 'x00289145', frameContent: 'x00209111', ctRecon: 'x00189314', ctXray: 'x00189325',
  inStackPos: 'x00209057',
  // identifying values read transiently for descriptor screening (never stored)
  patientName: 'x00100010', patientId: 'x00100020', accession: 'x00080050', otherIds: 'x00101000',
  birthDate: 'x00100030', studyUID: 'x0020000d', seriesUID: 'x0020000e',
};

// projection radiograph attributes (read only for non-CT images; see radiograph.js)
const XR = {
  imagerPs: 'x00181164', nominalPs: 'x00182010', emf: 'x00181114', sid: 'x00181110', sod: 'x00181111',
  calibType: 'x00280a02', imageLaterality: 'x00200062', laterality: 'x00200060', viewPosition: 'x00185101',
  windowCenter: 'x00281050', windowWidth: 'x00281051', voiFunction: 'x00281056', lutShape: 'x20500020',
  pir: 'x00281040', pirSign: 'x00281041', intent: 'x00080068', patientOrientation: 'x00200020',
  // palette colour LUT descriptors + data (needed to decode PALETTE COLOR secondary captures)
  palDescR: 'x00281101', palDescG: 'x00281102', palDescB: 'x00281103',
  palR: 'x00281201', palG: 'x00281202', palB: 'x00281203',
  // presence checks only (values never read)
  segPalR: 'x00281221', modalityLutSeq: 'x00283000', voiLutSeq: 'x00283010',
};
const XR_SKIP = new Set([XR.segPalR, XR.modalityLutSeq, XR.voiLutSeq]);

const KEPT_TAGS = new Set([
  TAG.transferSyntax, TAG.sopClass, TAG.mediaSopClass, TAG.imageType, TAG.modality, TAG.bodyPart, TAG.sliceThickness,
  TAG.kvp, TAG.spacingBetween, TAG.gantryTilt, TAG.kernel, TAG.patientPosition, TAG.seriesNumber,
  TAG.acquisitionNumber, TAG.instanceNumber, TAG.ipp, TAG.iop, TAG.sliceLocation, TAG.spp, TAG.photometric,
  TAG.planar, TAG.numFrames, TAG.rows, TAG.cols, TAG.pixelSpacing, TAG.bitsAllocated, TAG.bitsStored, TAG.highBit,
  TAG.pixelRep, TAG.padding, TAG.paddingLimit, TAG.intercept, TAG.slope, TAG.burnedIn, TAG.inStackPos,
  'x00020000', 'x00020001', 'x00281054', // group length, meta version, rescale type (technical)
]);
// for radiographs the extra technical tags we read count as kept, so the anonymisation report stays exact
const KEPT_TAGS_XR = new Set([...KEPT_TAGS, ...Object.values(XR).filter((t) => !XR_SKIP.has(t))]);
const KEPT_SEQS = new Set([TAG.shared, TAG.perFrame, TAG.pixelMeasures, TAG.planePosition, TAG.planeOrientation,
  TAG.pixelValueTx, TAG.ctRecon, TAG.ctXray]);

export function sopKind(uid) {
  if (!uid) return 'unknown';
  if (uid === '1.2.840.10008.5.1.4.1.1.2' || uid === '1.2.840.10008.5.1.4.1.1.2.1' || uid === '1.2.840.10008.5.1.4.1.1.2.2') return 'ct';
  if (uid.startsWith('1.2.840.10008.5.1.4.1.1.7')) return 'sc';
  // CR, DX (presentation/processing, mammo, intra-oral), XA, RF projection images
  if (uid === '1.2.840.10008.5.1.4.1.1.1' || uid.startsWith('1.2.840.10008.5.1.4.1.1.1.') ||
    uid === '1.2.840.10008.5.1.4.1.1.12.1' || uid === '1.2.840.10008.5.1.4.1.1.12.2' ||
    uid === '1.2.840.10008.5.1.4.1.1.12.1.1' || uid === '1.2.840.10008.5.1.4.1.1.12.2.1') return 'xr';
  if (uid.startsWith('1.2.840.10008.5.1.4.1.1.88.')) return 'sr';
  if (uid.startsWith('1.2.840.10008.5.1.4.1.1.104.')) return 'pdf';
  if (uid.startsWith('1.2.840.10008.5.1.4.1.1.11.')) return 'pr';
  if (uid === '1.2.840.10008.1.3.10') return 'dicomdir';
  if (uid.startsWith('1.2.840.10008.5.1.4.1.1.66')) return 'raw';
  if (uid.startsWith('1.2.840.10008.5.1.4.1.1.481.')) return 'rt';
  return 'other';
}

const safeCode = (s, max = 16) => toPrintableAscii(s || '').toUpperCase().replace(/[^A-Z0-9 _\-]/g, '').slice(0, max);
const round = (v, p = 1e-6) => (v === undefined ? undefined : Math.round(v / p) * p);

function frameGeometry(shared, pf, field) {
  const fromSeq = (seqTag, tag, reader) => {
    const a = pf && item0(pf, seqTag);
    if (a && has(a, tag)) return reader(a, tag);
    const b = shared && item0(shared, seqTag);
    if (b && has(b, tag)) return reader(b, tag);
    return undefined;
  };
  return fromSeq(field[0], field[1], field[2]);
}

/**
 * Extract the whitelisted technical header + anonymisation statistics from a parsed dataSet.
 * Returns { rec, transient: { groupUID }, anon: { cats: Map, discarded }, descFlagged }.
 */
export function extractHeader(ds) {
  const sopUid = (str(ds, TAG.sopClass) || str(ds, TAG.mediaSopClass) || '').replace(/\0/g, '').trim();
  const kind = sopKind(sopUid);
  const modality = safeCode(str(ds, TAG.modality), 8);
  // anything that is not a CT image may be a projection radiograph: read (and whitelist) the XR attributes
  const wantXr = kind !== 'ct' && modality !== 'CT';
  const anon = countIdentifiers(ds, wantXr ? KEPT_TAGS_XR : KEPT_TAGS, KEPT_SEQS);

  const ts = str(ds, TAG.transferSyntax)?.replace(/\0/g, '').trim() || IMPLICIT_LE;
  const rec = {
    ts,
    tsName: tsInfo(ts).name,
    kind,
    modality,
    imageType: (strAll(ds, TAG.imageType) || '').toUpperCase().split('\\').map((s) => safeCode(s, 16)).filter(Boolean),
    rows: us(ds, TAG.rows),
    cols: us(ds, TAG.cols),
    bitsAllocated: us(ds, TAG.bitsAllocated),
    bitsStored: us(ds, TAG.bitsStored),
    highBit: us(ds, TAG.highBit),
    pixelRep: us(ds, TAG.pixelRep) || 0,
    spp: us(ds, TAG.spp) ?? 1,
    photometric: safeCode(str(ds, TAG.photometric), 16) || 'MONOCHROME2',
    planar: us(ds, TAG.planar) || 0,
    numFrames: Math.max(1, Math.round(num(ds, TAG.numFrames) || 1)),
    burnedIn: safeCode(str(ds, TAG.burnedIn), 3) === 'YES',
    spacingBetween: num(ds, TAG.spacingBetween),
    gantryTilt: num(ds, TAG.gantryTilt),
    kvp: num(ds, TAG.kvp),
    seriesNumber: num(ds, TAG.seriesNumber),
    instanceNumber: num(ds, TAG.instanceNumber),
    acquisitionNumber: num(ds, TAG.acquisitionNumber),
    patientPosition: safeCode(str(ds, TAG.patientPosition), 4),
    padding: undefined,
    paddingLimit: undefined,
    kernel: '',
    bodyPart: '',
    description: '',
    hasPixels: has(ds, 'x7fe00010'),
    pixel: null,
    frames: [],
  };
  if (rec.bitsStored === undefined) rec.bitsStored = rec.bitsAllocated;
  if (rec.highBit === undefined && rec.bitsStored) rec.highBit = rec.bitsStored - 1;
  if (has(ds, TAG.padding)) rec.padding = rec.pixelRep ? ss(ds, TAG.padding) : us(ds, TAG.padding);
  if (has(ds, TAG.paddingLimit)) rec.paddingLimit = rec.pixelRep ? ss(ds, TAG.paddingLimit) : us(ds, TAG.paddingLimit);

  // ---- descriptor screening: identifying values are read here and go out of scope at return ----
  let descFlagged = false;
  {
    const tokens = identifyingTokens({
      patientName: str(ds, TAG.patientName), patientId: str(ds, TAG.patientId), accession: str(ds, TAG.accession),
      otherIds: strAll(ds, TAG.otherIds), birthDate: str(ds, TAG.birthDate),
    });
    const d = screenDescriptor(str(ds, TAG.seriesDescription), tokens, 48);
    rec.description = d.value;
    descFlagged = d.flagged;
    const shared = item0(ds, TAG.shared);
    const recon = item0(ds, TAG.ctRecon) || (shared && item0(shared, TAG.ctRecon));
    const k = screenDescriptor((strAll(ds, TAG.kernel) || (recon && strAll(recon, TAG.kernel)) || '').replace(/\\/g, ' '), tokens, 24);
    rec.kernel = k.value;
    const b = screenDescriptor(str(ds, TAG.bodyPart), tokens, 16);
    rec.bodyPart = b.value.toUpperCase();
    if (rec.kvp === undefined) {
      const xr = item0(ds, TAG.ctXray) || (shared && item0(shared, TAG.ctXray));
      if (xr) rec.kvp = num(xr, TAG.kvp);
    }
    if (wantXr) {
      const v = screenDescriptor(str(ds, XR.viewPosition), tokens, 16);
      rec.xr = extractXr(ds);
      rec.xr.viewPosition = safeCode(v.value, 16);
      rec.xr.flagged = v.flagged || b.flagged;
    }
  }

  // ---- per-frame geometry ----
  const shared = item0(ds, TAG.shared);
  const perFrameEl = ds.elements[TAG.perFrame];
  const topIpp = nums(ds, TAG.ipp);
  const topIop = nums(ds, TAG.iop);
  const topPs = nums(ds, TAG.pixelSpacing);
  const topTh = num(ds, TAG.sliceThickness);
  const topSlope = num(ds, TAG.slope);
  const topIcpt = num(ds, TAG.intercept);
  const sliceLoc = num(ds, TAG.sliceLocation);
  for (let f = 0; f < rec.numFrames; f++) {
    const pf = perFrameEl && perFrameEl.items && perFrameEl.items[f] ? perFrameEl.items[f].dataSet : undefined;
    const g = (seq, tag, rd) => frameGeometry(shared, pf, [seq, tag, rd]);
    const fr = {
      ipp: g(TAG.planePosition, TAG.ipp, nums) || (f === 0 || !perFrameEl ? topIpp : undefined),
      iop: g(TAG.planeOrientation, TAG.iop, nums) || topIop,
      ps: g(TAG.pixelMeasures, TAG.pixelSpacing, nums) || topPs,
      thickness: g(TAG.pixelMeasures, TAG.sliceThickness, num) ?? topTh,
      slope: g(TAG.pixelValueTx, TAG.slope, num) ?? topSlope ?? 1,
      intercept: g(TAG.pixelValueTx, TAG.intercept, num) ?? topIcpt ?? 0,
      sliceLocation: rec.numFrames === 1 ? sliceLoc : undefined,
      stackPos: pf ? frameGeometry(undefined, pf, [TAG.frameContent, TAG.inStackPos, num]) : undefined,
    };
    if (rec.numFrames > 1 && !perFrameEl && f > 0) fr.ipp = undefined;
    if (fr.ipp && fr.ipp.length !== 3) fr.ipp = undefined;
    if (fr.iop && fr.iop.length !== 6) fr.iop = undefined;
    if (fr.ps && fr.ps.length < 2) fr.ps = fr.ps.length === 1 ? [fr.ps[0], fr.ps[0]] : undefined;
    if (fr.ipp) fr.ipp = fr.ipp.map((v) => round(v));
    if (fr.iop) fr.iop = fr.iop.map((v) => round(v, 1e-8));
    rec.frames.push(fr);
  }
  rec.sliceThickness = rec.frames[0]?.thickness;

  // ---- pixel data location ----
  const pe = ds.elements[PIXEL_DATA];
  if (pe) {
    rec.pixel = { offset: pe.dataOffset, length: pe.length, encapsulated: pe.length === 0xffffffff || !!pe.encapsulatedPixelData };
  }

  const transient = {
    groupUID: (str(ds, TAG.studyUID) || '') + '|' + (str(ds, TAG.seriesUID) || ''),
  };
  return { rec, transient, anon, descFlagged };
}

// Technical radiograph attributes only (all numeric / coded). Free text is screened by the caller.
function extractXr(ds) {
  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : undefined);
  const lat = safeCode(str(ds, XR.imageLaterality), 1) || safeCode(str(ds, XR.laterality), 1);
  const ps2 = (tag) => { const a = nums(ds, tag); return a && a.length >= 2 && a[0] > 0 && a[1] > 0 ? [a[0], a[1]] : a && a.length === 1 && a[0] > 0 ? [a[0], a[0]] : undefined; };
  const palDesc = (tag) => {
    const el = ds.elements[tag];
    if (!el || el.length < 6) return undefined;
    try { return [ds.uint16(tag, 0), ds.uint16(tag, 1), ds.uint16(tag, 2)]; } catch { return undefined; }
  };
  return {
    imagerPs: ps2(XR.imagerPs),
    nominalPs: ps2(XR.nominalPs),
    emf: pos(num(ds, XR.emf)),
    sid: pos(num(ds, XR.sid)),
    sod: pos(num(ds, XR.sod)),
    calibType: safeCode(str(ds, XR.calibType), 16),
    laterality: lat === 'L' || lat === 'R' ? lat : '',
    viewPosition: '',
    windowCenter: num(ds, XR.windowCenter),
    windowWidth: num(ds, XR.windowWidth),
    voiFunction: safeCode(str(ds, XR.voiFunction), 16),
    lutShape: safeCode(str(ds, XR.lutShape), 16),
    pir: safeCode(str(ds, XR.pir), 8),
    pirSign: ss(ds, XR.pirSign),
    intent: safeCode(str(ds, XR.intent), 16),
    patientOrientation: (strAll(ds, XR.patientOrientation) || '').toUpperCase().split('\\').map((s) => safeCode(s, 4)).filter(Boolean).slice(0, 2),
    palette: rec0Palette(palDesc),
    segmentedPalette: has(ds, XR.segPalR),
    modalityLutSeq: has(ds, XR.modalityLutSeq),
    voiLutSeq: has(ds, XR.voiLutSeq),
    flagged: false,
  };
}
function rec0Palette(palDesc) {
  const r = palDesc(XR.palDescR), g = palDesc(XR.palDescG), b = palDesc(XR.palDescB);
  return r && g && b ? { r, g, b } : undefined;
}

/** The palette colour LUT data elements (read from a full parse when decoding). */
export const PALETTE_DATA_TAGS = [XR.palR, XR.palG, XR.palB];

/** Checks the pixel payload is completely present (uncompressed) in a header-only parse. */
export function pixelDataComplete(rec, byteLength) {
  if (!rec.pixel) return false;
  if (rec.pixel.encapsulated) return true;
  const ts = tsInfo(rec.ts);
  if (ts.deflate) return true;
  const need = rec.rows * rec.cols * (rec.bitsAllocated >> 3) * rec.spp * rec.numFrames;
  return rec.pixel.offset + Math.min(need, rec.pixel.length) <= byteLength;
}
