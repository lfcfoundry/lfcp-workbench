/* Workbench import worker. Classic worker: loads the pinned LFC-pack build, then the ES-module ingest core. */
'use strict';
importScripts('../vendor/lfcp/0.10.42/lfc-pack.js'); //@@IMPORT_LFC@@

const DIR = 'lfcfoundry-workbench', CATALOG = 'catalog.json', SLICE = 256 * 1024, FLUSH = 256 * 1024;
const enc = new TextEncoder(), jobs = new Map();
let core = null;
const MODS = () => self.__M || null; // set by the single-file build, which inlines the ES modules
const send = (type, id, data) => self.postMessage(Object.assign({ type, id }, data));
const loadCore = async () => (core ||= MODS() || Object.assign({}, await import('../src/ingest/delimited.mjs'), await import('../src/ingest/infer.mjs'), await import('../src/ingest/colbuild.mjs')));
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
// Helper workers start from this script's own address. A page opened from a file has an opaque origin, where Chromium refuses a nested worker from a blob address (SecurityError); the page then makes ready-made helper workers itself and hands this worker one message port for each (the page's CSP only allows blob: workers, so a data: address is not an option). The port answers like a Worker.
const POOL = [];
function portWorker(p) {
  const port = p.port, w = { onmessage: null, onerror: null, postMessage: (m, t) => port.postMessage(m, t || []), terminate: () => { port.close(); self.postMessage({ type: 'helperKill', id: p.id }); self.postMessage({ type: 'helperPool', n: 1 }); } };
  port.onmessage = (e) => { if (w.onmessage) w.onmessage(e); };
  return w;
}
function mkWorker() {
  try { return new Worker(self.location.href); } catch (e) { if (!POOL.length) throw e; return portWorker(POOL.shift()); }
}
if (self.origin === 'null' && /^blob:/.test(self.location.href)) { let blocked = false; try { new Worker(self.location.href).terminate(); } catch { blocked = true; } if (blocked) self.postMessage({ type: 'helperPool', n: 8 }); }   // opaque origin (a page opened from a file): ask the page for helpers
self.addEventListener('message', (e) => {   // a helper made by the page: talk to the importing worker over the port
  const m = e.data; if (!m || m.type !== 'attachPort') return;
  const port = m.port; self.postMessage = (x, t) => port.postMessage(x, t || []); port.onmessage = (ev) => self.onmessage(ev);
});
const stop = (job) => { if (job.cancelled) { const e = new Error('Import cancelled.'); e.cancelled = true; throw e; } };

self.onmessage = async (e) => {
  const m = e.data || {};
  await storageReady;
  if (m.type === 'cancel') { const j = jobs.get(m.id); if (j) { j.cancelled = true; if (j.abort) j.abort(); } }
  else if (m.type === 'ports') m.ids.forEach((id, i) => POOL.push({ id, port: m.ports[i] }));
  else if (m.type === 'attachPort') { /* handled above */ }
  else if (m.type === 'parseJob') parseJob(m);
  else if (m.type === 'seg') segJob(m);
  else if (m.type === 'packBlock') packBlockJob(m);
  else if (m.type === 'packCols') packColsJob(m);
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
  else if (m.type === 'derive') deriveColumn(m);
  else if (m.type === 'groupby') groupView(m);
  else if (m.type === 'exportLfcp') exportLfcp(m);
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
  const keys = headers.map((h, i) => enc.encode((i ? ',' : '{') + JSON.stringify(h) + ':')), isInt = headers.map((_, i) => !!(plan && plan[i] === true)), decN = headers.map((_, i) => (plan && typeof plan[i] === 'number' ? plan[i] : 0));
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
        if (len === 0) { if (isInt[c] || decN[c]) { out[o++] = 110; out[o++] = 117; out[o++] = 108; out[o++] = 108; } else { out[o++] = 34; out[o++] = 34; } t.n++; t.empty++; continue; }
        let plain = false;
        if (isInt[c]) {
          const neg = b[s0] === 45 ? 1 : 0;
          if (len > neg && len - neg <= 15) { const c0 = b[s0 + neg]; if (c0 === 48) plain = len === 1; else if (c0 > 48 && c0 <= 57) { plain = true; for (let q = s0 + neg + 1; q < f0; q++) if (b[q] < 48 || b[q] > 57) { plain = false; break; } } }
        }
        else if (decN[c]) {   // decimal column: a plain decimal with exactly decN digits after the point (see typedDecimal in infer.mjs) is written as a number
          const d = decN[c], neg = b[s0] === 45 ? 1 : 0, dot = len - d - 1;
          if (dot > neg && b[s0 + dot] === 46 && len - neg - 1 <= 15 && !(b[s0 + neg] === 48 && dot - neg > 1)) {
            plain = true; let nz = false;
            for (let q = s0 + neg; q < f0; q++) { if (q === s0 + dot) continue; const c0 = b[q]; if (c0 < 48 || c0 > 57) { plain = false; break; } if (c0 !== 48) nz = true; }
            if (plain && neg && !nz) plain = false;
          }
          if (plain) {   // written as the whole number scaled by 10^d: no point, no leading zeros (12.30 -> 1230, -0.05 -> -5, 0.00 -> 0)
            if (neg) out[o++] = 45; let st = false;
            for (let q = s0 + neg; q < f0; q++) { if (q === s0 + dot) continue; const c0 = b[q]; if (!st && c0 === 48) continue; st = true; out[o++] = c0; }
            if (!st) out[o++] = 48;
            if (!t.int && t.num && !t.bool && !t.date) t.n++; else t.add(tdec.decode(b.subarray(s0, f0))); continue;
          }
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

let X = null; // instance of the row-builder module (null if WebAssembly is missing or refused)
const loadX = () => { if (X === null) { try { const s = atob('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'), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); X = new WebAssembly.Instance(new WebAssembly.Module(u)).exports; } catch (e) { X = false; } } return X; };
// Row builder in WebAssembly (clang, SIMD scanner of 16 bytes at a time, bulk-memory): the same job as makeFast. It checks each cell against the column's type flags (int, number, boolean, date) and stops at any row
// that would change them, so the JavaScript trackers see exactly the rows they saw before. Dates already accepted are remembered in a table so they need no string.
function makeFastW(headers, plan, trackers, delimiter) {
  const n = headers.length, D = delimiter.charCodeAt(0);
  if (n === 0 || n > 64 || D > 126 || typeof WebAssembly === 'undefined' || !loadX()) return null;
  const keys = headers.map((h, i) => enc.encode((i ? ',' : '{') + JSON.stringify(h) + ':'));
  const extra = keys.reduce((a, k) => a + k.length, 0) + 8 * n + 4; if (extra > 8000) return null;
  X.setup(n, D, extra);
  const IN = (X.__heap_base.value + 15) & ~15, OUT = IN + 2097152 + 64, CAP = 6291456, SLOTS = 8;
  const m8 = new Uint8Array(X.memory.buffer); if (m8.length < OUT + CAP) return null;
  const kp = X.keys_ptr(), flagsP = X.flags_ptr(), cn = new Uint32Array(X.memory.buffer, X.cnt_n_ptr(), 64), ce = new Uint32Array(X.memory.buffer, X.cnt_e_ptr(), 64);
  let off = 0, slotNo = 0; const slot = new Uint8Array(n).fill(255), synced = new Int32Array(n);
  for (let c = 0; c < n; c++) { m8.set(keys[c], kp + off); X.set_col(c, off, keys[c].length, plan && plan[c] === true ? 1 : plan && typeof plan[c] === 'number' && plan[c] > 0 && plan[c] < 10 ? 16 + plan[c] : 0, 255); off += keys[c].length; }
  const F = { off: false, rows: 0, miss: 0 };
  F.run = (b, i, lim, parser, io) => {
    for (let c = 0; c < n; c++) {
      const t = trackers[c]; if (t.date && slot[c] === 255 && slotNo < SLOTS) { slot[c] = slotNo++; X.set_slot(c, slot[c]); } m8[flagsP + c] = (t.int ? 1 : 0) | (t.num ? 2 : 0) | (t.bool ? 4 : 0) | (t.date ? 8 : 0);
      if (t.date && slot[c] !== 255 && t.okDates.size > synced[c]) { for (const v of t.okDates) { const e = enc.encode(v); m8.set(e, IN); X.cache_add(slot[c], IN, e.length); } synced[c] = t.okDates.size; }
    }
    let out = io.buf, o = io.pos, count = 0; const end = Math.min(b.length, lim);
    while (i < end && !F.off) {
      const len = Math.min(end - i, 2097152); m8.set(b.subarray(i, i + len), IN);
      const used = X.build(IN, len, OUT, CAP), ol = X.out_len(), r = X.rows(), bail = X.bail();
      if (ol) { if (out.length - o < ol) { const g = new Uint8Array(Math.max(out.length * 2, o + ol)); g.set(out.subarray(0, o)); out = g; } out.set(m8.subarray(OUT, OUT + ol), o); o += ol; }
      if (r) { for (let c = 0; c < n; c++) { trackers[c].n += cn[c]; trackers[c].empty += ce[c]; } parser.line += r; parser.startLine = parser.line; count += r; F.miss = 0; }
      i += used;
      if (bail) { if (++F.miss >= 64) F.off = true; break; }
      if (used === 0) break;
    }
    io.buf = out; io.pos = o; F.rows += count; return i;
  };
  return F;
}

// ---- Staged columns: plain lines go from file bytes straight to typed column chunks (WebAssembly, wasm/colbuild.c), no JSON text ----
// A chunk is { n, bytes, cols } with one entry per column: a Float64Array (whole numbers, or decimals scaled by 10^d; NaN = empty cell) or { bytes, start, end } (text, as byte offsets).
// The wasm builder takes the lines that keep every column's type flags (the same rules as the row builder above) and stops at any other line; that line goes through
// the character parser (slow rows, below) and lands in the same columns, so the result does not depend on which path a line took.
// A cell that stays text in a number column (for example "007") cannot live in a Float64Array: the import stops with err.mixed and starts again on the JSON-lines path.
const mixedErr = () => Object.assign(new Error('A number column holds a text-like cell; the file is imported on the text path.'), { mixed: true });
const COLB = 1048576;   // bytes of CSV per wasm call and per chunk
let C = null;
const loadC = () => { if (C === null) { try { const s = atob('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'), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); C = new WebAssembly.Instance(new WebAssembly.Module(u)).exports; } catch { C = false; } } return C; };
function makeColW(headers, plan, trackers, delimiter, sink, dict, dictOn) {
  const n = headers.length, D = delimiter.charCodeAt(0);
  if (n === 0 || n > 64 || D > 126 || typeof WebAssembly === 'undefined' || !core.placeColumns || !loadC()) return null;
  const B = core.placeColumns(C, headers, plan, delimiter, { capRows: 32768, chunkBytes: COLB, dict }); if (dictOn) for (let c = 0; c < n; c++) dictOn[c] = B.isDict(c);
  const flagsP = B.exports.flags_ptr(), cn = new Uint32Array(B.memory.buffer, B.exports.cnt_n_ptr(), 64), ce = new Uint32Array(B.memory.buffer, B.exports.cnt_e_ptr(), 64);
  const slot = new Uint8Array(n).fill(255), synced = new Int32Array(n); let slotNo = 0; const SLOTS = 8;
  const F = { off: false, rows: 0, miss: 0 };
  // Same contract as makeFastW's run: takes the plain lines of b[i..) whose line break is before lim, returns where it stopped.
  F.run = (b, i, lim, parser) => {
    const m8 = B.mem();
    for (let c = 0; c < n; c++) {
      const t = trackers[c]; if (t.date && slot[c] === 255 && slotNo < SLOTS) { slot[c] = slotNo++; C.set_slot(c, slot[c]); } m8[flagsP + c] = (t.int ? 1 : 0) | (t.num ? 2 : 0) | (t.bool ? 4 : 0) | (t.date ? 8 : 0);
      if (t.date && slot[c] !== 255 && t.okDates.size > synced[c]) { for (const v of t.okDates) { const e = enc.encode(v); m8.set(e, B.IN); C.cache_add(slot[c], B.IN, e.length); } synced[c] = t.okDates.size; }
    }
    const end = Math.min(b.length, lim);
    while (i < end && !F.off) {
      const r = B.build(b.subarray(i, i + Math.min(end - i, COLB)));
      if (r.n) { const m = new Uint32Array(B.memory.buffer, B.exports.cnt_n_ptr(), 64), e = new Uint32Array(B.memory.buffer, B.exports.cnt_e_ptr(), 64); for (let c = 0; c < n; c++) { trackers[c].n += m[c]; trackers[c].empty += e[c]; } parser.line += C.nlines(); parser.startLine = parser.line; F.rows += r.n; F.miss = 0; sink({ n: r.n, bytes: r.used, cols: r.arr }); }
      i += r.used;
      if (r.bail === 'mixed') throw mixedErr();
      if (r.bail === 'dict') { B.undict(r.bailcol); if (dictOn) dictOn[r.bailcol] = false; continue; }   // more than 4096 distinct values in a chunk: this column is text from here on
      if (r.bail) { if (++F.miss >= 64) F.off = true; break; }
      if (r.used === 0) break;
    }
    return i;
  };
  return F;
}
// Lines the wasm builder leaves to the character parser, collected until the next wasm chunk (or the end) and turned into a chunk of the same shape.
function slowRows(headers, plan, trackers, typedCell, typedDecimal, sink, dictOn) {
  const n = headers.length, kind = headers.map((_, c) => (plan && plan[c] === true ? 1 : plan && typeof plan[c] === 'number' && plan[c] > 0 ? plan[c] : 0));
  let vals = headers.map(() => []), rows = 0, bytes = 0;
  return {
    get n() { return rows; },
    add(f) {
      for (let c = 0; c < n; c++) {
        const raw = f[c]; trackers[c].add(raw); bytes += raw.length + 1;
        if (kind[c]) { const v = kind[c] === 1 ? typedCell(raw) : typedDecimal(raw, kind[c]); if (v === null) vals[c].push(NaN); else if (typeof v === 'number') vals[c].push(v); else throw mixedErr(); } else vals[c].push(raw);
      }
      rows++;
    },
    flush() {
      if (!rows) return;
      const cols = headers.map((_, c) => {
        if (kind[c]) return Float64Array.from(vals[c]);
        const strs = vals[c];
        if (dictOn && dictOn[c]) {   // a dictionary column keeps the dictionary shape: a code per row plus the distinct values (text shape when a chunk holds more than 4096)
          const ids = new Map(), codes = new Uint16Array(rows); let ok = true;
          for (let r = 0; r < rows; r++) { let id = ids.get(strs[r]); if (id === undefined) { if (ids.size >= 4096) { ok = false; break; } id = ids.size; ids.set(strs[r], id); } codes[r] = id; }
          if (ok) { const labs = [...ids.keys()]; let cp = 0; for (const x of labs) cp += x.length; const lbb = new Uint8Array(cp * 3), ls = new Uint32Array(labs.length), le = new Uint32Array(labs.length); let lo = 0; for (let q = 0; q < labs.length; q++) { ls[q] = lo; lo += enc.encodeInto(labs[q], lbb.subarray(lo)).written; le[q] = lo; } return { codes, lb: { bytes: lbb.slice(0, lo), start: ls, end: le } }; }
        }
        let cap = 0; for (const s of strs) cap += s.length; const buf = new Uint8Array(cap * 3), start = new Int32Array(rows), end = new Int32Array(rows); let o = 0;
        for (let r = 0; r < rows; r++) { start[r] = o; o += enc.encodeInto(strs[r], buf.subarray(o)).written; end[r] = o; }
        return { bytes: buf.slice(0, o), start, end };
      });
      sink({ n: rows, bytes, cols }); vals = headers.map(() => []); rows = 0; bytes = 0;
    },
  };
}
const dupText = (x) => { if (x.start.buffer === x.end.buffer) { const b = x.start.buffer.slice(0); return { bytes: x.bytes.slice(), start: new Int32Array(b, 0, x.start.length), end: new Int32Array(b, 4, x.end.length) }; } return { bytes: x.bytes.slice(), start: x.start.slice(), end: x.end.slice() }; };   // a text chunk shares one offsets array between start and end: the copy does too
const dupChunk = (c) => ({ n: c.n, bytes: c.bytes, cols: c.cols.map((x) => (x.codes ? { codes: x.codes.slice(), lb: { bytes: x.lb.bytes.slice(), start: x.lb.start.slice(), end: x.lb.end.slice() } } : x.bytes ? dupText(x) : x.slice())) });
const chunkBuffers = (c) => { const o = []; for (const x of c.cols) { if (x.codes) o.push(x.codes.buffer, x.lb.bytes.buffer, x.lb.start.buffer, x.lb.end.buffer); else if (x.bytes) { o.push(x.bytes.buffer, x.start.buffer); if (x.end.buffer !== x.start.buffer) o.push(x.end.buffer); } else o.push(x.buffer); } return o; };
// Dictionary chunk column to the text shape (a code per row to start and end offsets into joined bytes).
function expandDict(x, n) {
  const lb = x.lb; let tb = 0; for (let r = 0; r < n; r++) { const q = x.codes[r]; tb += lb.end[q] - lb.start[q]; }
  const bytes = new Uint8Array(tb), start = new Int32Array(n), end = new Int32Array(n); let o = 0;
  for (let r = 0; r < n; r++) { const q = x.codes[r]; start[r] = o; bytes.set(lb.bytes.subarray(lb.start[q], lb.end[q]), o); o += lb.end[q] - lb.start[q]; end[r] = o; }
  return { bytes, start, end };
}
// Pack worker side: join the chunks of one block (columns side by side, text offsets moved to the joined bytes) and pack them (LFC-pack packBlock over columns).
async function packColsJob(m) {
  try {
    await LfcPack.init();
    const ch = m.chunks, n = m.headers.length; let rows = 0; for (const c of ch) rows += c.n;
    const cols = {}, dk = {};   // dk: the dictionary columns of this block (ids and distinct values), sent back so the page can group by id later
    for (let k = 0; k < n; k++) {
      if (ch.every((c) => c.cols[k].codes)) {   // dictionary column in every chunk: merge the distinct values (codes renumbered) and hand LFC-pack { kind: 'dict', labels, ids }
        const map = new Map(), lat = new TextDecoder('latin1'), ids = new Uint16Array(rows); let tb = 0; const parts = [], st = [], en = [];
        let big = false, ro = 0;
        for (const c of ch) {
          const x = c.cols[k], lb = x.lb, nl = lb.start.length, remap = new Uint32Array(nl);
          for (let q = 0; q < nl; q++) {
            const sub = lb.bytes.subarray(lb.start[q], lb.end[q]), key = lat.decode(sub); let id = map.get(key);
            if (id === undefined) { id = map.size; map.set(key, id); parts.push(sub); st.push(tb); tb += sub.length; en.push(tb); }
            remap[q] = id;
          }
          if (map.size > 65535) big = true;
          for (let r = 0; r < c.n; r++) ids[ro + r] = remap[x.codes[r]];
          ro += c.n;
        }
        if (big) { cols[m.headers[k]] = null; throw new Error('dictionary column with more than 65,535 distinct values in a block'); }
        const bytes = new Uint8Array(tb); let bo = 0; for (const sub of parts) { bytes.set(sub, bo); bo += sub.length; }
        cols[m.headers[k]] = { kind: 'dict', labels: { bytes, start: Uint32Array.from(st), end: Uint32Array.from(en) }, ids };
        dk[m.headers[k]] = { ids: ids.slice(), bytes: bytes.slice(), start: Uint32Array.from(st), end: Uint32Array.from(en) };
        continue;
      }
      for (const c of ch) { const x = c.cols[k]; if (x.codes) c.cols[k] = expandDict(x, c.n); }   // a mix of dictionary and text chunks: all become text
      if (ch[0].cols[k].bytes) {
        let tb = 0; for (const c of ch) tb += c.cols[k].bytes.length;
        const bytes = new Uint8Array(tb), start = new Int32Array(rows), end = new Int32Array(rows); let bo = 0, ro = 0;
        for (const c of ch) { const x = c.cols[k]; bytes.set(x.bytes, bo); for (let r = 0; r < c.n; r++) { start[ro + r] = x.start[r] + bo; end[ro + r] = x.end[r] + bo; } bo += x.bytes.length; ro += c.n; }
        cols[m.headers[k]] = { bytes, start, end };
      } else {   // a number column with empty cells goes to LFC-pack as an array with nulls: its Float64Array form with NaN is 4-5 times slower to pack
        const a = new Float64Array(rows); let ro = 0, nan = false; for (const c of ch) { a.set(c.cols[k], ro); ro += c.n; }
        for (let r = 0; r < rows; r++) if (a[r] !== a[r]) { nan = true; break; }
        cols[m.headers[k]] = nan ? Array.from(a, (x) => (x !== x ? null : x)) : a;
      }
    }
    const r = await LfcPack.packBlock(cols, m.o), tr = [r.buffer]; for (const x of Object.values(dk)) tr.push(x.ids.buffer, x.bytes.buffer, x.start.buffer, x.end.buffer);
    self.postMessage({ type: 'packed', rid: m.rid, r, dk }, tr);
  } catch (err) { self.postMessage({ type: 'packed', rid: m.rid, error: String(err && err.message || err) }); }
}

// Reads the file in slices, parses it, tracks column types and hands JSON-lines bytes to onBytes (awaited, so the consumer sets the pace).
// Used twice: in a helper worker (parse on one thread while the import worker packs and writes on another), or inline when a helper cannot start.
// One JSON line per row, built as text without making a row object. A string that needs no escaping gets its quotes added directly (a regex test
// is much cheaper than JSON.stringify in Firefox); anything else goes through JSON.stringify, so the line is valid JSON with the same values.
const NEEDS_ESC = /["\\\u0000-\u001f]/;
function lineBuilder(headers, plan, trackers, typedCell) {
  const n = headers.length, keyQ = headers.map((h, i) => (i ? ',' : '{') + JSON.stringify(h) + ':'), isInt = headers.map((_, i) => !!(plan && plan[i] === true)), decN = headers.map((_, i) => (plan && typeof plan[i] === 'number' ? plan[i] : 0));
  return (f) => {
    let line = '';
    for (let i = 0; i < n; i++) {
      const raw = f[i]; trackers[i].add(raw);
      const v = isInt[i] ? typedCell(raw) : decN[i] ? core.typedDecimal(raw, decN[i]) : raw;
      line += keyQ[i] + (typeof v === 'string' ? (NEEDS_ESC.test(v) ? JSON.stringify(v) : '"' + v + '"') : v === null ? 'null' : v);   // a decimal column's value is the whole number scaled by 10^decimals (typedDecimal)
    }
    return line + '}\n';
  };
}
const sampleRecord = (headers, plan, f, typedCell) => { const rec = Object.create(null); for (let i = 0; i < headers.length; i++) rec[headers[i]] = plan && plan[i] === true ? typedCell(f[i]) : f[i]; return rec; };
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
// Piece start guess: the first line break after the cut that is followed by a whole record with the right number of fields when read as outside quotes.
// A break inside a quoted cell (a multi-line address, say) gives a wrong field count, so it is skipped; the later check of every piece still decides. -1: no pick.
function pickStart(b, ncols, dl) {
  let nl = b.indexOf(10);
  for (let tries = 0; nl >= 0 && tries < 24; tries++) {
    const st = nl + 1; let q = false, f = 1, ok = false;
    for (let j = st; j < b.length; j++) { const c = b[j]; if (c === 34) q = !q; else if (!q) { if (c === dl) f++; else if (c === 10) { ok = true; break; } } }
    if (!ok) return -1;
    if (f === ncols) return st;
    nl = b.indexOf(10, st);
  }
  return -1;
}
async function parseSegment(m) {
  await loadCore();
  const { DelimitedParser, IngestError, cleanHeaders, TypeTracker, typedCell } = core;
  const file = m.file, size = file.size, SL = 1048576;
  let start = 0;
  if (m.startAt != null) start = m.startAt;
  else if (m.headerOnly) start = 0;
  else if (m.first) start = m.hdrEnd;
  else if (m.headers && m.s < size && (start = pickStart(new Uint8Array(await file.slice(m.s, Math.min(size, m.s + 262144)).arrayBuffer()), m.headers.length, m.delimiter.charCodeAt(0))) >= 0) start += m.s;
  else { start = size; for (let o = m.s; o < size; o += 65536) { const b = new Uint8Array(await file.slice(o, Math.min(size, o + 65536)).arrayBuffer()); const k = b.indexOf(10); if (k >= 0) { start = o + k + 1; break; } } }
  const limit = Math.max(m.e, start), headers = m.headers, plan = m.plan;
  const trackers = m.trackers || (headers ? headers.map(() => new TypeTracker()) : null), build = headers ? lineBuilder(headers, plan, trackers, typedCell) : null;
  let header = null, rows = 0, pos = 0, acc = '', accN = 0; const sample = [], pieces = [];
  const colMode = !!(m.cols && headers && !m.headerOnly), chunks = [];
  const dictOn = headers ? headers.map(() => false) : null;   // which columns are in dictionary shape right now
  const slow = colMode ? slowRows(headers, plan, trackers, typedCell, core.typedDecimal, (c) => chunks.push(c), dictOn) : null;
  const F = headers && !m.headerOnly ? (colMode ? makeColW(headers, plan, trackers, m.delimiter, (c) => { slow.flush(); chunks.push(c); }, m.dict, dictOn) : ((m.wasmRows !== false && makeFastW(headers, plan, trackers, m.delimiter)) || makeFast(headers, plan, trackers, m.delimiter))) : null;
  let buf = new Uint8Array(1 << 20);
  const drain = () => { if (colMode) { slow.flush(); accN = 0; return; } if (!accN) return; if (buf.length - pos < acc.length * 3) { const n = new Uint8Array(Math.max(buf.length * 2, pos + acc.length * 3)); n.set(buf.subarray(0, pos)); buf = n; } pos += enc.encodeInto(acc, buf.subarray(pos)).written; acc = ''; accN = 0; };
  const flushOut = async () => { drain(); if (colMode) { if (m.emit) while (chunks.length) await m.emit(chunks.shift()); return; } if (!pos) return; const b = buf.slice(0, pos); pos = 0; if (m.emit) await m.emit(b); else pieces.push(b); };
  const parser = new DelimitedParser(m.delimiter, (f, line) => {
    if (m.headerOnly) { if (!header) header = cleanHeaders(f); return; }
    if (f.length !== headers.length) throw new IngestError(`Row has ${f.length} fields but the header has ${headers.length}.`, line);
    if (colMode) slow.add(f); else acc += build(f);
    rows++; if (sample.length < 20) sample.push(sampleRecord(headers, plan, f, typedCell)); if (++accN >= 64) drain();
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
    if (pos >= (1 << 22) || acc.length > (1 << 20) || (colMode && m.emit && chunks.length)) await flushOut();
  }
  if (!finished) { end = size; parser.feed(dec.decode(), true); }
  await flushOut();
  const snap = trackers ? trackers.map((x) => ({ n: x.n, empty: x.empty, int: x.int, num: x.num, bool: x.bool, date: x.date })) : null;
  return { startPos: start, endPos: end, pieces, chunks, rows: rows + (F ? F.rows : 0), fast: F ? F.rows : 0, lines: parser.line - 1, header, sample, trackers: snap, eof: !finished };
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
    if (m.dup) r.chunks2 = r.chunks.map(dupChunk);   // live columns: a second copy made here, in parallel, so the import worker keeps one and forwards the other to the pack workers
    self.postMessage({ type: 'segdone', rid: m.rid, r }, r.pieces.map((b) => b.buffer).concat(...r.chunks.map(chunkBuffers), ...(r.chunks2 || []).map(chunkBuffers)));
  } catch (err) { self.postMessage({ type: 'segdone', rid: m.rid, r: { error: String(err && err.message || err), mixed: !!(err && err.mixed) } }); }
}


// Import-worker side: cut the file into pieces, let two helpers parse them at the same time, pack the pieces in file order.
// Returns null when this is not possible here (helpers cannot start, no usable header break); the caller then uses the one-helper path.
async function runSegmented(file, delimiter, job, packBytes, progress, t, SEGB, plan, col, dict) {
  await loadCore(); const { TypeTracker } = core;
  const helpers = [], pending = new Map(); let rid = 0;
  const closeAll = () => helpers.forEach((h) => h.terminate());
  try { for (let i = 0; i < 2; i++) helpers.push(mkWorker()); } catch { closeAll(); return null; }
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
    if (col && headers.length > 64) col = null;   // the column builder takes up to 64 columns
    if (col) await col.begin(headers);
    const cols = !!col; t.cols = cols;
    const agg = headers.map(() => new TypeTracker());
    let rows = 0, expect = hdrEnd, lineBase = hdr.lines + 1; const sample = [];
    let nextD = 0, nextP = 0, quit = false; const done = new Map(), waiters = new Set();
    const signal = () => { for (const w of [...waiters]) { waiters.delete(w); w(); } };
    const wait = () => new Promise((r) => waiters.add(r));
    const run = async (h) => {
      while (!quit && nextD < total) {
        if (nextD >= nextP + SEG_WINDOW) { await wait(); continue; }
        const k = nextD++, s = hdrEnd + k * SEGB, e = Math.min(file.size, s + SEGB);
        done.set(k, await rpc(h, { file, delimiter, headers, plan, dict, cols, dup: !!(col && col.dup), first: k === 0, hdrEnd, s, e }).catch((err) => ({ error: String(err && err.message || err), cancelled: !!(err && err.cancelled) })));
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
        r = await rpc(helpers[k % helpers.length], { file, delimiter, headers, plan, dict, cols, startAt: expect, hdrEnd, s: expect, e: Math.min(file.size, hdrEnd + (k + 1) * SEGB) }).catch((err) => ({ error: String(err && err.message || err) }));
        stop(job);
        if (r.mixed) throw mixedErr();   // from a verified start: the file really has a text-like cell in a number column
        if (r.error || r.startPos !== expect) { serial = true; t.segWhy = 'k=' + k + ' ' + (r.error || ('start ' + r.startPos + ' expected ' + expect)); break; }
      }
      for (const b of r.pieces) await packBytes(b);
      if (col) for (let q = 0; q < r.chunks.length; q++) await col.push(r.chunks[q], r.chunks2 && r.chunks2[q]);
      rows += r.rows; t.fastRows = (t.fastRows || 0) + (r.fast || 0); r.trackers.forEach((x, i) => agg[i].merge(x)); for (const rec of r.sample) if (sample.length < 20) sample.push(rec);
      expect = r.endPos; lineBase += r.lines; progress(r.endPos, rows);
      if (r.eof) break;
    }
    quit = true; signal();
    if (serial || expect < file.size) {   // pieces did not fit together (or one failed): parse the rest in order, from the last verified spot
      closeAll();
      const r = await parseSegment({ file, delimiter, headers, plan, dict, cols, startAt: expect, e: file.size, lineBase, trackers: agg, emit: col ? col.push : packBytes, stopFn: () => stop(job) });
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
  samplePlan.dict = null;
  try {
    await loadCore(); const { DelimitedParser, TypeTracker } = core;
    const text = new TextDecoder().decode(new Uint8Array(await file.slice(0, 1048576).arrayBuffer()));
    const rows = []; const parser = new DelimitedParser(delimiter, (f) => { if (rows.length < 2001) rows.push(f); });
    try { parser.feed(text, file.size <= 1048576); } catch { /* a bad row in the sample: use the rows before it */ }
    if (rows.length < 2) return null;
    const cols = rows[0].length, tr = Array.from({ length: cols }, () => new TypeTracker());
    for (let r = 1; r < rows.length; r++) { if (rows[r].length !== cols) return null; for (let c = 0; c < cols; c++) tr[c].add(rows[r][c]); }
    const plan = tr.map((x, c) => {
      if (x.type === 'integer' && x.n > x.empty) return true;
      if (x.type !== 'number') return false;
      const d = core.sampleDecimals(rows.slice(1).map((r) => r[c]));   // decimals: stored as numbers, with the count kept in the catalog
      return d > 0 && x.n > x.empty ? d : false;
    });
    // low-variety text columns (at most 5% of the sample's rows distinct, and 200+ sample rows) are built as dictionary columns: a code per row and the distinct values
    const nr = rows.length - 1; samplePlan.dict = nr >= 200 ? tr.map((x, c) => { if (plan[c] || x.type === 'empty') return false; const seen = new Set(); for (let r = 1; r < rows.length; r++) { seen.add(rows[r][c]); if (seen.size > nr * 0.05) return false; } return true; }) : null;
    return plan.some(Boolean) ? plan : null;
  } catch { return null; }
}

// Staged columns can find a text-like cell in a number column late in the file; then the whole import runs again on the JSON-lines path (nothing was kept).
async function importFile(m) { if (await importOnce(m) === 'mixed') await importOnce(Object.assign({}, m, { noColumns: true })); }
const columnsOk = (m) => !m.noColumns && typeof WebAssembly !== 'undefined' && (m.columns === true || (!((self.navigator && self.navigator.deviceMemory) < 8) && (!/Android|iPhone|iPad|iPod|Mobile/i.test((self.navigator && self.navigator.userAgent) || '') || (self.navigator && self.navigator.deviceMemory) >= 8)))   // phones too when the browser reports 8 GB or more (Chrome caps the report at 8): measured on an 8 GB Android phone, first rows 1.0 s instead of 1.8-2.0 s, save 16-24% later;
async function importOnce(m) {
  let restart = false;
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
    let packer = LfcPack.packStream(Object.assign({ level: m.level || 3 }, { blockBytes: m.blockBytes || 2097152, share: true, meta }));
    let outBytes = 0;
    const write = async (parts) => { for (const p of parts) { stop(job); const s = performance.now(); await writable.write(p); t.writeMs += performance.now() - s; outBytes += p.byteLength; } };
    let packBytes = async (bytes) => { stop(job); const s = performance.now(); const parts = packer.push(bytes); t.packMs += performance.now() - s; await write(parts); };
    let dkBlocks = null;
    let finishPacking = async () => {}, col = null, colFlush = async () => {}, liveChunks = null, morePack = null;
    const packWorkers = m.packWorkers != null ? m.packWorkers : (m.live === true && file.size <= LIVE_MAX && columnsOk(m) ? 1 : 2);   // live columns: Firefox packs with one worker while parsing (the cores go to the parse helpers) and gets three more when parsing is done; Chromium also packs with one while parsing and gets one more (measured: each is the best of the variants in its browser)   // measured faster in Firefox, WebKitGTK and Chromium together with the byte-level parser
    let pws = null;   // pack threads; some pages (a downloaded file on Chrome) cannot start a worker from inside a worker, then packing stays on this thread
    if (packWorkers > 0 && useSegments(m, file)) { try { pws = []; for (let i = 0; i < packWorkers; i++) pws.push(mkWorker()); } catch { if (pws) pws.forEach((w) => w.terminate()); pws = null; } }
    if (pws) {   // blocks packed by worker threads, appended here in file order (LFC-pack 0.7.0 packBlock / pushPacked)
      const bb = m.blockBytes || 2097152, popts = Object.assign({ level: m.level || 3 }, { blockBytes: bb, share: false });
      packer = LfcPack.packStream(Object.assign({}, popts, { meta }));
      const ws = [], idle = [], done = new Map(); dkBlocks = new Map(); let seq = 0, emit = 0, parts = [], plen = 0, wake = null, wchain = Promise.resolve(), failed = null;
      const pump = () => { if (wake) { const r = wake; wake = null; r(); } };
      const onPacked = (w) => (e) => {
        const d = e.data; if (d.error) failed = new Error('Pack worker failed: ' + d.error); else { done.set(d.rid, d.r); if (d.dk) dkBlocks.set(d.rid, d.dk); }
        idle.push(w);
        wchain = wchain.then(async () => { while (done.has(emit)) { const r = done.get(emit); done.delete(emit); emit++; await write(packer.pushPacked(r)); } pump(); });
        pump();
      };
      for (const w of pws) { w.onmessage = onPacked(w); w.onerror = (e) => { failed = new Error('Pack worker failed: ' + (e && e.message || 'unknown')); pump(); }; ws.push(w); idle.push(w); }
      morePack = (k) => { try { for (let i = 0; i < k; i++) { const w = mkWorker(); w.onmessage = onPacked(w); w.onerror = (e) => { failed = new Error('Pack worker failed: ' + (e && e.message || 'unknown')); pump(); }; ws.push(w); idle.push(w); } pump(); } catch { /* the workers we have keep going */ } };   // parsing is done: its cores join the packing
      job.abort = () => { failed = Object.assign(new Error('Import cancelled.'), { cancelled: true }); pump(); };
      const send1 = async (msg, tr) => {
        while (!idle.length && !failed) await new Promise((r) => { wake = r; });
        if (failed) throw failed;
        idle.pop().postMessage(Object.assign({ rid: seq++ }, msg), tr);
      };
      const dispatch = (chunk) => send1({ type: 'packBlock', c: chunk, o: popts }, [chunk.buffer]);
      if (columnsOk(m)) {   // staged columns: chunks of typed columns are grouped into blocks of about colBlock bytes of CSV and packed by the pack workers
        const colBlock = m.colBlockBytes || 8388608; let cq = [], cqBytes = 0, cqRows = 0, colHeaders = null;
        // Live columns (desktop, file up to LIVE_MAX): the chunks are kept so the grid can read them as soon as parsing ends, while the pack workers still work through their queue.
        // Blocks wait in blockQ and go to the pack workers as copies (the kept chunks are not transferred), so parsing never waits for packing.
        liveChunks = m.live === true && file.size <= LIVE_MAX ? [] : null; let blockQ = [], pumping = null, pumpErr = null;
        const pump = () => { if (!pumping) pumping = (async () => { while (blockQ.length) { const b = blockQ.shift(); await send1({ type: 'packCols', chunks: b, headers: colHeaders, o: popts }, [].concat(...b.map(chunkBuffers))); } })().catch((e) => { pumpErr = e; }).finally(() => { pumping = null; }); };
        const sendCols = async () => { const list = cq; cq = []; cqBytes = 0; cqRows = 0; if (liveChunks) { blockQ.push(list); pump(); } else await send1({ type: 'packCols', chunks: list, headers: colHeaders, o: popts }, [].concat(...list.map(chunkBuffers))); };
        colFlush = async () => { if (cq.length) await sendCols(); while (pumping) await pumping; if (pumpErr) throw pumpErr; };
        col = { begin: async (h) => { colHeaders = h; }, dup: !!liveChunks, push: async (c, c2) => { stop(job); if (liveChunks) { liveChunks.push(c); cq.push(c2 || dupChunk(c)); } else cq.push(c); cqBytes += c.bytes; cqRows += c.n; if (cqBytes >= colBlock && cqRows >= 4096) await sendCols(); } };
      }
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
        await colFlush(); if (plen) await dispatch(take(plen));
        while ((emit < seq || done.size) && !failed) await new Promise((r) => { wake = r; });
        await wchain; if (failed) throw failed;
        ws.forEach((w) => w.terminate());
      };
      var packWorkersToStop = ws;
    }
    const plan = m.untyped ? null : await samplePlan(file, delimiter); const dictPlan = !m.untyped && m.dict !== false ? samplePlan.dict || null : null;
    let res = null;
    if (useSegments(m, file)) res = await runSegmented(file, delimiter, job, packBytes, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t, m.segBytes || SEG_BYTES, plan, col, col ? dictPlan : null);
    if (!res) try { helper = m.inline ? null : mkWorker(); } catch { helper = null; }
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
    const cols = headers.map((h, i) => Object.assign({ name: h, type: types[i].type, nullable: types[i].nullable }, plan && typeof plan[i] === 'number' ? { decimals: plan[i] } : {}));
    if (liveChunks && col && res.pieces && liveChunks.length && rows <= MAX_COLUMN_ROWS) { await startLive(m.id, name, headers, plan, liveChunks, rows, cols); if (view && view.live) for (const c of cols) if (c.type === 'date' && !view.cols.has(c.name)) view.cols.set(c.name, view.live.column(c.name));   /* date columns are the usual sort key: their text is made while the pack workers are still busy, so the first sort after the import has no decode */ if (morePack && m.morePack !== 0) morePack(m.morePack || (isFirefox ? 3 : /Chrome\//.test((self.navigator && navigator.userAgent) || '') ? 1 : 2)); }
    await finishPacking();
    if (dkBlocks && dkBlocks.size) { try { keptDict.set(name, mergeDicts(dkBlocks, rows)); } catch { keptDict.delete(name); } }
    await write(packer.finish());
    await writable.close(); closed = true; writable = null;
    // Complete only after the footer is validated, then recorded in the catalog.
    const v = await validate(name, rows);
    if (!v.ok) throw new IngestError('The written file failed footer validation: ' + v.reason);
    const cat = await store.catalog(); cat.push({ name, source: file.name, rows, bytes: outBytes, columns: cols, created: Date.now(), storage: STORAGE }); await store.setCatalog(cat);
    if (view && view.live && view.name === name) { try { const f2 = await store.file(name), R2 = await LfcPack.open(f2); Object.assign(view, { dictCols: keptDict.get(name) || null, R: R2, f: f2, flat: R2.blocks.length > 0 && R2.blocks.every((b) => b.kind === 'f' && !b.table), live: null }); liveChunks = null; textFromChunks(view); } catch { /* keep reading the kept columns */ } }   // the saved file takes over from the kept columns (same rows, same order)
    send('done', m.id, { dataset: { name, source: file.name, rows, bytes: outBytes, storage: STORAGE, delimiter: delimiter === '\t' ? 'TAB' : delimiter, columns: cols, sample, validation: v, ms: Math.round(performance.now() - t0), timing: { readMs: Math.round(t.readMs), parseMs: Math.round(t.parseMs), packMs: Math.round(t.packMs), writeMs: Math.round(t.writeMs), pieces: (res && res.pieces) || 0, redos: t.redos || 0, fastRows: t.fastRows || 0, columns: !!t.cols }, plan: plan ? plan.map(Boolean) : null, parallel: !!helper || !!(res && res.pieces), segmented: !!(res && res.pieces), serialTail: !!t.serialTail, redos: t.redos || 0, segWhy: t.segWhy } });
  } catch (err) {
    if (view && view.live && view.name === name) { view = null; send('liveclosed', m.id, {}); }
    if (writable && !closed) { try { await writable.abort(); } catch {} }
    if (name) await store.remove(name);
    if (err && err.mixed && !m.noColumns) restart = true;
    else send(err && err.cancelled ? 'cancelled' : 'error', m.id, { message: String(err && err.message || err), line: err && err.line || null });
  } finally { if (helper) helper.terminate(); if (typeof packWorkersToStop !== 'undefined') packWorkersToStop.forEach((w) => w.terminate()); jobs.delete(m.id); }
  return restart ? 'mixed' : null;
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
    const same = m.expectJson ? JSON.stringify(back) === m.expectJson : null; let diff = null;
    if (same === false) { const want = JSON.parse(m.expectJson); for (let i = 0; i < Math.max(want.length, back.length); i++) if (JSON.stringify(back[i]) !== JSON.stringify(want[i])) { diff = { row: i, got: back[i], want: want[i] }; break; } }
    send('verified', m.id, { rows: back.length, json: same, diff, firstRows: back.slice(0, 3) });
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
    await store.remove(m.name); keptDict.delete(m.name);
    await store.setCatalog((await store.catalog()).filter((c) => c.name !== m.name));
    send('deleted', m.id, { name: m.name });
  } catch (err) { send('error', m.id, { message: String(err && err.message || err) }); }
}

// Grid view. LfcPack.open(file) reads only the trailer and footer; browsing (no filter, no sort) then reads and decodes only the blocks a page needs, so memory is the footer plus one block at any file size.
// A filter or sort decodes every row once (cached), so it is limited by row count.
const MAX_DECODE_ROWS = 1000000;          // fallback path (decodes every row): used only when the file cannot be read by column
const MAX_WARM_ROWS = 10000000;   // background decode of the number columns: 10 million rows at most, and not on devices that report 4 GB of memory or less
const FIRST_PAGE_ROWS = 1000;   // a sort answers with this many rows first
const ensureFull = () => { if (view.pending) { const f = view.pending.full(); view.indices = f; view.pending = null; } };
const MAX_COLUMN_ROWS = 20000000;   // column path: only the filtered and sorted columns are decoded, one block at a time
let view = null, queryMod = null, colMod = null;
function scheduleWarm(m, total, delay) {
  // Warm the sort columns: whole-number, decimal and date columns are decoded on helper threads while the person looks at the first page,
  // so the first sort of one of them only has the selection scan left (the decode was most of a first sort).
  if (!m.noWarm && view.flat && total <= MAX_WARM_ROWS && !(self.navigator && navigator.deviceMemory && navigator.deviceMemory <= 4) && LfcPack.unpackColumnsParallel && view.f.size <= WHOLE_FILE_MAX) {
    // Text columns are warmed too when memory allows (about 40 bytes a cell): up to 3 million rows anywhere, up to 10 million on a desktop browser that does not report less than 8 GB.
    const warmText = !m.noWarmText && (total <= 3000000 || (total <= MAX_WARM_ROWS && !/Mobi|Android/.test(navigator.userAgent) && !(navigator.deviceMemory < 8)));
    const v = view, names = v.columns.filter((c) => c.type === 'integer' || c.type === 'number' || c.type === 'date' || (warmText && c.type === 'string')).map((c) => c.name);
    setTimeout(async () => { if (view !== v) return; try { await warmCols(names, true); } catch {} }, 300);
  }
}
async function openView(m) {
  if (view && view.live && view.name === m.name) return send('opened', m.id, { name: m.name, total: view.total, columns: view.columns });   // still being saved: the kept columns answer
  if (view && !view.live && view.name === m.name && view.R && view.cols && !m.fresh) {   // the same dataset is already open (just imported): keep its decoded columns, start with no filter
    view.indices = null; view.filtered = false; view.pending = null; view.rows = null; view.cache = new Map();
    send('opened', m.id, { dictKept: Object.keys(view.dictCols || {}), name: m.name, total: view.total, columns: view.columns, reused: true });
    return scheduleWarm(m, view.total, m.warmDelay == null ? 0 : m.warmDelay);   // the columns the import did not keep are decoded in the background, as after a fresh open
  }
  try {
    await LfcPack.init({ readOnly: true });
    queryMod ||= MODS() || await import('../src/query/query.mjs');
    colMod ||= MODS() || await import('../src/query/columnar.mjs');
    const entry = (await store.catalog()).find((c) => c.name === m.name);
    if (!entry) throw new Error('Dataset not found.');
    const f = await store.file(m.name);
    const R = await LfcPack.open(f), total = R.info.rows;
    view = { dictCols: keptDict.get(m.name) || null, name: m.name, R, f, total, rows: null, columns: entry.columns, indices: null, filtered: false, cols: new Map(), flat: R.blocks.length > 0 && R.blocks.every((b) => b.kind === 'f' && !b.table), cache: new Map() };
    send('opened', m.id, { dictKept: Object.keys(view.dictCols || {}), name: m.name, total, columns: entry.columns, kinds: (() => { const k = {}; R.blocks.forEach((b, i) => { const s = b.kind + (b.table ? 't' + b.table : ''); (k[s] ||= []).length < 3 && k[s].push(i + ':' + b.rows); }); return JSON.stringify(k); })() });
    scheduleWarm(m, total);
  } catch (err) { view = null; send('error', m.id, { message: String(err && err.message || err) }); }
}
// Column path: only the columns a filter or sort needs are decoded (LfcPack.unpackColumns), kept per column so typing in a filter box does not decode again.
// Falls back to decoding every row when the file has no flat-row blocks.
// Two ways, same result. A stored file up to WHOLE_FILE_MAX is read once and all wanted columns decoded together (2 to 3 times faster in all three
// browsers); a bigger one is read a block at a time with R.columns (LFC-pack 0.7.0), so memory stays at the kept columns plus one block.
const WHOLE_FILE_MAX = 384 * 1048576;
// ---- Live columns: the grid reads the kept column chunks while the file is still being saved ----
const isFirefox = !!(self.navigator && /Firefox\//.test(navigator.userAgent));
const LIVE_MAX = 600 * 1048576;   // about 1.04x the CSV in memory while the import runs; bigger files wait for the save
// Equal cells of a text column share one string (a column of repeated values, such as a street name, then costs one string per distinct value, not one per row). Cells are compared as bytes, so a repeated cell makes no string at all.
// Gives up (returns false from add) when the first 20,000 cells are mostly distinct or the table gets too big; the caller then builds plain strings.
function makeInterner() {
  let cap = 4096, mask = cap - 1, tab = new Int32Array(cap), cells = 0, live = true;
  const hs = [], bs = [], ss = [], es = [], strs = [];
  const grow = () => { cap *= 2; mask = cap - 1; tab = new Int32Array(cap); for (let id = 0; id < hs.length; id++) { let p = hs[id] & mask; while (tab[p] !== 0) p = (p + 1) & mask; tab[p] = id + 1; } };
  return {
    get on() { return live; },
    chunk(out, at, b, st, en, rows, make) {   // fills out[at..at+rows); make(bytes, start, end) builds a string for a cell not seen before
      for (let r = 0; r < rows; r++) {
        const a = st[r], e = en[r], len = e - a; let h = Math.imul(len + 2166136261, 16777619); const m = len < 12 ? e : a + 6; for (let i = a; i < m; i++) h = Math.imul(h ^ b[i], 16777619); if (len >= 12) for (let i = e - 6; i < e; i++) h = Math.imul(h ^ b[i], 16777619); h >>>= 0;   // hash of the length and the first and last 6 bytes (a full-bytes compare decides equality)
        let p = h & mask, id = -1;
        for (;;) {
          const t = tab[p]; if (t === 0) break;
          const j = t - 1;
          if (hs[j] === h && es[j] - ss[j] === e - a) { const ob = bs[j], o = ss[j]; let q = 0; const len = e - a; while (q < len && ob[o + q] === b[a + q]) q++; if (q === len) { id = j; break; } }
          p = (p + 1) & mask;
        }
        if (id < 0) { id = hs.length; hs.push(h); bs.push(b); ss.push(a); es.push(e); strs.push(make(b, a, e)); tab[p] = id + 1; if (hs.length * 2 > cap) grow(); }
        out[at + r] = strs[id];
      }
      const before = cells; cells += rows;
      if (before < 20000 && cells >= 20000 && hs.length > cells * 0.4) live = false;
      else if (hs.length > 1000000) live = false;
      return live;
    },
  };
}
async function startLive(id, name, headers, plan, chunks, rows, colsMeta) {
  queryMod ||= MODS() || await import('../src/query/query.mjs'); colMod ||= MODS() || await import('../src/query/columnar.mjs');
  const n = headers.length, starts = new Uint32Array(chunks.length + 1); for (let i = 0; i < chunks.length; i++) starts[i + 1] = starts[i] + chunks[i].n;
  const nums = new Map(), kindOf = headers.map((_, k) => !!(plan && (plan[k] === true || (typeof plan[k] === 'number' && plan[k] > 0)))), dec = new TextDecoder(), latin = new TextDecoder('latin1');
  for (let k = 0; k < n; k++) if (kindOf[k]) { const a = new Float64Array(rows); for (let i = 0; i < chunks.length; i++) a.set(chunks[i].cols[k], starts[i]); nums.set(headers[k], a); }
  const find = (r) => { let lo = 0, hi = chunks.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= r) lo = mid; else hi = mid - 1; } return lo; };
  const L = {
    row(r) { const o = {}, c = find(r), i = r - starts[c]; for (let k = 0; k < n; k++) { if (kindOf[k]) { const x = nums.get(headers[k])[r]; o[headers[k]] = x !== x ? null : x; } else { const x = chunks[c].cols[k]; if (x.codes) { const q = x.codes[i], lb = x.lb; o[headers[k]] = dec.decode(lb.bytes.subarray(lb.start[q], lb.end[q])); } else o[headers[k]] = dec.decode(x.bytes.subarray(x.start[i], x.end[i])); } } return o; },
    *columnGen(nm) {   // a text column (or a number column that stayed text) as an array of strings, made the first time a filter or sort needs it
      const k = headers.indexOf(nm), out = new Array(rows); let at = 0, I = makeInterner();
      const mk = (b, a, e) => dec.decode(b.subarray(a, e));
      for (const ch of chunks) {
        yield;   // between chunks: the caller may let queued messages run
        const x = ch.cols[k];
        if (x.codes) { const lb = x.lb, labs = new Array(lb.start.length); for (let q = 0; q < labs.length; q++) labs[q] = dec.decode(lb.bytes.subarray(lb.start[q], lb.end[q])); for (let r = 0; r < ch.n; r++) out[at++] = labs[x.codes[r]]; continue; }   // dictionary chunk: the distinct values decoded once, one lookup per row
        if (I && I.on) { I.chunk(out, at, x.bytes, x.start, x.end, ch.n, mk); at += ch.n; if (!I.on) I = null; continue; }   // equal cells share one string
        const b = x.bytes; let ascii = true; for (let i = 0; i < b.length; i++) if (b[i] > 127) { ascii = false; break; }
        if (ascii) { const s = latin.decode(b); for (let r = 0; r < ch.n; r++) out[at++] = s.substring(x.start[r], x.end[r]); }   // plain ASCII chunk: one decode, then slices
        else for (let r = 0; r < ch.n; r++) out[at++] = dec.decode(b.subarray(x.start[r], x.end[r]));
      }
      return out;
    },
    column(nm) { const g = this.columnGen(nm); let r; while (!(r = g.next()).done); return r.value; },
  };
  view = { name, R: null, f: null, total: rows, rows: null, columns: colsMeta, indices: null, filtered: false, cols: nums, flat: true, cache: new Map(), live: L };
  send('live', id, { name, total: rows, columns: colsMeta });
  setTimeout(() => { if (colMod.primeTopN) for (const a of nums.values()) colMod.primeTopN(a); }, 0);
  // The text columns the import does not keep as dictionary ids are made from the kept chunks as soon as the import has finished (see textFromChunks): a Save as LFCP or a text sort
  // right after the import finds them in memory instead of decoding them from the file (6 columns: 0.7-0.9 s). Done after, not during, the import so the import time does not change.
  view.liveRest = { names: headers.filter((h, k) => !kindOf[k] && !chunks.every((c) => c.cols[k].codes)), L };
}
async function warmColumn(n) {
  if (view.cols.has(n)) return;
  const v = view, c = v.columns.find((x) => x.name === n), num = c && (c.type === 'integer' || c.type === 'number');
  { const d = v.dictCols && v.dictCols[n]; if (d && c && !num && d.ids.length === v.total) { const arr = new Array(v.total), dict = d.dict, ids = d.ids; for (let i = 0; i < arr.length; i++) arr[i] = dict[ids[i]]; v.cols.set(n, arr); return; } }
  // a number column comes back as a typed array (NaN = empty cell): half the memory, and the top-N sort can scan it without parsing (src/query/topn.mjs)
  const got = await LfcPack.unpackColumnsParallel(new Uint8Array(await v.f.arrayBuffer()), num ? { keys: [n], nulls: 'NaN' } : { keys: [n] });
  if (view === v && got[n] && !v.cols.has(n)) { v.cols.set(n, got[n]); if (ArrayBuffer.isView(got[n]) && colMod && colMod.primeTopN) colMod.primeTopN(got[n]); }
}
async function loadColumns(names, stream, plain) {
  if (view.live) { for (const n of names) if (!view.cols.has(n)) view.cols.set(n, view.live.column(n)); const out = {}; for (const n of names) out[n] = view.cols.get(n); return out; }
  let want = names.filter((n) => !view.cols.has(n));
  if (view.dictCols && want.length && !plain) {   // a text column kept as dictionary ids from the import: its strings come from the distinct values (one lookup per row), no decode of the saved file
    for (const n of want) { const d = view.dictCols[n], c = view.columns.find((x) => x.name === n); if (d && c && c.type !== 'integer' && c.type !== 'number' && d.ids.length === view.total) { const a = new Array(view.total), dict = d.dict, ids = d.ids; for (let i = 0; i < a.length; i++) a[i] = dict[ids[i]]; view.cols.set(n, a); } }
    want = want.filter((n) => !view.cols.has(n));
  }
  if (want.length) {
    const isNum = want.map((n) => { const c = view.columns.find((x) => x.name === n); return !plain && !!c && (c.type === 'integer' || c.type === 'number'); }), bad = [];
    const out = want.map((_, k) => (isNum[k] ? new Float64Array(view.total) : new Array(view.total))); let at = 0;
    const put = (e) => { for (let k = 0; k < want.length; k++) { const src = e.cols[want[k]], dst = out[k]; if (isNum[k]) { for (let i = 0; i < e.n; i++) { const x = src ? src[i] : null; if (typeof x === 'number') dst[at + i] = x; else { dst[at + i] = NaN; if (x != null && x !== '') bad[k] = true; } } } else for (let i = 0; i < e.n; i++) dst[at + i] = src ? src[i] : ''; } at += e.n; };
    if (!stream && view.f.size <= WHOLE_FILE_MAX) { const bytes = new Uint8Array(await view.f.arrayBuffer()); for (const e of LfcPack.unpackColumns(bytes, { keys: want })) put(e); }
    else for (let b = 0; b < view.R.blocks.length; b++) put(await view.R.columns(b, { keys: want }));
    // a cell that is text in a number column (a decimal that did not fit the typed form) cannot live in a typed array: that column is read again as plain cells
    const again = want.filter((n, k) => bad[k]);
    want.forEach((n, k) => { if (!bad[k]) { view.cols.set(n, out[k]); if (isNum[k] && colMod && colMod.primeTopN) colMod.primeTopN(out[k]); } });
    if (again.length) await loadColumns(again, stream, true);
  }
  const cols = {}; for (const n of names) cols[n] = view.cols.get(n); return cols;
}
// A number filter that every row of every block provably satisfies (the footer's range holds for all rows of the block, no empty cells) changes nothing, so it is dropped before
// any column is decoded: no per-row test, and the filter column is not read at all unless the sort needs it.
async function dropFullMatch(filters, active) {
  if (view.live) return null;
  const keep = {}; let dropped = 0;
  for (const name of active) {
    const col = view.columns.find((c) => c.name === name), parsed = col && !col.derived && col.type === 'integer' ? queryMod.parseFilter(filters[name], col.type) : null, f = parsed && parsed.filter;
    let all = !!f && f.kind === 'num' && f.op !== 'ne' && view.R.blocks.length > 0;
    for (let b = 0; all && b < view.R.blocks.length; b++) {
      const z = await view.R.zone(b, name);
      all = !!z && z.count === view.R.blocks[b].rows && (f.op === 'gt' ? z.min > f.value : f.op === 'gte' ? z.min >= f.value : f.op === 'lt' ? z.max < f.value : z.max <= f.value);
    }
    if (all) dropped++; else keep[name] = filters[name];
  }
  return dropped ? keep : null;
}
// Number ranges per block (LFC-pack 0.7.0 R.zone, metadata only): a block whose range cannot satisfy a number filter is never decoded.
// A block with no range (text cells, empty cells, or an older file) is always kept. Used only when it keeps at most a fifth of the blocks.
let zoneMinBlocks = 0;   // test hook (gate=N in the page address): the fewest blocks that make a zone plan worth trying
let posMod = null;
// A number range or equality by row numbers is only exact when every cell of the column is a stored number: a block without a number range may hold text cells.
async function allBlocksHaveZone(col) { if (col.derived) return false; if (col.type !== 'integer') return true; for (let b = 0; b < view.R.blocks.length; b++) if (!(await view.R.zone(b, col.name))) return false; return true; }
async function zonePlan(filters, active) {
  if (view.live) return null;
  const need = [];
  for (const name of active) {
    const col = view.columns.find((c) => c.name === name); if (!col || col.derived) continue;
    const { filter: f } = queryMod.parseFilter(filters[name], col.type); if (!f) continue;
    if (col.type === 'integer' && f.kind === 'num' && f.op !== 'ne') need.push([name, f.op, f.value]);
    else if (col.type === 'integer' && f.op === 'eq' && /^-?(0|[1-9]\d{0,14})$/.test(f.value)) need.push([name, 'eq', +f.value]);
  }
  if (!need.length || view.R.blocks.length < (zoneMinBlocks || 8)) return null;
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
async function rowsAt(idx, from, to) { const o = await rowsAtBase(idx, from, to); if (view.derived && view.derived.size) overlayDerived(o, (i) => idx[from + i]); return o; }
function overlayDerived(objs, rowOf) {   // derived columns live beside the file: put their values into the row objects
  for (const [name, d] of view.derived) for (let i = 0; i < objs.length; i++) { const x = d[rowOf(i)]; objs[i][name] = x !== x ? null : x; }
}
async function rowsAtBase(idx, from, to) {
  if (view.live) { const o = []; for (let i = from; i < to; i++) o.push(view.live.row(idx[i])); return o; }
  if (view.rows) { const o = []; for (let i = from; i < to; i++) o.push(view.rows[idx[i]]); return o; }
  if (view.columns.length && view.columns.every((c) => view.cols.has(c.name))) {   // every column is already warmed: read the visible rows from them, not 28 whole blocks (223 to 57 ms for a score sort of 7M rows)
    const o = [];
    for (let i = from; i < to; i++) { const r = idx[i], row = {}; for (const c of view.columns) { const x = view.cols.get(c.name)[r]; row[c.name] = x !== x ? null : x; } o.push(row); }
    return o;
  }
  const R = view.R, firsts = R.blocks.map((b) => b.first), out = new Array(to - from), byBlock = new Map();
  for (let i = from; i < to; i++) {
    const r = idx[i]; let lo = 0, hi = firsts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (firsts[mid] <= r) lo = mid; else hi = mid - 1; }
    let list = byBlock.get(lo); if (!list) byBlock.set(lo, list = []); list.push(i);
  }
  for (const [b, list] of byBlock) {
    let rows = view.cache.get(b);
    if (rows) { for (const i of list) out[i - from] = rows[idx[i] - firsts[b]]; continue; }
    if (list.length <= 64) { const got = await R.block(b, { rows: list.map((i) => idx[i] - firsts[b]) }); for (let k = 0; k < list.length; k++) out[list[k] - from] = got[k]; continue; }   // few rows of this block: read just those (LFC-pack 0.10.26)
    rows = await R.block(b); view.cache.set(b, rows); if (view.cache.size > 8) view.cache.delete(view.cache.keys().next().value);
    for (const i of list) out[i - from] = rows[idx[i] - firsts[b]];
  }
  return out;
}
async function queryView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  const t0 = performance.now(), active = Object.keys(m.filters || {}).filter((k) => m.filters[k]), plain = !m.sort && !active.length;
  view.pending = null; zoneMinBlocks = m.gate || 0;
  if (plain) { view.filtered = false; return send('queried', m.id, { count: view.total, total: view.total, errors: {}, ms: 0, decodedAll: !!view.rows }); }
  const colOk = view.flat && view.total <= MAX_COLUMN_ROWS;
  if (colOk && !m.noInside) {
    const rest = await dropFullMatch(m.filters, active);
    if (rest) {   // every row matches some filters: run the query with the others only
      const left = Object.keys(rest);
      if (!left.length && !m.sort) { view.filtered = false; return send('queried', m.id, { count: view.total, total: view.total, errors: {}, ms: Math.round(performance.now() - t0), decodedAll: !!view.rows, allInside: true }); }
      m = Object.assign({}, m, { filters: rest });
      return queryView(Object.assign(m, { noInside: true }));
    }
  }
  if (colOk && !m.noPositions && !m.stream && !m.sort && active.length === 1 && !view.live && !view.cols.has(active[0]) && view.f.size <= WHOLE_FILE_MAX) {
    // One filter on a column that is not decoded yet: ask LFC-pack for just the matching row numbers (blocks that cannot match are skipped, no row objects, no whole-column decode)
    try {
      const col = view.columns.find((c) => c.name === active[0]), q = col && (posMod ||= MODS() || await import('../src/query/positions.mjs')).positionsQuery(m.filters[active[0]], col);
      if (q && await allBlocksHaveZone(col)) {
        const idx = LfcPack.unpack(new Uint8Array(await view.f.arrayBuffer()), Object.assign({ positions: true }, q));
        view.indices = idx; view.filtered = true;
        return send('queried', m.id, { count: idx.length, total: view.total, errors: {}, ms: Math.round(performance.now() - t0), decodedAll: false, columnsOnly: [], byPositions: true });
      }
    } catch (err) { view.posError = String(err && err.message || err); }   // anything unexpected: the column path below gives the answer
  }
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
    const cols = await loadColumns(names, m.stream), tLoad = Math.round(performance.now() - t0), tq0 = performance.now(), r = colMod.runColumnQuery(cols, view.total, view.columns, { filters: m.filters, sort: m.sort, top: m.noFirst ? 0 : FIRST_PAGE_ROWS });
    if (r.first) {   // first page first: the best rows now, the full order only when a page beyond them (or an export) needs it
      view.indices = new Uint32Array(r.count); view.indices.set(r.first); view.pending = { topN: r.first.length, full: r.full }; view.filtered = true;
      return send('queried', m.id, { count: r.count, total: view.total, errors: r.errors, ms: Math.round(performance.now() - t0), decodedAll: false, columnsOnly: names, firstPage: r.first.length, loadMs: tLoad, selMs: Math.round(performance.now() - tq0) });
    }
    view.indices = r.indices; view.filtered = true;
    return send('queried', m.id, { count: r.indices.length, total: view.total, errors: r.errors, ms: Math.round(performance.now() - t0), decodedAll: false, columnsOnly: names, loadMs: tLoad, posError: view.posError });
  }
  if (!view.rows) {
    if (view.total > MAX_DECODE_ROWS) return send('queried', m.id, { count: view.total, total: view.total, errors: { '': 'Filtering and sorting work up to ' + (view.flat ? MAX_COLUMN_ROWS : MAX_DECODE_ROWS).toLocaleString() + ' rows for now; this dataset has ' + view.total.toLocaleString() + '. You can still scroll it.' }, ms: 0, decodedAll: false, refused: true });
    view.rows = await view.R.rows({ from: 0, count: view.total });
  }
  const r = queryMod.runQuery(view.rows, view.columns, { filters: m.filters, sort: m.sort });
  view.indices = r.indices; view.filtered = true;
  send('queried', m.id, { count: r.indices.length, total: view.total, errors: r.errors, ms: Math.round(performance.now() - t0), decodedAll: true });
}
const formatScaled = (n, d) => { const a = String(Math.abs(n)).padStart(d + 1, '0'); return (n < 0 ? '-' : '') + a.slice(0, a.length - d) + '.' + a.slice(a.length - d); };   // the same as in query.mjs
const cellText = (v, c) => v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' && c && c.decimals ? formatScaled(v, c.decimals) : String(v);   // a number in a decimal column reads back as the text it was imported from
async function pageView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  let out, numbers;
  if (!view.filtered) {
    const n = Math.max(0, Math.min(m.count, view.total - m.start));
    const objs = n ? (view.live ? Array.from({ length: n }, (_, i) => view.live.row(m.start + i)) : await view.R.rows({ from: m.start, count: n })) : [];
    if (view.derived && view.derived.size) overlayDerived(objs, (i) => m.start + i);
    out = objs.map((r) => view.columns.map((c) => cellText(r[c.name], c))); numbers = objs.map((_, i) => m.start + i + 1);
  } else {
    if (view.pending && m.start + m.count > view.pending.topN) ensureFull();
    const end = Math.min(view.indices.length, m.start + m.count), objs = await rowsAt(view.indices, m.start, end);
    out = objs.map((r) => view.columns.map((c) => cellText(r[c.name], c))); numbers = Array.from(view.indices.subarray(m.start, end), (i) => i + 1);
  }
  send('paged', m.id, { start: m.start, rows: out, numbers });
}

// Export: writes the rows now shown (filter and sort applied) as CSV, in batches, into one Blob. Memory is one batch plus the Blob (browsers keep large Blobs off the JS heap).
async function exportView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  try {
    const { csvHeader, csvLines } = MODS() || await import('../src/export/csv.mjs'), d = m.delim || ',', BATCH = view.filtered && !view.rows ? 100000 : 5000;   // scattered rows: a big batch decodes each block once
    ensureFull();
    if (!m.noFast) await warmAll();   // columns decoded together on helper threads (when not already), then the CSV is written straight from them
    const count = view.filtered ? view.indices.length : view.total, parts = [...(m.bom ? ['\uFEFF'] : []), csvHeader(view.columns, d)];
    if (!m.noFast && view.columns.length && view.columns.every((c) => view.cols.has(c.name))) {   // fast path: no row objects, no per-cell function calls
      const srcs = view.columns.map((c) => ({ a: view.cols.get(c.name), dec: c.decimals || 0 })), idx = view.filtered ? view.indices : null, quote = new RegExp('["\\r\\n' + (d === '\t' ? '\\t' : d.replace(/[\\\]^-]/g, '\\$&')) + ']'), nc = srcs.length, arr = srcs.map((x) => x.a), dec = srcs.map((x) => x.dec), isT = arr.map((a) => ArrayBuffer.isView(a)), STEP = 20000;
      const tb0 = performance.now();
      for (let start = 0; start < count; start += STEP) {
        const end = Math.min(count, start + STEP); let text = '';
        for (let i = start; i < end; i++) {
          const r = idx ? idx[i] : i; let line = '';
          for (let k = 0; k < nc; k++) {
            const x = arr[k][r]; let t;
            if (isT[k]) { line += (x !== x ? '' : dec[k] ? formatScaled(x, dec[k]) : '' + x); if (k < nc - 1) line += d; continue; }   // a typed number column: no quoting needed
            if (typeof x === 'string') t = x; else if (x !== x || x == null) t = ''; else t = dec[k] && typeof x === 'number' ? formatScaled(x, dec[k]) : '' + x;
            if (t.length !== 0 && quote.test(t)) t = '"' + t.replace(/"/g, '""') + '"';
            line += t; if (k < nc - 1) line += d;
          }
          text += line + '\r\n';
        }
        parts.push(text);
      }
      const tb1 = performance.now(), blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
      return send('exported', m.id, { blob, rows: count, bytes: blob.size, fast: true, textMs: Math.round(tb1 - tb0), blobMs: Math.round(performance.now() - tb1) });
    }
    for (let start = 0; start < count; start += BATCH) {
      const n = Math.min(BATCH, count - start); let rows;
      if (view.filtered) rows = (await rowsAt(view.indices, start, start + n)).map((r) => view.columns.map((c) => cellText(r[c.name], c)));
      else rows = (view.live ? Array.from({ length: n }, (_, i) => view.live.row(start + i)) : await view.R.rows({ from: start, count: n })).map((r) => view.columns.map((c) => cellText(r[c.name], c)));
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

// ---- Derived columns, group-by and LFCP export (src/query/derive.mjs, groupby.mjs) ----
// A derived column is computed from one column by a named function, kept beside the file (not in it) and shown, filtered, sorted and exported like any other column.
let deriveMod = null, groupMod = null;
// Dictionary columns kept from the import: a code per row (2 bytes) and the distinct texts, so a group-by on a low-variety text column needs no text decode (the file stores the text itself).
const keptDict = new Map();
function mergeDicts(blocks, rows) {
  const order = [...blocks.keys()].sort((a, b) => a - b), names = Object.keys(blocks.get(order[0]) || {}), out = {}, dec = new TextDecoder(), lat = new TextDecoder('latin1');
  for (const nm of names) {
    if (!order.every((r) => blocks.get(r)[nm])) continue;
    const map = new Map(), dict = []; let total = 0; for (const r of order) total += blocks.get(r)[nm].ids.length;
    if (total !== rows) continue;
    const parts = []; let at = 0, big = false;
    for (const r of order) {
      const x = blocks.get(r)[nm], nl = x.start.length, remap = new Uint32Array(nl);
      for (let q = 0; q < nl; q++) { const sub = x.bytes.subarray(x.start[q], x.end[q]), key = lat.decode(sub); let id = map.get(key); if (id === undefined) { id = dict.length; map.set(key, id); dict.push(dec.decode(sub)); } remap[q] = id; }
      parts.push([x.ids, remap]);
    }
    big = dict.length > 65535; const ids = big ? new Uint32Array(rows) : new Uint16Array(rows);
    for (const [bi, remap] of parts) { for (let i = 0; i < bi.length; i++) ids[at + i] = remap[bi[i]]; at += bi.length; }
    out[nm] = { ids, dict };
  }
  return out;
}
async function deriveColumn(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  try {
    deriveMod ||= MODS() && MODS().derive ? { derive: MODS().derive, isNumberDerive: MODS().isNumberDerive } : await import('../src/query/derive.mjs');
    const t0 = performance.now(), src = view.columns.find((c) => c.name === m.source), name = String(m.name || '').trim();
    if (!src) throw new Error('Pick a column to work from.');
    if (!name || view.columns.some((c) => c.name === name)) throw new Error('Give the new column a name no other column has.');
    const cols = await loadColumns([m.source], false, true), data = deriveMod.derive(cols[m.source], view.total, m.fn), isNum = ArrayBuffer.isView(data);
    let whole = isNum; if (isNum) for (let i = 0; i < data.length; i++) { const x = data[i]; if (x === x && x !== Math.floor(x)) { whole = false; break; } }
    const meta = { name, type: isNum ? (whole ? 'integer' : 'number') : 'string', nullable: true, derived: true, from: m.source, fn: m.fn };
    (view.derived ||= new Map()).set(name, data); view.cols.set(name, data); view.columns = view.columns.concat([meta]); view.cache && view.cache.clear();
    if (isNum && colMod && colMod.primeTopN) colMod.primeTopN(data);
    send('derived', m.id, { columns: view.columns, ms: Math.round(performance.now() - t0) });
  } catch (err) { send('error', m.id, { message: String(err && err.message || err) }); }
}
async function groupView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  try {
    groupMod ||= MODS() && MODS().groupBy ? { groupBy: MODS().groupBy, groupByCodes: MODS().groupByCodes } : await import('../src/query/groupby.mjs');
    queryMod ||= MODS() || await import('../src/query/query.mjs'); colMod ||= MODS() || await import('../src/query/columnar.mjs');
    if (view.total > MAX_COLUMN_ROWS || !view.flat) throw new Error('Group by works up to ' + MAX_COLUMN_ROWS.toLocaleString() + ' rows for now.');
    const t0 = performance.now(), aggs = m.aggs || [{ fn: 'count' }], names = [...new Set([m.key].concat(aggs.filter((a) => a.col).map((a) => a.col)))];
    const active = Object.keys(m.filters || {}).filter((k) => m.filters[k]);
    for (const n of names) if (!view.columns.some((c) => c.name === n)) throw new Error('No column named ' + n + '.');
    const dc = (!m.noDict && view.dictCols) || {}, useIds = !!dc[m.key];
    // a column kept as dictionary ids from the import is counted by id: no text is decoded for it (the key, or an equal-to column in a 'share equal to' aggregate)
    const need = Array.from(new Set(names.concat(active))).filter((n) => !(useIds && dc[n] && !active.includes(n)));
    if (!/AppleWebKit(?!.*Chrome)/.test(self.navigator.userAgent || '') && !m.noParallel) await warmSome(need);   // missing columns decoded on helper threads at once (not in WebKitGTK: slower there)
    const cols = await loadColumns(need, false), tLoad = performance.now() - t0, tg = performance.now();
    let rows = null; if (active.length) rows = colMod.runColumnQuery(cols, view.total, view.columns, { filters: m.filters }).indices;
    const codeCols = {}; for (const a of aggs) if (a.col && dc[a.col] && a.fn === 'rate' && !m.noDict) codeCols[a.col] = dc[a.col];
    const g = useIds ? groupMod.groupByCodes(dc[m.key].ids, dc[m.key].dict, cols, view.total, rows, { aggs, codeCols }) : groupMod.groupBy(cols, view.total, rows, { key: m.key, aggs }), order = Array.from(g.keys, (_, i) => i).sort((a, b) => g.counts[b] - g.counts[a] || (g.keys[a] < g.keys[b] ? -1 : 1));
    const head = [m.key].concat(aggs.map((a) => (a.fn === 'count' ? 'count' : a.fn + '_' + a.col)));
    const table = order.slice(0, 1000).map((gi) => { let v = 0; return [g.keys[gi]].concat(aggs.map((a) => { const x = a.fn === 'count' ? g.counts[gi] : g.values[v++][gi]; return x !== x ? '' : a.fn === 'avg' || a.fn === 'rate' ? String(Math.round(x * 10000) / 10000) : String(x); })); });
    send('grouped', m.id, { byIds: useIds, headers: head, rows: table, groups: g.keys.length, rowsUsed: rows ? rows.length : view.total, ms: Math.round(performance.now() - t0), loadMs: Math.round(tLoad), groupMs: Math.round(performance.now() - tg) });
  } catch (err) { send('error', m.id, { message: String(err && err.message || err) }); }
}
// Decode every file column that is not decoded yet in two parallel calls (numbers as typed arrays, text as strings), so a filtered export reads its rows from memory instead of from 450 scattered blocks.
// Decodes the wanted columns that are not in memory yet, all in one pass (two parallel calls: number columns as typed arrays, text columns as strings; a dictionary column kept from the import costs
// one lookup per row and no decode). A column another call is already decoding is waited for, never decoded twice (a Save right after the background warm used to start the same decode again).
const yieldNow = (() => { const mc = new MessageChannel(); let res = null; mc.port1.onmessage = () => { const r = res; res = null; if (r) r(); }; return () => new Promise((r) => { res = r; mc.port2.postMessage(0); }); })();   // a turn for queued messages without the timer delay
function textFromChunks(v) {
  const lr = v.liveRest; if (!lr) return; v.liveRest = null;
  const fly = (v.inflight ||= new Map()); let done; const p = new Promise((r) => { done = r; }); for (const n of lr.names) fly.set(n, p);
  setTimeout(async () => {
    try { for (const nm of lr.names) { if (view !== v) break; if (!v.cols.has(nm)) { try { const g = lr.L.columnGen(nm); let r, k = 0; while (!(r = g.next()).done) { if (++k % 4 === 0) await yieldNow(); if (view !== v) break; } if (r.done && view === v) v.cols.set(nm, r.value); } catch {} } fly.delete(nm); await yieldNow(); } }
    finally { for (const nm of lr.names) fly.delete(nm); done(); }
  }, 0);
}
async function warmCols(names, background) {
  const v = view; if (!v.flat || v.live || !LfcPack.unpackColumnsParallel || v.f.size > WHOLE_FILE_MAX) return;
  const fly = (v.inflight ||= new Map()), waits = [];
  const want = [];
  for (const c of v.columns) { if (c.derived || !names.includes(c.name) || v.cols.has(c.name)) continue; const p = fly.get(c.name); if (p) waits.push(p); else want.push(c); }
  const isNum = (c) => c.type === 'integer' || c.type === 'number', rest = [];
  for (const c of want) { const d = v.dictCols && v.dictCols[c.name]; if (d && !isNum(c) && d.ids.length === v.total) { const arr = new Array(v.total), dict = d.dict, ids = d.ids; for (let i = 0; i < arr.length; i++) arr[i] = dict[ids[i]]; v.cols.set(c.name, arr); } else rest.push(c); }
  if (rest.length) {
    let done; const p = new Promise((r) => { done = r; }); for (const c of rest) fly.set(c.name, p);
    try {
      const bytes = new Uint8Array(await v.f.arrayBuffer());
      for (const group of [rest.filter(isNum), rest.filter((c) => !isNum(c))]) {
        if (!group.length) continue;
        const got = await LfcPack.unpackColumnsParallel(bytes, isNum(group[0]) ? { keys: group.map((c) => c.name), nulls: 'NaN' } : { keys: group.map((c) => c.name) });
        if (view !== v) return;
        for (const c of group) if (got[c.name] && !v.cols.has(c.name)) { v.cols.set(c.name, got[c.name]); if (ArrayBuffer.isView(got[c.name]) && colMod && colMod.primeTopN) colMod.primeTopN(got[c.name]); }
      }
    } finally { for (const c of rest) fly.delete(c.name); done(); }
  }
  await Promise.all(waits);
}
const warmAll = () => (view && view.total <= 3000000 ? warmCols(view.columns.map((c) => c.name)) : Promise.resolve());
const warmSome = (names) => warmCols(names);
// Saves the rows now shown (filter and sort applied, derived columns included) as a new LFCP dataset in this browser and hands the file back for download.
async function exportLfcp(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  let writable = null, name = null, closed = false;
  try {
    await LfcPack.init(); ensureFull();
    const t0 = performance.now();
    await warmAll(); const tWarm = performance.now() - t0;
    const cols = view.columns, count = view.filtered ? view.indices.length : view.total, keyQ = cols.map((c, i) => (i ? ',' : '{') + JSON.stringify(c.name) + ':');
    name = safe(view.name.replace(/-[0-9a-f-]{36}\.json\.lfc$/, '')) + '-view-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)) + '.json.lfc';
    writable = await store.create(name);
    const meta = { producer: 'LFCFoundry Workbench', producerVersion: '0.2.0', sourceFormat: 'lfcp', sourceName: 'view of ' + view.name.slice(0, 150), sourceBytes: 0, tables: [{ name: 'rows', rows: count, columns: cols.slice(0, 128).map((c, i) => ({ id: 'field-' + (i + 1), name: c.name.slice(0, 100), type: c.type, nullable: c.nullable !== false })) }] };
    let outBytes = 0;
    const write = async (parts) => { for (const p of parts) { await writable.write(p); outBytes += p.byteLength; } };
    const BATCH = 16384, tm = { rows: 0, text: 0, pack: 0 }, allWarm = cols.every((c) => view.cols.has(c.name)), popts = { level: 3, blockBytes: 2097152, share: false };
    const packer2 = LfcPack.packStream(Object.assign({}, popts, { meta }));
    for (let start = 0; start < count; start += BATCH) {
      const end = Math.min(count, start + BATCH); let ts = performance.now();
      if (allWarm && LfcPack.packBlock) {   // every column is in memory: gather the batch column by column and pack it as columns (no row objects, no JSON text)
        const out = {}, n = end - start;
        for (const c of cols) {
          const src = view.cols.get(c.name), a = new Array(n);
          if (ArrayBuffer.isView(src)) { for (let i = 0; i < n; i++) { const x = src[view.filtered ? view.indices[start + i] : start + i]; a[i] = x !== x ? null : x; } }
          else for (let i = 0; i < n; i++) a[i] = src[view.filtered ? view.indices[start + i] : start + i];
          out[c.name] = a;
        }
        tm.rows += performance.now() - ts; ts = performance.now();
        const r = await LfcPack.packBlock(out, popts); await write(packer2.pushPacked(r)); tm.pack += performance.now() - ts; continue;
      }
      const objs = view.filtered ? await rowsAt(view.indices, start, end) : view.live ? Array.from({ length: end - start }, (_, i) => view.live.row(start + i)) : await view.R.rows({ from: start, count: end - start });
      if (!view.filtered && view.derived && view.derived.size) overlayDerived(objs, (i) => start + i);
      tm.rows += performance.now() - ts; ts = performance.now(); let text = '';
      for (const r of objs) { let line = ''; for (let k = 0; k < cols.length; k++) { const v = r[cols[k].name]; line += keyQ[k] + (v == null ? 'null' : JSON.stringify(v)); } text += line + '}\n'; }
      tm.text += performance.now() - ts; ts = performance.now(); await write(packer2.push(enc.encode(text))); tm.pack += performance.now() - ts;
    }
    await write(packer2.finish()); await writable.close(); closed = true; writable = null;
    const v = await validate(name, count); if (!v.ok) throw new Error('The written file failed footer validation: ' + v.reason);
    const cat = await store.catalog(), outCols = cols.map((c) => { const o = Object.assign({}, c); delete o.derived; delete o.from; delete o.fn; return o; });
    cat.push({ name, source: 'view of ' + view.name, rows: count, bytes: outBytes, columns: outCols, created: Date.now(), storage: STORAGE }); await store.setCatalog(cat);
    send('exportedLfcp', m.id, { name, rows: count, bytes: outBytes, blob: await store.file(name), ms: Math.round(performance.now() - t0), warmMs: Math.round(tWarm), rowsMs: Math.round(tm.rows), textMs: Math.round(tm.text), packMs: Math.round(tm.pack) });
  } catch (err) {
    if (writable && !closed) { try { await writable.abort(); } catch {} } if (name) await store.remove(name);
    send('error', m.id, { message: String(err && err.message || err) });
  }
}
