Copyright (c) 2026 LFC Foundry. MIT License.

# Test evidence

Run from repository root with the existing Node environment:

```sh
node --test tests/ingest-lfcp.test.mjs
node docs/codex-handoffs/claude-2026-11-11/evidence/vendor-empty-first.cjs vendor/lfcp/0.4.19/lfc-pack.js vendor/lfcp/0.7.2/lfc-pack.js
```

The independent review passed the ingest test 1/1. The version fixture found 0.4.19 failed `empty-first-distinct` and `mixed-length-with-empty`, passed `mixed-length-without-empty`; 0.7.2 passed all three. Its exact row/column results and decoded lengths are in [evidence/vendor-empty-first-results.json](evidence/vendor-empty-first-results.json).

The November 10 investigation also ran 49 variable-length cases against both versions: 0.4.19 had 98 API comparison failures, 0.7.2 had zero. No browser qualification or current vendor update was performed in this handoff. The fixture uses synthetic local values only and requires no external service.
