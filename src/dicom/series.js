// Series geometry analysis: sorting, de-duplication, multi-phase handling, spacing regularity, tilt, scoring.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const median = (arr) => { const s = [...arr].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r = (v, p) => Math.round(v / p) * p;
export const vec = { sub, add, scale, dot, cross, norm, unit };

export function orientationOf(normal) {
  const a = normal.map(Math.abs);
  const m = Math.max(a[0], a[1], a[2]);
  if (m < Math.cos((30 * Math.PI) / 180)) return 'oblique';
  if (m === a[2]) return 'axial';
  if (m === a[1]) return 'coronal';
  return 'sagittal';
}

/**
 * Analyse the slices of one series group.
 * slices: [{ fileIdx, frame, ipp, iop, ps, thickness, slope, intercept, sliceLocation, instanceNumber,
 *            acquisitionNumber, stackPos, order }]
 * Returns { ok: true, plan } or { ok: false, reason }.
 * plan: { slices (sorted, kept), nz, origin, stepX, stepY, stepZ, spacing, sliceSpacing, orientation,
 *         resample: null | { srcPos: number[], gridPos: number[] }, warnings, tiltDeg, normal }
 */
export function analyseSeries(slices, hdr) {
  const warnings = [];
  const first = slices[0];
  let iop = first.iop;
  const ps = first.ps || [1, 1];
  if (!first.ps) warnings.push('pixel spacing missing — assumed 1 mm');
  const havePos = slices.every((s) => s.ipp);
  if (!iop) {
    iop = [1, 0, 0, 0, 1, 0];
    if (havePos) warnings.push('image orientation missing — assumed axial');
  }
  const rowDir = unit(iop.slice(0, 3));
  const colDir = unit(iop.slice(3, 6));
  const normal = unit(cross(rowDir, colDir));
  const stepX = scale(rowDir, ps[1]);
  const stepY = scale(colDir, ps[0]);

  let list = slices.slice();
  let positions;           // patient-space position vector of each slice (in list order)
  let synthesized = false;
  if (havePos) {
    for (const s of list) s.d = dot(s.ipp, normal);
  } else {
    // Fallback ordering: SliceLocation, else stack position / instance number.
    synthesized = true;
    const useLoc = list.every((s) => Number.isFinite(s.sliceLocation));
    const sp = hdr.spacingBetween > 0 ? hdr.spacingBetween : (first.thickness > 0 ? first.thickness : 1);
    const ord = (s) => (Number.isFinite(s.stackPos) ? s.stackPos : (s.instanceNumber ?? 0) * 100000 + s.frame);
    if (useLoc) {
      for (const s of list) s.d = s.sliceLocation;
      warnings.push('slice positions missing — ordered by slice location; geometry approximate');
    } else {
      list.sort((a, b) => ord(a) - ord(b) || a.order - b.order);
      list.forEach((s, i) => { s.d = i * sp; });
      warnings.push('slice positions missing — ordered by instance number; geometry approximate');
    }
    const base = useLoc ? [0, 0, 0] : [0, 0, 0];
    for (const s of list) s.ipp = add(base, scale(normal, s.d));
  }

  // ---- multi-phase / multi-acquisition stacks at the same positions: keep the first acquisition ----
  const posKey = (s) => Math.round(s.d / 0.005);
  const acqs = new Map();
  for (const s of list) {
    const a = Number.isFinite(s.acquisitionNumber) ? s.acquisitionNumber : 0;
    if (!acqs.has(a)) acqs.set(a, []);
    acqs.get(a).push(s);
  }
  if (acqs.size > 1 && acqs.size < list.length / 2) {
    const groups = [...acqs.entries()].sort((a, b) => a[0] - b[0]);
    const sets = groups.map(([, g]) => new Set(g.map(posKey)));
    let overlapping = false;
    for (let i = 0; i < sets.length && !overlapping; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        let common = 0;
        for (const k of sets[i]) if (sets[j].has(k)) common++;
        if (common > 0.5 * Math.min(sets[i].size, sets[j].size)) { overlapping = true; break; }
      }
    }
    if (overlapping) {
      const keep = groups[0][1];
      const dropped = list.length - keep.length;
      list = keep;
      warnings.push(`multiple acquisitions/phases at the same positions — kept the first (${dropped} slices ignored)`);
    }
  }

  // ---- sort along the normal, drop duplicates ----
  list.sort((a, b) => a.d - b.d || (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0) || a.frame - b.frame || a.order - b.order);
  const kept = [];
  let dups = 0;
  for (const s of list) {
    if (kept.length && Math.abs(s.d - kept[kept.length - 1].d) < 0.005) { dups++; continue; }
    kept.push(s);
  }
  if (dups) warnings.push(`${dups} duplicate slice${dups > 1 ? 's' : ''} ignored`);
  const n = kept.length;
  if (n < 2) return { ok: false, reason: 'only one distinct slice position' };

  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push(kept[i].d - kept[i - 1].d);
  const med = median(gaps);
  if (!(med > 1e-4)) return { ok: false, reason: 'slice spacing could not be determined' };
  // very large gaps (separate stacks, e.g. two scan ranges): split instead of interpolating across nothing
  const bigGap = Math.max(10, 5 * med);
  if (!synthesized && gaps.some((g) => g > bigGap)) {
    const chunks = [[kept[0]]];
    let maxGap = 0;
    for (let i = 1; i < n; i++) {
      if (gaps[i - 1] > bigGap) { chunks.push([]); maxGap = Math.max(maxGap, gaps[i - 1]); }
      chunks[chunks.length - 1].push(kept[i]);
    }
    return { ok: false, split: chunks, gapMm: maxGap, warnings };
  }
  const irregular = gaps.some((g) => Math.abs(g - med) > 0.1 * med);
  const span = kept[n - 1].d - kept[0].d;
  let nz = n;
  let resample = null;
  let sliceSpacing = span / (n - 1);
  if (irregular) {
    nz = Math.max(2, Math.round(span / med) + 1);
    sliceSpacing = span / (nz - 1);
    const srcPos = kept.map((s) => s.d);
    const gridPos = [];
    for (let k = 0; k < nz; k++) gridPos.push(kept[0].d + k * sliceSpacing);
    resample = { srcPos, gridPos };
    const missing = gaps.filter((g) => g > 1.5 * med).length;
    warnings.push(missing
      ? `irregular slice spacing (${missing} gap${missing > 1 ? 's' : ''} / missing slices) — resampled to ${sliceSpacing.toFixed(2)} mm`
      : `irregular slice spacing — resampled to ${sliceSpacing.toFixed(2)} mm`);
  }
  const origin = kept[0].ipp.slice();
  const stepZ = scale(sub(kept[n - 1].ipp, kept[0].ipp), 1 / (nz - 1));
  // in-plane drift check: slices that do not lie on a straight line
  let tiltDeg = (Math.acos(Math.min(1, Math.abs(dot(unit(stepZ), normal)))) * 180) / Math.PI;
  if (tiltDeg > 0.5) warnings.push(`gantry tilt ${tiltDeg.toFixed(1)}° — geometry corrected`);
  else tiltDeg = 0;

  // consistency of in-plane positions (non-linear shear) — warn only
  if (!synthesized && n > 2) {
    const dir = sub(kept[n - 1].ipp, kept[0].ipp);
    let maxDev = 0;
    for (const s of kept) {
      const t = (s.d - kept[0].d) / (span || 1);
      const exp = add(kept[0].ipp, scale(dir, t));
      maxDev = Math.max(maxDev, norm(sub(s.ipp, exp)));
    }
    if (maxDev > Math.max(ps[0], ps[1])) warnings.push('slices are not aligned on a straight line — geometry approximate');
  }

  // varying rescale is fine (handled per slice); varying pixel spacing is not expected (grouping key)
  const thickness = first.thickness;
  if (sliceSpacing > 2.5) warnings.push('thick slices — model will look stepped');
  if (Number.isFinite(thickness) && thickness > sliceSpacing * 1.6 && thickness > 1.5) {
    warnings.push(`slice thickness ${thickness.toFixed(1)} mm exceeds spacing`);
  }

  return {
    ok: true,
    plan: {
      slices: kept, nz, origin, stepX, stepY, stepZ, sliceSpacing, normal, resample, warnings, tiltDeg,
      spacing: [norm(stepX), norm(stepY), norm(stepZ)],
      orientation: orientationOf(normal),
    },
  };
}

// ------------------------------- kernel / scoring -------------------------------

/** 2 = bone/sharp, 1 = lung, 0 = standard/unknown, -1 = soft/smooth */
export function kernelSharpness(kernel) {
  const k = (kernel || '').toUpperCase().trim();
  if (!k) return 0;
  if (/BONE|SHARP|EDGE|DETAIL|ULTRA|HIGH ?RES|HR\b|YC|YD|\bY?[DEL]\b/.test(k)) {
    if (/\bL\b/.test(k) && !/BONE|SHARP/.test(k)) return 1;
    return 2;
  }
  if (/\bB[RV]?[6-9]\d|\bU[RL]?[6-9]\d|\bQR[6-9]\d|\bHR[6-9]\d|\bI[RV][6-9]\d|\bD[6-9]\d/.test(k)) return 2;
  if (/\bFC(\d+)/.test(k)) {
    const v = Number(k.match(/\bFC(\d+)/)[1]);
    if (v >= 30 && v < 50) return 2;
    if (v >= 50 && v < 60) return 1;
    if (v >= 80) return 2;
    return 0;
  }
  if (/LUNG|\bB[RL]?5\d|\bI[RV]?5\d/.test(k)) return 1;
  if (/SOFT|SMOOTH|STANDARD|STND|BRAIN|\bB[RV]?[1-3]\d|\bFC0\d|\bFC1\d|\bFC2\d|\b[ABC]\b/.test(k)) return -1;
  return 0;
}

export function scoreSeries(info, imageType) {
  let s = 1000;
  s -= 200 * Math.min(info.sliceSpacing, 10);                   // strongest: thin slices
  s -= 20 * Math.min(Math.max(info.pixelSpacing[0], info.pixelSpacing[1]), 2);
  s += Math.min(info.extentMm[2], 300) / 10;                   // coverage (≤ 30)
  s += Math.min(info.numSlices, 1000) / 50;                    // more slices (≤ 20)
  const it = imageType || [];
  const derived = it.some((x) => /DERIVED|SECONDARY|MPR|REFORMAT|PROJECTION|MIP|CURVED/.test(x));
  if (derived) s -= 60;
  else if (it[0] === 'ORIGINAL' && it[1] === 'PRIMARY') s += 10;
  if (info.orientation !== 'axial') s -= 20;
  s += 8 * kernelSharpness(info.kernel);
  if (!info.supported) s -= 10000;
  return Math.round(s * 100) / 100;
}

export { median };
