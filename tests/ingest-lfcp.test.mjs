// New ingest rules -> LFC-pack 0.6.2 -> back, exact. Uses real-world messy CSV.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readRecords } from '../src/ingest/records.mjs';

const lib = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '../vendor/lfcp/0.7.2/lfc-pack.js'));
await lib.init();
const csv = '﻿id,name,score,when,note\r\n1,"Ann, Jr.",9.5,2026-11-05,\r\n\r\n2,Bob,,2026-11-06,"line1\nline2"\r\n3,,7,2026-11-07,ok\r\n\r\n';
const { headers, records, types } = readRecords(csv.replace(/^﻿/, ''));
assert.deepEqual(headers, ['id', 'name', 'score', 'when', 'note']);
assert.equal(records.length, 3);
assert.deepEqual(types.map((t) => t.type), ['integer', 'string', 'number', 'date', 'string']);
assert.deepEqual(types.map((t) => t.nullable), [false, true, true, false, true]);
const packer = lib.packStream({ blockBytes: 262144, share: true, meta: {} });
const parts = [...packer.push(new TextEncoder().encode(records.map((r) => JSON.stringify(r) + '\n').join(''))), ...packer.finish()];
const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0)); let at = 0; for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
assert.deepEqual(JSON.parse(JSON.stringify(lib.unpackRows(bytes))), JSON.parse(JSON.stringify(records)));
assert.throws(() => readRecords('a,b\n1,2\n3\n'), (e) => e.line === 3 && /Row has 1 fields/.test(e.message));
console.log('  ok  messy CSV (BOM-stripped, CRLF, blank lines, quoted newline, empties) round-trips exactly on 0.6.2');
