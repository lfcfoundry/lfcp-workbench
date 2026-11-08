# Workbench import page (new code)

First page built on the new ingestion core in `../src/ingest/`, as a classic Worker plus a plain page (no build step). It is separate from `experiments/lfcp-first-spike/`, which stays frozen on LFC-pack 0.4.19.

**What it does:** imports a local CSV or TSV (any size the browser can slice), skips blank lines, names the line of any error, suggests a type for each column without converting values, writes LFCP with LFC-pack 0.5.0, checks the end marker and the footer row count, and only then lists the dataset as saved. It can be cancelled, which removes the partial file.

**Where data lives:** OPFS when the browser has it (Firefox 158, Chromium 155). WebKitGTK 2.52.6 has no `navigator.storage`, so there the page keeps datasets in memory for the tab and says so on screen.

**Data view (grid):** Open a saved dataset to scroll it in a window-rendered grid. Click a column name to sort (low to high, high to low, off). Each column has one filter box: text finds matches anywhere; `>5`, `>=5`, `<5`, `<=5` compare by value for numbers and dates; `=text` and `!=text` match exactly; `=` finds empty cells; `!` finds filled cells. Empty cells always sort last. Text sorts by code point (capitals before lowercase). Logic lives in `../src/query/query.mjs` with Node tests.

**Buttons:** Import, Cancel, Run self-test (generates a messy 20,000-row CSV, imports it, reads every value back and compares), Copy results (plain-text report, no screenshots needed).

**Limits today:** CSV and TSV only; browsing holds only the footer and one block; filter and sort decode only the columns they use (up to 10,000,000 rows, read one block at a time; other files fall back to decoding every row, up to 1,000,000 rows); blank-line skipping means a file with only one column cannot hold an empty value on its own line.

**Run it:** `python3 -m http.server 8080` from the repo root, then open `http://localhost:8080/app/index.html`. Browser checks: `python3 tests/browser-run.py firefox|chromium|webkit` (pass/fail, one browser at a time; see `docs/DEVELOPMENT.md`).

## Export CSV
The "Export CSV" button in the data view saves the rows now shown (filter and sort applied) as a CSV file named `<dataset>-view.csv`. Plain RFC 4180 with CRLF line ends, UTF-8, no byte-order mark, no spreadsheet-formula escaping, so our own reader gets back every value exactly. The file is built in the worker in batches of 5,000 rows and handed over as one Blob. Code: `src/export/csv.mjs`, `exportView` in `app/worker.js`. Checked by `tests/export.test.mjs` (Node) and one self-test check in the browser. Tick "Excel-friendly" to add a UTF-8 byte-order mark so Excel shows accented letters correctly; it is off by default, and the Workbench reads such files back identically.

## Import in pieces
For files of 48 MB and more, browsers with four or more cores cut the file into 8 MB pieces and let two helpers parse them at the same time while the import worker packs and writes in file order. A piece starts at the first line break after its cut, which is only a guess (the break may sit inside quotes). Each piece must end exactly where the next one started; if not, that piece is parsed again from the last verified spot, so the stored data is always identical to a one-thread import. Firefox uses pieces too since rows are built as text; before that, two helpers slowed each other down there. In Firefox the packed blocks are also made on two extra threads (LFC-pack 0.7.0 `packBlock` and `pushPacked`) and appended in file order; the other browsers pack on the import thread, because they showed no gain on the 4-core test machine.

## Whole-number columns
When a column's first 2,000 rows are all plain whole numbers (or empty), the Workbench stores those cells as numbers instead of text: files get about a fifth smaller and a number filter such as `id>=19990` decodes only the blocks whose stored number range can hold a match (a 7 million row file: about 1 second down to about 10 ms). Only plain whole numbers (an optional minus, no leading zeros, up to 15 digits, not `-0`) convert, so a cell reads back as exactly the same text; an empty cell is stored as null and still shows and exports as empty. A cell in such a column that is not a plain whole number (for example `n/a` or `007`) stays text. Decimal columns stay text, because `12.50` must stay `12.50`. Files imported before this change keep working and are read as before.

## Block size
Imported data is stored in blocks of about 2 MB of row text (it was 256 KB at first, then 1 MB). Larger blocks compress better: a 300 MB CSV of 7 million rows is stored in 8.0 MB instead of 16.0 MB (50% smaller), and the import takes the same time within noise. A block is the unit that is decoded for the visible rows and the unit a number filter can skip, so a screen of rows now decodes a whole block (about 23,000 rows); fetching 30 rows from far-apart places took 5 to 9 ms on average, and sorts were unchanged within noise.
