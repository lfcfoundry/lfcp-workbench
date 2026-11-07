// The fast CSV reader and type check must behave exactly like the frozen originals: same rows, same line numbers, same errors,
// for random messy text cut at random places, and same suggested types for random value lists.
import assert from 'node:assert/strict';
import { DelimitedParser as New } from '../src/ingest/delimited.mjs';
import { TypeTracker as NewT } from '../src/ingest/infer.mjs';
import { DelimitedParser as Old } from './fixtures/reference/delimited-v1.mjs';
import { TypeTracker as OldT } from './fixtures/reference/infer-v1.mjs';
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const alpha = ['a', 'b', ' ', ',', ',', '"', '"', '\n', '\r', '\r\n', 'xyz', '\t', ';', 'é', '☃'];
const run = (P, d, chunks) => { const rows = []; let err = null; try { const p = new P(d, (r, l) => rows.push([r, l])); chunks.forEach((c, k) => p.feed(c, k === chunks.length - 1)); if (!chunks.length) p.feed('', true); } catch (e) { err = e.message; } return JSON.stringify({ rows, err }); };
let cases = 0, withRows = 0;
for (let t = 0; t < 20000; t++) {
  let s = ''; const len = Math.floor(rnd() * 40); for (let i = 0; i < len; i++) s += alpha[Math.floor(rnd() * alpha.length)];
  const d = rnd() < 0.2 ? '\t' : rnd() < 0.2 ? ';' : ','; const cuts = []; for (let at = 0; at < s.length; at += 1 + Math.floor(rnd() * 6)) cuts.push(s.slice(at, at + 6));
  const cut2 = []; let at = 0; while (at < s.length) { const k = 1 + Math.floor(rnd() * 6); cut2.push(s.slice(at, at + k)); at += k; }
  for (const chunks of [[s], cut2]) { const a = run(Old, d, chunks); assert.equal(run(New, d, chunks), a, 'reader differs on ' + JSON.stringify(s)); cases++; if (a.includes('"rows":[[')) withRows++; }
}
console.log('  ok  reader: ' + cases + ' random inputs identical (' + withRows + ' produced rows)');
const pool = ['', '0', '12', '-7', '3.5', '1e5', 'true', 'FALSE', 'abc', '2026-11-05', '2026-11-05 10:00', '2026-02-31', '2026-13-01', '2026-11-05T10:00:00Z', '007', '12345678901234567890', ' 5', 'x'];
for (let t = 0; t < 5000; t++) {
  const a = new OldT(), b = new NewT(), n = 1 + Math.floor(rnd() * 12), base = pool[Math.floor(rnd() * pool.length)];
  for (let i = 0; i < n; i++) { const v = rnd() < 0.6 ? base : pool[Math.floor(rnd() * pool.length)]; a.add(v); b.add(v); }
  assert.deepEqual([b.type, b.nullable, b.n], [a.type, a.nullable, a.n]);
}
console.log('  ok  type check: 5000 random value lists give the same type and nullable');
