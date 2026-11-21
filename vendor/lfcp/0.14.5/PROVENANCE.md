# lfc-pack 0.14.5 vendor copy

- Source: https://github.com/lfcfoundry/JS-modules, modules/lfc-pack/lfc-pack.js at main commit d9420493 (PR 812, 2026-11-21).
- Version 0.14.5, API 0. MIT, Copyright (c) 2026 LFC Foundry (LICENSE-JS-modules.txt); bundled zstd notice in NOTICE-zstd.txt.
- Since 0.14.4 (PR 806, date-time text columns): 0.14.5 sizes blocks from the bytes instead of building a row object and string per cell. Same bytes. 44 SBA-shaped text columns x 20,000 rows: Chromium 156 0.79x, Firefox 158 0.88x, WebKitGTK 2.52.6 0.79 to 0.87x.
- sha256 of lfc-pack.js: 00c14af94a48814d8498bdad557934015c543c44e0bcc495530e746d5647e757
