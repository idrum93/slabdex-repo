// Trend & value gauges (medium term), in the spirit of a TPI: every input scores -1 / 0 / +1 and the gauge is a
// weighted average.
//
//  TREND  (-1 … +1)  is the card / index moving up?
//    context (40%) — market, era family, set, character: each index's own trend (Supertrend, price vs SMA50, Hull
//                    slope), plus breadth = share of the set's cards above their SMA50
//    card    (40%) — Supertrend, price vs SMA50, Hull slope, strength vs its set, strength vs the market, sales pressure (VZO)
//    grades  (20%) — compressed vs the grade below, or a neighbouring grade jumped first (only counts when present)
//  VALUE  (-2 … +2)  is it cheap? (+ = cheap, - = expensive; roughly z-scores)
//    own range — price vs its own trailing year (log z), set — strength vs its set vs its own 90D norm,
//    grade gap — share of the next grade up vs its usual share
//
//  Zones: BUY (trend ≥ +0.5, value ≥ -0.25) · LATE (trend up but pricey) · WATCH (cheap, trend not up yet) ·
//         AVOID (trend down and pricey) · NEUTRAL.
// Weights are equal within each group and fixed for now; the gauge's own readings are logged in the forward record
// (setups "Trend gauge up through +0.5", "Enters buy zone", "Undervalued, trend not up yet") so its accuracy is
// measured before any weight is tuned. All values on day i use data up to day i only.
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const I = isNode ? require('./indicators.js') : root.Ind;
  const Model = isNode ? require('./model.js') : root.Model;
  const isN = I.isN;
  const WEIGHTS = { context: 0.4, card: 0.4, grades: 0.2 };
  const TH = { up: 0.25, strong: 0.5, buy: 0.5, cheap: -0.25, late: -0.25, watch: 0.75, avoid: -0.25 };
  const clip = (v, a, b) => Math.max(a, Math.min(b, v));
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

  // Cached indicator parts per price array.
  const cache = new WeakMap();
  function parts(close) {
    let p = cache.get(close);
    if (!p) { p = { st: I.supertrend(close, 10, 3).dir, s50: I.sma(close, 50), hm: I.hma(close, 20) }; cache.set(close, p); }
    return p;
  }
  // Own trend of a price line on day i: Supertrend direction, price vs SMA50, Hull MA slope → mean of ±1 votes.
  function trendAt(close, i) {
    if (!close || i < 1 || !isN(close[i])) return null;
    const p = parts(close), v = [];
    if (p.st[i] === 1 || p.st[i] === -1) v.push(p.st[i]);
    if (isN(p.s50[i])) v.push(close[i] >= p.s50[i] ? 1 : -1);
    if (isN(p.hm[i]) && isN(p.hm[i - 1])) v.push(p.hm[i] > p.hm[i - 1] ? 1 : p.hm[i] < p.hm[i - 1] ? -1 : 0);
    return v.length >= 2 ? mean(v) : null;
  }
  // Breadth: share of members above their own SMA50, mapped to -1 … +1 (needs 3+ members with an SMA50).
  function breadthAt(model, members, i) {
    let up = 0, k = 0;
    for (const key of members || []) { const b = model.by[key]; if (!b) continue; const s = parts(b.close).s50[i]; if (isN(s) && isN(b.close[i])) { k++; if (b.close[i] >= s) up++; } }
    return k >= 3 ? (2 * up) / k - 1 : null;
  }
  // Rolling z of log values over the trailing window (prefix sums; needs minN points).
  function rollingZ(arr, win, minN) {
    const n = arr.length, S = new Float64Array(n + 1), Q = new Float64Array(n + 1), K = new Float64Array(n + 1), out = new Array(n).fill(null);
    for (let i = 0; i < n; i++) { const v = isN(arr[i]) && arr[i] > 0 ? Math.log(arr[i]) : null; S[i + 1] = S[i] + (v ?? 0); Q[i + 1] = Q[i] + (v == null ? 0 : v * v); K[i + 1] = K[i] + (v == null ? 0 : 1); }
    for (let i = 0; i < n; i++) {
      if (!isN(arr[i]) || arr[i] <= 0) continue;
      const a = Math.max(0, i - win + 1), k = K[i + 1] - K[a]; if (k < minN) continue;
      const m = (S[i + 1] - S[a]) / k, sd = Math.sqrt(Math.max(0, (Q[i + 1] - Q[a]) / k - m * m));
      if (sd > 1e-6) out[i] = (Math.log(arr[i]) - m) / sd;
    }
    return out;
  }
  const famOf = (c) => c.family || String(c.era || '').split(' ')[0];
  function contextOf(model, key) {
    const b = model.by[key], c = b.card, base = key.replace(/~alt$/, '');
    const set = model.idx['idx:set:' + (c.basket || Model.slug(c.set))] || null, era = model.idx['idx:era:' + Model.slug(c.era || '')] || null;
    const chars = (model.memberOf[base] || []).filter((id) => id.startsWith('idx:char:')).map((id) => model.idx[id]).filter(Boolean);
    return { all: model.idx['idx:all'] || null, fam: model.idx['idx:fam:' + Model.slug(famOf(c))] || null, set, era, local: set || era, char: chars.find((x) => x.scope === 'all') || chars[0] || null };
  }
  function zoneOf(t, v) {
    if (t == null) return 'neutral';
    if (t >= TH.buy && v != null && v >= TH.cheap) return 'buy';
    if (t >= TH.up) return 'late';
    if (t <= 0 && v != null && v >= TH.watch) return 'watch';
    if (t <= TH.avoid && v != null && v < TH.late) return 'avoid';
    return 'neutral';
  }
  const ZONES = {
    buy: { label: 'BUY ZONE', tone: 'good', note: 'trend up, priced fair or cheap' },
    late: { label: 'LATE', tone: 'warn', note: 'trend up but already pricey' },
    watch: { label: 'WATCH', tone: 'cyan', note: 'cheap, trend not up yet — wait for the turn' },
    avoid: { label: 'AVOID', tone: 'bad', note: 'trend down and pricey' },
    neutral: { label: 'NEUTRAL', tone: 'mid', note: 'no clear read' },
  };

  // Full daily series for one card line. o: { up, down } neighbouring grade models (or precomputed gap / sq / lagUp / lagDn arrays).
  function series(model, key, o = {}) {
    const b = model.by[key]; if (!b) return null;
    const n = model.axis.length, c = b.close, ctx = contextOf(model, key), p = parts(c);
    const ratio = (x, y) => x.map((v, i) => (isN(v) && isN(y?.[i]) && y[i] > 0 ? v / y[i] : null));
    const rs = ratio(c, model.index), rsm = I.sma(rs, 20);
    const rsS = ctx.local ? ratio(c, ctx.local.close) : null, rsSm = rsS ? I.sma(rsS, 20) : null;
    const vz = b.vol ? I.vzo(c, b.vol, 14).vzo : null;
    const gap = o.gap !== undefined ? o.gap : o.up ? Model.gapSeries(model, o.up, key)?.gap || null : null;
    const sq = o.sq !== undefined ? o.sq : o.down ? Model.squeezeSeries(model, o.down, key)?.flag || null : null;
    const lagUp = o.lagUp !== undefined ? o.lagUp : o.up ? Model.lagSeries(model, o.up, key)?.flag || null : null;
    const lagDn = o.lagDn !== undefined ? o.lagDn : o.down ? Model.lagSeries(model, o.down, key)?.flag || null : null;
    const zOwn = rollingZ(c, 365, 60), zSet = rsS ? rollingZ(rsS, 90, 30) : null;
    const trend = new Array(n).fill(null), value = new Array(n).fill(null), zone = new Array(n).fill('neutral');
    function compsAt(i) {
      const ctxC = [
        ['Market', ctx.all ? trendAt(ctx.all.close, i) : null, 'All tracked index trend'],
        ['Era family', ctx.fam ? trendAt(ctx.fam.close, i) : null, ctx.fam ? ctx.fam.name + ' index trend' : ''],
        [ctx.set ? 'Set' : 'Era', ctx.local ? trendAt(ctx.local.close, i) : null, ctx.local ? ctx.local.name + ' index trend' : ''],
        ['Character', ctx.char ? trendAt(ctx.char.close, i) : null, ctx.char ? ctx.char.name + ' index trend' : ''],
        ['Breadth', ctx.local ? breadthAt(model, ctx.local.members, i) : null, ctx.local ? `share of ${ctx.local.name} cards above their SMA50` : ''],
      ];
      const card = [
        ['Supertrend', p.st[i] === 1 ? 1 : p.st[i] === -1 ? -1 : null, 'Supertrend (10, 3) direction'],
        ['vs SMA50', isN(p.s50[i]) && isN(c[i]) ? (c[i] >= p.s50[i] ? 1 : -1) : null, 'market line above / below its 50-day average'],
        ['Hull MA', isN(p.hm[i]) && isN(p.hm[i - 1]) ? Math.sign(p.hm[i] - p.hm[i - 1]) : null, 'Hull MA (20) rising / falling'],
        ['RS vs set', rsS && isN(rsS[i]) && isN(rsSm[i]) ? (rsS[i] >= rsSm[i] ? 1 : -1) : null, 'beating its own set (RS above its 20-day MA)'],
        ['RS vs market', isN(rs[i]) && isN(rsm[i]) ? (rs[i] >= rsm[i] ? 1 : -1) : null, 'beating the market (RS above its 20-day MA)'],
        ['Sales pressure', vz && isN(vz[i]) ? (vz[i] > 5 ? 1 : vz[i] < -5 ? -1 : 0) : null, 'VZO above +5 / below -5'],
      ];
      const grades = [];
      if (sq?.[i] === true) grades.push(['Compressed', 1, 'priced almost like the grade below — may not have repriced yet']);
      if (lagUp?.[i] === true) grades.push(['Grade above jumped', 1, 'the next grade up rose ≥20%, this one hasn\'t yet']);
      if (lagDn?.[i] === true) grades.push(['Grade below jumped', 1, 'the next grade down rose ≥20%, this one hasn\'t yet']);
      const vals = [
        ['Own range', isN(zOwn[i]) ? clip(-zOwn[i], -2, 2) : null, 'price vs its own trailing year (z, + = low in its range)'],
        ['vs set', zSet && isN(zSet[i]) ? clip(-zSet[i], -2, 2) : null, 'strength vs its set compared with its own 90-day norm'],
        ['Grade gap', gap && isN(gap[i]) && gap[i] > 0 ? clip(-Math.log(gap[i]) / 0.15, -2, 2) : null, 'share of the next grade up vs its usual share (+ = cheap)'],
      ];
      return { context: ctxC, card, grades, value: vals };
    }
    function combine(cm) {
      const g = {}; let ws = 0, s = 0;
      for (const k of ['context', 'card', 'grades']) { const v = cm[k].map((x) => x[1]).filter(isN); g[k] = v.length ? mean(v) : null; if (g[k] != null && (k !== 'context' || v.length >= 2) && (k !== 'card' || v.length >= 3)) { s += WEIGHTS[k] * g[k]; ws += WEIGHTS[k]; } }
      const vv = cm.value.map((x) => x[1]).filter(isN);
      return { trend: ws >= 0.6 ? s / ws : null, value: vv.length ? clip(mean(vv), -2, 2) : null, groups: g };
    }
    const first = I.firstIdx(c), st0 = Model.staleSeries ? Model.staleSeries(b) : null;
    // Sibling grades' "days since last sale", mapped onto this grade's dates (for the behind-its-siblings check).
    const sib = new Array(n).fill(null);
    for (const om of [o.up, o.down]) {
      const ol = om && Model.lineIn(om, key, b.card), os = ol && Model.staleSeries(ol); if (!os) continue;
      const pos = new Map(om.axis.map((d, j) => [d, j]));
      for (let i = 0; i < n; i++) { const j = pos.get(model.axis[i]); const v = j != null ? os.since[j] : null; if (v != null && (sib[i] == null || v < sib[i])) sib[i] = v; }
    }
    const st = st0 ? model.axis.map((_, i) => Model.behindAt(st0, i, sib[i])) : null;
    for (let i = Math.max(1, first); i < n && first >= 0; i++) {
      const r = combine(compsAt(i)); trend[i] = r.trend;
      if (st && st[i]) { value[i] = null; zone[i] = 'neutral'; continue; } // overdue: price frozen while the newest sales are missing — no value or zone call
      value[i] = r.value; zone[i] = zoneOf(r.trend, r.value);
    }
    const last = I.lastIdx(c);
    return {
      trend, value, zone, last, stale: (i = last) => !!(st && st[i]),
      roc: (i = last, k = 7) => (isN(trend[i]) && isN(trend[i - k]) ? trend[i] - trend[i - k] : null),
      breakdown: (i = last) => { const cm = compsAt(i); return { ...cm, ...combine(cm) }; },
    };
  }

  // Gauge for an index: its own trend, strength vs the market (not for the market itself), breadth; value = own range.
  function indexSeries(model, id) {
    const x = model.idx[id]; if (!x) return null;
    const n = model.axis.length, c = x.close, all = model.idx['idx:all'];
    const rs = id === 'idx:all' ? null : c.map((v, i) => (isN(v) && isN(all?.close[i]) && all.close[i] > 0 ? v / all.close[i] : null)), rsm = rs ? I.sma(rs, 20) : null;
    const z = rollingZ(c, 365, 60), trend = new Array(n).fill(null), value = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
      const v = [];
      const t = trendAt(c, i); if (t != null) v.push(t, t); // the index's own trend counts double
      if (rs && isN(rs[i]) && isN(rsm[i])) v.push(rs[i] >= rsm[i] ? 1 : -1);
      const br = breadthAt(model, x.members, i); if (br != null) v.push(br);
      trend[i] = v.length >= 2 ? mean(v) : null;
      value[i] = isN(z[i]) ? clip(-z[i], -2, 2) : null;
    }
    const last = I.lastIdx(c);
    return { trend, value, last, roc: (i = last, k = 7) => (isN(trend[i]) && isN(trend[i - k]) ? trend[i] - trend[i - k] : null) };
  }
  const label = (t) => (t == null ? '—' : t >= TH.strong ? 'Strong up' : t >= TH.up ? 'Up' : t > -TH.up ? 'Neutral' : t > -TH.strong ? 'Down' : 'Strong down');
  const vlabel = (v) => (v == null ? '—' : v >= 1 ? 'Cheap' : v >= 0.4 ? 'Lean cheap' : v > -0.4 ? 'Fair' : v > -1 ? 'Lean rich' : 'Expensive');
  // Ranking for featured prospects: trend first, then value, then a rising gauge.
  const prospect = (t, v, roc) => (t ?? 0) + 0.35 * (v ?? 0) + 0.25 * clip(roc ?? 0, -1, 1);

  const api = { series, indexSeries, trendAt, zoneOf, ZONES, WEIGHTS, TH, label, vlabel, prospect };
  if (isNode) module.exports = api; else root.TPI = api;
})(typeof window !== 'undefined' ? window : globalThis);
