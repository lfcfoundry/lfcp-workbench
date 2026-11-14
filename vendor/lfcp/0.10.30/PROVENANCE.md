# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.10.30
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `313dcd4` on JS-modules `main` (PR 711, "lfc-pack 0.10.30: ASCII text columns written straight to bytes (B51)"), fetched 2026.11.14
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `5c865f7c16f2698d3e4219d5c3fef5a4c4fae7be`
- SHA-256 of the source object and vendored file: `2a4eb4242901fc0a2a7537cbedb84bcf4ffb5c3f49fe9778eebab2d53f9beede`
- File size: 608730 bytes

## Why this pin exists

The staged-columns build (a branch stacked on PR 30, not yet merged) needs `packBlock(columns)` (0.10.27) with ASCII text columns written straight to bytes (0.10.30). PR 30 itself stays on 0.10.28.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
