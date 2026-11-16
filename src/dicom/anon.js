// Anonymisation helpers: classification of identifying DICOM elements (PS3.15 Annex E basic profile groups),
// identifier counting WITHOUT reading values, and screening of free-text descriptors.
//
// Nothing here stores, returns or logs element VALUES (except the screened, cleaned descriptor strings).

const t = (g, e) => 'x' + g.toLowerCase() + e.toLowerCase();
const set = (list) => new Set(list.map(([g, e]) => t(g, e)));

export const CATEGORIES = [
  'Patient name', 'Patient ID', 'Dates of birth', 'Patient demographics', 'Study/series dates & times',
  'Institution & staff', 'Accession & order numbers', 'Device identifiers', 'UIDs', 'Free-text descriptions',
  'Private vendor tags', 'Overlays & curves', 'Other identifying attributes',
];

const PATIENT_NAME = set([['0010', '0010'], ['0010', '1001'], ['0010', '1005'], ['0010', '1060'], ['0010', '2297'],
  ['0010', '0101']]);
const PATIENT_ID = set([['0010', '0020'], ['0010', '0021'], ['0010', '0022'], ['0010', '0024'], ['0010', '1000'],
  ['0010', '1002'], ['0010', '0050'], ['0010', '1050'], ['0010', '0026'], ['0010', '0027'], ['0010', '0028']]);
const BIRTH = set([['0010', '0030'], ['0010', '0032'], ['0010', '0033'], ['0010', '0034'], ['0010', '0035']]);
const DATES = set([
  ['0008', '0012'], ['0008', '0013'], ['0008', '0015'], ['0008', '0020'], ['0008', '0021'], ['0008', '0022'],
  ['0008', '0023'], ['0008', '0024'], ['0008', '0025'], ['0008', '002a'], ['0008', '0030'], ['0008', '0031'],
  ['0008', '0032'], ['0008', '0033'], ['0008', '0034'], ['0008', '0035'], ['0008', '0201'], ['0018', '1012'],
  ['0018', '1014'], ['0018', '1200'], ['0018', '1201'], ['0018', '9074'], ['0018', '9151'], ['0018', '9623'],
  ['0018', '9701'], ['0032', '0032'], ['0032', '0033'], ['0032', '0034'], ['0032', '0035'], ['0032', '1000'],
  ['0032', '1001'], ['0032', '1010'], ['0032', '1011'], ['0032', '1040'], ['0032', '1041'], ['0032', '1050'],
  ['0032', '1051'], ['0038', '0020'], ['0038', '0021'], ['0038', '0030'], ['0038', '0031'], ['0038', '0032'],
  ['0038', '0033'], ['0040', '0002'], ['0040', '0003'], ['0040', '0004'], ['0040', '0005'], ['0040', '0244'],
  ['0040', '0245'], ['0040', '0250'], ['0040', '0251'], ['0040', '2004'], ['0040', '2005'], ['0040', 'a032'],
  ['0040', 'a120'], ['0040', 'a121'], ['0040', 'a122'], ['0040', 'a13a'], ['0020', '3403'], ['0020', '3405'],
  ['0018', '700c'], ['0018', '700e'], ['0018', '1202'], ['0040', 'a023'], ['0040', 'a024'], ['0040', 'a030'],
  ['0018', '1203'], ['0018', '1078'], ['0018', '1079'], ['0018', '1002'],
]);
DATES.delete(t('0018', '1002'));
const INSTITUTION = set([
  ['0008', '0080'], ['0008', '0081'], ['0008', '0082'], ['0008', '0090'], ['0008', '0092'], ['0008', '0094'],
  ['0008', '0096'], ['0008', '009c'], ['0008', '009d'], ['0008', '1010'], ['0008', '1040'], ['0008', '1041'],
  ['0008', '1048'], ['0008', '1049'], ['0008', '1050'], ['0008', '1052'], ['0008', '1060'], ['0008', '1062'],
  ['0008', '1070'], ['0008', '1072'], ['0032', '1032'], ['0032', '1033'], ['0040', '0006'], ['0040', '000b'],
  ['0040', '0010'], ['0040', '0011'], ['0040', '0241'], ['0040', '0242'], ['0040', '0243'], ['0040', '1010'],
  ['0040', '1011'], ['0040', '2008'], ['0040', '2009'], ['0040', '2010'], ['0040', 'a075'], ['0040', 'a073'],
  ['0040', 'a027'], ['0040', 'a078'], ['0040', 'a07a'], ['0040', 'a07c'], ['0040', 'a088'], ['0040', 'a123'],
  ['300e', '0008'], ['4008', '0114'], ['4008', '0119'], ['4008', '011a'], ['0002', '0016'], ['0002', '0017'],
  ['0002', '0018'], ['0008', '0055'], ['0008', '0054'], ['0040', '1102'], ['0040', '1103'], ['0040', '1104'],
]);
const ACCESSION = set([
  ['0008', '0050'], ['0008', '0051'], ['0020', '0010'], ['0040', '2016'], ['0040', '2017'], ['0040', '1001'],
  ['0040', '0009'], ['0040', '0253'], ['0038', '0010'], ['0038', '0011'], ['0038', '0014'], ['0038', '0400'],
  ['0032', '000a'], ['0032', '000b'], ['0032', '000c'], ['0040', 'a124'], ['0040', '0512'], ['0040', '0513'],
  ['0012', '0040'], ['0012', '0042'], ['0040', '1005'], ['0040', '1008'], ['0040', '2001'], ['0040', '4005'],
]);
ACCESSION.delete(t('0040', 'a124'));
const DEVICE = set([
  ['0018', '1000'], ['0018', '1004'], ['0018', '1005'], ['0018', '1007'], ['0018', '1008'], ['0018', '1009'],
  ['0018', '100a'], ['0018', '100b'], ['0018', '700a'], ['0018', '1002'], ['0018', '9371'], ['0018', '9373'],
  ['0018', '9367'], ['0018', '1508'], ['3002', '0018'], ['0018', '1030'],
]);
DEVICE.delete(t('0018', '1030'));
// UIDs in implicit-VR files (no VR available). In explicit files, any VR=UI counts too (minus the classifying ones).
const UIDS = set([
  ['0002', '0003'], ['0008', '0018'], ['0020', '000d'], ['0020', '000e'], ['0020', '0052'], ['0020', '0200'],
  ['0008', '1155'], ['0008', '0014'], ['0008', '3010'], ['0018', '1002'], ['0040', 'a124'], ['0008', '1195'],
  ['0088', '0140'], ['3006', '0024'], ['0004', '1511'], ['0008', '0058'], ['0020', '9161'], ['0020', '9164'],
  ['0028', '1199'], ['0008', '9123'], ['0040', '4023'], ['0040', 'db0d'], ['0040', 'a402'],
  ['0062', '0021'], ['0070', '031a'], ['0400', '0100'], ['0400', '0010'], ['3006', '00c2'], ['0018', '2042'],
  ['0008', '0019'],
]);
const NON_IDENTIFYING_UIDS = set([['0002', '0002'], ['0002', '0010'], ['0008', '0016'], ['0008', '1150'],
  ['0002', '0012'], ['0008', '0062'], ['0008', '001a'], ['0004', '1510'], ['0004', '1512'], ['0040', 'a171']]);
const FREE_TEXT = set([
  ['0008', '1030'], ['0008', '1080'], ['0008', '2111'], ['0008', '4000'], ['0010', '4000'], ['0018', '1030'],
  ['0018', '1400'], ['0020', '4000'], ['0032', '1060'], ['0032', '4000'], ['0040', '0007'], ['0040', '0254'],
  ['0040', '0280'], ['0040', '1400'], ['0040', '2400'], ['0040', '3001'], ['0040', 'a160'], ['0008', '0108'],
  ['0018', '0010'], ['0032', '1066'], ['0032', '1067'], ['0038', '0040'], ['0038', '0050'], ['0038', '0500'],
  ['0040', '1002'], ['0040', '1004'], ['0040', '1400'], ['0040', '0310'], ['0040', '0400'], ['4000', '0010'],
  ['4000', '4000'], ['0008', '1100'], ['0018', '9424'], ['0040', 'a730'],
]);
// groups that are wholly identifying (or administrative) context
const OTHER_GROUPS = new Set([0x0012, 0x0032, 0x0038, 0x0040, 0x4008, 0x0400, 0x0088, 0xfffa, 0x4000, 0x0010]);

export const SERIES_DESCRIPTION = t('0008', '103e');

/** Returns the identifier category of an element or null if not identifying. `vr` may be undefined (implicit VR). */
export function classifyTag(tag, vr) {
  const group = parseInt(tag.slice(1, 5), 16);
  if (group & 1) return 'Private vendor tags';
  if (PATIENT_NAME.has(tag)) return 'Patient name';
  if (PATIENT_ID.has(tag)) return 'Patient ID';
  if (BIRTH.has(tag)) return 'Dates of birth';
  if (group === 0x0010) return 'Patient demographics';
  if (INSTITUTION.has(tag)) return 'Institution & staff';
  if (ACCESSION.has(tag)) return 'Accession & order numbers';
  if (DEVICE.has(tag)) return 'Device identifiers';
  if (UIDS.has(tag) || (vr === 'UI' && !NON_IDENTIFYING_UIDS.has(tag))) return 'UIDs';
  if (DATES.has(tag) || vr === 'DA' || vr === 'DT' || vr === 'TM') return 'Study/series dates & times';
  if (FREE_TEXT.has(tag)) return 'Free-text descriptions';
  if ((group >= 0x6000 && group <= 0x60ff) || (group >= 0x5000 && group <= 0x50ff)) return 'Overlays & curves';
  if (OTHER_GROUPS.has(group)) return 'Other identifying attributes';
  if (vr === 'PN') return 'Institution & staff';
  return null;
}

/**
 * Walk a dicom-parser dataSet (recursively into sequences) and count present, non-empty identifying elements.
 * `keptTags` is a Set of top-level tags that are copied (whitelisted). `keptSeq` - sequences we read from.
 * Values are never read. Returns { cats: Map<category, count>, discarded: number }.
 */
export function countIdentifiers(dataSet, keptTags, keptSeqTags) {
  const cats = new Map();
  let discarded = 0;
  const walk = (ds, depth) => {
    for (const tag in ds.elements) {
      const el = ds.elements[tag];
      if (tag === 'x7fe00010' || tag === 'xfffee000' || tag === 'xfffee00d' || tag === 'xfffee0dd') continue;
      const group = parseInt(tag.slice(1, 5), 16);
      if (el.items && !(group & 1)) {
        if (keptSeqTags.has(tag)) {
          for (const it of el.items) if (it.dataSet) walkKeptSeq(it.dataSet, depth + 1);
        } else {
          for (const it of el.items) if (it.dataSet) walk(it.dataSet, depth + 1);
        }
        continue;
      }
      if (depth === 0 && keptTags.has(tag)) continue;
      discarded++;
      if (!(el.length > 0) && !el.items) continue;     // empty: present but carries nothing
      const cat = tag === SERIES_DESCRIPTION ? null : classifyTag(tag, el.vr);
      if (cat) cats.set(cat, (cats.get(cat) || 0) + 1);
    }
  };
  // inside functional-group sequences we keep a few technical items; everything else there is still discarded
  const walkKeptSeq = (ds, depth) => {
    for (const tag in ds.elements) {
      const el = ds.elements[tag];
      if (el.items) {
        if (keptSeqTags.has(tag)) {
          for (const it of el.items) if (it.dataSet) walkKeptSeq(it.dataSet, depth + 1);
        } else {
          for (const it of el.items) if (it.dataSet) walk(it.dataSet, depth + 1);
        }
        continue;
      }
      if (keptTags.has(tag)) continue;
      discarded++;
      if (!(el.length > 0)) continue;
      const cat = classifyTag(tag, el.vr);
      if (cat) cats.set(cat, (cats.get(cat) || 0) + 1);
    }
  };
  walk(dataSet, 0);
  return { cats, discarded };
}

// ---------------- descriptor screening ----------------

export function toPrintableAscii(s) {
  if (!s) return '';
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Build the list of identifying tokens (uppercase, >= 3 chars) from identifying values. Caller discards it. */
export function identifyingTokens({ patientName, patientId, accession, otherIds, birthDate }) {
  const tokens = new Set();
  const add = (v, split) => {
    if (!v) return;
    const s = toPrintableAscii(v).toUpperCase();
    const parts = split ? s.split(/[\^=\\\s,.\-_'()]+/) : s.split(/\\/);
    for (const p of parts) { const q = p.trim(); if (q.length >= 3) tokens.add(q); }
  };
  add(patientName, true);
  add(patientId, false);
  add(accession, false);
  add(otherIds, false);
  add(birthDate, false);
  if (birthDate && /^\d{8}$/.test(birthDate.trim())) {
    const b = birthDate.trim();
    tokens.add(b.slice(6, 8) + b.slice(4, 6) + b.slice(0, 4)); // DDMMYYYY
  }
  return tokens;
}

/**
 * Screen a free-text descriptor. Returns { value, flagged } where value is '' when flagged.
 * Flagged if it contains any identifying token, any run of >= 6 digits, or a date-like pattern.
 */
export function screenDescriptor(raw, tokens, maxLen = 48) {
  const s = toPrintableAscii(raw);
  if (!s) return { value: '', flagged: false };
  const up = s.toUpperCase();
  const compact = up.replace(/[\s\-_.\/]/g, '');
  let flagged = /\d{6,}/.test(up);
  if (/\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/.test(up)) flagged = true;
  if (!flagged) {
    for (const tok of tokens) {
      if (up.includes(tok) || compact.includes(tok.replace(/[\s\-_.\/]/g, ''))) { flagged = true; break; }
    }
  }
  if (flagged) return { value: '', flagged: true };
  return { value: s.slice(0, maxLen).trim(), flagged: false };
}

export const KEPT_ATTRIBUTES = [
  'Transfer syntax', 'SOP class (classification only)', 'Modality', 'Image type', 'Image size (rows × columns)',
  'Bit depth & pixel representation', 'Photometric interpretation', 'Number of frames', 'Pixel spacing',
  'Slice positions', 'Slice orientation', 'Slice thickness & spacing between slices', 'Slice location',
  'Gantry tilt', 'Rescale slope/intercept', 'Pixel padding value', 'kVp', 'Reconstruction kernel (screened)',
  'Body part examined (screened)', 'Series / instance / acquisition numbers', 'Patient position (e.g. HFS)',
  'Series description (screened)', 'Pixel data location',
  // projection radiographs only
  'Imager / scanned pixel spacing & calibration type', 'Magnification factor & source distances',
  'Laterality (L/R)', 'View position (screened)', 'Patient orientation codes', 'Window centre/width',
  'Presentation LUT shape & pixel intensity relationship', 'Presentation intent type', 'Palette colour lookup tables',
];
