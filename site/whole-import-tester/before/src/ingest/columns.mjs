// Staged columns: turns whole plain CSV lines straight into typed column chunks (no JSON text), for LFC-pack's packBlock(columns).
// This is the plain-JavaScript reference: it defines what the WebAssembly column builder (next step) must produce, and it is the fallback when WebAssembly is not available.
//
// A chunk is { n, used, cols } where cols[name] is
//   - a Float64Array for a whole-number column (plan true) or a decimal column (plan d: the value scaled by 10^d), NaN for an empty cell, or
//   - { bytes, start, end } for a text column: the chunk's own bytes and one Int32Array offset pair per value (the caller makes no JS strings).
// Same stored values as the JSON-lines builders in app/worker.js (typedCell / typedDecimal rules); empty text cells stay "" and empty number cells are empty.
// A cell that stays text in a number column (for example "007" in an integer column) cannot live in a Float64Array: the chunk reports bail = 'mixed' and the caller
// uses the JSON-lines path for the file. A line that is not plain (quote, backslash, control or non-ASCII byte, wrong field count) stops the chunk at that line (bail = 'line').
//
// CREDITS: handing typed columns to a column store without building row text first is how Apache Arrow and DuckDB's CSV reader work (https://arrow.apache.org/ , https://duckdb.org/);
// the offset-pair text layout is Arrow's "variable-size binary" idea. Our code, no code copied. See docs/CREDITS.md.
import { typedCell, typedDecimal } from './infer.mjs';
const dec = new TextDecoder('latin1');
export function buildColumns(bytes, headers, plan, delimiter) {
  const D = delimiter.charCodeAt(0), n = headers.length, len = bytes.length;
  const starts = [], ends = [];   // per line: field offsets
  let i = 0, rows = 0, bail = null, used = 0;
  const fs = new Int32Array(n), fe = new Int32Array(n);
  const sCols = headers.map(() => []), eCols = headers.map(() => []);
  scan: while (i < len) {
    let col = 0, p = i, e = -1; fs[0] = i;
    for (; p < len; p++) {
      const c = bytes[p];
      if (c === D) { if (col + 1 >= n) { bail = 'line'; break scan; } fe[col] = p; col++; fs[col] = p + 1; }
      else if (c === 10) { e = p; break; }
      else if (c === 34 || c === 92 || c < 32 || c > 126) { bail = 'line'; break scan; }   // 13 (carriage return) is handled below
    }
    if (e < 0) break;   // no line end yet: the rest waits for more bytes
    let end = e; if (end > i && bytes[end - 1] === 13) end--;
    if (col !== n - 1 || end === i) { bail = 'line'; break; }
    fe[n - 1] = end;
    for (let c = 0; c < n; c++) { sCols[c].push(fs[c]); eCols[c].push(fe[c]); }
    rows++; i = e + 1; used = i;
  }
  const cols = {};
  for (let c = 0; c < n; c++) {
    const kind = plan && plan[c] === true ? 1 : plan && typeof plan[c] === 'number' && plan[c] > 0 ? plan[c] : 0;
    if (!kind) { cols[headers[c]] = { bytes, start: Int32Array.from(sCols[c]), end: Int32Array.from(eCols[c]) }; continue; }
    const out = new Float64Array(rows);
    for (let r = 0; r < rows; r++) {
      const s = dec.decode(bytes.subarray(sCols[c][r], eCols[c][r])), v = kind === 1 ? typedCell(s) : typedDecimal(s, kind);
      if (v === null) out[r] = NaN; else if (typeof v === 'number') out[r] = v; else { bail = 'mixed'; return { n: 0, used: 0, cols: {}, bail }; }
    }
    cols[headers[c]] = out;
  }
  return { n: rows, used, cols, bail };
}
