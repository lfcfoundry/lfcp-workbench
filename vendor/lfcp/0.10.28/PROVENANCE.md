# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.10.28
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `f15c426` on JS-modules `main` (PR 709, "lfc-pack 0.10.28: nested blocks no longer break column reads"), fetched 2026.11.14
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `35082f7ef50f7f24f81478fcd9230cf268ba0cc7`
- SHA-256 of the source object and vendored file: `08d3a6db1187075e284c8b8546e367bc7a62a6db63d63d544c80c0f278279c97`
- File size: 605700 bytes

## Why this pin exists

Carries 0.10.26 (`block(i, { rows })` reads only chosen rows of a block, used to show the visible rows of a sort), 0.10.27 (`packBlock(columns)`) and 0.10.28 (a nested block, which LFC-pack may write for a small block with empty number cells, no longer breaks column reads). The Workbench saves at `level: 3` (owner's choice 2026.11.14).

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
