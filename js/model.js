// SlabDex model — shared by the terminal (browser) and scripts/brief.mjs (Node).
// Builds clean card lines, set/era/all indexes, signal scores and the market brief.
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const I = isNode ? require('./indicators.js') : root.Ind;
  const C = isNode ? require('./clean.js') : root.Clean;
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const MIN_SALE_DAYS_90 = 8; // graded: below this, momentum readings are mostly noise
  const GRADE_LABEL = { raw: 'RAW NM', psa7: 'PSA 7', psa8: 'PSA 8', psa9: 'PSA 9', psa10: 'PSA 10' };

  function fillDays(sorted) {
    if (!sorted.length) return [];
    const out = [], end = Date.parse(sorted[sorted.length - 1]);
    for (let t = Date.parse(sorted[0]); t <= end; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }

  // Raw NM lines come per printing, so 1st Ed and Unlimited are exact (no clustering needed).
  function rawLines(c, s) {
    const raw = s.raw || {};
    const prs = Object.keys(raw).filter((p) => raw[p]?.length);
    if (!prs.length) return [];
    const pick = (re) => prs.find((p) => re.test(p));
    const first = pick(/1st/i), unl = pick(/unlimited/i), rev = pick(/reverse/i);
    const holo = prs.find((p) => !/reverse|1st|unlimited|normal/i.test(p)) || prs.find((p) => !/reverse/i.test(p));
    let main, alt = null, mainL, altL;
    if (first && unl) { main = unl; alt = first; mainL = 'Unl'; altL = '1st Ed'; }
    else if (rev && holo) { main = holo; alt = rev; mainL = 'Holo'; altL = 'Reverse'; }
    else { main = holo || prs[0]; mainL = null; }
    const out = [{ key: c.key, card: { ...c, line: mainL, est: false }, pts: raw[main], dense: true }];
    if (alt && raw[alt].length >= 10) out.push({ key: c.key + '~alt', card: { ...c, key: c.key + '~alt', line: altL, est: false, virtual: true }, pts: raw[alt], dense: true });
    return out;
  }

  function buildModel(WL, SERIES, grade) {
    const lines = [];
    for (const c of WL.cards) {
      const s = SERIES[c.key];
      if (!s) continue;
      if (grade === 'raw') { lines.push(...rawLines(c, s)); continue; }
      const pts = s.grades?.[grade];
      if (!pts?.length) continue;
      const demo = s.source === 'demo';
      const kind = demo ? null : C.pooledKind(s.printings);
      const r = demo ? { main: pts, alt: [], out: [], split: null } : C.classify(pts, kind);
      const mixed = kind && !r.split ? (kind === '1st' ? '1st+Unl mixed' : 'holo+rev mixed') : null;
      lines.push({ key: c.key, card: { ...c, line: r.split ? r.split.mainLabel : mixed, est: !!r.split }, pts: r.main, demo });
      if (r.split && r.alt.length >= 4) lines.push({ key: c.key + '~alt', card: { ...c, key: c.key + '~alt', line: r.split.altLabel, est: true, virtual: true }, pts: r.alt, demo });
    }
    const dates = new Set();
    lines.forEach((l) => l.pts.forEach((p) => dates.add(p.t)));
    const axis = fillDays([...dates].sort());
    const pos = new Map(axis.map((d, i) => [d, i]));
    const by = {};
    for (const l of lines) {
      const raw = new Array(axis.length).fill(null), vol = new Array(axis.length).fill(null);
      l.pts.forEach((p) => { const i = pos.get(p.t); if (i == null) return; raw[i] = p.p; vol[i] = p.n ?? p.v7 ?? null; });
      const first = I.firstIdx(raw);
      if (!l.demo) for (let i = Math.max(0, first); i < vol.length; i++) if (vol[i] == null) vol[i] = 0;
      // Graded: market line = median of the last 3 sales, carried forward. Raw: provider's daily market price.
      let close;
      if (l.dense || l.demo) close = I.ffill(raw).map((v, i) => (i < first ? null : v));
      else {
        const mkt = new Array(axis.length).fill(null), last3 = [];
        raw.forEach((v, i) => { if (!I.isN(v)) return; last3.push(v); if (last3.length > 3) last3.shift(); mkt[i] = C.median(last3); });
        close = I.ffill(mkt).map((v, i) => (i < first ? null : v));
      }
      by[l.key] = { card: l.card, close, sales: l.dense ? null : raw, vol, demo: !!l.demo, saleN: l.pts.length, dense: !!l.dense };
    }
    const mains = Object.keys(by).filter((k) => !by[k].card.virtual);
    const idx = {};
    const add = (id, name, kind, keys, extra = {}) => { if (keys.length) idx[id] = { id, name, kind, members: keys, ...makeIndex(axis, keys.map((k) => by[k])), ...extra }; };
    add('idx:all', 'All tracked', 'all', mains);
    [...new Set(mains.map((k) => by[k].card.era))].forEach((e) => add('idx:era:' + slug(e), e, 'era', mains.filter((k) => by[k].card.era === e)));
    [...new Set(mains.map((k) => by[k].card.basket || slug(by[k].card.set)))].forEach((b) => {
      const keys = mains.filter((k) => (by[k].card.basket || slug(by[k].card.set)) === b);
      add('idx:set:' + b, by[keys[0]].card.set, 'set', keys, { era: by[keys[0]].card.era });
    });
    return { grade, dense: grade === 'raw', axis, by, idx, index: idx['idx:all']?.close || [] };
  }

  // Equal-weight geometric chain-link, base 100: bouncing prices can't make it drift.
  function makeIndex(axis, members) {
    const close = new Array(axis.length).fill(null), vol = new Array(axis.length).fill(null);
    let level = 100;
    for (let i = 0; i < axis.length; i++) {
      let s = 0, k = 0, any = false, v = 0, vAny = false;
      for (const m of members) {
        const a = m.close;
        if (I.isN(a[i])) any = true;
        if (i > 0 && I.isN(a[i]) && I.isN(a[i - 1]) && a[i - 1] > 0) { s += Math.log(a[i] / a[i - 1]); k++; }
        if (I.isN(m.vol[i])) { v += m.vol[i]; vAny = true; }
      }
      if (k) level *= Math.exp(s / k);
      close[i] = any ? level : null;
      vol[i] = vAny ? v : null;
    }
    return { close, vol };
  }

  function signals(close, vol, bench, { dense = false } = {}) {
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
    out.vol90 = I.volatility(close, 90);
    out.volExp = out.vol30 != null && out.vol90 ? out.vol30 / out.vol90 : null; // >1 = swings widening
    const c30p = n >= 60 && I.isN(close[n - 30]) && I.isN(close[n - 60]) ? (close[n - 30] / close[n - 60] - 1) * 100 : null;
    out.accel = I.isN(out.c30) && I.isN(c30p) ? out.c30 - c30p : null;
    if (bench) {
      const rs = close.map((v, i) => (I.isN(v) && I.isN(bench[i]) && bench[i] ? v / bench[i] : null));
      out.rs30 = I.chg(rs, 30); out.rs90 = I.chg(rs, 90);
    }
    if (vol) {
      const vv = vol.slice(Math.max(0, n - 29), n + 1).filter(I.isN);
      const now = vol.slice(Math.max(0, n - 6), n + 1).filter(I.isN);
      const sum30 = vv.reduce((a, b) => a + b, 0);
      out.volRatio = vv.length >= 10 && now.length && sum30 > 0 ? now.reduce((a, b) => a + b, 0) / now.length / (sum30 / vv.length) : null;
      out.saleDays90 = dense ? null : vol.slice(Math.max(0, n - 89), n + 1).filter((v) => v > 0).length;
    }
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
    if (out.saleDays90 != null && out.saleDays90 < MIN_SALE_DAYS_90) { out.score = null; out.tag = [`THIN · ${out.saleDays90} SALES/90D`, 'mid']; return out; }
    const w = have.reduce((s, p) => s + p[0], 0);
    out.score = Math.round((have.reduce((s, p) => s + p[0] * p[1], 0) / w) * 100);
    const ext = (out.distS50 ?? 0) > 25 || (out.rsi ?? 0) > 78;
    out.tag = out.score >= 68 ? (ext ? ['EXTENDED', 'warn'] : ['EARLY STRENGTH', 'good']) : out.score >= 55 ? ['IMPROVING', 'good'] : out.score >= 40 ? ['NEUTRAL', 'mid'] : ['WEAK', 'bad'];
    return out;
  }

  // ---------- market brief ----------
  // Plain-language read of where momentum is building: sets first, then eras, then standout cards.
  function brief(model) {
    const dense = model.dense;
    const all = model.idx['idx:all'];
    const sig = (x) => signals(x.close, x.vol, x.id === 'idx:all' ? null : model.index, { dense });
    const sets = Object.values(model.idx).filter((x) => x.kind === 'set').map((x) => ({ x, s: sig(x) }));
    const eras = Object.values(model.idx).filter((x) => x.kind === 'era').map((x) => ({ x, s: sig(x) }));
    const item = (k, text, tone) => ({ k, text, tone });
    const pc = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(0) + '%');
    const lv = (v) => (v == null ? '—' : v.toFixed(0));
    const lines = [];
    // Card-level scoreability decides whether this grade is worth reading at all.
    const cardSig = [];
    for (const [k, b] of Object.entries(model.by)) {
      const set = model.idx['idx:set:' + (b.card.basket || slug(b.card.set))];
      const s = signals(b.close, b.vol, set?.close || model.index, { dense });
      if (s.score != null) cardSig.push({ k, b, s });
    }
    const nCards = Object.values(model.by).filter((b) => !b.card.virtual).length;
    const meta = { asOf: model.axis[model.axis.length - 1] || null, grade: model.grade, gradeLabel: GRADE_LABEL[model.grade] || model.grade, cards: nCards, scoredCards: cardSig.filter((o) => !o.b.card.virtual).length };
    if (!nCards || meta.scoredCards < Math.max(3, nCards * 0.3)) {
      return { ...meta, thin: true, lines: [{ label: 'Data', items: [item('idx:all', `Too few ${meta.gradeLabel} sales to read momentum yet (${meta.scoredCards}/${nCards} cards scoreable). Try another grade.`, 'warn')] }] };
    }
    const by30 = sets.filter((o) => o.s.c30 != null).sort((a, b) => b.s.c30 - a.s.c30);
    const scored = sets.filter((o) => o.s.score != null).sort((a, b) => b.s.score - a.s.score);
    if (all) { const s = sig(all); lines.push({ label: 'Market', items: [item('idx:all', `All tracked ${lv(s.last)} · ${pc(s.c30)} 30D · ${pc(s.c90)} 90D`, s.c30 >= 0 ? 'good' : 'bad')] }); }
    if (by30[0]) lines.push({ label: 'Leading set', items: [item(by30[0].x.id, `${by30[0].x.name} ${lv(by30[0].s.last)}, ${pc(by30[0].s.c30)} in 30D`, 'good')] });
    if (scored.length) lines.push({ label: 'Strongest signals', items: scored.slice(0, 3).map((o) => item(o.x.id, `${o.x.name} ${o.s.score}`, 'good')) });
    const ramp = sets.filter((o) => (o.s.accel ?? 0) > 5 && (o.s.c30 ?? 0) > 0).sort((a, b) => b.s.accel - a.s.accel).slice(0, 2);
    if (ramp.length) lines.push({ label: 'Ramping up', items: ramp.map((o) => item(o.x.id, `${o.x.name} (30D ${pc(o.s.c30)}, +${o.s.accel.toFixed(0)} pts faster than prior 30D)`, 'good')) });
    const swing = sets.filter((o) => (o.s.volExp ?? 0) >= 1.3).sort((a, b) => b.s.volExp - a.s.volExp).slice(0, 2);
    if (swing.length) lines.push({ label: 'Swings widening', items: swing.map((o) => item(o.x.id, `${o.x.name} (30D volatility ${o.s.volExp.toFixed(1)}× its 90D)`, 'warn')) });
    const lag = [...scored].reverse().filter((o) => o.s.score < 45).slice(0, 2);
    const lagIds = new Set(lag.map((o) => o.x.id));
    const lag30 = by30.slice(-2).reverse().filter((o) => (o.s.c30 ?? 0) < 0 && !lagIds.has(o.x.id));
    if (lag.length || lag30.length) lines.push({ label: 'Lagging', items: [...lag.map((o) => item(o.x.id, `${o.x.name} ${o.s.score}`, 'bad')), ...lag30.map((o) => item(o.x.id, `${o.x.name} ${pc(o.s.c30)} 30D`, 'bad'))] });
    if (eras.length) lines.push({ label: 'Eras', items: eras.sort((a, b) => (b.s.c30 ?? -1e9) - (a.s.c30 ?? -1e9)).map((o) => item(o.x.id, `${o.x.name} ${pc(o.s.c30)}`, (o.s.c30 ?? 0) >= 0 ? 'good' : 'bad')) });

    // Standout cards: strong score AND clearly beating its own set, with real activity behind it.
    const cards = cardSig.filter((o) => !/mixed/.test(o.b.card.line || '')); // clean lines only
    const name = (b) => `${b.card.name}${b.card.line ? ' ' + b.card.line : ''} (${b.card.set})`;
    const leaders = cards.filter((o) => o.s.score >= 65 && (o.s.rs30 ?? 0) >= 10).sort((a, b) => b.s.rs30 - a.s.rs30).slice(0, 2);
    const standout = leaders.map((o) => item(o.k, `${name(o.b)}: ${o.s.tag[0].toLowerCase()}, ${pc(o.s.c30)} 30D, ${pc(o.s.rs30)} vs its set${o.s.volRatio >= 1.2 ? ', sales picking up' : ''}`, o.s.tag[1]));
    const breakout = cards.filter((o) => !leaders.includes(o) && o.s.trendUp && (o.s.distS50 ?? 0) > 0 && (o.s.distS50 ?? 0) < 15 && (o.s.accel ?? 0) > 10 && (o.s.volRatio ?? 0) >= 1.2).sort((a, b) => b.s.accel - a.s.accel)[0];
    if (breakout) standout.push(item(breakout.k, `${name(breakout.b)}: momentum turning up on rising sales (not yet extended)`, 'good'));
    if (standout.length) lines.push({ label: 'Cards to note', items: standout });
    return { ...meta, lines };
  }

  function briefMarkdown(briefs) {
    const L = ['# SlabDex market brief', ''];
    for (const b of briefs) {
      L.push(`## ${b.gradeLabel} — as of ${b.asOf} (${b.cards} cards, ${b.scoredCards} with enough data to score)`, '');
      for (const l of b.lines) L.push(`- **${l.label}:** ${l.items.map((i) => i.text).join('; ')}`);
      L.push('');
    }
    L.push('_Heuristic read of trend, momentum and relative strength from clean eBay graded sales (PSA) and TCGplayer raw Near Mint prices. Not financial advice._', '');
    return L.join('\n');
  }

  const api = { buildModel, makeIndex, signals, brief, briefMarkdown, fillDays, slug, GRADE_LABEL, MIN_SALE_DAYS_90 };
  if (isNode) module.exports = api; else root.Model = api;
})(typeof window !== 'undefined' ? window : globalThis);
