// CSV writer for the Workbench export. Plain RFC 4180: fields holding the delimiter, a quote, CR or LF are
// quoted and quotes are doubled; every other value is written exactly as stored. No spreadsheet-formula
// escaping and no byte-order mark, so the file reads back identically through our own CSV reader.
export function csvField(v, delimiter = ',') {
  const s = v == null ? '' : String(v);
  return s.includes(delimiter) || /["\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// rows: arrays of values, in column order. Returns one string ending with the line break.
export function csvLines(rows, delimiter = ',', eol = '\r\n') {
  let out = '';
  for (const r of rows) { let line = ''; for (let i = 0; i < r.length; i++) line += (i ? delimiter : '') + csvField(r[i], delimiter); out += line + eol; }
  return out;
}
export function csvHeader(columns, delimiter = ',', eol = '\r\n') { return csvLines([columns.map((c) => c.name)], delimiter, eol); }
