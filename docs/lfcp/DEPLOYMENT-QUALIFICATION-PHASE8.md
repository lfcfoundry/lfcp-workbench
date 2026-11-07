# Phase 8: LFCP candidate deployment qualification

**Scope:** qualify the isolated LFC-pack 0.4.19 string-writer candidate for browser CSP and Worker behavior, inspect locally available upstream integration evidence, and define acceptance gates. The pinned vendor artifact remains unchanged.

## Strict Content Security Policy

The candidate passed on Android Chrome 156 / an Android phone under this exact response-header policy:

```text
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

The page uses separate same-origin JavaScript and CSS files. It needs neither `unsafe-inline` nor JavaScript `unsafe-eval`. Results are in `benchmarks/results/phase-8-browser-strict-20261102T192745Z-afbc49f8.json`: 20/20 checks passed, including initialization, ordinary packing, eight empty/nonempty string patterns, cardinalities 2–8, 13-byte-chunk `packStream()`, parallel packing, and a synthetic Worker error.

### Directive-removal controls

- **`wasm-unsafe-eval`: required for initialization in tested Chrome.** With `script-src 'self'` and all other strict directives retained, `WebAssembly.instantiate()` was blocked by CSP. The browser's error explicitly stated that WebAssembly compilation/instantiation violated `script-src 'self'`. See `phase-8-browser-no_wasm-20261102T192745Z-e72d5ac0.json`.
- **`worker-src blob:`: required for `packParallel()` in tested Chrome.** With `worker-src 'self'`, ordinary and streaming paths and the string regressions passed. Parallel packing constructed one Worker object, but it never initialized, raised a Worker error event, and the returned promise rejected. The harness classifies this expected policy block as a passing negative control. See `phase-8-browser-no_blob_worker-20261102T192746Z-336f5ecc.json`.
- **`connect-src 'self'`: not required by the candidate's tested operations.** Under `connect-src 'none'`, initialization, ordinary/streaming/parallel packing, the regression matrix, Worker error propagation, and sequential parity all passed (20/20). The test page did not issue a request; it used session storage and then navigated to a separate same-origin collector page under the strict policy. See `phase-8-browser-no_connect-20261102T192748Z-d586bb7d.json`. The Phase 8 report receiver itself uses `connect-src 'self'` only to collect results.
- **`default-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, and `frame-ancestors 'none'`:** all remained in the passing strict policy. The harness separately allows same-origin scripts/styles. This validates the package inside that policy; it is not a claim that every future Workbench feature will need the same allowances.

Therefore the package-specific minimum evidenced here is `wasm-unsafe-eval` for WebAssembly and `worker-src blob:` for parallel helpers. The Workbench page also needs an appropriate source for its own application scripts. Keep `connect-src 'none'` if the product has no local network feature; add explicit local origins only for a later authorized integration. Do not broaden `script-src` to `unsafe-eval` or permit inline code on the basis of this test.

## Worker execution and error handling

The harness wraps the browser's native `Worker` constructor before loading the candidate. It records constructed instances, messages, the package's `started` reply (sent after the helper's asynchronous initialization), completed results, errors, and termination. No production source was instrumented or changed.

Under the strict policy, the parallel fixture produced two blocks. `packParallel(..., { workers: 2 })` created two Workers; both initialized, each accepted and completed work, and the decoded result matched sequential `pack()` semantically and byte-for-byte. The report records one completed job per Worker. The fault-control replaced a fresh helper's Blob source with a generated script that throws; the Worker error event was observed and `packParallel()` rejected with `helper worker failed: Uncaught Error: phase8 synthetic worker failure`. This validates error propagation for that Worker startup failure, not every worker/runtime failure mode.

The initial strict run at `T175851` exposed a harness mistake: the package reused a cached helper, so the attempted fault injection did not create a fresh Worker. That result is retained. A second run at `T182240` passed after reordering the fault control. The final matrix record at `T192745` passed after adding CSP directive-removal controls. The initial `no_blob_worker` result at `T192706` also had an incorrect assertion that expected CSP to prevent Worker object construction; Chrome instead constructed the object and asynchronously errored before initialization. The corrected `T192746` record captures the actual behavior. These preliminary harness failures are retained and are not candidate regressions.

## Firefox and external reproduction

No Firefox executable or installed Firefox app was available in this environment. No Firefox test was run and no Firefox compatibility claim is made. The local JS-modules `modules/lfc-pack/README.md` at ref `6e16aa8044d0a05bafa7c756c949f3537c23e92a` documents previous Firefox 158/160 testing, but that is source documentation, not independent Phase 8 validation.

External procedure: use a host that already has Firefox, run the server command in `experiments/fixes/lfc-pack-0.4.19-string-writer/phase8-validation/README.md`, open the loopback strict URL, and let the harness run all four policies. Preserve the JSON results, record the full Firefox version and environment, and examine CSP console errors. Do not install a browser solely for this phase.

## Upstream source and build route

The candidate's source base is the **locally recorded** `JS-modules` `origin/main` ref at `6e16aa8044d0a05bafa7c756c949f3537c23e92a` (2026-11-01), with `modules/lfc-pack/wasm/flatscan.c` blob `21a0aeb1a3e9fa4fd74deddc9952df710d604890`. The correction is a minimal change to the two `if(o)` separator conditions in the all-values branches. At this reference:

- `modules/lfc-pack/build.py` assembles the JavaScript package and embeds the already-built `wasm/flatscan.wasm` between the `/*FS:BEGIN*/` and `/*FS:END*/` markers. It also writes the decoder package and, when applicable, the viewer. It does **not** compile `flatscan.c`.
- `wasm/build-core.sh` documents compilation of `core.c`; `wasm/build.sh` builds Zstandard. No dedicated `flatscan.c` build script or pinned flat-scan compiler version is present in this source tree. The Phase 7 Clang 21.1.8 recipe proves this candidate reproducible locally, not that it is the official upstream build recipe.
- Root `CONTRIBUTING.md` welcomes issues and pull requests, asks contributors to read `AGENTS.md`, run `node tests/run.js`, and add a check for the change. The module has user-facing `CHANGELOG.md` and developer `CHANGELOG-DEV.md`; the module README says the format is not frozen until formal release. No Git tags are present in the local clone, which does not establish whether upstream tags/releases exist remotely.
- The local `JS-modules` checkout is `main` at `0758e96ccc4579fb2c0ca81891d18b5ef57ee170`, ahead 291 and behind 811 relative to its locally recorded `origin/main`; its current tree has no `modules/lfc-pack` directory. The historical `origin/main` commit `6e16aa...` is not an ancestor of checked-out `main`. No fetch or remote inspection was performed. Do not apply this patch to the divergent checkout without first establishing the authoritative upstream source and coordinating with its maintainers.

### Integration route comparison

| Route | Maintenance and provenance | Decision |
|---|---|---|
| Minimal source correction upstream, then official package rebuild | Best long-term source of truth and distribution path. Requires the maintainers to document/pin how `flatscan.c` becomes `flatscan.wasm`, regenerate package artifacts, update changelog/release metadata, and run upstream plus Workbench tests. | **Preferred**, conditional on confirming the authoritative branch and build recipe. A documented contribution path exists in the local historical source; acceptance and current release state are unknown. |
| Keep a downstream patched C source and reproducible build | Can preserve API/format semantics while retaining a tested package. Workbench must own the patch rebase, compiler/toolchain pin, generated wrapper, provenance, and ongoing compatibility testing. | **Fallback** if upstream cannot take the correction promptly. Preserve the old artifact and issue the corrected copy as a separately traceable vendor version. |
| Replace only embedded Wasm | Lowest immediate code churn and preserves the JS wrapper/API, as the candidate demonstrates. Binary-only replacement makes the source/build chain less auditable and leaves the defect in the source of truth. | **Avoid as a maintained route.** Use only as a temporary emergency measure with source, build recipe, and hashes recorded. |

No patch was submitted and no remote Git operation was performed. The upstream integration decision remains open because local refs diverge and the checked-out branch lacks the module.

## Production integration acceptance checklist

- [ ] Confirm the authoritative upstream branch/commit with maintainers; do not infer it from branch name or stale tracking refs.
- [ ] Land or explicitly carry the two-condition source patch; record source commit/blob and API/package version.
- [ ] Publish a reproducible `flatscan.c` → Wasm build command/script with compiler, linker, target, and flags pinned or versioned.
- [ ] Rebuild twice from the documented source/toolchain and compare Wasm hashes; verify exports, memory configuration, wrapper compatibility, and generated package hashes.
- [ ] Run the 19 targeted cases and 49-case API matrix; retain the pinned-vendor negative control and all existing dictionary/fallback/nested/multi-block controls.
- [ ] Run the relevant upstream suite (`node tests/run.js` and the LFC-pack test files) and add a permanent source-level regression test.
- [ ] Validate under Chrome, Firefox, and the project-supported WebKit engine, recording exact versions, OS/device, CSP, and Worker creation/execution counts.
- [ ] Verify production CSP without `unsafe-eval` or `unsafe-inline`; allow `wasm-unsafe-eval` for Wasm and `worker-src blob:` only if Blob workers remain part of the package. Keep `connect-src` constrained to actual approved local integration needs.
- [ ] Confirm Worker errors reject operations and parallel output matches sequential output for values and bytes on supported browsers.
- [ ] Preserve MIT and Zstandard BSD-3-Clause notices; record source, build, and artifact provenance.
- [ ] Stage a reversible vendor upgrade: keep the current pinned artifact/hash intact, add the corrected package under a new versioned path, and document the exact rollback target and verification hash before switching consumers.
- [ ] Keep decoded-value-count validation as separate requirement `LFCP-WB-PHASE5-002`; test malformed short/overlong string vectors independently before release.
- [ ] Obtain explicit authorization before changing the canonical vendor artifact or integrating it into application code.

## Decision

The candidate is **browser-qualified for Android Chrome 156 under the tested CSP** and demonstrates actual parallel Worker execution and error propagation. It is **not yet production-integration qualified**: Firefox was not locally tested, the official flat-scan compiler recipe is absent from the inspected source snapshot, upstream acceptance/current release status is unknown, and the available JS-modules branches diverge substantially. Keep the candidate isolated. The next action is to establish the authoritative upstream source/build route and obtain a Firefox run; no integration is authorized by this qualification.
