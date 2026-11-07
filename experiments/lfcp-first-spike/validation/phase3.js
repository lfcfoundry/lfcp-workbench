'use strict';

(function () {
  var encoder = new TextEncoder();
  var result = null;
  var activeWorker = null;
  var SOURCE_DIR = 'lfcfoundry-data-workbench';
  var MANIFEST_PREFIX = 'lfcp-workbench-phase3-lifecycle:';
  var TARGETS = [256 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];
  var WORKLOADS = ['highly-repetitive', 'moderately-repetitive', 'mixed-realistic', 'high-entropy', 'mixed-length-text', 'numeric-categorical'];

  function status(text) { document.getElementById('status').textContent = text; }
  function display() {
    document.getElementById('results').textContent = JSON.stringify(result, null, 2);
    document.getElementById('phase3-save').disabled = !result;
  }
  function errorText(error) { return String(error && error.message || error); }
  function idPart(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 72); }
  function localId() { return 'phase3-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 9); }
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).sort().forEach(function (key) { out[key] = canonical(value[key]); });
      return out;
    }
    return value;
  }
  function equal(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
  function memorySnapshot() {
    var memory = window.performance && performance.memory;
    return memory ? { api: 'performance.memory (non-standard; page realm)', usedHeapBytes: memory.usedJSHeapSize, totalHeapBytes: memory.totalJSHeapSize, heapLimitBytes: memory.jsHeapSizeLimit } : { status: 'not-exposed' };
  }
  async function userAgentMemory() {
    if (typeof performance.measureUserAgentSpecificMemory !== 'function') return { status: 'not-exposed' };
    try { var value = await performance.measureUserAgentSpecificMemory(); return { status: 'measured', bytes: value.bytes, breakdown: value.breakdown || null }; }
    catch (error) { return { status: 'unavailable', reason: errorText(error) }; }
  }
  async function storageEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) return { status: 'not-exposed' };
    try { var estimate = await navigator.storage.estimate(); return { status: 'measured-approximate-origin-estimate', usageBytes: estimate.usage == null ? null : estimate.usage, quotaBytes: estimate.quota == null ? null : estimate.quota }; }
    catch (error) { return { status: 'unavailable', reason: errorText(error) }; }
  }
  async function environment() {
    var persisted = 'not-exposed';
    if (navigator.storage && navigator.storage.persisted) {
      try { persisted = await navigator.storage.persisted(); } catch (error) { persisted = 'unavailable: ' + errorText(error); }
    }
    var handlePrototype = window.FileSystemHandle && FileSystemHandle.prototype;
    return {
      capturedAt: new Date().toISOString(), browserRuntime: navigator.userAgent, platform: navigator.platform || null,
      origin: location.origin, secureContext: window.isSecureContext, crossOriginIsolated: window.crossOriginIsolated,
      opfs: !!(navigator.storage && navigator.storage.getDirectory), storageEstimate: await storageEstimate(), storagePersisted: persisted,
      fileSystemHandleMove: !!(handlePrototype && typeof handlePrototype.move === 'function'),
      fileSystemWritableStream: typeof FileSystemWritableFileStream === 'function',
      pageMemory: memorySnapshot(), userAgentSpecificMemory: typeof performance.measureUserAgentSpecificMemory === 'function',
      deviceMemoryGiB: navigator.deviceMemory == null ? null : navigator.deviceMemory,
      worker: typeof Worker === 'function', streams: typeof ReadableStream === 'function', lfcpVersion: 'LFC-pack 0.4.19 / API 0'
    };
  }
  function newReport(suite) {
    return { schema: 'lfcp-workbench-browser-validation/v1', phase: 3, suite: suite, startedAt: new Date().toISOString(), environment: null, tests: [], notes: [] };
  }
  async function postReport(report) {
    var query = new URLSearchParams(location.search);
    if (!document.getElementById('report-local').checked && query.get('report') !== '1') return { status: 'not-requested' };
    try {
      var response = await fetch('/__lfcp_test_results', { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
      if (!response.ok) throw new Error('Report receiver returned HTTP ' + response.status);
      return Object.assign({ status: 'saved' }, await response.json());
    } catch (error) { return { status: 'failed', reason: errorText(error) }; }
  }
  function saveReport() {
    if (!result) return;
    var blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    var link = document.createElement('a'); link.href = URL.createObjectURL(blob);
    link.download = 'lfcp-workbench-phase3-' + (result.suite || 'validation') + '.json'; link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 0);
  }
  async function datasetDirectory(create) {
    if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('OPFS is unavailable in this browser context.');
    return (await navigator.storage.getDirectory()).getDirectoryHandle(SOURCE_DIR, { create: create !== false });
  }
  async function listLfcp() {
    var dir = await datasetDirectory(false), names = [];
    for await (var item of dir.entries()) if (item[1].kind === 'file' && item[0].endsWith('.json.lfc')) names.push(item[0]);
    return names.sort();
  }
  async function safeRemove(name) {
    if (!name || !name.startsWith('phase3-')) throw new Error('Refusing to remove a path without the phase3 generated-data prefix.');
    var dir = await datasetDirectory(false);
    try { await dir.removeEntry(name); return true; }
    catch (error) { if (error.name === 'NotFoundError') return false; throw error; }
  }
  function workerImport(file, options, onStage, onProgress) {
    return new Promise(function (resolve, reject) {
      var worker = new Worker('../worker.js?validation=phase3-v1'); activeWorker = worker;
      var id = 'phase3-job-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      var message = Object.assign({ type: 'import', id: id, file: file, format: 'jsonl', validationHooks: true, stageHooks: !!onStage }, options || {});
      worker.onmessage = function (event) {
        var value = event.data || {}; if (value.id !== id) return;
        if (value.type === 'stage') { if (onStage) onStage(value, worker); return; }
        if (value.type === 'progress') { if (onProgress) onProgress(value, worker); return; }
        if (value.type === 'done') { worker.terminate(); activeWorker = null; resolve(value.dataset); }
        else if (value.type === 'cancelled' || value.type === 'error') { worker.terminate(); activeWorker = null; var error = new Error(value.message || value.type); error.kind = value.type; reject(error); }
      };
      worker.onerror = function (event) { worker.terminate(); activeWorker = null; reject(new Error(event.message || 'Worker execution failed.')); };
      worker.postMessage(message);
    });
  }
  function hashText(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
  function seeded(seedText, rowIndex) {
    var seed = parseInt(hashText(seedText + '/' + rowIndex), 16) >>> 0;
    return function () { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  }
  function token(next, length, alphabet) {
    var value = '';
    for (var i = 0; i < length; i++) value += alphabet[next() % alphabet.length];
    return value;
  }
  var ALNUM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var CATEGORIES = ['north', 'south', 'east', 'west', 'central', 'coastal', 'upland', 'metro'];
  var REGIONS = ['Albany', 'Boise', 'Cedar Falls', 'Dover', 'Erie', 'Fresno', 'Galesburg', 'Helena'];
  var NAMES = ['Alex Morgan', 'Casey Rivera', 'Jordan Patel', 'Taylor Kim', 'Sam Williams', 'Robin Chen', 'Jamie Brooks', 'Drew Singh'];
  var NOTES = ['invoice reconciled', 'awaiting review', 'scheduled follow-up', 'customer requested update', 'routine renewal', 'shipment confirmed', 'account verified', 'manual check completed'];
  function recordFor(kind, index, seedText) {
    var next = seeded(seedText, index), category = CATEGORIES[next() % CATEGORIES.length], region = REGIONS[next() % REGIONS.length];
    if (kind === 'highly-repetitive') return { id: index + 1, category: 'active', region: 'north', status: 'open', quantity: 1, note: 'standard recurring record' };
    if (kind === 'moderately-repetitive') return { id: index + 1, category: CATEGORIES[next() % 4], region: REGIONS[next() % 4], amountCents: (next() % 500000) + 1250, status: next() % 5 ? 'open' : 'closed', note: NOTES[next() % NOTES.length] };
    if (kind === 'mixed-realistic') return { event_id: index + 1, day: '2025-' + String((index % 12) + 1).padStart(2, '0') + '-' + String((index % 27) + 1).padStart(2, '0'), category: category, region: region, account: NAMES[next() % NAMES.length], amount: ((next() % 10000000) / 100).toFixed(2), active: next() % 3 !== 0, note: NOTES[next() % NOTES.length] + ' for ' + region };
    if (kind === 'high-entropy') return { id: index + 1, token: token(next, 112, ALNUM), nonce: token(next, 32, ALNUM), group: category };
    if (kind === 'mixed-length-text') {
      var lengths = [0, 8, 40, 256, 1024, 4096], length = lengths[index % lengths.length];
      return { id: index + 1, category: category, body: token(next, length, ALNUM), note: NOTES[next() % NOTES.length] };
    }
    return { id: index + 1, category: category, region: region, count: next() % 1000000, signed_delta: (next() % 2000000) - 1000000, ratio: Number((next() / 4294967295).toFixed(8)), active: next() % 2 === 0 };
  }
  async function createGeneratedSource(kind, targetBytes, seedText, runTag) {
    var dir = await datasetDirectory(true);
    var filename = 'phase3-' + kind + '-' + targetBytes + '-' + idPart(runTag) + '.jsonl';
    try { await dir.getFileHandle(filename); throw new Error('Generated source name already exists; refusing to overwrite: ' + filename); }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
    var handle = await dir.getFileHandle(filename, { create: true }), writable = await handle.createWritable({ keepExistingData: false });
    var started = performance.now(), textBuffer = '', bufferBytes = 0, bytes = 0, rows = 0, maxSourceChunkBytes = 0;
    try {
      while (true) {
        var line = JSON.stringify(recordFor(kind, rows, seedText)) + '\n';
        var lineBytes = encoder.encode(line).byteLength;
        if (bytes + lineBytes > targetBytes) break;
        bytes += lineBytes; bufferBytes += lineBytes; rows++; textBuffer += line;
        if (bufferBytes >= 32768) {
          var chunk = encoder.encode(textBuffer); await writable.write(chunk); maxSourceChunkBytes = Math.max(maxSourceChunkBytes, chunk.byteLength); textBuffer = ''; bufferBytes = 0;
        }
      }
      if (textBuffer) { var tail = encoder.encode(textBuffer); await writable.write(tail); maxSourceChunkBytes = Math.max(maxSourceChunkBytes, tail.byteLength); }
      await writable.close();
    } catch (error) { try { await writable.abort(); } catch (_) {} try { await dir.removeEntry(filename); } catch (_) {} throw error; }
    var file = await handle.getFile();
    return { name: filename, file: file, inputBytes: file.size, rows: rows, fields: Object.keys(recordFor(kind, 0, seedText)).length, generationMs: performance.now() - started, maxSourceChunkBytes: maxSourceChunkBytes, seed: seedText };
  }
  async function decodeAndValidate(outputName, expected) {
    var dir = await datasetDirectory(false), handle = await dir.getFileHandle(outputName), file = await handle.getFile();
    var bytes = new Uint8Array(await file.arrayBuffer());
    var marker = file.size >= 4 ? new TextDecoder().decode(bytes.subarray(bytes.length - 4)) : '';
    var info = LfcPack.info(bytes);
    var pageSize = expected && expected.kind === 'mixed-length-text' ? 1024 : 8192;
    var decodedCount = 0, checkedIndexes = Object.create(null), mismatches = [], sampleIndexes = expected ? [0, Math.floor((expected.rows - 1) / 2), expected.rows - 1] : [];
    if (info.rows > 0) {
      for (var from = 0; from < info.rows; from += pageSize) {
        var page = LfcPack.unpackRows(bytes, { from: from, count: Math.min(pageSize, info.rows - from) });
        if (!Array.isArray(page)) throw new Error('LFCP reader returned a non-array row page.');
        for (var j = 0; j < page.length; j++) {
          var absolute = from + j;
          if (sampleIndexes.indexOf(absolute) >= 0 && expected) {
            var expectedRow = expected.buildRow(absolute);
            if (!equal(page[j], expectedRow)) {
              var diagnostic = null;
              if (expected.diagnosticFullDecode && absolute === sampleIndexes[0] && info.rows <= 5000) {
                try { var whole = LfcPack.unpack(bytes); diagnostic = { fullDecodeRows: whole.length, fullDecodeFirstRow: whole[0], fullDecodeFirstRowMatches: equal(whole[0], expected.buildRow(0)) }; }
                catch (decodeError) { diagnostic = { fullDecodeError: errorText(decodeError) }; }
              }
              mismatches.push({ row: absolute, expected: expectedRow, actual: page[j], fullDecodeDiagnostic: diagnostic });
            }
            checkedIndexes[absolute] = true;
          }
        }
        decodedCount += page.length;
      }
    }
    var corruptFooterRejected = false;
    if (bytes.length >= 16) {
      var footerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 16, true);
      var footerStart = bytes.length - 16 - footerLength;
      if (footerStart >= 0 && footerLength > 0) {
        var corrupted = bytes.slice(); corrupted[footerStart] ^= 1;
        try { LfcPack.info(corrupted); } catch (_) { corruptFooterRejected = true; }
      }
    }
    return {
      fileBytes: file.size, lastModified: file.lastModified, trailingMarker: marker, info: info,
      decodedRowsAcrossPages: decodedCount, decodedAllRows: decodedCount === info.rows,
      checkedSampleIndexes: Object.keys(checkedIndexes).map(Number).sort(function (a, b) { return a - b; }),
      valueMismatches: mismatches,
      footerCorruptionRejected: corruptFooterRejected
    };
  }
  async function runResourceMatrix() {
    var query = new URLSearchParams(location.search);
    var requestedWorkload = query.get('workload'), requestedTarget = Number(query.get('targetBytes'));
    var workloads = requestedWorkload && WORKLOADS.indexOf(requestedWorkload) >= 0 ? [requestedWorkload] : WORKLOADS;
    var targets = TARGETS.indexOf(requestedTarget) >= 0 ? [requestedTarget] : TARGETS;
    var repetitions = Math.max(1, Math.min(3, Number(query.get('trials')) || 3));
    var totalTrials = workloads.length * targets.length * repetitions;
    result = newReport('representative-resource-matrix'); result.environment = await environment(); result.fixtureMethod = 'Generated JSONL records from deterministic per-row xorshift32 seeds; source writer flushes at 32 KiB, with actual chunks up to about 35 KiB because it does not split individual records; each requested target is rounded down to a complete JSONL record.';
    result.trialPolicy = { independentTrialsPerWorkloadAndSize: repetitions, sameSeedForRepeatability: true, targetInputBytes: targets, workloads: workloads, noParquetComparison: true };
    result.memoryMeasurement = { pageHeap: 'performance.memory sampled every 50 ms when exposed; page realm only.', workerHeap: 'Worker instrumentation reports API exposure and sampled heap only when exposed.', processMemory: 'Not inferred from page/worker values; Android process diagnostic access checked separately.', deviceMemory: 'navigator.deviceMemory is a coarse browser hint, not measured free RAM.' };
    result.tests = []; display();
    await LfcPack.init();
    var trialNumber = 0;
    for (var w = 0; w < workloads.length; w++) {
      for (var s = 0; s < targets.length; s++) {
        var kind = workloads[w], target = targets[s], seedText = 'LFCP-WB-PHASE3-V1/' + kind + '/' + target;
        var group = { workload: kind, requestedTargetBytes: target, seed: seedText, trials: [] };
        result.tests.push(group);
        for (var trial = 1; trial <= repetitions; trial++) {
          trialNumber++;
          status('Phase 3 resource trial ' + trialNumber + ' / ' + totalTrials + ': ' + kind + ', target ' + target + ' bytes, repetition ' + trial + '.');
          var storageBefore = await storageEstimate();
          if (storageBefore.usageBytes == null || storageBefore.quotaBytes == null || storageBefore.quotaBytes - storageBefore.usageBytes < target * 3) {
            group.trials.push({ trial: trial, status: 'skipped', reason: 'Approximate free origin storage was unavailable or less than 3x the target; no bulk fixture attempted.', storageBefore: storageBefore });
            continue;
          }
          var generated = null, dataset = null, heapTimer = null, peakPageHeap = null, heapSamples = 0, trialResult = { trial: trial, status: 'not-tested', lfcpVersion: '0.4.19 / API 0' };
          var beforeNames = await listLfcp();
          try {
            var generation = await createGeneratedSource(kind, target, seedText, localId() + '-r' + trial);
            generated = generation;
            var outputPrefix = generation.name.replace(/\.jsonl$/i, '') + '-';
            if (beforeNames.some(function (name) { return name.startsWith(outputPrefix); })) throw new Error('Generated LFCP output prefix already exists; refusing to import over it.');
            trialResult.sourceName = generation.name; trialResult.inputBytes = generation.inputBytes; trialResult.rows = generation.rows; trialResult.fields = generation.fields;
            trialResult.sourceChunkBytesMax = generation.maxSourceChunkBytes; trialResult.generationMs = generation.generationMs;
            trialResult.storageBefore = storageBefore; trialResult.storageWithSource = await storageEstimate();
            trialResult.pageHeapBefore = memorySnapshot(); trialResult.workerUserAgentMemoryBefore = await userAgentMemory();
            var peak = function () { var sample = memorySnapshot(); heapSamples++; if (sample.usedHeapBytes != null) peakPageHeap = Math.max(peakPageHeap || 0, sample.usedHeapBytes); };
            peak(); heapTimer = setInterval(peak, 50);
            var importStart = performance.now();
            try { dataset = await workerImport(generation.file, { validationHooks: true }); }
            finally { clearInterval(heapTimer); heapTimer = null; peak(); }
            trialResult.importWallMs = performance.now() - importStart;
            trialResult.workerMetrics = dataset.metrics || null;
            trialResult.workerReadMs = dataset.metrics && dataset.metrics.readMs;
            trialResult.parsingMs = dataset.metrics && dataset.metrics.parseMs;
            trialResult.encodingMs = dataset.metrics && dataset.metrics.encodeMs;
            trialResult.opfsWriteMs = dataset.metrics && dataset.metrics.opfsWriteMs;
            trialResult.pageHeapAfter = memorySnapshot(); trialResult.sampledPeakPageHeapBytes = peakPageHeap; trialResult.pageHeapSamples = heapSamples; trialResult.pageHeapSamplingIntervalMs = 50;
            trialResult.userAgentSpecificMemoryAfter = await userAgentMemory(); trialResult.storageAfterImport = await storageEstimate();
            trialResult.outputName = dataset.name; trialResult.outputBytes = dataset.size;
            trialResult.inputOverOutputRatio = dataset.size ? generation.inputBytes / dataset.size : null;
            trialResult.outputOverInputFraction = generation.inputBytes ? dataset.size / generation.inputBytes : null;
            var decodeStarted = performance.now();
            var decoded = await decodeAndValidate(dataset.name, { kind: kind, rows: generation.rows, diagnosticFullDecode: kind === 'mixed-length-text', buildRow: function (index) { return recordFor(kind, index, seedText); } });
            trialResult.decodeValidationMs = performance.now() - decodeStarted;
            trialResult.decoding = decoded; trialResult.blockCount = decoded.info.blocks;
            trialResult.storageAfterDecode = await storageEstimate();
            var expectedSampleCount = Math.min(generation.rows, 3);
            trialResult.status = decoded.info.rows === generation.rows && decoded.decodedAllRows && decoded.checkedSampleIndexes.length === expectedSampleCount && decoded.valueMismatches.length === 0 && decoded.trailingMarker === 'LFC1' && decoded.footerCorruptionRejected ? 'pass' : 'fail';
            trialResult.assertions = { footerReaderAccepted: decoded.info.rows === generation.rows, allRowsDecodedInPages: decoded.decodedAllRows, deterministicValuesAndOrderSamples: decoded.checkedSampleIndexes.length === expectedSampleCount && decoded.valueMismatches.length === 0, footerCorruptionRejected: decoded.footerCorruptionRejected, outputBlockCountRecorded: decoded.info.blocks >= 0 };
          } catch (error) { trialResult.status = 'fail'; trialResult.error = errorText(error); }
          finally {
            if (heapTimer) clearInterval(heapTimer);
            if (generated) { try { var sourceDir = await datasetDirectory(false); await sourceDir.removeEntry(generated.name); } catch (_) {} }
            var afterNames = [];
            try { afterNames = await listLfcp(); } catch (_) {}
            var candidates = afterNames.filter(function (name) { return name.startsWith('phase3-') && beforeNames.indexOf(name) < 0; });
            for (var c = 0; c < candidates.length; c++) { try { await safeRemove(candidates[c]); } catch (_) {} }
            trialResult.testArtifactsRemoved = candidates;
            trialResult.storageAfterCleanup = await storageEstimate();
          }
          group.trials.push(trialResult); display();
        }
        display();
      }
    }
    result.finishedAt = new Date().toISOString(); result.reportCapture = await postReport(result); display();
    status('Phase 3 representative resource matrix finished. Inspect each trial status and its measured decode, timing, memory, and storage fields.');
  }
  function generatedSmallRows(count) {
    var rows = [];
    for (var i = 0; i < count; i++) rows.push({ id: i + 1, category: ['north', 'south', 'west'][i % 3], value: i * 17, note: 'restart-persistence-row-' + String(i + 1).padStart(4, '0') });
    return rows;
  }
  function persistenceKey(id, kind) { return MANIFEST_PREFIX + id + ':' + kind; }
  async function preparePersistence(id) {
    result = newReport('opfs-completed-file-restart-prepare'); result.environment = await environment(); result.lifecycleId = id; result.tests = []; display(); await LfcPack.init();
    var key = persistenceKey(id, 'complete');
    if (localStorage.getItem(key)) throw new Error('Lifecycle identifier already has a local manifest; refusing to overwrite it.');
    var expected = generatedSmallRows(256), text = expected.map(function (row) { return JSON.stringify(row); }).join('\n') + '\n';
    var file = new File([text], 'phase3-restart-' + id + '.jsonl', { type: 'application/x-ndjson' });
    var existing = await listLfcp();
    if (existing.some(function (name) { return name.startsWith('phase3-restart-' + id + '-'); })) throw new Error('Generated persistence output prefix already exists; refusing to overwrite it.');
    var dataset = await workerImport(file, {});
    var verified = await decodeAndValidate(dataset.name, null);
    var manifest = { lifecycleId: id, preparedAt: new Date().toISOString(), performanceTimeOrigin: performance.timeOrigin, origin: location.origin, outputName: dataset.name, outputSizeBytes: dataset.size, outputLastModified: verified.lastModified, footerMarker: verified.trailingMarker, info: verified.info, expected: expected, storagePersisted: result.environment.storagePersisted };
    if (verified.info.rows !== expected.length || !verified.decodedAllRows || verified.trailingMarker !== 'LFC1' || !verified.footerCorruptionRejected) throw new Error('Prepared LFCP dataset did not pass pre-restart validation.');
    localStorage.setItem(key, JSON.stringify(manifest));
    result.tests.push({ status: 'pass', stage: 'prepared-before-restart', datasetName: manifest.outputName, datasetSizeBytes: manifest.outputSizeBytes, rowCount: expected.length, fields: Object.keys(expected[0]).length, blockCount: manifest.info.blocks, footerReaderAccepted: true, footerCorruptionRejected: true, OPFSIdentity: { origin: manifest.origin, directory: SOURCE_DIR, name: manifest.outputName, lastModified: manifest.outputLastModified }, retainedForRestart: true });
    result.notes.push('This is only the pre-restart half. Close/restart Chrome without clearing site data, then open the same origin with run=persistence-verify and the same lifecycleId.');
    result.finishedAt = new Date().toISOString(); result.reportCapture = await postReport(result); display();
    status('Persistence fixture is complete and retained. Restart Chrome without clearing site data, then open the verification URL with lifecycleId=' + id + '.');
  }
  async function verifyPersistence(id, restartConfirmed) {
    result = newReport('opfs-completed-file-restart-verify'); result.environment = await environment(); result.lifecycleId = id; result.restartConfirmedByProcedure = restartConfirmed; result.tests = []; display(); await LfcPack.init();
    var raw = localStorage.getItem(persistenceKey(id, 'complete'));
    if (!raw) throw new Error('No prepared persistence manifest exists for lifecycleId=' + id + '.');
    var manifest = JSON.parse(raw), statusValue = 'fail', details = { fileFound: false, sameOrigin: manifest.origin === location.origin, outputName: manifest.outputName };
    try {
      var dir = await datasetDirectory(false), handle = await dir.getFileHandle(manifest.outputName), file = await handle.getFile(); details.fileFound = true;
      details.fileSizeBytes = file.size; details.expectedSizeBytes = manifest.outputSizeBytes; details.lastModified = file.lastModified; details.expectedLastModified = manifest.outputLastModified;
      var decoded = await decodeAndValidate(manifest.outputName, null); details.readerInfo = decoded.info; details.footerMarker = decoded.trailingMarker; details.decodedAllRows = decoded.decodedAllRows;
      var bytes = new Uint8Array(await file.arrayBuffer()), allRows = LfcPack.unpack(bytes);
      details.rowCount = allRows.length; details.expectedRowCount = manifest.expected.length; details.valuesAndOrderMatch = equal(allRows, manifest.expected);
      details.footerCorruptionRejected = decoded.footerCorruptionRejected; details.fileIdentityMatches = file.size === manifest.outputSizeBytes && file.lastModified === manifest.outputLastModified;
      details.storageEstimateAfterRestart = await storageEstimate();
      statusValue = details.sameOrigin && details.fileIdentityMatches && details.rowCount === manifest.expected.length && details.valuesAndOrderMatch && details.footerMarker === 'LFC1' && details.footerCorruptionRejected ? 'pass' : 'fail';
      await safeRemove(manifest.outputName); details.generatedDatasetRemovedAfterVerification = true;
    } catch (error) { details.error = errorText(error); statusValue = 'fail'; }
    result.tests.push({ status: statusValue, stage: restartConfirmed ? 'after-explicit-browser-restart-procedure' : 'after-navigation-without-restart-confirmation', details: details });
    result.notes.push('A successful browser restart check demonstrates persistence for this Chrome profile and test only. It does not guarantee retention against eviction, profile clearing, device failure, or all crash modes.');
    localStorage.removeItem(persistenceKey(id, 'complete')); result.finishedAt = new Date().toISOString(); result.reportCapture = await postReport(result); display();
    status('Completed-file persistence verification: ' + statusValue + '.');
  }
  function fixtureForInterrupted(id) {
    var rows = generatedSmallRows(20000), text = rows.map(function (row) { return JSON.stringify(row); }).join('\n') + '\n';
    return new File([text], 'phase3-abrupt-' + id + '.jsonl', { type: 'application/x-ndjson' });
  }
  async function armBrowserInterruption(id) {
    result = newReport('opfs-browser-close-interruption-arm'); result.environment = await environment(); result.lifecycleId = id; result.tests = []; display(); await LfcPack.init();
    var key = persistenceKey(id, 'interrupt'), file = fixtureForInterrupted(id);
    if (localStorage.getItem(key)) throw new Error('Lifecycle identifier already has a manifest; refusing to overwrite.');
    var before = await listLfcp(), armed = false;
    if (before.some(function (name) { return name.startsWith('phase3-abrupt-' + id + '-'); })) throw new Error('Generated interruption output prefix already exists; refusing to overwrite it.');
    await new Promise(function (resolve, reject) {
      var worker = new Worker('../worker.js?validation=phase3-v1'); activeWorker = worker;
      var jobId = 'phase3-abrupt-job-' + Date.now();
      var timeout = setTimeout(function () { worker.terminate(); activeWorker = null; reject(new Error('Timed out before the finalize gate.')); }, 60000);
      worker.onmessage = async function (event) {
        var message = event.data || {}; if (message.id !== jobId) return;
        if (message.type === 'stage' && message.stage === 'finalize') {
          clearTimeout(timeout); armed = true;
          try {
            var dir = await datasetDirectory(false), handle = await dir.getFileHandle(message.filename), visible = await handle.getFile();
            var marker = visible.size >= 4 ? new TextDecoder().decode(new Uint8Array(await visible.slice(visible.size - 4).arrayBuffer())) : '';
            var manifest = { lifecycleId: id, armedAt: new Date().toISOString(), origin: location.origin, outputName: message.filename, sourceBytes: file.size, expectedRows: 20000, stage: message.stage, outputBytesReportedByWorker: message.outputBytes, visibleBytesWhileGated: visible.size, visibleFooterMarkerWhileGated: marker, previousEntries: before };
            localStorage.setItem(key, JSON.stringify(manifest));
            result.tests.push({ status: 'armed', workerAtStage: message.stage, outputName: message.filename, outputBytesReportedByWorker: message.outputBytes, visibleBytesWhileGated: visible.size, visibleFooterMarkerWhileGated: marker, nextAction: 'Close/force-stop Chrome without resuming the worker; reopen the same origin with run=lifecycle-verify and lifecycleId=' + id });
            result.finishedAt = new Date().toISOString(); result.reportCapture = await postReport(result); display();
            status('Worker is paused before writable.close(); the page report is saved if enabled. Close Chrome now, then reopen the verify URL for this lifecycleId.');
            resolve();
          } catch (error) { worker.terminate(); activeWorker = null; reject(error); }
          return;
        }
        if (message.type === 'done' || message.type === 'error' || message.type === 'cancelled') {
          clearTimeout(timeout); worker.terminate(); activeWorker = null; reject(new Error('Worker ended before reaching the finalize gate: ' + message.type + ' ' + (message.message || '')));
        }
      };
      worker.onerror = function (event) { clearTimeout(timeout); worker.terminate(); activeWorker = null; reject(new Error(event.message || 'Worker failed before finalize gate.')); };
      worker.postMessage({ type: 'import', id: jobId, file: file, format: 'jsonl', validationHooks: true, stageHooks: true, stageGateAt: 'finalize' });
    });
    // Deliberately leave this generated OPFS input and the gated worker in place until Chrome is closed.
  }
  async function verifyInterruptedAfterRestart(id, restartConfirmed) {
    result = newReport('opfs-browser-close-interruption-verify'); result.environment = await environment(); result.lifecycleId = id; result.restartConfirmedByProcedure = restartConfirmed; result.tests = []; display(); await LfcPack.init();
    var raw = localStorage.getItem(persistenceKey(id, 'interrupt'));
    if (!raw) throw new Error('No interrupted-output manifest found for lifecycleId=' + id + '.');
    var manifest = JSON.parse(raw), after = await listLfcp(), entry = { status: 'not-tested', outputName: manifest.outputName, stageBeforeClose: manifest.stage, visibleBytesBeforeClose: manifest.visibleBytesWhileGated, workerReportedBytesBeforeClose: manifest.outputBytesReportedByWorker, entryPresentAfterRestart: after.indexOf(manifest.outputName) >= 0 };
    var dir = await datasetDirectory(false);
    try {
      var handle = await dir.getFileHandle(manifest.outputName), file = await handle.getFile(), data = new Uint8Array(await file.arrayBuffer());
      entry.bytesAfterRestart = file.size; entry.trailingMarker = file.size >= 4 ? new TextDecoder().decode(data.subarray(data.length - 4)) : '';
      try {
        entry.readerInfo = LfcPack.info(data); entry.readerAccepted = true;
        var rows = LfcPack.unpack(data); entry.decodedRows = rows.length; entry.rowCountMatches = rows.length === manifest.expectedRows;
        entry.classification = entry.rowCountMatches ? 'reader-accepted-and-row-count-matched' : 'reader-accepted-but-row-count-mismatch';
      } catch (error) { entry.readerAccepted = false; entry.readerError = errorText(error); entry.classification = entry.trailingMarker === 'LFC1' ? 'footer-marker-present-but-reader-rejected' : 'incomplete-or-unfinalized-reader-rejected'; }
      entry.status = 'observed';
    } catch (error) { if (error.name === 'NotFoundError') { entry.classification = 'no-entry-after-restart'; entry.status = 'observed'; } else { entry.status = 'fail'; entry.error = errorText(error); } }
    if (entry.status === 'observed') {
      try { entry.generatedOutputRemoved = await safeRemove(manifest.outputName); } catch (error) { entry.cleanupError = errorText(error); }
    }
    localStorage.removeItem(persistenceKey(id, 'interrupt')); result.tests.push(entry);
    result.notes.push('This abrupt browser process close was performed with a test Worker gated before writable.close(). Classification is based on the pinned reader plus row-count check; a trailing LFC1 marker alone is not accepted as completion.');
    result.finishedAt = new Date().toISOString(); result.reportCapture = await postReport(result); display();
    status('After-restart incomplete-output observation: ' + entry.classification + '.');
  }
  async function runStageInterruptionProbes() {
    result = newReport('opfs-worker-interruption-stages'); result.environment = await environment(); result.tests = []; display(); await LfcPack.init();
    var stages = ['file-created', 'writable-open', 'opfs-write-complete', 'finalize'];
    for (var i = 0; i < stages.length; i++) {
      var stage = stages[i], id = localId(), text = generatedSmallRows(20000).map(function (row) { return JSON.stringify(row); }).join('\n') + '\n';
      var file = new File([text], 'phase3-stage-' + id + '.jsonl', { type: 'application/x-ndjson' });
      var before = await listLfcp(), observed = null;
      if (before.some(function (name) { return name.startsWith('phase3-stage-' + id + '-'); })) { result.tests.push({ stage: stage, status: 'fail', error: 'Generated output prefix exists; refusing to overwrite.' }); continue; }
      status('Probing Worker termination at OPFS lifecycle stage ' + (i + 1) + ' / ' + stages.length + ': ' + stage + '.');
      try {
        await new Promise(function (resolve, reject) {
          var worker = new Worker('../worker.js?validation=phase3-v1'); activeWorker = worker;
          var jobId = 'phase3-stage-job-' + Date.now(), timeout = setTimeout(function () { worker.terminate(); activeWorker = null; reject(new Error('Stage probe timed out at ' + stage)); }, 60000);
          worker.onmessage = async function (event) {
            var message = event.data || {}; if (message.id !== jobId) return;
            if (message.type === 'stage' && message.stage === stage) {
              try {
                var dir = await datasetDirectory(false), handle = await dir.getFileHandle(message.filename), visible = await handle.getFile();
                var data = new Uint8Array(await visible.arrayBuffer()), marker = visible.size >= 4 ? new TextDecoder().decode(data.subarray(data.length - 4)) : '';
                var reader = { accepted: false };
                if (visible.size && visible.size <= 64 * 1024 * 1024) { try { reader.info = LfcPack.info(data); reader.accepted = true; } catch (error) { reader.error = errorText(error); } }
                observed = { stage: stage, filename: message.filename, fileVisibleWhileWorkerPaused: true, bytesWhilePaused: visible.size, workerReportedOutputBytes: message.outputBytes || message.outputBytesBeforeWrite || 0, trailingMarker: marker, reader: reader };
                worker.terminate(); activeWorker = null; clearTimeout(timeout); resolve();
              } catch (error) { worker.terminate(); activeWorker = null; clearTimeout(timeout); reject(error); }
            } else if (message.type === 'done' || message.type === 'error' || message.type === 'cancelled') {
              worker.terminate(); activeWorker = null; clearTimeout(timeout); reject(new Error('Worker ended before stage ' + stage + ': ' + message.type));
            }
          };
          worker.onerror = function (event) { worker.terminate(); activeWorker = null; clearTimeout(timeout); reject(new Error(event.message || 'Worker stage probe failed.')); };
          worker.postMessage({ type: 'import', id: jobId, file: file, format: 'jsonl', validationHooks: true, stageHooks: true, stageGateAt: stage });
        });
        var after = await listLfcp(), newNames = after.filter(function (name) { return name.startsWith('phase3-stage-') && before.indexOf(name) < 0; });
        observed.outputVisibleAfterTermination = newNames.indexOf(observed.filename) >= 0;
        if (observed.outputVisibleAfterTermination) {
          var outDir = await datasetDirectory(false), outFile = await (await outDir.getFileHandle(observed.filename)).getFile();
          observed.bytesAfterTermination = outFile.size;
          var outBytes = new Uint8Array(await outFile.arrayBuffer()); observed.markerAfterTermination = outFile.size >= 4 ? new TextDecoder().decode(outBytes.subarray(outBytes.length - 4)) : '';
          try { observed.readerAfterTermination = LfcPack.info(outBytes); observed.readerAcceptedAfterTermination = true; }
          catch (error) { observed.readerAcceptedAfterTermination = false; observed.readerErrorAfterTermination = errorText(error); }
        }
        observed.cleanup = [];
        for (var n = 0; n < newNames.length; n++) observed.cleanup.push({ name: newNames[n], removed: await safeRemove(newNames[n]) });
        observed.status = 'observed';
      } catch (error) { observed = { stage: stage, status: 'fail', error: errorText(error) }; }
      result.tests.push(observed); display();
    }
    result.notes.push('Each stage is gated by test-only Worker instrumentation. File visibility is observed while the worker is paused and after termination; this does not measure a write mid-system-call or establish cross-browser atomicity.');
    result.finishedAt = new Date().toISOString(); result.reportCapture = await postReport(result); display(); status('OPFS interruption-stage probes finished; generated outputs were individually removed after recording.');
  }
  async function auditGeneratedArtifacts() {
    result = newReport('generated-artifact-cleanup-audit'); result.environment = await environment();
    var dir = await datasetDirectory(false), entries = [];
    for await (var pair of dir.entries()) {
      if (!pair[0].startsWith('phase3-')) continue;
      var item = { name: pair[0], kind: pair[1].kind };
      if (pair[1].kind === 'file') { var file = await pair[1].getFile(); item.bytes = file.size; }
      entries.push(item);
    }
    var manifestKeys = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.startsWith(MANIFEST_PREFIX)) manifestKeys.push(key);
    }
    result.tests.push({ status: entries.length === 0 && manifestKeys.length === 0 ? 'pass' : 'observed-leftovers', generatedOpfsEntries: entries, lifecycleManifestKeys: manifestKeys });
    result.finishedAt = new Date().toISOString(); result.reportCapture = await postReport(result); display(); status('Generated artifact audit finished; no files were removed.');
  }
  async function runFromQuery() {
    var query = new URLSearchParams(location.search), mode = query.get('run');
    if (query.get('report') === '1') document.getElementById('report-local').checked = true;
    var id = idPart(query.get('lifecycleId') || localId());
    try {
      if (mode === 'phase3-resources') await runResourceMatrix();
      else if (mode === 'phase3-interrupt-stages') await runStageInterruptionProbes();
      else if (mode === 'persistence-prepare') await preparePersistence(id);
      else if (mode === 'persistence-verify') await verifyPersistence(id, query.get('restartConfirmed') === '1');
      else if (mode === 'artifact-audit') await auditGeneratedArtifacts();
      else if (mode === 'interruption-arm') await armBrowserInterruption(id);
      else if (mode === 'lifecycle-verify') {
        await verifyPersistence(id, query.get('restartConfirmed') === '1').catch(function (error) {
          result = newReport('opfs-completed-file-restart-verify'); result.lifecycleId = id; result.environment = null; result.tests.push({ status: 'not-run', error: errorText(error) }); display();
        });
        // If the completed-file manifest is absent after it was already verified, still continue to the interrupted-file check.
        await verifyInterruptedAfterRestart(id, query.get('restartConfirmed') === '1');
      }
    } catch (error) {
      if (!result) result = newReport(mode || 'phase3-harness-error');
      result.tests.push({ status: 'fail', error: errorText(error) }); result.finishedAt = new Date().toISOString();
      result.reportCapture = await postReport(result); display(); status('Phase 3 validation failed: ' + errorText(error));
    }
  }
  document.getElementById('phase3-resources').addEventListener('click', function () { runResourceMatrix().catch(function (error) { status('Phase 3 resource matrix failed: ' + errorText(error)); }); });
  document.getElementById('phase3-interrupt-stages').addEventListener('click', function () { runStageInterruptionProbes().catch(function (error) { status('Stage probe failed: ' + errorText(error)); }); });
  document.getElementById('phase3-audit').addEventListener('click', function () { auditGeneratedArtifacts().catch(function (error) { status('Artifact audit failed: ' + errorText(error)); }); });
  document.getElementById('phase3-save').addEventListener('click', saveReport);
  runFromQuery();
})();
