# Handoff status

**Prepared by:** Codex
**Review status:** Phase 14 issue draft is READY FOR SUBMISSION.
**Production integration:** NO-GO.

## Findings

- LFC-pack 0.4.19 / API 0 has a variable-length string round-trip defect in the optimized flat writer. In `strdict()`'s two all-values branches, `if(o)` omits a NUL separator after an empty first value because the output byte offset remains zero.
- The proposed narrow correction changes both separator predicates from `if(o)` to `if(i)`, using value ordinal position. It does not propose a format, public API, JavaScript fallback, dictionary-encoding, or reader change.
- The source proposal is based on the locally recorded JS-modules `origin/main` reference `6e16aa8044d0a05bafa7c756c949f3537c23e92a`; the source blob is `21a0aeb1a3e9fa4fd74deddc9952df710d604890`. Maintainers have not confirmed that this C source is authoritative for the Wasm distributed in 0.4.19.
- Regression evidence: 19/19 targeted candidate cases passed; eight corresponding pinned-vendor cases reproduced the defect; the 49-case candidate run had zero failed checks; the pinned-vendor negative control had 98 failed checks across 49 cases.
- Browser evidence: Android Chrome 156 on an Android phone passed 20/20 Phase 8 checks under the recorded strict CSP. Two parallel Workers initialized and completed work with sequential parity. Firefox remains unqualified.
- The corrected candidate Wasm was reproduced with the recorded Clang 21.1.8 / wasm-ld 21.1.8 build. This does not reproduce the historical upstream Wasm: the existing build process for that artifact is undocumented in the examined source snapshot.

## Integrity references

- Phase 11 `SHA256SUMS`: 40 payload files verified; manifest SHA-256 `e83e67168a7425ff89a55e25ddd44941dca50ea0fd4feb198ab043d67d5b9c74`.
- Canonical LFC-pack 0.4.19 vendor artifact SHA-256: `8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259`.
- Corrected candidate JavaScript SHA-256: `69a1d28e712224b3a98d93dbbde6ccd4f33b96bba457709c5568b56d5493601f`.
- Corrected candidate Wasm SHA-256: `80a8332b64fa28697fbea3a054579076ed217b64e1c28078fc95fedd5a6d3c8a`.

## Open questions

1. Is `modules/lfc-pack/wasm/flatscan.c` authoritative for the distributed 0.4.19 `flatscan.wasm`?
2. Which compiler, linker, and flags produced the historical Wasm, and can that environment be recovered?
3. If not, would maintainers accept a new pinned build recipe and deliberate Wasm regeneration?
4. Is the minimal source correction appropriate upstream, and what source, test, and release process should be followed?
5. Which Firefox version and environment should qualify the candidate?

## Requested Claude response

Review the issue and evidence independently; identify any remaining investigation; advise whether the issue should be submitted as drafted; and return a proposed next-action plan for user review. Keep any issue submission decision separate from production integration.

The investigation has not been submitted to maintainers. No issue attachments have been uploaded separately. This branch handoff contains the evidence package, but does not authorize issue submission, patch integration, canonical Wasm regeneration or replacement, or a release.
