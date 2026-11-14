# LFCP Workbench

Data multitool for ingestion, pipelining, and analysis.

LFCP Workbench is intended to become a browser-based environment for importing, exploring, querying, transforming, and visualizing structured data. Its foundational storage and interchange format is LFCFoundry Columnar Format (LFCP), developed in coordination with the Workbench as a consumer, producer, benchmark environment, and source of practical requirements.

## Project direction

**Established project direction:** The Workbench is a genuine browser application, local-first and offline-capable. It will not use Electron, Tauri, or a native desktop runtime. LFCP is foundational to the intended data architecture, with monolithic files and streaming workflows as design goals. Product limits must respect browser memory, storage quotas, security boundaries, and permissions.

**Proposed implementation direction:** Keep ingestion adapters, LFCP storage access, execution, persistence, and user interface as separate modules. Evolve the LFCP format, its library/API, streaming contracts, and the Workbench at their appropriate boundaries. The specific reader/writer contracts, logical schema, execution planner, and SQL integration remain open decisions in [`docs/architecture/OPEN-DECISIONS.md`](docs/architecture/OPEN-DECISIONS.md).

## Development stage

This repository currently establishes the project's documentation and experiment layout. It does not yet contain a production application, build system, installed dependencies, or production implementation.

The first implementation is preserved as an experiment in [`experiments/lfcp-first-spike/`](experiments/lfcp-first-spike/). It demonstrates a narrow CSV/TSV/JSONL-to-LFCP write path using the current LFC-pack API and OPFS. It is not production code. It does not demonstrate bounded end-to-end memory, production-scale ingestion, random-access or streaming LFCP reads, footer integrity validation, durable checkpoints or recovery, or performance superiority over Parquet.

The experiment uses the pinned LFC-pack 0.4.19/API 0 build in [`vendor/lfcp/0.4.19/`](vendor/lfcp/0.4.19/). Its provenance and notices are recorded there. LFCP is expected to evolve; the current implementation and format are not frozen by this repository.

## Project map

- [`docs/architecture/`](docs/architecture/) — system boundaries and unresolved decisions.
- [`docs/lfcp/`](docs/lfcp/) — Workbench-derived requirements and an evidence-based LFCP evolution process.
- [`experiments/`](experiments/) — prototypes that remain explicitly separate from production code.
- [`vendor/`](vendor/) — pinned third-party or shared build artifacts with provenance and notices.
- [`tests/fixtures/`](tests/fixtures/) — location and guidance for future reproducible validation fixtures.

No dependencies need to be installed to read this repository. The experiment's local run instructions are in its README; they apply only to that experimental page.

## Components and evidence

- `experiments/lfcp-first-spike/` — dependency-free feasibility prototype, with the integrated working copy and a byte-preserved `original-standalone/` snapshot of the standalone `data-workbench-spike`. The source directory had no Git history and remains preserved outside this repository. The original snapshot includes its own vendor copy; its hash matches the canonical vendor artifact.
- `experiments/diagnostics/` and `experiments/fixes/` — the separate LFC-pack 0.4.19 empty-string writer investigation, including source analysis, proposed correction, candidate JavaScript/Wasm, browser qualification, negative controls, and submission evidence. The candidate has not been integrated into production.
- `benchmarks/results/` — machine-readable experimental results and their interpretation. These are records, not a claim of broad browser qualification.
- `tests/` — Node.js regression programs for the LFC-pack workstream. `tests/fixtures/` documents the current fixture policy; no general-purpose Workbench test suite exists yet.
- `vendor/lfcp/0.4.19/` — immutable pinned LFC-pack artifact, provenance, and license notices.
- `docs/PROJECT-STATUS.md`, `docs/DEVELOPMENT.md`, and `docs/MIGRATION-INVENTORY.md` — current status, reproducibility instructions, and file-level migration inventory.

## Reproduce and test

No install or build step is required. The spike and browser qualification instructions are in their respective READMEs and [`docs/architecture/BROWSER-VALIDATION.md`](docs/architecture/BROWSER-VALIDATION.md). The focused Node.js regressions run from the repository root with:

```sh
node tests/lfcp-optimized-string-writer-fix.cjs
node tests/lfcp-variable-length-string-roundtrip.cjs
```

The second test is intentionally expected to demonstrate the defect against the pinned vendor in its default mode; consult the test comments and retained results before interpreting its exit status. Browser results are specific to the recorded Android Chrome environment. No general Workbench test command is established.

## Maturity and limitations

Version 2026.11.14.0848 (date stamp, Eastern; carries LFC-pack 0.10.18). The Workbench is at the documented direction and feasibility-experiment stage. There is no production ingestion pipeline, query engine, SQL support, visualization layer, build system, or stable release. The spike demonstrates a narrow browser file-to-LFCP path and has significant storage, reader, recovery, and scale limits. LFCP architecture, schema, streaming contracts, and vendor update policy remain open; see [`docs/architecture/OPEN-DECISIONS.md`](docs/architecture/OPEN-DECISIONS.md).

The LFC-pack correction remains an isolated proposal. Its issue draft and Phase 11 evidence package are preserved, and the Phase 14 audit says the draft is ready for submission while production integration remains NO-GO. The Codex-to-Claude handoff is on the `codex/lfc-pack-0419-empty-string-investigation-handoff` branch in [JS-modules](https://github.com/lfcfoundry/JS-modules/tree/codex/lfc-pack-0419-empty-string-investigation-handoff). No maintainer communication has been sent.
