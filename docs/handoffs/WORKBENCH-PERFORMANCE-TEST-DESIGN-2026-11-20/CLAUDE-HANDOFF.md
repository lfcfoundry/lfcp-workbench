# Claude assignment: improve Workbench grouping with measured evidence

Read the adjacent `README.md`, `TEST-MATRIX.md`, `BENCHMARK-PROTOCOL.md`, and `RESULTS-TEMPLATE.md` before coding. This assignment is based on current Workbench `main` at `562acc2`, not the older 0.13.3 study snapshot. Verify the active base and re-read `src/query/groupby.mjs`, `app/worker.js`, `tests/groupby-derive.test.mjs`, and `tests/run.mjs` first.

## Goal

Test and, where the evidence supports it, improve the one-key fused allocation and cold filtered two-key grouping memory use. Keep DBE-01 and DBE-02 as separate candidate changes. Do not implement DBE-03 unless both first candidates have independent results and a remaining measured target warrants it.

## Sequence

1. **Record the baseline.** Confirm the fused-path allocation and filtered `keyIds` lengths on this source revision. Capture current dense versus forced-map output order on the adversarial sequence in the matrix. Treat ordering as a behavior question; do not silently alter it.
2. **DBE-01.** Add a focused allocation regression proving that the successful `fusedDense` branch does not allocate the unused per-row `gid`. Exercise eligible and fallback cases from the matrix. Move the allocation only if behavior and fallback controls remain unchanged. Benchmark it using the protocol.
3. **DBE-02.** Add tests for cold uncoded filtered grouping, cache hits after filters, dictionary IDs, empty selections, shuffled rows, path thresholds, and aggregates. Prototype a selection-aligned ID representation for filtered uncoded keys. Keep dictionary IDs and reusable full-column cache entries row-indexed; do not cache a compact selection-specific array as if it covered the full column. Preserve current baseline output ordering for each grouping strategy.
4. **DBE-03 only if justified.** In a separate experiment, compare direct state updates with the current group-ID and aggregate scans. Reject it if correctness changes, gains do not repeat, or controls regress beyond the stated gate.

## Required checks

- Run `node tests/groupby-derive.test.mjs` and the repository's `node tests/run.mjs` gate after code changes. Add no timing assertions to these tests.
- Run the isolated browser performance harness in Chromium and every available Firefox/WebKit engine. Keep browser timing separate from Node timings and report unavailable engines explicitly.
- Measure direct function timing and worker-level timing separately if the worker path changes. Do not include data generation, import, OPFS, rendering, or browser startup in the timed function call.
- Use the paired A/B protocol, report raw data and p50/p90 with intervals, and complete a `RESULTS-TEMPLATE.md` copy for each candidate.

## Boundaries and delivery

- Work on an isolated Codex candidate branch/worktree. Do not modify `main`, the LFCP format, vendor artifacts, dependencies, import/export semantics, or the unrelated WB correctness audit.
- Keep every optimization behind its own testable diff. Preserve selection behavior, dictionary-ID paths, empty/missing-value handling, aggregate order, and baseline group ordering.
- If a benchmark is neutral, noisy, or engine-specific, say so and leave the unproven optimization out. Do not transfer DuckDB measurements or claim browser memory bounds from source arithmetic.
- Return the exact base/candidate commits, changed files, test commands/results, raw evidence paths, browser/device coverage, result decision, and remaining limitations. Do not push to `main`.
