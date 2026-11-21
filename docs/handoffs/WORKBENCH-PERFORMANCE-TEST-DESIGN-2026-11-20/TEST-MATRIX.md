# Group-by correctness and permutation matrix

This matrix separates correctness from timing. Run all small deterministic cases in Node and in the browser harness. Use a simple reference implementation for expected groups and aggregates, and compare the candidate with both the reference and the unchanged baseline.

## Common assertions

For every applicable case, assert:

- `keys`, `keys2` (when present), counts, and every aggregate array have the same length and values as the oracle and baseline.
- Group order matches the baseline for the selected path. Include a separate assertion for first-appearance order only if that contract is confirmed; do not silently change the dense `groupBy2` ordering while optimizing allocations.
- `NaN` values compare as missing values; empty groups, all-missing aggregate groups, empty text keys, and numeric `NaN` keys retain current behavior.
- Aggregate array order follows the requested non-count aggregate order. Count remains in `counts`, not in `values`.
- A filtered result uses the supplied row sequence consistently. Test sorted, reversed, and deterministic shuffled row lists. Test duplicate row indices only if the query API intends to allow them; otherwise document the precondition and keep duplicates out of public-path fixtures.
- Repeated calls do not change results, input arrays, cache ownership, or the source columns.

## DBE-01 — lazy allocation on the fused one-key path

The eligible branch is a small-range integer typed-array key and a supported `count`, `sum`, or `avg` aggregate list using at most two distinct numeric value columns. The fallback must remain unchanged.

| Dimension | Required values |
|---|---|
| Key range | Contiguous integers; sparse integers; negative-to-positive integers; range width `1,048,575` (eligible boundary); width `1,048,576` (fallback boundary); fractional key; text key; numeric `NaN`/empty key; all-empty key. |
| Aggregate list | Count only; count + sum; count + average; sum + average on the same column; sum and/or average on two distinct numeric columns; min, max, or rate (fallback); three distinct numeric columns (fallback); a nonnumeric sum/average input (fallback/error behavior unchanged). |
| Row selection | `rows === null`; all rows explicitly selected; dense half-selection; sparse 1% selection; empty selection. Use a non-monotonic selection in at least one case. |
| Values | Positive and negative values; zero; mixed valid and `NaN`; all-`NaN` aggregate values; empty input. |

**Allocation gate:** in an isolated allocation-count run, prove that the successful fused branch does not construct the per-row `Uint32Array(m)`. Prove that fallback branches still construct and use the group IDs as before. Keep allocation instrumentation out of timed runs.

**Decision boundary:** if eligibility is uncertain, compare the exact same fixture against the pre-change function and assert the selected fast/fallback path explicitly. A test that only checks final values may miss a branch-selection regression.

## DBE-02 — selection-sized IDs for two-key grouping

`groupBy2` accepts uncoded columns, supplied dictionary IDs, optional full-column cached IDs, optional `rows`, and either dense slots, packed-key open addressing, or the large-slot `Map` fallback. Do not force all permutations through one gigantic Cartesian product; use focused boundary fixtures and pairwise coverage elsewhere.

| Dimension | Required values |
|---|---|
| Key representation | Uncoded strings drawn from a small interned label pool; uncoded numeric typed arrays including `NaN`; dictionary IDs supplied for key 1, key 2, and both. |
| Selection size | No selection; explicit all-row selection; 50%, 10%, 1%, and 0.1% selection; empty selection. Include sparse and dense selections. |
| Selection order | Ascending, descending, seeded shuffle, and repeated rows if accepted by the API. The same selected rows in different orders expose order assumptions. |
| Cache state | Cold uncoded keys; warm full-column cache; filtered call after cache warm-up; repeated filtered call; cache disabled; six distinct full-column entries followed by a seventh to exercise current eviction; dictionary path. Verify filtered compact IDs never enter the reusable full-column cache. |
| Slot strategy | Product below `DENSE_SLOTS`; exactly `DENSE_SLOTS`; just above it; `forceMap`; packed-key open-addressing range; just below and just above the `2^31` slot switch to the `Map` fallback. For the latter, about 46,340 × 46,340 versus 46,341 × 46,341 distinct labels exercises the boundary with only about 46 thousand input rows. |
| Aggregates | Count; sum/average; min/max; rate on a normal text column; rate on a dictionary-coded column; multiple aggregates on the same numeric column; aggregates on different columns. |
| Data shape | One group; all unique pairs; repeated adjacent pairs; sorted and shuffled pairs; empty strings; numeric `NaN`; missing numeric aggregate values; all-missing values; empty input. |

### Required dense-versus-map order fixture

Use a short sequence such as `(a,x), (b,y), (b,x)`. Capture the dense and forced-map outputs separately. The fixture is deliberately adversarial: slot order can differ from first-seen pair order. Record the current behavior and intended contract before editing. For DBE-02, the candidate must preserve each baseline path's observable order. If the product contract requires both strategies to agree, file and test that correction separately from the allocation change.

### Allocation assertions

For a cold filtered call on uncoded keys, instrument allocations in a separate harness run and identify the arrays created by `keyIds` separately from the pre-created input and selection arrays, `groupBy2`'s `gid`, and output arrays. With `m << n`, the candidate should no longer allocate two key-ID arrays of length `n`; selection-aligned temporaries should be O(`m`). Dictionary-ID and warm full-column-cache paths should not acquire an extra full-length copy.

Test that empty selection returns the existing empty-result shape; a compact representation must not accidentally treat selection position as source row ID. Test cache hits using both full-column IDs indexed by row and compact filtered IDs indexed by selection position.

## DBE-03 — optional direct aggregate-state experiment

Only begin after DBE-01 and DBE-02 have independent results. Compare current group-ID materialization plus aggregate scans with direct updates as rows resolve to groups.

Cover one and two keys; low and high cardinality; grouped/sorted and shuffled rows; no selection, sparse selection, and dense selection; count, sum, average, min, max, rate, and multiple aggregates. Preserve counts, pair keys, path-specific ordering, missing-value rules, `NaN` handling, rate denominators, and numeric accumulation order. If a candidate changes semantics or does not repeatably improve at least one declared target without material control regressions, reject it.

## Coverage strategy

Do not run the Cartesian product of every dimension. Use:

1. The explicit branch and boundary cases above as mandatory tests.
2. A pairwise/covering set across key representation, selection size/order, cache state, slot strategy, and aggregate family.
3. A small seeded randomized differential suite against a reference implementation. Record the seed and retain any failing case as a deterministic fixture.
4. At least one adversarial order case per group strategy and one warm-cache-after-filter case.

Existing starting point: `tests/groupby-derive.test.mjs`. It covers basic one-key results, a mixed two-key case, forced-map/dictionary variants, and a warm cache; it is a correctness test, not a timing harness, and it does not establish the order/performance contracts required here.
