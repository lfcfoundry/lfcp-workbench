# Claude orchestrator handoff

Use this prompt to begin the next project phase after reviewing the published migration branch.

---

You are taking ownership of the LFC Workbench project for independent assessment and continued development.

Repository: `lfcfoundry/lfcp-workbench`  
GitHub URL: https://github.com/lfcfoundry/lfcp-workbench  
Migration branch: `codex/lfcp-workbench-github-migration-handoff`  
Migration import commit: `7b46150fbc4a3ed4566bbb2a8666431491ab5d75` (the project/evidence import commit immediately before this handoff documentation commit)

LFC Workbench is a data multitool for ingestion, pipelining, and analysis. Its intended direction is a local-first browser application. The repository is at documentation and feasibility-experiment maturity, not a production product.

## Repository map

- `docs/architecture/` — architecture overview, layers, browser evidence, and open decisions.
- `docs/lfcp/` — requirements, evolution, and the LFC-pack investigation status.
- `docs/PROJECT-STATUS.md` and `docs/DEVELOPMENT.md` — implementation status and reproducibility instructions.
- `experiments/lfcp-first-spike/` — copied standalone feasibility spike; it is not production code.
- `experiments/diagnostics/` and `experiments/fixes/` — separate LFC-pack defect investigation, candidate artifacts, regression harnesses, and submission packages.
- `benchmarks/results/` — retained machine-readable experimental reports.
- `tests/` — two focused Node.js regression scripts; there is no general Workbench suite.
- `vendor/lfcp/0.4.19/` — canonical pinned LFC-pack 0.4.19/API 0 artifact, provenance, and notices.
- `docs/MIGRATION-INVENTORY.md` — file-level migration inventory and classification.

## Existing implementation and experiments

The first spike supports selected CSV, TSV, and JSONL input, bounded file slices, a Worker-based write through LFC-pack to OPFS, and a bounded sample/profile. It has no SQL, general query planner, random-access reader, resumable ingestion, or production-scale guarantee. Its original standalone directory had no Git history and remains preserved separately; a byte-preserved source snapshot is included under `experiments/lfcp-first-spike/original-standalone/` alongside the existing integrated experiment. Assess both and explain their relationship to the larger Workbench direction. The standalone snapshot includes a duplicate pinned vendor artifact whose hash matches the canonical copy.

The LFC-pack 0.4.19 empty-string flat-writer investigation is a separate workstream. It includes the suspected isolated source correction, candidate JavaScript/Wasm, browser qualification, negative controls, regression tests, build-provenance research, maintainer inquiry and patch proposal, Phase 11 evidence package, Phase 12 issue draft, and the Phase 14 readiness audit. Phase 14 records the issue draft as ready for submission and production integration as NO-GO. The investigation has not been submitted to maintainers. Do not treat the candidate as production code.

The prior Codex-to-Claude investigation handoff is on the JS-modules branch [codex/lfc-pack-0419-empty-string-investigation-handoff](https://github.com/lfcfoundry/JS-modules/tree/codex/lfc-pack-0419-empty-string-investigation-handoff). The local recorded handoff commit is `f6ca6ce7691a545bfd3d75ddcf05af2c26954ecd`.

## Verification context

The existing tests are focused on LFC-pack behavior, not Workbench features. Browser evidence is specific to recorded Android Chrome runs; Firefox and WebKit are not qualified. Review `docs/DEVELOPMENT.md`, the browser validation guide, test comments, and result JSON before interpreting test status. During migration the canonical vendor file was verified as SHA-256 `8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259`; Phase 11 has its own SHA-256 manifest. Do not replace vendor files or alter historical result records.

## Your assessment tasks

1. Independently inspect the complete migrated repository.
2. Establish your own understanding of the project architecture.
3. Assess the project against its stated purpose as a data multitool for ingestion, pipelining, and analysis.
4. Identify incomplete, experimental, or undocumented functionality.
5. Review existing tests and reproducibility.
6. Assess the earlier data-workbench spike and its relationship to the main project.
7. Review the LFC-pack investigation as a separate workstream.
8. Develop a prioritized project roadmap.
9. Identify the highest-value next implementation increments.
10. Recommend a development and testing strategy.
11. Report findings and ask only questions that materially block progress.

Work autonomously on non-destructive investigation, documentation, testing, and isolated reversible implementation improvements. Preserve experimental evidence. Use dedicated Claude branches for changes. Do not modify shared repository agent instruction files without explicit approval.

Obtain explicit user approval before merging into `main`, publishing a release, changing canonical vendor artifacts, replacing pinned dependencies, changing data formats or compatibility contracts, integrating the proposed LFC-pack correction into production, submitting external maintainer communications, making destructive or irreversible changes, or taking actions that affect external services or users. There is no authorization here to perform those actions.

---
