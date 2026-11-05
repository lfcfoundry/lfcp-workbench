# Workbench architecture overview

## Established project direction

- **Browser application:** The Workbench runs as a browser application, without Electron, Tauri, a native desktop runtime, or unrestricted filesystem access.
- **Local-first and offline:** Selected files and explicitly permitted local resources are the data boundary. Runtime assets are to be packaged locally; remote services, telemetry, and silent network requests are outside the intended design.
- **LFCP foundational:** LFCP is intended to become LFCFoundry's general-purpose storage and interchange foundation for applicable non-media data. Both cohesive monolithic datasets and streaming workflows are strategic requirements. The Workbench is expected to help LFCP evolve through real workloads and evidence.
- **Resource honesty:** Browser memory, storage quotas, eviction, permissions, and API differences constrain behavior. The Workbench must report limits and recoverable failures rather than promise unlimited data sizes or capabilities.

These statements record project direction. They do not claim the current LFCP implementation already provides the required capabilities.

## Proposed system shape

Keep the application modular, with explicit boundaries between:

1. **Source adapters** — interpret selected files or permitted local sources and produce bounded input batches.
2. **LFCP data access** — open, validate, read, and write LFCP without exposing its physical layout to importers or views.
3. **Streaming and transfer contracts** — carry schemas and batches with ordering, backpressure, cancellation, completion, and failure semantics.
4. **Execution engine** — plan and run scans, projections, filters, transformations, and later relational operations over LFCP-backed data.
5. **Persistence and recovery** — use browser storage deliberately, track committed work, and distinguish complete datasets from interrupted operations.
6. **Application and presentation** — provide import flow, SQL and visual workflows, virtualized data views, profiling, visualization, and coordinated browser windows.

The engine should be usable independently of a particular page or visualization. The application should not require whole-dataset materialization between modules. The exact batch contract, query plan, and relationship to SQL remain open.

## Current repository state

The repository currently contains this documentation, a pinned LFC-pack 0.4.19/API 0 build, and the explicitly experimental `lfcp-first-spike`. No production source tree, package system, or build system has been established. See [open decisions](OPEN-DECISIONS.md) before treating proposed details as settled architecture.
