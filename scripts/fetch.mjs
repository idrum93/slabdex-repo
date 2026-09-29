#!/usr/bin/env node
// SlabDex data collector — PokemonPriceTracker free tier (100 credits/day, 60 calls/min).
//
// Strategy: the free tier only returns ~3 days of history, so instead of asking for
// history we take ONE snapshot per card per day and accumulate our own history in
// data/prices/<key>.json. Git is the database.
//
// Credit math (per the provider's docs): 1 credit/card + 1 for eBay graded data = 2 per card.
// 26 cards ≈ 52 credits/day, leaving headroom for id resolution and new cards.
//
// Usage:
//   PPT_API_KEY=xxx node scripts/fetch.mjs              # normal daily run
//   node scripts/fetch.mjs --dry-run                    # show the plan, spend nothing
//   node scripts/fetch.mjs --budget 40                  # cap credits for this run
//   node scripts/fetch.mjs --only evs-umbreon-vmax-215  # one card
//   node scripts/fetch.mjs --probe "Umbreon VMAX 215"   # dump raw API JSON (verify field names)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const PRICES = path.join(DATA, 'prices');
const API = 'https://www.pokemonpricetracker.com/api/v2';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const KEY = process.env.PPT_API_KEY;
const BUDGET = Number(opt('--budget', process.env.PPT_BUDGET || 90)); // leave ~10 credits reserve
const RESERVE = 5;
const DRY = flag('--dry-run');
const ONLY = opt('--only', null);
const PROBE = opt('--probe', null);
const TODAY = new Date().toISOString().slice(0, 10);
const STALE_DAYS_ROTATE = 3;

let spent = 0;
let dailyRemaining = Infinity;
const log = [];
const note = (m) => { console.log(m); log.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, params, estCost) {
  if (spent + estCost > BUDGET) throw new BudgetError();
  if (dailyRemaining - estCost < RESERVE) throw new BudgetError();
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    const cost = Number(res.headers.get('x-ratelimit-cost') || res.headers.get('x-api-calls-consumed') || estCost);
    const rem = res.headers.get('x-ratelimit-daily-remaining');
    if (rem != null) dailyRemaining = Number(rem);
    if (res.status === 429) {
      // Per-minute limit → wait and retry. Out of daily credits → stop the run.
      if (dailyRemaining <= RESERVE) throw new BudgetError();
      const wait = Number(res.headers.get('retry-after') || 30) * 1000;
      note(`429 rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.pathname}${url.search}`);
    spent += cost;
    await sleep(1100); // stay well under 60 calls/min
    return res.json();
  }
  throw new Error('rate limited 3x, giving up');
}
class BudgetError extends Error { constructor() { super('budget'); } }

const asList = (j) => (Array.isArray(j?.data) ? j.data : j?.data ? [j.data] : []);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() && isFinite(+v) ? +v : null);

// ---- id resolution: search once, cache tcgPlayerId in watchlist.json --------------------
async function resolveId(card) {
  const j = await api('/cards', { search: card.query, limit: 3 }, 3);
  const cands = asList(j);
  const numOf = (c) => String(c.cardNumber ?? c.number ?? '').split('/')[0].replace(/^0+/, '');
  const want = String(card.number).replace(/^0+/, '');
  const setHit = (c) => String(c.setName ?? c.set?.name ?? c.set ?? '').toLowerCase().includes(card.set.toLowerCase());
  const pick = cands.find((c) => numOf(c) === want && setHit(c)) || cands.find((c) => numOf(c) === want) || null;
  if (!pick) {
    note(`  ✗ could not resolve ${card.key} (got: ${cands.map((c) => `${c.name} ${c.setName} #${c.cardNumber}`).join(' | ') || 'nothing'})`);
    return null;
  }
  note(`  ✓ resolved ${card.key} → ${pick.tcgPlayerId} (${pick.name}, ${pick.setName} #${pick.cardNumber})`);
  return String(pick.tcgPlayerId);
}

// ---- normalise the eBay graded block defensively (field names vary by API version) -----
function gradeBlock(card, grade) {
  const e = card.ebay || {};
  const byGrade = e.salesByGrade || e.grades || e;
  return byGrade[grade] || byGrade[grade.toUpperCase()] || byGrade[grade.replace('psa', 'psa_')] || null;
}
function pickPrice(g) {
  if (!g) return null;
  const smp = g.smartMarketPrice;
  return num(smp?.price) ?? num(smp?.value) ?? num(smp) ?? num(g.medianPrice) ?? num(g.averagePrice) ?? num(g.avg) ?? num(g.marketPrice7Day);
}
function historyPoints(g) {
  // Accept {date: price}, {date: {average|median|price}}, or [{date, price}] shapes.
  const h = g?.priceHistory || g?.history;
  if (!h) return [];
  const out = [];
  const push = (d, v) => {
    const p = num(v) ?? num(v?.smartMarketPrice) ?? num(v?.median) ?? num(v?.medianPrice) ?? num(v?.average) ?? num(v?.averagePrice) ?? num(v?.price);
    const t = String(d).slice(0, 10);
    if (p != null && /^\d{4}-\d{2}-\d{2}$/.test(t)) out.push({ t, p: round(p), n: num(v?.count) ?? num(v?.salesCount) ?? null });
  };
  if (Array.isArray(h)) h.forEach((x) => push(x.date ?? x.t ?? x.day, x));
  else Object.entries(h).forEach(([d, v]) => push(d, v));
  return out;
}
const round = (p) => Math.round(p * 100) / 100;

async function loadSeries(key) {
  const f = path.join(PRICES, `${key}.json`);
  if (!existsSync(f)) return { key, source: 'pokemonpricetracker', updated: null, grades: {} };
  return JSON.parse(await readFile(f, 'utf8'));
}
function upsert(arr, pt) {
  const i = arr.findIndex((x) => x.t === pt.t);
  if (i >= 0) arr[i] = { ...arr[i], ...pt }; else arr.push(pt);
  arr.sort((a, b) => (a.t < b.t ? -1 : 1));
}

async function snapshot(card, grades) {
  const j = await api('/cards', { tcgPlayerId: card.tcgPlayerId, includeEbay: true, days: 3 }, 2);
  const c = asList(j)[0];
  if (!c) { note(`  ✗ ${card.key}: empty response`); return false; }
  const s = await loadSeries(card.key);
  if (s.source === 'demo') { s.grades = {}; s.source = 'pokemonpricetracker'; } // first real data replaces the demo series
  let wrote = 0;
  for (const g of grades) {
    const blk = gradeBlock(c, g);
    const arr = (s.grades[g] ||= []);
    for (const hp of historyPoints(blk)) if (!arr.some((x) => x.t === hp.t)) upsert(arr, hp);
    const p = pickPrice(blk);
    if (p == null) continue;
    upsert(arr, {
      t: TODAY,
      p: round(p),
      n: num(blk.salesCount) ?? num(blk.count) ?? null, // lifetime sales count
      v7: num(blk.dailyVolume7Day),                     // avg sales/day over last 7 days
    });
    wrote++;
  }
  s.updated = new Date().toISOString();
  s.tcgPlayerId = card.tcgPlayerId;
  s.tcgMarket = num(c.prices?.market) ?? num(c.marketPrice) ?? s.tcgMarket ?? null; // raw-card price, handy context
  await writeFile(path.join(PRICES, `${card.key}.json`), JSON.stringify(s) + '\n');
  note(`  ✓ ${card.key}: ${grades.map((g) => `${g}=${pickPrice(gradeBlock(c, g)) ?? '—'}`).join(' ')}`);
  return wrote > 0;
}

async function main() {
  if (PROBE) {
    if (!KEY) throw new Error('PPT_API_KEY not set');
    const j = await api('/cards', { search: PROBE, limit: 1, includeEbay: true, days: 3 }, 2);
    console.log(JSON.stringify(j, null, 2));
    return;
  }
  await mkdir(PRICES, { recursive: true });
  const wlPath = path.join(DATA, 'watchlist.json');
  const wl = JSON.parse(await readFile(wlPath, 'utf8'));
  let cards = wl.cards;
  if (ONLY) cards = cards.filter((c) => c.key === ONLY);

  // Plan: daily tier first, then rotate tier by staleness (oldest first). Skip anything done today.
  const meta = [];
  for (const c of cards) {
    const s = await loadSeries(c.key);
    const lastReal = s.source === 'demo' ? null : s.updated?.slice(0, 10) ?? null;
    const age = lastReal ? (Date.parse(TODAY) - Date.parse(lastReal)) / 864e5 : Infinity;
    if (age < 1 && !ONLY) continue;
    if (c.tier === 'rotate' && age < STALE_DAYS_ROTATE && !ONLY) continue;
    meta.push({ c, age });
  }
  meta.sort((a, b) => (a.c.tier === b.c.tier ? b.age - a.age : a.c.tier === 'daily' ? -1 : 1));
  const est = meta.reduce((n, m) => n + 2 + (m.c.tcgPlayerId ? 0 : 3), 0);
  note(`SlabDex fetch ${TODAY}: ${meta.length} cards due, est ${est} credits, budget ${BUDGET}`);
  if (DRY) { meta.forEach((m) => note(`  · ${m.c.key} [${m.c.tier}]${m.c.tcgPlayerId ? '' : ' (needs id)'}`)); return; }
  if (!KEY) throw new Error('PPT_API_KEY not set (add it as a GitHub Actions secret)');

  let done = 0, skipped = 0, dirtyWl = false;
  for (const { c } of meta) {
    try {
      if (!c.tcgPlayerId) {
        c.tcgPlayerId = await resolveId(c);
        if (c.tcgPlayerId) dirtyWl = true; else { skipped++; continue; }
      }
      if (await snapshot(c, wl.grades)) done++;
    } catch (e) {
      if (e instanceof BudgetError) { note(`Budget reached (spent ${spent}); remaining cards roll to next run.`); break; }
      note(`  ✗ ${c.key}: ${e.message}`); skipped++;
    }
  }
  if (dirtyWl) await writeFile(wlPath, JSON.stringify(wl, null, 2) + '\n');
  const status = { lastRun: new Date().toISOString(), creditsSpent: spent, dailyRemaining: isFinite(dailyRemaining) ? dailyRemaining : null, updated: done, skipped, log: log.slice(-60) };
  await writeFile(path.join(DATA, 'status.json'), JSON.stringify(status, null, 2) + '\n');
  note(`Done: ${done} updated, ${skipped} skipped, ${spent} credits spent.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
