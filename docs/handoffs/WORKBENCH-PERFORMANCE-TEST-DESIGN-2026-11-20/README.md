# Workbench group-by performance test design

**Purpose:** give Claude a current, evidence-led plan to test and improve the Workbench's one-key and two-key grouping paths. This branch contains design documents only; it makes no performance claim and changes no application code.

## Source baseline

The plan is based on GitHub `main` at `562acc2` (`Group by works on wide files whose short last block is stored nested`, 2026-11-20). The grouping source is `src/query/groupby.mjs`; the worker enforces the 20,000,000-row column limit and calls the grouping functions from `app/worker.js`.

The earlier DuckDB opportunity note was written against `9efaac4` and LFC-pack 0.13.3. Current `main` has advanced and pins LFC-pack 0.14.2. The `groupby.mjs` source is unchanged from that study base, so the first two allocation findings remain visible; Claude must still recheck the source and its call sites before coding.

## Findings to test

| ID | Source observation | Candidate benefit | Status |
|---|---|---|---|
| DBE-01 | `groupBy` allocates `gid` before the eligible `fusedDense` call can return. That successful path does not read `gid` (`groupby.mjs:61, 67–68`). | Avoid one `Uint32Array(m)`: 4 × `m` bytes. At 20 million rows, the maximum is 80,000,000 bytes (about 76.3 MiB). | Source-confirmed; benefit not measured. |
| DBE-02 | A cold, uncoded `keyIds` call allocates `Uint32Array(n)` and writes selected rows into it, even when only `m` rows are processed (`groupby.mjs:124–136`). Two such key arrays may cost 8 × `n` bytes; the current six-entry cache can retain six full arrays. | Make temporary filtered IDs proportional to selection size, without changing dictionary IDs or reusable full-column cache entries. | Source-confirmed; benefit not measured. |
| DBE-03 | General grouping builds a row-to-group array and then scans it for counts and aggregates. | Explore direct state updates only if the first two leave a worthwhile gap. Random state writes may be slower. | Hypothesis only; defer. |

These are typed-array byte counts derived from source, not observed peak browser memory, RSS, or elapsed-time improvements.

## Important behavior question

`groupBy2`'s dense path emits populated slots in slot order; its forced-map path emits groups as they are first encountered. Those orders can differ for adversarial pair sequences. Existing tests check group membership and values but do not assert pair order. Before making ordering claims, record the exact baseline for each path and determine the intended application contract. A performance patch must match the baseline for its path; any desired ordering correction is a separate correctness change.

## Documents

- [Test matrix](TEST-MATRIX.md) — correctness cases, boundary permutations, and coverage gaps.
- [Benchmark protocol](BENCHMARK-PROTOCOL.md) — fair timing and memory measurement rules and adoption gates.
- [Results template](RESULTS-TEMPLATE.md) — fields to fill for every candidate.
- [Claude handoff](CLAUDE-HANDOFF.md) — ordered assignment and delivery requirements.

## Scope

Keep each candidate isolated. Do not add DuckDB, alter LFCP or query semantics, combine these experiments with the WB correctness audit, or treat a Node pass as browser-performance qualification. Begin with DBE-01, then DBE-02. Leave DBE-03 unimplemented unless measured results justify a separate experiment.
