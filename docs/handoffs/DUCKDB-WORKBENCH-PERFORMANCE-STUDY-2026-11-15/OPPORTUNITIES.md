# Findings and experiment plan

## Audited implementation

The source base is Workbench commit [`9efaac4`](https://github.com/lfcfoundry/lfcp-workbench/tree/9efaac4d56506207ee2d8833961bb613cc7ecfd8), the latest `claude/project-thread-tb9b0d` tip checked on 2026-11-15. The active reader is vendored LFC-pack 0.13.3. The relevant Workbench implementation is [`src/query/groupby.mjs`](https://github.com/lfcfoundry/lfcp-workbench/blob/9efaac4d56506207ee2d8833961bb613cc7ecfd8/src/query/groupby.mjs), called by [`app/worker.js`](https://github.com/lfcfoundry/lfcp-workbench/blob/9efaac4d56506207ee2d8833961bb613cc7ecfd8/app/worker.js#L1380-L1402).

`groupBy` already has a dense slot path for integral keys in a small range and a `fusedDense` path for count plus sum/average of up to two numeric columns. `groupBy2` already uses dictionary IDs when supplied, a bounded dense Cartesian slot space, and an open-addressed table for packed key IDs. These are existing features, not new proposals. The source comment credits a `DUCKDB-GROUP-BY-2026.11.15.md` note, but that file is absent from the audited commit. The checked-in `tests/groupby-derive.test.mjs` exercises result correctness; no standalone Workbench `groupBy2` performance benchmark/report was present in the handoff and research/result files reviewed here.

## Ideas already studied or implemented

| Idea | Evidence | Disposition for this handoff |
|---|---|---|
| Parse into columnar storage without first building row objects/text | Workbench `docs/CREDITS.md`, `src/ingest/columns.mjs`, and `src/ingest/colbuild.mjs` | Already implemented. Do not propose as new. |
| Exact scaled-integer decimal columns | Workbench `docs/CREDITS.md` and `src/ingest/infer.mjs` | Already implemented with text fallback for values that would not round-trip. |
| Bounded Top-N plus block min/max pruning | Workbench `src/query/topn.mjs` and `docs/CREDITS.md` | Already implemented. |
| Set-based one-of filtering | Workbench `src/query/query.mjs` and `docs/CREDITS.md` | Already implemented. |
| Dense/perfect-hash numeric grouping, two-key packed slots, and dictionary-ID grouping | Workbench `src/query/groupby.mjs` | Already present in the audited source; the source comment's supporting note is missing. No new proposal to add perfect hashing. |
| Keep encoded dictionary values through equality predicates | [Phase 12 report](https://github.com/lfcfoundry/knowledge-base/blob/1fdacb10c0c5ef9744cc9c1d5b1024b840dde2da/docs/research/compression-and-data-performance/EXPERIMENT-PHASE-12-REPORT-2026-11-12.md), [Phase 13 report](https://github.com/lfcfoundry/knowledge-base/blob/1fdacb10c0c5ef9744cc9c1d5b1024b840dde2da/docs/research/compression-and-data-performance/EXPERIMENT-PHASE-13-REPORT-2026-11-12.md) | Already researched. Phase 12 measured a narrow detached path; Phase 13 rejected a safe general dispatch because pinned public metadata lacked per-value frequencies. Those experiments used Workbench 0.7.2 and LFC-pack 0.8.3, so recheck APIs before relying on the result for 0.13.3. |
| Dictionary/selection vectors and short-string prefix comparisons | [Phase 13 source catalog](https://github.com/lfcfoundry/knowledge-base/blob/1fdacb10c0c5ef9744cc9c1d5b1024b840dde2da/docs/research/compression-and-data-performance/PHASE13-UPSTREAM-SOURCE-CATALOG-2026-11-12.md), [independent source audit](https://github.com/lfcfoundry/knowledge-base/blob/1fdacb10c0c5ef9744cc9c1d5b1024b840dde2da/docs/research/compression-and-data-performance/LZ4-1.11-INDEPENDENT-SOURCE-AUDIT-2026-11-12.md) | Already studied as design comparators. Do not repeat a generic dictionary-vector pitch. The selection-sized IDs below are a distinct Workbench allocation question. |
| Reader buffer floors, capacities, and ownership | [Phase 15 report](https://github.com/lfcfoundry/knowledge-base/blob/1fdacb10c0c5ef9744cc9c1d5b1024b840dde2da/docs/research/compression-and-data-performance/EXPERIMENT-PHASE-15-REPORT-2026-11-12.md), [Phase 16 report](https://github.com/lfcfoundry/knowledge-base/blob/1fdacb10c0c5ef9744cc9c1d5b1024b840dde2da/docs/research/compression-and-data-performance/EXPERIMENT-PHASE-16-REPORT-2026-11-12.md) | Already measured for the pinned LFCP reader. Phase 16 rejected a 16 KiB WASM buffer floor: small cases saved scratch bytes, but measured protected read regressions. Its Node/Android timings do not qualify browser performance. |

The knowledge-base source references above are pinned to commit `1fdacb10c0c5ef9744cc9c1d5b1024b840dde2da`; the corresponding remote research branch matched that commit. A pre-existing edit and untracked bytecode cache in that research worktree were left untouched.

## DuckDB source review

The code review is pinned to DuckDB tag [`v2.0.0`](https://github.com/duckdb/duckdb/tree/v2.0.0); these details are not claims about every DuckDB version.

- [`GroupedAggregateHashTable::AddChunk`](https://github.com/duckdb/duckdb/blob/v2.0.0/src/execution/aggregate_hashtable.cpp#L366-L396) hashes an input group chunk, finds or creates group states, then updates aggregate states for that chunk. The fallback path likewise finds group addresses and updates states in [`AddChunk`](https://github.com/duckdb/duckdb/blob/v2.0.0/src/execution/aggregate_hashtable.cpp#L697-L714). The Workbench equivalent currently materializes one group ID per row on its general paths, then scans those IDs for counts and each aggregate.
- DuckDB has a narrow compressed-group fast path for all-constant groups or one dictionary vector, then falls back to hashing raw values: [`TryAddCompressedGroups`](https://github.com/duckdb/duckdb/blob/v2.0.0/src/execution/aggregate_hashtable.cpp#L597-L621). Workbench already has dictionary-ID grouping, so this is evidence for the principle, not a duplicate implementation request.
- DuckDB also has a clustered aggregate-state update path when group addresses are suitably clustered: [`UpdateAggregatesClustered`](https://github.com/duckdb/duckdb/blob/v2.0.0/src/execution/aggregate_hashtable.cpp#L622-L661). A run-aware Workbench experiment could be considered only after simpler memory improvements are measured; source code alone does not show that JavaScript benefits.
- The physical operator passes input chunks to its hash table in [`PhysicalHashAggregate::Sink`](https://github.com/duckdb/duckdb/blob/v2.0.0/src/execution/operator/aggregate/physical_hash_aggregate.cpp#L377-L426). DuckDB's vector docs describe fixed-size vectors, dictionary/constant/sequence representations, and selection vectors: [Execution Format](https://duckdb.org/docs/2.0/internals/vector). These are engine-specific abstractions; Workbench should preserve its current row-selection and value semantics.
- DuckDB's [memory-management article](https://duckdb.org/2024/07/09/memory-management) explains that chunked streaming avoids materializing all input, but high-cardinality aggregation can still grow its group state and may need spilling. No spill subsystem or DuckDB dependency is proposed for this browser-first application.

## Candidate DBE-01 — Do not allocate `gid` on the fused dense path

**Source evidence:** In `src/query/groupby.mjs`, `groupBy` constructs `gid = new Uint32Array(m)` at line 61 before checking the dense fast path. It calls `fusedDense(...)` at line 67 and returns at line 68 when that implementation supports the aggregate list. That successful branch never reads `gid`. JavaScript typed-array construction reserves/initializes a backing buffer, so the raw avoidable buffer is `4 × m` bytes.

At the app's `MAX_COLUMN_ROWS` of 20,000,000, the upper-bound raw buffer is 80,000,000 bytes (76.3 MiB). This is an allocation calculation, not a measured RSS or latency result. Move creation of `gid` until after the fused path has declined, then verify source semantics and measure the path. Keep the fallback behavior unchanged.

**Validation:** Compare fused results for count-only and count plus sum/average, one and two numeric columns, no selection and selected rows, empty input, all-empty numeric values, and first-appearance key order. Capture allocation/ArrayBuffer and latency in a same-runtime before/after experiment. Do not infer a speedup from the avoided byte count alone.

## Candidate DBE-02 — Make two-key IDs proportional to selected rows; budget retained cache by bytes

**Source evidence:** `groupView` can apply filters and pass a `rows` selection to `groupBy2` (`app/worker.js:1387-1398`); the same function rejects datasets only above 20,000,000 rows (`app/worker.js:1385`). In `keyIds` (`src/query/groupby.mjs:124-137`), `m` is set to `rows.length` when selected rows exist, but a cache miss allocates `new Uint32Array(n)` and writes IDs only at selected positions. `groupBy2` then allocates a separate `Uint32Array(m)` for `gid` (`src/query/groupby.mjs:139-170`). For two uncoded keys on a cold filtered call, the two key-ID buffers can therefore consume `8 × n` bytes even when `m` is small, plus `4 × m` for `gid`.

At `n = 20,000,000`, those two raw key-ID buffers are 160,000,000 bytes (152.6 MiB), before `gid`, labels, aggregation arrays, decoded columns, or JavaScript object overhead. When no selection is present, the cache can retain up to six full key-ID buffers: `24 × n` bytes, or 480,000,000 bytes (457.8 MiB) at the app row cap, before those other costs. This is a source-derived upper bound, not a measured peak. The six-entry count limit is not a memory budget.

**Proposed experiment:** On a filtered call with no cached or LFCP dictionary IDs, build compact IDs aligned to selection position (`m`) rather than original row index (`n`); use those compact IDs while composing two-key group slots. Preserve the existing full-column cache path for repeated unfiltered summaries until measurements show an alternative. Separately measure the cache's retained byte total and hit rate; if a cap is warranted, set it in bytes with an explicit eviction policy rather than choosing an unverified cap here.

**Validation:** Cover unfiltered and sparse/dense filtered rows; empty, reversed, and duplicate selections where accepted; dictionary-coded versus ordinary keys; cache miss/hit/eviction; repeated calls; first-seen output order; empty strings, missing numeric values, and high cardinality. Confirm aggregate values and exported summary are identical. Measure peak/retained ArrayBuffer bytes and query latency, not only array lengths.

## Candidate DBE-03 — Prototype direct aggregate-state updates outside the existing fused case

The current general `groupBy`/`groupBy2` paths first assign per-row group IDs, then count and scan again for aggregates. `fusedDense` computes directly without reading group IDs for one narrow class (integral single key with count/sum/average and at most two numeric columns), but `groupBy` still allocates `gid` before taking that path; DBE-01 covers that separate waste. Do not duplicate the existing fused calculation. DuckDB's chunk `AddChunk` path suggests a separate experiment: update count/sum/average/min/max/rate state as each row's group is resolved, or process groups in chunks. This could avoid `gid` and repeated full scans, but hash lookups and state writes may cost more than the current typed-array pass. It is **unmeasured and not a confirmed improvement**.

If tested, compare one-key string keys, two-key keys, dictionary IDs, low/high cardinality, sorted/run-clustered and shuffled rows, no filters and sparse selections, and one/multiple aggregates. Include correctness checks for exact group order, null/NaN behavior, rate denominators, sums and averages, plus peak memory and total time. Keep a fallback for workloads where the fused path loses.

## Measurement rules

- No DuckDB timing or benchmark number transfers to Workbench.
- Compare the same Workbench commit, fixtures, browser version, device, and workload; report warm/cold conditions and repetitions.
- Separate correctness tests from performance qualification. A Node pass or an Android/Termux result is not browser performance qualification.
- Use Chromium, Firefox, and WebKit where available; name unavailable browsers and avoid a blanket all-browser claim.
- Do not add a dependency, alter the LFCP format, change import/export semantics, or bundle these experiments with WB-01–WB-07 correctness fixes.
