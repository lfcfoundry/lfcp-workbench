# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.10.18
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `ba86478` on JS-modules `main` (file last changed in `38fd2c8c6d0bacaae368c6d8334abead4a70f16f`, PR 685, "lfc-pack 0.10.18: unpackRowsParallel (B38), WebKit reads on this thread"), fetched 2026.11.14
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `3d798b8dd5723a07cf6759ab85f744ff6bfc5911`
- SHA-256 of the source object and vendored file: `afd30efd64a73356baca2c9014e4222f7d47e07596dc671c6f92ccafa4f75128`
- File size: 564882 bytes

## Why this pin exists

Opens 0.10 files that have nullable columns (the null plane), which 0.7.2 cannot read, and carries every speed gain from 0.8 to 0.10.18. Older pins stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
