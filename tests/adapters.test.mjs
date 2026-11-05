// Unit tests for the spike's delimited-text adapter (experiments/lfcp-first-spike/src/adapters.js).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const ctx = { self: {} };
vm.runInNewContext(readFileSync(join(here, '../experiments/lfcp-first-spike/src/adapters.js'), 'utf8'), ctx);
const A = ctx.self.DataWorkbenchAdapters;

function parse(text, delim = ',', chunk = 0) {
  const rows = []; const p = new A.DelimitedParser(delim, (r) => rows.push(Array.from(r)));
  if (!chunk) p.feed(text, true);
  else { for (let i = 0; i < text.length; i += chunk) p.feed(text.slice(i, i + chunk), i + chunk >= text.length); }
  return rows;
}
const arr = (x) => JSON.parse(JSON.stringify(x));
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

t('plain rows', () => assert.deepEqual(arr(parse('a,b\n1,2\n')), [['a', 'b'], ['1', '2']]));
t('CRLF line ends', () => assert.deepEqual(arr(parse('a,b\r\n1,2\r\n')), [['a', 'b'], ['1', '2']]));
t('no trailing newline', () => assert.deepEqual(arr(parse('a,b\n1,2')), [['a', 'b'], ['1', '2']]));
t('quoted comma and newline', () => assert.deepEqual(arr(parse('a,b\n"x,1","y\nz"\n')), [['a', 'b'], ['x,1', 'y\nz']]));
t('escaped quote', () => assert.deepEqual(arr(parse('a\n"he said ""hi"""\n')), [['a'], ['he said "hi"']]));
t('empty fields kept', () => assert.deepEqual(arr(parse(',,\n')), [['', '', '']]));
t('tab delimiter', () => assert.deepEqual(arr(parse('a\tb\n1\t2\n', '\t')), [['a', 'b'], ['1', '2']]));
t('split at every size gives same rows', () => {
  const text = 'a,b,c\r\n"x,""1""",,3\r\n"multi\nline",5,6\r\n';
  const whole = arr(parse(text));
  for (let c = 1; c <= text.length; c++) assert.deepEqual(arr(parse(text, ',', c)), whole, 'chunk ' + c);
});
t('text after closing quote throws', () => assert.throws(() => parse('"a"b\n'), /closing quote/));
t('unclosed quote at end throws', () => assert.throws(() => parse('"a\n'), /does not close/));
t('mid-field quote throws', () => assert.throws(() => parse('ab"c\n'), /beginning of a delimited field/));
t('cleanHeaders: blanks and duplicates', () => assert.deepEqual(arr(A.cleanHeaders(['id', '', 'id', ' x '])), ['id', 'column_2', 'id_2', 'x']));
t('detectDelimiter', () => {
  assert.equal(A.detectDelimiter('a,b,c\n1,2,3\n'), ',');
  assert.equal(A.detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.equal(A.detectDelimiter('a;b;c\n1;2;3\n'), ';');
});
console.log(`  ${n} adapter checks passed`);
