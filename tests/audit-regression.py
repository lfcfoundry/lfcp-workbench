#!/usr/bin/env python3
"""Regression run for the seven Codex audit findings (WB-01 to WB-07), 2026-11-19.
Usage (from the repo root): CHROMIUM=... FIREFOX=... python3 tests/audit-regression.py chromium|firefox|webkit
Writes the two 6 MB Windows-1252 fixtures (not tracked), runs tests/audit/qa-runner.html through tests/browser-run.py, and fails if any finding still reproduces."""
import os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__)); fx = os.path.join(here, 'audit', 'fixtures')
def win(name, row):
    with open(os.path.join(fx, name), 'wb') as f:
        f.write(b'id,value\n')
        for i in range(60):
            cell = b'A' * 100000
            if i == row: cell = cell[:-1] + b'\xe9'
            f.write(str(i).encode() + b',' + cell + b'\n')
win('windows1252-early.csv', 5); win('windows1252-late.csv', 50)
browser = sys.argv[1] if len(sys.argv) > 1 else 'chromium'
out = subprocess.run([sys.executable, os.path.join(here, 'browser-run.py'), browser, 'autorun=1', '90', '--http=tests/audit/qa-runner.html'], capture_output=True, text=True, cwd=os.path.dirname(here)).stdout
print(out)
known = set(filter(None, os.environ.get('KNOWN_OPEN', '').split(',')))   # findings still open in this build, e.g. KNOWN_OPEN=WB-03,WB-04
bad = [l for l in out.splitlines() if l.startswith('BUG REPRODUCED') and not any('| ' + k + ' |' in l for k in known)]
if bad or 'Self-test: PASS' not in out: print('FAIL', bad); sys.exit(1)
print('PASS: no audit finding reproduces')
