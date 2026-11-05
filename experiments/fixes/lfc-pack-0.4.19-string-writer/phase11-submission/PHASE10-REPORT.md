<!-- Copyright (c) 2026 LFC Foundry. MIT License. -->

# Phase 10 report: maintainer inquiry and integration proposal

## Recommendation

**Remain NO-GO for production integration.** The technical patch and evidence are ready for maintainer review, but no maintainer has confirmed source authority or the historical compiler/linker recipe. The upstream binary cannot yet be rebuilt byte-for-byte from available documentation. Firefox qualification also remains outstanding.

**GO for preparing an upstream inquiry; not for sending it.** The draft issue and patch description are complete. No message, issue, pull request, or public proposal was created or sent.

## Contact mechanism and conventions

At verified `JS-modules` `main` commit `6e16aa8044d0a05bafa7c756c949f3537c23e92a`, root `CONTRIBUTING.md` says issues and pull requests are welcome, explicitly including AI-assisted work with a human. It requests reading `AGENTS.md`, running `node tests/run.js`, and adding a regression check. No `.github` issue or pull-request templates were found in that tree. The module keeps `CHANGELOG.md`, `CHANGELOG-DEV.md`, and a `test/` suite; `modules/lfc-pack/test/run.js` is the module test entry point. The module README also records browser versions and says the format is not frozen until formal release.

The least disruptive public sequence is a **GitHub issue first** to clarify source authority/build provenance and ask about Firefox testing; submit a pull request only after maintainers confirm the target source and build recipe. The drafts remain local at `MAINTAINER-INQUIRY.md` and `UPSTREAM-PATCH-PROPOSAL.md` in this directory.

## Evidence prepared

- The inquiry separates verified facts from six maintainer questions and includes an unsent issue-body draft.
- The patch proposal gives the two-line correction, four-row reproduction, expected and actual results, Phase 9 Node regression outcomes, Phase 8 Chrome/CSP/Worker results, Firefox status, and the historical Wasm reproducibility gap.
- The decision matrix defines evidence and ownership gates for upstream integration, downstream maintenance, or continued isolation.
- The existing Phase 8 Firefox procedure is retained. An acceptable Firefox result must record the full browser version and OS/device, apply the strict and directive-removal CSP matrix, verify initialization/ordinary/streaming/parallel operations and all empty-string cases, observe actual Worker creation/initialization/jobs/errors, compare sequential and parallel decoded values and bytes, and preserve machine-readable results. No Firefox result currently meets that bar.

## Responses that would change NO-GO

An upstream maintainer response would change the recommendation to **prepare an upstream PR for review** if it:

1. Confirms `modules/lfc-pack/wasm/flatscan.c` is the authoritative source for the distributed Wasm (or names the actual source of truth).
2. Identifies the compiler/linker, exact flags, or agrees to a new pinned recipe and confirms a reproducible build is acceptable.
3. Confirms the two `if(o)` → `if(i)` changes are correct and identifies the intended test/release process.
4. Provides a Firefox environment/version or confirms a supported Firefox target so the candidate can be tested.

That response would **not by itself authorize production integration**. A production NO-GO becomes eligible for reconsideration only after an official or explicitly owned downstream build reproduces from source, the package embeds that exact output, Node and supported-browser criteria pass, a versioned/immutable artifact and rollback reference exist, licensing is preserved, and the project owner explicitly approves the vendor integration. If maintainers say the source is elsewhere, the proposed patch must be rebased to that source and revalidated. If build provenance remains unknown and no one accepts a new downstream build contract, continue isolation.

## Phase 10 file set

- `MAINTAINER-INQUIRY.md` — unsent issue draft and technical questions.
- `UPSTREAM-PATCH-PROPOSAL.md` — unsent patch description and test/build evidence.
- `INTEGRATION-DECISION-MATRIX.md` — go/no-go conditions for paths A, B, and C.
- `PHASE10-REPORT.md` — this report and recommendation.

The canonical vendor artifact, Phase 6/7 candidate, Phase 8/9 reports, and existing experiments were not altered by these drafts. No commit, fetch, branch change, upstream contact, or publication was performed.
