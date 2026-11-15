# Confirmed bug register

All seven findings below were reproduced against commit 9efaac4d56506207ee2d8833961bb613cc7ecfd8 with the fixtures in this directory. “Fix direction” is a proposal for investigation, not an implemented correction or a mandated design.

| ID | Severity | Area | Confirmed behavior | Primary evidence |
|---|---|---|---|---|
| WB-01 | P0 | ZIP ingestion | An entry with a stale CRC is imported successfully and changed payload bytes are accepted. | app/worker.js:623-656; fixtures/bad-crc.zip |
| WB-02 | P0 | XLSX ingestion | A valid worksheet range beginning at column B loses/misplaces columns. | app/worker.js:720-740; fixtures/offset-dimension.xlsx |
| WB-03 | P0 | JSON/NDJSON fidelity | Unsafe integers are rounded silently during import/readback. | app/worker.js:775-789; vendor/lfcp/0.13.3/lfc-pack.js:254; fixtures/unsafe.json and unsafe.ndjson |
| WB-04 | P0 | NDJSON schema/export | A field first appearing after row 2,000 is absent from the discovered schema and CSV export. | app/worker.js:757-789, 928-930, 1273-1306; fixtures/late-field.ndjson |
| WB-05 | P0 | Nested JSON flattening | A literal dotted key colliding with a flattened nested key silently loses one value. | app/worker.js:758-766; fixtures/dot-collision.json |
| WB-06 | P2 | Excel date formats | A valid custom date format is missed when XML attributes are in a different order. | app/worker.js:676-685; fixtures/custom-date-reversed-attrs.xlsx |
| WB-07 | P2 | Encoding detection | A Windows-1252 byte after the sampled prefix causes a valid file to fail import. | app/worker.js:586-600, 742-754; fixtures/windows1252-late.csv |

## WB-01 — ZIP CRC validation defect

**Trigger:** Import fixtures/bad-crc.zip. Its stored data.csv payload was changed from “alpha” to “zlpha” without updating the ZIP CRC.

**Expected:** Reject the entry as corrupt before accepting its rows.

**Actual:** Import returns done, the stored row contains “zlpha”, and Workbench’s LFCP footer validation passes. The source archive’s integrity failure is not reported.

**Root cause:** unzipFile reads method and sizes from the central directory but does not retain or check the CRC. The stored-entry path returns the slice directly. The deflate path checks uncompressed length only.

**Proposed fix direction:** Validate CRC and actual sizes for stored and deflated entries before the dataset is accepted. Consider whether zipList should surface integrity status. Add corrupted stored and deflated fixtures; do not treat a valid LFCP output footer as proof that the ZIP source was valid.

## WB-02 — XLSX starting-column offset defect

**Trigger:** Import fixtures/offset-dimension.xlsx. Its worksheet dimension is B1:C3; the two headers are id and label in columns B and C.

**Expected:** Preserve both columns and their row values, with schema id,label.

**Actual:** Workbench produced columns column_1,id; the label column was lost.

**Root cause:** The parser computes width as the span from the dimension’s start to end column, then supplies only that width. Cell references remain absolute column indexes, so the parser’s coordinate origin and allocated width disagree.

**Proposed fix direction:** Define and test the worksheet coordinate origin, including leading blank cells and non-A starts, before choosing a remapping strategy. Add cases starting at B, C, and columns beyond Z, with gaps and multiple rows.

## WB-03 — Unsafe JSON integer precision loss

**Trigger:** Import fixtures/unsafe.json and fixtures/unsafe.ndjson. They include id 9007199254740993; the JSON fixture also contains amount 1234567890123456789012345. fixtures/unsafe.csv is a text-preserving control.

**Expected:** Preserve exact integer tokens or report explicitly that exact numeric fidelity cannot be maintained.

**Actual:** The imported/read-back id is 9007199254740992. The amount becomes approximately 1.2345678901234568e+24. The CSV control preserves the id as the string “9007199254740993”.

**Root cause:** The JSON path converts numeric tokens to JavaScript Number values. The pinned LFC-pack JSON-lines reader uses JSON.parse, which cannot represent arbitrary-precision integers exactly. The Workbench does not warn about the conversion.

**Proposed fix direction:** Decide an explicit JSON-number contract. Preserve unsafe tokens as text or reject/warn before loss; then verify the behavior through schema discovery, LFCP writing, readback, and export. Do not solve one import path while leaving another lossy.

## WB-04 — Late NDJSON fields omitted from schema and export

**Trigger:** Import fixtures/late-field.ndjson. It has 2,001 rows; only the last row contains extra with value late-value.

**Expected:** Include extra in the dataset schema and CSV export, or clearly reject a changing schema.

**Actual:** The Workbench catalog exposes only id. A raw LFCP round-trip check confirms all 2,001 records still exist, but the normal CSV export omits the extra header and late-value. This is silent loss in the exported view.

**Root cause:** parseNdjson discovers headers by scanning at most the first 2,000 lines. Later export uses the discovered columns.

**Proposed fix direction:** Establish a schema policy for late keys. Either discover/retain them or fail with a clear validation result before a narrower export can be mistaken for a complete one. Test late fields at boundaries 1,999, 2,000, and 2,001, and verify both stored rows and exported output.

## WB-05 — Nested JSON flattened-key collision

**Trigger:** Import fixtures/dot-collision.json, which contains both a top-level trip.distance value of 1 and a nested trip object with distance value 2.

**Expected:** Preserve both values under unambiguous names, or reject the ambiguous input.

**Actual:** Both paths map to trip.distance; import succeeds with one column and value 2. The top-level value 1 is gone.

**Root cause:** The one-level flattening transform maps nested paths to dotted names without checking collisions against literal dotted keys.

**Proposed fix direction:** Define an unambiguous escaping/path convention or reject collisions. Add reversed-key-order, multi-row, and multi-level cases. Verify no value is silently replaced.

## WB-06 — Excel custom date format depends on XML attribute order

**Trigger:** Import fixtures/custom-date-reversed-attrs.xlsx, whose valid numFmt element places formatCode before numFmtId.

**Expected:** Recognize the custom date style and interpret serial 45292 as 2024-01-01, matching the standard built-in date control.

**Actual:** The custom value remains integer 45292. The standard.xlsx control with a built-in date style imports as 2024-01-01.

**Root cause:** parseStyles’ regular expression requires numFmtId to precede formatCode, although XML attribute order is not semantically significant.

**Proposed fix direction:** Parse attributes independent of order (or use an appropriate XML parser), and test multiple attribute orders, quoted format literals, and date/time styles.

## WB-07 — Late Windows-1252 byte missed by UTF-8 sampling

**Trigger:** Import fixtures/windows1252-late.csv. It is about 6 MB, with a Windows-1252 0xE9 byte after the first 4 MB. The matching early-byte fixture is the control.

**Expected:** Convert the valid Windows-1252 file to UTF-8 and preserve “é”, or report an explicit encoding choice if auto-detection is ambiguous.

**Actual:** The early control imports and displays “é”. The late-byte file is treated as UTF-8 and fails later with a fatal “encoded data was not valid” TextDecoder error; no dataset is committed.

**Root cause:** notUtf8 samples the first 4 MB for files under 12 MB, while the subsequent normal decoding is strict.

**Proposed fix direction:** Revisit whole-stream detection and ambiguity policy for large inputs. Test late bytes, valid multibyte UTF-8 near sample boundaries, and files whose byte sequences are valid under both encodings. Avoid silently corrupting text while broadening detection.

## Separate product/security decision: formula-like CSV values

The current documented CSV export intentionally preserves exact values and does not escape spreadsheet formulas. This is not one of the seven confirmed bugs. Values originating in untrusted files may be interpreted as formulas by spreadsheet software. Claude must not silently change this CSV behavior; any safe-export mode or warning needs a separate product decision and round-trip compatibility review.
