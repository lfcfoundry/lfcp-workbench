// Filter and sort over in-memory rows, typed by the column types the ingest core suggests.
// One short filter language per column (fewest clicks, no dialogs):
//   text        contains, case-insensitive          >5  >=5  <5  <=5     (numbers and dates compare by value)
//   =text       equals exactly                      !=text   not equal
//   =           empty cell                          !        any non-empty cell
// Empty cells always sort last, ascending or descending. Ties keep file order.
const NUMERIC = new Set(['integer', 'number']);
const dateValue = (v) => Date.parse(String(v).replace(' ', 'T'));

export function parseFilter(text, type) {
  const s = String(text ?? '').trim();
  if (!s) return { filter: null };
  if (s === '!') return { filter: { op: 'notEmpty' } };
  if (s === '=') return { filter: { op: 'empty' } };
  const m = /^(>=|<=|!=|>|<|=)(.*)$/.exec(s);
  if (!m) return { filter: { op: 'contains', value: s.toLowerCase() } };
  const op = { '>=': 'gte', '<=': 'lte', '!=': 'ne', '>': 'gt', '<': 'lt', '=': 'eq' }[m[1]], raw = m[2].trim();
  if (op === 'eq' || op === 'ne') return { filter: { op, value: raw } };
  if (NUMERIC.has(type)) { const n = Number(raw); return raw === '' || Number.isNaN(n) ? { error: 'Enter a number after ' + m[1] } : { filter: { op, value: n, kind: 'num' } }; }
  if (type === 'date') { const n = dateValue(raw); return Number.isNaN(n) ? { error: 'Enter a date like 2026-11-05 after ' + m[1] } : { filter: { op, value: n, kind: 'date' } }; }
  return { filter: { op, value: raw, kind: 'str' } };
}

export function matches(f, cell) {
  const v = cell == null ? '' : String(cell);
  switch (f.op) {
    case 'empty': return v === '';
    case 'notEmpty': return v !== '';
    case 'contains': return v.toLowerCase().includes(f.value);
    case 'eq': return v === f.value;
    case 'ne': return v !== f.value;
  }
  if (v === '') return false;
  const x = f.kind === 'num' ? Number(v) : f.kind === 'date' ? dateValue(v) : v;
  if (f.kind !== 'str' && Number.isNaN(x)) return false;
  return f.op === 'gt' ? x > f.value : f.op === 'gte' ? x >= f.value : f.op === 'lt' ? x < f.value : x <= f.value;
}

export function sortKeyFor(type) { return sortKey(type); }
function sortKey(type) {
  if (NUMERIC.has(type)) return (v) => Number(v);
  if (type === 'date') return dateValue;
  return (v) => String(v);
}

// columns: [{name, type}]; filters: {columnName: text}; sort: {col, dir:'asc'|'desc'} | null
// Returns {indices: Uint32Array of matching row numbers in display order, errors: {columnName: message}}.
export function runQuery(rows, columns, { filters = {}, sort = null } = {}) {
  const errors = {}, active = [];
  for (const c of columns) {
    const text = filters[c.name]; if (!text) continue;
    const { filter, error } = parseFilter(text, c.type);
    if (error) errors[c.name] = error; else if (filter) active.push([c.name, filter]);
  }
  let idx = [];
  outer: for (let i = 0; i < rows.length; i++) { for (const [name, f] of active) if (!matches(f, rows[i][name])) continue outer; idx.push(i); }
  if (sort && sort.col) {
    const col = columns.find((c) => c.name === sort.col), name = sort.col, key = sortKey(col ? col.type : 'string'), sign = sort.dir === 'desc' ? -1 : 1;
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
