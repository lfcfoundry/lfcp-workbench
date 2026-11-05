# Browser validation and resource measurement

## Evidence status

**Verified in browser:** On 2026-11-02, Android Chrome `156.0.8078.73` on an Android phone / Android loaded the harness from `http://127.0.0.1:8080`. The page reported a secure context and OPFS availability. The 22-case functional matrix passed (15 output/readback cases and 7 expected malformed-input rejections); three generated resource workloads passed twice; two cooperative cancellation scenarios removed incomplete outputs; and an interrupted Worker left a visible zero-byte output with no `LFC1` marker. Raw JSON records are indexed in `benchmarks/results/README.md`.

**Not established:** This is one Android Chrome device and two runs per resource size. It does not establish cross-browser behavior, bounded end-to-end memory, browser-restart durability, quota behavior, production reliability, or production-scale performance. Early functional reports include a harness assertion bug and are retained with an explanation; the corrected final report passes. Node checks are recorded separately and are not substituted for the browser results.

The prototype source uses 64 KiB `File.slice()` reads in a Worker, incremental CSV/TSV parsing and JSONL line parsing, `LfcPack.packStream()` calls, and writes to an OPFS `FileSystemWritableFileStream`. Browser tests confirm those paths work for the generated cases and sizes on the stated device; they do not establish bounded end-to-end memory or larger-scale reliability.

## Test harness

Open `experiments/lfcp-first-spike/validation/` from a same-origin secure context. The harness uses the existing prototype Worker and pinned `vendor/lfcp/0.4.19/lfc-pack.js`; it has no external network dependency. Its CSP disallows connections. It generates deterministic input in the browser, records JSON results, and normally deletes its generated OPFS files. Leave **Keep successful test outputs** unchecked for routine runs.

The static server already available in the inspected environment is Python's standard-library HTTP server. From the repository root run:

```sh
python3 -m http.server 8080
```

Then navigate to `http://localhost:8080/experiments/lfcp-first-spike/validation/`. Browsers normally treat localhost as a secure context; this requirement still needs to be confirmed in each tested browser using the harness's `secureContext` result. HTTPS on a controlled local test server is another option. Do not expose the server to a network for these tests.

For a reproducible machine-readable capture without manually saving a browser download, use the test-only standard-library server instead:

```sh
python3 benchmarks/browser-test-server.py
```

It binds only to `127.0.0.1:8080`, serves the same static files, and accepts a report only from that same origin. The harness defaults to no report submission. Explicitly opt in using the **Send generated results** checkbox or `report=1` in the URL. For example:

```text
http://127.0.0.1:8080/experiments/lfcp-first-spike/validation/?run=functional&report=1
```

`run` may be `functional`, `resources`, `cancellation`, or `interruption`. These modes use only generated synthetic inputs. The opt-in POST sends the JSON test report (including synthetic sample values and device/runtime metadata) to the loopback server, which creates a unique file under `benchmarks/results/`. It does not send source files or user-selected data. The validation page allows same-origin `connect-src` only for this explicitly enabled report capture; the prototype application's own `index.html` continues to use `connect-src 'none'`. Do not expose the receiver beyond loopback.

Choose **Run generated functional matrix**, **Run 256 KiB / 4 MiB / 16 MiB resource series**, **Run cooperative cancellation checks**, and **Terminate Worker during OPFS write** separately. Save each JSON result before starting another series because the page presents the most recent run. The resource and failure series use only generated data, perform a quota estimate preflight for bulk source creation, and skip resource sizes if estimated free space is under three times the requested source size or an estimate is unavailable. Quota estimates are advisory and all generated source files are capped at 16 MiB. Cooperative cancellation is requested once after a progress message and once when the Worker reports the test-only `opfs-write` stage immediately before an awaited write. The interruption check terminates the Worker at the same write stage, observes whether a test output becomes visible/has an acceptable footer, then removes only newly created outputs with the `phase2-interrupt-source-` prefix.

For the original Phase 2 manual procedure, select **Keep successful test outputs**, run a small functional or resource test, save the JSON containing `outputName`, close and reopen the same browser profile, and inspect that named LFCP file. That Phase 2 procedure was not run then; the Phase 3 harness added and executed a separate exact-output persistence procedure described below.

## What the harness checks

### Functional matrix

The generated cases cover CSV, TSV, and JSONL, with expected rejection cases explicitly identified.

| Case | Expected behavior |
|---|---|
| Empty CSV | Reject: no header row. |
| Header-only CSV | Complete with zero data rows. |
| Quoted delimiter and doubled quote | Decode delimiter inside quotes and `""` as one quote. |
| Embedded newline | Preserve newline inside a quoted field as field content. |
| CRLF and LF | Parse both line-ending forms. |
| UTF-8 sequence crossing byte 64 KiB | Decode split multibyte sequence without replacement/corruption. |
| Record crossing byte 64 KiB | Keep parser state across input slices and return the whole record. |
| 128 KiB field | Accept below the prototype's 8 MiB record limit. |
| Empty and trailing fields | Preserve empty strings; normalize an empty header to `column_3` under current header rules. |
| Unclosed quote / text after closing quote | Reject as malformed; do not silently repair. |
| Invalid UTF-8 delimited input | Reject through fatal `TextDecoder`. |
| TSV | Use tab delimiter and preserve string values. |
| Empty JSONL | Complete with zero rows. |
| JSONL without final newline | Parse the final record. |
| Malformed JSONL | Reject. Blank JSONL lines are skipped by current implementation. |
| UTF-8 sequence crossing byte 64 KiB | Decode without corruption. |
| JSON null, absent property, empty string | Preserve current JSON object semantics through writer/readback. |
| 12,000-row JSONL | Decode all rows, check row count and require more than one LFCP block. |

Successful outputs are reopened with `LfcPack.info()` and decoded using `unpack()` for the 12,000-row multi-block case or `unpackRows()` for the other small cases. `info()` validates footer structure/checksum; the harness also flips a byte in the footer and expects the reader to reject it. The `LFC1` suffix is recorded but is not used as integrity evidence by itself. The successful decode exercises the reader's block decoding/checks on the decoded rows. The resource series decodes only a bounded first-row sample; it does not claim that every large-workload block was decoded.

### Resource series

Generated JSONL inputs target 256 KiB, 4 MiB, and 16 MiB. Each contains three fields and repeated deterministic rows. The saved result includes actual source bytes and rows; import wall time; worker read, parse, LFCP encoding, and OPFS write durations; input and output chunk counters/high-water sizes; LFCP output bytes and block count; storage estimates; and memory APIs exposed by that browser.

Worker counters are opt-in through the harness's `validationHooks` message flag; stage messages use the separate `stageHooks` flag. Normal prototype imports do not request either. `parseMs` covers decoding and parser/JSON work, pausing around awaited batch flushes; `encodeMs` covers synchronous `packStream.push()` and `finish()` calls; `opfsWriteMs` covers awaited writable writes. Older captured reports from before this timing correction have overlapping JSONL parse/flush durations and are marked superseded in the results index. Times are not an isolated microbenchmark: instrumentation, browser scheduling, garbage collection, storage implementation, compression, and file reading can affect them. Where `performance.memory` is exposed, the harness samples main-realm used heap every 50 ms during import and records the largest observed value; short-lived peaks between samples may be missed. It is non-standard and does not report worker heap. `measureUserAgentSpecificMemory()` is recorded before and after only when exposed and permitted. Browser APIs do not generally provide a portable per-Worker peak heap measurement. Use browser developer tools or OS process monitoring for a separately documented process-level measurement.

`navigator.storage.estimate()` is origin-level and approximate. Its deltas include browser bookkeeping and potentially unrelated origin data. The harness captures estimates before source creation, with source present, after output creation, and after cleanup. It does not equate these values to exact LFCP bytes on disk.

## OPFS failure, cancellation, and recovery coverage

- **Cooperative cancellation:** Harness checks cancellation requested after a progress message and cancellation requested while an OPFS write is awaited; it records whether the Worker's normal abort/remove path leaves a test output behind. The stage callback is test instrumentation, not a production protocol.
- **Successful creation/write/close:** exercised by the completed functional and resource imports in Chrome 156 on Android.
- **Interrupted Worker:** The harness terminated the Worker immediately after the test-only `opfs-write` stage message. A visible zero-byte file without a trailer remained; the harness then removed only that newly created test file. The interruption path does not decode all output blocks. Closing/restarting the entire browser is a separate failure mode; do not infer process-restart safety from Worker termination.
- **Quota failure:** deliberately not triggered. Do not fill real device storage. A future test needs an isolated browser profile or a controlled storage fault injection mechanism.
- **Injected OPFS read/write errors:** not supported by the current harness. Record only naturally observed browser errors.
- **Cancellation during parser/encoding/write sub-phases:** the harness cancelled after a read/progress checkpoint and while an OPFS write was awaited. It cannot interrupt synchronous parser or encoder instructions mid-call and does not prove cancellation at every internal point.
- **Completed file after browser restart:** this was not tested during Phase 2; a one-file Chrome process-restart test was completed in Phase 3 below.
- **Durable checkpoint/restart recovery:** not implemented and not tested.

The prototype's `createWritable()` path aborts and removes output on caught errors. Browser termination may not enter that catch block. Whether a pending writable appears as absent, rolled back, or incomplete after abrupt termination must be measured per browser; the prototype's `LFC1` suffix scan is not a recovery or integrity protocol.

## Expected result record

Each downloaded or explicitly submitted JSON identifies its schema, time, browser user agent and available client hints, platform, origin, secure-context status, OPFS availability, storage estimate, available memory APIs, LFCP version, case/workload characteristics, measured values, and pass/fail/skip result. Attach the unedited JSON to a future report. Run at least three repetitions per browser/size before comparing timing; retain individual runs and report distributions rather than only a best run.

The environment summary is `benchmarks/results/phase-2-environment.json`; raw reports and their interpretation are indexed in `benchmarks/results/README.md`. Results apply only to the stated Android Chrome device and generated fixtures.

## Phase 3: representative resource and storage-lifecycle evidence

### Environment and reproduction

**Verified in browser on 2026-11-02:** Android Chrome `156.0.8078.73` on the same an Android phone environment, at secure `http://127.0.0.1:8080`; OPFS and Workers were available. The browser returned `navigator.deviceMemory === 8`, `navigator.storage.persisted() === false`, and no `FileSystemHandle.prototype.move`. `measureUserAgentSpecificMemory()` was not exposed. The raw Phase 3 reports contain the user agent, runtime feature probes, quota estimate, and LFCP version.

Start the loopback-only report server as described above. The following modes use generated data only:

```text
?run=phase3-resources&report=1
?run=phase3-interrupt-stages&report=1
?run=persistence-prepare&lifecycleId=unique-id&report=1
?run=interruption-arm&lifecycleId=unique-id&report=1
?run=lifecycle-verify&lifecycleId=unique-id&restartConfirmed=1&report=1
?run=artifact-audit&report=1
```

The full resource matrix performs three trials for each of six workloads at requested targets of 262,144, 4,194,304, and 16,777,216 bytes (54 imports). Source files are generated and written to OPFS with a 32 KiB flush threshold; the writer does not split a record, so observed chunks reached 35,162 bytes. Targets are rounded down to complete records. A stable workload/size seed is reused across repetitions. The fixture code and seed derivation are in `experiments/lfcp-first-spike/validation/phase3.js`.

| Workload | Data characteristics |
|---|---|
| `highly-repetitive` | Fixed category, status, region, quantity, and note; increasing row ID. |
| `moderately-repetitive` | Small category, region, status, and note vocabularies with varied integer amounts. |
| `mixed-realistic` | Deterministic dates, categories, regions, names, decimal strings, booleans, and notes. |
| `high-entropy` | Per-row seeded base-62 tokens (112 and 32 characters) plus a category. |
| `mixed-length-text` | Text body lengths cycle through 0, 8, 40, 256, 1,024, and 4,096 characters, using deterministic per-row text. |
| `numeric-categorical` | Integer, signed delta, decimal ratio, boolean, category, and region fields. |

Each successful validation reopens the generated OPFS output with `LfcPack.info()`, decodes every row in bounded result pages, checks first/middle/last expected values and order, records block counts and sizes, and confirms that a mutated footer is rejected. This is still not a random-access file reader: each inspection obtains the whole output file as an `ArrayBuffer`. The `mixed-length-text` result is a semantic failure described below, even though the footer and row count validate.

### Resource results

The table reports medians across three trials at each size. Timings are import wall time from the already-generated `File`; they include worker scheduling and OPFS work, and are not device-independent benchmarks. Output ratio is input bytes divided by output LFCP bytes.

| Workload | Target | Actual input bytes | Rows | Median LFCP bytes | Input/output | Import median (range) ms | Blocks | Round trips |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Highly repetitive | 256 KiB | 262,070 | 2,329 | 896 | 292.49× | 106 (98–132) | 1 | 3/3 |
| Highly repetitive | 4 MiB | 4,194,240 | 36,889 | 7,601 | 551.80× | 514 (507–524) | 16 | 3/3 |
| Highly repetitive | 16 MiB | 16,777,105 | 146,854 | 28,767 | 583.21× | 2,235 (2,044–2,302) | 64 | 3/3 |
| Moderately repetitive | 256 KiB | 262,069 | 2,291 | 8,735 | 30.00× | 152 (136–154) | 1 | 3/3 |
| Moderately repetitive | 4 MiB | 4,194,280 | 36,275 | 131,532 | 31.89× | 740 (697–744) | 16 | 3/3 |
| Moderately repetitive | 16 MiB | 16,777,135 | 144,425 | 522,464 | 32.11× | 1,851 (1,709–2,561) | 64 | 3/3 |
| Mixed realistic | 256 KiB | 262,118 | 1,521 | 11,331 | 23.13× | 238 (234–279) | 1 | 3/3 |
| Mixed realistic | 4 MiB | 4,194,156 | 24,139 | 172,877 | 24.26× | 616 (548–703) | 16 | 3/3 |
| Mixed realistic | 16 MiB | 16,777,092 | 96,376 | 689,257 | 24.34× | 4,072 (2,321–4,692) | 64 | 3/3 |
| High entropy | 256 KiB | 262,115 | 1,354 | 149,160 | 1.76× | 92 (86–132) | 1 | 3/3 |
| High entropy | 4 MiB | 4,194,148 | 21,523 | 2,364,949 | 1.77× | 547 (505–600) | 16 | 3/3 |
| High entropy | 16 MiB | 16,777,158 | 85,928 | 9,440,209 | 1.78× | 3,092 (3,019–3,174) | 64 | 3/3 |
| Mixed-length text | 256 KiB | 258,500 | 269 | 180,858 | 1.43× | 133 (93–134) | 1 | 0/3 |
| Mixed-length text | 4 MiB | 4,190,351 | 4,307 | 2,925,170 | 1.43× | 499 (474–508) | 16 | 0/3 |
| Mixed-length text | 16 MiB | 16,777,107 | 17,224 | 11,703,237 | 1.43× | 2,484 (2,112–2,966) | 64 | 0/3 |
| Numeric/categorical | 256 KiB | 262,081 | 2,184 | 22,536 | 11.63× | 173 (166–184) | 1 | 3/3 |
| Numeric/categorical | 4 MiB | 4,194,235 | 34,596 | 349,999 | 11.98× | 791 (755–823) | 16 | 3/3 |
| Numeric/categorical | 16 MiB | 16,777,179 | 137,817 | 1,392,846 | 12.05× | 3,278 (2,270–3,500) | 64 | 3/3 |

The compression values are characteristics of these particular generated JSONL fixtures. They do not support a general LFCP-versus-Parquet claim. See `phase-3-browser-20261102T131947Z-894cac4c.json` for the original 54 trials and `phase-3-browser-20261102T132453Z-30069226.json` for the focused, repeated mixed-length diagnostics. The original resource report is retained unchanged; its `fixtureMethod` text incorrectly says encoded source chunks were at most 32 KiB. Its measured `sourceChunkBytesMax` fields show the actual maximum was 35,162 bytes because whole rows were not split. The code's recorded methodology has since been corrected; the focused report adds mismatch details and full paged decode counts.

### Memory and storage measurements

- Page `performance.memory` was exposed, but reported exactly 10,000,000 used bytes throughout the recorded samples across sizes. It is non-standard and coarse; this flat value is not a peak or proof of bounded memory.
- The Worker realm did not expose `performance.memory`; `measureUserAgentSpecificMemory()` was unavailable. No Worker heap peak was measured.
- Android app-process diagnostics were unavailable to the Termux app UID: `/system/bin/dumpsys meminfo` had no accessible `meminfo` service, ActivityManager process dumps were denied for lack of `android.permission.DUMP`, `/proc` exposed only the caller's process namespace, and `top` did not list Chrome. The device-wide `/proc/meminfo` snapshot is not an application-memory measurement.
- Browser-reported `navigator.deviceMemory` was 8 GiB, a coarse device hint. It is not free RAM or Chrome process memory.
- Worker counters recorded 64 KiB maximum input reads, about 263 KiB maximum queued JSON text in the largest workloads, and workload-dependent parser record sizes. These instrumented buffers do not account for all JavaScript strings, LFCP encoder/WASM allocations, browser internals, or staged OPFS writes.
- `navigator.storage.estimate()` was approximate and origin-wide. Reported quota was about 10 GiB; measured origin usage returned to about 173,592 bytes after the final Phase 3 cleanup audit. `navigator.storage.persisted()` was false. This does not guarantee a quota or immunity from eviction.

### OPFS completion and interruption

**Completed-file restart (verified):** A generated 256-row, 963-byte, one-block LFCP file passed `info()`, decoded all rows, matched all expected values/order, and rejected a mutated footer before restart. Chrome was force-stopped/reopened in the same profile and the same origin was revisited. The exact OPFS name, size, and `lastModified` remained; all 256 rows decoded identically and footer validation passed. That exact generated dataset was then removed. Raw records: `phase-3-browser-20261102T132015Z-0c1e8e0a.json` and `phase-3-browser-20261102T132344Z-255efc0a.json`.

**Interrupted Worker stages (verified on this Chrome build):** Test-only stage gates inspected `getFile()` at `file-created`, `writable-open`, `opfs-write-complete`, and `finalize`. A file entry was visible from `file-created`; the visible file was zero bytes at all four gates. At the `opfs-write-complete` gate the Worker reported 2,318 bytes accepted; at `finalize` it reported 15,772–15,777 output bytes. `getFile()` still reported zero bytes because `writable.close()` had not run. Worker termination left a visible zero-byte file, and `LfcPack.info()` rejected it as too short. The exact generated entries were removed. Raw records include `phase-3-browser-20261102T131711Z-e95b3fcd.json`, `phase-3-browser-20261102T131952Z-686661f3.json`, and `phase-3-browser-20261102T132203Z-3f45ca5c.json`.

**Whole-browser close during finalization (verified):** A second generated import was paused immediately before `writable.close()`, with a reader-visible zero-byte file. After browser process closure and relaunch, the entry remained as zero bytes, had no trailer marker, and the pinned LFCP reader rejected it as too short. The test removed only that generated entry. Raw records: `phase-3-browser-20261102T132227Z-94b2fa1c.json` and `phase-3-browser-20261102T132344Z-9e4c125c.json`.

The observations indicate that this Chrome `createWritable()` path kept writes staged until `close()` and discarded staged bytes on Worker termination/browser stop, while the earlier `getFileHandle({create:true})` entry remained. This matches [Chrome's documentation](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) that writable-stream changes are not written to disk until `close()`; the measured zero-byte rollback remains specific to this tested browser/path, not an atomicity guarantee for every browser or failure mode. A zero-byte or missing marker is an incomplete-output indicator in these tests; a marker alone is not sufficient to certify completion. The current spike's dataset-list code labels a file complete from the `LFC1` suffix alone, while `LfcPack.info()` performs footer validation. Listing status should not be treated as integrity validation. `FileSystemHandle.move` was not exposed, so rename/move publication was not tested. No storage quota failure or real storage exhaustion was attempted.

### Round-trip defect uncovered

In all nine mixed-length trials, the reader accepted the footer and decoded the complete expected row count, but three sampled values were wrong. The first generated row has an empty `body`; both `unpackRows()` and, in the smaller diagnostic cases, full `unpack()` returned the next row's non-empty token instead. The mismatch repeated at all three input sizes and all three trials. Phase 2's two-row empty-string case passed, so the evidence points to a case involving a high-cardinality, mixed-length string column, but does not isolate whether the defect is in LFC-pack writing, decoding, or their interaction. Do not treat these files as semantically valid just because `info()` accepts their footer. A reproducible LFCP library/conformance requirement is recorded in `docs/lfcp/REQUIREMENTS.md`; no format change is proposed from this evidence alone.

### Evidence limits and untested behavior

Only Android Chrome 156 on one device was tested. There was no cross-browser run, process-level Chrome memory profile, quota exhaustion, injected OPFS error, actual storage eviction, device reboot, or crash/power-loss test. Normal browser-process restart survived for one completed fixture and preserved one pre-close interrupted entry; that is not a general durability or recovery guarantee. No random-access LFCP reader, streaming reader, durable checkpoint, restart recovery protocol, or production application behavior was implemented here.
