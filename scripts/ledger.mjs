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
const H = Edge.H, ENTRY_DAYS = 14;
const FILE = path.join(DATA, 'ledger.json');        // small: running record per setup (what the site loads)
const LOG = path.join(DATA, 'ledger-log.json');     // every logged fire, one compact row each (the evidence)
const idOf = (e) => `${e.g}|${e.key}|${e.rule}|${e.t}`;
const isN = I.isN;
const logged = (r) => !r.id.includes('+'); // singles, curated combos, cross-grade
const DAY = 864e5, addDays = (t, d) => new Date(Date.parse(t) + d * DAY).toISOString().slice(0, 10);

// Same entry / exit rule as the backtest. Returns log excess vs the index, or null (no fill) / undefined (not yet).
function outcome(m, key, i) {
  const b = m.by[key], idx = m.index;
  if (!b || i + H >= m.axis.length) return undefined;
  if (!isN(b.close[i + H]) || !isN(idx[i]) || !isN(idx[i + H]) || idx[i] <= 0) return null;
  const got = []; let lastJ = -1;
  for (let j = i + 1; j <= Math.min(i + ENTRY_DAYS, i + H - 1) && got.length < 3; j++) if (isN(b.sales?.[j])) { got.push(b.sales[j]); lastJ = j; }
  let after = false; for (let j = lastJ + 1; j <= i + H && lastJ >= 0; j++) if (isN(b.sales[j])) { after = true; break; }
  if (got.length < 2 || !after) return null;
  got.sort((a, c) => a - c); const h = got.length >> 1;
  const entry = got.length % 2 ? got[h] : Math.sqrt(got[h - 1] * got[h]);
  return { entry, exit: b.close[i + H], f: Math.log(b.close[i + H] / entry) - Math.log(idx[i + H] / idx[i]) };
}
// Every other card in the grade over the same window = the peer baseline.
function peers(m, key, i) {
  const v = [];
  for (const [k, b] of Object.entries(m.by)) {
    if (k === key || b.demo || b.card.mixed) continue;
    const o = outcome(m, k, i); if (o && isN(o.f)) v.push(o.f);
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
  // 2. Score entries whose 30 days are up (frozen once scored).
  let scored = 0;
  for (const x of L.entries) {
    if (x.state !== 'pending') continue;
    const m = models[x.g]; if (!m) continue;
    const i = m.axis.indexOf(x.t);
    if (i < 0) { if (today > addDays(x.t, H + 30)) x.state = 'void'; continue; }
    const o = outcome(m, x.key, i);
    if (o === undefined) continue;
    if (o === null) { x.state = 'void'; x.why = 'no buyable sales after the fire'; scored++; continue; }
    const base = peers(m, x.key, i);
    Object.assign(x, { state: 'scored', scored: today, entry: Math.round(o.entry * 100) / 100, exit: Math.round(o.exit * 100) / 100, vsMkt: +((Math.exp(o.f) - 1) * 100).toFixed(1), vsPeers: base == null ? null : +((Math.exp(o.f - base) - 1) * 100).toFixed(1) });
    scored++;
  }
  // 3. Running record per setup (all grades together, with the split by grade).
  const by = {};
  for (const x of L.entries) {
    const s = (by[x.rule] ||= { rule: x.rule, label: labels[x.rule] || x.rule, n: 0, pending: 0, void: 0, wins: 0, sum: 0, grades: {} });
    if (x.state === 'pending') { s.pending++; continue; }
    if (x.state === 'void') { s.void++; continue; }
    if (x.vsPeers == null) continue;
    s.n++; s.sum += Math.log(1 + x.vsPeers / 100); if (x.vsPeers > 0) s.wins++;
    s.grades[x.g] = (s.grades[x.g] || 0) + 1;
  }
  L.summary = Object.values(by).map((s) => {
    const mean = s.n ? (Math.exp(s.sum / s.n) - 1) * 100 : null, p = s.n ? signP(s.wins, s.n) : null;
    const verdict = s.n < 10 ? 'collecting' : mean > 0 && p < 0.05 ? 'holding up' : mean <= 0 ? 'not holding' : 'mixed';
    return { rule: s.rule, label: s.label, n: s.n, pending: s.pending, void: s.void, vsPeers: mean == null ? null : +mean.toFixed(1), beat: s.n ? +(s.wins / s.n).toFixed(2) : null, p: p == null ? null : +p.toFixed(3), verdict, grades: s.grades };
  }).sort((a, b) => b.n - a.n || b.pending - a.pending);
  L.updated = today; L.horizon = H;
  const pending = L.entries.filter((x) => x.state === 'pending').length, total = L.entries.length;
  L.counts = { total, pending, scored: L.entries.filter((x) => x.state === 'scored').length, void: L.entries.filter((x) => x.state === 'void').length };
  await writeFile(LOG, '{"entries":[\n' + L.entries.map((x) => JSON.stringify(x)).join(',\n') + '\n]}\n');
  delete L.entries;
  await writeFile(FILE, JSON.stringify(L, null, 1) + '\n');
  return { added, scored, total, pending };
}

export function ledgerMarkdown(L) {
  if (!L?.summary?.length) return '';
  const rows = L.summary.filter((s) => s.n || s.pending).slice(0, 25);
  return ['## Forward record (live, out of sample)', '', `Setups logged when they fire since ${L.since}, scored ${L.horizon} days later against other tracked cards. Needs 10+ scored before it means anything.`, '',
    '| Setup | Scored | Pending | vs peers | Beat peers | p (sign) | Verdict |', '|---|---|---|---|---|---|---|',
    ...rows.map((s) => `| ${s.label} | ${s.n} | ${s.pending} | ${Edge.pct(s.vsPeers, 1)} | ${s.beat == null ? '—' : Math.round(s.beat * 100) + '%'} | ${s.p ?? '—'} | ${s.verdict} |`), ''].join('\n');
}
