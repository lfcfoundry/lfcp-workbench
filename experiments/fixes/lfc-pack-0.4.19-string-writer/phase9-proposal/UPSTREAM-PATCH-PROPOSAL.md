<!-- Copyright (c) 2026 LFC Foundry. MIT License. -->

# Draft upstream patch proposal — not submitted

## Summary

Correct two separator predicates in `modules/lfc-pack/wasm/flatscan.c` within `strdict()`’s all-values string joins. Use the value index (`i`) to decide whether a NUL separator precedes the value, rather than the current output offset (`o`). The change preserves LFC-pack API 0 and existing format semantics. It does not change the JavaScript fallback, dictionary encoding, readers, or format specification.

The exact two-line patch is `flatscan-string-separator.patch` in this directory. Its base is upstream `main` commit `6e16aa8044d0a05bafa7c756c949f3537c23e92a`, source blob `21a0aeb1a3e9fa4fd74deddc9952df710d604890`.

## Defect and reproduction

The two affected loops encode an all-values string vector as values separated by NUL bytes. An empty first value copies zero bytes, leaving `o == 0`; the next value is then treated as the first and gets no separator. The reader consequently sees a shorter/misaligned vector even though the footer row count remains correct.

Minimal logical input (flat layout, optimized writer):

```js
[
  { id: 0, body: '' },
  { id: 1, body: 'A' },
  { id: 2, body: 'B' },
  { id: 3, body: 'C' }
]
```

Expected decoded `body`: `['', 'A', 'B', 'C']`. In the retained `unpackRows()` negative-control record, pinned LFC-pack 0.4.19 returns the shifted values `A`, `B`, and `C`, then an `undefined`/missing `body` value for the fourth row; footer validation and the declared/returned four-row count still pass. This is the runtime value recorded by the harness, not a JSON-serialized representation. The full deterministic investigation covers empty values at multiple positions, consecutive/all-empty strings, repeated/unique values, cardinalities, writer/reader paths, multi-block cases, and fallback controls.

## Regression evidence

Phase 9 reran the existing Workbench harnesses without modifying either library:

- `phase9-19case-targeted.json`: corrected candidate passed 19/19; eight matching pinned-vendor cases reproduced the defect.
- `phase9-49case-candidate.json`: 49 API cases, zero failed checks.
- `phase9-49case-vendor-negative-control.json`: 49 cases and 98 failed checks on the pinned vendor, as expected.

The Phase 8 Android Chrome 156 run passed 20/20 checks under a strict CSP. It verified ordinary and streaming packing, all empty-string regression cases, two actual parallel Worker instances completing jobs, byte-identical parallel/sequential output, and propagation of an injected Worker startup error. The successful policy was:

```text
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

No `unsafe-inline` or JavaScript `unsafe-eval` was required. With `connect-src 'none'`, candidate operations still passed. Firefox was unavailable; no Firefox compatibility claim is made.

## Build and artifact provenance

The corrected C source builds reproducibly with local Clang 21.1.8 / wasm-ld 21.1.8 using the exact command in `BUILD-PROPOSAL.md`. The rebuilt corrected module is byte-identical to the candidate: 13,391 bytes, SHA-256 `80a8332b64fa28697fbea3a054579076ed217b64e1c28078fc95fedd5a6d3c8a`.

This does **not** reproduce the historical upstream module. The tracked upstream `flatscan.wasm` is 13,718 bytes, SHA-256 `a6611fa9e977d8b8c998f231130c89a4e46f695ce9549a9fd7c6b6cc34f4e31c`; it is byte-identical to the embedded `FSB64`, but the source tree does not document the flat-scan compiler or flags. Compiling the unmodified upstream source with the candidate flags yielded 13,342 bytes and SHA-256 `92494f9689651d2725f159fff06739593b213d659bad6cf774c3c197643432f7`, not a byte match. Therefore an official rebuild requires maintainer confirmation of source authority and a documented build contract.

## Proposed integration sequence

1. Confirm with maintainers that `flatscan.c` is authoritative and identify the historical Wasm build environment, or agree on a new pinned toolchain.
2. Add the two-line source change and a permanent empty-string regression to the upstream LFC-pack test suite.
3. Add a flat-scan Wasm build recipe with compiler/linker versions, flags, output checks, hashes, and an explicit embedding step. The existing `build.py` embeds a prebuilt Wasm module; it does not compile `flatscan.c`.
4. Rebuild in an isolated checkout, confirm expected exports and wrapper behavior, verify the embedded Wasm equals the standalone output, then inspect all generated package diffs.
5. Run the module suite (`node modules/lfc-pack/test/run.js`), the root suite required by `CONTRIBUTING.md` (`node tests/run.js`), the writer regressions, and the supported-browser matrix. Do not report Firefox until actually tested.
6. Record the resulting source commit, package version, toolchain, Wasm hash, package hash, licenses, and release/tag or other immutable artifact reference.

The existing MIT and Zstandard BSD-3-Clause notices remain applicable. The source correction changes no format bytes except correcting the intended separator in affected string vectors; maintainers should still run interop fixtures and document the release/version policy because the format remains pre-formal-release in the inspected README.
