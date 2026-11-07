import assert from 'node:assert/strict';
import { DelimitedParser, IngestError, cleanHeaders, detectDelimiter } from '../src/ingest/delimited.mjs';
import { TypeTracker } from '../src/ingest/infer.mjs';

const run = (text, d = ',', chunk = 0) => {
  const rows = [], lines = []; const p = new DelimitedParser(d, (r, l) => { rows.push(r); lines.push(l); });
  if (!chunk) p.feed(text, true); else for (let i = 0; i < text.length; i += chunk) p.feed(text.slice(i, i + chunk), i + chunk >= text.length);
  return { rows, lines };
};
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

t('plain, CRLF, CR, no trailing newline', () => {
  for (const nl of ['\n', '\r\n', '\r']) assert.deepEqual(run(`a,b${nl}1,2${nl}3,4`).rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
});
t('blank lines skipped (middle, end, start, whitespace-only kept as data)', () => {
  assert.deepEqual(run('a,b\n1,2\n\n3,4\n\n\n').rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
  assert.deepEqual(run('\n\na,b\n').rows, [['a', 'b']]);
  assert.deepEqual(run('a\n \n').rows, [['a'], [' ']]);
});
t('quoted empty line is data, not blank', () => assert.deepEqual(run('a\n""\nb\n').rows, [['a'], [''], ['b']]));
t('quoted fields: comma, newline, escaped quote', () => assert.deepEqual(run('a,b\n"x,1","y\nz"\n"he ""hi"""\n'.replace(/"he ""hi"""\n$/, '"he ""hi""",2\n')).rows, [['a', 'b'], ['x,1', 'y\nz'], ['he "hi"', '2']]));
t('empty cells kept as empty strings', () => assert.deepEqual(run(',,\n1,,3\n').rows, [['', '', ''], ['1', '', '3']]));
t('line numbers are physical lines, including after quoted newlines and blanks', () => {
  const { lines } = run('a,b\n"x\ny",1\n\n3,4\n'); assert.deepEqual(lines, [1, 2, 5]);
});
t('every chunk size gives identical rows and line numbers', () => {
  const text = 'a,b,c\r\n"x,""1""",,3\r\n\r\n"multi\nline",5,6\r\n7,8,9';
  const whole = run(text);
  for (let c = 1; c <= text.length; c++) assert.deepEqual(run(text, ',', c), whole, 'chunk ' + c);
});
t('errors carry the line number', () => {
  assert.throws(() => run('a\n"x"y\n'), (e) => e instanceof IngestError && e.line === 2 && /^Line 2:/.test(e.message));
  assert.throws(() => run('a\nb"c\n'), (e) => e.line === 2);
  assert.throws(() => run('a\n"open\n'), (e) => e.line === 2 && /does not close/.test(e.message));
});
t('record size limit', () => assert.throws(() => { const p = new DelimitedParser(',', () => {}, { maxRecordChars: 10 }); p.feed('x'.repeat(11), true); }, /limit/));
t('bad delimiter rejected', () => { for (const d of ['', '"', '\n', ',,']) assert.throws(() => new DelimitedParser(d, () => {})); });
t('cleanHeaders', () => assert.deepEqual(cleanHeaders(['id', '', 'id', ' x ', 'id']), ['id', 'column_2', 'id_2', 'x', 'id_3']));
t('detectDelimiter ignores delimiters inside quotes', () => {
  assert.equal(detectDelimiter('a,b\n1,2\n'), ','); assert.equal(detectDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(detectDelimiter('"a,b,c,d";"e"\n"1,2,3,4";"5"\n'), ';');
});
t('type inference', () => {
  const ty = (vals) => { const k = new TypeTracker(); vals.forEach((v) => k.add(v)); return k; };
  assert.equal(ty(['1', '-20', '']).type, 'integer'); assert.equal(ty(['1', '2.5']).type, 'number');
  assert.equal(ty(['true', 'False']).type, 'boolean'); assert.equal(ty(['2026-11-05', '2026-11-05T01:02:03Z']).type, 'date');
  assert.equal(ty(['2026-13-45']).type, 'string'); assert.equal(ty(['007']).type, 'number'.replace('number', 'string'));
  assert.equal(ty(['', '']).type, 'empty'); assert.equal(ty(['a', '1']).type, 'string'); assert.equal(ty(['1', '']).nullable, true);
});
console.log(`  ${n} ingest checks passed`);
