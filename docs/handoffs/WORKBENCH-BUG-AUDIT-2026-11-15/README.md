# LFCP Workbench Bug Audit — 2026-11-15

This handoff records an independent QA investigation of the latest Claude Workbench development. It is based on **claude/project-thread-tb9b0d at 9efaac4d56506207ee2d8833961bb613cc7ecfd8**, audited against GitHub on 2026-11-15. The seven findings below were reproduced on that source; no proposed correction has been implemented here.

## Executive summary

- Seven confirmed runtime defects: five P0 data-integrity defects and two P2 import defects.
- The existing Node suite passed 80/80 checks. The single-file build and Chromium self-tests passed, including a 300 MB workload. Those broad tests did not cover the seven specific cases.
- Firefox and WebKit were unavailable; this is not a cross-browser qualification.
- The active dependency is vendored LFC-pack 0.13.3. The historical 0.4.19 investigation does not describe this implementation.
- Raw CSV export intentionally preserves formula-like values. This is a separate product/security decision, not one of the seven bugs.

## Contents

- [Current state](CURRENT-STATE.md) — audited ref, architecture, dependency, and scope.
- [Bug register](BUG-REGISTER.md) — severity, trigger, source evidence, root cause, and proposed correction directions.
- [Reproduction guide](REPRODUCTION.md) — fixtures, browser runner, expected and actual results.
- [Test results](TEST-RESULTS.md) — existing suite, build, Chromium checks, and limits.
- [Fix plan](FIX-PLAN.md) — controlled implementation stages and regression coverage.
- [Claude handoff](CLAUDE-HANDOFF.md) — paste-ready independent review and correction assignment.
- [Browser QA runner](qa-runner.html) — same-origin fixture runner that exercises the audited Workbench worker without editing application files.
- [Source manifest](SOURCE-MANIFEST.sha256) — SHA-256 hashes for every other handoff document, runner, and fixture. Its own hash is reported separately at publication.

## Reproduction fixtures

The fixtures are under [fixtures/](fixtures/). They include the original minimal inputs and controls for ZIP CRC, XLSX parsing, JSON precision/schema, nested-key collisions, and Windows-1252 detection. The 300 MB workload and generated single-file build are deliberately not included.

## Scope and status

This is a handoff only. It does not contain fixes and does not modify application source, vendored dependencies, build output, workflows, or the audited Claude branch. The source snapshot and evidence identity are documented in [CURRENT-STATE.md](CURRENT-STATE.md); reproducible procedures are in [REPRODUCTION.md](REPRODUCTION.md).
