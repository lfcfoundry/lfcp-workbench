import assert from 'node:assert/strict';
import { runQuery } from '../src/query/query.mjs';
import { runColumnQuery } from '../src/query/columnar.mjs';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
// deterministic pseudo-random data with blanks, junk numbers, ties, mixed dates
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const columns = [{ name: 'id', type: 'integer' }, { name: 'score', type: 'number' }, { name: 'when', type: 'date' }, { name: 'name', type: 'string' }];
const rows = Array.from({ length: 3000 }, (_, i) => ({
  id: rnd() < 0.05 ? '' : String(Math.floor(rnd() * 50)), score: rnd() < 0.1 ? '' : rnd() < 0.03 ? 'n/a' : (rnd() * 100).toFixed(1),
  when: rnd() < 0.1 ? '' : rnd() < 0.05 ? 'soon' : pick(['2026-11-01', '2026-11-02T10:00:00Z', '2026-10-31', '2026-11-05']), name: rnd() < 0.1 ? '' : pick(['Ann', 'bob', 'Cy', 'ann marie', 'Zed', 'élan']) }));
const cols = {}; for (const c of columns) cols[c.name] = rows.map((r) => r[c.name]);
const same = (q) => { const a = runQuery(rows, columns, q), b = runColumnQuery(cols, rows.length, columns, q); assert.deepEqual(Array.from(b.indices), Array.from(a.indices)); assert.deepEqual(b.errors, a.errors); };
const filters = [{}, { id: '>=25' }, { score: '<50', name: 'an' }, { when: '>2026-11-01' }, { name: '=Ann' }, { name: '!=Ann', id: '<10' }, { score: '=' }, { name: '!' }, { id: '>x' }, { id: '>5', score: '>5', when: '!', name: 'a' }];
const sorts = [null, { col: 'id', dir: 'asc' }, { col: 'id', dir: 'desc' }, { col: 'score', dir: 'asc' }, { col: 'score', dir: 'desc' }, { col: 'when', dir: 'asc' }, { col: 'when', dir: 'desc' }, { col: 'name', dir: 'asc' }, { col: 'name', dir: 'desc' }];
t('column query equals row query for every filter x sort pair', () => { for (const f of filters) for (const s of sorts) same({ filters: f, sort: s }); });
t('only the needed columns are read', () => { const part = { id: cols.id }; const q = { filters: { id: '>=40' }, sort: { col: 'id', dir: 'desc' } }; assert.deepEqual(Array.from(runColumnQuery(part, rows.length, columns, q).indices), Array.from(runQuery(rows, columns, q).indices)); });
console.log(n + ' columnar checks passed');
