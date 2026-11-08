# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.7.0
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `049fbdc91cb54e49474e4782fded6296748e73e9` on JS-modules `main` (PR 629, "packBlock and pushPacked: blocks packed in worker threads, appended in order"), fetched 2026.11.08
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `2527f7958b1102ba7d42899979eeac9da1051c79`
- SHA-256 of the source object and vendored file: `900dee0d26c5d6f6c94b826d5bd59f72114b2226a477b7787d6a4d56c745f0fe`
- File size: 397958 bytes

## Why this pin exists

Adds `LfcPack.packBlock(chunk, opts)` (run in worker threads) and `packStream().pushPacked(bytes)` (run on the writer, in order). The Workbench uses them in Firefox to pack 2 MB blocks on two extra threads. The owner approved this pin on a Claude branch. Older pins stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
