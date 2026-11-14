# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.10.19
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `16bf42ca30f623861e12e5b8588e95bcbc780dc4` on JS-modules `main` (file last changed in `ffb2680a537ab91143ab8620bf120e8db7037ffb`, PR 690, "lfc-pack 0.10.19: positions: true returns row numbers"), fetched 2026.11.14
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `6956d3f25ab5b00094fa3198fff4eaee9b604614`
- SHA-256 of the source object and vendored file: `47c5c4aa77180eae66f98327e2240ece790454e20fa8f7a4b83b723fb968db6a`
- File size: 570869 bytes

## Why this pin exists

`unpack(file, { equals or range, positions: true })` returns a Uint32Array of matching row numbers without building rows. Older pins stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
