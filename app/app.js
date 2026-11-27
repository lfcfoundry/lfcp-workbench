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
    if (m.type === 'preview') { if (!liveHook) previewOpen(m); return; }   // the first rows are in: the grid opens now, the row count grows until the file is read
    if (m.type === 'notice') { encNote = m.text || ''; if (m.widths) fwGuess = m.widths; return; }
    if (m.type === 'earlyChart') { if (m.off) ecHide(); else if (!ecFinal) ecDraw(m.key, m.bars, m.rows, false); return; }
    if (m.type === 'previewGrow') { if (G.preview) previewGrow(m); return; }
    if (m.type === 'live') ecLive();
    if (m.type === 'live' && G.preview && !liveHook) { liveSeen = performance.now(); liveDone = finishPreview(m); return; }
    if (m.type === 'live') { liveSeen = performance.now(); liveDone = (liveHook || ((x) => { status('Ready to use. Storing a copy in this browser…'); return openGrid(x.name); }))(m); return; }   // the worker has parsed the file and keeps the columns: the grid can open before the save ends
    if (m.type === 'liveclosed') { G.preview = false; $('gridbox').hidden = true; return; }
    const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); }
  };
  // Early chart: a grey DRAFT of the most common values in the first rows while the file is read, then the same chart in blue with the counts of every row.
  let ecFinal = false, ecKey = '';
  function ecHide() { $('earlychart').hidden = true; ecFinal = false; ecKey = ''; }
  function ecDraw(key, bars, rows, final) {
    ecKey = key; const sec = $('earlychart'); sec.hidden = false; sec.className = final ? 'final' : '';
    const mx = Math.max(1, ...bars.map((b) => b[1]));
    $('ecnote').innerHTML = (final ? '' : '<span class="ecbadge">DRAFT</span>') + 'Most common values in <b>' + esc(key) + '</b>, ' + (final ? 'all ' + rows.toLocaleString() + ' rows.' : 'first ' + rows.toLocaleString() + ' rows so far. It turns blue when the whole file is read.');
    $('ecbars').innerHTML = bars.map((b) => '<div class="ecrow"><span title="' + esc(b[0]) + '">' + esc(b[0] || '(empty)') + '</span><div><i></i></div><b>' + b[1].toLocaleString() + '</b></div>').join('');
    $('ecbars').querySelectorAll('i').forEach((el, j) => { el.style.width = (100 * bars[j][1] / mx).toFixed(1) + '%'; });   // set from script: the page's style rules forbid inline style attributes
  }
  async function ecLive() {
    if (!ecKey || ecFinal) return; const key = ecKey; ecFinal = true;
    try { const r = await call({ type: 'groupby', key, aggs: [{ fn: 'count' }], filters: {} }); if (r.type === 'grouped') ecDraw(key, r.rows.slice(0, 8).map((x) => [x[0], +x[1]]), r.rowsUsed, true); else ecHide(); } catch { ecHide(); }
  }
  let fwGuess = '', fwAuto = false, liveHook = null, liveDone = null, liveSeen = 0, encNote = '';
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
    ecHide();     $('go').disabled = true; $('selftest').disabled = true; $('cancel').hidden = false; $('prog').hidden = false; $('prog').value = 0;
    const id = 'j' + (++seq); active = id;
    const res = await new Promise((resolve) => { waiters.set(id, resolve); worker.postMessage(Object.assign({ type: 'import', id, file, delimiter: $('delim').value, widths: ($('fwbox') && !$('fwbox').hidden && $('fwidths').value) || '', inline: !!inline || /[?&]inline=1/.test(location.search) }, opts || {})); });
    active = null; $('cancel').hidden = true; $('prog').hidden = true; $('selftest').disabled = false; $('go').disabled = !$('file').files.length;
    if (res.type === 'done') { status('Import complete and checked.' + (encNote ? ' ' + encNote : '')); encNote = ''; if (fwGuess) { $('delim').value = 'fixed'; $('fwidths').value = fwGuess; fwAuto = true; syncFw(); } fwGuess = ''; show(res.dataset); refresh(); }
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
  function previewOpen(m) {
    Object.assign(G, { preview: true, cols: m.columns, filters: {}, sort: null, count: m.total, total: m.total, start: -1, rows: [], numbers: [] });
    fillTools(); $('gridbox').hidden = false; $('gridtitle').textContent = 'Data: ' + m.name; buildHead(); $('gridspace').style.height = spaceHeight() + 'px'; $('gridscroll').scrollTop = 0; gridInfo(); status('Reading the file: the rows below are the first ones; the count grows until the file is read.'); return loadWindow();
  }
  function previewGrow(m) {
    const was = scaled(); G.count = G.total = m.total; $('gridspace').style.height = spaceHeight() + 'px'; gridInfo();
    if (G.rows.length < WINDOW || scaled() !== was) { G.start = -1; loadWindow(); }
  }
  async function finishPreview(m) {   // the file is read: the same grid, now with all rows, sort and filter; the place in the list is kept
    G.preview = false; Object.assign(G, { cols: m.columns, count: m.total, total: m.total, start: -1 });
    fillTools(); buildHead(); $('gridspace').style.height = spaceHeight() + 'px'; gridInfo(); status('Ready to use. Storing a copy in this browser…'); await loadWindow();
  }
  function gridInfo() { $('gridinfo').textContent = G.count.toLocaleString() + ' of ' + G.total.toLocaleString() + ' rows' + (G.preview ? ' so far (still reading the file)' : '') + (G.sort ? ', sorted by ' + G.sort.col + (G.sort.dir === 'desc' ? ' (high to low)' : ' (low to high)') : ''); }
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
    if (G.preview) $('gridhead').querySelectorAll('button,input').forEach((e) => { e.disabled = true; });
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
    $('dsrc').innerHTML = opts(); $('dfn').innerHTML = FUNCS.map((f) => '<option>' + f + '</option>').join(''); $('gkey').innerHTML = opts(); $('gkey2').innerHTML = '<option value="">nothing</option>' + opts(); $('gcol').innerHTML = opts();
  };
  async function addColumn(src, fn, name) {
    const r = await call({ type: 'derive', source: src, fn, name });
    if (r.type === 'error') { status(r.message, true); return r; }
    G.cols = r.columns; fillTools(); buildHead(); await applyQuery(); status('Added column ' + name + ' (' + r.ms + ' ms).'); return r;
  }
  async function summarize(key, fn, col, eq, key2) {
    const aggs = [{ fn: 'count' }]; if (fn) aggs.push(fn === 'rate' ? { fn, col, equals: eq } : { fn, col });
    const r = await call({ type: 'groupby', key, key2: key2 || undefined, aggs, filters: G.filters });
    if (r.type === 'error') { status(r.message, true); return r; }
    $('gres').innerHTML = '<table><tr>' + r.headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr>' + r.rows.slice(0, 200).map((x) => '<tr>' + x.map((v) => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('') + '</table>';
    $('gmsg').textContent = r.groups.toLocaleString() + ' groups from ' + r.rowsUsed.toLocaleString() + ' rows in ' + r.ms + ' ms'; G.lastGroup = r; $('gsave').disabled = false; return r;
  }
  async function saveLfcp(download) {
    status('Saving LFCP…'); const r = await call({ type: 'exportLfcp' });
    if (r.type === 'error') { status(r.message, true); return r; }
    if (download) { const a = document.createElement('a'); a.href = URL.createObjectURL(r.blob); a.download = r.name.replace(/-[0-9a-f-]{36}(\.json\.lfc)$/, '$1'); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
    status('Saved ' + r.name + ': ' + r.rows.toLocaleString() + ' rows, ' + (r.bytes / 1048576).toFixed(2) + ' MB (also kept in this browser).'); return r;
  }
  $('dgo').addEventListener('click', () => addColumn($('dsrc').value, $('dfn').value, $('dname').value || $('dfn').value));
  $('ggo').addEventListener('click', () => summarize($('gkey').value, $('gfn').value, $('gcol').value, $('geq').value, $('gkey2').value));
  async function saveSummary(download) {
    status('Saving summary as LFCP…'); const r = await call({ type: 'exportSummary' });
    if (r.type === 'error') { status(r.message, true); return r; }
    if (download) { const a = document.createElement('a'); a.href = URL.createObjectURL(r.blob); a.download = r.name.replace(/-[0-9a-f-]{36}(\.json\.lfc)$/, '$1'); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
    status('Saved ' + r.name + ': ' + r.rows.toLocaleString() + ' groups, ' + (r.bytes / 1024).toFixed(1) + ' KB (also kept in this browser).'); return r;
  }
  $('gsave').addEventListener('click', () => saveSummary(true));
  $('exportlfcp').addEventListener('click', () => saveLfcp(true));
  window.__wb = { saveSummary, addColumn, summarize, saveLfcp, call, applyQuery, openGrid, G };
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
        {   // a text-like cell ("007") in a number column cannot live in a typed column: the import starts again with only that column as text (its cells read back as text), the other columns stay typed
          const mixedRows = ['id,name,score\r\n', ...plain]; mixedRows[4501] = '007,row 4500,0.25\r\n';
          const mx = await runImport(new File(mixedRows, 'mixed.csv', { type: 'text/csv' }), false, { segBytes: 2048 });
          let okm = false, whym = mx.message || '';
          if (mx.type === 'done') { const want = []; for (let i = 0; i < 6000; i++) want.push({ id: i === 4500 ? '007' : String(i), name: 'row ' + i, score: (i % 9) * 100 + 25 }); const v = await call({ type: 'verify', name: mx.dataset.name, expectJson: JSON.stringify(want) }); okm = v.json === true && mx.dataset.timing.columns === true; whym = mx.dataset.rows + ' rows, columns path ' + mx.dataset.timing.columns + ', rows ' + (v.json === true ? 'identical' : 'DIFFERENT'); await call({ type: 'delete', name: mx.dataset.name }); }
          add('a text-like cell in a number column turns only that column into text', okm, whym);
        }
        const badRows = ['id,name,score\r\n', ...plain]; badRows[4001] = '4000,only two\r\n';
        const bf = new File(badRows, 'plainbad.csv', { type: 'text/csv' }), b1 = await runImport(bf, true, { strict: true }), b2 = await runImport(bf, false, { segBytes: 2048, strict: true }), b3 = await runImport(bf, false, { segBytes: 2048 });   // strict: skip the tidy stage, to test the error path
        segDetail.push('bad ' + Math.round(performance.now() - q3) + 'ms'); add('a bad row in the middle names the same line with pieces', b1.type === 'error' && b2.type === 'error' && b1.message === b2.message && /Line 4002/.test(b2.message), b2.message);
        add('the same file without strict is tidied and imported', b3.type === 'done' && b3.dataset.rows === 6000, b3.type === 'done' ? b3.dataset.rows + ' rows' : b3.message);
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
      const short1 = await runImport(new File(['a,b\r\n1,2\r\n3\r\n'], 'short.csv', { type: 'text/csv' }));
      add('a file with one short row is tidied and imported', short1.type === 'done' && short1.dataset.rows === 2, short1.type === 'done' ? short1.dataset.rows + ' rows' : short1.message);
      {   // space-separated pageview lists: quotes are ordinary characters (balanced, stray, and a short row far down that sends the quick tidy to the thorough one)
        const pv = []; for (let i = 0; i < 3000; i++) pv.push('en ' + (i % 50 === 0 ? '"Foo_' + i + '"_Bar' : i % 70 === 0 ? '"Stray_' + i : 'Page_' + i) + ' ' + (i % 900) + ' ' + (i % 7));
        const pq = await runImport(new File([pv.join('\n') + '\n'], 'views.txt', { type: 'text/plain' }));
        add('space-separated rows with quote marks in the titles import every row', pq.type === 'done' && pq.dataset.rows === 3000 - 1, pq.type === 'done' ? pq.dataset.rows + ' rows' : pq.message);
        const pq2 = await runImport(new File([pv.join('\n') + '\nen Short 5\n'], 'views2.txt', { type: 'text/plain' }));
        add('the same list with a short row at the end is tidied the thorough way and imports', pq2.type === 'done' && pq2.dataset.rows === 3000, pq2.type === 'done' ? pq2.dataset.rows + ' rows' : pq2.message);
        {   // a big list is read as it is (a quote mark is an ordinary character, a short row is filled, a blank line is skipped), with no tidy pass: forced here with small pieces
          const sv = ['project title views bytes']; for (let i = 0; i < 4000; i++) sv.push('en ' + (i % 40 === 0 ? '"Foo_' + i : i % 55 === 0 ? 'Bar_' + i + '"' : 'Page_' + i) + ' ' + (i % 900) + ' ' + (i % 7));
          sv.splice(2000, 0, 'en Short', '');
          const sr = await runImport(new File([sv.join('\n') + '\n'], 'views3.txt', { type: 'text/plain' }), false, { segBytes: 65536 });
          let sok = sr.type === 'done' && sr.dataset.rows === 4001, sdet = sr.type === 'done' ? sr.dataset.rows + ' rows' : sr.message;
          if (sok) { await openGrid(sr.dataset.name); const pg = await call({ type: 'page', start: 0, count: 4001 }); const r0 = pg.rows[0], rs = pg.rows[1999], re = pg.rows[4000]; sok = r0[1] === '"Foo_0' && rs[1] === 'Short' && String(re[1]) === 'Page_3999' && pg.rows.some((r) => r[1] === 'Bar_55"'); if (!sok) sdet = JSON.stringify([r0, rs, re]); }
          add('a big space-separated list with plain quote marks, a short row and a blank line is read as it is', sok, sdet);
        }
      }
      {   // first letter and length of a text column straight from the stored bytes: the same answers as on strings (ASCII, accents, CJK, a 4-byte character, empty cells)
        const ws = ['Zo\u00eb', '\u65e5\u672c\u8a9e', '\ud83d\ude00 smile', 'abc', '', '\u00e9clair', 'x'], dl = ['id,title'];
        for (let i = 0; i < 400; i++) dl.push(i + ',' + ws[i % ws.length]);
        const dr = await runImport(new File([dl.join('\n') + '\n'], 'derive-bytes.csv', { type: 'text/csv' }), false, { blockBytes: 1500 });
        let ok = dr.type === 'done', det = dr.type === 'done' ? '' : dr.message;
        if (ok) {
          await openGrid(dr.dataset.name);
          const d1 = await call({ type: 'derive', source: 'title', fn: 'first', name: 'f1' }), d2 = await call({ type: 'derive', source: 'title', fn: 'length', name: 'n1' });
          const pg = await call({ type: 'page', start: 0, count: 400 });
          for (let i = 0; i < 400 && ok; i++) { const t = ws[i % ws.length], row = pg.rows[i]; if (String(row[2]) !== t.charAt(0) || String(row[3]) !== String(t.length)) { ok = false; det = 'row ' + i + ': ' + JSON.stringify(row) + ' for ' + JSON.stringify(t); } }
          if (d1.type === 'error' || d2.type === 'error') { ok = false; det = d1.message || d2.message; }
        }
        add('first letter and length come out the same from stored bytes as from strings', ok, det);
      }
      const fwLines = ['id   name        score', '1    Ann Lee     10.5', '2    Bob         7', '3    Cy Young    8.25', '4    Di          9', '5    Ed Norton   6'].join('\n') + '\n';
      const fwg = await runImport(new File([fwLines], 'fw.txt', { type: 'text/plain' }));
      add('fixed-width text is guessed, and the Column widths box then shows the widths', fwg.type === 'done' && fwg.dataset.rows === 5 && !$('fwbox').hidden && $('delim').value === 'fixed' && $('fwidths').value === '5,12', fwg.type === 'done' ? fwg.dataset.rows + ' rows, widths ' + $('fwidths').value : fwg.message);
      $('fwidths').value = '5,12'; const fwt = await runImport(new File([fwLines], 'fw2.txt', { type: 'text/plain' }));
      add('typed widths with Delimiter set to Fixed width', fwt.type === 'done' && fwt.dataset.rows === 5, fwt.type === 'done' ? fwt.dataset.rows + ' rows' : fwt.message);
      $('delim').value = 'auto'; $('fwidths').value = ''; fwAuto = false; syncFw(); add('the Column widths box is hidden again for other files', $('fwbox').hidden, '');
      const dbfBytes = (() => { const hl = 32 + 64 + 1, rl = 1 + 3 + 5, b = new Uint8Array(hl + rl * 3 + 1), dv = new DataView(b.buffer); b[0] = 3; b[1] = 126; b[2] = 11; b[3] = 19; dv.setUint32(4, 3, true); dv.setUint16(8, hl, true); dv.setUint16(10, rl, true); const fld = (i, n, t, l) => { const o = 32 + i * 32; for (let k = 0; k < n.length; k++) b[o + k] = n.charCodeAt(k); b[o + 11] = t.charCodeAt(0); b[o + 16] = l; }; fld(0, 'id', 'N', 3); fld(1, 'name', 'C', 5); b[96] = 13; const rec = (r, t) => { for (let k = 0; k < t.length; k++) b[hl + r * rl + k] = t.charCodeAt(k); }; rec(0, '   1Ann  '); rec(1, '*  2Bob  '); rec(2, '   3Cy   '); b[hl + 3 * rl] = 26; return b; })();
      const dbr = await runImport(new File([dbfBytes], 'tiny.dbf', { type: 'application/octet-stream' }));
      add('a dBase file is read, deleted rows skipped', dbr.type === 'done' && dbr.dataset.rows === 2 && dbr.dataset.columns.map((c) => c.name).join() === 'id,name', dbr.type === 'done' ? dbr.dataset.rows + ' rows' : dbr.message);
      const dtaBytes = (() => { const o = []; const u8 = (...a) => o.push(...a), i16 = (n) => u8(n & 255, (n >> 8) & 255), i32 = (n) => u8(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255), pad = (t, w) => { for (let k = 0; k < w; k++) u8(k < t.length ? t.charCodeAt(k) : 0); };
        u8(114, 2, 1, 0); i16(2); i32(2); pad('', 81); pad('', 18); u8(251, 5); pad('id', 33); pad('name', 33); for (let k = 0; k < 6; k++) u8(0); pad('%8.0g', 49); pad('%5s', 49); pad('', 33); pad('', 33); pad('', 81); pad('', 81); u8(0, 0, 0, 0, 0);
        u8(7); pad('Ann', 5); u8(101); pad('Bob', 5); return new Uint8Array(o); })();
      const dtr = await runImport(new File([dtaBytes], 'tiny.dta', { type: 'application/octet-stream' }));
      add('a Stata file is read, missing values left empty', dtr.type === 'done' && dtr.dataset.rows === 2 && dtr.dataset.columns.map((c) => c.name).join() === 'id,name', dtr.type === 'done' ? dtr.dataset.rows + ' rows' : dtr.message);
      const xlsBytes = await new Response(new Blob([Uint8Array.from(atob('H4sICIbB/2oCA3RpbnkueGxzAO1YXWxURRQ+M7vd3i2lvS1UsMC6otDSH9JqojWK3bagkmhKAJWYJrJtt2Vlf5pSI8S/ReRNEg0PvpCYJuVJgxISedDE9s0HjT7Ig0aTwoPR4MNqNIbE9vqdc+duL5tt0m0NUenZnPk5c2bmzMz5u/v1V3Wzkxcbr1IRPEwBmnfCFPLRFNDyOjaRNrR5x3E8srMK/ymYMzW/YRDvVwHkN6807xo29Sr8P2E/ZfGboCjtoQzqcTpB5cAd0Bj/ekuZM79EvqXC6v7L35/9N/vxALDY/tnXs/1XAdcAq4FrgTXAWjcEUB2wHrgOuB7YIDpBtAG4EXgnsBG4CbjZ7B0xNePdaG81/XtRb1v1N7cUwhZeMVRBn6z9gp9c3v4qNOKj4IzoxTXgAI2xbvTFU0PRWwW9IkNcsQzTUNJdaCk6B2oNfSjUT6XcJdoHiFG0y2j0IR0T2c9IuVXKGuL5l2XOd0LppAh9L1r+thiBokrVR3FKUZIG4QeT4Gikz9m+XhcOtg7VIyPMtZLRSLCaptjGHk9kEuPxVCRYR+fZvk4ABtrT6YH24eFZMagp+sOJ+ox3Osp0XlPovy+Nrsuk021Hn8LdlbrnVpc/X0zfsQi9bRF6yyL0cEk6QR1EnuAC/axGJ0cO13YuIHVdLiR1fS4o9bpcpdTrcxXOYVH203Dfl2UVTQc638KCCr8ZZQGJDp5RdJ2eY3ee3y/7hPLstnlfL7334/20Js8G9xnMxqKTCuHBmlYxlDGK/Gq7AcKCIlsIANafiBF/UZMElQo30CSHsXImnk6geulIIoO405Phsjc76EBUi9JBN9IMWQ3AhQdpMLXmcOS6Lfsmt1WN9YdxEjb0OpHexnLtfZuvX3ugsft5oecWPmBoG98ntamTGJkJtsiMVinfEF4vnJ0S2ptSbsf80RGGH7ubfO3mwro/de/wtSfhfsKQiuTWNXZrUxurQ6dmDs92e7WipzFi0atybFIXrFpz0hqpAoXS0rZpt7lORdUKTZWg6SLanIRxN3CT6Sn0VKGn5e6IXsMNK+EMmTElnIHCmMa9bP9GS08LZ5Xh1MIZNJxaOFvA+Qvt49XzT7ivkreMPjErVs53yCrBfLPQw3m7RNqiqUrm8RzWpkd1PX0ccn0/0SNyy0RbjKTeBoBRKOOo5V9IealS1UpzL4VsJVDl5mC2pV1TdYce45znqeTQePZYdmQiuuf4UCIVfejB9oPxwUQqlZDb7U2OjHStbH/SK5k/75A8aIl1afb0e7/d6D9iv/+ORa1Nl77lR3rFGBuPd5n8MGYu8kmTJx4yueKwyRfHTI758xxRxLQ7zDwPitu5jpc3TB7/Qfnb5cjPFH3lyyvndm6yz74L+dtuXNjNbqiINmDyVM/B2T5Z9xWMjyQ0eGfWRkYvd+Yz94yNPZMYP5bMZm4+K6td5307OwD0b4R/8vtP7q/IBkrN4TvNhd32s9h9nI4i42I5jpYtf704GTdOOmV8VwUqPT3vw75p6Gg/ZHhhWfsHfN9gS5mzBbi3YGf9yAcTy34/drLlfv/dZb7VJCulA/Qizp9GXspvvxdaMCJvwpQJ5KtZUBaHZrN/RRn3z7b0QWH/3dhhSGRIiAaWJ0/XMs5/j2//2/3/h78BOgEPaAAWAAA='), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const xlr = await runImport(new File([xlsBytes], 'tiny.xls', { type: 'application/vnd.ms-excel' }));
      add('an old Excel (.xls) file is read, with its date column as dates', xlr.type === 'done' && xlr.dataset.rows === 2 && xlr.dataset.columns.map((c) => c.type).join() === 'integer,string,date', xlr.type === 'done' ? xlr.dataset.rows + ' rows, ' + xlr.dataset.columns.map((c) => c.type).join() : xlr.message);
      const xlbBytes = await new Response(new Blob([Uint8Array.from(atob('H4sIAGnL/2oC/wvwZmYRYWBg4GBgUS6JjZpWOUeSkYGBnZmBQRgoGu2cn1eSmlcSH1JZkFocq1eRm7N30kG/wwY8bfGqp0RNb1ootFx7y/CYw6OH/UNQ/tppaoE5br+/7ZB14ti4MLasS+j3b3v1UzkXt8a9NQwWdl65PG2RKJv4arUc77/bqnTytiq1BTT2M3rfVX55tGbbK+FJQmYBK7OflaTr7pSKVhAWZluZk5TXmDp7u1nj7YNib7+mFCXH8vQ0cssZfan51iBd8X3NtLky8s9OvPBc/dv58QMt0yVPpNl1SnfzX9X3/phq4NRnG2LeuW6J4217XuenOx5YbM87ZN+8NSTh+QXpVYI3ORh2muvukJnOeE1uKauK66f5Tx8WBy+sajzjf8Fr1ts9fzsqt/cVpuupSiduemxke/wX73yBAF7J1eHnPi19sUf7L4M/547vFXGfPHgmlv058dk/ACUk83gtctcDeerA0OQG0vFFqTnF+nogsve8Ld8hAx7WB6td7mVyMTut0OR2etX1gCHz1bbAYGuvQ/75/m4OPD3T5u9XD29//uaIrPMWH65rrpxMJwvSMwMK9s4JsxYwzHy1JdmJldvN4spVybl+P1X6rrlP5O3iOjblT9ypDLc5pTo3lJ/6nk+8ptmfOCFutie/hnnqzqkP7zb4B5vMbbpQki0w/ehje7Pve00rUopnT7zU37XeZVqphIFmhdXPBwZbzwRfjGKKDP/0+OAvVlR/FW8tvqsH5NkBMT8QV+Tol+cXZSfl52frJWXmZaelzDh54nADyy9JyWcGWg0RPQ5nmI648szj0eRpSyjjdFZzlnNWPczi1ibmxsaAavRhD7M314A8EyYGBimI0ZBQQ7YAHIJrJ57NAqbBhvijL/ZZvEzoCdw+3ehF6Ws5h81Tb5hs7F3698nbdK7bUhrJ7fNaVL68dI7Kt18euDf44YRFjesyHQO3nGy1kKiwtLl3pznp4IsCn4k8Z45suLtmfobLSuU3zmmhkhN5Kyb+WWAa7S9cNNno6K2XwTMDsqLY5l6UK1TYm3XbOvac5IaUVXuNA76tYy6dYfy3fe4vu4hbqr/NAqdwa39x13L/5hK0MIJNiNle9dryC6brFZv26WzetYynWufJvKVXvD+vv7Doz/Qzb0NTU+Re3nk0pX799e78/H1ooXGfv8jJFMhzAWIRSGgUZyQWpaYElxRl5qUXgwJj9vkTBw8dOMBw6NAcHh8HrcmKrY4zxHUmHZ9wYsLpCVyPpxmnMFhW8hy6w3PGYZ3yhJnHNzRMZESzxibry6Y4IG8FEPNCrSmpzEmFmH/syIc5ra2tjY2O7umczQYT1rU4xbbFKFxJ9WB0Ym3jUdjC1B1hKMK8sO9KEJuezKrSH9MMG3xaXl54GM33TNrgBeNGxsPcYm3TdXR8HARrGdlMGIQiu5Q+dbUmWgkzozmExVhzF8ghT4BYApGwijNSU0uK9cGUITiFpaTMOKRxgIHFh0eAYZG6kZEBh9NPHqueADZrfmahhOeNncZNlSd+SbIkFhWc9Sk4m6Mxa2bjjNAGziweDg2dmmcHFE603GbQm6DodILNwvCJscpCyccMJmlCys7CyiA3MTKJMOMuEGGggZEBe/GIbgB6OYAwwIsRpVRA14ie0RAalZgwsh26ZvSshNBcy4QvY6Gbg54IEeZ0M2NPkugmoKcvhAmfmNFSG7pW9BSB0FrNgjt9BHizsoFUsQPhIWAQ87OCeACfSCEi5wYAAA=='), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const xlbr = await runImport(new File([xlbBytes], 'tiny.xlsb', { type: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12' }));
      add('an Excel binary (.xlsb) file is read, with its date column as dates', xlbr.type === 'done' && xlbr.dataset.rows === 2 && xlbr.dataset.columns.map((c) => c.type).join() === 'integer,string,date', xlbr.type === 'done' ? xlbr.dataset.rows + ' rows, ' + xlbr.dataset.columns.map((c) => c.type).join() : xlbr.message);
      const xlmBytes = await new Response(new Blob([Uint8Array.from(atob('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'), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const xlmr = await runImport(new File([xlmBytes], 'tiny.xlsm', { type: 'application/vnd.ms-excel.sheet.macroEnabled.12' }));
      add('an Excel macro-enabled (.xlsm) file is read, with its date column as dates', xlmr.type === 'done' && xlmr.dataset.rows === 2 && xlmr.dataset.columns.map((c) => c.type).join() === 'integer,string,date', xlmr.type === 'done' ? xlmr.dataset.rows + ' rows, ' + xlmr.dataset.columns.map((c) => c.type).join() : xlmr.message);
      const pqbBytes = await new Response(new Blob([Uint8Array.from(atob('H4sIAMjN/2oC/wtwDDIUZRFtkBS9xewjOoFZlEGIgUHano0hhSHP+5vBTF4TJ0/FSw4NDuxsjKzM7Q0tTW2Nrc3uDi5Obo6uzscPHDl07ODRw+oKKkpqiqrKyxcsWbRs4dLF6QkpSWmJqcnH5zG7+83ZWfD02Fx2/7g9Pz88PR7f4ODY1MohqhbT4hG46GiHqHpck4vnpKUeU9Vi23wiNz09MVU9vtHJtWuqRuiymFav0FVXV4Quj2t28521NePqsth2v9hdX19cXX6/wdG5rVfCNO1Oi2fwsrMzTNPvNbl6T1sbsTXtbptv9La3N7am3290du+ba1H67E6rd/i6uztKn99rdveft7fi67O77f7x+/7++PpcXpRBdBGzaB+zDsj3AqJsomwyEhwnGCBAgoMRyhJj0MAiKigIJKQvMDCkOOSx2aqf5czbdFmgvYV7w0EGBgV2NiULBgUOnsZDD1htJiQKdzolb7CwafRQCl5hYtV8Mql4h80+Bw0h7yVGO51WBmVvsdp7MMMoeo3Z7sMvi6r32NUrSHC5L9pYoTTTK31T5U/WVtejqktTn4pODb1qurX0K2+v71ndtblvZefG3rXdW/uXudn5sPLi5MfCO0+ufDnz5s6frUeXPp16devX3rNr3869u/dv8+HFjydf3vy5+/Tq17Nv7/7dfnz58+nXt3/vP7/+/fz7++uByWCHseg+pGRwm4dBZmVg/Jl3OjvrlXUf3P75TsrMd9VR5oZkmQ12x6yVRAsLFGSDJTXYJJYFcB9d9LPp/7+4z7/27P/PoMCirLFN7+6zQOWOSWtW3HoZKMDiCEIugSKuIDRJxROEUiKnpYIQVDQkFAJWX83aGrU2bPXVlyVWc/2WX366qXieOp9jkMnhouPRfO2HHxZYyPC1K3A0gZAH1KxFGl0glDFrWSYIJUq0gVAExIJpp58W7YzRm3766ccKG7n+449fSvFjiXgzBg2eovxyBUtLheTEtMMrJbhBPEMIZ5jFNTDLr0HN8i6HN57h58h3+CE5oTDUyCvsJIelorY6ZyAb+6U3C6a5iSrp3kn+2qV+/l7tb/6QxX7Narq3Sl5cWuu+3u4vG4+UUc6RFYaP1Xz8AmYsMvBNbDuk02rJ9VlETEMnKGLRBp/E1kNaraZcr0XMNHKUCm84PdrQeySRvfOwnlC7rQrfbw8ZvgkWMkqFFk6PCnqOPGTpPKwp1G6swvfcQ2aVh4xGgNLMqQWKYFITTKqCSV0wqQwmtcGkOpjUB5HHmRmx5m1IzvV0gLEu2IPyNqbo8IpvSR9TBgm24uSM1NxEUTYGURZVJgmmzBQGUR4ggyUvMTdVlcFHBuhjUS6gAGtxcn5RKoPYBGZJGUkbNQYZoAGmDGwCkiA9ohxAcbETsmJ9HGotLGocpJWXkjrAxMcgysQAJASAlI0mm6QawwRmoCzIHh6oPWAnQWx6Zi52g13tG7faNA6CORTDdLEfapIoFnBBLYB4Ee6XB+xqe4TV3vGTlkDweEbsWxHQaDUOsWPiDJIyEjyOQUH+4VaQCJDYwaQPAtqOIBDoCAHejo7ljk7pjm6OjumOzulgMScnR0dfEMPZ0dETLICgHSFSTiYglj/cKOdskNFgJRVgwWSEejBwAwsa+ZUl54aC7AOaFwmiISDdJRSm3ykIq35XEJGU61YSFQjjB0LkncCGQ8wrh7jbFeE/J8cMrOY5g4jEcJCydEcXsP5kiCDCuVBga8sgoVCQWFRYmlqim1xQoJtYBIr/stSi4sz8PAUjMz0DPUNJG2A6hiCGn0wMDAHANg4AcDm4VOgIAAA='), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const pqbr = await runImport(new File([pqbBytes], 'tiny-brotli.parquet', { type: 'application/octet-stream' }));
      add('a Parquet file with BROTLI pages is read', pqbr.type === 'done' && pqbr.dataset.rows === 200 && pqbr.dataset.columns.map((c) => c.name).join() === 'id,name,score', pqbr.type === 'done' ? pqbr.dataset.rows + ' rows' : pqbr.message);
      const arwBytes = await new Response(new Blob([Uint8Array.from(atob('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'), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const arwr = await runImport(new File([arwBytes], 'tiny-nc.arrow', { type: 'application/octet-stream' }));
      add('an Arrow file with LZ4 buffers, nulls, a dictionary column and timestamps is read column by column', arwr.type === 'done' && arwr.dataset.rows === 300 && arwr.dataset.columns.map((c) => c.type).join() === 'integer,integer,number,boolean,string,string,date,date', arwr.type === 'done' ? arwr.dataset.rows + ' rows, ' + arwr.dataset.columns.map((c) => c.type).join() : arwr.message);
      const zsBytes = Uint8Array.from(atob('//////gDAAAQAAAAAAAKAAwABgAFAAgACgAAAAABBAAEAAAATP///wQAAAATAAAAmAMAAFQDAAAkAwAA+AIAAMgCAACUAgAAaAIAADwCAAAUAgAA7AEAAMABAACQAQAASAEAABgBAADsAAAAwAAAAIgAAAA8AAAABAAAAMT8//8AAAEBEAAAABQAAAAEAAAAAAAAAAMAAABudWwA9P3//xAAGAAIAAYABwAMABAAFAAQAAAAAAABBRQAAAA4AAAAIAAAAAQAAAAAAAAABAAAAGRpY3QAAAAACAAIAAAABAAIAAAABAAAAAD9//8AAAABIAAAAEz+//9A/f//AAABBxAAAAAcAAAABAAAAAAAAAADAAAAZGVjAAgADAAEAAgACAAAAAwAAAACAAAAdP3//wAAAQkQAAAAFAAAAAQAAAAAAAAAAwAAAHQzMgBS/v//AAAAAJz9//8AAAEKEAAAABgAAAAEAAAAAAAAAAQAAAB0c19zAAAAAND+///E/f//AAABChAAAAAYAAAABAAAAAAAAAAFAAAAdHNfbnMAAACm/v//AAADAPD9//8AAAEKEAAAACQAAAAEAAAAAAAAAAgAAAB0c19tc190egAAAAAIAAwABgAIAAgAAAAAAAEABAAAAAMAAABVVEMANP7//wAAAQoQAAAAGAAAAAQAAAAAAAAABQAAAHRzX3VzAAAAFv///wAAAgBg/v//AAABCBAAAAAUAAAABAAAAAAAAAADAAAAZDMyAD7///8AAAAAiP7//wAAARQQAAAAFAAAAAQAAAAAAAAAAgAAAGxzAAC4////rP7//wAAAQUQAAAAFAAAAAQAAAAAAAAAAQAAAHMAAADc////0P7//wAAAQYQAAAAGAAAAAQAAAAAAAAAAQAAAGIAAAAEAAQABAAAAPj+//8AAAEDEAAAABQAAAAEAAAAAAAAAAMAAABmNjQA1v///wAAAgAg////AAABAxAAAAAcAAAABAAAAAAAAAADAAAAZjMyAAAABgAIAAYABgAAAAAAAQBQ////AAABAhAAAAAUAAAABAAAAAAAAAADAAAAaTY0AED///8AAAABQAAAAHz///8AAAECEAAAABQAAAAEAAAAAAAAAAMAAAB1NjQAqv///0AAAACk////AAABAhAAAAAUAAAABAAAAAAAAAADAAAAaTMyAJT///8AAAABIAAAAND///8AAAECEAAAABwAAAAEAAAAAAAAAAMAAAB1MTYAAAAGAAgABAAGAAAAEAAAABAAFAAIAAYABwAMAAAAEAAQAAAAAAABAhAAAAAcAAAABAAAAAAAAAACAAAAaTgAAAgADAAIAAcACAAAAAAAAAEIAAAAAAAAAP/////AAAAAFAAAAAAAAAAMABgABgAFAAgADAAMAAAAAAIEABgAAAA4AAAAAAAAAAAAAAAIAAgAAAAEAAgAAAAQAAAADAAeABAABAAIAAwADAAAAGAAAAAkAAAAGAAAAAIAAAAAAAAAAAAAAAAABgAIAAcABgAAAAAAAAEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAAAAAAAAAgAAAAAAAAABMAAAAAAAAAAAAAAAEAAAACAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAotS/9IAxhAAAAAAAAAQAAAAIAAAAAAAACAAAAAAAAACi1L/0gAhEAAHh5AAAAAAD/////AAQAABQAAAAAAAAADAAYAAYABQAIAAwADAAAAAADBAAcAAAAqAQAAAAAAAAAAAAADAAeABAABAAIAAwADAAAAJACAAAkAAAAGAAAAAQAAAAAAAAAAAAAAAAABgAIAAcABgAAAAAAAAEmAAAAAAAAAAAAAAASAAAAAAAAABgAAAAAAAAAFQAAAAAAAAAwAAAAAAAAABIAAAAAAAAASAAAAAAAAAAZAAAAAAAAAGgAAAAAAAAAEgAAAAAAAACAAAAAAAAAACEAAAAAAAAAqAAAAAAAAAASAAAAAAAAAMAAAAAAAAAAJQAAAAAAAADoAAAAAAAAABIAAAAAAAAAAAEAAAAAAAAeAAAAAAAAACABAAAAAAAAEgAAAAAAAAA4AQAAAAAAACEAAAAAAAAAYAEAAAAAAAASAAAAAAAAAHgBAAAAAAAAKQAAAAAAAACoAQAAAAAAABIAAAAAAAAAwAEAAAAAAAASAAAAAAAAANgBAAAAAAAAEgAAAAAAAADwAQAAAAAAACUAAAAAAAAAGAIAAAAAAAAtAAAAAAAAAEgCAAAAAAAAAAAAAAAAAABIAgAAAAAAACgAAAAAAAAAcAIAAAAAAAAeAAAAAAAAAJACAAAAAAAAEgAAAAAAAACoAgAAAAAAACEAAAAAAAAA0AIAAAAAAAASAAAAAAAAAOgCAAAAAAAAMQAAAAAAAAAgAwAAAAAAABIAAAAAAAAAOAMAAAAAAAAtAAAAAAAAAGgDAAAAAAAAEgAAAAAAAACAAwAAAAAAACgAAAAAAAAAqAMAAAAAAAASAAAAAAAAAMADAAAAAAAAJgAAAAAAAADoAwAAAAAAABIAAAAAAAAAAAQAAAAAAAAhAAAAAAAAACgEAAAAAAAAEgAAAAAAAABABAAAAAAAACcAAAAAAAAAaAQAAAAAAAASAAAAAAAAAIAEAAAAAAAAIQAAAAAAAAAAAAAAEwAAAAQAAAAAAAAAAQAAAAAAAAAEAAAAAAAAAAEAAAAAAAAABAAAAAAAAAABAAAAAAAAAAQAAAAAAAAAAQAAAAAAAAAEAAAAAAAAAAEAAAAAAAAABAAAAAAAAAABAAAAAAAAAAQAAAAAAAAAAQAAAAAAAAAEAAAAAAAAAAEAAAAAAAAABAAAAAAAAAABAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAEAAAAAAAAABAAAAAAAAAABAAAAAAAAAAQAAAAAAAAAAQAAAAAAAAAEAAAAAAAAAAEAAAAAAAAABAAAAAAAAAABAAAAAAAAAAQAAAAAAAAAAQAAAAAAAAAEAAAAAAAAAAEAAAAAAAAABAAAAAAAAAABAAAAAAAAAAQAAAAAAAAABAAAAAAAAAABAAAAAAAAACi1L/0gAQkAAAsAAAAAAAAEAAAAAAAAACi1L/0gBCEAAAGAAH8AAAABAAAAAAAAACi1L/0gAQkAAAsAAAAAAAAIAAAAAAAAACi1L/0gCEEAAAAA//8AAAcAAAAAAAAAAAEAAAAAAAAAKLUv/SABCQAABwAAAAAAABAAAAAAAAAAKLUv/SAQgQAAAAAAgAAAAAD///9/AAAAAAAAAAAAAAABAAAAAAAAACi1L/0gAQkAAAsAAAAAAAAgAAAAAAAAACi1L/0gIKUAAGAAAP8ABQAAAAAAAAADEABZ8h2wAAAAAQAAAAAAAAAotS/9IAEJAAALAAAAAAAAIAAAAAAAAAAotS/9ICBtAAAwAACA/38AA1ACAH2uAAABAAAAAAAAACi1L/0gAQkAAAsAAAAAAAAQAAAAAAAAACi1L/0gEIEAAM3MzD0AAMA/AAAAAAAAUMAAAAAAAAAAAQAAAAAAAAAotS/9IAEJAAALAAAAAAAAIAAAAAAAAAAotS/9ICDFAACQNDMzMzMz0z9Q7+LW5BpLRACAAQBlsAQAAAAAAAAAAQAAAAAAAAAotS/9IAEJAAALAAAAAAAAAQAAAAAAAAAotS/9IAEJAAAJAAAAAAAAAQAAAAAAAAAotS/9IAEJAAAHAAAAAAAAFAAAAAAAAAAotS/9IBShAAAAAAAABQAAABAAAAAcAAAAHAAAAAAAABwAAAAAAAAAKLUv/SAc4QAAcGxhaW53aXRoLCBjb21tYW5ldwpsaW5lICJxIgAAACgAAAAAAAAAKLUv/SAovQAAgAAAAQACAAMADQAAAAAAAAAEVAIAAwENAAAAAAAAACi1L/0gDWkAAGFiY2NhZsOpIPCfmIAAAAEAAAAAAAAAKLUv/SABCQAACwAAAAAAABAAAAAAAAAAKLUv/SAQgQAARk0AAP////8AAAAAerkAAAAAAAAAAAABAAAAAAAAACi1L/0gAQkAAAsAAAAAAAAgAAAAAAAAACi1L/0gIAEBAIApB43hDQYAAADdv8Tq/v8AAAAAAAAAAMC9SyDF1gYAAAAAAAAAAAEAAAAAAAAAKLUv/SABCQAADQAAAAAAACAAAAAAAAAAKLUv/SAg5QAAsINJAcWMAQCsz2rcAAAAAKzPatwAAAABABswAgAAAAEAAAAAAAAAKLUv/SABCQAACwAAAAAAACAAAAAAAAAAKLUv/SAgvQAAiBXNhT3+nJcXAP//////////AQAdOAIBAAAAAAAAACi1L/0gAQkAAAsAAAAAAAAgAAAAAAAAACi1L/0gIK0AAGgAAIBRAQDxU2UAAAAAAgDgkAFgAQAAAQAAAAAAAAAotS/9IAEJAAANAAAAAAAAEAAAAAAAAAAotS/9IBCBAACLDgAAAAAAAH9RAQAAAAAAAAAAAAAAAAEAAAAAAAAAKLUv/SABCQAACwAAAAAAAEAAAAAAAAAAKLUv/SBAtQAAYNIEAPv/AP/jC1QCAAQQAFt1V8bHEAABAAAAAAAAACi1L/0gAQkAAAcAAAAAAAAQAAAAAAAAACi1L/0gEIEAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAA/////wAAAAA='), (c) => c.charCodeAt(0));
      const zsr = await runImport(new File([zsBytes], 'zstd.arrows', { type: 'application/octet-stream' }));
      add('an Arrow file compressed with ZSTD is read', zsr.type === 'done' && zsr.dataset.rows === 4, zsr.type === 'done' ? zsr.dataset.rows + ' rows, ' + zsr.dataset.columns.length + ' columns' : zsr.message);
      const badRows = ['a,b']; for (let i = 0; i < 24; i++) badRows.push(i % 2 ? '3' : '1,2');
      const bad = await runImport(new File([badRows.join('\r\n') + '\r\n'], 'bad.csv', { type: 'text/csv' }));
      add('a file that is mostly bad rows stops the import and names its line', bad.type === 'error' && /Line 3/.test(bad.message), bad.message);
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
    const L = ['LFCP Workbench results', 'Workbench version: 2026.11.26.2317 (LFC-pack 0.14.10)', 'Browser: ' + navigator.userAgent, 'Secure context: ' + window.isSecureContext + ', OPFS: ' + !!(navigator.storage && navigator.storage.getDirectory) + (last && last.dataset ? ', stored in: ' + last.dataset.storage : ''), 'Time: ' + new Date().toISOString()];
    if (last && last.selfTest) { L.push('', 'Self-test: ' + (last.selfTest.ok ? 'PASS' : 'FAIL') + ' (' + last.selfTest.ms + ' ms)'); last.selfTest.checks.forEach((c) => L.push((c.ok ? '  ok   ' : '  FAIL ') + c.name + (c.detail ? ' - ' + c.detail : ''))); }
    if (last && last.big) L.push('Big file: ' + last.big.mb + ' MB target, ' + last.big.rows + ' rows, ' + last.big.bytes + ' bytes' + (last.big.onDisk ? ', generated on disk (OPFS)' : ', generated in memory') + ', phase ms ' + JSON.stringify(last.big.T));
    if (last && last.dataset) { const d = last.dataset; L.push('', `Import: ${d.source}, ${d.rows} rows, ${d.columns.length} columns, ${d.bytes} bytes stored, ${d.ms} ms`, 'Timing ms: ' + JSON.stringify(d.timing), 'Check: ' + d.validation.level, 'Columns: ' + d.columns.map((c) => c.name + ':' + c.type + (c.nullable ? '?' : '')).join(', ')); }
    if (window.__imp) L.push('', window.__imp + ' ms=' + window.__importMs); return L.join('\n');
  }
  function reportBack() { if (/[?&]report=1/.test(location.search)) { try { const pm = /[?&]port=(\d+)/.exec(location.search); fetch((pm ? 'http://127.0.0.1:' + pm[1] : '') + '/result', { method: 'POST', body: report(), mode: pm ? 'no-cors' : 'same-origin' }); } catch {} } }

  const syncFw = () => { $('fwbox').hidden = $('delim').value !== 'fixed'; };   // the Column widths box shows only for fixed width: chosen in Delimiter, or guessed for the file just read
  $('delim').addEventListener('change', () => { fwAuto = false; syncFw(); });
  $('file').addEventListener('change', async () => {
    if (fwAuto) { $('delim').value = 'auto'; $('fwidths').value = ''; fwAuto = false; syncFw(); }
    const f = $('file').files[0]; $('go').disabled = !f; $('zipbox').hidden = true; $('zipentry').innerHTML = '';
    if (f) status(fmt(f.size) + ' selected. No upload happens.');
    if (f && /\.(zip|xlsx|xlsm|xlsb|xls|ods|sqlite|sqlite3|db|db3|s3db)$/i.test(f.name)) {   // list the files inside so one can be chosen (the largest text file is picked by default)
      const r = await call({ type: 'zipList', file: f });
      if ($('file').files[0] !== f) return;
      if (r.error) { status(r.error.indexOf('Excel') >= 0 ? r.error : 'Cannot read this zip file: ' + r.error, true); return; }
      $('zipboxlabel').textContent = r.kind || 'File in the zip';
      const text = r.entries.filter((x) => r.kind || /\.(csv|tsv|txt|json|ndjson|jsonl|gz|xlsx|xlsm|ods)$/i.test(x.name));
      $('zipentry').innerHTML = (text.length ? text : r.entries).map((x) => '<option value="' + esc(x.name) + '"' + (x.name === r.picked ? ' selected' : '') + '>' + esc(x.name) + (x.size > 0 ? ' (' + (r.kind === 'Table' ? 'about ' : '') + fmt(x.size) + ')' : '') + '</option>').join('');
      $('zipbox').hidden = $('zipentry').options.length < 2;
    }
  });
  $('go').addEventListener('click', () => { const f = $('file').files[0]; if (f) runImport(f, false, $('zipbox').hidden ? { live: true } : { live: true, zipEntry: $('zipentry').value }); });
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
