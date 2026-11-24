// Humeral shaft centre line on an AP radiograph of a shoulder without a stem, from the head circle down.
// At a series of levels below the head, a horizontal intensity profile is searched for the shaft: a rising edge
// (soft tissue → lateral or medial cortex) followed, a plausible shaft width later, by a falling edge. The midpoints
// of the best pair at each level are fitted with a robust line. Returns { a, b, confidence } (full-resolution px,
// a proximal) or null.
import { sample, intensitySpan } from './learned.js';

export function findShaft(g, head, opts = {}) {
  const { cx, cy, r } = head;
  if (!(r > 4)) return null;
  const span = intensitySpan(g);
  const step = Math.max(0.5, r / 40);
  const half = Math.round((2.2 * r) / step);
  const pts = [];
  for (let t = 1.1; t <= 5.5; t += 0.1) {
    const y = cy + t * r;
    if (y > g.height - 3) break;
    const v = [];
    for (let i = -half; i <= half; i++) v.push(sample(g, cx + i * step, y));
    // the profile is wide (±2.2 R) and often runs off the film beside a head near the edge: pad with the nearest
    // sample inside the image (a flat run has no gradient, so it adds no edges) rather than dropping the level
    const fin = v.map((x, i) => (Number.isFinite(x) ? i : -1)).filter((i) => i >= 0);
    if (fin.length < v.length / 3) continue;
    for (let i = 0; i < fin[0]; i++) v[i] = v[fin[0]];
    for (let i = fin[fin.length - 1] + 1; i < v.length; i++) v[i] = v[fin[fin.length - 1]];
    // smooth, then central-difference gradient
    const s = v.map((_, i) => (v[Math.max(0, i - 2)] + v[Math.max(0, i - 1)] + v[i] + v[Math.min(v.length - 1, i + 1)] + v[Math.min(v.length - 1, i + 2)]) / 5);
    const d = s.map((_, i) => (i > 1 && i < s.length - 2 ? (s[i + 2] - s[i - 2]) / 4 : 0));
    const minW = Math.round((0.5 * r) / step), maxW = Math.round((1.5 * r) / step);
    let best = null;
    const rises = [], falls = [];
    for (let i = 2; i < d.length - 2; i++) {
      if (d[i] > 0.012 * span && d[i] >= d[i - 1] && d[i] >= d[i + 1]) rises.push(i);
      if (d[i] < -0.012 * span && d[i] <= d[i - 1] && d[i] <= d[i + 1]) falls.push(i);
    }
    for (const i of rises) for (const j of falls) {
      const w = j - i;
      if (w < minW || w > maxW) continue;
      let inside = 0;
      for (let k = i + 1; k < j; k++) inside += s[k];
      inside /= w - 1;
      const outside = (s[Math.max(0, i - 3)] + s[Math.min(s.length - 1, j + 3)]) / 2;
      if (inside - outside < 0.04 * span) continue;
      const mid = (i + j) / 2 - half;
      // the shaft lies below the head, a little lateral of its centre: penalise midpoints far from it
      const off = Math.abs(mid * step) / r;
      const score = (d[i] - d[j]) / span + 0.5 * (inside - outside) / span - 0.15 * off;
      if (!best || score > best.score) best = { score, x: cx + mid * step, w: w * step };
    }
    if (best) pts.push({ x: best.x, y, w: best.w, score: best.score });
  }
  if (pts.length < 4) return null;
  // robust line x = m·y + c (RANSAC over pairs, inliers within 0.1 R and of a consistent width)
  let bestFit = null;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const p = pts[i], q = pts[j];
    if (Math.abs(q.y - p.y) < 0.5 * r) continue;
    const m = (q.x - p.x) / (q.y - p.y);
    if (Math.abs(m) > 0.9) continue;            // within about 42° of vertical
    const c = p.x - m * p.y;
    const inl = pts.filter((u) => Math.abs(u.x - (m * u.y + c)) < 0.08 * r);
    if (inl.length < 4) continue;
    const ws = inl.map((u) => u.w).sort((a, b) => a - b), wm = ws[Math.floor(ws.length / 2)];
    const good = inl.filter((u) => Math.abs(u.w - wm) < 0.3 * wm);
    const sc = good.reduce((s, u) => s + u.score, 0);
    if (good.length >= 4 && (!bestFit || sc > bestFit.sc)) bestFit = { sc, inl: good };
  }
  if (!bestFit) return null;
  // least-squares refit on the inliers
  const I = bestFit.inl, n = I.length;
  const my = I.reduce((s, u) => s + u.y, 0) / n, mx = I.reduce((s, u) => s + u.x, 0) / n;
  const sxy = I.reduce((s, u) => s + (u.y - my) * (u.x - mx), 0), syy = I.reduce((s, u) => s + (u.y - my) ** 2, 0);
  const m = syy > 0 ? sxy / syy : 0, c = mx - m * my;
  const y0 = Math.min(...I.map((u) => u.y)), y1 = Math.max(...I.map((u) => u.y));
  if (y1 - y0 < 0.6 * r) return null;
  // a short visible segment gives a poor direction: say so through the confidence
  const conf = Math.min(0.5, 0.2 + 0.1 * Math.min(1, (y1 - y0) / (2 * r)) + 0.01 * n);
  void opts;
  return { a: [m * y0 + c, y0], b: [m * y1 + c, y1], confidence: conf, inliers: n };
}
