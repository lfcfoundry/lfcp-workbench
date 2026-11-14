// Filters that LFC-pack 0.10.19 can answer with row numbers alone (unpack(file, { equals | range, positions: true })), without decoding the whole column.
// Returns the lfc-pack query for one filter, or null when the Workbench's own rules cannot be mapped exactly (then the column path runs as before).
// Exactness rules (same rows as matches() in query.mjs):
//   ranges (> >= < <=) are NOT mapped: measured slower than the column path when many rows match (100 MB, half the rows: 95 to 133 ms), and zonePlan already covers the selective ones
//   whole-number column, =number    : only the canonical text of an integer (5, not 05 or 5.0), because matches() compares text
//   text column, =text              : a non-empty trimmed value; strict equality on string cells, as matches() does
import { parseFilter } from './query.mjs';
const BIG = Number.MAX_SAFE_INTEGER;
export function positionsQuery(text, col) {
  const { filter: f, error } = parseFilter(text, col.type); if (error || !f) return null;
  const key = col.name;
  if (col.type === 'integer') {
    if (f.op === 'eq' && /^-?(0|[1-9]\d{0,14})$/.test(f.value) && f.value !== '-0') return { equals: { key, value: +f.value } };
    return null;
  }
  if (col.type === 'string' && f.op === 'eq' && f.value !== '') return { equals: { key, value: f.value } };
  return null;
}
