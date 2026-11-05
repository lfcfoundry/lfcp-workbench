'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vendor = require('../../../vendor/lfcp/0.4.19/lfc-pack.js');
const instrumented = require('./lfc-pack-instrumented.js');

const outputPath = path.resolve(__dirname, '../../../benchmarks/results/phase-5-optimized-string-writer-final-v3-20261102.json');
const enc = new TextEncoder();
const diagnostics = [];
const checks = [];

function jsonl(rows) {
  return enc.encode(rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function summarizeValue(value) {
  if (typeof value !== 'string') return { type: value === null ? 'null' : typeof value, value };
  return { type: 'string', characters: value.length, utf8Bytes: enc.encode(value).length, value: value.length <= 64 ? value : `${value.slice(0, 24)}…(${value.length} chars)…${value.slice(-8)}` };
}

function compareRows(expected, actual) {
  const mismatches = [];
  const count = Math.max(expected.length, actual.length);
  for (let i = 0; i < count; i += 1) {
    const wanted = expected[i];
    const got = actual[i];
    if (!wanted || !got) {
      mismatches.push({ row: i, expected: wanted || null, actual: got || null });
      continue;
    }
    for (const key of new Set([...Object.keys(wanted), ...Object.keys(got)])) {
      const eh = Object.prototype.hasOwnProperty.call(wanted, key);
      const ah = Object.prototype.hasOwnProperty.call(got, key);
      if (eh !== ah || !Object.is(wanted[key], got[key])) {
        mismatches.push({ row: i, column: key, expected: summarizeValue(eh ? wanted[key] : undefined), actual: summarizeValue(ah ? got[key] : undefined) });
      }
    }
  }
  return mismatches;
}

function valuesForCardinality(distinct) {
  const values = [''];
  for (let row = 1; row < 8; row += 1) values.push(row < distinct ? `v${row}` : 'v1');
  return values;
}

function rowsFor(values, { includeId = true } = {}) {
  return values.map((body, id) => includeId ? { id, body } : { body });
}

function byteHash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function copyDiagnosticHook(events) {
  instrumented._setDiagnosticHook((event) => events.push(event));
}

function clearDiagnosticHook() {
  instrumented._setDiagnosticHook(null);
}

function branchFromStrdictEvent(inputEvent, outputEvent) {
  if (!inputEvent || !outputEvent) return 'not-observed';
  const n = inputEvent.detail.stringCount;
  const distinct = new Set(inputEvent.detail.values.map((x) => x.value)).size;
  if (outputEvent.detail.returnDistinct === 0 && outputEvent.detail.resultWords[2] === 1) return 'more-than-half-distinct all-values join';
  if (outputEvent.detail.returnDistinct > 0 && outputEvent.detail.returnDistinct * 4 > n) return 'more-than-quarter-distinct all-values join';
  if (outputEvent.detail.returnDistinct > 0) return 'dictionary labels and indices';
  return `fallback after strdict; ${distinct} distinct values`;
}

async function packWithTrace(name, expectedRows, writerOptions = {}, mode = 'fast') {
  const input = jsonl(expectedRows);
  const inputBytes = input.length;
  const traceEvents = [];
  copyDiagnosticHook(traceEvents);

  const vendorBytes = mode === 'fast'
    ? await vendor.packRows(expectedRows, writerOptions)
    : await fallbackPack(vendor, expectedRows, writerOptions, mode);
  const diagBytes = mode === 'fast'
    ? await instrumented.packRows(expectedRows, writerOptions)
    : await fallbackPack(instrumented, expectedRows, writerOptions, mode);

  clearDiagnosticHook();
  assert.equal(Buffer.compare(Buffer.from(vendorBytes), Buffer.from(diagBytes)), 0, `${name}: diagnostic copy changed output bytes`);

  // Re-run the diagnostic copy with its hook disabled to detect any behavior change
  // attributable to observer callbacks, independently of its source-copy status.
  const noHookBytes = mode === 'fast'
    ? await instrumented.packRows(expectedRows, writerOptions)
    : await fallbackPack(instrumented, expectedRows, writerOptions, mode);
  assert.equal(Buffer.compare(Buffer.from(diagBytes), Buffer.from(noHookBytes)), 0, `${name}: tracing changed output bytes`);

  const decodedRows = instrumented.unpackRows(diagBytes);
  const mismatches = compareRows(expectedRows, decodedRows);
  const info = instrumented.info(diagBytes);
  const stats = instrumented.stats(diagBytes);
  checks.push({
    name,
    mode,
    status: mismatches.length ? 'reproduced-mismatch' : 'round-trip-pass',
    inputBytes,
    lfcpBytes: diagBytes.length,
    outputSha256: byteHash(diagBytes),
    vendorAndDiagnosticBytesEqual: true,
    diagnosticHookOnAndOffBytesEqual: true,
    footerAccepted: true,
    info,
    stats,
    mismatchCount: mismatches.length,
    mismatches,
    relevantEvents: traceEvents.filter((e) => /strdict|rawjoin|string-encoding|javascript\.string-encoding|flat-column|column-selection|block-assembled/.test(e.stage)),
    encodingBranch: branchFromStrdictEvent(
      traceEvents.find((e) => e.stage === 'fast.strdict.input'),
      traceEvents.find((e) => e.stage === 'fast.strdict.output')
    )
  });
}

async function fallbackPack(lib, rows, options, mode) {
  if (mode === 'nested') return lib.packRows(rows, { block: 'nested', ...options });
  const saved = global.WebAssembly;
  global.WebAssembly = undefined;
  try {
    return await lib.packRows(rows, { block: 'flat', ...options });
  } finally {
    global.WebAssembly = saved;
  }
}

async function main() {
  await vendor.init();
  await instrumented.init();

  const minimal = rowsFor(['', 'A', 'B', 'C']);
  await packWithTrace('minimal-four-row-fast-writer', minimal, { templates: false });

  const mixedLength = rowsFor(['', 'VTx8vKxt', 'A'.repeat(40), 'B'.repeat(256), 'C'.repeat(1024), 'D'.repeat(4096)]);
  await packWithTrace('six-row-mixed-length-fast-writer', mixedLength, { templates: false });

  for (let distinct = 2; distinct <= 8; distinct += 1) {
    await packWithTrace(`eight-row-cardinality-${distinct}`, rowsFor(valuesForCardinality(distinct)), { templates: false });
  }

  await packWithTrace('four-row-low-cardinality-all-values-branch', rowsFor(['', 'A', 'A', 'A']), { templates: false });
  await packWithTrace('same-four-row-javascript-flat-fallback', minimal, { templates: false }, 'javascript-flat');
  await packWithTrace('same-four-row-nested-control', minimal, {}, 'nested');

  // Assertions characterize the present defect and ensure the instrumented copy
  // captures the missing leading separator. The separate Phase 4 regression
  // harness is the future-fix acceptance test and currently exits nonzero.
  assert.equal(checks[0].status, 'reproduced-mismatch');
  assert.equal(checks[0].mismatchCount, 4);
  assert.equal(checks[0].relevantEvents.find((e) => e.stage === 'fast.strdict.output').detail.output.firstHex, '4100420043');
  assert.equal(checks[checks.length - 2].status, 'round-trip-pass');
  assert.equal(checks[checks.length - 1].status, 'round-trip-pass');
  assert.equal(checks.filter((c) => c.status === 'reproduced-mismatch').length, 8);
  assert.equal(checks.filter((c) => c.status === 'round-trip-pass').length, 4);

  const report = {
    schema: 'lfcp-workbench-optimized-string-writer-diagnostics/v1',
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    source: {
      package: 'LFC-pack 0.4.19 / API 0',
      jsModulesReference: '6e16aa8044d0a05bafa7c756c949f3537c23e92a',
      jsModulesBlob: 'dae1cf4a7d9f6f568ea05447f57e9158e7396091',
      sourceFileSha256: '8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259',
      flatscanSourceSha256: '14d8f0c3cd4c841404be5275a2472528e58abd21f3d74173ec69095963adcb60'
    },
    testSummary: {
      cases: checks.length,
      reproducedFailures: checks.filter((c) => c.status === 'reproduced-mismatch').length,
      passingControls: checks.filter((c) => c.status === 'round-trip-pass').length,
      byteComparisonsPassed: checks.every((c) => c.vendorAndDiagnosticBytesEqual && c.diagnosticHookOnAndOffBytesEqual)
    },
    cases: checks
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(report.testSummary)}\n`);
}

main().catch((error) => {
  clearDiagnosticHook();
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 1;
});
