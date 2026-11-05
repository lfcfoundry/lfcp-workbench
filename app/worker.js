/* Workbench import worker. Classic worker: loads the pinned LFC-pack build, then the ES-module ingest core. */
'use strict';
importScripts('../vendor/lfcp/0.4.24/lfc-pack.js');

const DIR = 'lfcfoundry-workbench', CATALOG = 'catalog.json', SLICE = 256 * 1024, FLUSH = 256 * 1024, MAX_VERIFY = 64 * 1024 * 1024;
const enc = new TextEncoder(), jobs = new Map();
let core = null;
const send = (type, id, data) => self.postMessage(Object.assign({ type, id }, data));
const loadCore = async () => (core ||= Object.assign({}, await import('../src/ingest/delimited.mjs'), await import('../src/ingest/infer.mjs')));
const safe = (s) => String(s || 'dataset').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'dataset';
// Storage layer: OPFS when the browser has it, otherwise memory for this tab only (WebKitGTK 2.52.6 has no navigator.storage).
const OPFS = !!(self.navigator && navigator.storage && navigator.storage.getDirectory);
const MEM = { files: new Map(), catalog: [] };
const STORAGE = OPFS ? 'browser storage (OPFS)' : 'memory, this tab only';
const store = OPFS ? {
  async dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true }); },
  async create(name) { const h = await (await this.dir()).getFileHandle(name, { create: true }); const w = await h.createWritable({ keepExistingData: false }); return { write: (p) => w.write(p), close: () => w.close(), abort: () => w.abort() }; },
  async file(name) { return (await (await this.dir()).getFileHandle(name)).getFile(); },
  async remove(name) { try { await (await this.dir()).removeEntry(name); } catch {} },
  async catalog() { try { return JSON.parse(await (await (await (await this.dir()).getFileHandle(CATALOG)).getFile()).text()); } catch { return []; } },
  async setCatalog(list) { const w = await (await (await this.dir()).getFileHandle(CATALOG, { create: true })).createWritable(); await w.write(JSON.stringify(list)); await w.close(); },
  async orphans(known) { const d = await this.dir(), out = []; for await (const [n, h] of d.entries()) if (h.kind === 'file' && n.endsWith('.json.lfc') && !known.has(n)) out.push({ name: n, bytes: (await h.getFile()).size }); return out; },
} : {
  async create(name) { const parts = []; return { write: async (p) => { parts.push(p.slice()); }, close: async () => { MEM.files.set(name, new Blob(parts)); }, abort: async () => {} }; },
  async file(name) { const f = MEM.files.get(name); if (!f) throw new Error('Dataset not found.'); return f; },
  async remove(name) { MEM.files.delete(name); },
  async catalog() { return MEM.catalog.slice(); },
  async setCatalog(list) { MEM.catalog = list.slice(); },
  async orphans() { return []; },
};
const stop = (job) => { if (job.cancelled) { const e = new Error('Import cancelled.'); e.cancelled = true; throw e; } };

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'cancel') { const j = jobs.get(m.id); if (j) j.cancelled = true; }
  else if (m.type === 'import') importFile(m);
  else if (m.type === 'list') list(m);
  else if (m.type === 'delete') remove(m);
  else if (m.type === 'verify') verify(m);
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
  if (f.size > MAX_VERIFY) return { ok: true, level: 'end marker only (file over 64 MiB)' };
  await LfcPack.init({ readOnly: true });
  const info = LfcPack.info(new Uint8Array(await f.arrayBuffer()));
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
