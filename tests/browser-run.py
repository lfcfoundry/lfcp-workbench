#!/usr/bin/env python3
# Runs the Workbench self-test page in one test browser at a time and prints its plain-text result.
# Usage: python3 tests/browser-run.py firefox|chromium|webkit   (env FIREFOX, CHROMIUM; webkit needs install.sh as root)
# Pass/fail only. Starts and stops its own loopback server and browser.
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.error
which = sys.argv[1]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if which == 'webkit' and os.environ.get('_WK_INNER') != '1':
    env = dict(os.environ, _WK_INNER='1', GTK_A11Y='none', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1')
    sys.exit(subprocess.run(['xvfb-run', '-a', '-s', '-screen 0 1280x1024x24', 'dbus-run-session', '--', sys.executable, '-I', os.path.abspath(__file__), which], env=env).returncode)
port = 8800 + os.getpid() % 100
url = 'http://127.0.0.1:%d/app/index.html?selftest=1&report=1' % port
log = tempfile.NamedTemporaryFile('w+', suffix='.log', delete=False)
srv = subprocess.Popen(['node', os.path.join(root, 'tests/browser-serve.mjs'), str(port)], stdout=log, stderr=subprocess.STDOUT)
prof = tempfile.mkdtemp(); proc = None; drv = None
try:
    time.sleep(0.7)
    if which == 'firefox':
        proc = subprocess.Popen([os.environ['FIREFOX'], '--headless', '--no-remote', '--profile', prof, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif which == 'chromium':
        proc = subprocess.Popen([os.environ['CHROMIUM'], '--headless=new', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + prof, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif which == 'webkit':
        wport = 4444 + os.getpid() % 500
        drv = subprocess.Popen(['WebKitWebDriver', '--port=%d' % wport], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
        def call(m, p, b=None):
            r = urllib.request.Request('http://127.0.0.1:%d%s' % (wport, p), method=m, headers={'Content-Type': 'application/json'}, data=json.dumps(b).encode() if b is not None else None)
            try: return json.load(urllib.request.urlopen(r, timeout=30))['value']
            except urllib.error.HTTPError as e: return {'error': e.read().decode()[:300]}
        s = call('POST', '/session', {'capabilities': {'alwaysMatch': {}}}); call('POST', '/session/%s/url' % s['sessionId'], {'url': url})
    else: sys.exit('unknown browser')
    for _ in range(180):
        time.sleep(0.5); log.seek(0); txt = log.read()
        if 'RESULT' in txt: print(txt.split('RESULT\n', 1)[1]); sys.exit(0 if 'Self-test: PASS' in txt else 1)
    print('NO RESULT within 90 s (the page did not report back)'); sys.exit(2)
finally:
    for p in (proc, drv, srv):
        if p:
            try: p.kill()
            except Exception: pass
    shutil.rmtree(prof, ignore_errors=True)
