// Frozen copy of the type check used before the shortcuts. Only tests/reader-equivalence.test.mjs imports it.
// Column type suggestion for delimited text. Reports only; it never converts
// values, so stored data stays the exact text from the file.
const INT = /^-?(0|[1-9]\d{0,14})$/;
const NUM = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const BOOL = /^(true|false)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export class TypeTracker {
  constructor() { this.n = 0; this.empty = 0; this.int = true; this.num = true; this.bool = true; this.date = true; }
  add(v) {
    this.n++;
    if (v === '') { this.empty++; return; }
    if (this.int && !INT.test(v)) this.int = false;
    if (this.num && !NUM.test(v)) this.num = false;
    if (this.bool && !BOOL.test(v)) this.bool = false;
    if (this.date && !(DATE.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T'))))) this.date = false;
  }
  get type() {
    if (this.n === this.empty) return 'empty';
    return this.int ? 'integer' : this.num ? 'number' : this.bool ? 'boolean' : this.date ? 'date' : 'string';
  }
  get nullable() { return this.empty > 0; }
}
