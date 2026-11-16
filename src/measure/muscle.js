// Muscle analysis on CT: a re-implementation of published, threshold-based methods. No segmentation model is used —
// no openly redistributable rotator-cuff model exists (the Terrier / Taghizadeh code and weights are unpublished and
// the TotalSegmentator shoulder-muscle weights are licence-gated), so the outlines are drawn by the user.
//
//   Tissue classes by attenuation (Aubrey 2014):   fat −190…−30 HU · low-attenuation muscle −29…+29 · normal muscle +30…+150
//   Terrier 2017 (Y-view through the spinoglenoid notch):   muscle −29…+166 HU, fat < −29, bone > +166
//     atrophy       Ra = (S − outlined muscle area) / S        S = premorbid muscle area (the fossa / expected outline)
//     infiltration  Ri = fat area inside the muscle / S
//     degeneration  Rd = (S − effective muscle area) / S       effective = outlined muscle minus fat minus bone

export const HU = { airMax: -191, fatMin: -190, fatMax: -30, lowMax: 29, normalMax: 150, terrierMuscleMax: 166 };

export const MUSCLES = [
  { id: 'ss', label: 'Supraspinatus', short: 'SS', premorbid: 'Supraspinatus fossa (premorbid outline)', where: 'Y-view: above the scapular spine.' },
  { id: 'is', label: 'Infraspinatus', short: 'IS', premorbid: 'Infraspinatus premorbid outline', where: 'Y-view: behind the scapular body, below the spine.' },
  { id: 'ssc', label: 'Subscapularis', short: 'SSC', premorbid: 'Subscapularis premorbid outline', where: 'Y-view: in front of the scapular body.' },
  { id: 'tm', label: 'Teres minor', short: 'TM', premorbid: 'Teres minor premorbid outline', where: 'Y-view: the small belly below the infraspinatus, along the lateral border.' },
  { id: 'delt', label: 'Deltoid', short: 'Delt', premorbid: null, where: 'Axial view at the level of the glenoid centre: the shell around the humeral head.' },
];

/** Mean fat fraction by Goutallier grade measured in 3D on 102 CTs (Werthel 2022) — group means, NOT thresholds. */
export const WERTHEL_FI = [0.9, 2.9, 11.4, 20.7, 29.3];

/** Thomazeau 1996 occupation ratio group means. */
export const OCCUPATION_MEANS = { controls: 0.70, degenerative: 0.62, tears: 0.44 };

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(a) / 2;
}

/** HU values of the raster pixels whose centres lie inside the polygon. raster = { width, height, data }. */
export function sampleRoi(raster, poly) {
  if (!poly || poly.length < 3) return new Float32Array(0);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(raster.width - 1, Math.ceil(x1)); y1 = Math.min(raster.height - 1, Math.ceil(y1));
  const out = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) if (pointInPolygon(x, y, poly)) out.push(raster.data[y * raster.width + x]);
  }
  return Float32Array.from(out);
}

/** Tissue statistics of a set of HU samples; pixelArea in mm² per sample. */
export function roiStats(values, pixelArea = 1) {
  const n = values.length;
  let fat = 0, low = 0, normal = 0, dense = 0, air = 0, sum = 0, sum2 = 0, mSum = 0, mN = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    sum += v; sum2 += v * v;
    if (v < HU.fatMin) air++;
    else if (v <= HU.fatMax) fat++;
    else if (v <= HU.lowMax) low++;
    else if (v <= HU.terrierMuscleMax) normal++;
    else dense++;
    if (v > HU.fatMax && v <= HU.terrierMuscleMax) { mSum += v; mN++; }
  }
  const tissue = fat + low + normal;   // soft tissue inside the outline (air and bone/metal excluded)
  const mean = n ? sum / n : NaN;
  return {
    n,
    areaMm2: n * pixelArea,
    meanHU: mean,
    sdHU: n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : NaN,
    muscleMeanHU: mN ? mSum / mN : NaN,          // mean attenuation of the non-fat muscle tissue
    fatFraction: tissue ? fat / tissue : NaN,     // intramuscular fat as a share of the soft tissue in the outline
    lowFraction: tissue ? low / tissue : NaN,
    normalFraction: tissue ? normal / tissue : NaN,
    denseFraction: n ? dense / n : NaN,
    fatAreaMm2: fat * pixelArea,
    effectiveAreaMm2: (low + normal) * pixelArea, // Terrier's Sm: muscle tissue only
    counts: { air, fat, low, normal, dense },
  };
}

/** Terrier ratios from a muscle outline and its premorbid outline (both as roiStats results). */
export function terrierRatios(muscle, premorbid) {
  const S = premorbid.areaMm2;
  if (!(S > 0)) return null;
  return {
    occupation: muscle.areaMm2 / S,
    atrophy: Math.max(0, 1 - muscle.areaMm2 / S),
    infiltration: muscle.fatAreaMm2 / S,
    degeneration: Math.max(0, 1 - muscle.effectiveAreaMm2 / S),
  };
}

/** Index (0–4) of the Goutallier grade whose published mean fat fraction is closest to `fatPct`. */
export function nearestGoutallier(fatPct) {
  let best = 0;
  for (let g = 1; g < WERTHEL_FI.length; g++) if (Math.abs(WERTHEL_FI[g] - fatPct) < Math.abs(WERTHEL_FI[best] - fatPct)) best = g;
  return best;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * Graded results for one muscle, in the same shape as protocol metric results so they flow into the same tables,
 * colour coding and report. `m` = MUSCLES entry, `stats` = roiStats of the muscle outline, `pre` = roiStats of the
 * premorbid outline or null.
 */
export function muscleResults(m, stats, pre) {
  const out = [];
  const base = { group: `Muscle — ${m.label}`, missing: [], provisional: false, needsScale: false, gauge: null, bands: null };
  if (!stats || !stats.n) return out;
  const fatPct = stats.fatFraction * 100;
  const g = nearestGoutallier(fatPct);
  let status, tag, say;
  if (g <= 1) {
    status = 'good'; tag = 'Low';
    say = `Intramuscular fat is low — closest to the mean of Goutallier grade ${g} muscles (${WERTHEL_FI[g]}%).`;
  } else if (g === 2) {
    status = 'borderline'; tag = 'Moderate';
    say = `Moderate fatty infiltration — closest to the mean of Goutallier grade 2 muscles (${WERTHEL_FI[2]}%).`;
  } else {
    status = 'out'; tag = 'Advanced';
    say = `Advanced fatty infiltration — closest to the mean of Goutallier grade ${g} muscles (${WERTHEL_FI[g]}%).`;
    if (m.id === 'tm') say += ' After a reverse arthroplasty, a teres minor at grade 3–4 lost external rotation (−7°) where a better one gained it (+9°).';
    if (m.id === 'is' || m.id === 'ss') say += ' A cuff muscle in this state will not recover with repair and cannot be relied on to centre an anatomic replacement.';
    if (m.id === 'delt') say += ' Deltoid fat correlated with poorer scores after reverse arthroplasty in small series.';
  }
  out.push({
    ...base, id: `${m.id}-fat`, label: `${m.label} — fat fraction`, unit: '%', value: fatPct, text: `${fatPct.toFixed(1)}%`, status, tag, say,
    target: '', evidence: 'pragmatic', refs: ['aubrey2014', 'werthel2022', 'goutallier1994', ...(m.id === 'tm' ? ['simovitch2007tm'] : []), ...(m.id === 'delt' ? ['wiater2015'] : [])],
    what: 'Share of the soft tissue inside the outline that has fat attenuation (−190 to −30 HU).',
    caveat: 'The grade comparison uses group means measured in 3D over whole muscles; this is one slice, so treat the grade as approximate. No validated fat-fraction cut-off per Goutallier grade exists. Do not use a contrast-enhanced or metal-degraded slice.',
    gauge: { min: 0, max: 40 },
    bands: [{ upTo: 7.15, status: 'good' }, { upTo: 16.05, status: 'borderline' }, { status: 'out' }],
  });
  out.push({
    ...base, id: `${m.id}-hu`, label: `${m.label} — mean attenuation`, unit: 'HU', value: stats.meanHU, text: `${stats.meanHU.toFixed(0)} HU`,
    status: 'info', tag: stats.meanHU >= 30 ? 'Normal range' : 'Low',
    say: stats.meanHU >= 30
      ? 'Mean attenuation is within the normal-muscle range (+30 to +150 HU).'
      : 'Mean attenuation is below +30 HU, the low-attenuation range that reflects fat within and between the fibres.',
    target: '', evidence: 'descriptive', refs: ['aubrey2014'],
    what: `Mean of all ${stats.n} pixels in the outline (SD ${stats.sdHU.toFixed(0)} HU). Low-attenuation muscle makes up ${pct(stats.lowFraction)} of the tissue, normal-attenuation muscle ${pct(stats.normalFraction)}.`,
    caveat: 'Attenuation depends on tube voltage, contrast and reconstruction kernel; compare like with like.',
  });
  out.push({
    ...base, id: `${m.id}-area`, label: `${m.label} — cross-sectional area`, unit: 'cm²', value: stats.areaMm2 / 100, text: `${(stats.areaMm2 / 100).toFixed(1)} cm²`,
    status: 'info', tag: '', say: m.id === 'delt'
      ? 'Larger deltoids correlated with better scores after reverse arthroplasty in small MRI series; there is no cut-off.'
      : 'Recorded for comparison between scans or sides; there is no absolute normal value.',
    target: '', evidence: 'descriptive', refs: m.id === 'delt' ? ['wiater2015'] : ['terrier2017'],
    what: `Area inside the outline; ${(stats.effectiveAreaMm2 / 100).toFixed(1)} cm² of it is muscle tissue (fat and bone excluded).`,
    caveat: 'Depends on which slice is used.',
  });
  if (pre && pre.n) {
    const t = terrierRatios(stats, pre);
    if (t) {
      const occ = t.occupation;
      const isSS = m.id === 'ss';
      out.push({
        ...base, id: `${m.id}-occ`, label: isSS ? 'Supraspinatus — occupation ratio' : `${m.label} — area / premorbid outline`, unit: 'ratio', value: occ, text: occ.toFixed(2),
        status: occ >= 0.6 ? 'good' : occ >= 0.4 ? 'borderline' : 'out',
        tag: occ >= 0.6 ? 'Preserved' : occ >= 0.4 ? 'Moderate atrophy' : 'Severe atrophy',
        say: isSS
          ? `The muscle fills ${pct(occ)} of its fossa. Published means: 0.70 in controls, 0.62 in degenerative cuffs, 0.44 with tears.`
          : `The muscle fills ${pct(occ)} of its premorbid outline.`,
        target: isSS ? '≥ 0.6' : '', evidence: 'pragmatic', refs: ['thomazeau1996', 'terrier2017'],
        what: 'Outlined muscle area divided by the premorbid outline (for the supraspinatus: its fossa — the Thomazeau occupation ratio).',
        caveat: 'The 0.6 and 0.4 limits are the commonly quoted Thomazeau stages; they were defined on MRI and were not verified against the original paper.',
        gauge: { min: 0, max: 1 }, bands: [{ upTo: 0.4, status: 'out' }, { upTo: 0.6, status: 'borderline' }, { status: 'good' }],
      });
      out.push({
        ...base, id: `${m.id}-deg`, label: `${m.label} — degeneration (Terrier)`, unit: '%', value: t.degeneration * 100, text: pct(t.degeneration),
        status: 'info', tag: '',
        say: `Atrophy ${pct(t.atrophy)} and fatty infiltration ${pct(t.infiltration)} of the premorbid area. In 107 osteoarthritic shoulders the mean degeneration was 36% for supraspinatus, 16% infraspinatus, 17% teres minor and 11% subscapularis — and almost all of it was atrophy, not fat.`,
        target: '', evidence: 'descriptive', refs: ['terrier2017'],
        what: 'Share of the premorbid muscle area that is no longer muscle tissue: (premorbid area − muscle tissue area) / premorbid area.',
        caveat: 'The reference values are from arthritic shoulders, not healthy ones, and depend on how the premorbid outline is drawn.',
      });
    }
  }
  return out;
}
