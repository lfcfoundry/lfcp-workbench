// Filters answered with LFC-pack 0.10.19 row numbers give exactly the rows the Workbench's own filter gives (query.mjs matches()), on the cases it maps, and decline the rest.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { positionsQuery } from '../src/query/positions.mjs';
import { runColumnQuery } from '../src/query/columnar.mjs';
const lib = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../vendor/lfcp/0.10.22/lfc-pack.js')); await lib.init();
let seed = 777; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const n = 6000, rows = [];
for (let i = 0; i < n; i++) rows.push({ id: i, k: rnd() < 0.08 ? null : Math.floor(rnd() * 50) - 10, name: rnd() < 0.1 ? null : 'Name ' + Math.floor(rnd() * 40), note: 'note ' + i });
const p = lib.packStream({ blockBytes: 16384, share: true, meta: {} });
const parts = [...p.push(new TextEncoder().encode(rows.map((r) => JSON.stringify(r) + '\n').join(''))), ...p.finish()];
const bytes = new Uint8Array(parts.reduce((a, x) => a + x.byteLength, 0)); let at = 0; for (const x of parts) { bytes.set(x, at); at += x.byteLength; }
const columns = [{ name: 'id', type: 'integer' }, { name: 'k', type: 'integer' }, { name: 'name', type: 'string' }, { name: 'note', type: 'string' }];
const cols = {}; for (const c of columns) cols[c.name] = rows.map((r) => (r[c.name] == null ? null : r[c.name]));
import { parseFilter } from '../src/query/query.mjs';
// parser
assert.deepEqual(parseFilter('=a|b', 'string').filter.values, ['a', 'b']);
assert.deepEqual(parseFilter('= a | b |c', 'string').filter.values, ['a', 'b', 'c']);
assert.deepEqual(parseFilter('=a\\|b|c', 'string').filter.values, ['a|b', 'c']);                  // escaped bar stays inside a value
assert.deepEqual(parseFilter('=a\\|b', 'string').filter, { op: 'eq', value: 'a|b' });             // one value, literal bar
assert.deepEqual(parseFilter('=abc', 'string').filter, { op: 'eq', value: 'abc' });               // unchanged
assert.ok(parseFilter('=a||b', 'string').error && parseFilter('=a|', 'string').error && parseFilter('=|a', 'string').error);
assert.equal(parseFilter('a|b', 'string').filter.op, 'contains');                                    // no = : still contains
assert.equal(parseFilter('!=a|b', 'string').filter.value, 'a|b');                                    // != unchanged
const run = (name, text) => Array.from(runColumnQuery(cols, n, columns, { filters: { [name]: text } }).indices);
// column path = plain reference
const ref = (name, vals) => { const s = new Set(vals); const out = []; for (let i = 0; i < n; i++) { const v = cols[name][i]; if (v != null && s.has(String(v))) out.push(i); } return out; };
assert.deepEqual(run('name', '=Name 3|Name 7|Name 99'), ref('name', ['Name 3', 'Name 7', 'Name 99']));
assert.deepEqual(run('k', '=3|-4|11'), ref('k', ['3', '-4', '11']));
assert.deepEqual(run('name', '=Name 3|nothing here'), ref('name', ['Name 3']));                   // value missing from the file
// positions path equals the column path
let m = 0, d = 0;
for (const [name, t] of [['name', '=Name 3|Name 7|Name 99'], ['name', '=Name 3|Name 12'], ['name', '=Name 3|zzz'], ['note', '=note 5|note 70|note 5999'], ['k', '=3|-4|11'], ['k', '=7|8'], ['k', '=5|6|7|8|9|-2'], ['id', '=1|2|5999|7000'],
  ['k', '=05|3'], ['k', '=1.5|2'], ['k', '=a|b'], ['name', '=Name 3|'], ['name', '=a|b|']]) {
  const q = positionsQuery(t, columns.find((c) => c.name === name));
  if (!q) { d++; continue; }
  assert.deepEqual(Array.from(lib.unpack(bytes, Object.assign({ positions: true }, q))), run(name, t), name + ' ' + t); m++;
}
assert.ok(m >= 8 && d >= 3, m + ' mapped ' + d + ' declined');
console.log(`  ok  one-of filter (=a|b): parser, column path, and row numbers agree (${m} mapped, ${d} declined)`);
