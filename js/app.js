// SlabDex app: loads watchlist + price series, builds the chart panes, signals and watchlist.
(function () {
  const $ = (id) => document.getElementById(id);
  const { money, pct } = TerminalChart.fmt;
  const I = window.Ind;

  const state = { key: null, grade: 'psa10', vs: 'index', range: 365, res: 'D', ind: { sma20: 1, sma50: 1, bb: 0, vol: 1, rs: 1, rsi: 1, macd: 1 }, sort: 'score', dir: -1 };
  try { Object.assign(state, JSON.parse(localStorage.getItem('slabdex') || '{}')); } catch (e) {}
  const save = () => { try { localStorage.setItem('slabdex', JSON.stringify(state)); } catch (e) {} };

  let WL = null, SERIES = {}, STATUS = null, chart = null, model = null;

  // ---------- data loading (static JSON from the repo, or an inlined bundle) ----------
  async function load() {
    if (window.__SLABDEX_DATA__) { ({ watchlist: WL, series: SERIES, status: STATUS } = window.__SLABDEX_DATA__); return; }
    const j = (u) => fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    WL = await j('data/watchlist.json');
    STATUS = await j('data/status.json');
    const res = await Promise.all(WL.cards.map((c) => j(`data/prices/${c.key}.json`)));
    WL.cards.forEach((c, i) => { if (res[i]) SERIES[c.key] = res[i]; });
  }

  // ---------- model: one shared daily axis, forward-filled closes, chain-linked index ----------
  function buildModel(grade) {
    const dates = new Set();
    const cards = WL.cards.filter((c) => SERIES[c.key]?.grades?.[grade]?.length);
    cards.forEach((c) => SERIES[c.key].grades[grade].forEach((p) => dates.add(p.t)));
    const axis = fillDays([...dates].sort());
    const pos = new Map(axis.map((d, i) => [d, i]));
    const by = {};
    cards.forEach((c) => {
      const raw = new Array(axis.length).fill(null), vol = new Array(axis.length).fill(null);
      SERIES[c.key].grades[grade].forEach((p) => { const i = pos.get(p.t); raw[i] = p.p; vol[i] = p.v7 ?? null; });
      const first = I.firstIdx(raw);
      const close = I.ffill(raw).map((v, i) => (i < first ? null : v));
      by[c.key] = { card: c, close, vol, demo: SERIES[c.key].source === 'demo' };
    });
    // Equal-weight, chain-linked index (base 100). Cards can join late without distorting it.
    const idx = new Array(axis.length).fill(null);
    let level = 100;
    for (let i = 0; i < axis.length; i++) {
      let s = 0, k = 0;
      for (const key in by) { const a = by[key].close; if (i > 0 && I.isN(a[i]) && I.isN(a[i - 1]) && a[i - 1] > 0) { s += a[i] / a[i - 1]; k++; } }
      if (k) level *= s / k;
      const any = Object.values(by).some((b) => I.isN(b.close[i]));
      idx[i] = any ? level : null;
    }
    return { axis, by, index: idx };
  }
  function fillDays(sorted) { // continuous calendar days so gaps in sales don't compress time
    if (!sorted.length) return [];
    const out = [], end = Date.parse(sorted[sorted.length - 1]);
    for (let t = Date.parse(sorted[0]); t <= end; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }

  function weekly(axis, close, vol) {
    const W = [], C = [], V = [];
    let cur = null;
    axis.forEach((d, i) => {
      const dt = new Date(d + 'T00:00:00Z'); const dow = (dt.getUTCDay() + 6) % 7;
      const wk = new Date(dt.getTime() - dow * 864e5).toISOString().slice(0, 10);
      if (!cur || cur.wk !== wk) { cur = { wk, o: null, h: -Infinity, l: Infinity, c: null, v: 0, vn: 0 }; W.push(wk); C.push(cur); }
      const v = close[i];
      if (I.isN(v)) { if (cur.o == null) cur.o = v; cur.h = Math.max(cur.h, v); cur.l = Math.min(cur.l, v); cur.c = v; }
      if (vol && I.isN(vol[i])) { cur.v += vol[i]; cur.vn++; }
    });
    return { dates: W, ohlc: C.map((x) => (x.o == null ? null : { o: x.o, h: x.h, l: x.l, c: x.c })), close: C.map((x) => x.c), vol: C.map((x) => (x.vn ? (x.v / x.vn) * 7 : null)) };
  }

  // ---------- signals ----------
  function signals(close, vol, bench) {
    const n = I.lastIdx(close);
    const hist = n + 1 - I.firstIdx(close);
    const out = { days: hist };
    if (n < 0) return out;
    const s20 = I.sma(close, 20), s50 = I.sma(close, 50), r = I.rsi(close, 14), m = I.macd(close);
    const last = close[n];
    out.last = last;
    out.c7 = I.chg(close, 7); out.c30 = I.chg(close, 30); out.c90 = I.chg(close, 90); out.c365 = I.chg(close, 365);
    out.rsi = r[n];
    out.macdH = m.hist[n]; out.macdRising = I.isN(m.hist[n]) && I.isN(m.hist[n - 3]) ? m.hist[n] > m.hist[n - 3] : null;
    out.distS50 = I.isN(s50[n]) ? (last / s50[n] - 1) * 100 : null;
    out.trendUp = I.isN(s20[n]) && I.isN(s50[n]) ? s20[n] > s50[n] : null;
    const prior = close.slice(0, n + 1).slice(-365).filter(I.isN);
    out.dd = prior.length ? (last / Math.max(...prior) - 1) * 100 : null;
    out.vol30 = I.volatility(close, 30);
    const c30p = n >= 60 && I.isN(close[n - 30]) && I.isN(close[n - 60]) ? (close[n - 30] / close[n - 60] - 1) * 100 : null;
    out.accel = I.isN(out.c30) && I.isN(c30p) ? out.c30 - c30p : null;
    if (bench) {
      const rs = close.map((v, i) => (I.isN(v) && I.isN(bench[i]) && bench[i] ? v / bench[i] : null));
      out.rs30 = I.chg(rs, 30); out.rs90 = I.chg(rs, 90);
    }
    if (vol) {
      const vv = vol.slice(Math.max(0, n - 29), n + 1).filter(I.isN);
      const now = vol.slice(Math.max(0, n - 6), n + 1).filter(I.isN);
      out.volRatio = vv.length >= 10 && now.length ? now.reduce((a, b) => a + b, 0) / now.length / (vv.reduce((a, b) => a + b, 0) / vv.length || 1) : null;
    }
    // Composite 0–100. Components missing data drop out and the weights renormalise.
    const clamp = (x) => Math.max(0, Math.min(1, x));
    const parts = [
      [15, out.trendUp == null || out.distS50 == null ? null : (out.distS50 > 0 ? 0.6 : 0) + (out.trendUp ? 0.4 : 0)],
      [15, out.c30 == null ? null : clamp(0.5 + out.c30 / 40) * 0.6 + (out.accel > 0 ? 0.4 : 0)],
      [15, out.macdH == null ? null : (out.macdH > 0 ? 0.5 : 0) + (out.macdRising ? 0.5 : 0)],
      [15, out.rsi == null ? null : out.rsi > 78 ? 0 : out.rsi > 68 ? 0.4 : out.rsi >= 50 ? 1 : out.rsi >= 40 ? 0.5 : 0.1],
      [25, out.rs30 == null ? null : clamp(0.5 + out.rs30 / 20)],
      [15, out.volRatio == null ? null : clamp((out.volRatio - 0.8) / 0.8)],
    ];
    const have = parts.filter((p) => p[1] != null);
    if (hist < 60 || have.length < 3) { out.score = null; out.tag = ['NEED ' + Math.max(0, 60 - hist) + 'D HISTORY', 'mid']; return out; }
    const w = have.reduce((s, p) => s + p[0], 0);
    out.score = Math.round((have.reduce((s, p) => s + p[0] * p[1], 0) / w) * 100);
    const ext = (out.distS50 ?? 0) > 25 || (out.rsi ?? 0) > 78;
    out.tag = out.score >= 68 ? (ext ? ['EXTENDED', 'warn'] : ['EARLY STRENGTH', 'good']) : out.score >= 55 ? ['IMPROVING', 'good'] : out.score >= 40 ? ['NEUTRAL', 'mid'] : ['WEAK', 'bad'];
    return out;
  }

  // ---------- theme for the canvas, read from CSS tokens ----------
  function theme() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: v('--bg'), grid: v('--grid'), sep: v('--line'), text: v('--fg'), muted: v('--muted'),
      up: v('--up'), down: v('--down'), level: v('--muted'), cross: v('--muted'),
      crossTag: v('--fg'), crossTagText: v('--bg'), tagText: v('--bg'),
      accent: v('--accent'), warn: v('--warn'), cmp: v('--cmp'), sma20: v('--sma20'), sma50: v('--sma50'),
      font: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
    };
  }
  const alpha = (hex, a) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

  // ---------- render ----------
  function label(c) { return `${c.name} · ${c.set} #${c.number}`; }

  function draw({ keepView = false } = {}) {
    const T = theme();
    const cur = model.by[state.key];
    if (!cur) { chart.setData([], []); return; }
    const vsSeries = state.vs === 'none' ? null : state.vs === 'index' ? { close: model.index, name: 'TCG INDEX' } : model.by[state.vs] ? { close: model.by[state.vs].close, name: model.by[state.vs].card.name } : null;

    let dates = model.axis, close = cur.close, vol = cur.vol, ohlc = null, bench = vsSeries?.close || null;
    if (state.res === 'W') {
      const w = weekly(dates, close, vol); dates = w.dates; close = w.close; vol = w.vol; ohlc = w.ohlc;
      if (bench) bench = weekly(model.axis, bench).close;
    }
    const f = state.res === 'W' ? { s1: 4, s2: 10, bb: 10 } : { s1: 20, s2: 50, bb: 20 }; // weekly ≈ same calendar span
    const percent = !!bench;
    const main = [];
    if (state.ind.bb) { const b = I.bollinger(close, f.bb); main.push({ type: 'band', data: b.up.map((u, i) => ({ up: u, lo: b.lo[i] })), fill: alpha(T.cmp, 0.08), rebaseWith: close, label: 'BB', color: alpha(T.cmp, 0.5) }); }
    if (ohlc) main.push({ type: 'candle', data: ohlc, label: '', tag: true, color: T.accent });
    else main.push({ type: 'area', data: close, color: T.accent, width: 2, fillTop: alpha(T.accent, 0.18), fillBottom: alpha(T.accent, 0), label: state.grade.toUpperCase().replace('PSA', 'PSA '), tag: true });
    if (bench) main.push({ type: 'line', data: bench, color: T.cmp, width: 1.5, label: vsSeries.name, tag: true });
    if (state.ind.sma20) main.push({ type: 'line', data: I.sma(close, f.s1), color: T.sma20, width: 1, label: state.res === 'W' ? 'SMA4W' : 'SMA20', rebaseWith: close });
    if (state.ind.sma50) main.push({ type: 'line', data: I.sma(close, f.s2), color: T.sma50, width: 1, label: state.res === 'W' ? 'SMA10W' : 'SMA50', rebaseWith: close });
    if (state.ind.vol && vol.some(I.isN)) main.push({ type: 'hist', data: vol, ownScale: true, heightFrac: 0.16, color: alpha(T.muted, 0.35), label: state.res === 'W' ? 'SALES/WK' : 'SALES/D' });

    const panes = [{ id: 'main', ratio: 5, percent, title: `${cur.card.name}  ${cur.card.set} #${cur.card.number}`, series: main }];
    if (state.ind.rs && bench) {
      const rs = close.map((v, i) => (I.isN(v) && I.isN(bench[i]) && bench[i] ? v / bench[i] : null));
      const f0 = I.firstIdx(rs); const b0 = f0 >= 0 ? rs[f0] : 1;
      const rsn = rs.map((v) => (I.isN(v) ? (v / b0) * 100 : null));
      panes.push({ id: 'rs', ratio: 1.3, title: `RS vs ${vsSeries.name}`, fmt: (v) => v.toFixed(1), levels: [100], series: [
        { type: 'line', data: rsn, color: T.cmp, width: 1.5, label: 'RS' },
        { type: 'line', data: I.sma(rsn, f.s1), color: T.sma20, width: 1, label: 'MA', fmt: (v) => v.toFixed(1) },
      ] });
    }
    if (state.ind.rsi) panes.push({ id: 'rsi', ratio: 1.2, title: 'RSI 14', range: [0, 100], levels: [30, 50, 70], fmt: (v) => v.toFixed(0), series: [{ type: 'line', data: I.rsi(close, 14), color: T.sma20, width: 1.3, label: 'RSI', fmt: (v) => v.toFixed(1) }] });
    if (state.ind.macd) {
      const m = I.macd(close);
      panes.push({ id: 'macd', ratio: 1.3, title: 'MACD 12 26 9', zeroCenter: true, fmt: (v) => v.toFixed(Math.abs(v) < 10 ? 1 : 0), series: [
        { type: 'hist', data: m.hist, colorFn: (v) => alpha(v >= 0 ? T.up : T.down, 0.6), label: 'HIST', color: T.muted },
        { type: 'line', data: m.line, color: T.cmp, width: 1.2, label: 'MACD' },
        { type: 'line', data: m.signal, color: T.warn || T.accent, width: 1, label: 'SIG' },
      ] });
    }
    chart.theme = T;
    const bars = state.range ? Math.ceil(state.range / (state.res === 'W' ? 7 : 1)) : dates.length;
    chart.defaultBars = bars;
    chart.setData(dates, panes, { keepView });
    $('demoFlag').hidden = !cur.demo && !(state.vs !== 'none' && state.vs !== 'index' && model.by[state.vs]?.demo);
    renderSignal(cur, vsSeries);
  }

  function fmtP(v, d = 1) { return v == null ? '<span class="dim">—</span>' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(d)}%</span>`; }

  function renderSignal(cur, vsSeries) {
    const s = signals(cur.close, cur.vol, vsSeries?.close || model.index);
    $('sigName').textContent = `${cur.card.name} · ${state.grade.toUpperCase()}`;
    $('scoreVal').textContent = s.score == null ? '—' : s.score;
    $('scoreBar').style.width = (s.score ?? 0) + '%';
    const tag = $('scoreTag'); tag.textContent = s.tag?.[0] || '—'; tag.className = 'tag ' + (s.tag?.[1] || 'mid');
    const rsName = vsSeries?.name || 'TCG INDEX';
    const rows = [
      ['Last', s.last != null ? money(s.last) : '—'],
      ['7D / 30D', `${fmtP(s.c7)} / ${fmtP(s.c30)}`],
      ['90D / 1Y', `${fmtP(s.c90)} / ${fmtP(s.c365)}`],
      ['Momentum accel.', s.accel == null ? '—' : `<span class="${s.accel >= 0 ? 'pos' : 'neg'}">${s.accel >= 0 ? '+' : ''}${s.accel.toFixed(1)} pts</span>`],
      [`RS 30D vs ${rsName.length > 12 ? 'VS' : rsName}`, fmtP(s.rs30)],
      ['RS 90D', fmtP(s.rs90)],
      ['RSI 14', s.rsi == null ? '—' : `<span class="${s.rsi > 70 ? 'neg' : s.rsi >= 50 ? 'pos' : 'dim'}">${s.rsi.toFixed(0)}</span>`],
      ['MACD hist', s.macdH == null ? '—' : `<span class="${s.macdH >= 0 ? 'pos' : 'neg'}">${s.macdH >= 0 ? 'above 0' : 'below 0'} · ${s.macdRising ? 'rising' : 'falling'}</span>`],
      ['vs SMA50', fmtP(s.distS50)],
      ['Sales pace 7D/30D', s.volRatio == null ? '—' : `<span class="${s.volRatio >= 1.2 ? 'pos' : s.volRatio < 0.8 ? 'neg' : ''}">${s.volRatio.toFixed(2)}×</span>`],
      ['Drawdown from 1Y high', fmtP(s.dd)],
      ['Volatility 30D (ann.)', s.vol30 == null ? '—' : s.vol30.toFixed(0) + '%'],
      ['History', `${s.days} days`],
    ];
    $('metrics').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  function renderWatchlist() {
    const rows = Object.values(model.by).map((b) => {
      const s = signals(b.close, b.vol, model.index);
      return { key: b.card.key, card: b.card, last: s.last, c30: s.c30, score: s.score, tag: s.tag, name: b.card.name };
    });
    const k = state.sort, dir = state.dir;
    rows.sort((a, b) => { const x = a[k], y = b[k]; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    $('wlBody').innerHTML = rows.map((r) => {
      const cls = r.score == null ? 'na' : r.tag[1];
      return `<tr class="row${r.key === state.key ? ' sel' : ''}${r.key === state.vs ? ' cmp' : ''}" data-k="${r.key}" tabindex="0">
        <td><span class="nm">${r.card.name}</span><span class="st">${r.card.set} #${r.card.number} · ${r.card.era}</span></td>
        <td class="n">${r.last != null ? money(r.last) : '—'}</td>
        <td class="n">${fmtP(r.c30, 0)}</td>
        <td class="n"><span class="pill ${cls}" title="${r.tag?.[0] || ''}">${r.score ?? '··'}</span></td>
        <td><button class="sw${r.key === state.vs ? ' on' : ''}" data-vs="${r.key}" title="Compare against this card" aria-label="Compare against ${r.card.name}">⇄</button></td></tr>`;
    }).join('');
  }

  function renderSelects() {
    const cards = Object.values(model.by).map((b) => b.card);
    $('sym').innerHTML = cards.map((c) => `<option value="${c.key}"${c.key === state.key ? ' selected' : ''}>${label(c)}</option>`).join('');
    $('vs').innerHTML = `<option value="none">None</option><option value="index">TCG Index (all tracked)</option>` +
      cards.filter((c) => c.key !== state.key).map((c) => `<option value="${c.key}">${label(c)}</option>`).join('');
    $('vs').value = model.by[state.vs] || state.vs === 'index' || state.vs === 'none' ? state.vs : 'index';
  }

  function syncButtons() {
    const set = (id, v) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
    set('grade', state.grade); set('range', state.range); set('res', state.res);
    $('ind').querySelectorAll('button').forEach((b) => b.classList.toggle('on', !!state.ind[b.dataset.v]));
  }

  function renderStatus() {
    const anyDemo = Object.values(model.by).some((b) => b.demo);
    const real = Object.values(model.by).filter((b) => !b.demo).length;
    const last = STATUS?.lastRun ? new Date(STATUS.lastRun).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null;
    $('status').textContent = anyDemo
      ? `DEMO · ${real}/${Object.keys(model.by).length} cards live${last ? ' · last fetch ' + last : ''}`
      : `LIVE · ${real} cards · ${last || 'no fetch log'}${STATUS?.dailyRemaining != null ? ' · ' + STATUS.dailyRemaining + ' credits left' : ''}`;
  }

  function refresh(opts) { save(); syncButtons(); renderWatchlist(); draw(opts); }

  function rebuild() {
    model = buildModel(state.grade);
    if (!model.by[state.key]) state.key = Object.keys(model.by)[0] || null;
    renderSelects(); renderStatus(); refresh();
  }

  // ---------- events ----------
  function bind() {
    const seg = (id, fn) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) fn(b.dataset.v); });
    seg('grade', (v) => { state.grade = v; rebuild(); });
    seg('range', (v) => { state.range = +v; refresh(); });
    seg('res', (v) => { state.res = v; refresh(); });
    seg('ind', (v) => { state.ind[v] = state.ind[v] ? 0 : 1; refresh({ keepView: true }); });
    $('sym').addEventListener('change', (e) => { state.key = e.target.value; if (state.vs === state.key) state.vs = 'index'; renderSelects(); refresh(); });
    $('vs').addEventListener('change', (e) => { state.vs = e.target.value; refresh({ keepView: true }); });
    $('wlBody').addEventListener('click', (e) => {
      const sw = e.target.closest('[data-vs]');
      if (sw) { e.stopPropagation(); state.vs = state.vs === sw.dataset.vs ? 'index' : sw.dataset.vs; if (state.vs === state.key) state.vs = 'index'; renderSelects(); refresh({ keepView: true }); return; }
      const tr = e.target.closest('tr[data-k]'); if (!tr) return;
      state.key = tr.dataset.k; if (state.vs === state.key) state.vs = 'index'; renderSelects(); refresh();
    });
    $('wlBody').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-k]')) e.target.click(); });
    document.querySelector('.wl thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]'); if (!th) return;
      const k = th.dataset.sort; state.dir = state.sort === k ? -state.dir : k === 'name' ? 1 : -1; state.sort = k; refresh({ keepView: true });
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw({ keepView: true }));
    new MutationObserver(() => draw({ keepView: true })).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('keydown', (e) => { // TradingView-ish: arrows step through watchlist
      if (e.target.matches('select, input')) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const rows = [...document.querySelectorAll('#wlBody tr[data-k]')]; const i = rows.findIndex((r) => r.dataset.k === state.key);
      const nx = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (nx) { e.preventDefault(); nx.click(); nx.scrollIntoView({ block: 'nearest' }); }
    });
  }

  async function start() {
    chart = new TerminalChart($('chart'), theme());
    try { await load(); } catch (e) { $('status').textContent = 'Could not load data/ — ' + e.message; return; }
    if (!WL || !Object.keys(SERIES).length) { $('status').textContent = 'NO DATA · run scripts/seed-demo.mjs or the fetch workflow'; return; }
    bind(); rebuild();
  }
  start();
})();
