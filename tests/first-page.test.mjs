// First page first: the top rows picked in one scan equal the first rows of the full sort, for every column kind, both directions, with empties, bad numbers and ties.
import assert from 'node:assert/strict';
import { runColumnQuery } from '../src/query/columnar.mjs';
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const columns = [{ name: 'f', type: 'number' }, { name: 'i', type: 'integer' }, { name: 'n', type: 'integer' }, { name: 'x', type: 'number' }, { name: 't', type: 'string' }, { name: 'd', type: 'date' }];
let cases = 0;
for (let round = 0; round < 60; round++) {
  const n = 50 + Math.floor(rnd() * 3000);
  const cols = { n: [], x: [], t: [], d: [], f: new Float64Array(n), i: new Int32Array(n) };
  for (let i = 0; i < n; i++) {
    cols.f[i] = Math.round(rnd() * 500) / 10; cols.i[i] = Math.floor(rnd() * 30) - 10;
    cols.n.push(rnd() < 0.05 ? null : Math.floor(rnd() * 40));                                   // many ties
    cols.x.push(rnd() < 0.1 ? '' : rnd() < 0.03 ? 'abc' : Math.round(rnd() * 1e4) / 100);
    cols.t.push(rnd() < 0.05 ? null : 'w' + Math.floor(rnd() * 200));
    cols.d.push(rnd() < 0.05 ? null : '2026-11-' + String(1 + Math.floor(rnd() * 28)).padStart(2, '0'));
  }
  for (const col of ['n', 'x', 't', 'd', 'f', 'i']) for (const dir of ['asc', 'desc']) for (const k of [1, 7, 64]) {
    const sort = { col, dir }, filters = rnd() < 0.3 ? { n: '>5' } : {};
    const full = runColumnQuery(cols, n, columns, { filters, sort }).indices;
    const r = runColumnQuery(cols, n, columns, { filters, sort, top: k });
    if (!r.first) { assert.ok(full.length <= k); continue; }
    assert.equal(r.count, full.length);
    assert.deepEqual(Array.from(r.first), Array.from(full.subarray(0, r.first.length)), `${col} ${dir} k=${k}`);
    assert.deepEqual(Array.from(r.full()), Array.from(full)); cases++;
  }
}
console.log(`  ok  first-page sort equals the start of the full sort (${cases} cases: numbers, decimals, text, dates, empties, ties)`);
