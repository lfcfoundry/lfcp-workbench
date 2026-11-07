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
  get type() {
    if (this.n === this.empty) return 'empty';
    return this.int ? 'integer' : this.num ? 'number' : this.bool ? 'boolean' : this.date ? 'date' : 'string';
  }
  get nullable() { return this.empty > 0; }
}
