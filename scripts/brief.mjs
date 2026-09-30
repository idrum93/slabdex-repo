#!/usr/bin/env node
// Writes data/brief.md (human/Claude-readable) and data/brief.json from the current data,
// using the exact same model the terminal uses. Runs after every fetch and discovery.
//   node scripts/brief.mjs
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA, PRICES } from './lib.mjs';

const req = createRequire(import.meta.url);
const Model = req('../js/model.js'), Edge = req('../js/edge.js');
const WL = JSON.parse(await readFile(path.join(DATA, 'watchlist.json'), 'utf8'));
const SERIES = {};
for (const c of [...WL.cards, ...(WL.extra || [])]) {
  const f = path.join(PRICES, `${c.key}.json`);
  if (existsSync(f)) SERIES[c.key] = JSON.parse(await readFile(f, 'utf8'));
}
const grades = [...new Set([WL.primaryGrade || 'psa8', 'raw', ...(WL.grades || [])])];
const briefs = [], models = {};
for (const g of grades) {
  const m = Model.buildModel(WL, SERIES, g);
  if (!Object.keys(m.by).length) continue;
  models[g] = m;
  briefs.push(Model.brief(m));
}
const consensus = Model.consensus(models);
// Setup backtest on the default grade (same code the terminal runs).
const pg = WL.primaryGrade || 'psa8';
const edge = models[pg] ? Edge.run(models[pg]) : { ok: false, reason: `no ${pg} data` };
const edgeOut = edge.ok ? { ...edge, results: edge.results.map(({ live, ...r }) => r), picks: edge.picks.map((p) => ({ key: p.key, name: p.card.name, set: p.card.set, status: p.status, rules: p.rules })) } : edge;
await writeFile(path.join(DATA, 'brief.json'), JSON.stringify({ generated: new Date().toISOString(), consensus, briefs, edge: edgeOut }, null, 2) + '\n');
await writeFile(path.join(DATA, 'brief.md'), Model.briefMarkdown(briefs, consensus) + '\n' + Edge.markdown(edge));
console.log(Edge.verdict(edge));
console.log(`brief: consensus over ${consensus.gradeLabels.join('/')} · ${briefs.map((b) => `${b.gradeLabel} ${b.scoredCards}/${b.cards}`).join(' · ')}`);
