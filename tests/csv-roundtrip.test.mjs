// End-to-end data-fidelity check of the spike's ingest path in Node:
// CSV text -> DelimitedParser -> JSON lines -> LfcPack.packStream -> unpackRows.
// Mirrors experiments/lfcp-first-spike/worker.js (same calls). Pass/fail only.
// Usage: node tests/csv-roundtrip.test.mjs [path-to-lfc-pack.js] [--expect-loss]
// Default library: vendor 0.4.21. --expect-loss: informational run for the 0.4.19 pin (shows which shapes lose data).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(process.argv[2] || join(here, '../vendor/lfcp/0.4.21/lfc-pack.js'));
const expectLoss = process.argv.includes('--expect-loss');
const ctx = { self: {} };
vm.runInNewContext(readFileSync(join(here, '../experiments/lfcp-first-spike/src/adapters.js'), 'utf8'), ctx);
const A = ctx.self.DataWorkbenchAdapters;
const LfcPack = createRequire(import.meta.url)(libPath);
await LfcPack.init();

async function roundTrip(csv) {
  const rows = []; let headers = null;
  const p = new A.DelimitedParser(',', (f) => {
    if (!headers) { headers = A.cleanHeaders(Array.from(f)); return; }
    const o = Object.create(null); headers.forEach((h, i) => { o[h] = f[i]; }); rows.push(o);
  });
  p.feed(csv, true);
  const packer = LfcPack.packStream({ blockBytes: 262144, share: true, meta: { tables: [] } });
  const parts = [...packer.push(new TextEncoder().encode(rows.map((r) => JSON.stringify(r) + '\n').join(''))), ...packer.finish()];
  const bytes = new Uint8Array(parts.reduce((n, x) => n + x.byteLength, 0)); let at = 0;
  for (const x of parts) { bytes.set(x, at); at += x.byteLength; }
  const back = LfcPack.unpackRows(bytes);
  return { rows, back };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const cases = {
  'one leading empty, 12 unique values (documented trigger)': 'id,note\n' + Array.from({ length: 13 }, (_, i) => `${i},${i ? 'value-' + i : ''}`).join('\n') + '\n',
  'one leading empty, A B C, long ids (documented trigger)': 'id,note\n' + ['', 'A', 'B', 'C'].map((v, i) => `${'x'.repeat(40) + i},${v}`).join('\n') + '\n',
  'leading empty cells in a text column': 'id,note\n1,\n2,\n3,hello\n4,world\n',
  'empty cells in the middle and end': 'id,note\n1,a\n2,\n3,b\n4,\n',
  'all-empty text column': 'id,note\n1,\n2,\n3,\n',
  'mixed lengths, leading empties (200 rows)': 'id,note\n' + Array.from({ length: 200 }, (_, i) => `${i},${i < 3 ? '' : 'v'.repeat(i % 37)}`).join('\n') + '\n',
  'id-like 36-char strings with leading empties': 'id,u\n1,\n2,\n3,123e4567-e89b-12d3-a456-426614174000\n',
};
let failed = 0;
for (const [name, csv] of Object.entries(cases)) {
  const { rows, back } = await roundTrip(csv);
  const ok = same(rows, back);
  const pass = expectLoss ? true : ok; // with --expect-loss the run is informational (the defect is shape-dependent)
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${ok ? 'lossless' : 'DATA DIFFERS'})`);
}
console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} as expected${expectLoss ? ' (informational)' : ''}`);
process.exit(failed ? 1 : 0);
