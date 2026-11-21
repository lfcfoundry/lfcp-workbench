# lfc-pack 0.14.10 vendor copy

- Source: https://github.com/lfcfoundry/JS-modules, modules/lfc-pack/lfc-pack.js at main commit 6a8fde6e (PR 848, 2026-11-21).
- Version 0.14.10, API 0. MIT, Copyright (c) 2026 LFC Foundry (LICENSE-JS-modules.txt); bundled zstd notice in NOTICE-zstd.txt.
- Since 0.14.9: wide-table packing skips per-column fixed costs (preview rows made when read, whole numbers counted without text, no size estimate up to 1,024 rows). Same bytes. 120 columns x 700 rows: 0.6 to 0.7 of the time in Chromium 156, Firefox 158, WebKitGTK 2.52.6.
- sha256 of lfc-pack.js: 1ae1ba53bb120209b498317ed81659f7f3f85076fdb84abf010613122621a962
