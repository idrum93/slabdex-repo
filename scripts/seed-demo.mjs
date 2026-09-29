#!/usr/bin/env node
// Writes clearly-labelled DEMO price series so the UI works before real data accrues.
// Demo files carry "source": "demo" and are wiped automatically the first time
// scripts/fetch.mjs writes a real snapshot for that card. Never overwrites real data.
//   node scripts/seed-demo.mjs [--days 540] [--force]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DAYS = Number(args[args.indexOf('--days') + 1]) || 540;
const FORCE = args.includes('--force');

// Rough starting levels by era so the demo feels plausible. Not real prices.
const BASE = { WOTC: 2500, EX: 1800, XY: 900, SWSH: 700, SV: 450 };

function rng(seed) { // mulberry32
  let a = [...seed].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619), 2166136261) >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

const wl = JSON.parse(await readFile(path.join(ROOT, 'data/watchlist.json'), 'utf8'));
await mkdir(path.join(ROOT, 'data/prices'), { recursive: true });
const end = new Date(); end.setUTCHours(0, 0, 0, 0);
let n = 0;
for (const c of wl.cards) {
  const f = path.join(ROOT, 'data/prices', `${c.key}.json`);
  if (existsSync(f)) {
    const cur = JSON.parse(await readFile(f, 'utf8'));
    if (cur.source !== 'demo' && !FORCE) { console.log(`skip ${c.key} (real data)`); continue; }
  }
  const r = rng(c.key);
  const drift = (r() - 0.35) * 0.0016;          // per-card personality
  const vol = 0.012 + r() * 0.02;
  let p = BASE[c.era] * (0.4 + r() * 1.4);
  let regime = 0, regimeLeft = 0;
  const psa10 = [], psa9 = [];
  const ratio9 = 0.28 + r() * 0.2;
  for (let d = DAYS - 1; d >= 0; d--) {
    if (regimeLeft-- <= 0) { regime = (r() - 0.5) * 0.006; regimeLeft = 20 + Math.floor(r() * 70); }
    p *= Math.exp(drift + regime + vol * gauss(r));
    const t = new Date(end.getTime() - d * 864e5).toISOString().slice(0, 10);
    const heat = Math.max(0, regime * 400);
    const v7 = Math.round((0.3 + r() * 1.5 + heat) * 100) / 100;
    psa10.push({ t, p: Math.round(p * 100) / 100, v7 });
    psa9.push({ t, p: Math.round(p * ratio9 * (1 + 0.02 * gauss(r)) * 100) / 100, v7: Math.round(v7 * 2.4 * 100) / 100 });
  }
  await writeFile(f, JSON.stringify({ key: c.key, source: 'demo', updated: end.toISOString(), grades: { psa10, psa9 } }) + '\n');
  n++;
}
console.log(`Seeded ${n} demo series (${DAYS} days).`);
