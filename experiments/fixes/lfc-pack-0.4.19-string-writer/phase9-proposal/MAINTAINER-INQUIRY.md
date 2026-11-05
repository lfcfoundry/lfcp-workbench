<!-- Copyright (c) 2026 LFC Foundry. MIT License. -->

# Draft maintainer inquiry — not sent

**Suggested mechanism:** open an issue through the [lfcfoundry/JS-modules issue tracker](https://github.com/lfcfoundry/JS-modules/issues) asking for source/build clarification. The repository’s `CONTRIBUTING.md` explicitly welcomes issues and pull requests and says bug reports should identify browser and device. No issue or pull request templates were found in the verified `main` tree. If maintainers confirm the source and build route, follow up with the separate patch proposal as a pull request.

## Established facts

- The read-only upstream query on 2026-11-02 resolved remote `HEAD` and `main` to `6e16aa8044d0a05bafa7c756c949f3537c23e92a`.
- At that commit, `modules/lfc-pack/wasm/flatscan.c` is the source path (blob `21a0aeb1a3e9fa4fd74deddc9952df710d604890`). The tracked `wasm/flatscan.wasm` is 13,718 bytes (blob `3042d8691f13d53c76c3497ea19479282f4a93ad`) and matches the bytes embedded as `FSB64` in `lfc-pack.js`.
- `build.py` embeds the existing Wasm but does not compile `flatscan.c`. The visible Wasm scripts build other components. The tracked Wasm contains no compiler metadata, and the inspected history does not record its compiler or flags.
- Rebuilding unmodified `flatscan.c` with the candidate’s Clang 21.1.8 / wasm-ld 21.1.8 command did not reproduce the tracked binary byte-for-byte. The corrected candidate does rebuild byte-for-byte with that command.
- The proposed fix changes two `strdict()` all-values separator predicates from `if(o)` to `if(i)`. The existing Workbench regressions pass on the candidate and reproduce the defect on the pinned vendor.
- Android Chrome 156 passed the Phase 8 CSP and Worker matrix. Firefox qualification for the corrected candidate is outstanding.

## Questions for maintainers

1. Is `modules/lfc-pack/wasm/flatscan.c` the authoritative source for the `flatscan.wasm` distributed in 0.4.19?
2. Which exact Clang and wasm-ld versions and flags produced the tracked 13,718-byte module? Are there build logs, CI definitions, local scripts, or archived build environments that identify them?
3. Can that historical build environment be recovered or reproduced? If not, would you prefer to establish a new pinned build recipe and deliberately regenerate the binary?
4. Would maintainers accept a checked-in flat-scan build script/provenance record alongside the existing `build.py` embedding step?
5. Does the two-condition `strdict()` correction appear appropriate for upstream? Is there a preferred source branch or test format for proposing it?
6. Can maintainers provide or facilitate a Firefox environment for the corrected candidate, or confirm which Firefox version should be used for release qualification?

## Draft issue body (not submitted)

**Title:** Clarify `flatscan.wasm` build provenance and review empty-string `strdict()` correction

I found a variable-length string round-trip defect in LFC-pack 0.4.19’s optimized flat writer. With flat rows whose string column begins with an empty value, `strdict()` can omit the NUL separator before the next value because the all-values loops use the output byte offset as the “not first value” test. For the four-row input `['', 'A', 'B', 'C']`, the retained `unpackRows()` regression record reports shifted values `A`, `B`, and `C`, followed by an `undefined`/missing `body` value; the footer and returned row count still report four. This describes the runtime result, not a JSON-serialized representation. The isolated two-predicate correction and regression evidence are available for review; no format or API change is proposed.

Before proposing integration, could you confirm whether `flatscan.c` is the source of the checked-in `flatscan.wasm`, and identify the compiler/linker versions and flags used to build it? `build.py` embeds the binary but does not compile it, and the current local Clang 21.1.8 build does not reproduce the tracked binary byte-for-byte. I would also appreciate advice on the preferred source/test branch and a Firefox test environment/version. No change has been made to the canonical vendored library, and no proposal has been submitted.

## Attachments/evidence to reference if requested

- `UPSTREAM-PATCH-PROPOSAL.md` and `flatscan-string-separator.patch` in this directory.
- `BUILD-PROPOSAL.md` and `verify-origin-artifact.py` in this directory.
- Phase 8 browser/CSP report and Phase 9 regression JSON records referenced by those documents.
