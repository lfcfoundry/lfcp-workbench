# Open architecture decisions

No decisions below are frozen. The current LFC-pack 0.4.19/API 0 implementation is an early reference point, not a permanent limit on LFCP.

1. **Random access versus sequential streaming reads:** Define source interfaces for footer-first selection from `File`/`Blob`/OPFS and for block-by-block consumption from an incoming stream. Specify when data is provisional and when integrity can be declared complete.
2. **Streaming writing and durable completion:** Decide how blocks are committed, where checkpoints occur, how the footer/trailer finalizes a file, and how interrupted output is resumed or rejected. Phase 3 observed Chrome OPFS writes staying invisible through `getFile()` until `close()` and being discarded after Worker/browser termination, with the separately created zero-byte directory entry left behind. This is one-browser evidence, not a cross-browser atomicity contract.
3. **Logical schema and type fidelity:** Define physical and logical types, including integer widths, exact decimals, timestamps/time zones, binary, and nested values.
4. **Null versus missing values:** Decide which distinctions are preserved in the format and how SQL and source adapters map them.
5. **Schema evolution:** Define stable field identity, additive and incompatible changes, reader behavior, version negotiation, and migration expectations.
6. **Browser storage and recovery guarantees:** Specify supported browser capabilities, quota and eviction handling, private-browsing behavior, and what recovery promises the application can actually make. One completed 256-row file survived a Chrome force-stop/reopen check, while `navigator.storage.persisted()` returned false; browser storage remains potentially evictable. Chrome did not expose `FileSystemHandle.move` in this environment.
7. **Vendor update and conformance policy:** Decide how pinned LFCP builds are updated, how notices/provenance are recorded, and which cross-implementation vectors are required for each supported feature.
8. **LFCP-native execution and SQL integration:** Decide how SQL is parsed and planned over LFCP, how operators access blocks/batches, and when a secondary query subsystem is justified. LFCP remains foundational in this project direction.
9. **Multi-window architecture:** Decide database/session ownership, coordination and conflict behavior across windows, and which multi-monitor features remain optional browser enhancements.

Each decision should cite a representative workload and evidence. Proposed implementation options belong in an ADR after the needed prototype or benchmark, not in an assumed product guarantee.

## Phase 3 evidence that informs, but does not close, decisions

- Repeated empty-string corruption in a high-cardinality, mixed-length string column is recorded as `LFCP-WB-PHASE3-001`; writer-versus-reader responsibility is not yet isolated.
- The current spike's visible final-name zero-byte entry can be classified by the pinned reader as incomplete in this Chrome test. It does not establish a portable recovery rule or justify a format change.
- A temporary output name plus an application catalog/state transition is a candidate for an isolated follow-up. Do not rely on atomic rename: this browser did not expose `FileSystemHandle.move`, and other-browser atomicity was not tested. Publish a dataset as complete only after the writer closes successfully and the reader validates the footer; the current spike's suffix-only list flag is weaker than that check.
- Random-access reads, sequential streaming reads, and recovery remain separate decisions; Phase 3 implemented none of them.
