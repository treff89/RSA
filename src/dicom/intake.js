// Intake: one entry point for everything a user may drop — CT series, projection radiographs (DICOM) and plain raster
// images (PNG/JPEG/...). Wraps one StudyLoader, which reads and anonymises each file exactly once during scan();
// radiograph / raster candidates are set aside there (whitelisted header record only, no names) and re-read lazily.

import { StudyLoader } from './loader.js';
import { parseDicomBytes } from './parse.js';
import { decodeRadiograph } from './radiograph.js';

export class Intake {
  constructor() {
    this._loader = new StudyLoader();
  }

  reset() {
    this._loader.reset();
  }

  /** Test hook: everything retained after a scan (except the opaque read closures). */
  _debugState() {
    return this._loader._debugState();
  }

  /**
   * sources: [{ name, size, read: () => Promise<ArrayBuffer|Uint8Array> }] (zips are expanded).
   * Returns { ct: { series, recommendedId, rejected } | null, radiographs, rasters, report, skippedFiles }.
   * Throws code 'NOTHING_USABLE' when there is neither a CT series, a radiograph nor a raster image.
   */
  async scan(sources, onProgress) {
    const r = await this._loader.scan(sources, onProgress, { radiographs: true, rasters: true, allowNoCT: true });
    const result = {
      ct: r.series.length ? { series: r.series, recommendedId: r.recommendedId, rejected: r.rejected } : null,
      radiographs: r.radiographs,
      rasters: r.rasters,
      report: r.report,
      skippedFiles: r.skippedFiles,
    };
    if (!result.ct && !result.radiographs.length && !result.rasters.length) {
      const n = r.report.filesScanned;
      let msg = `No usable images were found in the ${n} file${n === 1 ? '' : 's'} provided`;
      if (r.rejected.length) {
        msg += ` (${r.rejected.length} series skipped: ${[...new Set(r.rejected.map((x) => x.reason))].slice(0, 3).join('; ')})`;
      }
      const err = new Error(msg + '.');
      err.code = 'NOTHING_USABLE';
      err.result = result;          // anonymised, so the UI can still show what was seen
      err.rejected = r.rejected;
      throw err;
    }
    return result;
  }

  /** Decode one radiograph listed by scan() -> { width, height, data, min, max, window, pixelSpacing, meta, warnings }. */
  async loadRadiograph(id) {
    const L = this._loader;
    const x = L._xr.find((e) => e.id === id);
    if (!x) throw new Error('This image is no longer available. Please load the files again.');
    try {
      let ds;
      try { ds = parseDicomBytes(await L._readFile(x.fileIdx), false); } catch { ds = null; }
      const same = ds && ds.elements.x00280010 && ds.uint16('x00280010') === x.rec.rows && ds.uint16('x00280011') === x.rec.cols;
      if (!same) throw new Error('The image could not be read again. Were the files moved or changed?');
      // decode with the record anonymised at scan time, so the result matches what scan() reported
      return await decodeRadiograph(ds, x.rec);
    } finally {
      L._cache.clear();
    }
  }

  /**
   * Bytes of a non-DICOM image listed by scan(). The caller should decode them to pixels (which drops any embedded
   * metadata such as EXIF) and not keep or forward the raw bytes.
   */
  async readRaster(id) {
    const L = this._loader;
    const r = L._rasters.find((e) => e.id === id);
    if (!r) throw new Error('This image is no longer available. Please load the files again.');
    try {
      const u8 = await L._readFile(r.fileIdx);
      // detach from a (larger) archive buffer so the caller may transfer it
      return u8.byteLength === u8.buffer.byteLength ? u8 : u8.slice();
    } finally {
      L._cache.clear();
    }
  }

  buildVolume(seriesId, onProgress) {
    return this._loader.buildVolume(seriesId, onProgress);
  }
}
