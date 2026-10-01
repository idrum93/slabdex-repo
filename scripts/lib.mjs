// Shared PokemonPriceTracker client + parsers for fetch.mjs and discover.mjs.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const PRICES = path.join(DATA, 'prices');
const API = process.env.PPT_API_BASE || 'https://www.pokemonpricetracker.com/api/v2'; // override only for local testing

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const num = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() && isFinite(+v) ? +v : null);
export const round = (p) => Math.round(p * 100) / 100;
export const asList = (j) => (Array.isArray(j?.data) ? j.data : j?.data ? [j.data] : []);
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export class BudgetError extends Error { constructor() { super('budget'); } }

// Budget-aware client. Stops before the daily reserve, waits out per-minute 429s.
export function client({ key, budget, reserve = 5, pauseMs = 1100, log = console.log }) {
  const st = { spent: 0, dailyRemaining: Infinity };
  async function get(pathname, params, estCost) {
    if (st.spent + estCost > budget || st.dailyRemaining - estCost < reserve) throw new BudgetError();
    const url = new URL(API + pathname);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      const cost = Number(res.headers.get('x-ratelimit-cost') || res.headers.get('x-api-calls-consumed') || estCost);
      const rem = res.headers.get('x-ratelimit-daily-remaining');
      if (rem != null) st.dailyRemaining = Number(rem);
      if (res.status === 429) {
        if (st.dailyRemaining <= reserve) throw new BudgetError();
        const wait = Number(res.headers.get('retry-after') || 30) * 1000;
        log(`429 rate limited, waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        let body = ''; try { body = (await res.text()).slice(0, 200); } catch {}
        throw new Error(`${res.status} ${res.statusText} for ${url.pathname}${url.search} ${body}`);
      }
      st.spent += cost;
      await sleep(pauseMs);
      return res.json();
    }
    throw new Error('rate limited repeatedly, giving up');
  }
  return { get, st };
}

// ---- eBay graded block (defensive: field names vary by API version) ----
export function gradeBlock(card, grade) {
  const e = card?.ebay || {};
  const byGrade = e.salesByGrade || e.grades || e;
  return byGrade[grade] || byGrade[grade.toUpperCase()] || byGrade[grade.replace('psa', 'psa_')] || null;
}
export function pickPrice(g) {
  if (!g) return null;
  const smp = g.smartMarketPrice;
  return num(smp?.price) ?? num(smp?.value) ?? num(smp) ?? num(g.medianPrice) ?? num(g.averagePrice) ?? num(g.avg) ?? num(g.marketPrice7Day);
}
export const salesOf = (g) => num(g?.salesCount) ?? num(g?.count) ?? 0;

// Sale-day history. PokemonPriceTracker puts it at card.ebay.priceHistory[grade] as
// { "YYYY-MM-DD": { average, count, sevenDayAverage, ... } } — one entry per day with sales.
// Older/other shapes (inside the grade block, or arrays) are still accepted.
export function historyPoints(card, grade) {
  const e = card?.ebay || {};
  const h = e.priceHistory?.[grade] ?? gradeBlock(card, grade)?.priceHistory ?? gradeBlock(card, grade)?.history;
  if (!h) return [];
  const out = [];
  const push = (d, v) => {
    const p = num(v?.average) ?? num(v?.averagePrice) ?? num(v?.median) ?? num(v?.medianPrice) ?? num(v?.price) ?? num(v);
    const t = String(d).slice(0, 10);
    if (p != null && p > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t)) out.push({ t, p: round(p), n: num(v?.count) ?? 1 });
  };
  if (Array.isArray(h)) h.forEach((x) => push(x.date ?? x.t ?? x.day, x));
  else Object.entries(h).forEach(([d, v]) => push(d, v));
  return out;
}

// Flag sale days far from the card's typical price (x: 1). For WOTC sets where 1st Edition and
// Unlimited share one record, this drops the rare high-priced 1st Ed prints (and junk/mismatched
// sales) so the line follows the dominant market. Flags are recomputed on every merge.
export function flagOutliers(arr, band = 2.5) {
  const ps = arr.map((x) => x.p).sort((a, b) => a - b);
  if (ps.length < 3) { arr.forEach((x) => delete x.x); return; }
  const m = ps[Math.floor(ps.length / 2)];
  arr.forEach((x) => { if (x.p > m * band || x.p < m / band) x.x = 1; else delete x.x; });
}
export const cleanPts = (arr) => (arr || []).filter((x) => !x.x);
export function medianOf(arr) { const ps = arr.map((x) => x.p).sort((a, b) => a - b); return ps.length ? ps[Math.floor(ps.length / 2)] : null; }

// ---- price files ----
export async function loadSeries(key) {
  const f = path.join(PRICES, `${key}.json`);
  if (!existsSync(f)) return { key, source: 'pokemonpricetracker', updated: null, grades: {} };
  return JSON.parse(await readFile(f, 'utf8'));
}
export async function saveSeries(s) {
  await writeFile(path.join(PRICES, `${s.key}.json`), JSON.stringify(s) + '\n');
}
export function upsert(arr, pt) {
  const i = arr.findIndex((x) => x.t === pt.t);
  if (i >= 0) arr[i] = { ...arr[i], ...pt }; else arr.push(pt);
  arr.sort((a, b) => (a.t < b.t ? -1 : 1));
}

// Merge one API card record into a series.
//  grades[g]: actual sale days {t, p (avg sale price), n (sales that day), x (outlier flag)} — what the chart draws.
//  snap[g]:   the provider's daily market read {t, sm (smart price), conf, med, cnt (lifetime), v7} — context only.
export function mergeCard(s, c, grades, today) {
  if (s.source === 'demo') { s.grades = {}; s.source = 'pokemonpricetracker'; }
  s.snap ||= {};
  let wrote = 0;
  for (const g of grades) {
    const arr = (s.grades[g] ||= []).filter((x) => x.n != null && x.v7 === undefined); // drop legacy snapshot points
    for (const hp of historyPoints(c, g)) { upsert(arr, hp); wrote++; }
    flagOutliers(arr);
    s.grades[g] = arr;
    const blk = gradeBlock(c, g);
    if (blk) {
      const sn = (s.snap[g] ||= []);
      upsert(sn, { t: today, sm: num(blk.smartMarketPrice?.price) ?? null, conf: blk.smartMarketPrice?.confidence ?? null, med: num(blk.medianPrice), cnt: salesOf(blk), v7: num(blk.dailyVolume7Day) });
    }
  }
  // Raw Near Mint price history per printing (TCGplayer). Exact 1st Ed / Unlimited separation.
  const variants = c.priceHistory?.variants;
  if (variants && typeof variants === 'object') {
    s.raw ||= {};
    for (const [printing, conds] of Object.entries(variants)) {
      const h = conds?.['Near Mint']?.history;
      if (!Array.isArray(h)) continue;
      const arr = (s.raw[printing] ||= []);
      for (const x of h) {
        const t = String(x.date || '').slice(0, 10), p = num(x.market);
        if (p != null && p > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t)) upsert(arr, { t, p: round(p), n: num(x.volume) });
      }
    }
  }
  // Today's ungraded price per printing, if the base record carries it (no history, no extra credit).
  // Kept only as a hint of how far apart a card's printings trade; never charted or used in signals.
  const now = {};
  for (const [printing, v] of Object.entries(c.prices?.variants || c.variants || {})) {
    const p = num(v?.['Near Mint']?.price) ?? num(v?.['Near Mint']?.market) ?? num(v?.market) ?? num(v?.price);
    if (p != null && p > 0) now[printing] = round(p);
  }
  if (Object.keys(now).length) s.rawNow = { t: today, p: now };
  s.updated = new Date().toISOString();
  s.tcgPlayerId = String(c.tcgPlayerId ?? s.tcgPlayerId ?? '');
  s.printings = c.printingsAvailable || (c.variants ? Object.keys(c.variants) : s.printings || null);
  s.tcgMarket = num(c.prices?.market) ?? s.tcgMarket ?? null;
  return wrote;
}

// ---- card identity helpers shared by discover.mjs and groups.mjs ----
// The Pokémon on the card: "Blaine's Charizard" → charizard, "Dark Raichu" → raichu, "Tyranitar (H28)" → tyranitar,
// "Rayquaza ex" / "Garchomp LV.X" / "Mewtwo Star" / "Charizard δ" → the base Pokémon.
export const baseName = (n) => String(n).replace(/\s*\(.*?\)\s*/g, ' ').replace(/\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(Dark|Light|Shining)\s+/i, '')
  .replace(/^[A-Z][A-Za-z.]*(\s[A-Z][a-z]*)?'s\s+/, '').replace(/\s+(Gold Star|Star|ex|EX|LV\.?\s?X|δ|Delta Species|G|GL|FB|C|E4|4)$/i, '')
  .replace(/\s+/g, ' ').trim().toLowerCase();
// Rarity first: secret / shining / gold star / crystal / LV.X = 3, holo / ex / promo = 2, anything else 0.
export const rarityTier = (r, name = '') => (/secret|shining|gold ?star|crystal|\bstar\b|lv\.?\s?x/i.test(`${r} ${name}`) ? 3 : /holo|\bex\b|promo/i.test(`${r} ${name}`) ? 2 : 0);
