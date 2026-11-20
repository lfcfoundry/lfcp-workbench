// Staged columns: LFC-pack's packBlock(columns) over the typed chunks of src/ingest/columns.mjs stores the same values as today's JSON-lines path
// (typedCell / typedDecimal rules, empty cells, text cells), including blocks cut by pushPacked, and a number column with a text-like cell bails to the JSON path.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildColumns } from '../src/ingest/columns.mjs';
import { typedCell, typedDecimal } from '../src/ingest/infer.mjs';
const lib = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../vendor/lfcp/0.14.2/lfc-pack.js')); await lib.init();
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
  for (const t of ['007,a,1.50,2026-11-01,n\n', '1,a,1.50,2026-11-01\n', '1,a,1.5,2026-11-01,n\n', '1,a,-0.00,2026-11-01,n\n', '-0,a,1.50,2026-11-01,n\n']) {
    const w = B.build(enc.encode(t)), r = buildColumns(enc.encode(t), headers, plan, ',');
    assert.equal(w.bail, r.bail, t); assert.equal(w.n, r.n, t);
  }
  console.log(`ok: wasm column builder equals the JavaScript reference (${chunks} chunks, bail rules)`);
}

// Quoted cells in the wasm builder: quoted cells (also with delimiters, line breaks and CRLF inside) land in the same columns as the character parser makes;
// cells with an escaped quote (""), a backslash, non-ASCII text or a wrong field count stop the chunk at that record (bail 'line') for the character parser.
{
  const { make } = await import('../src/ingest/colbuild.mjs');
  const { readFileSync } = await import('node:fs');
  const { DelimitedParser } = await import('../src/ingest/delimited.mjs');
  const wasm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../wasm/colbuild.wasm'));
  const hs = ['id', 'name', 'score', 'note'], pl = [true, false, 2, false];
  const q = (v) => '"' + v + '"';
  const rec = (i, kind) => {
    const id = String(i), sc = (i % 7 ? ((i % 90) + '.25') : '');
    switch (kind) {
      case 0: return [id, 'plain ' + i, sc, 'n' + i].join(',');
      case 1: return [q(id), q('quoted ' + i), q(sc), q('note ' + i)].join(',');
      case 2: return [q(id), q('has, comma ' + i), sc, q('line\nbreak\r\nand tab\t' + i)].join(',');
      case 3: return [id, q(''), q(''), ''].join(',');
      case 4: return [q(id), q('esc "" quote'), sc, 'x'].join(',');   // weird: escaped quote
      case 5: return [id, 'back\\slash', sc, 'x'].join(',');   // weird: backslash
      case 6: return [id, 'caf\u00e9', sc, 'x'].join(',');   // weird: non-ASCII
      case 7: return [id, 'only two'].join(',');   // weird: wrong field count
      case 8: return [id, 'mid"quote', sc, 'x'].join(',');   // weird: a quote inside an unquoted cell
      default: return [id, q('a'), sc, q('b') + 'x'].join(',');   // weird: text after the closing quote
    }
  };
  const weird = new Set([5, 7, 8, 9]);   // escaped quotes (4) and valid UTF-8 (6) are built by the wasm builder now
  let seed2 = 99; const r2 = () => (seed2 = (seed2 * 1103515245 + 12345) >>> 0) / 4294967296;
  for (const eol of ['\n', '\r\n']) {
    const recs = [], kinds = []; for (let i = 0; i < 4000; i++) { const k = r2() < 0.08 ? 4 + Math.floor(r2() * 6) : Math.floor(r2() * 4); kinds.push(k); recs.push(rec(i, k)); }
    const offs = [0]; const text = recs.map((r) => r + eol).join(''); for (const r of recs) offs.push(offs[offs.length - 1] + enc.encode(r).length + eol.length);
    const bytes = enc.encode(text);
    // oracle: the character parser's cells, one well-formed record at a time
    const oracle = new Map(); for (let k = 0; k < recs.length; k++) if (!weird.has(kinds[k])) { const out = []; new DelimitedParser(',', (f) => out.push(f)).feed(recs[k] + eol, true); assert.equal(out.length, 1); oracle.set(k, out[0]); }
    const B = await make(wasm, hs, pl, ',', { capRows: 512, chunkBytes: 1 << 20 });
    let pos = 0, idx = 0, built = 0, bails = 0;
    while (pos < bytes.length) {
      const w = B.build(bytes.subarray(pos)); let rows = w.n;
      for (let r = 0; r < rows; r++, idx++) {
        assert.ok(!weird.has(kinds[idx]), 'record ' + idx + ' kind ' + kinds[idx] + ' should have stopped the chunk');
        const f = oracle.get(idx);
        const num = (s) => (s === '' ? NaN : typedCell(s)), dec = (s) => (s === '' ? NaN : typedDecimal(s, 2));
        const g = (c) => w.cols[hs[c]];
        const txt = (c) => { const x = g(c); return new TextDecoder().decode(x.bytes.subarray(x.start[r], x.end[r])); };
        assert.deepEqual([g(0)[r], g(2)[r] !== g(2)[r] ? 'NaN' : g(2)[r], txt(1), txt(3)], [num(f[0]), dec(f[2]) !== dec(f[2]) ? 'NaN' : dec(f[2]), f[1], f[3]], 'record ' + idx + ' ' + JSON.stringify(recs[idx]));
        built++;
      }
      assert.equal(w.used, offs[idx] - pos, 'used covers exactly the built records');
      pos = offs[idx];
      if (w.bail === 'line') {  assert.ok(weird.has(kinds[idx]), 'bailed on a well-formed record ' + idx + ' ' + JSON.stringify(recs[idx])); pos = offs[idx + 1]; idx++; bails++; }
      else if (w.bail) assert.fail('unexpected bail ' + w.bail);
      else if (rows === 0 && w.used === 0) { pos = offs[idx + 1]; idx++; }
    }
    // line count: the builder reports the physical lines of the records it built
    const w2 = B.build(enc.encode([rec(1, 2), rec(2, 1)].join(eol) + eol)); assert.equal(w2.n, 2); assert.equal(B.exports.nlines(), 4 + (eol === '\r\n' ? 0 : 0) + 0 - 0, 'physical lines: 2 breaks inside the first record plus 2 record ends');
    console.log(`ok: quoted cells (${eol === '\n' ? 'LF' : 'CRLF'}): ${built} records built, ${bails} weird records stopped the chunk`);
  }
}

// Dictionary columns: a low-variety text column comes back as a code per row plus the distinct values; past 4096 distinct values in a chunk the builder stops (bail 'dict'),
// the column goes back to text, and every cell still reads back as the same text.
{
  const { make } = await import('../src/ingest/colbuild.mjs');
  const { readFileSync } = await import('node:fs');
  const wasm = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../wasm/colbuild.wasm'));
  const hs = ['id', 'tag', 'uid'];
  const B = await make(wasm, hs, [true, false, false], ',', { capRows: 16384, chunkBytes: 1 << 20, dict: [false, true, false] });
  const rows = []; for (let i = 0; i < 12000; i++) rows.push(`${i},${i < 1000 ? 'tag' + (i % 7) : i % 11 === 0 ? '' : 'v' + i},u${i}\n`);
  const bytes = new TextEncoder().encode(rows.join('')), want = rows.map((r) => r.trim().split(',')[1]);
  let pos = 0, idx = 0, dictChunks = 0, textChunks = 0, sawBail = false; const dec = new TextDecoder();
  while (pos < bytes.length) {
    const w = B.build(bytes.subarray(pos)), x = w.arr[1];
    for (let r = 0; r < w.n; r++, idx++) {
      const got = x.codes ? dec.decode(x.lb.bytes.subarray(x.lb.start[x.codes[r]], x.lb.end[x.codes[r]])) : dec.decode(x.bytes.subarray(x.start[r], x.end[r]));
      assert.equal(got, want[idx], 'cell ' + idx);
    }
    if (w.n) { if (x.codes) dictChunks++; else textChunks++; }
    pos += w.used;
    if (w.bail === 'dict') { assert.equal(w.bailcol, 1); B.undict(1); sawBail = true; } else if (w.bail) assert.fail('unexpected bail ' + w.bail + ' at row ' + idx); else if (!w.used) break;
  }
  assert.equal(idx, 12000); assert.ok(sawBail && dictChunks >= 1 && textChunks >= 1, 'dict then text chunks, bail seen');
  console.log(`ok: dictionary columns read back as text (${dictChunks} dictionary chunks, ${textChunks} text chunks after the bail)`);
}
