# LFC-pack 0.4.19 string-writer correction — maintainer submission package

**Status:** Prepared for maintainer review; not sent or published. **Production integration remains NO-GO.**

This package contains the proposed issue body, minimal source patch, retained Node and browser evidence, and the test inputs needed for local reproduction. Copied files are bit-for-bit copies; SHA256SUMS records their original locations and hashes. Local paths in these documents are provenance labels, not externally accessible links. Attach selected package files to any future issue or provide them through a separately authorized public location.

## Defect and correction

In LFC-pack 0.4.19 / API 0, the optimized flat writer's strdict() has two all-values branches that use output byte offset o to decide whether to emit a NUL separator. An empty first string copies no bytes, so o remains zero and the following value is treated as the first. For rows with body values ['', 'A', 'B', 'C'], the retained unpackRows() negative-control record reports shifted values A, B, C, followed by an undefined/missing body for row four. Footer and returned row counts remain four. This is the runtime value recorded by the harness, not a JSON-serialized value.

The proposed patch changes both separator tests from if(o) to if(i), using the value ordinal. It proposes no format, JS fallback, reader, or dictionary-encoding change. Patch base: JS-modules main commit 6e16aa8044d0a05bafa7c756c949f3537c23e92a; modules/lfc-pack/wasm/flatscan.c blob 21a0aeb1a3e9fa4fd74deddc9952df710d604890. Maintainers must confirm that this source is authoritative for the distributed Wasm.

## Evidence and results

- Targeted regression record: 19/19 candidate cases passed; eight matching pinned-vendor cases reproduced the defect.
- API regression records: 49 candidate cases with zero failed checks; pinned vendor negative control: 49 cases, 98 failed checks.
- Browser qualification: Android Chrome 156 on an Android phone. Strict CSP record: 20/20 checks passed. Two actual parallel Workers initialized and completed jobs; output matched sequential output. Policy controls show wasm-unsafe-eval is needed for Wasm initialization and worker-src blob: for the tested parallel path; connect-src none also passed. These results do not qualify Firefox.
- Corrected candidate Wasm: 13,391 bytes, SHA-256 80a8332b64fa28697fbea3a054579076ed217b64e1c28078fc95fedd5a6d3c8a; the corrected Phase 9 rebuild matches it byte-for-byte.
- Historical upstream Wasm: 13,718 bytes, SHA-256 a6611fa9e977d8b8c998f231130c89a4e46f695ce9549a9fd7c6b6cc34f4e31c. The source snapshot has no documented flat-scan compiler/linker recipe. The candidate Clang 21.1.8 / wasm-ld 21.1.8 recipe builds the corrected candidate but does not reproduce the historical binary. Git history pairs source and binary but does not establish the original build process.
- Firefox was unavailable for Phase 8; no Firefox compatibility claim is made.

Reports and machine-readable records are under evidence/. Reproduction scripts and exact vendor/candidate inputs are under reproduction/.

## Reproduction instructions

Use only existing Node.js, Python 3, browser, and (for optional C-to-Wasm rebuild) Clang/wasm-ld installations. No dependencies are installed.

From reproduction/:

    node tests/lfcp-optimized-string-writer-fix.cjs

This runs the 19-case candidate/vendor comparison and creates a new result under benchmarks/results/ with exclusive file creation. It refuses to overwrite a same-named result.

    LFCP_PACK_PATH=experiments/fixes/lfc-pack-0.4.19-string-writer/lfc-pack-fixed.js node tests/lfcp-variable-length-string-roundtrip.cjs

This runs the broader variable-string harness against the corrected candidate. To run the negative control, omit LFCP_PACK_PATH; the pinned-vendor version is expected to report the known mismatches and exit nonzero. Archived JSON results remain the historical run records.

For browser reproduction, from reproduction/ start:

    python3 experiments/fixes/lfc-pack-0.4.19-string-writer/phase8-validation/server.py

Open:

    http://127.0.0.1:8080/experiments/fixes/lfc-pack-0.4.19-string-writer/phase8-validation/index.html?policy=strict

The harness runs strict CSP and directive-removal controls and writes newly generated results under reproduction/benchmarks/results/. Keep those apart from archived evidence/phase8/results/. Record browser version and environment for every new run; do not infer Firefox compatibility from Chrome results.

For a candidate-only C build, see the package-root BUILD-PROPOSAL.md and run its command from reproduction/experiments/fixes/lfc-pack-0.4.19-string-writer/. Change the output path to a new temporary filename and compare its SHA-256 to the recorded candidate hash. This does not reproduce historical upstream Wasm. Do not overwrite included artifacts.

The copied provenance helper at evidence/phase9/verify-origin-artifact.py is included for reference, not as a standalone package command. It expects the original LFCFoundry checkout layout, a sibling JS-modules Git checkout at the recorded origin/main reference, and the historical rebuild file adjacent to the helper. Those checkout objects are not bundled. The copied proposal documents retain some relative-path wording from their original phase9-proposal directory; use the package map above to locate their copied companions.

## Package map

- PROPOSED-ISSUE-BODY.md is the extracted unsent issue body.
- MAINTAINER-INQUIRY.md, UPSTREAM-PATCH-PROPOSAL.md, BUILD-PROPOSAL.md, INTEGRATION-DECISION-MATRIX.md, and PHASE10-REPORT.md contain the full proposal context.
- patch/ contains the minimal two-condition patch.
- evidence/phase8/ contains the browser report, harness instructions, and final CSP matrix records.
- evidence/phase9/ contains upstream/source/build investigation and regression JSON.
- evidence/build/ contains corrected and unmodified-source build outputs.
- reproduction/ contains regression scripts, pinned vendor/candidate inputs with notices, and the Phase 8 browser harness.

Outstanding maintainer questions: authoritative source; historical build process or approval of a new pinned build; preferred source/test/release process; Firefox target/environment. No maintainer contact, issue, pull request, or publication has occurred. Production integration remains NO-GO.
