Copyright (c) 2026 LFC Foundry. MIT License.

# Claude handoff: Workbench vendor evidence

**Update 2026-11-11 (Claude):** verified, no vendor change; see [CLAUDE-RESULTS.md](CLAUDE-RESULTS.md). The text below is the original handoff, kept as published.

This is an **isolated evidence-only** branch, `codex/claude-handoff-2026-11-11`, based on live-main `ede629220610dd536259fc0645dc968668a5f64c`. It is not canonical `main`. There is **no Workbench code candidate** to integrate: the current app uses LFC-pack 0.7.2, and the independent checks found no current vendor defect. Do not update the dependency or merge this branch into `main` merely because the historical 0.4.19 artifact is defective.

Read [CURRENT-STATE.md](CURRENT-STATE.md), [FINDINGS.md](FINDINGS.md), [TASKS.md](TASKS.md), [TEST-EVIDENCE.md](TEST-EVIDENCE.md), and [SOURCE-MANIFEST.md](SOURCE-MANIFEST.md). The independent fixture and recorded output are in [evidence/](evidence/). All required files are on this GitHub branch; no Termux filesystem is needed.

Claude should preserve the distinction between an **empty-first** 0.4.19 defect and ordinary nonempty mixed-length behavior, verify the current 0.7.2 import path, and only propose a vendor change if new current-version evidence warrants one. Work on this branch and report results; never merge into a canonical branch.
