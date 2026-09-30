// Minimal TradingView-style canvas chart engine: stacked panes sharing one time axis,
// crosshair, wheel-zoom, drag-pan, percent-compare mode. No dependencies.
(function () {
  const AXIS_W = 70, TIME_H = 24, PAD_T = 6;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const isN = (v) => v != null && isFinite(v);

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  const money = (v) => {
    const a = Math.abs(v);
    if (a >= 10000) return '$' + (v / 1000).toFixed(a >= 100000 ? 0 : 1) + 'k';
    if (a >= 100) return '$' + Math.round(v).toLocaleString('en-US');
    return '$' + v.toFixed(2);
  };
  const pct = (v) => (v >= 0 ? '+' : '') + v.toFixed(Math.abs(v) >= 100 ? 0 : 1) + '%';
  const plain = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

  class TerminalChart {
    constructor(el, theme) {
      this.el = el;
      this.theme = theme;
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:crosshair';
      el.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.dates = []; this.panes = [];
      this.view = { from: 0, to: 1 };
      this.hover = null;
      this.defaultBars = 180;
      this.ratios = {};   // pane id → user-set height ratio (drag a divider)
      this.yView = {};    // pane id → { zoom, off }  manual price scale (wheel/drag the axis, drag the plot)
      this.scales = [];   // per drawn pane: { id, top, bot, lo, hi, fixed }
      this._bind();
      new ResizeObserver(() => this.resize()).observe(el);
      this.resize();
    }

    setTheme(t) { this.theme = t; this.render(); }

    setData(dates, panes, { keepView = false } = {}) {
      const prevLen = this.dates.length;
      this.dates = dates; this.panes = panes;
      if (!keepView || !prevLen) this.resetView();
      else this._clamp();
      this.render();
    }

    setVisibleBars(n) { this.defaultBars = n; this.resetView(); this.render(); }
    resetView() {
      const n = this.dates.length;
      const bars = Math.min(this.defaultBars, n);
      this.view = { from: Math.max(0, n - bars), to: n + Math.max(2, bars * 0.03) };
    }
    _clamp() {
      const n = this.dates.length;
      let { from, to } = this.view;
      const w = Math.min(Math.max(to - from, 8), n + 20);
      to = Math.min(Math.max(to, w * 0.3), n + w * 0.25);
      from = to - w;
      if (from < -w * 0.25) { from = -w * 0.25; to = from + w; }
      this.view = { from, to };
    }

    resize() {
      const r = this.el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.w = Math.max(50, r.width); this.h = Math.max(50, r.height);
      this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.render();
    }

    // ---------- geometry ----------
    _layout() {
      const plotW = this.w - AXIS_W, total = this.h - TIME_H;
      const rat = (p) => this.ratios[p.id] ?? p.ratio ?? 1;
      const sum = this.panes.reduce((s, p) => s + rat(p), 0) || 1;
      let y = 0;
      this.boxes = this.panes.map((p) => { const h = Math.floor((total * rat(p)) / sum); const b = { x: 0, y, w: plotW, h }; y += h; return b; });
      this.plotW = plotW;
      this.barW = plotW / (this.view.to - this.view.from);
    }
    xOf(i) { return (i - this.view.from + 0.5) * this.barW; }
    iOf(x) { return Math.round(this.view.from + x / this.barW - 0.5); }

    _visibleRange() {
      const n = this.dates.length;
      return [Math.max(0, Math.floor(this.view.from)), Math.min(n - 1, Math.ceil(this.view.to))];
    }

    // ---------- interaction ----------
    _bind() {
      const c = this.canvas;
      let drag = null;
      const at = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      const paneAt = (y) => (this.boxes || []).findIndex((b) => y >= b.y && y < b.y + b.h);
      const divAt = (y) => (this.boxes || []).findIndex((b, k) => k > 0 && Math.abs(y - b.y) <= 4);
      const yv = (id) => (this.yView[id] ||= { zoom: 1, off: 0 });
      const cursorFor = ({ x, y }) => (divAt(y) > 0 ? 'row-resize' : x > this.plotW && y < this.h - 24 ? 'ns-resize' : 'crosshair');

      c.addEventListener('pointerdown', (e) => {
        const p = at(e), dv = divAt(p.y), k = paneAt(p.y);
        if (dv > 0) { // resize the two panes around this divider
          const a = this.panes[dv - 1], b = this.panes[dv];
          const ra = this.ratios[a.id] ?? a.ratio ?? 1, rb = this.ratios[b.id] ?? b.ratio ?? 1;
          drag = { mode: 'div', y: p.y, a, b, ra, rb, ha: this.boxes[dv - 1].h, hb: this.boxes[dv].h };
        } else if (p.x > this.plotW && k >= 0) { // stretch/squash the price scale
          const pid = this.panes[k].id; drag = { mode: 'axis', y: p.y, pid, z0: yv(pid).zoom };
        } else {
          const pid = k >= 0 ? this.panes[k].id : null;
          const sc = this.scales[k];
          drag = { mode: 'pan', x: e.clientX, y: p.y, from: this.view.from, to: this.view.to, pid, off0: pid ? yv(pid).off : 0, h: sc ? sc.bot - sc.top : 1, fixed: sc?.fixed };
        }
        c.setPointerCapture(e.pointerId); c.style.cursor = drag.mode === 'pan' ? 'grabbing' : c.style.cursor;
      });
      c.addEventListener('pointerup', (e) => { const was = drag; drag = null; try { c.releasePointerCapture(e.pointerId); } catch {} c.style.cursor = cursorFor(at(e)); if (was?.mode === 'div' && this.onLayout) this.onLayout(this.ratios); });
      c.addEventListener('pointermove', (e) => {
        const p = at(e);
        if (drag?.mode === 'pan') {
          const d = (e.clientX - drag.x) / this.barW;
          this.view = { from: drag.from - d, to: drag.to - d };
          this._clamp();
          if (drag.pid && !drag.fixed) { const v = yv(drag.pid); v.off = drag.off0 + ((p.y - drag.y) / drag.h) * v.zoom; }
        } else if (drag?.mode === 'axis') {
          yv(drag.pid).zoom = Math.max(0.05, Math.min(20, drag.z0 * Math.exp((p.y - drag.y) * 0.01)));
        } else if (drag?.mode === 'div') {
          const tot = drag.ha + drag.hb, dy = p.y - drag.y;
          const ha = Math.max(40, Math.min(tot - 40, drag.ha + dy)), s = drag.ra + drag.rb;
          this.ratios[drag.a.id] = (s * ha) / tot; this.ratios[drag.b.id] = (s * (tot - ha)) / tot;
        } else c.style.cursor = cursorFor(p);
        this.hover = !drag || drag.mode === 'pan' ? (p.x < this.plotW && p.y < this.h - 24 ? p : null) : null;
        this.render();
      });
      c.addEventListener('pointerleave', () => { if (!drag) { this.hover = null; this.render(); } });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const p = at(e);
        if (p.x > this.plotW) { // wheel over the price axis = zoom that pane's price scale
          const k = paneAt(p.y); if (k < 0) return;
          const v = yv(this.panes[k].id); v.zoom = Math.max(0.05, Math.min(20, v.zoom * Math.exp((e.deltaY || 0) * 0.0015)));
          this.render(); return;
        }
        const x = Math.min(p.x, this.plotW);
        const anchor = this.view.from + x / this.barW;
        const k = Math.exp((e.deltaY || e.deltaX) * 0.0015);
        this.view = { from: anchor - (anchor - this.view.from) * k, to: anchor + (this.view.to - anchor) * k };
        this._clamp();
        this.render();
      }, { passive: false });
      c.addEventListener('dblclick', (e) => { // axis: reset that pane's scale · plot: reset everything
        const p = at(e);
        if (p.x > this.plotW) { const k = paneAt(p.y); if (k >= 0) delete this.yView[this.panes[k].id]; }
        else { this.yView = {}; this.resetView(); }
        this.render();
      });
    }
    resetLayout() { this.ratios = {}; this.yView = {}; this.render(); }
    isManual() { return Object.values(this.yView).some((v) => v.zoom !== 1 || v.off !== 0); }

    // ---------- drawing ----------
    render() {
      if (!this.ctx) return;
      const ctx = this.ctx, T = this.theme;
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.fillStyle = T.bg; ctx.fillRect(0, 0, this.w, this.h);
      if (!this.dates.length || !this.panes.length) {
        ctx.fillStyle = T.muted; ctx.font = `12px ${T.font}`; ctx.fillText('NO DATA', 12, 20); return;
      }
      this._layout();
      const hi = this.hover ? Math.max(0, Math.min(this.dates.length - 1, this.iOf(this.hover.x))) : null;
      this.hoverIdx = hi;
      this.panes.forEach((p, k) => this._drawPane(p, this.boxes[k], hi, k));
      this._drawTimeAxis(hi);
      // right axis separator
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(this.plotW + 0.5, 0); ctx.lineTo(this.plotW + 0.5, this.h); ctx.stroke();
      this.onHover && this.onHover(hi);
    }

    _transform(p, s, i0) {
      if (!p.percent) return (v) => v;
      // Percent mode: rebase each series to its first visible value (TradingView "compare").
      // Overlays (SMA, bands) pass rebaseWith = the closes they derive from, so they share its base.
      const d = s.rebaseWith || s.data;
      const val = (x) => (x && typeof x === 'object' ? x.c : x);
      let base = null;
      for (let i = i0; i < d.length && base == null; i++) { const v = val(d[i]); if (isN(v)) base = v; }
      if (base == null) for (let i = i0; i >= 0 && base == null; i--) { const v = val(d[i]); if (isN(v)) base = v; }
      return (v) => (base ? (v / base - 1) * 100 : null);
    }

    _drawPane(p, b, hi, k) {
      const ctx = this.ctx, T = this.theme;
      const [i0, i1] = this._visibleRange();
      ctx.save();
      ctx.beginPath(); ctx.rect(b.x, b.y, b.w + AXIS_W, b.h); ctx.clip();

      // scales
      const tf = p.series.map((s) => this._transform(p, s, i0));
      let lo = Infinity, hiV = -Infinity;
      p.series.forEach((s, j) => {
        if (s.ownScale) return;
        for (let i = i0; i <= i1; i++) {
          const d = s.data[i];
          if (s.type === 'candle') { if (d) { lo = Math.min(lo, tf[j](d.l)); hiV = Math.max(hiV, tf[j](d.h)); } }
          else if (s.type === 'band') { if (d && isN(d.up)) { lo = Math.min(lo, tf[j](d.lo)); hiV = Math.max(hiV, tf[j](d.up)); } }
          else if (isN(d)) { const v = tf[j](d); lo = Math.min(lo, v); hiV = Math.max(hiV, v); }
        }
      });
      if (p.range) { lo = p.range[0]; hiV = p.range[1]; }
      else if (p.zeroCenter && isFinite(lo)) { const m = Math.max(Math.abs(lo), Math.abs(hiV)); lo = -m; hiV = m; }
      if (!isFinite(lo)) { lo = 0; hiV = 1; }
      if (hiV === lo) { hiV += Math.abs(hiV) * 0.05 || 1; lo -= Math.abs(lo) * 0.05 || 1; }
      const padV = p.range ? 0 : (hiV - lo) * 0.08;
      lo -= padV; hiV += padV;
      const yvw = this.yView[p.id];
      if (yvw && (yvw.zoom !== 1 || yvw.off !== 0)) { // manual price scale: zoom around the centre, shifted by off (in ranges)
        const rng = hiV - lo, mid = (hiV + lo) / 2 + yvw.off * rng, half = (rng / 2) * yvw.zoom;
        lo = mid - half; hiV = mid + half;
      }
      const top = b.y + PAD_T + (k === 0 ? 18 : 14) + (p.extraTop || 0), bot = b.y + b.h - 4;
      this.scales[k] = { id: p.id, top, bot, lo, hi: hiV, fixed: !!p.range };
      const y = (v) => bot - ((v - lo) / (hiV - lo)) * (bot - top);
      const fmt = p.percent ? pct : p.fmt || money;

      // grid + axis labels
      ctx.font = `11px ${T.font}`; ctx.textBaseline = 'middle';
      const step = niceStep(hiV - lo, Math.max(2, Math.floor((bot - top) / 42)));
      for (let v = Math.ceil(lo / step) * step; v <= hiV; v += step) {
        const yy = Math.round(y(v)) + 0.5;
        if (yy < top - 4) continue;
        ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(b.w, yy); ctx.stroke();
        ctx.fillStyle = T.muted; ctx.fillText(fmt(v), b.w + 8, yy);
      }
      (p.levels || []).forEach((lv) => {
        const yy = Math.round(y(lv)) + 0.5;
        ctx.setLineDash([3, 3]); ctx.strokeStyle = T.level; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(b.w, yy); ctx.stroke(); ctx.setLineDash([]);
      });

      // series
      ctx.beginPath(); ctx.rect(0, b.y, b.w, b.h); ctx.save(); ctx.clip();
      p.series.forEach((s, j) => this._drawSeries(s, tf[j], y, i0, i1, b, lo, hiV));
      ctx.restore();

      // pane separator
      if (k > 0) { ctx.strokeStyle = T.sep; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, b.y + 0.5); ctx.lineTo(this.w, b.y + 0.5); ctx.stroke(); }

      // last-value tags on the axis
      p.series.forEach((s, j) => {
        if (!s.tag) return;
        let li = -1; for (let i = Math.min(i1, s.data.length - 1); i >= 0; i--) { const d = s.data[i]; if (s.type === 'candle' ? d : isN(d)) { li = i; break; } }
        if (li < 0) return;
        const raw = s.type === 'candle' ? s.data[li].c : s.data[li];
        const v = tf[j](raw); if (!isN(v)) return;
        this._axisTag(b, y(v), fmt(v), s.color, T.tagText);
      });

      // crosshair
      if (hi != null) {
        const x = Math.round(this.xOf(hi)) + 0.5;
        ctx.setLineDash([4, 4]); ctx.strokeStyle = T.cross; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, b.y); ctx.lineTo(x, b.y + b.h); ctx.stroke();
        if (this.hover && this.hover.y >= b.y && this.hover.y < b.y + b.h) {
          const yy = Math.round(this.hover.y) + 0.5;
          ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(b.w, yy); ctx.stroke();
          ctx.setLineDash([]);
          const v = lo + ((bot - this.hover.y) / (bot - top)) * (hiV - lo);
          this._axisTag(b, yy, fmt(v), T.crossTag, T.crossTagText);
        }
        ctx.setLineDash([]);
      }

      // legend (values at crosshair or last bar)
      this._legend(p, b, hi, tf, fmt, k);
      ctx.restore();
    }

    _drawSeries(s, tf, y, i0, i1, b, lo, hiV) {
      const ctx = this.ctx, T = this.theme, bw = this.barW;
      const a = Math.max(0, i0 - 1), z = Math.min(s.data.length - 1, i1 + 1);
      if (s.type === 'hist') {
        let yy = y, base;
        if (s.ownScale) { // e.g. volume in the bottom 18% of the price pane
          let m = 0; for (let i = a; i <= z; i++) if (isN(s.data[i])) m = Math.max(m, s.data[i]);
          const h = b.h * (s.heightFrac || 0.18), bottom = b.y + b.h - 2;
          yy = (v) => bottom - (m ? (v / m) * h : 0); base = bottom;
        } else base = y(Math.max(lo, Math.min(hiV, 0)));
        const w = Math.max(1, bw * 0.7);
        for (let i = a; i <= z; i++) {
          const v = s.data[i]; if (!isN(v)) continue;
          ctx.fillStyle = s.colorFn ? s.colorFn(v, i) : s.color;
          const y1 = yy(v);
          ctx.fillRect(this.xOf(i) - w / 2, Math.min(y1, base), w, Math.max(1, Math.abs(base - y1)));
        }
        return;
      }
      if (s.type === 'candle') {
        const w = Math.max(1, bw * 0.7);
        for (let i = a; i <= z; i++) {
          const d = s.data[i]; if (!d) continue;
          const up = d.c >= d.o, col = up ? T.up : T.down, x = Math.round(this.xOf(i)) + 0.5;
          ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, y(tf(d.h))); ctx.lineTo(x, y(tf(d.l))); ctx.stroke();
          const yo = y(tf(d.o)), yc = y(tf(d.c));
          ctx.fillRect(x - w / 2, Math.min(yo, yc), w, Math.max(1, Math.abs(yo - yc)));
        }
        return;
      }
      if (s.type === 'dots') {
        ctx.fillStyle = s.color;
        for (let i = a; i <= z; i++) {
          const v = s.data[i]; if (!isN(v)) continue;
          const vv = tf(v); if (!isN(vv)) continue;
          ctx.beginPath(); ctx.arc(this.xOf(i), y(vv), Math.max(1.8, Math.min(3, this.barW * 0.4)), 0, Math.PI * 2); ctx.fill();
        }
        return;
      }
      if (s.type === 'band') {
        ctx.beginPath(); let started = false; const back = [];
        for (let i = a; i <= z; i++) {
          const d = s.data[i]; if (!d || !isN(d.up)) continue;
          const x = this.xOf(i); started ? ctx.lineTo(x, y(tf(d.up))) : (ctx.moveTo(x, y(tf(d.up))), (started = true));
          back.push([x, y(tf(d.lo))]);
        }
        for (let k = back.length - 1; k >= 0; k--) ctx.lineTo(back[k][0], back[k][1]);
        ctx.closePath(); ctx.fillStyle = s.fill; ctx.fill();
        return;
      }
      // line / area
      ctx.lineWidth = s.width || 1.5; ctx.strokeStyle = s.color; ctx.setLineDash(s.dash || []); ctx.lineJoin = 'round';
      ctx.beginPath(); let started = false, firstX = null, lastX = null;
      for (let i = a; i <= z; i++) {
        const raw = s.data[i]; if (!isN(raw)) { if (s.gaps) started = false; continue; }
        const v = tf(raw); if (!isN(v)) continue;
        const x = this.xOf(i), yy = y(v);
        if (!started) { ctx.moveTo(x, yy); started = true; if (firstX == null) firstX = x; } else ctx.lineTo(x, yy);
        lastX = x;
      }
      ctx.stroke(); ctx.setLineDash([]);
      if (s.type === 'area' && firstX != null) {
        ctx.lineTo(lastX, b.y + b.h); ctx.lineTo(firstX, b.y + b.h); ctx.closePath();
        const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
        g.addColorStop(0, s.fillTop); g.addColorStop(1, s.fillBottom);
        ctx.fillStyle = g; ctx.fill();
      }
    }

    _axisTag(b, yy, text, bg, fg) {
      const ctx = this.ctx, T = this.theme;
      if (yy < b.y || yy > b.y + b.h) return;
      ctx.font = `11px ${T.font}`;
      ctx.fillStyle = bg; ctx.fillRect(b.w + 1, yy - 9, AXIS_W - 2, 18);
      ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.fillText(text, b.w + 8, yy);
    }

    _legend(p, b, hi, tfs, fmt, k) {
      const ctx = this.ctx, T = this.theme;
      let x = 8; const yy = b.y + PAD_T + (k === 0 ? 7 : 5);
      ctx.textBaseline = 'middle';
      if (p.title) { ctx.font = `600 ${k === 0 ? 12 : 11}px ${T.font}`; ctx.fillStyle = T.text; ctx.fillText(p.title, x, yy); x += ctx.measureText(p.title).width + 12; }
      ctx.font = `11px ${T.font}`;
      p.series.forEach((s, j) => {
        if (!s.label) return;
        const tf = tfs[j];
        let idx = hi;
        if (idx == null) { idx = -1; for (let i = Math.min(this._visibleRange()[1], s.data.length - 1); i >= 0; i--) { const d = s.data[i]; if (s.type === 'candle' || s.type === 'band' ? d : isN(d)) { idx = i; break; } } }
        const d = idx >= 0 ? s.data[idx] : null;
        let val = '';
        if (s.type === 'candle') val = d ? `O ${fmt(tf(d.o))}  H ${fmt(tf(d.h))}  L ${fmt(tf(d.l))}  C ${fmt(tf(d.c))}` : '—';
        else if (s.type === 'band') val = d && isN(d.up) ? `${fmt(tf(d.lo))} – ${fmt(tf(d.up))}` : '—';
        else if (s.ownScale) val = isN(d) ? plain(d) : '—';
        else val = isN(d) && isN(tf(d)) ? (s.fmt || fmt)(tf(d)) : '—';
        const txt = `${s.label} ${val}`;
        ctx.fillStyle = s.color || s.fill; ctx.fillRect(x, yy - 4, 8, 8);
        ctx.fillStyle = T.muted; ctx.fillText(txt, x + 12, yy);
        x += ctx.measureText(txt).width + 24;
      });
    }

    _drawTimeAxis(hi) {
      const ctx = this.ctx, T = this.theme, yTop = this.h - TIME_H;
      ctx.fillStyle = T.bg; ctx.fillRect(0, yTop, this.w, TIME_H);
      ctx.strokeStyle = T.sep; ctx.beginPath(); ctx.moveTo(0, yTop + 0.5); ctx.lineTo(this.w, yTop + 0.5); ctx.stroke();
      ctx.font = `11px ${T.font}`; ctx.textBaseline = 'middle'; ctx.fillStyle = T.muted;
      const [i0, i1] = this._visibleRange();
      let lastX = -1e9, prev = null;
      const dayMode = this.barW > 7;
      for (let i = i0; i <= i1; i++) {
        const d = this.dates[i]; const m = d.slice(0, 7);
        const x = this.xOf(i);
        let label = null;
        if (m !== prev && prev != null) label = d.slice(5, 7) === '01' ? d.slice(0, 4) : MONTHS[+d.slice(5, 7) - 1];
        else if (dayMode && x - lastX > 64) label = String(+d.slice(8, 10));
        prev = m;
        if (label && x - lastX > 52 && x < this.plotW - 10) { ctx.fillText(label, x - ctx.measureText(label).width / 2, yTop + TIME_H / 2); lastX = x; }
      }
      if (hi != null) {
        const d = this.dates[hi], txt = `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} '${d.slice(2, 4)}`;
        const w = ctx.measureText(txt).width + 14, x = Math.min(Math.max(this.xOf(hi) - w / 2, 0), this.plotW - w);
        ctx.fillStyle = T.crossTag; ctx.fillRect(x, yTop + 2, w, TIME_H - 4);
        ctx.fillStyle = T.crossTagText; ctx.fillText(txt, x + 7, yTop + TIME_H / 2);
      }
    }
  }

  window.TerminalChart = TerminalChart;
  window.TerminalChart.fmt = { money, pct, plain };
})();
