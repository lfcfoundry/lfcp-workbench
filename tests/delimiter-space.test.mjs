// detectDelimiter: single-space separated files are found, prose and names are left alone.
import assert from 'node:assert/strict';
import { detectDelimiter, spaceDelimited } from '../src/ingest/delimited.mjs';
const t = (name, f) => { f(); console.log('  ok  ' + name); };
t('pageview list (a quote inside a title) is space separated', () => assert.equal(detectDelimiter('en Main_Page 100 5\nde Foo 3 9\nfr Bar_baz 12 4\nen.m Cat"x 7 1\nja Q 8 2\nen Z 1 1\n'), ' '));
t('two fields with a numeric column', () => assert.equal(detectDelimiter('alpha 1\nbeta 2\ngamma 3\ndelta 4\nepsilon 5\nzeta 6\n'), ' '));
t('two-word names stay one column', () => assert.equal(detectDelimiter('John Smith\nMary Jones\nAnn Lee\nBob Ray\nTom Hill\nSue Kim\n'), ','));
t('prose with a varying word count stays one column', () => assert.equal(detectDelimiter('the quick brown fox\njumps over\nthe lazy dog today\nand more\nwords here are many\nfew\n'), ','));
t('commas win over spaces', () => assert.equal(detectDelimiter('a,b c,d\n1,2 x,3\n4,5 y,6\n'), ','));
t('tabs win over spaces', () => assert.equal(detectDelimiter('a\tb c\n1\t2 x\n'), '\t'));
t('quoted fields that hold spaces', () => assert.equal(detectDelimiter('en "two words" 3\nde plain 4\nfr "a b" 5\nen x 6\nde y 7\nfr z 8\n'), ' '));
t('too few lines', () => assert.equal(spaceDelimited('a 1 2\nb 2 3\n'), false));
t('empty sample', () => assert.equal(detectDelimiter(''), ','));
