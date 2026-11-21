// Top-N of a whole typed number column, by a bounded heap and per-block minimum/maximum summaries ("zone maps").
//
// CREDITS: the two ideas here come from other projects and papers; this file is our own small implementation (no code copied).
//   - Bounded heap with a threshold test ("TopN"): the standard top-k selection; the same idea is DuckDB's TopN operator, which only keeps the k best rows seen so far
//     and rejects the rest with one comparison (https://duckdb.org/ ; DuckDB by Mark Raasveldt, Hannes Muehleisen and the DuckDB contributors, MIT license).
//   - Per-block min/max summaries used to skip whole blocks: "Small Materialized Aggregates" (Guido Moerkotte, VLDB 1998, http://www.vldb.org/conf/1998/p476.pdf), also known as zone maps; used by
//     Apache Parquet row-group statistics (https://parquet.apache.org/docs/file-format/), DuckDB row-group zone maps and Netezza/Oracle zone maps. Blocks are visited best-first and the scan stops when a block
//     cannot beat the k-th kept row.
//   See docs/CREDITS.md for links.
// Top k of a whole typed number column (Int32Array, Float64Array...; NaN = empty cell) with no filter. Same order as topSortIndices: values in sort order, ties in file order,
// empties last (so null is returned, and the caller uses the general path, when fewer than k values exist). A decimal column holds whole numbers scaled by 10^decimals, which
// sort the same as the decimals, so no key function is needed. Per-block min and max (made once per column, kept in a WeakMap) let blocks that cannot hold a top-k row be skipped:
// blocks are visited best-first and the visit stops when a block's best value is worse than the k-th kept row, or equal to it and the block starts after that row.
export const BLOCK = 65536;
const SUMMARIES = new WeakMap();
function blockSummary(a, B) {
  let s = SUMMARIES.get(a); if (s && s.B === B) return s;
  const nb = Math.ceil(a.length / B), mn = new Float64Array(nb), mx = new Float64Array(nb);
  for (let b = 0; b < nb; b++) { let lo = Infinity, hi = -Infinity; const e = Math.min(a.length, (b + 1) * B); for (let i = b * B; i < e; i++) { const x = a[i]; if (x < lo) lo = x; if (x > hi) hi = x; } mn[b] = lo; mx[b] = hi; }
  s = { B, mn, mx }; SUMMARIES.set(a, s); return s;
}
// Builds the block summaries ahead of the first sort (the warm-up calls this once a number column is decoded, so a person's first sort skips the one pass over every value).
export function primeSummary(a, B = BLOCK) { if (a && a.length > B) blockSummary(a, B); }
export function topSortTyped(a, k, sign, B = BLOCK) {
  if (k <= 0 || a.length <= k) return null;
  const hv = new Float64Array(k), hi = new Int32Array(k); let size = 0;
  const worse = (p, q) => { const x = sign * hv[p], y = sign * hv[q]; return x > y || (x === y && hi[p] > hi[q]); };   // p sorts after q
  const swap = (p, q) => { const t = hv[p]; hv[p] = hv[q]; hv[q] = t; const u = hi[p]; hi[p] = hi[q]; hi[q] = u; };
  const push = (x, i) => {
    if (size < k) { let p = size++; hv[p] = x; hi[p] = i; while (p > 0) { const q = (p - 1) >> 1; if (!worse(p, q)) break; swap(p, q); p = q; } return; }
    hv[0] = x; hi[0] = i; let p = 0;
    for (;;) { let m = p; const l = 2 * p + 1, r = l + 1; if (l < size && worse(l, m)) m = l; if (r < size && worse(r, m)) m = r; if (m === p) break; swap(p, m); p = m; }
  };
  const scan = (lo, hiEnd) => {
    let t = size < k ? Infinity : sign * hv[0];
    for (let i = lo; i < hiEnd; i++) { const x = sign * a[i]; if (x < t || (x === t && size >= k && i < hi[0])) { push(a[i], i); t = size < k ? Infinity : sign * hv[0]; } }   // NaN never passes; a tie at the bar wins only with an earlier row (blocks may arrive out of file order)
  };
  const S = blockSummary(a, B), nb = S.mx.length, best = new Float64Array(nb), ord = [];
  for (let b = 0; b < nb; b++) { best[b] = sign > 0 ? S.mn[b] : -S.mx[b]; if (best[b] !== Infinity) ord.push(b); }   // a block of only empty cells holds no value
  ord.sort((p, q) => best[p] - best[q] || p - q);
  for (let j = 0; j < ord.length; j++) {
    const b = ord[j];
    if (size >= k) { const t = sign * hv[0]; if (best[b] > t || (best[b] === t && b * B > hi[0])) break; }   // best-first order: every later block is out too
    scan(b * B, Math.min(a.length, (b + 1) * B));
  }
  if (size < k) return null;   // fewer than k values: empties are part of the answer, the general path orders them
  const order = Array.from({ length: size }, (_, p) => p).sort((p, q) => (worse(p, q) ? 1 : -1));
  const out = new Uint32Array(size); for (let a2 = 0; a2 < size; a2++) out[a2] = hi[order[a2]];
  return out;
}
