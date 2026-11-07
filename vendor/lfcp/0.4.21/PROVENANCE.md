# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.4.21
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `4716d2b` on `main` (PR 453, "text columns that start with empty strings keep them"), shallow clone fetched 2026.11.05
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `cf676c582d54359b06ec33d0b5a952a7b8ce5c5d`
- SHA-256 of the source object and vendored file: `8bb5671bc5876db68b1acc382677d2fd45504e8bda3503bf3defbb86b361063f`
- File size: 378008 bytes

## Why this pin exists

0.4.19 silently drops leading empty strings in text columns (affects 0.4.15 to 0.4.20). 0.4.21 fixes it. The owner approved adding this pin on a Claude branch; 0.4.19 stays in place, unchanged, as the evidence artifact. The spike and its tests are not yet repointed.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
