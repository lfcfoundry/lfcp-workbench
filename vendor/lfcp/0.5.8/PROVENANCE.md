# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.5.8
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `2f692e5fbfece1c588216e4a5a6e16d83b85d27d` on JS-modules `main` (PR 531, "Firefox builds IP-address text in one go"), fetched 2026.11.07
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `a5f6ad9ca235af50656b037cd4a0e3ecb96544b7`
- SHA-256 of the source object and vendored file: `c76037589452a725cf52081f6af99cb4b987988694beacf5bbdf4cb591918cc4`
- File size: 389243 bytes

## Why this pin exists

Firefox first reads of IP-address columns are faster; values are identical. The owner approved this pin on a Claude branch. Older pins (0.4.19, 0.4.21, 0.4.22, 0.4.24, 0.5.0) stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
