// The radix sort for number and date columns must give exactly the order of the comparison sort it replaced:
// empties last, then values that are not numbers, ties in file order, -0 equal to 0, ascending or descending, on all rows or a filtered subset.
import { radixSortNumbers } from '../src/query/columnar.mjs';
import { sortKeyFor } from '../src/query/query.mjs';
function reference(idx, src, key, sign) {
  const n = src.length, rank = new Uint8Array(n), num = new Float64Array(n);
  for (let k = 0; k < idx.length; k++) { const i = idx[k], v = src[i]; if (v == null || v === '') { rank[i] = 2; continue; } const x = key(v); if (x !== x) rank[i] = 1; else num[i] = x; }
  const arr = Array.from(idx);
  arr.sort((a, b) => { const ra = rank[a], rb = rank[b]; if (ra || rb) return ra === rb ? a - b : ra > rb ? 1 : -1; const x = num[a], y = num[b]; return x < y ? -sign : x > y ? sign : a - b; });
  return Uint32Array.from(arr);
}
let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const pool = [() => String(rnd(50)), () => String(rnd(1e9) - 5e8), () => (rnd(20000) / 100 - 100).toFixed(3), () => '', () => null, () => 'abc', () => '-0', () => '0', () => '1e300', () => '-1e-300', () => 'Infinity', () => '-Infinity', () => String(rnd(5)), () => (rnd(1000) / 100).toFixed(2)];
let bad = 0, cases = 0; const key = sortKeyFor('number');
const check = (idx, src, sign) => { cases++; const A = reference(idx, src, key, sign), B = radixSortNumbers(idx, src, key, sign); if (A.length !== B.length || A.some((v, i) => v !== B[i])) bad++; };
for (let t = 0; t < 300; t++) {
  const n = 1 + rnd(1500), mode = rnd(3);
  const src = Array.from({ length: n }, () => mode === 0 ? pool[rnd(pool.length)]() : mode === 1 ? String(rnd(30)) : (rnd(10) === 0 ? '' : String(rnd(1e6) / 10)));
  const idx = Uint32Array.from(Array.from({ length: n }, (_, i) => i).filter(() => rnd(5) !== 0));
  check(idx, src, 1); check(idx, src, -1);
}
for (let t = 0; t < 200; t++) {   // columns already in order or strictly reversed, with some empty and non-number cells
  const n = 1 + rnd(300), dir = rnd(2) ? 1 : -1; let v = rnd(100); const src = [];
  for (let i = 0; i < n; i++) { v += dir * (1 + rnd(3)); const r = rnd(10); src.push(r === 0 ? '' : r === 1 ? 'zz' : String(v)); }
  const idx = Uint32Array.from(Array.from({ length: n }, (_, i) => i));
  check(idx, src, 1); check(idx, src, -1);
}
if (bad) { console.log('  FAIL radix sort differs from the comparison sort in ' + bad + ' of ' + cases + ' cases'); process.exit(1); }
console.log('  ok  radix sort equals the comparison sort (' + cases + ' cases: ties, empties, non-numbers, -0, ordered and reversed columns, filtered rows)');
