# Claude handoff prompt — LFCP Workbench bug audit

You are being asked to independently review and address seven reproduced LFCP Workbench defects. Begin with the source and test artifacts in this directory. Do not treat the proposed fix directions as prescribed implementations.

## Source and evidence

The investigation audited GitHub branch claude/project-thread-tb9b0d at commit 9efaac4d56506207ee2d8833961bb613cc7ecfd8. The active Workbench dependency at that commit is vendored LFC-pack 0.13.3. Read CURRENT-STATE.md before touching code. Run qa-runner.html and consult BUG-REGISTER.md and REPRODUCTION.md for the exact triggers, expected behavior, and observed behavior.

The seven findings are:

1. WB-01 P0: ZIP entries with stale CRCs are accepted; the altered payload is imported.
2. WB-02 P0: XLSX worksheets whose dimension begins after column A lose or misplace columns.
3. WB-03 P0: JSON/NDJSON unsafe integers are silently rounded by JavaScript numeric parsing.
4. WB-04 P0: NDJSON keys first appearing after row 2,000 are omitted from schema and CSV export.
5. WB-05 P0: a literal dotted JSON key can collide with the dotted name created by nested-object flattening, losing a value.
6. WB-06 P2: custom Excel date detection depends on numFmt XML attribute order.
7. WB-07 P2: Windows-1252 bytes after the first 4 MB are missed by UTF-8 sampling for files under 12 MB, causing a valid file to fail later decoding.

All seven were reproduced on the audited source. The existing test results were 80/80 Node checks, successful build and Chromium tests, and a successful 300 MB Chromium workload. Firefox and WebKit were unavailable; do not claim full cross-browser testing.

## Assignment

1. Inspect the current source, the seven fixtures, and the LFC-pack 0.13.3 behavior. Confirm the source revision you are working from and reconcile any changes since the audited commit.
2. Add focused regression coverage before or alongside each correction. Keep each defect isolated and testable; avoid unrelated refactoring and performance work.
3. Prioritize silent data corruption and data loss. Verify stored and deflated ZIP integrity, define explicit unsafe-JSON integer behavior, prevent late NDJSON keys from silently disappearing, resolve flattened-key collisions without dropping either value, and correct XLSX positions for non-A1 starts.
4. Correct custom date-format parsing independent of XML attribute order. Revisit large-file encoding detection with late invalid UTF-8 bytes and valid UTF-8 boundary controls.
5. Test malformed, truncated, and boundary inputs. Verify round-trip fidelity, schema, export, LFCP footer validation, cancellation/error cleanup, and supported browser paths.
6. Inspect compatibility implications and choose the safest correction; do not blindly implement a suggested direction.
7. Report each correction with its regression test, before/after behavior, and browser coverage.

## Constraints

- Do not modify the audited Claude branch or overwrite any existing Claude worktree.
- Keep product fixes on an isolated implementation branch/worktree.
- Do not add remote services, telemetry, or cloud dependencies.
- The raw CSV export intentionally preserves exact values and does not escape spreadsheet formulas. Treat formula escaping as a separate product/security decision; do not silently change CSV semantics as part of these seven fixes.
- The handoff branch is documentation and evidence only. Do not add production changes to it.
