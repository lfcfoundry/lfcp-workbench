// Derived columns: a new column computed from one existing column by a named function (no user code is run).
// Date text is read the way the import stores it: 2002-12-11T03:00:00.000 (or a space instead of T). Result: Float64Array (NaN = empty/unreadable) or Array<string>.
const D = (s, i) => s.charCodeAt(i) - 48;
const two = (s, i) => { const a = D(s, i), b = D(s, i + 1); return (a >= 0 && a <= 9 && b >= 0 && b <= 9) ? a * 10 + b : NaN; };
const NUM_FNS = {
  year: (s) => { const a = two(s, 0), b = two(s, 2); return a === a && b === b && s.length >= 4 ? a * 100 + b : NaN; },
  month: (s) => (s.length >= 7 ? two(s, 5) : NaN),
  day: (s) => (s.length >= 10 ? two(s, 8) : NaN),
  hour: (s) => (s.length >= 13 ? two(s, 11) : NaN),
  minute: (s) => (s.length >= 16 ? two(s, 14) : NaN),
  length: (s) => s.length,
};
const TEXT_FNS = { upper: (s) => s.toUpperCase(), lower: (s) => s.toLowerCase(), trim: (s) => s.trim(), first: (s) => s.charAt(0) };
export const DERIVE_FUNCTIONS = [...Object.keys(NUM_FNS), ...Object.keys(TEXT_FNS)];
export const isNumberDerive = (fn) => fn in NUM_FNS;
export function derive(src, n, fn) {
  if (fn in NUM_FNS) {
    const f = NUM_FNS[fn], out = new Float64Array(n);
    for (let i = 0; i < n; i++) { const s = src[i]; out[i] = typeof s === 'string' ? f(s) : NaN; }
    return out;
  }
  if (fn in TEXT_FNS) { const f = TEXT_FNS[fn], out = new Array(n); for (let i = 0; i < n; i++) { const s = src[i]; out[i] = typeof s === 'string' ? f(s) : ''; } return out; }
  throw new Error('Unknown function: ' + fn);
}
