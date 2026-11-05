(async function () {
  'use strict';

  const policyId = new URLSearchParams(location.search).get('policy') || 'strict';
  const state = document.getElementById('state');
  const policyNode = document.getElementById('policy');
  const reportNode = document.getElementById('report');
  const nativeWorker = window.Worker;
  const workerTrace = [];
  let nextWorkerId = 1;
  let failNextWorker = false;
  let activeTest = 'setup';

  function traceWorker(worker, record) {
    const nativePost = worker.postMessage.bind(worker);
    worker.postMessage = function (message, transfer) {
      if (message && message.kind === 'p') {
        record.jobsPosted++;
        record.messagesPosted.push({ kind: message.kind, id: message.id, bytes: message.buf && message.buf.byteLength });
      } else if (message && message.kind === 'w') {
        record.warmupsPosted++;
      }
      return nativePost(message, transfer);
    };
    worker.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.started) {
        record.initialized = true;
        record.jobsStarted++;
      } else if (data.warm) {
        record.initialized = true;
      } else if (data.error) {
        record.workerErrors.push(String(data.error));
      } else if (data.bytes instanceof ArrayBuffer || data.bytes instanceof Uint8Array) {
        record.jobsCompleted++;
      } else if (data.id != null && (data.F || data.msg)) {
        record.jobsCompleted++;
      }
    });
    worker.addEventListener('error', (event) => {
      record.errorEvents.push({ message: event.message || '', filename: event.filename || '' });
    });
    const nativeTerminate = worker.terminate.bind(worker);
    worker.terminate = function () {
      record.terminated = true;
      return nativeTerminate();
    };
  }

  window.Worker = new Proxy(nativeWorker, {
    construct(target, args) {
      const record = {
        id: nextWorkerId++, test: activeTest, created: false, initialized: false,
        jobsPosted: 0, jobsStarted: 0, jobsCompleted: 0, warmupsPosted: 0,
        messagesPosted: [], errorEvents: [], workerErrors: [], terminated: false,
        syntheticFault: failNextWorker
      };
      failNextWorker = false;
      workerTrace.push(record);
      let workerArgs = args;
      if (record.syntheticFault) {
        const faultUrl = URL.createObjectURL(new Blob(["throw new Error('phase8 synthetic worker failure');"], { type: 'text/javascript' }));
        record.syntheticFaultUrl = faultUrl;
        workerArgs = [faultUrl, ...args.slice(1)];
      }
      const worker = Reflect.construct(target, workerArgs, target);
      record.created = true;
      traceWorker(worker, record);
      return worker;
    }
  });

  const encoder = new TextEncoder();
  const results = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const rowsFor = (values) => values.map((body, id) => ({ id, body, pad: 'p'.repeat(80) }));
  const jsonl = (rows) => encoder.encode(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  };
  const equalRows = (a, b) => a.length === b.length && a.every((row, i) => same(row, b[i]));

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Failed to load same-origin script: ' + src));
      document.head.appendChild(script);
    });
  }

  async function candidateRegression(lib, name, values) {
    activeTest = name;
    const expected = rowsFor(values);
    const bytes = await lib.packRows(expected, { block: 'flat', templates: false });
    const decoded = lib.unpackRows(bytes);
    const columns = lib.unpackColumns(bytes).flatMap((block) => block.cols.body || []);
    assert(lib.info(bytes).rows === expected.length, name + ': footer row count');
    assert(equalRows(expected, decoded), name + ': row values mismatch');
    assert(same(values, columns), name + ': column values mismatch');
    return { name, status: 'pass', rows: decoded.length, footerRows: lib.info(bytes).rows, columnValues: columns.length };
  }

  function navigateTo(policy, collect) {
    const target = new URL(location.href);
    target.search = '';
    target.searchParams.set('policy', policy);
    if (collect) target.searchParams.set('collect', '1');
    target.searchParams.set('run', String(Date.now()));
    location.replace(target.href);
  }

  async function collectNoConnectReport() {
    const raw = sessionStorage.getItem('lfcp-phase8-no-connect-report');
    if (!raw) throw new Error('No connect-src-none report was retained in sessionStorage');
    const report = JSON.parse(raw);
    reportNode.textContent = JSON.stringify(report, null, 2);
    state.textContent = 'No-connect policy test completed; transferring the local-only report from this connect-src self collector page…';
    const response = await fetch('/__phase8_result?policy=no_connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw
    });
    if (!response.ok) throw new Error('Local result capture failed: HTTP ' + response.status);
    const saved = await response.json();
    sessionStorage.removeItem('lfcp-phase8-no-connect-report');
    state.className = 'done';
    state.textContent = 'No-connect page completed without a connection; local collector saved ' + saved.saved + '.';
  }

  async function run() {
    if (new URLSearchParams(location.search).get('collect') === '1') {
      try { await collectNoConnectReport(); }
      catch (error) { state.className = 'failed'; state.textContent = 'Report collection failed: ' + String(error && error.message || error); }
      return;
    }
    const cap = navigator.userAgentData && navigator.userAgentData.getHighEntropyValues
      ? await navigator.userAgentData.getHighEntropyValues(['fullVersion', 'platformVersion', 'architecture', 'model']).catch(() => null)
      : null;
    const ua = { userAgent: navigator.userAgent, userAgentData: cap, platform: navigator.platform };
    const policyMap = {
      strict: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      no_wasm: "default-src 'none'; script-src 'self'; style-src 'self'; worker-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      no_blob_worker: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      no_connect: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    };
    const csp = policyMap[policyId];
    if (!csp) throw new Error('Unknown policy: ' + policyId);
    policyNode.textContent = 'Policy: ' + policyId + ' — ' + csp;
    const report = {
      schema: 'lfcp-workbench-phase8-browser-qualification/v1',
      capturedAt: new Date().toISOString(),
      policyId, csp, browser: ua,
      capabilities: { secureContext: isSecureContext, wasm: typeof WebAssembly === 'object', worker: typeof nativeWorker === 'function', streams: typeof ReadableStream === 'function' },
      package: null, results, workerTrace
    };

    try {
      await loadScript('/experiments/fixes/lfc-pack-0.4.19-string-writer/lfc-pack-fixed.js');
      const lib = window.LfcPack;
      report.package = { version: lib.version, apiVersion: lib.apiVersion };
      activeTest = 'initialization';
      const initStart = performance.now();
      try {
        await lib.init();
      } catch (error) {
        if (policyId !== 'no_wasm') throw error;
        results.push({ name: 'wasm-initialization-blocked-without-wasm-unsafe-eval', status: 'pass', expectedPolicyBlock: true, error: String(error && error.message || error) });
        report.result = 'pass';
        return await finishReport(report, policyId);
      }
      results.push({ name: 'candidate-initialization', status: 'pass', elapsedMs: performance.now() - initStart });

      activeTest = 'ordinary-pack';
      const ordinaryRows = rowsFor(['ordinary', '', 'tail']);
      const ordinary = await lib.packRows(ordinaryRows, { block: 'flat', templates: false });
      assert(equalRows(ordinaryRows, lib.unpackRows(ordinary)), 'ordinary pack round trip mismatch');
      results.push({ name: 'ordinary-pack', status: 'pass', rows: lib.info(ordinary).rows, bytes: ordinary.length });

      const regression = [
        ['empty-first', ['', 'A', 'B', 'C']],
        ['empty-middle', ['A', '', 'B', 'C']],
        ['empty-final', ['A', 'B', 'C', '']],
        ['consecutive-empties', ['', '', 'A', '', 'B', '']],
        ['all-empty', ['', '', '', '']],
        ['single-empty', ['']],
        ['ordinary-nonempty', ['A', 'B', 'C', 'D']],
        ['mixed-empty', ['', 'A', '', 'B', '']]
      ];
      for (const [name, values] of regression) results.push(await candidateRegression(lib, name, values));
      for (let distinct = 2; distinct <= 8; distinct++) {
        const values = [''];
        for (let row = 1; row < 8; row++) values.push(row < distinct ? `v${row}` : 'v1');
        results.push(await candidateRegression(lib, 'cardinality-' + distinct, values));
      }

      activeTest = 'stream-pack';
      const streamRows = rowsFor(['', 'A', 'B', 'C']);
      const input = jsonl(streamRows);
      const stream = lib.packStream({ templates: false });
      const parts = [];
      for (let p = 0; p < input.length; p += 13) parts.push(...stream.push(input.subarray(p, Math.min(input.length, p + 13))));
      parts.push(...stream.finish());
      const streamBytes = concat(parts);
      assert(equalRows(streamRows, lib.unpackRows(streamBytes)), 'stream pack round trip mismatch');
      results.push({ name: 'stream-pack', status: 'pass', inputChunkBytes: 13, rows: lib.info(streamBytes).rows });

      const parallelRows = rowsFor(['', 'A', 'B', 'C', '', 'A', 'B', 'C']);
      const parallelInput = jsonl(parallelRows);

      // Force a fresh worker to fail before a successful packParallel call
      // can leave reusable helpers in the package's idle-worker cache.
      if (policyId !== 'no_blob_worker') {
        activeTest = 'worker-error-propagation';
        failNextWorker = true;
        const errorStart = workerTrace.length;
        let propagatedError = null;
        try { await lib.packParallel(parallelInput, { blockBytes: 450, workers: 2, templates: false }); }
        catch (error) { propagatedError = String(error && error.message || error); }
        const errorWorkers = workerTrace.slice(errorStart);
        assert(propagatedError, 'synthetic Worker failure did not reject packParallel');
        assert(errorWorkers.some((worker) => worker.created && worker.errorEvents.length > 0), 'synthetic Worker error event was not observed');
        results.push({
          name: 'worker-error-propagation', status: 'pass',
          injectedWorkerFailure: true, promiseRejected: true, rejection: propagatedError,
          workerErrorEvents: errorWorkers.reduce((n, worker) => n + worker.errorEvents.length, 0),
          workersCreated: errorWorkers.filter((worker) => worker.created).length
        });
      }

      activeTest = 'parallel-pack';
      const sequential = await lib.pack(parallelInput, { blockBytes: 450, templates: false });
      const workerStart = workerTrace.length;
      let parallel = null;
      let parallelError = null;
      try { parallel = await lib.packParallel(parallelInput, { blockBytes: 450, workers: 2, templates: false }); }
      catch (error) { parallelError = String(error && error.message || error); }
      const parallelWorkers = workerTrace.slice(workerStart);
      if (policyId === 'no_blob_worker') {
        assert(parallelError, 'parallel pack unexpectedly ran without the candidate-required Blob Worker permission');
        assert(parallelWorkers.length > 0 && parallelWorkers.every((worker) => worker.created && !worker.initialized && worker.errorEvents.length > 0), 'the blocked Blob Worker did not fail before initialization');
        results.push({ name: 'parallel-pack-blocked-without-worker-src-blob', status: 'pass', expectedPolicyBlock: true, workersRequested: 2, workerConstructionAttempts: parallelWorkers.length, workerObjectsCreated: parallelWorkers.filter((worker) => worker.created).length, initializedWorkers: parallelWorkers.filter((worker) => worker.initialized).length, workerErrorEvents: parallelWorkers.reduce((n, worker) => n + worker.errorEvents.length, 0), rejection: parallelError });
        report.result = 'pass';
        return await finishReport(report, policyId);
      }
      assert(!parallelError && parallel, 'parallel pack failed: ' + parallelError);
      const seqDecoded = lib.unpackRows(sequential);
      const parDecoded = lib.unpackRows(parallel);
      assert(equalRows(parallelRows, seqDecoded), 'sequential control mismatch');
      assert(equalRows(parallelRows, parDecoded), 'parallel round trip mismatch');
      assert(equalRows(seqDecoded, parDecoded), 'parallel result differs semantically from sequential result');
      assert(lib.info(parallel).blocks >= 2, 'parallel fixture did not generate multiple blocks');
      assert(parallelWorkers.length >= 1 && parallelWorkers.every((worker) => worker.created), 'packParallel did not create a browser Worker');
      assert(parallelWorkers.some((worker) => worker.initialized && worker.jobsPosted > 0 && worker.jobsCompleted > 0), 'no Worker both initialized and completed pack work');
      results.push({
        name: 'parallel-pack-worker-execution', status: 'pass', workersRequested: 2,
        workersCreated: parallelWorkers.length,
        initializedWorkers: parallelWorkers.filter((worker) => worker.initialized).length,
        workersWithJobs: parallelWorkers.filter((worker) => worker.jobsPosted > 0).length,
        completedWorkerJobs: parallelWorkers.reduce((n, worker) => n + worker.jobsCompleted, 0),
        blocks: lib.info(parallel).blocks,
        semanticMatchesSequential: true,
        byteIdenticalToSequential: same(Array.from(sequential), Array.from(parallel))
      });

      report.result = 'pass';
    } catch (error) {
      report.result = 'fail';
      report.failure = String(error && error.stack || error);
      if (results.length === 0 && policyId === 'no_wasm' && /WebAssembly|CSP|Content Security Policy/i.test(report.failure)) {
        results.push({ name: 'wasm-initialization-blocked-without-wasm-unsafe-eval', status: 'pass', expectedPolicyBlock: true, error: String(error && error.message || error) });
        report.result = 'pass';
      }
    }

    await finishReport(report, policyId);
  }

  async function finishReport(report, policyId) {
    report.summary = {
      tests: results.length,
      passed: results.filter((result) => result.status === 'pass').length,
      failed: results.filter((result) => result.status !== 'pass').length,
      workersCreated: workerTrace.filter((worker) => worker.created).length,
      initializedWorkers: workerTrace.filter((worker) => worker.initialized).length,
      workerJobsCompleted: workerTrace.reduce((n, worker) => n + worker.jobsCompleted, 0)
    };
    state.className = report.result === 'pass' ? 'done' : 'failed';
    state.textContent = report.result === 'pass'
      ? `PASS — ${report.summary.passed} checks passed under ${policyId}.`
      : `FAIL — ${report.summary.failed} check(s) failed or were blocked under ${policyId}.`;
    reportNode.textContent = JSON.stringify(report, null, 2);
    if (policyId === 'no_connect') {
      report.resultCapture = 'sessionStorage handoff only; this document makes no fetch or other connection';
      sessionStorage.setItem('lfcp-phase8-no-connect-report', JSON.stringify(report));
      reportNode.textContent = JSON.stringify(report, null, 2);
      state.textContent += ' No report request was sent under connect-src none.';
      setTimeout(() => navigateTo('strict', true), 600);
      return;
    }
    try {
      const response = await fetch('/__phase8_result?policy=' + encodeURIComponent(policyId), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report)
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const saved = await response.json();
      report.savedResult = saved.saved;
      reportNode.textContent = JSON.stringify(report, null, 2);
      state.textContent += ' Saved ' + saved.saved + '.';
      const sequence = ['strict', 'no_wasm', 'no_blob_worker', 'no_connect'];
      const nextIndex = sequence.indexOf(policyId) + 1;
      if (nextIndex > 0 && nextIndex < sequence.length) setTimeout(() => navigateTo(sequence[nextIndex], false), 600);
    } catch (error) {
      report.resultCapture = 'blocked-or-unavailable: ' + String(error && error.message || error);
      reportNode.textContent = JSON.stringify(report, null, 2);
      if (policyId === 'no_connect' && report.result === 'pass') state.textContent += ' Local report POST was blocked by connect-src none, as expected.';
      else state.textContent += ' Result capture failed: ' + String(error && error.message || error);
    }
  }

  run().catch((error) => {
    state.className = 'failed';
    state.textContent = 'Harness failure: ' + String(error && error.message || error);
    reportNode.textContent = String(error && error.stack || error);
  });
})();
