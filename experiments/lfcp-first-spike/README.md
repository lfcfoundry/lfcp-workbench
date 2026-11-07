# LFCFoundry Data Workbench — LFCP feasibility spike

This is an experimental snapshot of the isolated, dependency-free browser prototype. It is not production application code. The canonical repository keeps the single pinned LFCP build at `../../vendor/lfcp/0.4.19/lfc-pack.js`; its Worker import path is the only runtime source-path adjustment from the standalone copy.

It tests one narrow path:

```text
selected CSV / TSV / JSONL file
  → bounded file slices in a Web Worker
  → JSON values at the current writer boundary
  → pinned LFC-pack streaming writer
  → LFCP blocks and footer written to OPFS
  → bounded sample and profile shown in the page
```

It is an architecture experiment, not a production application. LFCP is the persisted dataset format in this experiment. The current reader's whole-file-buffer requirement is made visible rather than hidden.

## Run locally

No package installation or build step is required. Serve the repository root from a secure same-origin context. For example, from the `lfcp-workbench/` root, with Python already available:

```sh
python3 -m http.server 8080
```

Then open `http://localhost:8080/experiments/lfcp-first-spike/`. The app has no runtime network requests, CDN assets, remote fonts, telemetry, or upload path. Its CSP blocks connections with `connect-src 'none'`. The app needs a secure context for Workers and OPFS; browsers treat localhost as secure.

## What the spike does

- Reads CSV, TSV, and JSONL/NDJSON from a user-selected `File` in 64 KiB slices.
- Parses delimited input incrementally, including quoted fields, escaped quotes, CRLF, and UTF-8 split across file slices. It rejects malformed quotes and ragged rows rather than guessing.
- Keeps CSV/TSV values as strings; it does not infer or cast their types.
- Parses JSONL records as JSON values and serializes value-equivalent JSON lines for the current LFCP writer.
- Sends bounded line batches to `LfcPack.packStream()` and writes emitted LFCP bytes directly to an OPFS file. The selected library build is pinned below.
- Collects a capped sample and lightweight profile during ingestion; it does not reopen the complete output to construct the preview.
- Lists files in its OPFS subdirectory and marks a file complete only when its final four bytes are `LFC1`.
- Inspects a selected or stored LFCP file only up to 64 MiB. That inspection uses the whole-file reader API and loads the file into memory.

## Explicit limits

- There is no SQL engine, query planner, grid virtualization, visual transformation builder, charting, or general expression engine.
- There is no large-file LFCP random-access reader. Inspection is capped at 64 MiB because the pinned `LfcPack.info`, `stats`, and `unpackRows` APIs take the complete byte buffer.
- Current `packStream()` is a streaming writer for newline-delimited JSON input, not an end-to-end resumable stream protocol. It retains block metadata until `finish()` writes the footer. This prototype has no durable block checkpoint or interrupted-import resume.
- OPFS content is private to this browser origin, not a user-visible filesystem backup. Clearing browser site data can remove it. The prototype does not export to a user-selected ordinary file.
- CSV/TSV schema metadata is intentionally simple; fields are strings. JSONL profiling is a bounded observation, not a formal schema inference system.
- File size is constrained by browser storage quota and device resources. No maximum supported dataset size is claimed.
- A browser or Worker termination can leave an incomplete file. The prototype lists incomplete files and offers explicit removal; it does not silently remove them.

## Pinned code and licensing

The shared `../../vendor/lfcp/0.4.19/lfc-pack.js` is the one-file distribution at:

```text
JS-modules local refs/remotes/origin/main
commit 6e16aa8044d0a05bafa7c756c949f3537c23e92a
path modules/lfc-pack/lfc-pack.js
Git blob dae1cf4a7d9f6f568ea05447f57e9158e7396091
version 0.4.19, API 0
```

The JS-modules checkout itself remains at `0758e96ccc4579fb2c0ca81891d18b5ef57ee170`; its locally recorded `origin/main` object is divergent and is not verified current GitHub content. The project code is MIT-licensed. `../../vendor/lfcp/0.4.19/NOTICE-zstd.txt` preserves the Zstandard 1.5.7 BSD-3-Clause notice. No dependency was installed.

## Source map

- `app.js` — page state, progress, sample/profile display, local storage listing.
- `worker.js` — format routing, LFCP streaming writes, OPFS storage, bounded LFCP inspection.
- `src/adapters.js` — incremental delimited parser and delimiter/header helpers.
- `docs/lfcp-evolution.md` — proposed division of responsibilities and LFCP evolution requirements.
- `../../vendor/lfcp/0.4.19/` — one shared pinned LFCP browser build, licenses, notice, and provenance.

## Evidence and status

- **Verified in source:** The pinned library README identifies version 0.4.19/API 0 and says the format is not frozen.
- **Verified in source:** The prototype calls the current `packStream()` writer and persists the returned byte chunks, then footer, to OPFS.
- **Measured experimental result:** No throughput, peak-memory, storage-durability, compatibility, or browser-matrix benchmark has been run for this spike.
- **Proposed:** Use this prototype to guide a separately designed random-access LFCP reader/writer contract and LFCP-native execution layer. These prototype limits are not permanent format limits.
