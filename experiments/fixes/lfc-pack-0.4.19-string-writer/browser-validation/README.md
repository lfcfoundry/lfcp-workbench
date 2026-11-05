# Phase 7 browser validation

This page runs generated-data tests against the pinned LFC-pack artifact and the Phase 6 corrected candidate in a real browser. It tests the candidate's flat-row APIs, `packStream()` with 13-byte input chunks, and `packParallel()` across two flat blocks. The pinned-vendor check is a negative control and is expected to reproduce the known mismatch.

## Run

From the repository root, start the loopback-only server:

```sh
python3 experiments/fixes/lfc-pack-0.4.19-string-writer/browser-validation/server.py
```

Open `http://127.0.0.1:8080/experiments/fixes/lfc-pack-0.4.19-string-writer/browser-validation/index.html` in a browser. The page records its generated test report through the same-origin loopback endpoint in a new `benchmarks/results/phase-7-browser-candidate-*.json` file. The receiver uses exclusive file creation and refuses requests from other origins. Stop the server with Ctrl-C after testing.

All scripts and test data are served from this repository on loopback; the page sends no data to remote services and uses only generated values. `localhost` is a secure context for WebAssembly. No dependencies are required.

## Environment and result

The tested Android Chrome reported brand/version `Google Chrome 156`, model Android phone, platform Android, and `isSecureContext`, WebAssembly, Worker, and Streams support. The reduced user-agent data did not expose the full patch version. The test reported 19 candidate passes and reproduced the pinned vendor failure. See the Phase 7 result records in `benchmarks/results/`.

Firefox was not installed in the available Android environment, and no Firefox or desktop Chromium executable was available in Termux. This result is specific to the tested Chrome environment; it does not establish cross-browser compatibility.
