// Group-by and totals over decoded columns (the same columns the filter and sort use).
// cols: { name: Array<string> | Float64Array (NaN = empty cell) }. rows: optional Uint32Array of row numbers (the filtered view); null = every row.
// aggs: [{ fn: 'count' } | { fn: 'sum'|'avg'|'min'|'max', col } | { fn: 'rate', col, equals }]   (rate = share of rows whose cell equals the text)
// Result: { keys: string[], counts: Float64Array, values: Float64Array[] (one per non-count agg, in order), order: group numbers by first appearance }
// Pass 1 gives every row a group number (a last-key cache first, then a Map from text to number); pass 2 is one tight loop per aggregate.

// Pass 2: one tight loop per non-count aggregate over per-row group numbers gid (G groups, counts already filled).
function aggregate(cols, rows, m, gid, G, counts, aggs, codeCols) {
  const values = [];
  for (const a of aggs) {
    if (a.fn === 'count') continue;
    const cc = a.fn === 'rate' && codeCols && codeCols[a.col], c = cc ? null : cols[a.col], out = new Float64Array(G), seen = new Float64Array(G);
    if (cc) {   // a kept dictionary column: compare ids, no text
      const want = cc.dict.indexOf(a.equals), ci = cc.ids; for (let i = 0; i < m; i++) if (ci[rows ? rows[i] : i] === want) out[gid[i]]++;
      for (let g = 0; g < G; g++) out[g] = counts[g] ? out[g] / counts[g] : NaN;
    } else if (a.fn === 'rate') {
      for (let i = 0; i < m; i++) { if (c[rows ? rows[i] : i] === a.equals) out[gid[i]]++; }
      for (let g = 0; g < G; g++) out[g] = counts[g] ? out[g] / counts[g] : NaN;
    } else {
      if (!ArrayBuffer.isView(c)) throw new Error('Column ' + a.col + ' is not a number column.');
      if (a.fn === 'min') out.fill(Infinity); else if (a.fn === 'max') out.fill(-Infinity);
      for (let i = 0; i < m; i++) {
        const x = c[rows ? rows[i] : i]; if (x !== x) continue; const g = gid[i]; seen[g]++;
        if (a.fn === 'min') { if (x < out[g]) out[g] = x; } else if (a.fn === 'max') { if (x > out[g]) out[g] = x; } else out[g] += x;
      }
      for (let g = 0; g < G; g++) { if (!seen[g]) out[g] = NaN; else if (a.fn === 'avg') out[g] /= seen[g]; }
    }
    values.push(out);
  }
  return values;
}

export function groupBy(cols, n, rows, { key, aggs }) {
  const kc = cols[key], m = rows ? rows.length : n, gid = new Uint32Array(m), names = [], map = new Map(), numKey = ArrayBuffer.isView(kc);
  let lastK, lastG = -1;
  for (let i = 0; i < m; i++) {
    const r = rows ? rows[i] : i, k = kc[r];
    if (k === lastK && lastG >= 0) { gid[i] = lastG; continue; }
    let g = map.get(k);
    if (g === undefined) { g = names.length; map.set(k, g); names.push(numKey ? (k !== k ? '' : String(k)) : k); }
    gid[i] = lastG = g; lastK = k;
  }
  const G = names.length, counts = new Float64Array(G);
  for (let i = 0; i < m; i++) counts[gid[i]]++;
  const values = aggregate(cols, rows, m, gid, G, counts, aggs);
  return { keys: names, counts, values };
}

// Group by a dictionary-coded column: ids[i] is the index into dict (the distinct texts), no text is read per row. Same result shape as groupBy.
// Other aggregates read the same cols as groupBy; a dictionary column used as the 'rate' column is compared by id (equals is looked up once).
export function groupByCodes(ids, dict, cols, n, rows, { aggs, codeCols = {} }) {
  const m = rows ? rows.length : n, G = dict.length, counts = new Float64Array(G);
  if (rows) for (let i = 0; i < m; i++) counts[ids[rows[i]]]++; else for (let i = 0; i < m; i++) counts[ids[i]]++;
  const values = [];
  for (const a of aggs) {
    if (a.fn === 'count') continue;
    const out = new Float64Array(G), seen = new Float64Array(G);
    if (a.fn === 'rate') {
      const cc = codeCols[a.col];
      if (cc) { const want = cc.dict.indexOf(a.equals), ci = cc.ids; for (let i = 0; i < m; i++) { const r = rows ? rows[i] : i; if (ci[r] === want) out[ids[r]]++; } }
      else { const c = cols[a.col]; for (let i = 0; i < m; i++) { const r = rows ? rows[i] : i; if (c[r] === a.equals) out[ids[r]]++; } }
      for (let g = 0; g < G; g++) out[g] = counts[g] ? out[g] / counts[g] : NaN;
    } else {
      const c = cols[a.col]; if (!ArrayBuffer.isView(c)) throw new Error('Column ' + a.col + ' is not a number column.');
      if (a.fn === 'min') out.fill(Infinity); else if (a.fn === 'max') out.fill(-Infinity);
      for (let i = 0; i < m; i++) { const r = rows ? rows[i] : i, x = c[r]; if (x !== x) continue; const g = ids[r]; seen[g]++; if (a.fn === 'min') { if (x < out[g]) out[g] = x; } else if (a.fn === 'max') { if (x > out[g]) out[g] = x; } else out[g] += x; }
      for (let g = 0; g < G; g++) { if (!seen[g]) out[g] = NaN; else if (a.fn === 'avg') out[g] /= seen[g]; }
    }
    values.push(out);
  }
  const keep = []; for (let g = 0; g < G; g++) if (counts[g]) keep.push(g);   // a dictionary entry no selected row uses is not a group
  return { keys: keep.map((g) => dict[g]), counts: Float64Array.from(keep, (g) => counts[g]), values: values.map((v) => Float64Array.from(keep, (g) => v[g])) };
}

// Two key columns. Each key is turned into small ids first (a kept dictionary column gives its ids for free, other columns get ids from one Map pass),
// then one group number per row = id1 * card2 + id2: a dense slot when the product is <= DENSE_SLOTS (no hashing at all), else a Map on that number.
// Idea credited: DuckDB's perfect-hash group-by (slot = sum of (value - min) << shift, a dense array when the key space is small), see DUCKDB-GROUP-BY-2026.11.15.md.
// ids1/dict1, ids2/dict2: optional kept dictionary ids (index into dict). Result: keys = [[label1, label2], ...] with the same counts/values shape as groupBy.
export const DENSE_SLOTS = 1 << 18;
function keyIds(kc, n, rows, ids, dict) {
  if (ids) return { ids, labels: dict };
  const m = rows ? rows.length : n, out = new Uint32Array(n), map = new Map(), labels = [], num = ArrayBuffer.isView(kc);
  let lastK, lastG = -1;
  for (let i = 0; i < m; i++) {
    const r = rows ? rows[i] : i, k = kc[r];
    if (k === lastK && lastG >= 0) { out[r] = lastG; continue; }
    let g = map.get(k);
    if (g === undefined) { g = labels.length; map.set(k, g); labels.push(num ? (k !== k ? '' : String(k)) : k); }
    out[r] = lastG = g; lastK = k;
  }
  return { ids: out, labels };
}
export function groupBy2(cols, n, rows, { key, key2, aggs, ids1, dict1, ids2, dict2, forceMap, codeCols }) {
  const m = rows ? rows.length : n, A = keyIds(cols[key], n, rows, ids1, dict1), B = keyIds(cols[key2], n, rows, ids2, dict2), G2 = B.labels.length || 1, slots = A.labels.length * G2;
  const dense = !forceMap && slots <= DENSE_SLOTS, gid = new Uint32Array(m), a = A.ids, b = B.ids;
  let G, firstA, firstB;
  if (dense) {
    G = slots;
    if (rows) for (let i = 0; i < m; i++) { const r = rows[i]; gid[i] = a[r] * G2 + b[r]; } else for (let i = 0; i < m; i++) gid[i] = a[i] * G2 + b[i];
  } else {
    const map = new Map(); firstA = []; firstB = []; let lastC = -1, lastG = -1;
    for (let i = 0; i < m; i++) {
      const r = rows ? rows[i] : i, c = a[r] * G2 + b[r];
      if (c === lastC) { gid[i] = lastG; continue; }
      let g = map.get(c); if (g === undefined) { g = firstA.length; map.set(c, g); firstA.push(a[r]); firstB.push(b[r]); }
      gid[i] = lastG = g; lastC = c;
    }
    G = firstA.length;
  }
  const counts = new Float64Array(G); for (let i = 0; i < m; i++) counts[gid[i]]++;
  const values = aggregate(cols, rows, m, gid, G, counts, aggs, codeCols), keep = [];
  for (let g = 0; g < G; g++) if (counts[g]) keep.push(g);   // dense slots no selected row uses are not groups
  const la = (g) => A.labels[dense ? Math.floor(g / G2) : firstA[g]], lb = (g) => B.labels[dense ? g % G2 : firstB[g]];
  return { keys: keep.map((g) => [la(g), lb(g)]), counts: Float64Array.from(keep, (g) => counts[g]), values: values.map((v) => Float64Array.from(keep, (g) => v[g])) };
}
