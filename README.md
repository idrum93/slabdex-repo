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
- **Printings** — one row per card. Pooled 1st Ed / Unl (or holo / reverse) sales are split by price clusters; when the gap is hidden by days that averaged both printings, the split is retried on single-sale days and checked against the RAW 1st Ed ÷ Unl price ratio. Holo / reverse holo records get the same treatment, and RAW names which cluster is which ("Holo" / "Reverse"). Clusters must sell side by side in time (a card that simply doubled isn't split). Single-printing cards with a second, cheaper cluster selling alongside (another card's listings mixed in) have that cluster set aside. When a card has two printings (1st Ed / Unlimited, holo / reverse) a toggle appears in the toolbar; *Both* overlays them. `*` = split estimated from graded sale prices; RAW is exact.
- **Watchlist** — CARDS, INDEX, SETUPS (tested setups firing now), LAG (lagging grades), MINE, BRIEF. CARDS (⊞ groups by set; era picks without a set index group under their era), INDEXES (market, era families, eras, sets, character ladder, themes; *by era* sections open on click), MINE (★ starred, saved in your browser), BRIEF (full readout). The metric column header is a dropdown.
- **▲ / ▼ badges** — a real shift in the last 7 days (2+ signals agreeing, or the tag jumping two levels).
- **Indicators** — ordered by backtest evidence for the current grade (tooltips show the best tested result): Supertrend 10×3 (close-only), SMA 50 / 20, Hull MA 20, RS, VZO (sales pressure, Fisher line ≈ FSVZO), RSI, sales volume, MACD. **GUIDE** (on by default) adds a line under each pane — what it's for, what's favorable, ✓/✗ now — and shades where it held; the price pane is shaded where every enabled trend check agrees. EMA and Bollinger were dropped: EMA duplicated SMA, and bands on sparse forward-filled sales mostly measure gaps between sales.
- **Brief** — BRIEF tab rows: sprite / set symbol, name, why, 30D %, signal score. On RAW, a note explains that EX, DP and index-only cards are graded-only.
- **Line vs dots** — the price line is the market line: the median of the last 3 clean sales, carried forward between sales, so single high or low sales don't whip it around. Dots are each day's average sale price, so they sit above and below the line by design.
- **Chart** — wheel = zoom time; wheel or drag on the price axis = zoom price; drag = pan; drag a pane divider = resize; double-click or ⟲ = reset. Press `?` for all shortcuts.

## Character & theme indexes — the ladder

`data/groups.json` defines characters (Charizard, Lugia, Ho-Oh, …) and themes (Eeveelutions, Dragons, Legendary Birds, Legendary Beasts). `scripts/groups.mjs` builds, for every group:

- **one index per era family** (`Charizard · WOTC`, `Charizard · EX`, …) — rarity first (secret / shining / gold star / LV.X > holo / ex), then PSA 8 price, spread across sets, and each card must pass the clean-sales check (PSA 8 or PSA 9).
- **one all-eras index** when the group spans 2+ eras (`Charizard · all eras`). These form the **character ladder** — the macro hierarchy of characters across eras, shown in INDEXES, the picker and the brief.

Only WOTC may add index-only cards (2 credits, no RAW, never in set / era / all indexes). EX and DP groups reuse their era picks, so they cost nothing extra.

Run **Actions → Build character & theme indexes** after editing groups.json (discovery runs it too). The Signal panel lists each card's set, era, era family, character and theme indexes and which it moves with most.

## Setup backtest — "which signals actually worked?"

`js/edge.js` tests ~60 indicator setups against the tracked history (runs in the browser per grade, and in `brief.mjs` for `brief.md`). Setups: RSI up through 30 / 50, MACD crossing its signal (and below zero), price back above SMA50, SMA20 × SMA50, relative strength turning up, sales-pace surge, oversold dip, Hull MA turning up, Supertrend flipping up, VZO crossing 0, the SlabDex score reaching IMPROVING / EARLY STRENGTH — plus every pair firing within 7 days, 3+ setups within 10 days, cross-grade versions (the same setup firing in another PSA grade of the same card within a week), relative strength against the card's own set, and curated combos (ST↑ + Px>SMA50 + Score≥55; ST↑ while RSI<70; ST↑ with VZO>0; ST↑ while RS>MA; pullback to SMA20 in an uptrend).

- **Outcome**: buy at the median of the next real sales after the setup fires (not the price that triggered it), measured 30 days later, versus the market.
- **Chance**: each event is compared with random *other* tracked cards over the *same* dates, 1000 times (p-value).
- **Luck from testing many setups**: Benjamini–Hochberg correction (q ≤ 0.10), must beat peers in both halves of the history, across 5+ cards, and beat the typical peer at least half the time.

Only **confirmed** setups get top billing (first tile, ◆ in the card list, a box in the Signal panel, first in BRIEF). Otherwise the BRIEF tab says plainly that nothing has beaten chance yet. It was checked on simulated random prices (no false confirmations) and on planted effects (a +20% effect is usually found, +10% usually isn't yet — the history is still short). With ~180 days, expect "no edge yet" or a few promising setups at first; evidence firms up as history accumulates.

## Grade gap

Each card's price as a share of the next grade up (PSA 7→8, 8→9, 9→10), using recent sales in both grades (≤ 45 days old). Compared with the card's own usual share (120-day median of its paired sales). When a card doesn't have 30 paired days yet, a peer yardstick stands in — chosen by testing which predicts best on this data: same-set cards for PSA 8÷9 (~14% typical miss vs ~19% for era/family), era family for PSA 7÷8 (all ~13%), and none for PSA 9÷10 (PSA 10 premiums are card-specific; peers miss by ~45%). Labels say which yardstick was used (usual / set norm / WOTC norm). Measured on this data: WOTC PSA 9 ≈ 16% of PSA 10 (middle half 14–22%), PSA 8 ≈ 50% of PSA 9 (43–62%), PSA 7 ≈ 67% of PSA 8 (63–76%). Shown in the Signal panel, the **Gap** column option (100% = normal, amber below 80%), and a BRIEF section; "cheap vs next grade" is also a backtested setup, and the brief quotes its current result.

## Lagging grades

**Cross-grade data rules** (lag, compressed and grade gap all use them):
- Days with 2+ sales are the day's average; when a card's printings are split, such a day is only kept if it sits clearly inside one printing's own range (within 1.3× of that printing's single-sale median) — an average of a 1st Ed and an Unl sale is set aside, never counted as either.
- Only the same printing is compared: a line that blends two printings (pooled 1st Ed + Unl, or holo + reverse, not separable) is never compared across grades.
- 1st Ed is always labelled the dearer printing (RAW is only used to name holo vs reverse — RAW 1st/Unl prices are sometimes swapped).
- Graded sales far below the card's cheapest RAW Near Mint price (× 0.6 for PSA 8+, × 0.4 for PSA 7) are treated as ungraded / mislabeled listings and dropped.
- If a lower grade prices above a higher one (by > 10%), the card gets a ⚠ in the GRADES block and no lag or compression call.
- A "jump" must rest on ≥ 2 sales in the 30 days; a compression needs ≥ 2 recent sales in the grade below.

Every card is fetched in PSA 7–10 in the same call, so comparing grades costs no extra credits. The Signal panel's **GRADES** block shows each grade's price, 30D move, share of the next grade up and last sale; click a grade to switch to it. A grade is marked ⤴ **lagging** when a neighbouring grade rose ≥ 20% in 30 days (with a sale in the last 14 days) while it moved ≤ 5% and still sells. The **LAG** tab lists every current laggard (sorted by how far the jumping grade outran it; the badge is the grade to look at, and clicking opens that grade). "Grade above led" and "grade below led" are backtested setups (lagUp / lagDown), so if catch-up proves real they reach SETUPS on their own.

**Compressed grades (⇅)** head the LAG tab: a grade whose next grade down sells for ≥ 80% of its price and ≥ 1.4× the usual share (≥ 90% when there's no usual yet) — often a grade that hasn't repriced after an upstream move. Each flagged grade also gets an **implied price**: the reference grade's market price × (or ÷) the usual ratio — what it would sell for if the usual spread came back — with the reference grade's 30-day sale count (⚠ under 2). The LAG tab's UPSIDE column is the distance to it. It is only as good as the reference grade's price. Cases where the lower grade is dearer (> 110%) are treated as suspect listings, not opportunities. Also a backtested setup (squeeze).

## Sprites and set symbols

- Every card shows its Pokémon's sprite (Poké Ball for trainers): `scripts/sprites.mjs` (run by groups.mjs) downloads missing ones from PokeAPI's sprite repo — Crystal #1–251, Emerald #252–386, Platinum #387–493 — using `data/dex.json`, and writes `sprite` into the watchlist. No credits.
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
