'use strict';

// Corrected-copy regression. The pinned vendor artifact remains the Phase 5
// baseline; every fixture is also run against it to record before/after results.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vendor = require('../vendor/lfcp/0.4.19/lfc-pack.js');
const fixed = require('../experiments/fixes/lfc-pack-0.4.19-string-writer/lfc-pack-fixed.js');

const resultPath = path.resolve(__dirname, '../benchmarks/results/phase-6-string-writer-fix-final-v2-20261102.json');
const padding = 'p'.repeat(80); // Ensures the source exceeds writeFlatBlockFast's 64-byte guard, including one-row cases.
const fixtureCases = [
  { name: 'early-join-empty-first-unique', values: ['', 'A', 'B', 'C'], branch: 'early-more-than-half-distinct' },
  { name: 'early-join-empty-middle', values: ['A', '', 'B', 'C'], branch: 'early-more-than-half-distinct' },
  { name: 'early-join-empty-final', values: ['A', 'B', 'C', ''], branch: 'early-more-than-half-distinct' },
  { name: 'postscan-join-consecutive-empties', values: ['', '', 'A', '', 'B', ''], branch: 'post-scan-all-values' },
  { name: 'all-values-empty', values: ['', '', '', ''], branch: 'non-join-fallback-control' },
  { name: 'single-empty', values: [''], branch: 'single-value-control' },
  { name: 'ordinary-nonempty-strings', values: ['A', 'B', 'C', 'D'], branch: 'early-join-nonempty-first-control' },
  { name: 'postscan-mixed-empty-nonempty', values: ['', 'A', '', 'B', ''], branch: 'post-scan-all-values' },
  { name: 'postscan-low-cardinality', values: ['', 'A', 'A', 'A'], branch: 'post-scan-all-values' },
  { name: 'dictionary-empty-first-control', values: ['', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1'], branch: 'dictionary-control' },
  ...Array.from({ length: 7 }, (_, i) => {
    const distinct = i + 2;
    const values = [''];
    for (let row = 1; row < 8; row += 1) values.push(row < distinct ? `v${row}` : 'v1');
    return { name: `cardinality-sweep-${distinct}-distinct`, values, branch: `cardinality-${distinct}` };
  }),
  { name: 'javascript-flat-fallback-control', values: ['', 'A', 'B', 'C'], branch: 'javascript-flat-fallback', mode: 'fallback' },
  { name: 'nested-block-control', values: ['', 'A', 'B', 'C'], branch: 'nested-block', mode: 'nested' }
];

function makeRows(values) {
  return values.map((body, id) => ({ id, body, pad: padding }));
}

function equalRows(expected, actual) {
  try {
    assert.deepStrictEqual(actual, expected);
    return { equal: true, mismatchCount: 0, firstMismatch: null };
  } catch {
    const n = Math.max(expected.length, actual.length);
    let mismatchCount = 0;
    let firstMismatch = null;
    for (let row = 0; row < n; row += 1) {
      if (row >= expected.length || row >= actual.length || !actual[row] || !expected[row] ||
          !Object.hasOwn(actual[row], 'body') || !Object.is(actual[row].body, expected[row].body)) {
        mismatchCount += 1;
        if (!firstMismatch) firstMismatch = {
          row,
          expected: expected[row] && expected[row].body,
          actual: actual[row] && actual[row].body
        };
      }
    }
    return { equal: false, mismatchCount, firstMismatch };
  }
}

function equalValues(expected, actual) {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

async function pack(lib, rows, mode) {
  if (mode === 'nested') return lib.packRows(rows, { block: 'nested', templates: false });
  if (mode === 'fallback') {
    const saved = global.WebAssembly;
    try {
      global.WebAssembly = undefined;
      return await lib.packRows(rows, { block: 'flat', templates: false });
    } finally {
      global.WebAssembly = saved;
    }
  }
  return lib.packRows(rows, { block: 'flat', templates: false });
}

async function inspect(lib, rows, mode) {
  const bytes = await pack(lib, rows, mode);
  const info = lib.info(bytes);
  const decoded = lib.unpackRows(bytes);
  const expectedValues = rows.map((row) => row.body);
  const columnBlocks = mode === 'nested' ? [] : lib.unpackColumns(bytes);
  const bodyColumn = columnBlocks.flatMap((block) => block.cols.body || []);
  return {
    bytes,
    result: {
      footerAccepted: true,
      footerRows: info.rows,
      decodedRows: decoded.length,
      decodedValues: decoded.map((row) => row.body),
      columnValues: bodyColumn,
      stats: lib.stats(bytes),
      rowComparison: equalRows(rows, decoded),
      columnValuesChecked: mode !== 'nested',
      columnValuesEqual: mode === 'nested' ? null : equalValues(expectedValues, bodyColumn)
    }
  };
}

async function main() {
  await vendor.init();
  await fixed.init();
  const records = [];
  for (const fixture of fixtureCases) {
    const rows = makeRows(fixture.values);
    const before = await inspect(vendor, rows, fixture.mode);
    const after = await inspect(fixed, rows, fixture.mode);
    assert.equal(after.result.footerRows, rows.length, `${fixture.name}: fixed footer row count`);
    assert.equal(after.result.decodedRows, rows.length, `${fixture.name}: fixed decoded row count`);
    assert.equal(after.result.rowComparison.equal, true, `${fixture.name}: fixed decoded rows`);
    if (fixture.mode !== 'nested') assert.deepStrictEqual(after.result.columnValues, fixture.values, `${fixture.name}: fixed decoded column values`);
    const bodyType = after.result.stats.flatMap((block) => block.keys || []).find((column) => column.key === 'body')?.type;
    if (fixture.branch === 'early-more-than-half-distinct' || fixture.branch === 'post-scan-all-values') {
      assert.equal(bodyType, 's', `${fixture.name}: exercises the joined string-column representation`);
    }
    if (fixture.branch === 'dictionary-control' || fixture.branch === 'cardinality-2') {
      assert.equal(bodyType, 'D', `${fixture.name}: preserves the dictionary encoding control`);
    }
    records.push({
      name: fixture.name,
      branch: fixture.branch,
      mode: fixture.mode || 'optimized-flat',
      expectedValues: fixture.values,
      vendorBefore: { ...before.result, bytes: undefined, outputBytes: before.bytes.length },
      fixedAfter: { ...after.result, bytes: undefined, outputBytes: after.bytes.length },
      outputBytesIdentical: Buffer.compare(Buffer.from(before.bytes), Buffer.from(after.bytes)) === 0
    });
  }

  const result = {
    schema: 'lfcp-workbench-phase6-string-writer-fix/v1',
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, clang: '21.1.8 wasm32 target' },
    artifact: {
      vendorSha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../vendor/lfcp/0.4.19/lfc-pack.js'))).digest('hex'),
      fixedCopySha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../experiments/fixes/lfc-pack-0.4.19-string-writer/lfc-pack-fixed.js'))).digest('hex')
    },
    summary: {
      cases: records.length,
      fixedCasesPassed: records.filter((record) => record.fixedAfter.rowComparison.equal && (record.fixedAfter.columnValuesEqual === null || record.fixedAfter.columnValuesEqual)).length,
      vendorCasesWithMismatch: records.filter((record) => !record.vendorBefore.rowComparison.equal || record.vendorBefore.columnValuesEqual === false).length
    },
    cases: records
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 1;
});
