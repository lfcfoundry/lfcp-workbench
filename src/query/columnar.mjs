// Same filter and sort as query.mjs (runQuery), but over whole columns instead of row objects:
// cols = { columnName: array of cell values, one entry per row }, n = row count.
// Returns the same {indices, errors}. Used when only the filtered or sorted columns were decoded from the dataset
// (LfcPack.unpackColumns), which skips making a row object per row and decoding the other columns.
import { parseFilter, matches, sortKeyFor } from './query.mjs';

export function runColumnQuery(cols, n, columns, { filters = {}, sort = null, top = 0 } = {}) {
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
    if (top) { const first = topSortIndices(idx, src, key, sign, text, top); if (first) { const fidx = idx; return { first, count: fidx.length, errors, full: () => runColumnQuery(cols, n, columns, { filters, sort }).indices }; } }
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

// First page first: the best `k` rows of a sort in one scan, same order and tie rule as the full sort above (empties last, then values that are not
// numbers, then the sort order, ties in file order). A max-heap of the k best so far; a row that cannot beat the worst kept row costs one comparison.
// Returns the k row numbers in display order. The full order (runColumnQuery) is still needed to scroll past row k.
export function topSortIndices(idx, src, key, sign, text, k) {
  const len = idx.length; if (k >= len) return null;
  if (!text) {   // a column already in order (an id column) or strictly reversed: the full sort turns it around at once, and a heap would churn on every row
    let prev = 0, up = true, down = true, first = true;
    for (let t = 0; t < len; t++) { const v = src[idx[t]]; if (v == null || v === '') continue; const x = key(v); if (x !== x) continue; if (!first) { if (x < prev) up = false; if (x >= prev) down = false; if (!up && !down) break; } first = false; prev = x; }
    if (up || down) return null;
  }
  const hrank = new Uint8Array(k), hnum = new Float64Array(k), hstr = text ? new Array(k) : null, hidx = new Uint32Array(k);
  let size = 0;
  // c < 0: row a goes before row b (rank, value, then file order)
  const cmp = (ra, xa, sa, ia, rb, xb, sb, ib) => {
    if (ra !== rb) return ra - rb;
    if (ra === 0) { if (text) { if (sa < sb) return -sign; if (sa > sb) return sign; } else { if (xa < xb) return -sign; if (xa > xb) return sign; } }
    return ia - ib;
  };
  const worse = (p, q) => cmp(hrank[p], hnum[p], hstr && hstr[p], hidx[p], hrank[q], hnum[q], hstr && hstr[q], hidx[q]) > 0;   // p sorts after q
  const swap = (p, q) => { let t = hrank[p]; hrank[p] = hrank[q]; hrank[q] = t; t = hnum[p]; hnum[p] = hnum[q]; hnum[q] = t; t = hidx[p]; hidx[p] = hidx[q]; hidx[q] = t; if (hstr) { const s = hstr[p]; hstr[p] = hstr[q]; hstr[q] = s; } };
  const up = (p) => { while (p > 0) { const q = (p - 1) >> 1; if (!worse(p, q)) break; swap(p, q); p = q; } };
  const down = (p) => { for (;;) { let m = p; const l = 2 * p + 1, r = l + 1; if (l < size && worse(l, m)) m = l; if (r < size && worse(r, m)) m = r; if (m === p) break; swap(p, m); p = m; } };
  // Fast rejection: once k rows are kept, a normal value that cannot beat the worst kept normal value is skipped with one comparison (no heap work).
  // Later rows lose ties, so equal is a rejection too. thr is the worst kept value in sort direction (numbers: sign * value; text: the string).
  let thrOn = false, thrNum = 0, thrStr = '';
  const setThr = () => { if (hrank[0] === 0) { thrOn = true; thrNum = sign * hnum[0]; thrStr = hstr ? hstr[0] : ''; } else thrOn = false; };
  for (let t = 0; t < len; t++) {
    const i = idx[t], v = src[i];
    if (thrOn && v != null && v !== '') {
      if (text) { const s0 = String(v); if (sign > 0 ? s0 >= thrStr : s0 <= thrStr) continue; }
      else { const x0 = key(v); if (x0 === x0 && sign * x0 >= thrNum) continue; }
    }
    let r = 0, x = 0, s = null;
    if (v == null || v === '') r = 2; else if (text) s = String(v); else { x = key(v); if (x !== x) r = 1; }
    if (size < k) { hrank[size] = r; hnum[size] = x; if (hstr) hstr[size] = s; hidx[size] = i; up(size++); if (size === k) setThr(); continue; }
    if (cmp(r, x, s, i, hrank[0], hnum[0], hstr && hstr[0], hidx[0]) < 0) { hrank[0] = r; hnum[0] = x; if (hstr) hstr[0] = s; hidx[0] = i; down(0); setThr(); }
  }
  const order = Array.from({ length: size }, (_, p) => p).sort((p, q) => cmp(hrank[p], hnum[p], hstr && hstr[p], hidx[p], hrank[q], hnum[q], hstr && hstr[q], hidx[q]));
  const out = new Uint32Array(size); for (let a = 0; a < size; a++) out[a] = hidx[order[a]];
  return out;
}
