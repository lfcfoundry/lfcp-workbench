# LFCP-first architecture notes

## Evidence baseline

These notes refer to the local Git object `JS-modules@6e16aa8044d0a05bafa7c756c949f3537c23e92a`, not live GitHub content. The checked-out JS-modules `main` remains at `0758e96ccc4579fb2c0ca81891d18b5ef57ee170`; the locally recorded `origin/main` object is divergent. Relevant files are `modules/lfc-pack/SPEC.md`, `LAYOUT-SPEC.md`, `INTEROP.md`, `README.md`, `src/api.js`, `src/container.js`, `src/flat.js`, `src/nested.js`, `src/pool.js`, and the tests/vectors under `modules/lfc-pack/`.

## Current implementation findings

- **Verified in source:** `LfcPack.packStream()` accepts byte chunks containing newline-delimited JSON, emits completed compressed block byte arrays from `push()`, and emits its footer from `finish()`. It does not implement resumable checkpoints.
- **Verified in source:** `openFile(bytes)` consumes and retains the whole byte source. `blockBytes()` slices from that in-memory source. `unpackRows()` can avoid decoding blocks outside a requested row range, but the whole file buffer is still required.
- **Verified in source:** `unpackColumns()` returns typed columns only for flat-layout blocks and is marked experimental in the source comment.
- **Verified in source:** the current semantic model follows JSON values. The specification says numbers are doubles; values above 2^53 are rounded in value-exact mode. File metadata is optional JSON, capped at 64 KiB by the current implementation, and is not a decoding schema.
- **Documented but not independently verified:** `SPEC.md`, `LAYOUT-SPEC.md`, and `INTEROP.md` are draft documents with conformance vectors for JavaScript, Python, and Go. They explicitly say files are not frozen until formal release.

## Responsibility split for LFCP evolution

| Concern | Best owner | Reason |
|---|---|---|
| Physical block framing, footer, schemas on disk, compression identification, integrity fields, versioning | **LFCP format** | These determine durable cross-implementation file meaning. Keep product UI and job lifecycle out of this layer. |
| `readAt`, range source, bounded footer parse, lazy block/column reads, batch writer, codecs, cancellation hooks | **LFCP library/API** | These are reusable operations over a file and should not be reimplemented by every application. |
| `begin / schema / batch / checkpoint / finish / abort`, sequence numbers, credits/backpressure, resumability, transfer recovery | **LFCP streaming protocol** | A stream spans producers and consumers and needs lifecycle semantics beyond a complete file footer. |
| Scan/filter/project/cast/sort/aggregate/join, query planning, spilling, operator scheduling | **Data execution engine** | These are computational operators, not on-disk encoding rules. The engine should scan LFCP blocks and emit LFCP-backed or decoded batches. |
| Format selection, import previews, permissions, progress presentation, recovery UX, saved workflows, window coordination | **Data Workbench** | These are application and user-interaction responsibilities. |

## Proposed LFCP evolution path

1. **Proposed — define a logical schema model.** Specify stable field identity, display/source names, physical and logical types, nullability, missing-versus-null behavior, metadata/provenance, and evolution rules. Include signed/unsigned integer widths, float widths, decimal precision/scale, dates and timestamps with explicit timezone semantics, UTF-8, binary, lists, structs, and an extensible type registry.
2. **Proposed — separate schema from block observations.** A dataset schema describes stable fields; block metadata may describe encoding, observed ranges, null counts, and field presence. Type changes should require an explicit schema evolution event rather than silently changing field interpretation between blocks.
3. **Proposed — add bounded random-access sources.** A reader requests trailer/footer, then selected blocks/frames through `readAt(offset, length)` or an async equivalent. Sources include `Blob`/`File` and OPFS. Metadata and checksums need size caps before allocation.
4. **Proposed — add a batch-oriented writer.** Accept typed batches directly without first constructing complete NDJSON. Keep compression frame-by-frame and permit output chunks to be written to durable sinks. A file is complete only after a validated final footer/trailer is committed.
5. **Proposed — define checkpoints and recovery.** Checkpoint at independently verifiable block boundaries. Keep provisional state separate from a committed dataset, record the last valid byte/range and schema version, and define how to resume or reject partial output.
6. **Proposed — define a separate streaming protocol.** Use explicit start/schema/batch/checkpoint/end/abort messages, sequence numbers, batch credits/backpressure, checksums, cancellation, and error scope. Keep transport framing independent of the complete-file footer.
7. **Proposed — version by capabilities and conformance level.** Readers advertise format major/minor plus supported block layouts, type registry entries, codecs, indexes, and optional sections. Unknown optional features may be skipped only when semantics remain unambiguous; unsupported required features fail closed.
8. **Proposed — require cross-implementation fixtures and migration.** Maintain golden files for encodings/types/layouts; test JS, Python, Go, and later WASM consumers; fuzz malformed lengths and frames; and document migration tooling before changes affect user data.

## Execution without unnecessary materialization

**Proposed:** The engine should use three data-access forms selected per operator:

- **LFCP block/column reference:** for projection and predicates that can use selected columns or zone maps. References contain source identity, block, field, and ownership/lifetime rules; they are not raw binary-layout pointers.
- **Decoded `RecordBatch`:** for operations that need values, type conversion, vectorized evaluation, or Worker transfer. Use owned typed buffers plus validity bitmaps and bounded row/byte counts.
- **Materialized spill/run:** for operations needing global state, such as sort, hash join, or large aggregation. Spill sorted runs or partitions to OPFS in an engine-defined scratch format, then clean up only after a successful terminal state or an explicit recovery decision.

**Inferred:** `RecordBatch` is a practical common boundary, but it should not dictate LFCP's physical block layout. SQL and a future visual editor can compile to a small logical plan: `Scan`, `Project`, `Filter`, `Cast`, `Rename`, `Sort`, `Limit`, `Aggregate`, `Join`, and `Union`.

## SQL without displacing LFCP

**Proposed:** Treat SQL as a language front end, not a required storage representation. A future SQL layer can parse statements into the logical plan and let an LFCP-native engine execute supported operations. SQLite may be integrated for SQL parsing/relational operations or as a comparison backend, but should not force full LFCP materialization at every boundary.

**Not yet established:** Whether SQLite virtual tables over LFCP, a SQLite import adapter, or a new SQL planner offers the best first implementation. The current spike does not include SQL and performs no comparative benchmark. A prototype should compare callback-driven virtual-table scans against bounded batch scans and SQLite table import on the same data and query set.

## Prototype boundary

**Verified in source:** This spike demonstrates only an incremental text-source adapter feeding the existing LFCP streaming writer and an OPFS sink. Its inspection route uses the current full-buffer reader under a 64 MiB guard.

**Not yet established:** Incremental LFCP reading, random access, append semantics, resumable output, durable import journals, SQL, query execution, operator spilling, multi-window ownership, or production browser limits. The prototype does not claim any of these capabilities.
