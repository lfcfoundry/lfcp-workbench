# Cleanup note, 2026.11.06

On the owner's approval, the test phone's model and operating-system version were removed from this repository, and the history of the Codex branch and the Claude branch was rewritten so the old text is no longer in any commit on either branch.

- 51 text files were edited. The phone is now described as "an Android phone". Nothing else in the evidence was changed.
- Every SHA-256 fingerprint that pointed at an edited file was refreshed. All 40 entries in the Phase 11 manifest verify against their files, and every JSON file still parses.
- Commit ids quoted in older documents (for example `7b46150` for the migration import and `0af1a5c` for the Codex handoff tip) are the ids from before the rewrite. The same commits now have these ids:

| Commit | Before | After |
|---|---|---|
| Migration import | `7b46150` | `896d2aa` |
| Codex handoff tip | `0af1a5c` | `2082c55` |

- GitHub may still hold the old commits behind read-only pull-request references. Those cannot be reached from any branch here.
