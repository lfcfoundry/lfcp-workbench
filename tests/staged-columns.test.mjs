// Staged columns: LFC-pack's packBlock(columns) over the typed chunks of src/ingest/columns.mjs stores the same values as today's JSON-lines path
// (typedCell / typedDecimal rules, empty cells, text cells), including blocks cut by pushPacked, and a number column with a text-like cell bails to the JSON path.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildColumns } from '../src/ingest/columns.mjs';
import { typedCell, typedDecimal } from '../src/ingest/infer.mjs';
const lib = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../vendor/lfcp/0.10.30/lfc-pack.js')); await lib.init();
const enc = new TextEncoder();
let seed = 4242; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, ri = (n) => Math.floor(rnd() * n);
const headers = ['id', 'name', 'score', 'when', 'note'], plan = [true, false, 2, false, false];
const mk = (n, mixed) => {
  const lines = ['id,name,score,when,note'];
  for (let i = 0; i < n; i++) lines.push([i - 100, ri(10) === 0 ? '' : 'name ' + 'x'.repeat(i % 17), ri(7) === 0 ? '' : ((ri(2000) - 500) / 100).toFixed(2), '2026-11-' + String(1 + i % 28).padStart(2, '0'), ri(9) === 0 ? '' : 'note ' + i].join(','));
  if (mixed) lines[Math.floor(n / 2)] = '007,a,1.50,2026-11-01,n';
  return lines.join('\n') + '\n';
};
const today = (text) => {   // the JSON-lines path's values
  const rows = text.trimEnd().split('\n').slice(1).map((l) => l.split(','));
  return rows.map((f) => ({ id: typedCell(f[0]), name: f[1], score: typedDecimal(f[2], 2), when: f[3], note: f[4] }));
};
let blocks = 0;
for (const n of [1, 5, 60, 2500]) {
  const text = mk(n, false), body = enc.encode(text), hdrEnd = body.indexOf(10) + 1, data = body.subarray(hdrEnd);
  // whole data in one chunk, and in pieces cut at line ends
  for (const pieces of [1, 3, 7]) {
    const cuts = [0]; for (let k = 1; k < pieces; k++) { let c = Math.floor((data.length * k) / pieces); while (c < data.length && data[c - 1] !== 10) c++; if (c > cuts[cuts.length - 1] && c < data.length) cuts.push(c); } cuts.push(data.length);
    const ps = []; let total = 0;
    for (let k = 0; k + 1 < cuts.length; k++) {
      const part = data.slice(cuts[k], cuts[k + 1]), ch = buildColumns(part, headers, plan, ',');
      assert.equal(ch.bail, null); assert.equal(ch.used, part.length); total += ch.n;
      ps.push(await lib.packBlock(ch.cols, { share: false, level: 3 }));
    }
    assert.equal(total, n);
    const st = lib.packStream({ blockBytes: 1 << 30, share: false, level: 3, meta: {} }); const out = [];
    for (const p of ps) out.push(...st.pushPacked(p)); out.push(...st.finish());
    const u = new Uint8Array(out.reduce((a, x) => a + x.byteLength, 0)); let at = 0; for (const x of out) { u.set(x, at); at += x.byteLength; }
    const got = lib.unpackRows(u), want = today(text);
    assert.equal(got.length, n);
    for (let r = 0; r < n; r++) {   // empties: number cells read null, text cells read ""
      const g = got[r], w = want[r];
      assert.deepEqual([g.id, g.name, g.score, g.when, g.note], [w.id, w.name, w.score, w.when, w.note], `n=${n} pieces=${pieces} row ${r}`);
    }
    blocks += ps.length;
  }
}
// bail rules
assert.equal(buildColumns(enc.encode('007,a,1.50,2026-11-01,n\n'), headers, plan, ',').bail, 'mixed');
assert.equal(buildColumns(enc.encode('1,"q",1.50,2026-11-01,n\n'), headers, plan, ',').bail, 'line');
assert.equal(buildColumns(enc.encode('1,a,1.50,2026-11-01\n'), headers, plan, ',').bail, 'line');
const part = buildColumns(enc.encode('1,a,1.50,2026-11-01,n\n2,b,2.50,2026-11-02,m\n3,c,3'), headers, plan, ',');
assert.equal(part.n, 2); assert.equal(part.bail, null);   // an unfinished last line waits
console.log(`ok: staged columns through packBlock equal the JSON-lines values (${blocks} packed chunks, bail rules)`);
// WebAssembly builder equals the JavaScript reference chunk by chunk
{
  const { make } = await import('../src/ingest/colbuild.mjs');
  const { readFileSync } = await import('node:fs');
  const wasm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../wasm/colbuild.wasm'));
  const B = await make(wasm, headers, plan, ',', { capRows: 4096 });
  let chunks = 0;
  for (const n of [1, 7, 300, 3000]) {
    const text = mk(n, false), body = enc.encode(text), data = body.subarray(body.indexOf(10) + 1);
    const w = B.build(data), r = buildColumns(data, headers, plan, ',');
    assert.equal(w.bail, r.bail); assert.equal(w.n, r.n); assert.equal(w.used, r.used);
    for (const h of headers) {
      const a = w.cols[h], b = r.cols[h];
      if (a instanceof Float64Array) assert.deepEqual(Array.from(a, (x) => (x !== x ? 'NaN' : x)), Array.from(b, (x) => (x !== x ? 'NaN' : x)), `${h} n=${n}`);
      else { const sa = Array.from(a.start, (s, i) => new TextDecoder().decode(a.bytes.subarray(s, a.end[i]))), sb = Array.from(b.start, (s, i) => new TextDecoder().decode(b.bytes.subarray(s, b.end[i]))); assert.deepEqual(sa, sb, `${h} n=${n}`); }
    }
    chunks++;
  }
  // bail rules agree
  for (const t of ['007,a,1.50,2026-11-01,n\n', '1,"q",1.50,2026-11-01,n\n', '1,a,1.50,2026-11-01\n', '1,a,1.5,2026-11-01,n\n', '1,a,-0.00,2026-11-01,n\n', '-0,a,1.50,2026-11-01,n\n', '1,a,1.50,2026-11-01,é\n']) {
    const w = B.build(enc.encode(t)), r = buildColumns(enc.encode(t), headers, plan, ',');
    assert.equal(w.bail, r.bail, t); assert.equal(w.n, r.n, t);
  }
  console.log(`ok: wasm column builder equals the JavaScript reference (${chunks} chunks, bail rules)`);
}
