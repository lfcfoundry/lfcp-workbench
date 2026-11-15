# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.10.42
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `d6dfab7` on JS-modules `main` (PR 742, "lfc-pack 0.10.42 (Firefox join-all and indexed fill)"), fetched 2026.11.15
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `2a8fd1a2bd50bd421baf0acaa43f2e36db2bc949`
- SHA-256 of the source object and vendored file: `04b2bfdc1ccc77dbc98ba9c0cf84bb03af5268e1fe62a53687fcc8e57b9a6061`
- File size: 647579 bytes

## Why this pin exists

Staged columns hand text columns as bytes to packBlock (wasm byte-column kernel, 0.10.39) and low-variety columns as { kind: 'dict', labels, ids } (0.10.38).

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
