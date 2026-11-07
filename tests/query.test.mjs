import assert from 'node:assert/strict';
import { parseFilter, matches, runQuery } from '../src/query/query.mjs';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const cols = [{ name: 'id', type: 'integer' }, { name: 'name', type: 'string' }, { name: 'score', type: 'number' }, { name: 'when', type: 'date' }];
const rows = [
  { id: '10', name: 'Ann', score: '9.5', when: '2026-11-03' },
  { id: '9', name: 'bob', score: '', when: '2026-11-01' },
  { id: '100', name: 'Cy', score: '7', when: '2026-11-02T10:00:00Z' },
  { id: '2', name: '', score: '12.25', when: '' },
];
const ids = (q) => Array.from(runQuery(rows, cols, q).indices);
t('no query returns every row in file order', () => assert.deepEqual(ids({}), [0, 1, 2, 3]));
t('numeric sort is by value, not text (9 < 10 < 100)', () => assert.deepEqual(ids({ sort: { col: 'id', dir: 'asc' } }).map((i) => rows[i].id), ['2', '9', '10', '100']));
t('descending numeric', () => assert.deepEqual(ids({ sort: { col: 'id', dir: 'desc' } }).map((i) => rows[i].id), ['100', '10', '9', '2']));
t('empty cells sort last in both directions', () => {
  assert.equal(rows[ids({ sort: { col: 'score', dir: 'asc' } }).pop()].score, '');
  assert.equal(rows[ids({ sort: { col: 'score', dir: 'desc' } }).pop()].score, '');
  assert.deepEqual(ids({ sort: { col: 'score', dir: 'asc' } }), [2, 0, 3, 1]);
});
t('date sort handles date and date-time', () => assert.deepEqual(ids({ sort: { col: 'when', dir: 'asc' } }), [1, 2, 0, 3]));
t('text sort is code point order (capitals before lowercase), empty last', () => assert.deepEqual(ids({ sort: { col: 'name', dir: 'asc' } }), [0, 2, 1, 3]));
t('contains is case-insensitive', () => assert.deepEqual(ids({ filters: { name: 'AN' } }), [0]));
t('numeric comparisons', () => {
  assert.deepEqual(ids({ filters: { id: '>=10' } }), [0, 2]); assert.deepEqual(ids({ filters: { id: '<10' } }), [1, 3]);
  assert.deepEqual(ids({ filters: { score: '>8' } }), [0, 3]);
});
t('date comparison', () => assert.deepEqual(ids({ filters: { when: '>2026-11-01' } }), [0, 2]));
t('equals, not equals, empty, non-empty', () => {
  assert.deepEqual(ids({ filters: { name: '=Ann' } }), [0]); assert.deepEqual(ids({ filters: { name: '!=Ann' } }), [1, 2, 3]);
  assert.deepEqual(ids({ filters: { score: '=' } }), [1]); assert.deepEqual(ids({ filters: { score: '!' } }), [0, 2, 3]);
});
t('filters combine with AND, then sort applies', () => assert.deepEqual(ids({ filters: { id: '>=9', score: '!' }, sort: { col: 'id', dir: 'desc' } }), [2, 0]));
t('bad number gives a message, not a crash or silent empty result', () => {
  const r = runQuery(rows, cols, { filters: { id: '>abc' } }); assert.match(r.errors.id, /number/); assert.equal(r.indices.length, 4);
});
t('empty cells never match a comparison', () => assert.deepEqual(ids({ filters: { score: '<100' } }), [0, 2, 3]));
t('parseFilter blanks', () => assert.deepEqual(parseFilter('  ', 'string'), { filter: null }));
t('100k rows filter and sort stays correct', () => {
  const big = Array.from({ length: 100000 }, (_, i) => ({ v: String((i * 7919) % 100003) }));
  const q = runQuery(big, [{ name: 'v', type: 'integer' }], { filters: { v: '>=50000' }, sort: { col: 'v', dir: 'asc' } });
  for (let i = 1; i < q.indices.length; i++) assert.ok(Number(big[q.indices[i - 1]].v) <= Number(big[q.indices[i]].v));
  assert.equal(q.indices.length, big.filter((r) => Number(r.v) >= 50000).length);
});
console.log(`  ${n} query checks passed`);
