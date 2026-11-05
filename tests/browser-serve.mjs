// Tiny loopback server for browser checks. Serves the repo; for app/index.html it relaxes
// connect-src so a test run (?report=1) can POST its plain-text result to /result.
// Usage: node tests/browser-serve.mjs [port]  -> prints the URL; result is written to stdout and the process exits.
import http from 'node:http'; import { readFileSync, existsSync } from 'node:fs'; import { join, resolve, extname, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), port = +process.argv[2] || 8765;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname === '/result') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.end('ok'); console.log('RESULT\n' + b); setTimeout(() => process.exit(0), 50); }); return; }
  const f = join(root, u.pathname.replace(/\/$/, '/index.html'));
  if (!f.startsWith(root) || !existsSync(f)) { res.statusCode = 404; return res.end('no'); }
  let body = readFileSync(f); if (f.endsWith('app/index.html')) body = Buffer.from(String(body).replace("connect-src 'none'", "connect-src 'self'"));
  res.setHeader('content-type', types[extname(f)] || 'application/octet-stream'); res.end(body);
}).listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port + '/app/index.html?selftest=1&report=1'));
