// Filter and sort over in-memory rows, typed by the column types the ingest core suggests.
// One short filter language per column (fewest clicks, no dialogs):
//   text        contains, case-insensitive          >5  >=5  <5  <=5     (numbers and dates compare by value)
//   =text       equals exactly                      !=text   not equal
//   =           empty cell                          !        any non-empty cell
// Empty cells always sort last, ascending or descending. Ties keep file order.
const NUMERIC = new Set(['integer', 'number']);
const dateValue = (v) => Date.parse(String(v).replace(' ', 'T'));

// CREDITS: the one-of list is SQL's IN (...) tested with a Set; see docs/CREDITS.md (https://duckdb.org/docs/stable/sql/expressions/in).
// Splits "a|b\|c" into ["a","b|c"] on bars not preceded by a backslash; each piece is trimmed.
function splitOneOf(t) {
  const out = []; let cur = '';
  for (let i = 0; i < t.length; i++) { const ch = t[i]; if (ch === '\\' && t[i + 1] === '|') { cur += '|'; i++; } else if (ch === '|') { out.push(cur.trim()); cur = ''; } else cur += ch; }
  out.push(cur.trim()); return out;
}
export function parseFilter(text, type) {
  const s = String(text ?? '').trim();
  if (!s) return { filter: null };
  if (s === '!') return { filter: { op: 'notEmpty' } };
  if (s === '=') return { filter: { op: 'empty' } };
  const m = /^(>=|<=|!=|>|<|=)(.*)$/.exec(s);
  if (!m) return { filter: { op: 'contains', value: s.toLowerCase() } };
  const op = { '>=': 'gte', '<=': 'lte', '!=': 'ne', '>': 'gt', '<': 'lt', '=': 'eq' }[m[1]], raw = m[2].trim();
  if (op === 'eq' && m[2].includes('|')) {   // =a|b keeps rows equal to any value; \| is a literal bar
    const parts = splitOneOf(m[2]);
    if (parts.length > 1) return parts.some((x) => x === '') ? { error: 'Empty value in the = list' } : { filter: { op: 'in', values: parts, set: new Set(parts) } };
    if (parts[0] !== raw) return { filter: { op, value: parts[0] } };
  }
  if (op === 'eq' || op === 'ne') return { filter: { op, value: raw } };
  if (NUMERIC.has(type)) { const n = Number(raw); return raw === '' || Number.isNaN(n) ? { error: 'Enter a number after ' + m[1] } : { filter: { op, value: n, kind: 'num' } }; }
  if (type === 'date') { const n = dateValue(raw); return Number.isNaN(n) ? { error: 'Enter a date like 2026-11-05 after ' + m[1] } : { filter: { op, value: n, kind: 'date' } }; }
  return { filter: { op, value: raw, kind: 'str' } };
}

// dec: the column's count of decimals when it stores decimals as whole numbers scaled by 10^dec (see infer.mjs); a number then reads as text with exactly that many decimals
// (formatScaled), the text it was imported from, and compares by value cell / 10^dec.
export function formatScaled(n, d) { const a = String(Math.abs(n)).padStart(d + 1, '0'); return (n < 0 ? '-' : '') + a.slice(0, a.length - d) + '.' + a.slice(a.length - d); }
const SCALE = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
export function matches(f, cell, dec) {
  if (cell !== cell) cell = null;   // a number column read as a typed array holds NaN for an empty cell
  if (typeof cell === 'number' && f.kind === 'num') {   // stored numbers: compare without making text first
    const x = dec ? cell / SCALE[dec] : cell;
    return f.op === 'gt' ? x > f.value : f.op === 'gte' ? x >= f.value : f.op === 'lt' ? x < f.value : f.op === 'lte' ? x <= f.value : matchText(f, dec ? formatScaled(cell, dec) : String(cell));
  }
  return matchText(f, cell == null ? '' : typeof cell === 'number' && dec ? formatScaled(cell, dec) : String(cell));
}
function matchText(f, v) {
  switch (f.op) {
    case 'empty': return v === '';
    case 'notEmpty': return v !== '';
    case 'contains': return v.toLowerCase().includes(f.value);
    case 'eq': return v === f.value;
    case 'in': return f.set.has(v);
    case 'ne': return v !== f.value;
  }
  if (v === '') return false;
  const x = f.kind === 'num' ? Number(v) : f.kind === 'date' ? dateValue(v) : v;
  if (f.kind !== 'str' && Number.isNaN(x)) return false;
  return f.op === 'gt' ? x > f.value : f.op === 'gte' ? x >= f.value : f.op === 'lt' ? x < f.value : x <= f.value;
}

export function sortKeyFor(type, dec) { return sortKey(type, dec); }
function sortKey(type, dec) {
  if (NUMERIC.has(type)) return dec ? (v) => (typeof v === 'number' ? v / SCALE[dec] : Number(v)) : (v) => Number(v);
  if (type === 'date') return dateValue;
  return dec ? (v) => (typeof v === 'number' ? formatScaled(v, dec) : String(v)) : (v) => String(v);
}

// columns: [{name, type}]; filters: {columnName: text}; sort: {col, dir:'asc'|'desc'} | null
// Returns {indices: Uint32Array of matching row numbers in display order, errors: {columnName: message}}.
export function runQuery(rows, columns, { filters = {}, sort = null } = {}) {
  const errors = {}, active = [];
  for (const c of columns) {
    const text = filters[c.name]; if (!text) continue;
    const { filter, error } = parseFilter(text, c.type);
    if (error) errors[c.name] = error; else if (filter) active.push([c.name, filter, c.decimals]);
  }
  let idx = [];
  outer: for (let i = 0; i < rows.length; i++) { for (const [name, f, dec] of active) if (!matches(f, rows[i][name], dec)) continue outer; idx.push(i); }
  if (sort && sort.col) {
    const col = columns.find((c) => c.name === sort.col), name = sort.col, key = sortKey(col ? col.type : 'string', col && col.decimals), sign = sort.dir === 'desc' ? -1 : 1;
    const blank = (v) => v == null || v === '';
    idx.sort((a, b) => {
      const va = rows[a][name], vb = rows[b][name], ea = blank(va), eb = blank(vb);
      if (ea || eb) return ea && eb ? a - b : ea ? 1 : -1;
      const ka = key(va), kb = key(vb), na = ka !== ka, nb = kb !== kb; // NaN last
      if (na || nb) return na && nb ? a - b : na ? 1 : -1;
      return ka < kb ? -sign : ka > kb ? sign : a - b;
    });
  }
  return { indices: Uint32Array.from(idx), errors };
}
