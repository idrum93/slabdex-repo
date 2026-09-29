// Sale cleaning shared by the terminal (browser) and scripts (Node).
//
// Some records pool two printings' graded sales (WOTC 1st Edition + Unlimited, or holo + reverse holo).
// For each card and grade we:
//   1. drop junk (more than 8× from the median — mismatched listings, lots, typos),
//   2. if the record is pooled, try to split sales into two price clusters (Otsu on log price);
//      a split is accepted only when the clusters are clearly separate (centres ≥ 2.2× apart,
//      a real gap between them, ≥ 3 sales each),
//   3. keep the larger cluster as the card's main line and the other as an "alt" line,
//   4. inside each line, drop sales more than 2.5× from that line's median.
// Every sale ends up as exactly one of: main, alt, out.
(function (root) {
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

  function pooledKind(printings) {
    const v = (printings || []).join(' ');
    if (/1st/i.test(v) && /unlimited/i.test(v)) return '1st';
    if (/reverse/i.test(v) && /holo/i.test(v)) return 'rev';
    return null;
  }
  const LABELS = { '1st': { low: 'Unl', high: '1st Ed' }, rev: { low: 'lower tier', high: 'upper tier' } };

  function band(pts, k) {
    const m = median(pts.map((x) => x.p));
    const keep = [], out = [];
    for (const x of pts) (pts.length >= 3 && (x.p > m * k || x.p < m / k) ? out : keep).push(x);
    return { keep, out };
  }

  function classify(points, kind) {
    const all = (points || []).filter((x) => x && x.p > 0);
    const res = { main: [], alt: [], out: [], split: null, mainTier: null, kind };
    if (!all.length) return res;
    const m = median(all.map((x) => x.p));
    const rest = [];
    for (const x of all) (all.length >= 3 && (x.p > m * 8 || x.p < m / 8) ? res.out : rest).push(x);

    let main = rest, alt = [];
    if (kind && rest.length >= 6) {
      const s = [...rest].sort((a, b) => a.p - b.p), L = s.map((x) => Math.log(x.p));
      let best = null;
      for (let k = 3; k <= s.length - 3; k++) {
        const lo = L.slice(0, k), hi = L.slice(k);
        const ml = lo.reduce((a, b) => a + b, 0) / lo.length, mh = hi.reduce((a, b) => a + b, 0) / hi.length;
        const sse = lo.reduce((a, v) => a + (v - ml) ** 2, 0) + hi.reduce((a, v) => a + (v - mh) ** 2, 0);
        if (!best || sse < best.sse) best = { k, ml, mh, sse };
      }
      if (best) {
        const ratio = Math.exp(best.mh - best.ml), gap = s[best.k].p / s[best.k - 1].p;
        if (ratio >= 2.2 && gap >= 1.25) {
          const low = s.slice(0, best.k), high = s.slice(best.k);
          const highMain = high.length > low.length;
          main = highMain ? high : low; alt = highMain ? low : high;
          const lab = LABELS[kind];
          res.split = { ratio: Math.round(ratio * 10) / 10, mainLabel: highMain ? lab.high : lab.low, altLabel: highMain ? lab.low : lab.high };
          res.mainTier = highMain ? 'high' : 'low';
        }
      }
    }
    const bm = band(main, 2.5), ba = band(alt, 2.5);
    res.main = bm.keep.sort((a, b) => (a.t < b.t ? -1 : 1));
    res.alt = ba.keep.sort((a, b) => (a.t < b.t ? -1 : 1));
    res.out.push(...bm.out, ...ba.out);
    return res;
  }

  const api = { classify, pooledKind, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Clean = api;
})(typeof window !== 'undefined' ? window : globalThis);
