# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.10.38
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `087f94d` on JS-modules `main` (PR 737, "lfc-pack 0.10.38: packBlock takes dictionary columns (kind: 'dict')"), fetched 2026.11.15
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `f600749eab9fa3ab5fd0f7966bacd98193d5bcaa`
- SHA-256 of the source object and vendored file: `7ae47cac79022e08bdfc1c34bfa4db01d450b30dce90f3745f548860d56b9802`
- File size: 637813 bytes

## Why this pin exists

Staged columns hand low-variety text columns to `packBlock` as `{ kind: 'dict', labels, ids }` (0.10.38), which packs the same bytes in about a quarter of the time.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
