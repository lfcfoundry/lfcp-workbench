'use strict';

(function () {
  var $ = function (id) { return document.getElementById(id); };
  var worker = new Worker('./worker.js');
  var fileInput = $('source-file'), formatSelect = $('format'), delimiterRow = $('delimiter-row');
  var activeId = null, requestSeq = 0, pending = Object.create(null), currentResult = null;

  function nextId(prefix) { return prefix + '-' + (++requestSeq) + '-' + Date.now().toString(36); }
  function setStatus(text, error) { var el = $('status'); el.textContent = text; el.className = 'status' + (error ? ' error' : ''); }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function showResult(kind, dataset) {
    currentResult = { kind: kind, dataset: dataset };
    $('empty-state').hidden = true;
    $('result-view').hidden = false;
    $('workspace-title').textContent = dataset.name || 'Dataset details';
    if (kind === 'import') {
      var d = dataset;
      $('result-summary').innerHTML = '<strong>' + esc(d.sourceName) + '</strong><span class="summary-pill">' + esc(d.sourceFormat.toUpperCase()) + '</span><span class="summary-pill">' + Number(d.rows).toLocaleString() + ' rows</span><span class="summary-pill">' + formatBytes(d.size) + ' LFCP</span>' + (d.delimiter ? '<span class="summary-pill">delimiter ' + esc(d.delimiter) + '</span>' : '');
      renderTable($('preview-table'), d.sample || []);
      renderTable($('profile-table'), d.profile || [], ['field', 'types', 'present', 'missing', 'nulls', 'distinctSample', 'examples']);
      $('details-json').textContent = JSON.stringify({ file: d.name, bytes: d.size, rows: d.rows, format: d.sourceFormat, delimiter: d.delimiter, fieldsInMetadata: d.columns, profileCapped: d.profileCapped, schemaColumnsTruncated: d.schemaColumnsTruncated, note: 'The full LFCP file was streamed to OPFS. The prototype preview/profile was collected while ingesting; it did not re-open the entire file.' }, null, 2);
    } else {
      var x = dataset;
      $('result-summary').innerHTML = '<strong>' + esc(x.name) + '</strong><span class="summary-pill">' + Number(x.info.rows || 0).toLocaleString() + ' rows</span><span class="summary-pill">' + Number(x.info.blocks || 0).toLocaleString() + ' blocks</span><span class="summary-pill">' + formatBytes(x.info.size) + '</span><span class="summary-pill">format ' + x.info.major + '.' + x.info.minor + '</span>';
      renderTable($('preview-table'), x.sample || []);
      var flat = [];
      (x.stats || []).forEach(function (block, i) {
        (block.keys || []).forEach(function (key) { flat.push({ block: i, table: block.table, rows: block.rows, field: key.key || key.name || '', encoding: key.type, values: key.n, nulls: key.nulls, distinct: key.distinct }); });
      });
      renderTable($('profile-table'), flat, ['block', 'table', 'rows', 'field', 'encoding', 'values', 'nulls', 'distinct']);
      $('details-json').textContent = JSON.stringify({ info: x.info, metadata: x.metadata, blockStats: x.stats, note: 'Inspection used the full file in memory and is limited to 64 MiB in this spike.' }, null, 2);
    }
    activateTab('preview');
  }
  function renderTable(host, rows, order) {
    if (!rows || !rows.length) { host.innerHTML = '<div class="list-empty">No rows to display.</div>'; return; }
    var keys = order || [];
    if (!keys.length) rows.slice(0, 20).forEach(function (row) { Object.keys(row || {}).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
    keys = keys.slice(0, 20);
    var html = '<table class="data-table"><thead><tr>' + keys.map(function (k) { return '<th>' + esc(k) + '</th>'; }).join('') + '</tr></thead><tbody>';
    rows.slice(0, 100).forEach(function (row) {
      html += '<tr>' + keys.map(function (k) {
        var v = row && row[k], shown = v == null ? (v === null ? 'null' : '') : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        return '<td title="' + esc(shown) + '"' + (v == null ? ' class="muted-cell"' : '') + '>' + esc(shown) + '</td>';
      }).join('') + '</tr>';
    });
    host.innerHTML = html + '</tbody></table>';
  }
  function activateTab(name) {
    document.querySelectorAll('.tab').forEach(function (button) {
      var active = button.dataset.tab === name; button.classList.toggle('active', active); button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    ['preview', 'profile', 'details'].forEach(function (tab) { $('tab-' + tab).hidden = tab !== name; });
  }
  document.querySelectorAll('.tab').forEach(function (button) { button.addEventListener('click', function () { activateTab(button.dataset.tab); }); });

  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (f && /\.json\.lfc$/i.test(f.name) && formatSelect.value === 'auto') formatSelect.value = 'lfc';
    else if (f && formatSelect.value === 'lfc' && !/\.json\.lfc$/i.test(f.name)) formatSelect.value = 'auto';
    delimiterRow.hidden = formatSelect.value === 'lfc';
    $('start-import').textContent = formatSelect.value === 'lfc' ? 'Inspect selected LFCP' : 'Import as LFCP →';
    $('file-label').textContent = f ? f.name : 'Select a local file';
    $('start-import').disabled = !f;
    if (f) setStatus(formatBytes(f.size) + ' selected. No upload or network request will be made.');
  });
  formatSelect.addEventListener('change', function () {
    var isLfc = formatSelect.value === 'lfc'; delimiterRow.hidden = isLfc;
    $('start-import').textContent = isLfc ? 'Inspect selected LFCP' : 'Import as LFCP →';
  });
  $('start-import').addEventListener('click', function () {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var format = formatSelect.value;
    if (format === 'lfc') { var inspectId = nextId('inspect'); pending[inspectId] = true; worker.postMessage({ type: 'inspect-file', id: inspectId, file: file }); setStatus('Inspecting the selected LFCP file…'); return; }
    activeId = nextId('import');
    $('start-import').disabled = true; $('cancel-import').hidden = false; $('progress-wrap').hidden = false; $('progress').value = 0;
    setStatus('Starting local import…');
    var delimiter = $('delimiter').value === 'tab' ? '\t' : $('delimiter').value;
    worker.postMessage({ type: 'import', id: activeId, file: file, format: format, delimiter: delimiter });
  });
  $('cancel-import').addEventListener('click', function () { if (activeId) { worker.postMessage({ type: 'cancel', id: activeId }); setStatus('Stopping at the next batch boundary…'); } });
  $('lfc-file').addEventListener('change', function () {
    var file = $('lfc-file').files && $('lfc-file').files[0];
    if (!file) return;
    var id = nextId('inspect'); pending[id] = true; worker.postMessage({ type: 'inspect-file', id: id, file: file });
    setStatus('Inspecting ' + file.name + '…');
  });
  $('refresh-storage').addEventListener('click', refreshStorage);

  function refreshStorage() {
    var id = nextId('list'); pending[id] = true; worker.postMessage({ type: 'list', id: id });
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(function (e) {
      $('storage-usage').textContent = formatBytes(e.usage || 0) + ' used · ' + (e.quota ? formatBytes(e.quota) + ' estimated quota' : 'quota unavailable');
    }).catch(function () { $('storage-usage').textContent = 'Storage estimate unavailable'; });
  }
  function renderSaved(entries, message) {
    var host = $('saved-list');
    if (message) { host.innerHTML = '<div class="list-empty">' + esc(message) + '</div>'; return; }
    if (!entries.length) { host.innerHTML = '<div class="list-empty">No datasets saved in this browser yet.</div>'; return; }
    host.innerHTML = entries.map(function (e) {
      return '<div class="dataset-row"><span class="dataset-glyph" aria-hidden="true">▦</span><div class="dataset-info"><strong title="' + esc(e.name) + '">' + esc(e.name) + '</strong><small>' + formatBytes(e.size) + ' · ' + new Date(e.modified).toLocaleString() + '</small></div><span class="dataset-state ' + (e.complete ? '' : 'incomplete') + '">' + (e.complete ? 'complete' : 'incomplete') + '</span><button class="dataset-open" data-open="' + esc(e.name) + '" ' + (e.complete ? '' : 'disabled') + '>Inspect</button>' + (!e.complete ? '<button class="dataset-open" data-delete="' + esc(e.name) + '">Remove</button>' : '') + '</div>';
    }).join('');
    host.querySelectorAll('[data-open]').forEach(function (button) { button.addEventListener('click', function () { var id = nextId('inspect'); pending[id] = true; worker.postMessage({ type: 'inspect-stored', id: id, name: button.dataset.open }); setStatus('Opening stored LFCP with the bounded prototype reader…'); }); });
    host.querySelectorAll('[data-delete]').forEach(function (button) { button.addEventListener('click', function () { if (!confirm('Remove this incomplete prototype dataset from this browser?')) return; var id = nextId('delete'); pending[id] = true; worker.postMessage({ type: 'delete', id: id, name: button.dataset.delete }); }); });
  }

  worker.onmessage = function (event) {
    var msg = event.data || {};
    if (msg.type === 'progress') {
      var pct = msg.totalBytes ? Math.min(1, msg.bytes / msg.totalBytes) : 0;
      $('progress').value = pct; $('progress-pct').textContent = Math.round(pct * 100) + '%';
      $('progress-text').textContent = Number(msg.rows || 0).toLocaleString() + ' rows · ' + formatBytes(msg.bytes || 0) + (msg.delimiter ? ' · ' + msg.delimiter : '');
      return;
    }
    if (msg.type === 'done' && msg.id === activeId) {
      activeId = null; $('start-import').disabled = !(fileInput.files && fileInput.files[0]); $('cancel-import').hidden = true; $('progress-wrap').hidden = true;
      showResult('import', msg.dataset); setStatus('Import complete. LFCP blocks and footer were written to OPFS.'); refreshStorage(); return;
    }
    if (msg.type === 'inspect') { delete pending[msg.id]; showResult('inspect', msg.dataset); setStatus('LFCP inspection complete. This path used a whole-file buffer.'); return; }
    if (msg.type === 'list') { delete pending[msg.id]; renderSaved(msg.entries || [], msg.message); return; }
    if (msg.type === 'deleted') { delete pending[msg.id]; setStatus('Incomplete local dataset removed.'); refreshStorage(); return; }
    if (msg.type === 'cancelled') {
      if (msg.id === activeId) { activeId = null; $('start-import').disabled = !(fileInput.files && fileInput.files[0]); $('cancel-import').hidden = true; $('progress-wrap').hidden = true; setStatus('Import cancelled; its unfinished output was removed.'); refreshStorage(); }
      return;
    }
    if (msg.type === 'error') {
      delete pending[msg.id];
      if (msg.id === activeId) { activeId = null; $('start-import').disabled = !(fileInput.files && fileInput.files[0]); $('cancel-import').hidden = true; $('progress-wrap').hidden = true; }
      setStatus(msg.message || 'The operation failed.', true); return;
    }
  };
  worker.onerror = function (event) { activeId = null; $('cancel-import').hidden = true; $('progress-wrap').hidden = true; setStatus('Worker stopped: ' + (event.message || 'unknown error'), true); };
  if (!window.isSecureContext) setStatus('Use HTTPS or localhost: browser OPFS and Worker features require a secure context.', true);
  refreshStorage();
})();
