#!/usr/bin/env node
// Builds a single self-contained HTML file (CSS, JS and current data inlined).
// Handy for sharing a snapshot or opening without a web server.
//   node scripts/build-preview.mjs  →  dist/slabdex.html
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFile(path.join(ROOT, p), 'utf8');
const watchlist = JSON.parse(await rd('data/watchlist.json'));
const status = existsSync(path.join(ROOT, 'data/status.json')) ? JSON.parse(await rd('data/status.json')) : null;
const ledger = existsSync(path.join(ROOT, 'data/ledger.json')) ? JSON.parse(await rd('data/ledger.json')) : null;
const series = {};
for (const f of await readdir(path.join(ROOT, 'data/prices'))) if (f.endsWith('.json')) { const s = JSON.parse(await rd('data/prices/' + f)); series[s.key] = s; }

let html = await rd('index.html');
html = html.replace('<link rel="stylesheet" href="css/styles.css">', ((c) => () => c)(`<style>\n${await rd('css/styles.css')}</style>`));
try { watchlist.printingNames = JSON.parse(await rd('data/printings.json')).names; } catch {}
const data = `<script>window.__SLABDEX_DATA__=${JSON.stringify({ watchlist, series, status, ledger }).replace(/</g, '\\u003c')};</script>`;
html = html.replace('<script src="js/indicators.js"></script>', ((c) => () => c)(`${data}\n<script>\n${await rd('js/indicators.js')}</script>`));
html = html.replace('<script src="js/chart.js"></script>', ((c) => () => c)(`<script>\n${await rd('js/chart.js')}</script>`));
html = html.replace('<script src="js/clean.js"></script>', ((c) => () => c)(`<script>\n${await rd('js/clean.js')}</script>`));
html = html.replace('<script src="js/model.js"></script>', ((c) => () => c)(`<script>\n${await rd('js/model.js')}</script>`));
html = html.replace('<script src="js/tpi.js"></script>', ((c) => () => c)(`<script>\n${await rd('js/tpi.js')}</script>`));
html = html.replace('<script src="js/edge.js"></script>', ((c) => () => c)(`<script>\n${await rd('js/edge.js')}</script>`));
html = html.replace('<script src="js/app.js"></script>', ((c) => () => c)(`<script>\n${await rd('js/app.js')}</script>`));
if (process.argv.includes('--fragment')) html = html.replace(/^[\s\S]*?<head>\s*<meta charset="utf-8">\s*<meta name="viewport"[^>]*>/, '').replace(/<\/head>\s*<body>/, '').replace(/<\/body>\s*<\/html>\s*$/, '');
await mkdir(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', process.argv.includes('--fragment') ? 'slabdex-fragment.html' : 'slabdex.html');
await writeFile(out, html);
console.log(`wrote ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} KB)`);
