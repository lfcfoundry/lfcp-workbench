# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.7.2
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `1aabf448f75f64fe2599f917a05b3a210548c0ba` on JS-modules `main` (PR 645, "lfc-pack 0.7.2: fix lost non-ASCII flag in the SIMD line counter"), fetched 2026.11.08
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `f47777cbd279e14a4ffd4d49c803418466c1ad68`
- SHA-256 of the source object and vendored file: `747df574c3f90f54443c2d24645f39a9962560ee3b0a71cf179dffa9702eee84`
- File size: 420641 bytes

## Why this pin exists

Faster packing of flat rows (SIMD line counter, quicker string dictionary) with the same file bytes and no API change. Version 0.7.1 had a bug (lost non-ASCII flag) that the Workbench's variable-length-string round-trip probe caught; 0.7.2 fixes it. Older pins stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
