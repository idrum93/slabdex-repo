// Indicator math. All functions take arrays of numbers (null = no data) aligned to a date axis
// and return arrays of the same length.
(function () {
  const isN = (v) => v != null && isFinite(v);

  function sma(a, n) {
    const out = new Array(a.length).fill(null);
    let s = 0, k = 0;
    for (let i = 0; i < a.length; i++) {
      if (isN(a[i])) { s += a[i]; k++; }
      if (i >= n && isN(a[i - n])) { s -= a[i - n]; k--; }
      if (i >= n - 1 && k === n) out[i] = s / n;
    }
    return out;
  }

  function ema(a, n) {
    const out = new Array(a.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null, seed = [], started = false;
    for (let i = 0; i < a.length; i++) {
      if (!isN(a[i])) { if (started) out[i] = prev; continue; }
      if (!started) {
        seed.push(a[i]);
        if (seed.length === n) { prev = seed.reduce((x, y) => x + y, 0) / n; out[i] = prev; started = true; }
        continue;
      }
      prev = a[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function stdev(a, n) {
    const m = sma(a, n);
    return a.map((_, i) => {
      if (!isN(m[i])) return null;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (a[j] - m[i]) ** 2;
      return Math.sqrt(s / n);
    });
  }

  function bollinger(a, n = 20, k = 2) {
    const m = sma(a, n), sd = stdev(a, n);
    return { mid: m, up: m.map((v, i) => (isN(v) ? v + k * sd[i] : null)), lo: m.map((v, i) => (isN(v) ? v - k * sd[i] : null)) };
  }

  // Wilder's RSI
  function rsi(a, n = 14) {
    const out = new Array(a.length).fill(null);
    let ag = 0, al = 0, cnt = 0, prev = null, ready = false;
    for (let i = 0; i < a.length; i++) {
      if (!isN(a[i])) continue;
      if (prev == null) { prev = a[i]; continue; }
      const ch = a[i] - prev; prev = a[i];
      const g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (!ready) {
        ag += g; al += l; cnt++;
        if (cnt === n) { ag /= n; al /= n; ready = true; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
      } else {
        ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n;
        out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      }
    }
    return out;
  }

  function macd(a, f = 12, s = 26, sig = 9) {
    const ef = ema(a, f), es = ema(a, s);
    const line = a.map((_, i) => (isN(ef[i]) && isN(es[i]) ? ef[i] - es[i] : null));
    const signal = ema(line, sig);
    const hist = line.map((v, i) => (isN(v) && isN(signal[i]) ? v - signal[i] : null));
    return { line, signal, hist };
  }

  // Rate of change in % over n bars
  function roc(a, n) {
    return a.map((v, i) => (i >= n && isN(v) && isN(a[i - n]) && a[i - n] !== 0 ? (v / a[i - n] - 1) * 100 : null));
  }

  // Forward-fill: card sales are sparse, last known price holds until a new sale.
  function ffill(a) {
    let last = null;
    return a.map((v) => (isN(v) ? (last = v) : last));
  }

  function lastN(a) { for (let i = a.length - 1; i >= 0; i--) if (isN(a[i])) return a[i]; return null; }
  function lastIdx(a) { for (let i = a.length - 1; i >= 0; i--) if (isN(a[i])) return i; return -1; }
  function firstIdx(a) { for (let i = 0; i < a.length; i++) if (isN(a[i])) return i; return -1; }

  // Change over the last n bars, measured from the last valid bar
  function chg(a, n) {
    const i = lastIdx(a);
    if (i < 0 || i - n < 0 || !isN(a[i - n])) return null;
    return (a[i] / a[i - n] - 1) * 100;
  }

  function volatility(a, n = 30) { // annualised stdev of daily log returns
    const i = lastIdx(a);
    if (i < n) return null;
    const r = [];
    for (let j = i - n + 1; j <= i; j++) if (isN(a[j]) && isN(a[j - 1]) && a[j - 1] > 0) r.push(Math.log(a[j] / a[j - 1]));
    if (r.length < n / 2) return null;
    const m = r.reduce((x, y) => x + y, 0) / r.length;
    return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / r.length) * Math.sqrt(365) * 100;
  }

  const api = { sma, ema, stdev, bollinger, rsi, macd, roc, ffill, lastN, lastIdx, firstIdx, chg, volatility, isN };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else window.Ind = api;
})();
