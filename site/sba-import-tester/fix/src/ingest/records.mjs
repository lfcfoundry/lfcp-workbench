// Turn delimited text into header + record objects + suggested column types.
// Values stay exact text from the file. Whole-text helper for tests and small
// inputs; the streaming path uses DelimitedParser directly with the same rules.
import { DelimitedParser, IngestError, cleanHeaders } from './delimited.mjs';
import { TypeTracker } from './infer.mjs';

export function readRecords(text, delimiter = ',') {
  let headers = null, trackers = null; const records = [];
  new DelimitedParser(delimiter, (fields, line) => {
    if (!headers) { headers = cleanHeaders(fields); trackers = headers.map(() => new TypeTracker()); return; }
    if (fields.length !== headers.length) throw new IngestError(`Row has ${fields.length} fields but the header has ${headers.length}.`, line);
    const rec = Object.create(null);
    for (let i = 0; i < headers.length; i++) { rec[headers[i]] = fields[i]; trackers[i].add(fields[i]); }
    records.push(rec);
  }).feed(text, true);
  if (!headers) throw new IngestError('The file has no header row.');
  return { headers, records, types: headers.map((name, i) => ({ name, type: trackers[i].type, nullable: trackers[i].nullable })) };
}
