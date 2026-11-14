// 0.10 null-plane files (format minor 1): the pinned 0.10.18 writes and reads them, and still reads files written by 0.7.2.
// 0.7.2 cannot open a null-plane file; that is why the Workbench moved to 0.10.18.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url)), req = createRequire(import.meta.url);
const load = (v) => req(join(here, `../vendor/lfcp/${v}/lfc-pack.js`));
const [oldL, newL] = [load('0.7.2'), load('0.10.18')]; await Promise.all([oldL.init(), newL.init()]);
const pack = (L, rows, blockBytes = 4096) => { const p = L.packStream({ blockBytes, share: true, meta: {} }); const parts = [...p.push(new TextEncoder().encode(rows.map((r) => JSON.stringify(r) + '\n').join(''))), ...p.finish()]; const b = new Uint8Array(parts.reduce((n, x) => n + x.byteLength, 0)); let at = 0; for (const x of parts) { b.set(x, at); at += x.byteLength; } return b; };
const rows = Array.from({ length: 3000 }, (_, i) => ({ id: i, score: i % 7 === 0 ? null : i * 0.5, name: i % 5 === 0 ? null : 'n' + i, note: i % 3 === 0 ? '' : 'ok' }));
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const nb = pack(newL, rows); same(newL.unpackRows(nb), rows);
let oldOpens = true; try { same(oldL.unpackRows(nb), rows); } catch { oldOpens = false; }
const ob = pack(oldL, rows); same(newL.unpackRows(ob), rows); // files stored by earlier Workbench versions still open
const cols = newL.unpackColumns(nb, { keys: ['id', 'score'] }); assert.ok(cols);
console.log(`  ok  0.10.18 null-plane file: round trip exact; 0.7.2 opens it: ${oldOpens}; 0.10.18 reads a 0.7.2 file exactly; unpackColumns works`);
