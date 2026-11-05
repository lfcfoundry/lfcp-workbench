# LFC Workbench takeover report

Written 2026.11.05 2:10 AM Eastern. Repo `lfcfoundry/lfcp-workbench`, inspected at the Codex migration branch `codex/lfcp-workbench-github-migration-handoff` (HEAD `0af1a5c`, one commit above the import commit `7b46150`). Nothing in the repo was changed to produce this report; tests ran on a throwaway copy.

## 1. What LFC Workbench is

A browser-only, local-first, offline data multitool: import files, explore, query, transform, visualize. LFCP (our LFC-pack format) is the storage and interchange layer. No Electron, Tauri or native runtime. That much is settled direction. Everything else (reader/writer contracts, logical schema, planner, SQL) is explicitly open.

**Honest maturity: documentation plus one feasibility experiment. There is no application yet.**

## 2. Actual repository structure (185 files, 11 MB)

| Path | What it really is |
|---|---|
| `README.md`, `docs/PROJECT-STATUS.md`, `docs/DEVELOPMENT.md`, `docs/MIGRATION-INVENTORY.md` | Status and reproducibility notes. Accurate and careful about claims. |
| `docs/architecture/` (4 files) | Five-layer model (format, library, streaming protocol, engine, app) and 9 open decisions. Proposals, not code. |
| `docs/lfcp/` (7 files) | Requirements template (empty of real requirements), LFCP evolution process, and the LFC-pack defect investigation phases. |
| `experiments/lfcp-first-spike/` | The one real implementation: 4 small JS files (about 1,000 lines) plus `validation/` harnesses (about 900 lines) and `original-standalone/`, a byte-preserved copy of the original spike. |
| `experiments/diagnostics/`, `experiments/fixes/` (78 files) | The LFC-pack empty-string investigation: instrumented build, candidate JS and Wasm, negative controls, Phase 11 package, Phase 12 issue draft. |
| `benchmarks/results/` (58 files) | Raw JSON from Android Chrome runs, plus a loopback test server. |
| `tests/` | Two Node scripts, both about the LFC-pack defect. No fixtures. |
| `vendor/lfcp/0.4.19/` | Pinned lfc-pack.js (2,008 lines), sha256 `8c312582...c259`, verified unchanged. |

No package manifest, build, CI or dependencies.

## 3. Implementation status

| Capability | Status |
|---|---|
| CSV, TSV, JSONL ingest in bounded slices, Worker, write via `LfcPack.packStream` to OPFS | **Implemented, experimental** (spike) |
| Bounded sample and column profile (capped at 256 columns, 4,096 fields) | Implemented, experimental |
| Cancel, list, delete datasets, inspect stored file | Implemented in spike |
| Stage hooks, heap sampling, validation pages | Test scaffolding in the integrated copy only |
| Random-access or streaming LFCP reads | **Not implemented.** Inspect reads the whole file and unpacks 100 rows. |
| Durable completion and recovery | Not implemented. Chrome OPFS writes stay invisible until `close()`; interrupted runs leave a zero-byte entry. |
| SQL, query planner, transforms, pipelines, visualization, multi-window | Not started. Proposed only. |
| JSON, Excel, Parquet, other adapters | Not started |

## 4. Test baseline (Node 22.23.4, copy of the branch, about 4 s total, no browsers)

| Test | Result |
|---|---|
| `tests/lfcp-optimized-string-writer-fix.cjs` | 19 of 19 candidate cases pass; pinned vendor mismatches in 8 (the known defect). In the repo as shipped it **fails with EEXIST** because it refuses to overwrite its already-committed result file. Run on a copy with the output name changed, as the migration notes did. |
| `tests/lfcp-variable-length-string-roundtrip.cjs` | Exit 1 by design: reproduces the defect against the vendor. Matches the 98 failed checks recorded at migration. |
| Vendor hash, `git status` | Unchanged. Clean tree. |

Both scripts are defect probes, not product tests. **There is no Workbench test suite, so "baseline" means: nothing of the product is under test.** Browser evidence is Android Chrome only. I ran no browser tests in this pass (cost); the cloud three-browser rig exists for later.

## 5. The original spike

- The integrated copy is the original plus additive instrumentation (stage gating, worker heap sampling, metrics) and one changed import path. No behavior difference on the main path. The standalone snapshot is kept as the baseline.
- It is the right size for a spike and answers one question: can files stream into LFCP in OPFS without a UI freeze? Findings it produced are valuable: Phase 3 corruption of empty strings, OPFS invisibility until close, no `FileSystemHandle.move` in Chrome, storage not persisted.
- Its weaknesses are the ones that decide the architecture: it is a single worker script mixing parsing, profiling, OPFS and UI messages; it uses ES5-style `var` code with no modules; it validates a "complete" file by name suffix; and it unpacks whole files to inspect.
- Recommendation: **do not grow it.** Treat it as reference. Build the product in a new source tree and port the ideas (slice reader, delimited parser, cancel protocol) with tests.

## 6. The LFC-pack workstream (summary only; repo material untouched)

The empty-string work in this repo is a snapshot from the Codex handoff and is **out of date**. The separate thread "Investigate LFC-pack empty-string writer defect" owns it. Its current findings (read from `/mnt/project-files/lfc-pack-empty-string/ASSESSMENT-AND-PLAN-2026.11.05.md`):

- The bug is real and wider than Codex said: default `packRows`, `packTables`, `packParallel` lose leading empty strings. It affects 0.4.15 through 0.4.20. The one-line-pair fix (`if(o)` to `if(i)`) passes 61 of 61 checks in Firefox 158, Chromium 155, WebKitGTK 2.52.6 and Node.
- Wasm provenance is resolved: the shipped wasm rebuilds byte for byte with clang 18.1.3 and a recovered recipe.
- LFC-pack is our own module, so no outside maintainer exists. No public issue is recommended. A fix brief goes to the JS-modules code thread through Opus.
- Phone model details in the Codex draft must never be published.

**What it means for Workbench:** the pinned 0.4.19 vendor is affected, and the spike uses `packStream`. Phase 3 saw corruption in the spike, so the defect is real here. I did not separately confirm `packStream` in the fixed build; the other thread's 61 checks cover it only if they include stream cases (to verify). Until a fixed LFC-pack ships, any Workbench ingest must not claim lossless string round trips. Per the approval boundaries, I will not touch the vendor file; the vendor bump is a decision for the owner after the code thread releases the fix.

## 7. Architecture and documentation gaps

1. No workload definition. Requirements template has no real entries. Everything downstream (reader API, memory limits) needs one.
2. No source tree, module system, build, lint or test runner chosen. Existing style is IIFE plus `importScripts`.
3. No reader abstraction. The spike cannot read a column or row range without whole-file unpack. LFC-pack's own API for range reads (`unpackRows` from/count exists) has not been evaluated against the spike's needs.
4. Docs mention Wasm provenance as unresolved; now stale. `PROJECT-STATUS.md`, README and handoff all repeat the "Firefox unqualified, provenance unresolved" framing.
5. Repo contains a staged mix of 78 investigation files that belong to another thread's workstream; risk of drift and duplicate truth with JS-modules and the knowledge base.
6. Absolute Termux paths and a phone model in committed JSON and the issue draft. Repo is private today; scrub before any public release.
7. The EEXIST failure of the shipped test shows tests write into committed results. Test outputs should go to a temp directory.
8. Project rules not yet applied here: three-browser timing rig, hidden speed-report and error-log buttons, play-page style freshness not relevant, CSP check.

## 8. Roadmap (small, independently testable; each has objective, user benefit, approach, files, dependencies, tests, risks, done)

**R0. Takeover housekeeping (done in this pass).** Objective: fix the record. Files: this report, a `docs/TAKEOVER-REPORT.md` copy on a Claude branch. Risk: none. Done: pushed on `claude/*` branch.

**R1. Test harness that tests the product, not the defect (recommended first).**
- Objective: one command, `node tests/run.mjs`, that runs deterministic, fast checks and writes results to a temp directory.
- Benefit: every later change is verifiable in seconds; the owner gets a pass/fail summary.
- Approach: new `tests/` runner with no dependencies; wrap the two existing scripts as "known-defect probes" with expected results; add adapter tests (CSV quoting, TSV, JSONL, CRLF, BOM, split chunk boundaries) against `src/adapters.js`.
- Files: `tests/run.mjs`, `tests/adapters.test.mjs`, fixtures in `tests/fixtures/`. No vendor or spike behavior changes.
- Dependencies: none. Tests: itself; run time under 5 s in Node. Risk: low. Done: green run recorded, old EEXIST gone.

**R2. Define the first workload and requirements (LFCP-WB-001).** Objective: one representative job, e.g. "import a 500 MB CSV, profile it, filter and export, in a phone and a laptop browser, within stated memory". Output: requirement record plus fixtures. Needs the owner's preferred real-world file type (a card). Risk: scope creep; keep to one job.

**R3. New source tree with ES modules: ingestion core.** Objective: port adapters and slice reader into `src/` as testable modules with a batch contract (schema plus bounded row batches, cancel, error). Benefit: the product base. Dependencies: R1, R2. Tests: Node unit plus three-browser pass/fail. Risk: batch contract is an architecture decision, so write an ADR first.

**R4. Reader layer: footer-first, range reads over File and OPFS.** Objective: open a dataset and read a column or row range without unpacking all. Dependency: what LFC-pack's reader already offers; may need a JS-modules request relayed by Opus. Benchmarks: three test browsers, timing, early-stop A/B rule.

**R5. Durable import: temp file plus catalog, validate footer before "complete".** Replaces the suffix-only flag. Tests: kill-worker and reload in three browsers; document differences.

**R6. Data grid view plus profile (virtualized), then simple filter/sort over LFCP blocks.** First user-visible "multitool" capability.

**R7. Query layer decision (SQL or visual operators), via ADR with measured prototypes.** Only after R4 and R6.

**R8. Vendor update policy, CI, three-browser nightly rig.** Includes taking the fixed LFC-pack once released.

## 9. Recommended first increment

**R1, then R2 in parallel with a short owner card.** R1 is cheap (a few minutes of compute, Node only), fully reversible, touches no vendor, format or spike behavior, and gives every later step a safety net. It also resolves the confusing shipped test failure.

## Approval and process notes

- Branches: all work goes on `claude/` branches; the Codex branch and `main` stay untouched. No merges, releases, vendor changes or external posts without a card.
- I did not edit any agent instruction files.
- Pending owner decisions are on cards in the thread: starting R1, and the workload for R2.

## Cost of this pass

About 7 minutes wall time (clone, read, two Node runs, writing). Compute: one shallow clone (11 MB), about 4 s of Node, no browsers, no subagents.
