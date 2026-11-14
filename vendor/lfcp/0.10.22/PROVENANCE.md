# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.10.22
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `45bf4aa091485145851a216b2433ce7717ae623b` on JS-modules `main` (PR 698, "lfc-pack 0.10.22: first-call speedup (B43) and per-column XXH64 checks by default (B44)"), fetched 2026.11.14
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `4fb059ec18af1ed91b5739fe944561ea30957d09`
- SHA-256 of the source object and vendored file: `3fae7ee2da5f37eb7bf150c5a9d9057dafec6b97131cefe86040ce544fbd752a`
- File size: 590658 bytes

## Why this pin exists

0.10.21 adds a wasm bit-unpack (faster whole-column reads), `aggregate`, and `nulls: 'NaN'`; 0.10.22 speeds up the first aggregate call and writes a per-column check by default (older readers still open the files). Stored files grow slightly because of the checks; the Workbench's size and speed are re-timed in the PR that adopts this pin. Older pins stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
