// End-to-end check of the built site in headless Chromium (manual: `npm run e2e`; needs Playwright on NODE_PATH).
//   node test/e2e/run.mjs [screenshot-dir]
// Covers: nothing leaves the page; all six study types on synthetic phantoms; a real DICOM radiograph with planted
// identifiers going through anonymising intake; landmark placement by clicking; muscle outlines; exports.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { makePhantom } from '../../src/sample/xray-phantom.js';
import { xray, PHI_STRINGS } from '../dicom/xr-helpers.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const shots = process.argv[2] || null;
if (shots) mkdirSync(shots, { recursive: true });
const { server, url } = await serve('dist');
const browser = await chromium.launch();
const problems = [];
let step = 0;
const ok = (msg) => console.log(`  ok ${++step} - ${msg}`);

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith(url) && !u.startsWith('blob:') && !u.startsWith('data:')) problems.push(`external request: ${u}`); });
  await page.goto(url);
  return page;
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const loaded = (page, n = 1) => page.waitForFunction((k) => window.__rsa && window.__rsa.state.items.length >= k && !window.__rsa.state.loadingName, n, { timeout: 120000 });
const results = (page) => page.evaluate(() => Object.fromEntries(window.__rsa.assess().results.map((r) => [r.id, { v: r.value, s: r.status, t: r.text }])));

try {
  // ── the page itself ──
  {
    const page = await newPage();
    const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
    assert.match(csp, /connect-src 'none'/);
    const blocked = await page.evaluate(async () => { try { await fetch('https://example.com/'); return false; } catch { return true; } });
    assert.ok(blocked, 'fetch to another origin must be refused by the page policy');
    await shot(page, '00-intro');
    await page.close();
    problems.length = 0;   // the refused fetch logs a console error by design
    ok('the page policy refuses outgoing connections');
  }

  // ── six study types on synthetic phantoms ──
  for (const [implant, modality, proto] of [['reverse', 'xray', 'rsa-ap'], ['pyc', 'xray', 'pyc-ap'], ['native', 'xray', 'native-ap'], ['reverse', 'ct', 'rsa-ct'], ['pyc', 'ct', 'pyc-ct'], ['native', 'ct', 'native-ct']]) {
    const page = await newPage();
    await page.click(`.type[data-implant="${implant}"]`);
    await page.click(`[data-sample="${modality}"]`);
    await loaded(page);
    const b = await page.evaluate(() => { const x = window.__rsa.assess(); return { id: x.protocol.id, auto: Object.entries(x.ctx.state).filter(([, v]) => v === 'auto').map(([k]) => k) }; });
    assert.equal(b.id, proto);
    assert.ok(b.auto.includes(implant === 'reverse' ? 'gs' : 'head'), `${proto}: implant / head detected automatically`);
    await shot(page, `${proto}-1-detected`);
    await page.click('#btn-demo');
    const r = await results(page);
    const pending = Object.entries(r).filter(([, x]) => x.s === 'pending').map(([k]) => k);
    const allowed = { 'native-ap': ['rsaAngle', 'osteophyte', 'dti', 'laa', 'atd', 'hara', 'shara'], 'rsa-ap': ['dwa'], 'pyc-ap': ['schOX', 'schOY', 'shara'] }[proto] || [];
    assert.deepEqual(pending.filter((k) => !allowed.includes(k)), [], `${proto}: everything measurable is measured`);
    if (proto === 'rsa-ap') {
      await page.selectOption('#cal-size', '38');
      const q = await results(page);
      assert.ok(Math.abs(q.gsApparent.v - 38) < 0.6, 'glenosphere diameter recovered');
      assert.ok(q.lsa.v > 40 && q.lsa.v < 130 && q.dsa.v > 10 && q.dsa.v < 100);
      // arm position normalised to vertical: HARA still reported as taken, DSA/LSA re-measured on the rotated humerus
      await page.click('[data-neutral="vertical"]');
      const nb = await page.evaluate(() => { const b = window.__rsa.assess(); return b.neutral && { ok: b.neutral.ok, deg: b.neutral.deg, note: b.appraisal.caveats.some((c) => /normalised/.test(c)) }; });
      assert.ok(nb && nb.ok && Math.abs(nb.deg) > 1 && nb.note, 'arm position normalised');
      const qn = await results(page);
      assert.ok(Math.abs(qn.hara.v - q.hara.v) < 1e-6, 'HARA reported as taken');
      assert.ok(Math.abs(qn.dsa.v - q.dsa.v) > 0.5, 'DSA re-measured');
      await shot(page, 'rsa-ap-neutral');
      await page.click('[data-neutral="off"]');
    }
    if (proto === 'native-ap') {
      // the scapular Y-view protocol: four clicks give posterior acromial height, tilt and coverage
      await page.selectOption('#view', 'y');
      assert.equal(await page.evaluate(() => window.__rsa.assess().protocol.id), 'native-y');
      const im = await page.evaluate(() => ({ w: window.__rsa.state.items[0].image.width, h: window.__rsa.state.items[0].image.height }));
      await page.click('#btn-fit');
      const pts = { yc: [0.5, 0.35], ia: [0.5, 0.75], pa: [0.42, 0.25], aa: [0.58, 0.22] };
      for (const [id, [fx, fy]] of Object.entries(pts)) {
        await page.click(`[data-act="lm-place"][data-lm="${id}"]`);
        const sp = await page.evaluate((p) => window.__rsa.screen(p), { x: fx * im.w, y: fy * im.h });
        await page.mouse.click(sp.x, sp.y);
      }
      const y = await results(page);
      assert.ok(y.pah.s !== 'pending' && y.pat.s !== 'pending' && y.pac.s !== 'pending', 'Y-view measurements computed');
      await page.click('[data-tab="measure"]');
      await shot(page, 'native-y-measurements');
      await page.selectOption('#view', 'ap');
      await page.click('[data-tab="landmarks"]');
    }
    if (proto === 'native-ct') {
      const t = await page.evaluate(() => window.__rsa.state.items[0].truth);
      assert.ok(Math.abs(r.version.v - t.versionDeg) < 1, 'version matches the phantom');
      assert.ok(Math.abs(r.subluxScap.v - t.subluxationPct) < 2, 'subluxation matches the phantom');
    }
    if (proto === 'rsa-ct') {
      const t = await page.evaluate(() => window.__rsa.state.items[0].truth);
      assert.ok(Math.abs(r.version.v - t.versionDeg) < 2 && Math.abs(r.tilt.v - t.inclinationDeg) < 2, 'glenosphere version and tilt match the phantom');
    }
    await shot(page, `${proto}-2-landmarks`);
    await page.click('[data-tab="measure"]');
    assert.ok(await page.locator('.m').count() >= 5);
    await shot(page, `${proto}-3-measurements`);
    await page.click('[data-tab="appraisal"]');
    assert.ok((await page.textContent('#appraisal')).length > 200);
    await shot(page, `${proto}-4-appraisal`);
    if (implant === 'native') {
      await page.click('[data-tab="decision"]');
      await page.fill('[data-clin="age"]', '76'); await page.dispatchEvent('[data-clin="age"]', 'change');
      await page.selectOption('[data-clin="cuff"]', 'massive');
      assert.equal(await page.evaluate(() => window.__rsa.decision().verdict), 'reverse');
      await shot(page, `${proto}-5-decision`);
    }
    if (proto === 'native-ct') {
      // outline the deltoid on the axial pane round its known centre and check the fat fraction that comes back
      await page.click('[data-tab="muscle"]');
      const c = await page.evaluate(() => { const m = window.__rsa.state.items[0].truth.muscles.deltoid; window.__rsa.ctCursor(m.center); return m; });
      await page.click('[data-act="roi"][data-muscle="delt"][data-kind="muscle"]');
      for (const [dx, dy] of [[-4, -4], [4, -4], [4, 4], [-4, 4]]) {
        const p = await page.evaluate(([w, a, b]) => window.__rsa.ctScreen('axial', [w[0] + a, w[1] + b, w[2]]), [c.center, dx, dy]);
        await page.mouse.click(p.x, p.y);
      }
      await page.keyboard.press('Enter');
      const roi = await page.evaluate(() => { const x = window.__rsa.state.items[0].rois[0]; return x && { n: x.stats.n, fat: x.stats.fatFraction, mean: x.stats.meanHU }; });
      assert.ok(roi && roi.n > 20, 'outline captured');
      assert.ok(Math.abs(roi.fat - c.fatFraction) < 0.12, `deltoid fat fraction ${roi.fat} vs ${c.fatFraction}`);
      await shot(page, `${proto}-6-muscle`);
    }
    const text = await page.evaluate(() => window.__rsa.reportText());
    assert.match(text, /RAW DATA/); assert.match(text, /REFERENCES/);
    const csv = await page.evaluate(() => window.__rsa.csv());
    assert.ok(csv.split('\r\n').length > 6);
    await page.close();
    ok(`${proto}: detection, measurement, appraisal and export`);
  }

  // ── a DICOM radiograph with planted identifiers, opened through the file picker ──
  {
    const ph = makePhantom({ kind: 'reverse', side: 'L', seed: 5 });
    const { width, height, data } = ph.image;
    let mn = Infinity, mxv = -Infinity;
    for (const v of data) { if (v < mn) mn = v; if (v > mxv) mxv = v; }
    const px = new Uint16Array(width * height);
    for (let i = 0; i < px.length; i++) px[i] = Math.round(((data[i] - mn) / (mxv - mn)) * 4095);
    const bytes = xray({ rows: height, cols: width, pixels: px, bits: 16, bitsStored: 12, modality: 'DX', description: 'SHOULDER AP MUSTERMANN',
      extra: [['00181164', 'DS', '0.22\\0.22'], ['00181114', 'DS', '1.1'], ['00200062', 'CS', 'L'], ['00185101', 'CS', 'AP']] });
    const dir = join(tmpdir(), `rsa-e2e-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'MUSTERMANN_ERIKA_shoulder.dcm');
    writeFileSync(file, bytes);
    const page = await newPage();
    await page.setInputFiles('#in-files', file);
    await loaded(page);
    const info = await page.evaluate(() => { const it = window.__rsa.state.items[0]; const b = window.__rsa.assess(); return { det: it.det.kind, mm: b.scale.mm, src: b.scale.source, gs: b.ctx.L.gs, side: it.lateralSign, report: window.__rsa.state.report }; });
    assert.equal(info.det, 'reverse');
    assert.ok(Math.abs(info.mm - 0.2) < 1e-6, 'imager pixel spacing divided by the magnification factor');
    assert.ok(Math.abs(info.gs.r - ph.truth.glenosphere.r) < 2.5);
    assert.equal(info.side, 1, 'left shoulder: humerus on the right of the image');
    assert.ok(info.report.totalElementsDiscarded > 10);
    // nothing identifying anywhere the page can show or export
    const dump = await page.evaluate(() => {
      const s = window.__rsa.state;
      const strip = (k, v) => (ArrayBuffer.isView(v) ? undefined : v);
      return document.documentElement.outerHTML + JSON.stringify(s, strip) + window.__rsa.reportText() + window.__rsa.csv() + JSON.stringify(window.__rsa.json());
    });
    for (const phi of [...PHI_STRINGS, 'shoulder.dcm']) assert.ok(!dump.toUpperCase().includes(phi.toUpperCase()), `identifier "${phi}" leaked`);
    // place a landmark by clicking: the acromion at a known pixel
    const target = { x: ph.truth.acr[0], y: ph.truth.acr[1] };
    await page.click('[data-act="lm-place"][data-lm="acr"]');
    const sp = await page.evaluate((p) => window.__rsa.screen(p), target);
    await page.mouse.click(sp.x, sp.y);
    const placed = await page.evaluate(() => window.__rsa.assess().ctx.L.acr);
    assert.ok(Math.hypot(placed.x - target.x, placed.y - target.y) < 1.5, 'a click lands on the pixel under the pointer');
    // drag it 30 px and check it follows
    await page.mouse.move(sp.x, sp.y); await page.mouse.down(); await page.mouse.move(sp.x + 12, sp.y + 9, { steps: 4 }); await page.mouse.up();
    const moved = await page.evaluate(() => window.__rsa.assess().ctx.L.acr);
    assert.ok(Math.hypot(moved.x - placed.x, moved.y - placed.y) > 5, 'a dragged landmark moves');
    // correcting the implant re-places the bony landmarks that are still estimates
    const before = await page.evaluate(() => { const b = window.__rsa.assess(); return { gs: b.ctx.L.gs, sgt: b.ctx.L.sgt, st: b.ctx.state.sgt }; });
    if (before.gs && before.sgt && before.st === 'estimated') {
      const c = await page.evaluate((g) => window.__rsa.screen({ x: g.cx, y: g.cy }), before.gs);
      await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x + 15, c.y + 10, { steps: 5 }); await page.mouse.up();
      const after = await page.evaluate(() => window.__rsa.assess().ctx.L.sgt);
      assert.ok(Math.hypot(after.x - before.sgt.x, after.y - before.sgt.y) > 2, 'estimated landmarks follow a corrected glenosphere');
    }
    await page.selectOption('#cal-size', '38');
    const sc = await page.evaluate(() => window.__rsa.assess().scale);
    assert.equal(sc.source, 'implant');
    await shot(page, 'dicom-xray');
    await page.close();
    ok('DICOM radiograph: anonymised on load, detected, calibrated, landmarks placed by click and drag');
  }

  // ── two films of the same reverse compared; each image keeps its own study type ──
  {
    const dir = join(tmpdir(), `rsa-e2e-cmp-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const files = [5, 9].map((seed, k) => {
      const ph = makePhantom({ kind: 'reverse', side: 'L', seed });
      const { width, height, data } = ph.image;
      let mn = Infinity, mxv = -Infinity;
      for (const v of data) { if (v < mn) mn = v; if (v > mxv) mxv = v; }
      const px = new Uint16Array(width * height);
      for (let i = 0; i < px.length; i++) px[i] = Math.round(((data[i] - mn) / (mxv - mn)) * 4095);
      const f = join(dir, `film${k}.dcm`);
      writeFileSync(f, xray({ rows: height, cols: width, pixels: px, bits: 16, bitsStored: 12, modality: 'DX', extra: [['00181164', 'DS', '0.22\\0.22'], ['00181114', 'DS', '1.1'], ['00200062', 'CS', 'L'], ['00185101', 'CS', 'AP']] }));
      return f;
    });
    const page = await newPage();
    await page.setInputFiles('#in-files', files);
    await loaded(page, 2);
    await page.click('[data-item="1"]');
    assert.ok(await page.isVisible('[data-tab="compare"]'), 'compare tab offered with two AP films');
    await page.click('[data-tab="compare"]');
    await page.fill('[data-cmp="months"]', '12'); await page.dispatchEvent('[data-cmp="months"]', 'change');
    const cmp = await page.evaluate(() => window.__rsa.compare());
    assert.equal(cmp.type, 'followup-reverse');
    assert.ok(cmp.rows.some((r) => r.id === 'lsa') && cmp.rows.some((r) => r.id === 'atd'), 'paired measurements listed');
    assert.ok((await page.locator('table.cmp tbody tr').count()) >= 4);
    await shot(page, 'compare');
    assert.match(await page.evaluate(() => window.__rsa.reportText()), /COMPARISON — earlier/);
    assert.equal(await page.evaluate(() => window.__rsa.json().comparisons.length), 1);
    // add a pre-operative film from the Comparison tab: it joins the study as a native film and is paired
    {
      const ph = makePhantom({ kind: 'native', side: 'L', seed: 3 });
      const { width, height, data } = ph.image;
      let mn = Infinity, mxv = -Infinity;
      for (const v of data) { if (v < mn) mn = v; if (v > mxv) mxv = v; }
      const px = new Uint16Array(width * height);
      for (let i = 0; i < px.length; i++) px[i] = Math.round(((data[i] - mn) / (mxv - mn)) * 4095);
      const f = join(dir, 'preop.dcm');
      writeFileSync(f, xray({ rows: height, cols: width, pixels: px, bits: 16, bitsStored: 12, modality: 'DX', extra: [['00181164', 'DS', '0.22\\0.22'], ['00181114', 'DS', '1.1'], ['00200062', 'CS', 'L'], ['00185101', 'CS', 'AP']] }));
      await page.setInputFiles('#in-preop', f);
      await loaded(page, 3);
      const it = await page.evaluate(() => window.__rsa.state.items.map((i) => ({ implant: i.implant, role: i.role })));
      assert.deepEqual(it[2], { implant: 'native', role: 'preop' });
      const pc = await page.evaluate(() => { const c = window.__rsa.compare(); return { type: c.type, preop: c.preop, match: c.match }; });
      assert.equal(pc.type, 'preop-reverse');
      assert.ok(pc.preop);
      assert.ok(pc.match && pc.match.ok, `arm matched to the pre-op film: ${pc.match && pc.match.reason}`);
      await shot(page, 'comparison-preop');
    }
    // re-type the earlier film as a native shoulder: only that film changes
    await page.click('[data-item="0"]');
    await page.click('#implant [data-implant="native"]');
    const types = await page.evaluate(() => window.__rsa.state.items.map((i) => i.implant));
    assert.deepEqual(types.slice(0, 2), ['native', 'reverse']);
    await page.click('[data-item="1"]');
    assert.equal(await page.evaluate(() => window.__rsa.assess().protocol.id), 'rsa-ap');
    assert.ok(['preop-reverse'].includes(await page.evaluate(() => window.__rsa.compare().type)));
    await page.close();
    ok('two films compared; per-image study type; comparison in the exports');
  }

  assert.deepEqual(problems, [], 'no console errors, page errors or external requests');
  ok('no console errors and no external requests in any scenario');
  console.log(`# e2e passed (${step} checks)`);
} catch (e) {
  console.error('# e2e FAILED:', e.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
