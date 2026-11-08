import assert from 'node:assert/strict';
import { typedCell } from '../src/ingest/infer.mjs';
import { runQuery } from '../src/query/query.mjs';
import { runColumnQuery } from '../src/query/columnar.mjs';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
t('plain whole numbers become numbers whose text is the original', () => {
  for (const v of ['0', '7', '-7', '123456789012345', '-123456789012345']) { const x = typedCell(v); assert.equal(typeof x, 'number'); assert.equal(String(x), v); }
});
t('empty becomes null; anything else stays text', () => {
  assert.equal(typedCell(''), null);
  for (const v of ['-0', '007', '+5', '1.0', '1e3', ' 5', '5 ', '1234567890123456', 'abc', '0x10', '1,000', '१२']) assert.equal(typedCell(v), v);
});
// the stored (typed) column and the text column must filter and sort exactly alike
let seed = 99; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const columns = [{ name: 'id', type: 'integer' }, { name: 'name', type: 'string' }];
const text = Array.from({ length: 4000 }, () => ({ id: rnd() < 0.06 ? '' : rnd() < 0.02 ? 'n/a' : rnd() < 0.02 ? '007' : String(Math.floor(rnd() * 60) - 20), name: rnd() < 0.5 ? 'a' : 'b' }));
const typed = text.map((r) => ({ id: typedCell(r.id), name: r.name }));
const colsT = { id: text.map((r) => r.id), name: text.map((r) => r.name) }, colsN = { id: typed.map((r) => r.id), name: typed.map((r) => r.name) };
const filters = [{}, { id: '>=10' }, { id: '>10' }, { id: '<-5' }, { id: '<=0' }, { id: '=7' }, { id: '=-3' }, { id: '!=7' }, { id: '=' }, { id: '!' }, { id: '1' }, { id: '-' }, { id: '>x' }, { id: '>=0', name: 'a' }, { id: '=007' }, { id: '<3', name: '!=a' }];
const sorts = [null, { col: 'id', dir: 'asc' }, { col: 'id', dir: 'desc' }, { col: 'name', dir: 'asc' }];
t('typed column gives the same rows and order as the text column, row path and column path', () => {
  for (const f of filters) for (const s of sorts) {
    const a = runQuery(text, columns, { filters: f, sort: s }), b = runQuery(typed, columns, { filters: f, sort: s });
    const c = runColumnQuery(colsT, text.length, columns, { filters: f, sort: s }), d = runColumnQuery(colsN, text.length, columns, { filters: f, sort: s });
    assert.deepEqual(Array.from(b.indices), Array.from(a.indices), JSON.stringify([f, s]));
    assert.deepEqual(Array.from(d.indices), Array.from(c.indices), JSON.stringify([f, s]));
    assert.deepEqual(Array.from(d.indices), Array.from(a.indices));
    assert.deepEqual(d.errors, c.errors);
  }
});
console.log(n + ' typed checks passed');
