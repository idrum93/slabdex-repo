// SlabDex app: loads watchlist + price series, cleans sales, builds card lines and set/era indexes,
// then drives the chart panes, signal panel and watchlist.
(function () {
  const $ = (id) => document.getElementById(id);
  const { money, pct } = TerminalChart.fmt;
  const I = window.Ind;
  const C = window.Clean;

  const state = { v: 3, key: null, grade: 'psa9', vs: 'idx:all', range: 365, res: 'D', ind: { st: 1, sma20: 1, sma50: 1, hma: 0, vol: 1, rs: 1, rsi: 1, macd: 0, vzo: 0 }, guide: 1, dash: 0, whatIf: 0, wi: {}, sort: 'score', dir: -1, wlView: 'cards', wlMetric: 'c30', merge: false, print: 'main', group: false, collapsed: [], stars: [] };
  let hadSaved = false;
  try { const sv = JSON.parse(localStorage.getItem('slabdex') || 'null'); if (sv && sv.v === 3) { Object.assign(state, sv); hadSaved = true; if (!('st' in state.ind)) state.ind.st = 1; } } catch (e) {} // older saved layouts are ignored
  const save = () => { try { localStorage.setItem('slabdex', JSON.stringify(state)); } catch (e) {} };

  let WL = null, SERIES = {}, STATUS = null, LEDGER = null, chart = null, model = null;
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // ---------- data loading (static JSON from the repo, or an inlined bundle) ----------
  async function load() {
    if (window.__SLABDEX_DATA__) { ({ watchlist: WL, series: SERIES, status: STATUS, ledger: LEDGER } = window.__SLABDEX_DATA__); return; }
    const j = (u) => fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    WL = await j('data/watchlist.json');
    STATUS = await j('data/status.json');
    LEDGER = await j('data/ledger.json'); // forward record of live setups (scripts/ledger.mjs)
    const pn = await j('data/printings.json'); if (pn?.names) WL.printingNames = pn.names; // names for holo / reverse tiers
    const all = [...WL.cards, ...(WL.extra || [])];
    const res = await Promise.all(all.map((c) => j(`data/prices/${c.key}.json`)));
    all.forEach((c, i) => { if (res[i]) SERIES[c.key] = res[i]; });
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
  const hasAlt = (k) => !!model.by[k + '~alt'];
  const curKey = () => (state.print === 'alt' && hasAlt(state.key) ? state.key + '~alt' : state.key);
  const lineTag = (c) => (c.line ? ` · ${c.line}${c.est ? ' (est.)' : ''}` : '');
  const cardLabel = (c) => `${c.name}${lineTag(c)} — ${c.set} #${c.number}`;
  const KIND_WORD = { char: 'character', theme: 'theme', family: 'era family' };
  // Index icons: character / theme sprites (pixel art) and set symbols. Hidden if they fail to load.
  const spr = (u, cls = 'spr') => (u ? `<img class="${cls}" src="${u}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '');
  const icon = (x) => (x?.sprite ? spr(x.sprite) : x?.symbol ? spr(x.symbol, 'spr setsym') : '');
  const KIND_TAG = { all: 'ALL', family: 'FAM', era: 'ERA', set: 'SET', char: 'CHR', theme: 'THM' };
  function keyIcon(k, { thumb = true } = {}) {
    const x = model.idx[k]; if (x) return icon(x) || `<span class="bk">${KIND_TAG[x.kind] || ''}</span>`;
    const b = model.by[k]; if (!b) return '';
    if (b.card.sprite) return spr(b.card.sprite); // the card's own Pokémon (Poké Ball for trainers)
    const base = k.replace(/~alt$/, ''), g = (model.memberOf[base] || []).map((id) => model.idx[id]).find((y) => y?.kind === 'char' && y.sprite);
    if (g) return spr(g.sprite);
    return thumb && b.card.tcgPlayerId ? `<img class="bthumb" src="https://tcgplayer-cdn.tcgplayer.com/product/${b.card.tcgPlayerId}_in_200x200.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  }
  // "implied $1,050 (+17%) from PSA 9 × usual 52% · 3 sales" — the reference grade's sale count is the caveat.
  function impliedTxt(im, { short = false } = {}) {
    if (!im || !I.isN(im.price)) return '';
    const L = Model.GRADE_LABEL, thin = im.refN30 < 2;
    const how = `${L[im.ref]} ${money(im.refPrice)} ${GORD_UP(im) ? '×' : '÷'} ${normWord(im.normSrc)} ${(im.norm * 100).toFixed(0)}%`;
    return short ? `→ ${money(im.price)} (${im.upside >= 0 ? '+' : ''}${im.upside.toFixed(0)}%)${thin ? ' ⚠' : ''}` : `implied ${money(im.price)} (${im.upside >= 0 ? '+' : ''}${im.upside.toFixed(0)}%) from ${how} · ${im.refN30} ${L[im.ref]} sale${im.refN30 === 1 ? '' : 's'} in 30D${thin ? ' — thin, treat with caution' : ''}`;
  }
  const GORD_UP = (im) => ({ psa7: 7, psa8: 8, psa9: 9, psa10: 10 }[im.ref] > { psa7: 7, psa8: 8, psa9: 9, psa10: 10 }[im.grade]);
  const implied = (key, card, grade, ref) => { const im = Model.impliedPrice(allModels(), key, card, grade, ref); if (im) im.grade = grade; return im; };
  const normWord = (src) => (src === 'own' || !src ? 'usual' : src === 'set' ? 'set norm' : `${src} norm`); // where the yardstick came from
  const famOfCard = (c) => c.family || String(c.era || '').split(' ')[0];
  const idxLabel = (x) => `${x.kind === 'all' ? 'All tracked' : x.name} ${KIND_WORD[x.kind] ? KIND_WORD[x.kind] + ' ' : ''}index (${x.members.length})`;
  const symName = (r) => (r.isIndex ? `${r.index.kind === 'all' ? 'ALL' : r.name.toUpperCase()} IDX` : r.name + (r.card.line ? ` ${r.card.line}` : ''));

  // ---------- per-model stats (shared by watchlist + gauges) ----------
  function stats() {
    if (model._stats) return model._stats;
    const cards = {}, idx = {};
    const ch = {};
    for (const [k, b] of Object.entries(model.by)) {
      cards[k] = signals(b.close, b.vol, model.index);
      const set = model.idx['idx:set:' + (b.card.basket || slug(b.card.set))];
      ch[k] = Model.changes(b.close, b.vol, set?.close || model.index, { dense: model.dense });
    }
    for (const x of Object.values(model.idx)) {
      idx[x.id] = signals(x.close, x.vol, x.id === 'idx:all' ? null : model.index);
      if (x.id !== 'idx:all') ch[x.id] = Model.changes(x.close, x.vol, model.index, { dense: model.dense });
    }
    // Grade gap vs the next grade up (PSA 7→8, 8→9, 9→10), with the family's typical ratio as the peer yardstick.
    const up = Model.NEXT[model.grade];
    if (up) for (const g of Model.gradeGaps(model, otherModel(up))) if (cards[g.key]) cards[g.key].gap = g;
    return (model._stats = { cards, idx, ch });
  }
  const pct0 = (v) => (v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(0)}%</span>`);
  const METRICS = {
    c30: { label: '30D', get: (s) => s.c30, fmt: pct0 },
    dist50: { label: 'vs 50D', get: (s) => s.distS50, fmt: pct0 },
    accel: { label: 'Accel', get: (s) => s.accel, fmt: (v) => (v == null ? '—' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(0)}</span>`) },
    volRatio: { label: 'Pace', get: (s) => s.volRatio, fmt: (v) => (v == null ? '—' : `<span class="${v >= 1.2 ? 'pos' : v < 0.8 ? 'neg' : ''}">${v.toFixed(2)}×</span>`) },
    gap: { label: 'Gap', get: (s) => s.gap?.gap ?? null, fmt: (v) => (v == null ? '—' : `<span class="${v < 0.8 ? 'warn' : ''}" title="Price as a share of the next grade up, vs this card's usual share (100% = normal)">${(v * 100).toFixed(0)}%</span>`) },
    volExp: { label: 'Swing', get: (s) => s.volExp, fmt: (v) => (v == null ? '—' : `<span class="${v >= 1.3 ? 'warn' : ''}">${v.toFixed(2)}×</span>`) },
  };

  // Market gauges for the current grade. Each one ranks the watchlist by the metric behind it.
  function gauges() {
    const st = stats();
    const mains = Object.entries(model.by).filter(([, b]) => !b.card.virtual && b.card.role !== 'group').map(([k]) => st.cards[k]);
    const share = (f, g) => { const v = mains.filter((s) => g(s) != null); return v.length ? { v: (v.filter(f).length / v.length) * 100, n: v.length } : { v: null, n: 0 }; };
    const scored = mains.filter((s) => s.score != null);
    const all = st.idx['idx:all'] || {};
    const pctTone = (v) => (v == null ? 'mid' : v >= 60 ? 'good' : v <= 40 ? 'bad' : 'mid');
    const br = share((s) => s.distS50 > 0, (s) => s.distS50), adv = share((s) => s.c30 > 0, (s) => s.c30), rmp = share((s) => s.accel > 0, (s) => s.accel);
    const mom = scored.length ? scored.reduce((a, s) => a + s.score, 0) / scored.length : null;
    return [
      { id: 'mom', label: 'MOMENTUM', v: mom, max: 100, txt: mom == null ? '—' : mom.toFixed(0), sub: `avg of ${scored.length} scored`, tone: mom == null ? 'mid' : mom >= 55 ? 'good' : mom < 40 ? 'bad' : 'mid', sort: 'score' },
      { id: 'br', label: 'BREADTH', v: br.v, max: 100, txt: br.v == null ? '—' : br.v.toFixed(0) + '%', sub: 'above 50D avg', tone: pctTone(br.v), metric: 'dist50' },
      { id: 'adv', label: 'ADVANCERS', v: adv.v, max: 100, txt: adv.v == null ? '—' : adv.v.toFixed(0) + '%', sub: 'up over 30D', tone: pctTone(adv.v), metric: 'c30' },
      { id: 'rmp', label: 'RAMPING', v: rmp.v, max: 100, txt: rmp.v == null ? '—' : rmp.v.toFixed(0) + '%', sub: 'momentum speeding up', tone: pctTone(rmp.v), metric: 'accel' },
      { id: 'pace', label: model.dense ? 'VOLUME' : 'SALES PACE', v: all.volRatio, max: 2, txt: all.volRatio == null ? '—' : all.volRatio.toFixed(2) + '×', sub: '7D vs 30D', tone: all.volRatio == null ? 'mid' : all.volRatio >= 1.2 ? 'good' : all.volRatio < 0.8 ? 'bad' : 'mid', metric: 'volRatio' },
      { id: 'swing', label: 'SWINGS', v: all.volExp, max: 2, txt: all.volExp == null ? '—' : all.volExp.toFixed(2) + '×', sub: '30D vs 90D volatility', tone: all.volExp == null ? 'mid' : all.volExp >= 1.3 ? 'warn' : 'mid', metric: 'volExp' },
    ];
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
    const cur = resolve(curKey());
    if (!cur) { chart.setData([], []); return; }
    renderPrint();
    const other = state.print === 'both' && hasAlt(state.key) ? resolve(state.key + '~alt') : null;
    const vsSeries = state.vs === 'none' ? null : resolve(state.vs, state.key);
    const bench0 = vsSeries && vsSeries.id !== cur.id ? vsSeries : null;
    const merge = !!(state.merge && bench0);
    $('mergeBtn').disabled = !bench0; $('mergeBtn').setAttribute('aria-pressed', String(merge));

    let dates = model.axis, close = cur.close, vol = cur.vol, ohlc = null, bench = bench0?.close || null;
    if (state.res === 'W') {
      const w = weekly(dates, close, vol); dates = w.dates; close = w.close; vol = w.vol; ohlc = w.ohlc;
      if (bench) bench = weekly(model.axis, bench).close;
    }
    const benchShown = bench;
    if (merge) { // one line: slot 1 ÷ slot 2, rebased to 100 where both first exist
      const r = close.map((v, i) => (I.isN(v) && I.isN(bench[i]) && bench[i] ? v / bench[i] : null));
      const r0 = r[I.firstIdx(r)] || 1;
      close = r.map((v) => (I.isN(v) ? (v / r0) * 100 : null)); vol = close.map(() => null); ohlc = null; bench = null;
    }
    const f = state.res === 'W' ? { s1: 4, s2: 10, bb: 10 } : { s1: 20, s2: 50, bb: 20 }; // weekly ≈ same calendar span
    const percent = !!bench && !merge;
    const lvl = (v) => v.toFixed(1);
    const main = [];
    if (ohlc) main.push({ type: 'candle', data: ohlc, label: '', tag: true, color: T.accent });
    else main.push({ type: 'area', data: close, color: T.accent, width: 2, fillTop: alpha(T.accent, 0.18), fillBottom: alpha(T.accent, 0), label: merge ? 'A÷B' : cur.isIndex ? 'LEVEL' : other ? cur.card.line + (cur.card.est ? ' est.' : '') : `${Model.GRADE_LABEL[state.grade]}${model.dense ? '' : ' MKT (median of last 3 sales)'}`, tag: true });
    if (merge) main.push({ type: 'line', data: close.map((v) => (I.isN(v) ? 100 : null)), color: alpha(T.muted, 0.6), width: 1, dash: [3, 3], label: '' });
    if (!merge && !cur.isIndex && !ohlc && cur.sales && state.res === 'D') main.push({ type: 'dots', data: cur.sales, color: T.fg || T.text, rebaseWith: close, label: 'SALE (day avg)' });
    if (bench) main.push({ type: 'line', data: bench, color: T.cmp, width: 1.5, tag: true }); // its legend lives in the compare row below
    if (other && !merge) { // BOTH printings: overlay the other line on the same scale
      const oc = state.res === 'W' ? weekly(model.axis, other.close).close : other.close;
      main.push({ type: 'line', data: oc, color: T.warn, width: 1.5, label: other.card.line + (other.card.est ? ' est.' : ''), tag: true });
    }
    if (state.ind.sma20) main.push({ type: 'line', data: I.sma(close, f.s1), color: T.sma20, width: 1, label: state.res === 'W' ? 'SMA4W' : 'SMA20', rebaseWith: close });
    if (state.ind.sma50) main.push({ type: 'line', data: I.sma(close, f.s2), color: T.sma50, width: 1, label: state.res === 'W' ? 'SMA10W' : 'SMA50', rebaseWith: close });
    if (state.ind.hma) main.push({ type: 'line', data: I.hma(close, f.s1), color: T.warn, width: 1.3, label: state.res === 'W' ? 'HMA4W' : 'HMA20', rebaseWith: close });
    if (state.ind.st) { // trailing line, green while the trend is up, red while down
      const t = I.supertrend(close, state.res === 'W' ? 4 : 10, 3);
      main.push({ type: 'line', data: t.line.map((v, i) => (t.dir[i] === 1 ? v : null)), color: T.up, width: 1.3, label: 'ST▲', rebaseWith: close });
      main.push({ type: 'line', data: t.line.map((v, i) => (t.dir[i] === -1 ? v : null)), color: T.down, width: 1.3, label: 'ST▼', rebaseWith: close });
    }
    if (state.ind.vol && vol.some(I.isN)) main.push({ type: 'hist', data: vol, ownScale: true, heightFrac: 0.16, color: alpha(T.muted, 0.45), label: model.dense ? (state.res === 'W' ? 'VOL/WK' : 'VOL/D') : state.res === 'W' ? 'SALES/WK' : 'SALES/D' });

    const nameA = cur.isIndex ? `${idxLabel(cur.index)}` : `${cur.card.name}${other ? '' : lineTag(cur.card)}  ${cur.card.set} #${cur.card.number}`;
    const title = merge ? `${cur.isIndex ? symName(cur) : cur.card.name + lineTag(cur.card)}  ÷  ${symName(bench0)} · base 100` : cur.isIndex ? `${nameA} · base 100` : nameA;
    const panes = [{ id: 'main', ratio: 5, percent, fmt: cur.isIndex || merge ? lvl : money, title, series: main, extraTop: bench0 ? 20 : 0 }];
    // Guide: each indicator says what it's for, what "favorable" looks like, whether it is now, and shades where it held.
    const G = !!state.guide, zc = alpha(T.up, 0.09);
    const lastOk = (z) => { for (let i = z.length - 1; i >= 0; i--) if (z[i] != null) return !!z[i]; return null; };
    const guide = (pane, z, text) => { if (!G) return; pane.zones = z.map(Boolean); pane.zoneColor = zc; pane.hint = { ok: lastOk(z), text }; };
    if (G && !merge) { // trend conditions from the overlays that are on; the main pane is shaded where all of them agree
      const conds = [];
      if (state.ind.sma50) { const s2 = I.sma(close, f.s2); conds.push(['price > SMA50', close.map((v, i) => (I.isN(v) && I.isN(s2[i]) ? v > s2[i] : null))]); }
      if (state.ind.sma20 && state.ind.sma50) { const s1 = I.sma(close, f.s1), s2 = I.sma(close, f.s2); conds.push(['SMA20 > SMA50', close.map((_, i) => (I.isN(s1[i]) && I.isN(s2[i]) ? s1[i] > s2[i] : null))]); }
      if (state.ind.st) { const t = I.supertrend(close, state.res === 'W' ? 4 : 10, 3); conds.push(['Supertrend up', t.dir.map((d) => (d == null ? null : d === 1))]); }
      if (state.ind.hma) { const h = I.hma(close, f.s1); conds.push(['HMA rising', h.map((v, i) => (I.isN(v) && I.isN(h[i - 1]) ? v > h[i - 1] : null))]); }
      if (state.ind.vol && vol.some(I.isN)) { const a7 = I.sma(vol.map((v) => v ?? 0), state.res === 'W' ? 1 : 7), a30 = I.sma(vol.map((v) => v ?? 0), state.res === 'W' ? 4 : 30); conds.push(['sales pace up', a7.map((v, i) => (I.isN(v) && I.isN(a30[i]) && a30[i] > 0 ? v > a30[i] : null))]); }
      if (conds.length) {
        const all = close.map((_, i) => (conds.every(([, z]) => z[i] != null) ? conds.every(([, z]) => z[i]) : null));
        panes[0].zones = all.map(Boolean); panes[0].zoneColor = zc;
        panes[0].hint = { ok: lastOk(all), text: 'Trend check (shaded = all true): ' + conds.map(([n, z]) => `${n} ${lastOk(z) ? '✓' : '✗'}`).join(' · ') };
      }
    }
    if (state.ind.rs && bench && !merge) {
      const rs = close.map((v, i) => (I.isN(v) && I.isN(bench[i]) && bench[i] ? v / bench[i] : null));
      const f0 = I.firstIdx(rs); const b0 = f0 >= 0 ? rs[f0] : 1;
      const rsn = rs.map((v) => (I.isN(v) ? (v / b0) * 100 : null));
      panes.push({ id: 'rs', ratio: 1.3, title: `RS vs ${symName(bench0)}`, fmt: lvl, levels: [100], series: [
        { type: 'line', data: rsn, color: T.cmp, width: 1.5, label: 'RS' },
        { type: 'line', data: I.sma(rsn, f.s1), color: T.sma20, width: 1, label: 'MA', fmt: lvl },
      ] });
      const rm = I.sma(rsn, f.s1); guide(panes[panes.length - 1], rsn.map((v, i) => (I.isN(v) && I.isN(rm[i]) ? v > rm[i] : null)), 'Beating the benchmark? Favorable: RS above its MA (rising line = outperforming)');
    }
    if (state.ind.rsi) { const r = I.rsi(close, 14); panes.push({ id: 'rsi', ratio: 1.2, title: 'RSI 14', range: [0, 100], levels: [30, 50, 70], fmt: (v) => v.toFixed(0), series: [{ type: 'line', data: r, color: T.sma20, width: 1.3, label: 'RSI', fmt: lvl }] });
      guide(panes[panes.length - 1], r.map((v) => (I.isN(v) ? v >= 50 && v <= 70 : null)), 'Momentum. Favorable: 50–70 (above 70 = stretched, below 50 = weak)'); }
    if (state.ind.macd) {
      const m = I.macd(close);
      panes.push({ id: 'macd', ratio: 1.3, title: 'MACD 12 26 9', zeroCenter: true, fmt: (v) => v.toFixed(Math.abs(v) < 10 ? 1 : 0), series: [
        { type: 'hist', data: m.hist, colorFn: (v) => alpha(v >= 0 ? T.up : T.down, 0.6), label: 'HIST', color: T.muted },
        { type: 'line', data: m.line, color: T.cmp, width: 1.2, label: 'MACD' },
        { type: 'line', data: m.signal, color: T.warn || T.accent, width: 1, label: 'SIG' },
      ] });
      guide(panes[panes.length - 1], m.hist.map((v) => (I.isN(v) ? v > 0 : null)), 'Momentum turns. Favorable: MACD above its signal (green histogram)');
    }
    if (state.ind.vzo && vol.some(I.isN)) {
      const z = I.vzo(close, vol, state.res === 'W' ? 6 : 14);
      panes.push({ id: 'vzo', ratio: 1.2, title: 'VZO 14 · sales-weighted', range: [-100, 100], levels: [-40, 0, 40], fmt: (v) => v.toFixed(0), series: [
        { type: 'line', data: z.vzo, color: T.cmp, width: 1.3, label: 'VZO', fmt: lvl },
        { type: 'line', data: z.fisher.map((v) => (I.isN(v) ? Math.max(-100, Math.min(100, v)) : null)), color: T.warn, width: 1, label: 'FISHER', fmt: lvl },
      ] });
      guide(panes[panes.length - 1], z.vzo.map((v) => (I.isN(v) ? v > 0 : null)), 'Sales pressure (more sales on up days). Favorable: above 0, strong above 40. Noisy on thin cards');
    }
    chart.theme = T;
    chart.defaultBars = state.range ? Math.ceil(state.range / (state.res === 'W' ? 7 : 1)) : dates.length;
    // Second slot gets its own legend row (values follow the crosshair) with a clear button.
    CMP = bench0 ? { r: bench0, data: benchShown, dates, s: bench0.isIndex ? stats().idx[bench0.id] : stats().cards[bench0.id] } : null;
    $('cmpRow').hidden = !CMP;
    chart.onHover = renderCmpRow;
    chart.setData(dates, panes, { keepView });
    $('demoFlag').hidden = !(cur.demo || bench0?.demo);
    renderSignal(cur, bench0, merge ? close : null);
  }

  function renderPrint() {
    const el = $('print');
    const m = model.by[state.key], a = model.by[state.key + '~alt'];
    if (!m || !a) { el.hidden = true; el.innerHTML = ''; return; }
    const lab = (c) => (c.line || 'Main').replace(/ \(est\.\)/, '') + (c.est ? '*' : '');
    el.hidden = false;
    el.innerHTML = [['main', lab(m.card)], ['alt', lab(a.card)], ['both', 'Both']].map(([v, t]) => `<button data-v="${v}" class="${state.print === v ? 'on' : ''}" title="${v === 'both' ? 'Overlay both printings' : 'Show this printing'}${m.card.est ? ' · * = split estimated from sale prices' : ''}">${t}</button>`).join('');
  }

  let CMP = null, cmpLast = '';
  function renderCmpRow(hi) {
    if (!CMP) return;
    const d = CMP.data, r = CMP.r, s = CMP.s || {};
    let i = hi; if (i == null || !I.isN(d[i])) i = I.lastIdx(d);
    const v = i >= 0 ? d[i] : null;
    const val = v == null ? '—' : r.isIndex ? v.toFixed(1) : money(v);
    const when = hi != null && CMP.dates[hi] ? CMP.dates[hi].slice(5) + ' ' : '';
    const pc = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(0) + '%');
    const html = `${when}<b>${val}</b> · 30D <b>${pc(s.c30)}</b> · 90D <b>${pc(s.c90)}</b> · Sig <b>${s.score ?? '··'}</b>${s.tag ? ' ' + s.tag[0].toLowerCase() : ''}`;
    const name = symName(r) + (r.isIndex ? '' : ` · ${r.card.set}`);
    const key = name + html;
    if (key === cmpLast) return; cmpLast = key;
    $('cmpName').textContent = name;
    $('cmpVals').innerHTML = html;
  }

  function fmtP(v, d = 1) { return v == null ? '<span class="dim">—</span>' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(d)}%</span>`; }

  // The card in every PSA grade: price, 30D move, share of the next grade up, last sale. A grade whose neighbour
  // just jumped ≥20% while it stayed flat is marked as lagging — the one to look at before it (maybe) catches up.
  const allModels = () => { const o = {}; for (const g of ['psa7', 'psa8', 'psa9', 'psa10']) o[g] = g === model.grade ? model : otherModel(g); return o; };
  function ladderRows(cur, ratio) {
    if (ratio || cur.isIndex || model.dense) return '';
    if (cur.card.mixed) return `<h3>GRADES</h3><p class="trk">This line blends two printings (${esc(cur.card.line)}), so it isn't compared across grades.</p>`;
    const rows = Model.gradeLadder(allModels(), cur.id, cur.card); if (rows.length < 2) return '';
    const sq = Model.squeezeNow(allModels(), cur.id, cur.card); rows.forEach((r) => { r.sq = sq.find((x) => x.grade === r.grade); r.im = r.sq && !r.sq.inverted ? implied(cur.id, cur.card, r.grade, r.sq.down) : r.lagging ? implied(cur.id, cur.card, r.grade, r.lagging[0]) : null; });
    const warn = rows.inconsistent ? '<p class="trk">⚠ Grade prices are out of order (a lower grade above a higher one): mixed printings or mislabeled sales in the data, so no lag or compression call is made for this card.</p>' : '';
    const L = Model.GRADE_LABEL, e = EDGE[state.grade];
    const res = (id) => e?.ok ? e.results.find((r) => r.id === id) : null;
    const lagNote = rows.some((r) => r.lagging) ? (() => { const a = res('lagUp'), b = res('lagDown'); const t = [a, b].filter((x) => x && x.n).map((x) => `${x.id === 'lagUp' ? 'grade above led' : 'grade below led'}: ${Edge.pct(x.vsPeers, 1)} vs peers over 30D (${x.n}×, ${x.status === 'few' ? 'too few' : x.status})`).join(' · '); return `<p class="trk">⇅ = priced almost like the grade below (the grade to look at). ⤴ = a neighbouring grade jumped ≥20% in 30D and this one hasn't followed. Backtest (${L[state.grade]}): ${t || 'not enough history yet'}. Not a buy signal on its own.</p>`; })() : '';
    return `<h3>GRADES <span class="dim">30D · share of next grade</span></h3>` + rows.map((r) => `<button class="ctx-row lad${r.grade === model.grade ? ' on' : ''}${r.lagging ? ' lagging' : ''}" data-grade="${r.grade}" type="button" title="${r.lagging ? `Lagging: ${r.lagging.map((g) => L[g]).join(' & ')} jumped, ${L[r.grade]} hasn't followed · ` : ''}Last sale ${r.age ?? '—'} days ago · click to switch grade"><span class="ck">${L[r.grade]}</span><span class="cn">${money(r.price)} ${r.share != null ? `<span class="dim">${(r.share * 100).toFixed(0)}%</span>` : ''}${r.lagging ? ' <b class="lagm">⤴</b>' : ''}${r.sq ? (r.sq.inverted ? ' <b class="dim" title="Priced above-or-equal to the grade below — usually mixed listings, check sales">⇵?</b>' : ' <b class="sqzm" title="Compressed: the grade below sells for ' + (r.sq.ratio * 100).toFixed(0) + '% of this grade (' + normWord(r.sq.normSrc) + ' ' + (r.sq.norm != null ? (r.sq.norm * 100).toFixed(0) + '%' : '—') + ')">⇅</b>') : ''}</span><span class="cv">${fmtP(r.c30, 0)}</span></button>${r.im ? `<p class="implied">${esc(impliedTxt(r.im))}</p>` : ''}`).join('') + warn + lagNote;
  }
  // Every grade's last sale next to an estimate built from the card's other grades — including grades that are
  // blended, thin or stale, where the estimate is the better guide to what a copy should cost.
  // What-if prices typed in the Signal panel: "695 750 644 600" (dates like 9/30 and $ signs are ignored).
  function parseWi(txt) {
    const s = String(txt || '').replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ').replace(/\$/g, '');
    const v = (s.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) || []).map((x) => +x.replace(/,/g, '')).filter((x) => x >= 5);
    if (!v.length) return null;
    const w = [...v].sort((a, b) => a - b), h = w.length >> 1;
    return { price: w.length % 2 ? w[h] : (w[h - 1] + w[h]) / 2, n: v.length, vals: v };
  }
  const wiKey = (id, g) => `${id.replace(/~alt$/, '')}|${g}`;
  function wiOverrides(id) {
    if (!state.whatIf) return null;
    const o = {}; for (const g of ['psa7', 'psa8', 'psa9', 'psa10']) { const p = parseWi(state.wi?.[wiKey(id, g)]); if (p) o[g] = p; }
    return Object.keys(o).length ? o : null;
  }
  function valueRows(cur, ratio) {
    if (ratio || cur.isIndex || model.dense) return '';
    const ov = wiOverrides(cur.id);
    const E = Model.gradeEstimates(allModels(), cur.id, cur.card, ov); if (!E.anchor) return '';
    const L = Model.GRADE_LABEL, src = (v) => (v === 'own' ? "this card's own grade spread" : v === 'set' ? 'same-set average spread' : `${v} average spread`);
    const aAge = E.rows.find((r) => r.anchor)?.age ?? null;
    const rows = E.rows.map((r) => {
      const stale = !r.anchor && (r.stale || (r.age != null && aAge != null && r.age - aAge > 7)); // overdue for its usual pace, or much older than the anchor's newest sale: newer sales may be missing
      const lastTxt = r.user ? `<span class="wiv">${money(r.user.price)} <span class="dim">your ${r.user.n > 1 ? 'median of ' + r.user.n : 'price'}</span></span>${r.dataLast != null ? ` <span class="dim">(data ${money(r.dataLast)} ${r.dataAge}d)</span>` : ''}` : r.last == null ? '<span class="dim">no sale</span>' : `${money(r.last)} <span class="dim">${r.age}d${r.blended ? ' · blended' : ''}</span>`;
      const estTxt = r.anchor ? '<span class="dim">anchor</span>' : r.est == null ? '<span class="dim">—</span>' : `≈${money(r.est)} <span class="dim">±${Math.round(r.miss * 100)}%</span>`;
      const gap = r.gap == null ? '' : stale ? `<span class="dim" title="Newest sales likely missing from the data — gap not reliable">⧗ stale</span>` : `<span class="${Math.abs(r.gap) <= r.miss * 100 ? 'dim' : r.gap < 0 ? 'pos' : 'neg'}">${r.gap >= 0 ? '+' : ''}${r.gap.toFixed(0)}%</span>`;
      const tip = r.anchor ? `Anchor: ${L[r.grade]} market price (median of last 3 clean sales), ${r.n30} sales in 30D` : r.est != null ? `Estimate from ${L[E.anchor]} via ${src(r.via)}; typical miss ±${Math.round(r.miss * 100)}%. Gap = last sale vs estimate (grey = within the typical miss).${r.blended ? ' Last sale may be either printing.' : ''}${r.age != null && r.age > 45 ? ' Last sale is old — the estimate is the better guide.' : ''}${stale ? ` ⧗ This grade's newest sales are likely missing: last sale ${r.age}d ago${r.typ ? ` though it usually sells every ~${r.typ}d` : ''}${aAge != null ? `, ${L[E.anchor]}'s ${aAge}d ago` : ''}. The provider posts sales late, so the gap isn't shown.` : ''}` : 'Not enough data to estimate';
      return `<button class="ctx-row val${r.grade === model.grade ? ' on' : ''}${r.user ? ' wi' : ''}" data-grade="${r.grade}" type="button" title="${esc(tip)}"><span class="ck">${L[r.grade]}</span><span class="cn">${lastTxt}<br>${estTxt}</span><span class="cv">${gap}</span></button>` + (state.whatIf ? `<input class="wi-in" data-wi="${esc(wiKey(cur.id, r.grade))}" type="text" inputmode="decimal" placeholder="${L[r.grade]} prices you found, e.g. 695 750 644" value="${esc(state.wi?.[wiKey(cur.id, r.grade)] || '')}" aria-label="What-if ${L[r.grade]} prices">` : '');
    }).join('');
    const bad = Model.gradeLadder(allModels(), cur.id, cur.card).inconsistent ? '<p class="trk">⚠ This card\'s grade prices are out of order (mixed or mislabeled sales), so these estimates are unreliable.</p>' : '';
    const wiNote = state.whatIf ? `<p class="wi-note">WHAT-IF ${ov ? `· using your ${Object.keys(ov).map((g) => `${L[g]} ${money(ov[g].price)}`).join(', ')} as the current price${E.anchor && ov[E.anchor] ? ` (anchor: ${L[E.anchor]})` : ''}` : '· type prices you found outside the tool (eBay, Alt…) under any grade'}. Estimates only — your inputs are saved on this device and never touch the collected data, signals, backtest or forward record.</p>` : '';
    return `<h3>VALUE BY GRADE <span class="dim">last sale · estimate · gap</span><button class="wi-tog${state.whatIf ? ' on' : ''}" type="button" data-witog title="What-if: enter sold prices you found elsewhere to see adjusted estimates. Display only.">WHAT-IF ${state.whatIf ? '●' : '○'}</button></h3>${wiNote}${rows}${bad}<p class="trk">Estimates walk from ${L[E.anchor]} (most recent clean sales) using grade-to-grade spreads. Green gap = last sale below the estimate by more than the usual error. ⧗ stale = that grade is overdue for a sale at its usual pace (or 8+ days behind the anchor), so its newest sales are probably not in the data yet and no gap is shown. An estimate, not a quote.</p>`;
  }
  // Cards with a lagging grade right now: the flat grade, the grade that jumped, and the spread between them.
  let LAGS = null;
  function lagList() {
    if (LAGS && LAGS.m === model) return LAGS.rows;
    const ms = allModels(), rows = [], seen = new Set();
    for (const [k, b] of Object.entries(model.by)) {
      const base = k.replace(/~alt$/, ''), id = base + '|' + (b.card.line || '');
      if (seen.has(id)) continue; seen.add(id);
      const lad = Model.gradeLadder(ms, k, b.card);
      for (const r of lad) if (r.lagging && r.tradable) { // the lagging slab must clear the minimum price and be liquid
        const led = r.lagging.map((g) => lad.find((x) => x.grade === g)).sort((a, c) => c.c30 - a.c30)[0];
        rows.push({ k, card: b.card, lag: r, led, spread: led.c30 - r.c30 });
      }
    }
    rows.sort((a, c) => c.spread - a.spread);
    LAGS = { m: model, rows };
    return rows;
  }
  let SQS = null;
  function squeezeList() {
    if (SQS && SQS.m === model) return SQS.rows;
    const ms = allModels(), rows = [], seen = new Set();
    for (const [k, b] of Object.entries(model.by)) {
      const id = k.replace(/~alt$/, '') + '|' + (b.card.line || ''); if (seen.has(id)) continue; seen.add(id);
      if (!Model.tradable(model, b)) continue; // below the minimum slab price or not liquid
      for (const sq of Model.squeezeNow(ms, k, b.card)) if (!sq.inverted) rows.push({ k, card: b.card, sq });
    }
    rows.sort((a, c) => c.sq.ratio / (c.sq.norm || 1) - a.sq.ratio / (a.sq.norm || 1));
    SQS = { m: model, rows };
    return rows;
  }
  // For a card: how its own set, character and theme indexes moved, and which of them it tracks most.
  function contextRows(cur, ratio) {
    if (ratio || cur.isIndex) return '';
    const base = cur.id.replace(/~alt$/, ''), st = stats();
    const ids = ['idx:set:' + (cur.card.basket || slug(cur.card.set)), 'idx:era:' + slug(cur.card.era || ''), 'idx:fam:' + slug(famOfCard(cur.card)), ...(model.memberOf[base] || []), 'idx:all'].filter((id, i, a) => model.idx[id] && a.indexOf(id) === i);
    if (!ids.length) return '';
    let best = null;
    const rows = ids.map((id) => {
      const x = model.idx[id], s = st.idx[id];
      const tc = Model.trackCorr(model.axis, cur.close, x.close);
      if (tc && tc.r != null && (!best || tc.r > best.r)) best = { id, r: tc.r, w: tc.weeks };
      const lab = { set: 'SET', era: 'ERA', family: 'FAMILY', char: 'CHAR', theme: 'THEME', all: 'ALL' }[x.kind] || x.kind.toUpperCase();
      return `<button class="ctx-row" data-k="${id}" type="button"><span class="ck">${lab}</span><span class="cn">${icon(x)}${esc(x.name)}</span><span class="cv">${fmtP(s.c30, 0)}</span></button>`;
    }).join('');
    const trk = best && best.r >= 0.3 ? `Moves most with <b>${esc(model.idx[best.id].name)}</b> <span class="dim">(weekly r ${best.r.toFixed(2)}, ${best.w} wks)</span>` : best ? '<span class="dim">No clear link to any index yet (weekly r below 0.3).</span>' : '';
    return `<h3>ITS INDEXES <span class="dim">30D</span></h3>${rows}${trk ? `<p class="trk">${trk}</p>` : ''}`;
  }

  function renderSignal(cur, bench0, ratio) {
    const bench = ratio ? null : bench0?.close || (cur.id === 'idx:all' ? null : model.index);
    const s = ratio ? signals(ratio, null, null) : signals(cur.close, cur.vol, bench);
    const benchName = bench0 ? symName(bench0) : cur.id === 'idx:all' ? '—' : 'ALL IDX';
    $('sigName').textContent = ratio ? `${cur.isIndex ? symName(cur) : cur.card.name} ÷ ${symName(bench0)} · ${Model.GRADE_LABEL[state.grade]}` : `${cur.isIndex ? idxLabel(cur.index) : cur.card.name + lineTag(cur.card)} · ${Model.GRADE_LABEL[state.grade]}`;
    const img = $('sigImg'), card = !cur.isIndex && !ratio ? cur.card : null;
    const ix = cur.isIndex && !ratio ? cur.index : null, ixIcon = ix && (ix.sprite || ix.symbol);
    img.classList.toggle('icon', !!ixIcon); img.classList.toggle('pix', !!ix?.sprite);
    if (card?.tcgPlayerId || ixIcon) { // shown only once it has actually loaded
      const u = ixIcon || `https://tcgplayer-cdn.tcgplayer.com/product/${card.tcgPlayerId}_in_200x200.jpg`;
      if (img.dataset.u !== u) { img.hidden = true; img.onload = () => { img.hidden = false; }; img.onerror = () => { img.hidden = true; }; img.dataset.u = u; img.alt = card ? card.name : ix.name; img.src = u; }
      else img.hidden = !(img.complete && img.naturalWidth > 0);
    } else img.hidden = true;
    const base = card ? card.key.replace(/~alt$/, '') : null;
    $('sigStar').hidden = !base; if (base) { const on = isStar(base); $('sigStar').textContent = on ? '★' : '☆'; $('sigStar').classList.toggle('on', on); $('sigStar').dataset.k = base; }
    const chg = !ratio && stats().ch[cur.id];
    $('sigChange').innerHTML = chg ? `<span class="${chg.dir > 0 ? 'pos' : 'neg'}">${chg.dir > 0 ? '▲' : '▼'} this week:</span> ${esc(chg.items.map((i) => i.text).join(' · '))}` : '';
    const gz = !ratio && !cur.isIndex && !model.dense ? tpiCard(cur.id) : null, ov = gz?.s.stale() ? gz.liq.overdue : null;
    if (ov) $('sigChange').innerHTML = `<span class="warn">⧗ Newest ${Model.GRADE_LABEL[state.grade]} sales likely missing</span> — last sale ${ov.since}d ago${ov.typ ? `, usually every ~${ov.typ}d` : ''}. The provider posts sales late; readings below may lag the real market.` + (chg ? '<br>' + $('sigChange').innerHTML : '');
    $('sigChange').hidden = !chg && !ov;
    $('scoreVal').textContent = s.score == null ? '—' : s.score;
    $('scoreBar').style.width = (s.score ?? 0) + '%';
    const tag = $('scoreTag'); tag.textContent = s.tag?.[0] || '—'; tag.className = 'tag ' + (s.tag?.[1] || 'mid');
    const rows = [
      [ratio ? 'Ratio (base 100)' : cur.isIndex ? 'Level' : 'Last', s.last != null ? (cur.isIndex || ratio ? s.last.toFixed(1) : money(s.last)) : '—'],
      ['7D / 30D', `${fmtP(s.c7)} / ${fmtP(s.c30)}`],
      ['90D / 1Y', `${fmtP(s.c90)} / ${fmtP(s.c365)}`],
      ['Momentum accel.', s.accel == null ? '—' : `<span class="${s.accel >= 0 ? 'pos' : 'neg'}">${s.accel >= 0 ? '+' : ''}${s.accel.toFixed(1)} pts</span>`],
      ...(ratio ? [] : [[`RS 30D vs ${benchName}`, fmtP(s.rs30)], ['RS 90D', fmtP(s.rs90)]]),
      ['RSI 14', s.rsi == null ? '—' : `<span class="${s.rsi > 70 ? 'neg' : s.rsi >= 50 ? 'pos' : 'dim'}">${s.rsi.toFixed(0)}</span>`],
      ['MACD hist', s.macdH == null ? '—' : `<span class="${s.macdH >= 0 ? 'pos' : 'neg'}">${s.macdH >= 0 ? 'above 0' : 'below 0'} · ${s.macdRising ? 'rising' : 'falling'}</span>`],
      ['vs SMA50', fmtP(s.distS50)],
      ['Sales pace 7D/30D', s.volRatio == null ? '—' : `<span class="${s.volRatio >= 1.2 ? 'pos' : s.volRatio < 0.8 ? 'neg' : ''}">${s.volRatio.toFixed(2)}×</span>`],
      ['Drawdown from 1Y high', fmtP(s.dd)],
      ...(!cur.isIndex && !ratio && stats().cards[cur.id]?.gap ? [(() => { const g = stats().cards[cur.id].gap, L = Model.GRADE_LABEL; return [`vs ${L[g.up]}`, `<span class="${g.gap < 0.8 ? 'warn' : ''}" title="${esc(L[model.grade])} price as a share of ${esc(L[g.up])}: now vs ${g.normSrc === 'own' ? "this card's own usual share (120D median)" : g.normSrc ? 'the ' + esc(normWord(g.normSrc)) + ' (not enough of its own history yet)' : 'nothing yet'}${g.peer != null ? `; ${esc(g.peerSrc === 'set' ? 'same-set' : g.peerSrc)} cards typically ${(g.peer * 100).toFixed(0)}%` : ''}">${(g.ratio * 100).toFixed(0)}% <span class="dim">(${normWord(g.normSrc)} ${g.norm != null ? (g.norm * 100).toFixed(0) + '%' : '—'})</span></span>`]; })()] : []),
      ...(!cur.isIndex && !ratio && stats().cards[cur.id]?.gap && stats().cards[cur.id].gap.gap < 0.8 ? (() => { const g = stats().cards[cur.id].gap, im = implied(cur.id, cur.card, model.grade, g.up); return im ? [['Implied price', `<span class="warn" title="${esc(impliedTxt(im))}">${money(im.price)} <span class="dim">(${im.upside >= 0 ? '+' : ''}${im.upside.toFixed(0)}%)</span></span>`]] : []; })() : []),
      ['Volatility 30D (ann.)', s.vol30 == null ? '—' : s.vol30.toFixed(0) + '%'],
      ...(ratio ? [] : [[cur.isIndex ? 'Members' : model.dense ? 'Price days' : 'Clean sale days', cur.isIndex ? String(cur.index.members.length) : String(cur.saleN)]]),
      ...(model.dense || ratio ? [] : [['Sale days, last 90D', s.saleDays90 == null ? '—' : `<span class="${s.saleDays90 < Model.MIN_SALE_DAYS_90 ? 'neg' : ''}">${s.saleDays90}</span>`]]),
      ...(model.dense || ratio || cur.isIndex ? [] : (() => { const q = Model.liquidity(model, cur), R = q.rules; return [
        ['Tradable', Model.tradable(model, cur) ? '<span class="pos">yes</span>' : q.overdue?.stale && q.liquid && Model.aboveMin(model, cur) ? `<span class="warn" title="Last sale ${q.overdue.since}d ago; usually sells every ~${q.overdue.typ}d. The provider posts sales late, so newer sales are probably missing.">⧗ newest sales missing</span>` : `<span class="neg" title="Needs ${R.liqDays}+ sale days in ${R.liqWin}D, a sale within ${R.liqAge}D${model.minPrice ? ` and ${money(model.minPrice)}+` : ''}">no · ${!Model.aboveMin(model, cur) ? 'under ' + money(model.minPrice) : q.days < R.liqDays ? `${q.days}/${R.liqDays} sale days` : `last sale ${q.age}d ago`}</span>`],
        ['Sales spread 90D', q.spread == null ? '—' : `<span class="${q.wide ? 'warn' : ''}" title="75th ÷ 25th percentile of recent sales. Above ${R.spreadFlag}× the price you pay depends heavily on which listing you catch.">${q.spread.toFixed(2)}×${q.wide ? ' wide' : ''}</span>`],
      ]; })()),
      ['History', `${s.days} days`],
    ];
    $('sigCtx').innerHTML = setupLine(cur, ratio) + gaugeRows(cur, ratio) + ladderRows(cur, ratio) + valueRows(cur, ratio) + contextRows(cur, ratio);
    $('metrics').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  const isStar = (k) => state.stars.includes(k);
  const chgBadge = (c) => (c ? `<span class="chg ${c.dir > 0 ? 'up' : 'dn'}" title="This week: ${esc(c.items.map((i) => i.text).join('; '))}">${c.dir > 0 ? '▲' : '▼'}</span>` : '');
  function cardRow(b, M, st) {
    const c = b.card, s = st.cards[c.key], alt = model.by[c.key + '~alt']?.card;
    return { key: c.key, name: c.name, set: c.set, custom: !!c.custom, sub: `${c.role === 'group' ? 'idx-only · ' : ''}${c.set} #${c.number}${alt ? ` · ${c.line}/${alt.line}${c.est ? '*' : ''}` : c.line ? ' · ' + c.line : ''}`, last: s.last, lastTxt: s.last != null ? money(s.last) : '—', metric: M.get(s), score: s.score, tag: s.tag, ch: st.ch[c.key], basket: c.basket || slug(c.set), setup: edgeLive(c.key), sprite: c.sprite };
  }
  function idxRow(x, M, st) {
    const s = st.idx[x.id];
    const where = { all: '', family: 'era family · ', era: 'era · ', set: `${x.era} · `, char: x.scope === 'all' ? 'character ladder · ' : 'character · ', theme: x.scope === 'all' ? 'theme ladder · ' : 'theme · ' }[x.kind] ?? '';
    return { key: x.id, name: x.name, sub: `${where}${x.members.length} cards`, last: s.last, lastTxt: s.last != null ? s.last.toFixed(1) : '—', metric: M.get(s), score: s.score, tag: s.tag, ch: st.ch[x.id], isIdx: true, sprite: x.sprite, symbol: x.symbol };
  }
  function rowHtml(r, M, extra = '') {
    const cls = r.score == null ? 'na' : r.tag[1];
    const star = r.isIdx ? '' : `<button class="st-btn${isStar(r.key) ? ' on' : ''}" data-star="${r.key}" title="${isStar(r.key) ? 'Remove from' : 'Add to'} MINE" aria-label="Star ${esc(r.name)}">${isStar(r.key) ? '★' : '☆'}</button>`;
    return `<tr class="row${r.key === state.key ? ' sel' : ''}${r.key === state.vs ? ' cmp' : ''}${extra}" data-k="${r.key}" tabindex="0">
      <td><span class="nm">${icon(r)}${esc(r.name)}${chgBadge(r.ch)}${r.setup ? `<span class="setup ${r.setup.status}" title="${r.setup.status === 'confirmed' ? 'Confirmed' : 'Promising (could be luck)'} setup fired ${r.setup.best.ago}d ago: ${esc(r.setup.best.label)} — see SETUPS">${r.setup.status === 'confirmed' ? '◆' : '◇'}</span>` : ''}</span><span class="st">${esc(r.sub)}</span></td>
      <td class="n">${r.lastTxt}</td>
      <td class="n">${M.fmt(r.metric)}</td>
      <td class="n"><span class="pill ${cls}" title="${r.tag?.[0] || ''}">${r.score ?? '··'}</span></td>
      <td class="acts"><button class="sw${r.key === state.vs ? ' on' : ''}" data-vs="${r.key}" title="Compare against this" aria-label="Compare against ${esc(r.name)}">⇄</button>${star}</td></tr>`;
  }
  function renderWatchlist() {
    const view = state.wlView, brief = view === 'brief';
    document.querySelectorAll('#wlTabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
    document.querySelector('.wl table').hidden = brief; $('briefList').hidden = !brief;
    $('groupBtn').hidden = view !== 'cards'; $('groupBtn').setAttribute('aria-pressed', String(!!state.group));
    if (brief) { renderBriefList(); return; }
    $('wlFirstCol').textContent = view === 'sets' ? 'Index' : 'Card';
    $('wlLastCol').textContent = view === 'sets' ? 'Level' : 'Last';
    const M = METRICS[state.wlMetric] || METRICS.c30;
    $('wlMetric').value = state.wlMetric in METRICS ? state.wlMetric : 'c30';
    const st = stats();
    const k = state.sort === 'c30' ? 'metric' : state.sort, dir = state.dir;
    const cmp = (a, b) => { const x = a[k], y = b[k]; if (x == null) return y == null ? 0 : 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * dir; };
    const allMains = Object.values(model.by).filter((b) => !b.card.virtual);
    const showUnder = state.collapsed.includes('under'), under = allMains.filter((b) => !Model.aboveMin(model, b));
    const mains = showUnder ? allMains : allMains.filter((b) => Model.aboveMin(model, b)); // slabs under the minimum price are hidden unless shown
    let html = '';
    if (view === 'sets') {
      // Ladders = one row per character/theme (its all-eras index when it spans eras); per-era splits sit in collapsible sections.
      const all = Object.values(model.idx), lad = { char: Model.ladder(model, 'char'), theme: Model.ladder(model, 'theme') };
      const ladIds = new Set([...lad.char, ...lad.theme].map((x) => x.id));
      const secs = [
        ['all', 'Market', all.filter((x) => x.kind === 'all')],
        ['family', 'Era families', all.filter((x) => x.kind === 'family')],
        ['era', 'Eras', all.filter((x) => x.kind === 'era')],
        ['set', 'Sets', all.filter((x) => x.kind === 'set')],
        ['lad:char', 'Character ladder', lad.char],
        ['lad:theme', 'Themes', lad.theme],
        ['by:char', 'Characters by era', all.filter((x) => x.kind === 'char' && !ladIds.has(x.id)), true],
        ['by:theme', 'Themes by era', all.filter((x) => x.kind === 'theme' && !ladIds.has(x.id)), true],
      ];
      html = secs.map(([key, title, xs, fold]) => {
        if (!xs.length) return '';
        const rows = xs.map((x) => idxRow(x, M, st)).sort(cmp);
        const tk = 'sec:' + key, open = fold ? state.collapsed.includes(tk) : !state.collapsed.includes(tk); // folded sections: toggled = open
        return `<tr class="sec" data-toggle="${tk}"><td colspan="5">${open ? '▾' : '▸'} ${title} <span class="dim">${xs.length}</span></td></tr>` + (open ? rows.map((r) => rowHtml(r, M)).join('') : '');
      }).join('');
    } else if (view === 'setups') { // cards where a tested setup fired in the last 7 days
      const e = edge();
      if (!e) html = '<tr><td colspan="5" class="empty">Testing setups against history…</td></tr>';
      else {
        // Rank: confirmed first, then how many separate setups are firing on the card, then the best one's evidence.
        const picks = e.ok ? e.picks.filter((p) => model.by[p.key]).map((p) => ({ ...p, nRules: p.rules.length })).sort((a, b) => (a.status === 'confirmed' ? 0 : 1) - (b.status === 'confirmed' ? 0 : 1) || b.nRules - a.nRules || (a.best.p ?? 1) - (b.best.p ?? 1)) : [];
        const q = picks.length ? Math.max(...picks.map((p) => p.best.q ?? 1)) : null;
        const note = `<tr class="sec"><td colspan="5"><p class="setupnote">${esc(Edge.verdict(e))}${picks.some((p) => p.status === 'promising') ? ` <b>◇ promising</b> = beat other cards in the past but didn't survive the luck correction${q != null ? ` (up to ~${Math.round(q * 100)}% of these could be flukes)` : ''}; <b>◆ confirmed</b> = did. Sorted by how many setups agree (×N). ${picks.length} of ${Object.keys(model.by).length} card lines — a lead to research, not a buy signal.` : ''}</p></td></tr>`;
        html = note + (picks.length ? picks.map((p) => { const r = cardRow(model.by[p.key], M, st); r.sub = `${p.status === 'confirmed' ? '◆' : '◇'}${p.nRules > 1 ? '×' + p.nRules : ''} ${p.best.label} · ${p.best.ago === 0 ? 'today' : p.best.ago + 'd ago'} · ${Edge.pct(p.best.vsPeers, 1)} vs peers${(() => { const f = fwdOf(p.best.id); return f?.n ? ` · live ${Edge.pct(f.vsPeers, 0)} (${f.n})` : ''; })()}${(() => { const q = Model.liquidity(model, model.by[p.key]); return q.wide ? ` · ⚠ spread ${q.spread.toFixed(1)}×` : ''; })()}`; return rowHtml(r, M, p.status === 'confirmed' ? ' setup-conf' : ' setup-prom'); }).join('') : '<tr><td colspan="5" class="empty">No tested setup has fired in the last 7 days.</td></tr>');
      }
      html += fwdSection();
    } else if (view === 'zone') { // tradable slabs by gauge zone, best prospects first
      const G = tpiAll(), L = Model.GRADE_LABEL[state.grade];
      const groups = ['buy', 'watch', 'late', 'neutral', 'avoid'].map((z) => [z, G.ranked.filter((c) => c.zone === z)]);
      const note = `<tr class="sec"><td colspan="5"><p class="setupnote">Tradable ${L} slabs (${model.minPrice ? money(model.minPrice) + '+, ' : ''}liquid) by trend &amp; value gauge. <b>BUY ZONE</b> = trend ≥ +0.5 and priced fair or cheap · <b>WATCH</b> = cheap, trend not up yet · <b>LATE</b> = trend up but pricey. Open ◔ GAUGES for the dashboard. A lead to research until the forward record backs the zones.</p></td></tr>`;
      html = note + groups.map(([z, xs]) => {
        if (!xs.length) return '';
        const tk = 'zone:' + z, open = z === 'buy' || z === 'watch' ? !state.collapsed.includes(tk) : state.collapsed.includes(tk);
        return `<tr class="sec" data-toggle="${tk}"><td colspan="5">${open ? '▾' : '▸'} ${TPI.ZONES[z].label} <span class="dim">${xs.length} · ${esc(TPI.ZONES[z].note)}</span></td></tr>` + (open ? xs.map((c) => { const r = cardRow(c.b, M, st); r.sub = `trend ${sgn(c.t)} ${c.roc == null ? '' : c.roc > 0.05 ? '▲' : c.roc < -0.05 ? '▼' : '▬'} · value ${sgn(c.v)} (${TPI.vlabel(c.v).toLowerCase()})${c.liq.wide ? ` · ⚠ spread ${c.liq.spread.toFixed(1)}×` : ''}`; return rowHtml(r, M, ' zrow z-' + z); }).join('') : '');
      }).join('') || '<tr><td colspan="5" class="empty">No tradable slab has a gauge reading yet.</td></tr>';
    } else if (view === 'lag') { // a neighbouring grade jumped, this grade hasn't followed
      const L = Model.GRADE_LABEL, rows = model.dense ? [] : lagList(), e = EDGE[state.grade];
      const bt = ['lagUp', 'lagDown'].map((id) => e?.ok ? e.results.find((r) => r.id === id) : null).filter((x) => x && x.n);
      const note = `<tr class="sec"><td colspan="5"><p class="setupnote">⤴ A card's neighbouring grade rose ≥20% in 30 days (with a sale in the last 14 days) while the grade shown stayed within +5% and still sells. Sorted by the gap between the two moves; click to open that grade. Backtest (${L[state.grade]}): ${bt.length ? bt.map((x) => `${x.id === 'lagUp' ? 'grade above led' : 'grade below led'} ${Edge.pct(x.vsPeers, 1)} vs peers over 30D (${x.n}×, ${x.status === 'few' ? 'too few to judge' : x.status})`).join(' · ') : 'not enough history yet'}. Check the jump came from several sales before chasing.</p></td></tr>`;
      const M2 = { fmt: (v) => (v == null ? '<span class="dim" title="No usual ratio yet, so no implied price">—</span>' : `<span class="warn" title="Upside to the implied price">${v >= 0 ? '+' : ''}${v.toFixed(0)}%</span>`) };
      const M3 = { fmt: (v) => (v == null ? '—' : `<span class="sqzm" title="Upside to the implied price">${v >= 0 ? '+' : ''}${v.toFixed(0)}%</span>`) };
      const sqs = model.dense ? [] : squeezeList(), sr = e?.ok ? e.results.find((r) => r.id === 'squeeze') : null;
      const sqHtml = sqs.length ? `<tr class="sec"><td colspan="5">⇅ Compressed <span class="dim">${sqs.length}</span><p class="setupnote">Priced almost like the grade below: that grade sells for ≥80% of this grade's price and ≥1.4× its usual share: this grade may not have repriced yet. Backtest (${L[state.grade]}): ${sr && sr.n ? `${Edge.pct(sr.vsPeers, 1)} vs peers over 30D (${sr.n}×, ${sr.status === 'few' ? 'too few to judge' : sr.status})` : 'not enough history yet'}.</p></td></tr>` + sqs.map((x) => {
        const im = implied(x.k, x.card, x.sq.grade, x.sq.down);
        const r = { key: x.k, name: x.card.name + (x.card.line && !x.card.mixed ? ` · ${x.card.line.replace(/ \(est\.\)/, '')}` : ''), sub: `${L[x.sq.down]} = ${(x.sq.ratio * 100).toFixed(0)}% of ${L[x.sq.grade]} · ${normWord(x.sq.normSrc)} ${x.sq.norm != null ? (x.sq.norm * 100).toFixed(0) + '%' : '—'}${im ? ' ' + impliedTxt(im, { short: true }) : ''}`, lastTxt: `<span title="${esc(im ? impliedTxt(im) : L[x.sq.grade] + ' price')}">${money(x.sq.price)}</span>`, metric: im ? im.upside : null, score: null, tag: null, sprite: x.card.sprite, isIdx: false };
        return rowHtml(r, M3, ' sqzrow').replace('<tr class="row', `<tr data-lgrade="${x.sq.grade}" class="row`).replace(/<span class="pill[^"]*"[^>]*>··<\/span>/, `<span class="pill sqzp">${L[x.sq.grade].replace('PSA ', '')}</span>`);
      }).join('') + `<tr class="sec"><td colspan="5">⤴ Lagging <span class="dim">${rows.length}</span></td></tr>` : '';
      html = model.dense ? `<tr class="sec"><td colspan="5">${rawNote()}</td></tr>` : sqHtml + note + (rows.length ? rows.map((x) => {
        const im = implied(x.k, x.card, x.lag.grade, x.led.grade);
        const r = { key: x.k, name: x.card.name + (x.card.line && !x.card.mixed ? ` · ${x.card.line.replace(/ \(est\.\)/, '')}` : ''), sub: `${L[x.lag.grade]} ${Edge.pct(x.lag.c30, 0)} · ${L[x.led.grade]} ${Edge.pct(x.led.c30, 0)}${im ? ' ' + impliedTxt(im, { short: true }) : ''}`, lastTxt: `<span title="${esc(im ? impliedTxt(im) : L[x.lag.grade] + ' price')}">${money(x.lag.price)}</span>`, metric: im ? im.upside : null, spread: x.spread, score: null, tag: null, sprite: x.card.sprite, isIdx: false };
        return rowHtml(r, M2, ' lagrow').replace('<tr class="row', `<tr data-lgrade="${x.lag.grade}" class="row`).replace(/<span class="pill[^"]*"[^>]*>··<\/span>/, `<span class="pill lagg">${L[x.lag.grade].replace('PSA ', '')}</span>`);
      }).join('') : '<tr><td colspan="5" class="empty">No lagging grades right now.</td></tr>');
    } else if (view === 'mine') {
      const rows = mains.filter((b) => isStar(b.card.key)).map((b) => cardRow(b, M, st)).sort(cmp);
      html = rows.length ? rows.map((r) => rowHtml(r, M)).join('') : `<tr><td colspan="5" class="empty">Star cards with ☆ (or press S) to keep them here. Stars are saved in this browser.</td></tr>`;
    } else if (state.group) { // grouped by set: set index row, then its cards
      const rows = mains.map((b) => cardRow(b, M, st));
      const sets = Object.values(model.idx).filter((x) => x.kind === 'set').map((x) => ({ ...idxRow(x, M, st), basket: x.id.slice(8) })).sort(cmp);
      // Era picks without a set index (one card from a set) group under their era instead.
      const have = new Set(sets.map((g) => g.basket)), loose = rows.filter((r) => !have.has(r.basket));
      const lEras = [...new Set(loose.map((r) => model.by[r.key].card.era))];
      html = lEras.map((e) => {
        const tk = 'loose:' + slug(e), open = !state.collapsed.includes(tk), kids = loose.filter((r) => model.by[r.key].card.era === e).sort(cmp);
        return `<tr class="sec" data-toggle="${tk}"><td colspan="5">${open ? '▾' : '▸'} ${esc(e)} picks <span class="dim">${kids.length}</span></td></tr>` + (open ? kids.map((r) => rowHtml(r, M, ' kid')).join('') : '');
      }).join('') + sets.map((g) => {
        const open = !state.collapsed.includes(g.key);
        const kids = rows.filter((r) => r.basket === g.basket).sort(cmp);
        return rowHtml({ ...g, name: `${open ? '▾' : '▸'} ${g.name}` }, M, ' grp').replace('<tr class="row', `<tr data-toggle="${g.key}" class="row`) + (open ? kids.map((r) => rowHtml(r, M, ' kid')).join('') : '');
      }).join('');
    } else {
      html = mains.map((b) => cardRow(b, M, st)).sort(cmp).map((r) => rowHtml(r, M)).join('');
    }
    if (view === 'cards' && under.length) html += `<tr class="sec" data-toggle="under"><td colspan="5">${showUnder ? '▾' : '▸'} ${under.length} ${Model.GRADE_LABEL[state.grade]} slabs under ${money(model.minPrice)} <span class="dim">${showUnder ? 'shown above · click to hide' : 'hidden · click to show'}</span></td></tr>`;
    if (model.dense && view !== 'brief') html = `<tr class="sec"><td colspan="5">${rawNote()}</td></tr>` + html;
    document.querySelector('.wl table').classList.toggle('lagv', view === 'lag');
    $('wlBody').innerHTML = html;
  }

  // ---------- picker: Era ▸ Set ▸ Card tree with type-to-search (both slots) ----------
  const PK = { A: { open: new Set(), q: '', hi: 0 }, B: { open: new Set(), q: '', hi: 0 } };
  function pickerLabel(id, slot) {
    if (slot === 'B' && (!id || id === 'none')) return 'None';
    if (id === 'set') return 'Own set index';
    if (id === 'era') return 'Own era index';
    const x = model.idx[id]; if (x) return idxLabel(x);
    const b = model.by[id]; if (b) return `${b.card.name} — ${b.card.set} #${b.card.number}`;
    return '—';
  }
  function pickerItems(slot) {
    const P = PK[slot], q = P.q.trim().toLowerCase(), st = stats();
    const cards = Object.values(model.by).filter((b) => !b.card.virtual);
    const eras = [...new Set(cards.filter((b) => b.card.role !== 'group').map((b) => b.card.era))];
    const items = [];
    const cardItem = (b, depth) => { const s = st.cards[b.card.key]; return { id: b.card.key, depth, kind: 'card', sprite: b.card.sprite, text: `${b.card.name}`, sub: `#${b.card.number}${model.by[b.card.key + '~alt'] ? ' · 2 printings' : ''}`, right: s.last != null ? money(s.last) : '', c30: s.c30, custom: b.card.custom }; };
    const idxItem = (x, depth, open, hasKids) => { const s = st.idx[x.id]; return { id: x.id, depth, kind: x.kind, sprite: x.sprite, symbol: x.symbol, text: x.kind === 'all' ? 'All tracked index' : x.name, sub: `${x.members.length} cards`, right: s.last != null ? s.last.toFixed(1) : '', c30: s.c30, open, hasKids }; };
    if (slot === 'B') items.push({ id: 'none', depth: 0, kind: 'opt', text: 'None' }, { id: 'set', depth: 0, kind: 'opt', text: 'Own set index' }, { id: 'era', depth: 0, kind: 'opt', text: 'Own era index' });
    if (q) { // flat search: indexes and cards whose name / set / number match every word
      const words = q.split(/\s+/);
      const hit = (t) => words.every((w) => t.includes(w));
      for (const x of Object.values(model.idx)) if (hit(`${x.name} ${x.kind === 'all' ? 'all tracked' : ''} ${KIND_WORD[x.kind] || x.kind} index`.toLowerCase())) { const it = idxItem(x, 0, false, false); it.sub = `${KIND_WORD[x.kind] || x.kind} · ${it.sub}`; items.push(it); }
      for (const b of cards) if (hit(`${b.card.name} ${b.card.set} ${b.card.number} ${b.card.era}`.toLowerCase())) { const it = cardItem(b, 0); it.sub = `${b.card.set} ${it.sub}`; items.push(it); }
      return items;
    }
    const mine = cards.filter((b) => isStar(b.card.key));
    if (mine.length) { items.push({ id: 'grp:mine', depth: 0, kind: 'group', text: '★ Mine', sub: `${mine.length} cards`, open: P.open.has('grp:mine'), hasKids: true }); if (P.open.has('grp:mine')) mine.forEach((b) => { const it = cardItem(b, 1); it.sub = `${b.card.set} ${it.sub}`; items.push(it); }); }
    if (model.idx['idx:all']) items.push(idxItem(model.idx['idx:all'], 0, false, false));
    for (const e of eras) {
      const ex = model.idx['idx:era:' + slug(e)], eo = P.open.has('era:' + e);
      items.push({ ...(ex ? idxItem(ex, 0, eo, true) : { id: null, depth: 0, kind: 'era', text: e }), tog: 'era:' + e, open: eo, hasKids: true });
      if (!eo) continue;
      const sets = Object.values(model.idx).filter((x) => x.kind === 'set' && x.era === e);
      for (const sx of sets) {
        const so = P.open.has(sx.id);
        items.push({ ...idxItem(sx, 1, so, true), tog: sx.id });
        if (so) cards.filter((b) => b.card.role !== 'group' && (b.card.basket || slug(b.card.set)) === sx.id.slice(8)).forEach((b) => items.push(cardItem(b, 2)));
      }
      cards.filter((b) => b.card.role !== 'group' && b.card.era === e && !model.idx['idx:set:' + (b.card.basket || slug(b.card.set))])
        .forEach((b) => { const it = cardItem(b, 1); it.sub = `${b.card.set} ${it.sub}`; items.push(it); });
    }
    for (const [kind, title] of [['char', 'Characters'], ['theme', 'Themes']]) {
      const gs = Model.ladder(model, kind); if (!gs.length) continue;
      const t = 'grp:' + kind, o = P.open.has(t);
      items.push({ id: null, depth: 0, kind: 'era', text: title, sub: `${gs.length} ladder indexes`, tog: t, open: o, hasKids: true });
      if (!o) continue;
      for (const gx of gs.sort((a, b) => (a.base || a.name).localeCompare(b.base || b.name))) {
        const go = P.open.has(gx.id);
        items.push({ ...idxItem(gx, 1, go, true), tog: gx.id });
        if (!go) continue;
        // per-era splits of this character/theme, then its cards
        Object.values(model.idx).filter((y) => y.kind === kind && y.id !== gx.id && (y.base || y.name) === (gx.base || gx.name))
          .forEach((y) => items.push(idxItem(y, 2, false, false)));
        gx.members.forEach((k) => { const b = model.by[k]; if (b) { const it = cardItem(b, 2); it.sub = `${b.card.set} ${it.sub}`; items.push(it); } });
      }
    }
    return items;
  }
  function renderPicker(slot) {
    const root = $(slot === 'A' ? 'pickA' : 'pickB'), P = PK[slot];
    const cur = slot === 'A' ? state.key : state.vs;
    root.querySelector('.pk-val').textContent = pickerLabel(cur, slot);
    const pop = root.querySelector('.pk-pop'); if (pop.hidden) return;
    const items = pickerItems(slot).filter((it) => !(slot === 'B' && it.id === state.key));
    P.hi = Math.max(0, Math.min(P.hi, items.length - 1));
    const pc = (v) => (v == null ? '' : `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(0)}%</span>`);
    let html = items.map((it, i) => `<div class="pk-it d${it.depth} k-${it.kind}${it.id === cur ? ' cur' : ''}${i === P.hi ? ' hi' : ''}" data-i="${i}" role="option">
        ${it.hasKids ? `<button class="pk-tog" data-tog="${esc(it.tog || it.id)}" tabindex="-1" aria-label="${it.open ? 'Collapse' : 'Expand'}">${it.open ? '▾' : '▸'}</button>` : '<span class="pk-sp"></span>'}
        <span class="pk-t">${icon(it)}${esc(it.text)}${it.custom ? ' <em>mine</em>' : ''}</span><span class="pk-s">${esc(it.sub || '')}</span><span class="pk-r">${it.right || ''} ${pc(it.c30)}</span></div>`).join('');
    if (model.dense && !P.q.trim()) html = `<div class="pk-miss">${rawNote()}</div>` + html;
    root.querySelector('.pk-list').innerHTML = html || '<div class="pk-miss">No matches.</div>';
    root._items = items;
    root.querySelector('.pk-it.hi')?.scrollIntoView({ block: 'nearest' });
  }
  function openPicker(slot, on = true) {
    const root = $(slot === 'A' ? 'pickA' : 'pickB'), pop = root.querySelector('.pk-pop'), P = PK[slot];
    for (const o of ['A', 'B']) if (o !== slot) $(o === 'A' ? 'pickA' : 'pickB').querySelector('.pk-pop').hidden = true;
    pop.hidden = !on; root.classList.toggle('open', on);
    if (on) {
      const cur = slot === 'A' ? state.key : state.vs, b = model.by[cur], x = model.idx[cur];
      const era = b ? b.card.era : x?.era || (x?.kind === 'era' ? x.name : null);
      if (era) P.open.add('era:' + era);
      const setId = b ? 'idx:set:' + (b.card.basket || slug(b.card.set)) : x?.kind === 'set' ? x.id : null;
      if (setId) P.open.add(setId);
      if (x && (x.kind === 'char' || x.kind === 'theme')) P.open.add('grp:' + x.kind);
      P.q = ''; root.querySelector('.pk-q').value = ''; P.hi = 0;
      renderPicker(slot);
      const i = (root._items || []).findIndex((it) => it.id === cur); if (i >= 0) { P.hi = i; renderPicker(slot); }
      root.querySelector('.pk-q').focus();
    }
  }
  function choose(slot, id) {
    if (!id || id.startsWith('grp:')) return;
    openPicker(slot, false);
    if (slot === 'A') select(id);
    else { state.vs = id; if (id === 'none') state.merge = false; renderSelects(); refresh({ keepView: true }); }
  }
  function bindPicker(slot) {
    const root = $(slot === 'A' ? 'pickA' : 'pickB'), P = PK[slot], q = root.querySelector('.pk-q');
    root.querySelector('.pk-btn').addEventListener('click', () => openPicker(slot, root.querySelector('.pk-pop').hidden));
    q.addEventListener('input', () => { P.q = q.value; P.hi = 0; renderPicker(slot); });
    q.addEventListener('keydown', (e) => {
      const items = root._items || [];
      if (e.key === 'ArrowDown') { P.hi = Math.min(items.length - 1, P.hi + 1); renderPicker(slot); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { P.hi = Math.max(0, P.hi - 1); renderPicker(slot); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const it = items[P.hi]; if (it?.hasKids && !P.q) { const t = it.tog || it.id; e.key === 'ArrowRight' ? P.open.add(t) : P.open.delete(t); renderPicker(slot); e.preventDefault(); } }
      else if (e.key === 'Enter') { const it = items[P.hi]; if (it) choose(slot, it.id); e.preventDefault(); }
      else if (e.key === 'Escape') { openPicker(slot, false); root.querySelector('.pk-btn').focus(); }
    });
    root.querySelector('.pk-list').addEventListener('click', (e) => {
      const tg = e.target.closest('[data-tog]');
      if (tg) { const t = tg.dataset.tog; P.open.has(t) ? P.open.delete(t) : P.open.add(t); renderPicker(slot); q.focus(); return; }
      const it = e.target.closest('.pk-it'); if (!it) return;
      const item = root._items[+it.dataset.i];
      if (item.id) choose(slot, item.id); else if (item.hasKids) { const t = item.tog; P.open.has(t) ? P.open.delete(t) : P.open.add(t); renderPicker(slot); }
    });
  }

  function renderSelects() {
    const valid = ['none', 'set', 'era'].includes(state.vs) || model.by[state.vs] || model.idx[state.vs];
    if (!valid || state.vs === state.key) state.vs = state.key === 'idx:all' ? 'none' : 'idx:all';
    renderPicker('A'); renderPicker('B');
  }

  function syncButtons() {
    const set = (id, v) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
    set('grade', state.grade); set('range', state.range); set('res', state.res);
    $('ind').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === 'guide' ? !!state.guide : !!state.ind[b.dataset.v]));
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

  // Consensus across grades is grade-independent, so it's computed once per data load.
  let CONS = null;
  function consensusOnce() {
    if (CONS) return CONS;
    const models = {};
    for (const g of ['psa7', 'psa8', 'psa9', 'psa10']) { const m = g === state.grade ? model : Model.buildModel(WL, SERIES, g); if (Object.keys(m.by).length) models[g] = m; }
    return (CONS = Model.consensus(models));
  }
  // ---------- setup backtest (js/edge.js): once per grade, computed just after first paint ----------
  const EDGE = {}; let edgePending = null, EW = undefined; const WORKQ = {};
  function edgeWorker() {
    if (EW !== undefined) return EW;
    try {
      if (window.__SLABDEX_DATA__ || typeof Worker === 'undefined') return (EW = null);
      EW = new Worker('js/edge-worker.js');
      EW.onmessage = (e) => { const d = e.data, q = WORKQ[d.grade]; if (!q) return; delete WORKQ[d.grade]; if (d.type === 'done') q.done(d.result); else q.fallback(); };
      EW.onerror = (e) => { console.warn('edge worker failed, using the main thread', e.message); const qs = Object.values(WORKQ); for (const k in WORKQ) delete WORKQ[k]; EW.terminate(); EW = null; qs.forEach((q) => q.fallback()); };
      EW.postMessage({ type: 'init', WL, SERIES });
    } catch (err) { console.warn(err); EW = null; }
    return EW;
  }
  function edge() {
    const g = state.grade;
    if (EDGE[g] || typeof Edge === 'undefined') return EDGE[g] || null;
    if (edgePending !== g) {
      edgePending = g;
      const done = (res) => { EDGE[g] = res; edgePending = null; if (model.grade === g) { rankIndicators(); renderBrief(); refresh({ keepView: true }); } };
      const onMain = () => setTimeout(() => {
        if (model.grade !== g) { edgePending = null; return; }
        let res; try { res = Edge.run(model, { others: ['psa7', 'psa8', 'psa9', 'psa10'].filter((x) => x !== g).map(otherModel) }); } catch (err) { console.error(err); res = { ok: false, reason: 'backtest failed' }; }
        done(res);
      }, 40);
      // The backtest is the heaviest job (~1 s on a fast laptop, several on a phone): run it in a background worker so
      // the page stays responsive. Falls back to the main thread where workers aren't available (the offline preview).
      const w = edgeWorker();
      if (!w) onMain();
      else { WORKQ[g] = { done, fallback: onMain }; w.postMessage({ type: 'run', grade: g }); }
    }
    return null;
  }
  // Order the indicator buttons by backtest evidence for this grade (strongest first) and put the evidence in each tooltip.
  const IND_BASES = { st: ['stUp'], sma50: ['px50', 'gold'], hma: ['hmaUp'], rs: ['rsX'], sma20: ['gold'], vzo: ['vzoX'], rsi: ['rsi30', 'rsi50'], vol: ['volUp'], macd: ['macdX', 'macdX0'] };
  function rankIndicators() {
    const e = EDGE[state.grade], bar = $('ind'); if (!e?.ok || !bar) return;
    const btns = [...bar.querySelectorAll('button')];
    const ev = {};
    for (const b of btns) {
      const bases = IND_BASES[b.dataset.v]; if (!bases) continue;
      const best = e.results.filter((r) => r.p != null && r.vsPeers > 0 && (r.parts || [r.id]).some((x) => bases.includes(x))).sort((a, c) => a.p - c.p)[0];
      ev[b.dataset.v] = best ? -Math.log10(best.p) : 0;
      b.title = b.title.replace(/\n\nBacktest:[\s\S]*$/, '') + (best ? `\n\nBacktest (${Model.GRADE_LABEL[state.grade]}): best with this — ${best.label}: ${Edge.stat(best)} · ${best.status}` : '\n\nBacktest: no positive result yet');
    }
    btns.sort((a, b) => (b.dataset.v === 'guide') - (a.dataset.v === 'guide') || (ev[b.dataset.v] ?? 0) - (ev[a.dataset.v] ?? 0)).forEach((b) => bar.appendChild(b));
  }
  const OTHER = {};
  const otherModel = (g) => (OTHER[g] ||= Model.buildModel(WL, SERIES, g)); // other grades, for cross-grade setups
  const edgeLive = (k) => { const e = EDGE[state.grade]; return e?.ok ? e.picks.find((p) => p.key === k) || null : null; };
  function setupLine(cur, ratio) {
    if (ratio || cur.isIndex) return '';
    const p = edgeLive(cur.id); if (!p) return '';
    const b = p.best, conf = p.status === 'confirmed';
    return `<p class="setupline ${conf ? 'conf' : ''}">${conf ? '◆ BACKTESTED SETUP' : '◇ Promising setup (not confirmed)'} · ${b.ago === 0 ? 'today' : b.ago + 'd ago'}<br><b>${esc(b.label)}</b><br><span class="dim">${esc(Edge.stat(b))}</span></p>`;
  }
  // ---------- trend & value gauges (js/tpi.js) ----------
  // Per grade: every card line's gauge series (cached), index gauges, and the ranked prospects.
  const GZ = {}, GC = new WeakMap();
  function idxGauge(id) { let c = GC.get(model); if (!c) { c = {}; GC.set(model, c); } const k = '#' + id; if (k in c) return c[k]; const s = TPI.indexSeries(model, id); return (c[k] = s && s.last >= 0 ? { id, x: model.idx[id], s, t: s.trend[s.last], v: s.value[s.last], roc: s.roc() } : null); }
  // One card's gauge (cached per model) — the Signal panel needs only this, not every card.
  function tpiCard(k) {
    let c = GC.get(model); if (!c) { c = {}; GC.set(model, c); }
    if (k in c) return c[k];
    const b = model.by[k]; if (!b || b.card.mixed || b.demo) return (c[k] = null);
    const g = model.grade, up = Model.NEXT[g] ? otherModel(Model.NEXT[g]) : null, down = Model.PREV[g] ? otherModel(Model.PREV[g]) : null;
    const s = TPI.series(model, k, { up, down }); if (!s || s.last < 0) return (c[k] = null);
    const i = s.last, q = Model.liquidity(model, b);
    const o = { k, b, s, t: s.trend[i], v: s.value[i], zone: s.zone[i], roc: s.roc(), tradable: Model.tradable(model, b), liq: q };
    o.score = TPI.prospect(o.t, o.v, o.roc) - (q.wide ? 0.2 : 0);
    return (c[k] = o);
  }
  function tpiAll() {
    const g = state.grade; if (GZ[g]?.m === model) return GZ[g];
    const cards = {}, idx = {};
    for (const k of Object.keys(model.by)) { const o = tpiCard(k); if (o) cards[k] = o; }
    for (const id of Object.keys(model.idx)) { const o = idxGauge(id); if (o) idx[id] = o; }
    const ranked = Object.values(cards).filter((c) => c.tradable && c.t != null).sort((a, b) => b.score - a.score);
    return (GZ[g] = { m: model, cards, idx, ranked, buy: ranked.filter((c) => c.zone === 'buy'), watch: ranked.filter((c) => c.zone === 'watch').sort((a, b) => b.v - a.v) });
  }
  const sgn = (v, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`);
  const rocTxt = (r) => (r == null ? '' : r > 0.05 ? `<span class="pos" title="Gauge vs a week ago">▲${Math.abs(r).toFixed(2)}</span>` : r < -0.05 ? `<span class="neg" title="Gauge vs a week ago">▼${Math.abs(r).toFixed(2)}</span>` : '<span class="dim" title="Gauge vs a week ago">▬</span>');
  // Semicircle gauge, -1 (left, red) … +1 (right, green).
  function gaugeSvg(v, { size = 120, label = true } = {}) {
    const w = size, h = size * 0.7, cx = w / 2, cy = size * 0.47, r = w * 0.4, sw = w * 0.085;
    const pt = (a, rr = r) => [cx + rr * Math.cos(Math.PI * (1 - a)), cy - rr * Math.sin(Math.PI * (1 - a))]; // a: 0 = left … 1 = right
    const arc = (a0, a1, cls) => { const [x0, y0] = pt(a0), [x1, y1] = pt(a1); return `<path class="${cls}" d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke-width="${sw}" fill="none"/>`; };
    const a = v == null ? null : (Math.max(-1, Math.min(1, v)) + 1) / 2, [nx, ny] = a == null ? [cx, cy] : pt(a, r * 0.9);
    return `<svg class="gsvg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Trend ${sgn(v)}">${arc(0, 0.375, 'ga-dn')}${arc(0.375, 0.625, 'ga-mid')}${arc(0.625, 1, 'ga-up')}${a == null ? '' : `<line class="ga-needle" x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke-width="${Math.max(2, w / 45)}"/>`}<circle class="ga-hub" cx="${cx}" cy="${cy}" r="${w / 22}"/>${label ? `<text class="ga-val" x="${cx}" y="${(cy + size * 0.2).toFixed(1)}" text-anchor="middle">${v == null ? '—' : sgn(v)}</text>` : ''}</svg>`;
  }
  // Value bar, -2 (expensive, red) … +2 (cheap, green).
  const valueBar = (v) => `<div class="vbar" title="Value ${sgn(v)} (−2 expensive … +2 cheap)"><i style="left:${v == null ? 50 : ((Math.max(-2, Math.min(2, v)) + 2) / 4) * 100}%"${v == null ? ' hidden' : ''}></i></div>`;
  const zoneChip = (z) => `<span class="zchip z-${z}" title="${esc(TPI.ZONES[z].note)}">${TPI.ZONES[z].label}</span>`;
  function prospectTile(c) {
    const card = c.b.card, L = Model.GRADE_LABEL[state.grade];
    return `<button class="ptile z-${c.zone}" type="button" data-open="${c.k}" title="Open ${esc(card.name)} on the chart">
      <span class="pt-top">${keyIcon(c.k)}<span class="pt-name"><b>${esc(card.name)}</b><span class="dim">${esc(card.set)} #${esc(card.number)} · ${L}</span></span></span>
      ${gaugeSvg(c.t, { size: 112 })}
      <span class="pt-row"><span>${money(c.b.close[c.s.last])}</span>${rocTxt(c.roc)}${zoneChip(c.zone)}</span>
      <span class="pt-row small"><span class="dim">value</span>${valueBar(c.v)}<span>${esc(TPI.vlabel(c.v))}</span></span>
      ${c.liq.wide ? `<span class="pt-warn">⚠ wide sales spread ${c.liq.spread.toFixed(1)}×</span>` : ''}
    </button>`;
  }
  function idxTile(o) {
    const x = o.x;
    return `<button class="gtile" type="button" data-open="${o.id}" title="Open ${esc(x.name)} on the chart"><span class="gt-name">${icon(x)}${esc(x.kind === 'all' ? 'All tracked' : x.name)}</span>${gaugeSvg(o.t, { size: 104 })}<span class="pt-row small">${rocTxt(o.roc)}<span class="dim">${esc(TPI.label(o.t))}</span></span><span class="pt-row small"><span class="dim">range</span>${valueBar(o.v)}</span></button>`;
  }
  // Market gauge and the average tradable card's gauge over time, against the All-tracked index level.
  function historySvg() {
    const G = tpiAll(), all = G.idx['idx:all']; if (!all) return '';
    const n = model.axis.length, from = Math.max(0, n - 240), W = 640, H = 170, P = 26;
    const avg = model.axis.map((_, i) => { let s = 0, k = 0; for (const c of Object.values(G.cards)) { const t = c.s.trend[i]; if (I.isN(t) && Model.tradable(model, c.b, i)) { s += t; k++; } } return k >= 5 ? s / k : null; });
    const lvl = model.idx['idx:all'].close, lv = lvl.slice(from).filter(I.isN), lo = Math.min(...lv), hi = Math.max(...lv);
    const X = (i) => P + ((i - from) / Math.max(1, n - 1 - from)) * (W - 2 * P), Y = (v) => H - P - ((v + 1) / 2) * (H - 2 * P), YL = (v) => H - P - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 2 * P);
    const path = (arr, f) => { let d = '', pen = false; for (let i = from; i < n; i++) { const v = arr[i]; if (!I.isN(v)) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${f(v).toFixed(1)}`; pen = true; } return d; };
    const ticks = [0, 0.5, 1].map((f) => Math.round(from + f * (n - 1 - from)));
    return `<svg class="hsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Trend gauge over time">
      <line class="h-grid" x1="${P}" x2="${W - P}" y1="${Y(0)}" y2="${Y(0)}"/><line class="h-grid dash" x1="${P}" x2="${W - P}" y1="${Y(0.5)}" y2="${Y(0.5)}"/><line class="h-grid dash" x1="${P}" x2="${W - P}" y1="${Y(-0.5)}" y2="${Y(-0.5)}"/>
      <text class="h-ax" x="4" y="${Y(1) + 4}">+1</text><text class="h-ax" x="4" y="${Y(0) + 4}">0</text><text class="h-ax" x="4" y="${Y(-1) + 4}">−1</text>
      <path class="h-lvl" d="${path(lvl, YL)}"/><path class="h-mkt" d="${path(all.s.trend, Y)}"/><path class="h-avg" d="${path(avg, Y)}"/>
      ${ticks.map((i) => `<text class="h-ax" x="${X(i)}" y="${H - 6}" text-anchor="middle">${model.axis[i]?.slice(5) || ''}</text>`).join('')}
    </svg><p class="hleg"><i class="k-mkt"></i>Market gauge <i class="k-avg"></i>Average tradable card <i class="k-lvl"></i>All tracked index (level)</p>`;
  }
  function renderDash() {
    const el = $('dash'); if (el.hidden) return;
    const G = tpiAll(), L = Model.GRADE_LABEL[state.grade], e = EDGE[state.grade];
    const bt = e?.ok ? ['buyZone', 'tpiUp'].map((id) => e.results.find((r) => r.id === id)).filter((r) => r && r.n) : [];
    const fw = ['buyZone', 'tpiUp'].map((id) => LEDGER?.summary?.find((s) => s.rule === id)).filter(Boolean);
    const rec = `${bt.map((r) => `Backtest · ${esc(r.label)}: ${esc(Edge.stat(r))} · ${r.status}`).join('<br>') || 'Backtest: not enough history yet.'}${fw.length ? '<br>' + fw.map((s) => `Forward record · ${esc(s.label)}: ${esc(fwdTxt(s))} · ${esc(fwdVerdict(s))}`).join('<br>') : ''}`;
    const sec = (title, sub, body) => `<section class="dsec"><h3>${title} <span class="dim">${sub}</span></h3>${body}</section>`;
    const kinds = (k) => Object.values(G.idx).filter((o) => o.x.kind === k);
    const chars = Object.values(G.idx).filter((o) => o.x.kind === 'char' && (o.x.scope === 'all' || !Object.values(G.idx).some((p) => p.x.kind === 'char' && p.x.scope === 'all' && p.x.base === o.x.base))).sort((a, b) => (b.t ?? -9) - (a.t ?? -9));
    const top = G.buy.slice(0, 8);
    el.innerHTML = `<div class="dash-head"><b>TREND &amp; VALUE GAUGES</b> <span class="dim">${L} · medium term (30–90 day inputs) · long term needs a year of history</span><button class="tbtn" type="button" data-close-dash>✕ chart</button></div>
      ${sec('★ TOP PROSPECTS', `${L} slabs in the buy zone: tradable (${model.minPrice ? money(model.minPrice) + '+, ' : ''}liquid), trend gauge ≥ +0.5, priced fair or cheap — ranked by trend, value and a rising gauge`,
        top.length ? `<div class="pgrid">${top.map(prospectTile).join('')}</div>` : `<p class="dim">No tradable ${L} slab is in the buy zone right now.</p>`)}
      <p class="drec">${rec}<br><span class="dim">A lead to research, not a buy signal, until the forward record shows the buy zone beating other cards after PSA fees.</span></p>
      ${G.watch.length ? sec('WATCH', 'cheap, trend not up yet — wait for the gauge to turn', `<div class="pgrid">${G.watch.slice(0, 6).map(prospectTile).join('')}</div>`) : ''}
      ${sec('MARKET', 'All tracked and era families', `<div class="ggrid">${[...kinds('all'), ...kinds('family')].map(idxTile).join('')}</div>`)}
      ${sec('TREND OVER TIME', L, historySvg())}
      ${sec('ERAS', '', `<div class="ggrid">${kinds('era').sort((a, b) => (b.t ?? -9) - (a.t ?? -9)).map(idxTile).join('')}</div>`)}
      ${sec('CHARACTERS', '', `<div class="ggrid">${chars.map(idxTile).join('')}</div>`)}
      ${sec('SETS', '', `<div class="ggrid">${kinds('set').sort((a, b) => (b.t ?? -9) - (a.t ?? -9)).map(idxTile).join('')}</div>`)}
      <p class="dim dnote">Trend gauge (−1…+1) = weighted average of ±1 votes: market, era family, set, character and breadth (40%); the card's Supertrend, SMA50, Hull MA, strength vs its set and the market, sales pressure (40%); grade compression or a neighbouring grade jumping first (20%, only when present). Value (−2 expensive … +2 cheap) = price vs its own trailing year, vs its set, and vs the next grade up. Index range bars show where the index sits in its own trailing year. ▲▼ = change in the gauge vs a week ago.</p>`;
  }
  // Signal panel block for one card: gauge, value, zone, and the vote-by-vote breakdown.
  function gaugeRows(cur, ratio) {
    if (ratio || model.dense) return '';
    if (cur.isIndex) { const o = idxGauge(cur.id); if (!o) return ''; return `<h3>TREND GAUGE <span class="dim">${esc(TPI.label(o.t))}</span></h3><div class="gblock">${gaugeSvg(o.t, { size: 120 })}<div class="gside">${rocTxt(o.roc)}<span class="dim">range in its year</span>${valueBar(o.v)}</div></div>`; }
    const c = tpiCard(cur.id); if (!c) return '';
    const bd = c.s.breakdown(), vote = (v) => (v == null ? '<span class="dim">·</span>' : v > 0.05 ? `<span class="pos">+${v === 1 ? 1 : v.toFixed(1)}</span>` : v < -0.05 ? `<span class="neg">${v === -1 ? -1 : v.toFixed(1)}</span>` : '<span class="dim">0</span>');
    const rows = (title, arr, w) => arr.length ? `<p class="gbh">${title}${w ? ` <span class="dim">${Math.round(w * 100)}% · ${sgn(bd.groups?.[title.toLowerCase()] ?? null)}</span>` : ''}</p>` + arr.map(([n, v, why]) => `<p class="gbr" title="${esc(why)}"><span>${esc(n)}</span>${vote(v)}</p>`).join('') : '';
    const open = state.collapsed.includes('gauge:open'); // folded by default
    return `<h3>TREND &amp; VALUE ${zoneChip(c.zone)}</h3><div class="gblock">${gaugeSvg(c.t, { size: 120 })}<div class="gside"><span>${esc(TPI.label(c.t))} ${rocTxt(c.roc)}</span><span class="dim">value · ${esc(TPI.vlabel(c.v))} ${sgn(c.v)}</span>${valueBar(c.v)}${c.s.stale() ? `<span class="warn small" title="Last sale ${c.liq.overdue?.since}d ago; usually sells every ~${c.liq.overdue?.typ}d. The provider posts sales late, so the price is frozen — no value or zone call.">⧗ newest sales missing</span>` : c.tradable ? '' : '<span class="neg small">not tradable</span>'}</div></div>
      <button class="ctx-row gbtoggle" type="button" data-gtoggle>${open ? '▾' : '▸'} why <span class="dim">vote by vote</span></button>
      ${open ? `<div class="gbd">${rows('Context', bd.context, TPI.WEIGHTS.context)}${rows('Card', bd.card, TPI.WEIGHTS.card)}${rows('Grades', bd.grades, TPI.WEIGHTS.grades)}${rows('Value', bd.value)}</div>` : ''}`;
  }
  // ---------- forward record: setups logged live when they fire, scored 30 days later (data/ledger.json) ----------
  const FWD_TONE = { 'holding up': 'pos', 'not holding': 'neg', 'beats peers, not fees': 'warn', mixed: '', collecting: 'dim' };
  const fwdOf = (id) => LEDGER?.summary?.find((s) => s.rule === id) || null;
  const fwdOne = (s, h) => (s?.n ? `${h}D: ${Edge.pct(s.vsPeers, 1)} vs peers, ${Math.round(s.beat * 100)}% beat · after fees ${Edge.pct(s.net, 1)} (${Math.round((s.pays ?? 0) * 100)}% paid) · ${s.n} scored` : `${h}D: none scored yet`);
  const fwdTxt = (s) => `${fwdOne(s, LEDGER?.horizon || 30)}${s.h90 ? ` | ${fwdOne(s.h90, 90)}` : ''}${s.pending ? ` · ${s.pending} pending` : ''}`;
  const fwdVerdict = (s) => (s.h90?.n >= 10 ? s.h90.verdict + ' (90D)' : s.verdict); // 90D decides once it has enough
  function fwdIntro() {
    const c = LEDGER?.counts || {};
    return `Logged the day a setup fires (since ${LEDGER.since}) on a slab that was ${LEDGER.minPrice ? `${money(LEDGER.minPrice)}+ and ` : ''}liquid that day (6+ sale days in 90, a sale within 30), then scored ${LEDGER.horizon} and 90 days later against every other such slab in that grade — results the backtest never saw. "After fees" = the slab's own return after the PSA Vault consignment fee for its sale price (13% + $3 under $100 · 13% to $499 · 12% to $999 · 10% to $2,499 · 9% to $4,999 · 7% from $5,000). ${c.scored || 0} scored at ${LEDGER.horizon}D · ${c.scored90 || 0} at 90D · ${c.pending || 0} waiting · ${c.void || 0} void (no buyable sales after the fire). A verdict needs 10+ scored; "holding up" = beat its peers more often than a coin flip (sign test p < 0.05) AND made money after fees; "beats peers, not fees" = a real signal that doesn't pay for a trade. Once 90D has 10+, it decides.`;
  }
  function fwdSection() {
    if (!LEDGER?.summary?.length) return `<tr class="sec"><td colspan="5">FORWARD RECORD <span class="dim">starts after the next daily run</span></td></tr>`;
    const open = !state.collapsed.includes('sec:fwd');
    const rows = LEDGER.summary.filter((s) => s.n || s.pending || s.h90?.n).sort((a, b) => (b.h90?.n || 0) - (a.h90?.n || 0) || b.n - a.n || b.pending - a.pending);
    return `<tr class="sec" data-toggle="sec:fwd"><td colspan="5">${open ? '▾' : '▸'} FORWARD RECORD <span class="dim">${LEDGER.counts?.scored || 0} scored</span></td></tr>` + (open ? `<tr class="sec"><td colspan="5"><p class="setupnote">${esc(fwdIntro())}</p><div class="fwd">${rows.map((s) => `<p class="fwdrow"><span class="fl">${esc(s.label)}</span><span class="fv ${FWD_TONE[fwdVerdict(s).replace(/ \(90D\)$/, '')] || ''}">${esc(fwdVerdict(s))}</span><span class="fs dim">${esc(fwdTxt(s))}</span></p>`).join('')}</div></td></tr>` : '');
  }
  function edgeGroup() {
    const e = edge();
    if (!e) return '<div class="bgroup"><h3>Setups · backtest</h3><p>Testing setups against history…</p></div>';
    const conf = e.ok ? e.picks.filter((p) => p.status === 'confirmed') : [], prom = e.ok ? e.picks.filter((p) => p.status === 'promising') : [];
    const row = (p, mark, tone) => briefRow({ k: p.key, tone, text: `${mark} ${p.card.name}${lineTag(p.card)}: ${p.best.label}, ${p.best.ago === 0 ? 'today' : p.best.ago + 'd ago'} · ${Edge.stat(p.best)}` });
    let h = `<div class="bgroup edge${conf.length ? ' hot' : ''}"><h3>Setups · backtest · ${esc(Model.GRADE_LABEL[e.grade] || '')}</h3><p>${esc(Edge.verdict(e))}</p>`;
    if (conf.length) h += '<h4>Firing now · confirmed</h4>' + conf.map((p) => row(p, '◆', 'good')).join('');
    if (prom.length) h += '<h4>Firing now · promising, could be luck</h4>' + prom.slice(0, 8).map((p) => row(p, '◇', '')).join('');
    if (e.ok) {
      const top = e.results.filter((r) => r.p != null).slice(0, 6);
      if (top.length) h += '<h4>Best tested setups</h4>' + top.map((r) => `<p class="erow"><b>${esc(r.label)}</b> · ${r.status}<br>${esc(Edge.stat(r))} · halves ${r.halves.map((v) => Edge.pct(v, 0)).join(' / ')}</p>`).join('');
      const fw = (LEDGER?.summary || []).filter((s) => s.n >= 10).sort((a, b) => (a.p ?? 1) - (b.p ?? 1)).slice(0, 4);
      h += `<h4>Forward record · live since ${esc(LEDGER?.since || '—')}</h4>` + (fw.length ? fw.map((s) => `<p class="erow"><b>${esc(s.label)}</b> · ${esc(s.verdict)}<br>${esc(fwdTxt(s))}${s.p != null ? ` · p ${s.p}` : ''}</p>`).join('') : `<p class="dim">${LEDGER?.counts ? `${LEDGER.counts.scored} scored, ${LEDGER.counts.pending} waiting for their ${LEDGER.horizon} days.` : 'Starts after the next daily run.'} Setups get a live verdict once 10+ are scored.</p>`);
      h += `<p class="dim">Entry = median of the next real sales after a setup fires; outcome = ${e.horizon}D later, versus other tracked cards on the same dates. ${e.tested} setups tested, so single wins are corrected for luck (q ≤ 0.10) and must hold in both halves of the history.</p>`;
    }
    return h + '</div>';
  }

  // ---------- brief: tiles up top, full list in the watchlist column ----------
  const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const splitItem = (t) => {
    const cut = (i, skip) => ({ n: t.slice(0, i).trim(), d: t.slice(i + skip).replace(/^[\s:,]+/, '').replace(/[\])]$/, '') });
    let i = t.lastIndexOf(' ['); if (i > 0) return cut(i, 2);
    i = t.indexOf(': '); if (i > 0) return cut(i, 2);
    const pm = t.match(/\s\((?=[+\-−]?\d)/); if (pm) return cut(pm.index, 2);
    const m = t.match(/\s(?=[+\-−]?\d)/); if (m) return cut(m.index, 1);
    return { n: t, d: '' };
  };
  const itemAttrs = (i) => `data-k="${esc(i.k)}"${i.keys ? ` data-keys="${esc(JSON.stringify(i.keys))}"` : ''}`;
  function renderTiles() {
    const b = Model.brief(model), c = consensusOnce();
    const find = (src, label) => src.lines.find((l) => l.label === label);
    const gs = Object.fromEntries(gauges().map((g) => [g.id, g]));
    const tiles = [];
    const add = (label, line, meta) => { if (!line || !line.items.length) return; const it = line.items[0], sp = splitItem(it.text); tiles.push({ label, it, n: sp.n, d: sp.d, meta: meta ?? (line.items.length > 1 ? `+${line.items.length - 1} more` : ''), all: line.items.map((x) => x.text).join('\n') }); };
    if (b.thin) add(`${b.gradeLabel} data`, b.lines[0]);
    else add(`Market · ${b.gradeLabel}`, find(b, 'Market'), `breadth ${gs.br.txt} · up ${gs.adv.txt} · ramping ${gs.rmp.txt}`);
    add('All grades agree ▲', find(c, 'Grades agree ▲'));
    add('Leading set', find(b, 'Leading set'));
    add('Ramping up', find(b, 'Ramping up'));
    add('Card to watch', find(c, 'Cards agree ▲') || find(b, 'Cards to note'));
    add('RAW vs graded', find(c, 'RAW vs graded'));
    add('Weakest', find(c, 'Grades agree ▼') || find(b, 'Lagging'));
    add('Leading character', find(b, 'Leading characters'));
    add('Themes', find(b, 'Themes'));
    add('Swings widening', find(b, 'Swings widening'));
    { // what changed this week across sets and cards
      const st = stats(), rows = [];
      for (const [k, c] of Object.entries(st.ch)) if (c && !k.endsWith('~alt') && !(model.by[k]?.card.custom)) rows.push({ k, c, name: model.idx[k] ? model.idx[k].name + ' index' : model.by[k]?.card.name + (model.by[k]?.card.line ? ' ' + model.by[k].card.line : '') });
      const up = rows.filter((r) => r.c.dir > 0), dn = rows.filter((r) => r.c.dir < 0);
      const lead = up.find((r) => r.k.startsWith('idx:')) || up[0] || dn[0];
      if (lead) tiles.splice(1, 0, { label: 'New this week', it: { k: lead.k, tone: lead.c.dir > 0 ? 'good' : 'bad' }, n: lead.name, d: lead.c.items.map((i) => i.text).join(' · '), meta: `▲ ${up.length} turned up · ▼ ${dn.length} turned down`, all: rows.map((r) => `${r.c.dir > 0 ? '▲' : '▼'} ${r.name}: ${r.c.items.map((i) => i.text).join('; ')}`).join('\n') });
    }
    { // backtested setups take the first slot, but only once the evidence is confirmed
      const e = edge(), top = e?.ok ? e.picks.filter((p) => p.status === 'confirmed') : [];
      if (top.length) { const p = top[0]; tiles.unshift({ label: '◆ Buy setup · tested', it: { k: p.key, tone: 'good' }, n: p.card.name + lineTag(p.card), d: `${p.best.label} · ${Edge.pct(p.best.vsPeers, 1)} vs peers`, meta: `${p.best.ago === 0 ? 'today' : p.best.ago + 'd ago'}${top.length > 1 ? ` · +${top.length - 1} more` : ''}`, all: top.map((x) => `${x.card.name} (${x.card.set}): ${x.best.label} — ${Edge.stat(x.best)}`).join('\n') }); }
    }
    $('tiles').innerHTML = tiles.map((t) => `<button class="tile ${t.it.tone || 'mid'}" ${itemAttrs(t.it)} title="${esc(t.all)}" type="button"><span class="tl">${esc(t.label)}</span><span class="tn">${keyIcon(t.it.k, { thumb: false })}${esc(t.n)}</span><span class="td">${esc(t.d)}</span>${t.meta ? `<span class="tm">${esc(t.meta)}</span>` : ''}</button>`).join('');
  }
  // BRIEF tab: one row per item — icon, name, the reason in small type, then 30D % and signal score to scan down.
  function briefRow(i) {
    const st = stats(), x = model.idx[i.k], b = model.by[i.k], s = x ? st.idx[i.k] : b ? st.cards[i.k] : null;
    const sp = splitItem(i.text);
    const chip = s?.c30 != null ? `<span class="bchip ${s.c30 >= 0 ? 'pos' : 'neg'}">${s.c30 >= 0 ? '+' : ''}${s.c30.toFixed(0)}%</span>` : '<span class="bchip"></span>';
    const pill = s?.score != null ? `<span class="pill ${s.tag[1]}" title="${esc(s.tag[0])}">${s.score}</span>` : '<span class="pill na">··</span>';
    return `<button class="brow ${i.tone || ''}" ${itemAttrs(i)} type="button" title="${esc(i.text)}"><span class="bic">${keyIcon(i.k)}</span><span class="bt"><b>${esc(sp.n.replace(/^[▲▼]\s*/, ''))}</b><small>${esc(sp.d)}</small></span>${chip}${pill}</button>`;
  }
  function renderBriefList() {
    const b = Model.brief(model), c = consensusOnce();
    const grp = (title, lines, note) => `<div class="bgroup"><h3>${esc(title)}</h3>${lines.map((l) => `<h4>${esc(l.label)}</h4>${l.items.map(briefRow).join('')}`).join('')}${note ? `<p>${esc(note)}</p>` : ''}</div>`;
    const st = stats(), chg = Object.entries(st.ch).filter(([k, c]) => c && !model.by[k]?.card.custom).map(([k, c]) => ({ k, tone: c.dir > 0 ? 'good' : 'bad', text: `${model.idx[k] ? model.idx[k].name : model.by[k].card.name + (model.by[k].card.line ? ' ' + model.by[k].card.line : '')}: ${c.dir > 0 ? '▲' : '▼'} ${c.items.map((i) => i.text).join('; ')}` })).sort((a, b) => (a.k.startsWith('idx:') ? 0 : 1) - (b.k.startsWith('idx:') ? 0 : 1));
    const eg = edgeGroup(), hot = /bgroup edge hot/.test(eg);
    const L = Model.GRADE_LABEL, cheap = Object.entries(st.cards).filter(([k, v]) => v.gap && v.gap.gap != null && v.gap.gap < 0.8 && !k.endsWith('~alt')).sort((a, b) => a[1].gap.gap - b[1].gap.gap).slice(0, 8)
      .map(([k, v]) => ({ k, tone: 'warn', text: `${model.by[k].card.name}${lineTag(model.by[k].card)}: ${(v.gap.ratio * 100).toFixed(0)}% of ${L[v.gap.up]}${(() => { const im = implied(k, model.by[k].card, model.grade, v.gap.up); return im ? ' ' + impliedTxt(im, { short: true }) : ''; })()} · ${normWord(v.gap.normSrc)} ${(v.gap.norm * 100).toFixed(0)}%${v.gap.peer && v.gap.normSrc === 'own' ? ` · ${v.gap.peerSrc === 'set' ? 'set' : 'peers'} ${(v.gap.peer * 100).toFixed(0)}%` : ''}` }));
    const gr = EDGE[state.grade]?.results?.find((r) => r.id === 'gapLow');
    const gapNote = gr && gr.n ? `Backtest so far (${L[state.grade]}): after a card got this cheap vs its next grade, it did ${Edge.pct(gr.vsPeers, 1)} vs other cards over 30 days (${gr.n} times, ${gr.status === 'few' ? 'too few to judge' : gr.status}). A price check, not a buy signal yet.` : 'Not yet backtested for this grade. A price check, not a buy signal.';
    const gapGrp = cheap.length ? grp(`Grade gaps · ${L[state.grade]} vs ${L[Model.NEXT[state.grade]]}`, [{ label: 'Cheap vs next grade up, compared with the card’s own usual ratio', items: cheap }], gapNote) : '';
    const head = `<div class="bhead"><span></span><span>30D</span><span>Sig</span></div>`;
    $('briefList').innerHTML = rawNote() + head + (hot ? eg : '') + (chg.length ? grp(`New this week · ${Model.GRADE_LABEL[state.grade]}`, [{ label: 'Changed status', items: chg }]) : '') + grp(`Consensus · ${c.gradeLabels.map((x) => x.replace('RAW NM', 'RAW')).join(' / ')}`, c.lines, c.leadNote ? 'Lead-lag: ' + c.leadNote : '') + grp(`${b.gradeLabel} · ${b.asOf || '—'} · ${b.scoredCards}/${b.cards} scoreable`, b.lines) + gapGrp + (hot ? '' : eg);
  }
  // RAW only covers WOTC set baskets (EX, DP and index-only cards are fetched without RAW to fit the free tier).
  function rawNote() {
    return ''; // RAW (ungraded) is no longer collected: the site is graded-only
    if (!model.dense) return '';
    const n = [...WL.cards, ...(WL.extra || [])].filter((c) => c.raw === false).length;
    return n ? `<p class="rawnote">RAW tracks WOTC set cards only — ${n} EX, DP & index-only cards are graded-only. <button type="button" data-grade="${WL.primaryGrade || 'psa8'}">Switch to ${Model.GRADE_LABEL[WL.primaryGrade || 'psa8']}</button></p>` : '';
  }
  const renderBrief = () => { renderTiles(); if (state.wlView === 'brief') renderBriefList(); };

  function refresh(opts) { save(); syncButtons(); renderWatchlist(); draw(opts); showDash(); }
  function showDash() {
    const on = !!state.dash; $('dash').hidden = !on; $('gaugesBtn').setAttribute('aria-pressed', String(on)); $('gaugesBtn').classList.toggle('on', on);
    document.querySelector('.screen').classList.toggle('dash-on', on);
    if (on) renderDash();
  }

  // Keep the same printing when switching grades (the '~alt' line is 1st Ed in one grade, Unl in another).
  const ptag = (line) => (!line ? '' : /1st/i.test(line) ? '1st' : /unl/i.test(line) ? 'unl' : /reverse|upper/i.test(line) ? 'hi' : /holo|lower/i.test(line) ? 'lo' : '');
  function rebuild() {
    const shown = model?.by[curKey()]?.card;
    model = buildModel(state.grade);
    state.key = (state.key || '').replace(/~alt$/, '');
    if (shown && ptag(shown.line) && state.print !== 'both') {
      const want = ptag(shown.line), a = model.by[state.key + '~alt'];
      state.print = a && ptag(a.card.line) === want ? 'alt' : 'main';
    }
    if (!model.by[state.key] && !model.idx[state.key]) state.key = Object.keys(model.by).find((k) => !k.endsWith('~alt')) || 'idx:all';
    renderSelects(); renderStatus(); renderBrief(); refresh();
  }

  function select(key, { keepPrint = false } = {}) {
    if (key.endsWith('~alt')) { state.key = key.replace(/~alt$/, ''); state.print = 'alt'; }
    else { state.key = key; if (!keepPrint) state.print = 'main'; }
    if (state.vs === key) state.vs = 'idx:all';
    renderSelects(); refresh();
  }

  // ---------- events ----------
  function bind() {
    const seg = (id, fn) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) fn(b.dataset.v); });
    seg('grade', (v) => { state.grade = v; rebuild(); });
    seg('range', (v) => { state.range = +v; refresh(); });
    seg('res', (v) => { state.res = v; refresh(); });
    seg('ind', (v) => { if (v === 'guide') state.guide = state.guide ? 0 : 1; else state.ind[v] = state.ind[v] ? 0 : 1; refresh({ keepView: true }); });
    seg('wlTabs', (v) => { state.wlView = v; renderWatchlist(); save(); $('wlScroll').scrollTop = 0; });
    bindPicker('A'); bindPicker('B');
    document.addEventListener('pointerdown', (e) => { for (const id of ['pickA', 'pickB']) if (!$(id).contains(e.target)) { $(id).querySelector('.pk-pop').hidden = true; $(id).classList.remove('open'); } });
    document.addEventListener('click', (e) => { const g = e.target.closest('[data-grade]'); if (!g) return; e.stopPropagation(); e.preventDefault(); state.grade = g.dataset.grade; rebuild(); }, true); // 'Switch to PSA 8' links
    $('groupBtn').addEventListener('click', () => { state.group = !state.group; renderWatchlist(); save(); });
    $('sigStar').addEventListener('click', () => toggleStar($('sigStar').dataset.k));
    $('sigCtx').addEventListener('change', (e) => { const inp = e.target.closest('input[data-wi]'); if (!inp) return; const k = inp.dataset.wi; state.wi = { ...(state.wi || {}) }; if (inp.value.trim()) state.wi[k] = inp.value.trim(); else delete state.wi[k]; save(); draw({ keepView: true }); });
    $('sigCtx').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[data-wi]')) e.target.blur(); e.stopPropagation(); });
    $('sigCtx').addEventListener('click', (e) => { if (e.target.closest('input[data-wi]')) { e.stopPropagation(); return; } if (e.target.closest('[data-witog]')) { e.stopPropagation(); state.whatIf = state.whatIf ? 0 : 1; save(); draw({ keepView: true }); return; } if (e.target.closest('[data-gtoggle]')) { state.collapsed = state.collapsed.includes('gauge:open') ? state.collapsed.filter((x) => x !== 'gauge:open') : [...state.collapsed, 'gauge:open']; save(); draw({ keepView: true }); return; } const b = e.target.closest('.ctx-row[data-k]'); if (b) select(b.dataset.k); });
    $('helpBtn').addEventListener('click', () => { $('help').hidden = !$('help').hidden; });
    $('gaugesBtn').addEventListener('click', () => { state.dash = state.dash ? 0 : 1; save(); showDash(); });
    $('dash').addEventListener('click', (e) => {
      if (e.target.closest('[data-close-dash]')) { state.dash = 0; save(); showDash(); return; }
      const o = e.target.closest('[data-open]'); if (!o) return;
      state.dash = 0; select(o.dataset.open);
    });
    $('help').addEventListener('click', (e) => { if (e.target === $('help') || e.target.closest('[data-close]')) $('help').hidden = true; });
    $('mergeBtn').addEventListener('click', () => { state.merge = !state.merge; refresh({ keepView: true }); });
    $('cmpX').addEventListener('click', () => { state.vs = 'none'; state.merge = false; renderSelects(); refresh({ keepView: true }); });
    $('resetView').addEventListener('click', () => { chart.resetLayout(); chart.resetView(); chart.render(); state.paneRatios = {}; save(); });
    seg('print', (v) => { state.print = v; refresh({ keepView: true }); });
    $('wlMetric').addEventListener('click', (e) => e.stopPropagation());
    $('wlMetric').addEventListener('change', (e) => { state.wlMetric = e.target.value; state.sort = 'metric'; state.dir = -1; renderWatchlist(); save(); });
    $('wlBody').addEventListener('click', (e) => {
      const sw = e.target.closest('[data-vs]');
      const stb = e.target.closest('[data-star]'); if (stb) { e.stopPropagation(); toggleStar(stb.dataset.star); return; }
      const tg = e.target.closest('tr[data-toggle]');
      if (tg && (tg.classList.contains('sec') || (e.target.closest('td:first-child') && e.offsetX < 22))) { const k = tg.dataset.toggle; state.collapsed = state.collapsed.includes(k) ? state.collapsed.filter((x) => x !== k) : [...state.collapsed, k]; renderWatchlist(); save(); return; }
      if (sw) { e.stopPropagation(); state.vs = state.vs === sw.dataset.vs ? 'idx:all' : sw.dataset.vs; if (state.vs === state.key) state.vs = 'idx:all'; renderSelects(); refresh({ keepView: true }); return; }
      const tr = e.target.closest('tr[data-k]');
      if (tr?.dataset.lgrade && tr.dataset.lgrade !== state.grade) { state.key = tr.dataset.k; state.grade = tr.dataset.lgrade; rebuild(); return; }
      if (tr) select(tr.dataset.k, { keepPrint: tr.dataset.k === state.key });
    });
    const briefClick = (e) => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      let k = b.dataset.k;
      if (b.dataset.keys) { const ks = JSON.parse(b.dataset.keys); k = ks[state.grade] || k; if (!model.by[k] && !model.idx[k]) { const g = Object.keys(ks)[0]; state.grade = g; model = buildModel(g); renderSelects(); renderStatus(); renderBrief(); k = ks[g]; } }
      select(k);
    };
    $('tiles').addEventListener('click', briefClick);
    $('briefList').addEventListener('click', briefClick);
    $('wlBody').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr[data-k]')) e.target.click(); });
    document.querySelector('.wl thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]'); if (!th) return;
      const k = th.dataset.sort; state.dir = state.sort === k ? -state.dir : k === 'name' ? 1 : -1; state.sort = k; refresh({ keepView: true });
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => draw({ keepView: true }));
    new MutationObserver(() => draw({ keepView: true })).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('keydown', (e) => { // shortcuts (see the ? panel)
      if (e.target.matches('select, input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      const G = { 1: 'psa7', 2: 'psa8', 3: 'psa9', 4: 'psa10' };
      if (k === '/' ) { e.preventDefault(); openPicker('A'); return; }
      if (k === '\\') { e.preventDefault(); openPicker('B'); return; }
      if (G[k]) { state.grade = G[k]; rebuild(); return; }
      if (k === 'p' || k === 'P') { if (hasAlt(state.key)) { state.print = { main: 'alt', alt: 'both', both: 'main' }[state.print] || 'main'; refresh({ keepView: true }); } return; }
      if (k === 'd' || k === 'D') { state.dash = state.dash ? 0 : 1; save(); showDash(); return; }
      if (k === 'm' || k === 'M') { if (state.vs !== 'none') { state.merge = !state.merge; refresh({ keepView: true }); } return; }
      if (k === 'x' || k === 'X') { state.vs = 'none'; state.merge = false; renderSelects(); refresh({ keepView: true }); return; }
      if (k === 'w' || k === 'W') { state.res = state.res === 'W' ? 'D' : 'W'; refresh(); return; }
      if (k === 'r' || k === 'R') { chart.resetLayout(); chart.resetView(); chart.render(); return; }
      if (k === 's' || k === 'S') { const b = model.by[state.key]; if (b && !b.card.virtual) toggleStar(state.key); return; }
      if (k === 'g' || k === 'G') { state.group = !state.group; state.wlView = 'cards'; renderWatchlist(); save(); return; }
      if (k === '?') { $('help').hidden = !$('help').hidden; return; }
      if (k === 'Escape') { $('help').hidden = true; return; }
      if (k !== 'ArrowDown' && k !== 'ArrowUp') return;
      const rows = [...document.querySelectorAll('#wlBody tr[data-k]:not(.grp)')]; const i = rows.findIndex((r) => r.dataset.k === state.key);
      const nx = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (nx) { e.preventDefault(); nx.click(); nx.scrollIntoView({ block: 'nearest' }); }
    });
  }

  function toggleStar(k) {
    if (!k) return;
    state.stars = isStar(k) ? state.stars.filter((x) => x !== k) : [...state.stars, k];
    save(); renderWatchlist(); draw({ keepView: true });
  }

  async function start() {
    chart = new TerminalChart($('chart'), theme());
    chart.ratios = { ...(state.paneRatios || {}) };
    chart.onLayout = (r) => { state.paneRatios = { ...r }; save(); };
    try { await load(); } catch (e) { $('status').textContent = 'Could not load data/ — ' + e.message; return; }
    if (!WL || !Object.keys(SERIES).length) { $('status').textContent = 'NO DATA · run the discovery or fetch workflow'; return; }
    if (state.grade === 'raw') state.grade = WL.primaryGrade || 'psa8'; // RAW view retired
    if (!hadSaved && WL.primaryGrade) state.grade = WL.primaryGrade; // deepest clean grade, chosen by discover
    bind(); rebuild();
  }
  start();
})();
