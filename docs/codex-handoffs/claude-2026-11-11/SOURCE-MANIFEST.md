Copyright (c) 2026 LFC Foundry. MIT License.

# Source manifest

Parent/live-main revision: `ede629220610dd536259fc0645dc968668a5f64c`. No existing source/vendor file changed. Relevant files already in the repository:

| Repository path | Role | SHA-256 / provenance |
|---|---|---|
| `vendor/lfcp/0.7.2/lfc-pack.js` | Current worker vendor | `747df574c3f90f54443c2d24645f39a9962560ee3b0a71cf179dffa9702eee84`; source commit `1aabf448f75f64fe2599f917a05b3a210548c0ba`, blob `f47777cbd279e14a4ffd4d49c803418466c1ad68` |
| `vendor/lfcp/0.4.19/lfc-pack.js` | Historical defective vendor | `8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259`; source commit `6e16aa8044d0a05bafa7c756c949f3537c23e92a`, blob `dae1cf4a7d9f6f568ea05447f57e9158e7396091` |
| `app/worker.js`, `tools/build-single.mjs`, `tests/ingest-lfcp.test.mjs` | Current integration/test paths | Parent commit files, unchanged |

Added handoff files are the six status/task documents, `evidence/vendor-empty-first.cjs` (the exact independent fixture with only a copyright header added), and `evidence/vendor-empty-first-results.json` generated against parent vendor files. No binary or vendor update was created. Excluded: unrelated historical benchmark archives and divergent local branch changes.
