Copyright (c) 2026 LFC Foundry. MIT License.

# Claude tasks

1. Verify `app/worker.js`, `tools/build-single.mjs`, both vendor provenance files and the current 0.7.2 fixture results.
2. Keep 0.4.19 empty-first findings distinct from ordinary mixed-length behavior. Do not assume current 0.7.2 has the historical bug.
3. If new current-version reproduction appears, prepare a narrow isolated candidate preserving LFCP format/API compatibility and test existing consumers. Otherwise report **no Workbench vendor change**.
4. Run the focused ingest and independent fixture tests using existing dependencies only. Do not update vendor files, install dependencies, or merge into `main` as part of this handoff.
