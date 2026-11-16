// Multi-planar CT viewer: axial, coronal and sagittal reformats through a shared 3D cursor, plus one free oblique
// pane (used for the scapular Y-view). Every pane is resampled from the HU volume by trilinear interpolation along
// patient axes, so tilted or oblique acquisitions display correctly. All positions exchanged with the app are in
// patient millimetres (LPS: +x left, +y posterior, +z superior).
import { ImageView } from './imageview.js';
import { v3 } from '../measure/geom.js';

export const WINDOWS = {
  bone: { label: 'Bone', center: 500, width: 2200 },
  soft: { label: 'Soft tissue', center: 50, width: 420 },
  metal: { label: 'Metal', center: 1400, width: 6000 },
};

const STD = {
  axial: { title: 'Axial', U: [1, 0, 0], V: [0, 1, 0], N: [0, 0, 1], color: '#6aa9f2' },
  coronal: { title: 'Coronal', U: [1, 0, 0], V: [0, 0, -1], N: [0, 1, 0], color: '#4ecb8f' },
  sagittal: { title: 'Sagittal', U: [0, 1, 0], V: [0, 0, -1], N: [1, 0, 0], color: '#f2c14e' },
};

function invert3(sx, sy, sz) {
  const d = sx[0] * (sy[1] * sz[2] - sy[2] * sz[1]) - sx[1] * (sy[0] * sz[2] - sy[2] * sz[0]) + sx[2] * (sy[0] * sz[1] - sy[1] * sz[0]);
  const m00 = sx[0], m01 = sy[0], m02 = sz[0], m10 = sx[1], m11 = sy[1], m12 = sz[1], m20 = sx[2], m21 = sy[2], m22 = sz[2];
  return [
    (m11 * m22 - m12 * m21) / d, (m02 * m21 - m01 * m22) / d, (m01 * m12 - m02 * m11) / d,
    (m12 * m20 - m10 * m22) / d, (m00 * m22 - m02 * m20) / d, (m02 * m10 - m00 * m12) / d,
    (m10 * m21 - m11 * m20) / d, (m01 * m20 - m00 * m21) / d, (m00 * m11 - m01 * m10) / d,
  ];
}

const dirLetter = (d) => {
  const a = [Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])];
  const i = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
  return [['R', 'L'], ['A', 'P'], ['I', 'S']][i][d[i] > 0 ? 1 : 0];
};

export class Mpr {
  constructor(container, volume) {
    this.el = container;
    this.vol = volume;
    this.inv = invert3(volume.stepX, volume.stepY, volume.stepZ);
    const [nx, ny, nz] = volume.dims;
    this.centre = this.indexToWorld((nx - 1) / 2, (ny - 1) / 2, (nz - 1) / 2);
    this.cursor = this.centre.slice();
    this.win = { ...WINDOWS.bone };
    this.overlay = null;       // (paneId) => { handles, shapes } in pane raster px
    this.onPlace = null; this.onHandleDrag = null; this.onClick = null; this.onCursor = null;
    this.panes = {};
    this.active = 'axial';
    // world-space corners → extent along any direction
    this.corners = [];
    for (const i of [0, nx - 1]) for (const j of [0, ny - 1]) for (const k of [0, nz - 1]) this.corners.push(this.indexToWorld(i, j, k));
    this.minSpacing = Math.min(...volume.spacing);
    container.classList.add('mpr');
    for (const id of ['axial', 'coronal', 'sagittal', 'oblique']) this._makePane(id);
    for (const id of ['axial', 'coronal', 'sagittal']) this._definePane(id, STD[id]);
    this.renderAll();
  }

  destroy() {
    for (const p of Object.values(this.panes)) p.view.destroy();
    this.el.innerHTML = '';
    this.el.classList.remove('mpr');
  }

  indexToWorld(i, j, k) {
    const { origin: o, stepX: a, stepY: b, stepZ: c } = this.vol;
    return [o[0] + i * a[0] + j * b[0] + k * c[0], o[1] + i * a[1] + j * b[1] + k * c[1], o[2] + i * a[2] + j * b[2] + k * c[2]];
  }

  worldToIndex(p) {
    const m = this.inv, o = this.vol.origin;
    const x = p[0] - o[0], y = p[1] - o[1], z = p[2] - o[2];
    return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
  }

  _makePane(id) {
    const el = document.createElement('div');
    el.className = 'pane';
    el.dataset.pane = id;
    const tag = document.createElement('div');
    tag.className = 'pane-tag';
    const hint = document.createElement('div');
    hint.className = 'pane-hint';
    el.append(tag, hint);
    this.el.appendChild(el);
    const view = new ImageView(el, { wheel: 'scroll' });
    const pane = { id, el, tag, hint, view, defined: false };
    view.onScroll = (dir) => this.scroll(id, dir);
    view.onPlace = (pt) => { this.setActive(id); if (this.onPlace) this.onPlace(this.toWorld(pane, pt), id, pt); };
    view.onClick = (pt, key) => {
      this.setActive(id);
      if (this.onClick && this.onClick(this.toWorld(pane, pt), key, id)) return;
      this.setCursor(this.toWorld(pane, pt));
    };
    view.onHandleDrag = (key, pt, phase) => { if (this.onHandleDrag) this.onHandleDrag(key, this.toWorld(pane, pt), phase, id); };
    view.onHandleDown = () => this.setActive(id);
    view.onWindow = (w) => { this.win = { ...w }; for (const q of Object.values(this.panes)) if (q !== pane && q.defined) q.view.setWindow(w.center, w.width); };
    this.panes[id] = pane;
    if (id === 'oblique') hint.textContent = 'Scapular Y-view appears here once the trigonum and the glenoid (or glenosphere) are marked.';
  }

  _definePane(id, def) {
    const pane = this.panes[id];
    const U = v3.unit(def.U), V = v3.unit(def.V), N = v3.unit(def.N);
    const anchor = def.anchor || this.centre;
    let eu = 0, ev = 0, en = 0;
    if (def.fov) { eu = ev = def.fov / 2; }
    for (const c of this.corners) {
      const d = v3.sub(c, anchor);
      if (!def.fov) { eu = Math.max(eu, Math.abs(v3.dot(d, U))); ev = Math.max(ev, Math.abs(v3.dot(d, V))); }
      en = Math.max(en, Math.abs(v3.dot(d, N)));
    }
    const s = Math.max(this.minSpacing, (2 * Math.max(eu, ev)) / 680);
    const w = Math.max(16, Math.round((2 * eu) / s)), h = Math.max(16, Math.round((2 * ev) / s));
    // slice step: the voxel size seen along N
    const sp = this.vol.spacing;
    const ax = [v3.unit(this.vol.stepX), v3.unit(this.vol.stepY), v3.unit(this.vol.stepZ)];
    let step = 0;
    for (let i = 0; i < 3; i++) step += Math.abs(v3.dot(ax[i], N)) * sp[i];
    Object.assign(pane, { U, V, N, anchor, s, w, h, step: Math.max(0.3, step), range: en, title: def.title, color: def.color, defined: true });
    pane.raster = { width: w, height: h, data: new Int16Array(w * h), min: -1024, max: 3071 };
    pane.hint.textContent = '';
    pane.el.style.setProperty('--pane-color', def.color);
    pane.view.fitted = true;
  }

  /** Define (or redefine) the oblique pane. def = { title, U, V, N, anchor, fov } in world mm. */
  setOblique(def) {
    if (!def) return;
    const p = this.panes.oblique;
    const same = p.defined && v3.dot(p.N, v3.unit(def.N)) > 0.99995 && v3.dot(p.U, v3.unit(def.U)) > 0.99995 && v3.dist(p.anchor, def.anchor) < 0.5;
    if (same) return;
    this._definePane('oblique', { color: '#d58cf0', ...def });
    this.render('oblique');
  }

  /** Centre of a pane's raster in world mm: the anchor moved along N onto the plane through the cursor. */
  _planeCentre(pane) {
    return v3.add(pane.anchor, v3.mul(pane.N, v3.dot(v3.sub(this.cursor, pane.anchor), pane.N)));
  }

  toWorld(pane, pt) {
    const c = this._planeCentre(pane);
    const u = (pt.x - (pane.w - 1) / 2) * pane.s, v = (pt.y - (pane.h - 1) / 2) * pane.s;
    return [c[0] + u * pane.U[0] + v * pane.V[0], c[1] + u * pane.U[1] + v * pane.V[1], c[2] + u * pane.U[2] + v * pane.V[2]];
  }

  /** World point → pane raster px plus signed distance from the pane's current plane (mm). */
  toPane(pane, p) {
    const d = v3.sub(p, this._planeCentre(pane));
    return { x: v3.dot(d, pane.U) / pane.s + (pane.w - 1) / 2, y: v3.dot(d, pane.V) / pane.s + (pane.h - 1) / 2, depth: v3.dot(d, pane.N) };
  }

  /** Plane description of a pane at its current position (enough to resample it later for ROI statistics). */
  planeOf(id) {
    const p = this.panes[id];
    return { id, U: p.U.slice(), V: p.V.slice(), N: p.N.slice(), centre: this._planeCentre(p), s: p.s, w: p.w, h: p.h };
  }

  /** Resample an arbitrary plane into an Int16 HU raster. */
  samplePlane(plane, out) {
    const { w, h, s } = plane;
    const data = out || new Int16Array(w * h);
    const [nx, ny, nz] = this.vol.dims;
    const vol = this.vol.data, nxy = nx * ny;
    const c = plane.centre;
    const o = [
      c[0] - ((w - 1) / 2) * s * plane.U[0] - ((h - 1) / 2) * s * plane.V[0],
      c[1] - ((w - 1) / 2) * s * plane.U[1] - ((h - 1) / 2) * s * plane.V[1],
      c[2] - ((w - 1) / 2) * s * plane.U[2] - ((h - 1) / 2) * s * plane.V[2],
    ];
    const i0 = this.worldToIndex(o);
    const m = this.inv;
    const du = [0, 1, 2].map((r) => (m[r * 3] * plane.U[0] + m[r * 3 + 1] * plane.U[1] + m[r * 3 + 2] * plane.U[2]) * s);
    const dv = [0, 1, 2].map((r) => (m[r * 3] * plane.V[0] + m[r * 3 + 1] * plane.V[1] + m[r * 3 + 2] * plane.V[2]) * s);
    let q = 0;
    for (let y = 0; y < h; y++) {
      let fi = i0[0] + y * dv[0], fj = i0[1] + y * dv[1], fk = i0[2] + y * dv[2];
      for (let x = 0; x < w; x++, q++, fi += du[0], fj += du[1], fk += du[2]) {
        if (fi < 0 || fj < 0 || fk < 0 || fi > nx - 1 || fj > ny - 1 || fk > nz - 1) { data[q] = -1024; continue; }
        const i = fi | 0, j = fj | 0, k = fk | 0;
        const i1 = i < nx - 1 ? 1 : 0, j1 = j < ny - 1 ? nx : 0, k1 = k < nz - 1 ? nxy : 0;
        const a = fi - i, b = fj - j, cz = fk - k;
        const p = i + nx * j + nxy * k;
        const c00 = vol[p] + a * (vol[p + i1] - vol[p]);
        const c10 = vol[p + j1] + a * (vol[p + j1 + i1] - vol[p + j1]);
        const c01 = vol[p + k1] + a * (vol[p + k1 + i1] - vol[p + k1]);
        const c11 = vol[p + k1 + j1] + a * (vol[p + k1 + j1 + i1] - vol[p + k1 + j1]);
        const c0 = c00 + b * (c10 - c00), c1 = c01 + b * (c11 - c01);
        data[q] = c0 + cz * (c1 - c0);
      }
    }
    return { width: w, height: h, data, min: -1024, max: 3071 };
  }

  render(id) {
    const pane = this.panes[id];
    if (!pane.defined) return;
    this.samplePlane(this.planeOf(id), pane.raster.data);
    pane.view.setRaster(pane.raster, this.win);
    this.refreshOverlay(id);
  }

  renderAll() { for (const id of Object.keys(this.panes)) this.render(id); }

  refreshOverlays() { for (const id of Object.keys(this.panes)) this.refreshOverlay(id); }

  refreshOverlay(id) {
    const pane = this.panes[id];
    if (!pane.defined) return;
    const shapes = [];
    // crosshair: where the other panes' planes cut this one
    const c = this.toPane(pane, this.cursor);
    const big = 10000;
    for (const other of Object.values(this.panes)) {
      if (other === pane || !other.defined || other.id === 'oblique') continue;
      // direction of the intersection line in this pane = N_other × N_pane, expressed in (U, V)
      const dir = v3.cross(other.N, pane.N);
      const du = v3.dot(dir, pane.U), dv = v3.dot(dir, pane.V);
      const l = Math.hypot(du, dv);
      if (l < 0.2) continue;
      shapes.push({ type: 'line', a: { x: c.x - (du / l) * big, y: c.y - (dv / l) * big }, b: { x: c.x + (du / l) * big, y: c.y + (dv / l) * big }, color: other.color, width: 1, alpha: 0.4 });
    }
    const edge = (dx, dy, dir) => shapes.push({ type: 'text', p: { x: (pane.w - 1) / 2 + dx * (pane.w / 2 - 12), y: (pane.h - 1) / 2 + dy * (pane.h / 2 - 12) }, text: dirLetter(dir), color: '#9aa6b4' });
    edge(-1, 0, v3.mul(pane.U, -1)); edge(1, 0, pane.U); edge(0, -1, v3.mul(pane.V, -1)); edge(0, 1, pane.V);
    const extra = this.overlay ? this.overlay(id, pane) : null;
    pane.view.setOverlay({ handles: extra ? extra.handles : [], shapes: extra ? [...shapes, ...extra.shapes] : shapes });
    const pos = v3.dot(v3.sub(this.cursor, pane.anchor), pane.N);
    pane.tag.textContent = `${pane.title} · ${pos >= 0 ? '+' : ''}${pos.toFixed(1)} mm`;
  }

  setActive(id) {
    this.active = id;
    for (const p of Object.values(this.panes)) p.el.classList.toggle('active', p.id === id);
  }

  setCursor(p, opts = {}) {
    const prev = this.cursor;
    this.cursor = p.slice();
    for (const pane of Object.values(this.panes)) {
      if (!pane.defined) continue;
      const moved = Math.abs(v3.dot(v3.sub(p, prev), pane.N)) > 1e-4;
      if (moved) this.render(pane.id); else this.refreshOverlay(pane.id);
      if (opts.centre) pane.view.centerOn(this.toPane(pane, p));
    }
    if (this.onCursor) this.onCursor(this.cursor);
  }

  scroll(id, dir) {
    const pane = this.panes[id];
    if (!pane.defined) return;
    const pos = v3.dot(v3.sub(this.cursor, pane.anchor), pane.N);
    const next = Math.max(-pane.range, Math.min(pane.range, pos + dir * pane.step));
    this.setCursor(v3.add(this.cursor, v3.mul(pane.N, next - pos)));
  }

  setWindow(name) {
    this.win = { ...WINDOWS[name] };
    for (const p of Object.values(this.panes)) if (p.defined) p.view.setWindow(this.win.center, this.win.width);
  }

  arm(on, rubber) { for (const p of Object.values(this.panes)) if (p.defined) p.view.setArmed(on, rubber ? (pt) => rubber(pt, p.id) : null); }

  /** Trilinear HU at a world point (−1024 outside the volume). */
  sample(p) {
    const [fi, fj, fk] = this.worldToIndex(p);
    const [nx, ny, nz] = this.vol.dims;
    if (fi < 0 || fj < 0 || fk < 0 || fi > nx - 1 || fj > ny - 1 || fk > nz - 1) return -1024;
    const i = Math.min(nx - 2, fi | 0), j = Math.min(ny - 2, fj | 0), k = Math.min(nz - 2, fk | 0);
    const a = fi - i, b = fj - j, c = fk - k, d = this.vol.data, nxy = nx * ny, p0 = i + nx * j + nxy * k;
    const L = (q) => d[q] + a * (d[q + 1] - d[q]);
    const c0 = L(p0) + b * (L(p0 + nx) - L(p0)), c1 = L(p0 + nxy) + b * (L(p0 + nxy + nx) - L(p0 + nxy));
    return c0 + c * (c1 - c0);
  }
}
