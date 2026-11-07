// Frozen copy of the character-by-character reader used before the fast path. Only tests/reader-equivalence.test.mjs imports it.
// Streaming delimited-text (CSV/TSV) reader for the Workbench ingestion core.
// Feed decoded text in any chunk sizes; rows arrive through onRow(fields, line)
// where `line` is the 1-based physical line the record starts on.
// Rules: fully blank lines are skipped; RFC 4180 quotes ("" escapes a quote,
// quoted fields may hold delimiters and newlines); CR, LF and CRLF all end a
// record; a ragged row is reported as an IngestError with its line number.

export class IngestError extends Error {
  constructor(message, line) { super(line ? `Line ${line}: ${message}` : message); this.name = 'IngestError'; this.line = line || null; }
}

export class DelimitedParser {
  constructor(delimiter, onRow, { maxRecordChars = 8 * 1024 * 1024 } = {}) {
    if (typeof delimiter !== 'string' || delimiter.length !== 1 || /["\r\n]/.test(delimiter)) throw new IngestError('The delimiter must be one ordinary character.');
    this.d = delimiter; this.onRow = onRow; this.max = maxRecordChars;
    this.row = []; this.field = ''; this.mode = 0; // 0 plain, 1 in quotes, 2 after closing quote
    this.pendingQuote = false; this.skipLF = false;
    this.line = 1; this.startLine = 1; this.chars = 0; this.seen = false;
  }
  _endField() { this.row.push(this.field); this.field = ''; this.mode = 0; this.seen = true; }
  _endRecord() {
    if (!this.seen && this.row.length === 0 && this.field === '') { this.startLine = this.line; this.chars = 0; return; } // blank line
    this._endField();
    const row = this.row; const at = this.startLine;
    this.row = []; this.seen = false; this.chars = 0; this.startLine = this.line;
    this.onRow(row, at);
  }
  _newline(c) { this.line++; if (c === '\r') this.skipLF = true; this._endRecord(); }
  feed(text, final = false) {
    let i = 0; const n = text.length;
    if (this.pendingQuote) { // a quote ended the previous chunk while inside quotes
      this.pendingQuote = false;
      if (n && text[0] === '"') { this.field += '"'; i = 1; } else this.mode = 2;
    }
    for (; i < n; i++) {
      const c = text[i];
      if (this.skipLF) { this.skipLF = false; if (c === '\n') continue; }
      if (++this.chars > this.max) throw new IngestError('A record is over the 8 MiB limit.', this.startLine);
      if (this.mode === 1) {
        if (c === '"') {
          if (i + 1 < n) { if (text[i + 1] === '"') { this.field += '"'; i++; } else this.mode = 2; }
          else if (final) this.mode = 2; else this.pendingQuote = true;
        } else { if (c === '\n') this.line++; this.field += c; }
        continue;
      }
      if (c === this.d) { this._endField(); continue; }
      if (c === '\n' || c === '\r') { this._newline(c); continue; }
      if (this.mode === 2) throw new IngestError('Unexpected text after a closing quote.', this.line);
      if (c === '"') {
        if (this.field.length) throw new IngestError('A quote may only start at the beginning of a field.', this.line);
        this.mode = 1; this.seen = true;
      } else this.field += c;
    }
    if (final) {
      if (this.pendingQuote) { this.pendingQuote = false; this.mode = 2; }
      if (this.mode === 1) throw new IngestError('A quoted field does not close before the end of the file.', this.startLine);
      if (this.row.length || this.field.length || this.seen) this._endRecord();
    }
  }
}

// Unique, trimmed, non-empty column names; blanks become column_N, repeats get _2, _3...
export function cleanHeaders(values) {
  if (values.length > 4096) throw new IngestError('The header has more than 4096 fields.', 1);
  const used = new Set();
  return values.map((raw, i) => {
    const base = String(raw ?? '').trim() || `column_${i + 1}`;
    let name = base, k = 2;
    while (used.has(name)) name = `${base}_${k++}`;
    used.add(name);
    return name;
  });
}

// Count of delimiter candidates outside quotes on the first lines; ties go to comma.
export function detectDelimiter(sample) {
  let best = ',', bestScore = -1;
  for (const d of [',', '\t', ';', '|']) {
    const lines = sample.split(/\r?\n/).filter(Boolean).slice(0, 12);
    const counts = lines.map((l) => { let q = false, k = 1; for (const c of l) { if (c === '"') q = !q; else if (c === d && !q) k++; } return k; });
    const score = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}
