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
    const all = [...WL.cards, ...(WL.extra || []).map((c) => ({ ...c, role: 'group' }))];
    for (const c of all) {
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
    // Set / era / all indexes are the set baskets only; index-only cards (role 'group') feed character & theme indexes.
    const mains = Object.keys(by).filter((k) => !by[k].card.virtual && by[k].card.role !== 'group');
    const idx = {};
    const add = (id, name, kind, keys, extra = {}) => { if (keys.length) idx[id] = { id, name, kind, members: keys, ...makeIndex(axis, keys.map((k) => by[k])), ...extra }; };
    add('idx:all', 'All tracked', 'all', mains);
    [...new Set(mains.map((k) => by[k].card.era))].forEach((e) => add('idx:era:' + slug(e), e, 'era', mains.filter((k) => by[k].card.era === e)));
    [...new Set(mains.map((k) => by[k].card.basket || slug(by[k].card.set)))].forEach((b) => {
      const keys = mains.filter((k) => (by[k].card.basket || slug(by[k].card.set)) === b);
      if (keys.length >= 2) add('idx:set:' + b, by[keys[0]].card.set, 'set', keys, { era: by[keys[0]].card.era }); // a lone era pick is not a set index
    });
    // Era families (WOTC vs EX vs DP): only once there is more than one.
    const famOf = (c) => c.family || String(c.era || '').split(' ')[0];
    const fams = [...new Set(mains.map((k) => famOf(by[k].card)))];
    if (fams.length > 1) fams.forEach((f) => add('idx:fam:' + slug(f), WL.familyLabels?.[f] || f, 'family', mains.filter((k) => famOf(by[k].card) === f), { family: f }));
    for (const g of WL.groups || []) add(g.id, g.label, g.kind, g.members.filter((k) => by[k]), { scope: g.scope, base: g.base || g.label, sprite: g.sprite || null });
    // Which character / theme indexes each card belongs to (base key, so both printings share it).
    const memberOf = {};
    for (const g of WL.groups || []) for (const k of g.members) (memberOf[k] ||= []).push(g.id);
    return { grade, dense: grade === 'raw', axis, by, idx, memberOf, index: idx['idx:all']?.close || [] };
  }

  // One entry per character / theme: its all-eras index where one exists, otherwise its single-era index.
  function ladder(model, kind) {
    const byBase = {};
    for (const x of Object.values(model.idx)) if (x.kind === kind) (byBase[x.base || x.name] ||= []).push(x);
    return Object.values(byBase).map((xs) => xs.find((x) => x.scope === 'all') || xs[0]);
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
      if (b.card.custom) continue;
      const set = model.idx['idx:set:' + (b.card.basket || slug(b.card.set))];
      const s = signals(b.close, b.vol, set?.close || model.index, { dense });
      if (s.score != null) cardSig.push({ k, b, s });
    }
    const nCards = Object.values(model.by).filter((b) => !b.card.virtual && b.card.role !== 'group').length;
    const meta = { asOf: model.axis[model.axis.length - 1] || null, grade: model.grade, gradeLabel: GRADE_LABEL[model.grade] || model.grade, cards: nCards, scoredCards: cardSig.filter((o) => !o.b.card.virtual && o.b.card.role !== 'group').length };
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
    // Characters and themes: who is gaining on whom, independent of set.
    const grp = (kind) => ladder(model, kind).map((x) => ({ x, s: sig(x) })).filter((o) => o.s.c30 != null);
    const chars = grp('char').sort((a, b) => b.s.c30 - a.s.c30), themes = grp('theme').sort((a, b) => b.s.c30 - a.s.c30);
    if (chars.length) {
      lines.push({ label: 'Leading characters', items: chars.slice(0, 3).map((o) => item(o.x.id, `${o.x.name} ${pc(o.s.c30)} 30D`, o.s.c30 >= 0 ? 'good' : 'bad')) });
      const rampC = chars.filter((o) => (o.s.accel ?? 0) > 5 && o.s.c30 > 0).sort((a, b) => b.s.accel - a.s.accel).slice(0, 2);
      if (rampC.length) lines.push({ label: 'Characters ramping', items: rampC.map((o) => item(o.x.id, `${o.x.name} (+${o.s.accel.toFixed(0)} pts faster than prior 30D)`, 'good')) });
      lines.push({ label: 'Trailing characters', items: chars.slice(-2).reverse().map((o) => item(o.x.id, `${o.x.name} ${pc(o.s.c30)} 30D`, o.s.c30 >= 0 ? 'mid' : 'bad')) });
    }
    if (themes.length) lines.push({ label: 'Themes', items: themes.map((o) => item(o.x.id, `${o.x.name} ${pc(o.s.c30)}`, o.s.c30 >= 0 ? 'good' : 'bad')) });
    const famRows = Object.values(model.idx).filter((x) => x.kind === 'family').map((x) => ({ x, s: sig(x) })).filter((o) => o.s.c30 != null).sort((a, b) => b.s.c30 - a.s.c30);
    if (famRows.length) lines.splice(1, 0, { label: 'Era families', items: famRows.map((o) => item(o.x.id, `${o.x.name} ${lv(o.s.last)} · ${pc(o.s.c30)} 30D`, o.s.c30 >= 0 ? 'good' : 'bad')) });

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

  // ---------- consensus across grades ----------
  // A read counts only where a grade has real data. Sets/cards are "agreeing" when 2+ grades point the
  // same way and none points the other way. Printings are matched exactly (1st Ed with 1st Ed); blended
  // "mixed" lines are left out so a pooled record can't fake agreement.
  const CONS_GRADES = ['raw', 'psa7', 'psa8', 'psa9', 'psa10'];
  const dirOf = (s) => (s.score == null ? null : s.score >= 55 && (s.c30 ?? 0) >= 0 ? 1 : s.score < 40 || ((s.c30 ?? 0) < -5 && s.score < 55) ? -1 : 0);
  const tagOf = (line) => (!line ? 'single' : /1st/i.test(line) ? '1st' : /unl/i.test(line) ? 'unl' : /mixed/i.test(line) ? null : /reverse|lower|upper/i.test(line) ? null : 'single');
  const TAG_LABEL = { '1st': ' 1st Ed', unl: ' Unl', single: '' };

  function weeklyReturns(m, id) {
    const x = m.idx[id]; if (!x) return {};
    const w = {};
    m.axis.forEach((d, i) => { if (x.close[i] == null) return; const dt = new Date(d + 'T00:00:00Z'); const wk = new Date(dt - ((dt.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); w[wk] = x.close[i]; });
    const ks = Object.keys(w).sort(), r = {};
    for (let i = 1; i < ks.length; i++) r[ks[i]] = Math.log(w[ks[i]] / w[ks[i - 1]]);
    return r;
  }
  function corr(a, b) {
    const n = a.length; if (n < 8) return null;
    const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
    return aa && bb ? ab / Math.sqrt(aa * bb) : null;
  }
  // Does RAW move first? Correlate weekly RAW index returns with graded returns 1–4 weeks later.
  function leadLag(raw, graded, id = 'idx:all') {
    const R = weeklyReturns(raw, id), G = weeklyReturns(graded, id);
    const ks = Object.keys(R).filter((k) => k in G).sort();
    let best = null;
    for (let lag = 1; lag <= 4; lag++) {
      const a = [], b = [];
      for (let i = 0; i + lag < ks.length; i++) { a.push(R[ks[i]]); b.push(G[ks[i + lag]]); }
      const c = corr(a, b);
      if (c != null && (!best || c > best.r)) best = { lag, r: c, n: a.length };
    }
    if (!best) return null;
    best.need = 2.5 / Math.sqrt(best.n); // ~95% bar, raised because we pick the best of 4 lags
    best.real = best.r >= best.need;
    return best;
  }

  // Correlation of weekly returns between two aligned series over the last `days` days.
  function trackCorr(axis, a, b, days = 120) {
    const n = axis.length, from = Math.max(0, n - days), wk = {};
    for (let i = from; i < n; i++) {
      if (a[i] == null || b[i] == null) continue;
      const dt = new Date(axis[i] + 'T00:00:00Z'), w = new Date(dt - ((dt.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
      wk[w] = [a[i], b[i]];
    }
    const ks = Object.keys(wk).sort(), ra = [], rb = [];
    for (let i = 1; i < ks.length; i++) { const p = wk[ks[i - 1]], q = wk[ks[i]]; if (p[0] > 0 && p[1] > 0) { ra.push(Math.log(q[0] / p[0])); rb.push(Math.log(q[1] / p[1])); } }
    const moved = ra.filter((x) => Math.abs(x) > 1e-9).length;
    return moved >= 5 ? { r: corr(ra, rb), weeks: ra.length } : null;
  }

  function consensus(models) {
    const grades = CONS_GRADES.filter((g) => models[g] && !brief(models[g]).thin);
    const lab = (g) => GRADE_LABEL[g] || g;
    const item = (k, text, tone) => ({ k, text, tone });
    const lines = [];
    const reads = (kind) => {
      const out = {};
      for (const g of grades) {
        const m = models[g];
        const pool = kind === 'char' || kind === 'theme' ? ladder(m, kind) : Object.values(m.idx).filter((x) => x.kind === kind);
        for (const x of pool) {
          const s = signals(x.close, x.vol, x.id === 'idx:all' ? null : m.index, { dense: m.dense });
          const d = dirOf(s); if (d == null) continue;
          (out[x.id] ||= { id: x.id, name: x.name, r: [] }).r.push({ g, d, score: s.score, c30: s.c30 });
        }
      }
      return Object.values(out);
    };
    const summ = (o) => ({ ...o, up: o.r.filter((z) => z.d > 0), dn: o.r.filter((z) => z.d < 0), avg: o.r.reduce((a, z) => a + z.score, 0) / o.r.length });
    const sets = reads('set').map(summ);
    const gl = (arr) => arr.map((z) => lab(z.g).replace('RAW NM', 'RAW')).join(', ');

    const agreeUp = sets.filter((o) => o.up.length >= 2 && !o.dn.length).sort((a, b) => b.up.length - a.up.length || b.avg - a.avg);
    if (agreeUp.length) lines.push({ label: 'Grades agree ▲', items: agreeUp.slice(0, 4).map((o) => item(o.id, `${o.name} [${gl(o.up)}]`, 'good')) });
    const agreeDn = sets.filter((o) => o.dn.length >= 2 && !o.up.length).sort((a, b) => b.dn.length - a.dn.length || a.avg - b.avg);
    if (agreeDn.length) lines.push({ label: 'Grades agree ▼', items: agreeDn.slice(0, 3).map((o) => item(o.id, `${o.name} [${gl(o.dn)}]`, 'bad')) });
    const split = sets.filter((o) => o.up.length && o.dn.length).sort((a, b) => b.r.length - a.r.length);
    if (split.length) lines.push({ label: 'Grades split', items: split.slice(0, 3).map((o) => item(o.id, `${o.name} [▲ ${gl(o.up)} / ▼ ${gl(o.dn)}]`, 'warn')) });

    // RAW moving before graded (or the reverse): a current divergence, not a proven lead.
    if (grades.includes('raw')) {
      const div = [];
      for (const o of sets) {
        const rw = o.r.find((z) => z.g === 'raw'); const gr = o.r.filter((z) => z.g !== 'raw' && z.c30 != null);
        if (!rw || !gr.length || rw.c30 == null) continue;
        const gAvg = gr.reduce((a, z) => a + z.c30, 0) / gr.length;
        if (rw.c30 >= 8 && rw.d > 0 && gAvg < 3) div.push({ o, t: `${o.name}: RAW ${rw.c30 >= 0 ? '+' : ''}${rw.c30.toFixed(0)}% 30D, graded ${gAvg >= 0 ? '+' : ''}${gAvg.toFixed(0)}%`, tone: 'good', gap: rw.c30 - gAvg });
        else if (gAvg >= 8 && rw.c30 <= 0) div.push({ o, t: `${o.name}: graded ${gAvg >= 0 ? '+' : ''}${gAvg.toFixed(0)}% 30D, RAW ${rw.c30.toFixed(0)}%`, tone: 'warn', gap: gAvg - rw.c30 });
      }
      div.sort((a, b) => b.gap - a.gap);
      if (div.length) lines.push({ label: 'RAW vs graded', items: div.slice(0, 3).map((d) => item(d.o.id, d.t, d.tone)) });
    }

    for (const [kind, label] of [['char', 'Characters agree'], ['theme', 'Themes agree']]) {
      const gs = reads(kind).map(summ);
      const up = gs.filter((o) => o.up.length >= 2 && !o.dn.length).sort((a, b) => b.up.length - a.up.length || b.avg - a.avg);
      const dn = gs.filter((o) => o.dn.length >= 2 && !o.up.length).sort((a, b) => b.dn.length - a.dn.length || a.avg - b.avg);
      if (up.length) lines.push({ label: label + ' ▲', items: up.slice(0, 4).map((o) => item(o.id, `${o.name} [${gl(o.up)}]`, 'good')) });
      if (dn.length) lines.push({ label: label + ' ▼', items: dn.slice(0, 3).map((o) => item(o.id, `${o.name} [${gl(o.dn)}]`, 'bad')) });
    }
    const eras = reads('era').map(summ);
    if (eras.length) lines.push({ label: 'Eras', items: eras.sort((a, b) => b.up.length - b.dn.length - (a.up.length - a.dn.length)).map((o) => item(o.id, `${o.name} ▲${o.up.length} ▼${o.dn.length}`, o.up.length > o.dn.length ? 'good' : o.dn.length > o.up.length ? 'bad' : '')) });

    // Cards: same card AND same printing agreeing across grades, clean lines only.
    const cards = {};
    for (const g of grades) {
      const m = models[g];
      for (const [k, b] of Object.entries(m.by)) {
        if (b.card.custom) continue;
        const tag = tagOf(b.card.line); if (!tag) continue;
        const base = k.replace(/~alt$/, '');
        const set = m.idx['idx:set:' + (b.card.basket || slug(b.card.set))];
        const s = signals(b.close, b.vol, set?.close || m.index, { dense: m.dense });
        const d = dirOf(s); if (d == null) continue;
        const ck = base + '|' + tag;
        (cards[ck] ||= { name: `${b.card.name}${TAG_LABEL[tag]} · ${b.card.set}`, keys: {}, r: [] }).r.push({ g, d, score: s.score, rs30: s.rs30 });
        cards[ck].keys[g] = k;
      }
    }
    const cardUp = Object.values(cards).map(summ).filter((o) => o.up.length >= 2 && !o.dn.length).sort((a, b) => b.up.length - a.up.length || b.avg - a.avg);
    if (cardUp.length) lines.push({ label: 'Cards agree ▲', items: cardUp.slice(0, 3).map((o) => ({ ...item(Object.values(o.keys)[0], `${o.name} [${gl(o.up)}]`, 'good'), keys: o.keys })) });

    // Lead-lag self-check, recomputed every run as history grows.
    const ll = grades.includes('raw') ? grades.filter((g) => g !== 'raw').map((g) => ({ g, x: leadLag(models.raw, models[g]) })).filter((z) => z.x) : [];
    const real = ll.filter((z) => z.x.real);
    let leadNote = null;
    if (ll.length) {
      const weeks = Math.max(...ll.map((z) => z.x.n));
      leadNote = real.length
        ? `RAW has led ${real.map((z) => `${lab(z.g)} by ~${z.x.lag}w (r ${z.x.r.toFixed(2)})`).join(', ')} over ${weeks} weeks.`
        : `No reliable RAW→graded lead yet (${weeks} weeks of data; best ${ll.sort((a, b) => b.x.r - a.x.r)[0] ? `${lab(ll[0].g)} at ${ll[0].x.lag}w, r ${ll[0].x.r.toFixed(2)} vs ${ll[0].x.need.toFixed(2)} needed` : '—'}).`;
    }
    return { grades, gradeLabels: grades.map(lab), lines, leadNote, leadLag: ll.map((z) => ({ grade: z.g, lag: z.x.lag, r: +z.x.r.toFixed(3), need: +z.x.need.toFixed(3), weeks: z.x.n, real: z.x.real })) };
  }

  function briefMarkdown(briefs, cons) {
    const L = ['# SlabDex market brief', ''];
    if (cons) {
      L.push(`## Consensus across grades (${cons.gradeLabels.join(', ')})`, '');
      for (const l of cons.lines) L.push(`- **${l.label}:** ${l.items.map((i) => i.text).join('; ')}`);
      if (cons.leadNote) L.push(`- **Lead-lag check:** ${cons.leadNote}`);
      L.push('');
    }
    for (const b of briefs) {
      L.push(`## ${b.gradeLabel} — as of ${b.asOf} (${b.cards} cards, ${b.scoredCards} with enough data to score)`, '');
      for (const l of b.lines) L.push(`- **${l.label}:** ${l.items.map((i) => i.text).join('; ')}`);
      L.push('');
    }
    L.push('_Heuristic read of trend, momentum and relative strength from clean eBay graded sales (PSA) and TCGplayer raw Near Mint prices. Not financial advice._', '');
    return L.join('\n');
  }

  // What changed: compare today's read with the read `lb` days ago on the same data.
  const TAG_RANK = { WEAK: 0, NEUTRAL: 1, IMPROVING: 2, 'EARLY STRENGTH': 3, EXTENDED: 3 };
  function changes(close, vol, bench, { dense = false, lb = 7 } = {}) {
    const n = close.length, cut = (a) => (a ? a.slice(0, Math.max(0, n - lb)) : a);
    const now = signals(close, vol, bench, { dense }), was = signals(cut(close), cut(vol), cut(bench), { dense });
    const out = [];
    const rk = (s) => (s.score == null ? null : TAG_RANK[s.tag?.[0]] ?? null);
    const a = rk(was), b = rk(now);
    if (a != null && b != null && a !== b) out.push({ dir: b > a ? 1 : -1, text: `${was.tag[0].toLowerCase()} → ${now.tag[0].toLowerCase()}` });
    else if (a == null && b != null) out.push({ dir: b >= 2 ? 1 : 0, text: `now scoreable: ${now.tag[0].toLowerCase()}` });
    if (was.distS50 != null && now.distS50 != null && Math.sign(was.distS50) !== Math.sign(now.distS50)) out.push({ dir: now.distS50 > 0 ? 1 : -1, text: now.distS50 > 0 ? 'crossed above 50D avg' : 'fell below 50D avg' });
    if (was.accel != null && now.accel != null && was.accel <= 0 && now.accel > 5) out.push({ dir: 1, text: 'momentum turned up' });
    if (was.accel != null && now.accel != null && was.accel >= 0 && now.accel < -5) out.push({ dir: -1, text: 'momentum rolled over' });
    if (was.rs30 != null && now.rs30 != null && was.rs30 <= 0 && now.rs30 > 5) out.push({ dir: 1, text: 'started beating its benchmark' });
    const dir = out.reduce((x, c) => x + c.dir, 0), d = dir > 0 ? 1 : dir < 0 ? -1 : 0;
    // Only a real shift counts: 2+ signals agreeing on direction, or the tag jumping two levels.
    const agree = out.filter((c) => c.dir === d && d !== 0).length;
    const strong = d !== 0 && (agree >= 2 || (a != null && b != null && Math.abs(b - a) >= 2));
    return strong ? { dir: d, items: out, now } : null;
  }

  const api = { ladder, trackCorr, changes, buildModel, makeIndex, signals, brief, consensus, leadLag, briefMarkdown, fillDays, slug, GRADE_LABEL, MIN_SALE_DAYS_90 };
  if (isNode) module.exports = api; else root.Model = api;
})(typeof window !== 'undefined' ? window : globalThis);
