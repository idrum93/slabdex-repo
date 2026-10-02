// Roster ladder — keeps the tracked cards competing with the bench after discover can no longer be afforded.
//
// Every daily fetch, with the credits left over (never past safeDailyCredits):
//  1. Gate. A card qualifies when at least one grade is liquid at the minimum price on collected data: 6+ clean sale
//     days in the last 90, a sale in the last 30, recent median ≥ minPrice, printings not blended (same rule as the
//     site's "tradable"). Its other grades may be thin.
//  2. Demote. A tracked card that has failed the gate on every check for 7+ days moves to the bench (pins never do).
//  3. Check. The least recently checked bench cards are fetched (2 credits each, a few a day) and judged by the same gate.
//  4. Promote. A qualifying bench card takes an open slot in its basket (a WOTC set, or an era family), or replaces the
//     weakest card there if it beats it: more liquid grades, or as many and a price at least 25% higher. A card that
//     doesn't qualify is always weaker than one that does. Basket sizes never grow past perSet / the family cap, and open
//     slots are filled only while the whole roster still fits safeDailyCredits with room for the bench checks.
//
// Bench cards are fetched only now and then, so between checks their sales are estimated from the provider's lifetime
// sale count (the rise since the last check × this card's clean share). Tracked cards are fetched every 3 days and
// judged on their own sales. Moves are logged in data/ladder.json and shown in the brief.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA, asList, num, gradeBlock, loadSeries, saveSeries, mergeCard, BudgetError } from './lib.mjs';
const Clean = createRequire(import.meta.url)('../js/clean.js');

const DAY = 864e5;
const ago = (today, t) => Math.round((Date.parse(today) - Date.parse(t)) / DAY);
const minus = (today, d) => new Date(Date.parse(today) - d * DAY).toISOString().slice(0, 10);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function rulesOf(cfg) {
  const r = cfg.rules || {};
  return { days: Number(r.liqDays ?? 6), win: Number(r.liqWin ?? 90), age: Number(r.liqAge ?? 30), min: Number(cfg.minPrice || 0) };
}

// One grade: is it liquid at the minimum? bench = true adds the estimate for stretches no fetch covered.
function gradeGate(s, g, today, R, bench) {
  const pts = s.grades?.[g] || [];
  const out = { g, liquid: false, days: 0, last: null, med: null, est: 0 };
  if (!pts.length) return out;
  const kind = Clean.pooledKind(s.printings);
  const r = Clean.classify(pts, kind, Clean.gradedOpts(s, g));
  if (r.kind && !r.split && !r.same) { out.blended = true; return out; } // two printings that can't be told apart
  const lines = [r.main, r.split && r.alt.length >= 4 ? r.alt : null].filter((x) => x && x.length);
  const cut = minus(today, R.win), cut30 = minus(today, R.age);
  let best = out;
  for (const main of lines) {
    const rec = main.filter((p) => p.t >= cut), last = main[main.length - 1].t;
    const med = Clean.median(main.slice(-10).map((p) => p.p));
    let est = 0, recent = last >= cut30;
    if (bench) { // sales the provider counted in stretches we never fetched
      const share = main.length / pts.length, perDay = main.length / Math.max(1, main.reduce((n, p) => n + (p.n || 1), 0));
      for (const gap of s.ladder?.gaps?.[g] || []) {
        const from = gap.from > cut ? gap.from : cut; if (gap.to <= from) continue;
        const frac = (Date.parse(gap.to) - Date.parse(from)) / Math.max(DAY, Date.parse(gap.to) - Date.parse(gap.from));
        const n = gap.sales * share * perDay * frac; est += n;
        if (n >= 0.5 && gap.to >= cut30) recent = true;
      }
    }
    const days = rec.length + Math.floor(est);
    const cand = { g, liquid: days >= R.days && recent && med >= R.min, days, last, med, est: Math.round(est * 10) / 10 };
    if (cand.liquid && !best.liquid || (cand.liquid === best.liquid && (cand.med || 0) > (best.med || 0))) best = cand;
  }
  return best;
}

export function evaluate(s, grades, today, R, bench = false) {
  const per = grades.map((g) => gradeGate(s, g, today, R, bench));
  const liq = per.filter((x) => x.liquid);
  return { ok: liq.length > 0, liq: liq.map((x) => x.g), depth: liq.length, price: Math.max(0, ...liq.map((x) => x.med || 0)), per };
}
const beats = (a, b) => (a.ok && !b.ok) || (a.ok && b.ok && (a.depth > b.depth || (a.depth === b.depth && a.price >= b.price * 1.25)));
const why = (e) => (e.ok ? `liquid at ${e.liq.map((g) => g.toUpperCase()).join('/')}` : 'no grade liquid at the minimum');

export async function runLadder({ api, wl, today, credits, window, note, maxChecks = 4 }) {
  const cfg = JSON.parse(await readFile(path.join(DATA, 'sets.json'), 'utf8'));
  const R = rulesOf(cfg), FAM = cfg.families || {};
  const lpath = path.join(DATA, 'ladder.json');
  const L = existsSync(lpath) ? JSON.parse(await readFile(lpath, 'utf8')) : { fails: {}, checked: {}, history: [] };
  L.fails ||= {}; L.checked ||= {}; L.history ||= [];
  const grades = wl.grades || ['psa7', 'psa8', 'psa9', 'psa10'];
  const pinned = (c) => (cfg.pins || []).some((p) => p.set === c.set && String(p.number) === String(c.number) && (!p.name || norm(p.name) === norm(c.name)));
  const excluded = (c) => (cfg.exclude || []).some((p) => p.set === c.set && String(p.number) === String(c.number) && (!p.name || norm(p.name) === norm(c.name)));
  const basketOf = (c) => ((FAM[c.family]?.mode || 'perSet') === 'top' ? { id: 'fam:' + c.family, cap: Number(FAM[c.family].cap || 0) } : { id: 'set:' + c.basket, cap: Number(cfg.perSet || 4) });
  const log = (action, c, reason, extra = {}) => { const e = { t: today, action, key: c.key, name: c.name, set: c.set, basket: basketOf(c).id, reason, ...extra }; L.history.push(e); note(`  ladder: ${action} ${c.name} (${c.set}) — ${reason}`); };
  const moves = [];
  const toBench = (c, reason, extra) => { wl.cards = wl.cards.filter((x) => x.key !== c.key); (wl.bench ||= []).push({ ...c, tier: 'bench' }); delete L.fails[c.key]; log('demote', c, reason, extra); moves.push(c.key); };
  const toCards = (c, reason, extra) => { wl.bench = wl.bench.filter((x) => x.key !== c.key); wl.cards.push({ ...c, tier: 'rotate' }); log('promote', c, reason, extra); moves.push(c.key); };

  // 1–2. Tracked cards: judge on their own sales; demote after 7+ days of failing.
  const evals = {};
  for (const c of wl.cards) {
    const s = await loadSeries(c.key); if (s.source === 'demo') continue;
    const e = (evals[c.key] = evaluate(s, grades, today, R, false));
    if (e.ok) { delete L.fails[c.key]; continue; }
    const f = (L.fails[c.key] ||= { since: today });
    f.last = today;
    if (!pinned(c) && ago(today, f.since) >= 7) toBench(c, `${why(e)} for ${ago(today, f.since)} days`);
  }

  // 3. Bench checks with the leftover credits (2 each), least recently checked first.
  const n = Math.max(0, Math.min(maxChecks, Math.floor(credits / 2)));
  const queue = (wl.bench || []).filter((c) => c.tcgPlayerId && !excluded(c)).sort((a, b) => (L.checked[a.key] || '') < (L.checked[b.key] || '') ? -1 : 1).slice(0, n);
  const checked = [];
  for (const c of queue) {
    try {
      const j = await api.get('/cards', { tcgPlayerId: c.tcgPlayerId, includeEbay: true, days: window }, 2);
      const card = asList(j)[0]; if (!card) { L.checked[c.key] = today; continue; }
      const s = await loadSeries(c.key);
      // Uncovered stretch since the last fetch: the rise in the provider's lifetime sale count, per grade.
      s.ladder ||= { cnt: {}, gaps: {} };
      const snapLast = (g) => { const a = s.snap?.[g] || []; return a.length ? a[a.length - 1] : null; };
      const lastT = s.ladder.t || s.backfill?.date || (s.updated || '').slice(0, 10) || null, from = minus(today, window);
      const prevCnt = Object.fromEntries(grades.map((g) => [g, s.ladder.cnt[g] ?? snapLast(g)?.cnt ?? null]));
      mergeCard(s, card, grades, today);
      for (const g of grades) {
        const cnt = num(gradeBlock(card, g)?.salesCount) ?? num(gradeBlock(card, g)?.count), prev = prevCnt[g];
        if (cnt != null && prev != null && lastT && lastT < from && cnt > prev) {
          const seen = (s.grades[g] || []).filter((p) => p.t > lastT).reduce((k, p) => k + (p.n || 1), 0); // sales we now have after the last fetch
          const sales = cnt - prev - seen;
          if (sales > 0) { const old = (s.ladder.gaps[g] || []).filter((x) => x.to >= minus(today, R.win + 30)); s.ladder.gaps[g] = [...old, { from: lastT, to: from, sales }]; }
        }
        if (cnt != null) s.ladder.cnt[g] = cnt;
      }
      s.ladder.t = today;
      await saveSeries(s);
      L.checked[c.key] = today;
      checked.push({ c, e: evaluate(s, grades, today, R, true) });
    } catch (err) {
      if (err instanceof BudgetError) break;
      note(`  ladder: ✗ ${c.key}: ${err.message}`); L.checked[c.key] = today;
    }
  }

  // 4. Promotions: open slot, else replace the weakest beaten card in the basket.
  for (const { c, e } of checked.filter((x) => x.e.ok).sort((a, b) => b.e.depth - a.e.depth || b.e.price - a.e.price)) {
    const bk = basketOf(c), mates = wl.cards.filter((x) => basketOf(x).id === bk.id);
    // Open slots only while the roster's daily cost (every card every 3 days, 2 credits) leaves room for the bench checks.
    const maxTracked = Math.floor(((Number(cfg.safeDailyCredits || 85) - 2 * maxChecks) * 3) / 2) - (wl.extra || []).length;
    if (bk.cap && mates.length < bk.cap && wl.cards.length < maxTracked) { toCards(c, `${why(e)} · open slot in ${bk.id.replace(/^\w+:/, '')}`, { liq: e.liq, price: e.price }); continue; }
    const weak = mates.filter((x) => !pinned(x)).map((x) => ({ x, e: evals[x.key] || { ok: false, depth: 0, price: 0 } }))
      .sort((a, b) => (a.e.ok ? 1 : 0) - (b.e.ok ? 1 : 0) || a.e.depth - b.e.depth || a.e.price - b.e.price)[0];
    if (weak && beats(e, weak.e)) {
      toBench(weak.x, `replaced by ${c.name} (${weak.e.ok ? `${weak.e.depth} liquid grade${weak.e.depth > 1 ? 's' : ''}, $${Math.round(weak.e.price)}` : why(weak.e)})`);
      toCards(c, `${why(e)} · beat ${weak.x.name} in ${bk.id.replace(/^\w+:/, '')}`, { liq: e.liq, price: e.price });
    }
  }
  L.history = L.history.slice(-300);
  L.updated = new Date().toISOString();
  L.bench = (wl.bench || []).length; L.tracked = wl.cards.length;
  await writeFile(lpath, JSON.stringify(L, null, 1) + '\n');
  note(`Ladder: ${checked.length} bench checked (${checked.filter((x) => x.e.ok).length} qualify), ${moves.length} move${moves.length === 1 ? '' : 's'}, ${Object.keys(L.fails).length} tracked failing the gate.`);
  return { checked: checked.length, moves: moves.length, spent: checked.length * 2 };
}
