# lfc-pack 0.14.6 vendor copy

- Source: https://github.com/lfcfoundry/JS-modules, modules/lfc-pack/lfc-pack.js at main commit da436e7b (PR 815 merged as e5c31b7, 2026-11-21; later commits do not touch lfc-pack).
- Version 0.14.6, API 0. MIT, Copyright (c) 2026 LFC Foundry (LICENSE-JS-modules.txt); bundled zstd notice in NOTICE-zstd.txt.
- Since 0.14.5: dictionary columns compress their label bytes once while layouts are tried. Same bytes. 44 SBA-shaped text columns x 20,000 rows: Chromium 156 0.963x, Firefox 158 0.968x, WebKitGTK 2.52.6 0.97 and 0.85.
- sha256 of lfc-pack.js: 8db2e314efe0f1966cad9febe0a1f0c029d86d2f8dd853fa840669ba50470b7e
