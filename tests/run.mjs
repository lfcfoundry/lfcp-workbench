#!/usr/bin/env node
// Workbench test runner. Node pass/fail gate only (no timing numbers).
// Usage: node tests/run.mjs
// Runs the adapter unit tests, then the two LFC-pack defect probes on a
// throwaway copy of the repo, so nothing under benchmarks/results is touched.
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

// 1. Adapter unit tests
const unit = spawnSync(process.execPath, [join(root, 'tests/adapters.test.mjs')], { encoding: 'utf8' });
process.stdout.write(unit.stdout);
record('adapters unit tests', unit.status === 0, unit.status === 0 ? '' : unit.stderr.trim().split('\n')[0]);

for (const f of ['ingest.test.mjs', 'ingest-lfcp.test.mjs', 'query.test.mjs', 'columnar.test.mjs', 'export.test.mjs', 'reader-equivalence.test.mjs']) {
  const r = spawnSync(process.execPath, [join(root, 'tests', f)], { encoding: 'utf8' });
  process.stdout.write(r.stdout);
  record(`ingest core: ${f}`, r.status === 0, r.status === 0 ? '' : (r.stderr.trim().split('\n').find((l) => /Error/.test(l)) || ''));
}

// 2. Vendor pin is unchanged
const sha = createHash('sha256').update(readFileSync(join(root, 'vendor/lfcp/0.4.19/lfc-pack.js'))).digest('hex');
record('vendor 0.4.19 sha256 unchanged', sha === '8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259');

const FIXED = ['0.4.21', '0.4.22', '0.4.24', '0.5.0', '0.5.8', '0.5.9'];
for (const v of FIXED) {
  const h = createHash('sha256').update(readFileSync(join(root, `vendor/lfcp/${v}/lfc-pack.js`))).digest('hex');
  record(`vendor ${v} sha256 matches PROVENANCE.md`, readFileSync(join(root, `vendor/lfcp/${v}/PROVENANCE.md`), 'utf8').includes(h));
}

// 2b. Real ingest path (CSV -> packStream -> unpackRows) is lossless on 0.4.21; on 0.4.19 it must lose data for the documented trigger shapes
for (const v of FIXED) {
  const r = spawnSync(process.execPath, [join(root, 'tests/csv-roundtrip.test.mjs'), join(root, `vendor/lfcp/${v}/lfc-pack.js`)], { encoding: 'utf8' });
  record(`CSV ingest round trip lossless on ${v}`, r.status === 0, r.stdout.trim().split('\n').pop());
}
const r19 = spawnSync(process.execPath, [join(root, 'tests/csv-roundtrip.test.mjs'), join(root, 'vendor/lfcp/0.4.19/lfc-pack.js'), '--expect-loss'], { encoding: 'utf8' });
record('CSV ingest round trip loses data on 0.4.19 (expected, proves the cases bite)', r19.status === 0 && /DATA DIFFERS/.test(r19.stdout));

// 3. Defect probes on a temp copy. Expected results are documented: the fix
//    candidate passes 19/19 and the pinned vendor shows 8 mismatching cases;
//    the round-trip probe exits 1 with 98 failed checks (the known defect).
const tmp = mkdtempSync(join(tmpdir(), 'wb-run-'));
try {
  cpSync(root, tmp, { recursive: true, filter: (s) => !s.includes('/.git') });
  const stale = join(tmp, 'benchmarks/results/phase-6-string-writer-fix-final-v2-20261102.json');
  if (existsSync(stale)) rmSync(stale);
  const a = spawnSync(process.execPath, [join(tmp, 'tests/lfcp-optimized-string-writer-fix.cjs')], { encoding: 'utf8' });
  let ja = {}; try { ja = JSON.parse(a.stdout.trim().split('\n').pop()); } catch {}
  record('probe: candidate fix passes all cases', a.status === 0 && ja.cases === 19 && ja.fixedCasesPassed === 19, `${ja.fixedCasesPassed}/${ja.cases}`);
  record('probe: pinned 0.4.19 reproduces defect (expected)', ja.vendorCasesWithMismatch === 8, `${ja.vendorCasesWithMismatch} mismatching cases`);
  const b = spawnSync(process.execPath, [join(tmp, 'tests/lfcp-variable-length-string-roundtrip.cjs')], { encoding: 'utf8', maxBuffer: 1 << 28 });
  let jb = {}; try { jb = JSON.parse(b.stdout); } catch {}
  record('probe: round-trip defect result unchanged (expected exit 1, 98 failed)', b.status === 1 && jb.failedChecks === 98, `exit ${b.status}, ${jb.failedChecks} failed`);
  for (const v of FIXED) {
    const c = spawnSync(process.execPath, [join(tmp, 'tests/lfcp-variable-length-string-roundtrip.cjs')], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, LFCP_PACK_PATH: join(tmp, `vendor/lfcp/${v}/lfc-pack.js`) } });
    let jc = {}; try { jc = JSON.parse(c.stdout); } catch {}
    record(`${v} passes the same round-trip probe`, c.status === 0 && jc.failedChecks === 0 && jc.library?.version === v, `exit ${c.status}, ${jc.failedChecks} failed, version ${jc.library?.version}`);
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
