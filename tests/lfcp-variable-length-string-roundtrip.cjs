'use strict';

// Read-only regression investigation for LFC-pack 0.4.19 / API 0.
// This test is expected to exit nonzero against the pinned vendor while the
// known fast-writer defect exists. Set LFCP_PACK_PATH to run the same suite
// against an isolated candidate artifact. It never writes files; LFCP bytes
// remain in memory.

const path = require('node:path');
const libraryPath = process.env.LFCP_PACK_PATH
  ? path.resolve(process.env.LFCP_PACK_PATH)
  : '../vendor/lfcp/0.4.19/lfc-pack.js';
const LfcPack = require(libraryPath);

const failures = [];
const cases = [];
const encoder = new TextEncoder();

function jsonl(rows) {
  return encoder.encode(rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function describe(value, present = true) {
  if (!present) return { type: 'missing-property' };
  if (typeof value === 'string') {
    return {
      type: 'string',
      characters: value.length,
      utf8Bytes: encoder.encode(value).length,
      preview: value.length <= 48 ? value : `${value.slice(0, 20)}…${value.slice(-8)}`
    };
  }
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'object') return { type: 'object', keys: Object.keys(value) };
  return { type: typeof value, value };
}

function compareRows(expected, actual) {
  let mismatchCount = 0;
  const examples = [];
  const addMismatch = (mismatch) => {
    mismatchCount += 1;
    lastExample = mismatch;
    if (examples.length < 3) examples.push(mismatch);
  };
  let lastExample = null;
  const rowCount = Math.max(expected.length, actual.length);
  for (let row = 0; row < rowCount; row += 1) {
    if (row >= expected.length || row >= actual.length) {
      addMismatch({ row, column: '<row>', expected: describe(expected[row]), actual: describe(actual[row]) });
      continue;
    }
    const keys = new Set([...Object.keys(expected[row]), ...Object.keys(actual[row])]);
    for (const column of keys) {
      const expectedHas = Object.prototype.hasOwnProperty.call(expected[row], column);
      const actualHas = Object.prototype.hasOwnProperty.call(actual[row], column);
      const a = expectedHas ? expected[row][column] : undefined;
      const b = actualHas ? actual[row][column] : undefined;
      if (expectedHas !== actualHas || !Object.is(a, b)) {
        addMismatch({
          row,
          column,
          expected: describe(a, expectedHas),
          actual: describe(b, actualHas)
        });
      }
    }
  }
  return { mismatchCount, examples, lastExample };
}

function check(caseResult, label, expectedRows, actualRows) {
  const comparison = compareRows(expectedRows, actualRows);
  const result = { label, status: comparison.mismatchCount ? 'fail' : 'pass', rowCount: actualRows.length, mismatchCount: comparison.mismatchCount };
  if (comparison.mismatchCount) {
    result.examples = comparison.examples;
    result.lastMismatch = comparison.lastExample;
    failures.push({ case: caseResult.name, check: label, mismatchCount: comparison.mismatchCount, firstMismatch: comparison.examples[0], lastMismatch: comparison.lastExample });
  }
  caseResult.checks.push(result);
  return result;
}

function recordArtifact(name, expectedRows, bytes, options = {}) {
  const result = {
    name,
    inputBytes: options.inputBytes,
    lfcpBytes: bytes.byteLength,
    checks: [],
    footerAndCounts: null,
    blockStats: null
  };
  try {
    const info = LfcPack.info(bytes); // Opens and validates the footer through the public reader.
    const stats = LfcPack.stats(bytes);
    result.footerAndCounts = {
      footerAccepted: true,
      expectedRows: expectedRows.length,
      footerRows: info.rows,
      returnedRows: LfcPack.unpackRows(bytes).length,
      blocks: info.blocks,
      formatMajor: info.major,
      formatMinor: info.minor
    };
    result.blockStats = stats;
    if (info.rows !== expectedRows.length || result.footerAndCounts.returnedRows !== expectedRows.length) {
      failures.push({ case: name, check: 'footer-row-count', expectedRows: expectedRows.length, infoRows: info.rows, returnedRows: result.footerAndCounts.returnedRows });
    }
  } catch (error) {
    result.footerAndCounts = { footerAccepted: false, error: String(error && error.message || error) };
    failures.push({ case: name, check: 'footer-open', error: result.footerAndCounts.error });
  }

  check(result, 'unpackRows', expectedRows, LfcPack.unpackRows(bytes));
  check(result, 'unpack', expectedRows, LfcPack.unpack(bytes));

  if (options.checkColumns) {
    const blocks = LfcPack.unpackColumns(bytes);
    const expectedColumn = expectedRows.filter((row) => Object.prototype.hasOwnProperty.call(row, 'body')).map((row) => row.body);
    const actualColumn = blocks.flatMap((block) => block.cols.body || []);
    const columnRowsExpected = expectedColumn.map((body) => ({ body }));
    const columnRowsActual = actualColumn.map((body) => ({ body }));
    check(result, 'unpackColumns:body', columnRowsExpected, columnRowsActual);
    result.columnLengths = { expected: expectedColumn.length, decoded: actualColumn.length };
  }

  if (options.checkText) {
    let textRows;
    try {
      textRows = new TextDecoder().decode(LfcPack.unpackText(bytes)).split('\n').filter(Boolean).map((line) => JSON.parse(line));
      check(result, 'unpackText', expectedRows, textRows);
    } catch (error) {
      result.checks.push({ label: 'unpackText', status: 'error', error: String(error && error.message || error) });
      failures.push({ case: name, check: 'unpackText', error: String(error && error.message || error) });
    }
  }
  cases.push(result);
  return result;
}

function rowSet(values, options = {}) {
  return values.map((body, id) => {
    const row = {};
    if (options.tag !== undefined) row.tag = options.tag;
    if (options.includeId !== false) row.id = id;
    if (body !== options.omitBody) row.body = body;
    if (options.pad !== undefined) row.pad = options.pad;
    return row;
  });
}

function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

async function packStream(input, options = {}, chunkBytes = 17) {
  const writer = LfcPack.packStream(options);
  const parts = [];
  for (let offset = 0; offset < input.length; offset += chunkBytes) {
    parts.push(...writer.push(input.subarray(offset, Math.min(input.length, offset + chunkBytes))));
  }
  parts.push(...writer.finish());
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

async function main() {
  await LfcPack.init();

  // Literal expected values mirror the Phase 3 length cycle without using its PRNG,
  // sampling routine, or expected-value generator.
  const originalLikeValues = [
    '',
    'VTx8vKxt',
    'A'.repeat(40),
    'B'.repeat(256),
    'C'.repeat(1024),
    'D'.repeat(4096)
  ];
  const originalLikeRows = rowSet(originalLikeValues);
  const originalLikeBytes = jsonl(originalLikeRows);
  const originalLikePacked = await LfcPack.packRows(originalLikeRows);
  recordArtifact('phase3-length-cycle-literal-values', originalLikeRows, originalLikePacked, {
    inputBytes: originalLikeBytes.length,
    checkColumns: true,
    checkText: true
  });

  // Four rows are the smallest compact failing fixture observed with a 79-byte
  // ASCII JSONL block: the first empty string disappears from the decoded column.
  const minimalValues = ['', 'A', 'B', 'C'];
  const minimalRows = rowSet(minimalValues);
  const minimalInput = jsonl(minimalRows);
  const packedRows = await LfcPack.packRows(minimalRows);
  const packedText = await LfcPack.pack(minimalInput);
  const packedStream = await packStream(minimalInput);
  const apiComparison = {
    name: 'writer-api-comparison',
    inputBytes: minimalInput.length,
    packRowsEqualsPack: compareBytes(packedRows, packedText),
    packRowsEqualsPackStream: compareBytes(packedRows, packedStream),
    checks: []
  };
  if (!apiComparison.packRowsEqualsPack) failures.push({ case: apiComparison.name, check: 'packRows-vs-pack-bytes' });
  if (!apiComparison.packRowsEqualsPackStream) failures.push({ case: apiComparison.name, check: 'packRows-vs-packStream-bytes' });
  cases.push(apiComparison);
  recordArtifact('minimal-packRows', minimalRows, packedRows, { inputBytes: minimalInput.length, checkColumns: true, checkText: true });
  recordArtifact('minimal-pack', minimalRows, packedText, { inputBytes: minimalInput.length });
  recordArtifact('minimal-packStream', minimalRows, packedStream, { inputBytes: minimalInput.length });

  // Controls for writer/layout selection. WebAssembly is hidden only for the
  // synchronous call so packMany uses the JavaScript flat writer; it is restored
  // immediately and does not alter library or repository files.
  const savedWebAssembly = global.WebAssembly;
  let jsFlat;
  try {
    global.WebAssembly = undefined;
    jsFlat = await LfcPack.packRows(minimalRows, { block: 'flat', templates: false });
  } finally {
    global.WebAssembly = savedWebAssembly;
  }
  recordArtifact('control-javascript-flat-writer', minimalRows, jsFlat, { inputBytes: minimalInput.length, checkColumns: true });
  const nested = await LfcPack.packRows(minimalRows, { block: 'nested' });
  recordArtifact('control-nested-block-writer', minimalRows, nested, { inputBytes: minimalInput.length });

  // A source shorter than the fast-writer's 64-byte guard passes. Padding the
  // same three logical rows invokes the fast path and reproduces data loss.
  const shortRows = rowSet(['', 'A', 'B']);
  const shortBytes = jsonl(shortRows);
  recordArtifact('control-three-rows-under-fast-path-size-guard', shortRows, await LfcPack.packRows(shortRows), { inputBytes: shortBytes.length });
  const twoRows = rowSet(['', 'V1'], { pad: 'p'.repeat(25) });
  recordArtifact('control-two-rows-over-fast-path-size-guard', twoRows, await LfcPack.packRows(twoRows, { templates: false }), {
    inputBytes: jsonl(twoRows).length
  });
  const paddedRows = rowSet(['', 'A', 'B'], { pad: 'p'.repeat(25) });
  const paddedBytes = jsonl(paddedRows);
  recordArtifact('trigger-three-rows-over-fast-path-size-guard', paddedRows, await LfcPack.packRows(paddedRows, { templates: false }), { inputBytes: paddedBytes.length });
  const oneFieldRows = rowSet(['', 'A'.repeat(20), 'B'.repeat(20), 'C'.repeat(20)], { includeId: false });
  recordArtifact('trigger-one-column-flat-block', oneFieldRows, await LfcPack.packRows(oneFieldRows, { templates: false }), {
    inputBytes: jsonl(oneFieldRows).length,
    checkColumns: true
  });
  const threeFieldRows = rowSet(['', 'A', 'B', 'C'], { tag: 'constant', pad: 'pad' });
  recordArtifact('trigger-body-in-multiple-column-flat-block', threeFieldRows, await LfcPack.packRows(threeFieldRows, { templates: false }), {
    inputBytes: jsonl(threeFieldRows).length,
    checkColumns: true
  });

  // String-length boundary matrix. All expected values are deterministic and
  // independently constructed from the listed lengths, not sampled from output.
  for (const length of [1, 7, 8, 9, 39, 40, 41, 255, 256, 257, 1023, 1024, 1025, 4095, 4096, 4097]) {
    const tokens = length === 1
      ? ['A', 'B', 'C']
      : ['A', 'B', 'C'].map((prefix) => prefix + 'x'.repeat(length - 1));
    const rows = rowSet(['', ...tokens]);
    const input = jsonl(rows);
    recordArtifact(`ascii-length-boundary-${length}`, rows, await LfcPack.packRows(rows, { templates: false }), {
      inputBytes: input.length,
      checkColumns: true
    });
  }

  // Encoding-selection and positional controls.
  const positional = [
    { name: 's-type-first-empty-then-unique', values: ['', 'A', 'B', 'C'] },
    { name: 's-type-first-empty-with-repeats', values: ['', 'A', 'A', 'A'] },
    { name: 's-type-first-empty-repeated-pattern-control', values: ['', 'A', 'B', 'A'] },
    { name: 's-type-empty-middle-control', values: ['A', 'B', '', 'C'] },
    { name: 's-type-two-leading-empty-control', values: ['', '', 'A', 'B'] },
    { name: 'dictionary-type-empty-control', values: ['', 'A', 'A', 'A', 'A', 'A', 'A', 'A'] }
  ];
  for (const item of positional) {
    const rows = rowSet(item.values);
    const input = jsonl(rows);
    recordArtifact(item.name, rows, await LfcPack.packRows(rows, { templates: false }), {
      inputBytes: input.length,
      checkColumns: true
    });
  }

  // Raise string cardinality while holding row count and empty position fixed.
  for (let distinct = 2; distinct <= 8; distinct += 1) {
    const values = [''];
    for (let row = 1; row < 8; row += 1) values.push(row < distinct ? `v${row}` : 'v1');
    const rows = rowSet(values);
    recordArtifact(`cardinality-8-rows-${distinct}-distinct-values`, rows, await LfcPack.packRows(rows, { templates: false }), {
      inputBytes: jsonl(rows).length,
      checkColumns: true
    });
  }

  const allEmptyRows = rowSet(['', '', '', '']);
  recordArtifact('all-empty-string-frequency-control', allEmptyRows, await LfcPack.packRows(allEmptyRows, { templates: false }), {
    inputBytes: jsonl(allEmptyRows).length,
    checkColumns: true
  });
  const twelveRows = rowSet(['', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
  recordArtifact('row-count-12-unique-ascii-control', twelveRows, await LfcPack.packRows(twelveRows, { templates: false }), {
    inputBytes: jsonl(twelveRows).length,
    checkColumns: true
  });

  const utf8Rows = rowSet(['', 'é', '🧪', 'Z']);
  recordArtifact('utf8-character-versus-byte-control', utf8Rows, await LfcPack.packRows(utf8Rows, { templates: false }), {
    inputBytes: jsonl(utf8Rows).length,
    checkColumns: true
  });
  const nullRows = [{ id: 0, body: '' }, { id: 1, body: null }, { id: 2, body: 'B' }, { id: 3, body: 'C' }];
  recordArtifact('null-value-control', nullRows, await LfcPack.packRows(nullRows, { templates: false }), { inputBytes: jsonl(nullRows).length });
  const missingRows = [{ id: 0 }, { id: 1, body: 'A' }, { id: 2, body: 'B' }, { id: 3, body: 'C' }];
  recordArtifact('missing-property-control', missingRows, await LfcPack.packRows(missingRows, { templates: false }), { inputBytes: jsonl(missingRows).length });

  // Two separate flat blocks, each beginning with the same empty-first pattern.
  const blockRows = minimalRows.concat(minimalRows.map((row, i) => ({ id: i + 4, body: row.body })));
  const blockInput = jsonl(blockRows);
  const blockStream = await packStream(blockInput, { blockBytes: 64 }, 17);
  recordArtifact('packStream-two-blocks-empty-first-per-block', blockRows, blockStream, {
    inputBytes: blockInput.length,
    checkColumns: true
  });
  const blockParallel = await LfcPack.packParallel(blockInput, { blockBytes: 64, workers: 2, templates: false });
  const parallelComparison = {
    name: 'parallel-writer-comparison',
    inputBytes: blockInput.length,
    packStreamEqualsPackParallel: compareBytes(blockStream, blockParallel),
    checks: []
  };
  cases.push(parallelComparison);
  recordArtifact('packParallel-two-blocks-empty-first-per-block', blockRows, blockParallel, {
    inputBytes: blockInput.length,
    checkColumns: true
  });

  const report = {
    schema: 'lfcp-workbench-variable-string-investigation/v1',
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    library: { package: 'LFC-pack', version: LfcPack.version, apiVersion: LfcPack.apiVersion, path: require.resolve(libraryPath) },
    source: { repository: 'JS-modules', version: '0.4.19 / API 0', commit: '6e16aa8044d0a05bafa7c756c949f3537c23e92a', blob: 'dae1cf4a7d9f6f568ea05447f57e9158e7396091' },
    result: failures.length ? 'fail' : 'pass',
    failedChecks: failures.length,
    failures,
    cases
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 2;
});
