# LFC-pack 0.4.19 string-writer diagnostics

This is an isolated diagnostic copy for Phase 5. It is not production code and is not used by the Workbench prototype.

## Provenance

- JavaScript base: canonical `vendor/lfcp/0.4.19/lfc-pack.js`, LFC-pack 0.4.19 / API 0.
- Upstream source reference: JS-modules `6e16aa8044d0a05bafa7c756c949f3537c23e92a`.
- JavaScript source blob: `dae1cf4a7d9f6f568ea05447f57e9158e7396091`.
- `flatscan-source.c`: read from the same local JS-modules commit's `modules/lfc-pack/wasm/flatscan.c` Git object; it is an unmodified source copy for inspection.
- License notices are copied from `vendor/lfcp/0.4.19/` and retained here.

`lfc-pack-instrumented.js` adds an opt-in observer around the fast writer and its `strdict` call. The observer snapshots values and buffers after the operation; it does not write into the library's input or Wasm memory. The observer is disabled by default. The harness verifies byte-for-byte equality against the canonical artifact and equality with observation enabled and disabled for every case. The embedded Wasm is unchanged.

## Run

From the repository root, with the already available Node.js runtime:

```sh
node experiments/diagnostics/lfc-pack-0.4.19-string-writer/run-diagnostics.cjs
```

The runner writes a new machine-readable record under `benchmarks/results/` using exclusive creation. It will fail rather than overwrite an existing result. It exercises the four-row minimal failure, six-row mixed lengths, eight-row cardinalities 2 through 8, a low-cardinality join, JavaScript flat fallback, and nested-block control. Expected values are literal in-memory fixture values, independent of decoded output.

This is a Node-level library diagnosis, not a browser benchmark. It does not modify the vendor artifact, LFCP specification, or any upstream repository.
