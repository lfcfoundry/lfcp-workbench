Copyright (c) 2026 LFC Foundry. MIT License.

# Findings

## Current 0.7.2 vendor — no change indicated

The current vendor file SHA-256 is `747df574c3f90f54443c2d24645f39a9962560ee3b0a71cf179dffa9702eee84`. The November 10 investigation matched it to JS-modules source blob `f47777cbd279e14a4ffd4d49c803418466c1ad68` at commit `1aabf448f75f64fe2599f917a05b3a210548c0ba`. The app worker and build tool use 0.7.2. The independent empty-first and mixed-length fixture passed all three cases with 0.7.2; the existing ingest test passed. Each vendor JS embeds its required WASM, so no separate binary artifact is missing from these directories.

## Historical 0.4.19 — empty-first defect

The historical file SHA-256 is `8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259`, matched in the prior investigation to JS-modules blob `dae1cf4a7d9f6f568ea05447f57e9158e7396091` at commit `6e16aa8044d0a05bafa7c756c949f3537c23e92a`. An empty first value caused row/column round-trip failure and shifting. Mixed nonempty lengths `[1,8,40,256,1024,4096]` passed. Mixed lengths **with an initial empty value** failed. This is an empty-first bug, not a general mixed-length defect. The earlier C fast flat-writer condition `if(o)` instead of `if(i)` explains the first-delimiter loss.

The prior investigation also showed that a 0.4.19 reader can decode a 0.7.2-produced four-row file, while a 0.7.2 reader cannot recover data already corrupted by a 0.4.19 writer. Both report LFCP format major 1/minor 0. Preserve format/API compatibility in any separately authorized historical repair.

**LOW:** The current ingest test's console text says 0.6.2 while its import is 0.7.2. That message is misleading but not evidence of a vendor defect.
