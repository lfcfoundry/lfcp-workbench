import fs from 'node:fs'; import { DelimitedParser, cleanHeaders } from '../src/ingest/delimited.mjs'; import { TypeTracker, typedCell } from '../src/ingest/infer.mjs';
const src = fs.readFileSync(new URL('../app/worker.js', import.meta.url),'utf8');
const a = src.indexOf('function numBytes'), b = src.indexOf('// Reads the file in slices'), c = src.indexOf('const NEEDS_ESC'), d = src.indexOf('const sampleRecord');
const enc = new TextEncoder();
const mk = new Function('enc','typedCell', src.slice(c,d) + '\n' + src.slice(a,b) + '\nreturn { lineBuilder, makeFast };');
const { lineBuilder, makeFast } = mk(enc, typedCell);
function rnd(n){return Math.floor(Math.random()*n)}
const pick = (arr)=>arr[rnd(arr.length)];
const cells = [()=>String(rnd(1e6)), ()=>'-'+rnd(1000), ()=>'0', ()=>'-0', ()=>'007', ()=>'', ()=>'12345678901234567', ()=>'123456789012345', ()=>(rnd(1e4)/100).toFixed(2), ()=>'1e5', ()=>'-.5', ()=>'abc def', ()=>'true', ()=>'2026-11-0'+(1+rnd(9)), ()=>'x\\y', ()=>'café', ()=>'"q,uoted"', ()=>'"a""b"', ()=>' 5', ()=>'5 ', ()=>'a\tb', ()=>'1.', ()=>'1.5e', ()=>'1.5e+3', ()=>'+5'];
let bad = 0;
for (let trial = 0; trial < 300; trial++) {
  const nc = 1 + rnd(6), hdr = Array.from({length:nc},(_, i)=>'c'+i).join(','), plan = Array.from({length:nc},()=>Math.random()<0.4);
  let lines = [hdr]; const nr = 30 + rnd(300);
  for (let r = 0; r < nr; r++) { if (Math.random()<0.03) { lines.push(''); continue; } const k = Math.random()<0.03 ? nc + (rnd(2)?1:-1) : nc; if (k<1) continue; const gen = pick([0,1,2]); lines.push(Array.from({length:k},(_, i)=> (gen===0? cells[rnd(cells.length)](): gen===1? (i===0?String(r): 'w'+rnd(5)): String(rnd(1000)/10))).join(',')); }
  const eol = Math.random()<0.3 ? '\r\n' : '\n'; const text = lines.join(eol) + (Math.random()<0.5 ? eol : '');
  const bytes = enc.encode(text);
  // reference: old path
  const run = (fast) => {
    let headers=null, trackers=null, build=null, acc='', F=null, errs=null; const out=[]; let outBuf=new Uint8Array(1<<16), pos=0;
    const parser = new DelimitedParser(',', (f, line) => { if (!headers) { headers = cleanHeaders(f); trackers = headers.map(()=>new TypeTracker()); build = lineBuilder(headers, plan.slice(0,headers.length), trackers, typedCell); if (fast) F = makeFast(headers, plan.slice(0,headers.length), trackers, ','); return; } if (f.length !== headers.length) { const e = new Error(`Row has ${f.length} fields but the header has ${headers.length}.`); e.line = line; throw e; } acc += build(f); });
    const clean = (p)=>p.mode===0&&!p.seen&&p.row.length===0&&p.field===''&&!p.pendingQuote&&!p.skipLF;
    const dec = new TextDecoder('utf-8',{fatal:true}); let sampleN = 0;
    try {
      for (let i = 0; i < bytes.length;) {
        if (F && !F.off && clean(parser)) { if (acc) { const w = enc.encode(acc); outBuf.set(w,pos); pos+=w.length; acc=''; } const io={buf:outBuf,pos}; i = F.run(bytes, i, Infinity, parser, io); outBuf=io.buf; pos=io.pos; if (i>=bytes.length) break; }
        const k = !headers || (F && !F.off) ? bytes.indexOf(10, i) : -1;
        if (k < 0) { parser.feed(dec.decode(bytes.subarray(i),{stream:false}), false); break; }
        parser.feed(dec.decode(bytes.subarray(i,k+1),{stream:true}), false); i = k+1;
      }
      parser.feed(dec.decode(), true);
    } catch (e) { errs = e.message + ' @' + e.line; }
    if (acc) { const w = enc.encode(acc); outBuf.set(w,pos); pos+=w.length; }
    return { text: new TextDecoder().decode(outBuf.subarray(0,pos)), errs, types: trackers && trackers.map(t=>[t.n,t.empty,t.int,t.num,t.bool,t.date].join()).join('|'), line: parser.line, frows: F ? F.rows : 0 };
  };
  const A = run(false), B = run(true);
  if (A.text !== B.text || A.errs !== B.errs || A.types !== B.types || A.line !== B.line) { bad++; if (bad < 4) console.log('DIFF trial', trial, JSON.stringify({ea:A.errs,eb:B.errs,ta:A.types,tb:B.types,la:A.line,lb:B.line, same: A.text===B.text})); }
  globalThis.fr = (globalThis.fr||0) + B.frows;
}
console.log('trials 300, differences', bad, 'fast rows used', globalThis.fr);
if (bad) process.exit(1);
