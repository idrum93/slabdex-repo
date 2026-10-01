#!/usr/bin/env node
// Writes data/brief.md (human/Claude-readable) and data/brief.json from the current data,
// using the exact same model the terminal uses. Runs after every fetch and discovery.
//   node scripts/brief.mjs
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA, PRICES } from './lib.mjs';
import { updateLedger, ledgerMarkdown } from './ledger.mjs';

const req = createRequire(import.meta.url);
const Model = req('../js/model.js'), Edge = req('../js/edge.js');
const WL = JSON.parse(await readFile(path.join(DATA, 'watchlist.json'), 'utf8'));
try { WL.printingNames = JSON.parse(await readFile(path.join(DATA, 'printings.json'), 'utf8')).names; } catch {}
const SERIES = {};
for (const c of [...WL.cards, ...(WL.extra || [])]) {
  const f = path.join(PRICES, `${c.key}.json`);
  if (existsSync(f)) SERIES[c.key] = JSON.parse(await readFile(f, 'utf8'));
}
const grades = [...new Set([WL.primaryGrade || 'psa8', ...(WL.grades || [])])].filter((g) => g !== 'raw'); // graded only
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
const edge = models[pg] ? Edge.run(models[pg], { others: Object.values(models) }) : { ok: false, reason: `no ${pg} data` };
const edgeOut = edge.ok ? { ...edge, results: edge.results.map(({ live, ...r }) => r), picks: edge.picks.map((p) => ({ key: p.key, name: p.card.name, set: p.card.set, status: p.status, rules: p.rules })) } : edge;
await writeFile(path.join(DATA, 'brief.json'), JSON.stringify({ generated: new Date().toISOString(), consensus, briefs, edge: edgeOut }, null, 2) + '\n');
const led = await updateLedger(models, edge);
const ledger = JSON.parse(await readFile(path.join(DATA, 'ledger.json'), 'utf8'));
console.log(`ledger: +${led.added} logged, ${led.scored} scored, ${led.pending} pending of ${led.total}`);
await writeFile(path.join(DATA, 'brief.md'), Model.briefMarkdown(briefs, consensus) + '\n' + Edge.markdown(edge) + '\n' + ledgerMarkdown(ledger));
console.log(Edge.verdict(edge));
console.log(`brief: consensus over ${consensus.gradeLabels.join('/')} · ${briefs.map((b) => `${b.gradeLabel} ${b.scoredCards}/${b.cards}`).join(' · ')}`);
