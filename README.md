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

- After discovery: 17 daily + 34 every-2-days cards ≈ **64 credits/day**.
- First runs also resolve each card's `tcgPlayerId` once (≤3 credits each, then cached in `watchlist.json`). The budget cap (90) means resolution spills over 2 days, which is fine.
- `tier: "daily"` cards snapshot every run; `tier: "rotate"` cards refresh when older than 3 days, oldest first, with leftover credits.
- The fetcher reads `X-RateLimit-Daily-Remaining` and stops with a 5-credit reserve. Nothing ever retries into a daily-limit wall.

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

## WOTC discovery + backfill (run once on a paid plan)

`data/sets.json` lists the sets in scope (all WOTC-era sets from Base Set through Skyridge, plus Black Star Promos). With a paid key in `PPT_API_KEY`, run **Actions → Discover WOTC baskets + backfill**:

1. Optional: tick *sets only* first (about 20 credits) to confirm every set name resolves.
2. Full run: pulls every card in each set with eBay graded data, keeps chase rarities with a real graded market (min lifetime sales: PSA 9 ≥ 8 or PSA 10 ≥ 3), takes the **top 3 per set by PSA 9 price**, then backfills up to 180 days of history for those cards. Roughly 3–4k credits for all 17 sets.
3. It rewrites `data/watchlist.json` (old one kept as `watchlist.previous.json`) and writes `data/discovery/report.md` (also shown on the run's summary page), `candidates.json` and raw `sample-card.json` for checking field names.

Each set's top card refreshes daily and the other two every 2 days, about 64 credits/day, so the free tier maintains it after the paid plan ends. To change baskets later without spending credits, edit `sets.json` (pins, per-set count, sales minimums) and run `node scripts/discover.mjs --from-candidates`.

## Local use

```sh
node scripts/seed-demo.mjs          # regenerate demo data (never touches real data)
node scripts/fetch.mjs --dry-run    # see what today's run would spend
python3 -m http.server              # open http://localhost:8000
node scripts/build-preview.mjs      # single-file dist/slabdex.html snapshot
```

## Adding cards

Add an entry to `data/watchlist.json` with a unique `key`, `name`, `set`, `number`, `era`, a search `query`, and `"tcgPlayerId": null`. Stick to cards with real graded markets (holos, alt arts, SIRs) — base commons return empty eBay data and waste credits. Each daily card costs 2 credits/day.

## Layout

```
index.html            terminal UI
css/styles.css        Pokédex shell + terminal tokens (dark-first, light supported)
js/chart.js           dependency-free canvas chart engine (panes, crosshair, zoom, % compare)
js/indicators.js      SMA/EMA/BB/RSI/MACD/ROC/volatility
js/app.js             model (shared daily axis, forward-fill, chain-linked index), signals, UI
scripts/fetch.mjs     budgeted daily collector
scripts/seed-demo.mjs demo data
data/watchlist.json   tracked cards (ids cached here)
data/prices/*.json    accumulated history { t, p, n, v7 } per grade
data/status.json      last run log + credits left
```

## Roadmap (not built yet)

- Era and set indexes (every card already carries `era` and `set`, so this is a grouping change in `buildModel`).
- Leaderboard view by short/medium/long window.
- Optional backfill: one month of the paid API plan returns 6 months of history; `fetch.mjs` already merges any history points it receives.

## Notes

- Prices are aggregated eBay graded sales via a third party and can lag or miss thin markets. Sparse days are forward-filled.
- The TCG Index is equal-weight and chain-linked over the tracked cards, so it reflects your watchlist, not the whole hobby.
- Signals are heuristics for personal research, not financial advice.
