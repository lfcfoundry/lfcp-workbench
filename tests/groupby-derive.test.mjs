// Node pass/fail gate for src/query/groupby.mjs and derive.mjs (no timing).
import assert from 'node:assert/strict';
import { groupBy } from '../src/query/groupby.mjs';
import { derive } from '../src/query/derive.mjs';
const date = ['2002-12-11T03:00:00.000', '2002-12-11 23:59:00', '', 'bad', '2001-01-01T10:40:00.000', null];
assert.deepEqual(Array.from(derive(date, 6, 'hour')), [3, 23, NaN, NaN, 10, NaN]);
assert.deepEqual(Array.from(derive(date, 6, 'year')), [2002, 2002, NaN, NaN, 2001, NaN]);
assert.deepEqual(Array.from(derive(date, 6, 'month')), [12, 12, NaN, NaN, 1, NaN]);
assert.deepEqual(derive(['Ab ', null], 2, 'upper'), ['AB ', '']);
assert.throws(() => derive(date, 6, 'nope'));
const cols = { t: ['A', 'B', 'A', 'A', 'B', ''], arrest: ['true', 'false', 'false', 'true', 'false', 'true'], n: Float64Array.from([1, 2, NaN, 4, 5, 6]) };
const g = groupBy(cols, 6, null, { key: 't', aggs: [{ fn: 'count' }, { fn: 'rate', col: 'arrest', equals: 'true' }, { fn: 'sum', col: 'n' }, { fn: 'avg', col: 'n' }, { fn: 'min', col: 'n' }, { fn: 'max', col: 'n' }] });
assert.deepEqual(g.keys, ['A', 'B', '']); assert.deepEqual(Array.from(g.counts), [3, 2, 1]);
assert.deepEqual(Array.from(g.values[0]), [2 / 3, 0, 1]); assert.deepEqual(Array.from(g.values[1]), [5, 7, 6]); assert.deepEqual(Array.from(g.values[2]), [2.5, 3.5, 6]);
assert.deepEqual(Array.from(g.values[3]), [1, 2, 6]); assert.deepEqual(Array.from(g.values[4]), [4, 5, 6]);
const f = groupBy(cols, 6, Uint32Array.from([1, 4]), { key: 't', aggs: [{ fn: 'count' }] }); assert.deepEqual(f.keys, ['B']); assert.deepEqual(Array.from(f.counts), [2]);
const num = groupBy({ k: Float64Array.from([1, NaN, 1, NaN]) }, 4, null, { key: 'k', aggs: [{ fn: 'count' }] }); assert.deepEqual(num.keys, ['1', '']); assert.deepEqual(Array.from(num.counts), [2, 2]);
const empty = groupBy({ k: ['x'], n: Float64Array.from([NaN]) }, 1, null, { key: 'k', aggs: [{ fn: 'avg', col: 'n' }] }); assert.ok(Number.isNaN(empty.values[0][0]));
import { groupByCodes } from '../src/query/groupby.mjs';
const dict = ['A', 'B', ''], ids = Uint32Array.from([0, 1, 0, 0, 1, 2]), codes = groupByCodes(ids, dict, cols, 6, null, { aggs: [{ fn: 'count' }, { fn: 'rate', col: 'arrest', equals: 'true' }, { fn: 'sum', col: 'n' }] });
assert.deepEqual(codes.keys, g.keys); assert.deepEqual(Array.from(codes.counts), Array.from(g.counts)); assert.deepEqual(Array.from(codes.values[0]), Array.from(g.values[0])); assert.deepEqual(Array.from(codes.values[1]), Array.from(g.values[1]));
const cf = groupByCodes(ids, dict, cols, 6, Uint32Array.from([1, 4]), { aggs: [{ fn: 'count' }] }); assert.deepEqual(cf.keys, ['B']); assert.deepEqual(Array.from(cf.counts), [2]);
const arrestIds = Uint32Array.from([0, 1, 1, 0, 1, 0]), cc = groupByCodes(ids, dict, cols, 6, null, { aggs: [{ fn: 'rate', col: 'arrest', equals: 'true' }], codeCols: { arrest: { ids: arrestIds, dict: ['true', 'false'] } } }); assert.deepEqual(Array.from(cc.values[0]), Array.from(g.values[0]));
import { groupBy2 } from '../src/query/groupby.mjs';
{ // two keys: dense, Map and kept-id paths agree with a plain Map reference (random data incl. empty text and NaN numbers)
  const N = 5000, A = Array.from({ length: N }, (_, i) => ['x', 'y', '', 'z'][(i * 7 + (i >> 3)) % 4]), Bn = Float64Array.from({ length: N }, (_, i) => (i % 9 === 0 ? NaN : i % 5)), V = Float64Array.from({ length: N }, (_, i) => (i % 11 === 0 ? NaN : i % 13)), T = Array.from({ length: N }, (_, i) => (i % 3 ? 'true' : 'false'));
  const c = { A, B: Bn, V, T }, rows = Uint32Array.from({ length: 2000 }, (_, i) => i * 2 + 1), aggs = [{ fn: 'count' }, { fn: 'sum', col: 'V' }, { fn: 'avg', col: 'V' }, { fn: 'min', col: 'V' }, { fn: 'max', col: 'V' }, { fn: 'rate', col: 'T', equals: 'true' }];
  for (const rs of [null, rows]) {
    const ref = new Map(), m = rs ? rs.length : N; for (let i = 0; i < m; i++) { const r = rs ? rs[i] : i, k = A[r] + '\u0001' + (Bn[r] !== Bn[r] ? '' : String(Bn[r])); const e = ref.get(k) || { n: 0, s: 0, sn: 0, mn: Infinity, mx: -Infinity, t: 0 }; e.n++; if (V[r] === V[r]) { e.s += V[r]; e.sn++; e.mn = Math.min(e.mn, V[r]); e.mx = Math.max(e.mx, V[r]); } if (T[r] === 'true') e.t++; ref.set(k, e); }
    const dictA = ['x', 'y', '', 'z'], idsA = Uint8Array.from(A, (v) => dictA.indexOf(v));
    for (const o of [{}, { forceMap: true }, { ids1: idsA, dict1: dictA }, { ids1: idsA, dict1: dictA, forceMap: true }]) {
      const g = groupBy2(c, N, rs, { key: 'A', key2: 'B', aggs, ...o }); assert.equal(g.keys.length, ref.size);
      g.keys.forEach((k, i) => { const e = ref.get(k + '\u0001' + g.keys2[i]); assert.ok(e); assert.equal(g.counts[i], e.n); assert.equal(g.values[0][i], e.sn ? e.s : NaN); assert.equal(g.values[1][i], e.sn ? e.s / e.sn : NaN); assert.equal(g.values[2][i], e.sn ? e.mn : NaN); assert.equal(g.values[3][i], e.sn ? e.mx : NaN); assert.ok(Math.abs(g.values[4][i] - e.t / e.n) < 1e-12); });
    }
  }
}
{ // a key-id cache gives the same groups on the second call, with and without a row selection
  const A = ['x', 'y', 'x', 'z', 'y', 'x'], B = Float64Array.from([1, 1, 2, NaN, 1, 2]), c = { A, B }, cache = new Map(), aggs = [{ fn: 'count' }];
  const r1 = groupBy2(c, 6, null, { key: 'A', key2: 'B', aggs, cache }), r2 = groupBy2(c, 6, null, { key: 'A', key2: 'B', aggs, cache }), sel = Uint32Array.from([0, 2, 5]);
  assert.deepEqual(r2.keys, r1.keys); assert.deepEqual(Array.from(r2.counts), Array.from(r1.counts)); assert.equal(cache.size, 2);
  const f = groupBy2(c, 6, sel, { key: 'A', key2: 'B', aggs, cache }), g = groupBy2(c, 6, sel, { key: 'A', key2: 'B', aggs });
  assert.deepEqual(f.keys, g.keys); assert.deepEqual(f.keys2, g.keys2); assert.deepEqual(Array.from(f.counts), Array.from(g.counts));
}
console.log('groupby-derive: PASS');
