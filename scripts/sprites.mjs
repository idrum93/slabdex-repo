// Card sprites: every tracked card gets its Pokémon's sprite (img/sprites/<name>.png), trainers get a Poké Ball.
// Sprites come from github.com/PokeAPI/sprites — Crystal for #1–251, Emerald for #252–386, Platinum for #387–493 —
// and are downloaded once into the repo when a new Pokémon shows up. No API credits involved.
//   node scripts/sprites.mjs            # fill in missing sprites + write card.sprite into watchlist.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, baseName } from './lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'img', 'sprites');
const RAW = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/';
const src = (id) => `${RAW}pokemon/versions/${id <= 251 ? 'generation-ii/crystal/transparent' : id <= 386 ? 'generation-iii/emerald' : 'generation-iv/platinum'}/${id}.png`;

export async function ensureSprites(cards, log = console.log) {
  const dex = JSON.parse(await readFile(path.join(DATA, 'dex.json'), 'utf8'));
  await mkdir(DIR, { recursive: true });
  const nameOf = (card) => { // "Surfing Pikachu" → pikachu, "Rocket's Mewtwo" → mewtwo
    const b = baseName(card.name).replace(/\s+/g, '-');
    if (dex[b]) return b;
    const w = b.split('-').reverse().find((x) => dex[x]);
    return w || null;
  };
  let got = 0;
  for (const c of cards) {
    const n = nameOf(c), file = n ? `${n}.png` : 'poke-ball.png';
    if (!existsSync(path.join(DIR, file))) {
      try {
        const r = await fetch(n ? src(dex[n]) : `${RAW}items/poke-ball.png`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await writeFile(path.join(DIR, file), Buffer.from(await r.arrayBuffer())); got++;
      } catch (e) { log(`  sprite ${file}: ${e.message}`); }
    }
    if (existsSync(path.join(DIR, file))) c.sprite = `img/sprites/${file}`; else delete c.sprite;
  }
  if (got) log(`Downloaded ${got} new sprite(s).`);
  return cards;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const p = path.join(DATA, 'watchlist.json');
  const wl = JSON.parse(await readFile(p, 'utf8'));
  await ensureSprites([...wl.cards, ...(wl.extra || [])]);
  await writeFile(p, JSON.stringify(wl, null, 2) + '\n');
  console.log(`sprites: ${[...wl.cards, ...(wl.extra || [])].filter((c) => c.sprite).length} cards have one`);
}
