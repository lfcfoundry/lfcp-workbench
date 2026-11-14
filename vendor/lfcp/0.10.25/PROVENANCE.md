# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.10.25
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `6d88153e7cdf315b2b1354af8b541994d7108c2d` on JS-modules `main` (PR 705, "lfc-pack 0.10.25 (CP2-1): faster whole-column reads of number columns with empty values"), fetched 2026.11.14
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `2503c2eb2ab2fddb519c51ca134912be3bd3f3f3`
- SHA-256 of the source object and vendored file: `e028771ca355c86012494ca54fc78572e768636af6c0ee244be490ad136d4bba`
- File size: 593026 bytes

## Why this pin exists

Carries 0.10.23 (faster log and text-column saves), 0.10.24 (flat blocks at zstd level 2 by default) and 0.10.25 (faster whole-column reads of number columns with empty values). The Workbench saves at `level: 3` (owner's choice 2026.11.14), which keeps the 0.10.23 file bytes; the default level 2 made the stored file about 10% larger.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
