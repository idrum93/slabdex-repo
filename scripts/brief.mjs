#!/usr/bin/env node
// Writes data/brief.md (human/Claude-readable) and data/brief.json from the current data,
// using the exact same model the terminal uses. Runs after every fetch and discovery.
//   node scripts/brief.mjs
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA, PRICES } from './lib.mjs';

const Model = createRequire(import.meta.url)('../js/model.js');
const WL = JSON.parse(await readFile(path.join(DATA, 'watchlist.json'), 'utf8'));
const SERIES = {};
for (const c of WL.cards) {
  const f = path.join(PRICES, `${c.key}.json`);
  if (existsSync(f)) SERIES[c.key] = JSON.parse(await readFile(f, 'utf8'));
}
const grades = [...new Set([WL.primaryGrade || 'psa9', 'raw', ...(WL.grades || [])])];
const briefs = [];
for (const g of grades) {
  const m = Model.buildModel(WL, SERIES, g);
  if (!Object.keys(m.by).length) continue;
  briefs.push(Model.brief(m));
}
await writeFile(path.join(DATA, 'brief.json'), JSON.stringify({ generated: new Date().toISOString(), briefs }, null, 2) + '\n');
await writeFile(path.join(DATA, 'brief.md'), Model.briefMarkdown(briefs));
console.log(`brief: ${briefs.map((b) => `${b.gradeLabel} ${b.scoredCards}/${b.cards}`).join(' · ')}`);
