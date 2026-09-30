// Setup backtest: which indicator setups were followed by cards beating the market, beyond chance?
//
// For every tracked card line (current grade) it marks the days each setup fired, then measures what
// happened next: entry = median of the next few real sales, exit = market line H days later, minus the
// all-tracked index over the same window. Chance is judged against same-date peers: 1000 times, each
// event is swapped for a random other card on that date. Because ~60 setups are tested, p-values are
// corrected with Benjamini–Hochberg, and a setup must also beat its peers in both halves of the history.
//
// Statuses: confirmed (survives correction + both halves + ≥ 5 cards + beats the typical peer at
// least half the time, so one lucky boom can't carry it) › promising (p < 0.05 alone,
// could still be luck) › no edge › too few events. Only confirmed setups get top billing in the UI.
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const I = isNode ? require('./indicators.js') : root.Ind;
  const Model = isNode ? require('./model.js') : root.Model;
  const isN = I.isN;

  const H = 30;            // forward window (days)
  const WARM = 60;         // days of history before a setup can count (SMA50 / score need it)
  const PAIR_WIN = 7;      // two setups within 7 days = a combination
  const CONF_WIN = 10, CONF_N = 3;
  const PERMS = 1000;
  const MIN_EVENTS = 15, MIN_CARDS = 5, Q = 0.10;
  const BOOM = Math.log(1.15); // "boom" = beat the market by 15%+

  // Base setups: [id, label, fn(ctx, i) → condition true on day i]. An event is the day the condition turns on.
  const upTh = (a, i, th) => isN(a[i]) && isN(a[i - 1]) && a[i] >= th && a[i - 1] < th;        // crosses up through a level
  const upX = (a, b, i) => isN(a[i]) && isN(b[i]) && isN(a[i - 1]) && isN(b[i - 1]) && a[i] > b[i] && a[i - 1] <= b[i - 1]; // a crosses above b
  const BASE = [
    ['rsi30', 'RSI up through 30', (x, i) => upTh(x.rsi, i, 30)],
    ['rsi50', 'RSI up through 50', (x, i) => upTh(x.rsi, i, 50)],
    ['macdX', 'MACD crosses signal', (x, i) => upX(x.ml, x.ms, i)],
    ['macdX0', 'MACD cross below zero', (x, i) => upX(x.ml, x.ms, i) && x.ml[i] < 0],
    ['px50', 'Price back above SMA50', (x, i) => upX(x.c, x.s50, i)],
    ['gold', 'SMA20 crosses SMA50', (x, i) => upX(x.s20, x.s50, i)],
    ['rsX', 'RS turns up vs market', (x, i) => upX(x.rs, x.rsm, i)],
    ['volUp', 'Sales pace surge', (x, i) => upTh(x.vr, i, 1.5)],
    ['dip', 'Oversold dip (−15%, RSI<40)', (x, i) => x.dip[i] && !x.dip[i - 1]],
    ['hmaUp', 'Hull MA turns up', (x, i) => isN(x.hm[i]) && isN(x.hm[i - 1]) && isN(x.hm[i - 2]) && x.hm[i] > x.hm[i - 1] && x.hm[i - 1] <= x.hm[i - 2]],
    ['stUp', 'Supertrend flips up', (x, i) => x.st[i] === 1 && x.st[i - 1] === -1],
    ['vzoX', 'VZO (sales pressure) crosses 0', (x, i) => upTh(x.vz, i, 0)],
    ['rsSetX', 'Beats its own set (RS vs set turns up)', (x, i) => upX(x.rsS, x.rsSm, i)],
    ['gapLow', 'Cheap vs next grade up (<80% of its usual ratio)', (x, i) => !!x.gap && isN(x.gap[i]) && isN(x.gap[i - 1]) && x.gap[i] < 0.8 && x.gap[i - 1] >= 0.8],
    ['lagUp', 'Lagging grade: the grade above jumped ≥20%, this one has not', (x, i) => !!x.lagUp && x.lagUp[i] === true && x.lagUp[i - 1] !== true],
    ['lagDown', 'Lagging grade: the grade below jumped ≥20%, this one has not', (x, i) => !!x.lagDn && x.lagDn[i] === true && x.lagDn[i - 1] !== true],
    ['sc55', 'Score to IMPROVING', (x, i) => upTh(x.sc, i, 55)],
    ['sc68', 'Score to EARLY STRENGTH', (x, i) => upTh(x.sc, i, 68)],
  ];
  const SHORT = { rsi30: 'RSI↑30', rsi50: 'RSI↑50', macdX: 'MACD×', macdX0: 'MACD×<0', px50: 'Px>SMA50', gold: 'SMA20×50', rsX: 'RS↑', volUp: 'Pace↑', dip: 'Dip', hmaUp: 'HMA↑', stUp: 'ST↑', vzoX: 'VZO↑0', rsSetX: 'RS↑set', gapLow: 'Gap↓', lagUp: 'Lag↑', lagDown: 'Lag↓', sc55: 'Score≥55', sc68: 'Score≥68' };
  const SOLO = new Set(['gapLow', 'lagUp', 'lagDown']); // cross-grade price setups: tested on their own (few events)
  const NESTED = new Set(['macdX+macdX0', 'sc55+sc68']);
  const RULES = [
    ...BASE.map(([id, label]) => ({ id, label, parts: [id] })),
    ...BASE.flatMap(([a], i) => BASE.slice(i + 1).map(([b]) => ({ id: `${a}+${b}`, parts: [a, b] }))).filter((r) => !NESTED.has(r.id) && !r.parts.some((p) => SOLO.has(p))) // grade gap is tested on its own (few events)
      .map((r) => ({ ...r, label: `${SHORT[r.parts[0]]} + ${SHORT[r.parts[1]]} within ${PAIR_WIN}d` })),
    { id: 'conf3', label: `${CONF_N}+ setups within ${CONF_WIN}d`, parts: null },
    // Curated combos built from what the pairs keep pointing at (trend turning up + strength), plus filters:
    { id: 'trend3', label: 'ST↑ + Px>SMA50 + Score≥55 within 7d', parts: ['stUp', 'px50', 'sc55'], all: true },
    { id: 'stCalm', label: 'ST↑ while RSI < 70 (not stretched)', parts: ['stUp'], fn: (u, i) => u.trig.stUp[i] && u.x.rsi[i] != null && u.x.rsi[i] < 70 },
    { id: 'stDemand', label: 'ST↑ with sales pressure (VZO > 0)', parts: ['stUp', 'vzoX'], fn: (u, i) => u.trig.stUp[i] && u.x.vz[i] != null && u.x.vz[i] > 0 },
    { id: 'stLeader', label: 'ST↑ while beating the market (RS > its MA)', parts: ['stUp', 'rsX'], fn: (u, i) => u.trig.stUp[i] && u.x.rs[i] != null && u.x.rsm[i] != null && u.x.rs[i] > u.x.rsm[i] },
    { id: 'pullback', label: 'Pullback in uptrend (back above SMA20, SMA20>SMA50, ST up)', parts: ['px50', 'gold', 'stUp'], fn: (u, i) => { const x = u.x; return x.st[i] === 1 && x.s20[i] > x.s50[i] && x.c[i] > x.s20[i] && x.c[i - 1] <= x.s20[i - 1]; } },
  ];

  const within = (t, i, w) => { if (!t) return false; for (let j = Math.max(0, i - w); j <= i; j++) if (t[j]) return true; return false; };
  // Same setup firing in another PSA grade of the same card (and printing) within the week: agreement across
  // separate sale streams is much harder to get by accident than one grade's wiggle.
  const CROSS = ['rsi30', 'rsi50', 'macdX', 'px50', 'gold', 'rsX', 'rsSetX', 'volUp', 'hmaUp', 'stUp', 'vzoX', 'dip'];
  RULES.push(...CROSS.map((id) => ({ id: id + '@2g', label: `${BASE.find((b) => b[0] === id)[1]} · in 2+ grades`, parts: [id], cross: true, fn: (u, i) => u.trig[id][i] && within(u.cross?.[id], i, PAIR_WIN) })));
  // Deterministic RNG so the browser and the brief script agree.
  function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function context(b, bench, setBench, light = false) {
    const c = b.close, n = c.length;
    const rsi = I.rsi(c, 14), m = I.macd(c), s20 = I.sma(c, 20), s50 = I.sma(c, 50);
    const rs = c.map((v, i) => (isN(v) && isN(bench[i]) && bench[i] ? v / bench[i] : null)), rsm = I.sma(rs, 20);
    const sb = setBench || bench, rsS = c.map((v, i) => (isN(v) && isN(sb[i]) && sb[i] ? v / sb[i] : null)), rsSm = I.sma(rsS, 20);
    const vr = new Array(n).fill(null), dip = new Array(n).fill(false), sc = new Array(n).fill(null);
    const first = I.firstIdx(c);
    for (let i = first; i < n && first >= 0; i++) {
      if (b.vol) {
        let s7 = 0, k7 = 0, s30 = 0, k30 = 0;
        for (let j = Math.max(0, i - 29); j <= i; j++) if (isN(b.vol[j])) { s30 += b.vol[j]; k30++; if (j > i - 7) { s7 += b.vol[j]; k7++; } }
        vr[i] = k30 >= 10 && k7 && s30 > 0 ? s7 / k7 / (s30 / k30) : null;
      }
      let hi = -Infinity; for (let j = Math.max(first, i - 89); j <= i; j++) if (isN(c[j]) && c[j] > hi) hi = c[j];
      dip[i] = isN(c[i]) && c[i] <= hi * 0.85 && rsi[i] != null && rsi[i] < 40;
      if (!light && i - first >= WARM - 1) sc[i] = Model.signals(c.slice(0, i + 1), b.vol ? b.vol.slice(0, i + 1) : null, bench.slice(0, i + 1), { dense: b.dense }).score ?? null;
    }
    const hm = I.hma(c, 20), st = I.supertrend(c, 10, 3).dir, vz = b.vol ? I.vzo(c, b.vol, 14).vzo : new Array(n).fill(null);
    return { c, rsi, ml: m.line, ms: m.signal, s20, s50, rs, rsm, rsS, rsSm, vr, dip, sc, hm, st, vz };
  }

  function run(model, opts = {}) {
    const bench = model.index, axis = model.axis;
    const perms = opts.perms ?? PERMS;
    if (!bench?.length) return { ok: false, reason: 'no market index' };
    // RAW is the provider's smoothed market price (a rolling average of sales). Smoothing makes trends persist
    // on paper, so momentum setups would look predictive without being buyable. Graded sales only.
    if (model.dense) return { ok: false, grade: model.grade, reason: 'not run on RAW — it is a smoothed market price, which would flatter momentum setups; switch to a PSA grade' };
    const setClose = (m, c) => (m.idx['idx:set:' + (c.basket || Model.slug(c.set))] || m.idx['idx:era:' + Model.slug(c.era || '')])?.close || null;
    const pos = new Map(axis.map((d, i) => [d, i]));
    const others = (opts.others || []).filter((m) => m && m !== model && !m.dense && m.grade !== model.grade);
    const upModel = others.find((m) => m.grade === Model.NEXT[model.grade]) || null, downModel = others.find((m) => m.grade === Model.PREV[model.grade]) || null;
    // Base triggers of the same card+printing in the other grades, mapped onto this grade's dates.
    function crossTrig(key, b, first, last) {
      if (!others.length) return null;
      const base = key.replace(/~alt$/, ''), out = {};
      for (const id of CROSS) out[id] = new Uint8Array(axis.length);
      let any = false;
      for (const om of others) {
        const cand = [om.by[base], om.by[base + '~alt']].filter(Boolean);
        const ob = b.card.line && cand.some((y) => y.card.line) ? cand.find((y) => y.card.line === b.card.line) : om.by[key];
        if (!ob || ob.demo) continue;
        const f0 = I.firstIdx(ob.close), l0 = I.lastIdx(ob.close); if (f0 < 0) continue;
        const ox = context(ob, om.index, setClose(om, ob.card), true);
        for (const [id, , fn] of BASE) {
          if (!CROSS.includes(id)) continue;
          for (let i = Math.max(f0 + 1, f0 + WARM); i <= l0; i++) if (fn(ox, i)) { const j = pos.get(om.axis[i]); if (j != null) { out[id][j] = 1; any = true; } }
        }
      }
      return any ? out : null;
    }
    const units = [];
    for (const [key, b] of Object.entries(model.by)) {
      if (b.demo) continue;
      const first = I.firstIdx(b.close), last = I.lastIdx(b.close);
      const lo = first + WARM, hi = last - H;
      const x = context(b, bench, setClose(model, b.card));
      if (upModel) x.gap = Model.gapSeries(model, upModel, key)?.gap || null;
      if (upModel) x.lagUp = Model.lagSeries(model, upModel, key)?.flag || null;
      if (downModel) x.lagDn = Model.lagSeries(model, downModel, key)?.flag || null;
      // Base triggers on every day (for live setups too), fwd excess where the outcome is known.
      const trig = {};
      for (const [id, , fn] of BASE) {
        const t = new Uint8Array(axis.length);
        for (let i = Math.max(first + 1, lo); i <= last; i++) if (fn(x, i)) t[i] = 1;
        trig[id] = t;
      }
      // Entry = what you could actually pay: the median of the next (up to) 3 sales after the setup fires,
      // within 14 days — not the market line that fired it. Otherwise a lucky cheap sale "predicts" its own
      // rebound (tested on pure noise: the dip setup passed until this was fixed). Exit = market line at +H.
      const fwd = new Float64Array(axis.length).fill(NaN);
      const sales = b.dense ? null : b.sales;
      for (let i = lo; i <= hi; i++) {
        if (!isN(b.close[i + H]) || !isN(bench[i]) || !isN(bench[i + H]) || bench[i] <= 0) continue;
        let entry = null;
        if (!sales) entry = b.close[i + 1];
        else {
          const got = []; let lastJ = -1;
          for (let j = i + 1; j <= Math.min(i + 14, i + H - 1) && got.length < 3; j++) if (isN(sales[j])) { got.push(sales[j]); lastJ = j; }
          let after = false; for (let j = lastJ + 1; j <= i + H && lastJ >= 0; j++) if (isN(sales[j])) { after = true; break; }
          if (got.length >= 2 && after) { got.sort((a, c) => a - c); const h = got.length >> 1; entry = got.length % 2 ? got[h] : Math.sqrt(got[h - 1] * got[h]); } // true median (geometric mean of the middle two)
        }
        if (isN(entry) && entry > 0) fwd[i] = Math.log(b.close[i + H] / entry) - Math.log(bench[i + H] / bench[i]);
      }
      units.push({ key, card: b.card, lo, hi, last, trig, fwd, x, cross: crossTrig(key, b, first, last) });
    }
    const usable = units.filter((u) => u.hi - u.lo >= 20);
    if (usable.length < MIN_CARDS) return { ok: false, reason: `needs ${WARM + H + 20}+ days of history on ${MIN_CARDS}+ cards (have ${usable.length})`, horizon: H, tested: 0 };

    // Rule event arrays (raw, before cooldown).
    function ruleTrig(u, r) {
      const n = axis.length, out = new Uint8Array(n);
      if (r.fn) { for (let i = 1; i < n; i++) if (r.fn(u, i)) out[i] = 1; return out; }
      if (r.all) { // every part fired within PAIR_WIN days, event on the day the last one fires
        const T = r.parts.map((p) => u.trig[p]);
        for (let i = 0; i < n; i++) if (T.some((t) => t[i]) && T.every((t) => within(t, i, PAIR_WIN))) out[i] = 1;
        return out;
      }
      if (r.parts && r.parts.length === 1) return u.trig[r.id];
      if (r.parts) { const [A, B] = r.parts.map((p) => u.trig[p]); for (let i = 0; i < n; i++) if ((A[i] && within(B, i, PAIR_WIN)) || (B[i] && within(A, i, PAIR_WIN))) out[i] = 1; return out; }
      let prevOn = false; // confluence: distinct base setups in the last CONF_WIN days reaches CONF_N
      for (let i = 0; i < n; i++) { let k = 0; for (const [id] of BASE) if (id !== 'macdX0' && id !== 'sc55' && !SOLO.has(id) && within(u.trig[id], i, CONF_WIN)) k++; const on = k >= CONF_N; if (on && !prevOn) out[i] = 1; prevOn = on; }
      return out;
    }
    // Baselines over all eligible card-days, and every card's outcome on each date (the peer pool).
    let bs = 0, bn = 0, bh = 0, bb = 0; const mid = Math.round((Math.min(...usable.map((u) => u.lo)) + Math.max(...usable.map((u) => u.hi))) / 2);
    const pool = axis.map(() => []);
    for (const u of usable) for (let i = u.lo; i <= u.hi; i++) { const f = u.fwd[i]; if (!isN(f)) continue; bs += f; bn++; if (f > 0) bh++; if (f >= BOOM) bb++; pool[i].push(f); }
    const dayMean = pool.map((v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null));
    const dayMed = pool.map((v) => { if (!v.length) return null; const w = [...v].sort((a, b) => a - b), h = w.length >> 1; return w.length % 2 ? w[h] : (w[h - 1] + w[h]) / 2; });
    const base = { mean: bs / bn, hit: bh / bn, boom: bb / bn, n: bn };

    // Null = same dates, random cards. Under "the setup says nothing", the card it flagged should do no
    // better than any other tracked card over the same 30 days. (A per-card date-shuffle null was tried
    // first and flagged dozens of setups on pure random walks: declining cards fire more rebound setups
    // and also have lower own-average returns, which fakes an edge.)
    const R = rng(opts.seed ?? 20261017);
    const results = [];
    for (const r of RULES) {
      const evs = []; let n = 0, s = 0, hit = 0, boom = 0, edge = 0, beat = 0; const cards = new Set(); const hs = [{ s: 0, n: 0 }, { s: 0, n: 0 }];
      const live = [];
      for (const u of usable) {
        const t = ruleTrig(u, r);
        for (let i = u.lo, cool = -1; i <= u.hi; i++) if (t[i] && i > cool && isN(u.fwd[i]) && pool[i].length >= 5) { // non-overlapping windows, ≥ 5 peers
          const f = u.fwd[i]; evs.push(i); cool = i + H - 1; cards.add(u.key.replace(/~alt$/, ''));
          n++; s += f; edge += f - dayMean[i]; if (f > dayMed[i]) beat++; if (f > 0) hit++; if (f >= BOOM) boom++;
          const h = hs[i < mid ? 0 : 1]; h.s += f - dayMean[i]; h.n++;
        }
        for (let i = Math.max(u.lo, u.last - 7); i <= u.last; i++) if (t[i]) live.push({ key: u.key, ago: u.last - i });
      }
      const mean = n ? s / n : null;
      let p = null;
      if (n >= MIN_EVENTS) {
        let ge = 0;
        for (let k = 0; k < perms; k++) {
          let ps = 0;
          for (const i of evs) { const v = pool[i]; ps += v[Math.floor(R() * v.length)]; }
          if (ps >= s) ge++;
        }
        p = (ge + 1) / (perms + 1);
      }
      const hm = hs.map((h) => (h.n >= 5 ? h.s / h.n : null));
      const holds = hm.every((v) => v != null && v > 0);
      results.push({ id: r.id, label: r.label, parts: r.parts, n, cards: cards.size, mean, edge: n ? edge / n : null, excess: mean == null ? null : (Math.exp(mean) - 1) * 100, vsPeers: n ? (Math.exp(edge / n) - 1) * 100 : null, hit: n ? hit / n : null, beatPeers: n ? beat / n : null, boom: n ? boom / n : null, p, halves: hm.map((v) => (v == null ? null : (Math.exp(v) - 1) * 100)), holds, live });
    }
    // Benjamini–Hochberg over the setups that had enough events.
    const tested = results.filter((r) => r.p != null).sort((a, b) => a.p - b.p), m = tested.length;
    let running = 1;
    for (let k = m - 1; k >= 0; k--) { running = Math.min(running, (tested[k].p * m) / (k + 1)); tested[k].q = running; }
    for (const r of results) {
      r.status = r.p == null ? 'few' : r.q <= Q && r.holds && r.cards >= MIN_CARDS && r.edge > 0 && r.beatPeers >= 0.5 ? 'confirmed' : r.p < 0.05 && r.edge > 0 ? 'promising' : 'none';
    }
    const rank = { confirmed: 0, promising: 1, none: 2, few: 3 };
    results.sort((a, b) => rank[a.status] - rank[b.status] || (a.p ?? 2) - (b.p ?? 2));

    // Live setups: cards where a confirmed / promising setup fired in the last 7 days.
    const byCard = {};
    for (const r of results) if (r.status === 'confirmed' || r.status === 'promising') for (const l of r.live) {
      const e = (byCard[l.key] ||= { key: l.key, rules: [] });
      if (!e.rules.some((x) => x.id === r.id)) e.rules.push({ id: r.id, label: r.label, status: r.status, ago: l.ago, excess: r.excess, vsPeers: r.vsPeers, beatPeers: r.beatPeers, hit: r.hit, n: r.n, p: r.p, q: r.q });
    }
    const shrink = (x) => (x.vsPeers ?? 0) * (x.n / (x.n + 20)); // small samples pulled toward zero
    const picks = Object.values(byCard).map((e) => {
      e.rules.sort((a, b) => rank[a.status] - rank[b.status] || shrink(b) - shrink(a));
      e.best = e.rules[0]; e.status = e.best.status; e.card = model.by[e.key]?.card;
      return e;
    }).filter((e) => e.card).sort((a, b) => rank[a.status] - rank[b.status] || shrink(b.best) - shrink(a.best));
    const counts = { confirmed: 0, promising: 0, none: 0, few: 0 }; results.forEach((r) => counts[r.status]++);
    return { ok: true, grade: model.grade, horizon: H, tested: m, rules: results.length, counts, base, picks, results, cards: usable.length, events: results.reduce((s, r) => s + r.n, 0), asOf: axis[axis.length - 1] };
  }

  const pct = (v, d = 0) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
  // One plain-language line on where the evidence stands.
  function verdict(e) {
    if (!e?.ok) return `Setup backtest: ${e?.reason || 'not run'}.`;
    const bestP = e.results.find((r) => r.p != null);
    if (e.counts.confirmed) return `${e.counts.confirmed} setup${e.counts.confirmed > 1 ? 's' : ''} beat other cards beyond chance over the next ${e.horizon} days (of ${e.tested} tested on ${e.cards} cards, corrected for multiple tests, held in both halves).`;
    if (e.counts.promising) return `No setup is confirmed yet. ${e.counts.promising} look promising (p < 0.05 alone) but don't survive correction for testing ${e.tested} setups, so they may be luck.`;
    return `No setup has beaten chance yet (${e.tested} tested on ${e.cards} cards${bestP ? `, best p = ${bestP.p.toFixed(2)}` : ''}). Signals are descriptive only for now.`;
  }
  function markdown(e) {
    if (!e?.ok) return `## Setup backtest\n\n${verdict(e)}\n`;
    const L = [`## Setup backtest · ${Model.GRADE_LABEL[e.grade] || e.grade} · ${e.horizon}D excess vs market`, '', verdict(e), '', `Baseline (all card-days, entry at next sales): ${pct((Math.exp(e.base.mean) - 1) * 100, 1)} vs market on average, ${(e.base.hit * 100).toFixed(0)}% beat the market, ${(e.base.boom * 100).toFixed(0)}% by 15%+. "vs peers" = versus other tracked cards over the same dates.`, ''];
    if (e.picks.length) { L.push('### Setups firing now (last 7 days)', ''); e.picks.slice(0, 12).forEach((p) => L.push(`- **${p.card.name}${p.card.line ? ' · ' + p.card.line : ''}** (${p.card.set}) — ${p.best.label}, ${p.best.ago}d ago · ${p.status} · hist. ${pct(p.best.vsPeers, 1)} vs peers, ${(p.best.beatPeers * 100).toFixed(0)}% beat typical peer, n ${p.best.n}`)); L.push(''); }
    L.push('| Setup | Status | Events | Cards | vs peers | vs market | Beat typical peer | 15%+ | p | q | Halves (vs peers) |', '|---|---|---|---|---|---|---|---|---|---|---|');
    e.results.filter((r) => r.p != null).slice(0, 15).forEach((r) => L.push(`| ${r.label} | ${r.status} | ${r.n} | ${r.cards} | ${pct(r.vsPeers, 1)} | ${pct(r.excess, 1)} | ${(r.beatPeers * 100).toFixed(0)}% | ${(r.boom * 100).toFixed(0)}% | ${r.p.toFixed(3)} | ${r.q.toFixed(2)} | ${r.halves.map((h) => pct(h, 0)).join(' / ')} |`));
    return L.join('\n') + '\n';
  }

  // One-line stat for a rule, for the UI.
  const stat = (r) => `${pct(r.vsPeers, 1)} vs peers over ${H}D · ${(r.beatPeers * 100).toFixed(0)}% beat typical peer · n ${r.n}${r.p != null ? ` · p ${r.p < 0.001 ? '<0.001' : r.p.toFixed(3)}` : ''}${r.q != null ? ` · q ${r.q.toFixed(2)}` : ''}`;
  const api = { run, verdict, markdown, stat, pct, RULES, H };
  if (isNode) module.exports = api; else root.Edge = api;
})(typeof window !== 'undefined' ? window : globalThis);
