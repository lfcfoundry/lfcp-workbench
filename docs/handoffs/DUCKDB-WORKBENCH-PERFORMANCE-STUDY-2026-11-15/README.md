# DuckDB-informed Workbench efficiency study — 2026-11-15

This is a docs-only research handoff for Claude. It studies DuckDB's grouped aggregation code for transferable performance and memory ideas in LFCP Workbench. It does not include a Workbench code change or claim a measured speedup.

## Source base

- Workbench: `lfcfoundry/lfcp-workbench`, branch `claude/project-thread-tb9b0d`, commit `9efaac4d56506207ee2d8833961bb613cc7ecfd8`.
- The GitHub Claude branch tip was rechecked on 2026-11-15 and still matched that commit.
- Workbench uses vendored LFC-pack 0.13.3 at this commit.
- DuckDB source reviewed: tag `v2.0.0`. Its implementation details and benchmarks are version-specific and do not establish Workbench performance.

## Recommended next work

1. Remove an avoidable `Uint32Array` allocation from Workbench's single-key dense fused path. The array is allocated before the fused path returns and is never read on that path. This is a source-confirmed allocation opportunity; its runtime benefit has not been measured.
2. Measure and reduce full-dataset key-ID arrays on filtered two-key summaries. On a cold uncoded path, `keyIds` allocates one `Uint32Array(n)` for each key even when it processes only `rows.length` selected rows. The application permits grouping up to 20 million rows. The retained cache is limited to six columns, not a byte budget.
3. As a separate experiment, compare state updates during group lookup with the current per-row group-ID array plus later aggregate passes. DuckDB's hash aggregate updates group states while consuming input chunks; a Workbench version must prove a benefit and preserve ordering and null semantics.

These are hypotheses for isolated tests. See [OPPORTUNITIES.md](OPPORTUNITIES.md) for source locations, prior research, memory arithmetic, and a validation plan. [CLAUDE-HANDOFF.md](CLAUDE-HANDOFF.md) is a paste-ready assignment.

## Prior work not to repeat

The audited Workbench already has staged column ingestion, exact fixed-point decimal handling, top-N with block min/max skipping, an `IN`-style set filter, dense/perfect-hash grouping, and dictionary-code grouping. Previous LFC-pack research already tested dictionary-code equality and rejected a general dispatch rule under its older pinned versions. Prior buffer-capacity experiments also measured and rejected one smaller reader-buffer floor. Those results are summarized with links in [OPPORTUNITIES.md](OPPORTUNITIES.md).

## Scope

DuckDB is used only as a source of implementation patterns. Do not add DuckDB or another dependency, transfer DuckDB benchmark numbers, or combine performance work with the seven correctness fixes in the bug-audit handoff. No application source, vendor file, generated artifact, existing worktree, or Claude branch was changed for this study.
