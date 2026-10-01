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
    if (first && unl) { main = first; mainL = '1st Ed'; } // 1st Edition only, same as the graded lines
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
      if (grade === 'raw') { if (c.raw !== false) lines.push(...rawLines(c, s)); continue; } // raw:false cards (EX, DP, index-only) only have backfilled RAW that would go stale
      const pts = s.grades?.[grade];
      if (!pts?.length) continue;
      const demo = s.source === 'demo';
      const kind = demo ? null : C.pooledKind(s.printings);
      const r = demo ? { main: pts, alt: [], out: [], split: null } : C.classify(pts, kind, { ...C.gradedOpts(s, grade), names: WL.printingNames?.[c.key] });
      const mixed = r.kind && !r.split && !r.same ? (r.kind === '1st' ? '1st+Unl mixed' : 'holo+rev mixed') : null;
      const same = r.same ? (r.kind === '1st' ? '1st/Unl · one price level' : 'holo/rev · one price level') : null;
      lines.push({ key: c.key, card: { ...c, line: r.split ? r.split.mainLabel : mixed || same, est: !!r.split, mixed: !!mixed }, pts: r.main, demo });
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
    // Lines that blend two printings (couldn't be split) stay viewable but never feed an index — they're noise.
    const mains = Object.keys(by).filter((k) => !by[k].card.virtual && by[k].card.role !== 'group' && !by[k].card.mixed);
    const idx = {};
    const add = (id, name, kind, keys, extra = {}) => { if (keys.length) idx[id] = { id, name, kind, members: keys, ...makeIndex(axis, keys.map((k) => by[k])), ...extra }; };
    add('idx:all', 'All tracked', 'all', mains, { sprite: WL.eraSprites?.all || null });
    [...new Set(mains.map((k) => by[k].card.era))].forEach((e) => add('idx:era:' + slug(e), e, 'era', mains.filter((k) => by[k].card.era === e), { sprite: WL.eraSprites?.eras?.[e] || null }));
    [...new Set(mains.map((k) => by[k].card.basket || slug(by[k].card.set)))].forEach((b) => {
      const keys = mains.filter((k) => (by[k].card.basket || slug(by[k].card.set)) === b);
      if (keys.length >= 2) add('idx:set:' + b, by[keys[0]].card.set, 'set', keys, { era: by[keys[0]].card.era, symbol: WL.setSymbols?.[by[keys[0]].card.set] || null }); // a lone era pick is not a set index
    });
    // Era families (WOTC vs EX vs DP): only once there is more than one.
    const famOf = (c) => c.family || String(c.era || '').split(' ')[0];
    const fams = [...new Set(mains.map((k) => famOf(by[k].card)))];
    if (fams.length > 1) fams.forEach((f) => add('idx:fam:' + slug(f), WL.familyLabels?.[f] || f, 'family', mains.filter((k) => famOf(by[k].card) === f), { family: f, sprite: WL.eraSprites?.families?.[f] || null }));
    for (const g of WL.groups || []) add(g.id, g.label, g.kind, g.members.filter((k) => by[k] && !by[k].card.mixed), { scope: g.scope, base: g.base || g.label, sprite: g.sprite || null });
    // Which character / theme indexes each card belongs to (base key, so both printings share it).
    const memberOf = {};
    for (const g of WL.groups || []) for (const k of g.members) (memberOf[k] ||= []).push(g.id);
    return { grade, dense: grade === 'raw', axis, by, idx, memberOf, index: idx['idx:all']?.close || [], minPrice: Number(WL.minPrice) || 0, rules: WL.rules || null };
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
      if (b.card.custom || !tradable(model, b)) continue; // below the minimum slab price or not liquid: not a lead
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
    L.push('_Heuristic read of trend, momentum and relative strength from clean eBay graded sales (PSA). Not financial advice._', '');
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

  // ---------- grade gap: a grade's price as a share of the next grade up ----------
  // PSA 9 usually sells for ~15–20% of a PSA 10 on WOTC, PSA 8 for ~half a 9, PSA 7 for ~2/3 of an 8 — but each card
  // has its own normal spread (scarce 10s stretch it). So "cheap" means: well below its OWN usual ratio, and below peers.
  const NEXT = { psa7: 'psa8', psa8: 'psa9', psa9: 'psa10' };
  // Same card AND same printing in another grade's model. A line that blends printings (pooled 1st Ed + Unl, or
  // holo + reverse, that could not be split) is never compared across grades — its price mixes two products.
  function lineIn(m, key, card) {
    if (card?.mixed) return null;
    const base = key.replace(/~alt$/, ''), cand = [m.by[base], m.by[base + '~alt']].filter(Boolean);
    const hit = card?.line && cand.some((y) => y.card.line) ? cand.find((y) => y.card.line === card.line) || null : m.by[key] || null;
    return hit && !hit.card.mixed ? hit : null;
  }
  // Sales of a line in the `days` before index i.
  const salesIn = (b, i, days) => { let n = 0; for (let k = Math.max(0, i - days + 1); k <= i; k++) if (I.isN(b.sales?.[k])) n++; return n; };
  // Peer yardstick for a card's grade ratio when its own history is too short. Tested on this data (leave-one-out):
  // PSA 7÷8 — set, era and family all miss by ~13%; PSA 8÷9 — same-set cards are best (~14% vs ~19%);
  // PSA 9÷10 — nothing predicts it (~45% miss: 10s are card-specific scarcity), so no peer fallback there.
  function peerRatios(model, up) {
    const ck = '_peer_' + up.grade; if (model[ck]) return model[ck];
    const rows = [];
    for (const [key, b] of Object.entries(model.by)) {
      const s = gapSeries(model, up, key, { peer: false }); if (!s) continue;
      const v = s.ratio.filter(I.isN); if (v.length < 10) continue;
      rows.push({ key, set: b.card.set, fam: b.card.family || String(b.card.era || '').split(' ')[0], own: C.median(v) });
    }
    const out = {};
    for (const [key, b] of Object.entries(model.by)) {
      const set = b.card.set, fam = b.card.family || String(b.card.era || '').split(' ')[0];
      const inSet = rows.filter((r) => r.key !== key && r.set === set), inFam = rows.filter((r) => r.key !== key && r.fam === fam);
      out[key] = model.grade === 'psa9' ? null
        : model.grade === 'psa8' && inSet.length >= 2 ? { v: C.median(inSet.map((r) => r.own)), src: 'set' }
        : inFam.length >= 3 ? { v: C.median(inFam.map((r) => r.own)), src: fam } : null;
    }
    return (model[ck] = out);
  }
  // fresh: both grades sold within this many days; parity: their latest sales at most this many days apart (a grade whose
  // newest sales haven't reached the data yet would otherwise look cheap or dear against the other).
  function gapSeries(model, up, key, { fresh = 30, parity = 10, window = 120, peer = true } = {}) {
    const b = model.by[key]; if (!b || !up) return null;
    const u = lineIn(up, key, b.card); if (!u) return null;
    const pos = new Map(up.axis.map((d, i) => [d, i])), n = model.axis.length;
    const uc = new Array(n).fill(null), ulast = new Array(n).fill(null);
    let lastSale = null;
    const saleDay = new Set(); up.axis.forEach((d, i) => { if (u.sales ? I.isN(u.sales[i]) : I.isN(u.close[i])) saleDay.add(d); });
    let mySale = null; const mylast = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const d = model.axis[i], j = pos.get(d);
      if (j != null) uc[i] = u.close[j]; else if (i > 0) uc[i] = uc[i - 1];
      if (saleDay.has(d)) lastSale = i; ulast[i] = lastSale;
      if (b.sales ? I.isN(b.sales[i]) : I.isN(b.close[i])) mySale = i; mylast[i] = mySale;
    }
    const r = b.close.map((v, i) => (I.isN(v) && I.isN(uc[i]) && uc[i] > 0 && ulast[i] != null && i - ulast[i] <= fresh && mylast[i] != null && i - mylast[i] <= fresh && Math.abs(ulast[i] - mylast[i]) <= parity ? v / uc[i] : null));
    const pr = peer ? peerRatios(model, up)[key] : null;
    const normSrc = r.map(() => null);
    const norm = r.map((_, i) => { const w = r.slice(Math.max(0, i - window), i).filter(I.isN); if (w.length >= 30) { normSrc[i] = 'own'; return C.median(w); } if (pr) { normSrc[i] = pr.src; return pr.v; } return null; });
    const gap = r.map((v, i) => (I.isN(v) && I.isN(norm[i]) ? v / norm[i] : null));
    return { up: up.grade, ratio: r, norm, normSrc, gap, upLine: u };
  }
  // Latest grade gap for every card in this grade, with the family's typical ratio as the peer yardstick.
  function gradeGaps(model, up) {
    if (!up || model.dense) return [];
    const rows = [];
    for (const [key, b] of Object.entries(model.by)) {
      const g = gapSeries(model, up, key); if (!g) continue;
      const li = I.lastIdx(g.ratio); if (li < 0 || li < model.axis.length - 8) continue;
      rows.push({ key, card: b.card, up: up.grade, ratio: g.ratio[li], norm: g.norm[li], normSrc: g.normSrc[li], gap: g.gap[li], fam: b.card.family || String(b.card.era || '').split(' ')[0] });
    }
    const pr = peerRatios(model, up);
    rows.forEach((r) => { const p = pr[r.key]; r.peer = p ? p.v : null; r.peerSrc = p ? p.src : null; r.vsPeer = r.peer ? r.ratio / r.peer : null; });
    return rows;
  }

  // ---------- lagging grade: a neighbouring grade of the same card jumped, this one hasn't followed yet ----------
  const PREV = { psa8: 'psa7', psa9: 'psa8', psa10: 'psa9' };
  const GORD = { psa7: 7, psa8: 8, psa9: 9, psa10: 10 };
  // parity: the flat grade's latest sale may be at most this many days older than the jumping grade's latest sale —
  // otherwise the "lag" is usually just newer sales the data doesn't have yet (the provider posts sales days late).
  const LAG = { lb: 30, jump: 0.2, flat: 0.05, fresh: 14, live: 30, parity: 7 };
  // For each day: did grade `other` of this card rise ≥20% over 30 days (on a sale in the last 14 days) while this
  // grade moved ≤5% (and still trades — a sale in the last 30 days)? Returns the per-day flag and the moves.
  function lagSeries(model, other, key) {
    const b = model.by[key]; if (!b || !other || model.dense || other.dense) return null;
    const o = lineIn(other, key, b.card); if (!o) return null;
    const pos = new Map(other.axis.map((d, i) => [d, i])), n = model.axis.length;
    const flag = new Array(n).fill(null), oc = new Array(n).fill(null), mc = new Array(n).fill(null);
    let mySale = null;
    for (let i = 0; i < n; i++) {
      if (I.isN(b.sales?.[i])) mySale = i;
      const j = pos.get(model.axis[i]); if (j == null || j < LAG.lb || i < LAG.lb) continue;
      const a = o.close[j], a0 = o.close[j - LAG.lb], c = b.close[i], c0 = b.close[i - LAG.lb];
      if (!I.isN(a) || !I.isN(a0) || !I.isN(c) || !I.isN(c0) || a0 <= 0 || c0 <= 0) continue;
      let oFresh = false, oLast = null; for (let k = j; k >= 0 && k >= j - LAG.fresh; k--) if (I.isN(o.sales?.[k])) { oFresh = true; oLast = k; break; }
      oFresh = oFresh && salesIn(o, j, LAG.lb) >= 2; // the jump rests on at least 2 sales, not one outlier
      const ordered = GORD[other.grade] > GORD[model.grade] ? a >= c * 0.9 : c >= a * 0.9; // grades in price order, else the data is suspect
      const live = mySale != null && i - mySale <= LAG.live && (oLast == null || (Date.parse(other.axis[oLast]) - Date.parse(model.axis[mySale])) / 864e5 <= LAG.parity);
      oc[i] = a / a0 - 1; mc[i] = c / c0 - 1;
      flag[i] = oFresh && live && ordered ? oc[i] >= LAG.jump && mc[i] <= LAG.flat : false;
    }
    return { other: other.grade, flag, oc, mc };
  }
  // The card across every grade: latest price, 30D move, days since last sale, share of the next grade up.
  function gradeLadder(models, key, card) {
    const rows = [];
    for (const g of ['psa7', 'psa8', 'psa9', 'psa10']) {
      const m = models[g]; if (!m) continue;
      const b = lineIn(m, key, card); if (!b) continue;
      const li = I.lastIdx(b.close); if (li < 0) continue;
      let ls = null; for (let i = li; i >= 0; i--) if (I.isN(b.sales?.[i])) { ls = i; break; }
      rows.push({ grade: g, price: b.close[li], tradable: tradable(m, b), c30: I.chg(b.close, 30), n30: salesIn(b, li, 30), age: ls == null ? null : Math.round((Date.parse(m.axis[m.axis.length - 1]) - Date.parse(m.axis[ls])) / 864e5), key: b.card.key });
    }
    rows.forEach((r, k) => { const up = rows[k + 1]; r.share = up && up.grade === NEXT[r.grade] ? r.price / up.price : null; });
    // A lower grade priced well above a higher one means mixed or mislabeled sales somewhere: no lag call on this card.
    rows.inconsistent = rows.some((r, k) => rows[k + 1] && r.price > rows[k + 1].price * 1.1);
    if (rows.inconsistent) return rows;
    // flag laggards: a neighbour up ≥20% in 30D (with a fresh sale) while this grade is ≤ +5% and still selling
    rows.forEach((r, k) => {
      for (const nb of [rows[k - 1], rows[k + 1]]) if (nb && nb.c30 != null && r.c30 != null && nb.c30 >= LAG.jump * 100 && r.c30 <= LAG.flat * 100 && nb.age != null && nb.age <= LAG.fresh && nb.n30 >= 2 && r.age != null && r.age <= LAG.live && r.age - nb.age <= LAG.parity) r.lagging = (r.lagging || []).concat(nb.grade); // parity: not just missing newer sales
    });
    return rows;
  }

  // ---------- compressed grade: this grade priced almost like the grade below ----------
  // After an upstream repricing, a thinly traded grade can sit near the grade below it until a fresh copy sells.
  // Ratio = (grade below) ÷ (this grade), mapped onto this grade's dates; "compressed" when it is ≥ 0.8 AND
  // ≥ 1.4× the card's usual ratio (or ≥ 0.9 when there is no usual yet). Both grades need recent sales.
  const SQZ = { ratio: 0.8, vsNorm: 1.4, bare: 0.9, max: 1.1 }; // above 1.1 = inverted (lower grade dearer): usually mixed listings, not an opportunity
  function squeezeSeries(model, down, key) {
    const b = model.by[key]; if (!b || !down || model.dense) return null;
    const d = lineIn(down, key, b.card); if (!d) return null;
    const g = gapSeries(down, model, d.card.key); if (!g) return null;
    const pos = new Map(down.axis.map((x, i) => [x, i])), n = model.axis.length;
    const ratio = new Array(n).fill(null), norm = new Array(n).fill(null), normSrc = new Array(n).fill(null), flag = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const j = pos.get(model.axis[i]); if (j == null) continue;
      ratio[i] = g.ratio[j]; norm[i] = g.norm[j]; normSrc[i] = g.normSrc[j];
      if (!I.isN(ratio[i])) continue;
      if (salesIn(d, j, 30) < 2) { flag[i] = false; continue; } // the grade below's price rests on ≥ 2 recent sales
      flag[i] = ratio[i] <= SQZ.max && (I.isN(norm[i]) ? ratio[i] >= SQZ.ratio && ratio[i] >= norm[i] * SQZ.vsNorm : ratio[i] >= SQZ.bare);
    }
    return { down: down.grade, ratio, norm, normSrc, flag };
  }

  // Latest compression for a card across its grades (fresh within 8 days); inverted cases are reported as such.
  function squeezeNow(models, key, card) {
    const out = [];
    if (card?.mixed || gradeLadder(models, key, card).inconsistent) return out; // mixed printings or out-of-order grades: no call
    for (const g of ['psa8', 'psa9', 'psa10']) {
      const m = models[g], d = models[PREV[g]]; if (!m || !d) continue;
      const b = lineIn(m, key, card); if (!b) continue;
      const q = squeezeSeries(m, d, b.card.key); if (!q) continue;
      const li = I.lastIdx(q.ratio); if (li < 0 || li < m.axis.length - 8) continue;
      const r = q.ratio[li], nm = q.norm[li];
      if (r > SQZ.max) out.push({ grade: g, down: PREV[g], ratio: r, norm: nm, inverted: true, key: b.card.key });
      else if (q.flag[li]) out.push({ grade: g, down: PREV[g], ratio: r, norm: nm, normSrc: q.normSrc[li], key: b.card.key, price: b.close[I.lastIdx(b.close)] });
    }
    return out;
  }

  // ---------- implied price ----------
  // What `grade` would sell for if its usual ratio to a neighbouring grade `ref` came back:
  //   ref above → ref price × usual (grade ÷ ref);  ref below → ref price ÷ usual (ref ÷ grade).
  // Only as good as the reference grade's price, so its recent sale count is returned alongside.
  function impliedPrice(models, key, card, grade, ref) {
    const up = GORD[ref] > GORD[grade], lo = up ? grade : ref, hi = up ? ref : grade;
    const ml = models[lo], mh = models[hi], mg = models[grade], mr = models[ref]; if (!ml || !mh || !mg || !mr) return null;
    const bl = lineIn(ml, key, card), br = lineIn(mr, key, card), bg = lineIn(mg, key, card); if (!bl || !br || !bg) return null;
    const g = gapSeries(ml, mh, bl.card.key); if (!g) return null;
    const li = I.lastIdx(g.norm), norm = li >= 0 ? g.norm[li] : null; if (!I.isN(norm) || norm <= 0) return null;
    const ri = I.lastIdx(br.close), gi = I.lastIdx(bg.close), refPrice = br.close[ri], now = bg.close[gi];
    const price = up ? refPrice * norm : refPrice / norm;
    return { price, now, upside: now > 0 ? (price / now - 1) * 100 : null, ref, refPrice, refN30: salesIn(br, ri, 30), norm, normSrc: g.normSrc[li] };
  }

  // ---------- value by grade: last sale vs an estimate from the card's other grades ----------
  // Anchor = the grade with the most clean sales in the last 30 days (a single-printing or properly separated line).
  // Every other grade is estimated by walking the grade ladder from it with ratios between neighbouring grades:
  // the card's own median ratio when it has ≥ 10 paired sale days, else the best tested peer yardstick (same set for
  // PSA 8÷9, era family for 7÷8 and 9÷10). Each step carries its typical miss on this data, compounded along the walk.
  const MISS = { own: 0.10, set: 0.14, fam78: 0.13, fam89: 0.19, fam910: 0.45 };
  function ownRatios(model, up) {
    const ck = '_own_' + up.grade; if (model[ck]) return model[ck];
    const rows = [];
    for (const [key, b] of Object.entries(model.by)) {
      const s = gapSeries(model, up, key, { peer: false }); if (!s) continue;
      const v = s.ratio.filter(I.isN); if (v.length < 10) continue;
      rows.push({ key, set: b.card.set, fam: b.card.family || String(b.card.era || '').split(' ')[0], own: C.median(v) });
    }
    return (model[ck] = rows);
  }
  function pairRatio(ml, mh, key, card) {
    const fam = card.family || String(card.era || '').split(' ')[0];
    const lk = lineIn(ml, key, card), rows = ownRatios(ml, mh);
    const mine = lk ? rows.find((r) => r.key === lk.card.key) : null;
    if (mine) return { v: mine.own, src: 'own', miss: MISS.own };
    const others = rows.filter((r) => r.key.replace(/~alt$/, '') !== key.replace(/~alt$/, ''));
    const inSet = others.filter((r) => r.set === card.set), inFam = others.filter((r) => r.fam === fam);
    if (ml.grade === 'psa8' && inSet.length >= 2) return { v: C.median(inSet.map((r) => r.own)), src: 'set', miss: MISS.set };
    if (inFam.length >= 3) return { v: C.median(inFam.map((r) => r.own)), src: fam, miss: ml.grade === 'psa7' ? MISS.fam78 : ml.grade === 'psa8' ? MISS.fam89 : MISS.fam910 };
    return null;
  }
  function gradeEstimates(models, key, card) {
    const G = ['psa7', 'psa8', 'psa9', 'psa10'].filter((g) => models[g]), rows = [];
    for (const g of G) {
      const m = models[g], clean = lineIn(m, key, card), shown = clean || m.by[key.replace(/~alt$/, '')] || null;
      let last = null, age = null, n30 = 0;
      if (shown) {
        const sales = shown.sales || [];
        for (let i = sales.length - 1; i >= 0; i--) if (I.isN(sales[i])) { last = sales[i]; age = Math.round((Date.parse(m.axis[m.axis.length - 1]) - Date.parse(m.axis[i])) / 864e5); break; }
        n30 = salesIn(shown, m.axis.length - 1, 30);
      }
      const li = clean ? I.lastIdx(clean.close) : -1;
      rows.push({ grade: g, last, age, n30, blended: !clean && !!shown, mkt: li >= 0 ? clean.close[li] : null, clean: !!clean });
    }
    const anc = rows.filter((r) => r.clean && r.mkt && r.age != null && r.age <= 45).sort((a, b) => b.n30 - a.n30 || (a.age - b.age))[0];
    if (!anc) return { rows, anchor: null };
    const ai = rows.indexOf(anc); anc.est = anc.mkt; anc.lmiss = 0; anc.anchor = true;
    for (let k = ai + 1; k < rows.length; k++) { // walk up: higher grade = lower ÷ ratio(lower÷higher)
      const r = pairRatio(models[rows[k - 1].grade], models[rows[k].grade], key, card); if (!r || rows[k - 1].est == null) break;
      rows[k].est = rows[k - 1].est / r.v; rows[k].lmiss = Math.hypot(rows[k - 1].lmiss, Math.log(1 + r.miss)); rows[k].via = r.src;
    }
    for (let k = ai - 1; k >= 0; k--) { // walk down: lower grade = higher × ratio
      const r = pairRatio(models[rows[k].grade], models[rows[k + 1].grade], key, card); if (!r || rows[k + 1].est == null) break;
      rows[k].est = rows[k + 1].est * r.v; rows[k].lmiss = Math.hypot(rows[k + 1].lmiss, Math.log(1 + r.miss)); rows[k].via = r.src;
    }
    rows.forEach((r) => { if (r.est != null) { r.miss = Math.exp(r.lmiss) - 1; r.gap = r.last != null && !r.anchor ? (r.last / r.est - 1) * 100 : null; } });
    return { rows, anchor: anc.grade };
  }

  // Minimum slab price (data/sets.json minPrice → watchlist): a line counts only on days its market price is at
  // least this much — for leads (today's price) and for the backtest / forward record (the price on the day a setup fired).
  const aboveMin = (model, b, i) => { const min = model?.minPrice || 0; if (!min) return true; const j = i == null ? I.lastIdx(b.close) : i; return j >= 0 && I.isN(b.close[j]) && b.close[j] >= min; };
  // Tradability rules (override in data/sets.json "rules" → watchlist): a slab you could actually buy and later sell.
  //  liquid  = sold on ≥ liqDays different days in the last liqWin days, and at least once in the last liqAge days
  //  spread  = 75th ÷ 25th percentile of those sales; above spreadFlag the "market price" is a guess (flagged, not dropped)
  //  fees    = PSA Vault consignment (psacard.com/info/consignment-rates, Oct 2026): one fee on the whole sale price,
  //            by price band, no separate eBay fee. Taken off the exit price when judging whether a buy pays.
  // All judged as of day i (the day a setup fired), so tests never use information from after the fire.
  const RULES = { liqDays: 6, liqWin: 90, liqAge: 30, spreadFlag: 1.6,
    feeTiers: [[0, 0.13, 3], [100, 0.13, 0], [500, 0.12, 0], [1000, 0.10, 0], [2500, 0.09, 0], [5000, 0.07, 0]] }; // [from $, rate, flat $]
  // Share of a sale price lost to the seller fee (rate for its band + any flat fee).
  function feeAt(price, model) {
    const T = (model ? rulesOf(model) : RULES).feeTiers; let r = T[0];
    for (const t of T) if (price >= t[0]) r = t;
    return Math.min(0.99, r[1] + (price > 0 ? r[2] / price : 0));
  }
  const rulesOf = (model) => ({ ...RULES, ...(model?.rules || {}) });
  const dayOf = (model, i) => (i == null ? model.axis.length - 1 : i);
  function saleDaysIn(b, j, win) { const out = []; if (!b.sales) return out; for (let k = Math.max(0, j - win + 1); k <= j; k++) if (I.isN(b.sales[k])) out.push(k); return out; }
  function liquidAt(model, b, i) {
    if (!b.sales) return true; // RAW / demo: no sale-day record
    const R = rulesOf(model), j = dayOf(model, i), d = saleDaysIn(b, j, R.liqWin);
    return d.length >= R.liqDays && j - d[d.length - 1] <= R.liqAge;
  }
  function spreadAt(model, b, i) {
    const R = rulesOf(model), j = dayOf(model, i), ps = saleDaysIn(b, j, R.liqWin).map((k) => b.sales[k]).sort((x, y) => x - y);
    if (ps.length < 6) return null;
    const q = (f) => ps[Math.min(ps.length - 1, Math.floor(f * ps.length))];
    return q(0.75) / q(0.25);
  }
  const tradable = (model, b, i) => aboveMin(model, b, i) && liquidAt(model, b, i);
  function liquidity(model, b, i) { // for display
    const R = rulesOf(model), j = dayOf(model, i), d = saleDaysIn(b, j, R.liqWin), sp = spreadAt(model, b, i);
    return { days: d.length, age: d.length ? j - d[d.length - 1] : null, liquid: liquidAt(model, b, i), spread: sp, wide: sp != null && sp > R.spreadFlag, rules: R };
  }
  const api = { aboveMin, tradable, liquidAt, spreadAt, liquidity, rulesOf, RULES, feeAt, gradeEstimates, pairRatio, impliedPrice, peerRatios, squeezeNow, squeezeSeries, SQZ, lagSeries, gradeLadder, PREV, LAG, gapSeries, gradeGaps, NEXT, lineIn, ladder, trackCorr, changes, buildModel, makeIndex, signals, brief, consensus, leadLag, briefMarkdown, fillDays, slug, GRADE_LABEL, MIN_SALE_DAYS_90 };
  if (isNode) module.exports = api; else root.Model = api;
})(typeof window !== 'undefined' ? window : globalThis);
