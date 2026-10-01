#!/usr/bin/env node
// SlabDex discovery + backfill (run once while a paid PokemonPriceTracker plan is active).
//
//  1. Resolve each set in data/sets.json against the provider's set list.
//  2. Pull every card in the set with eBay graded data (bulk fetchAllInSet).
//  3. Keep chase rarities (holos, gold stars, crystals, shinings…) with a real graded market
//     (minimum lifetime PSA sales, grades that agree with each other); shortlist the top 6 per set.
//  4. Backfill up to --days of sale history for the shortlist, then keep the N per set with enough
//     real sale days, ranked by median sale price (+ pins). Runners-up stay on disk as a bench.
//  5. Rewrite data/watchlist.json with the baskets (old one saved as watchlist.previous.json),
//     write data/discovery/{report.md,candidates.json,sample-card.json}.
//
// Usage:
//   PPT_API_KEY=xxx node scripts/discover.mjs              # full run (~3–4k credits for all WOTC)
//   node scripts/discover.mjs --sets-only                  # resolve set names only (~20 credits)
//   node scripts/discover.mjs --days 180 --budget 8000 --per-set 3
//   node scripts/discover.mjs --rescan                     # rescan every set (default: only sets missing from candidates.json)
//   node scripts/discover.mjs --from-candidates            # re-pick from saved candidates + price files, 0 credits

import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA, PRICES, BudgetError, client, asList, num, slug, gradeBlock, pickPrice, salesOf, loadSeries, saveSeries, mergeCard, baseName, rarityTier } from './lib.mjs';
const Clean = createRequire(import.meta.url)('../js/clean.js'); // same cleaning the terminal uses

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const KEY = process.env.PPT_API_KEY;
const BUDGET = Number(opt('--budget', process.env.PPT_BUDGET || 8000));
const DAYS = Number(opt('--days', process.env.PPT_DAYS || 180));
const SETS_ONLY = flag('--sets-only');
const FROM_CANDIDATES = flag('--from-candidates');
const RESCAN = flag('--rescan');
const FAMILIES = (opt('--families', process.env.PPT_FAMILIES || '') || '').split(',').map((f) => f.trim()).filter(Boolean); // limit scanning to these families
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = path.join(DATA, 'discovery');

const log = [];
const note = (m) => { console.log(m); log.push(m); };
const api = client({ key: KEY, budget: BUDGET, reserve: 20, pauseMs: 1200, log: note });

const cfg = JSON.parse(await readFile(path.join(DATA, 'sets.json'), 'utf8'));
const PER_SET = Number(opt('--per-set', cfg.perSet || 3));
const SHORTLIST = Number(cfg.shortlist || 6);
const MIN_DAYS = Number(cfg.minSaleDays || 4);
const MAX_OUT = Number(cfg.maxOutlierShare ?? 0.35); // clean-sales rule: drop cards whose sales are mostly junk
const PRIMARY = cfg.primaryGrade || 'psa8';
const FAM = cfg.families || { WOTC: { mode: 'perSet' } };
const familyOf = (def) => def?.family || String(def?.era || '').split(' ')[0] || 'WOTC';
const ruleOf = (fam) => FAM[fam] || { mode: 'perSet' };
const defOf = (label) => cfg.sets.find((d) => d.label === label) || {};
const groupsCfg = existsSync(path.join(DATA, 'groups.json')) ? JSON.parse(await readFile(path.join(DATA, 'groups.json'), 'utf8')) : { characters: [], themes: [] };
const CHAR_NAMES = [...(groupsCfg.characters || []), ...(groupsCfg.themes || [])].map((g) => ({ label: g.label, names: g.names.map((n) => n.toLowerCase()) }));
// Final era picks reserve one slot per *character* only; themes (Eeveelutions, birds, …) compete on rarity and price with everything else.
const CHARS_ONLY = (groupsCfg.characters || []).map((g) => ({ label: g.label, names: g.names.map((n) => n.toLowerCase()) }));
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
    const pick = list.find((s) => norm(s.name) === want) || (def.exact ? null : list.find((s) => norm(s.name).startsWith(want)) || list.find((s) => norm(s.name).includes(want))) || null;
    if (pick) return { ...pick, _query: name, _alts: list.map((s) => s.name).slice(0, 8) };
  }
  return null;
}

// ---------- 2. whole set with graded data ----------
async function fetchSet(set) {
  const ids = [set.name, set.slug, set.id, set.setId].filter((v) => v != null && v !== ''); // name worked in practice
  const est = Math.max(40, (num(set.cardCount) ?? num(set.totalCards) ?? num(set.printedTotal) ?? 150) * 2);
  for (const id of [...new Set(ids.map(String))]) {
    const j = await api.get('/cards', { set: id, fetchAllInSet: true, includeEbay: true, language: 'english' }, est);
    const cards = asList(j);
    if (cards.length) return { cards, via: id };
  }
  return { cards: [], via: null };
}

// ---------- 3. selection ----------
function summarize(c, def) {
  const g = {};
  for (const gr of GRADES) { const b = gradeBlock(c, gr); g[gr] = { p: pickPrice(b), m: num(b?.medianPrice), n: salesOf(b), v7: num(b?.dailyVolume7Day) }; }
  return {
    tcgPlayerId: String(c.tcgPlayerId ?? ''), name: c.name, number: numOf(c), rarity: c.rarity || '', set: def.label, era: def.era, family: familyOf(def),
    variants: c.printingsAvailable || (c.variants ? Object.keys(c.variants) : null), g,
  };
}
function passes(x, def) {
  const rarityOk = def.allRarities || (CHASE.test(x.rarity) && !NOT_CHASE.test(x.rarity.trim()));
  const liquid = Object.entries(cfg.minSales || { psa9: 8, psa10: 3 }).some(([g, n]) => (x.g[g]?.n ?? 0) >= n); // PSA 8 counts: scarce-at-9 cards still have a market
  const m9 = x.g.psa9?.m ?? x.g.psa9?.p, m10 = x.g.psa10?.m ?? x.g.psa10?.p;
  const gradesAgree = !(m9 && m10 && (x.g.psa9?.n ?? 0) >= 2 && (x.g.psa10?.n ?? 0) >= 2 && m10 < m9 * 0.9); // PSA 10 selling under PSA 9 = mismatched sales
  return rarityOk && liquid && gradesAgree && !!x.tcgPlayerId;
}
// Rank by PSA 8 median (then PSA 9 scaled down, then PSA 10) so the price scale is comparable across cards.
const rankVal = (x) => x.g[PRIMARY]?.m ?? x.g[PRIMARY]?.p ?? ((x.g.psa9?.m ?? x.g.psa9?.p) != null ? (x.g.psa9.m ?? x.g.psa9.p) * 0.6 : (x.g.psa10?.m ?? x.g.psa10?.p) != null ? (x.g.psa10.m ?? x.g.psa10.p) * 0.25 : 0);
const charOf = (x) => CHAR_NAMES.find((c) => c.names.includes(baseName(x.name)))?.label || null;
const isPooled = (x) => { const v = (x.variants || []).join(' '); return /1st/i.test(v) && /unlimited/i.test(v); };

// Stage 1: shortlist per set (pins first, then best-priced passing candidates, deduped).
function shortlist(candidates) {
  const out = [];
  for (const [fam, rule] of Object.entries(FAM)) if (rule.mode === 'top') out.push(...eraShortlist(candidates, fam, rule));
  for (const def of cfg.sets) {
    if (ruleOf(familyOf(def)).mode === 'top') continue;
    const pool = candidates.filter((x) => x.set === def.label);
    const hit = (p, x) => p.set === def.label && String(p.number) === x.number && (!p.name || norm(p.name) === norm(x.name));
    const pinned = pool.filter((x) => (cfg.pins || []).some((p) => hit(p, x)));
    const excluded = (x) => (cfg.exclude || []).some((p) => hit(p, x));
    const rest = pool.filter((x) => x.pass && !pinned.includes(x) && !excluded(x)).sort((a, b) => rankVal(b) - rankVal(a));
    const seen = new Set(), list = [];
    for (const x of [...pinned.map((x) => ({ ...x, pinned: true })), ...rest]) {
      const k = `${norm(x.name)}#${x.number}`; if (seen.has(k)) continue; seen.add(k);
      list.push(x); if (list.length >= Math.max(SHORTLIST, pinned.length)) break;
    }
    out.push(...list);
  }
  return out;
}
// Era-wide shortlist for 'top' families: each tracked character gets first claim on its best cards,
// then the best remaining cards fill in (rarity first, then PSA 8 price), within per-set / per-character caps.
function eraCandidates(candidates, fam) {
  const hit = (p, x) => p.set === x.set && String(p.number) === x.number && (!p.name || norm(p.name) === norm(x.name));
  return candidates.filter((x) => x.family === fam && x.pass && !(cfg.exclude || []).some((p) => hit(p, x)))
    .sort((a, b) => rarityTier(b.rarity, b.name) - rarityTier(a.rarity, a.name) || rankVal(b) - rankVal(a));
}
function takeWithCaps(pool, want, rule, into = []) {
  const perSet = {}, perChar = {}, seen = new Set(into.map(keyOf));
  for (const x of into) { perSet[x.set] = (perSet[x.set] || 0) + 1; const b = baseName(x.name); perChar[b] = (perChar[b] || 0) + 1; }
  for (const x of pool) {
    if (into.length >= want) break;
    const b = baseName(x.name);
    if (seen.has(keyOf(x)) || (perSet[x.set] || 0) >= (rule.maxPerSet ?? 3) || (perChar[b] || 0) >= (rule.maxPerCharacter ?? 2)) continue;
    into.push(x); seen.add(keyOf(x)); perSet[x.set] = (perSet[x.set] || 0) + 1; perChar[b] = (perChar[b] || 0) + 1;
  }
  return into;
}
function eraShortlist(candidates, fam, rule) {
  const pool = eraCandidates(candidates, fam), list = [];
  for (const c of CHAR_NAMES) { // first claim: up to 2 per tracked character (so a reject still leaves a backup)
    const mine = pool.filter((x) => c.names.includes(baseName(x.name)));
    takeWithCaps(mine, list.length + 2, rule, list);
  }
  takeWithCaps(pool, rule.shortlist ?? rule.cap * 2, rule, list);
  return list.map((x) => ({ ...x, eraPick: true }));
}

// Stage 2: after backfill, keep cards with enough real sale days, ranked by median sale price.
function finalPick(short) {
  const chosen = [];
  const okC = (x) => (x.days ?? 0) >= MIN_DAYS && (x.outShare ?? 0) <= MAX_OUT && !x.blended; // a blended line feeds no signal, so it isn't worth its credits
  for (const [fam, rule] of Object.entries(FAM)) {
    if (rule.mode !== 'top') continue;
    const pool = short.filter((x) => x.family === fam && okC(x)).sort((a, b) => rarityTier(b.rarity, b.name) - rarityTier(a.rarity, a.name) || (b.med ?? rankVal(b)) - (a.med ?? rankVal(a)));
    const picked = [];
    for (const c of CHARS_ONLY) takeWithCaps(pool.filter((x) => c.names.includes(baseName(x.name))), Math.min(rule.cap, picked.length + 1), rule, picked); // one per character first
    // then the era's best cards by rarity and price (this is what brings in grails like Rayquaza Star)
    takeWithCaps(pool, rule.cap, rule, picked);
    picked.forEach((x) => chosen.push({ ...x, lead: false }));
  }
  for (const def of cfg.sets) {
    if (ruleOf(familyOf(def)).mode === 'top') continue;
    const pool = short.filter((x) => x.set === def.label);
    const ok = okC;
    const ranked = [...pool].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (ok(b) ? 1 : 0) - (ok(a) ? 1 : 0) || (b.med ?? rankVal(b)) - (a.med ?? rankVal(a)));
    ranked.filter((x) => x.pinned || ok(x)).slice(0, Math.max(PER_SET, pool.filter((x) => x.pinned).length)).forEach((x, i) => chosen.push({ ...x, lead: i === 0 })); // never fill a set with cards that fail the clean-sales rules
  }
  return chosen;
}
const keyOf = (x) => `${slug(x.set)}-${slug(x.name)}-${x.number}`;

function toWatch(x) {
  return {
    key: keyOf(x), name: x.name, set: x.set, number: x.number, era: x.era || defOf(x.set).era, family: x.family || familyOf(defOf(x.set)), basket: slug(x.set),
    rarity: x.rarity, pooled: isPooled(x), query: `${x.name} ${x.set} ${x.number}`,
    tier: 'rotate', // every card every 3 days
    raw: false, // graded only: daily fetches skip RAW history (2 credits)
    tcgPlayerId: x.tcgPlayerId,
  };
}

// ---------- report ----------
function report(sets, candidates, short, chosen, variantNotes) {
  const fm = (v) => (v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US'));
  const L = [`# SlabDex discovery — ${TODAY}`, '', `Credits spent: ${api.st.spent}${isFinite(api.st.dailyRemaining) ? ` · remaining today: ${api.st.dailyRemaining}` : ''} · history window: ${DAYS} days · min sale days: ${MIN_DAYS}`, ''];
  L.push('## Sets', '', '| Set | Resolved as | Cards | Passed rules | Shortlisted |', '|---|---|---|---|---|');
  for (const def of cfg.sets) {
    const st = sets.find((x) => x.def.label === def.label) || {};
    const pool = candidates.filter((x) => x.set === def.label);
    L.push(`| ${def.label} | ${st.res ? `${st.res.name}${st.via ? ` (via \`${st.via}\`)` : ''}` : pool.length ? '(from saved scan)' : '**not found**'} | ${pool.length} | ${pool.filter((x) => x.pass).length} | ${short.filter((x) => x.set === def.label).length} |`);
  }
  const lineOf = (x) => (x.split ? `${x.split.mainLabel} (est.) + ${x.altDays} ${x.split.altLabel}` : x.same ? 'holo/rev · one price level' : x.kind === '1st' ? '1st+Unl blended ✗' : x.kind === 'rev' ? 'holo+rev blended ✗' : 'single');
  L.push('', '## Baskets', '', `| Era | Set | Card | # | Median ${PRIMARY.toUpperCase()} (main line) | Clean sale days | Junk | Line |`, '|---|---|---|---|---|---|---|---|');
  for (const x of chosen) L.push(`| ${x.family || ''} | ${x.set} | ${x.name}${x.pinned ? ' 📌' : ''} | ${x.number} | ${fm(x.med)} | ${x.days ?? 0}${(x.days ?? 0) < MIN_DAYS ? ' ⚠' : ''} | ${Math.round((x.outShare ?? 0) * 100)}% | ${lineOf(x)} |`);
  const bench = short.filter((x) => !chosen.some((c) => keyOf(c) === keyOf(x)));
  if (bench.length) {
    L.push('', '## Bench (backfilled, not tracked daily)', '', '| Set | Card | # | Median PSA 9 | Clean days | Junk | Why not picked |', '|---|---|---|---|---|---|---|');
    for (const x of bench) L.push(`| ${x.set} | ${x.name} | ${x.number} | ${fm(x.med)} | ${x.days ?? 0} | ${Math.round((x.outShare ?? 0) * 100)}% | ${(x.outShare ?? 0) > MAX_OUT ? 'too much junk' : (x.days ?? 0) < MIN_DAYS ? 'too few sales' : x.blended ? 'printings blended (no signal)' : 'ranked lower'} |`);
  }
  L.push('', '## Notes', '', ...variantNotes.map((v) => `- ${v}`), '', '## Log', '', '```', ...log.slice(-150), '```', '');
  return L.join('\n');
}

// ---------- main ----------
async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(PRICES, { recursive: true });
  const candPath = path.join(OUT, 'candidates.json');
  let candidates = existsSync(candPath) ? JSON.parse(await readFile(candPath, 'utf8')) : [];
  const inScope = (def) => !FAMILIES.length || FAMILIES.includes(familyOf(def));
  if (RESCAN) { const drop = new Set(cfg.sets.filter(inScope).map((d) => d.label)); candidates = candidates.filter((x) => !drop.has(x.set)); } // rescan only the chosen families
  for (const x of candidates) x.family ||= familyOf(defOf(x.set));
  const sets = [], variantNotes = [];
  const done = new Set(candidates.map((x) => x.set));
  if (!FROM_CANDIDATES && !KEY) throw new Error('PPT_API_KEY not set');

  // 1–2. scan sets that aren't in the saved scan yet
  if (!FROM_CANDIDATES) {
    const todo = cfg.sets.filter((d) => inScope(d) && !done.has(d.label));
    note(`Discovery ${TODAY}: ${todo.length} sets to scan${FAMILIES.length ? ` (${FAMILIES.join(', ')})` : ''}, ${done.size} from saved scan · select by ${PRIMARY.toUpperCase()} · budget ${BUDGET} · history ${DAYS}d`);
    for (const def of todo) {
      try {
        const res = await resolveSet(def);
        if (!res) { note(`✗ set not found: ${def.label}${def.optional ? ' (optional, skipped)' : ''}`); sets.push({ def, res: null }); continue; }
        note(`✓ set ${def.label} → ${res.name} [${res.id ?? res.setId ?? res.slug ?? '?'}]`);
        if (SETS_ONLY) { sets.push({ def, res }); continue; }
        const { cards, via } = await fetchSet(res);
        note(`  ${cards.length} cards (via ${via ?? '—'}), spent so far ${api.st.spent}`);
        candidates = candidates.filter((x) => x.set !== def.label);
        for (const c of cards) candidates.push(summarize(c, def));
        sets.push({ def, res, via, count: cards.length });
        await writeFile(candPath, JSON.stringify(candidates)); // save progress per set
      } catch (e) {
        if (e instanceof BudgetError) { note(`Budget reached at ${def.label}; stopping set scan (rerun resumes here).`); break; }
        note(`✗ ${def.label}: ${e.message}`); sets.push({ def, res: null });
      }
    }
    if (SETS_ONLY) { await writeFile(path.join(OUT, 'report.md'), report(sets, candidates, [], [], ['(sets only)'])); note('Sets-only run complete.'); return; }
  }
  candidates.forEach((x) => { x.pass = passes(x, cfg.sets.find((d) => d.label === x.set) || {}); });

  // 3. shortlist
  const short = shortlist(candidates);
  note(`Shortlisted ${short.length} cards across ${new Set(short.map((x) => x.set)).size} sets.`);

  // 4. backfill shortlist (fresh series from sale history), then measure real sale days
  for (const x of short) {
    const key = keyOf(x);
    let s = await loadSeries(key);
    const fresh = s.backfill?.v === 3 && (s.backfill?.grades || []).join() === GRADES.join() && (s.backfill?.days ?? 0) >= DAYS; // v3 = all grades + raw by printing; a longer --days refetches
    if (!FROM_CANDIDATES && !fresh) {
      try {
        const j = await api.get('/cards', { tcgPlayerId: x.tcgPlayerId, includeEbay: true, includeHistory: true, days: DAYS }, 3);
        const c = asList(j)[0];
        if (!c) { note(`  ✗ ${key}: empty`); continue; }
        s = { key, source: 'pokemonpricetracker', grades: {}, snap: s.snap || {} };
        mergeCard(s, c, GRADES, TODAY);
        s.backfill = { date: TODAY, days: DAYS, v: 3, grades: GRADES };
        await saveSeries(s);
      } catch (e) {
        if (e instanceof BudgetError) { note('Budget reached during backfill; rerun to finish.'); break; }
        note(`  ✗ ${key}: ${e.message}`); continue;
      }
    }
    const kind = Clean.pooledKind(s.printings || x.variants);
    const r = Clean.classify(s.grades?.[PRIMARY], kind, Clean.gradedOpts(s, PRIMARY)), r10 = Clean.classify(s.grades?.psa10, kind, Clean.gradedOpts(s, 'psa10'));
    const cut = new Date(Date.parse(TODAY) - 90 * 864e5).toISOString().slice(0, 10);
    x.gradeDays = Object.fromEntries(GRADES.map((g) => [g, Clean.classify(s.grades?.[g], kind, Clean.gradedOpts(s, g)).main.filter((p) => p.t >= cut).length])); // clean sale days, last 90D
    const total = (s.grades?.[PRIMARY] || []).length;
    x.days = r.main.length; x.days10 = r10.main.length; x.med = Clean.median(r.main.map((p) => p.p));
    x.outShare = total ? r.out.length / total : 0; x.split = r.split; x.kind = kind; x.altDays = r.alt.length || r.unl?.length || 0;
    x.same = !!r.same; x.blended = !!r.kind && !r.split && !r.same; // pooled printings that couldn't be separated: the site leaves this line out of every signal
    note(`  ${key}: ${PRIMARY} ${x.days} clean days${r.split ? ` (${r.split.mainLabel}; +${r.alt.length} ${r.split.altLabel})` : ''}${r.out.length ? `, ${r.out.length} junk` : ''}, median ${x.med ?? '—'}`);
  }

  // How far back did the provider actually go? (Plan caps show up as a hard common start date.)
  const firsts = [];
  for (const x of short) { const s = await loadSeries(keyOf(x)); for (const a of [...Object.values(s.grades || {}), ...Object.values(s.raw || {})]) if (a?.length) firsts.push(a[0].t); }
  firsts.sort();
  if (firsts.length) { const span = Math.round((Date.parse(TODAY) - Date.parse(firsts[0])) / 864e5); note(`History reach: earliest point ${firsts[0]} (${span} days back; requested ${DAYS})`); variantNotes.push(`History reach: earliest stored point ${firsts[0]}, ${span} days back (requested ${DAYS}).`); }

  // 5. final pick
  const chosen = finalPick(short);
  note(`Chose ${chosen.length} cards across ${new Set(chosen.map((x) => x.set)).size} sets.`);
  // Default grade = the one where the most basket cards have enough recent sales to score (≥ 8 sale days / 90D).
  const gradeStats = GRADES.map((g) => ({ g, scorable: chosen.filter((x) => (x.gradeDays?.[g] ?? 0) >= 8).length, days: chosen.reduce((n, x) => n + (x.gradeDays?.[g] ?? 0), 0) }));
  const top = Math.max(0, ...gradeStats.map((x) => x.scorable));
  // Highest grade that is nearly as deep as the deepest one (≥ 80% as many scoreable cards).
  const pickG = [...gradeStats].reverse().find((x) => top && x.scorable >= top * 0.8);
  const defaultGrade = pickG ? pickG.g : PRIMARY;
  note(`Grade depth (cards scoreable / clean sale days, last 90D): ${gradeStats.map((x) => `${x.g} ${x.scorable}/${x.days}`).join(' · ')} → default ${defaultGrade}`);
  variantNotes.push(`Grade depth over the last 90 days (cards with ≥ 8 clean sale days / total clean sale days): ${gradeStats.map((x) => `${x.g.toUpperCase()} ${x.scorable}/${x.days}`).join(', ')}. Terminal default: ${defaultGrade.toUpperCase()}.`);
  const splitN = chosen.filter((x) => x.split).length, mixedN = chosen.filter((x) => x.kind && !x.split).length;
  variantNotes.push(`${splitN} chosen cards had pooled printings that split cleanly into two price clusters; the larger cluster is the main line and the other is charted separately when it has 4+ sales. Labels (1st Ed / Unl) are estimates from price, not from listings.`);
  variantNotes.push(`${mixedN} chosen cards are pooled but did not split${chosen.filter((x) => x.blended).length ? ` (${chosen.filter((x) => x.blended).length} pinned and blended)` : ''}; holo / reverse ones that trade at one price level are kept, blended ones are skipped because the site leaves them out of every signal.`);
  variantNotes.push(`Clean-sales rule: cards with more than ${Math.round(MAX_OUT * 100)}% junk sales are not picked unless pinned. Excluded in sets.json: ${(cfg.exclude || []).map((e) => `${e.set} #${e.number}`).join(', ') || 'none'}.`);

  // watchlist + cleanup
  const wlPath = path.join(DATA, 'watchlist.json');
  const prevWl = existsSync(wlPath) ? JSON.parse(await readFile(wlPath, 'utf8')) : {};
  if (existsSync(wlPath)) await writeFile(path.join(DATA, 'watchlist.previous.json'), await readFile(wlPath, 'utf8'));
  const cards = chosen.map(toWatch);
  const extraN = (prevWl.extra || []).length, perDay = (cards.reduce((n, c) => n + 2, 0) + extraN * 2) / 3;
  const byFam = {}; for (const c of cards) byFam[c.family] = (byFam[c.family] || 0) + 1;
  note(`Budget after the paid plan: ${cards.length} basket cards (${Object.entries(byFam).map(([f, n]) => `${f} ${n}`).join(', ')}) + ${extraN} index-only ≈ ${perDay.toFixed(0)} credits/day of 100${perDay > 90 ? ' ⚠ over the safe limit (90): lower a family cap in sets.json' : ''}.`);
  variantNotes.push(`Ongoing cost ≈ ${perDay.toFixed(0)} credits/day (every card every 3 days, 2 credits each, graded only).`);
  const bench = short.filter((x) => !cards.some((c) => c.key === keyOf(x))).map((x) => ({ ...toWatch(x), tier: 'bench' }));
  await writeFile(wlPath, JSON.stringify({ _comment: 'Generated by scripts/discover.mjs from data/sets.json. basket = set index group. tier rotate = every 3 days. bench = backfilled runners-up, not fetched.', grades: GRADES, primaryGrade: defaultGrade, selectionGrade: PRIMARY, setSymbols: Object.fromEntries(cfg.sets.filter((d) => d.code && cfg.symbolBase).map((d) => [d.label, `${cfg.symbolBase}${d.code}/symbol.png`])), familyLabels: Object.fromEntries(Object.entries(FAM).map(([f, r]) => [f, r.label || f])), cards, bench, extra: prevWl.extra || [], groups: prevWl.groups || [] }, null, 2) + '\n');
  const keep = new Set([...cards, ...bench, ...(prevWl.extra || [])].map((c) => c.key));
  for (const f of await readdir(PRICES)) {
    const k = f.replace(/\.json$/, '');
    if (keep.has(k)) continue;
    const s = await loadSeries(k);
    if (s.source === 'demo' || !s.backfill?.v) await unlink(path.join(PRICES, f)); // demo + first-pass files with no real history
  }
  await writeFile(path.join(OUT, 'report.md'), report(sets, candidates, short, chosen, variantNotes));
  await writeFile(path.join(DATA, 'status.json'), JSON.stringify({ lastRun: new Date().toISOString(), kind: 'discovery', creditsSpent: api.st.spent, dailyRemaining: isFinite(api.st.dailyRemaining) ? api.st.dailyRemaining : null, updated: chosen.length, log: log.slice(-60) }, null, 2) + '\n');
  note(`Done. ${cards.length} tracked + ${bench.length} bench, ${api.st.spent} credits spent. See data/discovery/report.md`);
}

main().catch((e) => { console.error(e); process.exit(1); });
