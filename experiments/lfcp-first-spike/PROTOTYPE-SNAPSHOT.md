# Experimental snapshot provenance

This directory was copied from the standalone filesystem project `~/lfcfoundry/data-workbench-spike/`. That source directory had no Git metadata, so there is no source commit history to import or claim.

The snapshot preserves its application, parser, documentation, styles, README, and both original notice files. The LFCP implementation file was consolidated into `../../vendor/lfcp/0.4.19/` so the canonical repository contains one copy of the large vendor artifact. The original notice files remain beside the experiment and are also present beside the shared vendor artifact. The only runtime code path adjustment is `worker.js` importing the shared build. The README's run path and vendor references were updated to reflect the new location. No other prototype behavior was intentionally changed.

The original standalone directory was not modified. The snapshot remains experimental and untested in a browser as part of this integration.
