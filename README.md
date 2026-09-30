# SlabDex

A personal, TradingView-style terminal for PSA-graded Pokémon card prices. Static site + a daily GitHub Action. No server, no paid services.

- **Chart**: price (daily line or weekly candles), SMA20/50, Bollinger bands, sales-pace volume, RS, RSI 14, MACD 12/26/9. Wheel to zoom, drag to pan, double-click to reset.
- **Compare**: pick any card or the **TCG Index** in `VS`. The main pane switches to % mode (both rebased to the first visible bar) and an **RS pane** shows card ÷ benchmark.
- **Signal**: a 0–100 heuristic score per card (trend, momentum + acceleration, MACD, RSI zone, 30-day relative strength vs index, sales-pace expansion). Tags: `EARLY STRENGTH`, `IMPROVING`, `NEUTRAL`, `WEAK`, `EXTENDED` (strong but stretched above SMA50 or RSI > 78). Needs 60 days of history.
- **Watchlist**: sortable, `⇄` sets the compare card, ↑/↓ steps through cards.

## Data source — and why it's this one

eBay has no free sold-listings API for individuals: the old Finding API is gone, Marketplace Insights is partner-only, and since July 2026 sold searches require sign-in, so scraping is out too.

SlabDex uses the **[PokemonPriceTracker](https://www.pokemonpricetracker.com/api-reference) free tier**, which aggregates eBay graded sales per grade:

| Free tier | |
|---|---|
| Credits | 100 / day |
| Rate | 60 calls / min |
| History window | **3 days** |
| Cost per card w/ eBay graded data | 2 credits |

Because free history is only 3 days, the strategy is **snapshot, don't query history**: one call per card per day, appended to `data/prices/<card>.json`. Git is the database; history grows from the day you turn it on.

### Credit budget

- Every card refreshes every 3 days, stalest first (each call asks for 4 days so no sale day is missed).
- WOTC set-basket cards cost 3 credits (graded + RAW history). EX, DP and index-only cards skip RAW: 2 credits.
- Target ≤ 90 credits/day on the 100/day free tier. `discover` and `groups` print the projected daily cost at the end of each run; anything over 90 is flagged ⚠.
- The fetcher reads `X-RateLimit-Daily-Remaining` and stops with a reserve. Nothing ever retries into a daily-limit wall.

## Setup

1. **Get a free key** at pokemonpricetracker.com/api-keys.
2. **Create the repo** and push this folder.
3. **Add the secret**: Settings → Secrets and variables → Actions → `PPT_API_KEY`.
4. **Enable Pages**: Settings → Pages → Deploy from branch → `main` / root.
5. **Verify field names once** (the parser is defensive, but confirm):
   ```sh
   PPT_API_KEY=xxx node scripts/fetch.mjs --probe "Umbreon VMAX 215"
   ```
   Look at `data[0].ebay` — prices come from `smartMarketPrice` → `medianPrice` → `averagePrice`, and volume from `dailyVolume7Day`. If the shape differs, adjust `gradeBlock()` / `pickPrice()` in `scripts/fetch.mjs`.
6. **Run it**: Actions → *Daily price snapshot* → Run workflow. After that it runs daily at 11:17 UTC.

The repo ships with **demo series** (clearly flagged in the UI) so the terminal works on day one. Each card's demo data is replaced automatically the first time a real snapshot lands.

## Eras and how cards are picked (run once on a paid plan, before Oct 17)

`data/sets.json` lists 44 sets in three era families:

| Family | Sets | Rule | Cards |
|---|---|---|---|
| **WOTC** | Base Set → Skyridge + Black Star Promos | per set: top 3 per set | ~48 |
| **EX** | Ruby & Sapphire → Power Keepers | era top: best 18 across the era, ≤ 3 per set, ≤ 2 per character | 18 |
| **DP & Platinum** | Diamond & Pearl → Arceus | era top: best 12 across the era, ≤ 3 per set, ≤ 2 per character | 12 |

WOTC is covered set by set. Later eras flip it: the era's best cards decide which sets appear, so the budget goes to the cards that matter instead of 27 more set baskets. The EX / DP shortlist gives tracked characters (groups.json) first claim before filling with the rest.

Everything ranks by **PSA 8** (then PSA 9 × 0.6, then PSA 10 × 0.25), holo-or-better, with a real graded market (PSA 8 ≥ 8 or PSA 9 ≥ 8 or PSA 10 ≥ 3 lifetime sales) and clean sales: at least 8 clean PSA 8 sale days in the backfilled history (`minSaleDays`), ≤ 35% junk.

**Run order** — Actions → *Discover baskets + backfill*:

1. Tick *sets only* (about 60 credits) to confirm every set name resolves.
2. Full run: families `WOTC,EX,DP`, tick *rescan*, budget 15000. It rescans WOTC with PSA 8 summaries, scans EX and DP, re-picks, backfills 180 days, then builds the character & theme indexes. Roughly 10k credits.
3. Read the summary's budget line (≤ 90/day).

To change baskets later without spending credits, edit `sets.json` (pins, excludes, caps) and run `node scripts/discover.mjs --from-candidates`.

## Using the terminal

- **CARD / VS boxes** — click (or press `/` and `\\`) to open the Era ▸ Set ▸ Card tree. Era, set, character and theme rows *are* their indexes: click the name to chart the index, the arrow to open it. Type to search across everything.
- **Printings** — one row per card. When a card has two printings (1st Ed / Unlimited, holo / reverse) a toggle appears in the toolbar; *Both* overlays them. `*` = split estimated from graded sale prices; RAW is exact.
- **Watchlist** — CARDS (⊞ groups by set; era picks without a set index group under their era), INDEXES (market, era families, eras, sets, character ladder, themes; *by era* sections open on click), MINE (★ starred, saved in your browser), BRIEF (full readout). The metric column header is a dropdown.
- **▲ / ▼ badges** — a real shift in the last 7 days (2+ signals agreeing, or the tag jumping two levels).
- **Chart** — wheel = zoom time; wheel or drag on the price axis = zoom price; drag = pan; drag a pane divider = resize; double-click or ⟲ = reset. Press `?` for all shortcuts.

## Character & theme indexes — the ladder

`data/groups.json` defines characters (Charizard, Lugia, Ho-Oh, …) and themes (Eeveelutions, Dragons, Legendary Birds, Legendary Beasts). `scripts/groups.mjs` builds, for every group:

- **one index per era family** (`Charizard · WOTC`, `Charizard · EX`, …) — rarity first (secret / shining / gold star / LV.X > holo / ex), then PSA 8 price, spread across sets, and each card must pass the clean-sales check (PSA 8 or PSA 9).
- **one all-eras index** when the group spans 2+ eras (`Charizard · all eras`). These form the **character ladder** — the macro hierarchy of characters across eras, shown in INDEXES, the picker and the brief.

Only WOTC may add index-only cards (2 credits, no RAW, never in set / era / all indexes). EX and DP groups reuse their era picks, so they cost nothing extra.

Run **Actions → Build character & theme indexes** after editing groups.json (discovery runs it too). The Signal panel lists each card's set, era, era family, character and theme indexes and which it moves with most.

## Setup backtest — "which signals actually worked?"

`js/edge.js` tests ~60 indicator setups against the tracked history (runs in the browser per grade, and in `brief.mjs` for `brief.md`). Setups: RSI up through 30 / 50, MACD crossing its signal (and below zero), price back above SMA50, SMA20 × SMA50, relative strength turning up, sales-pace surge, oversold dip, the SlabDex score reaching IMPROVING / EARLY STRENGTH — plus every pair firing within 7 days, and 3+ setups within 10 days.

- **Outcome**: buy at the median of the next real sales after the setup fires (not the price that triggered it), measured 30 days later, versus the market.
- **Chance**: each event is compared with random *other* tracked cards over the *same* dates, 1000 times (p-value).
- **Luck from testing many setups**: Benjamini–Hochberg correction (q ≤ 0.10), must beat peers in both halves of the history, across 5+ cards, and beat the typical peer at least half the time.

Only **confirmed** setups get top billing (first tile, ◆ in the card list, a box in the Signal panel, first in BRIEF). Otherwise the BRIEF tab says plainly that nothing has beaten chance yet. It was checked on simulated random prices (no false confirmations) and on planted effects (a +20% effect is usually found, +10% usually isn't yet — the history is still short). With ~180 days, expect "no edge yet" or a few promising setups at first; evidence firms up as history accumulates.

## Sprites and set symbols

- Character and theme indexes use transparent Crystal sprites from [PokeAPI/sprites](https://github.com/PokeAPI/sprites), stored in `img/sprites/` (groups.json: `spriteBase` + `sprite`). They show in the lists, the picker and as the Signal panel image.
- Set indexes use set symbols from pokemontcg.io (`symbolBase` + each set's `code` in sets.json), written into the watchlist by discover. Missing images are simply hidden.

## Local use

```sh
node scripts/seed-demo.mjs          # regenerate demo data (never touches real data)
node scripts/fetch.mjs --dry-run    # see what today's run would spend
python3 -m http.server              # open http://localhost:8000
node scripts/build-preview.mjs      # single-file dist/slabdex.html snapshot
```

## Layout

```
index.html            terminal UI
css/styles.css        Pokédex shell + terminal tokens (dark-first, light supported)
js/chart.js           dependency-free canvas chart engine (panes, crosshair, zoom, % compare)
js/indicators.js      SMA/EMA/BB/RSI/MACD/ROC/volatility
js/edge.js            setup backtest (permutation test vs same-date peers)
js/model.js           model (shared daily axis, chain-linked indexes, ladder), signals, brief
js/clean.js           clean-sales filter (junk, printing split, bands)
js/app.js             UI
scripts/fetch.mjs     budgeted collector (every card every 3 days)
scripts/discover.mjs  set scans, basket picks, backfill
scripts/groups.mjs    character & theme indexes
scripts/brief.mjs     market brief (brief.json / brief.md)
data/sets.json        sets, eras, pick rules
data/groups.json      characters & themes
scripts/seed-demo.mjs demo data
data/watchlist.json   tracked cards (ids cached here)
data/prices/*.json    accumulated history { t, p, n, v7 } per grade
data/status.json      last run log + credits left
```

## Roadmap

- Modern (SWSH / SV) as an era family: add sets with `family` + a `top` rule in sets.json. Budget allows roughly 8–10 more cards at 2 credits.
- Lead-lag between eras once there are 6+ months of overlap.

## Notes

- Prices are aggregated eBay graded sales via a third party and can lag or miss thin markets. Sparse days are forward-filled.
- The TCG Index is equal-weight and chain-linked over the tracked cards, so it reflects your watchlist, not the whole hobby.
- Signals are heuristics for personal research, not financial advice.
