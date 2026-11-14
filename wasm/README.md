# WebAssembly sources

- `colbuild.c`: staged columns builder (CSV lines to typed columns). Build: `clang --target=wasm32 -O3 -nostdlib -msimd128 -mbulk-memory -Wl,--no-entry -Wl,--export-memory -Wl,--initial-memory=33554432 -Wl,--export=__heap_base -Wl,--strip-all colbuild.c -o colbuild.wasm`.
  Derived from the row builder (`rb3.c`, kept in the research findings) and the staged-columns probe; credits in `docs/CREDITS.md`.
