// Top-k of a whole typed column (topSortTyped, with per-block min/max skipping) gives the same rows in the same order as the general sort, for both directions,
// heavy ties, empties (NaN), ordered and reversed columns, columns shorter than a block, and a block size small enough to exercise the skipping.
import assert from 'node:assert/strict';
import { runColumnQuery } from '../src/query/columnar.mjs';
import { topSortTyped } from '../src/query/topn.mjs';
let seed = 99; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, ri = (n) => Math.floor(rnd() * n);
let cases = 0, skipped = 0;
const kinds = {
  random: (n) => Float64Array.from({ length: n }, () => (rnd() < 0.1 ? NaN : ri(1000000))),
  ties: (n) => Float64Array.from({ length: n }, () => (rnd() < 0.1 ? NaN : ri(5))),
  allEqual: (n) => new Float64Array(n).fill(7),
  ascending: (n) => Float64Array.from({ length: n }, (_, i) => i),
  descending: (n) => Float64Array.from({ length: n }, (_, i) => n - i),
  int32: (n) => Int32Array.from({ length: n }, () => ri(2000) - 1000),
  sortedWithEmpties: (n) => Float64Array.from({ length: n }, (_, i) => (i % 7 === 0 ? NaN : Math.floor(i / 3))),
  clustered: (n) => Float64Array.from({ length: n }, (_, i) => Math.floor(i / 64) * 10 + ri(10)),   // blocks hold different ranges: skipping works
  mostlyEmpty: (n) => Float64Array.from({ length: n }, () => (rnd() < 0.97 ? NaN : ri(100))),
  negatives: (n) => Float64Array.from({ length: n }, () => ri(200) - 100 + (rnd() < 0.5 ? 0 : -0)),
};
const columns = [{ name: 'v', type: 'number' }];
for (const [kind, make] of Object.entries(kinds)) {
  for (const n of [5, 49, 50, 51, 700, 5000, 20000]) {
    const a = make(n), plain = Array.from(a, (x) => (x !== x ? null : x));
    for (const dir of ['asc', 'desc']) for (const k of [1, 50, 1000]) {
      const want = Array.from(runColumnQuery({ v: plain }, n, columns, { sort: { col: 'v', dir } }).indices).slice(0, k);
      for (const block of [64, 1000, 65536]) {
        const got = topSortTyped(a, k, dir === 'desc' ? -1 : 1, block);
        if (got === null) { skipped++; continue; }   // declined (fewer than k values, or k not below the row count): the general path answers
        assert.deepEqual(Array.from(got), want.slice(0, got.length), `${kind} n=${n} ${dir} k=${k} block=${block}`);
        assert.equal(got.length, Math.min(k, n)); cases++;
      }
      // through runColumnQuery: first page is what the app uses
      const r = runColumnQuery({ v: a }, n, columns, { sort: { col: 'v', dir }, top: k }, { block: 64 });
      if (r.first) { assert.deepEqual(Array.from(r.first), want.slice(0, r.first.length), `runColumnQuery ${kind} n=${n} ${dir} k=${k}`); assert.equal(r.count, n); cases++; }
    }
  }
}
// with a filter the general path runs and still gives the same answer on a typed column
const n = 3000, a = kinds.random(n), plain = Array.from(a, (x) => (x !== x ? null : x));
for (const f of ['>500000', '<=1000', '=', '!', '=7', '!=7']) for (const dir of ['asc', 'desc']) {
  const want = Array.from(runColumnQuery({ v: plain }, n, columns, { filters: { v: f }, sort: { col: 'v', dir } }).indices);
  const full = runColumnQuery({ v: a }, n, columns, { filters: { v: f }, sort: { col: 'v', dir } });
  assert.deepEqual(Array.from(full.indices), want, `typed column with filter ${f} ${dir}`);
  const top = runColumnQuery({ v: a }, n, columns, { filters: { v: f }, sort: { col: 'v', dir }, top: 50 });
  if (top.first) assert.deepEqual(Array.from(top.first), want.slice(0, top.first.length), `first page with filter ${f} ${dir}`);
  cases++;
}
// NaN is an empty cell in the filters, as null is
for (const f of ['=', '!', '>5', '<5', '5']) {
  const w = Array.from(runColumnQuery({ v: plain }, n, columns, { filters: { v: f } }).indices), g = Array.from(runColumnQuery({ v: a }, n, columns, { filters: { v: f } }).indices);
  assert.deepEqual(g, w, `NaN as empty, filter ${f}`); cases++;
}
console.log(`ok: ${cases} top-k cases equal to the general sort (${skipped} declined to the general path)`);
