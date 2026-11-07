# Deep dive: spike code and ingest path (2026.11.05)

Read line by line: `worker.js`, `app.js`, `src/adapters.js`, `index.html`, the architecture and LFCP docs. Facts below were checked by running code, not only read.

## How the spike ingests
Parse (CSV/TSV with `DelimitedParser`, or JSONL line by line) into JS objects, re-serialize each as a JSON line, push the bytes into `LfcPack.packStream`, write the returned parts to OPFS, finish with the footer, close. So rows are parsed once by us and parsed again by the packer. Every CSV column is typed `string`; there is no number, date or null inference, so CSV numbers are stored and compared as text.

## Findings
1. **The empty-string bug hits the real CSV path.** Empty cells are normal in CSV. `tests/csv-roundtrip.test.mjs` shows a CSV whose text column starts with one empty cell and has varied values comes back with data shifted on 0.4.19 and lossless on 0.4.21. It is shape-dependent: columns that start with two empties, and several other shapes, were fine in my cases. Never assume a given file is safe.
2. **Blank lines break import.** `a,b\n1,2\n\n3,4\n` parses to a one-field row, and the worker rejects it as ragged. Real exports often have a blank line at the end or between sections. Ingestion core must define a rule (skip fully empty lines, report the line number).
3. **Only the first 128 columns are recorded in metadata, and profiling stops at 256 columns.** Fine for a spike, wrong for a data tool; flag it visibly.
4. **"Complete" means the last four bytes are `LFC1`.** That is weaker than reading and validating the footer.
5. **Inspection loads the whole file (64 MiB cap).** No range reads yet.
6. **Delimiter detection** picks the highest average field count over 12 lines; quoted text with many commas can fool it.
7. **Stage hooks, heap sampling and gating are mixed into the import function.** This is test scaffolding inside product logic; it should become an injectable observer in the real code.
8. **Style:** one 250-line function, `var` and IIFE, no modules. Not a base to extend.

## Decision
The spike stays frozen as reference. The ingestion core is built new in `src/` as ES modules with the findings above as acceptance tests. The new code uses LFC-pack 0.4.21.

## Added with this note
- `tests/csv-roundtrip.test.mjs`: real ingest-path fidelity, run for 0.4.21 (must pass) and 0.4.19 (informational, must show loss).
- `tests/run.mjs` now has 9 checks.
