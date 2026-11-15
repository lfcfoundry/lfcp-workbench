# Controlled fix plan

This is a proposed order, not an implementation. Claude should verify each finding against the current source and LFC-pack 0.13.3 before choosing a correction.

## Stage 0 — Establish a reproducible baseline

1. Confirm the implementation base is the audited commit and record any newer source changes before starting.
2. Run the existing Node suite and Chromium self-test. Verify the fixture hashes in SOURCE-MANIFEST.sha256.
3. Convert each reproduction into a test with explicit expected behavior. Keep the browser probes as diagnostics, not as substitutes for focused regression tests.

## Stage 1 — Prevent silent corruption and loss

Treat each item as an isolated change with its own tests and review:

- WB-01: validate ZIP CRC and size for stored and deflated entries. Cover valid controls, stale CRCs, truncated entries, and size mismatches. Reject before cataloging a dataset.
- WB-03: define exact behavior for JSON numbers beyond the safe integer range. Test JSON array, wrapped JSON, NDJSON, LFCP readback, and CSV export. Preserve exact tokens or give an explicit error/warning before precision is lost.
- WB-04: define schema behavior when new keys appear late. Test rows around the 2,000-line boundary, full dataset round-trip, grid schema, and CSV export. Never silently emit a narrower export.
- WB-05: define an unambiguous policy for flattened names. Test both key orders, multi-row input, collisions with existing literal dotted keys, and round-trip output.
- WB-02: correct worksheet coordinate handling for non-A1 ranges. Test B/C starts, columns beyond Z, empty leading cells, gaps, and dimensions inconsistent with actual cells.

Do not bundle these unrelated corrections into one refactor. Preserve format compatibility where possible and document any unavoidable format or schema change.

## Stage 2 — Correct interpretation and encoding

- WB-06: parse custom number-format attributes without depending on XML attribute order. Test built-in and custom date, time, and date-time styles, quoted literals, and reordered attributes.
- WB-07: define a full-file encoding detection policy that works for large files and late invalid UTF-8. Test early and late Windows-1252 bytes, valid UTF-8 multibyte sequences at sample boundaries, malformed/truncated UTF-8, and ambiguous byte sequences. Avoid turning valid UTF-8 into mojibake.

## Stage 3 — Verify integration and release quality

1. Run focused regressions after each isolated fix, then the full Node suite.
2. Exercise the browser worker and storage path, including malformed inputs and interrupted/error paths.
3. Confirm source and exported values agree, and verify the LFCP output footer after successful imports.
4. Test at least Chromium; qualify Firefox and WebKit where available. Report browser gaps explicitly.
5. Run the large workload only after correctness tests; do not mix performance optimization into these fixes.
6. Review current 0.13.3 vendor behavior and add direct tests for the active pin, rather than relying only on historical vendor versions.

## Separate CSV product decision

CSV formula escaping remains a separate product/security decision. The current behavior intentionally preserves exact values. Do not alter it as part of WB-01–WB-07 or silently change round-trip semantics. Any safe-spreadsheet export mode or warning needs its own compatibility decision and tests.
