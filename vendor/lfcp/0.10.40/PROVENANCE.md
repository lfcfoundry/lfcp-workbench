# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.10.40
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `566bd7d` on JS-modules `main` (PR 740, "lfc-pack 0.10.40 (Firefox row saves, row-loop shape check)"), fetched 2026.11.15
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `09e10ed9b33c99a89b8773d1ad8820430f807b57`
- SHA-256 of the source object and vendored file: `fcd1f3a25a7892a8d2498fdeffcf8b3867e271b7368baa895be19b344b3cc648`
- File size: 646273 bytes

## Why this pin exists

Staged columns hand text columns as bytes to packBlock (wasm byte-column kernel, 0.10.39) and low-variety columns as { kind: 'dict', labels, ids } (0.10.38).

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
