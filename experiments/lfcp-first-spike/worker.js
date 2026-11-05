/* All parsing, LFCP packing and OPFS writes stay off the UI thread. */
importScripts('../../vendor/lfcp/0.4.19/lfc-pack.js', './src/adapters.js');

'use strict';

var adapters = self.DataWorkbenchAdapters;
var encoder = new TextEncoder();
var jobs = Object.create(null);
var MAX_INSPECT_BYTES = 64 * 1024 * 1024;
var IO_BYTES = 256 * 1024;
var READ_BYTES = 64 * 1024;

self.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.type === 'cancel') { if (jobs[msg.id]) jobs[msg.id].cancelled = true; return; }
  if (msg.type === 'continue-stage') { if (jobs[msg.id] && jobs[msg.id].stageGateResolver) { var resume = jobs[msg.id].stageGateResolver; jobs[msg.id].stageGateResolver = null; resume(); } return; }
  if (msg.type === 'list') { listDatasets(msg.id); return; }
  if (msg.type === 'delete') { deleteDataset(msg.id, msg.name); return; }
  if (msg.type === 'inspect-file') { inspectFile(msg); return; }
  if (msg.type === 'inspect-stored') { inspectStored(msg); return; }
  if (msg.type === 'import') importFile(msg);
};

function send(type, id, data) { self.postMessage(Object.assign({ type: type, id: id }, data || {})); }
function cancelled(job) { if (job.cancelled) { var e = new Error('Import cancelled.'); e.cancelled = true; throw e; } }
function textOf(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function nameSafe(s) { return String(s || 'dataset').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'dataset'; }

async function getDatasetDirectory() {
  if (!self.navigator.storage || !self.navigator.storage.getDirectory) throw new Error('This browser does not expose OPFS in this context. Use a secure same-origin page in a supported browser.');
  var root = await self.navigator.storage.getDirectory();
  return root.getDirectoryHandle('lfcfoundry-data-workbench', { create: true });
}

function profileState() {
  return { rows: 0, columns: Object.create(null), names: [], capped: false, rootTypes: Object.create(null) };
}
function valueType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer/number' : 'number';
  return typeof v;
}
function observe(profile, value) {
  profile.rows++;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    var rt = valueType(value); profile.rootTypes[rt] = (profile.rootTypes[rt] || 0) + 1; return;
  }
  var keys = Object.keys(value);
  if (keys.length > 4096) throw new Error('A JSONL object has more than the 4096-field prototype limit.');
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key.length > 512) throw new Error('A JSONL field name is over the 512-character prototype limit.');
    if (!profile.columns[key]) {
      if (profile.names.length >= 256) { profile.capped = true; continue; }
      profile.columns[key] = { present: 0, nulls: 0, types: Object.create(null), values: Object.create(null), samples: [] };
      profile.names.push(key);
    }
    var col = profile.columns[key], v = value[key], t = valueType(v);
    col.present++; col.types[t] = (col.types[t] || 0) + 1;
    if (v === null) col.nulls++;
    var shown = typeof v === 'string' ? v : JSON.stringify(v);
    if (shown === undefined) shown = String(v);
    if (shown.length > 120) shown = shown.slice(0, 117) + '…';
    if (!Object.prototype.hasOwnProperty.call(col.values, shown)) {
      if (col.samples.length < 8) col.samples.push(shown);
      if (Object.keys(col.values).length < 65) col.values[shown] = true;
    }
  }
}
function profileRows(profile) {
  return profile.names.map(function (name) {
    var c = profile.columns[name], types = Object.keys(c.types).sort().join(', ');
    var distinct = Object.keys(c.values).length >= 65 ? '64+' : String(Object.keys(c.values).length);
    return { field: name, types: types || 'unknown', present: c.present, missing: profile.rows - c.present, nulls: c.nulls, distinctSample: distinct, examples: c.samples };
  });
}

async function importFile(msg) {
  var job = { cancelled: false }; jobs[msg.id] = job;
  var writable = null, dir = null, filename = null, closed = false, workerHeapSampler = null, workerHeapPeak = null, workerHeapSamples = 0;
  try {
    if (!msg.file) throw new Error('No source file was provided.');
    var format = msg.format;
    if (format === 'auto') {
      var lower = msg.file.name.toLowerCase();
      format = /\.tsv$/.test(lower) ? 'tsv' : (/\.(jsonl|ndjson)$/.test(lower) ? 'jsonl' : (/\.csv$/.test(lower) ? 'csv' : ''));
    }
    if (!['csv', 'tsv', 'jsonl'].includes(format)) throw new Error('Choose CSV, TSV or JSONL/NDJSON for this prototype.');
    await LfcPack.init();
    cancelled(job);
    dir = await getDatasetDirectory();
    var unique = self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID() : (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    filename = nameSafe(msg.file.name.replace(/\.[^.]+$/, '')) + '-' + unique + '.json.lfc';
    var handle = await dir.getFileHandle(filename, { create: true });
    async function reportStage(stage, data) {
      if (!msg.stageHooks) return;
      send('stage', msg.id, Object.assign({ stage: stage, filename: filename }, data || {}));
      if (msg.stageGateAt === stage) await new Promise(function (resolve) { job.stageGateResolver = resolve; });
    }
    await reportStage('file-created', { outputBytes: 0 });
    writable = await handle.createWritable({ keepExistingData: false });
    await reportStage('writable-open', { outputBytes: 0 });
    var outputBytes = 0;
    var schemaMeta = { name: 'rows', rows: 0, columns: [], columnsTruncated: false };
    var meta = { producer: 'LFCFoundry Data Workbench feasibility spike', producerVersion: '0.1.0', sourceFormat: format, sourceName: String(msg.file.name).slice(0, 200), sourceBytes: msg.file.size, tables: [schemaMeta] };
    var packer = LfcPack.packStream({ blockBytes: 262144, share: true, meta: meta });
    var profile = profileState(), sample = [], lineParts = [], queued = 0, rows = 0, header = null, detectedDelimiter = null;
    var lastProgressAt = 0, decodedBytes = 0, measure = !!msg.validationHooks;
    var workerHeapApi = self.performance && self.performance.memory;
    function sampleWorkerHeap() {
      workerHeapSamples++;
      if (workerHeapApi && workerHeapApi.usedJSHeapSize != null) workerHeapPeak = Math.max(workerHeapPeak || 0, workerHeapApi.usedJSHeapSize);
    }
    var metrics = { readMs: 0, parseMs: 0, encodeMs: 0, opfsWriteMs: 0, readCalls: 0, maxInputChunkBytes: 0, maxPendingRecordChars: format === 'jsonl' ? 0 : null, maxQueuedLineChars: 0, outputParts: 0, maxOutputPartBytes: 0, workerHeap: { api: workerHeapApi ? 'performance.memory (non-standard; Worker realm)' : 'not-exposed', sampledPeakUsedHeapBytes: null, samples: 0, samplingIntervalMs: 50 } };
    if (measure) { sampleWorkerHeap(); workerHeapSampler = setInterval(sampleWorkerHeap, 50); }

    async function persistParts(parts) {
      for (var p = 0; p < parts.length; p++) {
        cancelled(job);
        if (msg.stageHooks) await reportStage('opfs-write', { partBytes: parts[p].byteLength, outputBytesBeforeWrite: outputBytes });
        var writeStarted = measure ? performance.now() : 0;
        await writable.write(parts[p]);
        if (measure) metrics.opfsWriteMs += performance.now() - writeStarted;
        outputBytes += parts[p].byteLength;
        if (measure) { metrics.outputParts++; metrics.maxOutputPartBytes = Math.max(metrics.maxOutputPartBytes, parts[p].byteLength); }
        if (msg.stageHooks) await reportStage('opfs-write-complete', { partBytes: parts[p].byteLength, outputBytes: outputBytes });
      }
    }
    async function flushRows() {
      if (!lineParts.length) return;
      var bytes = encoder.encode(lineParts.join('') );
      lineParts.length = 0; queued = 0;
      var encodeStarted = measure ? performance.now() : 0;
      var packedParts = packer.push(bytes);
      if (measure) metrics.encodeMs += performance.now() - encodeStarted;
      await persistParts(packedParts);
    }
    function queueValue(value) {
      rows++;
      observe(profile, value);
      if (sample.length < 80) sample.push(value);
      var line = JSON.stringify(value) + '\n';
      lineParts.push(line); queued += line.length;
      if (measure) metrics.maxQueuedLineChars = Math.max(metrics.maxQueuedLineChars, queued);
    }
    function addSchemaColumn(name, type) {
      if (schemaMeta.columns.length < 512) schemaMeta.columns.push({ id: 'field-' + (schemaMeta.columns.length + 1), name: String(name).slice(0, 200), type: type });
      else schemaMeta.columnsTruncated = true;
    }

    if (format === 'jsonl') {
      var pending = '', decoder = new TextDecoder('utf-8', { fatal: true });
      for (var offset = 0; offset < msg.file.size; offset += READ_BYTES) {
        cancelled(job);
        var end = Math.min(msg.file.size, offset + READ_BYTES);
        var readStarted = measure ? performance.now() : 0;
        var chunk = new Uint8Array(await msg.file.slice(offset, end).arrayBuffer());
        if (measure) { metrics.readMs += performance.now() - readStarted; metrics.readCalls++; metrics.maxInputChunkBytes = Math.max(metrics.maxInputChunkBytes, chunk.byteLength); }
        decodedBytes += chunk.byteLength;
        var parseStarted = measure ? performance.now() : 0;
        pending += decoder.decode(chunk, { stream: end < msg.file.size });
        var at;
        while ((at = pending.indexOf('\n')) >= 0) {
          var text = pending.slice(0, at); pending = pending.slice(at + 1);
          if (measure) metrics.maxPendingRecordChars = Math.max(metrics.maxPendingRecordChars, text.length);
          if (text.endsWith('\r')) text = text.slice(0, -1);
          if (!text.trim()) continue;
          var value;
          try { value = JSON.parse(text); } catch (err) { throw new Error('Invalid JSONL at or before byte ' + end + ': ' + err.message); }
          queueValue(value);
          if (queued >= IO_BYTES) {
            if (measure) { metrics.parseMs += performance.now() - parseStarted; parseStarted = 0; }
            await flushRows();
            if (measure) parseStarted = performance.now();
          }
        }
        if (pending.length > 8 * 1024 * 1024) throw new Error('A JSONL record is over the 8 MiB prototype limit.');
        if (measure) { metrics.maxPendingRecordChars = Math.max(metrics.maxPendingRecordChars, pending.length); metrics.parseMs += performance.now() - parseStarted; metrics.maxQueuedLineChars = Math.max(metrics.maxQueuedLineChars, queued); }
        if (Date.now() - lastProgressAt > 200) { lastProgressAt = Date.now(); send('progress', msg.id, { bytes: decodedBytes, totalBytes: msg.file.size, rows: rows, format: format }); }
      }
      var decoderTailStarted = measure ? performance.now() : 0;
      pending += decoder.decode();
      if (measure) metrics.parseMs += performance.now() - decoderTailStarted;
      if (pending.trim()) {
        var lastValue;
        if (measure) metrics.maxPendingRecordChars = Math.max(metrics.maxPendingRecordChars, pending.length);
        var finalParseStarted = measure ? performance.now() : 0;
        try { lastValue = JSON.parse(pending.replace(/\r$/, '')); } catch (err) { throw new Error('Invalid final JSONL record: ' + err.message); }
        queueValue(lastValue);
        if (measure) metrics.parseMs += performance.now() - finalParseStarted;
      }
      if (measure) metrics.maxQueuedLineChars = Math.max(metrics.maxQueuedLineChars, queued);
      schemaMeta.columns = profileRows(profile).slice(0, 128).map(function (c, i) { return { id: 'field-' + (i + 1), name: c.field.slice(0, 100), nameTruncated: c.field.length > 100, type: c.types, nullable: c.nulls > 0 }; });
      if (profile.names.length > 128) schemaMeta.columnsTruncated = true;
    } else {
      var delimiter = msg.delimiter;
      if (delimiter === 'auto') {
        var sniffStarted = measure ? performance.now() : 0;
        var sniffBytes = new Uint8Array(await msg.file.slice(0, Math.min(msg.file.size, 65536)).arrayBuffer());
        if (measure) { metrics.readMs += performance.now() - sniffStarted; metrics.readCalls++; metrics.maxInputChunkBytes = Math.max(metrics.maxInputChunkBytes, sniffBytes.byteLength); }
        var sniffParseStarted = measure ? performance.now() : 0;
        var sniff = new TextDecoder().decode(sniffBytes);
        delimiter = adapters.detectDelimiter(sniff);
        if (measure) metrics.parseMs += performance.now() - sniffParseStarted;
      }
      if (!delimiter || delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') throw new Error('The delimiter must be one ordinary character.');
      detectedDelimiter = delimiter === '\t' ? 'TAB' : delimiter;
      var headers = null;
      var parser = new adapters.DelimitedParser(delimiter, function (fields) {
        if (!headers) {
          headers = adapters.cleanHeaders(fields);
          header = headers;
          schemaMeta.columns = headers.slice(0, 128).map(function (name, i) { return { id: 'field-' + (i + 1), name: name.slice(0, 100), nameTruncated: name.length > 100, type: 'string', nullable: false }; });
          if (headers.length > 128) schemaMeta.columnsTruncated = true;
          return;
        }
        if (fields.length !== headers.length) throw new Error('A row has ' + fields.length + ' fields but the header has ' + headers.length + '. Ragged delimited input is not accepted by this prototype.');
        var obj = Object.create(null);
        for (var i = 0; i < headers.length; i++) obj[headers[i]] = fields[i];
        queueValue(obj);
      });
      var csvDecoder = new TextDecoder('utf-8', { fatal: true });
      for (var csvOffset = 0; csvOffset < msg.file.size; csvOffset += READ_BYTES) {
        cancelled(job);
        var csvEnd = Math.min(msg.file.size, csvOffset + READ_BYTES);
        var csvReadStarted = measure ? performance.now() : 0;
        var csvBytes = new Uint8Array(await msg.file.slice(csvOffset, csvEnd).arrayBuffer());
        if (measure) { metrics.readMs += performance.now() - csvReadStarted; metrics.readCalls++; metrics.maxInputChunkBytes = Math.max(metrics.maxInputChunkBytes, csvBytes.byteLength); }
        decodedBytes += csvBytes.byteLength;
        var csvParseStarted = measure ? performance.now() : 0;
        parser.feed(csvDecoder.decode(csvBytes, { stream: csvEnd < msg.file.size }), false);
        if (measure) { metrics.parseMs += performance.now() - csvParseStarted; metrics.maxQueuedLineChars = Math.max(metrics.maxQueuedLineChars, queued); }
        if (queued >= IO_BYTES) await flushRows();
        if (Date.now() - lastProgressAt > 200) { lastProgressAt = Date.now(); send('progress', msg.id, { bytes: decodedBytes, totalBytes: msg.file.size, rows: rows, format: format, delimiter: detectedDelimiter }); }
      }
      var finalCsvParseStarted = measure ? performance.now() : 0;
      parser.feed(csvDecoder.decode(), true);
      if (measure) metrics.parseMs += performance.now() - finalCsvParseStarted;
      if (!header) throw new Error('The delimited file has no header row.');
    }
    cancelled(job);
    await flushRows();
    schemaMeta.rows = rows;
    var finalEncodeStarted = measure ? performance.now() : 0;
    var footer = packer.finish();
    if (measure) metrics.encodeMs += performance.now() - finalEncodeStarted;
    await persistParts(footer);
    cancelled(job);
    await reportStage('finalize', { outputBytes: outputBytes, rows: rows });
    await writable.close(); closed = true; writable = null;
    if (workerHeapSampler) { clearInterval(workerHeapSampler); workerHeapSampler = null; }
    if (measure) { sampleWorkerHeap(); metrics.workerHeap.sampledPeakUsedHeapBytes = workerHeapPeak; metrics.workerHeap.samples = workerHeapSamples; }
    var file = await handle.getFile();
    if (msg.stageHooks) send('stage', msg.id, { stage: 'complete', filename: filename, outputBytes: outputBytes, rows: rows });
    send('done', msg.id, {
      dataset: { name: filename, sourceName: msg.file.name, sourceFormat: format, rows: rows, size: file.size, outputBytes: outputBytes, delimiter: detectedDelimiter, columns: schemaMeta.columns.length, sample: sample, profile: profileRows(profile), profileCapped: profile.capped, rootTypes: profile.rootTypes, schemaColumnsTruncated: schemaMeta.columnsTruncated, metrics: measure ? metrics : null }
    });
  } catch (err) {
    if (workerHeapSampler) { clearInterval(workerHeapSampler); workerHeapSampler = null; }
    if (writable && !closed) { try { await writable.abort(); } catch (_) {} }
    if (filename && dir && !closed) { try { await dir.removeEntry(filename); } catch (_) {} }
    send(err && err.cancelled ? 'cancelled' : 'error', msg.id, { message: String(err && err.message || err) });
  } finally { if (workerHeapSampler) clearInterval(workerHeapSampler); delete jobs[msg.id]; }
}

async function listDatasets(id) {
  try {
    var dir = await getDatasetDirectory(), entries = [];
    for await (var pair of dir.entries()) {
      var name = pair[0], handle = pair[1];
      if (handle.kind !== 'file' || !name.endsWith('.json.lfc')) continue;
      var file = await handle.getFile(), marker = '';
      if (file.size >= 4) marker = textOf(new Uint8Array(await file.slice(file.size - 4).arrayBuffer()));
      entries.push({ name: name, size: file.size, complete: marker === 'LFC1', modified: file.lastModified });
    }
    entries.sort(function (a, b) { return b.modified - a.modified; });
    send('list', id, { entries: entries });
  } catch (err) { send('list', id, { entries: [], message: String(err && err.message || err) }); }
}

async function deleteDataset(id, name) {
  try {
    if (!/^[\w.-]+\.json\.lfc$/.test(name)) throw new Error('Invalid local dataset name.');
    var dir = await getDatasetDirectory();
    await dir.removeEntry(name);
    send('deleted', id, { name: name });
  } catch (err) { send('error', id, { message: String(err && err.message || err) }); }
}

async function inspectFile(msg) {
  try {
    await LfcPack.init({ readOnly: true });
    if (!msg.file) throw new Error('Choose an LFCP file first.');
    if (msg.file.size > MAX_INSPECT_BYTES) throw new Error('This spike will not inspect files over 64 MiB: the pinned reader currently requires the complete file buffer.');
    var bytes = new Uint8Array(await msg.file.arrayBuffer());
    sendInspection(msg.id, msg.file.name, bytes);
  } catch (err) { send('error', msg.id, { message: String(err && err.message || err) }); }
}

async function inspectStored(msg) {
  try {
    var dir = await getDatasetDirectory(), handle = await dir.getFileHandle(msg.name), file = await handle.getFile();
    if (file.size > MAX_INSPECT_BYTES) throw new Error('This spike will not inspect files over 64 MiB: the pinned reader currently requires the complete file buffer.');
    await LfcPack.init({ readOnly: true });
    sendInspection(msg.id, msg.name, new Uint8Array(await file.arrayBuffer()));
  } catch (err) { send('error', msg.id, { message: String(err && err.message || err) }); }
}

function sendInspection(id, name, bytes) {
  var info = LfcPack.info(bytes), stats = LfcPack.stats(bytes), rows = LfcPack.unpackRows(bytes, { from: 0, count: 100 });
  send('inspect', id, { dataset: { name: name, info: info, stats: stats, sample: rows, metadata: LfcPack.metadata(bytes) } });
}
