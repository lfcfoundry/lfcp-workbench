# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.10.20
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `6b1fcb01cc00dcfcdcf76fe108e92667c1f27a5e` on JS-modules `main` (PR 694, "lfc-pack 0.10.20: small-file layout (B39k), no zone maps under 100 rows"), fetched 2026.11.14
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `0d479a5bfa0ffa8641e939ecb14567b07786e5ab`
- SHA-256 of the source object and vendored file: `65759ff6b031c57084e44177e2fa9c6b6fc26a29e66eec0bce3a03d15e79a3d3`
- File size: 576471 bytes

## Why this pin exists

Tables of 32 rows or fewer are stored about 20 to 50% smaller; one-block files under 100 rows have no zone maps, so zone() returns null for them (the Workbench's row-number filter path declines when a block has no zone, and falls back to the column path). Older pins stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
