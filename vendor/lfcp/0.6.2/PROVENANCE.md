# Pinned LFC-pack artifact provenance

- Package: LFC-pack
- Version: 0.6.2
- API version: 0
- Source repository: `lfcfoundry/JS-modules`
- Source reference: `fafb751a1e951a1fa9ef523a9f2147f0ff59608d` on JS-modules `main` (PR 615, "packStream keeps pushed pieces and joins once per block"), fetched 2026.11.07
- Source path: `modules/lfc-pack/lfc-pack.js`
- Git blob: `cee02db64b685e44ca8c798e8c93ddbff0174e7f`
- SHA-256 of the source object and vendored file: `edc90b612a4c7f54ca8d04842ded3932819859e05e44ac3255d6b3a4aee60dcc`
- File size: 396090 bytes

## Why this pin exists

Small pushes into `packStream` no longer copy all waiting text on every push, so the Workbench's 64-row pushes into 2 MB blocks pack faster. The bytes written are the same as 0.5.9. The owner approved this pin on a Claude branch. Older pins stay as they are.

## Licensing

- LFC-pack project code: MIT; see `LICENSE-JS-modules.txt`.
- Embedded Zstandard 1.5.7: BSD-3-Clause; see `NOTICE-zstd.txt`.
