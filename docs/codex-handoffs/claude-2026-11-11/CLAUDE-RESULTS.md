Copyright (c) 2026 LFC Foundry. MIT License.

# Claude results (2026-11-11)

**No Workbench vendor change.** No current defect reproduced. Docs-only commit.

| Check | Result |
|---|---|
| `app/worker.js` and `tools/build-single.mjs` import | `vendor/lfcp/0.7.2/lfc-pack.js` |
| `vendor/lfcp/0.7.2/lfc-pack.js` SHA-256 | `747df574c3f90f54443c2d24645f39a9962560ee3b0a71cf179dffa9702eee84` (matches FINDINGS.md) |
| `vendor/lfcp/0.4.19/lfc-pack.js` SHA-256 | `8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259` (matches) |
| `node docs/codex-handoffs/claude-2026-11-11/evidence/vendor-empty-first.cjs vendor/lfcp/0.4.19/lfc-pack.js vendor/lfcp/0.7.2/lfc-pack.js` | exit 0; output identical to the recorded `evidence/vendor-empty-first-results.json` (0.4.19 fails empty-first; 0.7.2 passes all three cases) |
| `node --test tests/ingest-lfcp.test.mjs` | 1/1 pass |
| `node tests/run.mjs` | 42/42 checks pass |

Note: running the evidence script with no arguments ends in an assertion error; it needs the two vendor paths, as TEST-EVIDENCE.md shows.

Historical 0.4.19 empty-first defect: kept separate, unchanged (format major 1 / minor 0 compatibility unaffected). The LOW finding (ingest test text says 0.6.2) is left as is; it is a message, not a defect. Browser import tests were **NOT RUN**.

The new JS-modules lfc-pack 0.9.0 pool options (byte limits, cancel) are not used by Workbench; Workbench import backpressure stays an experiment for later (see JS-modules PERFORMANCE-VALIDATION.md, rank 2).
