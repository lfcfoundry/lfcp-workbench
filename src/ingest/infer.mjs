// Column type suggestion for delimited text. Reports only; it never converts
// values, so stored data stays the exact text from the file.
const INT = /^-?(0|[1-9]\d{0,14})$/;
const NUM = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const BOOL = /^(true|false)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export class TypeTracker {
  constructor() { this.n = 0; this.empty = 0; this.int = true; this.num = true; this.bool = true; this.date = true; this.okDates = new Set(); }
  add(v) {
    this.n++;
    if (v === '') { this.empty++; return; }
    // Same answers as testing every pattern on every value, with the repeated work skipped: an integer is always a number, and a date string that passed once passes again.
    if (this.int && INT.test(v)) { /* integer: also a number, so the number test is skipped */ }
    else { this.int = false; if (this.num && !NUM.test(v)) this.num = false; }
    if (this.bool && !BOOL.test(v)) this.bool = false;
    if (this.date && !this.okDates.has(v)) {
      if (DATE.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T')))) { if (this.okDates.size < 4096) this.okDates.add(v); }
      else this.date = false;
    }
  }
  // Folds in the tallies of another tracker that saw later rows (used when a file is parsed in pieces).
  merge(o) { this.n += o.n; this.empty += o.empty; this.int = this.int && o.int; this.num = this.num && o.num; this.bool = this.bool && o.bool; this.date = this.date && o.date; }
  get type() {
    if (this.n === this.empty) return 'empty';
    return this.int ? 'integer' : this.num ? 'number' : this.bool ? 'boolean' : this.date ? 'date' : 'string';
  }
  get nullable() { return this.empty > 0; }
}

// Stored form of a cell in a whole-number column. A plain integer (no sign other than a leading minus, no leading zeros, up to 15 digits,
// not "-0") becomes a number, so its text is exactly String(number); an empty cell becomes null; anything else stays the text from the file.
// This is the only place the stored values differ from the file's text, and it never changes how a value reads back as text.
export function typedCell(v) {
  const n = v.length;
  if (n === 0) return null;
  if (n > 16) return v;
  const neg = v.charCodeAt(0) === 45 ? 1 : 0;
  if (neg === n) return v;
  if (v.charCodeAt(neg) === 48) return n === 1 ? 0 : v;   // "0" is a number; "-0", "007" and "0.5" stay text
  for (let k = neg; k < n; k++) { const c = v.charCodeAt(k); if (c < 48 || c > 57) return v; }
  return n - neg <= 15 ? +v : v;
}
