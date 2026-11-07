# Phase 8 CSP and Worker qualification

This isolated harness tests the corrected candidate under response-header CSP policies and observes the package's real browser Workers. It does not modify the candidate or pinned library. All test values are generated in memory.

## Run

From the repository root, start the loopback-only server:

```sh
python3 experiments/fixes/lfc-pack-0.4.19-string-writer/phase8-validation/server.py
```

Open this URL in the browser under test:

```text
http://127.0.0.1:8080/experiments/fixes/lfc-pack-0.4.19-string-writer/phase8-validation/index.html?policy=strict
```

The harness automatically runs the strict policy and three directive-removal controls (`no_wasm`, `no_blob_worker`, `no_connect`). Results are written with exclusive file creation under `benchmarks/results/phase-8-browser-*.json`. The no-connect page writes its report to session storage and navigates to a same-origin collector page before the report is posted; the no-connect test page itself makes no fetch request. Stop the server with Ctrl-C.

The test uses only repository assets and loopback requests, requires no dependency installation, and does not upload user data. Run it on the same machine as the browser so loopback resolves to this local server.

## Browser scope

Phase 8 was executed in Android Chrome 156 on an Android phone / Android. Chrome exposed only the major version through User-Agent Client Hints in this environment. Firefox was not installed, and no desktop Chromium or Firefox executable was available in Termux.

For a Firefox check, use a host with Firefox already installed, start the same server from the repository on that host, open the URL above, and retain the four generated policy results. Record Firefox's full version and OS/device in the JSON. Do not infer Firefox support from the module README's historical tested-browser line.
