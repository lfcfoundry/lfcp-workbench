# LFCP evolution process

The Workbench should contribute practical, reproducible evidence to LFCP development. This process keeps each enhancement at the right architectural layer and makes compatibility consequences visible.

## Workflow

1. **Capture a real workload.** Add a requirement record in `REQUIREMENTS.md` with source characteristics, schema, expected behavior, resource constraints, and a representative fixture.
2. **Classify the owning layer.** Decide whether the requirement belongs in the LFCP format, library/API, streaming protocol, execution engine, or Workbench. Split it if it crosses boundaries; do not put UI-specific behavior into the format.
3. **Establish a baseline.** Record exact source references and versions, browser/runtime, input fixture hash, execution conditions, correctness results, throughput/latency, peak-memory method, and storage use. Label unmeasured items explicitly.
4. **Document the limitation.** State what current code does, what the documents claim, and what has not been established. Do not generalize one workload into a universal performance result.
5. **Propose the smallest enhancement.** Describe API and format effects, alternatives, versioning, old-reader behavior, failure cases, and migration path. Keep experimental behavior clearly marked.
6. **Test experimentally.** Use reproducible fixtures and compare output correctness, memory, throughput, cancellation, and recovery. Add cross-implementation conformance coverage where file semantics change.
7. **Review compatibility and migration.** Identify readers/writers affected, define how older versions behave, and provide migration guidance before relying on a changed durable representation.
8. **Promote evidence, not intent.** Update support documentation only after the stated validation criteria pass and the conformance process is maintained.

## Change categories

- **Format:** changes how durable files are interpreted. Requires specification, versioning, compatibility analysis, and cross-reader fixtures.
- **Library/API:** adds reusable read/write/access behavior without silently changing file meaning. Requires API compatibility and resource/error tests.
- **Streaming protocol:** defines transfer lifecycle, sequencing, backpressure, cancellation, and provisional/committed delivery. Requires interruption and interoperability tests.
- **Execution engine:** adds operators, planning, spilling, or scheduling. Requires correctness and workload benchmarks; it should not redefine stored data semantics.
- **Workbench only:** improves import, permissions, recovery UX, workflows, or presentation without changing reusable data contracts.

## Evidence rules

- Keep fixture inputs and expected outputs stable and identify them by content hash.
- Report exact software references and browser/runtime versions.
- Measure comparable workloads with documented settings; do not make Parquet comparisons without matching schema, compression, and correctness checks.
- Separate cold-start and warm measurements, throughput and time-to-first-result, heap/WASM memory and storage footprint.
- A feature remains experimental until its stated correctness, compatibility, and resource criteria are validated.
- No process document grants permission to modify JS-modules or publish remote changes; those actions require separate authorization.
