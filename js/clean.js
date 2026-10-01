// Sale cleaning shared by the terminal (browser) and scripts (Node).
//
// Some records pool two printings' graded sales (WOTC 1st Edition + Unlimited, or holo + reverse holo).
// For each card and grade we:
//   1. drop junk (more than 8× from the median — mismatched listings, lots, typos),
//   2. if the record is pooled, try to split sales into two price clusters (Otsu on log price);
//      a split is accepted only when the clusters are clearly separate (centres ≥ 2.2× apart,
//      a real gap between them, ≥ 3 sales each),
//      if that fails, retry on single-sale days only (multi-sale days average both printings), checked
//      against the split ratio the card shows in its other grades; ambiguous multi-sale days are set aside.
//      Only graded sales are used — RAW prices never enter graded evaluation,
//   3. keep the larger cluster as the card's main line and the other as an "alt" line,
//   4. inside each line, drop sales more than 2.5× from that line's median.
// Every sale ends up as exactly one of: main, alt, out.
(function (root) {
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

  // Pooled = the record really has two printings. ("Reverse Holofoil" alone is one printing, not two.)
  function pooledKind(printings) {
    const p = printings || [], v = p.join(' ');
    if (/1st/i.test(v) && /unlimited/i.test(v)) return '1st';
    if (p.some((x) => /reverse/i.test(x)) && p.some((x) => !/reverse/i.test(x) && /holo|normal/i.test(x))) return 'rev';
    if (p.some((x) => /^normal$/i.test(x.trim())) && p.some((x) => /holo/i.test(x))) return 'holoN'; // holo + non-holo: keep the holo only
    return null;
  }

  // Two clusters only count as printings / foreign listings if they sell side by side in time —
  // a card that simply doubled over the months also looks like two price clusters, but one after the other.
  function interleaved(lo, hi) {
    const [small, big] = lo.length <= hi.length ? [lo, hi] : [hi, lo];
    const bt = big.map((x) => x.t).sort(), a = bt[Math.floor(bt.length * 0.1)], z = bt[Math.ceil(bt.length * 0.9) - 1];
    const inside = small.filter((x) => x.t >= a && x.t <= z).length / small.length;
    const st = small.map((x) => x.t).sort(), mid = st[Math.floor(st.length / 2)];
    return inside >= 0.5 && bt[0] < mid && bt[bt.length - 1] > mid;
  }
  const LABELS = { '1st': { low: 'Unl', high: '1st Ed' }, rev: { low: 'lower tier', high: 'upper tier' } };

  function band(pts, k) {
    const m = median(pts.map((x) => x.p));
    const keep = [], out = [];
    for (const x of pts) (pts.length >= 3 && (x.p > m * k || x.p < m / k) ? out : keep).push(x);
    return { keep, out };
  }

  // Two-cluster split of log prices (Otsu): best cut, ratio of cluster centres, gap at the cut, threshold.
  function otsu(pts) {
    const s = [...pts].sort((a, b) => a.p - b.p), L = s.map((x) => Math.log(x.p));
    let best = null;
    for (let k = 3; k <= s.length - 3; k++) {
      const lo = L.slice(0, k), hi = L.slice(k);
      const ml = lo.reduce((a, b) => a + b, 0) / lo.length, mh = hi.reduce((a, b) => a + b, 0) / hi.length;
      const sse = lo.reduce((a, v) => a + (v - ml) ** 2, 0) + hi.reduce((a, v) => a + (v - mh) ** 2, 0);
      if (!best || sse < best.sse) best = { k, ml, mh, sse };
    }
    if (!best) return null;
    return { lo: s.slice(0, best.k), hi: s.slice(best.k), ratio: Math.exp(best.mh - best.ml), gap: s[best.k].p / s[best.k - 1].p, T: Math.sqrt(s[best.k].p * s[best.k - 1].p) };
  }

  function classify(points, kind, opts = {}) {
    const res = { main: [], alt: [], out: [], mixed: [], foreign: [], split: null, mainTier: null, kind, same: false };
    // Floor: a graded sale far below the card's cheapest RAW Near Mint price is almost always an ungraded or
    // mislabeled listing, not a slab. Those go straight to junk.
    const all = (points || []).filter((x) => x && x.p > 0 && !(opts.floor && x.p < opts.floor ? res.out.push(x) : false)); // floor comes from the grade below (graded data only)
    if (!all.length) return res;
    if (kind === 'holoN' && all.length < 6) { kind = null; res.kind = null; }
    const m = median(all.map((x) => x.p));
    const rest = [];
    for (const x of all) (all.length >= 3 && (x.p > m * 8 || x.p < m / 8) ? res.out : rest).push(x);

    let main = rest, alt = [];
    const take = (lo, hi, ratio) => {
      const highMain = hi.length > lo.length, lab = LABELS[kind]; // 1st Ed is always the dearer printing; holo vs reverse can't be told apart by price, so they are named by tier
      main = highMain ? hi : lo; alt = highMain ? lo : hi;
      res.split = { ratio: Math.round(ratio * 10) / 10, mainLabel: highMain ? lab.high : lab.low, altLabel: highMain ? lab.low : lab.high };
      res.mainTier = highMain ? 'high' : 'low';
    };
    // Holo + non-holo: only the holo is tracked. If the sales show two clusters, the cheaper one is the non-holo and is
    // set aside; with one cluster everything is treated as the holo (chase holos dominate these listings).
    if (kind === 'holoN') {
      const pure = rest.filter((x) => x.n == null || x.n <= 1), b = pure.length >= 6 ? otsu(pure) : null;
      if (b && b.ratio >= 2 && b.gap >= 1.25 && interleaved(b.lo, b.hi)) { const keep = []; for (const x of rest) (x.p < b.T ? res.foreign : keep).push(x); main = keep; }
      kind = null; res.kind = null;
    }
    if (kind && rest.length >= 6) {
      // Pass 1: all sale days. Pass 2: only single-sale days (a day's average of a 1st Ed and an Unl sale lands
      // in between and hides the gap), then place multi-sale days by which side of the threshold they clearly fall.
      const b1 = otsu(rest);
      if (b1 && b1.ratio >= 2.2 && b1.gap >= 1.25 && interleaved(b1.lo, b1.hi)) take(b1.lo, b1.hi, b1.ratio);
      else {
        const pure = rest.filter((x) => x.n == null || x.n <= 1), b2 = pure.length >= 6 ? otsu(pure) : null;
        const prior = opts.prior; // the split ratio this card shows in its other grades (graded sales only)
        const okPrior = !prior || (b2 && b2.ratio >= prior / 1.8 && b2.ratio <= prior * 1.8);
        const closeToPrior = prior && b2 && Math.abs(Math.log(b2.ratio / prior)) <= Math.log(1.35); // RAW agrees: no clean gap needed
        if (b2 && b2.ratio >= (prior ? 1.7 : 2.0) && (b2.gap >= 1.25 || closeToPrior) && okPrior) {
          const T = b2.T, lo = [], hi = [];
          for (const x of rest) {
            if (x.n == null || x.n <= 1) (x.p >= T ? hi : lo).push(x);
            else if (x.p >= T * 1.2) hi.push(x);
            else if (x.p <= T / 1.2) lo.push(x);
            else res.mixed.push(x); // a day averaging both printings: kept out of both lines, not counted as junk
          }
          if (lo.length >= 3 && hi.length >= 3 && interleaved(lo, hi)) take(lo, hi, b2.ratio); else res.mixed = [];
        }
      }
    }
    // No split, but the single-sale prices show no second printing either (no two price levels selling side by side,
    // ≥ 8 single sales): whatever printing mix there is sells at one price level in this grade, so the line is usable.
    // Judged from this grade's own graded sales only.
    if (kind && !res.split) {
      const pure = rest.filter((x) => x.n == null || x.n <= 1), b = pure.length >= 8 ? otsu(pure) : null;
      const twoLevels = b && b.ratio >= 1.6 && interleaved(b.lo, b.hi);
      if (pure.length >= 8 && !twoLevels) { res.same = true; main = rest; alt = []; res.mixed = []; }
    }
    // After any printing split: a day with 2+ sales is that day's AVERAGE, and an average of one 1st Ed and one Unl
    // sale lands between the clusters (often just above the cut, since the cut is a geometric midpoint). Keep such
    // a day only when it sits clearly inside one printing's own range (within 1.3× of that printing's single-sale
    // median); otherwise set it aside as mixed. Single-sale days are always one printing.
    if (res.split) {
      const hiSide = res.mainTier === 'high', H = hiSide ? main : alt, Lo = hiSide ? alt : main;
      const pm = (a) => { const p = a.filter((x) => x.n == null || x.n <= 1); return median((p.length >= 3 ? p : a).map((x) => x.p)); };
      const mH = pm(H), mL = pm(Lo);
      const keepH = [], keepL = [];
      for (const x of H) (x.n == null || x.n <= 1 || x.p >= mH / 1.3 ? keepH : res.mixed).push(x);
      for (const x of Lo) (x.n == null || x.n <= 1 || x.p <= mL * 1.3 ? keepL : res.mixed).push(x);
      if (hiSide) { main = keepH; alt = keepL; } else { main = keepL; alt = keepH; }
    }
    // One printing but two clearly separate price clusters selling side by side = another card's listings
    // mixed in (e.g. a cheaper Ho-Oh under the Skyridge crystal). The smaller cluster is set aside as foreign.
    if ((!kind || res.same) && rest.length >= 8) {
      const pure = rest.filter((x) => x.n == null || x.n <= 1), b = pure.length >= 8 ? otsu(pure) : null;
      if (b && b.ratio >= 2.5 && b.gap >= 1.4 && interleaved(b.lo, b.hi)) {
        const minor = b.lo.length <= b.hi.length ? 'lo' : 'hi', share = b[minor].length / pure.length;
        if (share <= 0.4 && b[minor].length >= 2) {
          const keep = [];
          for (const x of rest) ((minor === 'lo' ? x.p < b.T : x.p >= b.T) ? res.foreign : keep).push(x);
          main = keep;
        }
      }
    }
    const bm = band(main, 2.5), ba = band(alt, 2.5);
    res.main = bm.keep.sort((a, b) => (a.t < b.t ? -1 : 1));
    res.alt = ba.keep.sort((a, b) => (a.t < b.t ? -1 : 1));
    res.out.push(...bm.out, ...ba.out);
    return res;
  }

  // Options for classifying one grade, from the card's GRADED sales only (RAW never enters graded evaluation):
  //  · prior: the printing split ratio this card shows in its other grades (median of clean splits there)
  //  · floor: half the median sale of the grade below — a "PSA 9" far under the PSA 8 price is not a real PSA 9 sale
  const GORD = ['psa7', 'psa8', 'psa9', 'psa10'];
  function gradedOpts(s, grade) {
    if (!s?.grades) return {};
    const kind = pooledKind(s.printings), out = {};
    const below = GORD[GORD.indexOf(grade) - 1], pb = below ? (s.grades[below] || []).map((x) => x.p).filter((p) => p > 0) : [];
    if (pb.length >= 5) out.floor = median(pb) * 0.5;
    if (kind && kind !== 'holoN') {
      const rs = [];
      for (const g of GORD) if (g !== grade && (s.grades[g] || []).length >= 6) { const r = classify(s.grades[g], kind); if (r.split) rs.push(r.split.ratio); }
      if (rs.length) out.prior = median(rs);
    }
    return out;
  }
  const api = { classify, pooledKind, median, gradedOpts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Clean = api;
})(typeof window !== 'undefined' ? window : globalThis);
