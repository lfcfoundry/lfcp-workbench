# Browser validation results

## Phase 2 evidence

All browser reports were captured from generated test data in Android Chrome 156.0.8078.73 on an Android phone / Android. The report server bound to `127.0.0.1` and accepted only explicit same-origin opt-in submissions. Reports contain no user-selected input files.

## Final evidence

- `phase-2-browser-20261102T130353Z-c7aac769.json` — final cache-busted functional matrix: 22/22 cases passed, including 15 completed round trips and 7 expected rejections. It fully decoded and checked ordering for 12,000 rows across two LFCP blocks; footer corruption was rejected.
- `phase-2-browser-20261102T130349Z-9dea0d1e.json` and `phase-2-browser-20261102T130359Z-b6bd4a7e.json` — two generated JSONL resource runs at actual input sizes 262,116, 4,194,288, and 16,777,188 bytes. All assertions passed. End-to-end times were 163/92 ms, 421/471 ms, and 1,539/1,928 ms respectively. The largest case emitted 64 blocks and 19,308 bytes from 16,777,188 highly repetitive input bytes. These rows compress unusually well and are not a representative compression benchmark.
- `phase-2-browser-20261102T130402Z-1ca27cdd.json` — cache-busted Worker cooperative cancellation after a read/progress checkpoint and while an OPFS write was pending; both returned cancellation and left no visible test output.
- `phase-2-browser-20261102T130407Z-4ff8b6da.json` — cache-busted Worker terminated at the OPFS-write hook; a visible zero-byte `.json.lfc` with no footer marker remained. The harness removed that exact generated test file after recording the observation.

## Retained harness-development runs

These files are retained to preserve the test history. Their sole failed assertion was a harness bug: the 12,000-row case requested only the first 100 decoded rows and compared them to all 12,000 expected rows. No LFCP row-count or block assertion failed. The harness was corrected to request a full decode, then rerun successfully in the final functional report above.

- `phase-2-browser-20261102T124904Z-d5a5490b.json`
- `phase-2-browser-20261102T124923Z-b027a743.json`
- `phase-2-browser-20261102T125100Z-714a784e.json`

`phase-2-browser-20261102T124932Z-ed12c7f1.json`, `phase-2-browser-20261102T130021Z-2775ce42.json`, and `phase-2-browser-20261102T130035Z-1035715b.json` also passed their resource correctness assertions. Their JSONL parse timer included awaited pack/write flushes. Do not use those records to separate parsing from encoding or OPFS time; the cache-busted reports above use the corrected timing boundary.

`phase-2-browser-20261102T130031Z-723d6406.json` is an additional passing functional run before cache-busting the Worker URL. The final functional report above was captured after that cache-busting change.

Additional pre-cache-busted cancellation and interruption observations are retained in `phase-2-browser-20261102T130038Z-66a92f30.json` and `phase-2-browser-20261102T130044Z-d3404da4.json`. Their behavior matches the final cache-busted reports.

Four additional Phase 2 suite reruns were captured at the beginning of the Phase 3 browser session and are retained as separate records: `phase-2-browser-20261102T131725Z-f3130754.json` (22 functional cases), `phase-2-browser-20261102T131729Z-ec0476c0.json` (three resource sizes), `phase-2-browser-20261102T131731Z-f2e42f00.json` (two cooperative cancellation cases), and `phase-2-browser-20261102T131736Z-7161f2d9.json` (Worker interruption). Their recorded assertions passed; they are not used as Phase 3 representative-data results.

## Limits of these results

The resource series has two runs per size on one device, not a broad benchmark distribution, and does not compare Parquet. `performance.memory` reported a flat 10,000,000-byte main-realm value at 50 ms sampling intervals; that non-standard/coarse reading does not measure Worker heap or establish a peak. `navigator.storage.estimate()` is approximate and origin-level. No quota error, forced storage failure, whole-browser restart, or durable recovery test was performed.

## Phase 3 resource and storage-lifecycle evidence

All Phase 3 browser reports are raw JSON from Android Chrome 156.0.8078.73 on the an Android phone environment, at secure localhost with OPFS available. Reports use generated deterministic test data only. Keep them alongside Phase 2 evidence; no Phase 2 record was replaced.

### Resource runs

- `phase-3-browser-20261102T131947Z-894cac4c.json` — original complete matrix: six generated workload families × three input targets × three trials (54 imports). Forty-five trials passed full paged row decoding, footer validation, and sampled value/order checks. Nine mixed-length-text trials failed sampled value equality; the initial report did not yet retain full mismatch details.
- `phase-3-browser-20261102T132117Z-ef61b333.json` and `phase-3-browser-20261102T132140Z-0472f07b.json` — focused small-fixture mismatch reproduction and diagnostic. `unpackRows()` and full `unpack()` both decoded the first empty `body` as the next row's 8-character token.
- `phase-3-browser-20261102T132453Z-30069226.json` — corrected follow-up matrix for mixed-length text at all three sizes and three trials each. All 9 trials decoded every row and passed footer validation, but each had three wrong sampled string values. It records LFCP output size, block count, timings, and mismatch details. This report supersedes only the incomplete diagnostics in the first report; both are retained.

The workload definitions, per-size medians, ranges, and fixture limitations are documented in `docs/architecture/BROWSER-VALIDATION.md`. Compression ratios describe these generated inputs only; no Parquet comparison was made.

**Fixture metadata correction:** the raw resource reports' `fixtureMethod` string says the generated-source chunks were at most 32 KiB. The generator actually flushes at a 32 KiB threshold without splitting a JSONL row, and its measured `sourceChunkBytesMax` reached 35,162 bytes. The raw JSON remains unchanged; use the counter and the corrected description in `BROWSER-VALIDATION.md`.

### OPFS lifecycle runs

- `phase-3-browser-20261102T131711Z-e95b3fcd.json`, `phase-3-browser-20261102T131952Z-686661f3.json`, and `phase-3-browser-20261102T132203Z-3f45ca5c.json` — stage-gated Worker termination observations at file creation, writable open, after a write call, and before finalization. The filename was visible at all stages; `getFile()` showed zero bytes and the reader rejected it as too short after termination.
- `phase-3-browser-20261102T132015Z-0c1e8e0a.json` — completed 256-row LFCP file prepared and fully validated before browser restart.
- `phase-3-browser-20261102T132227Z-94b2fa1c.json` — Worker paused at the finalization gate with a generated output entry visible as zero bytes; setup for whole-browser closure.
- `phase-3-browser-20261102T132344Z-255efc0a.json` — after Chrome force-stop/reopen, the completed dataset had identical OPFS name, size, and lastModified, and all 256 values/order decoded correctly; generated file then removed.
- `phase-3-browser-20261102T132344Z-9e4c125c.json` — after that same browser restart, the interrupted pre-close entry remained at zero bytes without a marker and was rejected by the reader; generated file then removed.
- `phase-3-browser-20261102T132615Z-2d02e41c.json` — read-only artifact audit: no `phase3-` OPFS entries and no Phase 3 lifecycle manifests remained.

The repeated stage probes at 13:19 and 13:22 and the focused reruns are retained. Their repeated behavior is consistent, but all observations are from one Chrome build. `storage.persisted()` was false, `FileSystemHandle.move` was not exposed, and no quota-failure, eviction, device-reboot, or power-loss test was performed. No general durability or atomic-rename guarantee is established.

### Phase 3 memory limits

`performance.memory` stayed at a reported 10,000,000 bytes in the page realm, with 50 ms sampling. The Worker did not expose that API; `measureUserAgentSpecificMemory()` was also unavailable. Android's app UID could not inspect Chrome process memory (`dumpsys` permission/service unavailable; `/proc` and `top` did not expose Chrome). The browser's 8 GiB `deviceMemory` value is a coarse hint. These results do not establish peak browser-process memory or bounded end-to-end memory.

## Phase 4–5 string-writer correctness evidence

- `phase-4-variable-string-roundtrip-20261102.json` — deterministic Node regression matrix against LFC-pack 0.4.19. It records the expected current failure across optimized writer/reader API cases and passing fallback controls. The test exits nonzero while the defect is present.
- `phase-5-optimized-string-writer-20261102.json`, `phase-5-optimized-string-writer-final-20261102.json`, and `phase-5-optimized-string-writer-final-v2-20261102.json` — retained initial diagnostic captures while the observer and reporting were refined. Keep these as investigation history; they are superseded for the final branch-level summary by the v3 record below.
- `phase-5-optimized-string-writer-final-v3-20261102.json` — final diagnostic capture: 12 cases, eight optimized-path mismatches, four passing controls, and byte-for-byte equivalence between the canonical writer and the instrumented copy. It records the helper input cells, `strdict` output, selected frame, and block metadata for the minimal and cardinality fixtures.

The exact root cause and reproducible command are documented in `docs/lfcp/OPTIMIZED-STRING-WRITER-DIAGNOSTICS.md`. These are small correctness diagnostics, not performance measurements. At the Phase 5 handoff, the Phase 4 regression still exited 1 with 98 failed API checks across 49 case records. Phase 6's before/after suite results are recorded below.

## Phase 6 isolated string-writer correction

- `phase-6-string-writer-fix-20261102.json` — initial 19-case candidate comparison. Preserved as the first run record.
- `phase-6-string-writer-fix-final-20261102.json` — retained targeted matrix after adding assertions that both all-values branches retain type `s` and dictionary controls retain type `D`. Its nested control uses row decoding; the record's flat-column applicability flag was refined in the v2 record below.
- `phase-6-string-writer-fix-final-v2-20261102.json` — authoritative 19-case targeted matrix: all fixed cases passed; eight cases still fail on the untouched pinned vendor. Nested-block column values are marked not applicable; row values and cardinality pass.

The existing 49-case harness was run against both artifacts: pinned vendor 98 failed checks / exit 1; isolated corrected candidate 0 failed checks / exit 0. See `docs/lfcp/OPTIMIZED-STRING-WRITER-DIAGNOSTICS.md` for the patch, compiler, limitations, and exact commands. The corrected candidate is experimental and does not replace or change the canonical vendor artifact.

## Phase 7 candidate validation

Phase 7 independently rebuilt the corrected flat-scan module and reran the candidate against Node and Android Chrome. These are validation records for the isolated candidate; they do not change the canonical vendor artifact or imply cross-browser support.

- `phase-7-targeted-node-20261102.json` — 19 targeted writer cases; all 19 pass with the candidate, while eight matching vendor cases reproduce the known defect.
- `phase-7-node-regression-20261102.json` — the 49-case API harness; pinned vendor: 98 failed checks / exit 1; candidate: zero failed checks / exit 0.
- `phase-7-browser-candidate-20261102T172809Z-46543fb2.json` — Android Chrome 156 on an Android phone, 19 candidate checks passed and the pinned-vendor negative control reproduced the mismatch. This is the fuller browser environment record.
- `phase-7-browser-candidate-20261102T165903Z-1ca586d2.json` — earlier browser run with equivalent functional outcomes and less detailed user-agent data; retained as separate evidence.

The clean rebuild `experiments/fixes/lfc-pack-0.4.19-string-writer/flatscan-rebuilt-20261102.wasm` is byte-identical to `flatscan-fixed-v2.wasm` for the recorded Clang/wasm-ld 21.1.8 toolchain and flags. Firefox was unavailable; no cross-engine result is claimed. See `docs/lfcp/CANDIDATE-INTEGRATION-READINESS.md` for methodology, API/build provenance, limitations, and integration options.

## Phase 8 CSP and Worker qualification

Authoritative Phase 8 browser records are the final policy matrix from Android Chrome 156 / an Android phone:

- `phase-8-browser-strict-20261102T192745Z-afbc49f8.json` — 20/20 passed under `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none`.
- `phase-8-browser-no_wasm-20261102T192745Z-e72d5ac0.json` — expected policy denial: WebAssembly initialization was blocked when `wasm-unsafe-eval` was removed.
- `phase-8-browser-no_blob_worker-20261102T192746Z-336f5ecc.json` — expected policy denial: parallel packing's Blob Worker raised an error before initialization; its promise rejected. Ordinary, streaming, and string regression cases passed.
- `phase-8-browser-no_connect-20261102T192748Z-d586bb7d.json` — 20/20 passed under `connect-src 'none'`; the test page itself made no report request and handed its generated report through session storage to a later local collector page.

Earlier strict and no-Blob records are retained too. The strict `T175851` run exposed reuse of a cached helper in the first fault-injection setup; `T182240` and the final matrix passed after reordering the test. The first `no_blob_worker` run at `T192706` had an incorrect expectation that CSP prevents Worker object construction; it in fact constructed the object and asynchronously blocked startup. The corrected `T192746` record captures that behavior. These are harness diagnostics, not candidate failures. See `docs/lfcp/DEPLOYMENT-QUALIFICATION-PHASE8.md` and `experiments/fixes/lfc-pack-0.4.19-string-writer/phase8-validation/README.md` for exact reproduction steps and scope.
