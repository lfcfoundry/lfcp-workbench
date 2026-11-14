// WebAssembly column builder (wasm/colbuild.c): the fast version of buildColumns in columns.mjs. Same chunks, same bail rules.
// make(wasmBytes, headers, plan, delimiter, { capRows, chunkBytes }) -> { build(bytes) } where build returns { n, used, bail, cols } like buildColumns
// (bail 'line' = JavaScript must handle the next line, 'mixed' = a number column holds a text-like cell). Memory is reused between calls: the returned columns are copies.
export async function make(wasmBytes, headers, plan, delimiter, opts = {}) {
  const { instance } = await WebAssembly.instantiate(wasmBytes), X = instance.exports, n = headers.length;
  const capRows = opts.capRows || 65536, CH = opts.chunkBytes || 2097152;
  let p = (X.__heap_base.value + 15) & ~15; const IN = p; p += CH + 64;
  const kinds = headers.map((_, c) => (plan && plan[c] === true ? 1 : plan && typeof plan[c] === 'number' && plan[c] > 0 ? 16 + plan[c] : 0)), place = [];
  const need = (z) => { const a = p; p = (p + z + 15) & ~15; return a; };
  const enc = new TextEncoder(), kp = X.keys_ptr(); let koff = 0;
  for (let c = 0; c < n; c++) {
    const k = enc.encode(JSON.stringify(headers[c]) + ':'); new Uint8Array(X.memory.buffer, kp + koff, k.length).set(k);
    const pl = { kind: kinds[c], a: 0, b: 0, t: 0 };
    if (kinds[c] === 0) { pl.a = need(capRows * 4); pl.b = need(capRows * 4); pl.t = need(CH + 64); } else pl.a = need(capRows * 8);
    place.push(pl); X.set_col(c, koff, k.length, kinds[c], 255); X.set_out(c, pl.a, pl.b, pl.t); koff += k.length;
  }
  X.setup(n, delimiter.charCodeAt(0), 0);
  const mem = () => X.memory.buffer;
  if (p > mem().byteLength) X.memory.grow(Math.ceil((p - mem().byteLength) / 65536));
  return {
    flagsPtr: X.flags_ptr(), memory: X.memory, exports: X,
    build(bytes) {
      if (bytes.length > CH) throw new Error('colbuild: chunk larger than ' + CH);
      new Uint8Array(mem(), IN, bytes.length).set(bytes); X.reset_text();
      const used = X.build(IN, bytes.length, capRows), rows = X.rows(), b = X.bail(), cols = {};
      for (let c = 0; c < n; c++) {
        const pl = place[c];
        if (pl.kind) cols[headers[c]] = new Float64Array(mem(), pl.a, rows).slice();
        else { const tl = X.tlen(c); cols[headers[c]] = { bytes: new Uint8Array(mem(), pl.t, tl).slice(), start: new Int32Array(mem(), pl.a, rows).slice(), end: new Int32Array(mem(), pl.b, rows).slice() }; }
      }
      return { n: rows, used, bail: b === 2 ? 'mixed' : b === 1 ? 'line' : null, cols };
    },
  };
}
