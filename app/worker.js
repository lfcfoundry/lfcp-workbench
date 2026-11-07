/* Workbench import worker. Classic worker: loads the pinned LFC-pack build, then the ES-module ingest core. */
'use strict';
importScripts('../vendor/lfcp/0.5.9/lfc-pack.js'); //@@IMPORT_LFC@@

const DIR = 'lfcfoundry-workbench', CATALOG = 'catalog.json', SLICE = 256 * 1024, FLUSH = 256 * 1024;
const enc = new TextEncoder(), jobs = new Map();
let core = null;
const MODS = () => self.__M || null; // set by the single-file build, which inlines the ES modules
const send = (type, id, data) => self.postMessage(Object.assign({ type, id }, data));
const loadCore = async () => (core ||= MODS() || Object.assign({}, await import('../src/ingest/delimited.mjs'), await import('../src/ingest/infer.mjs')));
const safe = (s) => String(s || 'dataset').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'dataset';
// Storage layer: OPFS when the browser has it, otherwise memory for this tab only (WebKitGTK 2.52.6 has no navigator.storage).
let OPFS = false, STORAGE = 'memory, this tab only';
const MEM = { files: new Map(), catalog: [] };
const opfsStore = {
  async dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true }); },
  async create(name) { const h = await (await this.dir()).getFileHandle(name, { create: true }); const w = await h.createWritable({ keepExistingData: false }); return { write: (p) => w.write(p), close: () => w.close(), abort: () => w.abort() }; },
  async file(name) { return (await (await this.dir()).getFileHandle(name)).getFile(); },
  async remove(name) { try { await (await this.dir()).removeEntry(name); } catch {} },
  async catalog() { try { return JSON.parse(await (await (await (await this.dir()).getFileHandle(CATALOG)).getFile()).text()); } catch { return []; } },
  async setCatalog(list) { const w = await (await (await this.dir()).getFileHandle(CATALOG, { create: true })).createWritable(); await w.write(JSON.stringify(list)); await w.close(); },
  async orphans(known) { const d = await this.dir(), out = []; for await (const [n, h] of d.entries()) if (h.kind === 'file' && n.endsWith('.json.lfc') && !known.has(n)) out.push({ name: n, bytes: (await h.getFile()).size }); return out; },
};
const memStore = {
  async create(name) { const parts = []; return { write: async (p) => { parts.push(p.slice()); }, close: async () => { MEM.files.set(name, new Blob(parts)); }, abort: async () => {} }; },
  async file(name) { const f = MEM.files.get(name); if (!f) throw new Error('Dataset not found.'); return f; },
  async remove(name) { MEM.files.delete(name); },
  async catalog() { return MEM.catalog.slice(); },
  async setCatalog(list) { MEM.catalog = list.slice(); },
  async orphans() { return []; },
};
let store = memStore;
// Some contexts (WebKitGTK, pages opened from a file) have no usable OPFS: look once, fall back to memory.
const storageReady = (async () => { try { await navigator.storage.getDirectory(); OPFS = true; STORAGE = 'browser storage (OPFS)'; store = opfsStore; } catch {} })();
const stop = (job) => { if (job.cancelled) { const e = new Error('Import cancelled.'); e.cancelled = true; throw e; } };

self.onmessage = async (e) => {
  const m = e.data || {};
  await storageReady;
  if (m.type === 'cancel') { const j = jobs.get(m.id); if (j) j.cancelled = true; }
  else if (m.type === 'import') importFile(m);
  else if (m.type === 'list') list(m);
  else if (m.type === 'delete') remove(m);
  else if (m.type === 'verify') verify(m);
  else if (m.type === 'gen') genBig(m);
  else if (m.type === 'genclean') store.remove('scratch-big.csv').then(() => send('cleaned', m.id, {}));
  else if (m.type === 'open') openView(m);
  else if (m.type === 'query') queryView(m);
  else if (m.type === 'page') pageView(m);
  else if (m.type === 'export') exportView(m);
};

async function importFile(m) {
  const job = { cancelled: false }; jobs.set(m.id, job);
  let name = null, writable = null, closed = false;
  const t0 = performance.now(), t = { readMs: 0, parseMs: 0, packMs: 0, writeMs: 0 };
  try {
    await Promise.all([loadCore(), LfcPack.init()]);
    const { DelimitedParser, IngestError, cleanHeaders, detectDelimiter, TypeTracker } = core;
    const file = m.file; if (!file) throw new IngestError('No file was provided.');
    let delimiter = m.delimiter || 'auto';
    if (delimiter === 'auto') delimiter = detectDelimiter(new TextDecoder().decode(new Uint8Array(await file.slice(0, 65536).arrayBuffer())));
    name = safe(file.name) + '-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)) + '.json.lfc';
    writable = await store.create(name);
    const meta = { producer: 'LFCFoundry Workbench', producerVersion: '0.2.0', sourceFormat: delimiter === '\t' ? 'tsv' : 'csv', sourceName: String(file.name).slice(0, 200), sourceBytes: file.size, tables: [{ name: 'rows', rows: 0, columns: [] }] };
    const packer = LfcPack.packStream({ blockBytes: 262144, share: true, meta });
    let headers = null, trackers = null, rows = 0, lines = [], queued = 0, outBytes = 0, lastProg = 0; const sample = [];
    const write = async (parts) => { for (const p of parts) { stop(job); const s = performance.now(); await writable.write(p); t.writeMs += performance.now() - s; outBytes += p.byteLength; } };
    const flush = async () => { if (!lines.length) return; const bytes = enc.encode(lines.join('')); lines = []; queued = 0; const s = performance.now(); const parts = packer.push(bytes); t.packMs += performance.now() - s; await write(parts); };
    const parser = new DelimitedParser(delimiter, (f, line) => {
      if (!headers) { headers = cleanHeaders(f); trackers = headers.map(() => new TypeTracker()); return; }
      if (f.length !== headers.length) throw new IngestError(`Row has ${f.length} fields but the header has ${headers.length}.`, line);
      const rec = Object.create(null);
      for (let i = 0; i < headers.length; i++) { rec[headers[i]] = f[i]; trackers[i].add(f[i]); }
      rows++; if (sample.length < 20) sample.push(rec);
      const s = JSON.stringify(rec) + '\n'; lines.push(s); queued += s.length;
    });
    const dec = new TextDecoder('utf-8', { fatal: true });
    for (let off = 0; off < file.size; off += SLICE) {
      stop(job);
      const end = Math.min(file.size, off + SLICE);
      let s = performance.now(); const chunk = new Uint8Array(await file.slice(off, end).arrayBuffer()); t.readMs += performance.now() - s;
      s = performance.now(); parser.feed(dec.decode(chunk, { stream: end < file.size }), false); t.parseMs += performance.now() - s;
      if (queued >= FLUSH) await flush();
      if (performance.now() - lastProg > 200) { lastProg = performance.now(); send('progress', m.id, { bytes: end, total: file.size, rows }); }
    }
    parser.feed(dec.decode(), true);
    if (!headers) throw new IngestError('The file has no header row.');
    await flush(); stop(job);
    meta.tables[0].rows = rows; meta.tables[0].columns = headers.slice(0, 128).map((h, i) => ({ id: 'field-' + (i + 1), name: h.slice(0, 100), type: trackers[i].type, nullable: trackers[i].nullable }));
    await write(packer.finish());
    await writable.close(); closed = true; writable = null;
    // Complete only after the footer is validated, then recorded in the catalog.
    const v = await validate(name, rows);
    if (!v.ok) throw new IngestError('The written file failed footer validation: ' + v.reason);
    const cols = headers.map((h, i) => ({ name: h, type: trackers[i].type, nullable: trackers[i].nullable }));
    const cat = await store.catalog(); cat.push({ name, source: file.name, rows, bytes: outBytes, columns: cols, created: Date.now(), storage: STORAGE }); await store.setCatalog(cat);
    send('done', m.id, { dataset: { name, source: file.name, rows, bytes: outBytes, storage: STORAGE, delimiter: delimiter === '\t' ? 'TAB' : delimiter, columns: cols, sample, validation: v, ms: Math.round(performance.now() - t0), timing: { readMs: Math.round(t.readMs), parseMs: Math.round(t.parseMs), packMs: Math.round(t.packMs), writeMs: Math.round(t.writeMs) } } });
  } catch (err) {
    if (writable && !closed) { try { await writable.abort(); } catch {} }
    if (name) await store.remove(name);
    send(err && err.cancelled ? 'cancelled' : 'error', m.id, { message: String(err && err.message || err), line: err && err.line || null });
  } finally { jobs.delete(m.id); }
}

async function validate(name, rows) {
  const f = await store.file(name);
  if (f.size < 8) return { ok: false, reason: 'file too small' };
  if (new TextDecoder().decode(new Uint8Array(await f.slice(f.size - 4).arrayBuffer())) !== 'LFC1') return { ok: false, reason: 'end marker missing' };
  await LfcPack.init({ readOnly: true });
  const info = (await LfcPack.open(f)).info; // reads only the trailer and footer, any file size
  if (info.rows !== rows) return { ok: false, reason: `footer says ${info.rows} rows, wrote ${rows}` };
  return { ok: true, level: 'end marker and footer row count' };
}

async function verify(m) { // read a stored dataset back and compare every row with the expected records
  try {
    await LfcPack.init({ readOnly: true });
    const f = await store.file(m.name);
    const back = LfcPack.unpackRows(new Uint8Array(await f.arrayBuffer()));
    send('verified', m.id, { rows: back.length, json: m.expectJson ? JSON.stringify(back) === m.expectJson : null, firstRows: back.slice(0, 3) });
  } catch (err) { send('error', m.id, { message: String(err && err.message || err) }); }
}

async function list(m) {
  try {
    const cat = await store.catalog();
    send('list', m.id, { datasets: cat.slice().reverse(), incomplete: await store.orphans(new Set(cat.map((c) => c.name))), storage: STORAGE });
  } catch (err) { send('list', m.id, { datasets: [], incomplete: [], message: String(err && err.message || err) }); }
}

async function remove(m) {
  try {
    if (!/^[\w.-]+\.json\.lfc$/.test(m.name)) throw new Error('Invalid dataset name.');
    await store.remove(m.name);
    await store.setCatalog((await store.catalog()).filter((c) => c.name !== m.name));
    send('deleted', m.id, { name: m.name });
  } catch (err) { send('error', m.id, { message: String(err && err.message || err) }); }
}

// Grid view. LfcPack.open(file) reads only the trailer and footer; browsing (no filter, no sort) then reads and decodes only the blocks a page needs, so memory is the footer plus one block at any file size.
// A filter or sort decodes every row once (cached), so it is limited by row count.
const MAX_DECODE_ROWS = 1000000;          // fallback path (decodes every row): used only when the file cannot be read by column
const MAX_COLUMN_ROWS = 10000000;   // column path: only the filtered and sorted columns are decoded, one block at a time
let view = null, queryMod = null, colMod = null;
async function openView(m) {
  try {
    await LfcPack.init({ readOnly: true });
    queryMod ||= MODS() || await import('../src/query/query.mjs');
    colMod ||= MODS() || await import('../src/query/columnar.mjs');
    const entry = (await store.catalog()).find((c) => c.name === m.name);
    if (!entry) throw new Error('Dataset not found.');
    const f = await store.file(m.name);
    const R = await LfcPack.open(f), total = R.info.rows;
    view = { name: m.name, R, f, total, rows: null, columns: entry.columns, indices: null, filtered: false, cols: new Map(), flat: R.blocks.length > 0 && R.blocks.every((b) => b.kind === 'f' && !b.table), cache: new Map() };
    send('opened', m.id, { name: m.name, total, columns: entry.columns });
  } catch (err) { view = null; send('error', m.id, { message: String(err && err.message || err) }); }
}
// Column path: only the columns a filter or sort needs are decoded (LfcPack.unpackColumns), kept per column so typing in a filter box does not decode again.
// Falls back to decoding every row when the file has no flat-row blocks.
// Two ways, same result. A stored file up to WHOLE_FILE_MAX is read once and all wanted columns decoded together (2 to 3 times faster in all three
// browsers); a bigger one is read a block at a time with R.columns (LFC-pack 0.5.9), so memory stays at the kept columns plus one block.
const WHOLE_FILE_MAX = 384 * 1048576;
async function loadColumns(names, stream) {
  const want = names.filter((n) => !view.cols.has(n));
  if (want.length) {
    const out = want.map(() => new Array(view.total)); let at = 0;
    const put = (e) => { for (let k = 0; k < want.length; k++) { const src = e.cols[want[k]], dst = out[k]; for (let i = 0; i < e.n; i++) dst[at + i] = src ? src[i] : ''; } at += e.n; };
    if (!stream && view.f.size <= WHOLE_FILE_MAX) { const bytes = new Uint8Array(await view.f.arrayBuffer()); for (const e of LfcPack.unpackColumns(bytes, { keys: want })) put(e); }
    else for (let b = 0; b < view.R.blocks.length; b++) put(await view.R.columns(b, { keys: want }));
    want.forEach((n, k) => view.cols.set(n, out[k]));
  }
  const cols = {}; for (const n of names) cols[n] = view.cols.get(n); return cols;
}
// Row objects for some row numbers, grouped by block so each block is decoded once. Keeps a few decoded blocks for scrolling back and forth.
async function rowsAt(idx, from, to) {
  if (view.rows) { const o = []; for (let i = from; i < to; i++) o.push(view.rows[idx[i]]); return o; }
  const R = view.R, firsts = R.blocks.map((b) => b.first), out = new Array(to - from), byBlock = new Map();
  for (let i = from; i < to; i++) {
    const r = idx[i]; let lo = 0, hi = firsts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (firsts[mid] <= r) lo = mid; else hi = mid - 1; }
    let list = byBlock.get(lo); if (!list) byBlock.set(lo, list = []); list.push(i);
  }
  for (const [b, list] of byBlock) {
    let rows = view.cache.get(b); if (!rows) { rows = await R.block(b); view.cache.set(b, rows); if (view.cache.size > 8) view.cache.delete(view.cache.keys().next().value); }
    for (const i of list) out[i - from] = rows[idx[i] - firsts[b]];
  }
  return out;
}
async function queryView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  const t0 = performance.now(), active = Object.keys(m.filters || {}).filter((k) => m.filters[k]), plain = !m.sort && !active.length;
  if (plain) { view.filtered = false; return send('queried', m.id, { count: view.total, total: view.total, errors: {}, ms: 0, decodedAll: !!view.rows }); }
  const colOk = view.flat && view.total <= MAX_COLUMN_ROWS;
  if (colOk) {
    const names = [...new Set(active.concat(m.sort ? [m.sort.col] : []))].filter((n) => view.columns.some((c) => c.name === n));
    if (m.stream) view.cols.clear();   // test hook: force the block-by-block path
    const cols = await loadColumns(names, m.stream), r = colMod.runColumnQuery(cols, view.total, view.columns, { filters: m.filters, sort: m.sort });
    view.indices = r.indices; view.filtered = true;
    return send('queried', m.id, { count: r.indices.length, total: view.total, errors: r.errors, ms: Math.round(performance.now() - t0), decodedAll: false, columnsOnly: names });
  }
  if (!view.rows) {
    if (view.total > MAX_DECODE_ROWS) return send('queried', m.id, { count: view.total, total: view.total, errors: { '': 'Filtering and sorting work up to ' + (view.flat ? MAX_COLUMN_ROWS : MAX_DECODE_ROWS).toLocaleString() + ' rows for now; this dataset has ' + view.total.toLocaleString() + '. You can still scroll it.' }, ms: 0, decodedAll: false, refused: true });
    view.rows = await view.R.rows({ from: 0, count: view.total });
  }
  const r = queryMod.runQuery(view.rows, view.columns, { filters: m.filters, sort: m.sort });
  view.indices = r.indices; view.filtered = true;
  send('queried', m.id, { count: r.indices.length, total: view.total, errors: r.errors, ms: Math.round(performance.now() - t0), decodedAll: true });
}
async function pageView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  let out, numbers;
  if (!view.filtered) {
    const n = Math.max(0, Math.min(m.count, view.total - m.start));
    const objs = n ? await view.R.rows({ from: m.start, count: n }) : [];
    out = objs.map((r) => view.columns.map((c) => r[c.name] ?? '')); numbers = objs.map((_, i) => m.start + i + 1);
  } else {
    const end = Math.min(view.indices.length, m.start + m.count), objs = await rowsAt(view.indices, m.start, end);
    out = objs.map((r) => view.columns.map((c) => r[c.name] ?? '')); numbers = Array.from(view.indices.subarray(m.start, end), (i) => i + 1);
  }
  send('paged', m.id, { start: m.start, rows: out, numbers });
}

// Export: writes the rows now shown (filter and sort applied) as CSV, in batches, into one Blob. Memory is one batch plus the Blob (browsers keep large Blobs off the JS heap).
async function exportView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  try {
    const { csvHeader, csvLines } = MODS() || await import('../src/export/csv.mjs'), d = m.delim || ',', BATCH = view.filtered && !view.rows ? 100000 : 5000;   // scattered rows: a big batch decodes each block once
    const count = view.filtered ? view.indices.length : view.total, parts = [csvHeader(view.columns, d)];
    for (let start = 0; start < count; start += BATCH) {
      const n = Math.min(BATCH, count - start); let rows;
      if (view.filtered) rows = (await rowsAt(view.indices, start, start + n)).map((r) => view.columns.map((c) => r[c.name] ?? ''));
      else rows = (await view.R.rows({ from: start, count: n })).map((r) => view.columns.map((c) => r[c.name] ?? ''));
      parts.push(csvLines(rows, d));
    }
    const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
    send('exported', m.id, { blob, rows: count, bytes: blob.size });
  } catch (err) { send('error', m.id, { message: String(err && err.message || err) }); }
}

// Big-file check support: builds a deterministic CSV of about m.mb megabytes, on disk (OPFS) when available.
async function genBig(m) {
  try {
    const { HEADER, line } = MODS() || await import('./bigdata.mjs'), target = m.mb * 1048576, parts = []; let w = null, bytes = 0, rows = 0, buf = [], bl = 0;
    if (OPFS) { const h = await (await store.dir()).getFileHandle('scratch-big.csv', { create: true }); w = await h.createWritable({ keepExistingData: false }); }
    const put = async (str) => { const b = enc.encode(str); bytes += b.byteLength; if (w) await w.write(b); else parts.push(b); };
    await put(HEADER);
    while (bytes < target) { const l = line(rows++); buf.push(l); bl += l.length; if (bl >= 1 << 20) { await put(buf.join('')); buf = []; bl = 0; } }
    if (buf.length) await put(buf.join(''));
    let file; if (w) { await w.close(); file = await (await (await store.dir()).getFileHandle('scratch-big.csv')).getFile(); } else file = new File(parts, 'big.csv', { type: 'text/csv' });
    send('generated', m.id, { file, rows, bytes, onDisk: !!w });
  } catch (err) { send('error', m.id, { message: String(err && err.message || err) }); }
}
