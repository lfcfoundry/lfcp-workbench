# Workbench group-by candidate results

Copy one report per candidate. Keep raw trial records alongside it.

## Candidate

- ID and hypothesis:
- Baseline commit:
- Candidate commit / diff:
- Source files changed:
- Date and operator:
- Existing correctness suite command/result:
- New focused correctness command/result:

## Environment

| Engine | Version | OS/device | CPU class / cores | Main thread or Worker | Status |
|---|---|---|---|---|---|
| Chromium | | | | | |
| Firefox | | | | | |
| WebKit | | | | | |
| Node (correctness/allocation only) | | | | | |

Record power mode, browser flags, memory telemetry available/absent, and any environment changes between paired runs.

## Correctness and order

- Matrix cells executed and omitted:
- Seeds and fixture description:
- Oracle and baseline comparison method:
- Output shape/value/order result:
- NaN, empty, null, duplicate-selection, and cache results:
- Failures, minimized cases, and follow-up:

## Performance and allocation

| Workload ID | `n` | `m` / selectivity | key/cardinality/path | cache | aggregate list | baseline p50/p90 | candidate p50/p90 | paired effect + interval | logical temp bytes baseline/candidate |
|---|---:|---:|---|---|---|---|---|---|---:|
| | | | | | | | | | |

- Warm-up and paired-trial counts:
- Raw result file(s), command(s), fixture seed:
- ArrayBuffer/typed-array allocation ledger:
- Runtime memory sample and its scope:
- OOM, skipped cells, errors, or anomalies:

## Decision

- Adopt / reject / inconclusive:
- Correctness gate:
- Target workloads improved:
- Protected controls and material-regression check:
- Known limits and browser/device coverage:
- Reproduction instructions:
