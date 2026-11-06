/* Park Finder — map.js
   Offline trail map: plain metre grid, no map tiles.
   Car at (0,0), +x east, +y north (north is up). Drag to pan, pinch to zoom. */
(function (root) {
  'use strict';

  class TrailMap {
    constructor(canvas) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.scale = 4;          // pixels per metre
      this.cx = 0; this.cy = 0; // world point at canvas centre
      this.auto = true;        // auto-fit until the user pans/zooms
      this.data = { points: [], me: null, waypoints: null, target: -1 };
      this.pointers = new Map();
      this._bind();
      this._resize();
      new ResizeObserver(() => { this._resize(); if (this.auto) this.fit(); this.draw(); }).observe(canvas);
    }

    _css(name, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    }

    _resize() {
      const r = this.c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      this.w = r.width; this.h = r.height; this.dpr = dpr;
      this.c.width = Math.max(1, Math.round(r.width * dpr));
      this.c.height = Math.max(1, Math.round(r.height * dpr));
    }

    _bind() {
      const c = this.c;
      c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
      const end = e => { this.pointers.delete(e.pointerId); this._pinch = null; };
      c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
      c.addEventListener('pointermove', e => {
        if (!this.pointers.has(e.pointerId)) return;
        const prev = this.pointers.get(e.pointerId);
        const cur = { x: e.clientX, y: e.clientY };
        this.pointers.set(e.pointerId, cur);
        if (this.pointers.size === 1) {
          this.auto = false;
          this.cx -= (cur.x - prev.x) / this.scale;
          this.cy += (cur.y - prev.y) / this.scale;
        } else if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (this._pinch) {
            this.auto = false;
            this.scale = Math.max(0.2, Math.min(80, this.scale * d / this._pinch));
          }
          this._pinch = d;
        }
        this.draw();
      });
      c.addEventListener('wheel', e => {
        e.preventDefault(); this.auto = false;
        this.scale = Math.max(0.2, Math.min(80, this.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        this.draw();
      }, { passive: false });
    }

    fit() {
      if (!this.w || !this.h) return;
      const pts = this.data.points.slice();
      pts.push({ x: 0, y: 0 });
      if (this.data.me) pts.push(this.data.me);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
      const pad = 1.25;
      const spanX = Math.max(20, (maxX - minX) * pad), spanY = Math.max(20, (maxY - minY) * pad);
      this.scale = Math.max(0.2, Math.min(80, Math.min(this.w / spanX, this.h / spanY)));
      this.cx = (minX + maxX) / 2; this.cy = (minY + maxY) / 2;
    }

    set(data) { this.data = data; if (this.auto) this.fit(); this.draw(); }
    refit() { this.auto = true; this.fit(); this.draw(); }

    _tx(x) { return (x - this.cx) * this.scale + this.w / 2; }
    _ty(y) { return -(y - this.cy) * this.scale + this.h / 2; }

    /** Pick a tidy grid spacing so lines are ~40–100 px apart. */
    _gridStep() {
      const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
      for (const s of steps) if (s * this.scale >= 40) return s;
      return 2000;
    }

    draw() {
      const g = this.ctx, d = this.data;
      if (!this.w || !this.h) return;
      if (!(this.scale > 0) || !isFinite(this.scale)) { this.scale = 4; this.fit(); }
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, this.w, this.h);

      const line = this._css('--line', '#2b323c');
      const muted = this._css('--muted', '#9aa4b1');
      const accent = this._css('--accent', '#ffc928');
      const blue = this._css('--blue', '#4da3ff');
      const go = this._css('--go', '#3ddc84');
      const text = this._css('--text', '#fff');

      // grid
      const step = this._gridStep();
      g.strokeStyle = line; g.lineWidth = 1;
      const x0 = this.cx - this.w / 2 / this.scale, x1 = this.cx + this.w / 2 / this.scale;
      const y0 = this.cy - this.h / 2 / this.scale, y1 = this.cy + this.h / 2 / this.scale;
      g.beginPath();
      for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { const px = Math.round(this._tx(x)) + .5; g.moveTo(px, 0); g.lineTo(px, this.h); }
      for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { const py = Math.round(this._ty(y)) + .5; g.moveTo(0, py); g.lineTo(this.w, py); }
      g.stroke();
      this.gridStep = step;

      // north marker
      g.fillStyle = muted; g.font = '700 12px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText('N ↑', 22, 18);

      // walked trail
      if (d.points.length > 1) {
        g.lineJoin = 'round'; g.lineCap = 'round';
        g.strokeStyle = blue; g.lineWidth = 4;
        g.beginPath();
        g.moveTo(this._tx(d.points[0].x), this._ty(d.points[0].y));
        for (let i = 1; i < d.points.length; i++) g.lineTo(this._tx(d.points[i].x), this._ty(d.points[i].y));
        g.stroke();
      }

      // retrace waypoints
      if (d.waypoints && d.waypoints.length) {
        g.setLineDash([6, 6]); g.strokeStyle = accent; g.lineWidth = 2;
        g.beginPath();
        d.waypoints.forEach((p, i) => i ? g.lineTo(this._tx(p.x), this._ty(p.y)) : g.moveTo(this._tx(p.x), this._ty(p.y)));
        g.stroke(); g.setLineDash([]);
        d.waypoints.forEach((p, i) => {
          g.beginPath(); g.arc(this._tx(p.x), this._ty(p.y), i === d.target ? 8 : 4, 0, Math.PI * 2);
          g.fillStyle = i === d.target ? accent : muted; g.fill();
        });
      }

      // error circle + me
      if (d.me) {
        const mx = this._tx(d.me.x), my = this._ty(d.me.y);
        const r = Math.max(6, (d.me.sigma || 0) * this.scale);
        g.beginPath(); g.arc(mx, my, r, 0, Math.PI * 2);
        g.fillStyle = 'rgba(77,163,255,.14)'; g.fill();
        g.strokeStyle = 'rgba(77,163,255,.45)'; g.lineWidth = 1; g.stroke();
        if (d.me.heading != null) {
          const a = (d.me.heading - 90) * Math.PI / 180;
          g.beginPath(); g.moveTo(mx, my);
          g.arc(mx, my, 28, a - 0.45, a + 0.45); g.closePath();
          g.fillStyle = 'rgba(77,163,255,.35)'; g.fill();
        }
        g.beginPath(); g.arc(mx, my, 9, 0, Math.PI * 2);
        g.fillStyle = blue; g.fill(); g.lineWidth = 3; g.strokeStyle = text; g.stroke();
      }

      // car
      const cx = this._tx(0), cy = this._ty(0);
      g.beginPath(); g.arc(cx, cy, 17, 0, Math.PI * 2);
      g.fillStyle = accent; g.fill();
      g.fillStyle = '#1a1400'; g.font = '900 16px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('P', cx, cy + 1);
      g.textBaseline = 'alphabetic';
      if (d.me && Math.hypot(d.me.x, d.me.y) < 3) { g.strokeStyle = go; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 22, 0, Math.PI * 2); g.stroke(); }
    }
  }

  root.TrailMap = TrailMap;
})(window);
