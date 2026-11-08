// Same filter and sort as query.mjs (runQuery), but over whole columns instead of row objects:
// cols = { columnName: array of cell values, one entry per row }, n = row count.
// Returns the same {indices, errors}. Used when only the filtered or sorted columns were decoded from the dataset
// (LfcPack.unpackColumns), which skips making a row object per row and decoding the other columns.
import { parseFilter, matches, sortKeyFor } from './query.mjs';

export function runColumnQuery(cols, n, columns, { filters = {}, sort = null } = {}) {
  const errors = {}, active = [];
  for (const c of columns) {
    const text = filters[c.name]; if (!text) continue;
    const { filter, error } = parseFilter(text, c.type);
    if (error) errors[c.name] = error; else if (filter) active.push([cols[c.name], filter]);
  }
  let idx;
  if (!active.length) { idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; }
  else {
    // the first filter scans every row; later filters scan only the survivors
    const [col0, f0] = active[0], first = []; for (let i = 0; i < n; i++) if (matches(f0, col0[i])) first.push(i);
    idx = Uint32Array.from(first);
    for (let a = 1; a < active.length && idx.length; a++) { const [col, f] = active[a]; let m = 0; for (let k = 0; k < idx.length; k++) if (matches(f, col[idx[k]])) idx[m++] = idx[k]; idx = idx.subarray(0, m); }
  }
  if (sort && sort.col && cols[sort.col]) {
    const col = columns.find((c) => c.name === sort.col), src = cols[sort.col], key = sortKeyFor(col ? col.type : 'string'), sign = sort.dir === 'desc' ? -1 : 1;
    const text = !col || !(col.type === 'integer' || col.type === 'number' || col.type === 'date');
    // rank 0 normal, 1 not a number, 2 empty: empties sort last, then unparsable values, ties keep file order
    if (!text) { idx = radixSortNumbers(idx, src, key, sign); return { indices: idx, errors }; }
    const rank = new Uint8Array(n), num = text ? null : new Float64Array(n), str = text ? new Array(n) : null;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], v = src[i];
      if (v == null || v === '') { rank[i] = 2; continue; }
      if (text) str[i] = String(v); else { const x = key(v); if (x !== x) rank[i] = 1; else num[i] = x; }
    }
    const arr = Array.from(idx);
    arr.sort(text
      ? (a, b) => { const ra = rank[a], rb = rank[b]; if (ra || rb) return ra === rb ? a - b : ra > rb ? 1 : -1; const x = str[a], y = str[b]; return x < y ? -sign : x > y ? sign : a - b; }
      : (a, b) => { const ra = rank[a], rb = rank[b]; if (ra || rb) return ra === rb ? a - b : ra > rb ? 1 : -1; const x = num[a], y = num[b]; return x < y ? -sign : x > y ? sign : a - b; });
    idx = Uint32Array.from(arr);
  }
  return { indices: idx, errors };
}

// Number and date sort without a comparison function: each value becomes 64 sortable bits (two 32-bit halves), then four stable passes of 16 bits
// order the row numbers (a pass whose digit is the same for every row is skipped). Same order as the comparison sort: empties last, then values
// that are not numbers, ties in file order, and -0 equal to 0, ascending or descending.
const F64 = new Float64Array(1), U32 = new Uint32Array(F64.buffer), HI = (() => { F64[0] = 1; return U32[1] === 0x3ff00000 ? 1 : 0; })(), LO = 1 - HI;
export function radixSortNumbers(idx, src, key, sign) {
  const len = idx.length;
  const desc = sign < 0;
  {   // Cheap first look: stops at the first value that is neither in order nor in strictly reverse order, so a random column costs almost nothing here;
    // an ordered column (an id column) needs no sorting, and a strictly reversed one (the same column high to low) is just turned around.
    let prev = 0, up = true, down = true, n = 0, first = true; const out = new Uint32Array(len), bad = [], empty = [];
    for (let k = 0; k < len; k++) {
      const i = idx[k], v = src[i]; if (v == null || v === '') { empty.push(i); continue; }
      const x = sign * key(v); if (x !== x) { bad.push(i); continue; }
      if (!first) { if (x < prev) up = false; if (x >= prev) down = false; if (!up && !down) break; }
      first = false; prev = x; out[n++] = i;
    }
    if (up || down) {
      if (!up) { for (let a = 0, b = n - 1; a < b; a++, b--) { const t = out[a]; out[a] = out[b]; out[b] = t; } }
      out.set(bad, n); out.set(empty, n + bad.length); return out;
    }
  }
  let hi = new Uint32Array(len), lo = new Uint32Array(len), id = new Uint32Array(len), n = 0, sorted = true, ph = 0, pl = 0;
  const bad = [], empty = [];
  for (let k = 0; k < len; k++) {
    const i = idx[k], v = src[i];
    if (v == null || v === '') { empty.push(i); continue; }
    let x = key(v); if (x !== x) { bad.push(i); continue; }
    if (x === 0) x = 0;
    F64[0] = x; let h = U32[HI], l = U32[LO];
    if (h & 0x80000000) { h = ~h >>> 0; l = ~l >>> 0; } else h = (h | 0x80000000) >>> 0;
    if (desc) { h = ~h >>> 0; l = ~l >>> 0; }
    if (sorted && n && (h < ph || (h === ph && l < pl))) sorted = false;
    ph = h; pl = l; hi[n] = h; lo[n] = l; id[n] = i; n++;
  }
  const done = () => { const out = new Uint32Array(len); out.set(id.subarray(0, n), 0); out.set(bad, n); out.set(empty, n + bad.length); return out; };
  if (sorted) return done();   // already in order (an id column, say): ties keep file order, so nothing to move
  let hi2 = new Uint32Array(n), lo2 = new Uint32Array(n), id2 = new Uint32Array(n);
  const count = new Uint32Array(65536);
  for (let pass = 0; pass < 4; pass++) {
    const word = pass < 2 ? lo : hi, shift = (pass & 1) * 16;
    count.fill(0);
    for (let k = 0; k < n; k++) count[(word[k] >>> shift) & 65535]++;
    if (n && count[(word[0] >>> shift) & 65535] === n) continue;   // every row has this digit: nothing to move
    let sum = 0; for (let d = 0; d < 65536; d++) { const c = count[d]; count[d] = sum; sum += c; }
    for (let k = 0; k < n; k++) { const d = (word[k] >>> shift) & 65535, to = count[d]++; hi2[to] = hi[k]; lo2[to] = lo[k]; id2[to] = id[k]; }
    let t = hi; hi = hi2; hi2 = t; t = lo; lo = lo2; lo2 = t; t = id; id = id2; id2 = t;
  }
  return done();
}
