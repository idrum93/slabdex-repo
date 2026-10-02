// Background backtest (js/edge.js) so the page never freezes while it runs. The page posts the watchlist and price
// series once ({type:'init'}), then asks per grade ({type:'run', grade}); models are built here with the same code.
self.importScripts('indicators.js', 'clean.js', 'model.js', 'tpi.js', 'edge.js');
let WL = null, SERIES = null, MODELS = {};
const GRADES = ['psa7', 'psa8', 'psa9', 'psa10'];
self.onmessage = (e) => {
  const d = e.data || {};
  if (d.type === 'init') { WL = d.WL; SERIES = d.SERIES; MODELS = {}; return; }
  if (d.type !== 'run' || !WL) return;
  const g = d.grade;
  try {
    for (const x of GRADES) MODELS[x] ||= self.Model.buildModel(WL, SERIES, x);
    const res = self.Edge.run(MODELS[g], { others: GRADES.filter((x) => x !== g).map((x) => MODELS[x]) });
    self.postMessage({ type: 'done', grade: g, result: res });
  } catch (err) {
    self.postMessage({ type: 'error', grade: g, message: String(err && err.message || err) });
  }
};
