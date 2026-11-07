'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const worker = new Worker(window.__WORKER_URL || './worker.js');
  let seq = 0, active = null, last = null; const waiters = new Map();
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
  const status = (t, bad) => { $('status').textContent = t; $('status').className = bad ? 'bad' : ''; };
  const call = (msg) => new Promise((resolve) => { const id = 'j' + (++seq); waiters.set(id, resolve); worker.postMessage(Object.assign({ id }, msg)); });
  const table = (rows, keys) => rows.length ? '<div class="wrap"><table><thead><tr>' + keys.map((k) => '<th>' + esc(k) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((r) => '<tr>' + keys.map((k) => '<td title="' + esc(r[k]) + '">' + esc(r[k]) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' : '<p>No rows.</p>';

  worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'progress') { $('prog').value = m.total ? m.bytes / m.total : 0; status(m.rows.toLocaleString() + ' rows · ' + fmt(m.bytes) + ' of ' + fmt(m.total)); return; }
    const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); }
  };
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
  async function runImport(file, inline) {
    $('go').disabled = true; $('selftest').disabled = true; $('cancel').hidden = false; $('prog').hidden = false; $('prog').value = 0;
    const id = 'j' + (++seq); active = id;
    const res = await new Promise((resolve) => { waiters.set(id, resolve); worker.postMessage({ type: 'import', id, file, delimiter: $('delim').value, inline: !!inline || /[?&]inline=1/.test(location.search) }); });
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
  function renderRows() {
    const sc = $('gridscroll'), first = topIndex(), host = $('gridrows');
    host.style.top = (scaled() ? sc.scrollTop - (first - G.start) * ROW : Math.max(0, G.start) * ROW) + 'px';
    host.innerHTML = G.rows.map((r) => '<div class="gr">' + r.map((v, i) => '<div class="gc' + (G.cols[i].type === 'integer' || G.cols[i].type === 'number' ? ' num' : '') + '" title="' + esc(v) + '">' + esc(v) + '</div>').join('') + '</div>').join('');
    return first;
  }
  async function loadWindow() {
    const sc = $('gridscroll'), first = Math.max(0, topIndex() - 10);
    if (G.start >= 0 && Math.abs(first - G.start) < 10 && G.rows.length) { $('gridhead').scrollLeft = sc.scrollLeft; return; }
    const r = await call({ type: 'page', start: first, count: WINDOW });
    G.start = r.start; G.rows = r.rows; G.numbers = r.numbers; renderRows(); $('gridhead').scrollLeft = sc.scrollLeft;
  }
  function gridInfo() { $('gridinfo').textContent = G.count.toLocaleString() + ' of ' + G.total.toLocaleString() + ' rows' + (G.sort ? ', sorted by ' + G.sort.col + (G.sort.dir === 'desc' ? ' (high to low)' : ' (low to high)') : ''); }
  async function applyQuery() {
    const r = await call({ type: 'query', filters: G.filters, sort: G.sort, stream: !!G.forceStream });
    G.count = r.count; G.total = r.total; G.start = -1; G.rows = []; G.lastQuery = r;
    $('gridspace').style.height = spaceHeight() + 'px'; $('gridscroll').scrollTop = 0;
    G.cols.forEach((c, i) => { const el = document.querySelector('[data-err="' + i + '"]'); if (el) el.textContent = r.errors[c.name] || ''; });
    if (r.errors['']) status(r.errors[''], true);
    gridInfo(); $('gridinfo').textContent += ' · ' + r.ms + ' ms'; await loadWindow();
    return r;
  }
  function buildHead() {
    $('gridhead').innerHTML = G.cols.map((c, i) => '<div class="hc"><button data-sort="' + i + '" title="Sort by ' + esc(c.name) + '">' + esc(c.name) + (G.sort && G.sort.col === c.name ? (G.sort.dir === 'asc' ? ' ▲' : ' ▼') : '') + '</button><input data-filter="' + i + '" placeholder="filter" aria-label="Filter ' + esc(c.name) + '" value="' + esc(G.filters[c.name] || '') + '"><div class="err" data-err="' + i + '"></div></div>').join('');
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
    const r = await call({ type: 'open', name });
    if (r.type === 'error') { status(r.message, true); return; }
    Object.assign(G, { cols: r.columns, filters: {}, sort: null }); $('gridbox').hidden = false; $('gridtitle').textContent = 'Data: ' + r.name; buildHead(); await applyQuery(); status('Opened. Type in a filter box or click a column name.');
    return r;
  }
  $('gridscroll').addEventListener('scroll', () => { if (!G.busy) { G.busy = true; requestAnimationFrame(async () => { G.busy = false; await loadWindow(); }); } });
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
      add('row count equals expected', d.rows === expected.length, `${d.rows} vs ${expected.length}`);
      add('import ran parse and pack on two threads', d.parallel === true || /[?&]inline=1/.test(location.search) || location.protocol === 'file:', (d.parallel ? 'two threads' : 'one thread') + (location.protocol === 'file:' ? ' (a page opened from a file may not be allowed a helper; it then runs on one thread)' : ''));
      const inl = await runImport(file, true);
      add('import on one thread gives the same dataset', inl.type === 'done' && inl.dataset.rows === d.rows && !inl.dataset.parallel && JSON.stringify(inl.dataset.columns) === JSON.stringify(d.columns) && inl.dataset.bytes === d.bytes, inl.type === 'done' ? inl.dataset.rows + ' rows, ' + inl.dataset.bytes + ' vs ' + d.bytes + ' bytes' : inl.message);
      if (inl.type === 'done') await call({ type: 'delete', name: inl.dataset.name });
      const bad = await runImport(new File(['a,b\r\n1,2\r\n3\r\n'], 'bad.csv', { type: 'text/csv' }));
      add('a bad row stops the import and names its line', bad.type === 'error' && /Line 3/.test(bad.message), bad.message);
      const idc = 'j' + (++seq), pc = new Promise((r) => waiters.set(idc, r)); worker.postMessage({ type: 'import', id: idc, file, delimiter: ',' }); worker.postMessage({ type: 'cancel', id: idc });
      const cr = await pc; add('cancel stops the import', cr.type === 'cancelled', cr.type);
      add('footer validated', d.validation.ok, d.validation.level);
      add('types: id integer, score number, when date', d.columns[0].type === 'integer' && d.columns[2].type === 'number' && d.columns[3].type === 'date', d.columns.map((c) => c.type).join(','));
      const v = await call({ type: 'verify', name: d.name, expectJson: JSON.stringify(expected) });
      add('every value read back identical to the source', v.json === true, v.message || `${v.rows} rows read`);
      const o = await openGrid(d.name);
      add('grid opens with all rows', o && o.total === expected.length, o && String(o.total));
      add('browsing decodes only the pages shown (no full decode yet)', G.lastQuery && G.lastQuery.decodedAll === false, G.rows.length + ' rows shown');
      add('browsed first page equals source rows', JSON.stringify(G.rows[0]) === JSON.stringify(G.cols.map((c) => expected[0][c.name])) && G.rows.length === 60, G.rows.length + ' rows');
      $('gridscroll').scrollTop = 15000 * 28; await new Promise((r) => setTimeout(r, 400));
      add('scrolling to row 15000 shows the right rows', G.start > 0 && JSON.stringify(G.rows[10]) === JSON.stringify(G.cols.map((c) => expected[G.start + 10][c.name])), 'window starts at ' + G.start);
      G.filters = { id: '>=19990' }; G.sort = { col: 'id', dir: 'desc' }; buildHead(); let q = await applyQuery();
      add('numeric filter id>=19990 gives 10 rows', q.count === 10, String(q.count));
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
    let res = null;
    if (g.type === 'generated') { s = performance.now(); res = await runImport(g.file); T.importMs = Math.round(performance.now() - s); }
    add('import finished', res && res.type === 'done', res && res.message);
    if (res && res.type === 'done') {
      const d = res.dataset; add('row count equals generated', d.rows === g.rows, `${d.rows} vs ${g.rows}`); add('footer validated', d.validation.ok, d.validation.level); T.storedBytes = d.bytes; T.phases = d.timing;
      s = performance.now(); const o = await openGrid(d.name); T.openMs = Math.round(performance.now() - s);
      add('data view opens', o && o.total === g.rows, o && String(o.total));
      const same = (row, i) => JSON.stringify(row) === JSON.stringify(cells(i));
      add('first rows are right', same(G.rows[0], 0) && same(G.rows[7], 7));
      const sc = $('gridscroll'), jump = async (frac) => { sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * frac); await new Promise((r) => setTimeout(r, 600)); };
      s = performance.now(); await jump(1); T.lastPageMs = Math.round(performance.now() - s - 600);
      const lastRow = G.rows[G.rows.length - 1]; add('scrolling to the end shows the last row', lastRow && same(lastRow, g.rows - 1), lastRow && lastRow[0] + ' vs ' + (g.rows - 1));
      await jump(0.5); const mid = G.rows[5]; add('middle of the file shows a consistent row', mid && same(mid, Number(mid[0])) && Number(mid[0]) > g.rows * 0.4 && Number(mid[0]) < g.rows * 0.6, mid && mid[0]);
      G.filters = { id: '>=' + (g.rows - 10) }; buildHead(); s = performance.now(); const q = await applyQuery(); T.filterMs = Math.round(performance.now() - s);
      add('filter finds the last 10 rows', q.count === 10, String(q.count));
      add('the filtered rows are the last 10', G.rows.length === 10 && same(G.rows[0], g.rows - 10) && same(G.rows[9], g.rows - 1), G.rows[0] && G.rows[0][0]);
      G.filters = {}; G.sort = { col: 'id', dir: 'desc' }; buildHead(); s = performance.now(); const q2 = await applyQuery(); T.sortMs = Math.round(performance.now() - s);
      add('sorting the whole file high to low puts the last row first', q2.count === g.rows && same(G.rows[0], g.rows - 1) && same(G.rows[5], g.rows - 6), G.rows[0] && G.rows[0][0]);
      G.sort = { col: 'score', dir: 'asc' }; buildHead(); s = performance.now(); const q3 = await applyQuery(); T.sortScoreMs = Math.round(performance.now() - s);
      G.sort = { col: 'note', dir: 'asc' }; buildHead(); s = performance.now(); const q4 = await applyQuery(); T.sortTextMs = Math.round(performance.now() - s); add('sorting by a text column (note) works', q4.count === g.rows && !!G.rows[0], G.rows[0] && G.rows[0][4]);
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
    const L = ['LFCFoundry Workbench results', 'Browser: ' + navigator.userAgent, 'Secure context: ' + window.isSecureContext + ', OPFS: ' + !!(navigator.storage && navigator.storage.getDirectory) + (last && last.dataset ? ', stored in: ' + last.dataset.storage : ''), 'Time: ' + new Date().toISOString()];
    if (last && last.selfTest) { L.push('', 'Self-test: ' + (last.selfTest.ok ? 'PASS' : 'FAIL') + ' (' + last.selfTest.ms + ' ms)'); last.selfTest.checks.forEach((c) => L.push((c.ok ? '  ok   ' : '  FAIL ') + c.name + (c.detail ? ' - ' + c.detail : ''))); }
    if (last && last.big) L.push('Big file: ' + last.big.mb + ' MB target, ' + last.big.rows + ' rows, ' + last.big.bytes + ' bytes' + (last.big.onDisk ? ', generated on disk (OPFS)' : ', generated in memory') + ', phase ms ' + JSON.stringify(last.big.T));
    if (last && last.dataset) { const d = last.dataset; L.push('', `Import: ${d.source}, ${d.rows} rows, ${d.columns.length} columns, ${d.bytes} bytes stored, ${d.ms} ms`, 'Timing ms: ' + JSON.stringify(d.timing), 'Check: ' + d.validation.level, 'Columns: ' + d.columns.map((c) => c.name + ':' + c.type + (c.nullable ? '?' : '')).join(', ')); }
    return L.join('\n');
  }
  function reportBack() { if (/[?&]report=1/.test(location.search)) { try { const pm = /[?&]port=(\d+)/.exec(location.search); fetch((pm ? 'http://127.0.0.1:' + pm[1] : '') + '/result', { method: 'POST', body: report(), mode: pm ? 'no-cors' : 'same-origin' }); } catch {} } }

  $('file').addEventListener('change', () => { const f = $('file').files[0]; $('go').disabled = !f; if (f) status(fmt(f.size) + ' selected. No upload happens.'); });
  $('go').addEventListener('click', () => { const f = $('file').files[0]; if (f) runImport(f); });
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
})();
