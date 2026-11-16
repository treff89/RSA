// StudyLoader: scan dropped sources -> anonymised series list; build HU volume for one series.
// With scan options it also sets aside projection radiographs and non-DICOM raster images (see intake.js), so every
// file is read and anonymised exactly once.

import { toU8, isZip, listZip, readZipEntry, isJunkName } from './sources.js';
import { parseDicomBytes, extractHeader, pixelDataComplete } from './parse.js';
import { analyseSeries, scoreSeries } from './series.js';
import { tsInfo } from './transfer-syntax.js';
import { decodeFrame, buildLUT, applyLUT } from './pixels.js';
import { CATEGORIES, KEPT_ATTRIBUTES } from './anon.js';
import { isRadiographCandidate, radiographSummary } from './radiograph.js';

const MIN_SLICES = 10;
const YIELD_MS = 30;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const tick = () => new Promise((r) => setTimeout(r, 0));
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '?');

/** Recognise common raster image files by magic bytes (never by name). Returns a type or null. */
export function sniffRaster(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  // 'BM' alone is weak: also require the reserved words to be zero and a plausible pixel offset
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26 && !(b[6] | b[7] | b[8] | b[9]) && b[10] >= 26 && !(b[12] | b[13])) return 'bmp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return 'tiff';
  return null;
}

function rejectReason(rec) {
  if (rec.kind === 'sr') return { reason: 'dose report / structured report — not an image', burned: /DOSE/.test(rec.description.toUpperCase()) };
  if (rec.kind === 'pdf') return { reason: 'encapsulated document (PDF) — not an image', burned: true };
  if (rec.kind === 'pr') return { reason: 'presentation state — not an image', burned: false };
  if (rec.kind === 'sc') return { reason: 'secondary capture / screenshot — may contain burned-in text', burned: true };
  if (rec.kind === 'rt' || rec.kind === 'raw') return { reason: 'not a CT image', burned: false };
  if (!rec.hasPixels || !rec.rows || !rec.cols) return { reason: 'no image data', burned: false };
  if (rec.spp !== 1 || /RGB|YBR|PALETTE/.test(rec.photometric)) return { reason: 'colour image (screenshot) — may contain burned-in text', burned: true };
  if (rec.burnedIn) return { reason: 'image flagged as containing burned-in annotation', burned: true };
  if (rec.modality !== 'CT') return { reason: `not a CT image (modality ${rec.modality || 'unknown'})`, burned: false };
  if (rec.imageType.includes('LOCALIZER') || rec.imageType.includes('SCOUT') || rec.imageType.includes('TOPOGRAM')) {
    return { reason: 'localizer / scout image', burned: false };
  }
  if (rec.imageType.includes('SECONDARY') && rec.imageType.includes('SCREEN')) return { reason: 'screen capture — may contain burned-in text', burned: true };
  if (rec.bitsAllocated !== 8 && rec.bitsAllocated !== 16) return { reason: `unsupported bit depth (${rec.bitsAllocated})`, burned: false };
  return null;
}

export class StudyLoader {
  constructor() {
    this.reset();
  }

  reset() {
    this._files = [];          // { read } | { container, entry }   (no names kept)
    this._containers = [];     // { read }
    this._records = [];        // whitelisted header records per file (index = file index)
    this._series = new Map();  // local id -> { info, plan, recs }
    this._cache = new Map();   // container idx -> Uint8Array (only during scan/build)
    this._xr = [];             // radiographs: { id, fileIdx, rec, summary }   (scan option `radiographs`)
    this._rasters = [];        // non-DICOM images: { id, fileIdx, type }      (scan option `rasters`)
  }

  /** Test hook: everything the loader retains (except the opaque read closures). */
  _debugState() {
    return {
      files: this._files.map((f) => (f === null ? null : f.entry ? { container: f.container, entry: f.entry } : { direct: true })),
      containers: this._containers.length,
      records: this._records,
      series: [...this._series.entries()].map(([id, s]) => ({ id, info: s.info, plan: s.plan })),
      cache: this._cache.size,
      radiographs: this._xr,
      rasters: this._rasters,
    };
  }

  async _containerBytes(idx) {
    if (this._cache.has(idx)) return this._cache.get(idx);
    const u8 = toU8(await this._containers[idx].read());
    if (this._cache.size >= 2) this._cache.delete(this._cache.keys().next().value);
    this._cache.set(idx, u8);
    return u8;
  }

  async _readFile(i) {
    const f = this._files[i];
    if (f.entry) return readZipEntry(await this._containerBytes(f.container), f.entry);
    return toU8(await f.read());
  }

  /**
   * options (all default false, i.e. the CT-only behaviour):
   *   radiographs - projection radiographs are listed in result.radiographs instead of being rejected as "not CT"
   *   rasters     - non-DICOM image files (by magic bytes) are listed in result.rasters instead of being skipped
   *   allowNoCT   - return the result instead of throwing NO_CT_SERIES when there is no usable CT series
   */
  async scan(sources, onProgress, options = {}) {
    this.reset();
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    const stats = { filesScanned: 0, dicomFiles: 0, skipped: 0, discarded: 0, burned: 0, descCleaned: 0 };
    const catEl = new Map(), catFiles = new Map();
    const groups = new Map();                  // transient: UID-based key -> group (discarded at end of scan)
    const studies = new Map();                 // transient: study UID -> study index
    let total = sources.length, done = 0, last = now();

    const report = async (msg) => {
      if (now() - last > YIELD_MS) {
        last = now();
        progress({ phase: 'scan', done, total, message: msg });
        await tick();
      }
    };

    const handleBytes = async (u8, fileRef, depth) => {
      if (isZip(u8)) {
        if (depth > 3) { stats.skipped++; return; }
        let entries;
        try { entries = listZip(u8); } catch { stats.skipped++; return; }
        const cIdx = this._containers.length;
        this._containers.push({ read: fileRef.readSelf });
        this._cache.set(cIdx, u8);
        total += entries.length;
        for (const e of entries) {
          const name = e.name;
          const entry = { method: e.method, csize: e.csize, usize: e.usize, localOffset: e.localOffset, encrypted: e.encrypted };
          if (isJunkName(name) || e.encrypted) { done++; stats.skipped++; continue; }
          let data;
          try { data = readZipEntry(u8, entry); } catch { done++; stats.skipped++; continue; }
          const ref = {
            file: { container: cIdx, entry },
            readSelf: async () => readZipEntry(await this._containerBytes(cIdx), entry),
          };
          await handleBytes(data, ref, depth + 1);
          done++;
          await report('Reading archive…');
        }
        this._cache.delete(cIdx);
        return;
      }
      stats.filesScanned++;
      let ds;
      try {
        ds = parseDicomBytes(u8, true);
      } catch { stats.skipped++; return; }
      if (!ds) {
        const type = options.rasters ? sniffRaster(u8) : null;
        if (!type) { stats.skipped++; return; }
        this._rasters.push({ id: `r${this._rasters.length + 1}`, fileIdx: this._files.length, type });
        this._files.push(fileRef.file);
        this._records.push(null);
        return;
      }
      let hdr;
      try { hdr = extractHeader(ds); } catch { stats.skipped++; return; }
      const { rec, transient, anon, descFlagged } = hdr;
      if (rec.kind === 'dicomdir') { stats.skipped++; return; }
      if (rec.hasPixels && !pixelDataComplete(rec, u8.length)) { stats.skipped++; return; }
      stats.dicomFiles++;
      stats.discarded += anon.discarded;
      for (const [c, n] of anon.cats) {
        catEl.set(c, (catEl.get(c) || 0) + n);
        catFiles.set(c, (catFiles.get(c) || 0) + 1);
      }
      if (descFlagged) {
        const c = 'Free-text descriptions';
        catEl.set(c, (catEl.get(c) || 0) + 1);
        if (!anon.cats.has(c)) catFiles.set(c, (catFiles.get(c) || 0) + 1);
      }
      const fileIdx = this._files.length;
      this._files.push(fileRef.file);
      this._records.push(rec);
      rec.descFlagged = descFlagged;
      const studyUid = transient.groupUID.split('|')[0];
      if (!studies.has(studyUid)) studies.set(studyUid, studies.size + 1);
      if (options.radiographs && isRadiographCandidate(rec)) {
        const summary = radiographSummary(rec);
        if (summary.burnedInRisk) stats.burned++;
        if (descFlagged || rec.xr.flagged) stats.descCleaned++;
        this._xr.push({ id: '', fileIdx, rec, summary, study: studies.get(studyUid) });
        return;
      }
      const rej = rejectReason(rec);
      if (rej && rej.burned) stats.burned++;
      // group key (transient, contains UIDs): study|series + size + orientation + pixel spacing
      const fr0 = rec.frames[0] || {};
      const iopKey = fr0.iop ? fr0.iop.map((v) => Math.round(v * 1000)).join(',') : 'noiop';
      const psKey = fr0.ps ? fr0.ps.map((v) => Math.round(v * 1e4)).join(',') : 'nops';
      const key = rej
        ? `${transient.groupUID}|rejected|${rej.reason}`
        : `${transient.groupUID}|${rec.rows}x${rec.cols}|${iopKey}|${psKey}`;
      let g = groups.get(key);
      if (!g) { g = { study: studies.get(studyUid), recs: [], fileIdx: [], rej, flagged: false }; groups.set(key, g); }
      g.recs.push(rec);
      g.fileIdx.push(fileIdx);
      if (descFlagged) g.flagged = true;
    };

    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const readSelf = () => src.read();
      try {
        if (src && typeof src.name === 'string' && isJunkName(src.name)) { stats.skipped++; done++; continue; }
        const u8 = toU8(await src.read());
        await handleBytes(u8, { file: { read: readSelf }, readSelf }, 0);
      } catch {
        stats.skipped++;
      }
      done++;
      await report('Reading files…');
    }
    this._cache.clear();

    // ---------- build series ----------
    progress({ phase: 'scan', done, total, message: 'Analysing series…' });
    const usable = [];
    const rejected = [];
    const multiStudy = studies.size > 1;
    let cur = null;
    for (const g of groups.values()) {
      const r0 = g.recs[0];
      const desc = g.flagged ? '' : mostCommon(g.recs.map((r) => r.description));
      cur = { r0, g, desc };
      if (g.flagged) stats.descCleaned++;
      const nImages = g.recs.reduce((a, r) => a + r.numFrames, 0);
      const labelBase = `${multiStudy ? `Study ${g.study} · ` : ''}Series ${Number.isFinite(r0.seriesNumber) ? r0.seriesNumber : '?'}${desc ? ' · ' + desc : ''}`;
      if (g.rej) {
        rejected.push({ label: `${labelBase} · ${nImages} image${nImages > 1 ? 's' : ''}`, reason: g.rej.reason });
        continue;
      }
      const slices = [];
      g.recs.forEach((rec, j) => {
        rec.frames.forEach((fr, f) => slices.push({
          fileIdx: g.fileIdx[j], frame: f, ipp: fr.ipp, iop: fr.iop, ps: fr.ps, thickness: fr.thickness,
          slope: fr.slope, intercept: fr.intercept, sliceLocation: fr.sliceLocation, stackPos: fr.stackPos,
          instanceNumber: rec.instanceNumber, acquisitionNumber: rec.acquisitionNumber, order: slices.length,
        }));
      });
      if (slices.length < MIN_SLICES) {
        rejected.push({ label: `${labelBase} · ${nImages} image${nImages > 1 ? 's' : ''}`, reason: `too few slices (${slices.length}; at least ${MIN_SLICES} needed)` });
        continue;
      }
      const a = analyseSeries(slices, { spacingBetween: r0.spacingBetween });
      let parts = [{ a, suffix: '', extraWarn: [] }];
      if (!a.ok && a.split) {
        const nParts = a.split.length;
        const gapWarn = `series has a ${a.gapMm.toFixed(0)} mm gap between stacks — split into ${nParts} parts`;
        parts = a.split.map((chunk, ci) => ({
          a: chunk.length >= MIN_SLICES ? analyseSeries(chunk, { spacingBetween: r0.spacingBetween }) : { ok: false, reason: `too few slices (${chunk.length}; at least ${MIN_SLICES} needed)` },
          suffix: ` · part ${ci + 1} of ${nParts}`,
          extraWarn: [gapWarn, ...a.warnings],
        }));
      }
      for (const part of parts) {
        const lb = labelBase + part.suffix;
        if (!part.a.ok) {
          rejected.push({ label: `${lb} · ${nImages} images`, reason: part.a.reason || 'inconsistent slice geometry' });
          continue;
        }
        if (part.a.plan.nz < MIN_SLICES) {
          rejected.push({ label: `${lb} · ${nImages} images`, reason: `too few distinct slices (${part.a.plan.slices.length})` });
          continue;
        }
        addUsable(part.a.plan, lb, [...new Set([...part.extraWarn, ...part.a.plan.warnings])]);
      }
    }
    function addUsable(plan, labelBase, planWarnings) {
      const { r0, g, desc } = cur;
      const ts = tsInfo(r0.ts);
      const tsSet = new Set(g.recs.map((r) => r.ts));
      const warnings = [...planWarnings];
      let supported = ts.supported;
      if (!ts.supported) warnings.unshift(`unsupported compression: ${ts.name}`);
      if (tsSet.size > 1) {
        for (const t of tsSet) if (!tsInfo(t).supported) { supported = false; warnings.unshift(`unsupported compression: ${tsInfo(t).name}`); break; }
      }
      if (ts.lossy) warnings.push(`lossy compression (${ts.name})`);
      if (r0.bitsAllocated === 8) warnings.push('8-bit image data');
      const tilt = Number.isFinite(r0.gantryTilt) ? Math.abs(r0.gantryTilt) : 0;
      if (tilt > 0.5 && !plan.tiltDeg) warnings.push(`gantry tilt ${tilt.toFixed(1)}° recorded in header`);
      const sliceThickness = Number.isFinite(plan.slices[0].thickness) ? plan.slices[0].thickness : null;
      const info = {
        id: '',
        label: '',
        description: desc,
        seriesNumber: Number.isFinite(r0.seriesNumber) ? r0.seriesNumber : null,
        numSlices: plan.nz,
        rows: r0.rows,
        cols: r0.cols,
        pixelSpacing: (plan.slices[0].ps || [1, 1]).slice(0, 2),
        sliceSpacing: round4(plan.sliceSpacing),
        sliceThickness,
        kernel: r0.kernel,
        bodyPart: r0.bodyPart,
        orientation: plan.orientation,
        transferSyntax: ts.name,
        compressed: ts.compressed,
        supported,
        extentMm: [round4(r0.cols * plan.spacing[0]), round4(r0.rows * plan.spacing[1]), round4(plan.nz * plan.spacing[2])],
        score: 0,
        warnings,
      };
      if (multiStudy) info.study = g.study;
      info.score = scoreSeries(info, r0.imageType);
      info._labelBase = labelBase;
      usable.push({ info, plan, kvp: r0.kvp });
    }
    usable.sort((x, y) => y.info.score - x.info.score);
    usable.forEach((s, i) => {
      s.info.id = `s${i + 1}`;
      const ps = s.info.pixelSpacing;
      s.info.label = `${s.info._labelBase} · ${s.info.numSlices} slices · ${fmt(ps[1])}×${fmt(ps[0])}×${fmt(s.info.sliceSpacing)} mm`;
      delete s.info._labelBase;
      this._series.set(s.info.id, s);
    });
    // radiographs in a stable, sensible order: study, series number, instance number, then scan order
    const ord = (v) => (Number.isFinite(v) ? v : Infinity);
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    this._xr.sort((a, b) => cmp(a.study, b.study) || cmp(ord(a.rec.seriesNumber), ord(b.rec.seriesNumber)) ||
      cmp(ord(a.rec.instanceNumber), ord(b.rec.instanceNumber)) || cmp(a.fileIdx, b.fileIdx));
    this._xr.forEach((x, i) => { x.id = `x${i + 1}`; });
    // drop records of files that are not part of a usable series (rejected / skipped)
    const keepFiles = new Set();
    for (const s of usable) for (const sl of s.plan.slices) keepFiles.add(sl.fileIdx);
    for (const x of this._xr) keepFiles.add(x.fileIdx);
    for (const r of this._rasters) keepFiles.add(r.fileIdx);
    this._records = this._records.map((r, i) => (keepFiles.has(i) ? r : null));
    this._files = this._files.map((f, i) => (keepFiles.has(i) ? f : null));

    const identifiersFound = [];
    for (const c of CATEGORIES) {
      if (catEl.get(c)) identifiersFound.push({ category: c, elements: catEl.get(c), files: catFiles.get(c) || 0 });
    }
    const recommended = usable.find((s) => s.info.supported);
    const result = {
      series: usable.map((s) => s.info),
      recommendedId: recommended ? recommended.info.id : null,
      rejected,
      skippedFiles: stats.skipped,
      report: {
        filesScanned: stats.filesScanned,
        dicomFiles: stats.dicomFiles,
        identifiersFound,
        totalElementsDiscarded: stats.discarded,
        kept: KEPT_ATTRIBUTES.slice(),
        descriptorsCleaned: stats.descCleaned,
        burnedInRisk: stats.burned,
      },
    };
    if (options.radiographs) {
      result.radiographs = this._xr.map((x) => ({
        id: x.id, ...x.summary, pixelSpacing: { ...x.summary.pixelSpacing }, warnings: x.summary.warnings.slice(),
        seriesNumber: Number.isFinite(x.rec.seriesNumber) ? x.rec.seriesNumber : null,
        instanceNumber: Number.isFinite(x.rec.instanceNumber) ? x.rec.instanceNumber : null,
      }));
    }
    if (options.rasters) result.rasters = this._rasters.map((r) => ({ id: r.id, type: r.type }));
    progress({ phase: 'scan', done: total, total, message: 'Done' });
    if (!usable.length && !options.allowNoCT) {
      let msg;
      if (!stats.dicomFiles) msg = `No DICOM images were found in the ${stats.filesScanned} file${stats.filesScanned === 1 ? '' : 's'} provided.`;
      else if (rejected.length) msg = 'No CT series suitable for 3D reconstruction was found ' +
        `(${rejected.length} series skipped: ${[...new Set(rejected.map((r) => r.reason))].slice(0, 3).join('; ')}).`;
      else msg = 'No CT series suitable for 3D reconstruction was found.';
      const err = new Error(msg);
      err.code = 'NO_CT_SERIES';
      err.result = result;        // the (anonymised) scan result, so the UI can still show what was seen
      throw err;
    }
    return result;
  }

  async buildVolume(seriesId, onProgress) {
    const s = this._series.get(seriesId);
    if (!s) throw new Error('This series is no longer available. Please load the files again.');
    if (!s.info.supported) {
      throw new Error(`This series cannot be decoded (${s.info.warnings[0] || s.info.transferSyntax}). ` +
        'Please export the images uncompressed or with lossless compression.');
    }
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    const { plan } = s;
    const nx = s.info.cols, ny = s.info.rows, nz = plan.nz;
    const nPix = nx * ny;
    const data = new Int16Array(nPix * nz);
    const slices = plan.slices;
    const total = slices.length;
    let last = now();
    let curFile = -1, curDs = null;
    let lut = null, lutKey = '';
    const getSlice = async (k, out, outOffset) => {
      const sl = slices[k];
      const rec = this._records[sl.fileIdx];
      if (sl.fileIdx !== curFile) {
        curDs = null;
        const u8 = await this._readFile(sl.fileIdx);
        let ds;
        try { ds = parseDicomBytes(u8, false); } catch { ds = null; }
        if (!ds) throw new Error(`One of the images in this series could not be read again (slice ${k + 1} of ${total}). Were the files moved or changed?`);
        curDs = ds;
        curFile = sl.fileIdx;
      }
      if (rec.rows !== ny || rec.cols !== nx) throw new Error('Inconsistent image sizes within the series.');
      let samples;
      try {
        samples = await decodeFrame(curDs, rec, sl.frame);
      } catch (e) {
        const msg = e && e.message ? e.message : 'decode error';
        throw new Error(`Could not decode slice ${k + 1} of ${total} (${tsInfo(rec.ts).name}): ${msg}.`);
      }
      const key = `${rec.bitsAllocated}|${rec.bitsStored}|${rec.highBit}|${rec.pixelRep}|${rec.padding}|${rec.paddingLimit}|${sl.slope}|${sl.intercept}`;
      if (key !== lutKey) {
        lut = buildLUT({ bitsAllocated: rec.bitsAllocated, bitsStored: rec.bitsStored, highBit: rec.highBit, pixelRep: rec.pixelRep,
          padding: rec.padding, paddingLimit: rec.paddingLimit, slope: sl.slope, intercept: sl.intercept });
        lutKey = key;
      }
      applyLUT(samples, lut, out, outOffset, nPix);
    };

    try {
      if (!plan.resample) {
        for (let k = 0; k < nz; k++) {
          await getSlice(k, data, k * nPix);
          if (now() - last > YIELD_MS) { last = now(); progress({ phase: 'load', done: k + 1, total }); await tick(); }
        }
      } else {
        const { srcPos, gridPos } = plan.resample;
        let a = new Int16Array(nPix), b = new Int16Array(nPix);
        await getSlice(0, a, 0);
        let ia = 0;
        let ib = -1;
        for (let k = 0; k < nz; k++) {
          const p = gridPos[k];
          while (ia + 1 < srcPos.length && srcPos[ia + 1] <= p + 1e-6) {
            // advance: b becomes the next source slice
            if (ib !== ia + 1) { await getSlice(ia + 1, b, 0); ib = ia + 1; }
            const t = a; a = b; b = t; ia = ia + 1; ib = -1;
          }
          const off = k * nPix;
          const da = srcPos[ia];
          if (Math.abs(p - da) < 1e-6 || ia + 1 >= srcPos.length) {
            data.set(a, off);
          } else {
            if (ib !== ia + 1) { await getSlice(ia + 1, b, 0); ib = ia + 1; }
            const t = (p - da) / (srcPos[ia + 1] - da);
            for (let i = 0; i < nPix; i++) data[off + i] = Math.round(a[i] + t * (b[i] - a[i]));
          }
          if (now() - last > YIELD_MS) { last = now(); progress({ phase: 'load', done: Math.min(ia + 1, total), total }); await tick(); }
        }
      }
    } finally {
      this._cache.clear();
      curDs = null;
    }
    progress({ phase: 'load', done: total, total });
    return {
      dims: [nx, ny, nz],
      data,
      origin: plan.origin.slice(),
      stepX: plan.stepX.slice(),
      stepY: plan.stepY.slice(),
      stepZ: plan.stepZ.slice(),
      spacing: plan.spacing.slice(),
      info: {
        seriesId,
        description: s.info.description,
        kernel: s.info.kernel,
        bodyPart: s.info.bodyPart,
        kvp: Number.isFinite(s.kvp) ? s.kvp : null,
        sliceThickness: s.info.sliceThickness,
        numSlices: nz,
        warnings: s.info.warnings.slice(),
      },
    };
  }
}

function mostCommon(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  let best = '', n = -1;
  for (const [v, c] of m) if (c > n) { best = v; n = c; }
  return best || '';
}
const round4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
