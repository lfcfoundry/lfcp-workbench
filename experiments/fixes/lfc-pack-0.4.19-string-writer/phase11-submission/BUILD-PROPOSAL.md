# Proposed LFC-pack flat-scan build documentation

**Proposal only.** This is not an upstream build script and must not be treated as an official recipe. It records the local reproducible candidate command and the missing upstream build contract.

## Local candidate build reproduced

Environment: Clang 21.1.8, wasm-ld/LLD 21.1.8, wasm32 target. No C runtime, headers, package downloads, or additional libraries are required by this compilation.

```sh
clang --target=wasm32 -O3 -nostdlib -fno-builtin -mbulk-memory \
  -Wl,--no-entry -Wl,--export-dynamic -Wl,--export=__heap_base \
  -Wl,--initial-memory=1048576 -Wl,--max-memory=1073741824 \
  -Wl,-z,stack-size=65536 -Wl,--strip-all \
  -o flatscan-fixed-v2.wasm flatscan.c
```

For the corrected Phase 9 reproduction, the output was directed to `flatscan-corrected-rebuild-20261102.wasm` in this directory. It is byte-identical to the retained Phase 6 `flatscan-fixed-v2.wasm`: 13,391 bytes, SHA-256 `80a8332b64fa28697fbea3a054579076ed217b64e1c28078fc95fedd5a6d3c8a`. The source is the isolated corrected `flatscan.c`, not an upstream edit.

## Existing upstream build gap

At `JS-modules` `origin/main` commit `6e16aa8044d0a05bafa7c756c949f3537c23e92a`, `modules/lfc-pack/build.py` embeds `wasm/flatscan.wasm` as base64 in `lfc-pack.js`; it does not invoke a compiler. `wasm/build-core.sh` builds `core.c`, and `wasm/build.sh` builds Zstandard. Neither builds `flatscan.c`.

Using the candidate flags above to compile the unmodified upstream `flatscan.c` produced a 13,342-byte module with SHA-256 `92494f9689651d2725f159fff06739593b213d659bad6cf774c3c197643432f7`. The checked-in upstream module is 13,718 bytes with SHA-256 `a6611fa9e977d8b8c998f231130c89a4e46f695ce9549a9fd7c6b6cc34f4e31c`; the output was **not** byte-identical. These candidate flags therefore reproduce the corrected candidate but do not reproduce the existing upstream binary. With no recorded upstream command/toolchain, the size/hash difference cannot be assigned to a specific compiler, linker, optimization, or source difference.

## Recommended upstream documentation change

Add a dedicated `wasm/build-flatscan.sh` or equivalent that:

1. States and checks the supported Clang/wasm-ld versions and wasm32 target.
2. Uses exact compiler and linker flags, with memory limits and required exports documented.
3. Builds to a temporary/new output and refuses to overwrite the checked-in artifact unless an explicit update step is requested.
4. Prints the resulting byte count and SHA-256 and validates the expected exports.
5. Documents how `build.py` embeds the verified Wasm bytes into `lfc-pack.js` and regenerates the other package outputs.
6. Runs the LFC-pack tests and verifies the embedded base64 decodes byte-for-byte to `wasm/flatscan.wasm`.
7. Records the generated artifact hash, source commit, and toolchain in the module changelog or a build-provenance record.

The command above is a candidate proposal, not an endorsed upstream choice. The maintainers should first determine which existing toolchain generated the current artifact and decide whether exact historical reproduction or a deliberate new toolchain baseline is the goal. Package generation writes files in the source tree, so an eventual build should run in an authorized isolated checkout and review every generated diff.
