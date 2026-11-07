import assert from 'node:assert/strict';
import { csvField, csvLines, csvHeader } from '../src/export/csv.mjs';
import { DelimitedParser } from '../src/ingest/delimited.mjs';
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const parse = (text, d = ',') => { const out = []; const p = new DelimitedParser(d, (r) => out.push(r)); p.feed(text, true); return out; };
t('plain values are written as is', () => assert.equal(csvField('abc'), 'abc'));
t('delimiter, quote, CR and LF force quotes; quotes double', () => {
  assert.equal(csvField('a,b'), '"a,b"'); assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('x\ny'), '"x\ny"'); assert.equal(csvField('x\ry'), '"x\ry"');
});
t('null and undefined become empty', () => { assert.equal(csvField(null), ''); assert.equal(csvField(undefined), ''); });
t('tab delimiter quotes only tabs, not commas', () => { assert.equal(csvField('a,b', '\t'), 'a,b'); assert.equal(csvField('a\tb', '\t'), '"a\tb"'); });
t('lines end with CRLF', () => assert.equal(csvLines([['a', 'b'], ['1', '']]), 'a,b\r\n1,\r\n'));
t('header uses column names', () => assert.equal(csvHeader([{ name: 'id' }, { name: 'a,b' }]), 'id,"a,b"\r\n'));
t('round trip through our reader keeps every value, including leading and trailing spaces', () => {
  const rows = [['id', 'note'], ['1', ' padded '], ['2', 'multi\nline, "quoted"'], ['3', ''], ['4', '=1+1'], ['5', 'ünïçode ☃']];
  assert.deepEqual(parse(csvLines(rows)), rows);
  assert.deepEqual(parse(csvLines(rows, '\t'), '\t'), rows);
});
console.log(n + ' export checks passed');
