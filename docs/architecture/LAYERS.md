# Architecture layers and ownership

This document separates durable format semantics from reusable APIs, execution behavior, and application behavior. **Proposed:** responsibilities below are initial boundaries, not a frozen LFCP specification.

| Layer | Owns | Should not own |
|---|---|---|
| **1. LFCP format** | Durable container/block meaning; schema and type representation; compression identifiers; integrity metadata; version and compatibility rules; file-level commit/finalization semantics. | UI labels, import dialogs, saved-query behavior, or application-specific workflow semantics. |
| **2. LFCP library/API** | File/Blob/OPFS source abstractions; bounded footer and block access; codecs; selected-column/range reads; batch-oriented writers; validation and cancellation interfaces. | A particular product's job display or visual pipeline language. |
| **3. Streaming and transfer protocols** | Message framing; schema and batch transfer; sequencing; backpressure/credits; cancellation; provisional versus committed data; checkpoints and recovery across producers and consumers. | Persistent on-disk meaning when that meaning belongs to the file format. |
| **4. Execution engine** | Logical and physical plans; scan, project, filter, cast, rename, sort, limit, aggregate, join, and union operators; scheduling, spill, and engine-level recovery. | Browser UI state or incidental encoding details of LFCP blocks. |
| **5. Workbench application and UI** | Source selection and permissions; import configuration; progress and error presentation; SQL/visual workflows; profiling and visualization; browser persistence policy and multi-window coordination. | New required LFCP sections that encode application-specific UI behavior. |

## Boundary rules

- Application metadata may be optional and namespaced; data decoding must rely on format-defined schema and block data, not UI-only conventions.
- A batch or block reference is an execution contract, not a promise about the LFCP binary layout.
- A complete-file reader, a random-access reader, and a sequential streaming reader have distinct contracts and validation timing.
- Execution operators should avoid materializing complete datasets when block references or bounded batches suffice. Global operations may require explicit spill and recovery design.
- SQL is a user-facing language and integration decision. Its presence does not make a separate database the foundational dataset format.

These rules are proposed architecture discipline. The corresponding API, protocol, and engine capabilities have not yet been implemented here.
