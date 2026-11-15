# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.13.3
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `480d71d` on JS-modules `main` (PR 742, "lfc-pack 0.13.3 (Firefox join-all and indexed fill)"), fetched 2026.11.15
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `b8beaa873efe1a2c8ce58574fba02913ac476aeb`
- SHA-256 of the source object and vendored file: `e630029c901214c47e6e50a77c3ebaf3d20e7a38764bffcb3964a1b9386a2b2f`
- File size: 662555 bytes

## Why this pin exists

File format minor 3 (dates as numbers from 0.11.0; space-separated timestamps from 0.13.3): readers older than 0.13.3 cannot open such files; the Workbench reader and writer are the same version. Staged columns hand text columns as bytes to packBlock (wasm byte-column kernel, 0.10.39) and low-variety columns as { kind: 'dict', labels, ids } (0.10.38).

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
