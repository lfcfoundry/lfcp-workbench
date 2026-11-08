#!/usr/bin/env node
// Builds ONE self-contained .html file of the Workbench page (no server, no install; open by double-click).
// Usage: node tools/build-single.mjs OUT.html [--test]
// The page's CSP names the exact hashes of its inline script and style, so no 'unsafe-inline' is needed.
// --test lets the page POST its plain-text result to a loopback server (used by tests/browser-run.py --file).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2]; const test = process.argv.includes('--test');
if (!out) { console.error('usage: node tools/build-single.mjs OUT.html [--test]'); process.exit(2); }
const rd = (p) => readFileSync(join(root, p), 'utf8');
const strip = (src) => src.replace(/^import .*$/gm, '').replace(/^export (class|function|const) /gm, '$1 ');
const mods = '(function(){\n' + ['src/ingest/delimited.mjs', 'src/ingest/infer.mjs', 'src/ingest/records.mjs', 'src/query/query.mjs', 'src/query/columnar.mjs', 'src/export/csv.mjs', 'app/bigdata.mjs'].map((f) => strip(rd(f))).join('\n') +
  '\nreturn { DelimitedParser, IngestError, cleanHeaders, detectDelimiter, TypeTracker, typedCell, readRecords, parseFilter, matches, runQuery, sortKeyFor, runColumnQuery, csvField, csvLines, csvHeader, HEADER, cells, line };\n})()';
const lfc = rd('vendor/lfcp/0.7.0/lfc-pack.js');
const worker = rd('app/worker.js').replace(/^importScripts\(.*$/m, '');
const workerSrc = 'self.__M = ' + mods + ';\n' + lfc + '\n;\n' + worker;
for (const [n, t] of [['worker source', workerSrc], ['mods', mods]]) if (/<\/script|<!--/i.test(t)) throw new Error(n + ' contains a sequence that cannot sit inside a script element');
const css = rd('app/app.css').trim();
const app = 'window.__M = ' + mods + ';\nwindow.__WORKER_URL = URL.createObjectURL(new Blob([document.getElementById("wsrc").textContent], { type: "text/javascript" }));\n' + rd('app/app.js');
const h = (t) => "'sha256-" + createHash('sha256').update(t).digest('base64') + "'";
let html = rd('app/index.html');
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${h(app)} 'wasm-unsafe-eval'; style-src ${h(css)}; worker-src blob:; connect-src ${test ? 'http://127.0.0.1:*' : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'">`);
html = html.replace('<link rel="stylesheet" href="app.css">', '<style>' + css + '</style>').replace('<script defer src="app.js"></script>', '');
html = html.replace('</body>', '<script type="text/plain" id="wsrc">' + workerSrc + '</script>\n<script>' + app + '</script>\n</body>');
writeFileSync(out, html);
console.log('wrote ' + out + ' (' + (html.length / 1024).toFixed(0) + ' KB)' + (test ? ' [test build]' : ''));
