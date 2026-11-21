# Follow-up audit: group-by proposals against current main

**Current base:** Workbench main `764e5c5` (2026-11-21). This supersedes the original handoff’s `562acc2` source baseline and the prior audit at `d6199e5`. Re-read current `src/query/groupby.mjs`, `app/worker.js`, `tests/groupby-derive.test.mjs`, and `tests/run.mjs` before implementation.

## Audit finding

The two proposed allocation targets remain present in current main:

1. `groupBy()` constructs `gid = new Uint32Array(m)` before checking the numeric dense path. When `fusedDense()` accepts the aggregates, it returns its result directly and never reads `gid`. The successful path therefore still pays for the unused four-bytes-per-selected-row buffer. The existing dense numeric tests cover output values, but do not assert that this buffer is absent.
2. Cold uncoded `groupBy2()` calls `keyIds()` twice. Each uncached key creates `new Uint32Array(n)`, even when `rows.length` is much smaller than `n`. Filtered calls are not entered in the reusable full-column cache, but their temporary arrays still scale with the full source column. The current test uses a 2,000-row selection over 5,000 rows and does not measure or assert allocation length.

The current source still has both allocation patterns described above. The intervening main work improved parsing, wide-file Save packing in PR #111, and early-chart feedback in PR #112. PRs #113–#117 added a laptop race tester with H4/H6 files, an early-chart on/off switch, parse-thread sweep, a quick default run, and a Stop button that preserves partial results. Those are useful whole-import and Save controls; they do not implement or measure the two `groupby.mjs` allocations. PR #82 likewise fixed a worker flatness check and explicitly made no speed-path change. Keep parser, early-chart, Save, and group-by results separate.

The laptop tester's current quick/full plans compare Workbench with DuckDB and report import stages. Do not treat a DuckDB win or loss as evidence about `groupBy()` or cold filtered `groupBy2()`. Use that tester only as a separate macro-level check after a direct group-by result exists.

## Claude sequence

**DBE-01, one-key path only:** add an isolated allocation assertion for successful `fusedDense()` and for each fallback branch. Cover no selection and filtered selections; eligible integer keys at both sides of the range bound; count-only, one/two numeric sum or average columns; and fallback aggregates (`min`, `max`, `rate`, too many columns, nonnumeric input). Compare keys, first-appearance order, counts, NaN handling, and aggregate order with the current function and a small oracle. Only then move `gid` allocation below the fused return. Keep allocation instrumentation outside timing runs.

**DBE-02, two-key path only:** make cold filtered key IDs O(`m`) without confusing selection position with source row number. Keep full-column cache entries and supplied dictionary IDs row-indexed. Add separate cache/selection representations if needed; never put compact filtered IDs into the full-column cache. Cover cold, warm, filter-after-warm, repeat-filter, cache-disabled, sixth/seventh eviction, supplied IDs for either/both keys, empty selection, and 100%, 50%, 10%, 1%, and 0.1% selections in ascending, descending, and seeded-shuffle order. Include dense, forced-map, packed-open-addressing, and large Map fallback controls. Preserve each path’s current ordering; the `(a,x), (b,y), (b,x)` fixture must record dense and forced-map order separately.

Do not start DBE-03 (direct aggregate-state updates) until DBE-01 and DBE-02 have independent evidence and a remaining measured target. If either target is neutral or fails a control, record a no-go rather than stacking changes.

## Qualification and delivery

Use the original matrix in `TEST-MATRIX.md` and protocol in `BENCHMARK-PROTOCOL.md`, but reset the source baseline to `764e5c5`. Run `node tests/groupby-derive.test.mjs` and the current repository gate only after code changes. Time direct calls separately from worker message/dispatch calls on the same data, because the current worker has changed substantially while the group-by source has not. Keep generated input and row selection outside the timed region. Record raw browser samples and allocation ledgers; do not infer Worker peak memory from main-realm telemetry. Use current approved Chromium, Firefox and WebKitGTK builds one at a time. The early-chart toggle and race tester should remain off the DBE-01/02 timing path, then serve as explicit controls for any app-level end-to-end follow-up.

This is a follow-up plan only. No group-by code or tests were changed in this audit, and no current browser measurements were run.
