/* Small streaming source adapters for the LFCP feasibility spike. */
(function (root) {
  'use strict';

  function DelimitedParser(delimiter, onRow, maxRecordChars) {
    this.delimiter = delimiter;
    this.onRow = onRow;
    this.maxRecordChars = maxRecordChars || 8 * 1024 * 1024;
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.pendingQuote = false;
    this.afterQuote = false;
    this.skipLF = false;
    this.recordChars = 0;
  }

  DelimitedParser.prototype.endField = function () {
    if (this.row.length >= 4096) throw new Error('A delimited record has more than the 4096-field prototype limit.');
    this.row.push(this.field);
    this.field = '';
    this.afterQuote = false;
  };

  DelimitedParser.prototype.endRow = function () {
    this.endField();
    var row = this.row;
    this.row = [];
    this.recordChars = 0;
    this.onRow(row);
  };

  DelimitedParser.prototype.feed = function (text, final) {
    var i = 0;
    if (this.pendingQuote) {
      this.pendingQuote = false;
      if (text.charAt(0) === '"') {
        this.field += '"';
        i = 1;
      } else {
        this.inQuotes = false;
        this.afterQuote = true;
      }
    }
    for (; i < text.length; i++) {
      var c = text.charAt(i);
      this.recordChars++;
      if (this.recordChars > this.maxRecordChars) throw new Error('A delimited record is over the 8 MiB prototype limit.');
      if (this.skipLF) {
        this.skipLF = false;
        if (c === '\n') continue;
      }
      if (this.inQuotes) {
        if (c === '"') {
          if (i + 1 < text.length) {
            if (text.charAt(i + 1) === '"') { this.field += '"'; i++; this.recordChars++; }
            else { this.inQuotes = false; this.afterQuote = true; }
          } else if (!final) this.pendingQuote = true;
          else { this.inQuotes = false; this.afterQuote = true; }
        } else this.field += c;
        continue;
      }
      if (this.afterQuote) {
        if (c === this.delimiter) { this.endField(); continue; }
        if (c === '\n' || c === '\r') { this.endRow(); if (c === '\r') this.skipLF = true; continue; }
        throw new Error('Unexpected text after a closing quote in a delimited record.');
      }
      if (c === '"') {
        if (this.field.length) throw new Error('A quote may only start at the beginning of a delimited field.');
        this.inQuotes = true;
      } else if (c === this.delimiter) this.endField();
      else if (c === '\n' || c === '\r') { this.endRow(); if (c === '\r') this.skipLF = true; }
      else this.field += c;
    }
    if (final) {
      if (this.pendingQuote) { this.pendingQuote = false; this.inQuotes = false; this.afterQuote = true; }
      if (this.inQuotes) throw new Error('A quoted field does not close before the end of the file.');
      if (this.row.length || this.field.length || this.afterQuote) this.endRow();
    }
  };

  function cleanHeaders(values) {
    if (values.length > 4096) throw new Error('The header has more than the 4096-field prototype limit.');
    var used = Object.create(null);
    return values.map(function (raw, i) {
      var base = String(raw || '').trim() || ('column_' + (i + 1));
      if (base.length > 512) throw new Error('A column name is over the 512-character prototype limit.');
      var name = base, n = 2;
      while (used[name]) name = base + '_' + n++;
      used[name] = true;
      return name;
    });
  }

  function detectDelimiter(sample) {
    var candidates = [',', '\t', ';', '|'];
    var best = ',', bestScore = -1;
    for (var c = 0; c < candidates.length; c++) {
      var rows = sample.split(/\r?\n/).slice(0, 12).filter(Boolean);
      var counts = rows.map(function (row) { return row.split(candidates[c]).length; });
      var score = counts.length ? counts.reduce(function (a, b) { return a + b; }, 0) / counts.length : 0;
      if (score > bestScore) { best = candidates[c]; bestScore = score; }
    }
    return best;
  }

  root.DataWorkbenchAdapters = { DelimitedParser: DelimitedParser, cleanHeaders: cleanHeaders, detectDelimiter: detectDelimiter };
})(typeof self !== 'undefined' ? self : this);
