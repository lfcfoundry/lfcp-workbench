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
  constructor(delimiter, onRow, { maxRecordChars = 8 * 1024 * 1024, noQuote = false } = {}) {
    if (typeof delimiter !== 'string' || delimiter.length !== 1 || /["\r\n]/.test(delimiter)) throw new IngestError('The delimiter must be one ordinary character.');
    this.d = delimiter; this.onRow = onRow; this.max = maxRecordChars; this.nq = !!noQuote;   // noQuote: a quote mark is an ordinary character (space-separated lists such as pageview dumps)
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
    // Fast path: plain stretches are copied with one slice instead of one character at a time. Same rules and errors as the character-by-character reader.
    let i = 0; const n = text.length, D = this.d.charCodeAt(0), max = this.max;
    if (this.pendingQuote) { // a quote ended the previous chunk while inside quotes
      this.pendingQuote = false;
      if (n && text.charCodeAt(0) === 34) { this.field += '"'; i = 1; } else this.mode = 2;
    }
    while (i < n) {
      if (this.skipLF) { this.skipLF = false; if (text.charCodeAt(i) === 10) { i++; continue; } }
      if (this.mode === 1) { // inside quotes: copy up to the next quote, counting line breaks
        const q = text.indexOf('"', i), stop = q < 0 ? n : q;
        if (stop > i) {
          const seg = text.slice(i, stop);
          for (let k = seg.indexOf('\n'); k >= 0; k = seg.indexOf('\n', k + 1)) this.line++;
          this.field += seg; this.chars += stop - i;
          if (this.chars > max) throw new IngestError('A record is over the 8 MiB limit.', this.startLine);
        }
        if (q < 0) { i = n; break; }
        if (++this.chars > max) throw new IngestError('A record is over the 8 MiB limit.', this.startLine);
        if (q + 1 < n) { if (text.charCodeAt(q + 1) === 34) { this.field += '"'; i = q + 2; } else { this.mode = 2; i = q + 1; } }
        else { if (final) this.mode = 2; else this.pendingQuote = true; i = q + 1; }
        continue;
      }
      let j = i; // modes 0 and 2: find the next delimiter, line break or quote
      const nq = this.nq; while (j < n) { const c = text.charCodeAt(j); if (c === D || c === 10 || c === 13 || (c === 34 && !nq)) break; j++; }
      if (j > i) {
        if (this.mode === 2) throw new IngestError('Unexpected text after a closing quote.', this.line);
        this.field += text.slice(i, j); this.chars += j - i;
        if (this.chars > max) throw new IngestError('A record is over the 8 MiB limit.', this.startLine);
      }
      if (j >= n) { i = n; break; }
      if (++this.chars > max) throw new IngestError('A record is over the 8 MiB limit.', this.startLine);
      const c = text.charCodeAt(j); i = j + 1;
      if (c === D) this._endField();
      else if (c === 34) {
        if (this.mode === 2) throw new IngestError('Unexpected text after a closing quote.', this.line);
        if (this.field.length) throw new IngestError('A quote may only start at the beginning of a field.', this.line);
        this.mode = 1; this.seen = true;
      } else this._newline(c === 13 ? '\r' : '\n');
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
  if (bestScore <= 1 && spaceDelimited(sample)) return ' ';   // none of the usual delimiters occurs: a file of single-space separated fields
  return best;
}

// Space-separated values (for example "en Main_Page 1234 5678"): at least 5 lines, every line with the same number of single-space fields (no empty field),
// and either 3 or more fields or one field that is a number on every line. Plain text with a varying number of words never qualifies. The last line of the
// sample is ignored since the sample may end in the middle of it.
export function spaceDelimited(sample) {
  const all = sample.split(/\r?\n/); if (all.length > 1) all.pop();
  const lines = all.filter((l) => l.trim()).slice(0, 12);
  if (lines.length < 5) return false;
  const plain = lines.map((l) => l.split(' '));
  const quoted = lines.map((l) => { const r = []; let f = '', q = false; for (const c of l) { if (c === '"') { q = !q; f += c; } else if (c === ' ' && !q) { r.push(f); f = ''; } else f += c; } r.push(f); return r; });
  return consistent(plain) || (lines.some((l) => l.includes('"')) && consistent(quoted));
}
function consistent(rows) {
  const k = rows[0].length; if (k < 2) return false;
  for (const r of rows) { if (r.length !== k) return false; for (const f of r) if (f === '') return false; }
  if (k >= 3) return true;
  for (let c = 0; c < k; c++) if (rows.every((r) => /^-?\d+(\.\d+)?$/.test(r[c]))) return true;
  return false;
}
