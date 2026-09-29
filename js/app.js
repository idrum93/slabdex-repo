// SlabDex app: loads watchlist + price series, cleans sales, builds card lines and set/era indexes,
// then drives the chart panes, signal panel and watchlist.
(function () {
  const $ = (id) => document.getElementById(id);
  const { money, pct } = TerminalChart.fmt;
  const I = window.Ind;
  const C = window.Clean;

  const state = { v: 3, key: null, grade: 'psa9', vs: 'idx:all', range: 365, res: 'D', ind: { sma20: 1, sma50: 1, bb: 0, vol: 1, rs: 1, rsi: 1, macd: 1 }, sort: 'score', dir: -1, wlView: 'cards' };
  let hadSaved = false;
  try { const sv = JSON.parse(localStorage.getItem('slabdex') || 'null'); if (sv && sv.v === 3) { Object.assign(state, sv); hadSaved = true; } } catch (e) {} // older saved layouts are ignored
  const save = () => { try { localStorage.setItem('slabdex', JSON.stringify(state)); } catch (e) {} };

  let WL = null, SERIES = {}, STATUS = null, chart = null, model = null;
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // ---------- data loading (static JSON from the repo, or an inlined bundle) ----------
  async function load() {
    if (window.__SLABDEX_DATA__) { ({ watchlist: WL, series: SERIES, status: STATUS } = window.__SLABDEX_DATA__); return; }
    const j = (u) => fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    WL = await j('data/watchlist.json');
    STATUS = await j('data/status.json');
    const res = await Promise.all(WL.cards.map((c) => j(`data/prices/${c.key}.json`)));
    WL.cards.forEach((c, i) => { if (res[i]) SERIES[c.key] = res[i]; });
  }

  const buildModel = (grade) => Model.buildModel(WL, SERIES, grade);
  const signals = (close, vol, bench) => Model.signals(close, vol, bench, { dense: model?.dense });

  // Resolve a symbol id to a drawable series. 'set' / 'era' are relative to the main symbol.
  function resolve(id, rel) {
    if (!id || id === 'none') return null;
    if (id === 'set' || id === 'era') {
      const m = model.by[rel] ? model.by[rel].card : null;
      const mi = model.idx[rel];
      let tid = null;
      if (m) tid = id === 'set' ? 'idx:set:' + (m.basket || slug(m.set)) : 'idx:era:' + slug(m.era);
      else if (mi) tid = id === 'era' && mi.era ? 'idx:era:' + slug(mi.era) : 'idx:all';
      if (!tid || tid === rel || !model.idx[tid]) tid = rel === 'idx:all' ? null : 'idx:all';
      return tid ? resolve(tid) : null;
    }
    const b = model.by[id];
    if (b) return { id, isIndex: false, name: b.card.name, card: b.card, close: b.close, sales: b.sales, vol: b.vol, demo: b.demo, saleN: b.saleN };
    const x = model.idx[id];
    if (x) return { id, isIndex: true, name: x.name, index: x, close: x.close, vol: x.vol };
    return null;
  }
  const lineTag = (c) => (c.line ? ` · ${c.line}${c.est ? ' (est.)' : ''}` : '');
  const cardLabel = (c) => `${c.name}${lineTag(c)} — ${c.set} #${c.number}`;
  const idxLabel = (x) => `${x.kind === 'all' ? 'All tracked' : x.name} index (${x.members.length})`;
  const symName = (r) => (r.isIndex ? `${r.index.kind === 'all' ? 'ALL' : r.name.toUpperCase()} IDX` : r.name + (r.card.line ? ` ${r.card.line}` : ''));

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
  function draw({ keepView = false } = {}) {
    const T = theme();
    const cur = resolve(state.key);
    if (!cur) { chart.setData([], []); return; }
    const vsSeries = state.vs === 'none' ? null : resolve(state.vs, state.key);
    const bench0 = vsSeries && vsSeries.id !== cur.id ? vsSeries : null;

    let dates = model.axis, close = cur.close, vol = cur.vol, ohlc = null, bench = bench0?.close || null;
    if (state.res === 'W') {
      const w = weekly(dates, close, vol); dates = w.dates; close = w.close; vol = w.vol; ohlc = w.ohlc;
      if (bench) bench = weekly(model.axis, bench).close;
    }
    const f = state.res === 'W' ? { s1: 4, s2: 10, bb: 10 } : { s1: 20, s2: 50, bb: 20 }; // weekly ≈ same calendar span
    const percent = !!bench;
    const lvl = (v) => v.toFixed(1);
    const main = [];
    if (state.ind.bb) { const b = I.bollinger(close, f.bb); main.push({ type: 'band', data: b.up.map((u, i) => ({ up: u, lo: b.lo[i] })), fill: alpha(T.cmp, 0.08), rebaseWith: close, label: 'BB', color: alpha(T.cmp, 0.5) }); }
    if (ohlc) main.push({ type: 'candle', data: ohlc, label: '', tag: true, color: T.accent });
    else main.push({ type: 'area', data: close, color: T.accent, width: 2, fillTop: alpha(T.accent, 0.18), fillBottom: alpha(T.accent, 0), label: cur.isIndex ? 'LEVEL' : `${Model.GRADE_LABEL[state.grade]}${model.dense ? '' : ' MKT'}`, tag: true });
    if (!cur.isIndex && !ohlc && cur.sales) main.push({ type: 'dots', data: cur.sales, color: T.fg || T.text, rebaseWith: close, label: 'SALE' });
    if (bench) main.push({ type: 'line', data: bench, color: T.cmp, width: 1.5, label: symName(bench0), tag: true });
    if (state.ind.sma20) main.push({ type: 'line', data: I.sma(close, f.s1), color: T.sma20, width: 1, label: state.res === 'W' ? 'SMA4W' : 'SMA20', rebaseWith: close });
    if (state.ind.sma50) main.push({ type: 'line', data: I.sma(close, f.s2), color: T.sma50, width: 1, label: state.res === 'W' ? 'SMA10W' : 'SMA50', rebaseWith: close });
    if (state.ind.vol && vol.some(I.isN)) main.push({ type: 'hist', data: vol, ownScale: true, heightFrac: 0.16, color: alpha(T.muted, 0.45), label: model.dense ? (state.res === 'W' ? 'VOL/WK' : 'VOL/D') : state.res === 'W' ? 'SALES/WK' : 'SALES/D' });

    const title = cur.isIndex ? `${idxLabel(cur.index)} · base 100` : `${cur.card.name}${lineTag(cur.card)}  ${cur.card.set} #${cur.card.number}`;
    const panes = [{ id: 'main', ratio: 5, percent, fmt: cur.isIndex ? lvl : money, title, series: main }];
    if (state.ind.rs && bench) {
      const rs = close.map((v, i) => (I.isN(v) && I.isN(bench[i]) && bench[i] ? v / bench[i] : null));
      const f0 = I.firstIdx(rs); const b0 = f0 >= 0 ? rs[f0] : 1;
      const rsn = rs.map((v) => (I.isN(v) ? (v / b0) * 100 : null));
      panes.push({ id: 'rs', ratio: 1.3, title: `RS vs ${symName(bench0)}`, fmt: lvl, levels: [100], series: [
        { type: 'line', data: rsn, color: T.cmp, width: 1.5, label: 'RS' },
        { type: 'line', data: I.sma(rsn, f.s1), color: T.sma20, width: 1, label: 'MA', fmt: lvl },
      ] });
    }
    if (state.ind.rsi) panes.push({ id: 'rsi', ratio: 1.2, title: 'RSI 14', range: [0, 100], levels: [30, 50, 70], fmt: (v) => v.toFixed(0), series: [{ type: 'line', data: I.rsi(close, 14), color: T.sma20, width: 1.3, label: 'RSI', fmt: lvl }] });
    if (state.ind.macd) {
      const m = I.macd(close);
      panes.push({ id: 'macd', ratio: 1.3, title: 'MACD 12 26 9', zeroCenter: true, fmt: (v) => v.toFixed(Math.abs(v) < 10 ? 1 : 0), series: [
        { type: 'hist', data: m.hist, colorFn: (v) => alpha(v >= 0 ? T.up : T.down, 0.6), label: 'HIST', color: T.muted },
        { type: 'line', data: m.line, color: T.cmp, width: 1.2, label: 'MACD' },
        { type: 'line', data: m.signal, color: T.warn || T.accent, width: 1, label: 'SIG' },
      ] });
    }
    chart.theme = T;
    chart.defaultBars = state.range ? Math.ceil(state.range / (state.res === 'W' ? 7 : 1)) : dates.length;
    chart.setData(dates, panes, { keepView });
    $('demoFlag').hidden = !(cur.demo || bench0?.demo);
    renderSignal(cur, bench0);
  }

  function fmtP(v, d = 1) { return v == null ? '<span class="dim">—</span>' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(d)}%</span>`; }

  function renderSignal(cur, bench0) {
    const bench = bench0?.close || (cur.id === 'idx:all' ? null : model.index);
    const s = signals(cur.close, cur.vol, bench);
    const benchName = bench0 ? symName(bench0) : cur.id === 'idx:all' ? '—' : 'ALL IDX';
    $('sigName').textContent = `${cur.isIndex ? idxLabel(cur.index) : cur.card.name + lineTag(cur.card)} · ${Model.GRADE_LABEL[state.grade]}`;
    $('scoreVal').textContent = s.score == null ? '—' : s.score;
    $('scoreBar').style.width = (s.score ?? 0) + '%';
    const tag = $('scoreTag'); tag.textContent = s.tag?.[0] || '—'; tag.className = 'tag ' + (s.tag?.[1] || 'mid');
    const rows = [
      [cur.isIndex ? 'Level' : 'Last', s.last != null ? (cur.isIndex ? s.last.toFixed(1) : money(s.last)) : '—'],
      ['7D / 30D', `${fmtP(s.c7)} / ${fmtP(s.c30)}`],
      ['90D / 1Y', `${fmtP(s.c90)} / ${fmtP(s.c365)}`],
      ['Momentum accel.', s.accel == null ? '—' : `<span class="${s.accel >= 0 ? 'pos' : 'neg'}">${s.accel >= 0 ? '+' : ''}${s.accel.toFixed(1)} pts</span>`],
      [`RS 30D vs ${benchName}`, fmtP(s.rs30)],
      ['RS 90D', fmtP(s.rs90)],
      ['RSI 14', s.rsi == null ? '—' : `<span class="${s.rsi > 70 ? 'neg' : s.rsi >= 50 ? 'pos' : 'dim'}">${s.rsi.toFixed(0)}</span>`],
      ['MACD hist', s.macdH == null ? '—' : `<span class="${s.macdH >= 0 ? 'pos' : 'neg'}">${s.macdH >= 0 ? 'above 0' : 'below 0'} · ${s.macdRising ? 'rising' : 'falling'}</span>`],
      ['vs SMA50', fmtP(s.distS50)],
      ['Sales pace 7D/30D', s.volRatio == null ? '—' : `<span class="${s.volRatio >= 1.2 ? 'pos' : s.volRatio < 0.8 ? 'neg' : ''}">${s.volRatio.toFixed(2)}×</span>`],
      ['Drawdown from 1Y high', fmtP(s.dd)],
      ['Volatility 30D (ann.)', s.vol30 == null ? '—' : s.vol30.toFixed(0) + '%'],
      [cur.isIndex ? 'Members' : model.dense ? 'Price days' : 'Clean sale days', cur.isIndex ? String(cur.index.members.length) : String(cur.saleN)],
      ...(model.dense ? [] : [['Sale days, last 90D', s.saleDays90 == null ? '—' : `<span class="${s.saleDays90 < Model.MIN_SALE_DAYS_90 ? 'neg' : ''}">${s.saleDays90}</span>`]]),
      ['History', `${s.days} days`],
    ];
    $('metrics').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  function renderWatchlist() {
    const sets = state.wlView === 'sets';
    document.querySelectorAll('#wlTabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.wlView));
    $('wlFirstCol').textContent = sets ? 'Index' : 'Card';
    $('wlLastCol').textContent = sets ? 'Level' : 'Last';
    let rows;
    if (sets) {
      const order = { all: 0, era: 1, set: 2 };
      rows = Object.values(model.idx).map((x) => {
        const s = signals(x.close, x.vol, x.id === 'idx:all' ? null : model.index);
        return { key: x.id, name: x.name, sub: x.kind === 'all' ? `${x.members.length} cards` : x.kind === 'era' ? `era · ${x.members.length} cards` : `${x.era} · ${x.members.length} cards`, last: s.last, lastTxt: s.last != null ? s.last.toFixed(1) : '—', c30: s.c30, score: s.score, tag: s.tag, grp: order[x.kind] };
      });
      if (state.sort === 'score' || state.sort === 'c30' || state.sort === 'last' || state.sort === 'name') { /* sort below */ }
    } else {
      rows = Object.values(model.by).map((b) => {
        const s = signals(b.close, b.vol, model.index);
        const c = b.card;
        return { key: c.key, name: c.name, sub: `${c.set} #${c.number}${c.line ? ' · ' + c.line + (c.est ? ' est.' : '') : ''}`, last: s.last, lastTxt: s.last != null ? money(s.last) : '—', c30: s.c30, score: s.score, tag: s.tag };
      });
    }
    const k = state.sort, dir = state.dir;
    rows.sort((a, b) => (sets ? (a.grp ?? 0) - (b.grp ?? 0) : 0) || (() => { const x = a[k], y = b[k]; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * dir; })());
    $('wlBody').innerHTML = rows.map((r) => {
      const cls = r.score == null ? 'na' : r.tag[1];
      return `<tr class="row${r.key === state.key ? ' sel' : ''}${r.key === state.vs ? ' cmp' : ''}" data-k="${r.key}" tabindex="0">
        <td><span class="nm">${r.name}</span><span class="st">${r.sub}</span></td>
        <td class="n">${r.lastTxt}</td>
        <td class="n">${fmtP(r.c30, 0)}</td>
        <td class="n"><span class="pill ${cls}" title="${r.tag?.[0] || ''}">${r.score ?? '··'}</span></td>
        <td><button class="sw${r.key === state.vs ? ' on' : ''}" data-vs="${r.key}" title="Compare against this" aria-label="Compare against ${r.name}">⇄</button></td></tr>`;
    }).join('');
  }

  function renderSelects() {
    const idxs = Object.values(model.idx);
    const groups = (kind) => idxs.filter((x) => x.kind === kind).map((x) => `<option value="${x.id}">${idxLabel(x)}</option>`).join('');
    const idxOpts = `<optgroup label="Indexes">${groups('all')}${groups('era')}${groups('set')}</optgroup>`;
    const cardOpts = (skip) => `<optgroup label="Cards">${Object.values(model.by).filter((b) => b.card.key !== skip).map((b) => `<option value="${b.card.key}">${cardLabel(b.card)}</option>`).join('')}</optgroup>`;
    $('sym').innerHTML = idxOpts + cardOpts(null);
    $('sym').value = state.key;
    $('vs').innerHTML = `<option value="none">None</option><option value="set">Own set index</option><option value="era">Own era index</option>` + idxOpts + cardOpts(state.key);
    const valid = ['none', 'set', 'era'].includes(state.vs) || model.by[state.vs] || model.idx[state.vs];
    if (!valid || state.vs === state.key) state.vs = state.key === 'idx:all' ? 'none' : 'idx:all';
    $('vs').value = state.vs;
  }

  function syncButtons() {
    const set = (id, v) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
    set('grade', state.grade); set('range', state.range); set('res', state.res);
    $('ind').querySelectorAll('button').forEach((b) => b.classList.toggle('on', !!state.ind[b.dataset.v]));
  }

  function renderStatus() {
    const all = Object.values(model.by).filter((b) => !b.card.virtual);
    const anyDemo = all.some((b) => b.demo);
    const last = STATUS?.lastRun ? new Date(STATUS.lastRun).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : null;
    const nSets = Object.values(model.idx).filter((x) => x.kind === 'set').length;
    $('status').textContent = anyDemo
      ? `DEMO · ${all.filter((b) => !b.demo).length}/${all.length} cards live${last ? ' · last fetch ' + last : ''}`
      : `LIVE · ${all.length} cards · ${nSets} sets · ${last || 'no fetch log'}${STATUS?.dailyRemaining != null ? ' · ' + STATUS.dailyRemaining + ' credits left' : ''}`;
  }

  function renderBrief() {
    const b = Model.brief(model);
    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    $('briefHead').textContent = `BRIEF · ${b.gradeLabel} · ${b.asOf || '—'} · ${b.scoredCards}/${b.cards} cards scoreable`;
    $('briefBody').innerHTML = b.lines.map((l) => `<div class="bl"><span class="bk">${l.label}</span>${l.items.map((i) => `<button class="bi ${i.tone || ''}" data-k="${i.k}">${esc(i.text)}</button>`).join('<span class="sep">·</span>')}</div>`).join('');
  }

  function refresh(opts) { save(); syncButtons(); renderWatchlist(); draw(opts); }

  function rebuild() {
    model = buildModel(state.grade);
    if (!model.by[state.key] && !model.idx[state.key]) state.key = Object.keys(model.by)[0] || 'idx:all';
    renderSelects(); renderStatus(); renderBrief(); refresh();
  }

  function select(key) {
    state.key = key;
    if (state.vs === key) state.vs = 'idx:all';
    renderSelects(); refresh();
  }

  // ---------- events ----------
  function bind() {
    const seg = (id, fn) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) fn(b.dataset.v); });
    seg('grade', (v) => { state.grade = v; rebuild(); });
    seg('range', (v) => { state.range = +v; refresh(); });
    seg('res', (v) => { state.res = v; refresh(); });
    seg('ind', (v) => { state.ind[v] = state.ind[v] ? 0 : 1; refresh({ keepView: true }); });
    seg('wlTabs', (v) => { state.wlView = v; renderWatchlist(); save(); });
    $('sym').addEventListener('change', (e) => select(e.target.value));
    $('vs').addEventListener('change', (e) => { state.vs = e.target.value; refresh({ keepView: true }); });
    $('wlBody').addEventListener('click', (e) => {
      const sw = e.target.closest('[data-vs]');
      if (sw) { e.stopPropagation(); state.vs = state.vs === sw.dataset.vs ? 'idx:all' : sw.dataset.vs; if (state.vs === state.key) state.vs = 'idx:all'; renderSelects(); refresh({ keepView: true }); return; }
      const tr = e.target.closest('tr[data-k]'); if (tr) select(tr.dataset.k);
    });
    $('briefBody').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) select(b.dataset.k); });
    $('wlBody').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-k]')) e.target.click(); });
    document.querySelector('.wl thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]'); if (!th) return;
      const k = th.dataset.sort; state.dir = state.sort === k ? -state.dir : k === 'name' ? 1 : -1; state.sort = k; refresh({ keepView: true });
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw({ keepView: true }));
    new MutationObserver(() => draw({ keepView: true })).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('keydown', (e) => { // ↑/↓ step through the watchlist
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
    if (!WL || !Object.keys(SERIES).length) { $('status').textContent = 'NO DATA · run the discovery or fetch workflow'; return; }
    if (!hadSaved && WL.primaryGrade) state.grade = WL.primaryGrade; // vintage baskets default to PSA 9
    bind(); rebuild();
  }
  start();
})();
