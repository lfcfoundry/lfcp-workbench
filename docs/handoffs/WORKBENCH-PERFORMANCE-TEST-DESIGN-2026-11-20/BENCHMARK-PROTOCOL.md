# Group-by benchmark protocol

## Compare like with like

- Baseline source: GitHub `main` at `562acc2` unless Claude records a newer base and repeats the source audit. Record the candidate commit and exact diff.
- Generate deterministic columns and row selections before timing. Use a fixed seed and reusable string labels; do not include fixture creation, CSV parsing, LFCP decoding, OPFS, message setup, or UI rendering in the group-function timer.
- Measure both a direct function call and, when an optimization changes worker integration, one worker-level request. Keep those results separate.
- Run correctness assertions before collecting timings. Run allocation instrumentation in a separate pass; instrumentation can perturb the timed code.
- Use synthetic data only. Do not record user data or post reports to an external service.

## Workload sets

Keep the matrix bounded and report every omitted cell.

| Set | Sizes and variants | Purpose |
|---|---|---|
| One-key fusion | `n = 100k, 1m, 7m`, then the largest safe size up to 20m; `rows = null`, 10%, and 1%; eligible and fallback aggregate lists. | Show whether removing the unused `gid` changes latency and temporary allocation as `m` grows. |
| Two-key filtered | `n = 100k, 1m, 7m`, then the largest safe size up to 20m; `m/n = 100%, 50%, 10%, 1%, 0.1%`, plus empty selection. Cold uncoded keys are the target; add warm-cache and dictionary controls. | Test scaling with `m` versus `n` and characterize the no-win full-selection control. |
| Cardinality controls | Small deterministic fixtures below/at/above `DENSE_SLOTS`, `forceMap`, and feasible cases at the `2^31` slot-path boundary. | Detect strategy-specific correctness and costs without conflating cardinality with row count. |
| Aggregate controls | Count-only, one numeric aggregate, multiple numeric aggregates, rate, and mixed aggregates. | Detect costs from output count and repeated aggregate scans. |

For large cases, start with numeric typed keys or repeated references to a small string pool. Account for the pre-existing input and `rows` selection memory separately. Stop a size ramp if the browser becomes unstable; do not retry crash-producing cells until the environment has recovered.

## Runtime and repetition

Use Node for deterministic correctness and allocation-count checks. Qualify performance in actual browser engines: Chromium, Firefox, and WebKit where available. Record exact browser/version, OS/device, CPU class, reported hardware concurrency, memory where available, power mode, and whether the call ran on the main thread or in a Worker. Mark unavailable engines; do not infer their results.

For each browser/workload cell:

1. Run at least five warm-ups outside the measured sample.
2. Collect at least 20 paired baseline/candidate trials for small cells and 10 pairs for the largest safe cells. Balance AB and BA order within the same session; keep cache-cold and cache-warm trials in separate labeled groups.
3. Report every trial or a lossless raw JSON record, plus p50, p90, min/max, and a paired effect interval. Do not report only the best run or pool unlike devices/engines.
4. Repeat on a second session for any claimed win that is near the decision threshold. State when only one device was available.

## Memory and allocation reporting

Record logical typed-array allocations by type, length, and call site in a separate instrumented run. For DBE-01, report the `4 × m` `gid` bytes removed on the fused path and confirm fallbacks still allocate what they need. For DBE-02, report the two key-ID buffers, `gid`, output arrays, and reusable cache bytes separately.

Also capture runtime memory telemetry when available, but label its scope. Main-realm `performance.memory` sampling does not measure Worker peak memory; GC timing and process RSS vary by engine. Never turn source arithmetic or sampled heap values into a claim of bounded end-to-end memory.

## Decision gates

- **Correctness is mandatory:** every relevant deterministic and differential case passes, with baseline-compatible output order and values.
- **DBE-01:** the fused path demonstrably avoids the `gid` buffer. Adopt if its measured latency is not materially worse on the fused path and fallback controls stay within 5% of baseline at p50 and p90; a statistically neutral latency result is acceptable for the deterministic memory saving.
- **DBE-02:** sparse cold-filter allocations must scale with `m`, not `n`, and the allocation ledger must show the expected reduction. Adopt only if target filtered workloads improve by at least 5% in p50 or have a large, demonstrated memory reduction with no greater than 5% p50/p90 regression in full-selection, warm-cache, dictionary, or fallback controls.
- **DBE-03:** require a repeatable improvement in its declared target cells and no semantic change. Otherwise record a no-go.

Treat 5% as the pre-registered material-regression threshold, not as permission to ignore confidence intervals. If the interval straddles the threshold, report the result as inconclusive and gather more paired trials or leave the candidate unadopted.

## Evidence format

Use [RESULTS-TEMPLATE.md](RESULTS-TEMPLATE.md). Preserve raw results, generated fixture parameters, seeds, exact commands, and source hashes in the candidate branch. Keep timing results out of correctness test assertions. No DuckDB timing is a Workbench baseline; no new dependency is needed.
