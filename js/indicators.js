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

  // Weighted moving average (linear weights), needs n valid values in a row.
  function wma(a, n) {
    const out = new Array(a.length).fill(null), d = (n * (n + 1)) / 2;
    for (let i = n - 1; i < a.length; i++) {
      let s = 0, ok = true;
      for (let j = 0; j < n; j++) { const v = a[i - j]; if (!isN(v)) { ok = false; break; } s += v * (n - j); }
      if (ok) out[i] = s / d;
    }
    return out;
  }
  // Hull moving average: WMA(2·WMA(n/2) − WMA(n), √n). Less lag than SMA/EMA, but overshoots on jumpy prices.
  function hma(a, n = 20) {
    const h = wma(a, Math.max(1, Math.round(n / 2))), f = wma(a, n);
    return wma(a.map((_, i) => (isN(h[i]) && isN(f[i]) ? 2 * h[i] - f[i] : null)), Math.max(1, Math.round(Math.sqrt(n))));
  }
  // Supertrend on a close-only series (no intraday highs/lows for card sales): ATR = Wilder average of |Δclose|.
  // Returns the trailing line and direction (+1 up, −1 down).
  function supertrend(a, n = 10, mult = 3) {
    const line = new Array(a.length).fill(null), dir = new Array(a.length).fill(null);
    let atr = null, k = 0, up = null, dn = null, d = 1, prev = null;
    for (let i = 0; i < a.length; i++) {
      const c = a[i]; if (!isN(c)) continue;
      if (prev != null) { const tr = Math.abs(c - prev); atr = atr == null ? tr : k < n ? (atr * k + tr) / (k + 1) : (atr * (n - 1) + tr) / n; k++; }
      if (atr != null && k >= n) {
        const bu = c - mult * atr, bd = c + mult * atr;
        up = up != null && prev > up ? Math.max(bu, up) : bu;
        dn = dn != null && prev < dn ? Math.min(bd, dn) : bd;
        if (d === 1 && c < up) d = -1; else if (d === -1 && c > dn) d = 1;
        line[i] = d === 1 ? up : dn; dir[i] = d;
      }
      prev = c;
    }
    return { line, dir };
  }
  // Volume Zone Oscillator with sale counts as volume: 100·EMA(±volume by price direction) / EMA(volume).
  // +40 and above = buying pressure zone, −40 and below = selling pressure. fisher = Fisher-transformed, smoothed.
  function vzo(close, vol, n = 14) {
    const sv = close.map((c, i) => { const p = close[i - 1]; const v = isN(vol?.[i]) ? vol[i] : 0; return isN(c) && isN(p) ? (c > p ? v : c < p ? -v : 0) : null; });
    const vv = close.map((c, i) => (isN(c) ? (isN(vol?.[i]) ? vol[i] : 0) : null));
    const a = ema(sv, n), b = ema(vv, n);
    const z = a.map((x, i) => (isN(x) && isN(b[i]) && b[i] > 0 ? (100 * x) / b[i] : isN(x) ? 0 : null));
    const fz = ema(z.map((x) => { if (!isN(x)) return null; const y = Math.max(-0.999, Math.min(0.999, x / 100)); return 50 * Math.log((1 + y) / (1 - y)); }), 5);
    return { vzo: z, fisher: fz };
  }

  const api = { sma, ema, wma, hma, supertrend, vzo, stdev, bollinger, rsi, macd, roc, ffill, lastN, lastIdx, firstIdx, chg, volatility, isN };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else (typeof window !== "undefined" ? window : self).Ind = api;
})();
