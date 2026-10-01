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
const Model = req('../js/model.js'), Edge = req('../js/edge.js'), TPI = req('../js/tpi.js');
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
const led = await updateLedger(models, edge);
// Top prospects: tradable slabs in the gauge buy zone (and the watch zone), per grade.
const prospects = {};
for (const [g, m] of Object.entries(models)) {
  const up = models[Model.NEXT[g]] || null, down = models[Model.PREV[g]] || null, rows = [];
  for (const [k, b] of Object.entries(m.by)) {
    if (b.card.mixed || b.demo || !Model.tradable(m, b)) continue;
    const s = TPI.series(m, k, { up, down }); if (!s || s.last < 0 || s.trend[s.last] == null) continue;
    const i = s.last, q = Model.liquidity(m, b), roc = s.roc();
    rows.push({ key: k, name: b.card.name, set: b.card.set, line: b.card.line || null, price: Math.round(b.close[i]), trend: +s.trend[i].toFixed(2), value: s.value[i] == null ? null : +s.value[i].toFixed(2), roc: roc == null ? null : +roc.toFixed(2), zone: s.zone[i], spread: q.spread == null ? null : +q.spread.toFixed(2), score: TPI.prospect(s.trend[i], s.value[i], roc) - (q.wide ? 0.2 : 0) });
  }
  rows.sort((a, c) => c.score - a.score);
  prospects[g] = { buy: rows.filter((r) => r.zone === 'buy').slice(0, 10), watch: rows.filter((r) => r.zone === 'watch').slice(0, 6), counts: Object.fromEntries(['buy', 'watch', 'late', 'neutral', 'avoid'].map((z) => [z, rows.filter((r) => r.zone === z).length])) };
}
const prospectMd = ['## Top prospects (trend & value gauges)', '', 'Tradable slabs (min price, liquid) with trend gauge ≥ +0.5 and priced fair or cheap, ranked by trend, value and a rising gauge. A lead to research until the forward record backs the zones.', '',
  ...Object.entries(prospects).flatMap(([g, p]) => [`### ${Model.GRADE_LABEL[g]} · buy ${p.counts.buy} · watch ${p.counts.watch} · late ${p.counts.late} · avoid ${p.counts.avoid}`, '', ...(p.buy.length ? p.buy.map((r) => `- **${r.name}** (${r.set}) $${r.price.toLocaleString('en-US')} · trend ${r.trend >= 0 ? '+' : ''}${r.trend} · value ${r.value ?? '—'}${r.roc != null ? ` · Δ7d ${r.roc >= 0 ? '+' : ''}${r.roc}` : ''}${r.spread > 1.6 ? ` · ⚠ spread ${r.spread}×` : ''}`) : ['- none in the buy zone']), ...(p.watch.length ? ['', 'Watch (cheap, trend not up yet): ' + p.watch.map((r) => `${r.name} (${r.set}) value ${r.value}`).join('; ')] : []), ''])].join('\n');
const ledger = JSON.parse(await readFile(path.join(DATA, 'ledger.json'), 'utf8'));
console.log(`ledger: +${led.added} logged, ${led.scored} scored, ${led.pending} pending of ${led.total}`);
await writeFile(path.join(DATA, 'brief.json'), JSON.stringify({ generated: new Date().toISOString(), consensus, briefs, edge: edgeOut, prospects }, null, 2) + '\n');
await writeFile(path.join(DATA, 'brief.md'), Model.briefMarkdown(briefs, consensus) + '\n' + prospectMd + '\n' + Edge.markdown(edge) + '\n' + ledgerMarkdown(ledger));
console.log(Edge.verdict(edge));
console.log(`brief: consensus over ${consensus.gradeLabels.join('/')} · ${briefs.map((b) => `${b.gradeLabel} ${b.scoredCards}/${b.cards}`).join(' · ')}`);
