# Test and build results

Results below are from the audited source commit 9efaac4d56506207ee2d8833961bb613cc7ecfd8. The application source was extracted to a temporary review copy for these runs; no app or vendored file in this branch was changed.

## Environment

- Node.js 26.13.1
- Python 3.14.10
- Chromium 157
- Chromium OPFS support: available in the tested context
- Firefox and WebKit/WebKitWebDriver: unavailable

## Results

| Check | Result | Notes |
|---|---|---|
| node tests/run.mjs | PASS — 80/80 | Existing Node gate; no checks were removed or skipped. |
| tools/build-single.mjs with --test | PASS | Generated a 1,027,684-byte single-file HTML build in temporary storage. It is not included in this handoff. |
| Chromium self-test | PASS | Exercised import, validation, query, export, worker paths, awkward text/column names, and OPFS. |
| Single-file file:// self-test | PASS | Opened the built page and completed its self-test using the build’s expected storage fallback. |
| 300 MB Chromium workload | PASS | 7,000,716 rows; import/footer validation, first/middle/last pages, filters, sorts, and scrolling checks completed. |
| Handoff qa-runner.html | PASS as a diagnostic harness | In Chromium 157, all seven known defect signatures reproduced and the built-in XLSX and early-byte encoding controls passed. The harness PASS means execution completed; it is not a claim that the application is correct. |
| Firefox | BLOCKED | Firefox binary/driver unavailable. |
| WebKit | BLOCKED | WebKitWebDriver unavailable. |

The successful broad tests do not disprove the seven defects: those paths were not covered by the existing suite. The minimal fixtures and qa-runner.html are provided to reproduce them.

## Important coverage limit

The Node suite’s FIXED vendor list in tests/run.mjs ends at 0.10.42 and does not directly verify the active 0.13.3 pin. The Chromium application self-test did exercise the current 0.13.3 worker path. Add direct current-pin regression coverage when the fixes are implemented.

## Browser scope

Only Chromium was available for the application browser tests. This report makes no claim that the full application passes across all browsers. Firefox and WebKit should be tested after the fixes in environments that provide those browsers.
