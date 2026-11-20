// Deterministic generator for the big-file check: row i is always the same, so the test
// can recompute any row and compare it with what the data view shows.
export const HEADER = 'id,name,score,when,note\n';
export function cells(i) {
  return [String(i), 'Name ' + (i % 97), i % 9 === 0 ? '' : (((i * 37) % 10000) / 100).toFixed(2), '2026-11-' + String(1 + (i % 28)).padStart(2, '0'), 'note ' + i];
}
export const line = (i) => cells(i).join(',') + '\n';
