# Current audited state

## Exact source identity

- GitHub repository: lfcfoundry/lfcp-workbench
- Audited branch: claude/project-thread-tb9b0d
- Audited commit: 9efaac4d56506207ee2d8833961bb613cc7ecfd8
- Audit date: 2026-11-15
- Current GitHub tip was checked before this handoff was created and matched the audited commit.
- The latest branch was 80 commits beyond origin/main and 121 commits beyond the November 11 Claude handoff; one commit on the old handoff was not on this branch.
- This handoff branch is based directly on the audited commit. It does not change or check out the Claude branch.

The latest non-merge development includes XLSX/XLSM sheet selection, shared strings, and dates; gzip, ZIP, JSON/NDJSON, and UTF-16 input; group-by improvements; and worker reuse and save-failure cleanup. The source-tree difference against origin/main is concentrated in app/app.js, app/index.html, and app/worker.js.

## Application structure

- app/index.html is the browser entry page.
- app/app.js implements the page controls, worker request coordination, grid, filtering/sorting, and export actions.
- app/worker.js is the classic import/query worker and coordinates parsing, format conversion, LFC-pack persistence, and page/query responses.
- src/ingest contains delimited parsing, type inference, and column construction.
- src/query contains query execution, positions, typed/top-N sorting, columnar access, grouping, and derived columns.
- src/export/csv.mjs writes CSV output.
- tools/build-single.mjs creates the optional single-file HTML build.

The app is browser-first and local-first: input is processed in the browser and datasets are stored through its browser storage path. The product path does not add a remote service or telemetry dependency.

## Active LFC-pack dependency

The worker imports vendor/lfcp/0.13.3/lfc-pack.js at app/worker.js:3. The single-file builder reads the same pinned file at tools/build-single.mjs:18. Its provenance records version 0.13.3 and source reference 480d71d from JS-modules main. The inspected vendor file was byte-identical to the file at the audited commit.

The earlier 0.4.19 string-writer reproduction is historical context only. It was not used as evidence for the seven findings in this handoff.

## Test state and caveats

At the audited commit, node tests/run.mjs reported 80/80 checks passing. The app built successfully, Chromium browser checks passed, and the 300 MB workload completed. The seven bug-specific fixtures were then reproduced separately. Firefox and WebKit were not available, so no all-browser claim is made. See [TEST-RESULTS.md](TEST-RESULTS.md).

The existing test suite’s fixed-vendor list stops at 0.10.42; it does not directly pin-check 0.13.3. The browser self-test did exercise the active 0.13.3 path, but the automated Node vendor matrix should be reviewed.

## Documentation drift

Several repository documents still describe the project as a feasibility-only spike, cite older LFC-pack versions, or understate the test/build setup. Treat those descriptions and the November 11 handoff as historical where they conflict with this commit’s code and test results.
