# Reproduction guide

The original minimal input fixtures are included in fixtures/. The browser runner is qa-runner.html. It creates a same-origin frame of the audited app and invokes the app’s existing worker API with inline imports; it does not patch app source or use a remote service.

## Run the browser probes

From the repository root, serve the checkout over localhost:

    python3 -m http.server 8080

Open this page in Chromium:

    http://127.0.0.1:8080/docs/handoffs/WORKBENCH-BUG-AUDIT-2026-11-15/qa-runner.html

Select “Run all probes”. Keep the page on the same localhost origin so it can load the app and local fixtures. The runner reports observed values and marks each known defect as reproduced or not reproduced. “Reproduced” means the current behavior matched the defect description; it is not a test pass for corrected behavior. The app iframe and browser storage are used only in that browser profile. The runner attempts to remove every successfully imported fixture dataset when it finishes. For automated headless Chromium execution from the repository root, run:

    CHROMIUM=/path/to/chromium python3 tests/browser-run.py chromium autorun=1 90 --http=docs/handoffs/WORKBENCH-BUG-AUDIT-2026-11-15/qa-runner.html

The browser runner serves the checkout on loopback and collects the diagnostic report. Its harness-completion result is separate from the per-finding BUG REPRODUCED/NOT REPRODUCED labels.

For a manual fallback, open app/index.html in the same checkout and import the fixture named in each item below. Inspect the displayed schema/sample; for WB-04 open the dataset and export CSV. Do not use the historical LFC-pack 0.4.19 experiment as the reproduction target.

## Finding-to-fixture map

| Finding | Fixture and trigger | Expected | Actual on audited source |
|---|---|---|---|
| WB-01 | bad-crc.zip; import the ZIP containing data.csv | Reject stale CRC | Import completes and row value is zlpha, not alpha |
| WB-02 | offset-dimension.xlsx; sheet dimension B1:C3 | Columns id,label with both values | column_1,id; label is lost |
| WB-03 | unsafe.json and unsafe.ndjson | Exact id 9007199254740993 or explicit precision warning | Readback id is 9007199254740992; unsafe.csv control preserves the text |
| WB-04 | late-field.ndjson; final of 2,001 records adds extra | Include extra in schema and export, or reject changing schema | Catalog/export contain id only; late-value is omitted |
| WB-05 | dot-collision.json | Preserve both keys distinctly or reject | One trip.distance column remains with value 2; top-level 1 is lost |
| WB-06 | custom-date-reversed-attrs.xlsx; compare standard.xlsx | Custom date serial becomes 2024-01-01 | Custom date remains integer 45292; built-in style control works |
| WB-07 | windows1252-late.csv; compare windows1252-early.csv | Import and preserve é in both files | Early control imports; late file fails strict UTF-8 decoding |

## Reproduction details

- bad-crc.zip is a 131-byte stored ZIP entry. Its payload was altered without updating its CRC. The generated LFCP footer can still validate because that check validates the written dataset, not the source ZIP checksum.
- offset-dimension.xlsx is a small valid workbook with headers id,label in columns B and C. The failure is coordinate alignment, not a malformed workbook.
- unsafe.json contains id 9007199254740993 and a 25-digit amount; unsafe.ndjson contains the same unsafe id. unsafe.csv contains the same id as text.
- late-field.ndjson contains rows id 0 through 1999 followed by id 2000 with extra equal to late-value. The underlying raw LFCP round-trip retained all rows, but schema-limited CSV export omitted the late field.
- dot-collision.json contains a literal trip.distance key and nested trip.distance path in the same object.
- custom-date-reversed-attrs.xlsx is compared with standard.xlsx to isolate custom format attribute order from general Excel support.
- windows1252-early.csv and windows1252-late.csv are each 6,000,239 bytes. The late file places byte 0xE9 beyond the 4 MB sample used for files smaller than 12 MB; the early file is a positive control.

All fixture bytes are included here and their SHA-256 values are listed in SOURCE-MANIFEST.sha256. The original temporary app.js probes were not copied: they modified the audited app entry point to add test hooks and depended on a temporary /qa-fixtures route. qa-runner.html is a standalone replacement that leaves application source unchanged.
