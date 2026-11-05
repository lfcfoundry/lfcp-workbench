# Project status

## Current state

LFC Workbench is a browser-based data multitool project for ingestion, pipelining, and analysis. The repository is in the documentation and feasibility stage. It has no production application, package/build system, or general query and transformation engine. Statements in architecture documents distinguish established direction from proposals.

## Completed work

- Established project purpose, intended browser-local/offline direction, architecture boundaries, and open decisions.
- Preserved the first LFCP feasibility spike at `experiments/lfcp-first-spike/`. It reads selected CSV, TSV, and JSONL files in bounded slices, writes through the pinned LFC-pack stream writer to OPFS, and displays a bounded sample/profile. It remains experimental.
- Preserved browser qualification harnesses and benchmark records under `experiments/lfcp-first-spike/validation/` and `benchmarks/results/`.
- Preserved the separate LFC-pack 0.4.19 empty-string flat-writer investigation under `experiments/diagnostics/` and `experiments/fixes/`, including source proposal, candidate artifacts, negative controls, tests, Phase 11 package, and Phase 12 issue draft.
- Preserved the Phase 14 readiness audit on the JS-modules Codex handoff branch. It marks the issue draft ready for submission and production integration NO-GO; no external submission is authorized by that status.
- Pinned LFC-pack 0.4.19/API 0 with provenance and notices under `vendor/lfcp/0.4.19/`.

## Experiments and evidence

The first spike has no standalone Git history. Its original source directory was retained outside this repository. A byte-preserved copy now lives at `experiments/lfcp-first-spike/original-standalone/`; the adjacent integrated experiment is retained separately, including its existing changes. The snapshot's LFC-pack artifact is kept as a duplicate rather than silently deduplicated, and its hash matches the canonical repository vendor artifact. See both READMEs for their respective paths and limits.

The LFC-pack investigation is a separate engineering workstream, not the entire Workbench product. Its evidence includes Phase 1–14 materials distributed across the project records and the JS-modules handoff. Browser qualification is limited to the reported Android Chrome environment; Firefox and WebKit remain unqualified. Candidate results do not establish production readiness or reproducible provenance for the historical upstream Wasm.

## Tests and verification

Two Node.js regression scripts cover the empty-string fix candidate and variable-length string round trips. Their scope is the LFC-pack investigation, not Workbench functionality. The browser harnesses exercise synthetic cases and retain JSON reports. The repository has no general Workbench unit, integration, or end-to-end test suite, CI workflow, or build command.

Run instructions and the results of migration-time checks are in [`DEVELOPMENT.md`](DEVELOPMENT.md). A test expected to reproduce a vendor defect must be interpreted using its documented expected result, not simply as a pass/fail indicator.

## Technical debt and limitations

- The prototype is not production code and does not provide SQL, planning, visual transformations, general expressions, random-access LFCP reads, or bounded whole-operation memory.
- OPFS storage is origin-local and subject to browser permissions, quota, and eviction. There is no durable checkpoint/recovery contract or cross-browser guarantee.
- LFCP schema, compatibility, streaming, integrity, and completion semantics are unsettled.
- Browser evidence is narrow and does not establish production scale or broad compatibility.
- The canonical vendor build's historical Wasm build process is undocumented in the examined source snapshot. The proposed corrected candidate does not reproduce the old Wasm.
- The project has no dependency policy beyond the current pin, no CI, and no product-level test suite.

## Open architectural decisions

See [`architecture/OPEN-DECISIONS.md`](architecture/OPEN-DECISIONS.md) for the evidence-backed list. High-impact unresolved topics include LFCP random access versus sequential streaming, durable writer completion and recovery, logical types and null/missing semantics, schema evolution, browser storage guarantees, vendor/conformance policy, LFCP-native query execution and SQL integration, and multi-window coordination.

## Suggested milestones

1. Audit the spike and define one representative ingestion and analysis workload with measurable correctness and resource expectations.
2. Decide the minimum LFCP read/write and batch contracts needed for that workload, recording alternatives and evidence in an ADR.
3. Build a small independently testable LFCP access layer and deterministic conformance fixtures without treating the prototype as production code.
4. Add an ingestion pipeline with explicit cancellation, errors, completion validation, and bounded-memory measurements.
5. Evaluate query/execution and presentation increments against real workloads before selecting SQL or visualization architecture.
6. Establish CI, supported browser/runtime policy, and a deliberate vendor update process.

These are recommendations for planning, not claims that the milestones are implemented or approved architectural decisions.
