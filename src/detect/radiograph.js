// Automatic detection and landmarking of one radiograph — the single entry point used by the app's worker and by
// the evaluation harness, so both run exactly the same code.
import * as xdet from './xray.js';
import { autoLandmarks, nativeLandmarks } from './auto.js';
import { findShaft } from './shaft.js';
import { traceCortex } from './cortex.js';
import { frames as learnedFrames, placeLearned } from './learned.js';
import MODEL from './model.json' with { type: 'json' };

/**
 * Automatic detection and landmarking of a radiograph. Never throws: a failed detection just means manual placement.
 * Implants go through the real-film pipeline (../detect/auto.js); a shoulder with no implant falls back to the
 * gradient-voted humeral head circle, from which the bony landmarks are estimated.
 */
export function detectXray(image, opts = {}) {
  const img = { width: image.width, height: image.height, data: image.data };
  const out = { kind: 'unknown', confidence: 0, reverse: null, head: null, stem: null, side: null, metalFraction: 0, estimates: {}, error: null };
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'mask' || ArrayBuffer.isView(v) ? undefined : v)));
  try {
    const mmPerPx = image.pixelSpacing && image.pixelSpacing.mm > 0 ? image.pixelSpacing.mm : undefined;
    // opts.implant is the study type the reader chose: 'reverse', 'pyc' (any humeral head replacement) or 'native'
    const implant = opts.implant === 'reverse' ? 'reverse' : opts.implant === 'native' ? 'native' : opts.implant ? 'hemi' : undefined;
    out.implant = opts.implant || null;
    const a = implant === 'native' ? null : autoLandmarks(img, { mmPerPx, implant, axisMode: opts.axisMode, headFinder: (im) => xdet.detectHead(im) });
    if (a) {
      // cortices traced along the stem: canal widths, and the bone outline shown when the arm is normalised
      try {
        const R = a.reverse ? a.reverse.glenosphere.r : a.head ? a.head.r : 0;
        if (a.stem && R > 0) {
          const tr = traceCortex(img, a.stem, R, { metal: true, levels: { canalM: 0.3, canalD: 0.85 } });
          if (tr) {
            const pid = a.reverse ? 'rsa-ap' : 'pyc-ap';
            const est = (a.estimates && a.estimates[pid]) || {};
            for (const [id, l] of Object.entries(tr.canal)) est[id] = l;
            a.humerus = { outline: tr.outline, metal: tr.metal };
          }
        }
      } catch { /* canal lines stay as estimated */ }
      return strip({ ...out, ...a });
    }
    // no implant: native shoulder
    // native heads fill anything from a tenth (whole shoulder film) to a third (tight crop) of the short side
    const head = xdet.detectHead(img, { mmPerPx, frLo: 0.06, frHi: 0.34 });
    if (head) {
      out.kind = 'native'; out.confidence = 0.3 + 0.5 * (head.score || 0); out.head = head;
      // lateral is the side of the head with less bone and tissue beyond it
      const side = (sg) => { let s = 0, k = 0; for (let t = 1.5; t <= 3; t += 0.25) { const x = Math.round(head.cx + sg * t * head.r), y = Math.round(head.cy); if (x >= 0 && x < img.width) { s += img.data[y * img.width + x]; k++; } } return k ? s / k : -Infinity; };
      const L = opts.lateralSign || (side(1) < side(-1) ? 1 : -1);
      out.side = L > 0 ? 'right-of-glenoid' : 'left-of-glenoid';
      try { out.estimates['native-ap'] = nativeLandmarks(img, head, L); } catch { out.estimates['native-ap'] = {}; }
      // learned positions relative to the head (where the model beat the hand-written estimate in testing)
      try {
        const F = MODEL.types && MODEL.types.native ? learnedFrames({ centre: [head.cx, head.cy], r: head.r }, L) : null;
        if (F) Object.assign(out.estimates['native-ap'], placeLearned(img, F, MODEL.types.native));
      } catch { /* keep the hand-written estimates */ }
      try {
        const sh = findShaft(img, head);
        if (sh) {
          out.estimates['native-ap'].hcl = { a: sh.a, b: sh.b, confidence: sh.confidence };
          const tr = traceCortex(img, { a: sh.a, b: sh.b }, head.r, { metal: false, from: 0, to: 1 });
          if (tr) out.humerus = { outline: tr.outline, metal: [[], []] };
        }
      } catch { /* no shaft line: placed by hand */ }
    }
  } catch (e) {
    out.error = 'Automatic detection failed on this image; place the landmarks by hand.';
  }
  return strip(out);
}

