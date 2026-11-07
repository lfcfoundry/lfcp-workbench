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
