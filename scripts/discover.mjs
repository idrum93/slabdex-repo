#!/usr/bin/env node
// SlabDex discovery + backfill (run once while a paid PokemonPriceTracker plan is active).
//
//  1. Resolve each set in data/sets.json against the provider's set list.
//  2. Pull every card in the set with eBay graded data (bulk fetchAllInSet).
//  3. Keep chase rarities (holos, gold stars, crystals, shinings…) with a real graded market
//     (minimum lifetime PSA sales), rank by primary-grade price, take the top N per set + pins.
//  4. Backfill up to --days of graded history for the chosen cards, one call each.
//  5. Rewrite data/watchlist.json with the baskets (old one saved as watchlist.previous.json),
//     write data/discovery/{report.md,candidates.json,sample-card.json}.
//
// Usage:
//   PPT_API_KEY=xxx node scripts/discover.mjs              # full run (~3–4k credits for all WOTC)
//   node scripts/discover.mjs --sets-only                  # resolve set names only (~20 credits)
//   node scripts/discover.mjs --days 180 --budget 8000 --per-set 3
//   node scripts/discover.mjs --from-candidates            # re-pick baskets from saved candidates.json, 0 credits

import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DATA, PRICES, BudgetError, client, asList, num, slug, gradeBlock, pickPrice, salesOf, historyPoints, loadSeries, saveSeries, mergeCard } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const KEY = process.env.PPT_API_KEY;
const BUDGET = Number(opt('--budget', process.env.PPT_BUDGET || 8000));
const DAYS = Number(opt('--days', process.env.PPT_DAYS || 180));
const SETS_ONLY = flag('--sets-only');
const FROM_CANDIDATES = flag('--from-candidates');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = path.join(DATA, 'discovery');

const log = [];
const note = (m) => { console.log(m); log.push(m); };
const api = client({ key: KEY, budget: BUDGET, reserve: 20, pauseMs: 1200, log: note });

const cfg = JSON.parse(await readFile(path.join(DATA, 'sets.json'), 'utf8'));
const PER_SET = Number(opt('--per-set', cfg.perSet || 3));
const PRIMARY = cfg.primaryGrade || 'psa9';
const GRADES = cfg.grades || ['psa9', 'psa10'];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const numOf = (c) => String(c.cardNumber ?? c.number ?? '').split('/')[0].replace(/^0+/, '') || '0';

const CHASE = /holo|secret|gold ?star|star|crystal|shining|promo|ultra|rare holo/i;
const NOT_CHASE = /^(common|uncommon|rare)$/i;

// ---------- 1. sets ----------
async function resolveSet(def) {
  for (const name of def.names) {
    const j = await api.get('/sets', { search: name, language: 'english', limit: 20 }, 1);
    const list = asList(j).filter((s) => !/japan/i.test(s.language || '') && !/japanese/i.test(s.name || ''));
    const want = norm(name);
    const pick = list.find((s) => norm(s.name) === want) || list.find((s) => norm(s.name).startsWith(want)) || null;
    if (pick) return { ...pick, _query: name, _alts: list.map((s) => s.name).slice(0, 8) };
  }
  return null;
}

// ---------- 2. whole set with graded data ----------
async function fetchSet(set) {
  const ids = [set.id, set.setId, set.slug, set.tcgPlayerId, set.name].filter((v) => v != null && v !== '');
  const est = Math.max(40, (num(set.cardCount) ?? num(set.totalCards) ?? num(set.printedTotal) ?? 150) * 2);
  for (const id of [...new Set(ids.map(String))]) {
    const j = await api.get('/cards', { set: id, fetchAllInSet: true, includeEbay: true, days: 30, language: 'english' }, est);
    const cards = asList(j);
    if (cards.length) return { cards, via: id };
  }
  return { cards: [], via: null };
}

// ---------- 3. selection ----------
function summarize(c, def) {
  const g = {};
  for (const gr of GRADES) { const b = gradeBlock(c, gr); g[gr] = { p: pickPrice(b), n: salesOf(b), v7: num(b?.dailyVolume7Day) }; }
  return {
    tcgPlayerId: String(c.tcgPlayerId ?? ''), name: c.name, number: numOf(c), rarity: c.rarity || '', set: def.label, era: def.era,
    printing: c.printing || c.variant || null, variants: c.variants ? Object.keys(c.variants) : null, g,
  };
}
function passes(x, def) {
  const rarityOk = def.allRarities || (CHASE.test(x.rarity) && !NOT_CHASE.test(x.rarity.trim()));
  const liquid = (x.g.psa9?.n ?? 0) >= (cfg.minSales?.psa9 ?? 8) || (x.g.psa10?.n ?? 0) >= (cfg.minSales?.psa10 ?? 3);
  return rarityOk && liquid && x.tcgPlayerId;
}
const rankVal = (x) => x.g[PRIMARY]?.p ?? (x.g.psa10?.p != null ? x.g.psa10.p * 0.35 : 0);

function pickBaskets(candidates) {
  const chosen = [];
  for (const def of cfg.sets) {
    const pool = candidates.filter((x) => x.set === def.label);
    const pinned = pool.filter((x) => cfg.pins.some((p) => p.set === def.label && String(p.number) === x.number));
    const rest = pool.filter((x) => x.pass && !pinned.includes(x)).sort((a, b) => rankVal(b) - rankVal(a));
    const seen = new Set();
    const basket = [];
    for (const x of [...pinned, ...rest]) {
      const k = `${norm(x.name)}#${x.number}`; if (seen.has(k)) continue; seen.add(k);
      basket.push(x); if (basket.length >= Math.max(PER_SET, pinned.length)) break;
    }
    basket.forEach((x, i) => chosen.push({ ...x, lead: i === 0 }));
  }
  return chosen;
}

function toWatch(x) {
  return {
    key: `${slug(x.set)}-${slug(x.name)}-${x.number}`, name: x.name, set: x.set, number: x.number, era: x.era, basket: slug(x.set),
    rarity: x.rarity, query: `${x.name} ${x.set} ${x.number}`,
    tier: x.lead ? 'daily' : 'rotate', // one card per set daily, the rest every 2 days → fits the free tier
    tcgPlayerId: x.tcgPlayerId,
  };
}

// ---------- 5. report ----------
function report(sets, candidates, chosen, variantNotes) {
  const fm = (v) => (v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US'));
  const L = [`# SlabDex discovery — ${TODAY}`, '', `Credits spent: ${api.st.spent}${isFinite(api.st.dailyRemaining) ? ` · remaining today: ${api.st.dailyRemaining}` : ''} · history window requested: ${DAYS} days`, ''];
  L.push('## Sets', '', '| Set | Resolved as | Cards | Candidates | Passed rules |', '|---|---|---|---|---|');
  for (const s of sets) {
    const pool = candidates.filter((x) => x.set === s.def.label);
    L.push(`| ${s.def.label} | ${s.res ? `${s.res.name} (via \`${s.via ?? '—'}\`)` : '**not found**' + (s.alts?.length ? ` — saw: ${s.alts.join(', ')}` : '')} | ${s.count ?? 0} | ${pool.length} | ${pool.filter((x) => x.pass).length} |`);
  }
  L.push('', '## Baskets', '', '| Set | Card | # | Rarity | PSA 9 | 9 sales | PSA 10 | 10 sales | Refresh | History pts |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const x of chosen) L.push(`| ${x.set} | ${x.name} | ${x.number} | ${x.rarity} | ${fm(x.g.psa9?.p)} | ${x.g.psa9?.n ?? 0} | ${fm(x.g.psa10?.p)} | ${x.g.psa10?.n ?? 0} | ${x.lead ? 'daily' : '2 days'} | ${x.histPts ?? '—'} |`);
  L.push('', '## Printing variants (1st Edition / Shadowless / Unlimited)', '', ...variantNotes.map((v) => `- ${v}`), '');
  L.push('## Log', '', '```', ...log.slice(-120), '```', '');
  return L.join('\n');
}

// ---------- main ----------
async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(PRICES, { recursive: true });
  let candidates = [], sets = [], variantNotes = [];

  if (FROM_CANDIDATES) {
    candidates = JSON.parse(await readFile(path.join(OUT, 'candidates.json'), 'utf8'));
    candidates.forEach((x) => { x.pass = passes(x, cfg.sets.find((d) => d.label === x.set) || {}); });
    sets = cfg.sets.map((def) => ({ def, res: { name: def.label }, count: candidates.filter((x) => x.set === def.label).length }));
    variantNotes.push('Re-picked from saved candidates; no API calls made.');
  } else {
    if (!KEY) throw new Error('PPT_API_KEY not set');
    note(`Discovery ${TODAY}: ${cfg.sets.length} sets, top ${PER_SET}/set by ${PRIMARY}, budget ${BUDGET}, history ${DAYS}d`);
    for (const def of cfg.sets) {
      try {
        const res = await resolveSet(def);
        if (!res) { note(`✗ set not found: ${def.label}${def.optional ? ' (optional, skipped)' : ''}`); sets.push({ def, res: null }); continue; }
        note(`✓ set ${def.label} → ${res.name} [${res.id ?? res.setId ?? res.slug ?? '?'}]`);
        if (SETS_ONLY) { sets.push({ def, res, alts: res._alts }); continue; }
        const { cards, via } = await fetchSet(res);
        note(`  ${cards.length} cards (via ${via ?? '—'}), spent so far ${api.st.spent}`);
        if (cards.length && !existsSync(path.join(OUT, 'sample-set-card.json'))) await writeFile(path.join(OUT, 'sample-set-card.json'), JSON.stringify(cards.find((c) => c.ebay) || cards[0], null, 2));
        // Variant check: same number twice, or printing fields present?
        const nums = cards.map(numOf); const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
        const hasPrinting = cards.some((c) => c.printing || c.variants);
        variantNotes.push(`${def.label}: ${dup.length ? `${new Set(dup).size} card numbers appear more than once (separate records per printing — good)` : 'one record per card number'}${hasPrinting ? '; printing/variant fields present in records' : ''}.`);
        for (const c of cards) { const x = summarize(c, def); x.pass = passes(x, def); candidates.push(x); }
        sets.push({ def, res, via, count: cards.length });
      } catch (e) {
        if (e instanceof BudgetError) { note(`Budget reached at ${def.label}; stopping set scan.`); break; }
        note(`✗ ${def.label}: ${e.message}`); sets.push({ def, res: null });
      }
    }
    if (SETS_ONLY) { await writeFile(path.join(OUT, 'report.md'), report(sets, [], [], ['(sets only)'])); note('Sets-only run complete.'); return; }
    await writeFile(path.join(OUT, 'candidates.json'), JSON.stringify(candidates.map(({ pass, ...x }) => x)));
  }

  const chosen = pickBaskets(candidates);
  note(`Chose ${chosen.length} cards across ${new Set(chosen.map((x) => x.set)).size} sets.`);

  // ---------- 4. backfill ----------
  let sampleSaved = existsSync(path.join(OUT, 'sample-card.json'));
  for (const x of chosen) {
    const key = toWatch(x).key;
    if (FROM_CANDIDATES && !KEY) { x.histPts = null; continue; }
    try {
      const j = await api.get('/cards', { tcgPlayerId: x.tcgPlayerId, includeEbay: true, includeHistory: true, days: DAYS }, 3);
      const c = asList(j)[0];
      if (!c) { note(`  ✗ ${key}: empty`); continue; }
      if (!sampleSaved) { await writeFile(path.join(OUT, 'sample-card.json'), JSON.stringify(c, null, 2)); sampleSaved = true; }
      const s = await loadSeries(key);
      s.key = key;
      mergeCard(s, c, GRADES, TODAY);
      s.backfill = { date: TODAY, days: DAYS };
      await saveSeries(s);
      x.histPts = GRADES.map((g) => historyPoints(gradeBlock(c, g)).length).join(' / ');
      note(`  ✓ ${key}: ${GRADES.map((g) => `${g} ${s.grades[g]?.length ?? 0} pts`).join(', ')}`);
    } catch (e) {
      if (e instanceof BudgetError) { note('Budget reached during backfill; rerun to finish.'); break; }
      note(`  ✗ ${key}: ${e.message}`);
    }
  }

  // ---------- watchlist + cleanup ----------
  const wlPath = path.join(DATA, 'watchlist.json');
  if (existsSync(wlPath)) await writeFile(path.join(DATA, 'watchlist.previous.json'), await readFile(wlPath, 'utf8'));
  const cards = chosen.map(toWatch);
  await writeFile(wlPath, JSON.stringify({ _comment: 'Generated by scripts/discover.mjs from data/sets.json. basket = set index group. tier daily = every run, rotate = every 2 days.', grades: GRADES, primaryGrade: PRIMARY, cards }, null, 2) + '\n');
  const keep = new Set(cards.map((c) => c.key));
  for (const f of await readdir(PRICES)) {
    const k = f.replace(/\.json$/, '');
    if (keep.has(k)) continue;
    const s = await loadSeries(k);
    if (s.source === 'demo') await unlink(path.join(PRICES, f)); // real data from dropped cards is kept
  }
  await writeFile(path.join(OUT, 'report.md'), report(sets, candidates, chosen, variantNotes));
  await writeFile(path.join(DATA, 'status.json'), JSON.stringify({ lastRun: new Date().toISOString(), kind: 'discovery', creditsSpent: api.st.spent, dailyRemaining: isFinite(api.st.dailyRemaining) ? api.st.dailyRemaining : null, updated: chosen.length, log: log.slice(-60) }, null, 2) + '\n');
  note(`Done. ${cards.length} cards in watchlist, ${api.st.spent} credits spent. See data/discovery/report.md`);
}

main().catch((e) => { console.error(e); process.exit(1); });
