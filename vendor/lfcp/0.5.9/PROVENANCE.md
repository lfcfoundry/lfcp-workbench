# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.5.9
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `4897da0c6bd9c0650ece240858a0cd897cb42b36` on JS-modules `main` (PR 533, "open() reader gives one block's columns and the footer's number ranges"), fetched 2026.11.07
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `c694683ff5a1ae0c3925b241ca3c5575f6dd8587`
- SHA-256 of the source object and vendored file: `6015ae02beb0ea6c5067268c925fc67d8840a86303eef8a89732e686bd107782`
- File size: 390675 bytes

## Why this pin exists

Adds `R.columns(i, { keys })` (one block's columns, fetching only that block) and `R.zone(i, key)` (a number column's min, max and count from the footer) to the `LfcPack.open` reader. The Workbench uses columns() so filter and sort no longer read the whole file. The owner approved this pin on a Claude branch. Older pins (0.4.19, 0.4.21, 0.4.22, 0.4.24, 0.5.0) stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
