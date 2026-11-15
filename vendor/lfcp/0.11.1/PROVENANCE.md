# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.11.1
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `7c8e765` on JS-modules `main` (PR 742, "lfc-pack 0.11.1 (Firefox join-all and indexed fill)"), fetched 2026.11.15
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `8aaeedf672b03fee54b951e1d2e5f992a848fa10`
- SHA-256 of the source object and vendored file: `bf793daf46bbc6beab3dd79c35bfd7d8f8a33563d2777612b2bdedbc4e16fa01`
- File size: 657833 bytes

## Why this pin exists

File format minor 2 (date columns stored as numbers from 0.11.0): the Workbench reader and writer are the same version. Staged columns hand text columns as bytes to packBlock (wasm byte-column kernel, 0.10.39) and low-variety columns as { kind: 'dict', labels, ids } (0.10.38).

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
