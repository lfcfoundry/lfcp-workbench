# Claude assignment: evaluate DuckDB-informed Workbench group-by opportunities

Review this handoff independently before changing code. The audited Workbench source is `claude/project-thread-tb9b0d` at `9efaac4d56506207ee2d8833961bb613cc7ecfd8`, with vendored LFC-pack 0.13.3. Confirm the current implementation base first and reconcile any intervening changes. This branch contains research documentation only.

Read [OPPORTUNITIES.md](OPPORTUNITIES.md) and inspect the linked Workbench and DuckDB source. The DuckDB comparison is pinned to v2.0.0. Do not transfer its benchmark results or implement DuckDB-specific architecture by analogy.

## Assignment

1. Independently verify DBE-01: `groupBy` allocates `gid` before `fusedDense` can return, although the successful fused path does not use `gid`. If still true, measure the benefit of moving the allocation after the fusion check. Keep the general path unchanged.
2. Independently verify DBE-02: a cold, uncoded, filtered `groupBy2` may allocate one full-`n` ID vector per key while processing only selected rows. Test a compact selection-aligned ID representation and measure retained cache bytes/hit rate. Preserve the current dictionary-ID path and unfiltered reuse unless evidence supports changing them.
3. Only after the first two measurements, consider DBE-03: compare the existing group-ID-plus-rescan pipeline with direct state updates for other one-key/two-key cases. Keep this as an isolated experiment; reject it if output semantics change or the performance/memory result is not repeatable.
4. Inspect the existing studies linked from `OPPORTUNITIES.md` before proposing more DuckDB ideas. The decimal, staged-column, Top-N/zone-map, `IN` set, perfect-hash, dictionary-code, and reader-buffer themes have already been studied or implemented. Do not repackage them as new work.

For each candidate, add focused correctness tests before or alongside any code change. Preserve first-seen group order, exact grouping keys, selection order, duplicates where permitted, empty/missing values, NaN handling, aggregation order, and rate denominators. Benchmark baseline and candidate on the same browser/device/runtime with explicit workload shapes, repetitions, time and memory measurements. Report Chromium/Firefox/WebKit availability separately; Node or Android/Termux correctness runs do not qualify browser performance.

Do not combine this work with the WB-01 through WB-07 data-correctness fixes. Do not add DuckDB or another dependency, modify LFCP format semantics, or claim improvement until the local Workbench experiment supports it. Keep any implementation in a separate isolated branch/worktree and provide the exact commit, tests, measurements, limitations, and rejected candidates for review.
