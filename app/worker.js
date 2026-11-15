/* Workbench import worker. Classic worker: loads the pinned LFC-pack build, then the ES-module ingest core. */
'use strict';
importScripts('../vendor/lfcp/0.13.3/lfc-pack.js'); //@@IMPORT_LFC@@

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
  else if (m.type === 'packPlain') packPlainJob(m);
  else if (m.type === 'packCols') packColsJob(m);
  else if (m.type === 'pqGroup') pqGroupJob(m);
  else if (m.type === 'credit') { parseCredits++; if (credit) { const r = credit; credit = null; r(); } }
  else if (m.type === 'import') importWithEncoding(m);
  else if (m.type === 'zipList') zipList(m);
  else if (m.type === 'list') list(m);
  else if (m.type === 'delete') remove(m);
  else if (m.type === 'verify') verify(m);
  else if (m.type === 'gen') genBig(m);
  else if (m.type === 'genclean') store.remove('scratch-big.csv').then(() => send('cleaned', m.id, {}));
  else if (view && view.preview && (m.type === 'query' || m.type === 'derive' || m.type === 'groupby' || m.type === 'export' || m.type === 'exportLfcp')) send('error', m.id, { message: 'The file is still being read; sorting and filtering start when the rows are all in.' });
  else if (m.type === 'open') openView(m);
  else if (m.type === 'query') queryView(m);
  else if (m.type === 'page') pageView(m);
  else if (m.type === 'export') exportView(m);
  else if (m.type === 'derive') deriveColumn(m);
  else if (m.type === 'groupby') groupView(m);
  else if (m.type === 'exportSummary') exportSummary(m);
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
const mixedErr = (col) => Object.assign(new Error('A number column holds a text-like cell; the file is imported on the text path.'), { mixed: true, col: col == null ? -1 : col });   // col: the number column that held the cell (-1 when not known)
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
      if (r.bail === 'mixed') { if (++F.miss >= 64) F.off = true; break; }   // the character parser reads this line next and names the column if the cell really is text-like
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
  const n = headers.length, kind = headers.map((_, c) => (plan && plan[c] === true ? 1 : plan && typeof plan[c] === 'number' && plan[c] > 0 ? plan[c] : 0)), isInt = headers.map((_, c) => !!(plan && plan[c] === true));   // a column of 1 decimal has kind 1 too: isInt tells it from a whole-number column
  let vals = headers.map(() => []), rows = 0, bytes = 0;
  return {
    get n() { return rows; },
    add(f) {
      for (let c = 0; c < n; c++) {
        const raw = f[c]; trackers[c].add(raw); bytes += raw.length + 1;
        if (kind[c]) { const v = isInt[c] ? typedCell(raw) : typedDecimal(raw, kind[c]); if (v === null) vals[c].push(NaN); else if (typeof v === 'number') vals[c].push(v); else throw mixedErr(c); } else vals[c].push(raw);
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
// Save as LFCP: a pack thread packs one batch of plain columns (arrays of cells) into one block.
async function packPlainJob(m) {
  try { await LfcPack.init(); const r = await LfcPack.packBlock(m.cols, m.o); self.postMessage({ type: 'packed', rid: m.rid, r }, [r.buffer]); }
  catch (err) { self.postMessage({ type: 'packed', rid: m.rid, error: String(err && err.message || err) }); }
}
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
let flatOne = null;
async function packBlockJob(m) {
  try { await LfcPack.init(); let bytes = new Uint8Array(m.c); if (m.flat) { flatOne ||= flatTransform(); flatOne.reset(); bytes = flatOne(bytes); } const r = LfcPack.packBlock(bytes, m.flat ? Object.assign({}, m.o, { blockBytes: bytes.length + 1024 }) : m.o);
    // Exact column types: the first 2000 lines can say "whole numbers" or "dates" for a column that later has decimals or other text. Each block is searched for a violation, and the importer combines the answers.
    let chk = null; if (m.chk && (m.chk.ints.length || m.chk.dates.length)) {
      const txt = new TextDecoder('latin1').decode(bytes); chk = { dec: [], bad: [] };
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
      if (m.chk.ints.length) { const re = new RegExp('"(' + m.chk.ints.map(esc).join('|') + ')":-?\\d+(?:\\.\\d|[eE])', 'g'); const seen = new Set(); let mm; while (seen.size < m.chk.ints.length && (mm = re.exec(txt))) { seen.add(mm[1]); re.lastIndex = mm.index + mm[0].length; } chk.dec = [...seen]; }
      for (const nm of m.chk.dates) { if (new RegExp('"' + esc(nm) + '":"(?!\\d{4}-\\d\\d-\\d\\d(?:[ T]\\d\\d:\\d\\d(?::\\d\\d(?:\\.\\d+)?)?)?Z?")').test(txt)) chk.bad.push(nm); }
    }
    self.postMessage({ type: 'packed', rid: m.rid, r, chk }, [r.buffer]); }
  catch (err) { self.postMessage({ type: 'packed', rid: m.rid, error: String(err && err.message || err) }); }
}

// Helper side of a segmented import: parse one piece, post the result (the bytes are transferred, not copied).
async function segJob(m) {
  try {
    const r = await parseSegment(m);
    if (m.dup) r.chunks2 = r.chunks.map(dupChunk);   // live columns: a second copy made here, in parallel, so the import worker keeps one and forwards the other to the pack workers
    self.postMessage({ type: 'segdone', rid: m.rid, r }, r.pieces.map((b) => b.buffer).concat(...r.chunks.map(chunkBuffers), ...(r.chunks2 || []).map(chunkBuffers)));
  } catch (err) { self.postMessage({ type: 'segdone', rid: m.rid, r: { error: String(err && err.message || err), mixed: !!(err && err.mixed), col: err && err.col != null ? err.col : -1 } }); }
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
        if (r.mixed) throw mixedErr(r.col);   // from a verified start: the file really has a text-like cell in a number column
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
    let text = new TextDecoder().decode(new Uint8Array(await file.slice(0, 4194304).arrayBuffer())); let cutAll = file.size <= 4194304;
    { let cut = 0, n = 0; while (n < 6003) { const k = text.indexOf('\n', cut); if (k < 0) { cut = text.length; break; } cut = k + 1; n++; } if (cut < text.length) { text = text.slice(0, cut); cutAll = false; } }
    const rows = []; const parser = new DelimitedParser(delimiter, (f) => { if (rows.length < 6001) rows.push(f); });
    try { parser.feed(text, cutAll); } catch { /* a bad row in the sample: use the rows before it */ }
    if (rows.length < 2) return null;
    const cols = rows[0].length, tr = Array.from({ length: cols }, () => new TypeTracker());
    for (let r = 1; r < rows.length; r++) { if (rows[r].length !== cols) return null; for (let c = 0; c < cols; c++) tr[c].add(rows[r][c]); }
    // Five 256 KB slices from later in the file feed the type tally and the decimal-digit check, so a column whose digits or number-ness change after the first MB is planned as text up front (saves the restart).
    const extra = [];
    if (file.size > 8 * 1048576) for (const frac of [0.2, 0.4, 0.6, 0.8, 0.97]) {
      const off = Math.floor(file.size * frac);
      const t2 = new TextDecoder().decode(new Uint8Array(await file.slice(off, Math.min(file.size, off + 262144)).arrayBuffer()));
      const k = t2.indexOf('\n'); if (k < 0) continue;
      const got = []; const p2 = new DelimitedParser(delimiter, (f) => { if (f.length === cols) got.push(f); });
      try { p2.feed(t2.slice(k + 1), false); } catch { /* skip */ }
      for (const f of got.slice(0, -1)) extra.push(f);
    }
    for (const f of extra) for (let c = 0; c < cols; c++) tr[c].add(f[c]);
    const allRows = extra.length ? rows.concat(extra) : rows;
    const plan = tr.map((x, c) => {
      if (x.type === 'integer' && x.n > x.empty) return true;
      if (x.type !== 'number') return false;
      const d = core.sampleDecimals(allRows.slice(1).map((r) => r[c]));   // decimals: stored as numbers, with the count kept in the catalog
      return d > 0 && x.n > x.empty ? d : false;
    });
    // low-variety text columns (at most 5% of the sample's rows distinct, and 200+ sample rows) are built as dictionary columns: a code per row and the distinct values
    const nr = rows.length - 1; samplePlan.dict = nr >= 200 ? tr.map((x, c) => { if (plan[c] || x.type === 'empty') return false; const seen = new Set(); for (let r = 1; r < rows.length; r++) { seen.add(rows[r][c]); if (seen.size > nr * 0.05) return false; } return true; }) : null;
    return plan.some(Boolean) ? plan : null;
  } catch { return null; }
}

// Staged columns can find a text-like cell in a number column late in the file; then the whole import runs again on the JSON-lines path (nothing was kept).
// A number column that meets a text-like cell late in the file (a sample of the first rows said integer) no longer sends the whole import to the text path: that one column is
// read as text and the import starts again with the other number columns kept (up to 3 times), so the staged columns, live view and pack workers stay on.
// A file that is not valid UTF-8 (usually a Windows-1252 export) is re-encoded to UTF-8 first; valid UTF-8 files never reach this path's re-encode.
async function notUtf8(file) {
  const SL = 1048576, spots = [[0, 4194304]]; if (file.size > 12 * SL) spots.push([Math.floor(file.size / 2), SL], [file.size - SL, SL]);
  for (const [at, len] of spots) {
    const u = new Uint8Array(await file.slice(at, Math.min(file.size, at + len)).arrayBuffer()); let i = 0;
    if (at > 0) while (i < 3 && i < u.length && (u[i] & 0xC0) === 0x80) i++;   // a slice may start inside a character
    try { new TextDecoder('utf-8', { fatal: true }).decode(i ? u.subarray(i) : u, { stream: true }); } catch { return true; }
  }
  return false;
}
async function toUtf8File(file) {
  const dec = new TextDecoder('windows-1252'), enc = new TextEncoder(), parts = [], rd = file.stream().getReader();
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(enc.encode(dec.decode(value, { stream: true }))); }
  parts.push(enc.encode(dec.decode()));
  return new File(parts, file.name);
}
// UTF-16 (with a byte order mark, or without one when the text is mostly ASCII and every other byte is zero) is converted to UTF-8 in 4 MB pieces that the parser can slice like any file.
async function sniffUtf16(file) {
  const u = new Uint8Array(await file.slice(0, 65536).arrayBuffer()); if (u.length < 2) return null;
  if (u[0] === 0xFF && u[1] === 0xFE) return 'utf-16le'; if (u[0] === 0xFE && u[1] === 0xFF) return 'utf-16be';
  const n = Math.min(u.length, 4096) & ~1; if (n < 8) return null; let ev = 0, od = 0; for (let i = 0; i < n; i += 2) { if (u[i] === 0) ev++; if (u[i + 1] === 0) od++; }
  const half = n / 2; if (od > half * 0.4 && ev < half * 0.02) return 'utf-16le'; if (ev > half * 0.4 && od < half * 0.02) return 'utf-16be'; return null;
}
async function utf16ToUtf8File(file, label) {
  const dec = new TextDecoder(label), enc = new TextEncoder(), parts = [], rd = file.stream().getReader(); let acc = [], accN = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; const e = enc.encode(dec.decode(value, { stream: true })); acc.push(e); accN += e.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } }
  const tail = dec.decode(); if (tail) acc.push(enc.encode(tail)); if (acc.length) parts.push(new Blob(acc));
  return new File(parts, file.name);
}
const isGz = (f) => /\.gz$/i.test(f.name || '');
async function gunzipFile(file) {   // serial variant: decode the whole file into a Blob (spilled to disk by the browser), then import as usual
  const parts = []; const rd = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader(); let acc = [], accN = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; acc.push(value); accN += value.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } }
  if (acc.length) parts.push(new Blob(acc));
  return new File(parts, String(file.name).replace(/\.gz$/i, ''), { type: 'text/csv' });
}
const isZip = (f) => /\.zip$/i.test(f.name || '');
// Zip: read the central directory, pick the entry (m.zipEntry, else the largest .csv/.tsv/.txt), inflate it with DecompressionStream('deflate-raw') into a Blob (stored entries are sliced, not copied).
async function unzipFile(file, want, listOnly) {
  const sz = file.size, tailN = Math.min(sz, 65557), tail = new DataView(await file.slice(sz - tailN, sz).arrayBuffer());
  let e = -1; for (let i = tailN - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('This is not a zip file (no end record).');
  let n = tail.getUint16(e + 10, true), cdSize = tail.getUint32(e + 12, true), cdOff = tail.getUint32(e + 16, true);
  if (n === 0xFFFF || cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {   // zip64 end record
    const loc = tail.getUint32(e - 20, true) === 0x07064b50 ? e - 20 : -1; if (loc < 0) throw new Error('Unsupported zip64 layout.');
    const off64 = Number(tail.getBigUint64(loc + 8, true)), r = new DataView(await file.slice(off64, off64 + 56).arrayBuffer());
    n = Number(r.getBigUint64(32, true)); cdSize = Number(r.getBigUint64(40, true)); cdOff = Number(r.getBigUint64(48, true));
  }
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer()), dec = new TextDecoder(), ents = []; let p = 0;
  for (let i = 0; i < n && p + 46 <= cdSize; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const flags = cd.getUint16(p + 8, true), method = cd.getUint16(p + 10, true); let csz = cd.getUint32(p + 20, true), usz = cd.getUint32(p + 24, true);
    const nl = cd.getUint16(p + 28, true), el = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true); let lho = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nl));
    if (csz === 0xFFFFFFFF || usz === 0xFFFFFFFF || lho === 0xFFFFFFFF) { let q = p + 46 + nl; const end = q + el; while (q + 4 <= end) { const id = cd.getUint16(q, true), len = cd.getUint16(q + 2, true); if (id === 1) { let o = q + 4; if (usz === 0xFFFFFFFF) { usz = Number(cd.getBigUint64(o, true)); o += 8; } if (csz === 0xFFFFFFFF) { csz = Number(cd.getBigUint64(o, true)); o += 8; } if (lho === 0xFFFFFFFF) { lho = Number(cd.getBigUint64(o, true)); } } q += 4 + len; } }
    ents.push({ name, method, csz, usz, lho, enc: !!(flags & 1) }); p += 46 + nl + el + cl;
  }
  const files = ents.filter((x) => !x.name.endsWith('/'));
  let pick = want ? files.find((x) => x.name === want) : null;
  if (!pick) pick = files.filter((x) => /\.(csv|tsv|txt)$/i.test(x.name)).sort((a, b) => b.usz - a.usz)[0] || files.sort((a, b) => b.usz - a.usz)[0];
  if (!pick) throw new Error('The zip file has no files.');
  if (listOnly) return { entries: files.map((x) => ({ name: x.name, size: x.usz, method: x.method })), picked: pick.name }; if (pick.enc) throw new Error('This zip entry is encrypted.');
  if (pick.method !== 0 && pick.method !== 8) throw new Error('This zip entry uses an unsupported compression method (' + pick.method + ').');
  const lh = new DataView(await file.slice(pick.lho, pick.lho + 30).arrayBuffer()), start = pick.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const base = pick.name.split('/').pop(); const raw = file.slice(start, start + pick.csz);
  if (pick.method === 0) return { file: new File([raw], base, { type: 'text/csv' }), entries: files.map((x) => x.name), picked: pick.name };
  const parts = []; const rd = raw.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(); let acc = [], accN = 0, total = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; acc.push(value); accN += value.length; total += value.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } }
  if (acc.length) parts.push(new Blob(acc));
  if (total !== pick.usz) throw new Error('The zip entry did not unpack to its recorded size.');
  return { file: new File(parts, base, { type: 'text/csv' }), entries: files.map((x) => x.name), picked: pick.name };
}
// The page lists the files in a zip so the person can pick one (m.zipEntry); the default is the largest .csv, .tsv or .txt.
async function zipList(m) { try { const r = await unzipFile(m.file, null, true); send('zipList', m.id, r); } catch (err) { send('zipList', m.id, { error: String(err && err.message || err) }); } }
async function importWithEncoding(m) {
  const early = { cancelled: false, pre: true }; jobs.set(m.id, early);   // a cancel that arrives while the file is checked still counts
  try {
    for (let hop = 0; hop < 2 && m.file; hop++) {   // a .zip or .gz is unpacked first (a .gz inside a .zip too); an unpack error is reported, not imported as text
      if (isZip(m.file)) { const z = await unzipFile(m.file, m.zipEntry); m = Object.assign({}, m, { file: z.file }); send('notice', m.id, { text: 'Opened ' + z.picked + ' from the zip file' + (z.entries.length > 1 ? ' (' + z.entries.length + ' files inside).' : '.') }); }
      else if (isGz(m.file)) { m = Object.assign({}, m, { file: await gunzipFile(m.file) }); send('notice', m.id, { text: 'This file was gzip-compressed, so it was unpacked first.' }); }
      else break;
    }
  } catch (err) { jobs.delete(m.id); return send('error', m.id, { message: String(err && err.message || err) }); }
  if (m.file && await isParquet(m.file)) return importFile(Object.assign({}, m, { parquet: true, untyped: true }));   // binary: no text checks
  try { const u16 = m.file && m.file.size > 1 ? await sniffUtf16(m.file) : null; if (u16) { m = Object.assign({}, m, { file: await utf16ToUtf8File(m.file, u16) }); send('notice', m.id, { text: 'This file was UTF-16, so it was converted to UTF-8.' }); } else if (m.file && m.file.size && await notUtf8(m.file)) { m = Object.assign({}, m, { file: await toUtf8File(m.file) }); send('notice', m.id, { text: 'This file is not UTF-8, so it was read as Windows-1252.' }); } }
  catch { /* the normal import reports any real problem */ }
  return importFile(m);
}
const isNdjson = (f) => /\.(ndjson|jsonl|json)$/i.test(f.name || '');
// NDJSON: one JSON object per line is already the JSON-lines form LFC-pack packs, so the bytes go to the pack workers cut at line ends; the first 2000 lines give the column names and types.
// JSON objects to flat JSON lines (wasm, flat.c). Cuts each top-level object out of an array or a line stream, drops white space outside strings, and writes the members of a one-level nested object as dotted names ("trip":{"distance":1} becomes "trip.distance":1). Deeper nesting, a key over 1000 bytes or an object over 4 MB sets an error bit.
function flatTransform() {
  const bin = Uint8Array.from(atob('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IQdBASEGIBIhAwwOC0EBIQZBACEMQQBBAToAtKjAhwAgA0GAiMCCAGpBIjoAACADQQFqIQNBACEHDA0LQQEhB0EAIQZBAEEBNgK4qMCHACADQYCIwIIAakH7ADoAACADQQFqIQMMDAsCQAJAIA1BAXFFDQBBAEEAOgCcqMCHAAwBCyADQYCIwIIAakEsOgAAIANBAWohAwtBASEMQQAhDUEAQQE6AKyowIcAQQBBADYCqKjAhwBBACEIDAYLAkAgBUEBRg0AAkACQCAFQQJ0QdCowIcAaigCACISDQBBAEEBOgCcqMCHACAFQX9qIQUMAQsCQCANQX9zIANFckEBcQ0AIANBf2ogAyADQf+HwIIAai0AAEEsRhshAwsgBUF/aiIFQQJ0QdCowIcAaiIGIAYoAgAgEmo2AgBBAEEAOgCcqMCHAAsgEkUhDUEAIQxBACAFNgK8qMCHAEEAIAVBAnRBkKnAhwBqKAIAIgo2AqCowIcAQQBBADoArKjAhwAMBgsCQAJAIA1BAXENACADIRIMAQtBACESQQBBADoAnKjAhwAgA0UNACADQX9qIAMgA0H/h8CCAGotAABBLEYbIRILIBJBgYjAggBqQQo6AAAgEkGAiMCCAGpB/QA6AABBACENQQAgD0EBaiIPNgKAqMCHAEEAQQA2AryowIcAQQAhB0EAIQZBACEFIBJBAmoiAiEDDAoLIANBgIjAggBqQTo6AAAMAwsgEkHbAEYNBAsgA0GAiMCCAGogEjoAAAwBC0EBIQxBACENQQBBATYCvKjAhwBBAEEBOgCsqMCHACADQYCIwIIAakH7ADoAAEEAQQA2AqiowIcAQQBBADYCuKjAhwBBAEEAOgCcqMCHAEEAQQA2AqCowIcAQQBBADYC1KjAhwAgA0EBaiEDQQAhCkEAIQhBACEHQQEhBQwGCyADQQFqIQMLQQAhB0EAIQYMBAtBASEHQQAhBkEAQQE2AriowIcAIANBgIjAggBqQdsAOgAAIANBAWohAwwDCyADIAdqIQNBACEGDAILQQAhEEEAIQYgEyEDDAELQQEhBiATIQMLIAAgAUEBaiIBRw0ACwtBACACNgKUqMCHACADIAJrIQELQQAgATYCkKjAhwAgAgsAYARuYW1lAAsKZmxhdDIud2FzbQE4BwAGaW5fcHRyAQdvdXRfcHRyAgRyb3dzAwZlcnJvcnMECGZpbmlzaGVkBQVyZXNldAYFc3BsaXQHEgEAD19fc3RhY2tfcG9pbnRlcgA4CXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQxVYnVudHUgY2xhbmcRMTguMS4zICgxdWJ1bnR1MSkAOQ90YXJnZXRfZmVhdHVyZXMDKwtidWxrLW1lbW9yeSsPbXV0YWJsZS1nbG9iYWxzKwhzaWduLWV4dA=='), (c) => c.charCodeAt(0)), X = new WebAssembly.Instance(new WebAssembly.Module(bin), {}).exports; X.reset(1);
  const ip = X.in_ptr(), op = X.out_ptr(), mem = new Uint8Array(X.memory.buffer);
  const f = (chunk) => {
    if (chunk.length > (5 << 20)) throw new Error('chunk too large'); mem.set(chunk, ip); const n = X.split(chunk.length), e = X.errors();
    if (e & 1) throw new Error('JSON nested more than one level deep is not supported yet.'); if (e & 2) throw new Error('A JSON key is longer than 1000 bytes.'); if (e & 4) throw new Error('A single JSON object is larger than 4 MB.');
    return mem.slice(op, op + n);
  }; f.rows = () => X.rows(); f.reset = () => X.reset(1); f.finished = () => X.finished(); return f;
}
async function parseNdjson(file, stopFn, onBytes, onProgress, t) {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer()); let hp = 0; while (hp < head.length && (head[hp] === 32 || head[hp] === 10 || head[hp] === 13 || head[hp] === 9 || head[hp] === 0xEF || head[hp] === 0xBB || head[hp] === 0xBF)) hp++;
  let splitter = head[hp] === 91 ? flatTransform() : null, arrStart = 0;
  if (head[hp] === 123) {   // a single JSON object that wraps the rows ({"data":[{..},{..}]}) instead of one object per line: the first array of objects is the table
    const h1 = new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer()), lat = new TextDecoder('latin1').decode(h1), nl = lat.indexOf('\n'); let first = false;
    if (nl >= 0) { try { JSON.parse(lat.slice(0, nl)); first = true; } catch { first = false; } }
    if (!first) { const mm = /"(?:[^"\\]|\\.)*"\s*:\s*(\[)\s*\{/.exec(lat); if (!mm) throw new Error('This JSON file is not a list of objects, one object per line, or an object that holds such a list.'); arrStart = mm.index + mm[0].indexOf('['); splitter = flatTransform(); }
  } const splitterWasOn = !!splitter; const hasNested = (bytes) => { const text = dec.decode(bytes.subarray(0, Math.min(bytes.length, 262144))); const ls = text.split('\n'); for (let i = 0; i < Math.min(ls.length - 1, 50); i++) { let o; try { o = JSON.parse(ls[i]); } catch { return false; } for (const k in o) { const v = o[k]; if (v !== null && typeof v === 'object' && !Array.isArray(v)) return true; } } return false; };
  let dateCand = []; const SL = 4 << 20, dec = new TextDecoder('utf-8'); let carry = new Uint8Array(0), rows = 0, headers = null, kinds = null, sample = [];
  const sniff = (bytes) => {
    const text = dec.decode(bytes.subarray(0, Math.min(bytes.length, 4 << 20))); const lines = text.split('\n'); lines.pop();
    const idx = new Map(); headers = []; kinds = [];
    for (let i = 0; i < Math.min(lines.length, 2000); i++) {
      const ln = lines[i].trim(); if (!ln) continue; let o; try { o = JSON.parse(ln); } catch { throw new Error('Line ' + (i + 1) + ' is not valid JSON.'); }
      if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error('Line ' + (i + 1) + ' is not a JSON object.');
      if (sample.length < 20) sample.push(o);
      for (const k of Object.keys(o)) {
        const v = o[k]; let c = idx.get(k); if (c === undefined) { c = headers.length; idx.set(k, c); headers.push(k); kinds.push(null); }
        if (v === null) continue; if (typeof v === 'object') throw new Error('Column "' + k + '" holds a nested value; nested JSON is not supported yet.');
        const kd = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : 'string';
        const cur = kinds[c]; kinds[c] = cur === null || cur === kd ? kd : (cur === 'integer' && kd === 'number') || (cur === 'number' && kd === 'integer') ? 'number' : 'string';
      }
    }
    const dateRe = /^\d{4}-\d\d-\d\d(?:[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?)?Z?$/, okName = (x) => /^[\x20-\x7e]+$/.test(x) && !/["\\]/.test(x);
    dateCand = headers.map((h, c) => kinds[c] === 'string' && okName(h) && sample.length > 0 && sample.every((o) => o[h] === null || o[h] === undefined || (typeof o[h] === 'string' && dateRe.test(o[h]))) && sample.some((o) => typeof o[h] === 'string'));
    t.chk = { ints: headers.filter((h, c) => kinds[c] === 'integer' && okName(h)), dates: headers.filter((h, c) => dateCand[c]) };
  };
  for (let off = 0; off < file.size; off += SL) {
    if (splitter && splitter.finished && splitter.finished()) break;
    stopFn(); let s = performance.now(); const chunk = new Uint8Array(await file.slice(off, Math.min(file.size, off + SL)).arrayBuffer()); t.readMs += performance.now() - s;
    s = performance.now(); if (splitter) { const body = splitter(off === 0 && arrStart ? chunk.subarray(arrStart) : chunk); if (body.length) { if (!headers) sniff(body); rows = splitter.rows(); t.parseMs += performance.now() - s; await onBytes(body); onProgress(Math.min(file.size, off + SL), rows); } else t.parseMs += performance.now() - s; continue; }
    const k = chunk.lastIndexOf(10); let body;
    if (k < 0) { const n = new Uint8Array(carry.length + chunk.length); n.set(carry); n.set(chunk, carry.length); carry = n; t.parseMs += performance.now() - s; continue; }
    body = new Uint8Array(carry.length + k + 1); body.set(carry); body.set(chunk.subarray(0, k + 1), carry.length); carry = chunk.slice(k + 1);
    if (!headers && hasNested(body)) { t.flatPack = true; const tmp = flatTransform(); sniff(tmp(body.slice(0, Math.min(body.length, body.lastIndexOf(10, 1 << 20) + 1 || body.length)))); }
    if (splitter) { const sw = !splitterWasOn; body = splitter(body); if (sw && carry.length) { const x = splitter(carry); carry = new Uint8Array(0); const nb = new Uint8Array(body.length + x.length); nb.set(body); nb.set(x, body.length); body = nb; } rows = splitter.rows(); if (!headers) sniff(body); } else { if (!headers) sniff(body); for (let i = body.indexOf(10); i >= 0; i = body.indexOf(10, i + 1)) rows++; }
    t.parseMs += performance.now() - s; await onBytes(body); onProgress(Math.min(file.size, off + SL), rows);
  }
  if (!splitter && carry.length && dec.decode(carry).trim()) { const body = new Uint8Array(carry.length + 1); body.set(carry); body[carry.length] = 10; if (!headers) sniff(body); rows++; await onBytes(body); }
  if (!headers || !headers.length) throw new Error('The file has no JSON lines.');
  return { headers, types: kinds.map((x, c) => ({ type: dateCand[c] ? 'date' : (x || 'string'), nullable: true })), rows, sample, refine: (types) => { for (let c = 0; c < headers.length; c++) { if (types[c].type === 'integer' && t.chkDec && t.chkDec.has(headers[c])) types[c].type = 'number'; if (types[c].type === 'date' && t.chkBad && t.chkBad.has(headers[c])) types[c].type = 'string'; } } };
}
async function importFile(m) {
  if (m.parquet) { await importOnce(m); return; }
  if (m.file && isNdjson(m.file)) m = Object.assign({}, m, { ndjson: true, untyped: true, noColumns: true });
  const demote = new Set(); let mm = m;
  for (let tries = 0; tries < 4; tries++) {
    const r = await importOnce(mm); if (!r) return;
    if (r === 'mixed' || tries === 3) break;
    demote.add(r.col); mm = Object.assign({}, m, { demote: [...demote] });
  }
  await importOnce(Object.assign({}, m, { noColumns: true }));
}
const columnsOk = (m) => !m.noColumns && typeof WebAssembly !== 'undefined' && (m.columns === true || (!((self.navigator && self.navigator.deviceMemory) < 8) && (!/Android|iPhone|iPad|iPod|Mobile/i.test((self.navigator && self.navigator.userAgent) || '') || (self.navigator && self.navigator.deviceMemory) >= 8)))   // phones too when the browser reports 8 GB or more (Chrome caps the report at 8): measured on an 8 GB Android phone, first rows 1.0 s instead of 1.8-2.0 s, save 16-24% later;
async function importOnce(m) {
  let restart = false;
  const prev = jobs.get(m.id), job = { cancelled: !!(prev && prev.pre && prev.cancelled) }; jobs.set(m.id, job);
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
    const meta = { producer: 'LFCFoundry Workbench', producerVersion: '0.2.0', sourceFormat: m.parquet ? 'parquet' : delimiter === '\t' ? 'tsv' : 'csv', sourceName: String(file.name).slice(0, 200), sourceBytes: file.size, tables: [{ name: 'rows', rows: 0, columns: [] }] };
    let packer = LfcPack.packStream(Object.assign({ level: m.level || 3 }, { blockBytes: m.blockBytes || 2097152, share: !m.parquet, meta }));
    let outBytes = 0;
    const write = async (parts) => { for (const p of parts) { stop(job); const s = performance.now(); await writable.write(p); t.writeMs += performance.now() - s; outBytes += p.byteLength; } };
    let packBytes = async (bytes) => { stop(job); const s = performance.now(); const parts = packer.push(bytes); t.packMs += performance.now() - s; await write(parts); };
    let dkBlocks = null;
    let finishPacking = async () => {}, col = null, colFlush = async () => {}, liveChunks = null, morePack = null;
    const packWorkers = m.packWorkers != null ? m.packWorkers : (m.live === true && file.size <= LIVE_MAX && columnsOk(m) ? 1 : 2);   // live columns: Firefox packs with one worker while parsing (the cores go to the parse helpers) and gets three more when parsing is done; Chromium also packs with one while parsing and gets one more (measured: each is the best of the variants in its browser)   // measured faster in Firefox, WebKitGTK and Chromium together with the byte-level parser
    let pws = null;   // pack threads; some pages (a downloaded file on Chrome) cannot start a worker from inside a worker, then packing stays on this thread
    if (packWorkers > 0 && (useSegments(m, file) || (m.parquet && columnsOk(m)))) { try { pws = []; for (let i = 0; i < packWorkers; i++) pws.push(mkWorker()); } catch { if (pws) pws.forEach((w) => w.terminate()); pws = null; } }
    if (pws) {   // blocks packed by worker threads, appended here in file order (LFC-pack 0.7.0 packBlock / pushPacked)
      const bb = m.blockBytes || 2097152, popts = Object.assign({ level: m.level || 3 }, { blockBytes: bb, share: false });
      packer = LfcPack.packStream(Object.assign({}, popts, { meta }));
      const ws = [], idle = [], done = new Map(); dkBlocks = new Map(); let seq = 0, emit = 0, parts = [], plen = 0, wake = null, wchain = Promise.resolve(), failed = null;
      const pump = () => { if (wake) { const r = wake; wake = null; r(); } };
      const onPacked = (w) => (e) => {
        const d = e.data; if (d.error) failed = new Error('Pack worker failed: ' + d.error); else { done.set(d.rid, d.r); if (d.dk) dkBlocks.set(d.rid, d.dk); if (d.chk) { for (const x of d.chk.dec) (t.chkDec ||= new Set()).add(x); for (const x of d.chk.bad) (t.chkBad ||= new Set()).add(x); } }
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
      const dispatch = (chunk) => send1({ type: 'packBlock', c: chunk, o: popts, flat: !!t.flatPack, chk: t.chk }, [chunk.buffer]);
      if (columnsOk(m)) {   // staged columns: chunks of typed columns are grouped into blocks of about colBlock bytes of CSV and packed by the pack workers
        const colBlock = m.colBlockBytes || 8388608; let cq = [], cqBytes = 0, cqRows = 0, colHeaders = null;
        // Live columns (desktop, file up to LIVE_MAX): the chunks are kept so the grid can read them as soon as parsing ends, while the pack workers still work through their queue.
        // Blocks wait in blockQ and go to the pack workers as copies (the kept chunks are not transferred), so parsing never waits for packing.
        liveChunks = m.live === true && file.size <= LIVE_MAX ? [] : null; let blockQ = [], pumping = null, pumpErr = null;
        const pump = () => { if (!pumping) pumping = (async () => { while (blockQ.length) { const b = blockQ.shift(); await send1({ type: 'packCols', chunks: b, headers: colHeaders, o: popts }, [].concat(...b.map(chunkBuffers))); } })().catch((e) => { pumpErr = e; }).finally(() => { pumping = null; }); };
        const sendCols = async () => { const list = cq; cq = []; cqBytes = 0; cqRows = 0; if (liveChunks) { blockQ.push(list); pump(); } else await send1({ type: 'packCols', chunks: list, headers: colHeaders, o: popts }, [].concat(...list.map(chunkBuffers))); };
        colFlush = async () => { if (cq.length) await sendCols(); while (pumping) await pumping; if (pumpErr) throw pumpErr; };
        // Early view: the grid opens on the first parsed chunks and the row count grows while the file is still being read (a preview: no sort or filter until the end).
        const pvStarts = [0], pvDec = new TextDecoder(); let pvSent = 0, pvKind = null, pvOn = liveChunks !== null && m.preview !== false;
        const pvTick = () => {
          const total = pvStarts[pvStarts.length - 1], now = performance.now();
          if (!pvKind) {
            pvKind = colHeaders.map((_, k) => !!(plan && (plan[k] === true || (typeof plan[k] === 'number' && plan[k] > 0))));
            const columns = colHeaders.map((h, k) => Object.assign({ name: h, type: !pvKind[k] ? 'string' : plan[k] === true ? 'integer' : 'number', nullable: true }, pvKind[k] && typeof plan[k] === 'number' ? { decimals: plan[k] } : {}));
            const chunks = liveChunks, hs = colHeaders, kind = pvKind, find = (r) => { let lo = 0, hi = pvStarts.length - 2; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pvStarts[mid] <= r) lo = mid; else hi = mid - 1; } return lo; };
            const pv = { row(r) { const o = {}, c = find(r), i = r - pvStarts[c], ch = chunks[c]; for (let k = 0; k < hs.length; k++) { const x = ch.cols[k]; if (kind[k]) { const v = x[i]; o[hs[k]] = v !== v ? null : v; } else if (x.codes) { const q = x.codes[i], lb = x.lb; o[hs[k]] = pvDec.decode(lb.bytes.subarray(lb.start[q], lb.end[q])); } else o[hs[k]] = pvDec.decode(x.bytes.subarray(x.start[i], x.end[i])); } return o; } };
            view = { name, preview: true, pv, total, columns, R: null, f: null, rows: null, indices: null, filtered: false, cols: new Map(), flat: true, cache: new Map() };
            send('preview', m.id, { name, total, columns }); pvSent = now; return;
          }
          if (view && view.preview && now - pvSent >= 250) { view.total = total; send('previewGrow', m.id, { total }); pvSent = now; }
        };
        col = { begin: async (h) => { colHeaders = h; }, dup: !!liveChunks, push: async (c, c2) => { stop(job); if (liveChunks) { liveChunks.push(c); pvStarts.push(pvStarts[pvStarts.length - 1] + c.n); if (pvOn) { try { pvTick(); } catch { pvOn = false; if (view && view.preview) { view = null; send('liveclosed', m.id, {}); } } } cq.push(c2 || dupChunk(c)); } else cq.push(c); cqBytes += c.bytes; cqRows += c.n; if (cqBytes >= colBlock && cqRows >= 4096) await sendCols(); } };
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
    let plan = m.untyped ? null : await samplePlan(file, delimiter); if (plan && m.demote) { plan = plan.map((x, c) => (m.demote.includes(c) ? false : x)); if (!plan.some(Boolean)) plan = null; } const dictPlan = !m.untyped && m.dict !== false ? samplePlan.dict || null : null;
    let res = null;
    if (!m.ndjson && !m.parquet && useSegments(m, file)) res = await runSegmented(file, delimiter, job, packBytes, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t, m.segBytes || SEG_BYTES, plan, col, col ? dictPlan : null);
    if (!res && !m.ndjson && !m.parquet) try { helper = m.inline ? null : mkWorker(); } catch { helper = null; }
    if (m.parquet) { res = await parseParquet(file, job, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t, write, packer, col, (p) => { plan = p; }); if (res.plan) plan = res.plan; } else if (m.ndjson) { res = await parseNdjson(file, () => stop(job), packBytes, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t); } else if (res) { /* parsed in pieces */ } else if (helper) {   // parse on the helper, pack and write here: both run at once
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
    if (view && view.preview && view.name === name && !(view.live)) { view = null; send('liveclosed', m.id, {}); }
    await finishPacking(); if (res.refine) { res.refine(types); for (let i = 0; i < headers.length; i++) { cols[i].type = types[i].type; if (meta.tables[0].columns[i]) meta.tables[0].columns[i].type = types[i].type; } }
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
    if (view && (view.live || view.preview) && view.name === name) { view = null; send('liveclosed', m.id, {}); }
    if (writable && !closed) { try { await writable.abort(); } catch {} }
    if (name) await store.remove(name);
    if (err && err.mixed && !m.noColumns) restart = err.col != null && err.col >= 0 ? { col: err.col } : true;
    else send(err && err.cancelled ? 'cancelled' : 'error', m.id, { message: String(err && err.message || err), line: err && err.line || null });
  } finally { if (helper) helper.terminate(); if (typeof packWorkersToStop !== 'undefined') packWorkersToStop.forEach((w) => w.terminate()); jobs.delete(m.id); }
  return restart ? (restart === true ? 'mixed' : restart) : null;
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
  if (view && (view.live || view.preview) && view.name === m.name) return send('opened', m.id, { name: m.name, total: view.total, columns: view.columns });   // still being saved: the kept columns answer
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
        const a = st[r], e = en[r], len = e - a; let h = Math.imul(len + 2166136261, 16777619); if (len <= 32) { for (let i = a; i < e; i++) h = Math.imul(h ^ b[i], 16777619); } else { const mid = a + (len >> 1) - 4; for (let i = a; i < a + 10; i++) h = Math.imul(h ^ b[i], 16777619); for (let i = mid; i < mid + 8; i++) h = Math.imul(h ^ b[i], 16777619); for (let i = e - 10; i < e; i++) h = Math.imul(h ^ b[i], 16777619); } h >>>= 0;   // hash of the length and all bytes up to 32, else the first 10, middle 8 and last 10 (a full-bytes compare decides equality); timestamps differ only in the middle, so a first-and-last hash made every one collide
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
  if (EARLY_TEXT) textFromChunks(view);   // variant: start now, while the pack threads finish the file
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
    const objs = n ? (view.live || view.pv ? Array.from({ length: n }, (_, i) => (view.live || view.pv).row(m.start + i)) : await view.R.rows({ from: m.start, count: n })) : [];
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
// The groups to show: most rows first, ties by key text. Only the first `top` are needed, so groups below the count that the top-th group has are skipped before the sort (299k groups: a full sort with array keys took 2 s).
function topGroups(g, two, top) {
  const G = g.keys.length, c = g.counts; let cand;
  if (G > top * 4) {
    let mx = 0; for (let i = 0; i < G; i++) if (c[i] > mx) mx = c[i];
    if (mx <= 1048576) {
      const h = new Uint32Array(mx + 2); for (let i = 0; i < G; i++) h[c[i]]++;
      let thr = mx, acc = 0; for (; thr > 0; thr--) { acc += h[thr]; if (acc >= top) break; }
      cand = []; for (let i = 0; i < G; i++) if (c[i] >= thr) cand.push(i);
    }
  }
  if (!cand) { cand = []; for (let i = 0; i < G; i++) cand.push(i); }
  const K = g.keys, K2 = g.keys2;
  return cand.sort(two ? (a, b) => c[b] - c[a] || (K[a] < K[b] ? -1 : K[a] > K[b] ? 1 : K2[a] < K2[b] ? -1 : K2[a] > K2[b] ? 1 : 0) : (a, b) => c[b] - c[a] || (K[a] < K[b] ? -1 : K[a] > K[b] ? 1 : 0));
}
async function groupView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  try {
    groupMod ||= MODS() && MODS().groupBy ? { groupBy: MODS().groupBy, groupByCodes: MODS().groupByCodes, groupBy2: MODS().groupBy2 } : await import('../src/query/groupby.mjs');
    queryMod ||= MODS() || await import('../src/query/query.mjs'); colMod ||= MODS() || await import('../src/query/columnar.mjs');
    if (view.total > MAX_COLUMN_ROWS || !view.flat) throw new Error('Group by works up to ' + MAX_COLUMN_ROWS.toLocaleString() + ' rows for now.');
    const t0 = performance.now(), aggs = m.aggs || [{ fn: 'count' }], names = [...new Set([m.key].concat(m.key2 ? [m.key2] : [], aggs.filter((a) => a.col).map((a) => a.col)))];
    const active = Object.keys(m.filters || {}).filter((k) => m.filters[k]);
    for (const n of names) if (!view.columns.some((c) => c.name === n)) throw new Error('No column named ' + n + '.');
    const dc = (!m.noDict && view.dictCols) || {}, useIds = !m.key2 && !!dc[m.key], two = !!m.key2;
    // a column kept as dictionary ids from the import is counted by id: no text is decoded for it (the key, or an equal-to column in a 'share equal to' aggregate)
    const need = Array.from(new Set(names.concat(active))).filter((n) => !((useIds || two) && dc[n] && !active.includes(n)));
    if (!/AppleWebKit(?!.*Chrome)/.test(self.navigator.userAgent || '') && !m.noParallel) await warmSome(need);   // missing columns decoded on helper threads at once (not in WebKitGTK: slower there)
    const cols = await loadColumns(need, false), tLoad = performance.now() - t0, tg = performance.now();
    let rows = null; if (active.length) rows = colMod.runColumnQuery(cols, view.total, view.columns, { filters: m.filters }).indices;
    const codeCols = {}; for (const a of aggs) if (a.col && dc[a.col] && a.fn === 'rate' && !m.noDict) codeCols[a.col] = dc[a.col];
    const g = two ? groupMod.groupBy2(cols, view.total, rows, { key: m.key, key2: m.key2, aggs, forceMap: !!m.forceMap, codeCols, cache: m.noKeyCache ? null : (view.keyCache ||= new Map()), ids1: dc[m.key] && dc[m.key].ids, dict1: dc[m.key] && dc[m.key].dict, ids2: dc[m.key2] && dc[m.key2].ids, dict2: dc[m.key2] && dc[m.key2].dict }) : useIds ? groupMod.groupByCodes(dc[m.key].ids, dc[m.key].dict, cols, view.total, rows, { aggs, codeCols }) : groupMod.groupBy(cols, view.total, rows, { key: m.key, aggs }), order = topGroups(g, two, 1000);
    const head = (two ? [m.key, m.key2] : [m.key]).concat(aggs.map((a) => (a.fn === 'count' ? 'count' : a.fn + '_' + a.col)));
    const table = order.slice(0, 1000).map((gi) => { let v = 0; return (two ? [g.keys[gi], g.keys2[gi]] : [g.keys[gi]]).concat(aggs.map((a) => { const x = a.fn === 'count' ? g.counts[gi] : g.values[v++][gi]; return x !== x ? '' : a.fn === 'avg' || a.fn === 'rate' ? String(Math.round(x * 10000) / 10000) : String(x); })); });
    view.lastGroup = { g, two, aggs, head, key: m.key, key2: m.key2, source: view.name };
    send('grouped', m.id, { byIds: useIds, headers: head, rows: table, groups: g.keys.length, rowsUsed: rows ? rows.length : view.total, ms: Math.round(performance.now() - t0), loadMs: Math.round(tLoad), groupMs: Math.round(performance.now() - tg) });
  } catch (err) { send('error', m.id, { message: String(err && err.message || err) }); }
}
// Decode every file column that is not decoded yet in two parallel calls (numbers as typed arrays, text as strings), so a filtered export reads its rows from memory instead of from 450 scattered blocks.
// Decodes the wanted columns that are not in memory yet, all in one pass (two parallel calls: number columns as typed arrays, text columns as strings; a dictionary column kept from the import costs
// one lookup per row and no decode). A column another call is already decoding is waited for, never decoded twice (a Save right after the background warm used to start the same decode again).
const yieldNow = (() => { const mc = new MessageChannel(); let res = null; mc.port1.onmessage = () => { const r = res; res = null; if (r) r(); }; return () => new Promise((r) => { res = r; mc.port2.postMessage(0); }); })();   // a turn for queued messages without the timer delay
const EARLY_TEXT = true;
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
// Saves the last Summarize result (every group, most rows first) as a new LFCP dataset: one text column per key, a count column, one number column per aggregate.
async function exportSummary(m) {
  let writable = null, name = null, closed = false;
  try {
    const lg = view && view.lastGroup; if (!lg) throw new Error('Run Summarize first.');
    await LfcPack.init(); const t0 = performance.now(), { g, two, aggs, head } = lg, order = topGroups(g, two, Infinity), n = order.length;
    const cols = {}, types = [], numCols = [];
    const nk = two ? 2 : 1; for (let k = 0; k < nk; k++) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = k ? g.keys2[order[i]] : g.keys[order[i]]; cols[head[k]] = a; types.push('string'); }
    let v = 0; aggs.forEach((a, j) => { const arr = new Array(n), src = a.fn === 'count' ? g.counts : g.values[v++]; for (let i = 0; i < n; i++) { const x = src[order[i]]; arr[i] = x !== x ? null : x; } cols[head[nk + j]] = arr; types.push(a.fn === 'count' || a.fn === 'min' || a.fn === 'max' || a.fn === 'sum' ? 'number' : 'number'); });
    const names = Object.keys(cols), colMeta = names.map((nm, i) => ({ id: 'field-' + (i + 1), name: nm.slice(0, 100), type: types[i] === 'string' ? 'string' : (names[i] === 'count' ? 'integer' : 'number'), nullable: true }));
    name = safe(view.name.replace(/-[0-9a-f-]{36}\.json\.lfc$/, '')) + '-summary-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)) + '.json.lfc';
    writable = await store.create(name);
    const meta = { producer: 'LFCFoundry Workbench', producerVersion: '0.2.0', sourceFormat: 'lfcp', sourceName: 'summary of ' + view.name.slice(0, 150), sourceBytes: 0, tables: [{ name: 'rows', rows: n, columns: colMeta }] };
    const popts = { level: 3, blockBytes: 2097152, share: false }, packer = LfcPack.packStream(Object.assign({}, popts, { meta })); let outBytes = 0;
    const write = async (parts) => { for (const p of parts) { await writable.write(p); outBytes += p.byteLength; } };
    const BATCH = 65536; for (let s = 0; s < n; s += BATCH) { const out = {}; for (const nm of names) out[nm] = cols[nm].slice(s, s + BATCH); const r = await LfcPack.packBlock(out, popts); await write(packer.pushPacked(r)); }
    await write(packer.finish()); await writable.close(); closed = true; writable = null;
    const vd = await validate(name, n); if (!vd.ok) throw new Error('The written file failed footer validation: ' + vd.reason);
    const cat = await store.catalog(); cat.push({ name, source: 'summary of ' + view.name, rows: n, bytes: outBytes, columns: colMeta.map((c) => ({ name: c.name, type: c.type, nullable: true })), created: Date.now(), storage: STORAGE }); await store.setCatalog(cat);
    send('exportedLfcp', m.id, { name, rows: n, bytes: outBytes, blob: await store.file(name), ms: Math.round(performance.now() - t0) });
  } catch (err) {
    if (writable && !closed) { try { await writable.abort(); } catch {} } if (name) await store.remove(name);
    send('error', m.id, { message: String(err && err.message || err) });
  }
}
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
    const BATCH = m.batch || 16384, tm = { rows: 0, text: 0, pack: 0 }, allWarm = cols.every((c) => view.cols.has(c.name)), popts = { level: 3, blockBytes: 2097152, share: false };
    const packer2 = LfcPack.packStream(Object.assign({}, popts, { meta }));
    // Batches are packed on up to three helper threads while this thread gathers the next one; the packed blocks are written in order (LFC-pack packBlock / pushPacked, as the import does).
    let pool = null; const npool = m.noPool || !isFirefox || !allWarm || !LfcPack.packBlock ? 0 : Math.min(3, Math.ceil(count / BATCH));   // Firefox only: in Chromium the helper threads were no faster (pack 0.44-0.62 s against 0.36-0.50 s on this thread)
    if (npool > 1) { try { pool = []; for (let i = 0; i < npool; i++) pool.push(new Worker(self.location.href)); } catch { if (pool) pool.forEach((w) => w.terminate()); pool = null; } }
    const results = new Map(); let nextW = 0, emit = 0, pending = 0, wake = null, failed = null;
    const drain = async () => { while (results.has(emit)) { const r = results.get(emit); results.delete(emit); emit++; await write(packer2.pushPacked(r)); } };
    if (pool) for (const w of pool) w.onmessage = (e) => { const d = e.data || {}; pending--; if (d.error) failed = new Error(d.error); else results.set(d.rid, d.r); if (wake) { const r = wake; wake = null; r(); } };
    let seq = 0;
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
        if (pool) {
          while (pending >= pool.length) { await new Promise((r) => { wake = r; }); if (failed) throw failed; await drain(); }
          pending++; pool[nextW++ % pool.length].postMessage({ type: 'packPlain', rid: seq++, cols: out, o: popts });
          await drain();
        } else { const r = await LfcPack.packBlock(out, popts); await write(packer2.pushPacked(r)); }
        tm.pack += performance.now() - ts; continue;
      }
      const objs = view.filtered ? await rowsAt(view.indices, start, end) : view.live ? Array.from({ length: end - start }, (_, i) => view.live.row(start + i)) : await view.R.rows({ from: start, count: end - start });
      if (!view.filtered && view.derived && view.derived.size) overlayDerived(objs, (i) => start + i);
      tm.rows += performance.now() - ts; ts = performance.now(); let text = '';
      for (const r of objs) { let line = ''; for (let k = 0; k < cols.length; k++) { const v = r[cols[k].name]; line += keyQ[k] + (v == null ? 'null' : JSON.stringify(v)); } text += line + '}\n'; }
      tm.text += performance.now() - ts; ts = performance.now(); await write(packer2.push(enc.encode(text))); tm.pack += performance.now() - ts;
    }
    if (pool) { const ts = performance.now(); while (pending > 0 || results.size) { if (failed) throw failed; await drain(); if (pending > 0) await new Promise((r) => { wake = r; }); } tm.pack += performance.now() - ts; pool.forEach((w) => w.terminate()); }
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

// ---- Parquet (flat files): the reader is compression part 7's parquet-reader.js (v1 and v2 pages, PLAIN, dictionary, delta, byte-stream-split, snappy, zstd, uncompressed), unchanged below this line.
const isParquet = async (f) => { if (!f || f.size < 12) return false; const h = new Uint8Array(await f.slice(0, 4).arrayBuffer()); return h[0] === 0x50 && h[1] === 0x41 && h[2] === 0x52 && h[3] === 0x31; };
// Prototype Parquet reader (compression part 7): flat schema, PLAIN + RLE_DICTIONARY, RLE/bit-packed levels, zstd or uncompressed pages.
// Output per column chunk: number columns -> Float64Array (NaN = null); text columns -> { bytes, start, end } (null -> empty text, as the CSV path) or { codes, lb } for dictionary chunks.
// Works in a worker and in Node (UMD-less: sets self.PQ / module.exports).
(function () {
  'use strict';
  var TY = { BOOL: 0, I32: 1, I64: 2, I96: 3, F32: 4, F64: 5, BA: 6, FLBA: 7 };
  function thrift(b, p0) {   // Thrift compact reader: returns { v, p } for one struct
    var p = p0 || 0;
    function vi() { var r = 0, s = 0, c; for (;;) { c = b[p++]; r += (c & 127) * Math.pow(2, s); if (!(c & 128)) return r; s += 7; } }
    function zz() { var v = vi(); return (v % 2) ? -(v + 1) / 2 : v / 2; }
    function val(ty) {
      switch (ty) {
        case 1: return true; case 2: return false; case 3: return b[p++]; case 4: case 5: case 6: return zz(); case 7: p += 8; return 0;
        case 8: { var n = vi(), s = new TextDecoder().decode(b.subarray(p, p + n)); p += n; return s; }
        case 9: case 10: { var h = b[p++], n2 = h >> 4, et = h & 15, a = [], i; if (n2 === 15) n2 = vi(); for (i = 0; i < n2; i++) a.push(et === 1 ? b[p++] === 1 : val(et)); return a; }
        case 12: return st();
      } throw new Error('thrift type ' + ty);
    }
    function st() { var o = {}, id = 0, h, d, ty; for (;;) { h = b[p++]; if (h === 0) return o; d = h >> 4; ty = h & 15; id = d ? id + d : zz(); o[id] = ty === 1 ? true : ty === 2 ? false : val(ty); } }
    var v = st(); return { v: v, p: p };
  }
  // what a column is for the Workbench column plan: kind 'int' | 'double' | 'decimal' (scale = decimals) | 'timestamp' (unit 'ms' | 'us' | 'ns', epoch) | 'date' (days since epoch) | 'bool' | 'text'
  function describe(type, conv, lg, cscale, cprec) {
    if (type === TY.BA && !(conv === 5)) return { kind: 'text' };
    if (type === TY.BOOL) return { kind: 'bool' };
    if (lg[5] || conv === 5) return { kind: 'decimal', scale: lg[5] ? lg[5][1] : (cscale || 0) };
    if (lg[6] || conv === 6) return { kind: 'date' };
    if (lg[8]) return { kind: 'timestamp', unit: lg[8][2][1] ? 'ms' : lg[8][2][2] ? 'us' : 'ns' };
    if (conv === 9) return { kind: 'timestamp', unit: 'ms' };
    if (conv === 10) return { kind: 'timestamp', unit: 'us' };
    if (type === TY.F32 || type === TY.F64) return { kind: 'double' };
    if (type === TY.I32 || type === TY.I64) return { kind: 'int' };
    return { kind: 'other' };
  }
  function readFooter(tail) {   // tail: the last bytes of the file (at least footer length + 8); returns { rows, groups, cols }
    var n = tail.length, fl = tail[n - 8] | tail[n - 7] << 8 | tail[n - 6] << 16 | tail[n - 5] << 24 >>> 0;
    var m = thrift(tail.subarray(n - 8 - fl, n - 8)).v;
    var schema = m[2], si = 1, cols = [];
    function walk(depth, nested) {   // leaves in file order (= column chunk order); anything below a group, or repeated, is marked nested
      var s = schema[si++], nch = s[5] || 0, i;
      if (nch) { for (i = 0; i < nch; i++) walk(depth + 1, true); return; }
      var lg = s[10] || {}, k = describe(s[1], s[6], lg, s[7], s[8]);
      cols.push({ name: s[4], type: s[1], conv: s[6], logical: s[10], rep: s[3], flba: s[2], kind: k.kind, unit: k.unit, scale: k.scale, nested: nested || s[3] === 2 });
    }
    var nroot = schema[0][5] || 0, ri; for (ri = 0; ri < nroot; ri++) walk(1, false);
    var groups = m[4].map(function (g) { return { rows: g[3], chunks: g[1].map(function (c) { var cm = c[3]; return { type: cm[1], codec: cm[4], n: cm[5], comp: cm[7], uncomp: cm[6], dataOff: cm[9], dictOff: cm[11], start: cm[11] !== undefined && cm[11] > 0 ? Math.min(cm[11], cm[9]) : cm[9] }; }) }; });
    return { rows: m[3], cols: cols, groups: groups, footerLen: fl };
  }
  // RLE / bit-packed hybrid -> Int32Array(count) (bit width up to 32)
  function hybrid(b, p, end, bw, count, out) {
    var o = 0, h, c, i, v, bytes = (bw + 7) >> 3, mask = bw >= 32 ? -1 : (1 << bw) - 1;
    out = out || new Int32Array(count);
    while (o < count && p < end) {
      h = 0; var s = 0, x; do { x = b[p++]; h |= (x & 127) << s; s += 7; } while (x & 128);
      if (h & 1) {   // bit-packed: (h>>1) groups of 8
        var groups = h >>> 1, nv = groups * 8, bitpos = 0, take = Math.min(nv, count - o);
        for (i = 0; i < take; i++) { var bi = p + (bitpos >> 3), sh = bitpos & 7, w = b[bi] | (b[bi + 1] << 8) | (b[bi + 2] << 16) | (b[bi + 3] << 24); v = (w >>> sh) | (sh + bw > 32 ? (b[bi + 4] << (32 - sh)) : 0); out[o++] = v & mask; bitpos += bw; }
        p += groups * bw;
      } else {
        c = h >>> 1; v = 0; for (i = 0; i < bytes; i++) v |= b[p++] << (8 * i); v &= mask;
        var take2 = Math.min(c, count - o); if (v === 0) o += take2; else { out.fill(v, o, o + take2); o += take2; }
      }
    }
    return out;
  }
  function plainText(b, p, end, n) {   // PLAIN byte arrays -> { bytes, start, end } (offsets into a fresh joined copy)
    var start = new Int32Array(n), en = new Int32Array(n), i, tot = 0, q = p, L;
    for (i = 0; i < n; i++) { L = b[q] | b[q + 1] << 8 | b[q + 2] << 16 | b[q + 3] << 24; tot += L; q += 4 + L; }
    var bytes = new Uint8Array(tot), o = 0; q = p;
    for (i = 0; i < n; i++) { L = b[q] | b[q + 1] << 8 | b[q + 2] << 16 | b[q + 3] << 24; q += 4; bytes.set(b.subarray(q, q + L), o); start[i] = o; o += L; en[i] = o; q += L; }
    return { bytes: bytes, start: start, end: en };
  }
  function flbaNum(b, p, n, len) {   // FIXED_LEN_BYTE_ARRAY decimals: big-endian two's complement -> number
    var out = new Float64Array(n), i, j, v, neg;
    for (i = 0; i < n; i++, p += len) { neg = b[p] & 128; v = 0; for (j = 0; j < len; j++) v = v * 256 + (neg ? (~b[p + j] & 255) : b[p + j]); out[i] = neg ? -(v + 1) : v; }
    return out;
  }
  function plainNum(b, p, n, type, flba) {   // PLAIN number values -> Float64Array(n)
    var out = new Float64Array(n), i;
    if (type === TY.F64) { var cp = new Uint8Array(n * 8); cp.set(b.subarray(p, p + n * 8)); out.set(new Float64Array(cp.buffer)); return out; }
    if (type === TY.I32) { var c4 = new Uint8Array(n * 4); c4.set(b.subarray(p, p + n * 4)); var a = new Int32Array(c4.buffer); for (i = 0; i < n; i++) out[i] = a[i]; return out; }
    if (type === TY.I64) { var c8 = new Uint8Array(n * 8); c8.set(b.subarray(p, p + n * 8)); var u = new Uint32Array(c8.buffer), h = new Int32Array(c8.buffer); for (i = 0; i < n; i++) { if (h[2 * i + 1] > 2097151 || h[2 * i + 1] < -2097152) throw new Error('INT64 value beyond 2^53 is not supported'); out[i] = h[2 * i + 1] * 4294967296 + u[2 * i]; } return out; }
    if (type === TY.F32) { var cf = new Uint8Array(n * 4); cf.set(b.subarray(p, p + n * 4)); var f = new Float32Array(cf.buffer); for (i = 0; i < n; i++) out[i] = f[i]; return out; }
    if (type === TY.FLBA) return flbaNum(b, p, n, flba);
    throw new Error('plain type ' + type);
  }
  function bitsAt(b, pos, w) {   // w bits (up to 53) at bit position pos, little endian, as a number
    var bi = pos >> 3, sh = pos & 7, v = 0, got = 0, mul = 1, take;
    while (got < w) { take = Math.min(8 - sh, w - got); v += ((b[bi] >> sh) & ((1 << take) - 1)) * mul; mul *= (1 << take); got += take; bi++; sh = 0; }
    return v;
  }
  // DELTA_BINARY_PACKED -> { vals: Float64Array(count), end: byte position after the data }
  function deltaBP(b, p, count, wrap32) {
    var q = p; function uv() { var r = 0, m = 1, c; do { c = b[q++]; r += (c & 127) * m; m *= 128; } while (c & 128); return r; }
    function zv() { var v = uv(); return (v % 2) ? -(v + 1) / 2 : v / 2; }
    var bsz = uv(), mbn = uv(), total = uv(), first = zv(), out = new Float64Array(count), o = 0, cur = first, per = bsz / mbn, i, k, w, md, widths;
    if (count > 0) out[o++] = cur;
    while (o < count) {
      md = zv(); widths = b.subarray(q, q + mbn); q += mbn;
      for (k = 0; k < mbn && o < count; k++) {
        w = widths[k];
        if (w === 0) { for (i = 0; i < per && o < count; i++) { cur += md; out[o++] = cur; } }
        else { var base = q * 8; for (i = 0; i < per; i++) { var d = bitsAt(b, base + i * w, w); if (o < count) { cur += md + d; out[o++] = cur; } } q += (per * w) >> 3; }
      }
    }
    if (wrap32) for (i = 0; i < count; i++) out[i] = out[i] | 0; else for (i = 0; i < count; i++) if (out[i] > 9007199254740991 || out[i] < -9007199254740991) throw new Error('INT64 value beyond 2^53 is not supported');
    return { vals: out, end: q };
  }
  function packText(strs, lens, n) {   // helper: from byte pieces to { bytes, start, end }
    var tot = 0, i; for (i = 0; i < n; i++) tot += lens[i];
    return tot;
  }
  function deltaLengthBA(b, p, n) {
    var r = deltaBP(b, p, n), L = r.vals, start = new Int32Array(n), en = new Int32Array(n), tot = 0, i, q = r.end;
    for (i = 0; i < n; i++) tot += L[i];
    var bytes = new Uint8Array(tot); bytes.set(b.subarray(q, q + tot)); var o = 0;
    for (i = 0; i < n; i++) { start[i] = o; o += L[i]; en[i] = o; }
    return { bytes: bytes, start: start, end: en };
  }
  function deltaByteArray(b, p, n) {
    var pr = deltaBP(b, p, n), suf = deltaLengthBA(b, pr.end, n), P = pr.vals, i, tot = 0, start = new Int32Array(n), en = new Int32Array(n), L = new Int32Array(n);
    for (i = 0; i < n; i++) { L[i] = P[i] + (suf.end[i] - suf.start[i]); tot += L[i]; }
    var bytes = new Uint8Array(tot), o = 0, prev = 0, s0;
    for (i = 0; i < n; i++) { start[i] = o; if (P[i]) bytes.copyWithin(o, prev, prev + P[i]); s0 = o + P[i]; bytes.set(suf.bytes.subarray(suf.start[i], suf.end[i]), s0); prev = o; o += L[i]; en[i] = o; }
    return { bytes: bytes, start: start, end: en };
  }
  function byteStreamSplit(b, p, n, type, flba) {
    var w = type === TY.F64 || type === TY.I64 ? 8 : 4, cp = new Uint8Array(n * w), i, j;
    for (j = 0; j < w; j++) for (i = 0; i < n; i++) cp[i * w + j] = b[p + j * n + i];
    return plainNum(cp, 0, n, type, flba);
  }
  function plainBool(b, p, n) { var out = new Float64Array(n), i; for (i = 0; i < n; i++) out[i] = (b[p + (i >> 3)] >> (i & 7)) & 1; return out; }
  function plainText(b, p, end, n) {   // PLAIN byte arrays -> { bytes, start, end } (offsets into a fresh joined copy)
    var start = new Int32Array(n), en = new Int32Array(n), i, tot = 0, q = p, L;
    for (i = 0; i < n; i++) { L = b[q] | b[q + 1] << 8 | b[q + 2] << 16 | b[q + 3] << 24; tot += L; q += 4 + L; }
    var bytes = new Uint8Array(tot), o = 0; q = p;
    for (i = 0; i < n; i++) { L = b[q] | b[q + 1] << 8 | b[q + 2] << 16 | b[q + 3] << 24; q += 4; bytes.set(b.subarray(q, q + L), o); start[i] = o; o += L; en[i] = o; q += L; }
    return { bytes: bytes, start: start, end: en };
  }
  // Snappy raw block decoder (Parquet codec 1)
  function snappy(src, ulen) {
    var p = 0, n = 0, sh = 0, c; do { c = src[p++]; n |= (c & 127) << sh; sh += 7; } while (c & 128);
    var out = new Uint8Array(n), o = 0, len, off, tag, i;
    while (p < src.length) {
      tag = src[p++];
      switch (tag & 3) {
        case 0: len = tag >> 2; if (len >= 60) { var nb = len - 59; len = 0; for (i = 0; i < nb; i++) len |= src[p++] << (8 * i); } len++; out.set(src.subarray(p, p + len), o); p += len; o += len; continue;
        case 1: len = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[p++]; break;
        case 2: len = (tag >> 2) + 1; off = src[p] | src[p + 1] << 8; p += 2; break;
        default: len = (tag >> 2) + 1; off = src[p] | src[p + 1] << 8 | src[p + 2] << 16 | src[p + 3] << 24; p += 4;
      }
      if (off > o || off === 0) throw new Error('snappy: bad offset');
      if (off >= len) { out.copyWithin(o, o - off, o - off + len); o += len; } else { for (i = 0; i < len; i++, o++) out[o] = out[o - off]; }
    }
    if (o !== n || (ulen != null && n !== ulen)) throw new Error('snappy: length mismatch');
    return out;
  }
  function decodeValues(col, enc, pg, q, nn, dict) {
    var isText = col.type === TY.BA, t = col.type;
    if (enc === 8 || enc === 2) { var bw = pg[q++]; return { dictIdx: hybrid(pg, q, pg.length, bw, nn) }; }
    if (t === TY.BOOL) { if (enc === 0) return plainBool(pg, q, nn); if (enc === 3) { var bl = pg[q] | pg[q + 1] << 8 | pg[q + 2] << 16 | pg[q + 3] << 24; return Float64Array.from(hybrid(pg, q + 4, q + 4 + bl, 1, nn)); } throw new Error('bool encoding ' + enc); }
    if (enc === 0) return isText ? plainText(pg, q, pg.length, nn) : plainNum(pg, q, nn, t, col.flba);
    if (enc === 5) { if (t !== TY.I32 && t !== TY.I64) throw new Error('delta on type ' + t); return deltaBP(pg, q, nn, t === TY.I32).vals; }
    if (enc === 6 && isText) return deltaLengthBA(pg, q, nn);
    if (enc === 7 && isText) return deltaByteArray(pg, q, nn);
    if (enc === 9) return byteStreamSplit(pg, q, nn, t, col.flba);
    throw new Error('encoding ' + enc + ' not supported for type ' + t);
  }
  // decode one column chunk. bytes = the chunk's raw bytes; inflate(view, ulen) returns a Uint8Array (a view valid until the next call) for zstd pages.
  function decodeChunk(col, ch, bytes, inflate) {
    if (col.nested) throw new Error('nested or repeated column "' + col.name + '" is not supported yet');
    var p = 0, end = bytes.length, isText = col.type === TY.BA, dict = null, parts = [], total = 0;
    function unc(body, ul) { return ch.codec === 0 ? body : ch.codec === 6 ? inflate(body, ul) : ch.codec === 1 ? snappy(body, ul) : (function () { throw new Error('codec ' + ch.codec + ' not supported'); })(); }
    while (p < end) {
      var r = thrift(bytes, p), h = r.v, ty = h[1], ul = h[2], cl = h[3], body = bytes.subarray(r.p, r.p + cl);
      p = r.p + cl;
      if (ty === 2) {   // dictionary page, PLAIN
        var pgd = unc(body, ul), dn = h[7][1]; dict = isText ? plainText(pgd, 0, pgd.length, dn) : plainNum(pgd, 0, dn, col.type, col.flba); dict.n = dn; continue;
      }
      var nv, enc, q = 0, nn, defs = null, pg;
      if (ty === 0) {
        var dh = h[5]; nv = dh[1]; enc = dh[2]; pg = unc(body, ul); nn = nv;
        if (col.rep === 1) { var dl = pg[0] | pg[1] << 8 | pg[2] << 16 | pg[3] << 24; defs = hybrid(pg, 4, 4 + dl, 1, nv); q = 4 + dl; nn = 0; for (var i = 0; i < nv; i++) nn += defs[i]; if (nn === nv) defs = null; }
      } else if (ty === 3) {   // data page v2: levels first (never compressed), then the values (compressed unless is_compressed is false)
        var d2 = h[8]; nv = d2[1]; var nnul = d2[2]; enc = d2[4]; var dlen = d2[5] || 0, rlen = d2[6] || 0, isc = d2[7] !== false;
        nn = nv - nnul; var lv = body.subarray(0, rlen + dlen), vb = body.subarray(rlen + dlen);
        if (col.rep === 1 && nnul > 0) defs = hybrid(lv, rlen, rlen + dlen, 1, nv);
        pg = (isc && ch.codec !== 0) ? unc(vb, ul - rlen - dlen) : vb; q = 0;
      } else throw new Error('page type ' + ty + ' not supported');
      var vals = decodeValues(col, enc, pg, q, nn, dict);
      parts.push({ nv: nv, nn: nn, defs: defs, vals: vals }); total += nv;
    }
    return assemble(col, parts, total, dict, isText);
  }
  var BOOLLB = null;
  function boolLabels() { if (!BOOLLB) { var te = new TextEncoder(), a = te.encode('false'), b = te.encode('true'), bytes = new Uint8Array(9); bytes.set(a, 0); bytes.set(b, 5); BOOLLB = { bytes: bytes, start: Int32Array.of(0, 5, 9), end: Int32Array.of(5, 9, 9), n: 3 }; } return BOOLLB; }
  function assemble(col, parts, total, dict, isText) {
    var k, i, o = 0;
    if (col.type === TY.BOOL) {   // booleans arrive as a dictionary text chunk "false" / "true" (null = empty), as the CSV path sees them
      var bc = new Int32Array(total);
      for (k = 0; k < parts.length; k++) { var pb = parts[k], sv = pb.vals, j0 = 0; for (i = 0; i < pb.nv; i++) bc[o + i] = (!pb.defs || pb.defs[i]) ? sv[j0++] : 2; o += pb.nv; }
      return { codes: bc, lb: boolLabels() };
    }
    if (!isText) {
      var out = new Float64Array(total);
      for (k = 0; k < parts.length; k++) {
        var pt = parts[k], v = pt.vals, src;
        if (v.dictIdx) { src = new Float64Array(pt.nn); var di = v.dictIdx; for (i = 0; i < pt.nn; i++) src[i] = dict[di[i]]; } else src = v;
        if (!pt.defs) { out.set(src, o); } else { var j = 0; for (i = 0; i < pt.nv; i++) out[o + i] = pt.defs[i] ? src[j++] : NaN; }
        o += pt.nv;
      }
      return out;
    }
    var allDict = parts.every(function (x) { return x.vals.dictIdx; });
    if (allDict && dict) {
      var codes = new Int32Array(total), nulls = false, lb = dict, dn = dict.n;
      for (k = 0; k < parts.length; k++) { var p2 = parts[k], di2 = p2.vals.dictIdx; if (!p2.defs) { codes.set(di2.subarray(0, p2.nn), o); } else { var j2 = 0; for (i = 0; i < p2.nv; i++) { if (p2.defs[i]) codes[o + i] = di2[j2++]; else { codes[o + i] = dn; nulls = true; } } } o += p2.nv; }
      if (nulls) { var nb = new Uint8Array(lb.bytes.length), ns = new Int32Array(dn + 1), ne = new Int32Array(dn + 1); nb.set(lb.bytes); ns.set(lb.start); ne.set(lb.end); ns[dn] = ne[dn] = lb.bytes.length; lb = { bytes: nb, start: ns, end: ne, n: dn + 1 }; }
      return { codes: codes, lb: lb };
    }
    var tb = 0; var texts = parts.map(function (pt2) { var v2 = pt2.vals; if (v2.dictIdx) { var dd = dict, tbb = 0, x; for (i = 0; i < pt2.nn; i++) { x = v2.dictIdx[i]; tbb += dd.end[x] - dd.start[x]; } var bytes = new Uint8Array(tbb), st = new Int32Array(pt2.nn), en = new Int32Array(pt2.nn), oo = 0; for (i = 0; i < pt2.nn; i++) { x = v2.dictIdx[i]; st[i] = oo; bytes.set(dd.bytes.subarray(dd.start[x], dd.end[x]), oo); oo += dd.end[x] - dd.start[x]; en[i] = oo; } v2 = { bytes: bytes, start: st, end: en }; } return v2; });
    texts.forEach(function (t) { tb += t.bytes.length; });
    var B = new Uint8Array(tb), S = new Int32Array(total), E = new Int32Array(total), bo = 0; o = 0;
    for (k = 0; k < parts.length; k++) { var pt3 = parts[k], t = texts[k]; B.set(t.bytes, bo); var jj = 0; for (i = 0; i < pt3.nv; i++) { if (!pt3.defs || pt3.defs[i]) { S[o + i] = t.start[jj] + bo; E[o + i] = t.end[jj] + bo; jj++; } else { S[o + i] = E[o + i] = bo; } } bo += t.bytes.length; o += pt3.nv; }
    return { bytes: B, start: S, end: E };
  }
  var api = { describe: describe, readFooter: readFooter, decodeChunk: decodeChunk, thrift: thrift, hybrid: hybrid, snappy: snappy, TY: TY };
  if (typeof module === 'object' && module.exports) module.exports = api; else self.PQ = api;
})();

let ZX = null, zip_ = 0, zic = 0, zop = 0, zoc = 0;   // zstd (zstd-kit wasm) for Parquet pages
const ZD64 = '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AQACCyAULQACQRB0IBlyIRkLIBQtAAFBCHQgGWohGQsgB0F/ai0AACIGRQ0CIAZnIAhBA3RrQQlqIRggFCEICyAFQQxqIAcgAyAJaxCkgICAACIGQYh/Sw0CIARBBGohAyAOQX1qIRogAkEKaiEbIBBBBGohHCAUQQRqIR0CQAJAIA4gDWtBBE8NACANIQIgDCEHIAshBAwBCyAFKAIMIR4CQAJAIA0gGkkNACANIQIgDCEHIAshBAwBC0EAIBFrQR9xIQYgBSgCFCEfIAUoAhAhCSAFKAIcISAgCyEEIAwhByANIQIDQCAAIAMgCiASdCAGdkECdGoiIS8BADsAACAhLQACISIgIS0AAyEjIAQgAyAXIBV0IAZ2QQJ0aiIhLwEAOwAAICEtAAIhJCAhLQADISUgByADIBkgGHQgBnZBAnRqIiEvAQA7AAAgIS0AAiEmICEtAAMhJyACIAMgHiAJdCAGdkECdGoiIS8BADsAACAhLQACISggIS0AAyEhIAAgI2oiIyADIAogEiAiaiISdCAGdkECdGoiAC8BADsAACAALQACISIgAC0AAyEpIAQgJWoiBCADIBcgFSAkaiIVdCAGdkECdGoiAC8BADsAACAALQACISQgAC0AAyElIAcgJ2oiByADIBkgGCAmaiIYdCAGdkECdGoiAC8BADsAACAALQACISYgAC0AAyEnIAIgIWoiKiADIB4gCSAoaiIAdCAGdkECdGoiAi8BADsAACAFIAAgAi0AAmoiCTYCECASICJqIQACQAJAIBMgG08NACAAIRJBAyEiDAELIABBB3EhEiATIABBA3ZrIhMoAAAhCkEAISILIAItAAMhACAVICRqIQJBAyEhAkACQCAWIBxPDQAgAiEVQQMhJAwBCyACQQdxIRUgFiACQQN2ayIWKAAAIRdBACEkCyAYICZqIQICQAJAIAggHU8NACACIRgMAQsgAkEHcSEYIAggAkEDdmsiCCgAACEZQQAhIQsgKiAAaiECAkACQCAfICBPDQBBAyEmDAELIAUgCUEHcSIANgIQIB8gCUEDdmsiHygAACEeQQAhJiAAIQkLICMgKWohACAEICVqIQQgByAnaiEHAkAgAiAaTw0AICQgInIgIXIgJnJFDQELCyAFIB82AhQLIAUgHjYCDAsgACALSw0BIAQgDEsNAUFsIQYgByANSw0C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QQxqNgIAIABBtNABaiABQbDQAWooAgA2AgAPCyAAQgA3A4jqAQt0AQN/AkAgAEUNACAAQbjVAWooAgAhASAAQbTVAWooAgAhAgJAAkACQAJAIAAoAgAiA0UNACACRQ0CIAEgAyACEYCAgIAAAAwBCyACRQ0CCyABIAAgAhGAgICAAAAMAgsgAxCBgICAAAsgABCBgICAAAtBAAsTAAJAIAANAEEADwsgACgCqNUBC4YCAQJ/QQAhAQJAIAAoAgAiAkUgACgCBEVzDQACQAJAIAJFDQAgACgCCEHA7AUgAhGBgICAAAAhAgwBC0HA7AUQgICAgAAhAgsgAkUNACACQQA2ApzrASACQQA2ApDrASACQQA2AtTrASACQQA2AsTrASACQgA3AqTrASACQQA2ArjpASACQQA2ArzsBSACQgA3A+jrASACQgA3ArzrASACQQA2AqzrASACQgE3ApTrASACQQA2AuzqASACQYGAgMAANgLM6wEgAiAAKQIANwL86gEgAkGE6wFqIABBCGooAgA2AgAgAkEANgK46wEgAkIANwOw6wEgAkEANgLw6gEgAiEBCyABC5kCAQR/AkACQCAARQ0AQUAhASAAKAKQ6wENASAAQYTrAWooAgAhAiAAQYDrAWooAgAhASAAKAKY6wEQqYCAgAAaIABBADYCqOsBIABCADcDmOsBAkAgACgCwOsBIgNFDQACQCABRQ0AIAIgAyABEYCAgIAAAAwBCyADEIGAgIAACyAAQQA2AsDrAQJAIAAoAqzrASIDRQ0AAkACQAJAAkACQCADKAIAIgRFDQAgAUUNAiACIAQgARGAgICAAAAMAQsgAUUNAgsgAiADIAERgICAgAAADAILIAQQgYCAgAALIAMQgYCAgAALIABBADYCrOsBCwJAIAFFDQAgAiAAIAERgICAgAAADAELIAAQgYCAgAALQQAhAQsgAQtnAQF/Qbh/IQMCQEEBQQUgAhsiAiABSw0AIAAgAmpBf2otAAAiA0EDcUECdEGgkICAAGooAgAgAmogA0EEdkEMcUGwkICAAGooAgBqIANBIHEiAkVqIANBwABJIAJBBXZxaiEDCyADC50FAwR/An4BfyOAgICAAEEQayIEJICAgIAAAkACQCABDQBBfyEFIAINAQsCQEEBQQUgAxsiBiACTQ0AAkACQCACRQ0AIANBAUYN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AkAgAUUNACACRQ0AAkACQCACQQdLDQAgACAAKAKs6QEiAzYCuOkBIAAoArDpASEEIAAgATYCsOkBIAAgASAEIANrajYCtOkBIABBrOkBaiEADAELAkAgASgAAEG3yMLhfkYNACAAIAAoAqzpASIDNgK46QEgACgCsOkBIQQgACABNgKw6QEgACABIAQgA2tqNgK06QEgAEGs6QFqIQAMAQsgACABKAAENgKg6wFBYiEDIABBEGogASACELeAgIAAIgRBiH9LDQEgAEKBgICAEDcDiOoBIAAgACgCrOkBIgM2ArjpASAAKAKw6QEhBSAAIAEgBGoiBDYCsOkBIAAgBCAFIANrajYCtOkBIABBrOkBaiEACyAAIAEgAmo2AgBBACEDCyADC9QBAQF/AkAgAEHA6QFqIAEgAiAAKALs6gEQroCAgAAiAUGIf00NACABDwtBuH8hAwJAIAENAAJAIAAoArDrAUEBRw0AIAAoAqzrAUUNACAAELaAgIAACwJAIABB3OkBaigCACIBRQ0AQWAhAyAAKAKg6wEgAUcNAQsCQAJAIABB4OkBaigCAEUNACAAIAAoAvDqASIBRTYC9OoBIAENASAAQZDqAWpCABCWgICAABoMAQsgAEEANgL06gELIAAgACkD8OkBIAKtfDcD8OkBQQAhAwsgAwtOAAJAAkACQCAAKAKo6wFBAWoOAwIAAQALIAAoApjrARCpgICAABogAEEANgKo6wEgAEIANwOY6wFBAA8LIABBADYCqOsBCyAAKAKc6wELcgECfyOAgICAAEEQayIEJICAgIAAIARBCGpBADYCACAEQgA3AwACQAJAIAQQq4CAgAAiBQ0AQUAhAwwBCyAFIAAgASACIANBAEEAIAUQtICAgAAQsICAgAAhAyAFEKyAgIAAGgsgBEEQaiSAgICAACADC98BAQd/I4CAgIAAQRBrIgEkgICAgAACQCAAKAKc6wFFDQAgACgCrOsBIQIgASAAQdzpAWooAgAiAzYCDCACKAIEQX9qIgQgAUEMakEEQgAQlICAgACncSEFAkADQCACKAIAIAUiBkECdGooAgAQqoCAgAAiByADRg0BIAYgBHFBAWohBSAHDQALCyACKAIAIAZBAnRqKAIAIgVFDQAgACgCmOsBEKmAgIAAGiAAQQA2ApjrASAAQX82AqjrASAAIAU2Apzr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NgKMAgJAIAIgByAXa00NACACIAcgFmtLDQoCQCAVIAQgF2siBGoiECALaiAVSw0AIAcgECAL/AoAAAwCCyAHIBBBACAEa/wKAAAgBCALaiELIAcgBGshByAXIQQLAkAgAkEQSQ0AIAQpAAAhLCAHQQhqIARBCGopAAA3AAAgByAsNwAAIAtBEUgNASAHIAtqIQsgBEEgaiECIAdBEGohBANAIAJBcGoiBykAACEsIARBCGogB0EIaikAADcAACAEICw3AAAgAikAACEsIARBGGogAkEIaikAADcAACAEICw3ABAgAkEgaiECIARBIGoiBCALSQ0ADAILCwJAAkAgAkEHSw0AIAcgBC0AADoAACAHIAQtAAE6AAEgByAELQACOgACIAcgBC0AAzoAAyAHIAQgAkECdCICQYChgIAAaigCAGoiBCgAADYABCAEIAJBoKGAgABqKAIAayEEDAELIAcgBCkAADcAAAsgC0EJSQ0AIAcgC2ohDwJAIAdBCGoiAiAEQQhqIhBrQQ9KDQADQCACIBApAAA3AAAgEEEIaiEQIAJBCGoiAiAPSQ0ADAILCyAQKQAAISwgAkEIaiAQQQhqKQAANwAAIAIgLDcAACALQRlIDQAgBEEoaiECIAdBGGohBANAIAJBcGoiBykAACEsIARBCGogB0EIaikAADcAACAEICw3AAAgAikAACEsIARBGGogAkEIaikAADcAACAEICw3ABAgAkEgaiECIARBIGoiBCAPSQ0ACwsCQCAJQYh/TQ0AIAkhCAwJCyAKIAw2AgggCiASNgIEIAogAzYCACAFIAlqIQUgAyAZaiEEICAhFAwDCyALQWBqIQcCQAJAIAsgFEsNACAFIAooAgQiECAEaiIJaiAHSw0AIBMgBWsgCUEgak8NAQsgBkHIAGpBCGogCkEIaigCADYCACAGIAopAgA3A0ggBSATIAcgBkHIAGogBkGMAmogFCAXIBYgFRDFgICAACEJDAILIAUgBGohByAKKAIIIQogAikAACEsIAVBCGogAkEIaikAADcAACAFICw3AAACQCAEQRFJDQAgAikAECEsIAVBGGogAkEYaikAADcAACAFICw3ABAgBEFwakERSA0AIAJBMGohAiAFQSBqIQQDQCACQXBqIg8pAAAhLCAEQQhqIA9BCGopAAA3AAAgBCAsNwAAIAIpAAAh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IAcgC2siByATIAVrSw0IIAUgCyAHEMOAgIAAIAQgAiAHayICNgIAIAUgB2ohBQsgAEEANgKE7AEgBCgCCCEHIAYgCTYCjAICQAJAAkAgAkGAgARKDQAgBSAEKAIEIgsgAmoiEWogCksNACATIAVrIBFBIGpPDQELIAZBCGpBCGogBEEIaigCADYCACAGIAQpAgA3AwggBSATIAZBCGogBkGMAmogECAXIBYgFRDEgICAACERDAELIAUgAmohBCAJIAJqIRIgCSkAACEsIAVBCGogCUEIaikAADcAACAFICw3AAACQCACQRFJDQAgDykAACEsIAVBGGogD0EIaikAADcAACAFICw3ABAgAkFwakERSA0AIAVBIGohAiAaIQwDQCAMQXBqIhkpAAAhLCACQQhqIBlBCGopAAA3AAAgAiAsNwAAIAwpAAAhLCACQRhqIAxBCGopAAA3AAAgAiAsNwAQIAxBIGohDCACQSBqIgIgBEkNAAsLIAQgB2shAiAGIBI2AowCAkAgByAEIBdrTQ0AIAcgBCAWa0sNCgJAIBUgAiAXayICaiISIAtqIBVLDQAgBCASIAv8CgAADAILIAQgEkEAIAJr/AoAACACIAtqIQsgBCACayEEIBchAgsCQCAHQRBJDQAgAikAACEsIARBCGogAkEIaikAADcAACAEICw3AAAgC0ERSA0BIAQgC2ohCyACQSBqIQIgBEEQaiEEA0AgAkFwaiIHKQAAISwgBEEIaiAHQQhqKQAANwAAIAQgLDcAACACKQAAISwgBEEYaiACQQhqKQAANwAAIAQgLDcAECACQSBqIQIgBEEgaiIEIAtJDQAMAgsLAkACQCAHQQdLDQAgBCACLQAAOgAAIAQgAi0AAToAASAEIAItAAI6AAIgBCACLQADOgADIAQgAiAHQQJ0IgdBgKGAgABqKAIAaiICKAAANgAEIAIgB0GgoYCAAGooAgBrIQIMAQsgBCACKQAANwAACyALQQlJDQAgBCALaiEMAkAgBEEIaiIHIAJBCGoiEmtBD0oNAANAIAcgEikAADcAACASQQhqIRIgB0EIaiIHIAxJDQAMAgsLIBIpAAAhLCAHQQhqIBJBCGopAAA3AAAgByAsNwAAIAtBGUgNACACQShqIQIgBEEYaiEEA0AgAkFwaiIHKQAAISwgBEEIaiAHQQhqKQAANwAAIAQgLDcAACACKQAAISwgBEEYaiACQQhqKQAANwAAIAQgLDcAECACQSBqIQIgBEEgaiIEIAxJDQALCwJAIBFBiX9JDQAgESEIDAkLIAUgEWohBSAQIRQMAwsgEkFgaiEHAkACQCASIBRLDQAgBSAEKAIEIgwgAmoiEWogB0sNACATIAVrIBFBIGpPDQELIAZBGGpBCGogBEEIaigCADYCACAGIAQpAgA3AxggBSATIAcgBkEYaiAGQYwCaiAUIBcgFiAVEMWAgIAAIREMAgsgBSACaiEHIAQoAgghBCALKQAAISwgBUEIaiALQQhqKQAANwAAIAUgLDcAAAJAIAJBEUkNACALKQAQISwgBUEYaiALQRhqKQAANwAAIAUgLDcAECACQXBqQRFIDQAgC0EwaiELIAVBIGohAgNAIAtBcGoiGSkAACEsIAJBCGogGUEIaikAADcAACACICw3AAAgCykAACEsIAJBGGogC0EIaikAADcAACACICw3ABAgC0EgaiELIAJBIGoiAiAHSQ0ACwsgByAEayECIAYgEjYCjAICQCAEIAcgF2tNDQAgBCAHIBZrSw0IAkAgFSACIBdrIgJqIgsgDGogFUsNACAHIAsgDPwKAAAMAwsgByALQQAgAmv8CgAAIAIgDGohDCAHIAJrIQcgFyECCwJAIARBEEkNACACKQAAISwgB0EIaiACQQhqKQAANwAAIAcgLDcAACAMQRFIDQIgByAMaiELIAJBIGohAiAHQRBqIQQDQCACQXBqIgcpAAAhLCAEQQhqIAdBCGopAAA3AAAgBCAsNwAAIAIpAAAhLCAEQRhqIAJBCGopAAA3AAAgBCAsNwAQIAJBIGohAiAEQSBqIgQgC0kNAAwDCwsCQAJAIARBB0sNACAHIAItAAA6AAAgByACLQABOgABIAcgAi0AAjoAAiAHIAItAAM6AAMgByACIARBAnQiBEGAoYCAAGooAgBqIgIoAAA2AAQgAiAEQaChgIAAaigCAGshAgwBCyAHIAIpAAA3AAALIAxBCUkNASAHIAxqIRICQCAHQQhqIgQgAkEIaiILa0EPSg0AA0AgBCALKQAANwAAIAtBCGohCyAEQQhqIgQgEkkNAAwDCwsgCykAACEsIARBCGogC0EIaikAADcAACAEICw3AAAgDEEZSA0BIAJBKGohAiAHQRhqIQQDQCACQXBqIgcpAAAhLCAEQQhqIAdBCGopAAA3AAAgBCAsNwAAIAIpAAAhLCAEQRhqIAJBCGopAAA3AAAgBCAsNwAQIAJBIGohAiAEQSBqIgQgEkkNAAwCCwsCQAJAIAYoAowCIhIgBCgCACICaiIMIBRLDQAgBSAEKAIEIgsgAmoiEWogCksNACATIAVrIBFBIGpPDQELIAZBKGpBCGogBEEIaigCADYCACAGIAQpAgA3AyggBSATIAZBKGogBkGMAmogFCAXIBYgFRDEgICAACERDAELIAUgAmohByAEKAIIIQQgEikAACEsIAVBCGogEkEIaikAADcAACAFICw3AAACQCACQRFJDQAgEikAECEsIAVBGGogEkEYaikAADcAACAFICw3ABAgAkFwakERSA0AIBJBMGohEiAFQSBqIQIDQCASQXBqIhkpAAAhLCACQQhqIBlBCGopAAA3AAAgAiAsNwAAIBIpAAAhLCACQRhqIBJBCGopAAA3AAAgAiAsNwAQIBJBIGohEiACQSBqIgIgB0kNAAsLIAcgBGshAiAGIAw2AowCAkAgBCAHIBdrTQ0AIAQgByAWa0sNBwJAIBUgAiAXayICaiISIAtqIBVLDQAgByASIAv8CgAADAILIAcgEkEAIAJr/AoAACACIAtqIQsgByACayEHIBchAgsCQCAEQRBJDQAgAikAACEsIAdBCGogAkEIaikAADcAACAHICw3AAAgC0ERSA0BIAcgC2ohCyACQSBqIQIgB0EQaiEEA0AgAkFwaiIHKQAAISwgBEEIaiAHQQhqKQAANwAAIAQgLDcAACACKQAAISwgBEEYaiACQQhqKQAANwAAIAQgLDcAECACQSBqIQIgBEEgaiIEIAtJDQAMAgsLAkACQCAEQQdLDQAgByACLQAAOgAAIAcgAi0AAToAASAHIAItAAI6AAIgByACLQADOgADIAcgAiAEQQJ0IgRBgKGAgABqKAIAaiICKAAANgAEIAIgBEGgoYCAAGooAgBrIQIMAQsgByACKQAANwAACyALQQlJDQAgByALaiEMAkAgB0EIaiIEIAJBCGoiEmtBD0oNAANAIAQgEikAADcAACASQQhqIRIgBEEIaiIEIAxJDQAMAgsLIBIpAAAhLCAEQQhqIBJBCGopAAA3AAAgBCAsNwAAIAtBGUgNACACQShqIQIgB0EYaiEE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KAKA7AEiAk0NASAFQQFIDQYMAgsgBygCbCIaIARqIhAgACgCgOwBIgJLDQELIBBBYGohAiAHIAQ2AnAgByADNgJ0IAcgCDYCeAJAAkACQCAQIApLDQAgCyAEIANqIhFqIAJLDQAgCSALayARQSBqTw0BCyAHQShqQQhqIAdB8ABqQQhqKAIANgIAIAcgBykDcDcDKCALIAkgAiAHQShqIAdB7ABqIAogDiANIAwQxYCAgAAhEQwBCyALIARqIQIgGikAACEbIAtBCGogGkEIaikAADcAACALIBs3AAACQCAEQRFJDQAgGikAECEbIAtBGGogGkEYaikAADcAACALIBs3ABAgBEFwakERSA0AIBpBMGohGiALQSBqIQQDQCAaQXBqIhIpAAAhGyAEQQhqIBJBCGopAAA3AAAgBCAbNwAAIBopAAAhGyAEQRhqIBpBCGopAAA3AAAgBCAbNwAQIBpBIGohGiAEQSBqIgQgAkkNAAsLIAIgCGshBCAHIBA2AmwCQCAIIAIgDmtNDQAgCCACIA1rSw0GAkAgDCAEIA5rIgRqIhAgA2ogDEsNACACIBAgA/wKAAAMAgsgAiAQQQAgBGv8CgAAIAcgBCADaiIDNgJ0IAIgBGshAiAOIQQLAkAgCEEQSQ0AIAQpAAAhGyACQQhqIARBCGopAAA3AAAgAiAbNwAAIANBEUgNASACIANqIQggBEEgaiEEIAJBEGohAgNAIARBcGoiAykAACEbIAJBCGogA0EIaikAADcAACACIBs3AAAgBCkAACEbIAJBGGogBEEIaikAADcAACACIBs3ABAgBEEgaiEEIAJBIGoiAiAISQ0ADAILCwJAAkAgCEEHSw0AIAIgBC0AADoAACACIAQtAAE6AAEgAiAELQACOgACIAIgBC0AAzoAAyACIAQgCEECdCIDQYChgIAAaigCAGoiBCgAADYABCAEIANBoKGAgABqKAIAayEEIAcoAnQhAwwBCyACIAQpAAA3AAALIANBCUkNACACIANqIRoCQCACQQhqIgggBEEIaiIQa0EPSg0AA0AgCCAQKQAANwAAIBBBCGohECAIQQhqIgggGkkNAAwCCwsgECkAACEbIAhBCGogEEEIaikAADcAACAIIBs3AAAgA0EZSA0AIARBKGohBCACQRhqIQIDQCAEQXBqIgMpAAAhGyACQQhqIANB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aiAIQQhqKQAANwAAIAMgGzcAACAFQRlIDQAgBEEoaiEEIAJBGGohAgNAIARBcGoiAykAACEbIAJBCGogA0EIaikAADcAACACIBs3AAAgBCkAACEbIAJBGGogBEEIaikAADcAACACIBs3ABAgBEEgaiEEIAJBIGoiAiAQSQ0ACwsgEUGIf0sNBCALIBFqIQsgGkF/aiIaDQALCyAHKAI8IAcoAkBHDQFBbCERIAcoAjhBIEcNAiAAQazQAWohBEEAIQIDQCAEIAJqIAdBNGogAmpBLGooAgA2AgAgAkEEaiICQQxHDQALIAcoAmwhCAsCQAJAIAAoAoTsAUECRg0AIAshAgwBC0G6fyERIAogCGsiBCAJIAtrSw0CQQAhAgJAIAtFDQAgCyAIIAT8CgAAIAsgBGohAgsgAEEANgKE7AEgAEGI7AVqIQogAEGI7AFqIQgLQbp/IREgCiAIayIEIAkgAmtLDQECQAJAIAINAEEAIQIMAQsgAiAIIAT8CgAAIAIgBGohAgsgAiABayERDAELQWwhEQsgB0GAAWokgICAgAAgEQutGQIWfwF+I4CAgIAAQeAAayIHJICAgIAAAkACQCAAKAKE7AENACABIAJBACACQQBKG2ohCAwBCyAAKAL86wEhCAsgByAAKAL46gEiAjYCTCACIAAoAojrAWohCQJAAkACQCAFDQAgASEKDAELIAAoArjpASELIAAoArTpASEMIAAoArDpASENIABBATYCjOoBQazQASECA0AgB0EUaiACakGAsH5qIAAgAmooAgA2AgAgAkEEaiICQbjQAUcNAAtBbCEOIARFDQEgByADNgIgIAcgA0EEajYCJAJAAkAgBEEESQ0AIAcgAyAEakF8aiICNgIcIAcgAigAACICNgIUIAJBgICACEkNAyAHQQggAkEYdmdBH3NrNgIYIARBiH9NDQEMAwsgByADNgIcIAcgAy0AACICNgIUAkACQAJAIARBfmoOAgEAAgsgAy0AAkEQdCACciECCyAHIAMtAAFBCHQgAmo2AhQLIAMgBGpBf2otAAAiAkUNAiAHIAJnIARBA3RrQQlqNgIYCyAHQRRqQRRqIAdBFGogACgCABDAgICAACAHQTBqIAdBFGogACgCCBDAgICAACAHQThqIAdBFGogACgCBBDAgICAACAIQWBqIQ8gB0EUakEsaiEQ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6QEgACgCsOkBIQMgACABNgKw6QEgACABIAMgAmtqNgK06QELC7kFAgJ/AX4gACADaiEFAkACQCADQQdKDQAgA0EBSA0BA0AgACACLQAAOgAAIAJBAWohAiAAQQFqIgAgBUkNAAwCCwsCQCAEQQFHDQACQAJAIAAgAmsiBkEHSw0AIAAgAi0AADoAACAAIAItAAE6AAEgACACLQACOgACIAAgAi0AAzoAAyAAIAIgBkECdCIGQYChgIAAaigCAGoiAigAADYABCACIAZBoKGAgABqKAIAayECDAELIAAgAikAADcAAAsgA0F4aiEDIABBCGohACACQQhqIQILAkAgBSABSw0AIAAgA2ohBQJAIARBAUcNACAAIAJrQQ9KDQADQCAAIAIpAAA3AAAgAkEIaiECIABBCGoiACAFSQ0ADAMLCyACKQAAIQcgAEEIaiACQQhqKQAANwAAIAAgBzcAACADQRFJDQEgAkEgaiEBIABBEGohAgNAIAFBcGoiACkAACEHIAJBCGogAEEIaikAADcAACACIAc3AAAgASkAACEHIAJBGGogAUEIaikAADcAACACIAc3ABAgAUEgaiEBIAJBIGoiAiAFSQ0ADAILCwJAAkAgACABTQ0AIAAhAQwBCyABIABrIQYCQAJAIARBAUcNACAAIAJrQQ9KDQAgAiEDA0AgACADKQAANwAAIANBCGohAyAAQQhqIgAgAUkNAAwCCwsgAikAACEHIABBCGogAkEIaikAADcAACAAIAc3AAAgBkERSA0AIAJBIGohAyAAQRBqIQADQCADQXBqIgQpAAAhByAAQQhqIARBCGopAAA3AAAgACAHNwAAIAMpAAAhByAAQRhqIANBCGopAAA3AAAgACAHNwAQIANBIGohAyAAQSBqIgAgAUkNAAsLIAIgBmohAgsgASAFTw0AA0AgASACLQAAOgAAIAJBAWohAiABQQFqIgEgBUkNAAsLCwvIGQEAQYAIC8AZAAAAAAEAAAADAAAABwAAAA8AAAAfAAAAPwAAAH8AAAD/AAAA/wEAAP8DAAD/BwAA/w8AAP8fAAD/PwAA/38AAP//AAD//wEA//8DAP//BwD//w8A//8fAP//PwD//38A////AP///wH///8D////B////w////8f////P////38AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAQAAAAEAAACWAAAA2AAAAH0BAAB3AAAAqgAAAM0AAAACAgAAcAAAALEAAADHAAAAGwIAAG4AAADFAAAAwgAAAIQCAABrAAAA3QAAAMAAAADfAgAAawAAAAABAAC9AAAAcQMAAGoAAABnAQAAvAAAAI8EAABtAAAARgIAALsAAAAiBgAAcgAAALACAAC7AAAAsAYAAHoAAAA5AwAAugAAAK0HAACIAAAA0AMAALkAAABTCAAAlgAAAJwEAAC6AAAAFggAAK8AAABhBQAAuQAAAMMGAADKAAAAhAUAALkAAACfBgAAygAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAEAAAAFAAAADQAAAB0AAAA9AAAAfQAAAP0AAAD9AQAA/QMAAP0HAAD9DwAA/R8AAP0/AAD9fwAA/f8AAP3/AQD9/wMA/f8HAP3/DwD9/x8A/f8/AP3/fwD9//8A/f//Af3//wP9//8H/f//D/3//x/9//8//f//fwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fAwAAAAQAAAAFAAAABgAAAAcAAAAIAAAACQAAAAoAAAALAAAADAAAAA0AAAAOAAAADwAAABAAAAARAAAAEgAAABMAAAAUAAAAFQAAABYAAAAXAAAAGAAAABkAAAAaAAAAGwAAABwAAAAdAAAAHgAAAB8AAAAgAAAAIQAAACIAAAAjAAAAJQAAACcAAAApAAAAKwAAAC8AAAAzAAAAOwAAAEMAAABTAAAAYwAAAIMAAAADAQAAAwIAAAMEAAADCAAAAxAAAAMgAAADQAAAA4AAAAMAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAQECAgMDBAQFBwgJCgsMDQ4PEAAAAAAAAAAAAAAAAAAAAAEAAAACAAAAAwAAAAQAAAAFAAAABgAAAAcAAAAIAAAACQAAAAoAAAALAAAADAAAAA0AAAAOAAAADwAAABAAAAASAAAAFAAAABYAAAAYAAAAHAAAACAAAAAoAAAAMAAAAEAAAACAAAAAAAEAAAACAAAABAAAAAgAAAAQAAAAIAAAAEAAAACAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAEBAQECAgMDBAYHCAkKCwwNDg8QAQAAAAQAAAAIAAAAAAAAAAEAAAACAAAABAAAAAAAAAACAAAABAAAAAgAAAAAAAAAAQAAAAIAAAADAAAABAAAAAUAAAAGAAAABwAAAAgAAAAJAAAACgAAAAsAAAAMAAAADQAAAA4AAAAPAAAAEAAAABIAAAAUAAAAFgAAABgAAAAcAAAAIAAAACgAAAAwAAAAQAAAAIAAAAAAAQAAAAIAAAAEAAAACAAAABAAAAAgAAAAQAAAAIAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAQEBAQICAwMEBgcICQoLDA0ODxAAAAAAAAAAAAAAAAABAAEBBgAAAAAAAAQAAAAAEAAABAAAAAAgAAAFAQAAAAAAAAUDAAAAAAAABQQAAAAAAAAFBgAAAAAAAAUHAAAAAAAABQkAAAAAAAAFCgAAAAAAAAUMAAAAAAAABg4AAAAAAAEFEAAAAAAAAQUUAAAAAAABBRYAAAAAAAIFHAAAAAAAAwUgAAAAAAAEBTAAAAAgAAYFQAAAAAAABwWAAAAAAAAIBgABAAAAAAoGAAQAAAAADAYAEAAAIAAABAAAAAAAAAAEAQAAAAAAAAUCAAAAIAAABQQAAAAAAAAFBQAAACAAAAUHAAAAAAAABQgAAAAgAAAFCgAAAAAAAAULAAAAAAAABg0AAAAgAAEFEAAAAAAAAQUSAAAAIAABBRYAAAAAAAIFGAAAACAAAwUgAAAAAAADBSgAAAAAAAYEQAAAABAABgRAAAAAIAAHBYAAAAAAAAkGAAIAAAAACwYACAAAMAAABAAAAAAQAAAEAQAAACAAAAUCAAAAIAAABQMAAAAgAAAFBQAAACAAAAUGAAAAIAAABQgAAAAgAAAFCQAAACAAAAULAAAAIAAABQwAAAAAAAAGDwAAACAAAQUSAAAAIAABBRQAAAAgAAIFGAAAACAAAgUcAAAAIAADBSgAAAAgAAQFMAAAAAAAEAYAAAEAAAAPBgCAAAAAAA4GAEAAAAAADQYAIAAAAAAAAAAAAAAAAAAAAQAAAAEAAAAFAAAADQAAAB0AAAA9AAAAfQAAAP0AAAD9AQAA/QMAAP0HAAD9DwAA/R8AAP0/AAD9fwAA/f8AAP3/AQD9/wMA/f8HAP3/DwD9/x8A/f8/AP3/fwD9//8A/f//Af3//wP9//8H/f//D/3//x/9//8//f//fwABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fAQABAQUAAAAAAAAFAAAAAAAABgQ9AAAAAAAJBf0BAAAAAA8F/X8AAAAAFQX9/x8AAAADBQUAAAAAAAcEfQAAAAAADAX9DwAAAAASBf3/AwAAABcF/f9/AAAABQUdAAAAAAAIBP0AAAAAAA4F/T8AAAAAFAX9/w8AAAACBQEAAAAQAAcEfQAAAAAACwX9BwAAAAARBf3/AQAAABYF/f8/AAAABAUNAAAAEAAIBP0AAAAAAA0F/R8AAAAAEwX9/wcAAAABBQEAAAAQAAYEPQAAAAAACgX9AwAAAAAQBf3/AAAAABwF/f//DwAAGwX9//8HAAAaBf3//wMAABkF/f//AQAAGAX9//8AAAAAAAAAAAADAAAABAAAAAUAAAAGAAAABwAAAAgAAAAJAAAACgAAAAsAAAAMAAAADQAAAA4AAAAPAAAAEAAAABEAAAASAAAAEwAAABQAAAAVAAAAFgAAABcAAAAYAAAAGQAAABoAAAAbAAAAHAAAAB0AAAAeAAAAHwAAACAAAAAhAAAAIgAAACMAAAAlAAAAJwAAACkAAAArAAAALwAAADMAAAA7AAAAQwAAAFMAAABjAAAAgwAAAAMBAAADAgAAAwQAAAMIAAADEAAAAyAAAANAAAADgAAAAwABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEBAQICAwMEBAUHCAkKCwwNDg8QAAAAAAAAAAAAAAABAAEBBgAAAAAAAAYDAAAAAAAABAQAAAAgAAAFBQAAAAAAAAUGAAAAAAAABQgAAAAAAAAFCQAAAAAAAAULAAAAAAAABg0AAAAAAAAGEAAAAAAAAAYTAAAAAAAABhYAAAAAAAAGGQAAAAAAAAYcAAAAAAAABh8AAAAAAAAGIgAAAAAAAQYlAAAAAAABBikAAAAAAAIGLwAAAAAAAwY7AAAAAAAEBlMAAAAAAAcGgwAAAAAACQYDAgAAEAAABAQAAAAAAAAEBQAAACAAAAUGAAAAAAAABQcAAAAgAAAFCQAAAAAAAAUKAAAAAAAABgwAAAAAAAAGDwAAAAAAAAYSAAAAAAAABhUAAAAAAAAGGAAAAAAAAAYbAAAAAAAABh4AAAAAAAAGIQAAAAAAAQYjAAAAAAABBicAAAAAAAIGKwAAAAAAAwYzAAAAAAAEBkMAAAAAAAUGYwAAAAAACAYDAQAAIAAABAQAAAAwAAAEBAAAABAAAAQFAAAAIAAABQcAAAAgAAAFCAAAACAAAAUKAAAAIAAABQsAAAAAAAAGDgAAAAAAAAYRAAAAAAAABhQAAAAAAAAGFwAAAAAAAAYaAAAAAAAABh0AAAAAAAAGIAAAAAAAEAYDAAEAAAAPBgOAAAAAAA4GA0AAAAAADQYDIAAAAAAMBgMQAAAAAAsGAwgAAAAACgYDBAAAAAAAAAAAAAAAAAAAAQAAAAMAAAAHAAAADwAAAB8AAAA/AAAAfwAAAP8AAAD/AQAA/wMAAP8HAAD/DwAA/x8AAP8/AAD/fwAA//8AAP//AQD//wMA//8HAP//DwD//x8A//8/AP//fwD///8A////Af///wP///8H////D////x////8/////fwAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAIAAAABAAAABAAAAAQAAAAEAAAABAAAAAgAAAAIAAAACAAAAAcAAAAIAAAACQAAAAoAAAALAAAA';
function pqInit() { if (ZX) return; const u = Uint8Array.from(atob(ZD64), (c) => c.charCodeAt(0)); ZX = new WebAssembly.Instance(new WebAssembly.Module(u), {}).exports; }
const pqInfl = (s, n) => { if (s.length > zic) { if (zip_) ZX.free(zip_); zic = Math.max(s.length, 65536); zip_ = ZX.malloc(zic); } if (n > zoc) { if (zop) ZX.free(zop); zoc = Math.max(n, 65536); zop = ZX.malloc(zoc); } new Uint8Array(ZX.memory.buffer, zip_, s.length).set(s); const r = ZX.decompress(zop, n, zip_, s.length); if (ZX.is_error(r) || r !== n) throw new Error('This Parquet file has a damaged zstd page.'); return new Uint8Array(ZX.memory.buffer, zop, n); };
const pad2 = (x) => (x < 10 ? '0' : '') + x;
function civil(z) { z += 719468; const era = Math.floor(z / 146097), doe = z - era * 146097, yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365), y = yoe + era * 400, doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, mo = mp < 10 ? mp + 3 : mp - 9; return [mo <= 2 ? y + 1 : y, mo, d]; }
// Dates and timestamps become the text the CSV path stores (YYYY-MM-DD, or YYYY-MM-DD HH:MM:SS with a fraction when the row group has one), so lfc-pack types them like any date column.
function pqDateText(a, kind, unit) {
  const n = a.length, per = kind === 'date' ? 0 : unit === 'ms' ? 1e3 : unit === 'us' ? 1e6 : 1e9, digs = per === 1e3 ? 3 : per === 1e6 ? 6 : 9;
  let frac = false; if (per) for (let i = 0; i < n; i++) { const v = a[i]; if (v === v && ((v % per) + per) % per !== 0) { frac = true; break; } }
  const w = kind === 'date' ? 10 : 19 + (frac ? 1 + digs : 0), bytes = new Uint8Array(n * w), start = new Int32Array(n), end = new Int32Array(n); let o = 0;
  const put = (s) => { for (let i = 0; i < s.length; i++) bytes[o++] = s.charCodeAt(i); };
  for (let i = 0; i < n; i++) {
    start[i] = o; const v = a[i]; if (v !== v) { end[i] = o; continue; }
    const secs = kind === 'date' ? v * 86400 : Math.floor(v / per), days = Math.floor(secs / 86400), sod = secs - days * 86400, c = civil(days);
    put(String(c[0]).padStart(4, '0') + '-' + pad2(c[1]) + '-' + pad2(c[2]));
    if (kind !== 'date') { put(' ' + pad2(Math.floor(sod / 3600)) + ':' + pad2(Math.floor(sod / 60) % 60) + ':' + pad2(sod % 60)); if (frac) put('.' + String(((v % per) + per) % per).padStart(digs, '0')); }
    end[i] = o;
  }
  return { bytes: bytes.subarray(0, o), start, end };
}
function pqNumText(a) {   // doubles have no fixed-decimal form: they are stored as the text a CSV would hold (the column still reads as a number)
  const n = a.length, parts = new Array(n); let tot = 0; for (let i = 0; i < n; i++) { const v = a[i]; const sx = v !== v ? '' : String(v); parts[i] = sx; tot += sx.length; }
  const bytes = new Uint8Array(tot), start = new Int32Array(n), end = new Int32Array(n); let o = 0;
  for (let i = 0; i < n; i++) { start[i] = o; const sx = parts[i]; for (let j = 0; j < sx.length; j++) bytes[o++] = sx.charCodeAt(j); end[i] = o; }
  return { bytes, start, end };
}
async function pqGroupJob(m) {
  try {
    pqInit(); await LfcPack.init(); const g = m.group, out = [], dec = new TextDecoder();
    for (let i = 0; i < g.chunks.length; i++) {
      const ch = g.chunks[i], b = new Uint8Array(await m.file.slice(ch.start, ch.start + ch.comp).arrayBuffer()), col = m.cols[i];
      let c = PQ.decodeChunk(col, ch, b, pqInfl); if (c instanceof Float64Array && (col.kind === 'date' || col.kind === 'timestamp')) c = pqDateText(c, col.kind, col.unit); out.push(c);
    }
    const len = (c) => c instanceof Float64Array ? c.length : c.codes ? c.codes.length : c.start.length, n = out.length ? len(out[0]) : 0;
    let sample = null;
    if (m.first) { sample = []; const rowsN = Math.min(20, n); for (let r = 0; r < rowsN; r++) { const rec = {}; m.cols.forEach((col, i) => { const c = out[i]; let v; if (c instanceof Float64Array) { v = c[r]; v = v !== v ? null : col.kind === 'decimal' && col.scale ? v / Math.pow(10, col.scale) : v; } else if (c.codes) { const q = c.codes[r]; v = dec.decode(c.lb.bytes.subarray(c.lb.start[q], c.lb.end[q])); } else v = dec.decode(c.bytes.subarray(c.start[r], c.end[r])); rec[col.name] = v === '' ? null : v; }); sample.push(rec); } }
    if (m.chunk) {   // staged columns: hand back a chunk in the shape the CSV builder makes, so the live grid and the pack workers take it as they take a CSV piece
      const cols = out.map((c, i) => { const k = m.cols[i].kind; if (c instanceof Float64Array) { if (k === 'int' || k === 'decimal') return c; return pqNumText(c); } if (c.codes) { const q = c.lb.n; return { codes: c.codes, lb: { bytes: c.lb.bytes, start: c.lb.start.slice(0, q), end: c.lb.end.slice(0, q) } }; } return c; });
      let est = 0; for (const c of cols) est += c instanceof Float64Array ? n * 8 : c.codes ? n : c.bytes.length + n;
      const chunk = { n, bytes: est, cols }, chunk2 = m.dup ? dupChunk(chunk) : null, tr = [].concat(chunkBuffers(chunk), chunk2 ? chunkBuffers(chunk2) : []);
      self.postMessage({ type: 'pqdone', rid: m.rid, chunk, chunk2, rows: n, sample }, tr); return;
    }
    const named = {}; out.forEach((c, i) => { named[m.cols[i].name] = c instanceof Float64Array ? c : c.codes ? { kind: 'dict', labels: { bytes: c.lb.bytes, start: Uint32Array.from(c.lb.start.subarray(0, c.lb.n)), end: Uint32Array.from(c.lb.end.subarray(0, c.lb.n)) }, ids: c.codes } : c; });
    const r = await LfcPack.packBlock(named, { level: m.level || 3, blockBytes: 2097152, share: false });
    self.postMessage({ type: 'pqdone', rid: m.rid, r, rows: n, sample }, [r.buffer]);
  } catch (err) { self.postMessage({ type: 'pqdone', rid: m.rid, error: String(err && err.message || err) }); }
}
async function parseParquet(file, job, progress, t, write, packer, col, setPlan) {
  const t0 = performance.now(); let tailN = Math.min(file.size, 1048576), tail = new Uint8Array(await file.slice(file.size - tailN).arrayBuffer());
  const fl = new DataView(tail.buffer, tail.byteLength - 8, 4).getUint32(0, true); if (fl + 8 > tailN && fl + 8 <= file.size) tail = new Uint8Array(await file.slice(file.size - fl - 8).arrayBuffer());
  const ft = PQ.readFooter(tail), cols = ft.cols, groups = ft.groups;
  if (!cols.length || !groups.length) throw new Error('This Parquet file has no rows.');
  const KIND = { int: 'integer', decimal: 'number', double: 'number', bool: 'boolean', text: 'string', date: 'date', timestamp: 'date' };
  const headers = cols.map((c) => c.name), types = cols.map((c) => ({ type: KIND[c.kind] || 'string', nullable: true }));
  const plan = cols.map((c) => c.kind === 'int' ? true : c.kind === 'decimal' ? (c.scale > 0 ? c.scale : true) : false);
  if (col && cols.some((c) => c.kind === 'double')) col = null;   // doubles have no fixed-decimal form, so the staged path would store them as text (bigger file, slower): take the direct pack path
  setPlan(plan); if (col) { await col.begin(headers); t.cols = true; }
  const hw = (self.navigator && navigator.hardwareConcurrency) || 4, nw = Math.max(1, Math.min(4, hw - 1, groups.length)), helpers = [], pending = new Map(); let rid = 0;
  const closeAll = () => helpers.forEach((h) => h.terminate());
  const failAll = (err) => { for (const p of pending.values()) p.rej(err); pending.clear(); };
  try { for (let i = 0; i < nw; i++) helpers.push(mkWorker()); } catch { closeAll(); throw new Error('Parquet files need worker threads, and this page cannot start them.'); }
  for (const h of helpers) { h.onmessage = (e) => { const d = e.data || {}; if (d.type === 'pqdone') { const p = pending.get(d.rid); if (p) { pending.delete(d.rid); if (d.error) p.rej(new Error(d.error)); else p.res(d); } } }; h.onerror = (e) => failAll(new Error('A Parquet helper failed: ' + (e && e.message || 'unknown error'))); }
  job.abort = () => { closeAll(); failAll(Object.assign(new Error('Import cancelled.'), { cancelled: true })); };
  const rpc = (h, msg) => new Promise((res, rej) => { const id = ++rid; pending.set(id, { res, rej }); h.postMessage(Object.assign({ type: 'pqGroup', rid: id }, msg)); });
  let rows = 0, sample = [], next = 0, nextW = 0; const done = new Map(), waiters = new Set(); const signal = () => { for (const w of [...waiters]) { waiters.delete(w); w(); } }, wait = () => new Promise((r) => waiters.add(r));
  const WINDOW = nw * 2; let quit = false, bytes = 0;
  const run = async (h) => { while (!quit && next < groups.length) { if (next >= nextW + WINDOW) { await wait(); continue; } const k = next++; done.set(k, await rpc(h, { file, cols, group: groups[k], first: k === 0, level: 3, chunk: !!col, dup: !!(col && col.dup) }).catch((err) => ({ error: err }))); signal(); } };
  try {
    const loops = helpers.map(run);
    for (let k = 0; k < groups.length; k++) {
      while (!done.has(k)) { stop(job); await wait(); }
      const r = done.get(k); done.delete(k); nextW = k + 1; signal(); stop(job);
      if (r.error) throw r.error;
      if (r.chunk) await col.push(r.chunk, r.chunk2); else await write(packer.pushPacked(r.r)); rows += r.rows; if (r.sample) sample = r.sample; for (const c of groups[k].chunks) bytes += c.comp; progress(Math.min(file.size, bytes), rows);
    }
    quit = true; signal(); await Promise.all(loops);
    t.parseMs = performance.now() - t0; t.readMs = 0;
    return { headers, types, rows, sample, pieces: col ? groups.length : 0, plan };
  } finally { quit = true; closeAll(); }
}
