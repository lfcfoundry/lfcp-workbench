# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.5.0
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `225461b5d7e5c3c97a66d758e3b22c380854104e` on JS-modules `main` (PR 472, "LfcPack.open(file) reads big files a block at a time"), fetched 2026.11.05
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `1c2641392e004ed91ee64fd785e2d9b7a45915e1`
- SHA-256 of the source object and vendored file: `ee795867e9daeb85b303b96dc1dfcef740b417764d95169f6ea8b4d71003ad44`
- File size: 387217 bytes

## Why this pin exists

Adds `LfcPack.open(file)`: reads only the trailer and footer, then rows or blocks on demand, so the data view no longer needs the whole file in memory. The owner approved this pin on a Claude branch. Older pins (0.4.19, 0.4.21, 0.4.22, 0.4.24) stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
