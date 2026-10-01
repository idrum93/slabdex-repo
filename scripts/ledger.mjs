// Forward signal log (data/ledger.json): the out-of-sample test the backtest can't give.
//
// The backtest looks back over history it has already seen, so with ~200 setups tried, some will look good by
// luck. This log only records setups at the moment they fire, then scores each one once 30 days have passed,
// with the same rules the backtest uses: entry = median of the next real sales (within 14 days), exit = market
// line 30 days after the fire, compared with every other tracked card in that grade over the same dates.
// A scored entry is frozen, so later changes to the code or data can't rewrite the record.
//
// Logged: single setups, the curated combos and the "in 2+ grades" versions — not the ~170 plain pairs, which
// are the main source of multiple-testing noise. Called from brief.mjs after every fetch and discovery.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA } from './lib.mjs';

const req = createRequire(import.meta.url);
const Model = req('../js/model.js'), Edge = req('../js/edge.js'), I = req('../js/indicators.js');
const H = Edge.H, H90 = 90, ENTRY_DAYS = 14;
const feeOf = (price, m) => Model.feeAt(price, m); // PSA Vault consignment fee by sale price, taken off every exit for the "does it pay" check
const FILE = path.join(DATA, 'ledger.json');        // small: running record per setup (what the site loads)
const LOG = path.join(DATA, 'ledger-log.json');     // every logged fire, one compact row each (the evidence)
const idOf = (e) => `${e.g}|${e.key}|${e.rule}|${e.t}`;
const isN = I.isN;
const logged = (r) => !r.id.includes('+'); // singles, curated combos, cross-grade
const DAY = 864e5, addDays = (t, d) => new Date(Date.parse(t) + d * DAY).toISOString().slice(0, 10);

// Same entry / exit rule as the backtest, over h days. Returns null (no fill) / undefined (not yet).
// f = log excess vs the index; a = the card's own log return (for the fee hurdle).
function outcome(m, key, i, h = H) {
  const b = m.by[key], idx = m.index;
  if (!b || i + h >= m.axis.length) return undefined;
  if (!isN(b.close[i + h]) || !isN(idx[i]) || !isN(idx[i + h]) || idx[i] <= 0) return null;
  const got = []; let lastJ = -1;
  for (let j = i + 1; j <= Math.min(i + ENTRY_DAYS, i + h - 1) && got.length < 3; j++) if (isN(b.sales?.[j])) { got.push(b.sales[j]); lastJ = j; }
  let after = false; for (let j = lastJ + 1; j <= i + h && lastJ >= 0; j++) if (isN(b.sales[j])) { after = true; break; }
  if (got.length < 2 || !after) return null;
  got.sort((a, c) => a - c); const k = got.length >> 1;
  const entry = got.length % 2 ? got[k] : Math.sqrt(got[k - 1] * got[k]);
  const a = Math.log(b.close[i + h] / entry);
  return { entry, exit: b.close[i + h], a, f: a - Math.log(idx[i + h] / idx[i]) };
}
// Every other tradable card in the grade over the same window = the peer baseline.
function peers(m, key, i, h = H) {
  const v = [];
  for (const [k, b] of Object.entries(m.by)) {
    if (k === key || b.demo || b.card.mixed || !Model.tradable(m, b, i)) continue; // peers: same price floor and liquidity, same day
    const o = outcome(m, k, i, h); if (o && isN(o.f)) v.push(o.f);
  }
  return v.length >= 5 ? v.reduce((a, c) => a + c, 0) / v.length : null;
}
// One-sided sign test: chance of at least k wins in n if the setup were a coin flip against its peers.
function signP(k, n) { let p = 0, c = 1; for (let i = 0; i <= n; i++) { if (i > 0) c = (c * (n - i + 1)) / i; if (i >= k) p += c; } return p / 2 ** n; }

export async function updateLedger(models, primaryEdge, today = new Date().toISOString().slice(0, 10)) {
  const L = existsSync(FILE) ? JSON.parse(await readFile(FILE, 'utf8')) : { since: today, horizon: H };
  L.entries = existsSync(LOG) ? JSON.parse(await readFile(LOG, 'utf8')).entries : [];
  const labels = Object.fromEntries(Edge.RULES.map((r) => [r.id, r.label]));
  const have = new Set(L.entries.map(idOf));
  const lastOf = {}; for (const e of L.entries) { const k = `${e.g}|${e.key}|${e.rule}`; if (!lastOf[k] || e.t > lastOf[k]) lastOf[k] = e.t; }
  const bt = Object.fromEntries((primaryEdge?.ok ? primaryEdge.results : []).map((r) => [r.id, r.status]));
  const all = Object.values(models);
  let added = 0;
  // 1. Log what fired in the last 7 days (each card / rule at most once per 30-day window, like the backtest).
  for (const m of all) {
    const e = Edge.run(m, { others: all, perms: 0 });
    if (!e.ok) continue;
    for (const r of e.results) {
      if (!logged(r)) continue;
      for (const l of r.live) {
        const t = m.axis[m.axis.length - 1 - l.ago] || null; if (!t) continue;
        const id = idOf({ g: m.grade, key: l.key, rule: r.id, t }), k = `${m.grade}|${l.key}|${r.id}`;
        if (have.has(id) || (lastOf[k] && Date.parse(t) - Date.parse(lastOf[k]) < H * DAY)) continue;
        const b = m.by[l.key], i = m.axis.indexOf(t);
        L.entries.push({ g: m.grade, key: l.key, rule: r.id, t, logged: today, ref: isN(b.close[i]) ? Math.round(b.close[i] * 100) / 100 : null, ...(m.grade === primaryEdge?.grade && bt[r.id] ? { bt: bt[r.id] } : {}), state: 'pending' });
        have.add(id); lastOf[k] = t; added++;
      }
    }
  }
  // 2. Score entries once their 30 and 90 days are up (each horizon frozen once scored). An entry whose slab was
  //    under the minimum price or not liquid on the fire day is excluded (judged from data up to that day only).
  let scored = 0;
  const pc = (v) => +((Math.exp(v) - 1) * 100).toFixed(1);
  for (const x of L.entries) {
    if (x.state === 'excluded') continue;
    const m = models[x.g]; if (!m) continue;
    const i = m.axis.indexOf(x.t), b = m.by[x.key];
    if (i < 0 || !b) { if (x.state === 'pending' && today > addDays(x.t, 120)) { x.state = 'void'; x.why = 'card no longer tracked'; } continue; }
    if (x.state === 'pending' && !Model.tradable(m, b, i)) { x.state = 'excluded'; x.why = 'under the minimum price or not liquid on the fire day'; scored++; continue; }
    for (const [h, st, sfx] of [[H, 'state', ''], [H90, 'state90', '90']]) {
      if ((x[st] || 'pending') !== 'pending') continue;
      const o = outcome(m, x.key, i, h);
      if (o === undefined) { x[st] = 'pending'; continue; }
      if (o === null) { x[st] = 'void'; if (!sfx) x.why = 'no buyable sales after the fire'; scored++; continue; }
      const base = peers(m, x.key, i, h);
      Object.assign(x, { [st]: 'scored', ['scored' + sfx]: today, entry: Math.round(o.entry * 100) / 100, ['exit' + sfx]: Math.round(o.exit * 100) / 100, ['vsMkt' + sfx]: pc(o.f), ['vsPeers' + sfx]: base == null ? null : pc(o.f - base), ['net' + sfx]: pc(o.a + Math.log(1 - feeOf(o.exit, m))) });
      scored++;
    }
  }
  // 3. Running record per setup (all grades together, with the split by grade).
  const by = {}, minP = Math.max(0, ...all.map((m) => m.minPrice || 0));
  L.minPrice = minP; L.fees = 'PSA Vault consignment'; L.feeTiers = Model.RULES.feeTiers; L.horizons = [H, H90];
  const blank = () => ({ n: 0, wins: 0, sum: 0, net: 0, pays: 0, pending: 0, void: 0 });
  for (const x of L.entries) {
    if (x.state === 'excluded' || (minP && x.ref != null && x.ref < minP)) continue; // under the price floor / not liquid: not counted
    const s = (by[x.rule] ||= { rule: x.rule, label: labels[x.rule] || x.rule, h: { [H]: blank(), [H90]: blank() }, grades: {} });
    for (const [h, st, sfx] of [[H, 'state', ''], [H90, 'state90', '90']]) {
      const z = s.h[h], state = x[st] || 'pending';
      if (state === 'pending') { z.pending++; continue; }
      if (state === 'void') { z.void++; continue; }
      const vp = x['vsPeers' + sfx], nt = x['net' + sfx]; if (vp == null) continue;
      z.n++; z.sum += Math.log(1 + vp / 100); if (vp > 0) z.wins++;
      if (nt != null) { z.net += Math.log(1 + nt / 100); if (nt > 0) z.pays++; }
      if (!sfx) s.grades[x.g] = (s.grades[x.g] || 0) + 1;
    }
  }
  // Verdict: beats its peers more often than a coin flip (sign test p < 0.05) AND, on average, still makes money
  // after the selling fee. A setup can be "beats peers, not fees": a real signal that isn't worth a trade.
  const judge = (z) => {
    const mean = z.n ? (Math.exp(z.sum / z.n) - 1) * 100 : null, net = z.n ? (Math.exp(z.net / z.n) - 1) * 100 : null, p = z.n ? signP(z.wins, z.n) : null;
    const verdict = z.n < 10 ? 'collecting' : mean > 0 && p < 0.05 ? (net > 0 ? 'holding up' : 'beats peers, not fees') : mean <= 0 ? 'not holding' : 'mixed';
    return { n: z.n, pending: z.pending, void: z.void, vsPeers: mean == null ? null : +mean.toFixed(1), net: net == null ? null : +net.toFixed(1), pays: z.n ? +(z.pays / z.n).toFixed(2) : null, beat: z.n ? +(z.wins / z.n).toFixed(2) : null, p: p == null ? null : +p.toFixed(3), verdict };
  };
  L.summary = Object.values(by).map((s) => {
    const a = judge(s.h[H]), b = judge(s.h[H90]);
    return { rule: s.rule, label: s.label, ...a, h90: b, grades: s.grades }; // top-level fields = 30D (what older pages read)
  }).sort((a, b) => b.n - a.n || b.h90.n - a.h90.n || b.pending - a.pending);
  L.updated = today; L.horizon = H;
  const pending = L.entries.filter((x) => x.state === 'pending').length, total = L.entries.length;
  L.counts = { total, pending, scored: L.entries.filter((x) => x.state === 'scored').length, scored90: L.entries.filter((x) => x.state90 === 'scored').length, void: L.entries.filter((x) => x.state === 'void').length, excluded: L.entries.filter((x) => x.state === 'excluded').length };
  await writeFile(LOG, '{"entries":[\n' + L.entries.map((x) => JSON.stringify(x)).join(',\n') + '\n]}\n');
  delete L.entries;
  await writeFile(FILE, JSON.stringify(L, null, 1) + '\n');
  return { added, scored, total, pending };
}

export function ledgerMarkdown(L) {
  if (!L?.summary?.length) return '';
  const rows = L.summary.filter((s) => s.n || s.pending || s.h90?.n).slice(0, 25);
  const pp = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
  return ['## Forward record (live, out of sample)', '', `Setups logged when they fire since ${L.since} (slabs at $${L.minPrice || 0}+ that were liquid that day), scored ${L.horizon} and 90 days later against other tracked cards, and after PSA Vault consignment fees (by sale price). Needs 10+ scored before a verdict means anything.`, '',
    '| Setup | 30D scored | Pending | vs peers | After fees | Paid | p | 30D verdict | 90D scored | 90D vs peers | 90D after fees | 90D verdict |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((s) => `| ${s.label} | ${s.n} | ${s.pending} | ${Edge.pct(s.vsPeers, 1)} | ${Edge.pct(s.net, 1)} | ${pp(s.pays)} | ${s.p ?? '—'} | ${s.verdict} | ${s.h90?.n ?? 0} | ${Edge.pct(s.h90?.vsPeers, 1)} | ${Edge.pct(s.h90?.net, 1)} | ${s.h90?.verdict ?? '—'} |`), ''].join('\n');
}
