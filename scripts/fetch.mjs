#!/usr/bin/env node
// SlabDex daily collector — PokemonPriceTracker (free tier: 100 credits/day, 60 calls/min).
//
// Strategy: the free tier only returns ~3 days of history, so we take ONE snapshot per card
// per day and accumulate our own history in data/prices/<key>.json. Git is the database.
// Cost: 2 credits per card (base + eBay graded), every card every 3 days → 135 cards ≈ 90 credits/day
// on the free tier. Graded only: ungraded (RAW) price history is no longer fetched. Long history comes from discover.mjs.
//
// Usage:
//   PPT_API_KEY=xxx node scripts/fetch.mjs              # normal daily run
//   node scripts/fetch.mjs --dry-run                    # show the plan, spend nothing
//   node scripts/fetch.mjs --budget 40                  # cap credits for this run
//   node scripts/fetch.mjs --only base-charizard-4      # one card
//   node scripts/fetch.mjs --probe "Charizard Base Set" # dump raw API JSON (verify field names)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA, PRICES, BudgetError, client, asList, loadSeries, saveSeries, mergeCard, mergeStats, gradeBlock, pickPrice } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const KEY = process.env.PPT_API_KEY;
const BUDGET = Number(opt('--budget', process.env.PPT_BUDGET || 90));
const DRY = flag('--dry-run');
const ONLY = opt('--only', null);
const PROBE = opt('--probe', null);
const TODAY = new Date().toISOString().slice(0, 10);
const STALE_DAYS = 3;
// History window per call. The free tier returns 3 days; while the paid plan lasts, ask for 30 so sales the provider
// posts late (dated days back) are still collected. days doesn't change the credit cost.
const PAID_UNTIL = process.env.PPT_PAID_UNTIL || '2026-10-17';
const WINDOW = Number(opt('--days', process.env.PPT_FETCH_DAYS || (TODAY < PAID_UNTIL ? 30 : 3))); // every card every 3 days; each call asks for the last 4 days so no sale or price day is missed

const log = [];
const note = (m) => { console.log(m); log.push(m); };
const api = client({ key: KEY, budget: BUDGET, log: note });

async function resolveId(card) {
  const j = await api.get('/cards', { search: card.query, limit: 3 }, 3);
  const cands = asList(j);
  const numOf = (c) => String(c.cardNumber ?? c.number ?? '').split('/')[0].replace(/^0+/, '');
  const want = String(card.number).replace(/^0+/, '');
  const setHit = (c) => String(c.setName ?? c.set?.name ?? c.set ?? '').toLowerCase().includes(card.set.toLowerCase());
  const pick = cands.find((c) => numOf(c) === want && setHit(c)) || cands.find((c) => numOf(c) === want) || null;
  if (!pick) { note(`  ✗ could not resolve ${card.key} (got: ${cands.map((c) => `${c.name} ${c.setName} #${c.cardNumber}`).join(' | ') || 'nothing'})`); return null; }
  note(`  ✓ resolved ${card.key} → ${pick.tcgPlayerId} (${pick.name}, ${pick.setName} #${pick.cardNumber})`);
  return String(pick.tcgPlayerId);
}

async function snapshot(card, grades) {
  // Graded only: base + eBay graded data = 2 credits. (RAW price history was +1 and fed no signal.)
  const j = await api.get('/cards', { tcgPlayerId: card.tcgPlayerId, includeEbay: true, days: WINDOW }, 2);
  const c = asList(j)[0];
  if (!c) { note(`  ✗ ${card.key}: empty response`); return false; }
  const s = await loadSeries(card.key);
  const wrote = mergeCard(s, c, grades, TODAY);
  await saveSeries(s);
  note(`  ✓ ${card.key}: ${grades.map((g) => `${g}=${pickPrice(gradeBlock(c, g)) ?? '—'}`).join(' ')}`);
  return wrote > 0;
}

async function main() {
  if (PROBE) {
    if (!KEY) throw new Error('PPT_API_KEY not set');
    console.log(JSON.stringify(await api.get('/cards', { search: PROBE, limit: 1, includeEbay: true, days: 3 }, 2), null, 2));
    return;
  }
  await mkdir(PRICES, { recursive: true });
  const wlPath = path.join(DATA, 'watchlist.json');
  const wl = JSON.parse(await readFile(wlPath, 'utf8'));
  let cards = [...wl.cards, ...(wl.extra || [])]; // set baskets + character/theme-only cards
  if (ONLY) cards = cards.filter((c) => c.key === ONLY);

  // Plan: daily tier first, then rotate tier by staleness (oldest first). Skip anything done today.
  const due = [];
  for (const c of cards) {
    const s = await loadSeries(c.key);
    const lastReal = s.source === 'demo' ? null : s.updated?.slice(0, 10) ?? null;
    const age = lastReal ? (Date.parse(TODAY) - Date.parse(lastReal)) / 864e5 : Infinity;
    if (!ONLY && age < (c.tier === 'daily' ? 1 : STALE_DAYS)) continue;
    due.push({ c, age });
  }
  due.sort((a, b) => b.age - a.age || (a.c.role === 'group' ? 1 : 0) - (b.c.role === 'group' ? 1 : 0)); // stalest first, baskets before index-only
  const est = due.reduce((n, m) => n + 2 + (m.c.tcgPlayerId ? 0 : 3), 0);
  note(`SlabDex fetch ${TODAY}: ${due.length} cards due, est ${est} credits, budget ${BUDGET}`);
  if (DRY) { due.forEach((m) => note(`  · ${m.c.key} [${m.c.tier}]${m.c.tcgPlayerId ? '' : ' (needs id)'}`)); return; }
  if (!KEY) throw new Error('PPT_API_KEY not set (add it as a GitHub Actions secret)');

  let done = 0, skipped = 0, dirtyWl = false;
  for (const { c } of due) {
    try {
      if (!c.tcgPlayerId) {
        c.tcgPlayerId = await resolveId(c);
        if (c.tcgPlayerId) dirtyWl = true; else { skipped++; continue; }
      }
      if (await snapshot(c, wl.grades)) done++;
    } catch (e) {
      if (e instanceof BudgetError) { note(`Budget reached (spent ${api.st.spent}); remaining cards roll to next run.`); break; }
      note(`  ✗ ${c.key}: ${e.message}`); skipped++;
    }
  }
  if (dirtyWl) await writeFile(wlPath, JSON.stringify(wl, null, 2) + '\n');
  const ld = [...mergeStats.lateDays].sort((a, b) => a - b), lm = ld.length ? ld[ld.length >> 1] : null;
  const rem = api.st.dailyRemaining;
  await writeFile(path.join(DATA, 'status.json'), JSON.stringify({ lastRun: new Date().toISOString(), window: WINDOW, late: mergeStats.late, lateMedianDays: lm, revised: mergeStats.revised, creditsSpent: api.st.spent, dailyRemaining: isFinite(rem) ? rem : null, updated: done, skipped, log: log.slice(-60) }, null, 2) + '\n');
  note(`Done: ${done} updated, ${skipped} skipped, ${api.st.spent} credits spent. Window ${WINDOW}d · late-posted sales caught: ${mergeStats.late}${lm != null ? ` (median ${lm}d after the sale, max ${ld[ld.length - 1]}d)` : ''} · days revised with more sales: ${mergeStats.revised}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
