/* Workbench import worker. Classic worker: loads the pinned LFC-pack build, then the ES-module ingest core. */
'use strict';
importScripts('../vendor/lfcp/0.7.0/lfc-pack.js'); //@@IMPORT_LFC@@

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
  if (m.type === 'cancel') { const j = jobs.get(m.id); if (j) { j.cancelled = true; if (j.abort) j.abort(); } }
  else if (m.type === 'parseJob') parseJob(m);
  else if (m.type === 'seg') segJob(m);
  else if (m.type === 'packBlock') packBlockJob(m);
  else if (m.type === 'credit') { parseCredits++; if (credit) { const r = credit; credit = null; r(); } }
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


// ---- Byte-level fast path: plain lines go from file bytes to JSON-lines bytes without strings, a row array or a decoder ----
// A line takes this path only when it is plain: ASCII bytes with no quote, backslash or control character, and exactly as many fields as the header.
// Any other line is handed to the character parser, which gives the same stored bytes, the same type tallies and the same error messages.
// The caller only calls run() while the character parser is in a clean state (no open quote, no partly read record).
function numBytes(b, s, f) {   // the same rule as NUM in infer.mjs: -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?
  let p = s; if (b[p] === 45) p++; if (p >= f) return false;
  if (b[p] === 48) p++; else if (b[p] >= 49 && b[p] <= 57) { p++; while (p < f && b[p] >= 48 && b[p] <= 57) p++; } else return false;
  if (p < f && b[p] === 46) { p++; const q = p; while (p < f && b[p] >= 48 && b[p] <= 57) p++; if (p === q) return false; }
  if (p < f && (b[p] === 101 || b[p] === 69)) { p++; if (p < f && (b[p] === 43 || b[p] === 45)) p++; const q = p; while (p < f && b[p] >= 48 && b[p] <= 57) p++; if (p === q) return false; }
  return p === f;
}
function makeFast(headers, plan, trackers, delimiter) {
  const n = headers.length, D = delimiter.charCodeAt(0);
  if (n === 0 || n > 512 || D > 126) return null;
  const keys = headers.map((h, i) => enc.encode((i ? ',' : '{') + JSON.stringify(h) + ':')), isInt = headers.map((_, i) => !!(plan && plan[i]));
  const extra = keys.reduce((a, k) => a + k.length, 0) + 8 * n + 4, fs = new Int32Array(n), fe = new Int32Array(n), tdec = new TextDecoder();
  const F = { off: false, rows: 0, miss: 0 };
  // Parses the plain lines of b[i..) whose line break is before lim; returns where it stopped (the caller handles the next line another way).
  F.run = (b, i, lim, parser, io) => {
    let out = io.buf, o = io.pos, count = 0;
    while (i < b.length && !F.off) {
      const k = b.indexOf(10, i); if (k < 0 || k >= lim) break;
      let e = k; if (e > i && b[e - 1] === 13) e--;
      let ok = e > i, col = 0, p = i; fs[0] = i;
      if (ok) for (; p < e; p++) { const c = b[p]; if (c === D) { fe[col] = p; if (++col >= n) { ok = false; break; } fs[col] = p + 1; } else if (c === 34 || c === 92 || c < 32 || c > 126) { ok = false; break; } }
      if (!ok || col !== n - 1) { if (++F.miss >= 64) F.off = true; break; }
      F.miss = 0; fe[n - 1] = e;
      const need = (e - i) + extra; if (out.length - o < need) { const g = new Uint8Array(Math.max(out.length * 2, o + need)); g.set(out.subarray(0, o)); out = g; }
      for (let c = 0; c < n; c++) {
        const key = keys[c]; for (let q = 0; q < key.length; q++) out[o++] = key[q];
        const s0 = fs[c], f0 = fe[c], len = f0 - s0, t = trackers[c];
        if (len === 0) { if (isInt[c]) { out[o++] = 110; out[o++] = 117; out[o++] = 108; out[o++] = 108; } else { out[o++] = 34; out[o++] = 34; } t.n++; t.empty++; continue; }
        let plain = false;
        if (isInt[c]) {
          const neg = b[s0] === 45 ? 1 : 0;
          if (len > neg && len - neg <= 15) { const c0 = b[s0 + neg]; if (c0 === 48) plain = len === 1; else if (c0 > 48 && c0 <= 57) { plain = true; for (let q = s0 + neg + 1; q < f0; q++) if (b[q] < 48 || b[q] > 57) { plain = false; break; } } }
        }
        if (plain) { for (let q = s0; q < f0; q++) out[o++] = b[q]; if (t.int && !t.bool && !t.date) t.n++; else t.add(tdec.decode(b.subarray(s0, f0))); continue; }
        out[o++] = 34; for (let q = s0; q < f0; q++) out[o++] = b[q]; out[o++] = 34;
        if (!t.int && !t.bool && !t.date && (!t.num || numBytes(b, s0, f0))) t.n++; else t.add(tdec.decode(b.subarray(s0, f0)));
      }
      out[o++] = 125; out[o++] = 10; count++; parser.line++; parser.startLine = parser.line; i = k + 1;
    }
    io.buf = out; io.pos = o; F.rows += count; return i;
  };
  return F;
}

// Reads the file in slices, parses it, tracks column types and hands JSON-lines bytes to onBytes (awaited, so the consumer sets the pace).
// Used twice: in a helper worker (parse on one thread while the import worker packs and writes on another), or inline when a helper cannot start.
// One JSON line per row, built as text without making a row object. A string that needs no escaping gets its quotes added directly (a regex test
// is much cheaper than JSON.stringify in Firefox); anything else goes through JSON.stringify, so the line is valid JSON with the same values.
const NEEDS_ESC = /["\\\u0000-\u001f]/;
function lineBuilder(headers, plan, trackers, typedCell) {
  const n = headers.length, keyQ = headers.map((h, i) => (i ? ',' : '{') + JSON.stringify(h) + ':'), isInt = headers.map((_, i) => !!(plan && plan[i]));
  return (f) => {
    let line = '';
    for (let i = 0; i < n; i++) {
      const raw = f[i]; trackers[i].add(raw);
      const v = isInt[i] ? typedCell(raw) : raw;
      line += keyQ[i] + (typeof v === 'string' ? (NEEDS_ESC.test(v) ? JSON.stringify(v) : '"' + v + '"') : v === null ? 'null' : v);
    }
    return line + '}\n';
  };
}
const sampleRecord = (headers, plan, f, typedCell) => { const rec = Object.create(null); for (let i = 0; i < headers.length; i++) rec[headers[i]] = plan && plan[i] ? typedCell(f[i]) : f[i]; return rec; };
let scratch = new Uint8Array(0);
async function parseStream(file, delimiter, stopFn, onBytes, onProgress, t, plan) {
  await loadCore();
  const { DelimitedParser, IngestError, cleanHeaders, TypeTracker, typedCell } = core;
  let headers = null, trackers = null, build = null, rows = 0, pos = 0, queued = 0, lastProg = 0; const sample = [];
  let acc = '', accN = 0, F = null;
  const drain = () => { if (!accN) return; if (scratch.length - pos < acc.length * 3) { const n = new Uint8Array(Math.max(scratch.length * 2, pos + acc.length * 3)); n.set(scratch.subarray(0, pos)); scratch = n; } pos += enc.encodeInto(acc, scratch.subarray(pos)).written; queued += acc.length; acc = ''; accN = 0; };
  const flush = async () => { drain(); if (!pos) return; const bytes = scratch.slice(0, pos); pos = 0; queued = 0; await onBytes(bytes); };
  const parser = new DelimitedParser(delimiter, (f, line) => {
    if (!headers) { headers = cleanHeaders(f); trackers = headers.map(() => new TypeTracker()); build = lineBuilder(headers, plan, trackers, typedCell); F = makeFast(headers, plan, trackers, delimiter); return; }
    if (f.length !== headers.length) throw new IngestError(`Row has ${f.length} fields but the header has ${headers.length}.`, line);
    acc += build(f); rows++; if (sample.length < 20) sample.push(sampleRecord(headers, plan, f, typedCell)); if (++accN >= 64) drain();
  });
  const dec = new TextDecoder('utf-8', { fatal: true });
  let pre = file.size ? file.slice(0, Math.min(file.size, SLICE)).arrayBuffer() : null;   // the next slice loads while this one is parsed
  for (let off = 0; off < file.size; off += SLICE) {
    stopFn();
    const end = Math.min(file.size, off + SLICE);
    let s = performance.now(); const chunk = new Uint8Array(await pre); t.readMs += performance.now() - s;
    pre = end < file.size ? file.slice(end, Math.min(file.size, end + SLICE)).arrayBuffer() : null;
    s = performance.now();
    for (let i = 0; i < chunk.length;) {
      if (F && !F.off && sample.length >= 20 && cleanState(parser)) { drain(); const io = { buf: scratch, pos }; i = F.run(chunk, i, Infinity, parser, io); scratch = io.buf; pos = io.pos; if (i >= chunk.length) break; }
      const k = !headers || (F && !F.off) ? chunk.indexOf(10, i) : -1;
      if (k < 0) { parser.feed(dec.decode(chunk.subarray(i), { stream: end < file.size }), false); break; }
      parser.feed(dec.decode(chunk.subarray(i, k + 1), { stream: true }), false); i = k + 1;
    }
    t.parseMs += performance.now() - s;
    if (queued >= FLUSH || pos >= FLUSH) await flush();
    if (performance.now() - lastProg > 200) { lastProg = performance.now(); onProgress(end, rows + (F ? F.rows : 0)); }
  }
  parser.feed(dec.decode(), true);
  if (!headers) throw new IngestError('The file has no header row.');
  await flush(); stopFn();
  return { headers, types: trackers.map((x) => ({ type: x.type, nullable: x.nullable })), rows: rows + (F ? F.rows : 0), sample };
}

// Helper-worker side of an import: parse and send bytes back, at most CREDITS buffers ahead of the packer.
const CREDITS = 6;
let credit = null, parseCredits = CREDITS;
async function parseJob(m) {
  const t = { readMs: 0, parseMs: 0 };
  try {
    parseCredits = CREDITS;
    const r = await parseStream(m.file, m.delimiter, () => {}, async (bytes) => {
      while (parseCredits <= 0) await new Promise((res) => { credit = res; });
      parseCredits--; self.postMessage({ type: 'lines', bytes }, [bytes.buffer]);
    }, (bytes, rows) => self.postMessage({ type: 'progress', bytes, rows }), t, m.plan);
    self.postMessage({ type: 'parsed', result: r, t });
  } catch (err) { self.postMessage({ type: 'perror', message: String(err && err.message || err), line: err && err.line || null }); }
}


// ---- Segmented parse: the file is cut into pieces that helpers parse at the same time ----
// A piece starts at the first line break after its cut point, which is a guess (the break may sit inside quotes), and runs to the first
// line break at or after the next cut where the parser is outside quotes. The pieces fit together only if each piece ends exactly where
// the next one started; otherwise the rest of the file is parsed in order from the last verified spot, so the result is always the same.
const SEG_BYTES = 8 * 1048576, SEG_MIN_FILE = 48 * 1048576, SEG_WINDOW = 5;
// Pieces need two parsing helpers that really run side by side. They do in all three test browsers now that rows are built as text
// (when each row was an object, Firefox ran two helpers at half speed each). Tests can force pieces on small files with m.segBytes.
const useSegments = (m, file) => !m.inline && (m.segBytes || (file.size >= SEG_MIN_FILE && (self.navigator && self.navigator.hardwareConcurrency || 2) >= 4));
const cleanState = (p) => p.mode === 0 && !p.seen && p.row.length === 0 && p.field === '' && !p.pendingQuote && !p.skipLF;
// m: file, delimiter, headers (null for the header scan), headerOnly, first, hdrEnd, s (cut), e (next cut), startAt, lineBase, trackers, emit, stopFn.
async function parseSegment(m) {
  await loadCore();
  const { DelimitedParser, IngestError, cleanHeaders, TypeTracker, typedCell } = core;
  const file = m.file, size = file.size, SL = 1048576;
  let start = 0;
  if (m.startAt != null) start = m.startAt;
  else if (m.headerOnly) start = 0;
  else if (m.first) start = m.hdrEnd;
  else { start = size; for (let o = m.s; o < size; o += 65536) { const b = new Uint8Array(await file.slice(o, Math.min(size, o + 65536)).arrayBuffer()); const k = b.indexOf(10); if (k >= 0) { start = o + k + 1; break; } } }
  const limit = Math.max(m.e, start), headers = m.headers, plan = m.plan;
  const trackers = m.trackers || (headers ? headers.map(() => new TypeTracker()) : null), build = headers ? lineBuilder(headers, plan, trackers, typedCell) : null;
  let header = null, rows = 0, pos = 0, acc = '', accN = 0; const sample = [], pieces = [];
  const F = headers && !m.headerOnly ? makeFast(headers, plan, trackers, m.delimiter) : null;
  let buf = new Uint8Array(1 << 20);
  const drain = () => { if (!accN) return; if (buf.length - pos < acc.length * 3) { const n = new Uint8Array(Math.max(buf.length * 2, pos + acc.length * 3)); n.set(buf.subarray(0, pos)); buf = n; } pos += enc.encodeInto(acc, buf.subarray(pos)).written; acc = ''; accN = 0; };
  const flushOut = async () => { drain(); if (!pos) return; const b = buf.slice(0, pos); pos = 0; if (m.emit) await m.emit(b); else pieces.push(b); };
  const parser = new DelimitedParser(m.delimiter, (f, line) => {
    if (m.headerOnly) { if (!header) header = cleanHeaders(f); return; }
    if (f.length !== headers.length) throw new IngestError(`Row has ${f.length} fields but the header has ${headers.length}.`, line);
    acc += build(f); rows++; if (sample.length < 20) sample.push(sampleRecord(headers, plan, f, typedCell)); if (++accN >= 64) drain();
  });
  if (m.lineBase) parser.line = parser.startLine = m.lineBase;
  const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: !m.headerOnly && start > 0 });
  const ready = () => cleanState(parser) && (!m.headerOnly || header);
  let at = start, end = size, finished = false, pre = at < size ? file.slice(at, Math.min(size, at + SL)).arrayBuffer() : null;
  while (at < size && !finished) {
    if (m.stopFn) m.stopFn();
    if (m.headerOnly && at - start > 8 * SL) throw new Error('No line break found near the start of the file.');
    const to = Math.min(size, at + SL), b = new Uint8Array(await pre); pre = to < size ? file.slice(to, Math.min(size, to + SL)).arrayBuffer() : null;   // the next slice loads while this one is parsed
    let i = 0; const from = Math.max(0, limit - at);
    while (i < b.length) {
      if (F && !F.off && sample.length >= 20 && cleanState(parser)) { drain(); const io = { buf, pos }; i = F.run(b, i, from, parser, io); buf = io.buf; pos = io.pos; if (i >= b.length) break; }
      const k1 = F && !F.off ? b.indexOf(10, i) : -1;   // one line by the character parser, then the byte path may take over again
      if (k1 >= 0 && k1 < from) { parser.feed(dec.decode(b.subarray(i, k1 + 1), { stream: true }), false); i = k1 + 1; continue; }
      const k = from < b.length ? b.indexOf(10, Math.max(from, i)) : -1;
      if (k < 0) { parser.feed(dec.decode(b.subarray(i), { stream: true }), false); i = b.length; break; }
      parser.feed(dec.decode(b.subarray(i, k + 1), { stream: true }), false); i = k + 1;
      if (ready()) { end = at + i; finished = true; break; }
    }
    at = to;
    if (pos >= (1 << 22) || acc.length > (1 << 20)) await flushOut();
  }
  if (!finished) { end = size; parser.feed(dec.decode(), true); }
  await flushOut();
  const snap = trackers ? trackers.map((x) => ({ n: x.n, empty: x.empty, int: x.int, num: x.num, bool: x.bool, date: x.date })) : null;
  return { startPos: start, endPos: end, pieces, rows: rows + (F ? F.rows : 0), fast: F ? F.rows : 0, lines: parser.line - 1, header, sample, trackers: snap, eof: !finished };
}

// Pack worker side (LFC-pack 0.7.0): pack one chunk of JSON lines into block bytes; the importer appends the results in order with pushPacked.
async function packBlockJob(m) {
  try { await LfcPack.init(); const r = LfcPack.packBlock(new Uint8Array(m.c), m.o); self.postMessage({ type: 'packed', rid: m.rid, r }, [r.buffer]); }
  catch (err) { self.postMessage({ type: 'packed', rid: m.rid, error: String(err && err.message || err) }); }
}

// Helper side of a segmented import: parse one piece, post the result (the bytes are transferred, not copied).
async function segJob(m) {
  try {
    const r = await parseSegment(m);
    self.postMessage({ type: 'segdone', rid: m.rid, r }, r.pieces.map((b) => b.buffer));
  } catch (err) { self.postMessage({ type: 'segdone', rid: m.rid, r: { error: String(err && err.message || err) } }); }
}


// Import-worker side: cut the file into pieces, let two helpers parse them at the same time, pack the pieces in file order.
// Returns null when this is not possible here (helpers cannot start, no usable header break); the caller then uses the one-helper path.
async function runSegmented(file, delimiter, job, packBytes, progress, t, SEGB, plan) {
  await loadCore(); const { TypeTracker } = core;
  const helpers = [], pending = new Map(); let rid = 0;
  const closeAll = () => helpers.forEach((h) => h.terminate());
  try { for (let i = 0; i < 2; i++) helpers.push(new Worker(self.location.href)); } catch { closeAll(); return null; }
  const failAll = (err) => { for (const p of pending.values()) p.rej(err); pending.clear(); };
  for (const h of helpers) {
    h.onmessage = (e) => { const d = e.data || {}; if (d.type === 'segdone') { const p = pending.get(d.rid); if (p) { pending.delete(d.rid); p.res(d.r); } } };
    h.onerror = (e) => failAll(new Error('The import helper failed: ' + (e && e.message || 'unknown error')));
  }
  const rpc = (h, msg) => new Promise((res, rej) => { const id = ++rid; pending.set(id, { res, rej }); h.postMessage(Object.assign({ type: 'seg', rid: id }, msg)); });
  job.abort = () => { closeAll(); failAll(Object.assign(new Error('Import cancelled.'), { cancelled: true })); };
  const t0 = performance.now();
  try {
    let hdr; try { hdr = await rpc(helpers[0], { file, delimiter, headerOnly: true, e: 0 }); } catch { closeAll(); return null; }
    if (hdr.error || !hdr.header || hdr.eof) { closeAll(); return null; }
    const headers = hdr.header, hdrEnd = hdr.endPos, total = Math.ceil((file.size - hdrEnd) / SEGB);
    const agg = headers.map(() => new TypeTracker());
    let rows = 0, expect = hdrEnd, lineBase = hdr.lines + 1; const sample = [];
    let nextD = 0, nextP = 0, quit = false; const done = new Map(), waiters = new Set();
    const signal = () => { for (const w of [...waiters]) { waiters.delete(w); w(); } };
    const wait = () => new Promise((r) => waiters.add(r));
    const run = async (h) => {
      while (!quit && nextD < total) {
        if (nextD >= nextP + SEG_WINDOW) { await wait(); continue; }
        const k = nextD++, s = hdrEnd + k * SEGB, e = Math.min(file.size, s + SEGB);
        done.set(k, await rpc(h, { file, delimiter, headers, plan, first: k === 0, hdrEnd, s, e }).catch((err) => ({ error: String(err && err.message || err), cancelled: !!(err && err.cancelled) })));
        signal();
      }
    };
    const loops = helpers.map(run);
    let serial = false;
    for (let k = 0; k < total; k++) {
      while (!done.has(k)) { stop(job); await wait(); }
      let r = done.get(k); done.delete(k); nextP = k + 1; signal(); stop(job);
      if (r.error || r.startPos !== expect) {   // a guessed start sat inside quotes: parse this piece again from the verified spot
        t.redos = (t.redos || 0) + 1;
        r = await rpc(helpers[k % helpers.length], { file, delimiter, headers, plan, startAt: expect, hdrEnd, s: expect, e: Math.min(file.size, hdrEnd + (k + 1) * SEGB) }).catch((err) => ({ error: String(err && err.message || err) }));
        stop(job);
        if (r.error || r.startPos !== expect) { serial = true; t.segWhy = 'k=' + k + ' ' + (r.error || ('start ' + r.startPos + ' expected ' + expect)); break; }
      }
      for (const b of r.pieces) await packBytes(b);
      rows += r.rows; t.fastRows = (t.fastRows || 0) + (r.fast || 0); r.trackers.forEach((x, i) => agg[i].merge(x)); for (const rec of r.sample) if (sample.length < 20) sample.push(rec);
      expect = r.endPos; lineBase += r.lines; progress(r.endPos, rows);
      if (r.eof) break;
    }
    quit = true; signal();
    if (serial || expect < file.size) {   // pieces did not fit together (or one failed): parse the rest in order, from the last verified spot
      closeAll();
      const r = await parseSegment({ file, delimiter, headers, plan, startAt: expect, e: file.size, lineBase, trackers: agg, emit: packBytes, stopFn: () => stop(job) });
      rows += r.rows; for (const rec of r.sample) if (sample.length < 20) sample.push(rec);
      t.serialTail = true;
    }
    t.parseMs = performance.now() - t0; t.readMs = 0;
    return { headers, types: agg.map((x) => ({ type: x.type, nullable: x.nullable })), rows, sample, pieces: total };
  } finally { closeAll(); }
}

// Which columns are stored as numbers: those whose first 2,000 rows (from the first MB) are all plain whole numbers or empty, with at least one number.
// Decided once from the sample so every piece and helper agrees; a later value that is not a plain whole number stays text in its cell.
async function samplePlan(file, delimiter) {
  try {
    await loadCore(); const { DelimitedParser, TypeTracker } = core;
    const text = new TextDecoder().decode(new Uint8Array(await file.slice(0, 1048576).arrayBuffer()));
    const rows = []; const parser = new DelimitedParser(delimiter, (f) => { if (rows.length < 2001) rows.push(f); });
    try { parser.feed(text, file.size <= 1048576); } catch { /* a bad row in the sample: use the rows before it */ }
    if (rows.length < 2) return null;
    const cols = rows[0].length, tr = Array.from({ length: cols }, () => new TypeTracker());
    for (let r = 1; r < rows.length; r++) { if (rows[r].length !== cols) return null; for (let c = 0; c < cols; c++) tr[c].add(rows[r][c]); }
    const plan = tr.map((x) => x.type === 'integer' && x.n > x.empty);
    return plan.some(Boolean) ? plan : null;
  } catch { return null; }
}

async function importFile(m) {
  const job = { cancelled: false }; jobs.set(m.id, job);
  let name = null, writable = null, closed = false, helper = null;
  const t0 = performance.now(), t = { readMs: 0, parseMs: 0, packMs: 0, writeMs: 0 };
  try {
    await Promise.all([loadCore(), LfcPack.init()]);
    const { IngestError, detectDelimiter } = core;
    const file = m.file; if (!file) throw new IngestError('No file was provided.');
    let delimiter = m.delimiter || 'auto';
    if (delimiter === 'auto') delimiter = detectDelimiter(new TextDecoder().decode(new Uint8Array(await file.slice(0, 65536).arrayBuffer())));
    name = safe(file.name) + '-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)) + '.json.lfc';
    writable = await store.create(name);
    const meta = { producer: 'LFCFoundry Workbench', producerVersion: '0.2.0', sourceFormat: delimiter === '\t' ? 'tsv' : 'csv', sourceName: String(file.name).slice(0, 200), sourceBytes: file.size, tables: [{ name: 'rows', rows: 0, columns: [] }] };
    let packer = LfcPack.packStream(Object.assign(m.level ? { level: m.level } : {}, { blockBytes: m.blockBytes || 2097152, share: true, meta }));
    let outBytes = 0;
    const write = async (parts) => { for (const p of parts) { stop(job); const s = performance.now(); await writable.write(p); t.writeMs += performance.now() - s; outBytes += p.byteLength; } };
    let packBytes = async (bytes) => { stop(job); const s = performance.now(); const parts = packer.push(bytes); t.packMs += performance.now() - s; await write(parts); };
    let finishPacking = async () => {};
    const packWorkers = m.packWorkers != null ? m.packWorkers : 2;   // measured faster in Firefox, WebKitGTK and Chromium together with the byte-level parser
    let pws = null;   // pack threads; some pages (a downloaded file on Chrome) cannot start a worker from inside a worker, then packing stays on this thread
    if (packWorkers > 0 && useSegments(m, file)) { try { pws = []; for (let i = 0; i < packWorkers; i++) pws.push(new Worker(self.location.href)); } catch { if (pws) pws.forEach((w) => w.terminate()); pws = null; } }
    if (pws) {   // blocks packed by worker threads, appended here in file order (LFC-pack 0.7.0 packBlock / pushPacked)
      const bb = m.blockBytes || 2097152, popts = Object.assign(m.level ? { level: m.level } : {}, { blockBytes: bb, share: false });
      packer = LfcPack.packStream(Object.assign({}, popts, { meta }));
      const ws = [], idle = [], done = new Map(); let seq = 0, emit = 0, parts = [], plen = 0, wake = null, wchain = Promise.resolve(), failed = null;
      const pump = () => { if (wake) { const r = wake; wake = null; r(); } };
      const onPacked = (w) => (e) => {
        const d = e.data; if (d.error) failed = new Error('Pack worker failed: ' + d.error); else done.set(d.rid, d.r);
        idle.push(w);
        wchain = wchain.then(async () => { while (done.has(emit)) { const r = done.get(emit); done.delete(emit); emit++; await write(packer.pushPacked(r)); } pump(); });
        pump();
      };
      for (const w of pws) { w.onmessage = onPacked(w); w.onerror = (e) => { failed = new Error('Pack worker failed: ' + (e && e.message || 'unknown')); pump(); }; ws.push(w); idle.push(w); }
      job.abort = () => { failed = Object.assign(new Error('Import cancelled.'), { cancelled: true }); pump(); };
      const dispatch = async (chunk) => {
        while (!idle.length && !failed) await new Promise((r) => { wake = r; });
        if (failed) throw failed;
        idle.pop().postMessage({ type: 'packBlock', rid: seq++, c: chunk, o: popts }, [chunk.buffer]);
      };
      const take = (n) => { const out = new Uint8Array(n); let at = 0; while (at < n) { const p = parts[0], need = n - at; if (p.length <= need) { out.set(p, at); at += p.length; parts.shift(); } else { out.set(p.subarray(0, need), at); parts[0] = p.subarray(need); at = n; } } plen -= n; return out; };
      packBytes = async (bytes) => {
        stop(job); parts.push(bytes); plen += bytes.length;
        while (plen > bb) {   // cut at the first line end at or after blockBytes, as push would
          let off = 0, cut = -1;
          for (const p of parts) { if (off + p.length > bb) { const k = p.indexOf(10, Math.max(bb - off, 0)); if (k >= 0) { cut = off + k + 1; break; } } off += p.length; }
          if (cut < 0) break;
          await dispatch(take(cut));
        }
      };
      finishPacking = async () => {
        if (plen) await dispatch(take(plen));
        while ((emit < seq || done.size) && !failed) await new Promise((r) => { wake = r; });
        await wchain; if (failed) throw failed;
        ws.forEach((w) => w.terminate());
      };
      var packWorkersToStop = ws;
    }
    const plan = m.untyped ? null : await samplePlan(file, delimiter);
    let res = null;
    if (useSegments(m, file)) res = await runSegmented(file, delimiter, job, packBytes, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t, m.segBytes || SEG_BYTES, plan);
    if (!res) try { helper = m.inline ? null : new Worker(self.location.href); } catch { helper = null; }
    if (res) { /* parsed in pieces */ } else if (helper) {   // parse on the helper, pack and write here: both run at once
      res = await new Promise((resolve, reject) => {
        let chain = Promise.resolve();
        job.abort = () => reject(Object.assign(new Error('Import cancelled.'), { cancelled: true }));
        helper.onerror = (e) => reject(new Error('The import helper failed: ' + (e && e.message || 'unknown error')));
        helper.onmessage = (e) => {
          const d = e.data || {};
          if (d.type === 'progress') { send('progress', m.id, { bytes: d.bytes, total: file.size, rows: d.rows }); return; }
          chain = chain.then(async () => {
            if (d.type === 'lines') { await packBytes(d.bytes); helper.postMessage({ type: 'credit' }); }
            else if (d.type === 'parsed') { t.readMs = d.t.readMs; t.parseMs = d.t.parseMs; resolve(d.result); }
            else if (d.type === 'perror') reject(Object.assign(new IngestError(d.message), { line: d.line, message: d.message }));
          }).catch(reject);
        };
        helper.postMessage({ type: 'parseJob', file, delimiter, plan });
      });
    } else res = await parseStream(file, delimiter, () => stop(job), packBytes, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t, plan);
    const { headers, types, rows, sample } = res; stop(job);
    meta.tables[0].rows = rows; meta.tables[0].columns = headers.slice(0, 128).map((h, i) => ({ id: 'field-' + (i + 1), name: h.slice(0, 100), type: types[i].type, nullable: types[i].nullable }));
    await finishPacking();
    await write(packer.finish());
    await writable.close(); closed = true; writable = null;
    // Complete only after the footer is validated, then recorded in the catalog.
    const v = await validate(name, rows);
    if (!v.ok) throw new IngestError('The written file failed footer validation: ' + v.reason);
    const cols = headers.map((h, i) => ({ name: h, type: types[i].type, nullable: types[i].nullable }));
    const cat = await store.catalog(); cat.push({ name, source: file.name, rows, bytes: outBytes, columns: cols, created: Date.now(), storage: STORAGE }); await store.setCatalog(cat);
    send('done', m.id, { dataset: { name, source: file.name, rows, bytes: outBytes, storage: STORAGE, delimiter: delimiter === '\t' ? 'TAB' : delimiter, columns: cols, sample, validation: v, ms: Math.round(performance.now() - t0), timing: { readMs: Math.round(t.readMs), parseMs: Math.round(t.parseMs), packMs: Math.round(t.packMs), writeMs: Math.round(t.writeMs), pieces: (res && res.pieces) || 0, redos: t.redos || 0, fastRows: t.fastRows || 0 }, plan: plan ? plan.map(Boolean) : null, parallel: !!helper || !!(res && res.pieces), segmented: !!(res && res.pieces), serialTail: !!t.serialTail, redos: t.redos || 0, segWhy: t.segWhy } });
  } catch (err) {
    if (writable && !closed) { try { await writable.abort(); } catch {} }
    if (name) await store.remove(name);
    send(err && err.cancelled ? 'cancelled' : 'error', m.id, { message: String(err && err.message || err), line: err && err.line || null });
  } finally { if (helper) helper.terminate(); if (typeof packWorkersToStop !== 'undefined') packWorkersToStop.forEach((w) => w.terminate()); jobs.delete(m.id); }
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
const MAX_COLUMN_ROWS = 20000000;   // column path: only the filtered and sorted columns are decoded, one block at a time
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
// browsers); a bigger one is read a block at a time with R.columns (LFC-pack 0.7.0), so memory stays at the kept columns plus one block.
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
// Number ranges per block (LFC-pack 0.7.0 R.zone, metadata only): a block whose range cannot satisfy a number filter is never decoded.
// A block with no range (text cells, empty cells, or an older file) is always kept. Used only when it keeps at most a fifth of the blocks.
async function zonePlan(filters, active) {
  const need = [];
  for (const name of active) {
    const col = view.columns.find((c) => c.name === name); if (!col) continue;
    const { filter: f } = queryMod.parseFilter(filters[name], col.type); if (!f) continue;
    if (col.type === 'integer' && f.kind === 'num' && f.op !== 'ne') need.push([name, f.op, f.value]);
    else if (col.type === 'integer' && f.op === 'eq' && /^-?(0|[1-9]\d{0,14})$/.test(f.value)) need.push([name, 'eq', +f.value]);
  }
  if (!need.length || view.R.blocks.length < 8) return null;
  const blocks = [];
  for (let b = 0; b < view.R.blocks.length; b++) {
    let keep = true;
    for (const [name, op, v] of need) {
      const z = await view.R.zone(b, name); if (!z) continue;
      if (op === 'gt' ? z.max <= v : op === 'gte' ? z.max < v : op === 'lt' ? z.min >= v : op === 'lte' ? z.min > v : (v < z.min || v > z.max)) { keep = false; break; }
    }
    if (keep) blocks.push(b);
  }
  if (blocks.length * 5 > view.R.blocks.length) return null;
  let n = 0; for (const b of blocks) n += view.R.blocks[b].rows;
  const rowOf = new Uint32Array(n); let at = 0;
  for (const b of blocks) { const bl = view.R.blocks[b]; for (let i = 0; i < bl.rows; i++) rowOf[at++] = bl.first + i; }
  return { blocks, n, rowOf };
}
async function loadBlocks(zp, names) {
  const out = {}; for (const nm of names) out[nm] = new Array(zp.n);
  let at = 0;
  for (const b of zp.blocks) { const e = await view.R.columns(b, { keys: names }); for (const nm of names) { const src = e.cols[nm], dst = out[nm]; for (let i = 0; i < e.n; i++) dst[at + i] = src ? src[i] : ''; } at += e.n; }
  return out;
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
    const zp = m.stream || m.noZones ? null : await zonePlan(m.filters, active);
    if (zp) {   // only the blocks whose number ranges can hold a match are decoded
      const cols = await loadBlocks(zp, names), r = colMod.runColumnQuery(cols, zp.n, view.columns, { filters: m.filters, sort: m.sort }), out = new Uint32Array(r.indices.length);
      for (let k = 0; k < out.length; k++) out[k] = zp.rowOf[r.indices[k]];
      view.indices = out; view.filtered = true;
      return send('queried', m.id, { count: out.length, total: view.total, errors: r.errors, ms: Math.round(performance.now() - t0), decodedAll: false, columnsOnly: names, zoneBlocks: zp.blocks.length, blocks: view.R.blocks.length });
    }
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
const cellText = (v) => v == null ? '' : typeof v === 'string' ? v : String(v);
async function pageView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  let out, numbers;
  if (!view.filtered) {
    const n = Math.max(0, Math.min(m.count, view.total - m.start));
    const objs = n ? await view.R.rows({ from: m.start, count: n }) : [];
    out = objs.map((r) => view.columns.map((c) => cellText(r[c.name]))); numbers = objs.map((_, i) => m.start + i + 1);
  } else {
    const end = Math.min(view.indices.length, m.start + m.count), objs = await rowsAt(view.indices, m.start, end);
    out = objs.map((r) => view.columns.map((c) => cellText(r[c.name]))); numbers = Array.from(view.indices.subarray(m.start, end), (i) => i + 1);
  }
  send('paged', m.id, { start: m.start, rows: out, numbers });
}

// Export: writes the rows now shown (filter and sort applied) as CSV, in batches, into one Blob. Memory is one batch plus the Blob (browsers keep large Blobs off the JS heap).
async function exportView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  try {
    const { csvHeader, csvLines } = MODS() || await import('../src/export/csv.mjs'), d = m.delim || ',', BATCH = view.filtered && !view.rows ? 100000 : 5000;   // scattered rows: a big batch decodes each block once
    const count = view.filtered ? view.indices.length : view.total, parts = [...(m.bom ? ['\uFEFF'] : []), csvHeader(view.columns, d)];
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
