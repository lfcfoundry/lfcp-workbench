# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.4.22
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `d5f1079b769dfa7e6830c0152bd3356644e8cffb` on JS-modules `main` (PR 454, "faster first open, each column kind read by its own small function"), fetched 2026.11.05
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `95b4375a76248f5be4cbd3cf4530b5f528e9cc13`
- SHA-256 of the source object and vendored file: `22d85b3bf7226544e9f9da8e0362b667d20bd3447dc90635992e8be8bb51dbfd`
- File size: 378969 bytes

## Why this pin exists

0.4.19 silently drops leading empty strings in text columns (affects 0.4.15 to 0.4.20). 0.4.21 and later fix it; 0.4.22 also makes the first open faster on Chromium. The owner approved this pin on a Claude branch (0.4.23 exists on main and was not requested). 0.4.19 and 0.4.21 stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
