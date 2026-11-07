# Phase 9: Upstream authority, binary provenance, and integration feasibility

**Decision:** no-go for production integration now. The correction is technically sound and the corrected candidate build is reproducible with the recorded local toolchain, but the existing upstream Wasm build cannot be reproduced from the available build instructions. Keep the source patch and generated candidate isolated until upstream maintainers confirm the build contract. Firefox remains untested.

All GitHub conclusions below distinguish the live, read-only ref query from local Git objects. No branch or ref was updated, and no source repository was changed.

## 1. Upstream source authority

On 2026-11-02, the read-only query

```sh
git -C ../JS-modules ls-remote --symref origin HEAD refs/heads/main refs/heads/codex-lfc-pack refs/heads/pr/lfc-pack 'refs/tags/*'
```

reported `HEAD -> refs/heads/main` and `main` at `6e16aa8044d0a05bafa7c756c949f3537c23e92a`. This matches the local `origin/main` ref. A separate read-only count reported 155 advertised branch heads and zero advertised tag refs. No fetch was performed. The branch tips most directly named for LFC-pack are topic/history branches; for example, `codex-lfc-pack` is `ba76a73811dc52bc762f29f9882d2b7cbb7a24a7` (README version 0.1.3), and `pr/lfc-pack` is `c784577603d547ca9172e7819963f40f8849417d` (README versions through 0.2.0). They do not supersede current `main` for the 0.4.19 source.

The current advertised `main` contains LFC-pack 0.4.19 / API 0. Its source of record for the flat writer is `modules/lfc-pack/wasm/flatscan.c`, blob `21a0aeb1a3e9fa4fd74deddc9952df710d604890`. The package source is `modules/lfc-pack/lfc-pack.js`; its embedded module is `FSB64`. The release changelog entry is `modules/lfc-pack/CHANGELOG.md`, version 0.4.19 dated 2026-11-01. The README says the file format is not frozen until a formal release. The root `CONTRIBUTING.md` invites issues and pull requests and requires reading `AGENTS.md`, running `node tests/run.js`, and adding a check. No tag refs were advertised; GitHub release objects were not separately queried, so a release-page history is not asserted.

The checked-out JS-modules worktree remains on `main` at `0758e96ccc4579fb2c0ca81891d18b5ef57ee170`, ahead 291 / behind 811 relative to `origin/main`; its tree has no `modules/lfc-pack` directory. The local `origin/main` ref is nevertheless confirmed current by the read-only remote query. Use the remote `main` snapshot for this report, not the divergent checked-out worktree. The JS-modules worktree was clean and was not changed.

## 2. Binary provenance and source correspondence

At the verified `origin/main` ref:

| Artifact | Exact identity |
|---|---|
| C source | `modules/lfc-pack/wasm/flatscan.c`, Git blob `21a0aeb1a3e9fa4fd74deddc9952df710d604890` |
| Checked-in Wasm | `modules/lfc-pack/wasm/flatscan.wasm`, Git blob `3042d8691f13d53c76c3497ea19479282f4a93ad`, 13,718 bytes, SHA-256 `a6611fa9e977d8b8c998f231130c89a4e46f695ce9549a9fd7c6b6cc34f4e31c` |
| `lfc-pack.js` embedded `FSB64` | Decodes to 13,718 bytes and is byte-for-byte identical to the checked-in Wasm; same SHA-256 |

The standalone binary and embedded binary are therefore verified to be the same artifact. Both expose no imports and export `memory`, `scan`, `count`, `hexcols`, `keyix`, `strdict`, `rawjoin`, `gather`, `ipcol`, and `__heap_base`.

Git history tracks source and binary together: the binary first appears with the 0.1.3 flat writer in commit `7ea5daed0744f2e6e113873717d1a9ca8a9d2295`; the most recent source and binary update in this history is commit `4fd8aa8e20b7f80d6844c9b9c93802a6ddf03ded` (2026-11-01). This provides version-control provenance and intended pairing, but not a reproducible build record.

The tracked Wasm has no custom sections and contains no `clang`, `LLVM`, `producers`, or build-id strings. Neither the binary nor the inspected commit messages identify the compiler/linker.

**Exact source-to-binary reproduction is not established.** The source tree has no flat-scan compiler recipe or recorded compiler/linker version. Clang 21.1.8 and wasm-ld/LLD 21.1.8 are available locally. Compiling the unmodified source blob from `origin/main` with the candidate flags below produced a 13,342-byte module, SHA-256 `92494f9689651d2725f159fff06739593b213d659bad6cf774c3c197643432f7`; it does not byte-match the checked-in 13,718-byte module. The modules expose the same import/export interface. The size/hash difference alone cannot distinguish different compiler flags/toolchain from another source/build difference, so it does not prove that the tracked binary is stale or unrelated.

The corrected source build is reproducible with the recorded local compiler and flags: `flatscan-corrected-rebuild-20261102.wasm` is byte-identical to `flatscan-fixed-v2.wasm`, 13,391 bytes, SHA-256 `80a8332b64fa28697fbea3a054579076ed217b64e1c28078fc95fedd5a6d3c8a`. That establishes the candidate build only; it does not reconstruct the historical upstream Wasm.

The read-only audit script `experiments/fixes/lfc-pack-0.4.19-string-writer/phase9-proposal/verify-origin-artifact.py` checks the local `origin/main` object identities and confirms `FSB64` equals the tracked standalone Wasm. Run it from the repository root with Python 3; it refuses a different local `origin/main` commit so results cannot silently drift.

## 3. Minimum reproducible build route

The Phase 7/9 candidate command uses Clang 21.1.8, target `wasm32`, and wasm-ld 21.1.8:

```sh
clang --target=wasm32 -O3 -nostdlib -fno-builtin -mbulk-memory \
  -Wl,--no-entry -Wl,--export-dynamic -Wl,--export=__heap_base \
  -Wl,--initial-memory=1048576 -Wl,--max-memory=1073741824 \
  -Wl,-z,stack-size=65536 -Wl,--strip-all \
  -o flatscan-fixed-v2.wasm flatscan.c
```

This uses no libc, headers, or external library for `flatscan.c`; the browser package separately embeds Zstandard, whose BSD-3-Clause notice is already preserved. The resulting module is Wasm 1 with no imports and the exports listed above. `modules/lfc-pack/build.py` then base64-embeds `wasm/flatscan.wasm` into the combined JavaScript package and also writes decoder/viewer outputs. The script writes into the source tree, so an eventual official regeneration should occur in an authorized isolated checkout and review every generated output.

The current upstream toolchain contract is missing. `wasm/build-core.sh` documents Clang 18+ for `core.c`; it is not a build instruction for `flatscan.c`. `wasm/build.sh` builds Zstandard. Do not infer the flat-scan flags from either script. The candidate recipe is recorded as a **proposal** in `experiments/fixes/lfc-pack-0.4.19-string-writer/phase9-proposal/BUILD-PROPOSAL.md`; it must not be silently adopted as official.

## 4. Isolated correction proposal and regression evidence

`experiments/fixes/lfc-pack-0.4.19-string-writer/phase9-proposal/flatscan-string-separator.patch` is the minimal two-line source proposal against `origin/main:modules/lfc-pack/wasm/flatscan.c`. In both all-values join loops in `strdict()`, it changes the separator condition from `if(o)` to `if(i)`. The separator is determined by value ordinal position; output byte offset can remain zero after an empty value. No format, dictionary, JS fallback, or reader behavior changes.

Phase 9 reran the existing regressions against isolated candidate/vendor copies:

- `phase9-19case-targeted.json`: 19/19 corrected-candidate cases passed; eight corresponding vendor cases still reproduced the known defect.
- `phase9-49case-candidate.json`: 49 cases, zero failed checks.
- `phase9-49case-vendor-negative-control.json`: 49 cases, 98 failed checks, expected negative control.

These records are in `experiments/fixes/lfc-pack-0.4.19-string-writer/phase9-proposal/`. Phase 8’s real-browser evidence remains in `benchmarks/results/phase-8-browser-strict-20261102T192745Z-afbc49f8.json`: Android Chrome 156 passed 20/20 checks under the tested strict CSP, verified two actual pack Workers, sequential/parallel byte identity, and Worker startup error propagation. No browser work was rerun in Phase 9.

The preserved Phase 8 policy matrix showed `wasm-unsafe-eval` is required for Wasm initialization and `worker-src blob:` for `packParallel()` in that Chrome version; no `unsafe-eval` or `unsafe-inline` was needed. `connect-src 'none'` passed the candidate tests. Details and exact headers remain in `docs/lfcp/DEPLOYMENT-QUALIFICATION-PHASE8.md`.

## 5. Firefox status

No Firefox executable or installed Firefox application was available in the current environment; Android Chrome was available and tested in Phase 8. Firefox qualification remains outstanding. The upstream module README at the verified source ref documents prior Firefox 158/160 testing, but this does not qualify the corrected candidate. Preserve and use the executable external procedure in `experiments/fixes/lfc-pack-0.4.19-string-writer/phase8-validation/README.md`; do not claim Firefox compatibility until that procedure is run and a result is recorded.

## 6. Integration strategy comparison

| Strategy | Auditability and reproducibility | Maintenance / compatibility / rollback | Assessment |
|---|---|---|---|
| **A. Upstream source correction and official rebuild** | Best if maintainers add a pinned build recipe and generate the Wasm/package from source. Source patch is small and preserves API 0 and format behavior. | Lowest long-term Workbench maintenance. Still requires authoritative current source, accepted patch, upstream tests, browser coverage, changelog/version decision, and a tagged or otherwise immutable release artifact. Rollback remains simple if Workbench keeps the old 0.4.19 artifact untouched and switches to a separately versioned package. | **Preferred, conditional.** Prepare/propose the patch; do not integrate until the missing official build contract and release artifact provenance are resolved. |
| **B. Maintained downstream source patch + local reproducible build** | Auditable if the exact source baseline, two-line patch, compiler, linker, flags, artifact hashes, and wrapper embedding are kept together. Corrected build currently reproduces byte-for-byte on Clang/LLD 21.1.8. | Workbench owns patch rebasing, toolchain support, integration tests, and future security/compatibility review. Rollback is feasible with versioned copies. | **Fallback** if upstream cannot take it promptly. Keep isolated until explicitly authorized; pin toolchain in a reproducible environment before relying on it long term. |
| **C. Binary-only replacement** | Weakest: package bytes can be checked, but source-to-binary provenance is not independently reproducible with the present upstream metadata. | Immediate compatibility was demonstrated, but maintaining a binary delta without its source/build process increases review and rebase risk. Rollback must restore the old artifact by exact hash. | **Do not use as the maintained route.** Emergency-only if a separately approved time-critical response requires it. |

## 7. Outstanding risks and decisions

1. Ask upstream maintainers to confirm the source branch and explain how the checked-in 13,718-byte `flatscan.wasm` was built. The 0.4.19 source is tracked on live `main`, but no compiler metadata exists in the inspected files.
2. Decide whether upstream will add an official `build-flatscan` recipe and what compiler version becomes the compatibility baseline. The current candidate command is reproducible but does not reproduce the old Wasm.
3. Obtain Firefox testing of the corrected candidate and the policy matrix. WebKit remains untested in this phase as well.
4. Decide how a formal release will be identified. Remote `main` has no advertised tag refs and the module says the format is not frozen until formal release.
5. Keep reader decoded-value-count validation (`LFCP-WB-PHASE5-002`) independent; Phase 9 did not implement it.

## 8. Recommendation

**NO-GO: do not replace or integrate the canonical vendor artifact.**

**GO: continue with an upstream source/build proposal only.** The patch, build proposal, provenance audit, regression records, and Phase 8 browser/CSP evidence are now prepared under the isolated proposal directory. A production or upstream change still requires maintainer confirmation, a documented reproducible build, Firefox validation, an immutable artifact/release reference, and explicit authorization for integration or submission.
