/* Workbench import worker. Classic worker: loads the pinned LFC-pack build, then the ES-module ingest core. */
'use strict';
importScripts('../vendor/lfcp/0.14.5/lfc-pack.js'); //@@IMPORT_LFC@@

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
  else if (m.type === 'pqPackPart') pqPartJob(m);
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
  if (n === 0 || n > 128 || D > 126 || typeof WebAssembly === 'undefined' || !core.placeColumns || !loadC()) return null;
  const CB = COLB;   // wide files: smaller chunks, so the text areas of 100+ columns stay small
  const B = core.placeColumns(C, headers, plan, delimiter, { capRows: 32768, chunkBytes: CB, dict }); if (dictOn) for (let c = 0; c < n; c++) dictOn[c] = B.isDict(c);
  const flagsP = B.exports.flags_ptr(), cn = new Uint32Array(B.memory.buffer, B.exports.cnt_n_ptr(), 128), ce = new Uint32Array(B.memory.buffer, B.exports.cnt_e_ptr(), 128);
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
      const r = B.build(b.subarray(i, i + Math.min(end - i, CB)));
      if (r.n) { const m = new Uint32Array(B.memory.buffer, B.exports.cnt_n_ptr(), 128), e = new Uint32Array(B.memory.buffer, B.exports.cnt_e_ptr(), 128); for (let c = 0; c < n; c++) { trackers[c].n += m[c]; trackers[c].empty += e[c]; } parser.line += C.nlines(); parser.startLine = parser.line; F.rows += r.n; F.miss = 0; sink({ n: r.n, bytes: r.used, cols: r.arr }); }
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
// One buffer for a whole chunk: a wide file makes chunks of 100+ columns, each with 2 or 3 small arrays; handing 700 small buffers to postMessage costs about 9 microseconds each in Chromium
// (36,000 buffers per 8 MiB piece, 13 s of the helpers' time on a 116-column file), so the arrays of a chunk are copied into one slab and travel as views of it.
const slabChunk = (c) => {
  let tot = 0; const add = (a) => { tot += (a.byteLength + 7) & ~7; };
  for (const x of c.cols) { if (x.codes) { add(x.codes); add(x.lb.bytes); add(x.lb.start); add(x.lb.end); } else if (x.bytes) { add(x.bytes); add(x.start); add(x.end); } else add(x); }
  const slab = new ArrayBuffer(tot); let off = 0;
  const mv = (a) => { const v = new a.constructor(slab, off, a.length); v.set(a); off += (a.byteLength + 7) & ~7; return v; };
  const cols = c.cols.map((x) => (x.codes ? { codes: mv(x.codes), lb: { bytes: mv(x.lb.bytes), start: mv(x.lb.start), end: mv(x.lb.end) } } : x.bytes ? Object.assign({}, x, { bytes: mv(x.bytes), start: mv(x.start), end: mv(x.end) }) : mv(x)));
  return Object.assign({}, c, { cols, slab });
};
const dupChunk = (c) => ({ n: c.n, bytes: c.bytes, cols: c.cols.map((x) => (x.codes ? { codes: x.codes.slice(), lb: { bytes: x.lb.bytes.slice(), start: x.lb.start.slice(), end: x.lb.end.slice() } } : x.bytes ? dupText(x) : x.slice())) });
const chunkBuffers = (c) => { if (c.slab) return [c.slab]; const o = []; for (const x of c.cols) { if (x.codes) o.push(x.codes.buffer, x.lb.bytes.buffer, x.lb.start.buffer, x.lb.end.buffer); else if (x.bytes) { o.push(x.bytes.buffer, x.start.buffer); if (x.end.buffer !== x.start.buffer) o.push(x.end.buffer); } else o.push(x.buffer); } return o; };
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
// A text column whose cells are all "YYYY-MM-DD HH:MM:SS" (or empty) is packed as typed seconds, which LFC-pack stores in fewer bytes and packs faster, and gives back as the same text. Any other cell (wrong shape, impossible date or time) returns null and the column stays text.
function tsFromText(bytes, start, end, n) {   // 'YYYY-MM-DD HH:MM:SS' with no, 3 or 6 fraction digits, the same in every cell; epoch values in s, ms or us (exact in a double), or null
  const out = new Float64Array(n); let lastKey = -1, lastBase = 0, L = 0;
  for (let i = 0; i < n; i++) if (end[i] > start[i]) { L = end[i] - start[i]; break; }
  if (L !== 19 && L !== 23 && L !== 26) return null;
  const fd = L === 19 ? 0 : L - 20, mul = L === 19 ? 1 : L === 23 ? 1000 : 1e6;
  for (let i = 0; i < n; i++) {
    const s = start[i], len = end[i] - s;
    if (len === 0) { out[i] = NaN; continue; }
    if (len !== L || (fd && bytes[s + 19] !== 46) || bytes[s + 4] !== 45 || bytes[s + 7] !== 45 || bytes[s + 10] !== 32 || bytes[s + 13] !== 58 || bytes[s + 16] !== 58) return null;
    const a = bytes[s] - 48, b = bytes[s + 1] - 48, c = bytes[s + 2] - 48, d = bytes[s + 3] - 48, e = bytes[s + 5] - 48, f = bytes[s + 6] - 48, g = bytes[s + 8] - 48, h = bytes[s + 9] - 48;
    const H1 = bytes[s + 11] - 48, H2 = bytes[s + 12] - 48, M1 = bytes[s + 14] - 48, M2 = bytes[s + 15] - 48, S1 = bytes[s + 17] - 48, S2 = bytes[s + 18] - 48;
    if ((a >>> 0) > 9 || (b >>> 0) > 9 || (c >>> 0) > 9 || (d >>> 0) > 9 || (e >>> 0) > 9 || (f >>> 0) > 9 || (g >>> 0) > 9 || (h >>> 0) > 9 || (H1 >>> 0) > 9 || (H2 >>> 0) > 9 || (M1 >>> 0) > 9 || (M2 >>> 0) > 9 || (S1 >>> 0) > 9 || (S2 >>> 0) > 9) return null;
    const hh = H1 * 10 + H2, mi = M1 * 10 + M2, sc = S1 * 10 + S2; if (hh > 23 || mi > 59 || sc > 59) return null;
    const y = a * 1000 + b * 100 + c * 10 + d, mo = e * 10 + f, dd = g * 10 + h, key = y * 10000 + mo * 100 + dd;
    if (key !== lastKey) {
      if (y < 1000 || mo < 1 || mo > 12 || dd < 1) return null;
      const dim = mo === 2 ? ((y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28) : (mo === 4 || mo === 6 || mo === 9 || mo === 11) ? 30 : 31; if (dd > dim) return null;
      const yy = mo <= 2 ? y - 1 : y, era = (yy / 400) | 0, yoe = yy - era * 400, doy = ((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 | 0) + dd - 1, doe = yoe * 365 + ((yoe / 4) | 0) - ((yoe / 100) | 0) + doy;
      lastBase = (era * 146097 + doe - 719468) * 86400; lastKey = key;
    }
    let fr = 0; for (let j = 0; j < fd; j++) { const q = bytes[s + 20 + j] - 48; if ((q >>> 0) > 9) return null; fr = fr * 10 + q; }
    out[i] = (lastBase + hh * 3600 + mi * 60 + sc) * mul + fr;
  }
  return { values: out, unit: L === 19 ? 's' : L === 23 ? 'ms' : 'us', fmt: L === 19 ? 'YYYY-MM-DD HH:MM:SS' : L === 23 ? 'YYYY-MM-DD HH:MM:SS.fff' : 'YYYY-MM-DD HH:MM:SS.ffffff' };
}
// Decimal text to doubles for a column of plain numbers whose digits print back exactly (no fixed scale, so the sample plan left it as text). Every cell must be
// -?digits[.digits] in its shortest form (no leading zero, no trailing zero after the point, no '+', no '-0', at most 15 digits, nothing under 1e-6), so String(value) is the cell text.
// Empty cells are NaN. Returns null at the first cell that fails; the column then stays text, so the grid and the export keep the same digits.
const P10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];
function numFromText(bytes, start, end, n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let p = start[i]; const e = end[i];
    if (p === e) { out[i] = NaN; continue; }
    const neg = bytes[p] === 45; if (neg) p++;
    if (p >= e) return null;
    const first = bytes[p]; let digs = 0, v = 0, dot = -1, last = 0;
    if (first === 48 && p + 1 < e && bytes[p + 1] !== 46) return null;   // leading zero
    for (let q = p; q < e; q++) {
      const c = bytes[q];
      if (c === 46) { if (dot >= 0 || q === p || q === e - 1) return null; dot = digs; continue; }
      const d = c - 48; if ((d >>> 0) > 9) return null;
      v = v * 10 + d; digs++; last = d;
    }
    if (digs > 15) return null;
    if (dot >= 0) { if (last === 0) return null; v /= P10[digs - dot]; if (v !== 0 && v < 1e-6) return null; }
    if (neg) { if (v === 0) return null; v = -v; }
    out[i] = v;
  }
  return out;
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
        const nv = m.num && m.num[k] ? numFromText(bytes, start, end, rows) : null, tv = nv || m.noTs ? null : tsFromText(bytes, start, end, rows);
        cols[m.headers[k]] = nv ? nv : tv ? { kind: 'ts', unit: tv.unit, values: tv.values, fmt: tv.fmt } : { bytes, start, end };
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
  let file = m.file; const size = file.size, SL = 1048576;
  if (file.mem) { const mf = file; file = { size: mf.size, slice: (x, y) => ({ arrayBuffer: async () => { if (x < mf.base || (y > mf.base + mf.buf.byteLength && mf.base + mf.buf.byteLength < mf.size)) throw new Error('MEM_RANGE'); return mf.buf.slice(x - mf.base, Math.min(y, mf.base + mf.buf.byteLength) - mf.base); } }) }; }
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
  try { await LfcPack.init(); let bytes = new Uint8Array(m.c); let keys = null, big = 0; if (m.flat === 1 || m.flat === 2) { flatOne ||= flatTransform(); if (m.flat === 2) { const sc = flatOne.scan(bytes); keys = sc.keys; if (sc.maybeBig) { flatOne.reset(0); const tb = flatOne(bytes); big = flatOne.big(); if (big) bytes = tb; } } else { flatOne.reset(1); bytes = flatOne(bytes); keys = flatOne.keys(); big = flatOne.big(); } } const r = LfcPack.packBlock(bytes, m.flat === 1 || m.flat === 3 || big ? Object.assign({}, m.o, { blockBytes: bytes.length + 1024 }) : m.o);
    // Exact column types: the first 2000 lines can say "whole numbers" or "dates" for a column that later has decimals or other text. Each block is searched for a violation, and the importer combines the answers.
    let chk = null; if (m.chk && (m.chk.ints.length || m.chk.dates.length)) {
      const txt = new TextDecoder('latin1').decode(bytes); chk = { dec: [], bad: [] };
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
      if (m.chk.ints.length) { const re = new RegExp('"(' + m.chk.ints.map(esc).join('|') + ')":-?\\d+(?:\\.\\d|[eE])', 'g'); const seen = new Set(); let mm; while (seen.size < m.chk.ints.length && (mm = re.exec(txt))) { seen.add(mm[1]); re.lastIndex = mm.index + mm[0].length; } chk.dec = [...seen]; }
      for (const nm of m.chk.dates) { if (new RegExp('"' + esc(nm) + '":"(?!\\d{4}-\\d\\d-\\d\\d(?:[ T]\\d\\d:\\d\\d(?::\\d\\d(?:\\.\\d+)?)?)?Z?")').test(txt)) chk.bad.push(nm); }
    }
    self.postMessage({ type: 'packed', rid: m.rid, r, chk, keys, big }, [r.buffer]); }
  catch (err) { self.postMessage({ type: 'packed', rid: m.rid, error: String(err && err.message || err) }); }
}

// Helper side of a segmented import: parse one piece, post the result (the bytes are transferred, not copied).
async function segJob(m) {
  try {
    const r = await parseSegment(m);
    if (m.dup) r.chunks2 = r.chunks.map(dupChunk);   // live columns: a second copy made here, in parallel, so the import worker keeps one and forwards the other to the pack workers
    if (r.chunks && r.chunks.length) { r.chunks = r.chunks.map(slabChunk); if (r.chunks2) r.chunks2 = r.chunks2.map(slabChunk); }
    self.postMessage({ type: 'segdone', rid: m.rid, r }, r.pieces.map((b) => b.buffer).concat(...r.chunks.map(chunkBuffers), ...(r.chunks2 || []).map(chunkBuffers)));
  } catch (err) { self.postMessage({ type: 'segdone', rid: m.rid, r: { error: String(err && err.message || err), mixed: !!(err && err.mixed), col: err && err.col != null ? err.col : -1 } }); }
}


// Import-worker side: cut the file into pieces, let two helpers parse them at the same time, pack the pieces in file order.
// Returns null when this is not possible here (helpers cannot start, no usable header break); the caller then uses the one-helper path.
async function runSegmented(file, delimiter, job, packBytes, progress, t, SEGB, plan, col, dict, nh) {
  nh = Math.max(2, Math.min(8, nh | 0 || 2));   // parse helpers: 2 by default; the page option parseHelpers tries more on machines with spare cores
  await loadCore(); const { TypeTracker } = core;
  const helpers = [], pending = new Map(); let rid = 0;
  const closeAll = () => helpers.forEach((h) => h.terminate());
  try { for (let i = 0; i < nh; i++) helpers.push(mkWorker()); } catch { closeAll(); return null; }
  const failAll = (err) => { for (const p of pending.values()) p.rej(err); pending.clear(); };
  for (const h of helpers) {
    h.onmessage = (e) => { const d = e.data || {}; if (d.type === 'segdone') { const p = pending.get(d.rid); if (p) { pending.delete(d.rid); p.res(d.r); } } };
    h.onerror = (e) => failAll(new Error('The import helper failed: ' + (e && e.message || 'unknown error')));
  }
  const rpc = async (h, msg) => {
    let tr = []; if (msg.file && msg.file.lazy) {   // a zip entry still being unpacked: hand the helper the bytes of its own window (segment plus 2 MiB past its end to finish the last row)
      const f = msg.file, lo = msg.headerOnly ? 0 : msg.startAt != null ? msg.startAt : msg.first ? msg.hdrEnd : msg.s, hi = Math.min(f.size, msg.headerOnly ? 4194304 : (msg.e || f.size) + 2097152);
      const u = await f.bytes(lo, hi); msg = Object.assign({}, msg, { file: { mem: true, size: f.size, base: lo, buf: u.buffer } }); tr = [u.buffer];
    }
    return new Promise((res, rej) => { const id = ++rid; pending.set(id, { res, rej }); h.postMessage(Object.assign({ type: 'seg', rid: id }, msg), tr); });
  };
  job.abort = () => { closeAll(); failAll(Object.assign(new Error('Import cancelled.'), { cancelled: true })); };
  const t0 = performance.now();
  try {
    let hdr; try { hdr = await rpc(helpers[0], { file, delimiter, headerOnly: true, e: 0 }); } catch { closeAll(); return null; }
    if (hdr.error || !hdr.header || hdr.eof) { closeAll(); return null; }
    const headers = hdr.header, hdrEnd = hdr.endPos, total = Math.ceil((file.size - hdrEnd) / SEGB);
    if (col && headers.length > 128) col = null;   // the column builder takes up to 128 columns
    if (col) await col.begin(headers);
    const cols = !!col; t.cols = cols;
    const agg = headers.map(() => new TypeTracker());
    let rows = 0, expect = hdrEnd, lineBase = hdr.lines + 1; const sample = [];
    let nextD = 0, nextP = 0, quit = false; const done = new Map(), waiters = new Set();
    const signal = () => { for (const w of [...waiters]) { waiters.delete(w); w(); } };
    const wait = () => new Promise((r) => waiters.add(r));
    const run = async (h) => {
      while (!quit && nextD < total) {
        if (nextD >= nextP + SEG_WINDOW + nh - 2) { await wait(); continue; }
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
  samplePlan.dict = null; samplePlan.num = null;
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
    samplePlan.num = tr.map((x, c) => x.type === 'number' && x.n > x.empty && !plan[c] && !(samplePlan.dict && samplePlan.dict[c]));
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
// Zip entries are checked against the CRC-32 in the central directory: the entry is wrapped as a gzip stream (header, raw deflate or stored blocks, CRC and size trailer) so the browser's own gzip decoder verifies it at native speed.
const GZ_HDR = new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 0, 255]), ZIP_BAD = 'This zip entry failed its checksum, so the file inside is damaged or was changed.';
function zipEntryStream(raw, pick) {
  const rd = raw.getReader(); let st = 0;
  const wrapped = new ReadableStream({
    async pull(ctl) {
      if (st === 0) { ctl.enqueue(GZ_HDR); st = 1; return; }
      if (st === 1) {
        const { done, value } = await rd.read();
        if (done) { if (pick.method === 0) ctl.enqueue(new Uint8Array([1, 0, 0, 255, 255])); st = 2; return; }
        if (pick.method === 8) { ctl.enqueue(value); return; }
        for (let o = 0; o < value.length; o += 65535) { const len = Math.min(65535, value.length - o), b = new Uint8Array(5 + len); b[1] = len & 255; b[2] = len >> 8; b[3] = ~len & 255; b[4] = (~len >> 8) & 255; b.set(value.subarray(o, o + len), 5); ctl.enqueue(b); }
        return;
      }
      const t = new Uint8Array(8), dv = new DataView(t.buffer); dv.setUint32(0, pick.crc, true); dv.setUint32(4, pick.usz >>> 0, true); ctl.enqueue(t); ctl.close(); st = 3;
    },
    cancel(r) { return rd.cancel(r); }
  }).pipeThrough(new DecompressionStream('gzip')), out = wrapped.getReader();
  return new ReadableStream({
    async pull(ctl) { try { const { done, value } = await out.read(); if (done) ctl.close(); else ctl.enqueue(value); } catch (err) { ctl.error(new Error(ZIP_BAD)); } },
    cancel(r) { return out.cancel(r); }
  });
}
async function unzipFile(file, want, listOnly, asStream) {
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
    ents.push({ name, method, csz, usz, lho, crc: cd.getUint32(p + 16, true), enc: !!(flags & 1) }); p += 46 + nl + el + cl;
  }
  const files = ents.filter((x) => !x.name.endsWith('/'));
  let pick = want ? files.find((x) => x.name === want) : null;
  if (!pick) pick = files.filter((x) => /\.(csv|tsv|txt)$/i.test(x.name)).sort((a, b) => b.usz - a.usz)[0] || files.sort((a, b) => b.usz - a.usz)[0];
  if (!pick) throw new Error('The zip file has no files.');
  if (listOnly) return { entries: files.map((x) => ({ name: x.name, size: x.usz, method: x.method })), picked: pick.name }; if (pick.enc) throw new Error('This zip entry is encrypted.');
  if (pick.method !== 0 && pick.method !== 8) throw new Error('This zip entry uses an unsupported compression method (' + pick.method + ').');
  const lh = new DataView(await file.slice(pick.lho, pick.lho + 30).arrayBuffer()), start = pick.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const base = pick.name.split('/').pop(); const raw = file.slice(start, start + pick.csz);
  if (asStream) { if (!want || pick.name !== want) throw new Error('The file has no ' + want + '.'); return { stream: zipEntryStream(raw.stream(), pick), picked: pick.name, usz: pick.usz }; }
  const parts = []; const rd = zipEntryStream(raw.stream(), pick).getReader(); let acc = [], accN = 0, total = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; acc.push(value); accN += value.length; total += value.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } }
  if (acc.length) parts.push(new Blob(acc));
  if (total !== pick.usz) throw new Error('The zip entry did not unpack to its recorded size.');
  return { file: new File(parts, base, { type: 'text/csv' }), entries: files.map((x) => x.name), picked: pick.name };
}
// The page lists the files in a zip so the person can pick one (m.zipEntry); the default is the largest .csv, .tsv or .txt.
async function zipList(m) { try { if (isOds(m.file)) { send('zipList', m.id, await odsList(m.file)); return; } if (/\.xls$/i.test(m.file.name || '') && await xlsOpen(m.file)) { send('zipList', m.id, await xlsList(m.file)); return; } if (!isXlsx(m.file) && !isZip(m.file) && !isGz(m.file) && await isSqliteFile(m.file)) { const r = await sqliteList(m.file); send('zipList', m.id, Object.assign({ kind: 'Table' }, r)); return; } if (isXlsb(m.file)) { send('zipList', m.id, await xlbList(m.file)); return; } if (isXlsx(m.file)) { const x = await xlsxMeta(m.file); send('zipList', m.id, { entries: x.sheets.filter((s) => !s.hidden || s === x.pick).map((s) => ({ name: s.name, size: -1 })), picked: x.pick.name, sheets: true, kind: 'Sheet' }); return; } const r = await unzipFile(m.file, null, true); send('zipList', m.id, r); } catch (err) { send('zipList', m.id, { error: String(err && err.message || err) }); } }
// ---- xlsx: sheet XML streams through a small wasm parser (sheet.c) that writes CSV bytes (dates from date-formatted cells become ISO text); then the normal CSV import runs on that file.
// xlsx -> CSV text core (shared by Node tests and the worker). Pure functions, no I/O.
function xlUnescape(s) {
  if (s.indexOf('&') < 0 && s.indexOf('_x') < 0) return s;
  s = s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, g) => g === 'amp' ? '&' : g === 'lt' ? '<' : g === 'gt' ? '>' : g === 'quot' ? '"' : g === 'apos' ? "'" : String.fromCodePoint(g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)));
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}
function parseSharedStrings(xml) {
  const out = []; const siRe = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g; let m;
  while ((m = siRe.exec(xml))) {
    let b = m[1] || ''; if (b.indexOf('<rPh') >= 0) b = b.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    if (b.indexOf('<r>') < 0 && b.indexOf('<r ') < 0) { const a = b.indexOf('>', b.indexOf('<t')), z = b.indexOf('</t>'); out.push(a >= 0 && z > a ? xlUnescape(b.slice(a + 1, z)) : ''); continue; }
    let s = ''; const tRe = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g; let t; while ((t = tRe.exec(b))) s += t[1] ? xlUnescape(t[1]) : ''; out.push(s);
  }
  return out;
}
// Which cell styles (cellXfs index) hold dates or times. kind: 0 number, 1 date, 2 date and time, 3 time only.
function parseStyles(xml) {
  const custom = new Map(); const nf = /<numFmt\b[^>]*>/g; let m;   // attribute order is not fixed in XML
  while ((m = nf.exec(xml))) { const id = /\bnumFmtId="(\d+)"/.exec(m[0]), fc = /\bformatCode="([^"]*)"/.exec(m[0]); if (id && fc) custom.set(+id[1], xlUnescape(fc[1])); }
  const fmtKind = (id) => {
    if (id >= 14 && id <= 17) return 1; if (id === 22) return 2; if (id >= 18 && id <= 21) return 3; if (id >= 45 && id <= 47) return 3;
    const code = custom.get(id); if (code == null) return 0;
    const c = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '').toLowerCase(); const t = /[hs]|am\/pm/.test(c), d = /[yd]/.test(c) || (!t && /m/.test(c));
    return d && t ? 2 : d ? 1 : t ? 3 : 0;
  };
  const cx = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml); const kinds = [];
  if (cx) { const xf = /<xf\b[^>]*?numFmtId="(\d+)"/g; while ((m = xf.exec(cx[1]))) kinds.push(fmtKind(+m[1])); }
  return kinds;
}
const colIndex = (r) => { let n = 0; for (let i = 0; i < r.length; i++) { const c = r.charCodeAt(i); if (c < 65) break; n = n * 26 + (c - 64); } return n - 1; };
const csvq = (s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c === 44 || c === 34 || c === 10 || c === 13) return '"' + s.replace(/"/g, '""') + '"'; } return s; };

const isXlsx = (f) => /\.(xlsx|xlsm|xlsb)$/i.test(f.name || '');
async function xlsxText(file, name) { const z = await unzipFile(file, name); return z.file.text(); }
function sheetWasm() {
  const bin = Uint8Array.from(atob('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IAcgAmogBToAACACQQFqIQMgBiAIQQJqIghHDQALCyAJRQ0AAkAgACAIaiIILQAAIgJBIkcNACAHIANqQSI6AAAgA0EBaiEDIAgtAAAhAgsgByADaiACOgAAIANBAWohAwtBACADQQFqNgK8iICAACAHIANqQSI6AAALIAQLCxIBAEGACAsLVFJVRQBGQUxTRQAAyQEEbmFtZQAMC3NoZWV0Mi53YXNtAZMBDwAFYWxsb2MBBXNldHVwAgdvdXRfbGVuAwlvdXRfcmVzZXQECGdldF9yb3dzBQlnZXRfd2lkdGgGC2dldF9kcm9wcGVkBwpnZXRfc3RhdHVzCAhzZXRfYmFzZQkHcHJvY2VzcwoFdW5lc2MLB2ZpbGxfdG8MCXBhcnNlX251bQ0IcHV0X2RhdGUOCHB1dF90ZXh0BxIBAA9fX3N0YWNrX3BvaW50ZXIJCgEABy5yb2RhdGEAOAlwcm9kdWNlcnMBDHByb2Nlc3NlZC1ieQEMVWJ1bnR1IGNsYW5nETE4LjEuMyAoMXVidW50dTEpADkPdGFyZ2V0X2ZlYXR1cmVzAysLYnVsay1tZW1vcnkrD211dGFibGUtZ2xvYmFscysIc2lnbi1leHQ='), (c) => c.charCodeAt(0)); return new WebAssembly.Instance(new WebAssembly.Module(bin), {}).exports;
}
async function xlsxMeta(file, wantSheet) {
  let list; try { list = await unzipFile(file, null, true); } catch (e) { throw new Error('This Excel file cannot be read. It may be password-protected, damaged, or an old .xls file (save it as .xlsx or .csv first).'); }
  const names = new Set(list.entries.map((x) => x.name));
  if (!names.has('xl/workbook.xml')) throw new Error(names.has('xl/workbook.bin') ? 'This is an Excel binary workbook saved with another name. Rename it to end in .xlsb and import it again.' : 'This is not an Excel (.xlsx) workbook: xl/workbook.xml is missing.');
  const wb = await xlsxText(file, 'xl/workbook.xml'), rels = names.has('xl/_rels/workbook.xml.rels') ? await xlsxText(file, 'xl/_rels/workbook.xml.rels') : '';
  const relMap = new Map(); { const re = /<Relationship\b([^>]*?)\/?>/g; let m; while ((m = re.exec(rels))) { const id = /\bId="([^"]*)"/.exec(m[1]), tg = /\bTarget="([^"]*)"/.exec(m[1]); if (id && tg) relMap.set(id[1], tg[1]); } }
  const sheets = []; { const re = /<sheet\b([^>]*?)\/?>/g; let m; while ((m = re.exec(wb))) { const nm = /\bname="([^"]*)"/.exec(m[1]), rid = /\br:id="([^"]*)"/.exec(m[1]), st = /\bstate="([^"]*)"/.exec(m[1]); if (nm && rid && relMap.has(rid[1])) { let tg = relMap.get(rid[1]); tg = tg[0] === '/' ? tg.slice(1) : 'xl/' + tg; sheets.push({ name: xlUnescape(nm[1]), path: tg, hidden: !!st && st[1] !== 'visible' }); } } }
  if (!sheets.length) throw new Error('This workbook has no sheets.');
  let pick = wantSheet ? sheets.find((s) => s.name === wantSheet) : null; if (!pick) pick = sheets.find((s) => !s.hidden) || sheets[0];
  return { names, wb, sheets, pick };
}
async function xlsxToCsvFile(file, wantSheet) {
  const { names, wb, sheets, pick } = await xlsxMeta(file, wantSheet);
  if (!names.has(pick.path)) throw new Error('The sheet "' + pick.name + '" is missing from the workbook.');
  const sst = names.has('xl/sharedStrings.xml') ? parseSharedStrings(await xlsxText(file, 'xl/sharedStrings.xml')) : [];
  const kinds = names.has('xl/styles.xml') ? parseStyles(await xlsxText(file, 'xl/styles.xml')) : [];
  const d1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb);
  const z = await unzipFile(file, pick.path, false, true), X = sheetWasm(), enc = new TextEncoder();
  const CAP = 12 << 20, OUTCAP = 16 << 20, INCAP = CAP + (4 << 20);
  const qs = sst.map((s) => enc.encode(csvq(s))); let sstBytes = 0; for (const q of qs) sstBytes += q.length;
  const inp = X.alloc(INCAP), out = X.alloc(OUTCAP), sp = X.alloc(sstBytes + 16), so = X.alloc(4 * (sst.length + 1)), kp = X.alloc(kinds.length + 1);
  { const offs = new Uint32Array(sst.length + 1); let M = new Uint8Array(X.memory.buffer), o = 0; for (let i = 0; i < qs.length; i++) { offs[i] = o; M.set(qs[i], sp + o); o += qs[i].length; } offs[qs.length] = o; new Uint32Array(X.memory.buffer, so, sst.length + 1).set(offs); M.set(Uint8Array.from(kinds), kp); }
  const rd = z.stream.getReader(), parts = []; let acc = [], accN = 0, fill = 0, started = false, setupDone = false, width = 0, base = 0;
  const flush = () => { const n = X.out_len(); if (!n) return; acc.push(new Uint8Array(X.memory.buffer, out, n).slice()); accN += n; X.out_reset(); if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
  const run = (final) => {
    if (!setupDone) {   // the column count comes from <dimension>, else from the first row
      const head = new TextDecoder('latin1').decode(new Uint8Array(X.memory.buffer, inp, Math.min(fill, 1 << 20)));
      const dm = /<dimension\b[^>]*\bref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/.exec(head); if (dm) { base = colIndex(dm[1]); width = colIndex(dm[3] || dm[1]) - base + 1; }
      if (!(width > 0 && width < 20000)) { width = 0; base = 0; const r1 = /<row\b[^>]*>([\s\S]*?)<\/row>/.exec(head); if (r1) { const re = /<c\b[^>]*?\br="([A-Z]+)\d+"/g; let m; while ((m = re.exec(r1[1]))) width = Math.max(width, colIndex(m[1]) + 1); } }
      if (!width) { if (!final) return; throw new Error('The sheet "' + pick.name + '" has no data.'); }
      X.set_base(width ? base : 0); X.setup(inp, out, OUTCAP, width, d1904 ? 1 : 0, sp, so, sst.length, kp, kinds.length); setupDone = true;
    }
    let p = 0; for (;;) { p = X.process(p, fill, final ? 1 : 0); flush(); const s = X.get_status(); if (s === 2) throw new Error('A cell or row in this sheet is too large to read.'); if (s !== 1) break; }
    if (p < fill) new Uint8Array(X.memory.buffer).copyWithin(inp, inp + p, inp + fill); fill -= p;
  };
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    if (fill + value.length > INCAP) throw new Error('A row in this sheet is larger than ' + (CAP >> 20) + ' MB.');
    new Uint8Array(X.memory.buffer).set(value, inp + fill); fill += value.length; if (fill >= (4 << 20)) run(false);
  }
  run(true); if (acc.length) parts.push(new Blob(acc));
  const rows = X.get_rows(); if (!rows) throw new Error('The sheet "' + pick.name + '" has no data.');
  return { file: new File(parts, String(file.name).replace(/\.(xlsx|xlsm)$/i, '') + '.csv', { type: 'text/csv' }), sheet: pick.name, sheets: sheets.length, rows, width, dropped: X.get_dropped() };
}
// ---- Fixed-width text: columns are found from the first lines (every line has a space in the gap) or taken from the widths the person typed; the text is rewritten as CSV, then imported normally.
// Fixed-width text: guess the column breaks from the first lines, or take widths typed by the person; convert to CSV text.
function guessWidths(lines) {
  lines = lines.filter((l) => l.trim().length); if (lines.length < 5) return null; if (lines.length > 300) lines = lines.slice(0, 300);
  let max = 0; for (const l of lines) if (l.length > max) max = l.length; if (max < 4 || max > 4000) return null;
  const sep = new Uint8Array(max).fill(1);   // 1 = every sampled line has a space (or ends) here
  for (const l of lines) for (let i = 0; i < l.length; i++) if (l.charCodeAt(i) !== 32) sep[i] = 0;
  const starts = []; for (let i = 0; i < max; i++) if (!sep[i] && (i === 0 || sep[i - 1])) starts.push(i);
  // a header word that starts where no data word crosses (right-aligned numbers touching text) also starts a column
  const head = lines[0], set = new Set(starts);
  for (let i = 1; i < head.length; i++) if (head.charCodeAt(i) !== 32 && head.charCodeAt(i - 1) === 32 && !set.has(i)) { let cut = true; for (let k = 1; k < lines.length; k++) { const l = lines[k]; if (i < l.length && l.charCodeAt(i) !== 32 && l.charCodeAt(i - 1) !== 32) { cut = false; break; } } if (cut) { set.add(i); } }
  if (set.size !== starts.length) { starts.length = 0; for (const x of [...set].sort((a, b) => a - b)) starts.push(x); }
  if (starts.length < 2 || starts.length > 1000) return null;
  // every field start must be a real boundary: most lines are non-space at the start and have space just before it
  const ok = starts.every((s) => s === 0 || lines.filter((l) => l.charCodeAt(s - 1) === 32 || s - 1 >= l.length).length >= lines.length * 0.95);
  if (!ok) return null;
  // prose guard: lines should have similar lengths or a table-like layout; reject if fewer than 3 fields have content in most rows
  let filled = 0; for (let k = 0; k < starts.length; k++) { const a = starts[k], b = k + 1 < starts.length ? starts[k + 1] : max; let c = 0; for (const l of lines) if (l.slice(a, b).trim()) c++; if (c >= lines.length * 0.5) filled++; }
  if (filled < 2) return null;
  const w = []; for (let k = 0; k < starts.length; k++) w.push((k + 1 < starts.length ? starts[k + 1] : max) - starts[k]);
  if (starts[0] > 0) w.unshift(starts[0]);   // leading blank margin becomes its own (dropped) piece: handled by caller via offset
  return { starts, widths: w.slice(starts[0] > 0 ? 1 : 0), offset: 0 };
}
function parseWidths(s) {   // "5,12,10,9" or "5 12 10 9": field widths, the last may be omitted (rest of the line)
  const parts = String(s).split(/[\s,;]+/).filter(Boolean).map(Number); if (!parts.length || parts.some((n) => !(n >= 1 && n === Math.floor(n)))) return null; return parts;
}
const fwQuote = (s) => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
function makeConverter(starts, ends) {   // starts/ends: character positions per field; ends[last] may be Infinity
  const n = starts.length; let first = true;
  return (line) => {
    if (!line.trim()) return '';
    let o = ''; for (let k = 0; k < n; k++) { let v = line.slice(starts[k], ends[k] === Infinity ? undefined : ends[k]).trim(); if (first && !v) v = 'column_' + (k + 1); o += (k ? ',' : '') + fwQuote(v); }
    first = false; return o + '\n';
  };
}
function layoutFromWidths(w) { const starts = [], ends = []; let p = 0; for (const x of w) { starts.push(p); p += x; ends.push(p); } ends[ends.length - 1] = Infinity; return { starts, ends }; }
function layoutFromGuess(g) { const ends = g.starts.map((s, k) => k + 1 < g.starts.length ? g.starts[k + 1] : Infinity); return { starts: g.starts, ends }; }

async function fixedWidthStage(m) {
  if (!m.file || isNdjson(m.file) || isXlsx(m.file)) return null;
  const typed = m.widths && String(m.widths).trim() ? parseWidths(m.widths) : null;
  if (m.widths && String(m.widths).trim() && !typed) throw new Error('Column widths must be whole numbers such as 5,12,10,9 (the last column takes the rest of each line).');
  const forced = m.delimiter === 'fixed'; let lay, text, guessed = null;
  const sample = new TextDecoder().decode(new Uint8Array(await m.file.slice(0, 1 << 20).arrayBuffer())).replace(/^\ufeff/, '');
  if (typed) { lay = layoutFromWidths(typed); text = 'Read as fixed-width text with the column widths you typed (the last column takes the rest of each line).'; }
  else {
    if (m.delimiter && m.delimiter !== 'auto' && !forced) return null;
    const ls = sample.split(/\r?\n/); ls.pop(); const probe = ls.filter((l) => l.trim()).slice(0, 12);
    if (!forced) { await loadCore(); if (core.spaceDelimited(sample)) return null; }   // single-space separated fields with the same count on every line are a delimited file, not fixed-width
    if (probe.length < 5) { if (forced) throw new Error('Could not find fixed-width columns in this file. Type the column widths, such as 5,12,10,9.'); return null; }
    if (!forced) for (const d of [',', '\t', ';', '|']) { let tot = 0; for (const l of probe) { let q = false, k = 1; for (const c of l) { if (c === '"') q = !q; else if (c === d && !q) k++; } tot += k; } if (tot / probe.length >= 1.5) return null; }
    const g = guessWidths(ls); if (!g) { if (forced) throw new Error('Could not find fixed-width columns in this file. Type the column widths, such as 5,12,10,9.'); return null; } lay = layoutFromGuess(g); guessed = g.starts.slice(1).map((x, i) => x - (i ? g.starts[i] : 0)).join(',');
    text = 'This looks like fixed-width text, so it was split into columns of width ' + g.starts.map((s, k) => k + 1 < g.starts.length ? g.starts[k + 1] - s : 'rest').join(', ') + '. Type your own widths in "Column widths" to change this.';
  }
  const conv = makeConverter(lay.starts, lay.ends), dec = new TextDecoder('utf-8'), enc = new TextEncoder(), parts = []; let acc = [], accN = 0, carry = '', rows = 0;
  const put = (s) => { if (!s) return; const e = enc.encode(s); acc.push(e); accN += e.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
  const rd = m.file.stream().getReader(); let first = true;
  const doText = (t, last) => { t = carry + t; const ls = t.split(/\r?\n|\r(?!$)/); carry = last ? '' : ls.pop(); if (last && ls.length && ls[ls.length - 1] === '') ls.pop(); let out = ''; for (let l of ls) { if (first) { l = l.replace(/^\ufeff/, ''); } const r = conv(l); if (r) { out += r; rows++; first = false; } } put(out); };
  for (;;) { const { done, value } = await rd.read(); if (done) break; doText(dec.decode(value, { stream: true }), false); }
  doText(dec.decode(), true); if (acc.length) parts.push(new Blob(acc));
  if (!rows) throw new Error('No rows could be read as fixed-width text.');
  return { file: new File(parts, String(m.file.name).replace(/\.[^.]*$/, '') + '.csv', { type: 'text/csv' }), text, widths: guessed };
}
// ---- SQLite: a small read-only reader (table b-trees, overflow pages, rowid and WITHOUT ROWID tables). Table-leaf pages are decoded in wasm (sq.c) and written as CSV; then the normal CSV import runs.
// Minimal read-only SQLite file reader: table b-trees (rowid and WITHOUT ROWID), overflow pages, UTF-8/16 text. Writes rows as CSV text.
// Reads through readBlock(offset, length) -> Promise<Uint8Array>.
function makeSqlite(readBlock) {
  const BLK = 1 << 22; let blkNo = -1, blk = null, ps = 0, U = 0, enc = 1, walMode = false, npages = 0, fileSize = 0;
  async function page(n) {   // Uint8Array view of page n (1-based); cached 4 MB block
    const off = (n - 1) * ps, b = Math.floor(off / BLK), e = Math.floor((off + ps - 1) / BLK);
    if (b === e) { if (b !== blkNo) { blk = await readBlock(b * BLK, BLK); blkNo = b; } const sub = blk.subarray(off - b * BLK, off - b * BLK + ps); if (sub.length < ps) throw new Error('page ' + n + ' is past the end of the file'); return sub; }
    const r = await readBlock(off, ps); if (r.length < ps) throw new Error('page ' + n + ' is past the end of the file'); return r;
  }
  const u16 = (p, o) => (p[o] << 8) | p[o + 1], u32 = (p, o) => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
  function varint(p, o) { let v = 0; for (let i = 0; i < 8; i++) { const c = p[o + i]; v = v * 128 + (c & 127); if (c < 128) return [v, i + 1]; } return [v * 256 + p[o + 8], 9]; }   // 9th byte uses all 8 bits (exact up to 2^53)
  async function open() {
    const h = await readBlock(0, 100); if (h.length < 100 || String.fromCharCode(...h.subarray(0, 15)) !== 'SQLite format 3') throw new Error('This is not an SQLite database file.');
    ps = u16(h, 16); if (ps === 1) ps = 65536; if (ps < 512 || (ps & (ps - 1))) throw new Error('This SQLite file has an invalid page size.');
    U = ps - h[20]; enc = u32(h, 56) || 1; walMode = h[18] === 2 && h[19] === 2; npages = u32(h, 28);
    return { pageSize: ps, encoding: enc, wal: walMode, pages: npages, reserved: h[20] };
  }
  const dec8 = new TextDecoder('utf-8'), dec16 = (le) => new TextDecoder(le ? 'utf-16le' : 'utf-16be');
  async function payloadOf(p, o, plen, isIndex, tableLeafOnly) {   // returns the whole payload bytes, following overflow pages
    const maxLocal = isIndex ? ((U - 12) * 64 / 255 | 0) - 23 : U - 35, minLocal = ((U - 12) * 32 / 255 | 0) - 23;
    if (plen <= maxLocal) return p.subarray(o, o + plen);
    let local = minLocal + ((plen - minLocal) % (U - 4)); if (local > maxLocal) local = minLocal;
    const out = new Uint8Array(plen); out.set(p.subarray(o, o + local), 0); let got = local, next = u32(p, o + local);
    while (got < plen && next) { const op = await page(next); const take = Math.min(U - 4, plen - got); out.set(op.subarray(4, 4 + take), got); got += take; next = u32(op, 0); }
    return out;
  }
  function decodeRecord(b, ncol, rowid, aliasIdx, st) {   // -> array of JS values (null, number, bigint, string, Uint8Array length marker)
    const [hlen, hn] = varint(b, 0); const types = []; let o = hn; while (o < hlen) { const [t, n] = varint(b, o); types.push(t); o += n; }
    let d = hlen; const out = new Array(ncol).fill(null);
    for (let i = 0; i < types.length; i++) {
      const t = types[i]; let v = null, len = 0;
      if (t === 0) v = null; else if (t >= 1 && t <= 6) { len = t === 5 ? 6 : t === 6 ? 8 : t; if (len <= 6) { let x = b[d] & 128 ? -1 : 0; for (let k = 0; k < len; k++) x = x * 256 + b[d + k]; if (b[d] & 128) { x = 0; for (let k = 0; k < len; k++) x = x * 256 + b[d + k]; x -= Math.pow(2, 8 * len); } v = x; } else { let x = 0n; for (let k = 0; k < 8; k++) x = (x << 8n) | BigInt(b[d + k]); if (x >= (1n << 63n)) x -= (1n << 64n); v = (x >= -9007199254740991n && x <= 9007199254740991n) ? Number(x) : x; } }
      else if (t === 7) { len = 8; v = new DataView(b.buffer, b.byteOffset + d, 8).getFloat64(0, false); }
      else if (t === 8) v = 0; else if (t === 9) v = 1;
      else if (t >= 12) { if (t & 1) { len = (t - 13) >> 1; const sl = b.subarray(d, d + len); v = enc === 1 ? dec8.decode(sl) : dec16(enc === 2).decode(sl); } else { len = (t - 12) >> 1; v = null; st.blobs++; } }
      d += len; if (i < ncol) out[i] = v;
    }
    if (aliasIdx >= 0 && out[aliasIdx] === null) out[aliasIdx] = rowid;
    return out;
  }
  async function walkTable(root, onRecord, cols, aliasIdx, st, withoutRowid) {
    const stack = [root];
    const visit = async (n) => {
      const p = await page(n), hb = n === 1 ? 100 : 0, type = p[hb], nc = u16(p, hb + 3);
      if (type === 0x0d) { const base = hb + 8; for (let i = 0; i < nc; i++) { let o = u16(p, base + 2 * i); const [pl, a] = varint(p, o); o += a; const [rid, b2] = varint(p, o); o += b2; onRecord(decodeRecord(await payloadOf(p, o, pl, false), cols, rid, aliasIdx, st)); } }
      else if (type === 0x05) { const base = hb + 12; for (let i = 0; i < nc; i++) { const o = u16(p, base + 2 * i); await visit(u32(p, o)); } await visit(u32(p, hb + 8)); }
      else if (type === 0x0a) { const base = hb + 8; for (let i = 0; i < nc; i++) { let o = u16(p, base + 2 * i); const [pl, a] = varint(p, o); o += a; onRecord(decodeRecord(await payloadOf(p, o, pl, true), cols, 0, -1, st)); } }
      else if (type === 0x02) { const base = hb + 12; for (let i = 0; i < nc; i++) { let o = u16(p, base + 2 * i); const child = u32(p, o); o += 4; const [pl, a] = varint(p, o); o += a; await visit(child); onRecord(decodeRecord(await payloadOf(p, o, pl, true), cols, 0, -1, st)); } await visit(u32(p, hb + 8)); }
      else throw new Error('Unexpected SQLite page type ' + type + ' on page ' + n + '.');
    };
    await visit(root);
  }
  function parseCreate(sql) {   // column names and the rowid-alias column index from CREATE TABLE text
    const open = sql.indexOf('('); if (open < 0) return null; let depth = 0, close = -1, q = null;
    for (let i = open; i < sql.length; i++) { const c = sql[i]; if (q) { if (c === q) q = null; continue; } if (c === '"' || c === "'" || c === '`') q = c; else if (c === '[') q = ']'; else if (c === '(') depth++; else if (c === ')') { depth--; if (depth === 0) { close = i; break; } } }
    if (close < 0) return null; const body = sql.slice(open + 1, close), segs = []; let cur = '', d2 = 0, q2 = null;
    for (const c of body) { if (q2) { cur += c; if (c === q2) q2 = null; continue; } if (c === '"' || c === "'" || c === '`') { q2 = c; cur += c; continue; } if (c === '[') { q2 = ']'; cur += c; continue; } if (c === '(') d2++; if (c === ')') d2--; if (c === ',' && d2 === 0) { segs.push(cur); cur = ''; } else cur += c; }
    segs.push(cur); const names = []; let alias = -1; const tail = sql.slice(close + 1);
    for (const sraw of segs) { const s = sraw.trim(); if (/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(s)) continue;
      const m = /^(?:"((?:[^"]|"")*)"|`([^`]*)`|\[([^\]]*)\]|'([^']*)'|([^\s(]+))\s*([\s\S]*)$/.exec(s); if (!m) continue; const nm = (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2] ?? m[3] ?? m[4] ?? m[5]); const rest = m[6] || '';
      if (/^integer\s+primary\s+key\b(?!\s+desc)/i.test(rest) || /^integer\s+(?:constraint\s+\S+\s+)?primary\s+key\b/i.test(rest)) alias = names.length; names.push(nm); }
    return { names, alias, withoutRowid: /without\s+rowid/i.test(tail) };
  }
  async function tables() {   // sqlite_master rows -> [{name, root, sql}] for real tables
    const out = [], st = { blobs: 0 };
    await walkTable(1, (r) => { if (r[0] === 'table' && r[3] > 0 && typeof r[4] === 'string' && !/^sqlite_/i.test(r[1]) && !/^\s*create\s+virtual/i.test(r[4])) out.push({ name: r[1], root: Number(r[3]), sql: r[4] }); }, 5, -1, st);
    for (const t of out) { const c = parseCreate(t.sql); if (c) Object.assign(t, c); }
    return out.filter((t) => t.names && t.names.length);
  }
  async function leafPages(root) {   // number of leaf pages (walks interior pages only), a size estimate
    let level = [root], depth = 0;
    for (;;) { const p0 = await page(level[0]), hb = level[0] === 1 ? 100 : 0, t = p0[hb]; if (t === 0x0d || t === 0x0a) return level.length; const next = [];
      for (const n of level) { const p = await page(n), h = n === 1 ? 100 : 0, nc = u16(p, h + 3), base = h + 12; for (let i = 0; i < nc; i++) next.push(u32(p, u16(p, base + 2 * i))); next.push(u32(p, h + 8)); } level = next; if (++depth > 12) return level.length; }
  }
  const csvq = (s) => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  async function exportCsv(t, put) {
    const st = { blobs: 0, rows: 0 }; let buf = 'name'.length ? t.names.map(csvq).join(',') + '\n' : '';
    const nc = t.names.length;
    await walkTable(t.root, (r) => { let line = ''; for (let i = 0; i < nc; i++) { const v = r[i]; if (i) line += ','; if (v === null || v === undefined) continue; line += typeof v === 'string' ? csvq(v) : String(v); } buf += line + '\n'; st.rows++; if (buf.length > (1 << 20)) { put(buf); buf = ''; } }, nc, t.alias, st, t.withoutRowid);
    put(buf); return st;
  }
  return { open, tables, leafPages, exportCsv, page, get info() { return { pageSize: ps, encoding: enc, reserved: ps - U }; } };
}
// Fast path: table-leaf pages are decoded in wasm (sq.c). wasmBytes: the compiled module bytes.
async function exportCsvFast(S, t, wasmBytes, putBytes) {
  const { page, info } = S; let X; const ps = info.pageSize, U = ps - info.reserved;
  const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), { env: { fmt_double: (x, dst) => { const s = String(x); const m = new Uint8Array(X.memory.buffer, dst, s.length + 1); for (let i = 0; i < s.length; i++) m[i] = s.charCodeAt(i); return s.length; } } }); X = inst.exports;
  const OUTCAP = 16 << 20, budget = 8 << 20, bp = Math.max(1, Math.floor(budget / ps)); const pg = X.alloc(bp * ps), out = X.alloc(OUTCAP);
  const nc = t.names.length; X.setup(pg, out, OUTCAP, ps, U, nc, t.alias >= 0 ? t.alias : 0xFFFFFFF, info.encoding);
  const flush = () => { const n = X.out_len(); if (n) { putBytes(new Uint8Array(X.memory.buffer, out, n).slice()); X.out_reset(); } };
  const enc = new TextEncoder(); putBytes(enc.encode(t.names.map((n) => (/[",\r\n]/.test(n) ? '"' + n.replace(/"/g, '""') + '"' : n)).join(',') + '\n'));
  // leaf pages in order (interior pages only are read here)
  let level = [t.root]; for (let d = 0; ; d++) { const p0 = await page(level[0]), hb = level[0] === 1 ? 100 : 0; if (p0[hb] === 0x0d) break; if (p0[hb] !== 0x05 || d > 12) throw new Error('Unexpected SQLite page type ' + p0[hb] + '.'); const next = []; for (const n of level) { const p = await page(n), h = n === 1 ? 100 : 0, c = (p[h + 3] << 8) | p[h + 4]; for (let i = 0; i < c; i++) { const o = (p[h + 12 + 2 * i] << 8) | p[h + 13 + 2 * i]; next.push(((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0); } next.push(((p[h + 8] << 24) | (p[h + 9] << 16) | (p[h + 10] << 8) | p[h + 11]) >>> 0); } level = next; }
  let ovPtr = 0, ovCap = 0;
  for (let at = 0; at < level.length; at += bp) {
    const n = Math.min(bp, level.length - at); for (let i = 0; i < n; i++) new Uint8Array(X.memory.buffer, pg + i * ps, ps).set(await page(level[at + i]));
    let pi = 0, cell = 0;
    for (;;) {
      X.run(pi, n, cell); flush(); const s = X.get_status(); if (s === 0) break;
      if (s === 1) { pi = X.get_ov_page(); cell = X.get_ov_cell(); continue; }
      if (s === 3) {
        pi = X.get_ov_page(); cell = X.get_ov_cell(); const plen = X.get_ov_plen(), off = X.get_ov_off(), maxL = U - 35, minL = (((U - 12) * 32 / 255) | 0) - 23; let local = minL + ((plen - minL) % (U - 4)); if (local > maxL) local = minL;
        if (plen > ovCap) { ovCap = Math.max(plen, ovCap * 2, 1 << 16); ovPtr = X.alloc(ovCap); }
        const src = new Uint8Array(X.memory.buffer, pg + pi * ps + off, local).slice(); let got = local; const dstOv = () => new Uint8Array(X.memory.buffer, ovPtr, plen); dstOv().set(src, 0);
        const u32 = (p, o) => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0; let nx = u32(new Uint8Array(X.memory.buffer, pg + pi * ps + off + local, 4), 0);
        while (got < plen && nx) { const op = await page(nx), take = Math.min(U - 4, plen - got); dstOv().set(op.subarray(4, 4 + take), got); got += take; nx = u32(op, 0); }
        let r = X.emit_payload(ovPtr, plen, X.get_ov_rowid_lo(), X.get_ov_rowid_hi()); if (r === 1) { flush(); r = X.emit_payload(ovPtr, plen, X.get_ov_rowid_lo(), X.get_ov_rowid_hi()); } if (r) throw new Error('A row in this SQLite table could not be read.');
        cell++; continue;
      }
      throw new Error('This SQLite table has pages that could not be read (page type or size).');
    }
  }
  flush(); return { rows: X.get_rows(), blobs: X.get_blobs() };
}

const SQ_WASM = Uint8Array.from(atob('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QQJqLQAAOgAAIAZBAmogBEEBai0AADoAACAGQQNqIAQtAAA6AAAgBEF8aiEEIBAgEkEEaiISag0ACyAFIBJqIQULQQAgBTYC2ImAgAAMAgtBACEEIAshBwNAIAMgBGogByAHQgqAIhRCCn59p0EwcjoAACAEQQFqIQQgB0IKVCEFIBQhByAFRQ0ACwtBACgCwImAgAAhEwJAAkAgBEEDcSISDQAgBCEGIBAhBQwBCyAEIQYgECEFA0AgEyAFaiANIAZqLQAAOgAAIAVBAWohBSAGQX9qIQYgEkF/aiISDQALCwJAIARBBEkNACATIAVqIRMgDCAGaiEEQQAhEkEAIAZrIRADQCATIBJqIgYgBEEDai0AADoAACAGQQFqIARBAmotAAA6AAAgBkECaiAEQQFqLQAAOgAAIAZBA2ogBC0AADoAACAEQXxqIQQgECASQQRqIhJqDQALIAUgEmohBQtBACAFNgLYiYCAACAOIRELIApBAWohCkEAKALQiYCAACEGIA8gCGoiCCAJTw0BIBEhDiAKIAZJDQALC0EAKALAiYCAACESAkAgCiAGTw0AAkACQCAGIAprQQNxIg0NACAKIQQMAQsgCiEEA0ACQCAERQ0AIBIgBWpBLDoAACAFQQFqIQULIARBAWohBCANQX9qIg0NAAsLIAogBmtBfEsNAANAAkAgBEUNACASIAVqQSw6AAAgBUEBaiEFCyASIAVqIg1BrNgAOwAAIA1BAmpBLDoAACAFQQNqIQUgBiAEQQRqIgRHDQALC0EAIQRBACAFQQFqNgLYiYCAACASIAVqQQo6AABBAEEAKALgiYCAAEEBajYC4ImAgAALIANBIGokgICAgAAgBAsWACAAIAEgA61CIIYgAq2EEI+AgIAACwvAAQEAQYAIC7gBAAAAAAAA8D8AAAAAAAAkQAAAAAAAAFlAAAAAAABAj0AAAAAAAIjDQAAAAAAAavhAAAAAAICELkEAAAAA0BJjQQAAAACE15dBAAAAAGXNzUEAAAAgX6ACQgAAAOh2SDdCAAAAopQabUIAAEDlnDCiQgAAkB7EvNZCAAA0JvVrDEMAgOA3ecNBQwCg2IVXNHZDAMhOZ23Bq0MAPZFg5FjhQ0CMtXgdrxVEUO/i1uQaS0SS1U0Gz/CARAD3AQRuYW1lAAgHc3Eud2FzbQHFAREACmZtdF9kb3VibGUBBWFsbG9jAgVzZXR1cAMHb3V0X2xlbgQJb3V0X3Jlc2V0BQlnZXRfYmxvYnMGCGdldF9yb3dzBwpnZXRfc3RhdHVzCAtnZXRfb3ZfcGFnZQkLZ2V0X292X2NlbGwKC2dldF9vdl9wbGVuCwpnZXRfb3Zfb2ZmDA9nZXRfb3Zfcm93aWRfbG8ND2dldF9vdl9yb3dpZF9oaQ4DcnVuDwtlbWl0X3JlY29yZBAMZW1pdF9wYXlsb2FkBxIBAA9fX3N0YWNrX3BvaW50ZXIJCgEABy5yb2RhdGEAOAlwcm9kdWNlcnMBDHByb2Nlc3NlZC1ieQEMVWJ1bnR1IGNsYW5nETE4LjEuMyAoMXVidW50dTEpADkPdGFyZ2V0X2ZlYXR1cmVzAysLYnVsay1tZW1vcnkrD211dGFibGUtZ2xvYmFscysIc2lnbi1leHQ='), (c) => c.charCodeAt(0));
async function isSqliteFile(f) { if (!f || f.size < 512) return false; const h = new Uint8Array(await f.slice(0, 16).arrayBuffer()); return String.fromCharCode(...h.subarray(0, 15)) === 'SQLite format 3'; }
async function sqliteOpen(file) {
  const S = makeSqlite(async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer())); const info = await S.open();
  let tables; try { tables = await S.tables(); } catch (e) { throw new Error('This SQLite file could not be read: ' + (e && e.message || e)); }
  if (!tables.length) throw new Error('This SQLite database has no tables with data to read.');
  return { S, info, tables };
}
async function sqliteList(file) {
  const { S, tables } = await sqliteOpen(file); const out = [];
  for (const t of tables) { let size = 0; try { size = (await S.leafPages(t.root)) * S.info.pageSize; } catch { size = 0; } out.push({ name: t.name, size }); }
  const best = out.reduce((a, b) => (b.size > a.size ? b : a), out[0]); return { entries: out, picked: best.name };
}
async function sqliteToCsvFile(file, wantTable) {
  const { S, info, tables } = await sqliteOpen(file); let pick = wantTable ? tables.find((t) => t.name === wantTable) : null;
  if (!pick) { let best = -1; for (const t of tables) { let n = 0; try { n = await S.leafPages(t.root); } catch { n = 0; } if (n > best) { best = n; pick = t; } } }
  const parts = []; let acc = [], accN = 0; const put = (b) => { acc.push(b); accN += b.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
  let st; const enc = new TextEncoder();
  try {
    if (!pick.withoutRowid && info.encoding === 1) st = await exportCsvFast(S, pick, SQ_WASM, put);
    else st = await S.exportCsv(pick, (s) => put(enc.encode(s)));
  } catch (e) { throw new Error('The SQLite file could not be read to the end (it may be damaged or cut short): ' + (e && e.message || e)); }
  if (acc.length) parts.push(new Blob(acc));
  if (!st.rows) throw new Error('The table "' + pick.name + '" has no rows.');
  return { file: new File(parts, String(file.name).replace(/\.[^.]*$/, '') + '-' + pick.name.replace(/[^A-Za-z0-9_-]+/g, '_') + '.csv', { type: 'text/csv' }), table: pick.name, tables: tables.length, rows: st.rows, blobs: st.blobs, wal: info.wal };
}
// ---- ODS (OpenDocument spreadsheet): content.xml streams through a wasm parser (ods.c) that writes one table as CSV (dates and times as ISO text, repeated rows and cells expanded, empty rows skipped); then the normal CSV import runs.
const isOds = (f) => /\.ods$/i.test(f.name || '');
const ODS_WASM = Uint8Array.from(atob('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AAVBOkcNASAFLQAGQewARw0BIAUtAAdB6QBHDQEgBS0ACEHuAEcNASAFLQAJQeUARw0BIAUtAApBLUcNASAFLQALQeIARw0BIAUtAAxB8gBHDQEgBS0ADUHlAEcNASAFLQAOQeEARw0BQQohAyAFLQAPQesARw0BCyACIAIoAgAiAEEBajYCACAAQdCRgIAAaiADOgAAC0EBIQMgBSAGakEBaiIAIAFJDQALCyADC5oFAQ5/I4CAgIAAQRBrIQECQEEAKAKoiYCAACICIABBACgC0JGIgAAiA2tBBHRqQTBqQQAoAoyJgIAATQ0AQQBBAjYCwImAgABBAA8LAkAgACADSQ0AQQAoAoiJgIAAIQQCQAJAQQAtALyJgIAARQ0AIARBB2ohBSABQXxqIQYgAUF/aiEHA0ACQAJAIAMNACACIQgMAQtBACACQQFqIgg2AqiJgIAAIAQgAmpBLDoAAAsCQAJAIAMgAEkNACADQQFqIQMgCCECDAELQQEhCUEAIQogA0EBaiIDIQsDQCABIApqIAsgC0EKbiIMQQpsa0EwcjoAACAJIg1BAWohCSAKQQFqIQogC0EKSSEOIAwhCyAORQ0ACyAEIAhqIgtB496xqwc2AAAgC0EGakHfADoAACALQQRqQe3cATsAACAIQQdqIQICQAJAIApBA3ENACAKIQ4MAQsgDUEDcSEMIAUgCGohDkEAIQsgByEJA0AgDiALaiAJIApqLQAAOgAAIAlBf2ohCSAMIAtBAWoiC0cNAAsgAiALaiECIAogC2shDgsCQCAKQX9qQQNJDQAgBCACaiEMIAYgDmohC0EAIQlBACAOayEOA0AgDCAJaiIKIAtBA2otAAA6AAAgCkEBaiALQQJqLQAAOgAAIApBAmogC0EBai0AADoAACAKQQNqIAstAAA6AAAgC0F8aiELIA4gCUEEaiIJag0ACyACIAlqIQILQQAgAjYCqImAgAALIAMgAE0NAAwCCwsgAEEBaiEJIAMhCwNAAkAgC0UNAEEAIAJBAWoiCjYCqImAgAAgBCACakEsOgAAIAohAgsgC0EBaiILIABNDQALIANBAWoiCyAJIAsgCUsbIQMLQQAgAzYC0JGIgAALQQELC4YBAQBBgAgLf1RSVUUARkFMU0UAPC90YWJsZTp0YWJsZS1jZWxsPgA8L3RhYmxlOmNvdmVyZWQtdGFibGUtY2VsbD4AIG9mZmljZTpib29sZWFuLXZhbHVlPSIAIG9mZmljZTpzdHJpbmctdmFsdWU9IgAgb2ZmaWNlOnRpbWUtdmFsdWU9IgAA2QEEbmFtZQAJCG9kcy53YXNtAaYBEAAFYWxsb2MBBXNldHVwAg1nZXRfbmFtZXNfbGVuAwlnZXRfdHJvd3MEB291dF9sZW4FCW91dF9yZXNldAYIZ2V0X3Jvd3MHCWdldF93aWR0aAgLZ2V0X2Ryb3BwZWQJCmdldF9zdGF0dXMKCmdldF90YWJsZXMLB3Byb2Nlc3MMCnVuZXNjX2ludG8NBGF0dHIOCWNlbGxfdGV4dA8HZmlsbF90bwcSAQAPX19zdGFja19wb2ludGVyCQoBAAcucm9kYXRhADgJcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBDFVidW50dSBjbGFuZxExOC4xLjMgKDF1YnVudHUxKQA5D3RhcmdldF9mZWF0dXJlcwMrC2J1bGstbWVtb3J5Kw9tdXRhYmxlLWdsb2JhbHMrCHNpZ24tZXh0'), (c) => c.charCodeAt(0));
async function odsStream(file, wantName, listOnly, onChunkOut) {
  const names0 = (await unzipFile(file, null, true)).entries.map((x) => x.name); if (!names0.some((x) => x.name === 'content.xml' || x === 'content.xml')) throw new Error('This is not an OpenDocument spreadsheet: content.xml is missing.');
  const z = await unzipFile(file, 'content.xml', false, true), X = new WebAssembly.Instance(new WebAssembly.Module(ODS_WASM), {}).exports, enc = new TextEncoder();
  const CAP = 12 << 20, OUTCAP = 16 << 20, INCAP = CAP + (6 << 20), inp = X.alloc(INCAP), out = X.alloc(OUTCAP), nm = X.alloc(65536), wb = enc.encode(wantName || ''), wp = X.alloc(wb.length + 1);
  new Uint8Array(X.memory.buffer).set(wb, wp); X.setup(inp, out, OUTCAP, listOnly ? 0xFFFFFFFF : 0, 0, nm, wp, wb.length);
  const rd = z.stream.getReader(); let fill = 0;
  const run = (final) => { let p = 0; for (;;) { p = X.process(p, fill, final ? 1 : 0); const n = X.out_len(); if (n) { if (onChunkOut) onChunkOut(new Uint8Array(X.memory.buffer, out, n).slice()); X.out_reset(); } const s = X.get_status(); if (s === 2) throw new Error('A cell or row in this spreadsheet is too large to read.'); if (s !== 1) break; } if (p < fill) new Uint8Array(X.memory.buffer).copyWithin(inp, inp + p, inp + fill); fill -= p; };
  for (;;) { const { done, value } = await rd.read(); if (done) break; if (fill + value.length > INCAP) throw new Error('A row in this spreadsheet is larger than ' + (CAP >> 20) + ' MB.'); new Uint8Array(X.memory.buffer).set(value, inp + fill); fill += value.length; if (fill >= (4 << 20)) run(false); }
  run(true);
  const raw = new TextDecoder().decode(new Uint8Array(X.memory.buffer, nm, X.get_names_len())).split('\0').filter(Boolean).map(xlUnescape), trows = raw.map((_, i) => X.get_trows(i));
  return { names: raw, trows, rows: X.get_rows(), width: X.get_width(), dropped: X.get_dropped() };
}
async function odsList(file) { const r = await odsStream(file, '', true); let best = 0; r.trows.forEach((n, i) => { if (n > r.trows[best]) best = i; }); return { entries: r.names.map((n) => ({ name: n, size: -1 })), picked: r.names[best], kind: 'Sheet' }; }
async function odsToCsvFile(file, wantSheet) {
  const parts = []; let acc = [], accN = 0; const put = (b) => { acc.push(b); accN += b.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
  let r = await odsStream(file, wantSheet, false, put);
  if (!r.rows && !wantSheet && r.names.length > 1) {   // the first table is empty: take the first table that has rows
    for (let i = 1; i < r.names.length && !r.rows; i++) { parts.length = 0; acc = []; accN = 0; r = await odsStream(file, r.names[i], false, put); if (r.rows) { r.sheet = r.names[i]; break; } }
  }
  if (acc.length) parts.push(new Blob(acc));
  if (!r.rows) throw new Error('The spreadsheet has no data.');
  return { file: new File(parts, String(file.name).replace(/\.ods$/i, '') + '.csv', { type: 'text/csv' }), sheet: wantSheet || r.sheet || r.names[0], sheets: r.names.length, rows: r.rows, width: r.width, dropped: r.dropped };
}
// ---- GeoJSON: a FeatureCollection becomes one row per feature (properties as columns, longitude/latitude for points, other geometry as JSON text), then the NDJSON import runs.
async function geoStage(m) {
  if (!m.file || !/\.(geojson|json)$/i.test(m.file.name || '')) return null;
  const h1 = new Uint8Array(await m.file.slice(0, 1 << 20).arrayBuffer()), lat = new TextDecoder('latin1').decode(h1);
  if (lat.indexOf('"FeatureCollection"') < 0) return null; const mm = /"features"\s*:\s*\[/.exec(lat); if (!mm) return null;
  const arrStart = mm.index + mm[0].length - 1, f = flatTransform(), dec = new TextDecoder(), enc = new TextEncoder(), parts = []; let acc = [], accN = 0, off = 0, n = 0, pts = 0, other = 0;
  const put = (s) => { if (!s) return; const e = enc.encode(s); acc.push(e); accN += e.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
  const conv = (line) => {
    if (!line) return ''; const o = JSON.parse(line), r = {};
    for (const k in o) {
      const v = o[k];
      if (k === 'type' || k === 'properties' || k === 'geometry') continue;
      if (k.startsWith('properties.')) { r[k.slice(11)] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v; }
      else if (k === 'geometry.type') r.geometry_type = v;
      else if (k === 'geometry.coordinates') { if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') { if (!('longitude' in r)) r.longitude = v[0]; if (!('latitude' in r)) r.latitude = v[1]; pts++; } else if (v !== null) { r.geometry = JSON.stringify(v); other++; } }
      else if (k.startsWith('geometry.')) { r[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v; }
      else r[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    }
    n++; return JSON.stringify(r) + '\n';
  };
  const rd = m.file.stream().getReader();
  for (;;) {
    const { done, value } = await rd.read(); if (done) break; let chunk = value;
    if (off + chunk.length <= arrStart) { off += chunk.length; continue; } if (off < arrStart) chunk = chunk.subarray(arrStart - off); off += value.length;
    let o = ''; const out = f(chunk); if (out.length) { const lines = dec.decode(out).split('\n'); for (const l of lines) o += conv(l); } put(o); if (f.finished()) break;
  }
  if (acc.length) parts.push(new Blob(acc)); if (!n) return null;
  return { file: new File(parts, String(m.file.name).replace(/\.[^.]*$/, '') + '.ndjson', { type: 'application/x-ndjson' }), text: 'Read ' + n.toLocaleString('en-US') + ' GeoJSON features: properties became columns' + (pts ? ', point coordinates became longitude and latitude' : '') + (other ? ', and other geometry was kept as JSON text in the geometry column' : '') + '.' };
}
// ---- XML: the repeating element with the most fields is the record (attributes become @name columns, child elements columns, nested ones dotted); the file becomes CSV, then the normal import runs.
// XML record-per-element to CSV: the repeating element with the most fields is the record; attributes become @name columns, child elements become columns (nested ones dotted).
const XTAG = /<(?:(\/)?([^\s>\/!?][^\s>\/]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/)?>|!--[\s\S]*?-->|!\[CDATA\[([\s\S]*?)\]\]>|\?[\s\S]*?\?>|![^>]*>)/g;
const XATTR = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function xmlUnesc(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, g) => g === 'amp' ? '&' : g === 'lt' ? '<' : g === 'gt' ? '>' : g === 'quot' ? '"' : g === 'apos' ? "'" : String.fromCodePoint(g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)));
}
const xmlCsvq = (s) => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
function xmlCut(text, final) {   // end of the part of text that holds only whole tags
  if (final) return text.length;
  let cut = text.lastIndexOf('>') + 1; if (cut <= 0) return 0;
  const c1 = text.lastIndexOf('<!--'); if (c1 >= 0 && text.indexOf('-->', c1) < 0) cut = Math.min(cut, c1);
  const c2 = text.lastIndexOf('<![CDATA['); if (c2 >= 0 && text.indexOf(']]>', c2) < 0) cut = Math.min(cut, c2);
  const lt = text.lastIndexOf('<'); if (lt >= cut) { /* an unfinished tag after the last '>' stays in the carry */ }
  return cut;
}
// Pass over text; calls h.open(name, attrsString, selfClosing, depth), h.close(name, depth), h.text(str)
function xmlScan(text, h) {
  XTAG.lastIndex = 0; let m, last = 0;
  while ((m = XTAG.exec(text))) {
    if (m.index > last) h.text(text.slice(last, m.index)); last = XTAG.lastIndex;
    if (m[2] !== undefined) { if (m[1]) h.close(m[2]); else { h.open(m[2], m[3], !!m[4]); if (m[4]) h.close(m[2]); } }
    else if (m[5] !== undefined) h.text(m[5], true);
  }
  if (last < text.length) h.text(text.slice(last));
}
function xmlPlan(text) {   // -> { path: [names], count, fields } or null
  const stack = [], info = new Map(); let sawChild = [];
  const h = {
    open(name, attrs) {
      const p = '/' + stack.concat(name).join('/'); let e = info.get(p); if (!e) { e = { count: 0, fields: new Set(), depth: stack.length + 1 }; info.set(p, e); } e.count++;
      if (stack.length) { const pp = '/' + stack.join('/'); const pe = info.get(pp); if (pe) pe.fields.add(name); }
      if (attrs && attrs.trim()) { XATTR.lastIndex = 0; let a; while ((a = XATTR.exec(attrs))) e.fields.add('@' + a[1]); }
      stack.push(name);
    },
    close() { stack.pop(); }, text() {},
  };
  xmlScan(text, h);
  let best = null;
  for (const [p, e] of info) { if (e.count < 2 || e.fields.size < 2 || e.depth < 2 && info.size > 1 && false) continue; if (!best || e.count > best.e.count || (e.count === best.e.count && e.depth < best.e.depth)) best = { p, e }; }
  if (!best) for (const [p, e] of info) { if (e.count >= 2 && (!best || e.count > best.e.count || (e.count === best.e.count && e.depth < best.e.depth))) best = { p, e }; }
  if (!best) return null; return { path: best.p.split('/').slice(1), count: best.e.count, fields: best.e.fields.size };
}
// Streaming converter: feed(text) -> CSV text; columns are fixed after the first `sampleRecords` records unless cols is given.
function makeXmlConverter(plan, cols) {
  const rp = plan.path, rd = rp.length; const stack = []; let inRec = false, rec = null, leafText = '', hasChild = [], names = cols ? cols.slice() : [], idx = new Map(); names.forEach((n, i) => idx.set(n, i));
  const st = { records: 0, dropped: 0, late: 0 }; const frozen = !!cols; let headerDone = !!cols, buf = [], pending = [];
  const key = () => stack.slice(rd).join('.');
  const setv = (k, v) => { let i = idx.get(k); if (i === undefined) { if (frozen) { st.dropped++; return; } if (headerDone) st.late++; i = names.length; names.push(k); idx.set(k, i); } const cur = rec[i]; rec[i] = cur === undefined ? v : cur + ' | ' + v; };
  const h = {
    open(name, attrs, selfClosing) {
      stack.push(name);
      if (!inRec) { if (stack.length === rd && rp.every((n, i) => stack[i] === n)) { inRec = true; rec = []; hasChild = [false]; leafText = ''; } else return; }
      else { hasChild[hasChild.length - 1] = true; hasChild.push(false); leafText = ''; }
      const base = stack.length === rd ? '' : key();
      if (attrs && attrs.trim()) { XATTR.lastIndex = 0; let a; while ((a = XATTR.exec(attrs))) setv((base ? base : '') + '@' + a[1], xmlUnesc(a[2] !== undefined ? a[2] : a[3])); }
    },
    close() {
      if (inRec) {
        const depth = stack.length, isLeaf = !hasChild[hasChild.length - 1];
        if (depth === rd) { if (isLeaf && leafText.trim()) setv('value', leafText.trim()); emitRec(); inRec = false; rec = null; }
        else { if (isLeaf) { const t = leafText.trim(); if (t) setv(key(), xmlUnesc(t)); } hasChild.pop(); }
        leafText = '';
      }
      stack.pop();
    },
    text(s, cdata) { if (inRec) leafText += cdata ? s : (s.indexOf('&') < 0 ? s : xmlUnesc(s)); },
  };
  function emitRec() { st.records++; if (!headerDone && st.records >= 2000) { /* freeze columns after the sample */ } pending.push(rec); if (!headerDone && pending.length >= 2000) { headerDone = true; flushPending(); } else if (headerDone) flushPending(); }
  let headerOut = false;
  function flushPending() {
    let out = ''; if (!headerOut) { out += names.map(csvq).join(',') + '\n'; headerOut = true; }
    const n = names.length; for (const r of pending) { let line = ''; for (let i = 0; i < n; i++) { if (i) line += ','; const v = r[i]; if (v !== undefined) line += xmlCsvq(v); } out += line + '\n'; } pending = []; buf.push(out);
  }
  let carry = '';
  return {
    feed(text, final) { text = carry + text; const cut = xmlCut(text, final); carry = text.slice(cut); xmlScan(text.slice(0, cut), h); if (final && !headerDone) { headerDone = true; flushPending(); } const o = buf.join(''); buf = []; return o; },
    stats: st, names: () => names,
  };
}

async function xmlStage(m) {
  if (!m.file || !/\.xml$/i.test(m.file.name || '')) return null;
  const head = new Uint8Array(await m.file.slice(0, 4 << 20).arrayBuffer()); let label = 'utf-8'; const h0 = new TextDecoder('latin1').decode(head.subarray(0, 200)), em = /encoding\s*=\s*["']([A-Za-z0-9_.:-]+)["']/.exec(h0);
  if (em) { try { new TextDecoder(em[1]); label = em[1]; } catch { label = 'utf-8'; } }
  let sample = new TextDecoder(label).decode(head); sample = sample.slice(0, sample.lastIndexOf('>') + 1);
  const plan = xmlPlan(sample); if (!plan) throw new Error('No repeating element was found in this XML file, so there are no records to read.');
  const pass = async (cols) => {
    const c = makeXmlConverter(plan, cols), dec = new TextDecoder(label), enc = new TextEncoder(), parts = []; let acc = [], accN = 0;
    const put = (s) => { if (!s) return; const e = enc.encode(s); acc.push(e); accN += e.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
    const rd = m.file.stream().getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; put(c.feed(dec.decode(value, { stream: true }), false)); }
    put(c.feed(dec.decode(), true)); if (acc.length) parts.push(new Blob(acc)); return { c, parts };
  };
  let r = await pass(null); if (r.c.stats.late) r = await pass(r.c.names());   // columns that first appear late in the file: read again with the full list
  if (!r.c.stats.records) throw new Error('No records could be read from this XML file.');
  return { file: new File(r.parts, String(m.file.name).replace(/\.[^.]*$/, '') + '.csv', { type: 'text/csv' }), text: 'Read ' + r.c.stats.records.toLocaleString('en-US') + ' <' + plan.path[plan.path.length - 1] + '> records from the XML file (the repeating element with the most fields). Attributes are columns starting with @, nested elements use dotted names.' };
}
// ---- Apache Arrow IPC (Feather 2, .arrow files and streams): flat columns are decoded in wasm (arrow.c) and written as CSV; LZ4-compressed buffers are unpacked there too; then the normal CSV import runs.
// Arrow IPC (file, Feather v2, stream) -> CSV using arrow.wasm. readBlock(offset, length) -> Promise<Uint8Array>; size = file size.
function makeFB(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u8 = (p) => b[p], i16 = (p) => dv.getInt16(p, true), u16 = (p) => dv.getUint16(p, true), i32 = (p) => dv.getInt32(p, true), u32 = (p) => dv.getUint32(p, true), i64 = (p) => Number(dv.getBigInt64(p, true));
  const root = () => u32(0);
  const field = (tp, i) => { const vt = tp - i32(tp), vs = u16(vt); const o = 4 + 2 * i; if (o >= vs) return 0; const f = u16(vt + o); return f ? tp + f : 0; };
  const tbl = (fp) => fp + u32(fp);   // follow an offset field
  const str = (fp) => { const s = fp + u32(fp), n = u32(s); return new TextDecoder().decode(b.subarray(s + 4, s + 4 + n)); };
  const vec = (fp) => { const v = fp + u32(fp); return { n: u32(v), at: v + 4 }; };
  return { u8, i16, u16, i32, u32, i64, root, field, tbl, str, vec };
}
function parseSchema(F, st) {
  const fields = F.field(st, 1); const out = []; if (!fields) return out; const v = F.vec(fields);
  for (let i = 0; i < v.n; i++) {
    const fp = F.tbl(v.at + 4 * i), nm = F.field(fp, 0), tt = F.field(fp, 2), ty = F.field(fp, 3), di = F.field(fp, 4), ch = F.field(fp, 5);
    const f = { name: nm ? F.str(nm) : '', type: tt ? F.u8(tt) : 0, dictId: null, children: ch ? F.vec(ch).n : 0 };
    if (ty) { const t = F.tbl(ty); f.t = t; }
    if (di) { const d = F.tbl(di); const idp = F.field(d, 0); f.dictId = idp ? F.i64(idp) : 0; const ip = F.field(d, 1); if (ip) { const it = F.tbl(ip), bw = F.field(it, 0), sg = F.field(it, 1); f.idxBits = bw ? F.i32(bw) : 32; f.idxSigned = sg ? F.u8(sg) !== 0 : false; f.idxSigned = sg ? !!F.u8(sg) : false; } else { f.idxBits = 32; f.idxSigned = true; } }
    out.push({ f, F });
  }
  return out;
}
const K = { I8: 1, I16: 2, I32: 3, I64: 4, U8: 5, U16: 6, U32: 7, U64: 8, F32: 9, F64: 10, BOOL: 11, UTF8: 12, LUTF8: 13, D32: 14, D64: 15, TS: 16, T32: 17, T64: 18, DEC: 19, NULL: 20, DICT: 21 };
function colKind(F, f) {   // -> { kind, aux, flags, nbuf } or throws
  const T = f.type, t = f.t; let kind, aux = 0, flags = 0, nbuf = 2;
  if (f.children) throw new Error('Column "' + f.name + '" is a nested type (list, struct or map); only flat columns are supported yet.');
  const intKind = (bits, signed) => ({ 8: signed ? K.I8 : K.U8, 16: signed ? K.I16 : K.U16, 32: signed ? K.I32 : K.U32, 64: signed ? K.I64 : K.U64 })[bits];
  if (T === 2) { const bw = F.field(t, 0), sg = F.field(t, 1); kind = intKind(bw ? F.i32(bw) : 32, sg ? !!F.u8(sg) : false); }
  else if (T === 3) { const p = F.field(t, 0); const pr = p ? F.i16(p) : 0; if (pr === 1) kind = K.F32; else if (pr === 2) kind = K.F64; else throw new Error('Column "' + f.name + '" is a 16-bit float, which is not supported yet.'); }
  else if (T === 5) { kind = K.UTF8; nbuf = 3; } else if (T === 20) { kind = K.LUTF8; nbuf = 3; }
  else if (T === 6) kind = K.BOOL;
  else if (T === 8) { const u = F.field(t, 0); kind = (u ? F.i16(u) : 1) === 0 ? K.D32 : K.D64; }
  else if (T === 10) { kind = K.TS; const u = F.field(t, 0); aux = u ? F.i16(u) : 0; if (F.field(t, 1)) flags = 1; }
  else if (T === 9) { const u = F.field(t, 0), bw = F.field(t, 1); aux = u ? F.i16(u) : 1; kind = (bw ? F.i32(bw) : 32) === 32 ? K.T32 : K.T64; }
  else if (T === 7) { const sc = F.field(t, 1), bw = F.field(t, 2); if ((bw ? F.i32(bw) : 128) !== 128) throw new Error('Column "' + f.name + '" is a 256-bit decimal, which is not supported yet.'); kind = K.DEC; aux = sc ? F.i32(sc) : 0; }
  else if (T === 1) { kind = K.NULL; nbuf = 0; }
  else if (T === 4 || T === 19 || T === 15) { kind = K.NULL; nbuf = T === 15 ? 2 : 3; }   // binary: left empty
  else throw new Error('Column "' + f.name + '" has an Arrow type that is not supported yet (type code ' + T + ').');
  return { kind, aux, flags, nbuf };
}
async function arrowToCsv(readBlock, size, wasmBytes, put, zstd) {
  let X; const inst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), { env: {
    fmt_double: (x, dst) => { const s = String(x); const m = new Uint8Array(X.memory.buffer, dst, s.length + 1); for (let i = 0; i < s.length; i++) m[i] = s.charCodeAt(i); return s.length; },
    fmt_float: (x, dst) => { let s = String(x); for (let p = 1; p <= 9; p++) { const t = x.toPrecision(p); if (Math.fround(Number(t)) === x) { s = String(Number(t)); break; } } const m = new Uint8Array(X.memory.buffer, dst, s.length + 1); for (let i = 0; i < s.length; i++) m[i] = s.charCodeAt(i); return s.length; },
  } }); X = inst.exports;
  const enc = new TextEncoder(); let pos = 0;
  const head = await readBlock(0, 8); if (String.fromCharCode(...head.subarray(0, 6)) === 'ARROW1') pos = 8; else if (head.length >= 4 && String.fromCharCode(...head.subarray(0, 4)) === 'FEA1') throw new Error('This is a Feather version 1 file; save it as Feather version 2 (Arrow IPC) or CSV.'); else if (!(head[0] === 255 && head[1] === 255 && head[2] === 255 && head[3] === 255)) throw new Error('This is not an Arrow IPC, Feather 2 or Arrow stream file.');
  let schema = null, cols = null; const dicts = new Map(); let OUTCAP = 16 << 20, out = 0, arenaCap = 0, arena = 0, descPtr = 0; let rowsTotal = 0, headerDone = false;
  const flush = () => { const n = X.out_len(); if (n) { put(new Uint8Array(X.memory.buffer, out, n).slice()); X.out_reset(); } };
  const ensureArena = (n) => { if (n > arenaCap) { arenaCap = Math.max(n + (n >> 2), 1 << 20); arena = X.alloc(arenaCap); } };
  async function readMsg() {
    if (pos + 8 > size) return null; const h = await readBlock(pos, 8); let ml = new DataView(h.buffer, h.byteOffset).getInt32(0, true), at = pos + 4; if (ml === -1) { ml = new DataView(h.buffer, h.byteOffset).getInt32(4, true); at = pos + 8; } if (ml <= 0) return null;
    const meta = await readBlock(at, ml), F = makeFB(meta), mp = F.root(), htp = F.field(mp, 1), hp = F.field(mp, 2), bl = F.field(mp, 3);
    const m = { F, type: htp ? F.u8(htp) : 0, hdr: hp ? F.tbl(hp) : 0, bodyLen: bl ? F.i64(bl) : 0, bodyAt: at + ml };
    pos = m.bodyAt + m.bodyLen; return m;
  }
  function batchInfo(F, rb) {
    const lp = F.field(rb, 0), np = F.field(rb, 1), bp = F.field(rb, 2), cp = F.field(rb, 3); const nodes = [], bufs = [];
    if (np) { const v = F.vec(np); for (let i = 0; i < v.n; i++) nodes.push({ len: F.i64(v.at + 16 * i), nulls: F.i64(v.at + 16 * i + 8) }); }
    if (bp) { const v = F.vec(bp); for (let i = 0; i < v.n; i++) bufs.push({ off: F.i64(v.at + 16 * i), len: F.i64(v.at + 16 * i + 8) }); }
    let codec = -1; if (cp) { const c = F.tbl(cp), cd = F.field(c, 0); codec = cd ? (F.u8(cd) << 24 >> 24) : 0; }
    return { len: lp ? F.i64(lp) : 0, nodes, bufs, codec };
  }
  async function loadBody(m, info) {   // body bytes of every buffer, decompressed into the wasm arena: returns pointers
    const body = await readBlock(m.bodyAt, m.bodyLen); const ptrs = [];
    if (info.codec < 0) { ensureArena(m.bodyLen + 64); new Uint8Array(X.memory.buffer).set(body, arena); for (const b of info.bufs) ptrs.push({ p: arena + b.off, n: b.len }); return ptrs; }
    if (info.codec !== 0 && !(info.codec === 1 && zstd)) throw new Error('This Arrow file uses a compression this reader does not know.');
    // each compressed buffer: int64 uncompressed length, then an LZ4 frame (length -1: stored raw)
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength); let total = 0; const un = info.bufs.map((b) => { if (!b.len) return 0; const u = Number(dv.getBigInt64(b.off, true)); const n = u < 0 ? b.len - 8 : u; total += (n + 15) & ~15; return n; });
    ensureArena(total + body.length + 64); const bodyPtr = arena + total; new Uint8Array(X.memory.buffer).set(body, bodyPtr); let w = arena;
    info.bufs.forEach((b, i) => { if (!b.len) { ptrs.push({ p: w, n: 0 }); return; } const u = Number(dv.getBigInt64(b.off, true)); if (u < 0) { new Uint8Array(X.memory.buffer).copyWithin(w, bodyPtr + b.off + 8, bodyPtr + b.off + b.len); } else if (u > 0) { if (info.codec === 1) { let v; try { v = zstd(body.subarray(b.off + 8, b.off + b.len), u); } catch { throw new Error('A compressed buffer in this Arrow file could not be unpacked (ZSTD).'); } new Uint8Array(X.memory.buffer).set(v, w); } else { const r = X.lz4f(bodyPtr + b.off + 8, b.len - 8, w, u); if (r !== u) throw new Error('A compressed buffer in this Arrow file could not be unpacked (LZ4).'); } } ptrs.push({ p: w, n: un[i] }); w += (un[i] + 15) & ~15; });
    return ptrs;
  }
  for (;;) {
    const m = await readMsg(); if (!m) break;
    if (m.type === 1) {   // schema
      const fl = parseSchema(m.F, m.hdr); cols = fl.map((x) => ({ f: x.f, F: x.F, ck: null })); cols.forEach((c) => { c.ck = colKind(c.F, c.f); });
      if (!cols.length) throw new Error('This Arrow file has no columns.'); schema = cols;
      const names = cols.map((c) => (/[",\r\n]/.test(c.f.name) ? '"' + c.f.name.replace(/"/g, '""') + '"' : c.f.name)); put(enc.encode(names.join(',') + '\n')); headerDone = true;
      out = X.alloc(OUTCAP); descPtr = X.alloc(40 * cols.length + 64); X.setup(out, OUTCAP, descPtr, cols.length);
    } else if (m.type === 2) {   // dictionary batch: utf8 values only
      const F = m.F, idp = F.field(m.hdr, 0), dp = F.field(m.hdr, 1), dl = F.field(m.hdr, 2); if (dl && F.u8(dl)) throw new Error('This Arrow file uses delta dictionaries, which are not supported yet.');
      const id = idp ? F.i64(idp) : 0, info = batchInfo(F, F.tbl(dp)), ptrs = await loadBody(m, info), col = schema.find((c) => c.f.dictId === id);
      const vt = col && col.f; // value type comes from the dictionary field's own type (the schema field type is the value type)
      const kind = col ? col.ck : null; if (!col) continue;
      if (!(col.ck.kind === K.UTF8 || col.ck.kind === K.LUTF8)) throw new Error('Column "' + col.f.name + '" is dictionary-encoded with non-text values, which is not supported yet.');
      const nb = col.ck.nbuf, p = ptrs; const keep = X.alloc(p[1].n + p[2].n + 64); const offKeep = keep, datKeep = keep + ((p[1].n + 15) & ~15);
      new Uint8Array(X.memory.buffer).copyWithin(offKeep, p[1].p, p[1].p + p[1].n); new Uint8Array(X.memory.buffer).copyWithin(datKeep, p[2].p, p[2].p + p[2].n);
      dicts.set(id, { offs: offKeep, data: datKeep, n: info.len, large: col.ck.kind === K.LUTF8 });
    } else if (m.type === 3) {   // record batch
      const F = m.F, info = batchInfo(F, m.hdr), ptrs = await loadBody(m, info); let bi = 0; const dv32 = new Uint32Array(X.memory.buffer, descPtr, 10 * cols.length);
      cols.forEach((c, i) => {
        const ck = c.ck, node = info.nodes[i] || { len: info.len, nulls: 0 }; const d = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; const take = (n) => { const r = []; for (let k = 0; k < n; k++) r.push(ptrs[bi++]); return r; };
        let kind = ck.kind, aux = ck.aux, nb = ck.nbuf; if (c.f.dictId !== null) { const dc = dicts.get(c.f.dictId); if (!dc) throw new Error('A dictionary for column "' + c.f.name + '" is missing.'); const ik = ({ 8: c.f.idxSigned ? K.I8 : K.U8, 16: c.f.idxSigned ? K.I16 : K.U16, 32: c.f.idxSigned ? K.I32 : K.U32, 64: c.f.idxSigned ? K.I64 : K.U64 })[c.f.idxBits]; d[6] = dc.offs; d[7] = dc.data; d[8] = dc.n; d[9] = dc.large ? 1 : 0; kind = K.DICT; aux = ik; nb = 2; }
        const bufs = take(nb); d[0] = kind; d[1] = aux; d[2] = ck.flags; d[3] = node.nulls > 0 && bufs[0] && bufs[0].n ? bufs[0].p : 0;
        if (kind === K.NULL) { } else if (kind === K.UTF8 || kind === K.LUTF8) { d[5] = bufs[1].p; d[4] = bufs[2].p; } else d[4] = bufs[1] ? bufs[1].p : 0;
        for (let k = 0; k < 10; k++) dv32[10 * i + k] = d[k];
      });
      let r = 0; for (;;) { r = X.rows(r, info.len); flush(); const s = X.get_status(); if (s === 2) throw new Error('A value in this Arrow file is too large to convert.'); if (s !== 1) break; }
      rowsTotal += info.len;
    }
  }
  if (!headerDone) throw new Error('No schema was found in this Arrow file.'); return { rows: rowsTotal, columns: cols.length };
}

const ARROW_WASM = Uint8Array.from(atob('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'), (c) => c.charCodeAt(0));
async function isArrowFile(f) { if (!f || f.size < 16) return false; const h = new Uint8Array(await f.slice(0, 8).arrayBuffer()); return String.fromCharCode(...h.subarray(0, 6)) === 'ARROW1' || (h[0] === 255 && h[1] === 255 && h[2] === 255 && h[3] === 255); }
async function arrowToCsvFile(file) {
  const parts = []; let acc = [], accN = 0; const put = (b) => { acc.push(b); accN += b.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
  const r = await arrowToCsv(async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer()), file.size, ARROW_WASM, put, (src, n) => { pqInit(); return pqInfl(src, n); });
  if (acc.length) parts.push(new Blob(acc)); if (!r.rows) throw new Error('This Arrow file has no rows.');
  return { file: new File(parts, String(file.name).replace(/\.[^.]*$/, '') + '.csv', { type: 'text/csv' }), rows: r.rows, columns: r.columns };
}
const DBF_CP = {"437": "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0", "850": "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00f8\u00a3\u00d8\u00d7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u00ae\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u00c1\u00c2\u00c0\u00a9\u2563\u2551\u2557\u255d\u00a2\u00a5\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u00e3\u00c3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u00a4\u00f0\u00d0\u00ca\u00cb\u00c8\u0131\u00cd\u00ce\u00cf\u2518\u250c\u2588\u2584\u00a6\u00cc\u2580\u00d3\u00df\u00d4\u00d2\u00f5\u00d5\u00b5\u00fe\u00de\u00da\u00db\u00d9\u00fd\u00dd\u00af\u00b4\u00ad\u00b1\u2017\u00be\u00b6\u00a7\u00f7\u00b8\u00b0\u00a8\u00b7\u00b9\u00b3\u00b2\u25a0\u00a0", "852": "\u00c7\u00fc\u00e9\u00e2\u00e4\u016f\u0107\u00e7\u0142\u00eb\u0150\u0151\u00ee\u0179\u00c4\u0106\u00c9\u0139\u013a\u00f4\u00f6\u013d\u013e\u015a\u015b\u00d6\u00dc\u0164\u0165\u0141\u00d7\u010d\u00e1\u00ed\u00f3\u00fa\u0104\u0105\u017d\u017e\u0118\u0119\u00ac\u017a\u010c\u015f\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u00c1\u00c2\u011a\u015e\u2563\u2551\u2557\u255d\u017b\u017c\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u0102\u0103\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u00a4\u0111\u0110\u010e\u00cb\u010f\u0147\u00cd\u00ce\u011b\u2518\u250c\u2588\u2584\u0162\u016e\u2580\u00d3\u00df\u00d4\u0143\u0144\u0148\u0160\u0161\u0154\u00da\u0155\u0170\u00fd\u00dd\u0163\u00b4\u00ad\u02dd\u02db\u02c7\u02d8\u00a7\u00f7\u00b8\u00b0\u00a8\u02d9\u0171\u0158\u0159\u25a0\u00a0", "857": "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u0131\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u0130\u00d6\u00dc\u00f8\u00a3\u00d8\u015e\u015f\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u011e\u011f\u00bf\u00ae\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u00c1\u00c2\u00c0\u00a9\u2563\u2551\u2557\u255d\u00a2\u00a5\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u00e3\u00c3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u00a4\u00ba\u00aa\u00ca\u00cb\u00c8\ufffd\u00cd\u00ce\u00cf\u2518\u250c\u2588\u2584\u00a6\u00cc\u2580\u00d3\u00df\u00d4\u00d2\u00f5\u00d5\u00b5\ufffd\u00d7\u00da\u00db\u00d9\u00ec\u00ff\u00af\u00b4\u00ad\u00b1\ufffd\u00be\u00b6\u00a7\u00f7\u00b8\u00b0\u00a8\u00b7\u00b9\u00b3\u00b2\u25a0\u00a0", "860": "\u00c7\u00fc\u00e9\u00e2\u00e3\u00e0\u00c1\u00e7\u00ea\u00ca\u00e8\u00cd\u00d4\u00ec\u00c3\u00c2\u00c9\u00c0\u00c8\u00f4\u00f5\u00f2\u00da\u00f9\u00cc\u00d5\u00dc\u00a2\u00a3\u00d9\u20a7\u00d3\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u00d2\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0", "861": "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00d0\u00f0\u00de\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00fe\u00fb\u00dd\u00fd\u00d6\u00dc\u00f8\u00a3\u00d8\u20a7\u0192\u00e1\u00ed\u00f3\u00fa\u00c1\u00cd\u00d3\u00da\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0", "863": "\u00c7\u00fc\u00e9\u00e2\u00c2\u00e0\u00b6\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u2017\u00c0\u00a7\u00c9\u00c8\u00ca\u00f4\u00cb\u00cf\u00fb\u00f9\u00a4\u00d4\u00dc\u00a2\u00a3\u00d9\u00db\u0192\u00a6\u00b4\u00f3\u00fa\u00a8\u00b8\u00b3\u00af\u00ce\u2310\u00ac\u00bd\u00bc\u00be\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0", "865": "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00f8\u00a3\u00d8\u20a7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00a4\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0", "737": "\u0391\u0392\u0393\u0394\u0395\u0396\u0397\u0398\u0399\u039a\u039b\u039c\u039d\u039e\u039f\u03a0\u03a1\u03a3\u03a4\u03a5\u03a6\u03a7\u03a8\u03a9\u03b1\u03b2\u03b3\u03b4\u03b5\u03b6\u03b7\u03b8\u03b9\u03ba\u03bb\u03bc\u03bd\u03be\u03bf\u03c0\u03c1\u03c3\u03c2\u03c4\u03c5\u03c6\u03c7\u03c8\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03c9\u03ac\u03ad\u03ae\u03ca\u03af\u03cc\u03cd\u03cb\u03ce\u0386\u0388\u0389\u038a\u038c\u038e\u038f\u00b1\u2265\u2264\u03aa\u03ab\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0"};
// ---- dBase / FoxPro (.dbf): fixed-width records behind a field table. Rows are rewritten as CSV bytes (deleted rows skipped, memo columns left out), then the normal CSV import runs.
// Reads through readBlock(offset, length) -> Promise<Uint8Array>.
const DBF_LANG = { 1: '437', 2: '850', 3: '1252', 4: 'macintosh', 8: '865', 9: '437', 10: '850', 11: '437', 13: '437', 14: '850', 15: '437', 16: '850', 17: '437', 18: '850', 19: 'shift_jis', 20: '850', 21: '437', 22: '850', 23: '865', 24: '437', 25: '437', 26: '850', 27: '437', 28: '863', 29: '850', 31: '852', 34: '852', 35: '852', 36: '860', 37: '850', 38: '866', 55: '850', 64: '852', 77: 'gbk', 78: 'euc-kr', 79: 'big5', 80: 'windows-874', 87: '1252', 88: '1252', 89: '1252', 100: '852', 101: '866', 102: '865', 103: '861', 106: '737', 107: '857', 108: '863', 120: 'big5', 121: 'euc-kr', 122: 'gbk', 123: 'shift_jis', 124: 'windows-874', 125: 'windows-1255', 126: 'windows-1256', 150: 'x-mac-cyrillic', 200: 'windows-1250', 201: 'windows-1251', 202: 'windows-1254', 203: 'windows-1253', 204: 'windows-1257' };
const DBF_VERSIONS = new Set([0x02, 0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8B, 0x8E, 0xCB, 0xF5, 0xFB]);
async function dbfHeader(readBlock, size) {   // the parsed header, or null when the file is not a dBase table (strict: the field table must add up to the record length)
  if (size < 34) return null;
  const h = await readBlock(0, 32), dv = new DataView(h.buffer, h.byteOffset, 32);
  if (!DBF_VERSIONS.has(h[0]) || h[2] < 1 || h[2] > 12 || h[3] < 1 || h[3] > 31) return null;
  const hdrLen = dv.getUint16(8, true), recLen = dv.getUint16(10, true), nrec = dv.getUint32(4, true);
  if (hdrLen < 65 || hdrLen > size || recLen < 2) return null;
  const head = await readBlock(0, hdrLen), fields = []; let p = 32, off = 1, nullIdx = 0, nullOff = -1, nullBits = 0;
  while (p + 32 <= hdrLen && head[p] !== 0x0D) {
    let e = p; while (e < p + 11 && head[e] !== 0) e++;
    const name = new TextDecoder('latin1').decode(head.subarray(p, e)), t = String.fromCharCode(head[p + 11]);
    for (let i = p; i < e; i++) if (head[i] < 32 || head[i] > 126) return null;
    let len = head[p + 16]; const dec = head[p + 17], flags = head[p + 18];
    if (t === 'C') len += dec * 256;   // long text fields keep the high byte of the length here
    if (!/[CNFDLMGPWIBOYT0+@]/.test(t) || len < 1) return null;
    const f = { name, t, len, dec, off, nullable: (flags & 2) !== 0 && t !== '0', bit: -1 };
    if (f.nullable) f.bit = nullIdx++;
    if (t === '0') nullOff = off;
    fields.push(f); off += len; p += 32;
  }
  if (head[p] !== 0x0D || off !== recLen || !fields.length) return null;
  const have = Math.floor((size - hdrLen) / recLen);
  if (nrec > have + 1 && nrec * recLen + hdrLen > size + 1) return null;   // the header promises more rows than the file holds
  return { hdrLen, recLen, nrec: Math.min(nrec, have + 1), have, fields, lang: h[29], nullOff, nullBits: nullIdx };
}
function dbfCodepage(lang) {
  const name = DBF_LANG[lang] || null;
  if (name && DBF_CP[name]) return { table: DBF_CP[name] };
  if (name === '1252' || (name && /^windows-/.test(name)) || name === 'macintosh' || name === 'x-mac-cyrillic' || name === '866') { const label = name === '1252' ? 'windows-1252' : name === '866' ? 'ibm866' : name; try { const d = new TextDecoder(label); const b = new Uint8Array(128); for (let i = 0; i < 128; i++) b[i] = 128 + i; return { table: d.decode(b) }; } catch { /* fall through */ } }
  if (name && /^(shift_jis|gbk|big5|euc-kr)$/.test(name)) { try { return { multi: new TextDecoder(name) }; } catch { /* fall through */ } }
  const b = new Uint8Array(128); for (let i = 0; i < 128; i++) b[i] = 128 + i; return { table: new TextDecoder('windows-1252').decode(b) };
}
// Walks the records and calls put(Uint8Array) with CSV bytes. Returns { rows, deleted, left: [names of columns that cannot be read] }.
async function dbfToCsv(readBlock, size, put) {
  const H = await dbfHeader(readBlock, size); if (!H) throw new Error('This is not a dBase file.');
  const cp = dbfCodepage(H.lang), enc = new TextEncoder(), left = [], cols = [];
  const used = new Set();
  for (const f of H.fields) {
    const ok = f.t === 'C' || f.t === 'N' || f.t === 'F' || f.t === 'D' || f.t === 'L' || f.t === 'I' || f.t === '+' || f.t === 'T' || f.t === 'Y' || f.t === 'O' || (f.t === 'B' && f.len === 8);
    if (!ok) { if (f.t !== '0') left.push(f.name || '?'); continue; }
    let nm = f.name.trim() || 'column_' + (cols.length + 1), base = nm, k = 2; while (used.has(nm.toLowerCase())) nm = base + '_' + (k++); used.add(nm.toLowerCase()); cols.push(Object.assign({}, f, { out: nm }));
  }
  if (!cols.length) throw new Error('This dBase file has no columns that can be read.');
  const tab = cp.table ? Array.from(cp.table).map((c) => enc.encode(c)) : null, multi = cp.multi || null;
  const CAP = 4 << 20; let ob = new Uint8Array(CAP + (1 << 20)), op = 0;
  const flush = () => { if (op) { put(ob.slice(0, op)); op = 0; } };
  const needMore = H.recLen * 4 + cols.length * 40 + 64; if (needMore > ob.length - CAP) ob = new Uint8Array(CAP + needMore);
  const quoteNeeded = (b, a, z) => { for (let i = a; i < z; i++) { const c = b[i]; if (c === 44 || c === 34 || c < 32) return true; } return false; };
  const utf8ok = (b, a, z) => { for (let i = a; i < z;) { const c = b[i]; if (c < 128) { i++; continue; } const n = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC2 ? 2 : 0; if (!n || i + n > z) return false; for (let k = 1; k < n; k++) if ((b[i + k] & 0xC0) !== 0x80) return false; i += n; } return true; };
  const wr = (s) => { for (let i = 0; i < s.length; i++) ob[op++] = s.charCodeAt(i); };
  const csvName = (s) => { if (/[",\r\n]/.test(s)) { const q = '"' + s.replace(/"/g, '""') + '"'; const e = enc.encode(q); ob.set(e, op); op += e.length; } else { const e = enc.encode(s); ob.set(e, op); op += e.length; } };
  const textField = (b, a, z) => {   // right-trimmed text, CSV quoted when needed, converted to UTF-8
    while (z > a && (b[z - 1] === 32 || b[z - 1] === 0)) z--;
    if (z === a) return;
    let hi = false; for (let i = a; i < z; i++) if (b[i] >= 128) { hi = true; break; }
    const q = quoteNeeded(b, a, z); if (q) ob[op++] = 34;
    if (!hi) { if (q) { for (let i = a; i < z; i++) { const c = b[i]; ob[op++] = c; if (c === 34) ob[op++] = 34; } } else { for (let i = a; i < z; i++) ob[op++] = b[i]; } }
    else if (utf8ok(b, a, z)) { for (let i = a; i < z; i++) { const c = b[i]; ob[op++] = c; if (c === 34) ob[op++] = 34; } }
    else if (multi) { const e = enc.encode(multi.decode(b.subarray(a, z)).replace(/"/g, q ? '""' : '"')); ob.set(e, op); op += e.length; }
    else { for (let i = a; i < z; i++) { const c = b[i]; if (c < 128) { ob[op++] = c; if (c === 34) ob[op++] = 34; } else { const e = tab[c - 128]; for (let k = 0; k < e.length; k++) ob[op++] = e[k]; } } }
    if (q) ob[op++] = 34;
  };
  const julian = (jd) => { let a = jd + 32044, b = Math.floor((4 * a + 3) / 146097), c = a - Math.floor(146097 * b / 4), d = Math.floor((4 * c + 3) / 1461), e = c - Math.floor(1461 * d / 4), m = Math.floor((5 * e + 2) / 153); const day = e - Math.floor((153 * m + 2) / 5) + 1, mon = m + 3 - 12 * Math.floor(m / 10), yr = 100 * b + d - 4800 + Math.floor(m / 10); return [yr, mon, day]; };
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  let header = ''; for (let k = 0; k < cols.length; k++) header += (k ? ',' : '') + (/[",\r\n]/.test(cols[k].out) ? '"' + cols[k].out.replace(/"/g, '""') + '"' : cols[k].out); { const e = enc.encode(header + '\n'); ob.set(e, 0); op = e.length; }
  let rows = 0, deleted = 0; const per = Math.max(1, Math.floor((4 << 20) / H.recLen)); const total = H.nrec;
  for (let r0 = 0; r0 < total; r0 += per) {
    const n = Math.min(per, total - r0), buf = await readBlock(H.hdrLen + r0 * H.recLen, n * H.recLen), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const got = Math.min(n, Math.floor(buf.length / H.recLen));
    for (let i = 0; i < got; i++) {
      const base = i * H.recLen, flag = buf[base]; if (flag === 0x1A) { r0 = total; break; } if (flag === 0x2A) { deleted++; continue; }
      if (op > CAP) flush();
      for (let k = 0; k < cols.length; k++) {
        const f = cols[k], a = base + f.off, z = a + f.len; if (k) ob[op++] = 44;
        if (f.nullable && H.nullOff >= 0) { const bit = f.bit, byte = buf[base + H.nullOff + (bit >> 3)]; if (byte & (1 << (bit & 7))) continue; }
        switch (f.t) {
          case 'C': textField(buf, a, z); break;
          case 'N': case 'F': { let s = a, e = z; while (s < e && (buf[s] === 32 || buf[s] === 0)) s++; while (e > s && (buf[e - 1] === 32 || buf[e - 1] === 0)) e--; if (e > s && buf[s] !== 42) for (let j = s; j < e; j++) ob[op++] = buf[j]; break; }
          case 'D': { let allz = true, blank = true; for (let j = a; j < z; j++) { if (buf[j] !== 32) blank = false; if (buf[j] !== 48 && buf[j] !== 32) allz = false; } if (blank || allz || f.len < 8) break; for (let j = 0; j < 4; j++) ob[op++] = buf[a + j]; ob[op++] = 45; ob[op++] = buf[a + 4]; ob[op++] = buf[a + 5]; ob[op++] = 45; ob[op++] = buf[a + 6]; ob[op++] = buf[a + 7]; break; }
          case 'L': { const c = buf[a] | 32; if (c === 116 || c === 121) wr('true'); else if (c === 102 || c === 110) wr('false'); break; }
          case 'I': case '+': wr(String(dv.getInt32(a, true))); break;
          case 'B': case 'O': { const v = dv.getFloat64(a, true); if (Number.isFinite(v)) wr(String(v)); break; }
          case 'Y': { const v = dv.getBigInt64(a, true); const neg = v < 0n, u = neg ? -v : v, ip = u / 10000n, fp = String(u % 10000n).padStart(4, '0').replace(/0+$/, ''); wr((neg ? '-' : '') + ip + (fp ? '.' + fp : '')); break; }
          case 'T': { const jd = dv.getInt32(a, true), ms = dv.getInt32(a + 4, true); if (jd <= 0) break; const [y, mo, d] = julian(jd), s = Math.floor(ms / 1000); wr(y + '-' + p2(mo) + '-' + p2(d) + ' ' + p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60)); break; }
        }
      }
      ob[op++] = 10; rows++;
    }
  }
  flush();
  return { rows, deleted, left, columns: cols.length };
}
async function isDbfFile(f) { if (!f || f.size < 66) return false; try { return !!(await dbfHeader(async (o, l) => new Uint8Array(await f.slice(o, o + l).arrayBuffer()), f.size)); } catch { return false; } }
async function dbfToCsvFile(file) {
  const parts = []; let acc = [], accN = 0; const put = (b) => { acc.push(b); accN += b.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
  const r = await dbfToCsv(async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer()), file.size, put);
  if (acc.length) parts.push(new Blob(acc)); if (!r.rows) throw new Error('This dBase file has no rows' + (r.deleted ? ' (all ' + r.deleted + ' are marked deleted).' : '.'));
  return Object.assign({ file: new File(parts, String(file.name).replace(/\.[^.]*$/, '') + '.csv', { type: 'text/csv' }) }, r);
}
// ---- Stata (.dta, formats 113 to 119): fixed-size rows behind a variable table. Rows are rewritten as CSV bytes, then the normal CSV import runs.
// Value labels (1 = "Male") are written as their text; %td and %tc dates as dates; Stata missing values as empty cells.
// Reads through readBlock(offset, length) -> Promise<Uint8Array>.
async function dtaHeader(readBlock, size) {   // parsed header, or null when the file is not a Stata file (strict)
  if (size < 64) return null;
  const head = await readBlock(0, Math.min(size, 1 << 16)), ascii = (a, z) => { let s = ''; for (let i = a; i < z; i++) s += String.fromCharCode(head[i]); return s; };
  const H = { tagged: false, rel: 0, le: true, nvar: 0, nobs: 0, types: [], names: [], fmts: [], lbls: [], dataOff: 0, strlOff: -1, vlOff: -1, utf8: false };
  const dvh = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (ascii(0, 11) === '<stata_dta>') {
    const rm = /^<stata_dta><header><release>(\d+)<\/release><byteorder>(MSF|LSF)<\/byteorder>/.exec(ascii(0, 80)); if (!rm) return null;
    H.tagged = true; H.rel = +rm[1]; H.le = rm[2] === 'LSF'; if (H.rel < 117 || H.rel > 119) return null;
    H.utf8 = H.rel >= 118; let p = rm[0].length;
    if (ascii(p, p + 3) !== '<K>') return null; p += 3; if (H.rel === 119) { H.nvar = dvh.getUint32(p, H.le); p += 4; } else { H.nvar = dvh.getUint16(p, H.le); p += 2; }
    if (ascii(p, p + 4) !== '</K>' || ascii(p + 4, p + 7) !== '<N>') return null; p += 7;
    if (H.rel === 117) { H.nobs = dvh.getUint32(p, H.le); p += 4; } else { H.nobs = Number(dvh.getBigUint64(p, H.le)); p += 8; }
    const mi = ascii(0, Math.min(head.length, 4096)).indexOf('<map>'); if (mi < 0) return null;
    const map = []; for (let i = 0; i < 14; i++) map.push(Number(dvh.getBigUint64(mi + 5 + i * 8, H.le)));
    if (map[13] > size + 1 || map[9] > size) return null;
    const nl = H.rel >= 118 ? 129 : 33, fl = H.rel >= 118 ? 57 : 49, ll = H.rel >= 118 ? 129 : 33, K = H.nvar;
    const rd = async (off, len) => (off + len <= head.length ? head.subarray(off, off + len) : readBlock(off, len));
    const tb = await rd(map[2] + 16, K * 2), nb = await rd(map[3] + 10, K * nl), fb = await rd(map[5] + 9, K * fl), lb = await rd(map[6] + 19, K * ll);
    if (tb.length < K * 2 || nb.length < K * nl) return null;
    const tdv = new DataView(tb.buffer, tb.byteOffset, tb.byteLength);
    const cstr = (b, a, w) => { let e = a; while (e < a + w && b[e] !== 0) e++; return new TextDecoder(H.utf8 ? 'utf-8' : 'latin1').decode(b.subarray(a, e)); };
    for (let j = 0; j < K; j++) { H.types.push(tdv.getUint16(j * 2, H.le)); H.names.push(cstr(nb, j * nl, nl)); H.fmts.push(cstr(fb, j * fl, fl)); H.lbls.push(cstr(lb, j * ll, ll)); }
    H.dataOff = map[9] + 6; H.strlOff = map[10] + 7; H.strlEnd = map[11]; H.vlOff = map[11] + 14; H.vlEnd = map[12];
  } else {
    H.rel = head[0]; if (H.rel < 113 || H.rel > 115) return null;
    if (head[1] !== 1 && head[1] !== 2) return null; H.le = head[1] === 2; if (head[2] !== 1) return null;
    H.nvar = dvh.getInt16(4, H.le); H.nobs = dvh.getInt32(6, H.le); const K = H.nvar; if (K < 1 || H.nobs < 0) return null;
    let p = 109; const fl = H.rel === 113 ? 12 : 49;
    const need = p + K + K * 33 + (K + 1) * 2 + K * fl + K * 33 + K * 81 + 5;
    if (need > head.length) return null;
    const cstr = (a, w) => { let e = a; while (e < a + w && head[e] !== 0) e++; return new TextDecoder('latin1').decode(head.subarray(a, e)); };
    for (let j = 0; j < K; j++) H.types.push(head[p + j]); p += K;
    for (let j = 0; j < K; j++) H.names.push(cstr(p + j * 33, 33)); p += K * 33; p += (K + 1) * 2;
    for (let j = 0; j < K; j++) H.fmts.push(cstr(p + j * fl, fl)); p += K * fl;
    for (let j = 0; j < K; j++) H.lbls.push(cstr(p + j * 33, 33)); p += K * 33; p += K * 81;
    for (;;) { if (p + 5 > head.length) return null; const t = head[p], n = dvh.getInt32(p + 1, H.le); p += 5; if (t === 0 && n === 0) break; if (n < 0) return null; p += n; }
    H.dataOff = p;
  }
  // widths and kinds
  H.cols = []; let off = 0;
  for (let j = 0; j < H.types.length; j++) {
    const t = H.types[j]; let k, w;
    if (H.tagged) { if (t >= 1 && t <= 2045) { k = 's'; w = t; } else if (t === 32768) { k = 'L'; w = 8; } else if (t === 65530) { k = 'b'; w = 1; } else if (t === 65529) { k = 'i'; w = 2; } else if (t === 65528) { k = 'l'; w = 4; } else if (t === 65527) { k = 'f'; w = 4; } else if (t === 65526) { k = 'd'; w = 8; } else return null; }
    else { if (t >= 1 && t <= 244) { k = 's'; w = t; } else if (t === 251) { k = 'b'; w = 1; } else if (t === 252) { k = 'i'; w = 2; } else if (t === 253) { k = 'l'; w = 4; } else if (t === 254) { k = 'f'; w = 4; } else if (t === 255) { k = 'd'; w = 8; } else return null; }
    H.cols.push({ k, w, off, name: H.names[j], fmt: H.fmts[j], lbl: H.lbls[j] }); off += w;
  }
  H.rowSize = off; if (!H.rowSize || H.nvar !== H.cols.length) return null;
  if (H.dataOff + H.nobs * H.rowSize > size) return null;
  return H;
}
function dtaFloatText(v) { for (let p = 1; p <= 9; p++) { const s = v.toPrecision(p); if (Math.fround(+s) === v) return String(+s); } return String(v); }
async function dtaToCsv(readBlock, size, put) {
  const H = await dtaHeader(readBlock, size); if (!H) throw new Error('This is not a Stata file.');
  const enc = new TextEncoder(), le = H.le, used = new Set(), cp1252 = H.utf8 ? null : Array.from(new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 128 }, (_, i) => 128 + i))).map((c) => enc.encode(c));
  const cols = H.cols; let labelsUsed = 0, dateCols = 0;
  // value labels: name -> Map(value -> text)
  const vl = new Map();
  const parseLabels = (buf, tagged) => {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), dec = new TextDecoder(H.utf8 ? 'utf-8' : 'latin1'), nl = H.rel >= 118 ? 129 : 33; let p = 0;
    for (;;) {
      let len, end;
      if (tagged) { if (p + 5 > buf.length || String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3], buf[p + 4]) !== '<lbl>') break; p += 5; len = dv.getInt32(p, le); p += 4; end = p + nl + 3 + len; }
      else { if (p + 4 > buf.length) break; len = dv.getInt32(p, le); p += 4; end = p + nl + 3 + len; if (len <= 0 || end > buf.length) break; }
      let e = p; while (e < p + nl && buf[e] !== 0) e++; const name = dec.decode(buf.subarray(p, e)); p += nl + 3;
      const n = dv.getInt32(p, le), tl = dv.getInt32(p + 4, le); p += 8; const offs = [], vals = [];
      for (let i = 0; i < n; i++) offs.push(dv.getInt32(p + i * 4, le)); p += n * 4; for (let i = 0; i < n; i++) vals.push(dv.getInt32(p + i * 4, le)); p += n * 4;
      const tb = buf.subarray(p, p + tl), m = new Map(); for (let i = 0; i < n; i++) { let a = offs[i], z = a; while (z < tb.length && tb[z] !== 0) z++; m.set(vals[i], dec.decode(tb.subarray(a, z))); }
      vl.set(name, m); p = end; if (tagged) { p += 6; }   // </lbl>
    }
  };
  if (H.tagged) { if (H.vlEnd > H.vlOff && H.vlEnd - H.vlOff < (256 << 20)) parseLabels(await readBlock(H.vlOff, H.vlEnd - H.vlOff), true); }
  else { const at = H.dataOff + H.nobs * H.rowSize; if (size - at > 8) parseLabels(await readBlock(at, size - at), false); }
  // strL values
  let strl = null;
  if (H.tagged && cols.some((c) => c.k === 'L') && H.strlEnd > H.strlOff) {
    strl = new Map(); const buf = await readBlock(H.strlOff, H.strlEnd - H.strlOff), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), od = H.rel === 117 ? 4 : 8, dec = new TextDecoder('utf-8');
    let p = 0; while (p + 3 <= buf.length && buf[p] === 71 && buf[p + 1] === 83 && buf[p + 2] === 79) { const v = dv.getUint32(p + 3, le); p += 7; let o; if (od === 4) { o = dv.getUint32(p, le); } else { o = Number(dv.getBigUint64(p, le)); } p += od; const t = buf[p], n = dv.getUint32(p + 1, le); p += 5; if (t === 130) strl.set(v + ',' + o, buf.subarray(p, p + n)); p += n; }
  }
  const oc = [];   // output columns
  for (const c of cols) { let nm = c.name || 'column_' + (oc.length + 1), base = nm, k = 2; while (used.has(nm.toLowerCase())) nm = base + '_' + (k++); used.add(nm.toLowerCase()); const f = /^%t([dc])/.exec(c.fmt || ''); const o = Object.assign({}, c, { out: nm, date: f ? f[1] : '', map: (c.k === 'b' || c.k === 'i' || c.k === 'l') && c.lbl && vl.has(c.lbl) ? vl.get(c.lbl) : null }); if (o.map) labelsUsed++; if (o.date && (c.k === 'd' || c.k === 'l' || c.k === 'i' || c.k === 'f')) dateCols++; else o.date = ''; oc.push(o); }
  const CAP = 4 << 20; let ob = new Uint8Array(CAP + (1 << 20)), op = 0;
  const flush = () => { if (op) { put(ob.slice(0, op)); op = 0; } };
  const ensure = (n) => { if (op + n > ob.length) { const m = new Uint8Array(Math.max(ob.length * 2, op + n)); m.set(ob.subarray(0, op)); ob = m; } };
  if (H.rowSize * 4 + oc.length * 40 + 64 > ob.length - CAP) ob = new Uint8Array(CAP + H.rowSize * 4 + oc.length * 40 + 64);
  const wr = (s) => { for (let i = 0; i < s.length; i++) ob[op++] = s.charCodeAt(i); };
  const wtext = (s) => { if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'; const e = enc.encode(s); ensure(e.length + 8); ob.set(e, op); op += e.length; };
  const utf8ok = (b, a, z) => { for (let i = a; i < z;) { const c = b[i]; if (c < 128) { i++; continue; } const n = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC2 ? 2 : 0; if (!n || i + n > z) return false; for (let k = 1; k < n; k++) if ((b[i + k] & 0xC0) !== 0x80) return false; i += n; } return true; };
  const rawText = (b, a, z) => {   // bytes -> CSV text field, UTF-8 out
    ensure((z - a) * 4 + 8); let hi = false, q = false; for (let i = a; i < z; i++) { const c = b[i]; if (c >= 128) hi = true; else if (c === 44 || c === 34 || c < 32) q = true; }
    if (q) ob[op++] = 34;
    if (!hi || H.utf8 || utf8ok(b, a, z)) { for (let i = a; i < z; i++) { const c = b[i]; ob[op++] = c; if (c === 34) ob[op++] = 34; } }
    else { for (let i = a; i < z; i++) { const c = b[i]; if (c < 128) { ob[op++] = c; if (c === 34) ob[op++] = 34; } else { const e = cp1252[c - 128]; for (let k = 0; k < e.length; k++) ob[op++] = e[k]; } } }
    if (q) ob[op++] = 34;
  };
  const civil = (z) => { z += 719468; const era = Math.floor(z / 146097), doe = z - era * 146097, yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365), y = yoe + era * 400, doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9; return [m <= 2 ? y + 1 : y, m, d]; };
  const p2 = (n) => (n < 10 ? '0' : '') + n, p4 = (n) => String(n).padStart(4, '0');
  const POW = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12];
  const tmp = new Uint8Array(24);
  const wint = (n) => {
    if (n < 0) { ob[op++] = 45; n = -n; }
    if (n < 2147483648) { let m = n | 0; if (m < 10) { ob[op++] = 48 + m; return; } let k = 0; while (m > 0) { const q = (m / 10) | 0; tmp[k++] = 48 + (m - q * 10); m = q; } while (k > 0) ob[op++] = tmp[--k]; return; }
    let k = 0; while (n > 0) { const q = Math.floor(n / 10); tmp[k++] = 48 + (n - q * 10); n = q; } while (k > 0) ob[op++] = tmp[--k];
  };
  const wnum = (v) => {   // shortest decimal text of a double; whole numbers and short decimals are written by hand, anything else by String()
    if (v === Math.floor(v)) { if (v > -1e15 && v < 1e15) { wint(v); return; } }
    else {
      const a = v < 0 ? -v : v;
      if (a < 2e9) for (let sdec = 1; sdec <= 9; sdec++) {
        const p = POW[sdec], r = Math.round(a * p); if (r >= 2147483648) break;
        if (r / p === a) { if (v < 0) ob[op++] = 45; let ri = r | 0; const ip = (ri / p) | 0; let fp = ri - ip * p; wint(ip); ob[op++] = 46; for (let k = sdec - 1; k >= 0; k--) { const q = (fp / 10) | 0; tmp[k] = 48 + (fp - q * 10); fp = q; } for (let k = 0; k < sdec; k++) ob[op++] = tmp[k]; return; }
      }
    }
    wr(String(v));
  };
  const dayCache = new Map();
  const dayBytes = (days) => { let b = dayCache.get(days); if (!b) { const [y, m, d] = civil(days - 3653); b = enc.encode(p4(y) + '-' + p2(m) + '-' + p2(d)); if (dayCache.size > 5000) dayCache.clear(); dayCache.set(days, b); } return b; };
  let header = ''; for (let k = 0; k < oc.length; k++) header += (k ? ',' : '') + (/[",\r\n]/.test(oc[k].out) ? '"' + oc[k].out.replace(/"/g, '""') + '"' : oc[k].out);
  { const e = enc.encode(header + '\n'); ensure(e.length); ob.set(e, 0); op = e.length; }
  const NC = oc.length, kind = new Uint8Array(NC), offA = new Int32Array(NC), widA = new Int32Array(NC), dateA = new Uint8Array(NC), mapA = oc.map((c) => c.map);
  for (let k = 0; k < NC; k++) { kind[k] = 's bilfdL'.indexOf(oc[k].k) ; offA[k] = oc[k].off; widA[k] = oc[k].w; dateA[k] = oc[k].date === 'd' ? 1 : oc[k].date === 'c' ? 2 : 0; }   // kinds: 0 s, 2 b, 3 i, 4 l, 5 f, 6 d, 7 L
  const PW = new Float64Array([1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9]);
  const tmpd = new Uint8Array(24);
  let rows = 0, missing = 0;
  // Hot loop in its own sync function: local output position, hand-written digit output.
  const block = (buf, dv, n) => {
    let lop = op, lob = ob, lastDay = -1e15, lastB = null; const rs = H.rowSize;
    for (let i = 0; i < n; i++) {
      const base = i * rs;
      if (lop > CAP || lop + rs * 4 + NC * 40 + 64 > lob.length) { op = lop; if (op > CAP) flush(); ensure(rs * 4 + NC * 40 + 64); lop = op; lob = ob; }
      for (let k = 0; k < NC; k++) {
        const a = base + offA[k], kd = kind[k]; if (k) lob[lop++] = 44;
        let v = 0;
        if (kd === 6) { v = dv.getFloat64(a, le); if (!(v <= 8.988465674311579e307)) { missing++; continue; } }
        else if (kd === 2) { v = dv.getInt8(a); if (v > 100) { missing++; continue; } }
        else if (kd === 3) { v = dv.getInt16(a, le); if (v > 32740) { missing++; continue; } }
        else if (kd === 4) { v = dv.getInt32(a, le); if (v > 2147483620) { missing++; continue; } }
        else if (kd === 5) { v = dv.getFloat32(a, le); if (!(v <= 1.7014117331926443e38)) { missing++; continue; } }
        else if (kd === 0) { const z = a + widA[k]; let e = a; while (e < z && buf[e] !== 0) e++; if (e > a) { op = lop; rawText(buf, a, e); lop = op; lob = ob; } continue; }
        else {   // strL
          op = lop; let key; if (H.rel === 117) key = dv.getUint32(a, le) + ',' + dv.getUint32(a + 4, le); else if (H.rel === 118) { const v2 = dv.getUint16(a, le), o2 = le ? dv.getUint32(a + 2, true) + dv.getUint16(a + 6, true) * 4294967296 : dv.getUint16(a + 2, false) * 4294967296 + dv.getUint32(a + 4, false); key = v2 + ',' + o2; } else { const lo = dv.getBigUint64(a, le); const v3 = Number(le ? lo & 0xFFFFFFn : lo >> 40n), o3 = Number(le ? lo >> 24n : lo & 0xFFFFFFFFFFn); key = v3 + ',' + o3; }
          const t = strl && strl.get(key); if (t && t.length) { let z = t.length; if (t[z - 1] === 0) z--; if (z > 0) rawText(t, 0, z); } lop = op; lob = ob; continue;
        }
        const mp = mapA[k]; if (mp !== null) { const t = mp.get(v); if (t !== undefined) { op = lop; wtext(t); lop = op; lob = ob; continue; } }
        const dk = dateA[k];
        if (dk === 1) { let dd = v | 0; if (dd !== v) dd = Math.floor(v); if (dd !== lastDay) { lastDay = dd; lastB = dayBytes(dd); } for (let t = 0; t < 10; t++) lob[lop++] = lastB[t]; continue; }
        if (dk === 2) { const ms = v >= 0 && v < 4e15 ? v : Math.round(v), days = ms >= 0 ? (ms / 86400000) | 0 : Math.floor(ms / 86400000), rem = ms - days * 86400000, sec = (rem / 1000) | 0, f = rem - sec * 1000; if (days !== lastDay) { lastDay = days; lastB = dayBytes(days); } for (let t = 0; t < 10; t++) lob[lop++] = lastB[t]; lob[lop++] = 32; const hh = (sec / 3600) | 0, mm = ((sec / 60) | 0) % 60, ss = sec % 60; lob[lop++] = 48 + ((hh / 10) | 0); lob[lop++] = 48 + hh % 10; lob[lop++] = 58; lob[lop++] = 48 + ((mm / 10) | 0); lob[lop++] = 48 + mm % 10; lob[lop++] = 58; lob[lop++] = 48 + ((ss / 10) | 0); lob[lop++] = 48 + ss % 10; if (f) { op = lop; wr('.' + String(f).padStart(3, '0')); lop = op; } continue; }
        if (kd === 5) { op = lop; wr(dtaFloatText(v)); lop = op; continue; }
        // integers and doubles: whole numbers and short decimals by hand, anything else with String()
        let neg = false, x = v; if (x < 0) { neg = true; x = -x; }
        let sd = 0, ip = x, fp = 0;
        if (kd === 6 && (x >= 2147483648 ? x !== Math.floor(x) : (x | 0) !== x)) {
          sd = -1;
          if (x < 2e7) { const q2 = (x * 100 + 0.5) | 0; if (q2 / 100 === x) { const qi = q2 | 0; ip = (qi / 100) | 0; fp = qi - ip * 100; if (fp % 10 === 0) { sd = 1; fp = (fp / 10) | 0; } else sd = 2; } }
          if (sd < 0 && x < 2e9) for (let t = 3; t <= 9; t++) { const q = Math.round(x * PW[t]); if (q >= 2147483648) break; if (q / PW[t] === x) { sd = t; ip = Math.floor(q / PW[t]); fp = q - ip * PW[t]; break; } }
          if (sd < 0) { op = lop; wr(String(v)); lop = op; continue; }
        }
        else if (x >= 1e15) { op = lop; wr(String(v)); lop = op; continue; }
        if (neg) lob[lop++] = 45;
        // write the integer part
        if (ip < 2147483648) { let q0 = ip | 0; if (q0 < 10) lob[lop++] = 48 + q0; else { let c = 0; while (q0 > 0) { const q = (q0 / 10) | 0; tmpd[c++] = 48 + (q0 - q * 10); q0 = q; } while (c > 0) lob[lop++] = tmpd[--c]; } }
        else { let q0 = ip, c = 0; while (q0 > 0) { const q = Math.floor(q0 / 10); tmpd[c++] = 48 + (q0 - q * 10); q0 = q; } while (c > 0) lob[lop++] = tmpd[--c]; }
        if (sd) { lob[lop++] = 46; let f0 = fp | 0; for (let t = sd - 1; t >= 0; t--) { const q = (f0 / 10) | 0; tmpd[t] = 48 + (f0 - q * 10); f0 = q; } for (let t = 0; t < sd; t++) lob[lop++] = tmpd[t]; }
      }
      lob[lop++] = 10; rows++;
    }
    op = lop; ob = lob;
  };
  const per = Math.max(1, Math.floor((4 << 20) / H.rowSize));
  for (let r0 = 0; r0 < H.nobs; r0 += per) {
    const n = Math.min(per, H.nobs - r0), buf = await readBlock(H.dataOff + r0 * H.rowSize, n * H.rowSize), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length < n * H.rowSize) throw new Error('This Stata file is damaged or cut short.');
    block(buf, dv, n);
  }
  flush();
  return { rows, columns: oc.length, labels: labelsUsed, dates: dateCols, missing, version: H.rel };
}
async function isDtaFile(f) { if (!f || f.size < 64) return false; try { return !!(await dtaHeader(async (o, l) => new Uint8Array(await f.slice(o, o + l).arrayBuffer()), f.size)); } catch { return false; } }
async function dtaToCsvFile(file) {
  const parts = []; let acc = [], accN = 0; const put = (b) => { acc.push(b); accN += b.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
  const r = await dtaToCsv(async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer()), file.size, put);
  if (acc.length) parts.push(new Blob(acc)); if (!r.rows) throw new Error('This Stata file has no rows.');
  return Object.assign({ file: new File(parts, String(file.name).replace(/\.[^.]*$/, '') + '.csv', { type: 'text/csv' }) }, r);
}
// ---- Old Excel (.xls, BIFF8): an OLE2 container holding a Workbook stream of records. One sheet is rewritten as CSV text, then the normal CSV import runs.
// Reads strings (shared string table with continuation records), numbers (RK and plain), booleans, formula results, dates by cell format.
const XLS_MAGIC = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
function xlsOleStream(u8) {   // the Workbook (or Book) stream bytes of an OLE2 file, or null
  for (let i = 0; i < 8; i++) if (u8[i] !== XLS_MAGIC[i]) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), ss = 1 << dv.getUint16(30, true), ms = 1 << dv.getUint16(32, true);
  if (ss < 512 || ss > 65536) return null;
  const nFat = dv.getUint32(44, true), dirStart = dv.getUint32(48, true), cutoff = dv.getUint32(56, true), mfStart = dv.getUint32(60, true), nMf = dv.getUint32(64, true), difStart = dv.getUint32(68, true), nDif = dv.getUint32(72, true);
  const END = 0xFFFFFFFE, per = ss / 4, secOff = (s) => 512 + s * ss;   // (a 4096-byte-sector file keeps its header in the first sector: offset ss)
  const hdrOff = ss === 512 ? 512 : ss, sOff = (s) => hdrOff + s * ss;
  const fatSecs = []; for (let i = 0; i < 109 && fatSecs.length < nFat; i++) { const s = dv.getUint32(76 + i * 4, true); if (s < 0xFFFFFFFA) fatSecs.push(s); }
  let d = difStart; for (let k = 0; k < nDif && d < 0xFFFFFFFA && sOff(d) + ss <= u8.length; k++) { for (let i = 0; i < per - 1 && fatSecs.length < nFat; i++) { const s = dv.getUint32(sOff(d) + i * 4, true); if (s < 0xFFFFFFFA) fatSecs.push(s); } d = dv.getUint32(sOff(d) + (per - 1) * 4, true); }
  const fat = new Uint32Array(fatSecs.length * per); for (let k = 0; k < fatSecs.length; k++) { if (sOff(fatSecs[k]) + ss > u8.length) return null; for (let i = 0; i < per; i++) fat[k * per + i] = dv.getUint32(sOff(fatSecs[k]) + i * 4, true); }
  const chain = (start) => { const out = []; let s = start, guard = 0; while (s < 0xFFFFFFFA && s < fat.length && guard++ < fat.length + 2) { out.push(s); s = fat[s]; } return out; };
  const readChain = (start, size) => { const secs = chain(start), out = new Uint8Array(secs.length * ss); for (let i = 0; i < secs.length; i++) { const o = sOff(secs[i]); if (o + ss > u8.length) return null; out.set(u8.subarray(o, o + ss), i * ss); } return size >= 0 && size < out.length ? out.subarray(0, size) : out; };
  const dir = readChain(dirStart, -1); if (!dir) return null;
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength); let root = null, found = null;
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nl = ddv.getUint16(o + 64, true), type = dir[o + 66]; if (nl < 2 || nl > 64) continue;
    let name = ''; for (let i = 0; i < (nl - 2) / 2; i++) name += String.fromCharCode(ddv.getUint16(o + i * 2, true));
    const start = ddv.getUint32(o + 116, true), size = ddv.getUint32(o + 120, true);
    if (type === 5) root = { start, size }; else if (type === 2 && (name === 'Workbook' || name === 'Book') && (!found || name === 'Workbook')) found = { name, start, size };
  }
  if (!found) return null;
  if (found.size >= cutoff) return { name: found.name, data: readChain(found.start, found.size) };
  if (!root) return null;
  const mini = readChain(root.start, -1), mf = readChain(mfStart, -1); if (!mini || !mf) return null;
  const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength), out = new Uint8Array(Math.ceil(found.size / ms) * ms); let s = found.start, i = 0;
  while (s < 0xFFFFFFFA && i * ms < out.length && s * 4 + 4 <= mf.length) { out.set(mini.subarray(s * ms, s * ms + ms), i * ms); s = mdv.getUint32(s * 4, true); i++; }
  return { name: found.name, data: out.subarray(0, found.size) };
}
function xlsBook(wb) {   // parse the workbook globals: sheets, shared strings, cell formats
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength), B = { wb, dv, sheets: [], sst: [], xf: [], fmts: new Map(), d1904: false };
  let p = 0; const rec = () => { if (p + 4 > wb.length) return null; const id = dv.getUint16(p, true), len = dv.getUint16(p + 2, true); const r = { id, a: p + 4, len }; p += 4 + len; return r; };
  const first = rec(); if (!first || (first.id & 0xFF) !== 0x09) return null;
  const ver = first.len >= 2 ? dv.getUint16(first.a, true) : 0;
  if (first.id !== 0x0809 || ver !== 0x0600) throw new Error('This is an old Excel file (Excel 95 or earlier). Open it in Excel and save it as .xlsx, then import that.');
  let r, sstParts = null;
  const flushSst = () => { if (sstParts) { B.sst = xlsReadSst(wb, sstParts); sstParts = null; } };
  while ((r = rec())) {
    if (r.id === 0x000A) break;   // EOF of the globals
    if (r.id === 0x003C) { if (sstParts) sstParts.push([r.a, r.a + r.len]); continue; }
    flushSst();
    if (r.id === 0x00FC) sstParts = [[r.a, r.a + r.len]];
    else if (r.id === 0x0022) B.d1904 = dv.getUint16(r.a, true) === 1;
    else if (r.id === 0x0085) { const pos = dv.getUint32(r.a, true), hidden = wb[r.a + 4], type = wb[r.a + 5], cch = wb[r.a + 6], fl = wb[r.a + 7]; let name = ''; if (fl & 1) for (let i = 0; i < cch; i++) name += String.fromCharCode(dv.getUint16(r.a + 8 + i * 2, true)); else for (let i = 0; i < cch; i++) name += String.fromCharCode(wb[r.a + 8 + i]); B.sheets.push({ name, pos, hidden, type }); }
    else if (r.id === 0x041E) { const idx = dv.getUint16(r.a, true), cch = dv.getUint16(r.a + 2, true), fl = wb[r.a + 4]; let s = ''; if (fl & 1) for (let i = 0; i < cch; i++) s += String.fromCharCode(dv.getUint16(r.a + 5 + i * 2, true)); else for (let i = 0; i < cch; i++) s += String.fromCharCode(wb[r.a + 5 + i]); B.fmts.set(idx, s); }
    else if (r.id === 0x00E0) B.xf.push(dv.getUint16(r.a + 2, true));
  }
  flushSst();
  B.kinds = B.xf.map((id) => xlsFmtKind(id, B.fmts));
  return B;
}
function xlsFmtKind(id, custom) {   // 0 number, 1 date, 2 date and time, 3 time only
  if ((id >= 14 && id <= 17) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return 1; if (id === 22) return 2; if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return 3;
  const code = custom.get(id); if (code == null) return 0;
  const c = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '').toLowerCase(); const t = /[hs]|am\/pm/.test(c), d = /[yd]/.test(c) || (!t && /m/.test(c));
  return d && t ? 2 : d ? 1 : t ? 3 : 0;
}
function xlsReadSst(wb, parts) {   // parts: [start, end) of the SST record and its CONTINUE records
  const out = [], dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength); let ci = 0, p = parts[0][0] + 8, end = parts[0][1];
  const total = dv.getUint32(parts[0][0] + 4, true);
  const next = () => { ci++; if (ci >= parts.length) return false; p = parts[ci][0]; end = parts[ci][1]; return true; };
  const need = (n) => { while (p + n > end) { if (p < end) return false; if (!next()) return false; } return true; };
  for (let i = 0; i < total; i++) {
    if (!need(3)) break;
    const cch = dv.getUint16(p, true), fl = wb[p + 2]; p += 3; let runs = 0, ext = 0;
    if (fl & 8) { if (!need(2)) break; runs = dv.getUint16(p, true); p += 2; } if (fl & 4) { if (!need(4)) break; ext = dv.getUint32(p, true); p += 4; }
    let wide = (fl & 1) !== 0, left = cch, s = '';
    while (left > 0) {
      if (p >= end) { if (!next()) break; wide = (wb[p] & 1) !== 0; p++; continue; }   // the continuation record restarts with a flags byte
      const bytes = wide ? Math.min(left * 2, (end - p) & ~1) : Math.min(left, end - p); if (bytes <= 0) { if (!next()) break; wide = (wb[p] & 1) !== 0; p++; continue; }
      const n = wide ? bytes / 2 : bytes; let chunk = ''; if (wide) { for (let k = 0; k < n; k++) chunk += String.fromCharCode(dv.getUint16(p + k * 2, true)); } else { for (let k = 0; k < n; k++) chunk += String.fromCharCode(wb[p + k]); } s += chunk; p += bytes; left -= n;
    }
    let skip = runs * 4 + ext; while (skip > 0) { if (p >= end) { if (!next()) break; continue; } const t = Math.min(skip, end - p); p += t; skip -= t; }
    out.push(s);
  }
  return out;
}
function xlsRk(v) { let d; if (v & 2) d = v >> 2; else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, (v & 0xFFFFFFFC) >>> 0, true); d = b.getFloat64(0, true); } return v & 1 ? d / 100 : d; }
const xlsP2 = (n) => (n < 10 ? '0' : '') + n;
function xlsSerial(v, kind, d1904) {
  let days = Math.floor(v), secs = Math.round((v - days) * 86400); if (secs >= 86400) { secs -= 86400; days++; }
  const time = xlsP2((secs / 3600) | 0) + ':' + xlsP2(((secs % 3600) / 60) | 0) + ':' + xlsP2(secs % 60);
  if (kind === 3) return time;
  const u = days + (d1904 ? 1462 : 0) - 25569 + (!d1904 && days < 60 ? 1 : 0), z = u + 719468, era = Math.floor(z / 146097), doe = z - era * 146097, yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365), y0 = yoe + era * 400, doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153), dd = doy - Math.floor((153 * mp + 2) / 5) + 1, mm = mp < 10 ? mp + 3 : mp - 9, yy = y0 + (mm <= 2 ? 1 : 0);
  const ds = String(yy).padStart(4, '0') + '-' + xlsP2(mm) + '-' + xlsP2(dd); return kind === 1 ? ds : ds + ' ' + time;
}
// Reads one worksheet into rows of strings (sparse arrays). Returns { rows: Array, count }.
function xlsSheetRows(B, sheet) {
  const wb = B.wb, dv = B.dv, rows = []; let p = sheet.pos, lastF = null, count = 0;
  const put = (r, c, s) => { if (s === '' || s === undefined) return; if (r > 65535 || c > 255) return; (rows[r] || (rows[r] = []))[c] = s; count++; };
  const val = (xf, v) => { const k = B.kinds[xf] | 0; return k && isFinite(v) ? xlsSerial(v, k, B.d1904) : String(v); };
  const str16 = (o) => { const cch = dv.getUint16(o, true), fl = wb[o + 2]; let q = o + 3; if (fl & 8) q += 2; if (fl & 4) q += 4; let s = ''; if (fl & 1) for (let i = 0; i < cch && q + i * 2 + 1 < wb.length; i++) s += String.fromCharCode(dv.getUint16(q + i * 2, true)); else for (let i = 0; i < cch && q + i < wb.length; i++) s += String.fromCharCode(wb[q + i]); return s; };
  let first = true;
  while (p + 4 <= wb.length) {
    const id = dv.getUint16(p, true), len = dv.getUint16(p + 2, true), a = p + 4; p = a + len;
    if (first) { first = false; if (id !== 0x0809) throw new Error('This Excel file is damaged.'); continue; }
    if (id === 0x000A) break;
    switch (id) {
      case 0x00FD: put(dv.getUint16(a, true), dv.getUint16(a + 2, true), B.sst[dv.getUint32(a + 6, true)]); break;
      case 0x0203: put(dv.getUint16(a, true), dv.getUint16(a + 2, true), val(dv.getUint16(a + 4, true), dv.getFloat64(a + 6, true))); break;
      case 0x027E: put(dv.getUint16(a, true), dv.getUint16(a + 2, true), val(dv.getUint16(a + 4, true), xlsRk(dv.getUint32(a + 6, true)))); break;
      case 0x00BD: { const r = dv.getUint16(a, true), c0 = dv.getUint16(a + 2, true), n = (len - 6) / 6 | 0; for (let i = 0; i < n; i++) put(r, c0 + i, val(dv.getUint16(a + 4 + i * 6, true), xlsRk(dv.getUint32(a + 6 + i * 6, true)))); break; }
      case 0x0204: { const r = dv.getUint16(a, true), c = dv.getUint16(a + 2, true), cch = dv.getUint16(a + 6, true), fl = wb[a + 8]; let s = ''; if (fl & 1) for (let i = 0; i < cch; i++) s += String.fromCharCode(dv.getUint16(a + 9 + i * 2, true)); else for (let i = 0; i < cch; i++) s += String.fromCharCode(wb[a + 9 + i]); put(r, c, s); break; }
      case 0x0205: { const r = dv.getUint16(a, true), c = dv.getUint16(a + 2, true); if (wb[a + 7] === 0) put(r, c, wb[a + 6] ? 'TRUE' : 'FALSE'); break; }   // errors stay empty
      case 0x0006: {   // formula: cached result
        const r = dv.getUint16(a, true), c = dv.getUint16(a + 2, true), xf = dv.getUint16(a + 4, true);
        if (dv.getUint16(a + 12, true) === 0xFFFF) { const t = wb[a + 6]; if (t === 0) lastF = [r, c]; else if (t === 1) put(r, c, wb[a + 8] ? 'TRUE' : 'FALSE'); }
        else put(r, c, val(xf, dv.getFloat64(a + 6, true)));
        break;
      }
      case 0x0207: if (lastF) { put(lastF[0], lastF[1], len >= 3 ? str16(a) : ''); lastF = null; } break;
    }
  }
  return { rows, count };
}
// Writes the CSV text of one sheet through put(Uint8Array). Header row = first non-empty row; its width fixes the width.
function xlsToCsv(B, sheetIx, put) {
  const sh = B.sheets[sheetIx], R = xlsSheetRows(B, sh), enc = new TextEncoder(), q = (s) => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  let width = 0, rows = 0, dropped = 0, out = [], size = 0;
  for (let r = 0; r < R.rows.length; r++) {
    const cells = R.rows[r]; if (!cells) continue;
    let max = -1; for (let c = cells.length - 1; c >= 0; c--) if (cells[c] !== undefined) { max = c; break; } if (max < 0) continue;
    if (!rows) { width = max + 1; for (let c = 0; c < width; c++) if (cells[c] === undefined) cells[c] = 'column_' + (c + 1); }
    if (max + 1 > width) dropped += max + 1 - width;
    let line = ''; for (let c = 0; c < width; c++) { if (c) line += ','; const v = cells[c]; if (v !== undefined) line += q(v); }
    out.push(line + '\n'); rows++; size += line.length + 1; if (size > (4 << 20)) { put(enc.encode(out.join(''))); out = []; size = 0; }
  }
  if (out.length) put(enc.encode(out.join('')));
  return { rows, width, dropped };
}
const xlsCache = new WeakMap();
async function xlsOpen(file) {   // the parsed workbook, or null when the file is not an Excel 97-2003 workbook
  if (xlsCache.has(file)) return xlsCache.get(file);
  let B = null; if (file && file.size >= 1024) { const h = new Uint8Array(await file.slice(0, 8).arrayBuffer()); if (XLS_MAGIC.every((b, i) => h[i] === b)) { const st = xlsOleStream(new Uint8Array(await file.arrayBuffer())); if (st) B = xlsBook(st.data); } }
  xlsCache.set(file, B); return B;
}
function xlsVisible(B) { const v = []; B.sheets.forEach((s, i) => { if (s.type === 0 && !s.hidden) v.push(i); }); if (!v.length) B.sheets.forEach((s, i) => { if (s.type === 0) v.push(i); }); return v; }
async function xlsList(file) {
  const B = await xlsOpen(file); if (!B) throw new Error('This is not an Excel file.'); const v = xlsVisible(B); if (!v.length) throw new Error('This Excel file has no worksheets.');
  let pick = v[0]; for (const i of v) { if (xlsSheetRows(B, B.sheets[i]).count > 0) { pick = i; break; } }
  return { entries: v.map((i) => ({ name: B.sheets[i].name, size: -1 })), picked: B.sheets[pick].name, sheets: true, kind: 'Sheet' };
}
async function xlsToCsvFile(file, wantSheet) {
  const B = await xlsOpen(file), v = xlsVisible(B); if (!v.length) throw new Error('This Excel file has no worksheets.');
  const parts = []; let acc = [], accN = 0; const put = (b) => { acc.push(b); accN += b.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
  let ix = wantSheet ? B.sheets.findIndex((s) => s.name === wantSheet) : -1, r;
  if (ix >= 0) r = xlsToCsv(B, ix, put);
  else { for (const i of v) { parts.length = 0; acc = []; accN = 0; r = xlsToCsv(B, i, put); ix = i; if (r.rows) break; } }
  if (acc.length) parts.push(new Blob(acc)); if (!r || !r.rows) throw new Error('The sheet has no data.');
  return { file: new File(parts, String(file.name).replace(/\.[^.]*$/, '') + '.csv', { type: 'text/csv' }), sheet: B.sheets[ix].name, sheets: v.length, rows: r.rows, width: r.width, dropped: r.dropped };
}
// ---- xlsb (Excel binary workbook, BIFF12): a zip of binary records, read in one pass per sheet (streamed, so a large sheet does not need to fit in memory) into the same CSV text as .xls and .xlsx.
// Record layout (Microsoft [MS-XLSB], https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/): type is 1 or 2 bytes, length is 1 to 4 bytes of 7 bits each, high bit = more.
const isXlsb = (f) => /\.xlsb$/i.test(f.name || '');
function xlbScan(u8, start, end, cb) {   // calls cb(id, a, len, dv) for each whole record; returns the offset of the first incomplete record, or -1 when cb asked to stop
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.length); let p = start;
  while (p < end) {
    let q = p, id = u8[q++]; if (id & 128) { if (q >= end) return p; id = (id & 127) | (u8[q++] << 7); }
    let len = 0, sh = 0, more = true; for (let i = 0; i < 4 && more; i++) { if (q >= end) return p; const b = u8[q++]; len += (b & 127) * Math.pow(2, sh); sh += 7; more = (b & 128) !== 0; }
    if (q + len > end) return p;
    if (cb(id, q, len, dv, u8) === true) return -1;
    p = q + len;
  }
  return p;
}
const xlbU16 = new TextDecoder('utf-16le');
function xlbStr(u8, dv, o) {   // XLWideString: u32 length in characters, then UTF-16LE
  const n = dv.getUint32(o, true); if (n === 0xFFFFFFFF) return ['', o + 4]; if (n > 1 << 24) throw new Error('This Excel file is damaged.');
  return [xlbU16.decode(u8.subarray(o + 4, o + 4 + 2 * n)), o + 4 + 2 * n];
}
const xlbCache = new WeakMap();
async function xlbOpen(file) {
  if (xlbCache.has(file)) return xlbCache.get(file);
  let list; try { list = await unzipFile(file, null, true); } catch (e) { throw new Error('This Excel file cannot be read. It may be password-protected or damaged.'); }
  const names = new Set(list.entries.map((x) => x.name));
  if (!names.has('xl/workbook.bin')) throw new Error('This is not an Excel binary (.xlsb) workbook: xl/workbook.bin is missing.');
  const bytes = async (n) => new Uint8Array(await (await unzipFile(file, n)).file.arrayBuffer());
  const B = { d1904: false, sheets: [], sst: [], kinds: [], names };
  const wb = await bytes('xl/workbook.bin'), rels = names.has('xl/_rels/workbook.bin.rels') ? await (await unzipFile(file, 'xl/_rels/workbook.bin.rels')).file.text() : '';
  const relMap = new Map(); { const re = /<Relationship\b([^>]*?)\/?>/g; let m; while ((m = re.exec(rels))) { const id = /\bId="([^"]*)"/.exec(m[1]), tg = /\bTarget="([^"]*)"/.exec(m[1]), ty = /\bType="([^"]*)"/.exec(m[1]); if (id && tg) relMap.set(id[1], { target: tg[1], type: ty ? ty[1] : '' }); } }
  xlbScan(wb, 0, wb.length, (id, a, len, dv) => {
    if (id === 0x99 && len >= 4) B.d1904 = (dv.getUint32(a, true) & 1) === 1;
    else if (id === 0x9C && len >= 12) {
      const st = dv.getUint32(a, true), [rid, o] = xlbStr(wb, dv, a + 8), [name] = xlbStr(wb, dv, o), r = relMap.get(rid); if (!r) return;
      let t = r.target; t = t[0] === '/' ? t.slice(1) : 'xl/' + t; B.sheets.push({ name, path: t, hidden: st !== 0, sheet: /\/worksheet$/.test(r.type) });
    }
  });
  if (names.has('xl/sharedStrings.bin')) { const s = await bytes('xl/sharedStrings.bin'); xlbScan(s, 0, s.length, (id, a, len, dv) => { if (id === 0x13 && len >= 5) B.sst.push(xlbStr(s, dv, a + 1)[0]); }); }
  if (names.has('xl/styles.bin')) {
    const s = await bytes('xl/styles.bin'), custom = new Map(); let inXf = false;
    xlbScan(s, 0, s.length, (id, a, len, dv) => {
      if (id === 0x2C && len >= 6) custom.set(dv.getUint16(a, true), xlbStr(s, dv, a + 2)[0]);
      else if (id === 0x269) inXf = true; else if (id === 0x26A) inXf = false;
      else if (id === 0x2F && inXf && len >= 4) B.kinds.push(xlsFmtKind(dv.getUint16(a + 2, true), custom));
    });
  }
  xlbCache.set(file, B); return B;
}
const xlbVisible = (B) => { const v = B.sheets.filter((s) => s.sheet && !s.hidden); return v.length ? v : B.sheets.filter((s) => s.sheet); };
// Streams one sheet. onRow(cells) gets each non-empty row as a sparse array of strings (in file order); return true from it to stop early.
async function xlbSheet(file, B, sh, onRow) {
  if (!B.names.has(sh.path)) throw new Error('The sheet "' + sh.name + '" is missing from the workbook.');
  const z = await unzipFile(file, sh.path, false, true), rd = z.stream.getReader(), sst = B.sst, kinds = B.kinds, d1904 = B.d1904;
  let cells = [], stop = false, carry = null;
  const val = (xf, v) => { const k = kinds[xf] | 0; return k && isFinite(v) ? xlsSerial(v, k, d1904) : String(v); };
  const flush = () => { if (cells.length) { const c = cells; cells = []; if (onRow(c) === true) stop = true; } };
  const put = (c, s) => { if (s === '' || s === undefined || c > 16383) return; cells[c] = s; };
  const cb = (id, a, len, dv, u8) => {
    switch (id) {
      case 0x00: flush(); return stop;
      case 0x02: if (len >= 12) { const c = dv.getUint32(a, true); put(c, val(dv.getUint32(a + 4, true) & 0xFFFFFF, xlsRk(dv.getUint32(a + 8, true)))); } break;
      case 0x05: case 0x09: if (len >= 16) { const c = dv.getUint32(a, true); put(c, val(dv.getUint32(a + 4, true) & 0xFFFFFF, dv.getFloat64(a + 8, true))); } break;
      case 0x07: if (len >= 12) put(dv.getUint32(a, true), sst[dv.getUint32(a + 8, true)]); break;
      case 0x06: case 0x08: if (len >= 12) put(dv.getUint32(a, true), xlbStr(u8, dv, a + 8)[0]); break;
      case 0x04: case 0x0A: if (len >= 9) put(dv.getUint32(a, true), dv.getUint8(a + 8) ? 'TRUE' : 'FALSE'); break;   // errors (3, 11) stay empty, as in .xls
      case 0x92: flush(); return true;
    }
    return stop;
  };
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    let buf = value; if (carry) { buf = new Uint8Array(carry.length + value.length); buf.set(carry, 0); buf.set(value, carry.length); carry = null; }
    const p = xlbScan(buf, 0, buf.length, cb); if (p < 0 || stop) { try { await rd.cancel(); } catch (e) {} flush(); return; }
    if (p < buf.length) carry = buf.slice(p);
  }
  flush();
}
async function xlbHasData(file, B, sh) { let any = false; await xlbSheet(file, B, sh, () => { any = true; return true; }); return any; }
async function xlbList(file) {
  const B = await xlbOpen(file), v = xlbVisible(B); if (!v.length) throw new Error('This Excel file has no worksheets.');
  let pick = v[0]; for (const s of v) { if (await xlbHasData(file, B, s)) { pick = s; break; } }
  return { entries: v.map((s) => ({ name: s.name, size: -1 })), picked: pick.name, sheets: true, kind: 'Sheet' };
}
async function xlbToCsvFile(file, wantSheet) {
  const B = await xlbOpen(file), v = xlbVisible(B); if (!v.length) throw new Error('This Excel file has no worksheets.');
  const enc = new TextEncoder(), q = (s) => (/[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  let want = wantSheet ? B.sheets.filter((s) => s.sheet && s.name === wantSheet) : v, res = null;
  for (const sh of want) {
    const parts = []; let acc = [], accN = 0, width = 0, rows = 0, dropped = 0, out = [], size = 0;
    const put = (b) => { acc.push(b); accN += b.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
    await xlbSheet(file, B, sh, (cells) => {
      let max = cells.length - 1; while (max >= 0 && cells[max] === undefined) max--; if (max < 0) return;
      if (!rows) { width = max + 1; for (let c = 0; c < width; c++) if (cells[c] === undefined) cells[c] = 'column_' + (c + 1); }
      if (max + 1 > width) dropped += max + 1 - width;
      let line = ''; for (let c = 0; c < width; c++) { if (c) line += ','; const x = cells[c]; if (x !== undefined) line += q(x); }
      out.push(line + '\n'); rows++; size += line.length + 1; if (size > (4 << 20)) { put(enc.encode(out.join(''))); out = []; size = 0; }
    });
    if (out.length) put(enc.encode(out.join(''))); if (acc.length) parts.push(new Blob(acc));
    if (rows) { res = { file: new File(parts, String(file.name).replace(/\.[^.]*$/, '') + '.csv', { type: 'text/csv' }), sheet: sh.name, sheets: v.length, rows, width, dropped }; break; }
  }
  if (!res) throw new Error('The sheet has no data.');
  return res;
}

// ---- Zip entries that are big CSV text are not first written to a Blob: the inflate stream is kept in memory as it arrives and the import starts at once (the parse helpers get the bytes of their segment by message), so unpacking overlaps parsing.
class LazyBlob {
  constructor(f, a, b) { this.f = f; this.a = a; this.b = b; this.size = b - a; this.type = f ? f.type : ""; }
  arrayBuffer() { return this.f.bytes(this.a, this.b).then((u) => u.buffer); }
  text() { return this.arrayBuffer().then((b) => new TextDecoder().decode(b)); }
  slice(x, y) { const n = this.size; x = x == null ? 0 : x < 0 ? Math.max(0, n + x) : Math.min(x, n); y = y == null ? n : y < 0 ? Math.max(0, n + y) : Math.min(y, n); return new LazyBlob(this.f, this.a + x, this.a + Math.max(x, y)); }
  stream() { const f = this.f; let at = this.a; const end = this.b; return new ReadableStream({ async pull(ctl) { if (at >= end) { ctl.close(); return; } const to = Math.min(end, at + 1048576); ctl.enqueue(await f.bytes(at, to)); at = to; } }); }
}
class LazyFile extends LazyBlob {
  constructor(name, size, stream) { super(null, 0, size); this.f = this; this.name = name; this.type = 'text/csv'; this.lazy = true; this.chunks = []; this.starts = []; this.have = 0; this.done = false; this.err = null; this.waiters = []; this.pump(stream); }
  async pump(stream) {
    try { const rd = stream.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; this.starts.push(this.have); this.chunks.push(value); this.have += value.length; this.wake(); } if (this.have !== this.size) throw new Error('The zip entry did not unpack to its recorded size.'); } catch (e) { this.err = e; }
    this.done = true; this.wake();
  }
  async settle() { while (!this.done) await new Promise((r) => this.waiters.push(r)); if (this.err) throw this.err; }   // the checksum is only known when the stream ends
  wake() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  async bytes(a, b) {
    b = Math.min(b, this.size); while (this.have < b && !this.done) await new Promise((r) => this.waiters.push(r));
    if (this.err) throw this.err; if (this.have < b) throw new Error('The zip entry ended early.');
    const out = new Uint8Array(Math.max(0, b - a)); if (b <= a) return out;
    let lo = 0, hi = this.starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.starts[mid] <= a) lo = mid; else hi = mid - 1; }
    let o = 0, i = lo; while (o < out.length) { const c = this.chunks[i], from = Math.max(0, a + o - this.starts[i]), take = Math.min(c.length - from, out.length - o); out.set(c.subarray(from, from + take), o); o += take; i++; }
    return out;
  }
}
const ZIP_STREAM_MAX = 600 * 1048576;   // owner cap: above this the old unpack path runs
async function lazyZipFile(file, want) {   // a LazyFile for a big CSV-like entry, or null (the ordinary unpack then runs)
  const list = await unzipFile(file, null, true), name = want || list.picked, ent = list.entries.find((x) => x.name === name);
  if (!ent || !/\.(csv|tsv|txt)$/i.test(name) || ent.size < SEG_MIN_FILE || ent.size > ZIP_STREAM_MAX || (ent.method !== 0 && ent.method !== 8)) return null;
  const zs = await unzipFile(file, name, false, true);
  return { file: new LazyFile(name.split('/').pop(), zs.usz, zs.stream), picked: name, entries: list.entries.map((x) => x.name) };
}
async function importWithEncoding(m) {
  const early = { cancelled: false, pre: true }; jobs.set(m.id, early);   // a cancel that arrives while the file is checked still counts
  try {
    for (let hop = 0; hop < 2 && m.file; hop++) {   // a .zip or .gz is unpacked first (a .gz inside a .zip too); an unpack error is reported, not imported as text
      if (isXlsx(m.file)) { const x = isXlsb(m.file) ? await xlbToCsvFile(m.file, m.zipEntry) : await xlsxToCsvFile(m.file, m.zipEntry); m = Object.assign({}, m, { file: x.file }); send('notice', m.id, { text: 'Read sheet "' + x.sheet + '" from the Excel workbook' + (x.sheets > 1 ? ' (' + x.sheets + ' sheets).' : '.') + (x.dropped ? ' ' + x.dropped + ' cells to the right of the header were left out.' : '') }); }
      else if (isOds(m.file)) { const x = await odsToCsvFile(m.file, m.zipEntry); m = Object.assign({}, m, { file: x.file }); send('notice', m.id, { text: 'Read sheet "' + x.sheet + '" from the OpenDocument spreadsheet' + (x.sheets > 1 ? ' (' + x.sheets + ' sheets).' : '.') + (x.dropped ? ' ' + x.dropped + ' cells to the right of the header were left out.' : '') }); }
      else if (isZip(m.file)) { const z = (!m.noStreamZip && await lazyZipFile(m.file, m.zipEntry)) || await unzipFile(m.file, m.zipEntry); m = Object.assign({}, m, { file: z.file }); send('notice', m.id, { text: 'Opened ' + z.picked + ' from the zip file' + (z.entries.length > 1 ? ' (' + z.entries.length + ' files inside).' : '.') }); }
      else if (isGz(m.file)) { m = Object.assign({}, m, { file: await gunzipFile(m.file) }); send('notice', m.id, { text: 'This file was gzip-compressed, so it was unpacked first.' }); }
      else if (await isArrowFile(m.file)) { const ap = m.noArrow ? null : await arrowPlan(m.file); if (ap) { arrowPlans.set(m.file, ap); m = Object.assign({}, m, { arrowNear: true }); send('notice', m.id, { text: 'Read ' + ap.rows.toLocaleString('en-US') + ' rows and ' + ap.cols.length + ' columns from the Arrow file.' }); break; } const x = await arrowToCsvFile(m.file); m = Object.assign({}, m, { file: x.file }); send('notice', m.id, { text: 'Read ' + x.rows.toLocaleString('en-US') + ' rows and ' + x.columns + ' columns from the Arrow file.' }); break; }
      else if (await isDbfFile(m.file)) { const x = await dbfToCsvFile(m.file); m = Object.assign({}, m, { file: x.file }); send('notice', m.id, { text: 'Read ' + x.rows.toLocaleString('en-US') + ' rows and ' + x.columns + ' columns from the dBase file' + (x.deleted ? ' (' + x.deleted.toLocaleString('en-US') + ' deleted rows skipped)' : '') + '.' + (x.left.length ? ' Left out (they cannot be read): ' + x.left.slice(0, 5).join(', ') + (x.left.length > 5 ? ', and ' + (x.left.length - 5) + ' more' : '') + '.' : '') }); break; }
      else if (await isDtaFile(m.file)) { const x = await dtaToCsvFile(m.file); m = Object.assign({}, m, { file: x.file }); send('notice', m.id, { text: 'Read ' + x.rows.toLocaleString('en-US') + ' rows and ' + x.columns + ' columns from the Stata file' + (x.labels ? '; value labels are shown as text' : '') + (x.dates ? '; date columns are shown as dates' : '') + '.' }); break; }
      else if (await xlsOpen(m.file)) { const x = await xlsToCsvFile(m.file, m.zipEntry); m = Object.assign({}, m, { file: x.file }); send('notice', m.id, { text: 'Read sheet "' + x.sheet + '" from the Excel 97-2003 workbook' + (x.sheets > 1 ? ' (' + x.sheets + ' sheets).' : '.') + (x.dropped ? ' ' + x.dropped + ' cells to the right of the header were left out.' : '') }); break; }
      else if (await isSqliteFile(m.file)) { const x = await sqliteToCsvFile(m.file, m.zipEntry); m = Object.assign({}, m, { file: x.file }); send('notice', m.id, { text: 'Read table "' + x.table + '" from the SQLite database' + (x.tables > 1 ? ' (' + x.tables + ' tables).' : '.') + (x.blobs ? ' ' + x.blobs + ' binary (BLOB) cells were left empty.' : '') + (x.wal ? ' The database uses write-ahead logging, so changes still in its -wal file are not included.' : '') }); break; }
      else break;
    }
  } catch (err) { jobs.delete(m.id); return send('error', m.id, { message: String(err && err.message || err) }); }
  if (m.file && (m.arrowNear || await isParquet(m.file))) return importFile(Object.assign({}, m, { parquet: true, untyped: true }));   // binary: no text checks
  try { const u16 = m.file && m.file.size > 1 ? await sniffUtf16(m.file) : null; if (u16) { m = Object.assign({}, m, { file: await utf16ToUtf8File(m.file, u16) }); send('notice', m.id, { text: 'This file was UTF-16, so it was converted to UTF-8.' }); } else if (m.file && m.file.size && await notUtf8(m.file)) { m = Object.assign({}, m, { file: await toUtf8File(m.file) }); send('notice', m.id, { text: 'This file is not UTF-8, so it was read as Windows-1252.' }); } }
  catch { /* the normal import reports any real problem */ }
  try { const xm = await xmlStage(m); if (xm) { m = Object.assign({}, m, { file: xm.file, delimiter: ',' }); send('notice', m.id, { text: xm.text }); } } catch (err) { jobs.delete(m.id); return send('error', m.id, { message: String(err && err.message || err) }); }
  try { const gj = await geoStage(m); if (gj) { m = Object.assign({}, m, { file: gj.file }); send('notice', m.id, { text: gj.text }); } } catch (err) { jobs.delete(m.id); return send('error', m.id, { message: String(err && err.message || err) }); }
  try { const fx = await fixedWidthStage(m); if (fx) { m = Object.assign({}, m, { file: fx.file, delimiter: ',' }); send('notice', m.id, { text: fx.text, widths: fx.widths || undefined }); } else if (m.delimiter === 'fixed') m = Object.assign({}, m, { delimiter: 'auto' }); } catch (err) { jobs.delete(m.id); return send('error', m.id, { message: String(err && err.message || err) }); }
  return importFile(m);
}
const isNdjson = (f) => /\.(ndjson|jsonl|json|geojson)$/i.test(f.name || '');
// NDJSON: one JSON object per line is already the JSON-lines form LFC-pack packs, so the bytes go to the pack workers cut at line ends; the first 2000 lines give the column names and types.
// JSON objects to flat JSON lines (wasm, flat.c). Cuts each top-level object out of an array or a line stream, drops white space outside strings, and writes the members of a one-level nested object as dotted names ("trip":{"distance":1} becomes "trip.distance":1). Deeper nesting, a key over 1000 bytes or an object over 4 MB sets an error bit.
function flatTransform() {
  const bin = Uint8Array.from(atob('AGFzbQEAAAABGAVgAAF/YAF/AX9gAX8AYAF+AGADfn9/AAMQDwAAAQAAAAAAAAIBAQMEAQQFAXABAQEFBAEA9AEGCQF/AUGwwswHCwd2DQZtZW1vcnkCAAVua2V5cwAACGtleXNfcHRyAAEHa2V5X29mZgACB2JpZ251bXMAAwZpbl9wdHIABAdvdXRfcHRyAAUEcm93cwAGBmVycm9ycwAHCGZpbmlzaGVkAAgFcmVzZXQACQVzcGxpdAAKBHNjYW4ADgq4Mg8LAEEAKAKgiICAAAsIAEGwiICAAAsRACAAQQJ0QbCIhIAAaigCAAsLAEEAKAK0mISAAAsIAEHAmISAAAsIAEHAmMSCAAsLAEEAKALAuMSHAAsLAEEAKALEuMSHAAsLAEEALQDIuMSHAAvQAgEBf0EAQQA2AtC4xIcAQQBBADYCzLjEhwBBAEEANgLUuMSHAEEAQQA6AMi4xIcAQQBBADoA2LjEhwBBAEEAOgDcuMSHAEEAQQA2AuC4xIcAQQBBADYC5LjEhwBBAEEANgLouMSHAEEAQQA6AOy4xIcAQQBBADYCxLjEhwBBAEEANgLAuMSHAEEAQQA6APC4xIcAQQBBADoA9LjEhwBBAEEANgL4uMSHAEEAQQA2Avy4xIcAQQBBADYCtJiEgABBAEEAOgCAucSHAEEAKAKEucSHACEBQQAgADYCoLnEhwBBACABQQFqNgKEucSHAEEAQQAoAoi5xIcAQQFqNgKIucSHAEEAQQA2AqCIgIAAQQBBADYCsIiEgABBAEEAOgCMucSHAEEAQQA2ApC5xIcAQQBBADYClLnEhwBBAEEAOgCYucSHAEEAQQA2Apy5xIcAC8MbAhF/AX5BACEBQQAhAgJAQQAtAMi4xIcADQBBACEBAkACQAJAAkACQAJAQQAoAtC4xIcAIgNFDQBBwJjEggBBACgC1LjEhwAiBEHAmMSCAGogA/wKAAACQEEAKALouMSHAEUNAEEAQQAoAuS4xIcAIARrNgLkuMSHAAtBACEBQQAtAIC5xIcARQ0CQQBBACgCpLnEhwAgBGs2AqS5xIcADAELQQAhBEEALQCAucSHAEUNAwsCQAJAIAANAEEAIQEMAQtBACgCqLnEhwAhBUEAIQEDQAJAAkACQAJAAkAgAUHAmISAAGotAAAiBEFQakH/AXFBCkkNACAEQf8BcSICQVVqIgZBGk0NAQwCC0EAIAVBAWoiBTYCqLnEhwAgAyABakHAmMSCAGogBDoAAAwDC0EBIAZ0QY2AgCBxDQELIAJB5QBGDQAgAyABaiEDDAMLIAMgAWpBwJjEggBqIAQ6AABBAEEAOgCsucSHAAsgACABQQFqIgFHDQALIAMgAWohBEEAIQIMBAsgASAASQ0BCyADIQQMAQtBAEEAOgCAucSHACADEIuAgIAAIQQLQQAhAiABIABPDQBBACECA0ACQCAEQYHA/wRJDQBBAEEAKALEuMSHAEEEcjYCxLjEhwAMAgsgAUHAmISAAGotAAAhAwJAAkACQAJAQQAoAvy4xIcAIgUNAAJAIANB+wBGDQAgA0HdAEcNBEEAQQE6AMi4xIcADAYLQQBBATYC/LjEhwBBAEEBOgDsuMSHACAEQcCYxIIAakH7ADoAAEEAQQAoAoS5xIcAQQFqNgKEucSHAEEAQQA2Apy5xIcAQQBBADoAmLnEhwBBAEEANgLouMSHAEEAQQA2Avi4xIcAQQBBADoA3LjEhwBBAEEANgLguMSHAEEAQQA2ArS5xIcADAELAkBBAC0A9LjEhwBFDQAgBEHAmMSCAGogAzoAACAEQQFqIQUCQEEALQDwuMSHAEUNAEEAQQA6APC4xIcADAMLAkAgA0EiRg0AIANB3ABHDQNBAEEBOgDwuMSHAAwDC0EAQQA6APS4xIcAQQAtANi4xIcARQ0CQQBBAjYC6LjEhwBBACAEQQAoAuS4xIcAQX9zakEAKALguMSHAGs2Asy4xIcAQQBBADoA2LjEhwAMAgsCQCADQXdqIgZBF0sNAEEBIAZ0QZOAgARxDQMLAkBBACgC+LjEhwAiBkUNAAJAIANBIkcNAEEAQQE6APS4xIcAIARBwJjEggBqQSI6AAAMAgsgBEHAmMSCAGogAzoAAAJAAkAgA0HfAXFBpX9qDgMAAwEDC0EAIAZBAWo2Avi4xIcADAILQQAgBkF/ajYC+LjEhwAMAQsCQEEAKALouMSHACIGQQNHDQBBAEEANgLouMSHAEEAKALguMSHACEGQQAoAsy4xIcAIQcCQAJAIAVBC0sNACADQfsARw0AQQAoAqC5xIcARQ0AQQEhBSAHIAZqQQFqQekHSQ0BCwJAQQAoApy5xIcAIghB/wNLDQAgBiAHaiEJQQAoAuS4xIcAIgpBwZjEggBqIQsCQEEALQCYucSHACIMDQAgCEEAKAKUucSHAE8NACAIQQJ0IgZBsOLEhwBqKAIAIAlBAWpHDQBBACEFIAZBsPLGhwBqKAIAQbDyxIcAaiINIQYgCyEHIAkhDgJAA0ACQCAFQQhqIg8gCU0NACAFIAlJDQIMBAsgCyAFaiEQIA0gBWohESAGQQhqIQYgB0EIaiEHIA5BeGohDiAPIQUgESkAACAQKQAAUQ0ADAILCwNAIAYtAAAgBy0AAEcNASAGQQFqIQYgB0EBaiEHIA5Bf2oiDkUNAgwACwsCQCAMDQBBAEEBOgCYucSHACAIRQ0AQQAhBwNAAkACQCAHQQJ0IgVBsOLEhwBqKAIAQX9qIgYNAEKDh/Sch/bDshQhEgwBCyAFQbDyxocAaigCAEGw8sSHAGohBUKDh/Sch/bDshQhEgNAIBIgBTEAAIVCs4OAgIAgfiESIAVBAWohBSAGQX9qIgYNAAsLIBIQjICAgAAgB0EBaiIHQQAoApy5xIcASQ0ACwsCQAJAIAkNAEKDh/Sch/bDshQhEgwBCyAKQcGYxIIAaiEFQoOH9JyH9sOyFCESIAkhBgNAIBIgBTEAAIVCs4OAgIAgfiESIAVBAWohBSAGQX9qIgYNAAsLIBIQjICAgAAgEiALIAkQjYCAgAACQEEAKAKQucSHACIFIAlqIgZBgIACSw0AAkAgCUUNACAFQbDyxIcAaiALIAn8CgAAC0EAIAY2ApC5xIcAQQAoApy5xIcAIghBAnQiBkGw8saHAGogBTYCACAGQbDixIcAaiAJQQFqNgIADAELQQBBAToAjLnEhwBBACgCnLnEhwAiCEECdEGw4sSHAGpBADYCAAtBACAIQQFqNgKcucSHAEEAKAKgucSHACEFCwJAIANB+wBHDQAgBUUNAAJAQQAoAvy4xIcAIgNBDEkNAEEAQQE2Avi4xIcAIARBwJjEggBqQfsAOgAAQQBBACgCxLjEhwBBAXI2AsS4xIcADAMLAkBBACgC4LjEhwAiBUEAKALMuMSHACIHaiIGQZh4akGWeEsNAEEAQQE2Avi4xIcAIARBwJjEggBqQfsAOgAAQQBBACgCxLjEhwBBAnI2AsS4xIcADAMLIANBAnQiCUHwucSHAGogBTYCAEEAKALkuMSHACEEAkAgB0UNACAFQbC6xIcAaiAEIAVqQcGYxIIAaiAH/AoAAAtBAEEBOgDsuMSHACAGQbC6xIcAakEuOgAAQQAgBkEBajYC4LjEhwBBACADQQFqIgM2Avy4xIcAIANBAnRBsLnEhwBqQQA2AgAgCUGwucSHAGoiAyADKAIAQX9qNgIAQQBBADoA3LjEhwAMBAtBACgC6LjEhwAhBgsCQCAGQQJHDQAgA0E6Rw0DQQBBAzYC6LjEhwAgBEHAmMSCAGpBOjoAAAwBCwJAAkACQAJAAkACQAJAAkACQCADQdoASg0AIANBIkYNASADQSxGDQMgA0E6Rw0GIARBwJjEggBqQTo6AAAMCQsgA0GFf2oOAwEFAwQLAkBBAC0A7LjEhwBFDQBBACAENgLkuMSHAEEAQQE6ANi4xIcAIARBwJjEggBqQSI6AABBACgC/LjEhwBBAnRBsLnEhwBqIgMgAygCAEEBajYCAEEAQQA6ANy4xIcAQQBBADoA7LjEhwAgBEEBaiEFAkACQEEAKALguMSHACIDDQAgBSEEDAELIARBwZjEggBqQbC6xIcAIAP8CgAAIAUgA2ohBAtBAEEBNgLouMSHAEEAQQE6APS4xIcADAoLQQBBAToA9LjEhwAgBEHAmMSCAGpBIjoAAAwHC0EAQQE2Avi4xIcAIARBwJjEggBqQfsAOgAADAYLAkACQEEALQDcuMSHAEUNAEEAQQA6ANy4xIcADAELIARBwJjEggBqQSw6AAAgBEEBaiEEC0EAQQE6AOy4xIcAQQBBADYC6LjEhwAMBwsCQEEAKAL8uMSHACIDQQJJDQACQAJAIANBAnRBsLnEhwBqKAIAIgUNAEEAQQE6ANy4xIcAIANBf2ohAwwBCwJAQQAtANy4xIcARQ0AIARFDQAgBEF/aiAEIARBv5jEggBqLQAAQSxGGyEECyADQX9qIgNBAnRBsLnEhwBqIgYgBigCACAFajYCAEEAQQA6ANy4xIcAC0EAIAM2Avy4xIcAQQAgA0ECdEHwucSHAGooAgA2AuC4xIcAQQBBADoA7LjEhwAMBwsCQAJAQQAtANy4xIcADQAgBCEDDAELQQAhA0EAQQA6ANy4xIcAIARFDQAgBEF/aiAEIARBv5jEggBqLQAAQSxGGyEDCyADQcGYxIIAakEKOgAAIANBwJjEggBqQf0AOgAAQQBBACgCwLjEhwBBAWo2AsC4xIcAQQBBACgCnLnEhwAiBEGABCAEQYAESRs2ApS5xIcAQQBBADYC/LjEhwAgA0ECaiECAkBBAC0AjLnEhwANAEEAKAKQucSHAEGBgAFJDQMLQQBBADYCkLnEhwBBAEEANgKUucSHAEEAQQA6AIy5xIcADAILIANB2wBGDQILAkACQEEALQDsuMSHAA0AAkAgA0EtRg0AIANBUGpB/wFxQQlLDQELQQAgBDYCpLnEhwBBAEEBOgCsucSHAEEAQQA2Aqi5xIcAAkAgASAATw0AQQAhA0EAIQcDQAJAAkAgASADaiIGQcCYhIAAai0AACIFQVBqQf8BcUEJSw0AQQAgB0EBaiIHNgKoucSHAAwBCwJAAkACQAJAIAVBVWoOBAMBAgMACyAFQeUARg0CIAVBxQBGDQILIAQgA2ohBAwGCyADRQ0BC0EAQQA6AKy5xIcACyAEIANqQcCYxIIAaiAFOgAAAkAgA0EBaiIDIAFqIgYgAE8NACADQYAgSQ0BCwsgBCADaiEEAkAgA0GAIEkNAEEAQQAoAsS4xIcAQQRyNgLEuMSHAAwICyAGIABJDQILQQBBAToAgLnEhwAgACEBDAYLIARBwJjEggBqIAM6AAAMAwsgBkF/aiEBIAQQi4CAgAAhBAwECyACIQQMAwtBAEEBNgL4uMSHACAEQcCYxIIAakHbADoAAAsgBEEBaiEEDAELIAUhBAsgAUEBaiIBIABJDQALC0EAIAI2AtS4xIcAIAQgAmshAQtBACABNgLQuMSHACACC8sBAQZ/AkBBAC0ArLnEhwBFDQBBACgCqLnEhwAiAUEQSQ0AQQAhAkEAKAKkucSHACIDQcCYxIIAaiEEAkAgAUEQSw0AIAQgBC0AAEEtRmohAQJAA0AgASACai0AACIFIAJBgIiAgABqLQAAIgZHDQEgAkEBaiICQRBGDQMMAAsLIAUgBk0NAQsgBEEBaiAEIAAgA2v8CgAAIARBIjoAACAAQcGYxIIAakEiOgAAQQBBACgCtJiEgABBAWo2ArSYhIAAIABBAmohAAsgAAuaAQEDfwJAIABCIIggAIWnQf8HcSIBQQJ0QbCCx4cAaiICKAIAQQAoAoS5xIcAIgNHDQADQAJAIAFBA3RBsKLHhwBqKQMAIABSDQBBAEEAKALEuMSHAEEIcjYCxLjEhwAPCyABQQFqQf8HcSIBQQJ0QbCCx4cAaiICKAIAIANGDQALCyACIAM2AgAgAUEDdEGwoseHAGogADcDAAuKAgEGfwJAQQAoAqCIgIAAIgNB/wNLDQAgA0ECdEGwiISAAGooAgAiBCACaiIFQf//A0sNAAJAIABCIIggAIWnQf8HcSIGQQJ0QbDix4cAaiIHKAIAQQAoAoi5xIcAIghHDQADQCAGQQN0QbCCyIcAaikDACAAUQ0CIAZBAWpB/wdxIgZBAnRBsOLHhwBqIgcoAgAgCEYNAAsLIAcgCDYCACAGQQN0QbCCyIcAaiAANwMAAkAgAkUNACAEQbCIgIAAaiEGA0AgBiABLQAAOgAAIAFBAWohASAGQQFqIQYgAkF/aiICDQALC0EAIANBAWoiATYCoIiAgAAgAUECdEGwiISAAGogBTYCAAsLwA4ECX8BewZ/AX5BACEBQQBBACgCiLnEhwBBAWo2Aoi5xIcAQQBBADYCoIiAgABBAEEANgKwiISAAEEAQQA2ApS5xIcAQQBBADYCnLnEhwACQCAARQ0AQQAhAkEAIQNBACEEQQAhBUEAIQZBACEBQQAhB0EAIQgDQAJAAkACQAJAAkACQAJAAkAgCEHAmISAAGotAAAiCUEiRw0AQQEgASAGQQ9LGyABIAUbIAEgBBshASAIQQFqIQQgA0EBRw0BAkAgB0H/AXEiCEH7AEYNACAIQSxHDQILIAQhCQNAAkACQAJAIAkiCEEQaiIJIABNDQAgCCAASQ0BDAcLIAhBwJiEgABq/QAAACIK/QwiIiIiIiIiIiIiIiIiIiIi/SMgCv0MXFxcXFxcXFxcXFxcXFxcXP0j/VD9ZCIHRQ0CIAdoIAhqIghBwJiEgABqLQAAIQkMAQsDQCAIQcCYhIAAai0AACIJQSJGDQEgCUHcAEYNASAAIAhBAWoiCEYNBgwACwsgCUH/AXFBIkYNBSAIQQJqIQkMAAsLAkACQAJAIAlBUGpB/wFxQQlLDQACQCAEDQAgB0H/AXEhC0EAIQVBASEGIAkhB0EBIQQCQAJAIAtBVWoOBAwBAQwACyALQcUARg0EIAtB5QBGDQQLQQEhBiAJIQdBASEFQQEhBAwKC0EBIQQgBkEBaiEGDAELAkAgBEUNAEEBIAEgCUHfAXFBxQBHGyABIAlBLkcbIAEgBkEPSxsgASAFGyEBC0EAIQQCQCAJQXdqIgtBF0sNAEEBIAt0QZOAgARxDQkLAkAgCUHfAXEiB0HbAEcNAAJAIANFDQAgA0EBaiEDDAILQQAhAkEAQQA2Apy5xIcAQQEhAyAJIQcMBAsgB0HdAEcNACADRQ0AIANBf2oiAw0AQQAhBEEAIAJBgAQgAkGABEkbNgKUucSHACAJIQdBACEDDAgLIAkhBwwHCyAJIQdBASEEDAYLA0ACQAJAIAQiCEEQaiIEIABNDQBBACEEQSIhByAIIABPDQYDQCAIQcCYhIAAai0AACIJQSJGDQIgCUHcAEYNAiAAIAhBAWoiCEYNBwwACwsgCEHAmISAAGr9AAAAIgr9DCIiIiIiIiIiIiIiIiIiIiL9IyAK/QxcXFxcXFxcXFxcXFxcXFxc/SP9UP1kIglFDQEgCWggCGoiCEHAmISAAGotAAAhCQtBIiEHIAlB/wFxQSJGDQEgCEECaiEEDAALC0EAIQQMBAsgACEICyAIIARrIQwCQAJAIAJB/wNLDQAgAkEAKAKUucSHAE8NACACQQJ0IgdBsMLEhwBqKAIAIAxHDQAgBEHAmISAAGohDUEAIQkgB0Gw0sSHAGooAgBBwJiEgABqIg4hByAEIQMCQANAIAlBCGoiCyAMSw0BIA0gCWohDyAOIAlqIRAgB0EIaiEHIANBCGohAyALIQkgECkAACAPKQAAUg0CDAALCyAJIAxPDQEDQCAHLQAAIANBwJiEgABqLQAARw0BIAdBAWohByAIIANBAWoiA0YNAgwACwsgBEHAmISAAGohB0KDh/Sch/bDshQhEQJAIAggBEYNAEKDh/Sch/bDshQhESAEIQkDQCARIAlBwJiEgABqMQAAhUKzg4CAgCB+IREgCCAJQQFqIglHDQALCyARIAcgDBCNgICAAEEAKAKcucSHACICQf8DSw0AIAJBAnQiCUGwwsSHAGogDDYCACAJQbDSxIcAaiAENgIAC0EBIQNBACEEQQAgAkEBaiICNgKcucSHAEEiIQcgCEEBaiIJIABPDQIgCUHAmISAAGotAABBOkcNAiAIQQJqIgggAE8NAQJAAkADQAJAIAhBwJiEgABqLQAAIglBIEYNACAJQSJHDQMgCEEBaiEJDAILIAAgCEEBaiIIRw0ACyAAIQgMAwsDQAJAAkACQCAJIghBEGoiCSAATQ0AIAggAEkNAQwFCyAIQcCYhIAAav0AAAAiCv0MIiIiIiIiIiIiIiIiIiIiIv0jIAr9DFxcXFxcXFxcXFxcXFxcXFz9I/1Q/WQiC0UNAiALaCAIaiIIQcCYhIAAai0AACEJDAELA0AgCEHAmISAAGotAAAiCUEiRg0BIAlB3ABGDQEgACAIQQFqIghHDQALIAAhCEEBIQMMBQsCQCAJQf8BcUEiRg0AIAhBAmohCQwBCwtBIiEHDAMLAkAgCUEtRiIHDQAgCUFQakH/AXFBCUsNAgsCQCAHIAhqIgsgAE8NACAHIAhqIQdBACEJAkADQCAHIAlqIgtBwJiEgABqLQAAIg9BUGpB/wFxQQlLDQEgByAJQQFqIglqIABJDQALIAAhCwwBCyAJQRBJDQAgD0EuRg0AIA9BxQBGDQAgD0HlAEYNAEEBIQELIAsgCE0NASALQX9qIQggC0G/mISAAGotAAAhBwwCCyAAIQgMAQsgCEF/aiEIQTohBwsgCEEBaiIIIABJDQALCyABCwsYAQBBgAgLETkwMDcxOTkyNTQ3NDA5OTEAAK8BBG5hbWUACwpmbGF0Ni53YXNtAXsPAAVua2V5cwEIa2V5c19wdHICB2tleV9vZmYDB2JpZ251bXMEBmluX3B0cgUHb3V0X3B0cgYEcm93cwcGZXJyb3JzCAhmaW5pc2hlZAkFcmVzZXQKBXNwbGl0CwhxdW90ZUJpZwwGcm93QWRkDQZyZWdBZGQOBHNjYW4HEgEAD19fc3RhY2tfcG9pbnRlcgkKAQAHLnJvZGF0YQA4CXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQxVYnVudHUgY2xhbmcRMTguMS4zICgxdWJ1bnR1MSkAQg90YXJnZXRfZmVhdHVyZXMEKwtidWxrLW1lbW9yeSsPbXV0YWJsZS1nbG9iYWxzKwhzaWduLWV4dCsHc2ltZDEyOA=='), (c) => c.charCodeAt(0)), X = new WebAssembly.Instance(new WebAssembly.Module(bin), {}).exports; X.reset(1);
  const ip = X.in_ptr(), op = X.out_ptr(), mem = new Uint8Array(X.memory.buffer);
  const f = (chunk) => {
    if (chunk.length > (5 << 20)) throw new Error('chunk too large'); mem.set(chunk, ip); const n = X.split(chunk.length), e = X.errors();
    if (e & 1) throw new Error('JSON nested more than one level deep is not supported yet.'); if (e & 2) throw new Error('A JSON key is longer than 1000 bytes.'); if (e & 4) throw new Error('A single JSON object is larger than 4 MB.'); if (e & 8) throw new Error('A JSON object has the same name twice once nested objects are flattened (for example "trip.distance" as a key and inside "trip"). Rename one of them so no value is lost.');
    return mem.slice(op, op + n);
  }; f.rows = () => X.rows(); f.reset = (flat) => X.reset(flat === 0 ? 0 : 1); f.finished = () => X.finished(); f.big = () => X.bignums();
  f.scan = (bytes) => { if (bytes.length > (5 << 20)) throw new Error('chunk too large'); mem.set(bytes, ip); const maybe = X.scan(bytes.length); return { maybeBig: !!maybe, keys: f.keys() }; };
  f.keys = () => { const n = X.nkeys(), kp = X.keys_ptr(), out = [], dc = new TextDecoder(); for (let i = 0; i < n; i++) { try { out.push(JSON.parse('"' + dc.decode(mem.subarray(kp + X.key_off(i), kp + X.key_off(i + 1))) + '"')); } catch { /* an odd key is skipped */ } } return out; };
  return f;
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
    if (!splitter && !t.flatPack) { const tmp = flatTransform(), cut = bytes.lastIndexOf(10, Math.min(bytes.length, 4 << 20) - 1) + 1; if (cut > 0 && tmp.scan(bytes.subarray(0, cut)).maybeBig) { tmp.reset(0); const tb = tmp(bytes.subarray(0, cut)); if (tmp.big()) bytes = tb; } }   // whole numbers beyond 2^53 are quoted (kept as text), here for the column types as in the pack workers
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
    if (!splitter && !t.flatPack) t.scanPack = true;
    if (splitter) { for (const k of splitter.keys()) (t.keys ||= new Set()).add(k); t.big = Math.max(t.big || 0, splitter.big()); }
    t.parseMs += performance.now() - s; await onBytes(body); onProgress(Math.min(file.size, off + SL), rows);
  }
  if (!splitter && carry.length && dec.decode(carry).trim()) { const body = new Uint8Array(carry.length + 1); body.set(carry); body[carry.length] = 10; if (!headers) sniff(body); rows++; await onBytes(body); { const tmp = flatTransform(); for (const k of tmp.scan(body).keys) (t.keys ||= new Set()).add(k); } }
  if (!headers || !headers.length) throw new Error('The file has no JSON lines.');
  return { headers, types: kinds.map((x, c) => ({ type: dateCand[c] ? 'date' : (x || 'string'), nullable: true })), rows, sample, lateKeys: () => { const have = new Set(headers); return [...(t.keys || [])].filter((k) => !have.has(k)); }, refine: (types) => { for (let c = 0; c < headers.length; c++) { if (types[c].type === 'integer' && t.chkDec && t.chkDec.has(headers[c])) types[c].type = 'number'; if (types[c].type === 'date' && t.chkBad && t.chkBad.has(headers[c])) types[c].type = 'string'; } } };
}
async function importFile(m) {
  if (m.parquet) { let mm = m; for (let tries = 0; tries < 8; tries++) { const r = await importOnce(mm); if (!r || r === 'mixed' || r.pqExact == null) return; mm = Object.assign({}, mm, { exact: tries >= 2 ? 'all' : (Array.isArray(mm.exact) ? mm.exact : []).concat(r.pqExact) }); } send('error', m.id, { message: 'Too many Parquet columns need exact 64-bit integers.' }); return; }
  const r = await importFile0(m);
  if (r && r.enc) { try { m = Object.assign({}, m, { file: await toUtf8File(m.file), reencoded: true }); } catch (err) { return send('error', m.id, { message: String(err && err.message || err) }); } send('notice', m.id, { text: 'This file is not UTF-8, so it was read as Windows-1252.' }); return importFile0(m); }
}
async function importFile0(m) {
  if (m.file && isNdjson(m.file)) m = Object.assign({}, m, { ndjson: true, untyped: true, noColumns: true });
  const demote = new Set(); let mm = m;
  for (let tries = 0; tries < 4; tries++) {
    const r = await importOnce(mm); if (!r) return; if (r.enc) return r;
    if (r === 'normalize') {   // tidy the file once, then import it the normal way; if it cannot be tidied the first error is reported
      let nz = null; try { nz = await normalizeFile(m.file, m.delimiter); } catch { nz = null; }
      if (!nz) { send('error', m.id, { message: mm.firstError, line: mm.firstLine }); return; }
      send('notice', m.id, { text: nz.text }); m = Object.assign({}, m, { file: nz.file, delimiter: nz.delimiter, normalized: true }); mm = Object.assign({}, m, { demote: [...demote] }); tries--; continue;
    }
    if (r === 'mixed' || tries === 3) break;
    demote.add(r.col); mm = Object.assign({}, m, { demote: [...demote] });
  }
  const r2 = await importOnce(Object.assign({}, m, { noColumns: true })); if (r2 && r2.enc) return r2;
}
const columnsOk = (m) => !m.noColumns && typeof WebAssembly !== 'undefined' && (m.columns === true || (!((self.navigator && self.navigator.deviceMemory) < 8) && (!/Android|iPhone|iPad|iPod|Mobile/i.test((self.navigator && self.navigator.userAgent) || '') || (self.navigator && self.navigator.deviceMemory) >= 8)))   // phones too when the browser reports 8 GB or more (Chrome caps the report at 8): measured on an 8 GB Android phone, first rows 1.0 s instead of 1.8-2.0 s, save 16-24% later;
// ---- Tidy stage: a delimited file that the strict reader rejects (comment lines, short or long rows, backslash escapes, stray quotes) is rewritten as clean CSV once, then imported normally. Files the strict reader accepts never pay for it.
// Tidy a delimited text file that the strict reader rejected: comment lines, ragged rows, backslash escapes, stray quotes.
// makeNormalizer(o) -> { feed(bytes) -> Uint8Array|null, end() -> Uint8Array|null, stats }
// o: delim (byte), comments (bool), backslash (bool), width (0 = take it from the first row)
function makeNormalizer(o) {
  const D = o.delim, Q = 34, BS = 92, NL = 10, CR = 13;
  const st = { comments: 0, headerPad: 0, padded: 0, truncated: 0, escapes: 0, blank: 0, rows: 0, maxFields: 0, width: o.width || 0, quotedDelim: 0 };
  let fb = new Uint8Array(1 << 16), fn = 0, ob = new Uint8Array(1 << 20), on = 0, doneEnd = 0;
  let needQ = false, fields = 0, rowStart = true, inQ = false, justClosed = false, quoted = false, pendBS = false, bomChecked = false, sawCR = false, skipLine = false, firstRow = true, cutPos = -1;
  const growF = () => { const n = new Uint8Array(fb.length * 2); n.set(fb); fb = n; };
  const need = (n) => { if (on + n > ob.length) { const m = new Uint8Array(Math.max(ob.length * 2, on + n)); m.set(ob.subarray(0, on)); ob = m; } };
  const pushF = (c) => { if (fn >= fb.length) growF(); fb[fn++] = c; if (c === D || c === Q || c === NL || c === CR) needQ = true; };
  const pushRun = (b, i, j) => { const k = j - i; while (fn + k > fb.length) growF(); if (k < 48) { for (let x = 0; x < k; x++) fb[fn + x] = b[i + x]; } else fb.set(b.subarray(i, j), fn); fn += k; };
  const spPlain = new Uint8Array(256), spQ = new Uint8Array(256); spPlain[D] = spPlain[Q] = spPlain[NL] = spPlain[CR] = 1; spQ[Q] = 1; if (o.backslash) { spPlain[BS] = 1; spQ[BS] = 1; }
  const emit = () => {   // write the logical field fb[0..fn) with CSV quoting
    if (st.width && fields === st.width && !firstRow && cutPos < 0) cutPos = on;   // the delimiter before the first extra field goes here
    const q = needQ; needQ = false;
    need(fn * 2 + 4);
    if (fields > 0) ob[on++] = D;
    if (q) { ob[on++] = Q; for (let i = 0; i < fn; i++) { const c = fb[i]; if (c === Q) ob[on++] = Q; ob[on++] = c; } ob[on++] = Q; }
    else if (fn < 48) { for (let x = 0; x < fn; x++) ob[on + x] = fb[x]; on += fn; } else { ob.set(fb.subarray(0, fn), on); on += fn; }
    fields++; fn = 0; quoted = false; justClosed = false;
  };
  const colName = (i) => { const s = 'column_' + (i + 1); for (let k = 0; k < s.length; k++) ob[on++] = s.charCodeAt(k); };
  const finishRow = () => {
    if (fields === 0 && fn === 0 && !quoted) { st.blank++; rowStart = true; return; }
    emit();
    if (firstRow) {
      if (!st.width) st.width = fields;
      if (fields < st.width) { for (let i = fields; i < st.width; i++) { need(24); ob[on++] = D; colName(i); } st.headerPad = st.width - fields; }
      firstRow = false;
    } else if (st.width) {
      if (fields < st.width) { need(st.width - fields + 2); for (let i = fields; i < st.width; i++) ob[on++] = D; st.padded++; }
      else if (fields > st.width) { on = cutPos; st.truncated++; }
    }
    if (fields > st.maxFields) st.maxFields = fields;
    need(2); ob[on++] = NL; doneEnd = on; st.rows++; fields = 0; rowStart = true; cutPos = -1;
  };
  function feed(b) {
    let i = 0; const n = b.length;
    if (!bomChecked && n >= 3) { bomChecked = true; if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) { need(3); ob[on++] = 0xEF; ob[on++] = 0xBB; ob[on++] = 0xBF; doneEnd = on; i = 3; } }
    for (; i < n; i++) {
      const c = b[i];
      if (skipLine) { if (c === NL || c === CR) { skipLine = false; sawCR = c === CR; } continue; }
      if (pendBS) {
        pendBS = false;
        if (c === Q || c === D || c === BS) { pushF(c); st.escapes++; continue; }
        if (c === 78 && fn === 0 && !inQ && !quoted) { st.escapes++; continue; }   // \N is a null: the field stays empty
        pushF(BS);   // not an escape: keep the backslash and treat c normally
      }
      if (inQ) {
        if (o.backslash && c === BS) { pendBS = true; continue; }
        if (c === Q) { inQ = false; justClosed = true; continue; }
        needQ = true; let j = i + 1; while (j < n && !spQ[b[j]]) j++; if (c === D) st.quotedDelim++; else for (let x = i + 1; x < j; x++) if (b[x] === D) { st.quotedDelim++; break; } pushRun(b, i, j); i = j - 1; continue;
      }
      if (justClosed) { if (c === Q) { inQ = true; justClosed = false; pushF(Q); continue; } justClosed = false; }
      if (c === NL || c === CR) { if (c === NL && sawCR) { sawCR = false; continue; } sawCR = c === CR; finishRow(); continue; }
      sawCR = false;
      if (rowStart) { rowStart = false; if (o.comments && c === 35) { st.comments++; skipLine = true; rowStart = true; continue; } }
      if (c === D) { emit(); continue; }
      if (c === Q && fn === 0 && !quoted && !o.noQuote) { inQ = true; quoted = true; continue; }
      if (c === Q) { pushF(c); continue; }   // a quote in the middle of a field is plain text; pushF marks the field for quoting on output
      if (o.backslash && c === BS) { pendBS = true; continue; }
      { let j = i + 1; while (j < n && !spPlain[b[j]]) j++; pushRun(b, i, j); i = j - 1; }
    }
    return take(false);
  }
  function take(final) {
    if (final && (fn || fields || inQ || quoted)) { if (pendBS) { pushF(BS); pendBS = false; } finishRow(); }
    if (!doneEnd) return null;
    const out = ob.slice(0, doneEnd); const rest = on - doneEnd; if (rest) ob.copyWithin(0, doneEnd, on); on = rest; if (cutPos >= 0) cutPos -= doneEnd; doneEnd = 0; return out;
  }
  return { feed, end: () => take(true), stats: st };
}
const NORMALIZE_ERR = /^(Line \d+: )?(Row has \d+ fields|Unexpected text after a closing quote|A quote may only start|The header has more)/;
async function normalizeFile(file, delimiter) {
  const sample = new Uint8Array(await file.slice(0, 4 << 20).arrayBuffer()); let s0 = 0; if (sample[0] === 0xEF && sample[1] === 0xBB && sample[2] === 0xBF) s0 = 3;
  const comments = sample[s0] === 35, text = new TextDecoder().decode(sample);
  const bs = /\\["\\,;\t|]/.test(text.slice(0, 4 << 20));
  let dch = delimiter && delimiter !== 'auto' ? delimiter : null;
  if (!dch) { await loadCore(); dch = core.detectDelimiter(comments ? text.split(/\r?\n/).filter((l) => l && l[0] !== '#').join('\n') : text); }
  const D = dch.charCodeAt(0); let dry = makeNormalizer({ delim: D, comments, backslash: bs }); dry.feed(sample.subarray(0, sample.length)); dry.end();
  let noQuote = false; if (D === 32 && dry.stats.quotedDelim === 0) { noQuote = true; dry = makeNormalizer({ delim: D, comments, backslash: bs, noQuote }); dry.feed(sample.subarray(0, sample.length)); dry.end(); }   // space-separated text (pageview lists): when no quoted field holds a space, a quote is just a character
  const ds = dry.stats; if (!ds.rows || (!comments && !bs && ds.rows >= 20 && ds.padded + ds.truncated > 0.3 * ds.rows)) return null;   // too irregular to be a tidy-able table: report the original error
  const nz = makeNormalizer({ delim: D, comments, backslash: bs, noQuote, width: ds.maxFields }), parts = []; let acc = [], accN = 0;
  const put = (b) => { if (!b) return; acc.push(b); accN += b.length; if (accN >= (4 << 20)) { parts.push(new Blob(acc)); acc = []; accN = 0; } };
  const rd = file.stream().getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; put(nz.feed(value)); }
  put(nz.end()); if (acc.length) parts.push(new Blob(acc));
  const st = nz.stats, bits = [];
  if (st.comments) bits.push(st.comments + ' comment line' + (st.comments === 1 ? '' : 's') + ' starting with # skipped');
  if (st.padded) bits.push(st.padded + ' short row' + (st.padded === 1 ? '' : 's') + ' filled with empty cells');
  if (st.truncated) bits.push(st.truncated + ' row' + (st.truncated === 1 ? ' had' : 's had') + ' more cells than the widest rows seen early in the file, and the extra cells were left out');
  if (st.headerPad) bits.push(st.headerPad + ' extra column' + (st.headerPad === 1 ? '' : 's') + ' named column_N for rows wider than the header');
  if (st.escapes) bits.push('backslash escapes read');
  if (st.maxFields > 0 && ds.maxFields > 0 && st.width > 0) { /* header widened by column_N names when rows were wider */ }
  return { file: new File(parts, String(file.name).replace(/\.[^.]*$/, '') + '.csv', { type: 'text/csv' }), delimiter: dch, text: 'This file had irregular rows, so it was tidied first: ' + (bits.join(', ') || 'blank lines removed') + '.' };
}
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
    let inlScan = null, packBytes = async (bytes) => { stop(job); const s = performance.now(); if (t.scanPack && !t.flatPack) { inlScan ||= flatTransform(); const sc = inlScan.scan(bytes); for (const k of sc.keys) (t.keys ||= new Set()).add(k); if (sc.maybeBig) { inlScan.reset(0); const tb = inlScan(bytes), bg = inlScan.big(); if (bg) { t.big = (t.big || 0) + bg; bytes = tb; } } } const parts = packer.push(bytes); t.packMs += performance.now() - s; await write(parts); };
    let dkBlocks = null;
    let tsJobs = null;
    let finishPacking = async () => {}, col = null, colFlush = async () => {}, liveChunks = null, morePack = null;
    const packWorkers = m.packWorkers != null ? m.packWorkers : (m.live === true && file.size <= LIVE_MAX && columnsOk(m) ? 1 : 2);   // live columns: Firefox packs with one worker while parsing (the cores go to the parse helpers) and gets three more when parsing is done; Chromium also packs with one while parsing and gets one more (measured: each is the best of the variants in its browser)   // measured faster in Firefox, WebKitGTK and Chromium together with the byte-level parser
    let pws = null;   // pack threads; some pages (a downloaded file on Chrome) cannot start a worker from inside a worker, then packing stays on this thread
    dropKeep(); if (packWorkers > 0 && (useSegments(m, file) || (m.parquet && columnsOk(m)))) { try { pws = []; for (let i = 0; i < packWorkers; i++) pws.push(mkWorker()); } catch { if (pws) pws.forEach((w) => w.terminate()); pws = null; } }
    if (pws) {   // blocks packed by worker threads, appended here in file order (LFC-pack 0.7.0 packBlock / pushPacked)
      const bb = m.blockBytes || 2097152, popts = Object.assign({ level: m.level || 3 }, { blockBytes: bb, share: false });
      packer = LfcPack.packStream(Object.assign({}, popts, { meta }));
      const ws = [], idle = [], done = new Map(); dkBlocks = new Map(); let seq = 0, emit = 0, parts = [], plen = 0, wake = null, wchain = Promise.resolve(), failed = null;
      const pump = () => { if (wake) { const r = wake; wake = null; r(); } };
      const onPacked = (w) => (e) => {
        const d = e.data; if (d.error) failed = new Error('Pack worker failed: ' + d.error); else { done.set(d.rid, d.r); if (d.keys) for (const k of d.keys) (t.keys ||= new Set()).add(k); if (d.big) t.big = (t.big || 0) + d.big; if (d.dk) dkBlocks.set(d.rid, d.dk); if (d.chk) { for (const x of d.chk.dec) (t.chkDec ||= new Set()).add(x); for (const x of d.chk.bad) (t.chkBad ||= new Set()).add(x); } }
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
      const dispatch = (chunk) => {   // plain JSON lines: the key scan runs here, on the reading thread (it waits for a free pack worker anyway), so the pack workers only pack
        let flat = t.flatPack ? 1 : t.scanPack ? 2 : 0;
        if (flat === 2) { inlScan ||= flatTransform(); const sc = inlScan.scan(chunk); for (const k of sc.keys) (t.keys ||= new Set()).add(k); flat = 0; if (sc.maybeBig) { inlScan.reset(0); const tb = inlScan(chunk), bg = inlScan.big(); if (bg) { t.big = (t.big || 0) + bg; chunk = tb.slice(); flat = 3; } } }   // 3: whole numbers already quoted, the block needs room for the extra quotes
        return send1({ type: 'packBlock', c: chunk, o: popts, flat, chk: t.chk }, [chunk.buffer]);
      };
      if (columnsOk(m)) {   // staged columns: chunks of typed columns are grouped into blocks of about colBlock bytes of CSV and packed by the pack workers
        const colBlock = m.colBlockBytes || 8388608; let cq = [], cqBytes = 0, cqRows = 0, colHeaders = null;
        // Live columns (desktop, file up to LIVE_MAX): the chunks are kept so the grid can read them as soon as parsing ends, while the pack workers still work through their queue.
        // Blocks wait in blockQ and go to the pack workers as copies (the kept chunks are not transferred), so parsing never waits for packing.
        liveChunks = m.live === true && file.size <= LIVE_MAX ? [] : null; let blockQ = [], pumping = null, pumpErr = null;
        const pump = () => { if (!pumping) pumping = (async () => { while (blockQ.length) { const b = blockQ.shift(); await send1({ type: 'packCols', chunks: b, headers: colHeaders, num: numPlan, o: popts }, [].concat(...b.map(chunkBuffers))); } })().catch((e) => { pumpErr = e; }).finally(() => { pumping = null; }); };
        const sendCols = async () => { const list = cq; cq = []; cqBytes = 0; cqRows = 0; if (liveChunks) { blockQ.push(list); pump(); } else await send1({ type: 'packCols', chunks: list, headers: colHeaders, num: numPlan, o: popts }, [].concat(...list.map(chunkBuffers))); };
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
        keepWorkers(ws);
      };
      var packWorkersToStop = ws;
    }
    let plan = m.untyped ? null : await samplePlan(file, delimiter); if (plan && m.demote) { plan = plan.map((x, c) => (m.demote.includes(c) ? false : x)); if (!plan.some(Boolean)) plan = null; } const dictPlan = !m.untyped && m.dict !== false ? samplePlan.dict || null : null, numPlan = !m.untyped && m.numFree !== false && samplePlan.num ? samplePlan.num.map((x, c) => x && !(plan && plan[c])) : null;
    let res = null;
    if (!m.ndjson && !m.parquet && useSegments(m, file)) res = await runSegmented(file, delimiter, job, packBytes, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t, m.segBytes || SEG_BYTES, plan, col, col ? dictPlan : null, m.parseHelpers);
    if (!res && !m.ndjson && !m.parquet) try { helper = m.inline ? null : mkWorker(); } catch { helper = null; }
        if (m.parquet) { res = await parseParquet(file, job, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t, write, packer, col, (p) => { plan = p; }, m.exact); if (res.plan) plan = res.plan; } else if (m.ndjson) { res = await parseNdjson(file, () => stop(job), packBytes, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t); } else if (res) { /* parsed in pieces */ } else if (helper) {   // parse on the helper, pack and write here: both run at once
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
    if (liveChunks && col && res.pieces && liveChunks.length && rows <= MAX_COLUMN_ROWS) { await startLive(m.id, name, headers, plan, liveChunks, rows, cols); if (view && view.live) for (const c of cols) if (c.type === 'date' && !view.cols.has(c.name)) { view.cols.set(c.name, view.live.column(c.name)); (tsJobs ||= []).push([view, c.name, view.live]); }   /* typed seconds for Save are made after 'done' (not on the import's critical path) */   /* date columns are the usual sort key: their text is made while the pack workers are still busy, so the first sort after the import has no decode */ const wide = ((self.navigator && navigator.hardwareConcurrency) || 4) >= 12 && !(self.navigator && navigator.deviceMemory && navigator.deviceMemory < 8);   // owner laptop (16 cores): Chrome is best at 4 pack workers in all (2 before), Firefox keeps gaining to 6; 4-core machines keep the old counts
    if (morePack && m.morePack !== 0) morePack(m.morePack || (wide ? (isFirefox ? 5 : /Chrome\//.test((self.navigator && navigator.userAgent) || '') ? 3 : 2) : isFirefox ? 3 : /Chrome\//.test((self.navigator && navigator.userAgent) || '') ? 1 : 2)); }
    if (view && view.preview && view.name === name && !(view.live)) { view = null; send('liveclosed', m.id, {}); }
    if (file && file.lazy) await file.settle(); await finishPacking(); if (res.refine) { res.refine(types); for (let i = 0; i < headers.length; i++) { cols[i].type = types[i].type; if (meta.tables[0].columns[i]) meta.tables[0].columns[i].type = types[i].type; } }
    if (res.lateKeys) {   // keys that first appear after the sampled rows become columns too (text type; the packed blocks hold the real values)
      const late = res.lateKeys().slice(0, 512); for (const k of late) { headers.push(k); types.push({ type: 'string', nullable: true }); cols.push({ name: k, type: 'string', nullable: true }); if (meta.tables[0].columns.length < 128) meta.tables[0].columns.push({ id: 'field-' + headers.length, name: k.slice(0, 100), type: 'string', nullable: true }); }
      if (late.length) send('notice', m.id, { text: late.length + (late.length === 1 ? ' column was' : ' columns were') + ' found after the first 2,000 rows and added to the table.' });
    }
    if (t.big) send('notice', m.id, { text: 'Some whole numbers have more digits than a number can hold exactly, so they were kept as text.' });
    if (dkBlocks && dkBlocks.size) { try { keptDict.set(name, mergeDicts(dkBlocks, rows)); } catch { keptDict.delete(name); } }
    await write(packer.finish());
    await writable.close(); closed = true; writable = null;
    // Complete only after the footer is validated, then recorded in the catalog.
    const v = await validate(name, rows);
    if (!v.ok) throw new IngestError('The written file failed footer validation: ' + v.reason);
    const cat = await store.catalog(); cat.push({ name, source: file.name, rows, bytes: outBytes, columns: cols, created: Date.now(), storage: STORAGE }); await store.setCatalog(cat);
    if (view && view.live && view.name === name) { try { const f2 = await store.file(name), R2 = await LfcPack.open(f2); Object.assign(view, { dictCols: keptDict.get(name) || null, R: R2, f: f2, flat: isFlatFile(R2), live: null }); liveChunks = null; textFromChunks(view); } catch { /* keep reading the kept columns */ } }   // the saved file takes over from the kept columns (same rows, same order)
    send('done', m.id, { dataset: { name, source: file.name, rows, bytes: outBytes, storage: STORAGE, delimiter: delimiter === '\t' ? 'TAB' : delimiter, columns: cols, sample, validation: v, ms: Math.round(performance.now() - t0), timing: { readMs: Math.round(t.readMs), parseMs: Math.round(t.parseMs), packMs: Math.round(t.packMs), writeMs: Math.round(t.writeMs), pieces: (res && res.pieces) || 0, redos: t.redos || 0, fastRows: t.fastRows || 0, columns: !!t.cols }, plan: plan ? plan.map(Boolean) : null, parallel: !!helper || !!(res && res.pieces), segmented: !!(res && res.pieces), serialTail: !!t.serialTail, redos: t.redos || 0, segWhy: t.segWhy } });
    if (tsJobs) { const jobs = tsJobs; setTimeout(async () => { for (const [v, nm, L] of jobs) { await yieldNow(); if (view !== v || (v.tsCache && v.tsCache.has(nm))) continue; try { (v.tsCache ||= new Map()).set(nm, L.tsColumn(nm)); } catch { /* Save parses the text instead */ } } }, 0); }
  } catch (err) {
    if (view && (view.live || view.preview) && view.name === name) { view = null; send('liveclosed', m.id, {}); }
    if (writable && !closed) { try { await writable.abort(); } catch {} }
    if (name) await store.remove(name);
    if (err && err.pqExact != null && m.parquet) restart = { pqExact: err.pqExact };   // an INT64 column holds a value beyond 2^53: read that column as exact digit text and start again
    else if (err && err.mixed && !m.noColumns) restart = err.col != null && err.col >= 0 ? { col: err.col } : true;
    else if (!m.reencoded && !m.ndjson && /TextDecoder/.test(String(err && err.message)) && /not valid|decoding failed/i.test(String(err && err.message))) restart = { enc: true };   // a Windows-1252 byte past the sampled start: read the file again as Windows-1252 (valid UTF-8 files never pay for a whole-file check)
    else if (!m.normalized && !m.strict && !m.ndjson && NORMALIZE_ERR.test(String(err && err.message || ''))) { restart = 'normalize'; m.firstError = String(err.message); m.firstLine = err.line || null; }
    else send(err && err.cancelled ? 'cancelled' : 'error', m.id, { message: String(err && err.message || err), line: err && err.line || null });
  } finally { if (helper) helper.terminate(); if (typeof packWorkersToStop !== 'undefined') packWorkersToStop.forEach((w) => { if (!(self.__keep && self.__keep.includes(w))) w.terminate(); }); jobs.delete(m.id); }
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
    view = { dictCols: keptDict.get(m.name) || null, name: m.name, R, f, total, rows: null, columns: entry.columns, indices: null, filtered: false, cols: new Map(), flat: isFlatFile(R), cache: new Map() };
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
    tsColumn(nm) {   // a fixed-width 'YYYY-MM-DD HH:MM:SS[.000000]' text column as epoch seconds (UTC), read straight from the kept bytes; null when any cell does not fit (then Save uses the text path)
      const k = headers.indexOf(nm), out = new Float64Array(rows); let at = 0, W = -1, lastKey = -1, lastDays = 0;
      const days = (Y, M, D) => { const yy = M <= 2 ? Y - 1 : Y, era = Math.floor(yy / 400), yoe = yy - era * 400, doy = Math.floor((153 * (M + (M > 2 ? -3 : 9)) + 2) / 5) + D - 1; return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468; };
      const one = (b, a, e) => {
        const w = e - a; if (w === 0) return NaN; if (W < 0) W = w; if (w !== W || w < 19 || b[a + 4] !== 45 || b[a + 10] !== 32) return undefined;
        for (let q = 19; q < w; q++) { if (q === 19 ? b[a + q] !== 46 : b[a + q] !== 48) return undefined; }
        const c0 = b[a] - 48, c1 = b[a + 1] - 48, c2 = b[a + 2] - 48, c3 = b[a + 3] - 48, c5 = b[a + 5] - 48, c6 = b[a + 6] - 48, c8 = b[a + 8] - 48, c9 = b[a + 9] - 48, c11 = b[a + 11] - 48, c12 = b[a + 12] - 48, c14 = b[a + 14] - 48, c15 = b[a + 15] - 48, c17 = b[a + 17] - 48, c18 = b[a + 18] - 48;
        if ((c0 >>> 0) > 9 || (c1 >>> 0) > 9 || (c2 >>> 0) > 9 || (c3 >>> 0) > 9 || (c5 >>> 0) > 9 || (c6 >>> 0) > 9 || (c8 >>> 0) > 9 || (c9 >>> 0) > 9 || (c11 >>> 0) > 9 || (c12 >>> 0) > 9 || (c14 >>> 0) > 9 || (c15 >>> 0) > 9 || (c17 >>> 0) > 9 || (c18 >>> 0) > 9) return undefined;
        const key = (((c0 * 10 + c1) * 10 + c2) * 10 + c3) * 10000 + (c5 * 10 + c6) * 100 + c8 * 10 + c9; if (key !== lastKey) { lastKey = key; lastDays = days(c0 * 1000 + c1 * 100 + c2 * 10 + c3, c5 * 10 + c6, c8 * 10 + c9); }
        return (lastDays * 24 + c11 * 10 + c12) * 3600 + (c14 * 10 + c15) * 60 + c17 * 10 + c18;
      };
      for (const ch of chunks) {
        const x = ch.cols[k];
        if (x.codes) { const lb = x.lb, v = new Float64Array(lb.start.length); for (let q = 0; q < v.length; q++) { const r = one(lb.bytes, lb.start[q], lb.end[q]); if (r === undefined) return null; v[q] = r; } for (let r = 0; r < ch.n; r++) out[at++] = v[x.codes[r]]; continue; }
        const b = x.bytes, st = x.start, en = x.end; for (let r = 0; r < ch.n; r++) { const v = one(b, st[r], en[r]); if (v === undefined) return null; out[at++] = v; }
      }
      out.fmt = W < 0 ? null : 'YYYY-MM-DD HH:MM:SS' + (W > 19 ? '.' + 'f'.repeat(W - 20) : '');
      return out;
    },
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
// Date column as epoch numbers (NaN = empty) for sorting: lfc-pack reads it as numbers; a column with an empty cell is stored as text and returns null here (the text sort stays).
async function dateKeys(n) {
  const v = view, c = v.columns.find((x) => x.name === n); if (!c || c.type !== 'date' || !LfcPack.unpackColumnsParallel) return null;
  v.dateKeys ||= new Map(); if (v.dateKeys.has(n)) return v.dateKeys.get(n);
  let out = null;
  try { const got = await LfcPack.unpackColumnsParallel(new Uint8Array(await v.f.arrayBuffer()), { keys: [n], dates: 'numbers', nulls: 'NaN' }); if (got[n] instanceof Float64Array) out = got[n]; } catch { out = null; }
  if (view === v) v.dateKeys.set(n, out); return out;
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
    const cols = await loadColumns(names, m.stream); let qcols = view.columns;
    if (m.sort && !m.filters[m.sort.col] && !m.stream) { const dk = await dateKeys(m.sort.col); if (dk && dk.length === view.total) { cols[m.sort.col] = dk; qcols = view.columns.map((c) => (c.name === m.sort.col ? Object.assign({}, c, { type: 'number' }) : c)); } }   // a date column sorts as numbers (epoch values read straight from the file), not as 3 million text values parsed one by one
    const tLoad = Math.round(performance.now() - t0), tq0 = performance.now(), r = colMod.runColumnQuery(cols, view.total, qcols, { filters: m.filters, sort: m.sort, top: m.noFirst ? 0 : FIRST_PAGE_ROWS });
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
// A file this app wrote holds flat rows only. The packer may store a very small block (a short last block of a wide file) in its nested form, which reads the same, so those files stay flat.
function isFlatFile(R) { const mine = !!(R.meta && R.meta.producer === 'LFCFoundry Workbench'); return R.blocks.length > 0 && R.blocks.every((b) => !b.table && (b.kind === 'f' || (mine && b.kind === 'n'))); }
async function groupView(m) {
  if (!view) return send('error', m.id, { message: 'No dataset is open.' });
  try {
    groupMod ||= MODS() && MODS().groupBy ? { groupBy: MODS().groupBy, groupByCodes: MODS().groupByCodes, groupBy2: MODS().groupBy2 } : await import('../src/query/groupby.mjs');
    queryMod ||= MODS() || await import('../src/query/query.mjs'); colMod ||= MODS() || await import('../src/query/columnar.mjs');
    if (view.total > MAX_COLUMN_ROWS) throw new Error('Group by works up to ' + MAX_COLUMN_ROWS.toLocaleString() + ' rows for now.');
    if (!view.flat) throw new Error('Group by needs a file of plain rows; this file holds nested or table blocks.');
    const t0 = performance.now(), aggs = m.aggs || [{ fn: 'count' }], names = [...new Set([m.key].concat(m.key2 ? [m.key2] : [], aggs.filter((a) => a.col).map((a) => a.col)))];
    const active = Object.keys(m.filters || {}).filter((k) => m.filters[k]);
    for (const n of names) if (!view.columns.some((c) => c.name === n)) throw new Error('No column named ' + n + '.');
    const dc = (!m.noDict && view.dictCols) || {}, useIds = !m.key2 && !!dc[m.key], two = !!m.key2;
    // a column kept as dictionary ids from the import is counted by id: no text is decoded for it (the key, or an equal-to column in a 'share equal to' aggregate)
    const need = Array.from(new Set(names.concat(active))).filter((n) => !((useIds || two) && dc[n] && !active.includes(n)));
    if (!/AppleWebKit(?!.*Chrome)/.test(self.navigator.userAgent || '') && !m.noParallel) await warmSome(need);   // missing columns decoded on helper threads at once (not in WebKitGTK: slower there)
    const cols = await loadColumns(need, false), tLoad = performance.now() - t0, tg = performance.now();
    // a number column that the import kept as text (a decimal with mixed digits after the point): sum, avg, min and max read it as numbers (NaN = empty), made once and kept
    for (const a of aggs) { const c = a.col && a.fn !== 'rate' && a.fn !== 'count' && view.columns.find((x) => x.name === a.col); if (c && (c.type === 'integer' || c.type === 'number') && !c.decimals && cols[a.col] && !ArrayBuffer.isView(cols[a.col])) { const nc = (view.numCache ||= new Map()); let f = nc.get(a.col); if (!f) { const t = cols[a.col]; f = new Float64Array(t.length); for (let i = 0; i < f.length; i++) { const x = t[i]; f[i] = x == null || x === '' ? NaN : +x; } nc.set(a.col, f); } cols[a.col] = f; } }
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
// The import's pack threads are kept for a minute after the import (their wasm is started and their memory paid) so a Save as LFCP of a big view can pack on them; dropKeep frees them.
function dropKeep(force) { if (self.__keepBusy && !force) { self.__keepDrop = true; return; }   // a Save is packing on them: dropped when it ends
  clearTimeout(self.__keepT); self.__keepBusy = false; self.__keepDrop = false; if (self.__keep) { for (const w of self.__keep) w.terminate(); self.__keep = null; } }
function keepWorkers(ws) { dropKeep(); if (!ws.length || !isFirefox) { for (const w of ws) w.terminate(); return; } self.__keep = ws.slice(); for (const w of ws) { w.onmessage = null; w.onerror = null; } self.__keepT = setTimeout(dropKeep, 60000); }
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
    const kept = !m.noKeep && self.__keep && self.__keep.length >= 2 && Math.ceil(count / BATCH) >= 13 ? self.__keep : null;
    let pool = null; const npool = m.noPool || !(isFirefox || kept) || !allWarm || !LfcPack.packBlock ? 0 : Math.min(kept ? kept.length : 3, Math.ceil(count / BATCH));   // Firefox only: in Chromium the helper threads were no faster (pack 0.44-0.62 s against 0.36-0.50 s on this thread)
    if (npool > 1 && kept) { clearTimeout(self.__keepT); self.__keepBusy = true; pool = kept; } else if (npool > 1) { try { pool = []; for (let i = 0; i < npool; i++) pool.push(new Worker(self.location.href)); } catch { if (pool) pool.forEach((w) => w.terminate()); pool = null; } }
    const results = new Map(); let nextW = 0, emit = 0, pending = 0, wake = null, failed = null;
    const drain = async () => { while (results.has(emit)) { const r = results.get(emit); results.delete(emit); emit++; await write(packer2.pushPacked(r)); } };
    if (pool) for (const w of pool) w.onmessage = (e) => { const d = e.data || {}; pending--; if (d.error) failed = new Error(d.error); else results.set(d.rid, d.r); if (wake) { const r = wake; wake = null; r(); } };
    let seq = 0;
    for (let start = 0; start < count; start += BATCH) {
      const end = Math.min(count, start + BATCH); let ts = performance.now();
      if (allWarm && LfcPack.packBlock) {   // every column is in memory: gather the batch column by column and pack it as columns (no row objects, no JSON text)
        const out = {}, n = end - start, fx = view.filtered ? view.indices.subarray(start, end) : null;   // the batch's row numbers are cut out once, not looked up per cell
        for (const c of cols) {
          const src = view.cols.get(c.name);
          if (!m.noTs && c.type === 'date' && Array.isArray(src)) {   // date text of a fixed width ('YYYY-MM-DD HH:MM:SS[.000000]') goes to packBlock as { kind: 'ts' } epoch seconds: parsed once for all rows (at the end of a live import from the kept bytes, otherwise here from the strings), the saved rows gathered as a typed copy
            const tc = view.tsCache || (view.tsCache = new Map()); let col = tc.get(c.name);
            if (col === undefined) { const t0p = performance.now(); col = new Float64Array(src.length); col.fmt = typeof src[0] === 'string' ? 'YYYY-MM-DD HH:MM:SS' + (src[0].length > 19 ? '.' + 'f'.repeat(src[0].length - 20) : '') : null; for (let r = 0; r < src.length; r++) { const v = src[r]; if (typeof v !== 'string' || v.length < 19 || v.charCodeAt(4) !== 45 || v.charCodeAt(10) !== 32 || v.length !== src[0].length || (v.length > 19 && !/^\.0+$/.test(v.slice(19)))) { col = null; break; }
                const Y = (v.charCodeAt(0) - 48) * 1000 + (v.charCodeAt(1) - 48) * 100 + (v.charCodeAt(2) - 48) * 10 + v.charCodeAt(3) - 48, M = (v.charCodeAt(5) - 48) * 10 + v.charCodeAt(6) - 48, D = (v.charCodeAt(8) - 48) * 10 + v.charCodeAt(9) - 48, h = (v.charCodeAt(11) - 48) * 10 + v.charCodeAt(12) - 48, mi = (v.charCodeAt(14) - 48) * 10 + v.charCodeAt(15) - 48, se = (v.charCodeAt(17) - 48) * 10 + v.charCodeAt(18) - 48;
                const yy = M <= 2 ? Y - 1 : Y, era = Math.floor(yy / 400), yoe = yy - era * 400, doy = Math.floor((153 * (M + (M > 2 ? -3 : 9)) + 2) / 5) + D - 1, doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; col[r] = ((era * 146097 + doe - 719468) * 24 + h) * 3600 + mi * 60 + se; }
              tc.set(c.name, col); }
            if (col) { const t = new Float64Array(n); if (fx) { for (let i = 0; i < n; i++) t[i] = col[fx[i]]; } else t.set(col.subarray(start, end)); out[c.name] = { kind: 'ts', unit: 's', values: t, fmt: col.fmt }; continue; }
          }
          if (ArrayBuffer.isView(src)) {   // a number column goes to LFC-pack as a typed array, NaN for an empty cell (lfc-pack 0.14.5: 0.86 to 0.91x the time of a plain array with nulls in Chromium, Firefox and WebKitGTK, same bytes)
            const t = new Float64Array(n); if (fx) { for (let i = 0; i < n; i++) t[i] = src[fx[i]]; } else t.set(src.subarray(start, end));
            out[c.name] = t; continue;
          }
          const a = new Array(n); if (fx) { for (let i = 0; i < n; i++) a[i] = src[fx[i]]; } else for (let i = 0; i < n; i++) a[i] = src[start + i];
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
    if (pool) { const ts = performance.now(); while (pending > 0 || results.size) { if (failed) throw failed; await drain(); if (pending > 0) await new Promise((r) => { wake = r; }); } tm.pack += performance.now() - ts; if (kept) { self.__keepBusy = false; if (self.__keepDrop) dropKeep(); else self.__keepT = setTimeout(dropKeep, 60000); } else pool.forEach((w) => w.terminate()); }
    await write(packer2.finish()); await writable.close(); closed = true; writable = null;
    const v = await validate(name, count); if (!v.ok) throw new Error('The written file failed footer validation: ' + v.reason);
    const cat = await store.catalog(), outCols = cols.map((c) => { const o = Object.assign({}, c); delete o.derived; delete o.from; delete o.fn; return o; });
    cat.push({ name, source: 'view of ' + view.name, rows: count, bytes: outBytes, columns: outCols, created: Date.now(), storage: STORAGE }); await store.setCatalog(cat);
    send('exportedLfcp', m.id, { name, rows: count, bytes: outBytes, blob: await store.file(name), ms: Math.round(performance.now() - t0), warmMs: Math.round(tWarm), rowsMs: Math.round(tm.rows), textMs: Math.round(tm.text), packMs: Math.round(tm.pack) });
  } catch (err) {
    if (self.__keepBusy) dropKeep(true);   // a failed Save: the kept threads may hold unfinished jobs, so they go
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
  var EX = false;   // exact INT64 mode (set by decodeChunk with { exact: true }): INT64 values stay BigInt64Array until they become digit text
  function plainNum(b, p, n, type, flba) {   // PLAIN number values -> Float64Array(n)
    if (EX && type === TY.I64) { var c9 = new Uint8Array(n * 8); c9.set(b.subarray(p, p + n * 8)); return new BigInt64Array(c9.buffer); }
    var out = new Float64Array(n), i;
    if (type === TY.F64) { var cp = new Uint8Array(n * 8); cp.set(b.subarray(p, p + n * 8)); out.set(new Float64Array(cp.buffer)); return out; }
    if (type === TY.I32) { var c4 = new Uint8Array(n * 4); c4.set(b.subarray(p, p + n * 4)); var a = new Int32Array(c4.buffer); for (i = 0; i < n; i++) out[i] = a[i]; return out; }
    if (type === TY.I64) { var c8 = new Uint8Array(n * 8); c8.set(b.subarray(p, p + n * 8)); var u = new Uint32Array(c8.buffer), h = new Int32Array(c8.buffer); for (i = 0; i < n; i++) { if (h[2 * i + 1] > 2097151 || h[2 * i + 1] < -2097152) throw rangeErr(); out[i] = h[2 * i + 1] * 4294967296 + u[2 * i]; } return out; }
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
  function rangeErr() { var e = new Error('INT64 value beyond 2^53 is not supported'); e.code = 'INT64_RANGE'; return e; }
  function deltaBPBig(b, p, count) {   // exact INT64 DELTA_BINARY_PACKED -> { vals: BigInt64Array, end }
    var q = p; function uv() { var r = 0, m = 1, c; do { c = b[q++]; r += (c & 127) * m; m *= 128; } while (c & 128); return r; }
    function uvb() { var r = 0n, sh = 0n, c; do { c = b[q++]; r |= BigInt(c & 127) << sh; sh += 7n; } while (c & 128); return r; }
    function zvb() { var v = uvb(); return (v & 1n) ? -((v + 1n) >> 1n) : (v >> 1n); }
    var bsz = uv(), mbn = uv(); uv(); var cur = zvb(), out = new BigInt64Array(count), o = 0, per = bsz / mbn, i, k, w, md, widths;
    if (count > 0) out[o++] = cur;
    while (o < count) {
      md = zvb(); widths = b.subarray(q, q + mbn); q += mbn;
      for (k = 0; k < mbn && o < count; k++) {
        w = widths[k];
        if (w === 0) { for (i = 0; i < per && o < count; i++) { cur = BigInt.asIntN(64, cur + md); out[o++] = cur; } }
        else { var base = q * 8; for (i = 0; i < per; i++) { var d = 0n, bp = base + i * w, got = 0, bi, sh, take; while (got < w) { bi = (bp + got) >> 3; sh = (bp + got) & 7; take = Math.min(8 - sh, w - got); d |= BigInt((b[bi] >> sh) & ((1 << take) - 1)) << BigInt(got); got += take; } if (o < count) { cur = BigInt.asIntN(64, cur + md + d); out[o++] = cur; } } q += (per * w) >> 3; }
      }
    }
    return { vals: out, end: q };
  }
  function deltaBP(b, p, count, wrap32) {
    if (EX && !wrap32) return deltaBPBig(b, p, count);
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
    if (wrap32) for (i = 0; i < count; i++) out[i] = out[i] | 0; else for (i = 0; i < count; i++) if (out[i] > 9007199254740991 || out[i] < -9007199254740991) throw rangeErr();
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
  // opts.exact: for an INT64 column, return digit text { bytes, start, end } (exact to 64 bits; UINT_64 columns as unsigned) instead of a Float64Array.
  // Detect the need: decodeChunk(col, ch, bytes, inflate) throws an Error whose .code is 'INT64_RANGE' when a value is beyond 2^53; retry that chunk (and the column's other chunks) with { exact: true }.
  function decodeChunk(col, ch, bytes, inflate, opts) {
    EX = !!(opts && opts.exact && col.type === TY.I64 && !col.nested);
    var r;
    try { r = decodeChunk1(col, ch, bytes, inflate); } finally { EX = false; }
    if (r instanceof Float64Array && !col.flba) {   // unsigned integer columns: UINT_32 comes back as signed 32-bit, UINT_64 as signed 64-bit
      var i, n = r.length;
      if (col.conv === 13 && col.type === TY.I32) { for (i = 0; i < n; i++) if (r[i] < 0) r[i] += 4294967296; }
      else if (col.conv === 14 && col.type === TY.I64) { for (i = 0; i < n; i++) if (r[i] < 0) throw rangeErr(); }
    }
    return r;
  }
  function decodeChunk1(col, ch, bytes, inflate) {
    if (col.nested) throw new Error('nested or repeated column "' + col.name + '" is not supported yet');
    var p = 0, end = bytes.length, isText = col.type === TY.BA, dict = null, parts = [], total = 0;
    function unc(body, ul) { return ch.codec === 0 ? body : ch.codec === 6 || ch.codec === 4 || ch.codec === 2 || ch.codec === 7 || ch.codec === 5 ? inflate(body, ul, ch.codec) : ch.codec === 1 ? snappy(body, ul) : (function () { throw new Error('This Parquet file is compressed with ' + ({ 3: 'LZO' }[ch.codec] || 'an unknown method (code ' + ch.codec + ')') + ', which Workbench cannot unpack yet. Save it again with ZSTD or Snappy.'); })(); }
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
  function bigText(big, nul, unsigned) {   // BigInt64Array (+ null flags) -> { bytes, start, end } decimal digits, null = empty
    var n = big.length, strs = new Array(n), tot = 0, i, v;
    for (i = 0; i < n; i++) { if (nul && nul[i]) { strs[i] = ''; continue; } v = unsigned ? BigInt.asUintN(64, big[i]) : big[i]; strs[i] = v.toString(); tot += strs[i].length; }
    var bytes = new Uint8Array(tot), st = new Int32Array(n), en = new Int32Array(n), o = 0, j, s;
    for (i = 0; i < n; i++) { st[i] = o; s = strs[i]; for (j = 0; j < s.length; j++) bytes[o++] = s.charCodeAt(j); en[i] = o; }
    return { bytes: bytes, start: st, end: en };
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
    if (!isText && EX) {   // exact INT64 -> digit text
      var big = new BigInt64Array(total), nul = new Uint8Array(total);
      for (k = 0; k < parts.length; k++) {
        var pe = parts[k], ve = pe.vals, se;
        if (ve.dictIdx) { se = new BigInt64Array(pe.nn); for (i = 0; i < pe.nn; i++) se[i] = dict[ve.dictIdx[i]]; } else se = ve;
        if (!pe.defs) big.set(se, o); else { var je = 0; for (i = 0; i < pe.nv; i++) { if (pe.defs[i]) big[o + i] = se[je++]; else nul[o + i] = 1; } }
        o += pe.nv;
      }
      return bigText(big, nul, col.conv === 14);
    }
    if (!isText) {
      var out = new Float64Array(total);
      for (k = 0; k < parts.length; k++) {
        var pt = parts[k], v = pt.vals, src;
        if (v.dictIdx) {   // gather the dictionary values straight into the output column
          var di = v.dictIdx;
          if (!pt.defs) { for (i = 0; i < pt.nn; i++) out[o + i] = dict[di[i]]; } else { var jd = 0, df = pt.defs; for (i = 0; i < pt.nv; i++) out[o + i] = df[i] ? dict[di[jd++]] : NaN; }
        } else { src = v; if (!pt.defs) { out.set(src, o); } else { var j = 0; for (i = 0; i < pt.nv; i++) out[o + i] = pt.defs[i] ? src[j++] : NaN; } }
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
const pqZstd = (s, n) => { if (s.length > zic) { if (zip_) ZX.free(zip_); zic = Math.max(s.length, 65536); zip_ = ZX.malloc(zic); } if (n > zoc) { if (zop) ZX.free(zop); zoc = Math.max(n, 65536); zop = ZX.malloc(zoc); } new Uint8Array(ZX.memory.buffer, zip_, s.length).set(s); const r = ZX.decompress(zop, n, zip_, s.length); if (ZX.is_error(r) || r !== n) throw new Error('This Parquet file has a damaged zstd page.'); return new Uint8Array(ZX.memory.buffer, zop, n); };
// Parquet GZIP pages: libdeflate 1.25 (MIT, Copyright 2016 Eric Biggers, 2024 Google LLC; https://github.com/ebiggers/libdeflate), built for wasm with SIMD, one-shot gunzip into wasm memory. A zlib-wrapped page (some old writers) is read through the raw-deflate entry.
// Notice (libdeflate, MIT; full text in docs/NOTICES-WASM-DECODERS.txt): Copyright 2016 Eric Biggers, Copyright 2024 Google LLC.
const GZ64 = 'AGFzbQEAAAABPwhgAX8Bf2ABfwBgA39/fwF/YAABf2AFf39/f38Bf2AHf39/f39/fwF/YAh/f39/f39/fwF/YAZ/f39/f38BfwMREAABAgIDAQMEBAUGBwMFBwIEBQFwAQMDBQcBAYAEgIAEBggBfwFBgNMECwc5BgZtZW1vcnkCAARoZWFwAAQHc2V0aGVhcAAFBGluaXQABgZndW56aXAABwtpbmZsYXRlX3JhdwAICQgBAEEBCwIAAQqcQxBVAQJ/QQAgAEEAKAL40oCAACIBQYDThIAAQQ9qQXBxIAEbIgFqQQ9qQXBxIgA2AvjSgIAAAkAgAD8AQRB0IgJNDQAgACACa0H//wNqQRB2QAAaCyABCwIACw4AIAAgASAC/AoAACAACw0AIAAgASAC/AsAIAALLQEBfwJAQQAoAvjSgIAAIgANAEEAQYDThIAAQQ9qQXBxIgA2AvjSgIAACyAACw0AQQAgADYC+NKAgAALMAEBf0EBIQACQEEAKAL80oCAAA0AQQAQjICAgAAiADYC/NKAgAAgAEEARyEACyAAC1EBAX8jgICAgABBEGsiBSSAgICAACAFQQA2AgxBACgC/NKAgAAgACABIAIgAyAFQQxqEI6AgIAAIQMgBCAFKAIMNgIAIAVBEGokgICAgAAgAwtRAQF/I4CAgIAAQRBrIgUkgICAgAAgBUEANgIMQQAoAvzSgIAAIAAgASACIAMgBUEMahCLgICAACEDIAQgBSgCDDYCACAFQRBqJICAgIAAIAMLzSUDFX8BewN/I4CAgIAAQRBrIgckgICAgAAgASACaiIIIAJBESACQRFJG2shCSADIARqIgogBEGXAiAEQZcCSRtrIQsgAEGk2gBqIQwgAEGYyQBqIQ0gAEHg1QBqIQ4gAEHMA2ohD0EAIRBBACERQQAhAiABIRIgAyETAkADQAJAAkAgCCASa0EDSw0AIAIhFCARQf8BcSICQRdLDQEDQAJAAkAgEiAIRg0AIBItAAAgAnQgFHIhFCASQQFqIRIMAQtBASEVIAghEiAQQQFqIhBBBEsNBQsgEUEIaiIRQf8BcSICQRhJDQAMAgsLIAdBDGogEkEEEIKAgIAAGiASIBFBA3ZBB3FrQQNqIRIgBygCDCARQf8BcXQgAnIhFCARQRhyIRELQQEhFQJAAkACQAJAAkACQCAUQQF2QQNxDgMEAQAHC0EAIQQgAEEAOgCgWiARQW9qIQIgFEERdiEWIBRBDXZBD3EiF0EEaiERIBRBCHZBH3FBAWohGCAUQQN2QR9xQYECaiEZA0ACQAJAIAJB/wFxIhpBAk0NACACIRsMAQsCQCAIIBJrQQNLDQAgAiEbA0ACQAJAIBIgCEYNACASLQAAIBp0IBZyIRYgEkEBaiESDAELQQEhFSAIIRIgEEEBaiIQQQRLDQsLIBtBCGoiG0H/AXEiGkEYSQ0ADAILCyAHQQxqIBJBBBCCgICAABogAkEYciEbIBIgAkEDdkEHcWtBA2ohEiAHKAIMIBp0IBZyIRYLIAAgBEGAiICAAGotAABqIBZBB3E6AAAgG0F9aiECIBZBA3YhFiAEQQFqIgQgEUcNAAsCQCAXQQ9GDQADQCAAIBdBhIiAgABqLQAAakEAOgAAIBdBAWoiF0EPRw0ACwsCQCAPIABBE0GgiICAAEEHQQcgDkEAEIqAgIAADQBBASEVDAcLIBkgGGohEUEAIQQDQAJAAkAgAkH/AXEiG0ENTQ0AIAIhFwwBCwJAIAggEmtBA0sNACACIRcDQAJAAkAgEiAIRg0AIBItAAAgG3QgFnIhFiASQQFqIRIMAQtBASEVIAghEiAQQQFqIhBBBEsNCwsgF0EIaiIXQf8BcSIbQRhJDQAMAgsLIAdBDGogEkEEEIKAgIAAGiACQRhyIRcgEiACQQN2QQdxa0EDaiESIAcoAgwgG3QgFnIhFgsgACAWQf8AcUECdGpBzANqKAIAIhtBEHYhGiAXIBtrIQIgFiAbQf8BcXYhFgJAAkAgG0H//z9LDQAgACAEaiAaOgAAIARBAWohBAwBCwJAAkACQAJAIBpBcGoOAgABAgsCQCAEDQBBASEVDAwLIAAgBGoiG0EFaiAbQX9qLQAAIhc6AAAgG0EEaiAXOgAAIBtBA2ogFzoAACAbQQJqIBc6AAAgG0EBaiAXOgAAIBsgFzoAACACQX5qIQIgFkEDcUEDaiEbIBZBAnYhFgwCCyAAIARqIhtCADcAACAbQQhqQQA7AAAgAkF9aiECIBZBB3FBA2ohGyAWQQN2IRYMAQsgACAEakEAIBZB/wBxQQtqIhsQg4CAgAAaIAJBeWohAiAWQQd2IRYLIBsgBGohBAsgBCARSQ0ACyAEIBFGDQFBASEVDAYLIBFBfWohAiAUQQN2IRYgAC0AoFoNASAA/QwFBQUFBQUFBQUFBQUFBQUFIhz9CwCwAiAAIBz9CwCgAiAA/QwHBwcHBwcHBwgICAgICAgI/QsAkAIgAP0MBwcHBwcHBwcHBwcHBwcHB/0LAIACIAD9DAkJCQkJCQkJCQkJCQkJCQkiHP0LAPABIAAgHP0LAOABIAAgHP0LANABIAAgHP0LAMABIAAgHP0LALABIAAgHP0LAKABIAAgHP0LAJABIAD9DAgICAgICAgICAgICAgICAgiHP0LAIABIAAgHP0LAHAgACAc/QsAYCAAIBz9CwBQIAAgHP0LAEAgACAc/QsAMCAAIBz9CwAgIAAgHP0LABAgACAc/QsAACAAQQE6AKBaQSAhGEGgAiEZCwJAIA0gACAZaiAYQfCIgIAAQQhBDyAOQQAQioCAgAANAEEBIRUMBQsgACAAIBlB8ImAgABBC0EPIA4gDBCKgICAAA0AQQEhFQwEC0F/IAwoAgB0QX9zIRgCQAJAIBIgCUkNACACIREMAQsCQCATIAtJDQAgAiERDAELIAdBDGogEkEEEIKAgIAAGiACQRhyIREgEiACQQN2QQdxa0EDaiESIAAgBygCDCACQf8BcXQgFnIiFiAYcUECdGooAgAhFQNAIBEgFWshESAWIBVB/wFxIhl2IQICQAJAAkAgFUF/Sg0AIAAgAiAYcUECdGooAgAhFyAHQQxqIBJBBBCCgICAABogBygCDCEEIBUhGyAXIRUMAQsCQAJAIBVBgIACcQ0AIBUhGyACIRcMAQsgFUGAwABxDQYgESAAIAJBfyAVQQh2dEF/c3EgFUEQdmpBAnRqKAIAIhtrIREgAiAbQf8BcSIZdiEXAkAgG0F/Sg0AIAAgFyAYcUECdGooAgAhFSAHQQxqIBJBBBCCgICAABogBygCDCEEIBchAgwCCyACIRYgG0GAwABxRQ0AIBchAgwGCyAAIBdB/wFxQQJ0akGYyQBqKAIAIQQgB0EMaiASQQQQgoCAgAAaIBFBGHIhHSASIBFBA3ZBB3FrQQNqIRogBygCDCARQf8BcXQgF3IhFwJAIARBgIACcUUNACAAIBdBCHYiF0F/IARBCHZBP3F0QX9zcSAEQRB2akECdGpBmMkAaigCACEEIAdBDGogGkEEEIKAgIAAGiAHKAIMIB1BeGoiAkH3AXF0IBdyIRcgAkEYciEdIBogAkEDdkEGcWtBA2ohGgsCQCAXQX8gBEH/AXEiEXRBf3NxIARBCHZB/wFxdiIeIARBEHYiH2oiAiATIANrTQ0AQQEhFQwICyAWQX8gGXRBf3NxIRIgACAXIBF2IhcgGHFBAnRqKAIAIRUgB0EMaiAaQQQQgoCAgAAaIAcoAgwgHSAEayIRQf8BcXQgF3IhFiATIBIgG0EIdkH/AXF2IBtBEHZqIhdqIRsgEyACayEEIBogEUEDdkEHcWtBA2ohEgJAAkAgAkEESQ0AIAdBDGogBEEEEIKAgIAAGiAHIAcoAgw2AgwgEyAHQQxqQQQQgoCAgAAaIAdBDGogBEEEakEEEIKAgIAAGiAHIAcoAgw2AgwgE0EEaiAHQQxqQQQQgoCAgAAaIAdBDGogBEEIakEEEIKAgIAAGiAHIAcoAgw2AgwgE0EIaiAHQQxqQQQQgoCAgAAaIAdBDGogBEEMakEEEIKAgIAAGiAHIAcoAgw2AgwgE0EMaiAHQQxqQQQQgoCAgAAaIAdBDGogBEEQakEEEIKAgIAAGiAHIAcoAgw2AgwgE0EQaiAHQQxqQQQQgoCAgAAaIBdBFUgNAUEAIAJrIRcgE0EUaiECA0AgB0EMaiACIBdqIgRBBBCCgICAABogByAHKAIMNgIMIAIgB0EMakEEEIKAgIAAGiAHQQxqIARBBGpBBBCCgICAABogByAHKAIMNgIMIAJBBGogB0EMakEEEIKAgIAAGiAHQQxqIARBCGpBBBCCgICAABogByAHKAIMNgIMIAJBCGogB0EMakEEEIKAgIAAGiAHQQxqIARBDGpBBBCCgICAABogByAHKAIMNgIMIAJBDGogB0EMakEEEIKAgIAAGiAHQQxqIARBEGpBBBCCgICAABogByAHKAIMNgIMIAJBEGogB0EMakEEEIKAgIAAGiACQRRqIgIgG0kNAAwCCwsCQCACQQFHDQAgByAELQAAQYGChAhsIgQ2AgwgEyAHQQxqQQQQgoCAgAAaIAcgBDYCDCATQQRqIAdBDGpBBBCCgICAABogByAENgIMIBNBCGogB0EMakEEEIKAgIAAGiAHIAQ2AgwgE0EMaiAHQQxqQQQQgoCAgAAaIBdBEUgNASATQRBqIQIDQCAHIAQ2AgwgAiAHQQxqQQQQgoCAgAAaIAcgBDYCDCACQQRqIAdBDGpBBBCCgICAABogByAENgIMIAJBCGogB0EMakEEEIKAgIAAGiAHIAQ2AgwgAkEMaiAHQQxqQQQQgoCAgAAaIAJBEGoiAiAbSQ0ADAILCyAHQQxqIARBBBCCgICAABogByAHKAIMNgIMIBMgB0EMakEEEIKAgIAAGiAHQQxqIBNBBBCCgICAABogByAHKAIMNgIMIBMgAmogB0EMakEEEIKAgIAAGiAeQQF0IB9BAXRqIQQgAkEDbCEZA0AgB0EMaiATIAJqIhdBBBCCgICAABogByAHKAIMNgIMIBMgBGoiGiAHQQxqQQQQgoCAgAAaIAdBDGogGkEEEIKAgIAAGiAHIAcoAgw2AgwgEyAZaiAHQQxqQQQQgoCAgAAaIBcgAmoiEyAEaiAbSQ0ACwsgGyETDAELIBMgG0EQdjoAACATQQFqIRMgBCARQf8BcXQgAnIhFiASIBFBA3ZBB3FrQQNqIRILIBFBGHIhESASIAlPDQEgEyALSQ0ACwsDQAJAAkAgCCASa0EDSw0AIBFB/wFxIgJBF0sNAQNAAkACQCASIAhGDQAgEi0AACACdCAWciEWIBJBAWohEgwBC0EBIRUgCCESIBBBAWoiEEEESw0ICyARQQhqIhFB/wFxIgJBGEkNAAwCCwsgB0EMaiASQQQQgoCAgAAaIBIgEUEDdkEHcWtBA2ohEiAHKAIMIBFB/wFxdCAWciEWIBFBGHIhEQsgESAAIBYgGHFBAnRqKAIAIgJrIREgFiACQf8BcXYhBAJAAkAgAkGAgAFxDQAgFiEbIAQhFgwBCyARIAAgBEF/IAJBCHZBP3F0QX9zcSACQRB2akECdGooAgAiAmshESAEIAJB/wFxdiEWIAQhGwsgAkEQdiEEAkAgAkF/Sg0AAkAgEyAKRw0AQQMhFQwGCyATIAQ6AAAgE0EBaiETDAELAkAgAkGAwABxRQ0AIBYhAgwDCwJAIBtBfyACQf8BcXRBf3NxIAJBCHZB3wFxdiIbIARqIhogCiATa00NAEEDIRUMBQsCQAJAIAggEmtBA0sNACARQf8BcSICQRdLDQEDQAJAAkAgEiAIRg0AIBItAAAgAnQgFnIhFiASQQFqIRIMAQtBASEVIAghEiAQQQFqIhBBBEsNCAsgEUEIaiIRQf8BcSICQRhJDQAMAgsLIAdBDGogEkEEEIKAgIAAGiASIBFBA3ZBB3FrQQNqIRIgBygCDCARQf8BcXQgFnIhFiARQRhyIRELAkAgACAWQf8BcUECdGpBmMkAaigCACICQYCAAnFFDQAgACAWQQh2IhZBfyACQQh2QT9xdEF/c3EgAkEQdmpBAnRqQZjJAGooAgAhAiARQXhqIRcCQAJAIAggEmtBA0sNACAXQf8BcSIVQRdNDQEgFyERDAILIAdBDGogEkEEEIKAgIAAGiAXQRhyIREgEiAXQQN2QQdxa0EDaiESIAcoAgwgF0H/AXF0IBZyIRYMAQsDQAJAAkAgEiAIRg0AIBItAAAgFXQgFnIhFiASQQFqIRIMAQtBASEVIAghEiAQQQFqIhBBBEsNBwsgEUH/AXEhFSARQQhqIhchESAVQRhJDQALIBdBeGohEQsCQCAWQX8gAkH/AXEiFXRBf3NxIAJBCHZB/wFxdiACQRB2aiIXIBMgA2tNDQBBASEVDAULIBEgAmshESAWIBV2IRYgEyATIBdrIgItAAA6AAAgEyACLQABOgABIBsgE2ogBGoiBCATQQNqIhsgBCAbSxsgE2shBCATQQJqIRsgEyAaaiETIAJBAmohAgJAAkAgBEF+aiIVQRBPDQAgGyEEDAELAkAgF0EQTw0AIBshBAwBC0EAIBdrIRogGyAVQXBxIhlqIQQgAiAZaiECIBkhFwNAIBsgGyAaav0AAAD9CwAAIBtBEGohGyAXQXBqIhcNAAsgFSAZRg0BCwNAIAQgAi0AADoAACACQQFqIQIgBEEBaiIEIBNJDQAMAQsLCwJAIBAgEUH9AWpBA3ZBH3EiAk0NAEEBIRUMAwsCQCAIIBIgECACa2oiBGtBBE4NAEEBIRUMAwsgB0EMaiAEQQIQgoCAgAAaIAcvAQwhAiAHQQxqIARBAmpBAhCCgICAABoCQCACIAcvAQxzQf//A3FB//8DRg0AQQEhFQwDCwJAIAogE2sgAk4NAEEDIRUMAwsCQCAIIARBBGoiBGsgAk4NAEEBIRUMAwsgEyAEIAIQgoCAgAAaIBMgAmohEyAEIAJqIRJBACEQQQAhEUEAIQILIBRBAXFFDQALQQEhFSAQIBFBA3ZBH3EiAksNAAJAIAVFDQAgBSASIBAgAmtqIAFrNgIACwJAAkAgBkUNACAGIBMgA2s2AgAMAQtBAiEVIBMgCkcNAQtBACEVCyAHQRBqJICAgIAAIBUL0A4BD38jgICAgABBgAFrIggkgICAgABBACEJAkACQCAFQQFqIgpBBEkNACAIQcAAaiELIApBfHEiCSEMA0AgC/0MAAAAAAAAAAAAAAAAAAAAAP0LBAAgC0EQaiELIAxBfGoiDA0ACyAKIAlGDQELIAUgCWtBAWohDCAIQcAAaiAJQQJ0aiELA0AgC0EANgIAIAtBBGohCyAMQX9qIgwNAAsLAkAgAkUNACACQQNxIQlBACEMAkAgAkEESQ0AIAJBfHEhDUEAIQwDQCAIQcAAaiABIAxqIgstAABBAnRqIgogCigCAEEBajYCACAIQcAAaiALQQFqLQAAQQJ0aiIKIAooAgBBAWo2AgAgCEHAAGogC0ECai0AAEECdGoiCiAKKAIAQQFqNgIAIAhBwABqIAtBA2otAABBAnRqIgsgCygCAEEBajYCACANIAxBBGoiDEcNAAsLIAlFDQAgASAMaiELA0AgCEHAAGogCy0AAEECdGoiDCAMKAIAQQFqNgIAIAtBAWohCyAJQX9qIgkNAAsLAkACQCAFQQJPDQAgBSEODAELIAhBwABqIAVBAnRqIQsDQAJAIAsoAgBFDQAgBSEODAILIAtBfGohC0EBIQ4gBUF/aiIFQQFLDQALCwJAIAdFDQAgByAOIAQgDiAESRsiBDYCAAtBACELIAhBADYCACAIIAgoAkAiBTYCBEEBIQwCQCAOQQJJDQBBASELIA5Bf2oiDEEBcSEPAkACQCAOQQJHDQBBACEJDAELIAxBfnEhECAIQcAAakEIciELIAhBDHIhDEEAIQlBACEKA0AgDEF8aiALQXxqKAIAIg0gBWoiBTYCACAMIAsoAgAiByAFaiIFNgIAIAcgCUECdCANQQF0amohCSALQQhqIQsgDEEIaiEMIBAgCkECaiIKRw0ACyAKQQFqIQsLAkAgD0UNACALQQJ0IgsgCGpBBGogCEHAAGogC2ooAgAiCyAFajYCACALIAlBAXRqIQkLIAlBAXQhCyAOIQwLIAhBwABqIAxBAnRqKAIAIAtqIQ0CQCACRQ0AIAJBAXEhB0EAIQsCQCACQQFGDQAgAkF+cSEKQQAhCwNAIAYgCCABIAtqIgwtAABBAnRqIgkoAgAiBUEBdGogCzsBACAJIAVBAWo2AgAgCCAMQQFqLQAAQQJ0aiIMIAwoAgAiDEEBajYCACAGIAxBAXRqIAtBAWo7AQAgCiALQQJqIgtHDQALCyAHRQ0AIAggASALai0AAEECdGoiDCAMKAIAIgxBAWo2AgAgBiAMQQF0aiALOwEACwJAAkAgDUEBIA50IgtNDQBBACEJDAELIAYgCCgCAEEBdGohEAJAAkACQCANIAtJDQAgCEHAAGpBBHIhC0EAIQcDQCAHQQFqIQcgCygCACEKIAtBBGohCyAKRQ0AC0EAIREgByAETQ0BQQAhDQwCCwJAAkAgDQ0AQQAhCwwBC0EAIQkgDUEBIA5Bf2p0Rw0DIAgoAkRBAUcNAyAQLwEAIQsLIAMgC0ECdGooAgBBgQJqIQZBASEJQQEhCwNAIAAgBjYCACAAQQRqIQAgCyAEdiEMIAtBAWohCyAMRQ0ADAMLC0EBIAd0IQsgCEHAAGpBBHIhAUEAIQ0DQCALQX9qIQwgB0GBAmwhBgNAIAAgDUECdGogBiADIBAvAQBBAnRqKAIAajYCAAJAIA0gDEcNAEEBIQkgBCAHTQ0EIAQgB2shDANAIAAgC0ECdCIJaiAAIAkQgoCAgAAaQQEhCSALQQF0IQsgDEF/aiIMDQAMBQsLQYCAgIB4IAwgDXNndiIJQX9qIA1xIAlyIQ0gEEECaiEQIApBf2oiCg0ACyABIAdBAnRqIQwDQAJAIAdBAWoiByAESw0AIAAgC0ECdCIJaiAAIAkQgoCAgAAaIAtBAXQhCwsgDCgCACEKIAxBBGohDCAKRQ0ACyAHIARNDQALC0EBIAR0IgJBf2ohEiAIQcAAakEEciETQX8hCwNAIBMgB0ECdGohDkF/IAd0QX9zIRQgByAEayIVQYECbCEWQQEgFXQiBkECdCEFA0ACQAJAIA0gEnEiDyALRw0AIAIhCSALIQ8MAQsgFSEMIAYhAQJAIAogBk8NACAOIQsgFSEMIAohCQNAIAsoAgAhASALQQRqIQsgASAJQQF0aiIJQQEgDEEBaiIMdCIBSQ0ACwsgACAPQQJ0aiACQRB0IAxBCHRyIARyQYCAA3I2AgAgASACaiEJIAIhEQsgACARIA0gBHZqIgxBAnRqIQsgFiADIBAvAQBBAnRqKAIAaiEBA0AgCyABNgIAIAsgBWohCyAMIAZqIgwgCUkNAAsCQCANIBRHDQBBASEJDAMLQYCAgIB4IA0gFHNndiILQX9qIA1xIAtyIQ0gEEECaiEQIAkhAiAPIQsgCkF/aiIKDQALA0AgB0EBaiEHIA4oAgAhCiAOQQRqIQ4gCkUNAAsgCSECIA8hCwwACwsgCEGAAWokgICAgAAgCQsWACAAIAEgAiADIARBACAFEImAgIAAC0ABAX8CQEGs2gBBACgC8NKAgAARgICAgAAAIgBFDQAgAEEAQazaABCDgICAABogAEEAKAL00oCAADYCqFoLIAALqwQBBn8jgICAgABBEGsiBySAgICAAAJAAkAgAkESTw0AQQEhAgwBCwJAIAEtAABBH0YNAEEBIQIMAQsCQCABLQABQYsBRg0AQQEhAgwBCwJAIAEtAAJBCEYNAEEBIQIMAQsCQCABLQADIghBH00NAEEBIQIMAQsgAUEKaiEJAkAgCEEEcUUNACAHQQZqIAlBAhCCgICAABoCQCACQXRqIAcvAQYiCkEIak8NAEEBIQIMAgsgASAKakEMaiEJCyABIAJqIQsCQAJAIAhBCHENACAJIQoMAQsgCyAJayEMAkADQCAMQX9qIQwgCUEBaiEKIAktAABFDQEgCiEJIAogC0cNAAsLQQEhAiAMQQhIDQELAkACQCAIQRBPDQAgCiEJDAELIAsgCmshDAJAA0AgDEF/aiEMIApBAWohCSAKLQAARQ0BIAkhCiAJIAtHDQALC0EBIQIgDEEISA0BCwJAIAhBAnFFDQAgCyAJQQJqIglrQQhODQBBASECDAELIAAgCSALIAlrQXhqIAMgBCAHIAYQiYCAgAAiAg0AAkAgBkUNACAGKAIAIQQLIAcoAgAhAkEAIAMgBBCPgICAACEKIAdBCGogCSACaiIJQQQQgoCAgAAaAkAgCiAHKAIIRg0AQQEhAgwBCyAHQQxqIAlBBGpBBBCCgICAABpBASECIAQgBygCDEcNAEEAIQIgBUUNACAFIAkgAWtBCGo2AgALIAdBEGokgICAgAAgAgsWACAAIAEgAiADIARBACAFEI2AgIAAC9UGAQJ/AkAgAQ0AQQAPCyABIAJqIQMgAEF/cyEAAkAgAkUNACABQQdxRQ0AIABB/wFxIAEtAABzQQJ0QfCSgIAAaigCACAAQQh2cyEAAkAgAUEBaiIEQQdxDQAgBCEBDAELAkAgAkEBRw0AIAQhAQwBCyAAQf8BcSABLQABc0ECdEHwkoCAAGooAgAgAEEIdnMhAAJAIAFBAmoiBEEHcQ0AIAQhAQwBCwJAIAJBAkcNACAEIQEMAQsgAEH/AXEgAS0AAnNBAnRB8JKAgABqKAIAIABBCHZzIQACQCABQQNqIgRBB3ENACAEIQEMAQsCQCACQQNHDQAgBCEBDAELIABB/wFxIAEtAANzQQJ0QfCSgIAAaigCACAAQQh2cyEAAkAgAUEEaiIEQQdxDQAgBCEBDAELAkAgAkEERw0AIAQhAQwBCyAAQf8BcSABLQAEc0ECdEHwkoCAAGooAgAgAEEIdnMhAAJAIAFBBWoiBEEHcQ0AIAQhAQwBCwJAIAJBBUcNACAEIQEMAQsgAEH/AXEgAS0ABXNBAnRB8JKAgABqKAIAIABBCHZzIQACQCABQQZqIgRBB3ENACAEIQEMAQsCQCACQQZHDQAgBCEBDAELIABB/wFxIAEtAAZzQQJ0QfCSgIAAaigCACAAQQh2cyEAAkAgAUEHaiIEQQdxDQAgBCEBDAELAkAgAkEHRw0AIAQhAQwBCyAAQf8BcSABLQAHc0ECdEHwkoCAAGooAgAgAEEIdnMhACABQQhqIQELAkAgAyABa0F4cSICRQ0AIAEgAmohAgNAIAEoAgAgAHMiAEEGdkH8B3FB8MKAgABqKAIAIABB/wFxQQJ0QfDKgIAAaigCAHMgAEEOdkH8B3FB8LqAgABqKAIAcyAAQRZ2QfwHcUHwsoCAAGooAgBzIAEoAgQiAEH/AXFBAnRB8KqAgABqKAIAcyAAQQZ2QfwHcUHwooCAAGooAgBzIABBDnZB/AdxQfCagIAAaigCAHMgAEEWdkH8B3FB8JKAgABqKAIAcyEAIAFBCGoiASACRw0ACyACIQELAkAgASADRg0AA0AgAEH/AXEgAS0AAHNBAnRB8JKAgABqKAIAIABBCHZzIQAgAUEBaiIBIANHDQALCyAAQX9zCwuHSwIAQYAIC/BKEBESAAgHCQYKBQsEDAMNAg4BDwAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAgAAAAMAAAAEAAAABQAAAAYAAAAHAAAACAAAAAkAAAAKAAAACwAAAAwAAAANAAAADgAAAA8AAAAQAAAAEQAAABIAAAAAAAAAAQAAAAIAAAADAAAABAABAAUAAQAHAAIACQACAA0AAwARAAMAGQAEACEABAAxAAUAQQAFAGEABgCBAAYAwQAHAAEBBwCBAQgAAQIIAAEDCQABBAkAAQYKAAEICgABDAsAARALAAEYDAABIAwAATANAAFADQABYA0AAWANAAFgAAAAgAAAAYAAAAKAAAADgAAABIAAAAWAAAAGgAAAB4AAAAiAAAAJgAAACoAAAAuAAAAMgAAADYAAAA6AAAAPgAAAEIAAABGAAAASgAAAE4AAABSAAAAVgAAAFoAAABeAAAAYgAAAGYAAABqAAAAbgAAAHIAAAB2AAAAegAAAH4AAACCAAAAhgAAAIoAAACOAAAAkgAAAJYAAACaAAAAngAAAKIAAACmAAAAqgAAAK4AAACyAAAAtgAAALoAAAC+AAAAwgAAAMYAAADKAAAAzgAAANIAAADWAAAA2gAAAN4AAADiAAAA5gAAAOoAAADuAAAA8gAAAPYAAAD6AAAA/gAAAQIAAAEGAAABCgAAAQ4AAAESAAABFgAAARoAAAEeAAABIgAAASYAAAEqAAABLgAAATIAAAE2AAABOgAAAT4AAAFCAAABRgAAAUoAAAFOAAABUgAAAVYAAAFaAAABXgAAAWIAAAFmAAABagAAAW4AAAFyAAABdgAAAXoAAAF+AAABggAAAYYAAAGKAAABjgAAAZIAAAGWAAABmgAAAZ4AAAGiAAABpgAAAaoAAAGuAAABsgAAAbYAAAG6AAABvgAAAcIAAAHGAAABygAAAc4AAAHSAAAB1gAAAdoAAAHeAAAB4gAAAeYAAAHqAAAB7gAAAfIAAAH2AAAB+gAAAf4AAAICAAACBgAAAgoAAAIOAAACEgAAAhYAAAIaAAACHgAAAiIAAAImAAACKgAAAi4AAAIyAAACNgAAAjoAAAI+AAACQgAAAkYAAAJKAAACTgAAAlIAAAJWAAACWgAAAl4AAAJiAAACZgAAAmoAAAJuAAACcgAAAnYAAAJ6AAACfgAAAoIAAAKGAAACigAAAo4AAAKSAAAClgAAApoAAAKeAAACogAAAqYAAAKqAAACrgAAArIAAAK2AAACugAAAr4AAALCAAACxgAAAsoAAALOAAAC0gAAAtYAAALaAAAC3gAAAuIAAALmAAAC6gAAAu4AAALyAAAC9gAAAvoAAAL+AAADAgAAAwYAAAMKAAADDgAAAxIAAAMWAAADGgAAAx4AAAMiAAADJgAAAyoAAAMuAAADMgAAAzYAAAM6AAADPgAAA0IAAANGAAADSgAAA04AAANSAAADV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';
let GZ = null, gzBase = 0;
function pqGunzip(s, n) {   // returns a view into wasm memory, valid until the next call
  if (!GZ) { GZ = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(atob(GZ64), (c) => c.charCodeAt(0))), {}).exports; GZ.init(); gzBase = (GZ.heap() + 15) & ~15; }
  const sp = gzBase, dp = (sp + s.length + 15) & ~15, gp = (dp + n + 15) & ~15, need = gp + 16, have = GZ.memory.buffer.byteLength;
  if (need > have) GZ.memory.grow(Math.ceil((need - have) / 65536));
  new Uint8Array(GZ.memory.buffer).set(s, sp);
  const zl = s.length > 6 && (s[0] & 15) === 8 && ((s[0] << 8) | s[1]) % 31 === 0, rc = zl ? GZ.inflate_raw(sp + 2, s.length - 2, dp, n, gp) : GZ.gunzip(sp, s.length, dp, n, gp);
  if (rc !== 0 || new DataView(GZ.memory.buffer).getUint32(gp, true) !== n) throw new Error('This Parquet file has a damaged GZIP page.');
  return new Uint8Array(GZ.memory.buffer, dp, n);
}
// Notice: this wasm is our own code (MIT, Copyright 2026 LFC Foundry), written from the public LZ4 block format; no LZ4 library code. Credits: docs/CREDITS.md.
// Parquet LZ4 pages: LZ4_RAW (one raw block per page) and the older Hadoop-framed LZ4. The decoder is 800 bytes of wasm built from my own small C code that follows the public LZ4 block format (https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md, Yann Collet); the Parquet side is https://github.com/apache/parquet-format/blob/master/Compression.md.
const L464 = 'AGFzbQEAAAABHANgBH9/f38Bf2AGf39/f39/AX9gBX9/f39/AX8DBAMAAQIEBQFwAQEBBQMBAAIGDwJ/AUGAiAQLfwBBgIgECwcnBAZtZW1vcnkCAARsejRiAAAFbHo0YmQAAgtfX2hlYXBfYmFzZQMBCqgFA04BAX8jgICAgABBEGsiBCSAgICAACAAIAAgAWogAiACIAIgA2ogBEEMahCBgICAACEAIAQoAgwhAyAEQRBqJICAgIAAQX8gAyACayAAGwuCBAEKfwJAAkAgACABTw0AA0AgAEEBaiEGAkACQCAALQAAIgBBBHYiB0EPRg0AIAYhCAwBC0EPIQcDQAJAIAYgAUkNAEF/DwsgByAGLQAAIglqIQcgBkEBaiIIIQYgCUH/AUYNAAsLQX8hCiABIAhrIAdJDQIgBCACayAHSQ0CIAIgCCAH/AoAACACIAdqIQsCQCAIIAdqIgYgAUkNACALIQIMAgsgASAGa0ECSA0CIAYvAAAiDEUNAiALIANrIAxJDQIgBkECaiEGAkACQCAAQQ9xIglBD0YNACAGIQAMAQtBDyEJA0AgBiABTw0EIAkgBi0AACIIaiEJIAZBAWoiACEGIAhB/wFGDQALCyAEIAtrIAlBBGoiDUkNAiALIAxrIQ4CQAJAIAwgDU8NACAJQQNxIQpBACEGAkAgCUF8Sw0AIA1BfHEhD0EAIQYDQCALIAZqIgkgDiAGaiIILQAAOgAAIAlBAWogCEEBai0AADoAACAJQQJqIAhBAmotAAA6AAAgCUEDaiAIQQNqLQAAOgAAIA8gBkEEaiIGRw0ACwsgCkUNAUEAIAxrIQkgAiAHIAZqaiEGA0AgBiAGIAlqLQAAOgAAIAZBAWohBiAKQX9qIgoNAAwCCwsgCyAOIA38CgAACyALIA1qIQIgACABSQ0ACwsgBSACNgIAQQAhCgsgCgtTAQF/I4CAgIAAQRBrIgUkgICAgAAgACAAIAFqIAIgA2oiAyACIAIgBGogBUEMahCBgICAACECIAUoAgwhACAFQRBqJICAgIAAQX8gACADayACGwsAQQRuYW1lAAsKbHo0YjIud2FzbQEZAwAEbHo0YgEJbHo0X2Jsb2NrAgVsejRiZAcSAQAPX19zdGFja19wb2ludGVyADgJcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBDFVidW50dSBjbGFuZxExOC4xLjMgKDF1YnVudHUxKQA5D3RhcmdldF9mZWF0dXJlcwMrC2J1bGstbWVtb3J5Kw9tdXRhYmxlLWdsb2JhbHMrCHNpZ24tZXh0';
let L4 = null, l4Base = 0;
const lz4Init = () => { if (!L4) { L4 = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(atob(L464), (c) => c.charCodeAt(0))), {}).exports; l4Base = (L4.__heap_base.value + 15) & ~15; } };
// LZ4 frame (Arrow IPC buffers): header, then blocks (4-byte size, high bit = stored raw), end mark; blocks may point back into earlier blocks, which lz4bd allows. Returns a view into wasm memory, valid until the next call.
function pqLz4Frame(s, n) {
  lz4Init(); const sp = l4Base, dp = (sp + s.length + 15) & ~15, need = dp + n + 16, have = L4.memory.buffer.byteLength; if (need > have) L4.memory.grow(Math.ceil((need - have) / 65536));
  new Uint8Array(L4.memory.buffer).set(s, sp); const bad = () => new Error('An LZ4 buffer in this Arrow file is damaged.'), dv = new DataView(L4.memory.buffer);
  if (s.length < 7 || dv.getUint32(sp, true) !== 0x184D2204) throw bad(); const flg = s[4]; if ((flg >> 6) !== 1 || (flg & 1)) throw bad();
  let p = 6 + ((flg & 8) ? 8 : 0), o = 0; const bc = (flg & 16) ? 4 : 0; p += 1;
  for (;;) {
    if (p + 4 > s.length) throw bad(); const w = dv.getUint32(sp + p, true); p += 4; if (w === 0) break; const raw = (w & 0x80000000) !== 0, bs = w & 0x7FFFFFFF; if (p + bs > s.length || o + (raw ? bs : 0) > n) throw bad();
    if (raw) { new Uint8Array(L4.memory.buffer).copyWithin(dp + o, sp + p, sp + p + bs); o += bs; } else { const r = L4.lz4bd(sp + p, bs, dp, o, n); if (r === 0xFFFFFFFF) throw bad(); o += r; } p += bs + bc;
  }
  if (o !== n) throw bad(); return new Uint8Array(L4.memory.buffer, dp, n);
}
function pqLz4(s, n, codec) {   // returns a view into wasm memory, valid until the next call
  lz4Init();
  const sp = l4Base, dp = (sp + s.length + 15) & ~15, need = dp + n + 16, have = L4.memory.buffer.byteLength;
  if (need > have) L4.memory.grow(Math.ceil((need - have) / 65536));
  new Uint8Array(L4.memory.buffer).set(s, sp);
  let got = -1;
  if (codec === 5) {   // Hadoop framing: repeated [uncompressed size, big-endian u32][compressed size, big-endian u32][block]; a page that does not fit it is one plain block
    const dv = new DataView(L4.memory.buffer); let p = 0, o = 0, ok = s.length >= 8;
    while (ok && p + 8 <= s.length) { const us = dv.getUint32(sp + p, false), cs = dv.getUint32(sp + p + 4, false); p += 8; if (cs > s.length - p || o + us > n) { ok = false; break; } const r = L4.lz4b(sp + p, cs, dp + o, us); if (r !== us) { ok = false; break; } p += cs; o += us; }
    if (ok && p === s.length && o === n) got = n;
  }
  if (got !== n) got = L4.lz4b(sp, s.length, dp, n);
  if (got !== n) throw new Error('This Parquet file has a damaged LZ4 page.');
  return new Uint8Array(L4.memory.buffer, dp, n);
}
// Parquet BROTLI pages: Google's brotli decoder (the reference C code, MIT, Copyright 2009, 2010, 2013-2016 the Brotli Authors; https://github.com/google/brotli; full notice in docs/NOTICES-WASM-DECODERS.txt) built for wasm. Loaded only when a BROTLI page appears: the wasm (170,253 bytes with brotli's built-in dictionary) is kept gzip-packed in this file and unpacked with the libdeflate decoder above.
const BR64 = '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'; const BR_LEN = 170253;
let BR = null, brBase = 0;
function pqBrotli(s, n) {
  if (!BR) { const w = pqGunzip(Uint8Array.from(atob(BR64), (c) => c.charCodeAt(0)), BR_LEN).slice(); BR = new WebAssembly.Instance(new WebAssembly.Module(w), {}).exports; brBase = (BR.__heap_base.value + 15) & ~15; }
  const b0 = s[0], wb = !(b0 & 1) ? 16 : ((b0 >> 1) & 7) ? 17 + ((b0 >> 1) & 7) : ((b0 >> 4) & 7) ? 8 + ((b0 >> 4) & 7) : 17;
  let ring = 1 << Math.min(wb, 24); while (ring > 4096 && ring >> 1 >= n) ring >>= 1;
  const sp = brBase, dp = (sp + s.length + 15) & ~15, sc = (dp + n + 15) & ~15, need = sc + ring + (3 << 19), have = BR.memory.buffer.byteLength;
  if (need > have) BR.memory.grow(Math.ceil((need - have) / 65536));
  new Uint8Array(BR.memory.buffer).set(s, sp);
  if (BR.brb(sp, s.length, dp, n, sc) !== n) throw new Error('This Parquet file has a damaged BROTLI page.');
  return new Uint8Array(BR.memory.buffer, dp, n);
}
const pqInfl = (s, n, codec) => (codec === 4 ? pqBrotli(s, n) : codec === 2 ? pqGunzip(s, n) : codec === 7 || codec === 5 ? pqLz4(s, n, codec) : pqZstd(s, n));
const pad2 = (x) => (x < 10 ? '0' : '') + x;
function civil(z) { z += 719468; const era = Math.floor(z / 146097), doe = z - era * 146097, yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365), y = yoe + era * 400, doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, mo = mp < 10 ? mp + 3 : mp - 9; return [mo <= 2 ? y + 1 : y, mo, d]; }
// Dates and timestamps become the text the CSV path stores (YYYY-MM-DD, or YYYY-MM-DD HH:MM:SS with a fraction when the row group has one), so lfc-pack types them like any date column.
function pqDateText(a, kind, unit, force, zone) {
  const n = a.length, per = kind === 'date' ? 0 : unit === 'ms' ? 1e3 : unit === 'us' ? 1e6 : 1e9, digs = per === 1e3 ? 3 : per === 1e6 ? 6 : 9;
  let frac = !!(per && force); if (per && !frac) for (let i = 0; i < n; i++) { const v = a[i]; if (v === v && ((v % per) + per) % per !== 0) { frac = true; break; } }
  const w = kind === 'date' ? 10 : 19 + (frac ? 1 + digs : 0) + (zone ? 1 : 0), bytes = new Uint8Array(n * w), start = new Int32Array(n), end = new Int32Array(n); let o = 0;
  const put = (s) => { for (let i = 0; i < s.length; i++) bytes[o++] = s.charCodeAt(i); };
  for (let i = 0; i < n; i++) {
    start[i] = o; const v = a[i]; if (v !== v) { end[i] = o; continue; }
    const secs = kind === 'date' ? v * 86400 : Math.floor(v / per), days = Math.floor(secs / 86400), sod = secs - days * 86400, c = civil(days);
    put(String(c[0]).padStart(4, '0') + '-' + pad2(c[1]) + '-' + pad2(c[2]));
    if (kind !== 'date') { put(' ' + pad2(Math.floor(sod / 3600)) + ':' + pad2(Math.floor(sod / 60) % 60) + ':' + pad2(sod % 60)); if (frac) put('.' + String(((v % per) + per) % per).padStart(digs, '0')); if (zone) put('Z'); }
    end[i] = o;
  }
  return { bytes: bytes.subarray(0, o), start, end };
}
// Timestamps as numbers for lfc-pack's { kind: 'ts' } input (no text formatting, no date parse); null when the values do not fit a form it takes.
function pqTs(a, unit, force) {
  if (force && unit === 'ns') return null;
  const per = unit === 'ms' ? 1e3 : unit === 'us' ? 1e6 : 1e9, n = a.length; let frac = !!force;
  for (let i = 0; i < n; i++) { const v = a[i]; if (!frac && v === v && ((v % per) + per) % per !== 0) { frac = true; break; } }
  let values, u, fmt = 'YYYY-MM-DD HH:MM:SS';
  if (!frac) { values = new Float64Array(n); for (let i = 0; i < n; i++) values[i] = a[i] / per; u = 's'; }
  else if (unit === 'ms' || unit === 'us') { values = a; u = unit; fmt += unit === 'ms' ? '.fff' : '.ffffff'; }
  else { for (let i = 0; i < n; i++) { const v = a[i]; if (v === v && v % 1000 !== 0) return null; } values = new Float64Array(n); for (let i = 0; i < n; i++) values[i] = a[i] / 1000; u = 'us'; fmt += '.ffffff'; }
  return { kind: 'ts', unit: u, values, fmt };
}
const pqIsExact = (ex, i, col) => !!ex && (ex === 'all' ? col.type === PQ.TY.I64 : ex.includes(i));   // exact INT64 as digit text: named columns, or every INT64 column after three restarts
function pqNumText(a) {   // doubles have no fixed-decimal form: they are stored as the text a CSV would hold (the column still reads as a number)
  const n = a.length, parts = new Array(n); let tot = 0; for (let i = 0; i < n; i++) { const v = a[i]; const sx = v !== v ? '' : String(v); parts[i] = sx; tot += sx.length; }
  const bytes = new Uint8Array(tot), start = new Int32Array(n), end = new Int32Array(n); let o = 0;
  for (let i = 0; i < n; i++) { start[i] = o; const sx = parts[i]; for (let j = 0; j < sx.length; j++) bytes[o++] = sx.charCodeAt(j); end[i] = o; }
  return { bytes, start, end };
}
// ---- Arrow near-copy: each record batch becomes typed columns straight from the Arrow buffers (no CSV text in between) and joins the Parquet path from there: decode workers, pack, write.
// Anything this path does not cover (float32, time, decimal, all-null or binary columns, LZ4-frame buffers, delta dictionaries, non-text dictionaries) returns null from arrowPlan, and the CSV route reads the file as before.
const arrowPlans = new WeakMap();
function arrowBatchInfo(F, rb) {
  const lp = F.field(rb, 0), np = F.field(rb, 1), bp = F.field(rb, 2), cp = F.field(rb, 3); const nodes = [], bufs = [];
  if (np) { const v = F.vec(np); for (let i = 0; i < v.n; i++) nodes.push({ len: F.i64(v.at + 16 * i), nulls: F.i64(v.at + 16 * i + 8) }); }
  if (bp) { const v = F.vec(bp); for (let i = 0; i < v.n; i++) bufs.push({ off: F.i64(v.at + 16 * i), len: F.i64(v.at + 16 * i + 8) }); }
  let codec = -1; if (cp) { const c = F.tbl(cp), cd = F.field(c, 0); codec = cd ? (F.u8(cd) << 24 >> 24) : 0; }
  return { len: lp ? F.i64(lp) : 0, nodes, bufs, codec };
}
function arrowBodyBufs(body, info) {   // one Uint8Array per Arrow buffer: views into the body, or unpacked copies when the batch is compressed (ZSTD)
  const out = [], dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (const b of info.bufs) {
    if (!b.len) { out.push(new Uint8Array(0)); continue; }
    if (info.codec < 0) { out.push(body.subarray(b.off, b.off + b.len)); continue; }
    const u = Number(dv.getBigInt64(b.off, true));
    if (u < 0) out.push(body.slice(b.off + 8, b.off + b.len)); else if (u === 0) out.push(new Uint8Array(0));
    else { let v; try { if (info.codec === 0) v = pqLz4Frame(body.subarray(b.off + 8, b.off + b.len), u); else { pqInit(); v = pqInfl(body.subarray(b.off + 8, b.off + b.len), u); } } catch (e) { throw info.codec === 0 ? e : new Error('A compressed buffer in this Arrow file could not be unpacked (ZSTD).'); } out.push(v.slice()); }
  }
  return out;
}
const arrowView = (u8, T, n) => { if (u8.byteOffset % T.BYTES_PER_ELEMENT) u8 = u8.slice(); return new T(u8.buffer, u8.byteOffset, n); };
async function arrowPlan(file) {
  try {
    const rd = async (o, l) => new Uint8Array(await file.slice(o, o + l).arrayBuffer()); let pos = 0;
    const h0 = await rd(0, 8); if (String.fromCharCode(...h0.subarray(0, 6)) === 'ARROW1') pos = 8; else if (h0.length >= 4 && String.fromCharCode(...h0.subarray(0, 4)) === 'FEA1') return null;
    let descs = null; const groups = [], dicts = {};
    while (pos + 8 <= file.size) {
      const hd = await rd(pos, 8), dh = new DataView(hd.buffer); let ml = dh.getInt32(0, true), at = pos + 4; if (ml === -1) { ml = dh.getInt32(4, true); at = pos + 8; } if (ml <= 0) break;
      const F = makeFB(await rd(at, ml)), mp = F.root(), htp = F.field(mp, 1), hp = F.field(mp, 2), bl = F.field(mp, 3), type = htp ? F.u8(htp) : 0, hdr = hp ? F.tbl(hp) : 0, bodyLen = bl ? F.i64(bl) : 0, bodyAt = at + ml; pos = bodyAt + bodyLen;
      if (type === 1) {
        descs = []; for (const x of parseSchema(F, hdr)) {
          const ck = colKind(x.F, x.f), k = ck.kind, d = { name: x.f.name, scale: 0, ak: k, dictId: x.f.dictId, idxBits: x.f.idxBits, idxSigned: x.f.idxSigned, type: -1 };
          if (k >= K.I8 && k <= K.U64) { d.kind = 'int'; if (k === K.I64 || k === K.U64) d.type = PQ.TY.I64; } else if (k === K.F64) d.kind = 'double'; else if (k === K.BOOL) d.kind = 'bool';
          else if (k === K.UTF8 || k === K.LUTF8) d.kind = 'text'; else if (k === K.D32 || k === K.D64) d.kind = 'date'; else if (k === K.TS) { d.kind = 'timestamp'; d.unit = ['ms', 'ms', 'us', 'ns'][ck.aux]; d.mul = ck.aux === 0 ? 1000 : 1; d.fixed = ck.aux > 0; d.tz = !!ck.flags; } else return null;
          descs.push(d);
        }
        if (!descs.length) return null;
      } else if (type === 2) {
        if (!descs) return null; const dl = F.field(hdr, 2); if (dl && F.u8(dl)) return null;
        const idp = F.field(hdr, 0), id = idp ? F.i64(idp) : 0, info = arrowBatchInfo(F, F.tbl(F.field(hdr, 1))), d = descs.find((x) => x.dictId === id); if (!d || info.codec > 1 || (d.ak !== K.UTF8 && d.ak !== K.LUTF8)) return null;
        const B = arrowBodyBufs(await rd(bodyAt, bodyLen), info), n = info.len;
        let st, en; if (d.ak === K.UTF8) { const o = arrowView(B[1], Int32Array, n + 1); st = Int32Array.from(o.subarray(0, n)); en = Int32Array.from(o.subarray(1, n + 1)); } else { const o = arrowView(B[1], BigInt64Array, n + 1); st = new Int32Array(n); en = new Int32Array(n); for (let i = 0; i < n; i++) { st[i] = Number(o[i]); en[i] = Number(o[i + 1]); } }
        dicts[id] = { bytes: B[2].slice(), start: st, end: en, n }; for (const dd of descs) if (dd.dictId === id) dd.hasDict = true;
      } else if (type === 3) {
        if (!descs) return null; const info = arrowBatchInfo(F, hdr); if (info.codec > 1) return null;
        for (const d of descs) if (d.dictId !== null && !dicts[d.dictId]) return null;
        groups.push({ arrow: { bodyAt, bodyLen, len: info.len, nodes: info.nodes, bufs: info.bufs, codec: info.codec, dicts: Object.assign({}, dicts) }, chunks: [{ comp: bodyLen }] });
      }
    }
    if (!descs || !groups.length) return null;
    let rows = 0; for (const g of groups) rows += g.arrow.len;
    return { cols: descs, groups, dicts, rows };
  } catch (e) { return null; }
}
const ARROW_BOOLLB = (() => { const bytes = new TextEncoder().encode('falsetrue'); return { bytes, start: Int32Array.of(0, 5, 9), end: Int32Array.of(5, 9, 9), n: 3 }; })();
const ARROW_MAXS = 9007199254740991n;
function arrowCol(c, node, B, bi, dicts, exact, ci) {   // one column of one batch -> the shapes the Parquet reader hands back: Float64Array (NaN = empty), { codes, lb }, or { bytes, start, end }
  const n = node.len, val = node.nulls > 0 && B[bi].length ? B[bi] : null, bad = (i) => !(val[i >> 3] >> (i & 7) & 1), k = c.ak;
  if (c.dictId !== null) {
    const ix = c.idxBits === 8 ? (c.idxSigned ? Int8Array : Uint8Array) : c.idxBits === 16 ? (c.idxSigned ? Int16Array : Uint16Array) : c.idxBits === 32 ? (c.idxSigned ? Int32Array : Uint32Array) : null; if (!ix) throw new Error('This Arrow file uses 64-bit dictionary indexes, which are not supported yet.');
    const v = arrowView(B[bi + 1], ix, n), dd = dicts[c.dictId], codes = new Int32Array(n); let lb = dd, nulls = false;
    if (!val) for (let i = 0; i < n; i++) codes[i] = v[i]; else for (let i = 0; i < n; i++) { if (bad(i)) { codes[i] = dd.n; nulls = true; } else codes[i] = v[i]; }
    if (nulls) { const nb = new Uint8Array(dd.bytes.length), ns = new Int32Array(dd.n + 1), ne = new Int32Array(dd.n + 1); nb.set(dd.bytes); ns.set(dd.start); ne.set(dd.end); ns[dd.n] = ne[dd.n] = dd.bytes.length; lb = { bytes: nb, start: ns, end: ne, n: dd.n + 1 }; }
    return { codes, lb };
  }
  if (k === K.UTF8 || k === K.LUTF8) {
    let st, en; if (k === K.UTF8) { const o = arrowView(B[bi + 1], Int32Array, n + 1); st = o.slice(0, n); en = o.slice(1, n + 1); } else { const o = arrowView(B[bi + 1], BigInt64Array, n + 1); st = new Int32Array(n); en = new Int32Array(n); for (let i = 0; i < n; i++) { st[i] = Number(o[i]); en[i] = Number(o[i + 1]); } }
    if (val) for (let i = 0; i < n; i++) if (bad(i)) en[i] = st[i];
    return { bytes: B[bi + 2].slice(), start: st, end: en };
  }
  if (k === K.BOOL) { const bits = B[bi + 1], codes = new Int32Array(n); for (let i = 0; i < n; i++) codes[i] = val && bad(i) ? 2 : (bits[i >> 3] >> (i & 7)) & 1; return { codes, lb: ARROW_BOOLLB }; }
  if (k === K.F64 && !val) return arrowView(B[bi + 1], Float64Array, n).slice();
  const out = new Float64Array(n);
  if (k === K.I64 || k === K.U64 || k === K.D64 || k === K.TS) {
    const big = arrowView(B[bi + 1], k === K.U64 ? BigUint64Array : BigInt64Array, n);
    if ((k === K.I64 || k === K.U64) && exact) { const te = new TextEncoder(), parts = [], st = new Int32Array(n), en = new Int32Array(n); let o = 0; for (let i = 0; i < n; i++) { st[i] = o; if (!(val && bad(i))) { const b = te.encode(String(big[i])); parts.push(b); o += b.length; } en[i] = o; } const bytes = new Uint8Array(o); let p = 0; for (const b of parts) { bytes.set(b, p); p += b.length; } return { bytes, start: st, end: en }; }
    for (let i = 0; i < n; i++) {
      if (val && bad(i)) { out[i] = NaN; continue; } const v = big[i];
      if ((k === K.I64 || k === K.U64) && (v > ARROW_MAXS || v < -ARROW_MAXS)) throw Object.assign(new Error('An integer column holds a value beyond 2^53.'), { code: 'INT64_RANGE', col: ci });
      out[i] = k === K.D64 ? Math.floor(Number(v) / 86400000) : Number(v);
    }
    if (k === K.TS && c.mul === 1000) { for (let i = 0; i < n; i++) out[i] *= 1000; }
    return out;
  }
  const T = { [K.I8]: Int8Array, [K.I16]: Int16Array, [K.I32]: Int32Array, [K.U8]: Uint8Array, [K.U16]: Uint16Array, [K.U32]: Uint32Array, [K.F64]: Float64Array, [K.D32]: Int32Array }[k], v = arrowView(B[bi + 1], T, n);
  if (!val) for (let i = 0; i < n; i++) out[i] = v[i]; else for (let i = 0; i < n; i++) out[i] = bad(i) ? NaN : v[i];
  return out;
}
async function arrowGroupCols(m, a) {
  const body = new Uint8Array(await m.file.slice(a.bodyAt, a.bodyAt + a.bodyLen).arrayBuffer()), B = arrowBodyBufs(body, a), out = []; let bi = 0;
  m.cols.forEach((c, i) => { const node = a.nodes[i] || { len: a.len, nulls: 0 }; out.push(arrowCol(c, node, B, bi, a.dicts, pqIsExact(m.exact, i, c), i)); bi += c.dictId !== null ? 2 : (c.ak === K.UTF8 || c.ak === K.LUTF8) ? 3 : 2; });
  return out;
}
async function pqGroupJob(m) {
  try {
    pqInit(); await LfcPack.init(); const g = m.group, out = [], dec = new TextDecoder();
    let arrowOut = null; if (g.arrow) { try { arrowOut = await arrowGroupCols(m, g.arrow); } catch (e) { if (e && e.code === 'INT64_RANGE') { self.postMessage({ type: 'pqdone', rid: m.rid, error: String(e.message), exactCol: e.col }); return; } throw e; } }
    for (let i = 0; i < (g.arrow ? m.cols.length : g.chunks.length); i++) {
      const ch = g.arrow ? null : g.chunks[i], b = ch ? new Uint8Array(await m.file.slice(ch.start, ch.start + ch.comp).arrayBuffer()) : null, col = m.cols[i];
      let c; try { c = g.arrow ? arrowOut[i] : PQ.decodeChunk(col, ch, b, pqInfl, pqIsExact(m.exact, i, col) ? { exact: true } : undefined); } catch (e) { if (e && e.code === 'INT64_RANGE') { self.postMessage({ type: 'pqdone', rid: m.rid, error: String(e.message), exactCol: i }); return; } throw e; } if (c instanceof Float64Array && (col.kind === 'date' || col.kind === 'timestamp')) c = (!m.chunk && col.kind === 'timestamp' && !col.tz && pqTs(c, col.unit, col.fixed)) || pqDateText(c, col.kind, col.unit, col.fixed, col.tz); out.push(c);
    }
    const len = (c) => c instanceof Float64Array ? c.length : c.kind === 'ts' ? c.values.length : c.codes ? c.codes.length : c.start.length, n = out.length ? len(out[0]) : 0;
    let sample = null;
    if (m.first) { sample = []; const rowsN = Math.min(20, n); for (let r = 0; r < rowsN; r++) { const rec = {}; m.cols.forEach((col, i) => { const c = out[i]; let v; if (c.kind === 'ts') { const x = c.values[r]; v = x !== x ? null : new Date(x * (c.unit === 's' ? 1000 : c.unit === 'ms' ? 1 : 0.001)).toISOString().slice(0, 19).replace('T', ' '); } else if (c instanceof Float64Array) { v = c[r]; v = v !== v ? null : col.kind === 'decimal' && col.scale ? v / Math.pow(10, col.scale) : v; } else if (c.codes) { const q = c.codes[r]; v = dec.decode(c.lb.bytes.subarray(c.lb.start[q], c.lb.end[q])); } else v = dec.decode(c.bytes.subarray(c.start[r], c.end[r])); rec[col.name] = v === '' ? null : v; }); sample.push(rec); } }
    if (m.chunk) {   // staged columns: hand back a chunk in the shape the CSV builder makes, so the live grid and the pack workers take it as they take a CSV piece
      const cols = out.map((c, i) => { const k = m.cols[i].kind; if (c instanceof Float64Array) { if (k === 'int' || k === 'decimal') return c; return pqNumText(c); } if (c.codes) { const q = c.lb.n; return { codes: c.codes, lb: { bytes: c.lb.bytes, start: c.lb.start.slice(0, q), end: c.lb.end.slice(0, q) } }; } return c; });
      let est = 0; for (const c of cols) est += c instanceof Float64Array ? n * 8 : c.codes ? n : c.bytes.length + n;
      const chunk = { n, bytes: est, cols }, chunk2 = m.dup ? dupChunk(chunk) : null, tr = [].concat(chunkBuffers(chunk), chunk2 ? chunkBuffers(chunk2) : []);
      self.postMessage({ type: 'pqdone', rid: m.rid, chunk, chunk2, rows: n, sample }, tr); return;
    }
    const named = {}; out.forEach((c, i) => { named[m.cols[i].name] = c instanceof Float64Array || c.kind === 'ts' ? c : c.codes ? { kind: 'dict', labels: { bytes: c.lb.bytes, start: Uint32Array.from(c.lb.start.subarray(0, c.lb.n)), end: Uint32Array.from(c.lb.end.subarray(0, c.lb.n)) }, ids: c.codes } : c; });
    const popts = { level: m.level || 3, blockBytes: 2097152, share: false }, S = n >= 131072 ? (m.parts || 1) : 1;
    if (S > 1) {   // spare cores: cut the decoded group into S row ranges; range 0 is packed here, the others go to pack helpers through the importing worker (blocks stay in (group, range) order)
      const cut = (c, a, b) => c instanceof Float64Array ? c.subarray(a, b) : c.kind === 'ts' ? Object.assign({}, c, { values: c.values.subarray(a, b) }) : c.kind === 'dict' ? { kind: 'dict', labels: c.labels, ids: c.ids.subarray(a, b) } : { bytes: c.bytes, start: c.start.subarray(a, b), end: c.end.subarray(a, b) };
      const dup = (c, trf) => { if (c instanceof Float64Array) { const x = c.slice(); trf.push(x.buffer); return x; } if (c.kind === 'ts') { const x = Object.assign({}, c, { values: c.values.slice() }); trf.push(x.values.buffer); return x; } if (c.kind === 'dict') { const x = { kind: 'dict', labels: c.labels, ids: c.ids.slice() }; trf.push(x.ids.buffer); return x; } const x = { bytes: c.bytes.slice(), start: c.start.slice(), end: c.end.slice() }; trf.push(x.bytes.buffer, x.start.buffer, x.end.buffer); return x; };
      for (let q = 1; q < S; q++) {
        const a = Math.floor(n * q / S), b = Math.floor(n * (q + 1) / S), part = {}, trf = [];
        for (const nm in named) part[nm] = dup(cut(named[nm], a, b), trf);
        self.postMessage({ type: 'pqPart', grp: m.grp, p: q, rows: b - a, named: part, o: popts }, trf);
      }
      const n0 = Math.floor(n / S), part0 = {}; for (const nm in named) part0[nm] = cut(named[nm], 0, n0);
      const r0 = await LfcPack.packBlock(part0, popts);
      self.postMessage({ type: 'pqdone', rid: m.rid, r: r0, rows: n0, parts: S, sample }, [r0.buffer]); return;
    }
    const r = await LfcPack.packBlock(named, popts);
    self.postMessage({ type: 'pqdone', rid: m.rid, r, rows: n, sample }, [r.buffer]);
  } catch (err) { self.postMessage({ type: 'pqdone', rid: m.rid, error: String(err && err.message || err) }); }
}
async function pqPartJob(m) {   // pack helper: pack one row range that a decode worker handed over
  try { pqInit(); await LfcPack.init(); const r = await LfcPack.packBlock(m.named, m.o); self.postMessage({ type: 'pqpartdone', grp: m.grp, p: m.p, rows: m.rows, r }, [r.buffer]); }
  catch (err) { self.postMessage({ type: 'pqpartdone', grp: m.grp, p: m.p, error: String(err && err.message || err) }); }
}
async function parseParquet(file, job, progress, t, write, packer, col, setPlan, exact) {
  const t0 = performance.now(); let tailN = Math.min(file.size, 1048576), tail = new Uint8Array(await file.slice(file.size - tailN).arrayBuffer());
  const fl = new DataView(tail.buffer, tail.byteLength - 8, 4).getUint32(0, true); if (fl + 8 > tailN && fl + 8 <= file.size) tail = new Uint8Array(await file.slice(file.size - fl - 8).arrayBuffer());
  const AP = arrowPlans.get(file), ft = AP ? { cols: AP.cols, groups: AP.groups } : PQ.readFooter(tail), cols = ft.cols, groups = ft.groups;
  if (!cols.length || !groups.length) throw new Error('This Parquet file has no rows.');
  const KIND = { int: 'integer', decimal: 'number', double: 'number', bool: 'boolean', text: 'string', date: 'date', timestamp: 'date' };
  const headers = cols.map((c) => c.name), types = cols.map((c) => ({ type: KIND[c.kind] || 'string', nullable: true }));
  const plan = cols.map((c, i) => pqIsExact(exact, i, c) ? false : c.kind === 'int' ? true : c.kind === 'decimal' ? (c.scale > 0 ? c.scale : true) : false);
  if (col && cols.some((c) => c.kind === 'double')) col = null;   // doubles have no fixed-decimal form, so the staged path would store them as text (bigger file, slower): take the direct pack path
  setPlan(plan); if (col) { await col.begin(headers); t.cols = true; }
  const hw = (self.navigator && navigator.hardwareConcurrency) || 4, nw = Math.max(1, Math.min(4, hw - 1, groups.length)), helpers = [], pending = new Map(); let rid = 0;
  const ph = [], idle = [], partQ = [], partsIn = new Map();   // pack helpers for row ranges handed over by the decode workers
  const closeAll = () => { helpers.forEach((h) => h.terminate()); ph.forEach((h) => h.terminate()); };
  const failAll = (err) => { for (const p of pending.values()) p.rej(err); pending.clear(); };
  try { for (let i = 0; i < nw; i++) helpers.push(mkWorker()); } catch { closeAll(); throw new Error('Parquet files need worker threads, and this page cannot start them.'); }
  // Pack pool (owner laptop runs: taxi 16 cores k=4 best, SBA 16 cores k=8 best): a decoded group is cut into k row ranges, k = min(floor(workers / row groups), POOL_K_MAX), and no range may hold fewer than POOL_CELLS (about 2M after the SBA laptop run) cells (rows x columns). Constants, not settings.
  const POOL_K_MAX = 8, POOL_CELLS = 2e6, canPool = !col && hw > 4 && !(self.navigator && navigator.deviceMemory && navigator.deviceMemory < 8);
  const kBase = canPool ? Math.min(POOL_K_MAX, Math.floor((hw - 1) / groups.length)) : 1, partsFor = (g) => Math.max(1, Math.min(kBase, Math.floor(((g && g.rows) || 0) * cols.length / POOL_CELLS)));
  const spare = kBase > 1 ? Math.min(hw - 1 - nw, nw * (kBase - 1)) : 0;
  const dispatch = () => { while (partQ.length && (idle.length || ph.length < spare)) { let h = idle.shift(); if (!h) { try { h = mkWorker(); } catch { return; } h.onmessage = (e) => { const d = e.data || {}; if (d.type !== 'pqpartdone') return; if (d.error) failAll(new Error(d.error)); else { (partsIn.get(d.grp) || partsIn.set(d.grp, new Map()).get(d.grp)).set(d.p, d); idle.push(h); dispatch(); } signal(); }; h.onerror = (e) => { failAll(new Error('A Parquet helper failed: ' + (e && e.message || 'unknown error'))); signal(); }; ph.push(h); } const q = partQ.shift(), trf = []; for (const nm in q.named) { const c = q.named[nm]; if (c instanceof Float64Array) trf.push(c.buffer); else if (c.kind === 'ts') trf.push(c.values.buffer); else if (c.kind === 'dict') trf.push(c.ids.buffer); else trf.push(c.bytes.buffer, c.start.buffer, c.end.buffer); } h.postMessage({ type: 'pqPackPart', grp: q.grp, p: q.p, rows: q.rows, named: q.named, o: q.o }, trf); } };
  for (const h of helpers) { h.onmessage = (e) => { const d = e.data || {}; if (d.type === 'pqPart') { partQ.push(d); dispatch(); return; } if (d.type === 'pqdone') { const p = pending.get(d.rid); if (p) { pending.delete(d.rid); if (d.error) p.rej(Object.assign(new Error(d.error), { pqExact: d.exactCol })); else p.res(d); } } }; h.onerror = (e) => failAll(new Error('A Parquet helper failed: ' + (e && e.message || 'unknown error'))); }
  job.abort = () => { closeAll(); failAll(Object.assign(new Error('Import cancelled.'), { cancelled: true })); };
  const rpc = (h, msg) => new Promise((res, rej) => { const id = ++rid; pending.set(id, { res, rej }); h.postMessage(Object.assign({ type: 'pqGroup', rid: id }, msg)); });
  let rows = 0, sample = [], next = 0, nextW = 0; const done = new Map(), waiters = new Set(); const signal = () => { for (const w of [...waiters]) { waiters.delete(w); w(); } }, wait = () => new Promise((r) => waiters.add(r));
  const WINDOW = nw * 2; let quit = false, bytes = 0;
  const run = async (h) => { while (!quit && next < groups.length) { if (next >= nextW + WINDOW) { await wait(); continue; } const k = next++; done.set(k, await rpc(h, { file, cols, exact, group: groups[k], grp: k, parts: partsFor(groups[k]), first: k === 0, level: 3, chunk: !!col, dup: !!(col && col.dup) }).catch((err) => ({ error: err }))); signal(); } };
  try {
    const loops = helpers.map(run);
    for (let k = 0; k < groups.length; k++) {
      while (!(done.has(k) && (!done.get(k).parts || done.get(k).parts <= 1 || (partsIn.get(k) && partsIn.get(k).size >= done.get(k).parts - 1)))) { stop(job); await wait(); }
      const r = done.get(k); done.delete(k); nextW = k + 1; signal(); stop(job);
      if (r.error) throw r.error;
      if (r.chunk) await col.push(r.chunk, r.chunk2); else { await write(packer.pushPacked(r.r)); if (r.parts > 1) { const pi = partsIn.get(k); partsIn.delete(k); for (let q = 1; q < r.parts; q++) { const d = pi.get(q); await write(packer.pushPacked(d.r)); rows += d.rows; } } } rows += r.rows; if (r.sample) sample = r.sample; for (const c of groups[k].chunks) bytes += c.comp; progress(Math.min(file.size, bytes), rows);
    }
    quit = true; signal(); await Promise.all(loops);
    t.parseMs = performance.now() - t0; t.readMs = 0;
    return { headers, types, rows, sample, pieces: col ? groups.length : 0, plan };
  } finally { quit = true; closeAll(); }
}
