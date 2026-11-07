'use strict';

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var results = { schema: 'lfcp-workbench-browser-validation/v1', startedAt: null, environment: null, tests: [] };
  var activeWorker = null;
  var testPrefix = 'phase2-';

  function setStatus(message) { $('status').textContent = message; }
  function show() { $('results').textContent = JSON.stringify(results, null, 2); $('save').disabled = !results.tests.length; }
  function bytesFrom(text) { return new TextEncoder().encode(text); }
  function fileOf(name, content) { return new File([content], name, { type: 'application/octet-stream' }); }
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      var sorted = {};
      Object.keys(value).sort().forEach(function (key) { sorted[key] = canonical(value[key]); });
      return sorted;
    }
    return value;
  }
  function equal(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
  function errorText(error) { return String(error && error.message || error); }

  async function deliverLocalReport() {
    if (!$('report-local').checked) return;
    results.localReport = { optedIn: true, target: 'same-origin loopback only' };
    show();
    try {
      var response = await fetch('/__lfcp_test_results', { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(results) });
      if (!response.ok) throw new Error('Local report receiver returned HTTP ' + response.status + '.');
      var saved = await response.json(); results.localReport.status = 'saved'; results.localReport.file = saved.saved; show();
      setStatus('Generated results saved to ' + saved.saved + ' by the same-origin loopback report server.');
    } catch (error) {
      results.localReport.status = 'failed'; results.localReport.error = errorText(error); show();
      setStatus('Local report capture failed: ' + errorText(error));
    }
  }

  function recordHarnessFailure(name, error) {
    results.tests.push({ name: name, status: 'fail', error: errorText(error), lfcpVersion: '0.4.19 / API 0' });
    show(); setStatus('Harness error: ' + errorText(error)); deliverLocalReport();
  }

  async function storageEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) return { available: false };
    try {
      var value = await navigator.storage.estimate();
      return { available: true, usageBytes: value.usage == null ? null : value.usage, quotaBytes: value.quota == null ? null : value.quota };
    } catch (error) { return { available: false, error: errorText(error) }; }
  }

  function storagePreflightReason(estimate, requestedBytes) {
    if (!estimate.available || estimate.quotaBytes == null || estimate.usageBytes == null) return 'Storage usage/quota estimate unavailable; generated large workload skipped.';
    if (estimate.quotaBytes - estimate.usageBytes < requestedBytes * 3) return 'Estimated free space is under three times the generated source size; no large write attempted.';
    return null;
  }

  async function datasetDir(create) {
    if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('OPFS unavailable in this context.');
    var root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('lfcfoundry-data-workbench', { create: create !== false });
  }

  async function listOutputs() {
    var dir = await datasetDir(true), out = [];
    for await (var pair of dir.entries()) if (pair[1].kind === 'file' && pair[0].endsWith('.json.lfc')) out.push(pair[0]);
    return out.sort();
  }

  async function removeTestFile(name) {
    if (!name || !name.startsWith(testPrefix) || !name.endsWith('.json.lfc')) return;
    var dir = await datasetDir(false);
    try { await dir.removeEntry(name); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
  }

  function memorySnapshot() {
    var mem = performance && performance.memory;
    return mem ? { api: 'performance.memory (non-standard; main realm)', usedHeapBytes: mem.usedJSHeapSize, totalHeapBytes: mem.totalJSHeapSize, heapLimitBytes: mem.jsHeapSizeLimit } : { api: null, status: 'not exposed' };
  }

  async function environment() {
    var lfcp = { available: typeof LfcPack !== 'undefined', version: null, init: 'not run' };
    if (lfcp.available) {
      try { await LfcPack.init(); lfcp.init = 'passed'; }
      catch (error) { lfcp.init = 'failed: ' + errorText(error); }
    }
    var storage = await storageEstimate();
    var clientHints = null;
    if (navigator.userAgentData) {
      try { clientHints = await navigator.userAgentData.getHighEntropyValues(['architecture', 'model', 'platformVersion', 'uaFullVersion']); }
      catch (error) { clientHints = { status: 'unavailable', reason: errorText(error) }; }
    }
    return {
      capturedAt: new Date().toISOString(), browserRuntime: navigator.userAgent, platform: navigator.platform || null, userAgentClientHints: clientHints,
      language: navigator.language, origin: location.origin, secureContext: window.isSecureContext,
      crossOriginIsolated: window.crossOriginIsolated, opfs: !!(navigator.storage && navigator.storage.getDirectory),
      storageEstimate: storage, worker: typeof Worker === 'function', file: typeof File === 'function', streams: typeof ReadableStream === 'function',
      memory: memorySnapshot(), memoryMeasureUserAgentSpecific: typeof performance.measureUserAgentSpecificMemory === 'function',
      lfcp: lfcp, lfcpVersion: '0.4.19 / API 0'
    };
  }

  function runWorker(message, onProgress, onStage) {
    return new Promise(function (resolve, reject) {
      var worker = new Worker('../worker.js?validation=phase2-v2'); activeWorker = worker;
      var id = 'phase2-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      message.id = id;
      worker.onmessage = function (event) {
        var value = event.data || {};
        if (value.id !== id) return;
        if (value.type === 'progress') { if (onProgress) onProgress(value, worker); return; }
        if (value.type === 'stage') { if (onStage) onStage(value, worker); return; }
        if (value.type === 'done') { worker.terminate(); activeWorker = null; resolve(value.dataset); }
        else if (value.type === 'cancelled' || value.type === 'error') { worker.terminate(); activeWorker = null; var e = new Error(value.message || value.type); e.kind = value.type; reject(e); }
      };
      worker.onerror = function (event) { worker.terminate(); activeWorker = null; reject(new Error(event.message || 'Worker error')); };
      worker.postMessage(message);
    });
  }

  async function inspectOutput(name, expectedRows, fullDecode) {
    var dir = await datasetDir(false), handle = await dir.getFileHandle(name), file = await handle.getFile();
    if (file.size > 64 * 1024 * 1024) throw new Error('Validation reader cap is 64 MiB, matching the prototype inspection limit.');
    var bytes = new Uint8Array(await file.arrayBuffer());
    var suffix = String.fromCharCode.apply(null, Array.from(bytes.subarray(Math.max(0, bytes.length - 4))));
    var info = LfcPack.info(bytes); // Validates footer structure and CRC in this pinned reader.
    var rows = fullDecode ? LfcPack.unpack(bytes) : LfcPack.unpackRows(bytes, { from: 0, count: Math.min(expectedRows == null ? 100 : expectedRows, 100) });
    var footerCorruptionRejected = false;
    if (bytes.length >= 16) {
      var altered = bytes.slice(), view = new DataView(altered.buffer);
      var footerLength = view.getUint32(altered.length - 16, true), footerStart = altered.length - 16 - footerLength;
      if (footerStart >= 0 && footerLength > 0) {
        altered[footerStart] ^= 1;
        try { LfcPack.info(altered); } catch (_) { footerCorruptionRejected = true; }
      }
    }
    return { fileBytes: file.size, trailingMarker: suffix, info: info, decodedSample: rows, footerCorruptionRejected: footerCorruptionRejected };
  }

  async function runFixture(test) {
    var name = testPrefix + test.name.replace(/[^a-z0-9-]/gi, '-') + '.' + test.ext;
    var file = fileOf(name, test.content), before = await listOutputs(), start = performance.now(), dataset = null;
    var record = { name: test.name, format: test.format, inputBytes: file.size, expectedRows: test.expectedRows.length, expectedErrorPattern: test.expectedErrorPattern || null, lfcpVersion: '0.4.19 / API 0', status: 'not-tested' };
    try {
      dataset = await runWorker({ type: 'import', file: file, format: test.format, delimiter: test.delimiter || (test.format === 'tsv' ? '\t' : ','), validationHooks: true });
      record.durationMs = performance.now() - start;
      if (test.expectError) {
        record.status = 'fail'; record.error = 'Expected import error but the import completed.';
        if (!$('retain').checked) await removeTestFile(dataset.name);
        return record;
      }
      var decoded = await inspectOutput(dataset.name, test.expectedRows.length, !!test.fullDecode);
      record.outputBytes = dataset.size; record.rowsReported = dataset.rows; record.columnsReported = dataset.columns;
      record.outputName = dataset.name; record.workerMetrics = dataset.metrics || null; record.decoded = decoded;
      var valuesMatch = test.fullDecode ? equal(decoded.decodedSample, test.expectedRows) : equal(decoded.decodedSample, test.expectedRows.slice(0, 100));
      var blocksMatch = !test.expectBlocks || decoded.info.blocks > 1;
      record.decoded = { fileBytes: decoded.fileBytes, trailingMarker: decoded.trailingMarker, info: decoded.info, decodedRowCount: decoded.decodedSample.length, firstRows: decoded.decodedSample.slice(0, 3), lastRows: decoded.decodedSample.slice(-3), footerCorruptionRejected: decoded.footerCorruptionRejected };
      record.status = dataset.rows === test.expectedRows.length && valuesMatch && blocksMatch && decoded.info.rows === test.expectedRows.length && decoded.trailingMarker === 'LFC1' && decoded.footerCorruptionRejected ? 'pass' : 'fail';
      record.assertions = { rowCount: dataset.rows === test.expectedRows.length, decodedRows: valuesMatch, readerRowCount: decoded.info.rows === test.expectedRows.length, footerCorruptionRejected: decoded.footerCorruptionRejected, multipleBlocks: blocksMatch };
      if (!$('retain').checked) await removeTestFile(dataset.name);
    } catch (error) {
      record.error = errorText(error); record.errorKind = error.kind || null;
      var expectedMessage = !test.expectedErrorPattern || new RegExp(test.expectedErrorPattern, 'i').test(record.error);
      record.status = test.expectError && error.kind === 'error' && expectedMessage ? 'pass (expected rejection)' : 'fail';
      if (dataset && !$('retain').checked) { try { await removeTestFile(dataset.name); } catch (_) {} }
      var after = await listOutputs();
      record.newOutputNames = after.filter(function (n) { return before.indexOf(n) < 0; });
      record.incompleteOutputCleaned = record.newOutputNames.every(function (n) { return !n.startsWith(testPrefix); });
      if (test.expectError && !record.incompleteOutputCleaned) record.status = 'fail';
    }
    return record;
  }

  function functionalCases() {
    var hugeStart = 'value\n', ascii = 'a'.repeat(65535 - bytesFrom(hugeStart).length), crossing = hugeStart + ascii + '€\n';
    var jsonBoundary = '{"value":"' + 'b'.repeat(65535 - bytesFrom('{"value":"').length) + '€"}\n';
    return [
      { name: 'csv-empty-input', ext: 'csv', format: 'csv', content: '', expectedRows: [], expectError: true, expectedErrorPattern: 'no header row' },
      { name: 'csv-header-only', ext: 'csv', format: 'csv', content: 'a,b\n', expectedRows: [] },
      { name: 'csv-quoted-delimiter-and-escaped-quote', ext: 'csv', format: 'csv', content: 'a,b\n"x,y","say ""hi"""\n', expectedRows: [{ a: 'x,y', b: 'say "hi"' }] },
      { name: 'csv-embedded-newline', ext: 'csv', format: 'csv', content: 'a,b\n"line one\nline two",z\n', expectedRows: [{ a: 'line one\nline two', b: 'z' }] },
      { name: 'csv-crlf-and-lf', ext: 'csv', format: 'csv', content: 'a,b\r\n1,2\n3,4\r\n', expectedRows: [{ a: '1', b: '2' }, { a: '3', b: '4' }] },
      { name: 'csv-utf8-chunk-boundary', ext: 'csv', format: 'csv', content: crossing, expectedRows: [{ value: ascii + '€' }] },
      { name: 'csv-record-crosses-input-boundary', ext: 'csv', format: 'csv', content: 'value\n' + 'r'.repeat(65540) + '\n', expectedRows: [{ value: 'r'.repeat(65540) }] },
      { name: 'csv-long-field-128k', ext: 'csv', format: 'csv', content: 'v\n' + 'x'.repeat(128 * 1024) + '\n', expectedRows: [{ v: 'x'.repeat(128 * 1024) }] },
      { name: 'csv-empty-and-trailing-fields', ext: 'csv', format: 'csv', content: 'a,b,\n,tail,\n', expectedRows: [{ a: '', b: 'tail', column_3: '' }] },
      { name: 'csv-unclosed-quote', ext: 'csv', format: 'csv', content: 'a\n"unfinished', expectedRows: [], expectError: true, expectedErrorPattern: 'does not close' },
      { name: 'csv-text-after-closing-quote', ext: 'csv', format: 'csv', content: 'a\n"x"z\n', expectedRows: [], expectError: true, expectedErrorPattern: 'Unexpected text' },
      { name: 'csv-ragged-row', ext: 'csv', format: 'csv', content: 'a,b\n1\n', expectedRows: [], expectError: true, expectedErrorPattern: 'fields but the header' },
      { name: 'csv-invalid-utf8', ext: 'csv', format: 'csv', content: new Uint8Array([97, 10, 255, 10]), expectedRows: [], expectError: true, expectedErrorPattern: 'encoded|utf-8' },
      { name: 'tsv-tab-delimiter', ext: 'tsv', format: 'tsv', content: 'a\tb\n1\t2\n', expectedRows: [{ a: '1', b: '2' }] },
      { name: 'jsonl-empty-input', ext: 'jsonl', format: 'jsonl', content: '', expectedRows: [] },
      { name: 'jsonl-no-final-newline', ext: 'jsonl', format: 'jsonl', content: '{"a":1}\n{"a":2}', expectedRows: [{ a: 1 }, { a: 2 }] },
      { name: 'jsonl-malformed', ext: 'jsonl', format: 'jsonl', content: '{"a":1}\n{bad}\n', expectedRows: [], expectError: true, expectedErrorPattern: 'Invalid JSONL' },
      { name: 'jsonl-invalid-utf8', ext: 'jsonl', format: 'jsonl', content: new Uint8Array([123, 34, 97, 34, 58, 255, 125, 10]), expectedRows: [], expectError: true, expectedErrorPattern: 'encoded|utf-8' },
      { name: 'jsonl-crlf-and-blank-lines', ext: 'jsonl', format: 'jsonl', content: '{"a":1}\r\n\r\n{"a":2}\r\n', expectedRows: [{ a: 1 }, { a: 2 }] },
      { name: 'jsonl-utf8-chunk-boundary', ext: 'jsonl', format: 'jsonl', content: jsonBoundary, expectedRows: [{ value: 'b'.repeat(65535 - bytesFrom('{"value":"').length) + '€' }] },
      { name: 'jsonl-null-missing-and-empty', ext: 'jsonl', format: 'jsonl', content: '{"present":"","nullValue":null}\n{"present":"x"}', expectedRows: [{ present: '', nullValue: null }, { present: 'x' }] },
      { name: 'jsonl-multiple-lfcp-blocks', ext: 'jsonl', format: 'jsonl', content: Array.from({ length: 12000 }, function (_, i) { return JSON.stringify({ id: i, group: 'g' + (i % 7), value: i * 3 }) + '\n'; }).join(''), expectedRows: Array.from({ length: 12000 }, function (_, i) { return { id: i, group: 'g' + (i % 7), value: i * 3 }; }), fullDecode: true, expectBlocks: true }
    ];
  }

  async function runFunctional() {
    results.startedAt = new Date().toISOString(); results.environment = await environment(); results.tests = []; show();
    var cases = functionalCases();
    for (var i = 0; i < cases.length; i++) {
      setStatus('Functional case ' + (i + 1) + ' / ' + cases.length + ': ' + cases[i].name);
      var rec = await runFixture(cases[i]); results.tests.push(rec); show();
    }
    setStatus('Functional matrix finished. Inspect each result and assertion; no browser-independent simulation was used.');
    await deliverLocalReport();
  }

  async function writeGeneratedJsonl(targetBytes, tag) {
    var dir = await datasetDir(true), name = testPrefix + tag + '.jsonl', handle = await dir.getFileHandle(name, { create: true });
    var writable = await handle.createWritable({ keepExistingData: false });
    var row = '{"id":1,"group":"alpha","value":17}\n', encoded = bytesFrom(row), rowsPerChunk = Math.max(1, Math.floor(48 * 1024 / encoded.length));
    var chunk = bytesFrom(row.repeat(rowsPerChunk)), total = 0;
    try {
      while (total + chunk.length <= targetBytes) { await writable.write(chunk); total += chunk.length; }
      var remainder = targetBytes - total, extraRows = Math.floor(remainder / encoded.length);
      if (extraRows) { var tail = bytesFrom(row.repeat(extraRows)); await writable.write(tail); total += tail.length; }
      await writable.close();
    } catch (error) { try { await writable.abort(); } catch (_) {} try { await dir.removeEntry(name); } catch (_) {} throw error; }
    return { name: name, file: await handle.getFile(), bytes: total, rows: Math.floor(total / encoded.length) };
  }

  async function performanceMemoryEstimate() {
    if (typeof performance.measureUserAgentSpecificMemory !== 'function') return { status: 'not exposed' };
    try { var m = await performance.measureUserAgentSpecificMemory(); return { status: 'measured', bytes: m.bytes, breakdown: m.breakdown || null }; }
    catch (error) { return { status: 'unavailable', reason: errorText(error) }; }
  }

  async function runResources() {
    results.startedAt = new Date().toISOString(); results.environment = await environment(); results.tests = []; show();
    var sizes = [256 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];
    for (var i = 0; i < sizes.length; i++) {
      var tag = 'resource-' + sizes[i], rec = { name: tag, format: 'JSONL', requestedSourceBytes: sizes[i], fields: 3, status: 'not-tested', lfcpVersion: '0.4.19 / API 0' };
      var estimateBefore = await storageEstimate();
      var preflightReason = storagePreflightReason(estimateBefore, sizes[i]);
      if (preflightReason) {
        rec.status = 'skipped'; rec.reason = preflightReason; results.tests.push(rec); show(); continue;
      }
      var source = null, dataset = null;
      var heapSampler = null, observedPeakHeap = null, heapSampleCount = 0;
      try {
        source = await writeGeneratedJsonl(sizes[i], tag);
        rec.inputBytes = source.bytes; rec.rowsExpected = source.rows; rec.inputFields = 3;
        rec.storageBefore = estimateBefore; rec.storageWithSource = await storageEstimate();
        rec.mainRealmMemoryBefore = memorySnapshot(); rec.userAgentMemoryBefore = await performanceMemoryEstimate();
        var started = performance.now();
        function sampleHeap() {
          var snap = memorySnapshot(); heapSampleCount++;
          if (snap.usedHeapBytes != null) observedPeakHeap = Math.max(observedPeakHeap == null ? 0 : observedPeakHeap, snap.usedHeapBytes);
        }
        sampleHeap(); heapSampler = setInterval(sampleHeap, 50);
        try { dataset = await runWorker({ type: 'import', file: source.file, format: 'jsonl', validationHooks: true }); }
        finally { clearInterval(heapSampler); heapSampler = null; sampleHeap(); }
        rec.importWallMs = performance.now() - started; rec.parsingMs = dataset.metrics && dataset.metrics.parseMs;
        rec.lfcpEncodingMs = dataset.metrics && dataset.metrics.encodeMs; rec.opfsWriteMs = dataset.metrics && dataset.metrics.opfsWriteMs;
        rec.workerReadMs = dataset.metrics && dataset.metrics.readMs; rec.workerMetrics = dataset.metrics || null;
        rec.mainRealmMemoryAfter = memorySnapshot(); rec.observedPeakMainRealmHeapBytes = observedPeakHeap;
        rec.mainRealmHeapSampleCount = heapSampleCount; rec.mainRealmHeapSamplingIntervalMs = 50;
        rec.userAgentMemoryAfter = await performanceMemoryEstimate();
        rec.storageAfterImport = await storageEstimate(); rec.outputBytes = dataset.size; rec.outputName = dataset.name; rec.compressionRatio = source.bytes ? dataset.size / source.bytes : null;
        var decoded = await inspectOutput(dataset.name, 100);
        rec.readerRows = decoded.info.rows; rec.lfcpBlockCount = decoded.info.blocks; rec.decodedFirstRows = decoded.decodedSample.slice(0, 3);
        rec.footerCorruptionRejected = decoded.footerCorruptionRejected; rec.passAssertions = { rowCount: decoded.info.rows === source.rows, multipleBlocksWhenLarge: sizes[i] <= 1024 * 1024 || decoded.info.blocks > 1, footerCheck: decoded.footerCorruptionRejected };
        rec.status = Object.keys(rec.passAssertions).every(function (key) { return rec.passAssertions[key]; }) ? 'pass' : 'fail';
        if (!$('retain').checked) await removeTestFile(dataset.name);
      } catch (error) { rec.status = 'fail'; rec.error = errorText(error); }
      finally {
        if (heapSampler) clearInterval(heapSampler);
        if (source) { try { var dir = await datasetDir(false); await dir.removeEntry(source.name); } catch (_) {} }
        rec.storageAfterCleanup = await storageEstimate();
      }
      results.tests.push(rec); show(); setStatus('Resource workload ' + (i + 1) + ' / ' + sizes.length + ' complete.');
    }
    setStatus('Resource series finished. Results apply only to this browser and device.');
    await deliverLocalReport();
  }

  async function runCancellation() {
    results.startedAt = new Date().toISOString(); results.environment = await environment(); results.tests = []; show();
    var quotaReason = storagePreflightReason(await storageEstimate(), 16 * 1024 * 1024);
    if (quotaReason) { results.tests.push({ name: 'cooperative-cancellation', status: 'skipped', reason: quotaReason, lfcpVersion: '0.4.19 / API 0' }); show(); setStatus('Cancellation checks skipped by storage preflight.'); await deliverLocalReport(); return; }
    var source = null;
    try {
      source = await writeGeneratedJsonl(16 * 1024 * 1024, 'cancel-source');
      for (var modeIndex = 0; modeIndex < 2; modeIndex++) {
        var mode = modeIndex === 0 ? 'after-progress-read-parse-checkpoint' : 'while-opfs-write-awaits';
        var before = await listOutputs(), cancelSent = false, cancelPoint = null;
        var rec = { name: 'cooperative-cancel-' + (modeIndex === 0 ? 'progress' : 'opfs-write'), trigger: mode, format: 'JSONL', inputBytes: source.bytes, rows: source.rows, fields: 3, lfcpVersion: '0.4.19 / API 0', status: 'not-tested' };
        try {
          await runWorker({ type: 'import', file: source.file, format: 'jsonl', validationHooks: modeIndex === 1, stageHooks: modeIndex === 1 }, function (progress, worker) {
            if (modeIndex === 0 && !cancelSent) { cancelSent = true; cancelPoint = { bytesRead: progress.bytes, rows: progress.rows }; worker.postMessage({ type: 'cancel', id: progress.id }); }
          }, function (stage, worker) {
            if (modeIndex === 1 && !cancelSent && stage.stage === 'opfs-write') { cancelSent = true; cancelPoint = { stage: stage.stage, partBytes: stage.partBytes, outputBytesBeforeWrite: stage.outputBytesBeforeWrite }; worker.postMessage({ type: 'cancel', id: stage.id }); }
          });
          rec.status = 'fail'; rec.reason = 'Import completed before cancellation took effect.';
        } catch (error) {
          rec.errorKind = error.kind || null; rec.error = errorText(error);
          rec.status = error.kind === 'cancelled' ? 'pass' : 'fail';
        }
        rec.cancelRequested = cancelSent; rec.cancelPoint = cancelPoint;
        var after = await listOutputs(); rec.newOutputs = after.filter(function (name) { return before.indexOf(name) < 0; });
        var generatedOutputs = rec.newOutputs.filter(function (name) { return name.startsWith(testPrefix + 'cancel-source-'); });
        rec.incompleteOutputCleanup = generatedOutputs.length === 0;
        if (!rec.incompleteOutputCleanup) {
          for (var i = 0; i < generatedOutputs.length; i++) await removeTestFile(generatedOutputs[i]);
          rec.status = 'fail';
        }
        results.tests.push(rec); show();
      }
    } finally {
      if (source) { try { var sourceDir = await datasetDir(false); await sourceDir.removeEntry(source.name); } catch (_) {} }
    }
    setStatus('Cooperative cancellation checks finished. They do not establish restart recovery.');
    await deliverLocalReport();
  }

  async function runInterruptedWrite() {
    results.startedAt = new Date().toISOString(); results.environment = await environment(); results.tests = []; show();
    var quotaReason = storagePreflightReason(await storageEstimate(), 16 * 1024 * 1024);
    if (quotaReason) { results.tests.push({ name: 'terminate-worker-during-opfs-write', status: 'skipped', reason: quotaReason, lfcpVersion: '0.4.19 / API 0' }); show(); setStatus('Worker interruption check skipped by storage preflight.'); await deliverLocalReport(); return; }
    var source = null, worker = null, before = await listOutputs();
    var rec = { name: 'terminate-worker-during-opfs-write', format: 'JSONL', requestedSourceBytes: 16 * 1024 * 1024, lfcpVersion: '0.4.19 / API 0', status: 'not-tested' };
    try {
      source = await writeGeneratedJsonl(16 * 1024 * 1024, 'interrupt-source');
      rec.inputBytes = source.bytes; rec.rows = source.rows; rec.fields = 3;
      await new Promise(function (resolve, reject) {
        var id = testPrefix + 'interrupt-' + Date.now(), timer;
        worker = new Worker('../worker.js?validation=phase2-v2'); activeWorker = worker;
        timer = setTimeout(function () { if (worker) worker.terminate(); worker = null; activeWorker = null; reject(new Error('Timed out before the Worker entered an OPFS write.')); }, 30000);
        worker.onmessage = function (event) {
          var value = event.data || {}; if (value.id !== id) return;
          if (value.type === 'stage' && value.stage === 'opfs-write') {
            rec.interruptedStage = value.stage; rec.partBytes = value.partBytes; rec.outputBytesBeforeWrite = value.outputBytesBeforeWrite;
            worker.terminate(); worker = null; activeWorker = null; clearTimeout(timer); resolve();
          } else if (value.type === 'done' || value.type === 'error' || value.type === 'cancelled') {
            if (worker) worker.terminate(); worker = null; activeWorker = null; clearTimeout(timer);
            reject(new Error('Worker ended before the requested termination point: ' + value.type));
          }
        };
        worker.onerror = function (event) { if (worker) worker.terminate(); worker = null; activeWorker = null; clearTimeout(timer); reject(new Error(event.message || 'Worker failed before write interruption.')); };
        worker.postMessage({ type: 'import', id: id, file: source.file, format: 'jsonl', validationHooks: true, stageHooks: true });
      });
      await new Promise(function (resolve) { setTimeout(resolve, 500); });
      var after = await listOutputs();
      var added = after.filter(function (name) { return before.indexOf(name) < 0 && name.startsWith(testPrefix + 'interrupt-source-'); });
      rec.filesVisibleAfterTermination = [];
      for (var i = 0; i < added.length; i++) {
        var dir = await datasetDir(false), handle = await dir.getFileHandle(added[i]), file = await handle.getFile(), marker = '';
        if (file.size >= 4) marker = String.fromCharCode.apply(null, Array.from(new Uint8Array(await file.slice(file.size - 4).arrayBuffer())));
        var item = { name: added[i], bytes: file.size, trailingMarker: marker, classification: marker === 'LFC1' ? 'marker-present-requires-reader-validation' : 'incomplete-or-unfinalized' };
        if (marker === 'LFC1' && file.size <= 64 * 1024 * 1024) {
          try { await LfcPack.init({ readOnly: true }); item.readerInfo = LfcPack.info(new Uint8Array(await file.arrayBuffer())); item.classification = 'footer-reader-accepted; block contents not decoded'; }
          catch (error) { item.readerError = errorText(error); item.classification = 'marker-present-reader-rejected'; }
        }
        rec.filesVisibleAfterTermination.push(item);
      }
      rec.testOutcome = rec.filesVisibleAfterTermination.length ? 'output entry observed; inspect its classification' : 'no new dataset entry visible';
      rec.status = 'pass';
      for (var j = 0; j < added.length; j++) await removeTestFile(added[j]);
    } catch (error) { rec.status = 'fail'; rec.error = errorText(error); }
    finally {
      if (worker) { worker.terminate(); worker = null; activeWorker = null; }
      if (source) { try { var sourceDir = await datasetDir(false); await sourceDir.removeEntry(source.name); } catch (_) {} }
      try {
        var cleanupEntries = await listOutputs();
        for (var k = 0; k < cleanupEntries.length; k++) {
          if (before.indexOf(cleanupEntries[k]) < 0 && cleanupEntries[k].startsWith(testPrefix + 'interrupt-source-')) await removeTestFile(cleanupEntries[k]);
        }
      } catch (_) {}
    }
    results.tests.push(rec); show(); setStatus('Worker interruption check finished. The recorded file state is browser-specific and is not a recovery guarantee.');
    await deliverLocalReport();
  }

  $('functional').addEventListener('click', function () { runFunctional().catch(function (e) { recordHarnessFailure('functional-harness', e); }); });
  $('resource').addEventListener('click', function () { runResources().catch(function (e) { recordHarnessFailure('resource-harness', e); }); });
  $('cancel').addEventListener('click', function () { runCancellation().catch(function (e) { recordHarnessFailure('cancellation-harness', e); }); });
  $('interrupt').addEventListener('click', function () { runInterruptedWrite().catch(function (e) { recordHarnessFailure('interruption-harness', e); }); });
  $('save').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' }), link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = 'lfcp-workbench-browser-validation.json'; link.click(); URL.revokeObjectURL(link.href);
  });
  environment().then(function (env) {
    results.environment = env; show();
    setStatus(env.secureContext ? (env.opfs ? 'Secure context and OPFS API detected; no tests have run yet.' : 'Secure context detected, but OPFS is unavailable.') : 'Not a secure context. Open this page from localhost or HTTPS before testing.');
    var query = new URLSearchParams(location.search), run = query.get('run');
    if (query.get('report') === '1') $('report-local').checked = true;
    if (run) window.setTimeout(function () {
      if (run === 'functional') runFunctional().catch(function (e) { recordHarnessFailure('functional-harness', e); });
      else if (run === 'resources') runResources().catch(function (e) { recordHarnessFailure('resource-harness', e); });
      else if (run === 'cancellation') runCancellation().catch(function (e) { recordHarnessFailure('cancellation-harness', e); });
      else if (run === 'interruption') runInterruptedWrite().catch(function (e) { recordHarnessFailure('interruption-harness', e); });
    }, 0);
  }).catch(function (error) { setStatus('Environment probe failed: ' + errorText(error)); });
})();
