// Filters answered with LFC-pack 0.10.19 row numbers give exactly the rows the Workbench's own filter gives (query.mjs matches()), on the cases it maps, and decline the rest.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { positionsQuery } from '../src/query/positions.mjs';
import { runColumnQuery } from '../src/query/columnar.mjs';
const lib = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../vendor/lfcp/0.10.19/lfc-pack.js')); await lib.init();
let seed = 777; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const n = 6000, rows = [];
for (let i = 0; i < n; i++) rows.push({ id: i, k: rnd() < 0.08 ? null : Math.floor(rnd() * 50) - 10, name: rnd() < 0.1 ? null : 'Name ' + Math.floor(rnd() * 40), note: 'note ' + i });
const p = lib.packStream({ blockBytes: 16384, share: true, meta: {} });
const parts = [...p.push(new TextEncoder().encode(rows.map((r) => JSON.stringify(r) + '\n').join(''))), ...p.finish()];
const bytes = new Uint8Array(parts.reduce((a, x) => a + x.byteLength, 0)); let at = 0; for (const x of parts) { bytes.set(x, at); at += x.byteLength; }
const columns = [{ name: 'id', type: 'integer' }, { name: 'k', type: 'integer' }, { name: 'name', type: 'string' }, { name: 'note', type: 'string' }];
const cols = {}; for (const c of columns) cols[c.name] = rows.map((r) => (r[c.name] == null ? null : r[c.name]));
let cases = 0, declined = 0;
const check = (name, text) => {
  const col = columns.find((c) => c.name === name), q = positionsQuery(text, col);
  if (!q) { declined++; return; }
  const got = Array.from(lib.unpack(bytes, Object.assign({ positions: true }, q)));
  const want = Array.from(runColumnQuery(cols, n, columns, { filters: { [name]: text } }).indices);
  assert.deepEqual(got, want, `${name} ${text}`); cases++;
};
for (const t of ['>5', '>=5', '<5', '<=5', '>5.5', '>=5.5', '<5.5', '<=5.5', '>-3', '<=-10', '>1000', '<-1000', '=7', '=0', '=-4', '= 12 ', '>=0', '<=0', '>-0.5', '<0.5']) check('k', t);
for (const t of ['>100', '>=100', '<10', '<=2999', '=777', '=5999', '=6000', '>5990']) check('id', t);
for (const t of ['=Name 3', '=Name 39', '=Name 40', '= Name 7 ', '=name 3', '=note 123', '=note 9999']) check('name', t), check('note', t);
for (const t of ['=05', '=5.0', '=1e1', '!=5', 'abc', '!', '=', '>abc']) check('k', t);   // declined or exact
for (const t of ['=', '!', '!=Name 3', 'Name', '>a']) check('name', t);                   // declined
assert.ok(cases > 14 && declined > 8, `${cases} mapped, ${declined} declined`);
console.log(`  ok  row-number filters equal the Workbench filter (${cases} mapped cases, ${declined} correctly declined)`);
