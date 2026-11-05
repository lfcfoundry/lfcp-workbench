# LFC-pack 0.4.19 optimized string-writer fix candidate

This directory contains an isolated corrected candidate for Phase 6. It is experimental validation material, not the canonical vendor artifact or an upstream release. The Phase 5 diagnostic copy and reports remain unchanged.

## Provenance and patch

- Base `flatscan.c`: JS-modules `modules/lfc-pack/wasm/flatscan.c`, commit `6e16aa8044d0a05bafa7c756c949f3537c23e92a`, blob `21a0aeb1a3e9fa4fd74deddc9952df710d604890`.
- `flatscan.c`: copy of the Phase 5 source evidence with only the two all-values join conditions changed from `if(o)` to `if(i)`.
- Compiler: local Clang 21.1.8, wasm32 target; no tools or dependencies were installed.
- Final candidate module: `flatscan-fixed-v2.wasm`, 13,391 bytes, SHA-256 `80a8332b64fa28697fbea3a054579076ed217b64e1c28078fc95fedd5a6d3c8a`.
- `lfc-pack-fixed.js`: exact pinned JavaScript wrapper with only its inline `FSB64` flat-scan module replaced by the candidate module. The builder asserts the input vendor SHA-256 is `8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259` and creates the output exclusively.
- MIT and Zstandard BSD-3-Clause notices are retained in this directory.

The first local compile, `flatscan-fixed.wasm`, lacked the exported `__heap_base` required by the wrapper. It is retained as an intermediate artifact; the builder uses `flatscan-fixed-v2.wasm`, compiled with the explicit heap-base export. The candidate module was validated for the required exports and exercised through the real LFC-pack wrapper and decoder.

## Rebuild and test

From this directory, the final compile command used was:

```sh
clang --target=wasm32 -O3 -nostdlib -fno-builtin -mbulk-memory \
  -Wl,--no-entry -Wl,--export-dynamic -Wl,--export=__heap_base \
  -Wl,--initial-memory=1048576 -Wl,--max-memory=1073741824 \
  -Wl,-z,stack-size=65536 -Wl,--strip-all \
  -o flatscan-fixed-v2.wasm flatscan.c
```

The current output is already present. The builder intentionally refuses to overwrite files; for another build, preserve the current candidate and use a new output filename in a copied/adjusted builder script.

From the repository root, run:

```sh
node tests/lfcp-optimized-string-writer-fix.cjs
LFCP_PACK_PATH=experiments/fixes/lfc-pack-0.4.19-string-writer/lfc-pack-fixed.js \
  node tests/lfcp-variable-length-string-roundtrip.cjs
```

The targeted test compares the fixed copy with the pinned baseline, checks footer and decoded cardinality separately, and asserts exact row values plus flat-column values where applicable. It covers both affected join branches, empty-string positions and runs, all-empty and single-empty controls, ordinary strings, the cardinality sweep, dictionary encoding, JavaScript fallback, and nested blocks. Machine-readable results are retained under `benchmarks/results/`.
