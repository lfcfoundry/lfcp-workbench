'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const worker = new Worker(window.__WORKER_URL || './worker.js');
  if (window.__WORKER_URL) {   // a page opened from a file has an opaque origin, where a worker cannot start its own helpers: the worker asks, the page starts them and hands over ports (see mkWorker in worker.js)
    const hs = new Map(); let hid = 0;
    const spawn = (k) => { const ids = [], ports = []; for (let i = 0; i < k; i++) { const h = new Worker(window.__WORKER_URL), ch = new MessageChannel(), id = ++hid; h.postMessage({ type: 'attachPort', port: ch.port1 }, [ch.port1]); hs.set(id, h); ids.push(id); ports.push(ch.port2); } worker.postMessage({ type: 'ports', ids, ports }, ports); };
    worker.addEventListener('message', (e) => { const m = e.data || {}; if (m.type === 'helperKill') { const h = hs.get(m.id); if (h) { h.terminate(); hs.delete(m.id); } } else if (m.type === 'helperPool') spawn(m.n); });
  }
  let seq = 0, active = null, last = null; const waiters = new Map();
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
  const status = (t, bad) => { $('status').textContent = t; $('status').className = bad ? 'bad' : ''; };
  const call = (msg) => new Promise((resolve) => { const id = 'j' + (++seq); waiters.set(id, resolve); worker.postMessage(Object.assign({ id }, msg)); });
  const table = (rows, keys) => rows.length ? '<div class="wrap"><table><thead><tr>' + keys.map((k) => '<th>' + esc(k) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + keys.map((k) => '<td title="' + esc(r[k]) + '">' + esc(r[k]) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' : '<p>No rows.</p>';

  worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'progress') { $('prog').value = m.total ? m.bytes / m.total : 0; status(m.rows.toLocaleString() + ' rows · ' + fmt(m.bytes) + ' of ' + fmt(m.total)); return; }
    if (m.type === 'live') { liveSeen = performance.now(); liveDone = (liveHook || ((x) => { status('Reading while the file is saved…'); return openGrid(x.name); }))(m); return; }   // the worker has parsed the file and keeps the columns: the grid can open before the save ends
    if (m.type === 'liveclosed') { $('gridbox').hidden = true; return; }
    const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); }
  };
  let liveHook = null, liveDone = null, liveSeen = 0;
  worker.onerror = (e) => status('Worker stopped: ' + (e.message || 'unknown error'), true);

  function show(d, extra) {
    last = { dataset: d, extra: extra || null };
    $('result').hidden = false;
    $('summary').textContent = `${d.source}: ${d.rows.toLocaleString()} rows, ${d.columns.length} columns, ${fmt(d.bytes)} stored, delimiter ${d.delimiter}, checked by ${d.validation.level}. Kept in: ${d.storage}. ${d.ms} ms total.`;
    $('cols').innerHTML = table(d.columns.map((c) => ({ column: c.name, type: c.type, empty_cells: c.nullable ? 'yes' : 'no' })), ['column', 'type', 'empty_cells']);
    $('preview').innerHTML = table(d.sample, d.columns.slice(0, 12).map((c) => c.name));
  }
  async function refresh() {
    const r = await call({ type: 'list' }), host = $('saved');
    if (r.message) { host.textContent = r.message; return; }
    host.innerHTML = (r.storage && r.storage.startsWith('memory') ? '<p class="bad">This browser has no persistent storage API here, so datasets are kept in memory and disappear when the tab closes.</p>' : '') + (r.datasets.length ? table(r.datasets.map((d) => ({ name: d.name, rows: d.rows, size: fmt(d.bytes), source: d.source })), ['name', 'rows', 'size', 'source']) : '<p>No datasets saved in this browser yet.</p>') +
      (r.incomplete.length ? '<p class="bad">Incomplete files (not usable): ' + r.incomplete.map((o) => esc(o.name)).join(', ') + '</p>' : '') +
      r.datasets.map((d) => '<button data-open="' + esc(d.name) + '">Open ' + esc(d.name.slice(0, 24)) + '…</button>').join('') +
      r.datasets.map((d) => '<button data-del="' + esc(d.name) + '">Delete ' + esc(d.name.slice(0, 24)) + '…</button>').join('') +
      r.incomplete.map((o) => '<button data-del="' + esc(o.name) + '">Remove incomplete ' + esc(o.name.slice(0, 24)) + '…</button>').join('');
    host.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openGrid(b.dataset.open)));
    host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { await call({ type: 'delete', name: b.dataset.del }); refresh(); }));
  }
  async function runImport(file, inline, opts) {
    $('go').disabled = true; $('selftest').disabled = true; $('cancel').hidden = false; $('prog').hidden = false; $('prog').value = 0;
    const id = 'j' + (++seq); active = id;
    const res = await new Promise((resolve) => { waiters.set(id, resolve); worker.postMessage(Object.assign({ type: 'import', id, file, delimiter: $('delim').value, inline: !!inline || /[?&]inline=1/.test(location.search) }, opts || {})); });
    active = null; $('cancel').hidden = true; $('prog').hidden = true; $('selftest').disabled = false; $('go').disabled = !$('file').files.length;
    if (res.type === 'done') { status('Import complete and checked.'); show(res.dataset); refresh(); }
    else status((res.type === 'cancelled' ? 'Cancelled. Nothing was kept.' : 'Import failed: ' + res.message), res.type !== 'cancelled');
    return res;
  }

  // Grid: fixed-height rows, only the visible window is rendered; the worker holds the rows and answers page requests.
  const ROW = 28, WINDOW = 60; const G = { cols: [], filters: {}, sort: null, count: 0, total: 0, start: -1, rows: [], numbers: [], busy: false, timer: 0 };
  // Browsers cap element height (Firefox about 17.8M px), so a very long list scales the scrollbar instead of using real row heights.
  const MAXH = 10000000;
  const scaled = () => G.count * ROW > MAXH, spaceHeight = () => Math.min(G.count * ROW, MAXH);
  function topIndex() {
    const sc = $('gridscroll'), vis = Math.ceil(sc.clientHeight / ROW);
    if (!scaled()) return Math.floor(sc.scrollTop / ROW);
    return Math.max(0, Math.round(sc.scrollTop / (MAXH - sc.clientHeight) * (G.count - vis)));
  }
  const colWidth = () => 11 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);   // the .gc width in css is 11rem
  function renderRows() {
    const sc = $('gridscroll'), first = topIndex(), host = $('gridrows');
    host.style.top = (scaled() ? sc.scrollTop - (first - G.start) * ROW : Math.max(0, G.start) * ROW) + 'px';
    // Only the columns in view (and one more each side) are drawn; the space element keeps the full width so the scroll bar and the header stay right. Wide data (50 columns) used to rebuild every cell on each jump.
    const CW = colWidth(), nc = G.cols.length, c0 = Math.max(0, Math.floor(sc.scrollLeft / CW) - 1), c1 = Math.min(nc, Math.ceil((sc.scrollLeft + sc.clientWidth) / CW) + 1); G.c0 = c0; G.c1 = c1;
    $('gridspace').style.width = (nc * CW) + 'px';
    host.style.setProperty('--pad', (c0 * CW) + 'px'); const pad = '', cls = G.cols.map((c) => (c.type === 'integer' || c.type === 'number' ? 'gc num' : 'gc'));
    let h = ''; for (const r of G.rows) { h += '<div class="gr">' + pad; for (let i = c0; i < c1; i++) h += '<div class="' + cls[i] + '">' + esc(r[i]) + '</div>'; h += '</div>'; } host.innerHTML = h;
    return first;
  }
  let winSeq = 0;   // the newest request wins: a slower, older reply (scrolling fast, or the worker busy) must not replace the rows for the place the person is now at
  async function loadWindow() {
    const sc = $('gridscroll'), first = Math.max(0, topIndex() - 10), mine = ++winSeq;
    if (G.start >= 0 && Math.abs(first - G.start) < 10 && G.rows.length) { const c0 = Math.max(0, Math.floor(sc.scrollLeft / colWidth()) - 1); if (c0 !== G.c0) renderRows(); $('gridhead').scrollLeft = sc.scrollLeft; return; }
    const r = await call({ type: 'page', start: first, count: WINDOW }); if (mine !== winSeq) return;
    G.start = r.start; G.rows = r.rows; G.numbers = r.numbers; renderRows(); $('gridhead').scrollLeft = sc.scrollLeft;
  }
  function gridInfo() { $('gridinfo').textContent = G.count.toLocaleString() + ' of ' + G.total.toLocaleString() + ' rows' + (G.sort ? ', sorted by ' + G.sort.col + (G.sort.dir === 'desc' ? ' (high to low)' : ' (low to high)') : ''); }
  async function applyQuery() {
    const r = await call({ type: 'query', filters: G.filters, sort: G.sort, stream: !!G.forceStream, noZones: !!G.noZones, noInside: !!G.noInside, noFirst: /[?&]nofirst=1/.test(location.search), noPositions: /[?&]nopos=1/.test(location.search), gate: +((/[?&]gate=(\d+)/.exec(location.search) || [])[1] || 0) });
    G.count = r.count; G.total = r.total; G.start = -1; G.rows = []; G.lastQuery = r;
    $('gridspace').style.height = spaceHeight() + 'px'; $('gridscroll').scrollTop = 0;
    G.cols.forEach((c, i) => { const el = document.querySelector('[data-err="' + i + '"]'); if (el) el.textContent = r.errors[c.name] || ''; });
    if (r.errors['']) status(r.errors[''], true);
    gridInfo(); $('gridinfo').textContent += ' · ' + r.ms + ' ms'; await loadWindow();
    return r;
  }
  function buildHead() {
    $('gridhead').innerHTML = G.cols.map((c, i) => '<div class="hc"><button data-sort="' + i + '" title="Sort by ' + esc(c.name) + '">' + esc(c.name) + (G.sort && G.sort.col === c.name ? (G.sort.dir === 'asc' ? ' ▲' : ' ▼') : '') + '</button><input data-filter="' + i + '" placeholder="filter" title="=a|b keeps rows equal to any value (write \\| for a bar)" aria-label="Filter ' + esc(c.name) + '" value="' + esc(G.filters[c.name] || '') + '"><div class="err" data-err="' + i + '"></div></div>').join('');
    $('gridhead').querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
      const c = G.cols[+b.dataset.sort]; G.sort = G.sort && G.sort.col === c.name ? (G.sort.dir === 'asc' ? { col: c.name, dir: 'desc' } : null) : { col: c.name, dir: 'asc' };
      buildHead(); applyQuery();
    }));
    $('gridhead').querySelectorAll('[data-filter]').forEach((inp) => inp.addEventListener('input', () => {
      G.filters[G.cols[+inp.dataset.filter].name] = inp.value; clearTimeout(G.timer); G.timer = setTimeout(applyQuery, 200);
    }));
  }
  async function openGrid(name) {
    status('Opening ' + name + '…');
    const r = await call({ type: 'open', name, noWarm: /[?&]nowarm=1/.test(location.search), noWarmText: /[?&]nowarmtext=1/.test(location.search) });
    if (r.type === 'error') { status(r.message, true); return; }
    Object.assign(G, { cols: r.columns, filters: {}, sort: null }); fillTools(); $('gridbox').hidden = false; $('gridtitle').textContent = 'Data: ' + r.name; buildHead(); await applyQuery(); status('Opened. Type in a filter box or click a column name.');
    return r;
  }
  $('gridscroll').addEventListener('scroll', () => { if (!G.busy) { G.busy = true; requestAnimationFrame(async () => { G.busy = false; await loadWindow(); }); } });
  $('gridrows').addEventListener('mouseover', (e) => { const t = e.target; if (t.classList && t.classList.contains('gc') && !t.title) t.title = t.textContent; });   // the full text of a cut-off cell shows on hover (made then, not for every cell)
  window.addEventListener('resize', () => { if (typeof G !== 'undefined' && G.rows && G.rows.length) renderRows(); });
  // Export the rows now shown (filter and sort applied) as CSV. Returns the worker's reply; with download=true also saves the file.
  async function exportCsv(download, bom) {
    status('Preparing CSV…');
    const r = await call({ type: 'export', delim: ',', bom: bom === undefined ? $('excelbom').checked : bom });
    if (r.type === 'error') { status(r.message, true); return r; }
    if (download) {
      const a = document.createElement('a'), name = String(($('gridtitle').textContent || 'data').replace(/^Data: /, '')).replace(/\.[^.]*$/, '') + '-view.csv';
      a.href = URL.createObjectURL(r.blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      status('Saved ' + name + ': ' + r.rows.toLocaleString() + ' rows, ' + (r.bytes / 1048576).toFixed(1) + ' MB.');
    }
    return r;
  }
  $('exportcsv').addEventListener('click', () => exportCsv(true));
  // Add column, Summarize and Save as LFCP (the worker does the work: src/query/derive.mjs, groupby.mjs)
  const FUNCS = ['hour', 'year', 'month', 'day', 'minute', 'length', 'upper', 'lower', 'trim', 'first'];
  const fillTools = () => {
    const opts = (f) => G.cols.filter(f || (() => true)).map((c) => '<option>' + esc(c.name) + '</option>').join('');
    $('dsrc').innerHTML = opts(); $('dfn').innerHTML = FUNCS.map((f) => '<option>' + f + '</option>').join(''); $('gkey').innerHTML = opts(); $('gcol').innerHTML = opts();
  };
  async function addColumn(src, fn, name) {
    const r = await call({ type: 'derive', source: src, fn, name });
    if (r.type === 'error') { status(r.message, true); return r; }
    G.cols = r.columns; fillTools(); buildHead(); await applyQuery(); status('Added column ' + name + ' (' + r.ms + ' ms).'); return r;
  }
  async function summarize(key, fn, col, eq) {
    const aggs = [{ fn: 'count' }]; if (fn) aggs.push(fn === 'rate' ? { fn, col, equals: eq } : { fn, col });
    const r = await call({ type: 'groupby', key, aggs, filters: G.filters });
    if (r.type === 'error') { status(r.message, true); return r; }
    $('gres').innerHTML = '<table><tr>' + r.headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' + r.rows.slice(0, 200).map((x) => '<tr>' + x.map((v) => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('') + '</table>';
    $('gmsg').textContent = r.groups.toLocaleString() + ' groups from ' + r.rowsUsed.toLocaleString() + ' rows in ' + r.ms + ' ms'; G.lastGroup = r; return r;
  }
  async function saveLfcp(download) {
    status('Saving LFCP…'); const r = await call({ type: 'exportLfcp' });
    if (r.type === 'error') { status(r.message, true); return r; }
    if (download) { const a = document.createElement('a'); a.href = URL.createObjectURL(r.blob); a.download = r.name.replace(/-[0-9a-f-]{36}(\.json\.lfc)$/, '$1'); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
    status('Saved ' + r.name + ': ' + r.rows.toLocaleString() + ' rows, ' + (r.bytes / 1048576).toFixed(2) + ' MB (also kept in this browser).'); return r;
  }
  $('dgo').addEventListener('click', () => addColumn($('dsrc').value, $('dfn').value, $('dname').value || $('dfn').value));
  $('ggo').addEventListener('click', () => summarize($('gkey').value, $('gfn').value, $('gcol').value, $('geq').value));
  $('exportlfcp').addEventListener('click', () => saveLfcp(true));
  window.__wb = { addColumn, summarize, saveLfcp, call, applyQuery, openGrid, G };
  $('closegrid').addEventListener('click', () => { $('gridbox').hidden = true; });

  // Self-test: messy generated CSV, imported in the worker, read back, compared row by row.
  async function selfTest() {
    const t0 = performance.now(), lines = ['id,name,score,when,note\r\n'];
    for (let i = 0; i < 20000; i++) {
      if (i === 5 || i % 997 === 0) lines.push('\r\n');
      lines.push(`${i},${i < 2 ? '' : 'name ' + 'x'.repeat(i % 23)},${i % 7 ? (i % 100) + '.5' : ''},2026-11-${String(1 + i % 28).padStart(2, '0')},${i === 0 ? '' : i % 50 === 0 ? '"multi\nline, ""quoted"""' : 'note ' + i}\r\n`);
    }
    const file = new File(lines, 'selftest.csv', { type: 'text/csv' });
    const { readRecords } = (window.__M || await import('../src/ingest/records.mjs'));
    const expected = readRecords(lines.join('').replace(/^﻿/, '')).records;
    const res = await runImport(file);
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
    add('import finished', res.type === 'done', res.message);
    if (res.type === 'done') {
      const d = res.dataset;
      const { typedCell, typedDecimal } = (window.__M || await import('../src/ingest/infer.mjs')), names0 = d.columns.map((c) => c.name);
      const expTyped = d.plan ? expected.map((r) => { const o = Object.assign({}, r); names0.forEach((nm, i) => { if (d.plan[i]) o[nm] = d.columns[i].decimals ? typedDecimal(r[nm], d.columns[i].decimals) : typedCell(r[nm]); }); return o; }) : expected, expJson0 = JSON.stringify(expTyped);
      add('whole-number columns are stored as numbers', !!d.plan && d.columns.some((c, i) => d.plan[i] && c.type === 'integer'), d.plan ? names0.filter((_, i) => d.plan[i]).join(', ') : 'none');
      add('row count equals expected', d.rows === expected.length, `${d.rows} vs ${expected.length}`);
      add('import ran parse and pack on two threads', d.parallel === true || /[?&]inline=1/.test(location.search) || !/^https?:/.test(location.protocol), (d.parallel ? 'two threads' : 'one thread') + (location.protocol === 'file:' ? ' (a page opened from a file may not be allowed a helper; it then runs on one thread)' : ''));
      const inl = await runImport(file, true);
      add('import on one thread gives the same dataset', inl.type === 'done' && inl.dataset.rows === d.rows && !inl.dataset.parallel && JSON.stringify(inl.dataset.columns) === JSON.stringify(d.columns) && inl.dataset.bytes === d.bytes, inl.type === 'done' ? inl.dataset.rows + ' rows, ' + inl.dataset.bytes + ' vs ' + d.bytes + ' bytes' : inl.message);
      if (inl.type === 'done') await call({ type: 'delete', name: inl.dataset.name });
      let segOk = true, segDetail = []; const expJson = expJson0;
      for (const sb of [1009]) {

        const q0 = performance.now(), sg = await runImport(file, false, { segBytes: sb }); segDetail.push(Math.round(performance.now() - q0) + 'ms');
        const same = sg.type === 'done' && sg.dataset.rows === d.rows && sg.dataset.bytes === d.bytes && JSON.stringify(sg.dataset.columns) === JSON.stringify(d.columns) && (sg.dataset.segmented || sg.dataset.parallel === false);
        let rowsOk = false;
        if (sg.type === 'done') { const v = await call({ type: 'verify', name: sg.dataset.name, expectJson: expJson }); rowsOk = v.json === true; await call({ type: 'delete', name: sg.dataset.name }); }
        segOk = segOk && same && rowsOk; segDetail.push(sb + (sg.type === 'done' ? (sg.dataset.segmented ? (sg.dataset.serialTail ? 'T[' + sg.dataset.segWhy + ']' : 'S' + sg.dataset.redos) : '-') : '!'));
      }
      add('import in small pieces gives the same dataset', segOk, ('piece sizes ' + segDetail.join(' ')) + ' (S<n> = pieces fit after n re-parsed pieces, T = rest parsed in order, - = one helper path)');
      {   // plain rows: every guessed cut is a real line break, so the pieces fit and nothing is parsed twice
        const plain = []; for (let i = 0; i < 6000; i++) plain.push(i + ',row ' + i + ',' + (i % 9) + '.25\r\n');
        const pf = new File(['id,name,score\r\n', ...plain], 'plain.csv', { type: 'text/csv' });
        const q1 = performance.now(), one = await runImport(pf, true), q2 = performance.now(), many = await runImport(pf, false, { segBytes: 2048 }), q3 = performance.now(); segDetail.push('plain ' + Math.round(q2 - q1) + '/' + Math.round(q3 - q2) + 'ms');
        const okp = one.type === 'done' && many.type === 'done' && many.dataset.segmented === true && !many.dataset.serialTail && many.dataset.redos === 0 && many.dataset.rows === 6000 && (many.dataset.bytes === one.dataset.bytes || (many.dataset.timing.columns && Math.abs(many.dataset.bytes - one.dataset.bytes) < one.dataset.bytes * 0.02)) && JSON.stringify(many.dataset.columns) === JSON.stringify(one.dataset.columns);
        const okpFile = !/^https?:/.test(location.protocol) && one.type === 'done' && many.type === 'done' && many.dataset.rows === 6000 && (many.dataset.bytes === one.dataset.bytes || (many.dataset.timing.columns && Math.abs(many.dataset.bytes - one.dataset.bytes) < one.dataset.bytes * 0.02));   // a page opened from a file may not get helper threads: same result on one thread is enough
        add('pieces that fit are accepted without parsing twice', okp || okpFile, many.type === 'done' ? many.dataset.rows + ' rows, ' + (many.dataset.serialTail ? 'rest parsed in order' : 'pieces fit') + ', ' + many.dataset.bytes + ' vs ' + one.dataset.bytes + ' bytes' : many.message);
        {   // every cell quoted, a quoted line break and an empty quoted cell in each row (like real exports): pieces start at a real row start (no re-parse) and the cells read back the same
          const qr = []; for (let i = 0; i < 3000; i++) qr.push('"' + i + '","row ' + i + '","' + (i % 5 ? i + '.50' : '') + '","' + (i % 4 ? '' : 'two\nlines ' + i) + '"\n');
          const qf = new File(['"id","name","score","note"\n', ...qr], 'quoted.csv', { type: 'text/csv' }), qm = await runImport(qf, false, { segBytes: 2048 });
          let okq = false, whyq = qm.message || '';
          if (qm.type === 'done') { const want = []; for (let i = 0; i < 3000; i++) want.push({ id: i, name: 'row ' + i, score: i % 5 ? i * 100 + 50 : null, note: i % 4 ? '' : 'two\nlines ' + i }); const v = await call({ type: 'verify', name: qm.dataset.name, expectJson: JSON.stringify(want) }); okq = v.json === true && qm.dataset.rows === 3000 && qm.dataset.timing.redos === 0; whyq = qm.dataset.rows + ' rows, redos ' + qm.dataset.timing.redos + ', fast rows ' + qm.dataset.timing.fastRows + ', rows ' + (v.json === true ? 'identical' : 'DIFFERENT'); await call({ type: 'delete', name: qm.dataset.name }); }
          add('quoted cells with line breaks import in pieces without re-parsing', okq, whyq);
        }
        {   // a text-like cell ("007") in a number column cannot live in a typed column: the import starts again on the text path and stores the same cells
          const mixedRows = ['id,name,score\r\n', ...plain]; mixedRows[4501] = '007,row 4500,0.25\r\n';
          const mx = await runImport(new File(mixedRows, 'mixed.csv', { type: 'text/csv' }), false, { segBytes: 2048 });
          let okm = false, whym = mx.message || '';
          if (mx.type === 'done') { const want = []; for (let i = 0; i < 6000; i++) want.push({ id: i === 4500 ? '007' : i, name: 'row ' + i, score: (i % 9) * 100 + 25 }); const v = await call({ type: 'verify', name: mx.dataset.name, expectJson: JSON.stringify(want) }); okm = v.json === true && mx.dataset.timing.columns === false; whym = mx.dataset.rows + ' rows, columns path ' + mx.dataset.timing.columns + ', rows ' + (v.json === true ? 'identical' : 'DIFFERENT'); await call({ type: 'delete', name: mx.dataset.name }); }
          add('a text-like cell in a number column falls back to the text path', okm, whym);
        }
        const badRows = ['id,name,score\r\n', ...plain]; badRows[4001] = '4000,only two\r\n';
        const bf = new File(badRows, 'plainbad.csv', { type: 'text/csv' }), b1 = await runImport(bf, true), b2 = await runImport(bf, false, { segBytes: 2048 });
        segDetail.push('bad ' + Math.round(performance.now() - q3) + 'ms'); add('a bad row in the middle names the same line with pieces', b1.type === 'error' && b2.type === 'error' && b1.message === b2.message && /Line 4002/.test(b2.message), b2.message);
        for (const x of [one, many]) if (x.type === 'done') await call({ type: 'delete', name: x.dataset.name });
        {   // blocks packed by worker threads (LFC-pack 0.7.0) and appended in order give the same rows
          const pk = await runImport(pf, false, { segBytes: 2048, blockBytes: 3000, packWorkers: 2 });
          let okw = false, why = pk.message || '';
          if (pk.type === 'done') { const want = []; for (let i = 0; i < 6000; i++) want.push({ id: i, name: 'row ' + i, score: (i % 9) * 100 + 25 }); const v = await call({ type: 'verify', name: pk.dataset.name, expectJson: JSON.stringify(want) }); okw = v.json === true && pk.dataset.rows === 6000 && pk.dataset.validation.ok; why = pk.dataset.rows + ' rows, ' + pk.dataset.bytes + ' bytes, rows ' + (v.json === true ? 'identical' : 'DIFFERENT'); await call({ type: 'delete', name: pk.dataset.name }); }
          add('blocks packed by worker threads give the same rows', okw, why);
        }
      }
      {   // many small blocks: a number filter decodes only the blocks whose range can hold a match, with the same answer as scanning everything
        // LFC-pack writes a tiny block as nested rows when a number column has empty cells inside it, and the column path needs flat blocks: this check uses a copy with no empty scores
        const zr = await runImport(new File(lines.map((l) => l.replace(/^(\d+,[^,]*),,/, '$1,1.5,')), 'zone.csv', { type: 'text/csv' }), false, { blockBytes: 3000 });
        if (zr.type === 'done') {
          await openGrid(zr.dataset.name);
          const want = (f) => expected.filter(f).map((r) => r.id).join(',');
          const run = async (filters, sort, noZones) => { G.filters = filters; G.sort = sort; G.noZones = noZones; buildHead(); const q = await applyQuery(); G.noZones = false; return { q, ids: G.rows.map((r) => r[0]).join(',') }; };
          const a = await run({ id: '>=19990' }, { col: 'id', dir: 'asc' }, false), b2 = await run({ id: '>=19990' }, { col: 'id', dir: 'asc' }, true);
          const c = await run({ id: '=777' }, null, false), d2 = await run({ id: '<3' }, { col: 'id', dir: 'desc' }, false), e2 = await run({ id: '>5', name: 'x' }, null, false), e3 = await run({ id: '>5', name: 'x' }, null, true);
          add('number filter skips blocks and gives the same rows', a.q.zoneBlocks > 0 && a.q.zoneBlocks * 5 <= a.q.blocks && a.ids === b2.ids && a.ids === want((r) => +r.id >= 19990) && c.ids === '777' && d2.ids === '2,1,0' && e2.q.count === e3.q.count, 'kept ' + a.q.zoneBlocks + ' of ' + a.q.blocks + ' blocks ' + JSON.stringify(a.q).slice(0, 200) + '; ' + a.q.count + ' rows');
          await call({ type: 'delete', name: zr.dataset.name }); G.filters = {}; G.sort = null;
        } else add('number filter skips blocks and gives the same rows', false, zr.message);
      }
      {   // awkward text: quotes, backslash, tab, non-BMP, line separator, and column names that are special to objects
        const weird = 'id,__proto__,1,"a""b",note\r\n1,x,2,y,"back\\slash"\r\n2,x,3,y,"tab\there"\r\n3,\u00e9,4,y,"\ud83d\ude00 \u2028 end"\r\n4,x,5,y,"quote "" and, comma\nnext line"\r\n';
        const wr = await runImport(new File([weird], 'weird.csv', { type: 'text/csv' })), wExp = readRecords(weird).records;
        let wOk = false, wDetail = wr.message || '';
        if (wr.type === 'done') {
          const wNames = wr.dataset.columns.map((c) => c.name), wTyped = wExp.map((r) => { const o = Object.create(null); wNames.forEach((nm, i) => { const pe = wr.dataset.plan && wr.dataset.plan[i], dc = wr.dataset.columns[i].decimals; o[nm] = pe ? (dc ? typedDecimal(r[nm], dc) : typedCell(r[nm])) : r[nm]; }); return o; });
          const wv = await call({ type: 'verify', name: wr.dataset.name, expectJson: JSON.stringify(wTyped) });
          wOk = wv.json === true && wr.dataset.rows === 4; wDetail = wr.dataset.rows + ' rows, columns ' + wNames.join(' | ') + (wOk ? '' : ' / got ' + JSON.stringify(wv.firstRows));
          await call({ type: 'delete', name: wr.dataset.name });
        }
        add('awkward text and column names are stored and read back exactly', wOk, wDetail);
      }
      const bad = await runImport(new File(['a,b\r\n1,2\r\n3\r\n'], 'bad.csv', { type: 'text/csv' }));
      add('a bad row stops the import and names its line', bad.type === 'error' && /Line 3/.test(bad.message), bad.message);
      const idc = 'j' + (++seq), pc = new Promise((r) => waiters.set(idc, r)); worker.postMessage({ type: 'import', id: idc, file, delimiter: ',' }); worker.postMessage({ type: 'cancel', id: idc });
      const cr = await pc; add('cancel stops the import', cr.type === 'cancelled', cr.type);
      add('footer validated', d.validation.ok, d.validation.level);
      add('types: id integer, score number, when date', d.columns[0].type === 'integer' && d.columns[2].type === 'number' && d.columns[3].type === 'date', d.columns.map((c) => c.type).join(','));
      const v = await call({ type: 'verify', name: d.name, expectJson: expJson0 });
      add('every value read back identical to the source', v.json === true, v.message || (v.diff ? `first difference at row ${v.diff.row}: got ${JSON.stringify(v.diff.got)} want ${JSON.stringify(v.diff.want)}` : `${v.rows} rows read`));
      const o = await openGrid(d.name);
      add('grid opens with all rows', o && o.total === expected.length, o && String(o.total));
      add('browsing decodes only the pages shown (no full decode yet)', G.lastQuery && G.lastQuery.decodedAll === false, G.rows.length + ' rows shown');
      add('browsed first page equals source rows', JSON.stringify(G.rows[0]) === JSON.stringify(G.cols.map((c) => expected[0][c.name])) && G.rows.length === 60, G.rows.length + ' rows');
      $('gridscroll').scrollTop = 15000 * 28; await new Promise((r) => setTimeout(r, 400));
      add('scrolling to row 15000 shows the right rows', G.start > 0 && JSON.stringify(G.rows[10]) === JSON.stringify(G.cols.map((c) => expected[G.start + 10][c.name])), 'window starts at ' + G.start);
      G.filters = { id: '>=19990' }; G.sort = { col: 'id', dir: 'desc' }; buildHead(); let q = await applyQuery();
      add('numeric filter id>=19990 gives 10 rows', q.count === 10, String(q.count));
      {   // filters every row satisfies are skipped; the rows must be the same as testing every row
        const same = []; let okAll = true;
        for (const [f, srt] of [['>=0', null], ['<=19999', null], ['>-5', { col: 'id', dir: 'desc' }], ['>=1', null], ['<19999', null]]) {
          const A = await call({ type: 'query', filters: { id: f }, sort: srt, noInside: true }), B = await call({ type: 'query', filters: { id: f }, sort: srt });
          const pa = await call({ type: 'page', start: 0, count: 5 }); const rowsB = pa.rows.map((r) => r.join('|')).join(';');
          await call({ type: 'query', filters: { id: f }, sort: srt, noInside: true }); const pb = await call({ type: 'page', start: 0, count: 5 });
          const ok = A.count === B.count && rowsB === pb.rows.map((r) => r.join('|')).join(';'); okAll = okAll && ok; same.push(f + ':' + B.count + (B.allInside ? ' skipped' : ''));
        }
        add('a filter every row satisfies gives the same rows as testing every row', okAll, same.join(' '));
      }
      add('filtering reads only the columns it needs', q.decodedAll === false && !!q.columnsOnly && q.columnsOnly.join() === 'id', q.columnsOnly && q.columnsOnly.join());
      add('sorted high to low: first row id 19999', G.rows[0] && G.rows[0][0] === '19999', G.rows[0] && G.rows[0][0]);
      G.filters = { name: 'xxxxxxxxxxxxxxxxxxxxxx' }; G.sort = { col: 'score', dir: 'asc' }; buildHead(); q = await applyQuery();
      const want = expected.filter((r) => r.name.toLowerCase().includes('xxxxxxxxxxxxxxxxxxxxxx')).length;
      add('text filter matches the source count', q.count === want, `${q.count} vs ${want}`);
      add('empty scores sort last', !G.rows.length || G.rows[0][2] !== '', G.rows[0] && G.rows[0][2]);
      G.filters = { id: '>=19990' }; G.sort = { col: 'id', dir: 'desc' }; buildHead(); await applyQuery();
      const ex = await exportCsv(false), exRows = [];
      if (ex.blob) { const P = (window.__M || await import('../src/ingest/delimited.mjs')).DelimitedParser; new P(',', (r) => exRows.push(r)).feed(await ex.blob.text(), true); }
      const want10 = expected.filter((r) => +r.id >= 19990).sort((a, b) => b.id - a.id).map((r) => G.cols.map((c) => r[c.name]));
      add('export of the filtered, sorted view equals those rows', exRows.length === 11 && JSON.stringify(exRows[0]) === JSON.stringify(G.cols.map((c) => c.name)) && JSON.stringify(exRows.slice(1)) === JSON.stringify(want10), exRows.length - 1 + ' rows exported');
      const exb = await exportCsv(false, true), head3 = exb.blob ? new Uint8Array(await exb.blob.slice(0, 3).arrayBuffer()) : [];
      const exbRows = []; if (exb.blob) { const P = (window.__M || await import('../src/ingest/delimited.mjs')).DelimitedParser; new P(',', (r) => exbRows.push(r)).feed(new TextDecoder().decode(new Uint8Array(await exb.blob.arrayBuffer())), true); }
      add('Excel-friendly export starts with a byte-order mark and reads back the same', head3[0] === 0xEF && head3[1] === 0xBB && head3[2] === 0xBF && exb.bytes === ex.bytes + 3 && JSON.stringify(exbRows) === JSON.stringify(exRows), exb.bytes + ' vs ' + ex.bytes + ' bytes');
      G.forceStream = true; G.filters = { id: '>=19990' }; G.sort = { col: 'id', dir: 'desc' }; buildHead(); const qs = await applyQuery(); G.forceStream = false;
      add('block-by-block column read gives the same filtered, sorted rows', qs.count === 10 && JSON.stringify(G.rows[0]) === JSON.stringify(G.cols.map((c) => expected.find((r) => r.id === '19999')[c.name])), qs.count + ' rows');
      G.filters = { id: '>abc' }; buildHead(); q = await applyQuery();
      add('bad filter shows a message', !!q.errors.id, q.errors.id);
      $('gridbox').hidden = true;
      await call({ type: 'delete', name: d.name }); refresh();
    }
    const ok = checks.every((c) => c.ok);
    status(ok ? 'Self-test passed.' : 'Self-test FAILED.', !ok);
    last = Object.assign(last || {}, { selfTest: { ok, checks, ms: Math.round(performance.now() - t0) } });
    $('result').hidden = false;
    if (ok && !res.dataset) return;
    $('summary').textContent = (ok ? 'PASS' : 'FAIL') + ' · ' + checks.map((c) => (c.ok ? 'ok ' : 'FAIL ') + c.name + (c.detail ? ' (' + c.detail + ')' : '')).join(' · ');
    reportBack();
  }

  // Big-file check: generate about N MB of CSV, import it, open the data view, read the first, middle and last rows.
  async function bigTest(mb) {
    const t0 = performance.now(), checks = [], T = {}; const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });
    const { cells } = (window.__M || await import('./bigdata.mjs'));
    status('Generating about ' + mb + ' MB of CSV…'); let s = performance.now();
    const g = await call({ type: 'gen', mb }); T.generateMs = Math.round(performance.now() - s);
    add('file generated', g.type === 'generated', g.message || `${g.rows} rows, ${fmt(g.bytes)}, ${g.onDisk ? 'on disk (OPFS)' : 'in memory'}`);
    let res = null; const liveOn = /[?&]live=1/.test(location.search);
    if (liveOn) liveHook = async (lm) => {   // time to a usable grid: the worker says the columns are ready; filter, sort and page right away, before the save ends
      T.liveReadyMs = Math.round(performance.now() - s); if (/[?&]liveq=0/.test(location.search)) return; const o = await openGrid(lm.name); T.liveOpenMs = Math.round(performance.now() - s);
      const sm = (row, i) => JSON.stringify(row) === JSON.stringify(cells(i));
      add('live: first rows are right', sm(G.rows[0], 0) && sm(G.rows[7], 7));
      G.filters = { id: '>=' + (g.rows - 10) }; buildHead(); let e0 = performance.now(); const q1 = await applyQuery(); T.liveFilterMs = Math.round(performance.now() - e0); T.liveFilterAtMs = Math.round(performance.now() - s);
      add('live: filter finds the last 10 rows', q1.count === 10 && sm(G.rows[0], g.rows - 10) && sm(G.rows[9], g.rows - 1), JSON.stringify(q1).slice(0, 200));
      G.filters = {}; G.sort = { col: 'score', dir: 'asc' }; buildHead(); e0 = performance.now(); const q2 = await applyQuery(); T.liveSortScoreMs = Math.round(performance.now() - e0); T.liveSortAtMs = Math.round(performance.now() - s);
      T.liveScoreFirst = JSON.stringify(G.rows[0]);
      G.sort = { col: 'note', dir: 'asc' }; buildHead(); e0 = performance.now(); await applyQuery(); T.liveSortTextMs = Math.round(performance.now() - e0); T.liveTextFirst = JSON.stringify(G.rows[0]);
      G.filters = { note: 'note 7000' }; G.sort = null; buildHead(); e0 = performance.now(); const q3 = await applyQuery(); T.liveTextFilterMs = Math.round(performance.now() - e0); T.liveTextCount = q3.count; T.liveTextFirstRow = JSON.stringify(G.rows[0]);
      G.filters = {}; G.sort = null; buildHead(); await applyQuery();
    };
    if (g.type === 'generated') { s = performance.now(); res = await runImport(g.file, false, (() => { const o = {}; const b = /[?&]bb=(\d+)/.exec(location.search), l = /[?&]lv=(\d+)/.exec(location.search); if (/[?&]untyped=1/.test(location.search)) o.untyped = true; if (liveOn) o.live = true; { const mp = /[?&]mp=(\d+)/.exec(location.search); if (mp) o.morePack = +mp[1]; } if (/[?&]livexfer=1/.test(location.search)) o.liveXfer = true; if (b) o.blockBytes = +b[1]; const sg = /[?&]seg=(\d+)/.exec(location.search); if (sg) o.segBytes = +sg[1]; const cb = /[?&]cb=(\d+)/.exec(location.search); if (cb) o.colBlockBytes = +cb[1]; const pw = /[?&]pw=(\d+)/.exec(location.search); if (pw) o.packWorkers = +pw[1]; if (l) o.level = +l[1]; return Object.keys(o).length ? o : undefined; })()); T.importMs = Math.round(performance.now() - s); }
    add('import finished', res && res.type === 'done', res && res.message);
    if (res && res.type === 'done') {
      const d = res.dataset; add('row count equals generated', d.rows === g.rows, `${d.rows} vs ${g.rows}`); add('footer validated', d.validation.ok, d.validation.level); T.storedBytes = d.bytes; T.phases = d.timing; T.colTypes = d.columns.map((c) => c.name + ':' + c.type + (c.decimals ? '.' + c.decimals : '')).join(',');
      s = performance.now(); const o = await openGrid(d.name); T.openMs = Math.round(performance.now() - s); T.kinds = o && o.kinds;
      add('data view opens', o && o.total === g.rows, o && String(o.total));
      if (liveOn && !/[?&]liveq=0/.test(location.search)) {   // same answers from the saved file as from the kept columns
        await liveDone; add('live: grid was ready before the import finished', T.liveReadyMs > 0 && T.liveReadyMs < T.importMs, T.liveReadyMs + ' vs ' + T.importMs + ' ms');
        G.sort = { col: 'score', dir: 'asc' }; buildHead(); await applyQuery(); add('live: score sort first row equals the saved file', JSON.stringify(G.rows[0]) === T.liveScoreFirst, T.liveScoreFirst + ' | ' + JSON.stringify(G.rows[0]));
        G.sort = { col: 'note', dir: 'asc' }; buildHead(); await applyQuery(); add('live: text sort first row equals the saved file', JSON.stringify(G.rows[0]) === T.liveTextFirst, T.liveTextFirst + ' | ' + JSON.stringify(G.rows[0]));
        G.filters = { note: 'note 7000' }; G.sort = null; buildHead(); const qa = await applyQuery(); add('live: text filter count and first row equal the saved file', qa.count === T.liveTextCount && JSON.stringify(G.rows[0]) === T.liveTextFirstRow, qa.count + ' vs ' + T.liveTextCount);
        G.filters = {}; G.sort = null; buildHead(); await applyQuery();
      }
      const same = (row, i) => JSON.stringify(row) === JSON.stringify(cells(i));
      add('first rows are right', same(G.rows[0], 0) && same(G.rows[7], 7));
      { const t1 = performance.now(); for (const f of [0.11, 0.37, 0.52, 0.73, 0.94]) await call({ type: 'page', start: Math.floor(g.rows * f), count: 30 }); T.pageColdMs = Math.round((performance.now() - t1) / 5 * 10) / 10; }   // average time to fetch 30 rows from far apart places
      { G.filters = { id: '>=' + (g.rows - 10) }; buildHead(); const e0 = performance.now(); const qq = await applyQuery(); T.earlyFilterMs = Math.round(performance.now() - e0); add('first filter, right after opening, finds the last 10 rows', qq.count === 10, JSON.stringify(qq)); G.filters = { score: '>=99.9' }; buildHead(); const e1 = performance.now(); await applyQuery(); T.earlyScoreMs = Math.round(performance.now() - e1); G.filters = {}; buildHead(); await applyQuery(); }   // while the background warm-up is still running; the score column is a decimal that needs decoding
      const sc = $('gridscroll'), jump = async (frac) => { sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * frac); await new Promise((r) => setTimeout(r, 600)); };
      s = performance.now(); await jump(1); T.lastPageMs = Math.round(performance.now() - s - 600);
      const lastRow = G.rows[G.rows.length - 1]; add('scrolling to the end shows the last row', lastRow && same(lastRow, g.rows - 1), lastRow && lastRow[0] + ' vs ' + (g.rows - 1));
      await jump(0.5); const mid = G.rows[5]; add('middle of the file shows a consistent row', mid && same(mid, Number(mid[0])) && Number(mid[0]) > g.rows * 0.4 && Number(mid[0]) < g.rows * 0.6, mid && mid[0]);
      { // scroll test: top to bottom in 6 s, one position per frame, frame gaps recorded (same method as the Glide Data Grid check)
        sc.scrollTop = 0; await new Promise((r) => setTimeout(r, 800)); const total = sc.scrollHeight - sc.clientHeight, gaps = []; let last = performance.now(); const t0 = last;
        await new Promise((ok) => { const vis = Math.ceil(sc.clientHeight / ROW); let blank = 0, blankRows = 0; const step = (now) => { gaps.push(now - last); last = now; const top = topIndex(), have0 = G.start, have1 = G.start + G.rows.length, miss = Math.max(0, Math.min(top + vis, g.rows) - Math.max(top, have0)) ; const unc = Math.min(top + vis, g.rows) - top - miss; if (unc > 0) { blank++; blankRows += unc; } T.blankFrames = blank; T.blankRowsAvg = +(blankRows / Math.max(1, gaps.length)).toFixed(2); const pos = Math.min(total, (now - t0) / 6000 * total); sc.scrollTop = pos; if (pos >= total) ok(); else requestAnimationFrame(step); }; requestAnimationFrame(step); });
        gaps.shift(); const so = gaps.slice().sort((a, b) => a - b), n = gaps.length, avg = gaps.reduce((a, b) => a + b, 0) / n;
        T.scroll = { rows: g.rows, frames: n, avgMs: +avg.toFixed(2), p99: +so[Math.floor(n * .99)].toFixed(1), maxMs: +so[n - 1].toFixed(1), over33: gaps.filter((x) => x > 33.4).length };
        { const w0 = performance.now(); let endRow = null; do { await new Promise((r) => setTimeout(r, 100)); endRow = G.rows[G.rows.length - 1]; } while (!(endRow && same(endRow, g.rows - 1)) && performance.now() - w0 < 5000); T.scrollSettleMs = Math.round(performance.now() - w0); add('after the scroll the last row is shown', endRow && same(endRow, g.rows - 1), (endRow && endRow[0]) + ', settled in ' + T.scrollSettleMs + ' ms'); }   // the page loads on the next frame after the scroll stops: wait for it (up to 5 s) and record how long it took instead of a fixed 600 ms
      }
      G.filters = { id: '>=' + (g.rows - 10) }; buildHead(); s = performance.now(); const q = await applyQuery(); T.filterMs = Math.round(performance.now() - s);
      add('filter finds the last 10 rows', q.count === 10, String(q.count));
      G.filters = { name: '=Name 5' }; buildHead(); s = performance.now(); const qe = await applyQuery(); T.eqMs = Math.round(performance.now() - s); T.eqByPositions = !!qe.byPositions; T.posError = qe.posError;
      add('text equality filter finds every row of that name', qe.count === Math.floor((g.rows - 6) / 97) + 1, String(qe.count));
      G.filters = { id: '>=' + Math.floor(g.rows * 0.5) }; buildHead(); s = performance.now(); const qr = await applyQuery(); T.rangeMs = Math.round(performance.now() - s);
      add('range filter on half the rows', qr.count === g.rows - Math.floor(g.rows * 0.5), String(qr.count));
      G.filters = { id: '>=' + (g.rows - 10) }; buildHead(); await applyQuery();
      add('the filtered rows are the last 10', G.rows.length === 10 && same(G.rows[0], g.rows - 10) && same(G.rows[9], g.rows - 1), G.rows[0] && G.rows[0][0]);
      G.filters = {}; G.sort = { col: 'id', dir: 'desc' }; buildHead(); s = performance.now(); const q2 = await applyQuery(); T.sortMs = Math.round(performance.now() - s);
      add('sorting the whole file high to low puts the last row first', q2.count === g.rows && same(G.rows[0], g.rows - 1) && same(G.rows[5], g.rows - 6), G.rows[0] && G.rows[0][0]);
      G.sort = { col: 'score', dir: 'asc' }; buildHead(); await new Promise((r) => setTimeout(r, 4000)); s = performance.now(); const q3 = await applyQuery(); T.sortScoreMs = Math.round(performance.now() - s); T.scoreLoadMs = q3.loadMs; T.scoreParts = { workerMs: q3.ms, loadMs: q3.loadMs, selMs: q3.selMs };   // where the time goes: worker total, column load, selection
      G.sort = { col: 'note', dir: 'asc' }; buildHead(); await new Promise((r) => setTimeout(r, 6000)); s = performance.now(); const q4 = await applyQuery(); T.sortTextMs = Math.round(performance.now() - s); T.textLoadMs = q4.loadMs; T.textParts = { workerMs: q4.ms, loadMs: q4.loadMs, selMs: q4.selMs }; add('sorting by a text column (note) works', q4.count === g.rows && !!G.rows[0], G.rows[0] && G.rows[0][4]);
      T.fullMatch = {};   // a filter every row satisfies (id >= 0): first query on a freshly opened dataset (cold) and the same again (warm), with and without the full-match shortcut
      for (const ni of [true, false]) {
        await openGrid(d.name); G.sort = null; G.noInside = ni; G.filters = { id: '>=0' }; buildHead();
        s = performance.now(); const f1 = await applyQuery(); const cold = Math.round(performance.now() - s);
        s = performance.now(); const f2 = await applyQuery(); const warm = Math.round(performance.now() - s);
        T.fullMatch[ni ? 'perRow' : 'shortcut'] = [cold, warm]; add('a filter every row satisfies keeps all rows (' + (ni ? 'tested per row' : 'shortcut') + ')', f1.count === g.rows && f2.count === g.rows && !!G.rows[0] && same(G.rows[0], 0), f1.count + ' rows' + (f1.allInside ? ', no per-row test' : ''));
      }
      G.noInside = false; G.filters = {};
      G.sort = { col: 'score', dir: 'asc' }; buildHead(); await applyQuery();
      add('sorting by score keeps empty scores last', q3.count === g.rows && G.rows[0] && G.rows[0][2] !== '', G.rows[0] && G.rows[0][2]);
      $('gridbox').hidden = true; await call({ type: 'delete', name: d.name });
    }
    await call({ type: 'genclean' }); refresh();
    const ok = checks.every((c) => c.ok); status(ok ? 'Big-file check passed.' : 'Big-file check FAILED.', !ok);
    last = { selfTest: { ok, checks, ms: Math.round(performance.now() - t0) }, big: { mb, rows: g.rows, bytes: g.bytes, onDisk: g.onDisk, T } };
    reportBack();
  }

  function report() {
    const L = ['LFCP Workbench results', 'Workbench version: 2026.11.15.0011 (LFC-pack 0.10.42)', 'Browser: ' + navigator.userAgent, 'Secure context: ' + window.isSecureContext + ', OPFS: ' + !!(navigator.storage && navigator.storage.getDirectory) + (last && last.dataset ? ', stored in: ' + last.dataset.storage : ''), 'Time: ' + new Date().toISOString()];
    if (last && last.selfTest) { L.push('', 'Self-test: ' + (last.selfTest.ok ? 'PASS' : 'FAIL') + ' (' + last.selfTest.ms + ' ms)'); last.selfTest.checks.forEach((c) => L.push((c.ok ? '  ok   ' : '  FAIL ') + c.name + (c.detail ? ' - ' + c.detail : ''))); }
    if (last && last.big) L.push('Big file: ' + last.big.mb + ' MB target, ' + last.big.rows + ' rows, ' + last.big.bytes + ' bytes' + (last.big.onDisk ? ', generated on disk (OPFS)' : ', generated in memory') + ', phase ms ' + JSON.stringify(last.big.T));
    if (last && last.dataset) { const d = last.dataset; L.push('', `Import: ${d.source}, ${d.rows} rows, ${d.columns.length} columns, ${d.bytes} bytes stored, ${d.ms} ms`, 'Timing ms: ' + JSON.stringify(d.timing), 'Check: ' + d.validation.level, 'Columns: ' + d.columns.map((c) => c.name + ':' + c.type + (c.nullable ? '?' : '')).join(', ')); }
    if (window.__imp) L.push('', window.__imp + ' ms=' + window.__importMs); return L.join('\n');
  }
  function reportBack() { if (/[?&]report=1/.test(location.search)) { try { const pm = /[?&]port=(\d+)/.exec(location.search); fetch((pm ? 'http://127.0.0.1:' + pm[1] : '') + '/result', { method: 'POST', body: report(), mode: pm ? 'no-cors' : 'same-origin' }); } catch {} } }

  $('file').addEventListener('change', () => { const f = $('file').files[0]; $('go').disabled = !f; if (f) status(fmt(f.size) + ' selected. No upload happens.'); });
  $('go').addEventListener('click', () => { const f = $('file').files[0]; if (f) runImport(f, false, { live: true }); });
  $('cancel').addEventListener('click', () => { if (active) { worker.postMessage({ type: 'cancel', id: active }); status('Stopping…'); } });
  $('selftest').addEventListener('click', selfTest);
  $('copy').addEventListener('click', async () => {
    const text = report(); let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {}
    if (!ok) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch {} ta.remove(); }
    $('copied').textContent = ok ? 'Copied.' : 'Copy failed; select and copy this text: ' + text.slice(0, 200);
  });
  refresh();
  if (/[?&]selftest=1/.test(location.search)) selfTest();
  const bt = /[?&]bigtest=(\d+)/.exec(location.search); if (bt) bigTest(+bt[1]);
  const iu = /[?&]importurl=([^&]+)/.exec(location.search);
  if (iu) (async () => {   // test hook: import a CSV served next to the page and print the import report (used for real-data profiling)
    const t0 = performance.now(), r = await fetch(decodeURIComponent(iu[1])), b = await r.blob(), f = new File([b], 'real.csv', { type: 'text/csv' });
    const oj = /[?&]opts=([^&]+)/.exec(location.search), s = performance.now(), res = await runImport(f, false, Object.assign({}, /[?&]live=1/.test(location.search) ? { live: true } : null, oj ? JSON.parse(decodeURIComponent(oj[1])) : null));
    window.__importMs = Math.round(performance.now() - s); const qj = /[?&]q=([^&]+)/.exec(location.search); if (res.type === 'done' && qj) { try { await openGrid(res.dataset.name); const qs = []; for (let i = 0; i < 4; i++) { const t = performance.now(); const r = await call({ type: 'query', filters: JSON.parse(decodeURIComponent(qj[1])), sort: (/[?&]sort=([^&]+)/.exec(location.search) ? JSON.parse(decodeURIComponent(/[?&]sort=([^&]+)/.exec(location.search)[1])) : undefined) }); qs.push([r.count, r.ms, r.loadMs, r.selMs, Math.round(performance.now() - t)].join('/')); } window.__qs = qs.join(' '); if (/[?&]save=\d+/.test(location.search)) { await new Promise((r) => setTimeout(r, +/[?&]save=(\d+)/.exec(location.search)[1])); const t = performance.now(); const sr = await call({ type: 'exportLfcp' }); window.__qs += ' SAVE ' + Math.round(performance.now() - t) + 'ms ' + (sr.type || '') + ' ' + (sr.rows || sr.count || ''); } } catch (e) { window.__qs = 'ERR ' + e.message; } }
    window.__imp = 'importurl ' + (res.type === 'done' ? 'done ' + JSON.stringify(res.dataset.timing) + ' Q ' + (window.__qs || '') : 'FAILED ' + res.message); status('importurl ' + (res.type === 'done' ? 'done in ' + window.__importMs + ' ms (fetch ' + Math.round(s - t0) + ' ms)' : res.message)); reportBack();
  })();
})();
