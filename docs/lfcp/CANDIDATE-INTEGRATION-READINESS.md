# Phase 7: LFCP string-writer candidate validation and integration readiness

**Scope:** validate the isolated Phase 6 writer correction and assess integration options. The canonical `vendor/lfcp/0.4.19/lfc-pack.js` remains unchanged. Phase 5 and Phase 6 reports and artifacts remain preserved.

## Build reproducibility and artifact integrity

The candidate source `experiments/fixes/lfc-pack-0.4.19-string-writer/flatscan.c` differs from the Phase 5 source snapshot at exactly two predicates: `if(o)` became `if(i)` in the early high-cardinality and post-scan all-values join loops. Its source base is JS-modules commit `6e16aa8044d0a05bafa7c756c949f3537c23e92a`, `modules/lfc-pack/wasm/flatscan.c`, blob `21a0aeb1a3e9fa4fd74deddc9952df710d604890`.

**Reproduced locally:** using Clang 21.1.8 with wasm32 target and wasm-ld 21.1.8, the README's documented command produced a new file `flatscan-rebuilt-20261102.wasm`. It is byte-identical to the Phase 6 `flatscan-fixed-v2.wasm`: both are 13,391 bytes, SHA-256 `80a8332b64fa28697fbea3a054579076ed217b64e1c28078fc95fedd5a6d3c8a`. Reproduction is established for this source, exact flags, and installed toolchain; this does not establish byte identity across compiler versions.

The final module has no imports and exports `memory`, `scan`, `count`, `hexcols`, `keyix`, `strdict`, `rawjoin`, `gather`, `ipcol`, and `__heap_base`. Its memory section declares 16 initial pages (1 MiB) and a 16,384-page maximum (1 GiB); `__heap_base` is 72,240 bytes. The embedded wrapper expects the heap-base export. The earlier `flatscan-fixed.wasm` lacks `__heap_base`, so it is not wrapper-compatible and must remain labeled as the failed initial intermediate while preserving Phase 6 evidence. The `build-fixed-copy.cjs` packaging script checks the original vendor SHA-256 and writes exclusively; it packages an already-built module rather than compiling the C source itself.

The candidate wrapper differs from the canonical wrapper only in the inline `FSB64` flat-scan module. It has the same LFC-pack 0.4.19 / API 0 JavaScript surface. Node and Chrome runs exercised initialization and package APIs successfully.

## Regression results

Phase 7 reran the Phase 6 19-case target matrix. The corrected candidate passed all 19 tests; eight matching pinned-vendor cases reproduced the known defect. It also reran the 49-case API harness against both libraries: the pinned vendor had 98 failed checks and exit code 1; the corrected candidate had zero failed checks and exit code 0. The suite includes `packRows()`, `pack()`, `packStream()`, `packParallel()`, all applicable reader paths, dictionary/fallback controls, cardinality, and multi-block tests.

The 19-case comparison is `benchmarks/results/phase-7-targeted-node-20261102.json`. The 49-case comparison is `benchmarks/results/phase-7-node-regression-20261102.json`. The canonical vendor remains an expected-failing negative control; no unrelated test failures appeared in the corrected candidate.

## Browser validation

Android Chrome 156 ran 20 browser checks: 19 corrected-candidate cases passed and the pinned-vendor negative control reproduced the mismatch. The candidate passed empty-string position and frequency cases, cardinalities 2–8, the dictionary control, `packStream()` with 13-byte input chunks, and `packParallel()` producing two blocks with two workers requested. The page verified `unpackRows()`, flat `unpackColumns()`, row counts, and footer counts. Chrome reported secure localhost, WebAssembly, Worker, and Streams support. User-agent data identified an Android phone; its privacy-reduced version data exposed Chrome major 156 but not the full patch version.

Browser reports are `benchmarks/results/phase-7-browser-candidate-20261102T165903Z-1ca586d2.json` and `phase-7-browser-candidate-20261102T172809Z-46543fb2.json`; the second includes the fuller user-agent data. The browser harness and server are in `experiments/fixes/lfc-pack-0.4.19-string-writer/browser-validation/`. Firefox was not installed and no other browser executable was available, so cross-browser compatibility remains untested.

## Integration strategy comparison

| Strategy | Compatibility and provenance | Maintenance and risks | Assessment |
|---|---|---|---|
| Replace only the embedded flat-scan Wasm in a downstream wrapper | Preserves the current JS API and type-`s` format semantics. Phase 6 demonstrates this with an unchanged wrapper outside `FSB64`. | Requires carrying the exact patched C source, compiler flags/toolchain, binary, wrapper-generation step, and provenance. A hand-built blob can drift from upstream source. | Technically low-impact for an emergency downstream patch, but keep explicitly marked and tested as a patch until upstream source adopts it. |
| Apply the C correction upstream and regenerate the official package | Keeps the fix at its source of truth; `build.py` embeds `wasm/flatscan.wasm` into the assembled package. Existing API and format can remain unchanged. | The inspected source reference has `build-core.sh` for `core.c`, `build.sh` for Zstandard, and `build.py` for embedding; it does not provide a dedicated `flatscan.c` build script or a pinned compiler version for that module. The official flat-scan compilation command/toolchain therefore still needs confirmation. | Preferred integration route once the upstream flat-scan build process, tests, and release/provenance are confirmed. Do not run its build in the live JS-modules checkout without authorization. |
| Maintain a documented downstream patch if upstream cannot take the fix | Can preserve API/format semantics and keep Workbench unblocked. | The Workbench assumes long-term responsibility for patch rebasing, compiler reproducibility, generated wrapper verification, conformance tests, and security review of the vendored library. | Fallback only if upstream integration is unavailable or delayed; keep patch and generated artifact linked to the exact source baseline. |

The inspected upstream `build.py` regenerates `lfc-pack.js` and `lfc-pack-read.js`, and may regenerate `viewer.html`; it writes those outputs in the source tree. An eventual upstream integration should verify every generated diff, use the project’s chosen toolchain, run upstream tests (`roundtrip`, `exact`, `query`, `pool`, and Python reader) plus Workbench regressions, and publish the updated source reference and artifact hashes. No remote state was checked in this phase.

## Licensing and deployment considerations

The flat-scan C and LFC-pack wrapper carry the existing LFCFoundry MIT notice. The Zstandard implementation was not changed; its BSD-3-Clause notice remains alongside the candidate. The candidate introduces no dependency or runtime network request. Preserve both notices and record the source commit/blob, C patch, compiler and linker versions/flags, Wasm hash, wrapper hash, and upstream release/reference when an artifact is eventually adopted.

The browser run used the default localhost policy, not the Workbench's eventual strict Content Security Policy. The current package's parallel helper constructs a Worker from a Blob URL (`new Worker(url)` in `makePool()` and `takeHelper()`), so a deployment policy may need `worker-src blob:` for these paths. Verify this under the intended CSP before release; this phase established offline loading on loopback, not CSP compatibility. A self-hosted static worker design could be evaluated if allowing Blob workers is undesirable.

The original vendor SHA-256 remains `8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259`, with Git blob `dae1cf4a7d9f6f568ea05447f57e9158e7396091`. The corrected candidate is not the canonical vendored dependency and should not be treated as deployed until an integration decision and authorized vendor update.

## Separate reader requirement and remaining blockers

Reader decoded-value-count validation remains documented as proposed requirement `LFCP-WB-PHASE5-002` in `docs/lfcp/REQUIREMENTS.md`. It was not implemented or included in this writer correction. A future reader change belongs in LFCP's reader/library API and needs validly framed type-`s` inputs with too few and too many decoded values, plus valid empty-string and dictionary controls across `unpackColumns()`, `unpackRows()`, and `unpack()`.

Outstanding integration items are confirmation of the upstream flat-scan compiler recipe/toolchain, upstream acceptance or an explicit downstream-patch decision, and Firefox/other-engine testing. The recommended next action is to prepare an upstream source patch proposal with this reproducible fixture and results, then wait for authorization before changing the vendored artifact or any other repository.

## Phase 8 deployment qualification

Phase 8 exercised the candidate under a strict Chrome CSP, directly instrumented real Worker construction and job messages, tested a Worker startup error, and ran negative controls with WebAssembly and Blob Worker permissions removed. Results and exact policies are documented in `docs/lfcp/DEPLOYMENT-QUALIFICATION-PHASE8.md`; the detailed Phase 8 report supersedes the Phase 7 suggestion that worker-count and CSP compatibility still needed their first test. Firefox and the authoritative upstream build/release route remain unresolved.
