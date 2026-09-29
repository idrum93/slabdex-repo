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
export function historyPoints(g) {
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

// Merge one API card record into a series: history points (never overwriting a snapshot) + today's snapshot.
export function mergeCard(s, c, grades, today) {
  if (s.source === 'demo') { s.grades = {}; s.source = 'pokemonpricetracker'; }
  let wrote = 0;
  for (const g of grades) {
    const blk = gradeBlock(c, g);
    const arr = (s.grades[g] ||= []);
    for (const hp of historyPoints(blk)) if (!arr.some((x) => x.t === hp.t)) upsert(arr, hp);
    const p = pickPrice(blk);
    if (p == null) continue;
    upsert(arr, { t: today, p: round(p), n: num(blk.salesCount) ?? num(blk.count) ?? null, v7: num(blk.dailyVolume7Day) });
    wrote++;
  }
  s.updated = new Date().toISOString();
  s.tcgPlayerId = String(c.tcgPlayerId ?? s.tcgPlayerId ?? '');
  s.tcgMarket = num(c.prices?.market) ?? num(c.marketPrice) ?? s.tcgMarket ?? null;
  return wrote;
}
