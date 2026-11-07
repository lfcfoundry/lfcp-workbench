# LFCP requirements from Workbench workloads

Record concrete workloads here before treating a capability as supported. One entry should describe one observable requirement and its validation. Use `TBD` rather than inventing evidence.

## Requirement record template

```yaml
requirement_id: LFCP-WB-TBD
workload_and_use_case: TBD
representative_fixture: TBD
expected_behavior_and_results: TBD
data_characteristics_and_schema: TBD
resource_constraints:
  memory: TBD
  storage: TBD
  latency_or_throughput: TBD
relevant_lfcp_version_or_reference: TBD
browser_and_runtime: TBD
measurement_method: TBD
current_limitation: TBD
proposed_enhancement: TBD
validation_criteria: TBD
compatibility_and_migration_criteria: TBD
status: proposed
```

## Status values

- `proposed` — workload captured; evidence or layer placement is incomplete.
- `specified` — behavior and compatibility expectations are agreed for experimentation.
- `experimental` — implementation is under evaluation; not a support claim.
- `validated` — reproducible correctness and resource criteria passed for the stated environment.
- `supported` — the feature is represented in the relevant format/API/protocol documentation and has maintained conformance coverage.
- `deferred` — intentionally postponed, with rationale recorded.

## Initial status

No Workbench-derived LFCP requirement is marked `supported`. Phase 2 adds the following experimental browser evidence; it does not freeze LFCP behavior or establish a general performance guarantee.

## Phase 2 browser evidence

```yaml
requirement_id: LFCP-WB-PHASE2-001
workload_and_use_case: Browser ingestion of generated CSV, TSV, and JSONL into OPFS-backed LFCP, followed by readback, footer validation, and multi-block decoding.
representative_fixture: Generated in experiments/lfcp-first-spike/validation/validation.js; raw reports benchmarks/results/phase-2-browser-20261102T130353Z-c7aac769.json and phase-2-browser-20261102T130349Z-9dea0d1e.json.
expected_behavior_and_results: 22 functional cases passed on one Android Chrome device; 12,000 ordered rows decoded from two blocks; generated 16,777,188-byte JSONL decoded to the footer row count across 64 blocks; a modified footer was rejected.
data_characteristics_and_schema: Three-field generated JSONL with repetitive rows for resource tests; functional cases also cover quoted delimited data, UTF-8 boundary splits, empty values, null/missing properties, malformed input, and a 128 KiB field.
resource_constraints:
  memory: Main-realm performance.memory reported a constant 10,000,000 bytes at 50 ms sampling; worker peak memory unavailable; no bounded end-to-end memory claim.
  storage: Chrome origin estimates; largest generated source 16,777,188 bytes; output 19,308 bytes for highly repetitive data; estimate is approximate.
  latency_or_throughput: Two runs for the largest fixture took 1,539 ms and 1,928 ms end to end; not a benchmark distribution or Parquet comparison.
relevant_lfcp_version_or_reference: LFC-pack 0.4.19, API 0; vendor/lfcp/0.4.19/lfc-pack.js; pinned source blob dae1cf4a7d9f6f568ea05447f57e9158e7396091.
browser_and_runtime: Chrome 156.0.8078.73, Android phone, Android, secure localhost context, OPFS available.
measurement_method: Browser harness with 64 KiB worker reads, worker timing counters, OPFS storage estimates, LFCP.info(), full unpack for the 12,000-row case, and footer-byte corruption check. See docs/architecture/BROWSER-VALIDATION.md.
current_limitation: One device and two runs per resource size. Reader validation still materializes the complete LFCP file; only resource-workload samples were decoded. Browser restart and quota failures remain untested.
proposed_enhancement: None established by these tests. Abrupt Worker termination left a visible zero-byte OPFS file; that is presently a Workbench output lifecycle/cleanup concern and does not demonstrate a required LFCP format change.
validation_criteria: Repeat correctness and resource tests across browser families and multiple runs; add larger and less repetitive fixtures; separately measure process and worker memory; validate complete-block integrity and restart behavior before support claims.
compatibility_and_migration_criteria: No format change proposed. Future format/API changes require independent conformance fixtures and old-reader compatibility analysis.
status: experimental
```

## Phase 3 browser evidence

```yaml
requirement_id: LFCP-WB-PHASE3-001
workload_and_use_case: Preserve exact string values, including empty strings, when packing and decoding a high-cardinality column with mixed string lengths in JSONL-to-LFCP browser ingestion.
representative_fixture: experiments/lfcp-first-spike/validation/phase3.js, WORKLOADS mixed-length-text; seed LFCP-WB-PHASE3-V1/mixed-length-text/<targetBytes>; repeated records in benchmarks/results/phase-3-browser-20261102T132453Z-30069226.json.
expected_behavior_and_results: Every decoded row must equal its source row in value and order. For each of 3 target sizes and 3 trials, all rows decoded and footer validation passed, but 3 sampled values were wrong; row 0 expected body empty and decoded the next row's 8-character token. Small cases confirmed the same mismatch with both unpackRows and unpack.
data_characteristics_and_schema: Four JSON fields (id, category, body, note); body lengths cycle through 0, 8, 40, 256, 1024, and 4096 ASCII characters; high-cardinality deterministic token strings; target inputs 262144, 4194304, and 16777216 bytes.
resource_constraints:
  memory: Worker reads at most 65536 input bytes; page heap API stayed at 10000000 reported bytes; Worker heap API was not exposed; no end-to-end memory bound established.
  storage: OPFS generated source/output were removed after each trial; origin quota estimates were approximate.
  latency_or_throughput: Three trials per target; see the machine-readable report for generation, import, encoding, OPFS write, and decode timings.
relevant_lfcp_version_or_reference: LFC-pack 0.4.19, API 0; vendor/lfcp/0.4.19/lfc-pack.js; pinned source blob dae1cf4a7d9f6f568ea05447f57e9158e7396091.
browser_and_runtime: Chrome 156.0.8078.73 on an Android phone; secure localhost; OPFS enabled.
measurement_method: Deterministic seeded fixture; 3 independent imports per target; footer validation; complete row decoding in pages; sampled expected-value/order comparison; full unpack diagnostic for outputs with at most 5000 rows. See docs/architecture/BROWSER-VALIDATION.md.
current_limitation: Round-trip mismatch reproduced in all nine trials; LFC-pack writer and reader responsibilities are not isolated. The footer validates despite wrong decoded values. Phase 2's two-row empty-string test passes.
proposed_enhancement: Investigate and correct LFCP library/API conformance for empty values in high-cardinality variable-length string columns. No format-level change is proposed unless isolated evidence demonstrates one is necessary.
validation_criteria: Add compact regression fixtures around empty strings adjacent to distinct values, cardinalities around encoding-selection thresholds, variable lengths, block boundaries, and multiple blocks; verify exact equality with independent decoders and existing fixtures; maintain compatibility with existing files.
compatibility_and_migration_criteria: Determine whether affected 0.4.19 files decode incorrectly across readers and whether corrected writer output remains readable by older versions. Do not rewrite stored files without a migration decision.
status: experimental
```

This finding is a library/reader-writer conformance investigation. It is not evidence that the LFCP binary format itself must change.

## Phase 5 optimized string-writer diagnosis

The Phase 4 investigation's exact internal cause is now established: both all-values join branches in the pinned optimized `strdict()` helper condition delimiter emission on output byte offset rather than logical value index. See `docs/lfcp/OPTIMIZED-STRING-WRITER-DIAGNOSTICS.md`. Phase 6's isolated corrected candidate passes the full semantic regression suite, but the requirement remains `experimental` for the canonical pinned implementation until an official/vendor artifact adopts the correction. No format change is indicated by current evidence.

## Phase 6 corrected-candidate validation

```yaml
requirement_id: LFCP-WB-PHASE6-001
workload_and_use_case: Preserve all values and logical positions in optimized flat string-column joins when one or more values are empty.
representative_fixture: tests/lfcp-optimized-string-writer-fix.cjs; result benchmarks/results/phase-6-string-writer-fix-final-v2-20261102.json; original suite tests/lfcp-variable-length-string-roundtrip.cjs.
expected_behavior_and_results: Exact decoded values and cardinality for first, middle, final, consecutive, all-empty, single-empty, and ordinary values; both all-values join branches produce the existing valid NUL-delimited type-s representation.
data_characteristics_and_schema: 19 targeted cases, including branch-specific n=4 and n=6 fixtures, eight-row cardinalities 2 through 8, one body string column plus numeric id and repeated pad fields to enter the optimized path.
resource_constraints:
  memory: Small correctness fixtures; no resource claim.
  storage: All generated files are in-memory LFCP buffers; no persistence required.
  latency_or_throughput: Not measured.
relevant_lfcp_version_or_reference: LFC-pack 0.4.19 / API 0; source base JS-modules commit 6e16aa8044d0a05bafa7c756c949f3537c23e92a; corrected source experiment in experiments/fixes/lfc-pack-0.4.19-string-writer/flatscan.c.
browser_and_runtime: Node.js v26.13.0 on Android arm64; local Clang 21.1.8 wasm32 build. Browser validation remains outstanding.
measurement_method: Compare full decoded rows and flat-column values against literal input arrays; check footer rows and decoded cardinality independently; run 49-case prior suite against pinned and corrected copies.
current_limitation: Corrected experimental wrapper passes 19/19 targeted cases and the 49-case suite with zero failures. Canonical vendor artifact is intentionally unchanged and still reports the Phase 5 defect.
proposed_enhancement: Adopt the two ordinal-based delimiter predicates in the upstream LFCP source and release/re-vendor only after the official build and browser conformance validation.
validation_criteria: Official artifact passes all targeted and existing cases; test both branches; retain dictionary, fallback, empty-position, multi-block, and cross-browser coverage.
compatibility_and_migration_criteria: Preserve type-s NUL-separated semantics. Existing affected files may contain already-lost values and cannot be repaired without original input; no format change is proposed.
status: experimental
```

## Separate reader robustness requirement

```yaml
requirement_id: LFCP-WB-PHASE5-002
workload_and_use_case: Reject a string column when decoded type-s values do not match the count declared by its LFCP block metadata.
representative_fixture: The four-row result from tests/lfcp-variable-length-string-roundtrip.cjs and diagnostic case minimal-four-row-fast-writer in benchmarks/results/phase-5-optimized-string-writer-final-v3-20261102.json.
expected_behavior_and_results: A type-s frame that decodes to fewer values than its declared count must produce an explicit damaged-column/count-mismatch error; it must not silently return rows with shifted or missing properties.
data_characteristics_and_schema: Flat block, one UTF-8 NUL-separated string column, declared count four, frame bytes 41 00 42 00 43 which currently split into three strings.
resource_constraints:
  memory: Validate the already-decoded vector count without materializing another dataset-sized representation.
  storage: No additional storage required.
  latency_or_throughput: Negligible count comparison expected; measure if the reader architecture makes it material.
relevant_lfcp_version_or_reference: LFC-pack 0.4.19 / API 0; JS-modules source reference 6e16aa8044d0a05bafa7c756c949f3537c23e92a; source blob dae1cf4a7d9f6f568ea05447f57e9158e7396091.
browser_and_runtime: Node.js v26.13.0 on Android arm64 for reproducer; validate in supported browser runtimes before claiming conformance.
measurement_method: Decode a validly framed/footer-accepted type-s block and compare split value count with declared n; retain independent footer validation as a separate check.
current_limitation: Reader accepts the footer and block row count although type-s decoding yields three values for n=4. The malformed bytes originate in the optimized writer; reader validation cannot recover lost data.
proposed_enhancement: Add reader/API count validation and a specific error for type-s decoded-value count mismatch. Keep this separate from correcting the optimized writer.
validation_criteria: Reject short and overlong decoded vectors before row assembly; valid empty strings and correct count columns continue to decode; exercise optimized and JavaScript writer outputs and corrupted fixtures.
compatibility_and_migration_criteria: Check whether existing LFCP files can contain other legitimate type-s edge encodings with apparent count mismatch; document that affected 0.4.19 files may become explicit errors and cannot be repaired without re-importing source data.
status: proposed
```

## Phase 4 string round-trip investigation

```yaml
requirement_id: LFCP-WB-PHASE4-001
workload_and_use_case: Preserve every string value and row position when LFCP packs and reads ASCII flat-row columns, including empty strings, repeated values, unique values, and mixed string lengths.
representative_fixture: tests/lfcp-variable-length-string-roundtrip.cjs; machine-readable result benchmarks/results/phase-4-variable-string-roundtrip-20261102.json; historical Phase 3 evidence benchmarks/results/phase-3-browser-20261102T132453Z-30069226.json.
expected_behavior_and_results: Every decoded value must exactly match the independently specified JSONL input. LFC-pack 0.4.19 fast flat writer failed the four-row minimal fixture through packRows(), pack(), packStream(), and packParallel(), and all applicable reader APIs: expected body values [empty, A, B, C], decoded [A, B, C, undefined]. Footer and row-count checks still accepted four rows. The JavaScript flat writer control and tested unaffected cases passed.
data_characteristics_and_schema: Flat JSONL objects with ASCII string columns; one to three columns; tested row counts 2 through 12; body lengths around 1, 8, 40, 256, 1024, and 4096 characters and adjacent boundaries; empty, repeated, unique, null, missing, and UTF-8 values; single and multiple LFCP blocks.
resource_constraints:
  memory: Small deterministic in-memory tests; no resource or scale claim.
  storage: No persistent test data written; encoded artifacts exist only in memory during tests.
  latency_or_throughput: Not measured; correctness investigation only.
relevant_lfcp_version_or_reference: LFC-pack 0.4.19 / API 0; source reference JS-modules 6e16aa8044d0a05bafa7c756c949f3537c23e92a; source blob dae1cf4a7d9f6f568ea05447f57e9158e7396091.
browser_and_runtime: Node.js v26.13.0 on Android arm64. The Phase 3 historical reproductions were Chrome 156 on Android.
measurement_method: Compare every decoded row and field against literal deterministic inputs through unpackRows(), unpack(), unpackColumns(), and unpackText(); record footer acceptance, row counts, block stats, string lengths, and writer-byte equality separately. See docs/lfcp/VARIABLE-LENGTH-STRING-INVESTIGATION.md.
current_limitation: The defect is isolated to the optimized WebAssembly flat-writer path at the writer layer; the precise internal strdict/join sub-branch is not yet established. The reader does not reject a decoded type-s column whose value count is shorter than metadata n. Some type-s controls pass, and the cardinality sweep was non-monotonic, so neither the type label nor a single cardinality threshold is a complete trigger rule.
proposed_enhancement: Correct the optimized flat writer's affected ASCII string encoding path. Separately add reader-side decoded-value-count validation. No LFCP format change is currently supported by evidence.
validation_criteria: The complete deterministic regression suite passes after a future implementation change; all writer APIs and reader APIs preserve every expected value; malformed short columns are rejected explicitly; empty, repeated, unique, UTF-8, dictionary, null/missing, boundary, and multi-block controls remain conformant.
compatibility_and_migration_criteria: Verify current and older readers against corrected type-s files; assess whether reader count validation changes behavior for existing files; do not silently rewrite affected datasets. Files whose values were omitted require re-import from original source to recover them.
status: experimental
```
