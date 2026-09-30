#!/usr/bin/env node
// Character + theme indexes (data/groups.json) → watchlist.groups and watchlist.extra.
//
// For every group and every era family it builds one index (e.g. "Charizard · WOTC", "Charizard · EX"),
// plus an "all eras" index over the union — the macro character ladder.
//   • WOTC may add index-only cards ("extra": fetched every 3 days without RAW, 2 credits, never in
//     set / era / all indexes). Picks come from the saved set scan: same Pokémon, holo or better,
//     a real graded market (PSA 8 counts), rarity first then PSA 8 price, spread across sets, and a
//     clean-sales check on backfilled history.
//   • Later eras (EX, DP) only use cards already in their era basket, so they add no ongoing cost.
//
//   PPT_API_KEY=xxx node scripts/groups.mjs            # select + backfill missing history (paid plan: 6 months)
//   node scripts/groups.mjs --dry-run                  # show picks from saved data, no API calls

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureSprites } from './sprites.mjs';
import { DATA, BudgetError, client, asList, slug, loadSeries, saveSeries, mergeCard, baseName, rarityTier } from './lib.mjs';
const Clean = createRequire(import.meta.url)('../js/clean.js');

const DRY = process.argv.includes('--dry-run');
const DAYS = Number(process.env.PPT_DAYS || 180);
const TODAY = new Date().toISOString().slice(0, 10);
const cfg = JSON.parse(await readFile(path.join(DATA, 'groups.json'), 'utf8'));
const sets = JSON.parse(await readFile(path.join(DATA, 'sets.json'), 'utf8'));
const cands = JSON.parse(await readFile(path.join(DATA, 'discovery', 'candidates.json'), 'utf8'));
const wlPath = path.join(DATA, 'watchlist.json');
const wl = JSON.parse(await readFile(wlPath, 'utf8'));
const GRADES = wl.grades || ['psa7', 'psa8', 'psa9', 'psa10'];
const log = [];
const note = (m) => { console.log(m); log.push(m); };
const api = DRY ? null : client({ key: process.env.PPT_API_KEY, budget: Number(process.env.PPT_BUDGET || 3000), reserve: 20, pauseMs: 1200, log: note });
if (!DRY && !process.env.PPT_API_KEY) throw new Error('PPT_API_KEY not set');

const MIN_DAYS = Number(sets.minSaleDays || 4); // same clean-sales bar as the set baskets
const FAMS = cfg.families || { WOTC: { addCards: true } };
const spriteOf = (d) => (d.sprite && cfg.spriteBase ? `${cfg.spriteBase}${d.sprite}.png` : null);
const famLabel = (f) => sets.families?.[f]?.label || f;
const defOf = (label) => sets.sets.find((d) => d.label === label) || {};
const familyOf = (setLabel) => defOf(setLabel).family || String(defOf(setLabel).era || '').split(' ')[0];
const liquid = (x) => Object.entries(sets.minSales || { psa9: 8, psa10: 3 }).some(([g, n]) => (x.g[g]?.n ?? 0) >= n);
const agree = (x) => { const m9 = x.g.psa9?.m ?? x.g.psa9?.p, m10 = x.g.psa10?.m ?? x.g.psa10?.p; return !(m9 && m10 && (x.g.psa9?.n ?? 0) >= 2 && (x.g.psa10?.n ?? 0) >= 2 && m10 < m9 * 0.9); };
const val = (x) => x.g.psa8?.m ?? x.g.psa8?.p ?? ((x.g.psa9?.m ?? x.g.psa9?.p ?? 0) * 0.6);
const keyOf = (x) => `${slug(x.set)}-${slug(x.name)}-${x.number}`;
const excluded = (x) => (cfg.exclude || []).some((e) => e.set === x.set && String(e.number) === x.number && (!e.name || baseName(e.name) === baseName(x.name)));
const isPromo = (set) => /promo/i.test(set);

const basketById = new Map(wl.cards.map((c) => [String(c.tcgPlayerId), c]));
const prevExtra = new Map((wl.extra || []).map((c) => [String(c.tcgPlayerId), c]));

// Clean-sales check on backfilled history: clean in PSA 8 or PSA 9 (≥ minSaleDays clean sale days, ≤ 35% junk).
async function ensureAndCheck(x, allowFetch) {
  const inBasket = basketById.get(String(x.tcgPlayerId));
  const key = inBasket?.key || keyOf(x);
  let s = await loadSeries(key);
  if (!(s.backfill?.v >= 3) && !DRY && allowFetch) {
    const c = asList(await api.get('/cards', { tcgPlayerId: x.tcgPlayerId, includeEbay: true, includeHistory: true, days: DAYS }, 3))[0];
    if (c) { s = { key, source: 'pokemonpricetracker', grades: {}, snap: {} }; mergeCard(s, c, GRADES, TODAY); s.backfill = { date: TODAY, days: DAYS, v: 3, grades: GRADES }; await saveSeries(s); }
  }
  const kind = Clean.pooledKind(s.printings || x.variants);
  let best = null, most = { days: 0, junk: 0 };
  for (const g of ['psa8', 'psa9']) {
    const tot = (s.grades?.[g] || []).length; if (!tot) continue;
    const r = Clean.classify(s.grades[g], kind, { prior: Clean.priorOf(s) }), v = { days: r.main.length, junk: r.out.length / tot };
    if (v.days > most.days) most = v;
    if (v.days >= MIN_DAYS && v.junk <= 0.35 && (!best || v.days > best.days)) best = v;
  }
  const known = s.backfill?.v >= 3, pick = best || most;
  return { key, inBasket: !!inBasket, ok: known ? !!best : DRY && allowFetch, days: pick.days, junk: pick.junk };
}

async function build(kind, def, rule, fam) {
  const names = def.names.map((n) => n.toLowerCase());
  const addCards = !!FAMS[fam]?.addCards;
  const pool = cands
    .filter((x) => familyOf(x.set) === fam && names.includes(baseName(x.name)) && rarityTier(x.rarity, x.name) >= 2 && liquid(x) && agree(x) && !excluded(x))
    .filter((x) => addCards || basketById.has(String(x.tcgPlayerId))) // later eras: era-basket cards only
    .sort((a, b) => rarityTier(b.rarity, b.name) - rarityTier(a.rarity, a.name) || val(b) - val(a));
  const seen = new Set(), perSet = {}, perChar = {}, members = [], rejected = [];
  for (const x of pool) {
    if (members.length >= rule.perGroup) break;
    const id = `${baseName(x.name)}#${x.set}#${x.number}`; if (seen.has(id)) continue; seen.add(id);
    const setCap = isPromo(x.set) ? rule.maxPerSetPromo ?? rule.maxPerSet : rule.maxPerSet;
    if ((perSet[x.set] || 0) >= setCap) continue;
    if (rule.maxPerCharacter && (perChar[baseName(x.name)] || 0) >= rule.maxPerCharacter) continue;
    let chk;
    try { chk = await ensureAndCheck(x, addCards); } catch (e) { if (e instanceof BudgetError) throw e; note(`  ✗ ${x.name} (${x.set}): ${e.message}`); continue; }
    if (!chk.ok) { rejected.push(`${x.name} (${x.set}): ${chk.days} clean sale days, ${Math.round(chk.junk * 100)}% junk`); continue; }
    members.push({ x, ...chk });
    perSet[x.set] = (perSet[x.set] || 0) + 1; perChar[baseName(x.name)] = (perChar[baseName(x.name)] || 0) + 1;
  }
  return { members, rejected };
}

const groups = [], extra = new Map(), allMembers = {};
const KINDS = [['char', cfg.characters, cfg.character], ['theme', cfg.themes, cfg.theme]];
try {
  for (const fam of Object.keys(FAMS)) {
    note(`\n== ${famLabel(fam)} ==`);
    for (const [kind, defs, rule] of KINDS) for (const d of defs) {
      const { members, rejected } = await build(kind, d, rule, fam);
      const gid = `${kind}:${slug(d.label)}`;
      (allMembers[gid] ||= { kind, label: d.label, sprite: spriteOf(d), keys: [] }).keys.push(...members.map((m) => m.key));
      const okSize = members.length >= rule.minMembers;
      if (members.length || rejected.length) note(`${okSize ? '✓' : '·'} ${kind === 'char' ? 'Character' : 'Theme'} ${d.label} · ${famLabel(fam)}: ${members.length} card${members.length === 1 ? '' : 's'}${okSize ? '' : ` (below ${rule.minMembers}: no ${famLabel(fam)} index, still counts toward all eras)`}${rejected.length ? ` · passed over: ${rejected.join('; ')}` : ''}`);
      members.forEach((m) => note(`    ${m.inBasket ? 'basket' : 'extra '} ${m.x.name} — ${m.x.set} #${m.x.number} (${m.x.rarity}, ${m.days} clean days)`));
      if (okSize) groups.push({ id: `idx:${kind}:${slug(d.label)}:${slug(fam)}`, kind, label: `${d.label} · ${famLabel(fam)}`, base: d.label, scope: fam, sprite: spriteOf(d), members: members.map((m) => m.key) });
      for (const m of members) if (!m.inBasket) {
        const x = m.x, prev = prevExtra.get(String(x.tcgPlayerId));
        extra.set(m.key, { key: m.key, name: x.name, set: x.set, number: x.number, era: defOf(x.set).era, family: fam, basket: slug(x.set), rarity: x.rarity, query: `${x.name} ${x.set} ${x.number}`, tier: 'group', role: 'group', raw: false, tcgPlayerId: String(x.tcgPlayerId), since: prev?.since || TODAY });
      }
    }
  }
} catch (e) { if (e instanceof BudgetError) note('Budget reached; rerun to finish.'); else throw e; }

// All-eras indexes: the macro ladder. Only worth a separate index when it spans 2+ families or adds members.
const minAll = cfg.allEras?.minMembers ?? 2;
note('\n== All eras ==');
for (const [gid, g] of Object.entries(allMembers)) {
  const keys = [...new Set(g.keys)];
  const fams = new Set(keys.map((k) => familyOf([...wl.cards, ...extra.values()].find((c) => c.key === k)?.set)));
  if (keys.length < minAll || fams.size < 2) { note(`· ${g.label}: ${keys.length} card(s) in ${[...fams].map(famLabel).join(', ') || 'no era'} — ${fams.size < 2 ? 'single era, its era index is its ladder entry' : 'too few for an all-eras index'}`); continue; }
  groups.push({ id: `idx:${g.kind}:${slug(g.label)}:all`, kind: g.kind, label: `${g.label} · all eras`, base: g.label, scope: 'all', sprite: g.sprite, members: keys });
  note(`✓ ${g.label} · all eras: ${keys.length} cards across ${[...fams].map(famLabel).join(', ')}`);
}

const es = cfg.eraSprites || {}, sp = (n) => (n && cfg.spriteBase ? `${cfg.spriteBase}${n}.png` : null);
const eraSprites = { all: sp(es.all), eras: Object.fromEntries(Object.entries(es.eras || {}).map(([k, v]) => [k, sp(v)])), families: Object.fromEntries(Object.entries(es.families || {}).map(([k, v]) => [k, sp(v)])) };
const out = { ...wl, extra: [...extra.values()], groups, eraSprites };
if (!DRY) await ensureSprites([...out.cards, ...out.extra], note); // card sprites (free, from PokeAPI's sprite repo)
const perDay = (wl.cards.reduce((n, c) => n + (c.raw === false ? 2 : 3), 0) + out.extra.length * 2) / 3;
note(`\n${groups.length} indexes (${groups.filter((g) => g.scope === 'all').length} all-eras) · ${out.extra.length} index-only cards · ongoing ≈ ${perDay.toFixed(0)} credits/day of 100${perDay > 90 ? ' ⚠ over the safe limit' : ''}${api ? ` · spent ${api.st.spent} credits` : ''}`);
if (!DRY) {
  await writeFile(wlPath, JSON.stringify(out, null, 2) + '\n');
  await mkdir(path.join(DATA, 'discovery'), { recursive: true });
  await writeFile(path.join(DATA, 'discovery', 'groups-report.md'), ['# SlabDex character & theme indexes', '', '```', ...log, '```', ''].join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, ['# Character & theme indexes', '', '```', ...log, '```', ''].join('\n'), { flag: 'a' });
}
