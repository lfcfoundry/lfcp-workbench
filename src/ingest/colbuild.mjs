// WebAssembly column builder (wasm/colbuild.c): the fast version of buildColumns in columns.mjs. Same chunks, same bail rules.
// make(wasmBytes, headers, plan, delimiter, { capRows, chunkBytes }) -> { build(bytes) } where build returns { n, used, bail, cols } like buildColumns
// (bail 'line' = JavaScript must handle the next line, 'mixed' = a number column holds a text-like cell). Memory is reused between calls: the returned columns are copies.
export async function make(wasmBytes, headers, plan, delimiter, opts = {}) {
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  return placeColumns(instance.exports, headers, plan, delimiter, opts);
}
// The same on an instance that already exists (the import workers make theirs synchronously). grab(rows) copies the chunk's columns out, by column index.
const DCAPB = 262144;   // bytes of distinct values per dictionary column per chunk
export function placeColumns(X, headers, plan, delimiter, opts = {}) {
  const n = headers.length;
  const capRows = opts.capRows || 65536, CH = opts.chunkBytes || 2097152, TC = opts.textCap && X.set_tcap ? Math.min(CH, opts.textCap) : 0;   // textCap: a smaller text area per column (wide tables); the builder ends a chunk when one fills
  if (X.set_tcap) X.set_tcap(TC);
  let p = (X.__heap_base.value + 15) & ~15; const IN = p; p += CH + 64;
  const kinds = headers.map((_, c) => (plan && plan[c] === true ? 1 : plan && plan[c] === 'f' ? 3 : plan && typeof plan[c] === 'number' && plan[c] > 0 ? 16 + plan[c] : 0)), pls = [];
  const need = (z) => { const a = p; p = (p + z + 15) & ~15; return a; };
  const enc = new TextEncoder(), kp = X.keys_ptr(); let koff = 0;
  for (let c = 0; c < n; c++) {
    const k = enc.encode(JSON.stringify(headers[c]) + ':'); new Uint8Array(X.memory.buffer, kp + koff, k.length).set(k);
    const pl = { kind: kinds[c], a: 0, b: 0, t: 0 };
    if (kinds[c] === 0) { pl.a = need(capRows * 4); pl.b = need(capRows * 4); pl.t = need((TC || CH) + 64); } else pl.a = need(capRows * 8);
    if (X.set_dict) X.set_dict(c, 0);
    if (kinds[c] === 0 && opts.dict && opts.dict[c] && X.set_dict) {   // dictionary column: one u16 code per row (in the start area) plus the distinct values of the chunk; stops with bail 'dict' past 4096 labels
      pl.dict = { bytes: need(DCAPB), start: need(4096 * 4), end: need(4096 * 4) }; X.set_dict_out(c, pl.dict.bytes, DCAPB, pl.dict.start, pl.dict.end); X.set_dict(c, 1); pl.on = true;
    }
    pls.push(pl); X.set_col(c, koff, k.length, kinds[c], 255); X.set_out(c, pl.a, pl.b, pl.t); koff += k.length;
  }
  X.setup(n, delimiter.charCodeAt(0), 0);
  const mem = () => X.memory.buffer;
  if (p > mem().byteLength) X.memory.grow(Math.ceil((p - mem().byteLength) / 65536));
  return {
    flagsPtr: X.flags_ptr(), memory: X.memory, exports: X, IN, CH, mem: () => new Uint8Array(mem()),
    // Wide tables (40 or more columns): the whole chunk is copied into ONE buffer and the columns are views of it. A chunk of 700 columns as 2,000 small buffers costs more to make, copy and post than the parsing itself.
    grabSlab(rows) {
      const al = (z) => (z + 7) & ~7, m8 = new Uint8Array(mem()); let tot = 0; const meta = new Array(n);
      for (let c = 0; c < n; c++) { const pl = pls[c]; if (pl.kind) { meta[c] = null; tot += rows * 8; } else if (pl.on) { const nl = X.dict_n(c), bl = X.dict_blen(c); meta[c] = [nl, bl]; tot += al(rows * 2) + al(bl) + 2 * al(nl * 4); } else { const tl = X.tlen(c); meta[c] = [tl]; tot += al(tl) + al((rows + 1) * 4); } }
      const slab = new ArrayBuffer(tot), s8 = new Uint8Array(slab), out = new Array(n); let o = 0;
      const cp = (ptr, len) => { const at = o; if (len) s8.set(m8.subarray(ptr, ptr + len), at); o += al(len); return at; };
      for (let c = 0; c < n; c++) {
        const pl = pls[c], mt = meta[c];
        if (pl.kind) out[c] = new Float64Array(slab, cp(pl.a, rows * 8), rows);
        else if (pl.on) { const codes = new Uint16Array(slab, cp(pl.a, rows * 2), rows), bytes = new Uint8Array(slab, cp(pl.dict.bytes, mt[1]), mt[1]), start = new Uint32Array(slab, cp(pl.dict.start, mt[0] * 4), mt[0]), end = new Uint32Array(slab, cp(pl.dict.end, mt[0] * 4), mt[0]); out[c] = { codes, lb: { bytes, start, end } }; }
        else { const bytes = new Uint8Array(slab, cp(pl.t, mt[0]), mt[0]), at = cp(pl.a, rows * 4), off = new Int32Array(slab, at, rows + 1); o = at + al((rows + 1) * 4); off[rows] = mt[0]; out[c] = { bytes, start: off.subarray(0, rows), end: off.subarray(1, rows + 1) }; }
      }
      out.slab = slab; return out;
    },
    grab(rows) {
      if (n >= 40 && opts.slab !== false) return this.grabSlab(rows);
      const out = [];
      for (let c = 0; c < n; c++) {
        const pl = pls[c];
        if (pl.kind) out.push(new Float64Array(mem(), pl.a, rows).slice());
        else if (pl.on) { const nl = X.dict_n(c); out.push({ codes: new Uint16Array(mem(), pl.a, rows).slice(), lb: { bytes: new Uint8Array(mem(), pl.dict.bytes, X.dict_blen(c)).slice(), start: new Uint32Array(mem(), pl.dict.start, nl).slice(), end: new Uint32Array(mem(), pl.dict.end, nl).slice() } }); }
        else { const tl = X.tlen(c), off = new Int32Array(rows + 1); off.set(new Int32Array(mem(), pl.a, rows)); off[rows] = tl; out.push({ bytes: new Uint8Array(mem(), pl.t, tl).slice(), start: off.subarray(0, rows), end: off.subarray(1, rows + 1) }); }   // cells are written one after another, so each cell ends where the next starts: one offsets array serves as both (half the memory)
      }
      return out;
    },
    build(bytes) {
      if (bytes.length > CH) throw new Error('colbuild: chunk larger than ' + CH);
      new Uint8Array(mem(), IN, bytes.length).set(bytes); X.reset_text(); for (let c = 0; c < n; c++) if (pls[c].on) X.dict_reset(c);
      const used = X.build(IN, bytes.length, capRows), rows = X.rows(), b = X.bail(), cols = {}, g = this.grab(rows);
      for (let c = 0; c < n; c++) cols[headers[c]] = g[c];
      return { n: rows, used, stray: X.stray ? X.stray() : 0, bail: b === 2 ? 'mixed' : b === 1 ? 'line' : b === 4 ? 'dict' : null, bailcol: b === 4 ? X.bailcol() : -1, cols, arr: g };
    },
    undict(c) { const pl = pls[c]; if (pl.on) { pl.on = false; X.set_dict(c, 0); X.set_out(c, pl.a, pl.b, pl.t); } },   // this column is text from now on (more than 4096 distinct values in a chunk)
    isDict(c) { return !!pls[c].on; },
  };
}
