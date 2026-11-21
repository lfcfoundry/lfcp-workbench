// Group-by and totals over decoded columns (the same columns the filter and sort use).
// cols: { name: Array<string> | Float64Array (NaN = empty cell) }. rows: optional Uint32Array of row numbers (the filtered view); null = every row.
// aggs: [{ fn: 'count' } | { fn: 'sum'|'avg'|'min'|'max', col } | { fn: 'rate', col, equals }]   (rate = share of rows whose cell equals the text)
// Result: { keys: string[], counts: Float64Array, values: Float64Array[] (one per non-count agg, in order), order: group numbers by first appearance }
// Pass 1 gives every row a group number (a last-key cache first, then a Map from text to number); pass 2 is one tight loop per aggregate.

// Pass 2: one tight loop per non-count aggregate over per-row group numbers gid (G groups, counts already filled).
function aggregate(cols, rows, m, gid, G, counts, aggs, codeCols) {
  const values = [], sums = new Map();
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
      const share = a.fn === 'sum' || a.fn === 'avg', hit = share && sums.get(a.col);   // sum and avg of one column read it once
      if (hit) { for (let g = 0; g < G; g++) { if (!hit.seen[g]) out[g] = NaN; else out[g] = a.fn === 'avg' ? hit.sum[g] / hit.seen[g] : hit.sum[g]; } values.push(out); continue; }
      if (a.fn === 'min') out.fill(Infinity); else if (a.fn === 'max') out.fill(-Infinity);
      if (a.fn === 'min') { for (let i = 0; i < m; i++) { const x = c[rows ? rows[i] : i]; if (x !== x) continue; const g = gid[i]; seen[g]++; if (x < out[g]) out[g] = x; } }
      else if (a.fn === 'max') { for (let i = 0; i < m; i++) { const x = c[rows ? rows[i] : i]; if (x !== x) continue; const g = gid[i]; seen[g]++; if (x > out[g]) out[g] = x; } }
      else if (rows) { for (let i = 0; i < m; i++) { const x = c[rows[i]]; if (x !== x) continue; const g = gid[i]; seen[g]++; out[g] += x; } }
      else { for (let i = 0; i < m; i++) { const x = c[i]; if (x !== x) continue; const g = gid[i]; seen[g]++; out[g] += x; } }
      if (share) sums.set(a.col, { sum: Float64Array.from(out), seen: Float64Array.from(seen) });
      for (let g = 0; g < G; g++) { if (!seen[g]) out[g] = NaN; else if (a.fn === 'avg') out[g] /= seen[g]; }
    }
    values.push(out);
  }
  return values;
}


// One pass, no group-number array: slot s = key - lo (R = empty key); count, sum and seen counts per slot for one or two number columns. Groups come out in order of first appearance.
function fusedDense(cols, kc, rows, m, lo, R, aggs) {
  const need = []; for (const a of aggs) { if (a.fn === 'count') continue; if (a.fn !== 'sum' && a.fn !== 'avg') return null; const c = cols[a.col]; if (!ArrayBuffer.isView(c)) return null; if (!need.includes(a.col)) need.push(a.col); }
  if (need.length > 2) return null;
  const cnt = new Float64Array(R + 1), order = [], c1 = need.length ? cols[need[0]] : null, c2 = need.length > 1 ? cols[need[1]] : null;
  const s1 = c1 ? new Float64Array(R + 1) : null, n1 = c1 ? new Float64Array(R + 1) : null, s2 = c2 ? new Float64Array(R + 1) : null, n2 = c2 ? new Float64Array(R + 1) : null;
  if (!c1) { for (let i = 0; i < m; i++) { const k = kc[rows ? rows[i] : i], t = k !== k ? R : k - lo; if (cnt[t] === 0) order.push(t); cnt[t]++; } }
  else if (!c2) {
    if (rows) for (let i = 0; i < m; i++) { const r = rows[i], k = kc[r], t = k !== k ? R : k - lo; if (cnt[t] === 0) order.push(t); cnt[t]++; const v = c1[r]; if (v === v) { n1[t]++; s1[t] += v; } }
    else for (let i = 0; i < m; i++) { const k = kc[i], t = k !== k ? R : k - lo; if (cnt[t] === 0) order.push(t); cnt[t]++; const v = c1[i]; if (v === v) { n1[t]++; s1[t] += v; } }
  } else {
    for (let i = 0; i < m; i++) { const r = rows ? rows[i] : i, k = kc[r], t = k !== k ? R : k - lo; if (cnt[t] === 0) order.push(t); cnt[t]++; const v = c1[r], w = c2[r]; if (v === v) { n1[t]++; s1[t] += v; } if (w === w) { n2[t]++; s2[t] += w; } }
  }
  const G = order.length, keys = new Array(G), counts = new Float64Array(G), values = [];
  for (let g = 0; g < G; g++) { const t = order[g]; keys[g] = t === R ? '' : String(t + lo); counts[g] = cnt[t]; }
  for (const a of aggs) {
    if (a.fn === 'count') continue;
    const j = need.indexOf(a.col), S = j ? s2 : s1, N = j ? n2 : n1, out = new Float64Array(G);
    for (let g = 0; g < G; g++) { const t = order[g]; out[g] = N[t] === 0 ? NaN : a.fn === 'avg' ? S[t] / N[t] : S[t]; }
    values.push(out);
  }
  return { keys, counts, values };
}
export function groupBy(cols, n, rows, { key, aggs }) {
  const kc = cols[key], m = rows ? rows.length : n, names = [], map = new Map(), numKey = ArrayBuffer.isView(kc);
  let gid;   // one group number per row; made only when a path needs it (the fused numeric path does not)
  if (numKey) {   // whole-number keys in a small range (ids, years, codes): a table slot per value, no Map; groups numbered by first appearance as before
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let i = 0; i < m; i++) { const k = kc[rows ? rows[i] : i]; if (k !== k) continue; if (k < lo) lo = k; if (k > hi) hi = k; if (k !== Math.floor(k)) { ok = false; break; } }
    if (ok && hi - lo < 1048576) {
      const R = lo === Infinity ? 1 : hi - lo + 1;
      const fused = fusedDense(cols, kc, rows, m, lo, R, aggs);   // count, sum and avg of up to two number columns in one pass over the rows
      if (fused) return fused;
      gid = new Uint32Array(m); const slot = new Int32Array(R + 1).fill(-1), counts0 = [];
      for (let i = 0; i < m; i++) {
        const k = kc[rows ? rows[i] : i], s = k !== k ? R : k - lo; let g = slot[s];
        if (g < 0) { g = names.length; slot[s] = g; names.push(k !== k ? '' : String(k)); counts0.push(0); }
        gid[i] = g; counts0[g]++;
      }
      const counts = Float64Array.from(counts0);
      return { keys: names, counts, values: aggregate(cols, rows, m, gid, names.length, counts, aggs) };
    }
  }
  gid = new Uint32Array(m); let lastK, lastG = -1;
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
// ids1/dict1, ids2/dict2: optional kept dictionary ids (index into dict). Result: keys = first-column text per group, keys2 = second-column text per group (two parallel arrays, no pair arrays), same counts/values shape as groupBy.
export const DENSE_SLOTS = 1 << 18;
function keyIds(kc, n, rows, ids, dict, cache, name) {
  if (ids) return { ids, labels: dict };
  const hit = cache && cache.get(name); if (hit) return hit;   // ids of a whole column from an earlier Summarize (valid for any row selection; labels no selected row uses become empty groups and are dropped)
  const m = rows ? rows.length : n, out = new Uint32Array(rows ? m : n), map = new Map(), labels = [], num = ArrayBuffer.isView(kc);   // a filtered cold column: ids per selected row (slot i), not per table row, so a small selection does not allocate the whole column
  let lastK, lastG = -1;
  for (let i = 0; i < m; i++) {
    const r = rows ? rows[i] : i, k = kc[r];
    if (k === lastK && lastG >= 0) { out[rows ? i : r] = lastG; continue; }
    let g = map.get(k);
    if (g === undefined) { g = labels.length; map.set(k, g); labels.push(num ? (k !== k ? '' : String(k)) : k); }
    out[rows ? i : r] = lastG = g; lastK = k;
  }
  const res = { ids: out, labels, sel: !!rows }; if (cache && !rows) { if (cache.size >= 6) cache.delete(cache.keys().next().value); cache.set(name, res); }   // at most 6 columns kept (4 bytes a row each)
  return res;
}
export function groupBy2(cols, n, rows, { key, key2, aggs, ids1, dict1, ids2, dict2, forceMap, codeCols, cache }) {
  const m = rows ? rows.length : n, A = keyIds(cols[key], n, rows, ids1, dict1, cache, key), B = keyIds(cols[key2], n, rows, ids2, dict2, cache, key2), G2 = B.labels.length || 1, slots = A.labels.length * G2;
  const dense = !forceMap && slots <= DENSE_SLOTS, gid = new Uint32Array(m), a = A.ids, b = B.ids, sa = !!A.sel, sb = !!B.sel;   // sel: the ids are per selected row (slot i), otherwise per table row (slot r)
  let G, firstA, firstB;
  if (dense) {
    G = slots;
    if (rows) for (let i = 0; i < m; i++) { const r = rows[i]; gid[i] = a[sa ? i : r] * G2 + b[sb ? i : r]; } else for (let i = 0; i < m; i++) gid[i] = a[i] * G2 + b[i];
  } else {
    firstA = []; firstB = []; let lastC = -1, lastG = -1;
    if (slots <= 2147483647) {   // open addressing on the packed key (power-of-two table at most half full, linear probing, multiplicative hash): no Map, no boxing
      let cap = 1024; const need = Math.min(m, slots) * 2; while (cap < need) cap <<= 1;
      const sh = 32 - Math.log2(cap), tk = new Int32Array(cap).fill(-1), tg = new Int32Array(cap), mask = cap - 1;
      for (let i = 0; i < m; i++) {
        const r = rows ? rows[i] : i, ia = sa ? i : r, ib = sb ? i : r, c = a[ia] * G2 + b[ib];
        if (c === lastC) { gid[i] = lastG; continue; }
        let h = Math.imul(c, -1640531535) >>> sh, g;
        for (;;) { const k = tk[h]; if (k === c) { g = tg[h]; break; } if (k === -1) { g = firstA.length; tk[h] = c; tg[h] = g; firstA.push(a[ia]); firstB.push(b[ib]); break; } h = (h + 1) & mask; }
        gid[i] = lastG = g; lastC = c;
      }
    } else {
      const map = new Map();
      for (let i = 0; i < m; i++) {
        const r = rows ? rows[i] : i, ia = sa ? i : r, ib = sb ? i : r, c = a[ia] * G2 + b[ib];
        if (c === lastC) { gid[i] = lastG; continue; }
        let g = map.get(c); if (g === undefined) { g = firstA.length; map.set(c, g); firstA.push(a[ia]); firstB.push(b[ib]); }
        gid[i] = lastG = g; lastC = c;
      }
    }
    G = firstA.length;
  }
  const counts = new Float64Array(G); for (let i = 0; i < m; i++) counts[gid[i]]++;
  const values = aggregate(cols, rows, m, gid, G, counts, aggs, codeCols);
  let K = 0; for (let g = 0; g < G; g++) if (counts[g]) K++;   // dense slots no selected row uses are not groups
  const keep = new Uint32Array(K), c2 = new Float64Array(K), v2 = values.map(() => new Float64Array(K)), k1 = new Array(K), k2 = new Array(K);
  for (let g = 0, j = 0; g < G; g++) {
    if (!counts[g]) continue;
    keep[j] = g; c2[j] = counts[g]; for (let v = 0; v < values.length; v++) v2[v][j] = values[v][g];
    if (dense) { k1[j] = A.labels[Math.floor(g / G2)]; k2[j] = B.labels[g % G2]; } else { k1[j] = A.labels[firstA[g]]; k2[j] = B.labels[firstB[g]]; } j++;
  }
  return { keys: k1, keys2: k2, counts: c2, values: v2 };
}
