# Workbench import page (new code)

First page built on the new ingestion core in `../src/ingest/`, as a classic Worker plus a plain page (no build step). It is separate from `experiments/lfcp-first-spike/`, which stays frozen on LFC-pack 0.4.19.

**What it does:** imports a local CSV or TSV (any size the browser can slice), skips blank lines, names the line of any error, suggests a type for each column without converting values, writes LFCP with LFC-pack 0.4.24, checks the end marker and the footer row count, and only then lists the dataset as saved. It can be cancelled, which removes the partial file.

**Where data lives:** OPFS when the browser has it (Firefox 158, Chromium 155). WebKitGTK 2.52.6 has no `navigator.storage`, so there the page keeps datasets in memory for the tab and says so on screen.

**Data view (grid):** Open a saved dataset to scroll it in a window-rendered grid. Click a column name to sort (low to high, high to low, off). Each column has one filter box: text finds matches anywhere; `>5`, `>=5`, `<5`, `<=5` compare by value for numbers and dates; `=text` and `!=text` match exactly; `=` finds empty cells; `!` finds filled cells. Empty cells always sort last. Text sorts by code point (capitals before lowercase). Logic lives in `../src/query/query.mjs` with Node tests.

**Buttons:** Import, Cancel, Run self-test (generates a messy 20,000-row CSV, imports it, reads every value back and compares), Copy results (plain-text report, no screenshots needed).

**Limits today:** CSV and TSV only; the footer check reads the whole file up to 64 MiB, over that only the end marker is checked; no export yet; the data view holds the whole dataset in memory (up to 64 MiB of LFCP); blank-line skipping means a file with only one column cannot hold an empty value on its own line.

**Run it:** `python3 -m http.server 8080` from the repo root, then open `http://localhost:8080/app/index.html`. Browser checks: `python3 tests/browser-run.py firefox|chromium|webkit` (pass/fail, one browser at a time; see `docs/DEVELOPMENT.md`).
