# Optimized flat string writer diagnostics

**Phase 5 status:** the LFC-pack 0.4.19 optimized flat-writer defect was localized to a missing delimiter in two embedded `strdict` output loops; Phase 5 included no fix. The Phase 6 isolated fix candidate and verification are appended below. The canonical vendor artifact remains unchanged.

## Evidence and reproduction fixtures

The investigation used `vendor/lfcp/0.4.19/lfc-pack.js` (LFC-pack 0.4.19 / API 0), in the Workbench checkout at `main`, HEAD `48120ba885aadcc84d4d70ab02df89460f410137`. Its provenance records JS-modules commit `6e16aa8044d0a05bafa7c756c949f3537c23e92a` and JavaScript source blob `dae1cf4a7d9f6f568ea05447f57e9158e7396091`.

**Verified by execution:** `experiments/diagnostics/lfc-pack-0.4.19-string-writer/run-diagnostics.cjs` uses literal JavaScript arrays as the independent expected values; the expected side does not use the LFCP reader or the Phase 3 fixture generator. It tests:

- Four-row minimal failure: `['', 'A', 'B', 'C']`.
- Six-row mixed lengths: `['', 'VTx8vKxt', 'A'.repeat(40), 'B'.repeat(256), 'C'.repeat(1024), 'D'.repeat(4096)]`.
- Eight-row cardinality sweep from two through eight distinct values.
- Four-row repeated-value case: `['', 'A', 'A', 'A']`.
- The same four-row minimal fixture through the JavaScript flat-writer fallback and nested-block writer.

`benchmarks/results/phase-5-optimized-string-writer-final-v3-20261102.json` records 12 executions: eight fast-writer semantic failures and four passing controls. Every decoded field is compared. The footer is independently opened and accepted. The diagnostic runner also verifies that the canonical and instrumented writers emit byte-identical files, and that enabling versus disabling its observer does not change file bytes. The run used Node.js `v26.13.0`, Android `arm64`.

The existing comprehensive regression `tests/lfcp-variable-length-string-roundtrip.cjs` was rerun. It exited 1 as expected while the defect remains: 49 case records and 98 failing API checks. The smallest fixture's four body results are expected `['', 'A', 'B', 'C']`, actual `['A', 'B', 'C', undefined]`. Footer rows remain four. The existing regression is the future-fix acceptance check; it must pass after a corrected implementation.

## Diagnostic-copy provenance and instrumentation

`experiments/diagnostics/lfc-pack-0.4.19-string-writer/lfc-pack-instrumented.js` is an isolated copy of the pinned JavaScript artifact with an opt-in observer. `flatscan-source.c` is an unmodified copy of `modules/lfc-pack/wasm/flatscan.c` read from the exact local JS-modules commit above. Its Git blob is `21a0aeb1a3e9fa4fd74deddc9952df710d604890`; its SHA-256 is `14d8f0c3cd4c841404be5275a2472528e58abd21f3d74173ec69095963adcb60`. The diagnostic JavaScript copy SHA-256 is `b8da7b8995f3aa324e4aa972dfb63c436695b61b08ad074f3ed0d46c990b24c7`.

Instrumentation observes the input cells and byte offsets, calls the unchanged embedded Wasm helper, then snapshots the return words, scratch arrays, and output bytes. It does not write to Wasm memory or mutate inputs. The runner asserts byte-for-byte equivalence to the canonical vendor artifact and checks traced/untraced output equivalence. It adds JS allocations and observation time, so its timings are not performance measurements. The embedded Wasm is unchanged. The C source corresponds to the package's declared source revision; the test directly measures the embedded Wasm's output, and source inspection identifies the matching operation.

Run from the repository root:

```sh
node experiments/diagnostics/lfc-pack-0.4.19-string-writer/run-diagnostics.cjs
node tests/lfcp-variable-length-string-roundtrip.cjs
```

The first command creates a new, exclusive result record; it refuses to overwrite an existing result. The second is expected to exit nonzero until the writer is corrected.

## Optimized writer path

**Verified in source:** eligible ASCII flat blocks enter `writeFlatBlockFast()` in `vendor/lfcp/0.4.19/lfc-pack.js` (around lines 1108–1190). For candidate string columns it passes input bytes plus `cval`, `clen`, and row-cell indices to the embedded `W.x.strdict` function (around lines 1148–1156). A zero return with `res[2]` set selects the `sOnly` joined-string representation; a nonzero return may select a dictionary or a joined-all-values representation according to `D*4 > count` (around lines 1160–1170). The flat block retains the row count and declares the string column's type and frame length when assembled (around lines 1200–1230).

The exact matching source is `JS-modules/modules/lfc-pack/wasm/flatscan.c` at commit `6e16aa8044d0a05bafa7c756c949f3537c23e92a`, `strdict()` lines 190–212. The embedded-helper entry point is the `strdict` export. The source comment specifies that its output is distinct values or all values joined by zero bytes.

## Stage-by-stage comparison

For the minimal input, optimized writer cell mapping is correct before the helper:

| Row | Cell index | Input byte offset | Byte length | Value |
|---:|---:|---:|---:|---|
| 0 | 1 | 16 | 0 | empty |
| 1 | 3 | 35 | 1 | `A` |
| 2 | 5 | 55 | 1 | `B` |
| 3 | 7 | 75 | 1 | `C` |

The fast helper reports `n=4`, return `D=0`, result words `[5, 0, 1, 0]`, and joined bytes `41 00 42 00 43` (`A\0B\0C`). `res[2]=1` selects the all-values string path. The fast block then declares type `s`, four values, and a five-byte raw frame. Splitting that string yields three strings, which the reader places into four rows without checking the count.

The JavaScript fallback receives the same four values. Its observed first-seen labels are `['', 'A', 'B']`; the partially populated dictionary indices are not used for this high-cardinality choice. The selected type is also `s`, but the fallback joins the full vector and emits six bytes, `00 41 00 42 00 43` (`\0A\0B\0C`). It decodes correctly. Thus the first divergence is after correct input cell mapping, inside the optimized helper's joined-output construction; type selection and format framing occur afterward.

For the six-row fixture, the helper emits 5,428 bytes rather than the required 5,429 bytes (5,424 UTF-8 data bytes plus five separators). Its first output byte is the first character of `VTx8vKxt`; decoded values shift left and the final value is absent. The JSONL serializer, expected values, and byte offsets are independently constructed and captured before the helper call.

## First incorrect operation and root cause

**Established in source and confirmed by captured helper output:** `strdict()` has two all-values join loops with the same incorrect delimiter condition:

- `flatscan.c` line 204: the early more-than-half-distinct path (`D*2 > n` while scanning).
- `flatscan.c` line 210: the post-scan all-values path (`D*4 > n` or `D >= 65536`).

Both loops start with `o=0` and use `if(o) out[o++]=0` before each value. The decision is based on whether any bytes have been written, but separators are required based on whether this is a later logical value. When the first value is empty, copying it leaves `o` at zero. The condition is therefore false again for the second value and the required leading separator is omitted. The correct condition for delimiting these loops is the logical loop position (`i`), as the dictionary-label loop immediately below already uses `if(i)`.

The last correct intermediate is the `ix` order and each selected cell's offset/length/content. The first incorrect intermediate is `sout` after the relevant C loop. The output length/result flags and final `s` frame then faithfully carry the already-short vector. No string length, UTF-8 byte count, or reader interpretation is needed to explain this defect.

The observed cardinality sweep follows the two separate affected branches, explaining its non-monotonic result:

| 8 rows / distinct values | Helper choice | Result |
|---:|---|---|
| 2 | dictionary labels and codes | Pass; dictionary join uses `if(i)` |
| 3–4 | post-scan all-values join because `D*4 > n` | Fail; missing first separator |
| 5 | helper returns zero without valid joined output; JS fallback handles the column | Pass |
| 6–8 | early all-values join once `D*2 > n` during the scan | Fail; missing first separator |

The four-row unique fixture triggers the early branch. The four-row repeated fixture with two distinct values triggers the post-scan branch. Both therefore fail for the same delimiter bug. These results do not imply that every empty-first string column fails; dictionary and fallback paths are controls that pass.

## Reader behavior is a separate robustness issue

**Verified in source and execution:** the type-`s` reader decodes the frame and splits on NUL but does not require the resulting vector length to equal the declared column count `n` (`vendor/lfcp/0.4.19/lfc-pack.js`, `decodeColumn()`, around line 1033). The block/footer row count can consequently validate even when the string frame contains too few values. This reader behavior did not cause the malformed writer bytes and must not be used as a substitute for fixing the writer.

Record reader count checking separately as requirement `LFCP-WB-PHASE5-002` in `docs/lfcp/REQUIREMENTS.md`. It should reject a type-`s` vector/count mismatch as damaged data. It cannot restore omitted source values.

## Correction layer, compatibility, and remaining questions

**Proposed corrective layer:** correct both delimiter conditions in the LFCP optimized C/Wasm writer implementation and rebuild through the normal LFC-pack source pipeline upstream. No LFCP format change is indicated: the JavaScript writer emits the existing valid type-`s` representation, and the current reader reads it correctly. A corrected vendor release/source update is required before the canonical artifact can change. This phase does not implement or stage such an update.

**Compatibility implications:** corrected output retains type `s`, the same NUL-separated value semantics, and the same declared count. Existing readers already accept that representation. Files already written with a lost value cannot recover it from the LFCP file; re-import requires the original source. Reader hardening may turn affected files into explicit errors and should be evaluated separately against existing files.

**Remaining questions:** the delimiter root cause is established for the captured optimized helper and source revision. This investigation did not inspect later upstream releases, validate a rebuilt/patched Wasm artifact, or test all string encodings and browser engines. Those are follow-up validation tasks, not unresolved alternatives for the observed defect.

## Regression coverage required for a future writer fix

Keep `tests/lfcp-variable-length-string-roundtrip.cjs` as the expected-failing-before-fix, expected-passing-after-fix suite. It compares every row and field through `unpackRows()`, `unpack()`, and applicable column/text readers; checks footer and row counts separately; and includes boundary, cardinality, positions, UTF-8, null/missing, and multi-block cases. The diagnostic runner adds branch-level confirmation and passing JavaScript-flat and nested controls. A future correction should additionally retain focused cases for both faulty loops (four unique and four low-cardinality values with an initial empty), empty strings at later positions, empty repeated values, multiple blocks, and exact decoded-count validation. Do not treat a valid footer or count alone as semantic round-trip success.

## Phase 6: corrected candidate and verification

**Implemented in an isolated candidate:** `experiments/fixes/lfc-pack-0.4.19-string-writer/flatscan.c` changes only the two identified all-values delimiter predicates, from `if(o)` to `if(i)`. `i` is the ordinal of the value being emitted; a delimiter is required before every ordinal after zero even if all preceding values emitted zero bytes. `o` is a byte offset and therefore cannot tell whether an empty logical value has already been processed.

The modified source was compiled with the locally available Clang 21.1.8 wasm32 target into `flatscan-fixed-v2.wasm`. `build-fixed-copy.cjs` substitutes that module into a separate copy of the pinned JavaScript wrapper after verifying the vendor SHA-256. It does not modify `vendor/lfcp/0.4.19/lfc-pack.js`. The wrapper copy is a validation candidate; it is not promoted as the project’s canonical vendor artifact.

`tests/lfcp-optimized-string-writer-fix.cjs` runs 19 targeted fixtures against both pinned and fixed copies. All 19 fixed cases passed exact decoded-row equality and cardinality checks; each flat case also passed `unpackColumns()` value equality. The nested control uses row decoding because `unpackColumns()` only accepts flat blocks. Eight of the corresponding vendor cases still mismatch, including both the early `D*2 > n` join and post-scan `D*4 > n` join. Empty middle/final, all-empty, single-empty, ordinary non-empty strings, dictionary encoding, JavaScript flat fallback, and nested controls pass on both copies. The cardinality sweep 2–8 passes on the fixed copy.

The original 49-case harness was extended only to accept an optional `LFCP_PACK_PATH`; its default remains the canonical vendor. Against the pinned artifact it remains at 98 failed checks / exit 1. Against the fixed candidate it passes all 49 case records with zero failed checks / exit 0, including `packRows`, `pack`, `packStream`, `packParallel`, all reader paths, cardinality, and multi-block coverage. The authoritative targeted capture is `benchmarks/results/phase-6-string-writer-fix-final-v2-20261102.json`; the first and initial targeted captures remain retained separately.

**Limitations:** this validates the corrected source compiled locally and embedded into a separate LFC-pack wrapper under Node.js on Android arm64. It is not a browser matrix, an upstream rebuild, or a released/vendor artifact. Clang 21.1.8 differs from the compiler used for the pinned build, so candidate binary identity with an upstream build is not expected. Semantic round-trip results are the acceptance evidence here; unchanged controls also retain byte-identical outputs in the targeted matrix. The canonical 0.4.19 artifact still has the reproduced defect until an explicitly authorized vendor update. Reader decoded-count validation remains a separate, unimplemented requirement.
