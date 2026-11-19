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
const loadX = () => { if (X === null) { try { const s = atob('AGFzbQEAAAABIAVgAAF/YAN/f38AYAV/f39/fwBgAn9/AGAEf39/fwF/Aw0MAAAAAAECAwAAAAEEBAUBcAEBAQUEAQCAAgYRAn8BQeDR1gALfwBB4NHWAAsHkAEOBm1lbW9yeQIACGtleXNfcHRyAAAJZmxhZ3NfcHRyAAEJY250X25fcHRyAAIJY250X2VfcHRyAAMFc2V0dXAABAdzZXRfY29sAAUIc2V0X3Nsb3QABgdvdXRfbGVuAAcEcm93cwAIBGJhaWwACQljYWNoZV9hZGQACgVidWlsZAALC19faGVhcF9iYXNlAwEK2yMMCABBgIiAgAALCABBgMiAgAALCABBwMiAgAALCABBwMqAgAALewBBACABOgDEzICAAEEAIAA2AsDMgIAAQQAgAjYCyMyAgABBAEJ/NwPQzICAAEEAQn83A9jMgIAAQQBCfzcD4MyAgABBAEJ/NwPozICAAEEAQn83A/DMgIAAQQBCfzcD+MyAgABBAEJ/NwOAzYCAAEEAQn83A4jNgIAACz8AIABBkNGAgABqIAM6AAAgAEHQzICAAGogBDoAACAAQQJ0IgBBkM+AgABqIAI2AgAgAEGQzYCAAGogATYCAAsQACAAQdDMgIAAaiABOgAACwsAQQAoAtDRgIAACwsAQQAoAtTRgIAACwsAQQAtANjRgIAAC+0DAQx/AkAgAkFXakFYSQ0AIAJBA3EhAwJAAkAgAkF/akEDTw0AQcW78oh4IQRBACEFDAELIAJBPHEhBkHFu/KIeCEEQQAhBQNAIAQgASAFaiIHLQAAc0GTg4AIbCAHQQFqLQAAc0GTg4AIbCAHQQJqLQAAc0GTg4AIbCAHQQNqLQAAcyIIQZODgAhsIQQgBiAFQQRqIgVHDQALCwJAIANFDQAgASAFaiEHA0AgBCAHLQAAcyIIQZODgAhsIQQgB0EBaiEHIANBf2oiAw0ACwsCQAJAIABBgKAKbCIJIARB/x9xQSlsakHg0YCAAGoiBS0AACIHDQBBACEKDAELIAJBAWohCyAJQeHRgIAAaiEMQQAhCiAEIQ0DQAJAAkAgB0H/AXEgAkcNACAMIA1B/x9xQSlsaiEFIAEhAyALIQcDQCAHQQFGDQUgB0F/aiEHIAMtAAAhBiAFLQAAIQ4gA0EBaiEDIAVBAWohBSAOIAZGDQALIAdFDQQgCkH/H0kNAQwECyAKQf4fSw0DCyANQQFqIQ0gCSAKQQFqIgogBGpB/x9xQSlsakHg0YCAAGoiBS0AACIHDQALCyAFIAI6AAAgAkUNACAIQZMDbCAKakH/H3FBKWwgAEGAoApsakHh0YCAAGogASAC/AoAAA8LC9QdBQ5/AXsCfwF7Dn8jgICAgABBgARrIgQkgICAgABBACEFQQBBADoA2NGAgABBAC0AxMyAgAAhBgJAQQAoAsDMgIAAIgdFDQBBwMiAgABBACAHQQJ0Igj8CwBBwMqAgABBACAI/AsAC0EAIQhBACEJAkAgAUUNACAAQX9qIQogAEEBaiELIAJBAWohDCABQQFqIQ0gBCAHQX9qIg5BAnRqIQ8gBEGAAmpBBHIhEEEAKALIzICAACERIAb9DyESQQAhCUEAIQhBACEFA0AgBCAJNgKAAkEAIRMgCSEUAkACQAJAAkADQAJAIAAgFGr9AAAAIhUgEv0jIBX9DCIiIiIiIiIiIiIiIiIiIiL9I/1QIBX9DFxcXFxcXFxcXFxcXFxcXFz9I/1QIBX9DIGBgYGBgYGBgYGBgYGBgYH9bv0MoaGhoaGhoaGhoaGhoaGhof0m/VD9ZCIWRQ0AIBAgE0ECdCIXaiEYIAQgF2ohFwNAIBZoIBRqIhkgAU8NAyAAIBlqLQAAIhogBkH/AXFHDQQgE0EBaiITIAdPDQYgFyAZNgIAIBggGUEBajYCACAXQQRqIRcgGEEEaiEYIBZBf2ogFnEiFg0ACwsgFEEQaiIUIAFJDQALCyANIRkMAQsgGkEKRw0BCyAZIAFLDQIgGSEWAkAgGSAJTQ0AIBkgCiAZai0AAEENRmshFgsgEyAORw0AIBYgCUYNACAPIBY2AgAgCCAJayAWaiARaiADSw0CAkAgB0UNAEEAIRMDQAJAIAQgE0ECdCIWaigCACIXIARBgAJqIBZqKAIAIhhGDQAgE0GAyICAAGotAAAiG0UNACAXIBhrIRwgACAYaiEdAkACQCAbQQNxDQBBACEeDAELQQAhGgJAIBwgHS0AACIfQS1GIiBNIiENAAJAIB0gIGotAAAiFkEwRw0AQQJBASAfQS1GGyAcRiEaDAELIBZBRmpB/wFxQfcBSQ0AIBwgIGtBD0sNACALIBggIGoiFmohFCAWIBdrQQFqIRYDQCAWRSEaIBZFDQEgFkEBaiEWIBQtAAAhIiAUQQFqIRQgIkFGakH/AXFB9QFLDQALCyAbIBpxIR4gG0ECcUUNAAJAIBoNACAhDQECQAJAIB0gIGotAAAiFkEwRw0AQQJBASAfQS1GGyEWDAELIBZBT2pB/wFxQQhLDQIgCyAYaiEiIBxBf2ohGgNAIBogIEYNAiAiICBqIRQgIEEBaiIWISAgFC0AAEFQakH/AXFBCkkNAAsLAkAgFiAcTw0AIB0gFmotAABBLkcNACAWQQFqIhQgHE8NAiAUIRYCQANAIB0gFmotAABBUGpB/wFxQQlLDQEgHCAWQQFqIhZHDQALIBwhFgsgFiAURg0CCwJAIBYgHE8NACAdIBZqLQAAQSByQeUARw0AAkAgFkEBaiIUIBxPDQACQCAdIBRqLQAAQVVqDgMAAQABCyAWQQJqIRQLIBQgHE8NAiAUIRYCQANAIB0gFmotAABBUGpB/wFxQQlLDQEgHCAWQQFqIhZHDQALIBwhFgsgFiAURg0CCyAWIBxHDQELIB5BAnIhHgsCQCAbQQRxRQ0AAkACQAJAIBxBfGoOAgABAwsgHS0AAEHfAXFB1ABHDQIgHS0AAUHfAXFB0gBHDQJBAyEWIB0tAAJB3wFxQdUARg0BDAILIB0tAABB3wFxQcYARw0BIB0tAAFB3wFxQcEARw0BIB0tAAJB3wFxQcwARw0BQQQhFiAdLQADQd8BcUHTAEcNAQsgHSAWai0AAEHfAXFBxQBHDQAgHkEEciEeCwJAIBtBCHFFDQAgE0HQzICAAGotAAAiIEH/AUYNACAcQShLDQACQAJAIBwNAEHFu/KIeCEiDAELIBxBA3EhFAJAAkAgGCAXa0F8TQ0AQcW78oh4ISJBACEXDAELIBxBPHEhGkHFu/KIeCEiQQAhFwNAICIgHSAXaiIWLQAAc0GTg4AIbCAWQQFqLQAAc0GTg4AIbCAWQQJqLQAAc0GTg4AIbCAWQQNqLQAAc0GTg4AIbCEiIBogF0EEaiIXRw0ACwsgFEUNACAAIBcgGGpqIRYDQCAiIBYtAABzQZODgAhsISIgFkEBaiEWIBRBf2oiFA0ACwsgIEGAoApsIiFB4dGAgABqISNBACEgICIhHwNAICEgICAiakH/H3FBKWxqQeDRgIAAai0AACIWRQ0BAkACQCAcIBZHDQAgIyAfQf8fcUEpbGohGCAcIRYgHSEXA0AgFkUNAiAWQX9qIRYgFy0AACEUIBgtAAAhGiAYQQFqIRggF0EBaiEXIBogFEYNAAsLIB9BAWohHyAgQQFqIiBBgCBHDQEMAgsLIB5BCHIhHgsgHiAbRw0DCyATQQFqIhMgB0cNAAtBACEbA0ACQCAbQQJ0IiJBkM+AgABqKAIAIhRFDQAgIkGQzYCAAGooAgAiHUGAiICAAGohF0EAIRoCQCAUQRBJDQAgCCACaiIWIB1BgIiAgABqa0EQSQ0AIAggFEFwcSIaaiEIIBohEyAXIRgDQCAWIBj9AAAA/QsAACAYQRBqIRggFkEQaiEWIBNBcGoiEw0ACyAUIBpGDQELAkACQCAUQQNxIhgNACAaIRYMAQsgGiEWA0AgAiAIaiAXIBZqLQAAOgAAIBZBAWohFiAIQQFqIQggGEF/aiIYDQALCyAaIBRrQXxLDQAgFCAWayETIAIgCGohFCAWIB1qQYCIgIAAaiEaQQAhFgNAIBQgFmoiGCAaIBZqIhctAAA6AAAgGEEBaiAXQQFqLQAAOgAAIBhBAmogF0ECai0AADoAACAYQQNqIBdBA2otAAA6AAAgEyAWQQRqIhZHDQALIAggFmohCAsgIkHAyICAAGoiFiAWKAIAQQFqNgIAAkACQAJAIAQgImooAgAiGiAEQYACaiAiaigCACIURw0AICJBwMqAgABqIhYgFigCAEEBajYCACACIAhqIRYCQCAbQZDRgIAAai0AAEUNACAWQe7qseMGNgAAIAhBBGohCAwDCyAWQaLEADsAAAwBCyAaIBRrISICQAJAAkACQCAbQZDRgIAAai0AACIYQQFHDQAgIiAAIBRqIhYtAABBLUYiF00NAyAWIBdqLQAAIhNBMEYNASATQUZqQf8BcUH3AUkNAyAiIBdrQQ9LDQNBAkEBIBcbIhcgIk8NAiAAIBcgFGoiE2ohFyATIBprIRMDQCAXLQAAQUZqQf8BcUH2AUkNASAXQQFqIRcgE0EBaiITRQ0DDAALCyAYQRBJDQIgGCAAIBRqIhctAAAiH0EtRiITakFyaiAiSw0CICIgGGtBD2oiFiATTQ0CIBcgFmotAABBLkcNAiATICJrQXBJDQIgFyATai0AAEEwRiAWIBNrQQFLcQ0CIBNBAWohFiAUIBprISAgFCAYaiAaayEeQQAhHUEAIRwCQANAAkAgHiAWakEQRg0AIBcgFmpBf2otAAAiCUFQakH/AXFBCUsNAiAcQQEgCUEwRhshHAsgFiAiTyEdICAgFkEBaiIWakEBRw0ACwsgHUEBcUUNAiAfQS1HIhYgHEEAR3JFDQICQCAWDQAgAiAIakEtOgAAIAhBAWohCAsCQCAUIBNqIhcgGk8NACAaIBhrQQ9qISIgGiAUIBNqayIWQQFxIR1BACEYAkAgGiAUQX9zaiATRg0AIBZBfnEhE0EAIRgDQAJAICIgFyIWRg0AIAAgFmotAAAhFwJAIBgNAEEAIRggF0H/AXFBMEYNAQsgAiAIaiAXOgAAQQEhGCAIQQFqIQgLAkAgFkEBaiIXICJGDQAgACAWakEBai0AACEUAkAgGA0AQQAhGCAUQf8BcUEwRg0BCyACIAhqIBQ6AABBASEYIAhBAWohCAsgF0EBaiEXIBNBfmoiEw0ACyAWQQJqIRcLAkAgHUUNACAXICJGDQAgACAXai0AACEWAkAgGA0AQQAhGCAWQf8BcUEwRg0BCyACIAhqIBY6AABBASEYIAhBAWohCAsgGA0FCyACIAhqQTA6AAAgCEEBaiEIDAQLICJBAUcNAQsgFCAaTw0CAkAgIkEQSQ0AIAggAmoiGCAAIBRqa0EQSQ0AIBQgIkFwcSITaiEUIAggE2ohCCATIRcDQCAYIBb9AAAA/QsAACAWQRBqIRYgGEEQaiEYIBdBcGoiFw0ACyAiIBNGDQMLAkACQCAaIBRrQQNxIhgNACAUIRYMAQsgFCEWA0AgAiAIaiAAIBZqLQAAOgAAIBZBAWohFiAIQQFqIQggGEF/aiIYDQALCyAUIBprQXxLDQIgGiAWayETIAAgFmohFCACIAhqIRpBACEWA0AgGiAWaiIYIBQgFmoiFy0AADoAACAYQQFqIBdBAWotAAA6AAAgGEECaiAXQQJqLQAAOgAAIBhBA2ogF0EDai0AADoAACATIBZBBGoiFkcNAAsgCCAWaiEIDAILIAIgCGpBIjoAACAIQQFqIRYCQCAUIBpPDQACQCAiQRBJDQAgDCAIaiAUIABqIhhrQRBJDQAgAiAWaiEXIBQgIkFwcSIdaiEUIBYgHWohFiAdIRMDQCAXIBj9AAAA/QsAACAYQRBqIRggF0EQaiEXIBNBcGoiEw0ACyAiIB1HDQAgCCAdaiEIDAELAkACQCAaIBRrQQNxIggNACAUIRgMAQsgFCEYA0AgAiAWaiAAIBhqLQAAOgAAIBZBAWohFiAYQQFqIRggCEF/aiIIDQALIBZBf2ohCAsgFCAaa0F8Sw0AIBogGGshEyAAIBhqIRQgAiAWaiEaQQAhCANAIBogCGoiGCAUIAhqIhctAAA6AAAgGEEBaiAXQQFqLQAAOgAAIBhBAmogF0ECai0AADoAACAYQQNqIBdBA2otAAA6AAAgEyAIQQRqIghHDQALIBYgCGoiFkF/aiEICyACIBZqQSI6AAALIAhBAmohCAsgG0EBaiIbIAdHDQALCyACIAhqQf0UOwAAIAVBAWohBSAIQQJqIQggGUEBaiIJIAFJDQEMAgsLQQBBAToA2NGAgAALQQAgBTYC1NGAgABBACAINgLQ0YCAACAEQYAEaiSAgICAACAJCw=='), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); X = new WebAssembly.Instance(new WebAssembly.Module(u)).exports; } catch (e) { X = false; } } return X; };
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
  try { await LfcPack.init(); let bytes = new Uint8Array(m.c); let keys = null, big = 0; if (m.flat) { flatOne ||= flatTransform(); if (m.flat === 2) { const sc = flatOne.scan(bytes); keys = sc.keys; if (sc.maybeBig) { flatOne.reset(0); const tb = flatOne(bytes); big = flatOne.big(); if (big) bytes = tb; } } else { flatOne.reset(1); bytes = flatOne(bytes); keys = flatOne.keys(); big = flatOne.big(); } } const r = LfcPack.packBlock(bytes, m.flat === 1 || big ? Object.assign({}, m.o, { blockBytes: bytes.length + 1024 }) : m.o);
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
async function zipList(m) { try { if (isXlsx(m.file)) { const x = await xlsxMeta(m.file); send('zipList', m.id, { entries: x.sheets.filter((s) => !s.hidden || s === x.pick).map((s) => ({ name: s.name, size: -1 })), picked: x.pick.name, sheets: true }); return; } const r = await unzipFile(m.file, null, true); send('zipList', m.id, r); } catch (err) { send('zipList', m.id, { error: String(err && err.message || err) }); } }
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

const isXlsx = (f) => /\.(xlsx|xlsm)$/i.test(f.name || '');
async function xlsxText(file, name) { const z = await unzipFile(file, name); return z.file.text(); }
function sheetWasm() {
  const bin = Uint8Array.from(atob('AGFzbQEAAAABKgdgAX8Bf2AKf39/f39/f39/fwBgAAF/YAAAYAF/AGADf39/AX9gAnx/AAMQDwABAgMCAgICBAUFAAUGBQQFAXABAQEFBAEAgAIGDwJ/AUHgiBQLfwBB4IgUCweFAQwGbWVtb3J5AgAFYWxsb2MAAAtfX2hlYXBfYmFzZQMBBXNldHVwAAEHb3V0X2xlbgACCW91dF9yZXNldAADCGdldF9yb3dzAAQJZ2V0X3dpZHRoAAULZ2V0X2Ryb3BwZWQABgpnZXRfc3RhdHVzAAcIc2V0X2Jhc2UACAdwcm9jZXNzAAkKv1MPXQEDf0EAIQFBAEEAKAKQiICAACICQeCIlIAAIAIbQQ9qQXBxIgIgAGoiADYCkIiAgAACQAJAIABB//8DakEQdiIAPwAiA00NACAAIANrQABBf0YNAQsgAiEBCyABC5wBAEEAIAE2ApiIgIAAQQAgADYClIiAgABBACACNgKciICAAEEAIAM2AqCIgIAAQQAgBDYCpIiAgABBACAFNgKoiICAAEEAIAY2AqyIgIAAQQAgBzYCsIiAgABBACAINgK0iICAAEEAIAk2AriIgIAAQQBBADYCvIiAgABBAEEANgLAiICAAEEAQQA2AsSIgIAAQQBBADoAyIiAgAALCwBBACgCvIiAgAALDQBBAEEANgK8iICAAAsLAEEAKALAiICAAAsLAEEAKAKgiICAAAsLAEEAKALEiICAAAsLAEEAKALMiICAAAsNAEEAIAA2AtCIgIAAC5otAR5/I4CAgIAAQRBrIgMkgICAgABBAEEANgLMiICAAAJAAkBBACgClIiAgAAiBCAAaiIFQQRqIAQgAWoiBksNAEEAIARrIQcDQCAFQX9zIQggBUEBaiEJQQAhCgNAAkACQAJAAkAgBSAKaiILLQAAQTxHDQAgC0EBai0AAEHyAEYNAQwCCyALQQVqIAZLDQUMAgsgC0ECai0AAEHvAEcNACALQQNqLQAAQfcARw0AAkACQCALIAZPDQAgBiAFayEMIAohDQNAIAUgDWoiDi0AAEE+Rg0CIAhBf2ohCCAJQQFqIQkgDCANQQFqIg1HDQALCyAFIARrIApqIQ8MBgsCQAJAAkACQAJAIAtBBGotAAAiC0FRag4QAgEBAQEBAQEBAQEBAQEBAgALIAtBIEYNAQsgByAFaiANaiEADAELAkAgDkF/ai0AAEEvRg0AIA5BAWoiECELIA5BB2ogBksNAgNAIAtBAWohCQJAAkACQAJAIAstAABBPEcNACAJLQAAQS9GDQEMAgsgC0EHaiAGSw0GDAILIAstAAJB8gBHDQAgCy0AA0HvAEcNACALLQAEQfcARw0AIAstAAVBPkcNAAJAQQAoAryIgIAAIhFBgICAAWpBACgCnIiAgABNDQBBAEEBNgLMiICAACAFIARrIApqIQ8MDAsgByAFaiAKaiESQQAhE0EAQQA2AtSIgIAAQQAhFANAIBAiFSEQAkADQCAQIg1BAmogC0sNASANQQRqIQ5BfCANayEMQXogDWshFiANQQZqIRdBACEJIA0hGANAAkAgDSAJaiIZLQAAQTxHDQAgGUEBaiIQLQAAQeMARw0CAkACQCAZQQJqIhAtAAAiGkFRag4QAQYGBgYGBgYGBgYGBgYGAQALIBpBIEcNBQsgGSALTw0DIBkgCGohEEEAIRogCSEbAkADQCAZIBpqIhwtAABBPkYNASAOQQFqIQ4gDEF/aiEMIBtBAWohGyAYQQFqIRggECAaQQFqIhpqDQAMBQsLAkACQCAaQQdJIh1FDQAgFCEVDAELIAkhEAJAA0ACQCANIBBqIh5BAmotAABBIEcNACAeQQNqLQAAQfIARw0AIB5BBGotAABBPUcNAAJAIB5BBWotAAAiH0Feag4GAAEBAQEAAQsCQCAeQQZqIh4gHEkNACAUIRUMBAsgGSAaaiEgIB4hEAJAA0AgEC0AACAfRg0BIBBBAWoiECAcSQ0ACyAgIRALIB4gEEcNAiAUIRUMAwsgFkF/aiEWIBdBAWohFyANIBBBAWoiEGpBBmogHEkNAAsgFCEVDAELIBAgFmoiFkEBIBZBAUsbIR9BACEeAkADQEFAIRYCQCAXLQAAIhBBv39qQf8BcUEaSQ0AQaB/IRYgEEGff2pB/wFxQRlLDQILIBdBAWohFyAeQRpsIBZqIBBqIR4gH0F/aiIfDQALCwJAIB4NACAUIRUMAQsgFSEQIB5Bf2oiF0EAKALQiICAACIWSQ0FIBcgFmshFQsgFUEBaiEUIBxBAWohECAcQX9qLQAAQS9GDQQgHEEFaiALSw0DQQEhFwNAAkACQAJAIBwgF2oiFi0AAEE8Rw0AIBZBAWotAABBL0YNAQwCCyAXQQFqIRcgFkEFaiALTQ0CDAYLIBZBAmotAABB4wBHDQAgFkEDai0AAEE+Rw0AIBZBBGohEAJAAkAgHUUNAEEAIRpB7gAhGUEAIR8MAQsgCSEeAkADQAJAIA0gHmoiH0ECai0AAEEgRw0AIB9BA2otAABB9ABHDQAgH0EEai0AAEE9Rw0AAkAgH0EFai0AACIdQV5qDgYAAQEBAQABCyAfQQZqIiAhHwJAICAgHE8NACAZIBpqIRkgICEfA0AgHy0AACAdRg0BIB9BAWoiHyAcSQ0ACyAZIR8LIB8gDWsgHmtBemohHgwCCyANIB5BAWoiHmpBBmogHEkNAAtBACEeQQAhIAsCQANAAkAgDSAJaiIZQQJqLQAAQSBHDQAgGUEDai0AAEHzAEcNACAZQQRqLQAAQT1HDQACQCAZQQVqLQAAIhpBXmoOBgABAQEBAAELIBlBBmoiHyEZAkAgHyAcTw0AIB8hGQNAIBktAAAgGkYNASAZQQFqIhkgHEkNAAsgHCEZCyAZIA1rIAlrQXpqIRoMAgsgDSAJQQFqIglqQQZqIBxJDQALQQAhGkEAIR8LQe4AIRkCQCAgRQ0AIB5FDQAgIC0AACEZCwJAIB5BAkkNAEHJACAZICAtAAAiCUHpAEYbIRkgCUHzAEcNACAgLQABQfQARw0AQdQAIRkMAQsgGUH/AXFByQBHDQAgF0EFSA0HA0ACQAJAAkACQCAYQQFqIgktAABBPEcNACAYQQJqLQAAQekARg0BDAILIBhBBmogFksNCwwCCyAYQQNqLQAAQfMARw0AIBhBBGotAABBPkcNAEEAIRlBACEJAkAgGEEGaiAWSw0AIBghCQNAAkACQAJAAkAgCUEBaiINLQAAQTxHDQAgCUECai0AAEEvRg0BDAILIAlBB2ogFk0NAkEAIQkMBAsgCUEDai0AAEHpAEcNACAJQQRqLQAAQfMARw0AIAlBBWotAABBPkcNACAJQQFqIQkMAwsgCUEHaiAWTQ0AQQAhCQwCCyANIQkMAAsLIBhBAWohDSAJIBYgCRshF0EAIRoCQANAIA1BAmogF0sNASAXIA1rIRggDUEFaiEOQQAhCSANIQwDQAJAIA0gCWoiFi0AAEE8Rw0AIBZBAWoiDS0AAEH0AEcNAgJAAkAgFkECaiINLQAAIglBUWoOEAEEBAQEBAQEBAQEBAQEBAEACyAJQSBHDQMLIBYgF08NAwJAA0AgDkF7ai0AAEE+Rg0BIAxBAWohDCAOQQFqIQ4gGEF/aiIYDQAMBQsLIA5BfGohDSAOQXpqLQAAQS9GDQIgDiAXSw0DIA5BfGohDQNAAkACQAJAAkAgDEEBaiIJLQAAQTxHDQAgDEECai0AAEEvRg0BDAILIAxBBmogF0sNBwwCCyAMQQNqLQAAQfQARw0AIAxBBGotAABBPkcNACADQQA2AggCQCANIAxBAWogA0EIahCKgICAACIJQQBIDQAgCSAZaiIOQYCACEsNAAJAIAlFDQAgGUHgiICAAGpB4IiIgAAgCfwKAAALIAxBBWohDSADKAIIIBpyIRogDiEZDAYLQQBBAjYCzIiAgAAgBSAEayAKaiEPDB0LIAxBBmogF0sNBQsgCSEMDAALCyAMQQFqIQwgGEF/aiEYIA5BAWohDiANIAlBAWoiCWpBAmogF00NAAsLCyAZRQ0KAkAgFUEAKAKgiICAAEkNAEEAQQAoAsSIgIAAQQFqNgLEiICAAAwLCwJAAkAgFRCLgICAAEUNACAZQQF0QQAoAryIgIAAIg1qQQRqQQAoApyIgIAASw0AQQAoApiIgIAAIQwCQCAaDQBBACEJAkAgGUEESQ0AIAwgDWohGCAZQXxxIRdBACEJA0AgGCAJaiIOIAlB4IiAgABqLQAAOgAAIA5BAWogCUHhiICAAGotAAA6AAAgDkECaiAJQeKIgIAAai0AADoAACAOQQNqIAlB44iAgABqLQAAOgAAIBcgCUEEaiIJRw0ACyANIAlqIQ0LAkAgGUEDcSIORQ0AIAlB4IiAgABqIQkDQCAMIA1qIAktAAA6AAAgCUEBaiEJIA1BAWohDSAOQX9qIg4NAAsLQQAgDTYCvIiAgABBASETDA0LIAwgDWpBIjoAACANQQFqIQlBACEOAkAgGUEBRw0ADAILIBlBfnEhFkEAIQ4DQAJAIA5B4IiAgABqIhgtAAAiDUEiRw0AIAwgCWpBIjoAACAJQQFqIQkgGC0AACENCyAMIAlqIA06AAAgCUEBaiENAkAgDkHhiICAAGoiFy0AACIYQSJHDQAgDCANakEiOgAAIAlBAmohDSAXLQAAIRgLIAwgDWogGDoAACANQQFqIQkgFiAOQQJqIg5GDQIMAAsLQQBBAjYCzIiAgAAgBSAEayAKaiEPDBcLAkAgGUEBcUUNAAJAAkAgDkHgiICAAGoiGC0AACIOQSJGDQAgCSENDAELIAwgCWpBIjoAACAJQQFqIQ0gGC0AACEOCyAMIA1qIA46AAAgDUEBaiEJC0EAIA1BAmo2AryIgIAAIAwgCWpBIjoAAEEBIRMMCgsgGEEGaiAWSw0JCyAJIRgMAAsLIBdBBEgNBgNAAkACQAJAAkAgDSAbaiIJQQFqLQAAQTxHDQAgCUECai0AAEH2AEYNAQwCCyAJQQVqIBZLDQoMAgsgCUEDai0AAEE+Rw0AIAlBBGohHEEAIR4CQCAJQQhqIBZLDQAgHCEJA0AgCUEBaiEYAkACQAJAIAktAABBPEcNACAYLQAAQS9GDQEMAgsgCUEFaiEXIBghCSAXIBZNDQIMAwsgCS0AAkH2AEcNACAJLQADQT5HDQAgCSEeDAILIAlBBWohFyAYIQkgFyAWTQ0ACwsgGUH/AXEiCUHlAEYNCSAcIB4gFiAeGyIYRg0JAkAgFUEAKAKgiICAAEkNAEEAQQAoAsSIgIAAQQFqNgLEiICAAAwKCwJAAkACQAJAAkACQCAJQdQARg0AAkAgCUHzAEcNAEEAIQkgHCAYTw0GIBggDGohDUEAIQkDQCAcLQAAIg5BUGpB/wFxQQpPDQcgHEEBaiEcIAlBCmwgDmpBUGohCSANQX9qIg0NAAwHCwsCQCAVEIuAgIAADQBBAEECNgLMiICAACAFIARrIApqIQ8MHAsCQAJAAkACQAJAIAlBnn9qDgMAAgECC0EBIRNBgIiAgABBhYiAgAAgHC0AAEExRhsiCS0AACINRQ0TIAlBAWohDkEAKAKYiICAACEMQQAoAryIgIAAIQkDQCAMIAlqIA06AAAgCUEBaiEJIA4tAAAhDSAOQQFqIQ4gDQ0AC0EAIAk2AryIgIAADBMLQQAoAryIgIAAIgkgGGogDWsgG2tBACgCnIiAgABLDQEgGCAMaiINQQEgDUEBSxshDEEAKAKYiICAACEXA0BBASETQSAgDi0AACINIA1B1ABGGyINQdoARg0TQQAgCUEBaiIYNgK8iICAACAXIAlqIA06AAAgDkEBaiEOIBghCSAMQX9qIgxFDRMMAAsLQQAhCQJAIB9FDQAgGkUNACAaQQNxIRZBACEXQQAhCQJAIBpBBEkNACAaQXxxIRlBACEXQQAhCQNAIAlBCmwgHyAXaiIJLQAAakEKbCAJQQFqLQAAakEKbCAJQQJqLQAAakEKbCAJQQNqLQAAakGw33xqIQkgGSAXQQRqIhdHDQALCyAWRQ0AIB8gF2ohFwNAIAlBCmwgFy0AAGpBUGohCSAXQQFqIRcgFkF/aiIWDQALCwJAAkAgCUEAKAK4iICAAE8NAEEAKAK0iICAACAJai0AACIJRQ0AIBwgGCADQQhqEIyAgIAARQ0AQQAoAryIgIAAQRhqQQAoApyIgIAATQ0BDAULIBggDWsiCUEAKAK8iICAACINaiAba0EAKAKciICAAEsiGg0CIAkgG2tBfGoiF0EBIBdBAUsbQQNxIR5BACEJQQAoApiIgIAAIRUCQCAXQQRJDQAgGCAMaiIJQQEgCUEBSxtBfHEhGyAVIA1qIRxBACEJA0AgDiAJaiIXLQAAIRNBACANIAlqIhZBAWo2AryIgIAAIBwgCWoiGSATOgAAIBdBAWotAAAhE0EAIBZBAmo2AryIgIAAIBlBAWogEzoAACAXQQJqLQAAIRNBACAWQQNqNgK8iICAACAZQQJqIBM6AAAgF0EDai0AACEXQQAgFkEEajYCvIiAgAAgGUEDaiAXOgAAIBsgCUEEaiIJRw0ACyANIAlqIQ0LIB5FDQYgGCAMaiIMQQEgDEEBSxtBA3EhDCAOIAlqIQkDQEEBIRMgCS0AACEOQQAgDUEBaiIYNgK8iICAACAVIA1qIA46AAAgCUEBaiEJIBghDSAMQX9qIgwNAAwICwsgAysDCCAJEI2AgIAAQQAhGgwFC0EAQQI2AsyIgIAAIAUgBGsgCmohDwwcC0EAQQI2AsyIgIAAIBIhDwwECyADQQA2AgggHCAYIANBCGoQioCAgAAiGEF/TA0AQQchGiAYRQ0DIBUQi4CAgABFDQAgGEEBdEEAKAK8iICAACINakEEakEAKAKciICAAEsNAEEAKAKYiICAACEMAkAgAygCCA0AIBhBA3EhF0EAIQkCQCAYQQRJDQAgDCANaiEWIBhB/P///wdxIRhBACEJA0AgFiAJaiIOIAlB4IiIgABqLQAAOgAAIA5BAWogCUHhiIiAAGotAAA6AAAgDkECaiAJQeKIiIAAai0AADoAACAOQQNqIAlB44iIgABqLQAAOgAAIBggCUEEaiIJRw0ACyANIAlqIQ0LAkAgF0UNACAJQeCIiIAAaiEJA0AgDCANaiAJLQAAOgAAIAlBAWohCSANQQFqIQ0gF0F/aiIXDQALC0EAIA02AryIgIAADAMLIAwgDWpBIjoAACAYQQFxIRkgDUEBaiEJQQAhDgJAIBhBAUcNAAwCCyAYQf7///8HcSEWQQAhDgNAAkAgDkHgiIiAAGoiGC0AACINQSJHDQAgDCAJakEiOgAAIAlBAWohCSAYLQAAIQ0LIAwgCWogDToAACAJQQFqIQ0CQCAOQeGIiIAAaiIXLQAAIhhBIkcNACAMIA1qQSI6AAAgCUECaiENIBctAAAhGAsgDCANaiAYOgAAIA1BAWohCSAWIA5BAmoiDkYNAgwACwtBAEECNgLMiICAAEEBIRogEiEPDAILAkAgGUUNAAJAAkAgDkHgiIiAAGoiGC0AACIOQSJGDQAgCSENDAELIAwgCWpBIjoAACAJQQFqIQ0gGC0AACEOCyAMIA1qIA46AAAgDUEBaiEJC0EAIA1BAmo2AryIgIAAIAwgCWpBIjoAAAtBASETCyAaDggKFhYPFhYJChYLIAlBACgCsIiAgABPDQlBACgCrIiAgAAgCUECdGoiCUEEaigCACINIAkoAgAiCUYNCUEAKAKoiICAACEOAkAgFRCLgICAAEUNAEEBIRMgDiAJaiIJIA4gDWogCWtBABCOgICAAA0KC0EAQQI2AsyIgIAAIAUgBGsgCmohDwwVCyAJQQVqIBZLDQgLIA5BAWohDiAMQX9qIQwgG0EBaiEbDAALCyAXQQFqIRcgFkEFaiALTQ0ADAQLCyAOQQFqIQ4gDEF/aiEMIBhBAWohGCAWQX9qIRYgF0EBaiEXIA0gCUEBaiIJakECaiALTQ0ACwsLCwJAAkAgEw0AQQAgETYCvIiAgAAMAQsCQEEAKAKgiICAACIIRQ0AQQAoAtSIgIAAIAhPDQAgCEF/ahCLgICAAA0AQQBBAjYCzIiAgAAgBSAEayAKaiEPDA0LQQBBACgCvIiAgAAiCkEBajYCvIiAgAAgCkEAKAKYiICAAGpBCjoAAEEAQQE6AMiIgIAAQQBBACgCwIiAgABBAWo2AsCIgIAACyALIARrQQZqIQAMBAsgC0EHaiAGSw0ECyAIQX9qIQggCSELDAALCyAHIAVqIA1qQQFqIQALIAQgAGoiBUEEaiAGTQ0EDAULIAUgBGsgCmohDwwFCyALQQVqIAZLDQMLIAhBf2ohCCAJQQFqIQkgCkEBaiEKDAALCwsgAEEAIAFBfGoiCiAKIAFLGyIKIAAgCksbIQ8LIANBEGokgICAgAAgDwvUDAEKf0EAIQNBACEEAkAgACABTw0AQQAhBEEAIQMDQAJAIARBh4B4akH//3dPDQBBfw8LAkACQAJAAkACQAJAAkACQAJAAkACQCAALQAAIgVBdmoiBg4jBQYGBQYGBgYGBgYGBgYGBgYGBgYGBgYGBQYGBgEGBgYGBgUACyAFQd8ARw0FIAEgAGtBB0gNBSAALQABQfgARw0FIAAtAAZB3wBHDQUgAC0AAiIGQVBqIgdB/wFxQQlNDQIgBkGff2pB/wFxQQVLDQEgBkGpf2ohBwwCCwJAAkAgAEEBaiIHIAFPDQAgBy0AAEEjRw0AAkACQAJAIABBAmoiCCABTw0AIAgtAABBIHJB+ABGDQELQQAhCSAIIQoDQCAJIQsgCiIHIAFPDQIgBy0AAEFQaiIMQf8BcUEJSw0CIAwgC0EKbGohCSAHQQFqIQogDEHjAEcNAAwCCwtBACEJIABBA2oiCCEKA0AgCSELIAoiByABTw0BIActAAAiCUE7Rg0BAkAgCUFQaiIMQf8BcUEJTQ0AAkAgCUGff2pB/wFxQQVLDQAgCUGpf2ohDAwBCyAJQb9/akH/AXFBBUsNAiAJQUlqIQwLIAdBAWohCiAMIAtBBHRqIQkgDEHjAEcNAAsLAkAgByABTw0AIActAABBO0cNACAHIAhLDQILIAYOIwUGBgUGBgYGBgYGBgYGBgYGBgYGBgYGBgUGBgYGBgYGBgYFBgsCQAJAAkAgASAHayIGQQRIDQAgBy0AACIHQeEARw0BQeEAIQcgAC0AAkHtAEcNAiAALQADQfAARw0CIAAtAARBO0cNAkEmIQsgAEEEakEBaiEADAYLIAZBA0cNByAHLQAAIQcLAkACQCAHQf8BcUGZf2oOBgECAgICAAILQewAIQcgAC0AAkH0AEcNASAALQADQTtHDQFBPCELIABBA2pBAWohAAwFC0HnACEHIAAtAAJB9ABHDQAgAC0AA0E7Rw0AQT4hCyAAQQNqQQFqIQAMBAsgBkEFSQ0FAkACQCAHQf8BcUGff2oOEQEHBwcHBwcHBwcHBwcHBwcABwsgAC0AAkH1AEcNBiAALQADQe8ARw0GIAAtAARB9ABHDQYgAC0ABUE7Rw0GIABBBmohAEEBIQVBIiELDAgLIAAtAAJB8ABHDQUgAC0AA0HvAEcNBSAALQAEQfMARw0FIAAtAAVBO0cNBSAAQQVqIQdBJyELCyAHQQFqIQAMAgsgBkG/f2pB/wFxQQVLDQMgBkFJaiEHCyAHQeMARg0CAkAgAC0AAyILQVBqIgZB/wFxQQpJDQACQCALQZ9/akH/AXFBBkkNACALQb9/akH/AXFBBk8NBCALQUlqIQYMAQsgC0Gpf2ohBgsgBkHjAEYNAgJAIAAtAAQiDEFQaiILQf8BcUEKSQ0AAkAgDEGff2pB/wFxQQZJDQAgDEG/f2pB/wFxQQZPDQQgDEFJaiELDAELIAxBqX9qIQsLIAtB4wBGDQICQCAALQAFIglBUGoiDEH/AXFBCkkNAAJAIAlBn39qQf8BcUEGSQ0AIAlBv39qQf8BcUEGTw0EIAlBSWohDAwBCyAJQal/aiEMCyAMQeMARg0CIABBB2ohACAMIAsgB0EIdCAGQQR0ampBBHRqIQsLQQEhBSALQXZqDiMDAgIDAgICAgICAgICAgICAgICAgICAgIDAgICAgICAgICAwILQQEhAwsgBEHgiIiAAGogBToAACAAQQFqIQAgBEEBaiEEDAMLIAtB/wBLDQEgAyEFCyAEQeCIiIAAaiALOgAAIARBAWohBCAFIQMMAQsCQCALQf8PSw0AIARB4YiIgABqIAtBP3FBgAFyOgAAIARB4IiIgABqIAtBBnZBwAFyOgAAIARBAmohBAwBCwJAIAtB//8DSw0AIARB4oiIgABqIAtBP3FBgAFyOgAAIARB4IiIgABqIAtBDHZB4AFyOgAAIARB4YiIgABqIAtBBnZBP3FBgAFyOgAAIARBA2ohBAwBCyAEQeCIiIAAaiALQRJ2QfABcjoAACAEQeOIiIAAaiALQT9xQYABcjoAACAEQeKIiIAAaiALQQZ2QT9xQYABcjoAACAEQeGIiIAAaiALQQx2QT9xQYABcjoAACAEQQRqIQQLIAAgAUkNAAsLIAIgAzYCACAEC5kFAQ5/I4CAgIAAQRBrIQECQEEAKAK8iICAACICIABBACgC1IiAgAAiA2tBBHRqQTBqQQAoApyIgIAATQ0AQQBBAjYCzIiAgABBAA8LAkAgACADSQ0AQQAoApiIgIAAIQQCQAJAQQAtAMiIgIAADQAgBEEHaiEFIAFBfGohBiABQX9qIQcDQAJAAkAgAw0AIAIhCAwBC0EAIAJBAWoiCDYCvIiAgAAgBCACakEsOgAACwJAAkAgAyAASQ0AIANBAWohAyAIIQIMAQtBASEJQQAhCiADQQFqIgMhCwNAIAEgCmogCyALQQpuIgxBCmxrQTByOgAAIAkiDUEBaiEJIApBAWohCiALQQpJIQ4gDCELIA5FDQALIAQgCGoiC0Hj3rGrBzYAACALQQZqQd8AOgAAIAtBBGpB7dwBOwAAIAhBB2ohAgJAAkAgCkEDcQ0AIAohDgwBCyANQQNxIQwgBSAIaiEOQQAhCyAHIQkDQCAOIAtqIAkgCmotAAA6AAAgCUF/aiEJIAwgC0EBaiILRw0ACyACIAtqIQIgCiALayEOCwJAIApBf2pBA0kNACAEIAJqIQwgBiAOaiELQQAhCUEAIA5rIQ4DQCAMIAlqIgogC0EDai0AADoAACAKQQFqIAtBAmotAAA6AAAgCkECaiALQQFqLQAAOgAAIApBA2ogCy0AADoAACALQXxqIQsgDiAJQQRqIglqDQALIAIgCWohAgtBACACNgK8iICAAAsgAyAATQ0ADAILCyAAQQFqIQkgAyELA0ACQCALRQ0AQQAgAkEBaiIKNgK8iICAACAEIAJqQSw6AAAgCiECCyALQQFqIgsgAE0NAAsgA0EBaiILIAkgCyAJSxshAwtBACADNgLUiICAAAtBAQuEBwUDfwF8An8BfAF/QQEhAwJAIAAgAU8NAAJAIAAtAAAiBEEtRw0AIABBAWohAEEAIQMMAQsgACAEQStGaiEACwJAAkAgACABSQ0AQQAhBUQAAAAAAAAAACEGDAELAkACQAJAIAAtAAAiB0FQaiIEQf8BcUEJTQ0ARAAAAAAAAAAAIQZBACEFIAAhBAwBC0EBIQUgBLchBgJAIABBAWoiBCABRw0AIAEhAAwDC0EBIQUgAEEBaiEAA0AgBC0AACIHQVBqIghB/wFxQQlLDQEgBkQAAAAAAAAkQKIgCLegIQYgBEEBaiEEIAEgAEEBaiIARw0ACyABIQAMAQsCQCAHQS5GDQAgBCEADAILAkAgBEEBaiIIIAFJDQAgCCEADAILAkAgBC0AAUFQaiIHQf8BcUEJTQ0AIAghAAwCCyAHt0SamZmZmZm5P6IgBqAhBkEBIQUgBEECaiIIIAQgASAAayIHaiIARg0BIAdBfmohBER7FK5H4XqEPyEJA0ACQCAILQAAQVBqIgdB/wFxQQlNDQAgCCEADAMLIAhBAWohCCAHtyAJoiAGoCEGIAlEAAAAAAAAJECjIQkgBEF/aiIEDQALC0EBIQULAkACQCAAIAFJDQAgACEEDAELAkAgAC0AAEEgckHlAEYNACAAIQQMAQtBASEKAkAgAEEBaiIEIAFPDQACQCAELQAAIghBLUcNACAAQQJqIQRBACEKDAELIABBAmogBCAIQStGGyEEC0QAAAAAAADwPyEJAkAgBCABTw0AIAEgBGshCEEAIQACQANAIAQtAAAiB0FQakH/AXFBCUsNASAEQQFqIQQgAEEKbCAHakFQaiEAIAhBf2oiCA0ACyABIQQLIABBAUgNAEQAAAAAAADwPyEJAkACQCAAQQdxIgcNACAAIQgMAQsgACEIA0AgCUQAAAAAAAAkQKIhCSAIQX9qIQggB0F/aiIHDQALCyAAQQhJDQAgCEF/aiEAA0AgCUQAAAAAAAAkQKJEAAAAAAAAJECiRAAAAAAAACRAokQAAAAAAAAkQKJEAAAAAAAAJECiRAAAAAAAACRAokQAAAAAAAAkQKJEAAAAAAAAJECiIQkgAEF4aiIAQX5JDQALCwJAIAoNACAGIAmjIQYMAQsgBiAJoiEGC0EAIQACQCAFRQ0AIAQgAUcNACACIAYgBpogAxs5AwBBASEACyAAC5AGBAJ+BX8EfgJ/AkACQCAAmUQAAAAAAADgQ2NFDQAgALAhAgwBC0KAgICAgICAgIB/IQILAkACQCAAIAK5oUQAAAAAABj1QKJEAAAAAAAA4D+gIgCZRAAAAAAAAOBDY0UNACAAsCEDDAELQoCAgICAgICAgH8hAwsgA0L/ogVVIQRBACgCvIiAgAAhBUEAKAKYiICAACEGAkACQCABQQNGDQBBACgCpIiAgAAhByAGIAVqIghBB2pBLToAACAIQQRqQS06AAAgCEEFaiAErSACfCICQrYLQgAgBxt8IAdFIAJCPFNxrXwiAkKLrSp8IgkgAkLbtyF8IAJCn7h+fEKTi1RVG0Kx9Qh/IgpCz4p3fiAJfCICQsx0fyACfCACQqydAn98IAJC0Ip3f3wiCULMdH8gAnwgCUKUnQJ/fCAJQu0CfyIJQpN9fnwiAkIFfkICfEKZAX8iC0IDQncgAkKyAlMbfCIMpyIHQQpuIg1BMGo6AAAgCEEGaiAHIA1BCmxrQTByOgAAIAhBCGogC0KZAX5CAnxCe38gAnynQQFqIgdBCm4iDUEwajoAACAIQgAgCSAKQpADfnwgDEIDU618IgIgAkKPzgBWGyICQugHf6dBMGo6AAAgCEEBaiACQuQAf0IKgadBMGo6AAAgCEECaiACQgp/IglCCoGnQTBqOgAAIAhBA2ogAiAJQgp+fadBMGo6AABBACAFQQpqIg42AryIgIAAIAhBCWogByANQQpsa0EwcjoAACABQQFGDQEgBiAOakEgOgAAIAVBC2ohBQsgBiAFaiIIQQVqQTo6AAAgCEECakE6OgAAIAhBBmogA0KA3Xp8IAMgBBsiA0I8gaciAUEKbiIGQTBqOgAAIAggA0KQHH8iAqciBEEKbiIHQTBqOgAAIAhBAWogBCAHQQpsa0EwcjoAACAIQQNqIAMgAkKQHH59p8FBPG0iBMFBCm4iB0EwajoAACAIQQRqIAQgB0EKbGtBMHI6AABBACAFQQhqNgK8iICAACAIQQdqIAEgBkEKbGtBMHI6AAALC8MEAQd/AkAgAUEBdEEAKAK8iICAACIDakEEakEAKAKciICAAE0NAEEAQQI2AsyIgIAAQQAPCwJAAkAgAg0AQQEhBCABRQ0BIAFBA3EhBUEAIQJBACgCmIiAgAAhBgJAIAFBBEkNACAGIANqIQQgAUF8cSEBQQAhAgNAIAQgAmoiByAAIAJqIggtAAA6AAAgB0EBaiAIQQFqLQAAOgAAIAdBAmogCEECai0AADoAACAHQQNqIAhBA2otAAA6AAAgASACQQRqIgJHDQALIAMgAmohAwsCQCAFRQ0AIAAgAmohAgNAIAYgA2ogAi0AADoAACACQQFqIQIgA0EBaiEDIAVBf2oiBQ0ACwtBACADNgK8iICAAEEBDwtBACEIQQAoApiIgIAAIgcgA2pBIjoAAEEBIQQgA0EBaiEDAkAgAUUNACABQQFxIQkCQCABQQFGDQAgAUF+cSEGQQAhCANAAkAgACAIaiIFLQAAIgJBIkcNACAHIANqQSI6AAAgA0EBaiEDIAUtAAAhAgsgByADaiACOgAAIANBAWohAgJAIAVBAWoiAS0AACIFQSJHDQAgByACakEiOgAAIANBAmohAiABLQAAIQULIAcgAmogBToAACACQQFqIQMgBiAIQQJqIghHDQALCyAJRQ0AAkAgACAIaiIILQAAIgJBIkcNACAHIANqQSI6AAAgA0EBaiEDIAgtAAAhAgsgByADaiACOgAAIANBAWohAwtBACADQQFqNgK8iICAACAHIANqQSI6AAALIAQLCxIBAEGACAsLVFJVRQBGQUxTRQAAyQEEbmFtZQAMC3NoZWV0Mi53YXNtAZMBDwAFYWxsb2MBBXNldHVwAgdvdXRfbGVuAwlvdXRfcmVzZXQECGdldF9yb3dzBQlnZXRfd2lkdGgGC2dldF9kcm9wcGVkBwpnZXRfc3RhdHVzCAhzZXRfYmFzZQkHcHJvY2VzcwoFdW5lc2MLB2ZpbGxfdG8MCXBhcnNlX251bQ0IcHV0X2RhdGUOCHB1dF90ZXh0BxIBAA9fX3N0YWNrX3BvaW50ZXIJCgEABy5yb2RhdGEAOAlwcm9kdWNlcnMBDHByb2Nlc3NlZC1ieQEMVWJ1bnR1IGNsYW5nETE4LjEuMyAoMXVidW50dTEpADkPdGFyZ2V0X2ZlYXR1cmVzAysLYnVsay1tZW1vcnkrD211dGFibGUtZ2xvYmFscysIc2lnbi1leHQ='), (c) => c.charCodeAt(0)); return new WebAssembly.Instance(new WebAssembly.Module(bin), {}).exports;
}
async function xlsxMeta(file, wantSheet) {
  let list; try { list = await unzipFile(file, null, true); } catch (e) { throw new Error('This Excel file cannot be read. It may be password-protected, damaged, or an old .xls file (save it as .xlsx or .csv first).'); }
  const names = new Set(list.entries.map((x) => x.name));
  if (!names.has('xl/workbook.xml')) throw new Error('This is not an Excel (.xlsx) workbook: xl/workbook.xml is missing.');
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
async function importWithEncoding(m) {
  const early = { cancelled: false, pre: true }; jobs.set(m.id, early);   // a cancel that arrives while the file is checked still counts
  try {
    for (let hop = 0; hop < 2 && m.file; hop++) {   // a .zip or .gz is unpacked first (a .gz inside a .zip too); an unpack error is reported, not imported as text
      if (isXlsx(m.file)) { const x = await xlsxToCsvFile(m.file, m.zipEntry); m = Object.assign({}, m, { file: x.file }); send('notice', m.id, { text: 'Read sheet "' + x.sheet + '" from the Excel workbook' + (x.sheets > 1 ? ' (' + x.sheets + ' sheets).' : '.') + (x.dropped ? ' ' + x.dropped + ' cells to the right of the header were left out.' : '') }); }
      else if (isZip(m.file)) { const z = await unzipFile(m.file, m.zipEntry); m = Object.assign({}, m, { file: z.file }); send('notice', m.id, { text: 'Opened ' + z.picked + ' from the zip file' + (z.entries.length > 1 ? ' (' + z.entries.length + ' files inside).' : '.') }); }
      else if (isGz(m.file)) { m = Object.assign({}, m, { file: await gunzipFile(m.file) }); send('notice', m.id, { text: 'This file was gzip-compressed, so it was unpacked first.' }); }
      else break;
    }
  } catch (err) { jobs.delete(m.id); return send('error', m.id, { message: String(err && err.message || err) }); }
  try { const u16 = m.file && m.file.size > 1 ? await sniffUtf16(m.file) : null; if (u16) { m = Object.assign({}, m, { file: await utf16ToUtf8File(m.file, u16) }); send('notice', m.id, { text: 'This file was UTF-16, so it was converted to UTF-8.' }); } else if (m.file && m.file.size && await notUtf8(m.file)) { m = Object.assign({}, m, { file: await toUtf8File(m.file) }); send('notice', m.id, { text: 'This file is not UTF-8, so it was read as Windows-1252.' }); } }
  catch { /* the normal import reports any real problem */ }
  return importFile(m);
}
const isNdjson = (f) => /\.(ndjson|jsonl|json)$/i.test(f.name || '');
// NDJSON: one JSON object per line is already the JSON-lines form LFC-pack packs, so the bytes go to the pack workers cut at line ends; the first 2000 lines give the column names and types.
// JSON objects to flat JSON lines (wasm, flat.c). Cuts each top-level object out of an array or a line stream, drops white space outside strings, and writes the members of a one-level nested object as dotted names ("trip":{"distance":1} becomes "trip.distance":1). Deeper nesting, a key over 1000 bytes or an object over 4 MB sets an error bit.
function flatTransform() {
  const bin = Uint8Array.from(atob('AGFzbQEAAAABDgNgAAF/YAF/AX9gAX8AAw0MAAABAAAAAAAAAgEBBAUBcAEBAQUEAQDAAgYRAn8BQZDCzAcLfwBBkMLMBwsHhAEOBm1lbW9yeQIABW5rZXlzAAAIa2V5c19wdHIAAQdrZXlfb2ZmAAIHYmlnbnVtcwADBmluX3B0cgAEB291dF9wdHIABQRyb3dzAAYGZXJyb3JzAAcIZmluaXNoZWQACAVyZXNldAAJBXNwbGl0AAoEc2NhbgALC19faGVhcF9iYXNlAwEKpTcMCwBBACgCgIiAgAALCABBkIiAgAALEQAgAEECdEGQiISAAGooAgALCwBBACgClJiEgAALCABBoJiEgAALCABBoJjEggALCwBBACgCoLjEhwALCwBBACgCpLjEhwALCwBBAC0AqLjEhwAL0AIBAX9BAEEANgKwuMSHAEEAQQA2Aqy4xIcAQQBBADYCtLjEhwBBAEEAOgCouMSHAEEAQQA6ALi4xIcAQQBBADoAvLjEhwBBAEEANgLAuMSHAEEAQQA2AsS4xIcAQQBBADYCyLjEhwBBAEEAOgDMuMSHAEEAQQA2AqS4xIcAQQBBADYCoLjEhwBBAEEAOgDQuMSHAEEAQQA6ANS4xIcAQQBBADYC2LjEhwBBAEEANgLcuMSHAEEAQQA2ApSYhIAAQQBBADoA4LjEhwBBACgC5LjEhwAhAUEAIAA2AoC5xIcAQQAgAUEBajYC5LjEhwBBAEEAKALouMSHAEEBajYC6LjEhwBBAEEANgKAiICAAEEAQQA2ApCIhIAAQQBBADoA7LjEhwBBAEEANgLwuMSHAEEAQQA2AvS4xIcAQQBBADoA+LjEhwBBAEEANgL8uMSHAAuXJgIlfwF+QQAhAUEAIQICQEEALQCouMSHAA0AAkACQEEAKAKwuMSHACIBDQBBACgCyLjEhwAhA0EALQDguMSHACEEDAELQaCYxIIAQQAoArS4xIcAIgVBoJjEggBqIAH8CgAAAkBBACgCyLjEhwAiA0UNAEEAQQAoAsS4xIcAIAVrNgLEuMSHAAtBACEEQQAtAOC4xIcARQ0AQQBBACgChLnEhwAgBWs2AoS5xIcAQQEhBAsCQAJAIAANAEEAIQIMAQtBACgC3LjEhwAhBkEALQDUuMSHACEHQQAtAMy5xIcAIQhBACgCyLnEhwAhCUEAKAKEucSHACEKQQAoApSYhIAAIQtBACgC2LjEhwAhDEEAKAKsuMSHACENQQAoAsC4xIcAIQ5BACgCxLjEhwAhD0EAKAL8uMSHACEQQQAtAPi4xIcAIRFBACgC9LjEhwAhEkEAKAKkuMSHACETQQAoAuS4xIcAIRRBACgCgIiAgAAhFUEAKALwuMSHACEWQQAtAOy4xIcAIRdBAC0AzLjEhwAhGEEALQC8uMSHACEZQQAoAqC4xIcAIRpBAC0AuLjEhwAhG0EALQDQuMSHACEcQQAhAkEAIQUDQAJAIAFBgcD/BEkNAEEAIBNBBHI2AqS4xIcADAILIAVBoJiEgABqLQAAIR0CQAJAAkACQAJAAkACQAJAAkAgBg0AIB1B/wFxIh1B+wBGDQFBACEGIB1B3QBHDQhBAEEBOgCouMSHAAwKCwJAIAdBAXFFDQAgAUGgmMSCAGogHToAACABQQFqIR4CQCAcQQFxRQ0AQQAhHEEAQQA6ANC4xIcADAgLAkAgHUH/AXEiHUEiRg0AAkAgHUHcAEYNAEEBIQdBACEcIB4hAQwKC0EBIRxBAEEBOgDQuMSHAAwIC0EAIRxBAEEAOgDUuMSHACAbQQFxRQ0GQQIhA0EAIRxBAEECNgLIuMSHAEEAIAEgD0F/c2ogDmsiDTYCrLjEhwBBAEEAOgC4uMSHAAwGCwJAIARBAXENACABIR4MBQsCQAJAIB1BUGpB/wFxQQpJDQAgHUH/AXEiBEFVaiIHQRpNDQEMAwtBASEEQQAhB0EAIAlBAWoiCTYCyLnEhwAgAUGgmMSCAGogHToAACABQQFqIQEMCAtBASAHdEGNgIAgcUUNAQwCC0EBIRhBACEZQQBBATYC3LjEhwBBAEEBOgDMuMSHAEEAIBRBAWoiFDYC5LjEhwAgAUGgmMSCAGpB+wA6AABBAEEANgL8uMSHAEEAQQA6APi4xIcAQQBBADYCyLjEhwBBAEEANgLYuMSHAEEAQQA6ALy4xIcAQQBBADYCwLjEhwBBAEEANgKUucSHACABQQFqIQFBACERQQAhEEEAIQ5BACEDQQAhDEEBIQYMBgsgBEHlAEYNAEEAQQA6AOC4xIcAIAggCUEPS3FBAUYNASABIR4MAgsgAUGgmMSCAGogHToAAEEAIQhBAEEAOgDMucSHAEEBIQQgAUEBaiEBQQAhBwwECyAKQaCYxIIAaiEHAkAgCUEQSw0AQTkhBAJAIAcgBy0AAEEtRmoiHy0AACIeQTlHDQBBMCEEIB8tAAEiHkEwRw0AQTAhBCAfLQACIh5BMEcNAEE3IQQgHy0AAyIeQTdHDQBBMSEEIB8tAAQiHkExRw0AQTkhBCAfLQAFIh5BOUcNAEE5IQQgHy0ABiIeQTlHDQBBMiEEIB8tAAciHkEyRw0AQTUhBCAfLQAIIh5BNUcNAEE0IQQgHy0ACSIeQTRHDQBBNyEEIB8tAAoiHkE3Rw0AQTQhBCAfLQALIh5BNEcNAEEwIQQgHy0ADCIeQTBHDQBBOSEEIB8tAA0iHkE5Rw0AQTkhBCAfLQAOIh5BOUcNAEExIQQgHy0ADyIeQTFHDQAgASEeDAILIB4gBEsNACABIR4MAQsgB0EBaiAHIAEgCmv8CgAAIAdBIjoAAEEAIAtBAWoiCzYClJiEgAAgAUGhmMSCAGpBIjoAACABQQJqIR4LQQAhBAJAAkAgHUH/AXEiH0F3aiIBQRdLDQBBASABdEGTgIAEcQ0BCwJAIAxFDQACQAJAIB9BIkcNAEEAQQE6ANS4xIcAIB5BoJjEggBqQSI6AAAMAQsgHkGgmMSCAGogHToAAAJAAkACQCAdQd8BcUGlf2oOAwADAQMLIAxBAWohDAwBCyAMQX9qIQwLQQAgDDYC2LjEhwALIB9BIkYhByAeQQFqIQEMBAsCQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkAgA0F+ag4CAQAFC0EAQQA2Asi4xIcAIB9B+wBGQQAoAoC5xIcAQQBHcSEgAkAgBkELSw0AICBFDQAgDSAOakEBakHpB08NACAWIQcMBAsCQCAQQf8DTQ0AIBYhBwwDCyAOIA1qISEgD0GhmMSCAGohIgJAIBEgECAST3JBAXENACAQQQJ0IgdBkOLEhwBqKAIAICFBAWpHDQBBACEBIAdBkPLGhwBqKAIAQZDyxIcAaiIjIQcgIiEEICEhAwJAA0ACQCABQQhqIgwgIU0NACABICFJDQIMBQsgIiABaiEkICMgAWohJSAHQQhqIQcgBEEIaiEEIANBeGohAyAMIQEgJSkAACAkKQAAUQ0ADAILCwNAIActAAAgBC0AAEcNASAHQQFqIQcgBEEBaiEEIANBf2oiA0UNAwwACwsCQCARQQFxDQBBAEEBOgD4uMSHACAQRQ0AQQAhEQNAAkACQCARQQJ0IgdBkOLEhwBqKAIAIgNBf2oiAQ0AQoOH9JyH9sOyFCEmDAELIAdBkPLGhwBqKAIAISQgAUEDcSEEAkACQCADQX5qQQNPDQBCg4f0nIf2w7IUISZBACEHDAELICRBkPLEhwBqIQMgAUF8cSEMQoOH9JyH9sOyFCEmQQAhBwNAICYgAyAHaiIBMQAAhUKzg4CAgCB+IAFBAWoxAACFQrODgICAIH4gAUECajEAAIVCs4OAgIAgfiABQQNqMQAAhUKzg4CAgCB+ISYgDCAHQQRqIgdHDQALCyAERQ0AIAcgJGpBkPLEhwBqIQEDQCAmIAExAACFQrODgICAIH4hJiABQQFqIQEgBEF/aiIEDQALCwJAAkAgJkIgiCAmhadB/wdxIgFBAnRBkILHhwBqIgcoAgAgFEcNAANAAkAgAUEDdEGQoseHAGopAwAgJlINAEEAIBNBCHIiEzYCpLjEhwAMAwsgAUEBakH/B3EiAUECdEGQgseHAGoiBygCACAURg0ACwsgByAUNgIAIAFBA3RBkKLHhwBqICY3AwALIBFBAWoiESAQRw0ACwsCQAJAICENAEKDh/Sch/bDshQhJgwBCyAhQQNxIQQCQAJAICFBf2pBA08NAEKDh/Sch/bDshQhJkEAIQcMAQsgD0GgmMSCAGohAyAhQXxxIQxCg4f0nIf2w7IUISZBACEHA0AgJiADIAdqIgFBAWoxAACFQrODgICAIH4gAUECajEAAIVCs4OAgIAgfiABQQNqMQAAhUKzg4CAgCB+IAFBBGoxAACFQrODgICAIH4hJiAMIAdBBGoiB0cNAAsLIARFDQAgDyAHakGhmMSCAGohAQNAICYgATEAAIVCs4OAgIAgfiEmIAFBAWohASAEQX9qIgQNAAsLICZCIIggJoWnQf8HcSIEIQECQAJAIARBAnQiA0GQgseHAGoiBygCACAURw0AIAQhAQNAAkAgAUEDdEGQoseHAGopAwAgJlINAEEAIBNBCHIiEzYCpLjEhwAMAwsgAUEBakH/B3EiAUECdEGQgseHAGoiBygCACAURg0ACwsgByAUNgIAIAFBA3RBkKLHhwBqICY3AwALAkAgFUH/A0sNACAVQQJ0QZCIhIAAaigCACIRICFqIgxB//8DSw0AAkAgA0GQ4seHAGoiASgCAEEAKALouMSHACIHRw0AA0AgBEEDdEGQgsiHAGopAwAgJlENAiAEQQFqQf8HcSIEQQJ0QZDix4cAaiIBKAIAIAdGDQALCyABIAc2AgAgBEEDdEGQgsiHAGogJjcDAAJAICFFDQAgEUGQiICAAGogIiAh/AoAAAtBACAVQQFqIhU2AoCIgIAAIBVBAnRBkIiEgABqIAw2AgALAkAgFiAhaiIHQYCAAksNAAJAICFFDQAgFkGQ8sSHAGogIiAh/AoAAAtBACAHNgLwuMSHAEEBIREgEEECdCIBQZDixIcAaiAhQQFqNgIAIAFBkPLGhwBqIBY2AgAMAwtBASEXQQBBAToA7LjEhwAgEEECdEGQ4sSHAGpBADYCACAWIQdBASERDAILAkAgH0E6Rg0AQQAhDEECIQNBACEEDBQLQQMhA0EAIQxBAEEDNgLIuMSHACAeQaCYxIIAakE6OgAAIB5BAWohAQwSCyAWIQdBACERC0EAIBBBAWoiEDYC/LjEhwALQQAhAyAgDQEgByEWCyAfQV5qDhkCCQkJCQkJCQkJBAkJCQkJCQkJCQkJCQkGAQsCQCAGQQxJDQBBASEMQQAhA0EAQQE2Ati4xIcAQQAgE0EBciITNgKkuMSHACAeQaCYxIIAakH7ADoAAAwNCwJAIA4gDWoiAUGYeGpBlnhLDQBBASEMQQAhA0EAQQE2Ati4xIcAQQAgE0ECciITNgKkuMSHACAeQaCYxIIAakH7ADoAAAwNCyAGQQJ0Ih1B0LnEhwBqIA42AgACQCANRQ0AIA5BkLrEhwBqIA8gDmpBoZjEggBqIA38CgAAC0EBIRhBACEZQQBBAToAzLjEhwAgAUGQusSHAGpBLjoAAEEAIAFBAWoiDjYCwLjEhwBBACAGQQFqIgY2Aty4xIcAIAZBAnRBkLnEhwBqQQA2AgAgHUGQucSHAGoiASABKAIAQX9qNgIAQQBBADoAvLjEhwAgByEWQQAhA0EAIQxBACEEQQAhByAPIQEMEQsgH0GFf2oOAwEHAwYLAkAgGEEBcUUNAEEAIB42AsS4xIcAQQBBAToAuLjEhwAgHkGgmMSCAGpBIjoAACAGQQJ0QZC5xIcAaiIBIAEoAgBBAWo2AgBBAEEAOgC8uMSHAEEAQQA6AMy4xIcAIB5BAWohAQJAIA5FDQAgHkGhmMSCAGpBkLrEhwAgDvwKAAAgASAOaiEBC0EBIRtBACEZQQBBATYCyLjEhwBBAEEBOgDUuMSHAEEAIRggHiEPQQEhA0EAIQxBACEEQQEhBwwQC0EBIQdBACEYQQBBAToA1LjEhwAgHkGgmMSCAGpBIjoAACAeQQFqIQFBACEMQQAhBAwPC0EBIQxBACEEQQBBATYC2LjEhwAgHkGgmMSCAGpB+wA6AAAMCAsCQAJAIBlBAXFFDQBBAEEAOgC8uMSHACAeIQEMAQsgHkGgmMSCAGpBLDoAACAeQQFqIQELQQEhGEEAIRlBAEEBOgDMuMSHAEEAQQA2Asi4xIcAQQAhAwwCCwJAIAZBAUYNAAJAAkAgBkECdEGQucSHAGooAgAiHQ0AQQBBAToAvLjEhwAgBkF/aiEGIB4hAQwBCwJAAkAgGSAeQQBHcUEBRg0AIB4hAQwBCyAeQX9qIB4gHkGfmMSCAGotAABBLEYbIQELIAZBf2oiBkECdEGQucSHAGoiByAHKAIAIB1qNgIAQQBBADoAvLjEhwALIB1FIRlBACEYQQAgBjYC3LjEhwBBACAGQQJ0QdC5xIcAaigCACIONgLAuMSHAEEAQQA6AMy4xIcADAILAkACQCAZQQFxDQAgHiEBDAELQQAhAUEAQQA6ALy4xIcAIB5FDQAgHkF/aiAeIB5Bn5jEggBqLQAAQSxGGyEBCyABQaGYxIIAakEKOgAAIAFBoJjEggBqQf0AOgAAQQAhGUEAIBpBAWoiGjYCoLjEhwBBACAQQYAEIBBBgARJGyISNgL0uMSHAEEAQQA2Aty4xIcAIAFBAmohAgJAIBcgFkGAgAFLckEBcQ0AQQAhFwwFC0EAIRlBAEEANgLwuMSHAEEAQQA2AvS4xIcAQQBBADoA7LjEhwBBACEXQQAhFkEAIRIMBAsgHkGgmMSCAGpBOjoAACAeQQFqIQELQQAhDAwGCyAfQdsARg0CC0EAIQwCQAJAIBhBAXFFDQBBACEEDAELAkAgH0EtRg0AQQAhBCAdQVBqQf8BcUEJSw0BC0EAIB42AoS5xIcAQQEhCEEAQQE6AOC4xIcAQQBBAToAzLnEhwBBACAfQS1HIgk2Asi5xIcAIB4hCkEBIQQLIB5BoJjEggBqIB06AAAgHkEBaiEBQQAhBwwIC0EAIQxBACEEQQAhB0EAIQYgAiEBDAcLQQEhDEEAIQRBAEEBNgLYuMSHACAeQaCYxIIAakHbADoAAAsgHiAMaiEBQQAhBwwFCyAeIAxqIQEgByEWC0EAIQRBACEHDAMLQQAhByAeIQEMAgtBACEbQQAhByAeIQEMAQtBASEHIB4hAQsgBUEBaiIFIABHDQALC0EAIAI2ArS4xIcAIAEgAmshAQtBACABNgKwuMSHACACC84NBA5/AXsHfwF+QQAhAUEAQQAoAui4xIcAQQFqIgI2Aui4xIcAQQBBADYCgIiAgABBAEEANgKQiISAAEEAQQA2AvS4xIcAQQBBADYC/LjEhwACQCAARQ0AQQAhA0EAIQRBACEFQQAhBkEAIQFBACEHQQAhCEEAIQlBACEKQQAhCwNAAkACQAJAIAdBoJiEgABqIgwtAAAiDUEiRw0AQQEgASAGQQ9LGyABIAUbIAEgBBshASAHQQFqIQQCQCADQQFHDQACQCAIQf8BcSINQfsARg0AIA1BLEcNAQsgBCEOA0ACQAJAIA4iDUEQaiIOIABNDQACQCANIABPDQADQCANQaCYhIAAai0AACIOQSJGDQMgDkHcAEYNAyAAIA1BAWoiDUcNAAsLIAAhDQwFCyANQaCYhIAAav0AAAAiD/0MIiIiIiIiIiIiIiIiIiIiIv0jIA/9DFxcXFxcXFxcXFxcXFxcXFz9I/1Q/WQiCEUNASAIaCANaiINQaCYhIAAai0AACEOCyAOQf8BcUEiRg0DIA1BAmohDgwACwsDQAJAAkACQCAEIg1BEGoiBCAATQ0AQQAhBEEiIQggDSAASQ0BIAAhDQwGCyANQaCYhIAAav0AAAAiD/0MIiIiIiIiIiIiIiIiIiIiIv0jIA/9DFxcXFxcXFxcXFxcXFxcXFz9I/1Q/WQiDkUNAiAOaCANaiINQaCYhIAAai0AACEODAELA0AgDUGgmISAAGotAAAiDkEiRg0BIA5B3ABGDQEgACANQQFqIg1HDQALIAAhDQwEC0EiIQgCQCAOQf8BcUEiRg0AIA1BAmohBAwBCwtBACEEDAILAkACQAJAAkAgDUFQakH/AXFBCUsNAAJAIAQNAEEAIQVBASEGIAhB/wFxIgRBVWoiDkEaSw0DQQEgDnRBiYCAIHFFDQMMBAtBASEEIAZBAWohBgwBCwJAIARFDQBBASABIA1B3wFxQcUARxsgASANQS5HGyABIAZBD0sbIAEgBRshAQtBACEEAkAgDUF3aiIOQRdLDQBBASAOdEGTgIAEcUUNACAHIQ0MBQsCQCANQd8BcSIOQdsARw0AAkAgA0UNACADQQFqIQMMAgtBACEJQQBBADYC/LjEhwBBASEDIA0hCCAHIQ1BACEEDAULIA5B3QBHDQAgA0UNACADQX9qIgMNAEEAIQRBACAJQYAEIAlBgARJGyIKNgL0uMSHACANIQggByENQQAhAwwECyANIQggByENDAMLIARB5QBGDQBBASEGIA0hCCAHIQ1BASEFQQEhBAwCCyANIQggByENQQEhBAwBCyANIARrIRACQAJAIAlB/wNLIhENACAJIApPDQAgCUECdCIIQZDCxIcAaigCACAQRw0AIARBoJiEgABqIRJBACEOIAhBkNLEhwBqKAIAQaCYhIAAaiITIQggBCEDAkADQAJAIA5BCGoiFCAQTQ0AIA4gEEkNAgwECyASIA5qIRUgEyAOaiEWIAhBCGohCCADQQhqIQMgFCEOIBYpAAAgFSkAAFENAAwCCwsDQCAILQAAIANBoJiEgABqLQAARw0BIAhBAWohCCANIANBAWoiA0YNAgwACwtCg4f0nIf2w7IUIRcCQCANIARGIhUNACAQQQNxIQMCQAJAIA0gB2tBfmpBA08NAEKDh/Sch/bDshQhF0EAIQgMAQsgEEF8cSEUQoOH9JyH9sOyFCEXQQAhCANAIBcgDCAIaiIOQQFqMQAAhUKzg4CAgCB+IA5BAmoxAACFQrODgICAIH4gDkEDajEAAIVCs4OAgIAgfiAOQQRqMQAAhUKzg4CAgCB+IRcgFCAIQQRqIghHDQALCyADRQ0AIAcgCGpBoZiEgABqIQ4DQCAXIA4xAACFQrODgICAIH4hFyAOQQFqIQ4gA0F/aiIDDQALCwJAIAtB/wNLDQAgC0ECdEGQiISAAGooAgAiByAQaiIDQf//A0sNAAJAIBdCIIggF4WnQf8HcSIOQQJ0QZDix4cAaiIIKAIAIAJHDQADQCAOQQN0QZCCyIcAaikDACAXUQ0CIA5BAWpB/wdxIg5BAnRBkOLHhwBqIggoAgAgAkYNAAsLIAggAjYCACAOQQN0QZCCyIcAaiAXNwMAAkAgFQ0AIAdBkIiAgABqIARBoJiEgABqIBD8CgAAC0EAIAtBAWoiCzYCgIiAgAAgC0ECdEGQiISAAGogAzYCAAsgEQ0AIAlBAnQiDkGQwsSHAGogEDYCACAOQZDSxIcAaiAENgIAC0EBIQNBACEEQQAgCUEBaiIJNgL8uMSHAEEiIQgLIA1BAWoiByAASQ0ACwsgAQsAiQEEbmFtZQALCmZsYXQ0Lndhc20BYQwABW5rZXlzAQhrZXlzX3B0cgIHa2V5X29mZgMHYmlnbnVtcwQGaW5fcHRyBQdvdXRfcHRyBgRyb3dzBwZlcnJvcnMICGZpbmlzaGVkCQVyZXNldAoFc3BsaXQLBHNjYW4HEgEAD19fc3RhY2tfcG9pbnRlcgA4CXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQxVYnVudHUgY2xhbmcRMTguMS4zICgxdWJ1bnR1MSkAQg90YXJnZXRfZmVhdHVyZXMEKwtidWxrLW1lbW9yeSsPbXV0YWJsZS1nbG9iYWxzKwhzaWduLWV4dCsHc2ltZDEyOA=='), (c) => c.charCodeAt(0)), X = new WebAssembly.Instance(new WebAssembly.Module(bin), {}).exports; X.reset(1);
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
  const r = await importFile0(m);
  if (r && r.enc) { try { m = Object.assign({}, m, { file: await toUtf8File(m.file), reencoded: true }); } catch (err) { return send('error', m.id, { message: String(err && err.message || err) }); } send('notice', m.id, { text: 'This file is not UTF-8, so it was read as Windows-1252.' }); return importFile0(m); }
}
async function importFile0(m) {
  if (m.file && isNdjson(m.file)) m = Object.assign({}, m, { ndjson: true, untyped: true, noColumns: true });
  const demote = new Set(); let mm = m;
  for (let tries = 0; tries < 4; tries++) {
    const r = await importOnce(mm); if (!r) return; if (r.enc) return r;
    if (r === 'mixed' || tries === 3) break;
    demote.add(r.col); mm = Object.assign({}, m, { demote: [...demote] });
  }
  const r2 = await importOnce(Object.assign({}, m, { noColumns: true })); if (r2 && r2.enc) return r2;
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
    const meta = { producer: 'LFCFoundry Workbench', producerVersion: '0.2.0', sourceFormat: delimiter === '\t' ? 'tsv' : 'csv', sourceName: String(file.name).slice(0, 200), sourceBytes: file.size, tables: [{ name: 'rows', rows: 0, columns: [] }] };
    let packer = LfcPack.packStream(Object.assign({ level: m.level || 3 }, { blockBytes: m.blockBytes || 2097152, share: true, meta }));
    let outBytes = 0;
    const write = async (parts) => { for (const p of parts) { stop(job); const s = performance.now(); await writable.write(p); t.writeMs += performance.now() - s; outBytes += p.byteLength; } };
    let inlScan = null, packBytes = async (bytes) => { stop(job); const s = performance.now(); if (t.scanPack && !t.flatPack) { inlScan ||= flatTransform(); const sc = inlScan.scan(bytes); for (const k of sc.keys) (t.keys ||= new Set()).add(k); if (sc.maybeBig) { inlScan.reset(0); const tb = inlScan(bytes), bg = inlScan.big(); if (bg) { t.big = (t.big || 0) + bg; bytes = tb; } } } const parts = packer.push(bytes); t.packMs += performance.now() - s; await write(parts); };
    let dkBlocks = null;
    let finishPacking = async () => {}, col = null, colFlush = async () => {}, liveChunks = null, morePack = null;
    const packWorkers = m.packWorkers != null ? m.packWorkers : (m.live === true && file.size <= LIVE_MAX && columnsOk(m) ? 1 : 2);   // live columns: Firefox packs with one worker while parsing (the cores go to the parse helpers) and gets three more when parsing is done; Chromium also packs with one while parsing and gets one more (measured: each is the best of the variants in its browser)   // measured faster in Firefox, WebKitGTK and Chromium together with the byte-level parser
    let pws = null;   // pack threads; some pages (a downloaded file on Chrome) cannot start a worker from inside a worker, then packing stays on this thread
    dropKeep(); if (packWorkers > 0 && useSegments(m, file)) { try { pws = []; for (let i = 0; i < packWorkers; i++) pws.push(mkWorker()); } catch { if (pws) pws.forEach((w) => w.terminate()); pws = null; } }
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
      const dispatch = (chunk) => send1({ type: 'packBlock', c: chunk, o: popts, flat: t.flatPack ? 1 : t.scanPack ? 2 : 0, chk: t.chk }, [chunk.buffer]);
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
        keepWorkers(ws);
      };
      var packWorkersToStop = ws;
    }
    let plan = m.untyped ? null : await samplePlan(file, delimiter); if (plan && m.demote) { plan = plan.map((x, c) => (m.demote.includes(c) ? false : x)); if (!plan.some(Boolean)) plan = null; } const dictPlan = !m.untyped && m.dict !== false ? samplePlan.dict || null : null;
    let res = null;
    if (!m.ndjson && useSegments(m, file)) res = await runSegmented(file, delimiter, job, packBytes, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t, m.segBytes || SEG_BYTES, plan, col, col ? dictPlan : null);
    if (!res && !m.ndjson) try { helper = m.inline ? null : mkWorker(); } catch { helper = null; }
    if (m.ndjson) { res = await parseNdjson(file, () => stop(job), packBytes, (bytes, rows) => send('progress', m.id, { bytes, total: file.size, rows }), t); } else if (res) { /* parsed in pieces */ } else if (helper) {   // parse on the helper, pack and write here: both run at once
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
    if (view && view.live && view.name === name) { try { const f2 = await store.file(name), R2 = await LfcPack.open(f2); Object.assign(view, { dictCols: keptDict.get(name) || null, R: R2, f: f2, flat: R2.blocks.length > 0 && R2.blocks.every((b) => b.kind === 'f' && !b.table), live: null }); liveChunks = null; textFromChunks(view); } catch { /* keep reading the kept columns */ } }   // the saved file takes over from the kept columns (same rows, same order)
    send('done', m.id, { dataset: { name, source: file.name, rows, bytes: outBytes, storage: STORAGE, delimiter: delimiter === '\t' ? 'TAB' : delimiter, columns: cols, sample, validation: v, ms: Math.round(performance.now() - t0), timing: { readMs: Math.round(t.readMs), parseMs: Math.round(t.parseMs), packMs: Math.round(t.packMs), writeMs: Math.round(t.writeMs), pieces: (res && res.pieces) || 0, redos: t.redos || 0, fastRows: t.fastRows || 0, columns: !!t.cols }, plan: plan ? plan.map(Boolean) : null, parallel: !!helper || !!(res && res.pieces), segmented: !!(res && res.pieces), serialTail: !!t.serialTail, redos: t.redos || 0, segWhy: t.segWhy } });
  } catch (err) {
    if (view && (view.live || view.preview) && view.name === name) { view = null; send('liveclosed', m.id, {}); }
    if (writable && !closed) { try { await writable.abort(); } catch {} }
    if (name) await store.remove(name);
    if (err && err.mixed && !m.noColumns) restart = err.col != null && err.col >= 0 ? { col: err.col } : true;
    else if (!m.reencoded && !m.ndjson && /TextDecoder/.test(String(err && err.message)) && /not valid|decoding failed/i.test(String(err && err.message))) restart = { enc: true };   // a Windows-1252 byte past the sampled start: read the file again as Windows-1252 (valid UTF-8 files never pay for a whole-file check)
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
