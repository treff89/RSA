// Transfer syntax table: UID -> { name, codec, compressed, supported, bigEndian?, deflate?, lossy? }
// codec: 'raw' | 'raw-encap' | 'rle' | 'jpegll' | 'jpegls' | 'j2k' | null (unsupported)

const T = (name, codec, extra = {}) => ({ name, codec, compressed: codec !== 'raw', supported: codec !== null, ...extra });

export const TRANSFER_SYNTAXES = {
  '1.2.840.10008.1.2': T('Implicit VR Little Endian', 'raw'),
  '1.2.840.10008.1.2.1': T('Explicit VR Little Endian', 'raw'),
  '1.2.840.10008.1.2.1.99': T('Deflated Explicit VR Little Endian', 'raw', { deflate: true }),
  '1.2.840.10008.1.2.2': T('Explicit VR Big Endian', 'raw', { bigEndian: true }),
  '1.2.840.10008.1.2.1.98': T('Encapsulated Uncompressed Explicit VR Little Endian', 'raw-encap'),
  '1.2.840.10008.1.2.5': T('RLE Lossless', 'rle'),
  '1.2.840.10008.1.2.4.57': T('JPEG Lossless (Process 14)', 'jpegll'),
  '1.2.840.10008.1.2.4.70': T('JPEG Lossless (Process 14, SV1)', 'jpegll'),
  '1.2.840.10008.1.2.4.80': T('JPEG-LS Lossless', 'jpegls'),
  '1.2.840.10008.1.2.4.81': T('JPEG-LS Near-Lossless', 'jpegls', { lossy: true }),
  '1.2.840.10008.1.2.4.90': T('JPEG 2000 Lossless', 'j2k'),
  '1.2.840.10008.1.2.4.91': T('JPEG 2000', 'j2k', { lossy: true }),
  // unsupported (recognised, so we can name them in the warning)
  '1.2.840.10008.1.2.4.50': T('JPEG Baseline (lossy)', null),
  '1.2.840.10008.1.2.4.51': T('JPEG Extended (lossy)', null),
  '1.2.840.10008.1.2.4.53': T('JPEG Spectral Selection (lossy)', null),
  '1.2.840.10008.1.2.4.55': T('JPEG Full Progression (lossy)', null),
  '1.2.840.10008.1.2.4.92': T('JPEG 2000 Part 2 Multi-component Lossless', null),
  '1.2.840.10008.1.2.4.93': T('JPEG 2000 Part 2 Multi-component', null),
  '1.2.840.10008.1.2.4.94': T('JPIP Referenced', null),
  '1.2.840.10008.1.2.4.95': T('JPIP Referenced Deflate', null),
  '1.2.840.10008.1.2.4.100': T('MPEG-2 video', null),
  '1.2.840.10008.1.2.4.101': T('MPEG-2 video', null),
  '1.2.840.10008.1.2.4.102': T('MPEG-4 video', null),
  '1.2.840.10008.1.2.4.103': T('MPEG-4 video', null),
  '1.2.840.10008.1.2.4.104': T('MPEG-4 video', null),
  '1.2.840.10008.1.2.4.105': T('MPEG-4 video', null),
  '1.2.840.10008.1.2.4.106': T('MPEG-4 video', null),
  '1.2.840.10008.1.2.4.107': T('HEVC video', null),
  '1.2.840.10008.1.2.4.108': T('HEVC video', null),
  '1.2.840.10008.1.2.4.110': T('JPEG XL Lossless', null),
  '1.2.840.10008.1.2.4.111': T('JPEG XL JPEG Recompression', null),
  '1.2.840.10008.1.2.4.112': T('JPEG XL', null),
  '1.2.840.10008.1.2.4.201': T('High-Throughput JPEG 2000 Lossless', null),
  '1.2.840.10008.1.2.4.202': T('High-Throughput JPEG 2000 (RPCL) Lossless', null),
  '1.2.840.10008.1.2.4.203': T('High-Throughput JPEG 2000', null),
};

export const IMPLICIT_LE = '1.2.840.10008.1.2';
export const EXPLICIT_LE = '1.2.840.10008.1.2.1';
export const DEFLATED_LE = '1.2.840.10008.1.2.1.99';

export function tsInfo(uid) {
  return TRANSFER_SYNTAXES[uid] || T('Unknown transfer syntax', null);
}
