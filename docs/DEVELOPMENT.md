# Development and reproducibility

## Current environment

The repository is static source, documentation, browser experiments, test scripts, and pinned artifacts. It has no package manifest, installed dependency tree, or build system. No dependency installation is required for repository inspection or the existing Node.js tests. Browser experiments require a modern browser with Worker and OPFS support and a secure same-origin context; `localhost` is normally considered secure.

## Node.js regression tests

From the repository root, with Node.js available:

```sh
node tests/lfcp-optimized-string-writer-fix.cjs
node tests/lfcp-variable-length-string-roundtrip.cjs
```

The scripts exercise the isolated candidate and pinned vendor. The variable-length regression includes behavior designed to reproduce the known vendor defect; read the script header and its JSON evidence before treating a nonzero result as an unexpected test failure. Corresponding retained records are in `benchmarks/results/`.

## Browser experiments

Follow [`architecture/BROWSER-VALIDATION.md`](architecture/BROWSER-VALIDATION.md) and the README files alongside each experiment. Serve only on loopback for local checks. The first spike can be served with Python's standard-library server from the repository root:

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080/experiments/lfcp-first-spike/`. Its validation page is under `experiments/lfcp-first-spike/validation/`. Browser results are environment-specific; preserve their original result JSON and metadata. Avoid tests that use real user data or external services.

The LFC-pack candidate browser harness is under `experiments/fixes/lfc-pack-0.4.19-string-writer/browser-validation/`; Phase 8 qualification has its own README and harness. These do not qualify the project across browsers.

## Vendor and artifact rules

Treat `vendor/lfcp/0.4.19/` as an immutable source artifact. Verify its SHA-256 against `PROVENANCE.md` before investigating changes. Candidate JavaScript and Wasm files under `experiments/fixes/` are experimental artifacts and must not replace the canonical file. Preserve licensing notices and the retained evidence manifests. The historical upstream Wasm build provenance is incomplete; see the Phase 11 package and Phase 14 handoff record.

## Migration-time verification

Migration verification on 2026-11-05:

- `node tests/lfcp-optimized-string-writer-fix.cjs` passed 19/19 candidate cases in an isolated copy after changing only the output filename to avoid overwriting its already-present result. Its pinned-vendor controls reproduced failures in 8 cases.
- `node tests/lfcp-variable-length-string-roundtrip.cjs` was run against the canonical vendor and returned its documented defect result: 98 failed checks. This reproduces the known issue and is not a clean passing run.
- The unstaged `git diff --check` passed. The staged import check identified one existing trailing blank line at the end of the preserved Phase 12 issue draft (`phase12-issue-review/ISSUE-DRAFT.md`); it was left unchanged to preserve the historical draft.
- All 40 entries in the Phase 11 package manifest matched their recorded SHA-256 values.
- The canonical vendor artifact and byte-preserved standalone spike copy both matched SHA-256 `8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259`. Candidate JavaScript and Wasm matched their recorded Phase 14 hashes.
- The original standalone spike and its repository snapshot each contained 10 files; every corresponding file matched byte for byte.
- The publication scan found no credential patterns, dependency caches, or files larger than 5 MiB. Five retained benchmark JSON files contain absolute Termux paths as execution metadata; those files were preserved without edits.

No generated caches or dependency directories are required. Do not rewrite historical JSON records to normalize absolute local paths; those paths are part of the recorded execution metadata.

## New code checks (added 2026.11.05, Claude branch)

- `node tests/run.mjs`: Node pass/fail gate, about 5 seconds, 14 checks. Writes nothing into the repo.
- `python3 tests/browser-run.py firefox|chromium|webkit`: opens `app/index.html?selftest=1&report=1` in one test browser (Firefox 158, ungoogled Chromium 155.0.8059.39, WebKitGTK 2.52.6 from the knowledge-base `browsers` branch), prints a plain-text result, exits 0 only on PASS. Needs `FIREFOX` and `CHROMIUM` set; webkit needs `xvfb-run`, `dbus-run-session` and `WebKitWebDriver`. Run one browser at a time. Pass/fail only; no speed claims.
- Latest results: `/mnt/project-files/lfc-workbench/browser-results/` (all three PASS on 2026.11.05).

## Big-file check (added 2026.11.06)

`python3 tests/browser-run.py firefox|chromium|webkit "bigtest=300" 400` generates a deterministic CSV of about 300 MB (7,000,716 rows; on disk in OPFS where the browser has it, in memory otherwise), imports it, opens the data view, checks the first rows, the last row after scrolling to the end, a middle row, then filters to the last 10 rows, sorts the whole file by id and by score (empties last) and checks the rows shown. Filter and sort read only the columns they need (`src/query/columnar.mjs`), so 7 million rows work. Pass/fail; the phase times in the report are informational only, from one run each. Results: `/mnt/project-files/lfc-workbench/browser-results/*-bigfile-300MB-*.txt`.

## One-file build (added 2026.11.06)

`node tools/build-single.mjs OUT.html` writes the whole page (code, styles, worker, LFC-pack 0.7.2) as one 455 KB `.html` file that opens by double-click, with a CSP that names the exact hashes of its inline script and style (no `unsafe-inline`). `--test` adds a loopback reporting hook; `python3 tests/browser-run.py chromium|firefox|webkit "selftest=1" 90 --file=OUT.html` runs it from `file://`. Results 2026.11.06: Chromium and Firefox PASS from `file://`; Chromium keeps data in memory only there (no OPFS on `file://`) and says so; WebKitGTK from `file://` fails reading the chosen file inside the worker ("I/O read operation failed"), so Safari-family browsers need the page hosted over http(s).

`python3 tests/browser-run.py all selftest=1 60` runs Firefox, Chromium and WebKitGTK one after another, always all three, and exits 1 if any failed. Line 1 of each run names the driver (Firefox and Chromium are launched directly, no Playwright, so first-open timing is not distorted; WebKitGTK uses WebKitWebDriver and is never used for timing). Timing comparisons that decide a card ("more than 5% slower") should use `qa-guide/ab-sequential/BRIEF-adopt.md`; the numbers in this repo's reports are single runs and informational.
