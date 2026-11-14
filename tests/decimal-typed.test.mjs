// Decimal columns stored as numbers: the text read back is exactly the text imported, in every reader (grid, export, filters, sorts).
//   1. typedDecimal round trip: every token either becomes a number that formats back to itself (formatScaled) or stays the original text.
//   2. The byte-level row builder and the character-parser line builder write the same lines and the same type tallies for decimal and whole-number plans.
//   3. Through lfc-pack: a CSV with a decimal column packed typed, read back with cellFormat, equals the source text cell by cell (including empties).
//   4. Filters and sorts on the typed column give the same row numbers as on the old text column, for every filter shape (contains, =, !=, ranges, empty, not empty) and sorts both ways.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DelimitedParser, cleanHeaders } from '../src/ingest/delimited.mjs';
import { TypeTracker, typedCell, typedDecimal, sampleDecimals, cellFormat, formatScaled } from '../src/ingest/infer.mjs';
import { runQuery } from '../src/query/query.mjs';
import { runColumnQuery } from '../src/query/columnar.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const lib = createRequire(import.meta.url)(join(here, '../vendor/lfcp/0.10.28/lfc-pack.js')); await lib.init();
let seed = 4242; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, ri = (n) => Math.floor(rnd() * n), pick = (a) => a[ri(a.length)];

// 1. round trip
let cells = 0, typed = 0;
const digits = (k) => Array.from({ length: k }, () => ri(10)).join('');
const token = (d) => {
  const r = rnd(), sign = rnd() < 0.3 ? '-' : '';
  if (r < 0.7) return sign + String(ri(10 ** Math.min(13 - d, 9))) + '.' + digits(d).padStart(d, '0');
  if (r < 0.75) return sign + '0.' + '0'.repeat(d);
  if (r < 0.8) return sign + '0'.repeat(1 + ri(2)) + String(ri(100)) + '.' + digits(d);
  if (r < 0.85) return sign + String(ri(1000)) + '.' + digits(d + 1 + ri(2));
  if (r < 0.9) return sign + String(ri(1000)) + (rnd() < 0.5 ? '.' : '') + (d > 1 ? digits(d - 1) : '');
  if (r < 0.93) return sign + digits(8 + ri(8)) + '.' + digits(d);
  if (r < 0.96) return pick(['1e5', '+1.5', '.5', '5.', 'abc', ' 1.50', '1,50', '1.50 ', '١.٥٠', '0x1.8']);
  return '';
};
for (let t = 0; t < 40000; t++) {
  const d = 1 + ri(4), tok = token(d), v = typedDecimal(tok, d);
  cells++; if (typeof v === 'number') typed++;
  const back = v === null ? '' : typeof v === 'number' ? formatScaled(v, d) : v;
  if (typeof v === 'number') assert.equal(v / 10 ** d, Number(tok), `value of ${tok}`);   // the scaled whole number divided by 10^d is the same double as the text
  assert.equal(back, tok, `typedDecimal(${JSON.stringify(tok)}, ${d})`);
  assert.ok(v === null || typeof v === 'number' || v === tok);
}
assert.ok(typed > cells * 0.4, 'a good share of the cells is stored as numbers');

// 2. builders agree
const src = fs.readFileSync(join(here, '../app/worker.js'), 'utf8');
const a = src.indexOf('function numBytes'), b = src.indexOf('// Reads the file in slices'), c = src.indexOf('const NEEDS_ESC'), dd = src.indexOf('const sampleRecord');
const enc = new TextEncoder(), core = { typedDecimal };
const { lineBuilder, makeFast, makeFastW } = new Function('enc', 'typedCell', 'core', src.slice(c, dd) + '\n' + src.slice(a, b) + "\nreturn { lineBuilder, makeFast, makeFastW: typeof makeFastW === 'function' ? makeFastW : null };")(enc, typedCell, core);
let bad = 0, fastRows = 0, wasmRows = 0;
for (let trial = 0; trial < 400; trial++) {
  const nc = 2 + ri(4), kinds = Array.from({ length: nc }, () => pick(['int', 'dec', 'dec', 'text'])), decs = kinds.map(() => 1 + ri(3));
  const plan = kinds.map((k, i) => (k === 'int' ? true : k === 'dec' ? decs[i] : false));
  const lines = [Array.from({ length: nc }, (_, i) => 'c' + i).join(',')]; const nr = 20 + ri(300);
  for (let r = 0; r < nr; r++) lines.push(Array.from({ length: nc }, (_, i) => (kinds[i] === 'int' ? pick([String(ri(1e6)), '-' + ri(100), '0', '-0', '007', '', '1.5']) : kinds[i] === 'dec' ? token(decs[i]) : pick(['x', 'a b', '', 'q' + ri(9)]))).join(','));
  const eol = rnd() < 0.3 ? '\r\n' : '\n', bytes = enc.encode(lines.join(eol) + (rnd() < 0.5 ? eol : ''));
  const run = (fast, wasm) => {
    let headers = null, trackers = null, build = null, F = null, acc = '', out = new Uint8Array(1 << 16), pos = 0;
    const parser = new DelimitedParser(',', (f) => { if (!headers) { headers = cleanHeaders(f); trackers = headers.map(() => new TypeTracker()); build = lineBuilder(headers, plan, trackers, typedCell); if (fast) F = (wasm ? makeFastW : makeFast)(headers, plan, trackers, ','); return; } acc += build(f); });
    const clean = (p) => p.mode === 0 && !p.seen && p.row.length === 0 && p.field === '' && !p.pendingQuote && !p.skipLF, dec = new TextDecoder();
    for (let i = 0; i < bytes.length;) {
      if (F && !F.off && clean(parser)) { if (acc) { const w = enc.encode(acc); out.set(w, pos); pos += w.length; acc = ''; } const io = { buf: out, pos }; i = F.run(bytes, i, Infinity, parser, io); out = io.buf; pos = io.pos; if (i >= bytes.length) break; }
      const k = !headers || (F && !F.off) ? bytes.indexOf(10, i) : -1;
      if (k < 0) { parser.feed(dec.decode(bytes.subarray(i)), false); break; }
      parser.feed(dec.decode(bytes.subarray(i, k + 1), { stream: true }), false); i = k + 1;
    }
    parser.feed('', true); if (acc) { const w = enc.encode(acc); out.set(w, pos); pos += w.length; }
    return { text: new TextDecoder().decode(out.subarray(0, pos)), types: trackers.map((t) => [t.n, t.empty, t.int, t.num, t.bool, t.date].join()).join('|'), frows: F ? F.rows : 0 };
  };
  const A = run(false), B = run(true); fastRows += B.frows;
  const W = makeFastW ? run(true, true) : B; wasmRows += W.frows;
  if (A.text !== B.text || A.types !== B.types || A.text !== W.text || A.types !== W.types) { bad++; if (bad < 3) console.log('DIFF', JSON.stringify(A.text.slice(0, 200)), '\n', JSON.stringify(B.text.slice(0, 200)), A.types, B.types); }
}
assert.equal(bad, 0, 'the byte-level builder and the line builder agree'); assert.ok(fastRows > 5000, 'the byte-level builder ran'); if (makeFastW) assert.ok(wasmRows > 5000, 'the wasm builder ran');

// 3 and 4. through lfc-pack, then queries
const N = 4000, D = 2, texts = [], colText = [];
for (let i = 0; i < N; i++) texts.push(token(D));
const sample = texts.filter((t) => /^-?(0|[1-9]\d*)\.\d{2}$/.test(t) || t === '');
assert.equal(sampleDecimals(sample), D); assert.equal(sampleDecimals([...sample, '1.5']), 0);
const typedRows = texts.map((t, i) => ({ id: i, amt: typedDecimal(t, D) })), textRows = texts.map((t, i) => ({ id: i, amt: t }));   // old stored form: the text itself ('' for an empty cell)
const pack = (rows) => { const p = lib.packStream({ blockBytes: 16384, share: true, meta: {} }); const parts = [...p.push(enc.encode(rows.map((r) => JSON.stringify(r) + '\n').join(''))), ...p.finish()]; const u = new Uint8Array(parts.reduce((x, y) => x + y.byteLength, 0)); let at = 0; for (const x of parts) { u.set(x, at); at += x.byteLength; } return u; };
const tBytes = pack(typedRows), xBytes = pack(textRows);
const read = (bytes) => { const o = { id: [], amt: [] }; for (const e of lib.unpackColumns(bytes, { keys: ['id', 'amt'] })) for (let i = 0; i < e.n; i++) { o.id.push(e.cols.id[i]); o.amt.push(e.cols.amt ? e.cols.amt[i] : null); } return o; };
const tc = read(tBytes), xc = read(xBytes);
for (let i = 0; i < N; i++) assert.equal(cellFormat(tc.amt[i], D), texts[i], `cell ${i}`);   // exact text back, empties included
const typeOf = (rows) => { const tr = new TypeTracker(); for (const r of rows) tr.add(r); return tr.type; };
const type = typeOf(texts);
const colsT = [{ name: 'id', type: 'integer' }, { name: 'amt', type, decimals: D }], colsX = [{ name: 'id', type: 'integer' }, { name: 'amt', type }];
let shapes = 0;
const filters = ['0', '1', '5.5', '5.50', '12.30', '.5', '-', '-1', '9', '99', '.00', '0.0', '10.00', '1.10', '>5', '>=5.5', '>=5.50', '<0', '<=0', '<-1.5', '>1000', '>-3', '=5.50', '=5.5', '=0.00', '=0.0', '=', '!', '!=5.50', '!=0.00', '=-0.00', '>abc', '=1e5'];
const same = (x, y, msg) => { assert.deepEqual(Array.from(x), Array.from(y), msg); shapes++; };
for (const f of filters) {
  for (const sort of [null, { col: 'amt', dir: 'asc' }, { col: 'amt', dir: 'desc' }]) {
    const want = runQuery(textRows, colsX, { filters: { amt: f }, sort }).indices;
    same(runQuery(typedRows.map((r) => ({ id: r.id, amt: r.amt })), colsT, { filters: { amt: f }, sort }).indices, want, `row path ${f} ${JSON.stringify(sort)}`);
    same(runColumnQuery({ id: tc.id, amt: tc.amt }, N, colsT, { filters: { amt: f }, sort }).indices, want, `column path ${f} ${JSON.stringify(sort)}`);
    const top = runColumnQuery({ id: tc.id, amt: tc.amt }, N, colsT, { filters: { amt: f }, sort, top: 50 });
    if (top.first) same(top.first, Array.from(want).slice(0, 50), `first page ${f} ${JSON.stringify(sort)}`);
  }
}
// a text cell in a decimal column makes the column text: sorting is by the formatted text
const mixed = [...texts.slice(0, 500), 'abc', 'x1'], mixedRows = mixed.map((t, i) => ({ id: i, amt: typedDecimal(t, D) })), mixedText = mixed.map((t, i) => ({ id: i, amt: t }));
for (const dir of ['asc', 'desc']) for (const f of ['', '1', '=5.50', '>5']) {
  const w = runQuery(mixedText, [{ name: 'id', type: 'integer' }, { name: 'amt', type: 'string' }], { filters: { amt: f }, sort: { col: 'amt', dir } }).indices;
  same(runQuery(mixedRows, [{ name: 'id', type: 'integer' }, { name: 'amt', type: 'string', decimals: D }], { filters: { amt: f }, sort: { col: 'amt', dir } }).indices, w, `mixed row ${f} ${dir}`);
  same(runColumnQuery({ id: mixed.map((_, i) => i), amt: mixedRows.map((r) => r.amt) }, mixed.length, [{ name: 'id', type: 'integer' }, { name: 'amt', type: 'string', decimals: D }], { filters: { amt: f }, sort: { col: 'amt', dir } }).indices, w, `mixed column ${f} ${dir}`);
}
console.log(`ok: ${cells} tokens, ${typed} stored as numbers; builders agree on 400 files (${fastRows} byte-level rows, ${wasmRows} wasm rows); ${N} cells read back exactly; ${shapes} query results equal`);
