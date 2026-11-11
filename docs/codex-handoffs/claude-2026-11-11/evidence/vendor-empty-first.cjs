// Copyright (c) 2026 LFC Foundry. MIT License.
const assert = require('node:assert/strict');
const path = require('node:path');

async function run(artifact) {
  const lib = require(path.resolve(artifact));
  await lib.init();
  const cases = [
    { name: 'empty-first-distinct', values: ['', 'A', 'B', 'C'] },
    { name: 'mixed-length-without-empty', values: ['X', 'VTx8vKxt', 'A'.repeat(40), 'B'.repeat(256), 'C'.repeat(1024), 'D'.repeat(4096)] },
    { name: 'mixed-length-with-empty', values: ['', 'VTx8vKxt', 'A'.repeat(40), 'B'.repeat(256), 'C'.repeat(1024), 'D'.repeat(4096)] },
  ];
  const results = [];
  for (const item of cases) {
    const rows = item.values.map((body, id) => ({ id, body, pad: 'p'.repeat(80) }));
    const bytes = lib.packRows(rows, { block: 'flat', templates: false });
    const decoded = lib.unpackRows(bytes);
    const columns = lib.unpackColumns(bytes).flatMap((block) => block.cols.body || []);
    const rowEqual = decoded.length === rows.length && decoded.every((row, i) => row.body === rows[i].body);
    const columnEqual = columns.length === rows.length && columns.every((value, i) => value === rows[i].body);
    results.push({ name: item.name, rows: rows.length, outputBytes: bytes.length, rowEqual, columnEqual, decodedValues: decoded.map((row) => row.body?.length ?? null) });
  }
  return { artifact, version: lib.version, results };
}

(async () => {
  const results = [];
  for (const artifact of process.argv.slice(2)) results.push(await run(artifact));
  assert.equal(results.length > 0, true);
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
