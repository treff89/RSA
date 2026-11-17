// ImageView: one canvas showing a greyscale raster (a radiograph, or a CT reformat) with zoom / pan / window-level,
// draggable landmark handles and measurement overlays. It knows nothing about protocols: the app hands it
// `handles` and `shapes` in raster pixel coordinates and receives clicks and drags back.

const HIT = 13;          // handle hit radius, CSS px
const DRAG_START = 4;    // movement before a press counts as a drag, CSS px

export class ImageView {
  constructor(container, opts = {}) {
    this.el = container;
    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.opts = { wheel: 'zoom', loupe: true, ...opts };
    this.raster = null;                 // { width, height, data }
    this.win = { center: 0.5, width: 1 };
    this.invert = false;
    this.bitmap = document.createElement('canvas');   // raster rendered with the current window
    this.bitmapDirty = true;
    this.view = { scale: 1, tx: 0, ty: 0 };            // screen = image * scale + t
    this.fitted = true;
    this.handles = [];
    this.shapes = [];
    this.armed = false;                 // true while the next click places something
    this.cursorPt = null;               // image-space pointer position (for the loupe and rubber bands)
    this.rubber = null;                 // optional function(pt) -> shapes drawn while placing
    this.pointers = new Map();
    this.drag = null;
    this.onPlace = null; this.onClick = null; this.onHandleDrag = null; this.onHandleDown = null;
    this.onScroll = null; this.onWindow = null; this.onViewChange = null; this.onHover = null;
    this._raf = 0;
    this._bind();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    this._resize();
  }

  destroy() {
    this._ro.disconnect();
    cancelAnimationFrame(this._raf);
    this.canvas.remove();
  }

  // ───────────── content ─────────────
  setRaster(raster, win) {
    const sizeChanged = !this.raster || this.raster.width !== raster.width || this.raster.height !== raster.height;
    this.raster = raster;
    if (win) this.win = { ...win };
    this.bitmapDirty = true;
    if (sizeChanged || this.fitted) this.fit();
    else this.draw();
  }

  setWindow(center, width) {
    this.win = { center, width: Math.max(width, 1e-6) };
    this.bitmapDirty = true;
    this.draw();
  }

  setInvert(on) { this.invert = !!on; this.bitmapDirty = true; this.draw(); }

  setOverlay({ handles, shapes }) {
    if (handles) this.handles = handles;
    if (shapes) this.shapes = shapes;
    this.draw();
  }

  setArmed(on, rubber = null) {
    this.armed = !!on;
    this.rubber = rubber;
    this.canvas.style.cursor = on ? 'crosshair' : '';
    this.draw();
  }

  fit() {
    if (!this.raster) return;
    const w = this.cssW, h = this.cssH;
    const s = Math.min(w / this.raster.width, h / this.raster.height) * 0.98;
    this.view = { scale: s, tx: (w - this.raster.width * s) / 2, ty: (h - this.raster.height * s) / 2 };
    this.fitted = true;
    this.draw();
  }

  /** Centre the view on an image point, optionally at a minimum zoom. */
  centerOn(p, minScale) {
    if (minScale && this.view.scale < minScale) this.view.scale = minScale;
    this.view.tx = this.cssW / 2 - p.x * this.view.scale;
    this.view.ty = this.cssH / 2 - p.y * this.view.scale;
    this.fitted = false;
    this.draw();
  }

  toImage(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (cx - r.left - this.view.tx) / this.view.scale, y: (cy - r.top - this.view.ty) / this.view.scale };
  }

  toScreen(p) { return { x: p.x * this.view.scale + this.view.tx, y: p.y * this.view.scale + this.view.ty }; }

  // ───────────── events ─────────────
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e, true));
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.cursorPt = null; this.draw(); } });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', (e) => { if (!this.armed && !this._handleAt(e)) this.fit(); });
    c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
  }

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _handleAt(e) {
    const p = this._local(e);
    let best = null, bd = HIT * HIT;
    for (const h of this.handles) {
      if (h.fixed) continue;
      const s = this.toScreen(h);
      const d = (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
      if (d <= bd) { bd = d; best = h; }
    }
    return best;
  }

  _down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus({ preventScroll: true });
    this.pointers.set(e.pointerId, this._local(e));
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), view: { ...this.view }, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      return;
    }
    const p = this._local(e);
    // while a landmark is being placed, a click places it even if it lands on an existing handle
    const h = e.button === 0 && !this.armed ? this._handleAt(e) : null;
    if (h) {
      const s = this.toScreen(h);
      this.drag = { kind: 'handle', key: h.key, off: { x: s.x - p.x, y: s.y - p.y }, moved: false, start: p };
      if (this.onHandleDown) this.onHandleDown(h.key);
    } else if (e.button === 2 || e.button === 1 || e.shiftKey) {
      this.drag = { kind: e.button === 1 ? 'pan' : 'window', start: p, view: { ...this.view }, win: { ...this.win }, moved: false };
    } else {
      this.drag = { kind: 'pan', start: p, view: { ...this.view }, moved: false, click: true };
    }
  }

  _move(e) {
    const p = this._local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    this.cursorPt = this.toImage(e.clientX, e.clientY);
    const d = this.drag;
    if (!d) {
      if (this.onHover) this.onHover(this.cursorPt);
      if (this.armed) this.draw();
      else this.canvas.style.cursor = this._handleAt(e) ? 'grab' : '';
      return;
    }
    if (d.kind === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const k = Math.hypot(a.x - b.x, a.y - b.y) / (d.d0 || 1);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this._zoomTo(d.view, d.mid, k, mid);
      return;
    }
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_START) return;
    d.moved = true;
    if (d.kind === 'handle') {
      const pt = { x: (p.x + d.off.x - this.view.tx) / this.view.scale, y: (p.y + d.off.y - this.view.ty) / this.view.scale };
      this.cursorPt = pt;
      if (this.onHandleDrag) this.onHandleDrag(d.key, pt, 'move');
      this.draw();
    } else if (d.kind === 'pan') {
      this.view.tx = d.view.tx + dx; this.view.ty = d.view.ty + dy;
      this.fitted = false;
      this.draw();
      if (this.onViewChange) this.onViewChange();
    } else if (d.kind === 'window') {
      const range = this.raster ? Math.max(1e-6, (this.raster.max ?? 1) - (this.raster.min ?? 0)) : 1;
      const width = Math.max(range / 2000, d.win.width * Math.exp(dx / 250));
      const center = d.win.center - (dy / 500) * range;
      this.setWindow(center, width);
      if (this.onWindow) this.onWindow(this.win);
    }
  }

  _up(e, cancelled) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'pinch') { if (this.pointers.size < 2) this.drag = null; return; }
    this.drag = null;
    if (cancelled) { this.draw(); return; }
    if (d.kind === 'handle') {
      if (d.moved && this.onHandleDrag) this.onHandleDrag(d.key, this.cursorPt, 'end');
      else if (!d.moved && this.onClick) this.onClick(this.toImage(e.clientX, e.clientY), d.key);
    } else if (d.kind === 'pan' && d.click && !d.moved) {
      const pt = this.toImage(e.clientX, e.clientY);
      if (this.armed && this.onPlace) this.onPlace(pt);
      else if (this.onClick) this.onClick(pt, null);
    }
    this.draw();
  }

  _zoomTo(base, anchorScreen, k, newAnchor = anchorScreen) {
    const s = Math.max(0.02, Math.min(40, base.scale * k));
    const ix = (anchorScreen.x - base.tx) / base.scale, iy = (anchorScreen.y - base.ty) / base.scale;
    this.view = { scale: s, tx: newAnchor.x - ix * s, ty: newAnchor.y - iy * s };
    this.fitted = false;
    this.draw();
    if (this.onViewChange) this.onViewChange();
  }

  _wheel(e) {
    e.preventDefault();
    if (this.opts.wheel === 'scroll' && !e.ctrlKey && !e.metaKey) {
      if (this.onScroll) this.onScroll(e.deltaY > 0 ? 1 : -1, e);
      return;
    }
    const p = this._local(e);
    this._zoomTo(this.view, p, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
  }

  zoomBy(k) { this._zoomTo(this.view, { x: this.cssW / 2, y: this.cssH / 2 }, k); }

  // ───────────── drawing ─────────────
  _resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.cssW = Math.max(1, r.width); this.cssH = Math.max(1, r.height);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    if (this.fitted) this.fit(); else this.draw();
  }

  _renderBitmap() {
    const r = this.raster;
    const b = this.bitmap;
    if (b.width !== r.width || b.height !== r.height) { b.width = r.width; b.height = r.height; }
    const g = b.getContext('2d');
    const img = g.createImageData(r.width, r.height);
    const out = new Uint32Array(img.data.buffer);
    const lo = this.win.center - this.win.width / 2, k = 255 / this.win.width;
    const d = r.data, n = r.width * r.height, inv = this.invert;
    for (let i = 0; i < n; i++) {
      let v = (d[i] - lo) * k;
      v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
      if (inv) v = 255 - v;
      out[i] = 0xff000000 | (v << 16) | (v << 8) | v;
    }
    g.putImageData(img, 0, 0);
    this.bitmapDirty = false;
  }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _draw() {
    const g = this.ctx, dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.raster) return;
    if (this.bitmapDirty) this._renderBitmap();
    const v = this.view;
    g.imageSmoothingEnabled = v.scale < 3;
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.bitmap, v.tx, v.ty, this.raster.width * v.scale, this.raster.height * v.scale);
    this._drawOverlay(g, (p) => this.toScreen(p), v.scale, 1);
    if (this.opts.loupe && this.cursorPt && (this.armed || (this.drag && this.drag.kind === 'handle' && this.drag.moved))) this._drawLoupe(g);
  }

  /** Draw shapes and handles through a projection `S` (image → target px). `k` scales line widths and fonts. */
  _drawOverlay(g, S, scale, k) {
    const shapes = this.rubber && this.cursorPt && this.armed ? [...this.shapes, ...(this.rubber(this.cursorPt) || [])] : this.shapes;
    for (const s of shapes) this._shape(g, s, S, scale, k);
    for (const h of this.handles) this._handle(g, h, S, k);
  }

  _shape(g, s, S, scale, k) {
    g.save();
    g.strokeStyle = s.color || '#f0a23b';
    g.fillStyle = s.color || '#f0a23b';
    g.globalAlpha = s.alpha ?? 0.95;
    g.lineWidth = (s.width || 1.6) * k;
    g.setLineDash(s.dash ? [6 * k, 5 * k] : []);
    g.lineCap = 'round';
    if (s.type === 'line' || s.type === 'dim') {
      let a = S(s.a), b = S(s.b);
      if (s.extend) {
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, e = Math.max(40 * k, 0.6 * l);
        a = { x: a.x - (dx / l) * e, y: a.y - (dy / l) * e }; b = { x: b.x + (dx / l) * e, y: b.y + (dy / l) * e };
      }
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      if (s.type === 'dim') {
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, t = 5 * k;
        const nx = (-dy / l) * t, ny = (dx / l) * t;
        g.setLineDash([]);
        g.beginPath(); g.moveTo(a.x - nx, a.y - ny); g.lineTo(a.x + nx, a.y + ny); g.moveTo(b.x - nx, b.y - ny); g.lineTo(b.x + nx, b.y + ny); g.stroke();
      }
      if (s.label) this._label(g, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, s.label, s.color, k);
    } else if (s.type === 'circle') {
      const c = S(s.c);
      g.beginPath(); g.arc(c.x, c.y, Math.max(0, s.r * scale), 0, Math.PI * 2); g.stroke();
      if (s.cross) {
        const t = 5 * k;
        g.setLineDash([]);
        g.beginPath(); g.moveTo(c.x - t, c.y); g.lineTo(c.x + t, c.y); g.moveTo(c.x, c.y - t); g.lineTo(c.x, c.y + t); g.stroke();
      }
    } else if (s.type === 'arc') {
      const c = S(s.c), a = S(s.a), b = S(s.b);
      let a0 = Math.atan2(a.y - c.y, a.x - c.x), a1 = Math.atan2(b.y - c.y, b.x - c.x);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const r = Math.min(34 * k, 0.35 * Math.min(Math.hypot(a.x - c.x, a.y - c.y), Math.hypot(b.x - c.x, b.y - c.y)));
      g.setLineDash([]);
      g.beginPath(); g.arc(c.x, c.y, r, a0, a0 + d, d < 0); g.stroke();
      if (s.label) {
        const m = a0 + d / 2;
        this._label(g, { x: c.x + Math.cos(m) * (r + 16 * k), y: c.y + Math.sin(m) * (r + 16 * k) }, s.label, s.color, k);
      }
    } else if (s.type === 'poly') {
      if (s.pts.length) {
        g.beginPath();
        s.pts.forEach((p, i) => { const q = S(p); if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); });
        if (s.closed) g.closePath();
        if (s.fill) { g.globalAlpha = 0.16; g.fill(); g.globalAlpha = s.alpha ?? 0.95; }
        g.stroke();
        if (s.label) this._label(g, S(s.pts[0]), s.label, s.color, k);
      }
    } else if (s.type === 'text') {
      this._label(g, S(s.p), s.text, s.color, k);
    }
    g.restore();
  }

  _label(g, p, text, color, k) {
    g.save();
    g.setLineDash([]);
    g.globalAlpha = 1;
    g.font = `600 ${12.5 * k}px ui-sans-serif, system-ui, sans-serif`;
    const w = g.measureText(text).width, padX = 5 * k, h = 18 * k;
    const x = p.x - w / 2 - padX, y = p.y - h / 2;
    g.fillStyle = 'rgba(13,17,22,.82)';
    g.beginPath();
    g.roundRect(x, y, w + 2 * padX, h, 5 * k);
    g.fill();
    g.fillStyle = color || '#f0a23b';
    g.textBaseline = 'middle';
    g.fillText(text, x + padX, p.y + 0.5 * k);
    g.restore();
  }

  _handle(g, h, S, k) {
    const p = S(h);
    const r = (h.small ? 4 : 6.5) * k;
    g.save();
    g.globalAlpha = h.ghost ? 0.45 : 1;
    g.lineWidth = 3.4 * k;
    g.strokeStyle = 'rgba(8,10,13,.75)';
    g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.stroke();
    g.lineWidth = (h.active ? 2.6 : 1.8) * k;
    g.strokeStyle = h.color || '#6aa9f2';
    g.setLineDash(h.dashed ? [3 * k, 2.5 * k] : []);
    g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    g.fillStyle = h.color || '#6aa9f2';
    g.beginPath(); g.arc(p.x, p.y, 1.3 * k, 0, Math.PI * 2); g.fill();
    if (h.label) {
      g.font = `600 ${11.5 * k}px ui-sans-serif, system-ui, sans-serif`;
      g.textBaseline = 'middle';
      const tx = p.x + r + 5 * k;
      g.lineWidth = 3 * k; g.strokeStyle = 'rgba(8,10,13,.8)';
      g.strokeText(h.label, tx, p.y);
      g.fillText(h.label, tx, p.y);
    }
    g.restore();
  }

  _drawLoupe(g) {
    const R = 62, Z = Math.max(3, this.view.scale * 2.5);
    const cs = this.toScreen(this.cursorPt);
    // Park the loupe in the corner away from the pointer.
    const cx = cs.x < this.cssW / 2 ? this.cssW - R - 14 : R + 14;
    const cy = cs.y < this.cssH / 2 ? this.cssH - R - 14 : R + 14;
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#000'; g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    g.imageSmoothingEnabled = true;
    const sw = (2 * R) / Z;
    g.drawImage(this.bitmap, this.cursorPt.x - sw / 2, this.cursorPt.y - sw / 2, sw, sw, cx - R, cy - R, 2 * R, 2 * R);
    const S = (p) => ({ x: cx + (p.x - this.cursorPt.x) * Z, y: cy + (p.y - this.cursorPt.y) * Z });
    for (const s of this.shapes) this._shape(g, { ...s, label: undefined }, S, Z, 1);
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx - 10, cy); g.lineTo(cx - 3, cy); g.moveTo(cx + 3, cy); g.lineTo(cx + 10, cy);
    g.moveTo(cx, cy - 10); g.lineTo(cx, cy - 3); g.moveTo(cx, cy + 3); g.lineTo(cx, cy + 10); g.stroke();
    g.restore();
    g.save();
    g.strokeStyle = 'rgba(240,162,59,.9)'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.restore();
  }

  /** Full-resolution canvas of the raster with the overlay burned in (for export). */
  snapshot(maxSide = 2400) {
    if (!this.raster) return null;
    if (this.bitmapDirty) this._renderBitmap();
    const k0 = Math.min(1, maxSide / Math.max(this.raster.width, this.raster.height));
    const c = document.createElement('canvas');
    c.width = Math.round(this.raster.width * k0); c.height = Math.round(this.raster.height * k0);
    const g = c.getContext('2d');
    g.drawImage(this.bitmap, 0, 0, c.width, c.height);
    const k = Math.max(1, c.width / 900);
    const rubber = this.rubber; this.rubber = null;
    this._drawOverlay(g, (p) => ({ x: p.x * k0, y: p.y * k0 }), k0, k);
    this.rubber = rubber;
    return c;
  }
}
