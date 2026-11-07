# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.4.24
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `acf5df1c0d4831ce8b342e94068c3c0ec5e4b2f4` on JS-modules `main` (PR 459, "packTables and packRows read row text from one JSON.stringify per array"), fetched 2026.11.05
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `a951f80c6b2881970e1331c2f8c69da0f2ea5015`
- SHA-256 of the source object and vendored file: `129712204acb610acac2cc60dd570151a9a9f907fbc0be449db67b644fcd5131`
- File size: 382074 bytes

## Why this pin exists

Includes the empty-string fix (0.4.21), the faster first open (0.4.22), 0.4.23 (auto mode skips the timed template read check) and 0.4.24 (faster packTables and packRows). The owner approved this pin on a Claude branch. 0.4.19, 0.4.21 and 0.4.22 stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
