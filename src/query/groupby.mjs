// Group-by and totals over decoded columns (the same columns the filter and sort use).
// cols: { name: Array<string> | Float64Array (NaN = empty cell) }. rows: optional Uint32Array of row numbers (the filtered view); null = every row.
// aggs: [{ fn: 'count' } | { fn: 'sum'|'avg'|'min'|'max', col } | { fn: 'rate', col, equals }]   (rate = share of rows whose cell equals the text)
// Result: { keys: string[], counts: Float64Array, values: Float64Array[] (one per non-count agg, in order), order: group numbers by first appearance }
// Pass 1 gives every row a group number (a last-key cache first, then a Map from text to number); pass 2 is one tight loop per aggregate.
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
  const values = [];
  for (const a of aggs) {
    if (a.fn === 'count') continue;
    const c = cols[a.col], out = new Float64Array(G), seen = new Float64Array(G);
    if (a.fn === 'rate') {
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
