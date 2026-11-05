#!/usr/bin/env python3
"""Loopback-only Phase 7 static host and exclusive test-result recorder."""

import json
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[4]
RESULTS = ROOT / "benchmarks" / "results"
MAX_BYTES = 1_000_000


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        if self.path != "/__phase7_result":
            self.send_error(404)
            return
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        if host not in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}") or origin != f"http://{host}":
            self.send_error(403, "Loopback same-origin report submissions only")
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BYTES:
            self.send_error(413, "Invalid result size")
            return
        try:
            report = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_error(400, "Invalid JSON")
            return
        if not isinstance(report, dict) or report.get("schema") != "lfcp-workbench-phase7-browser-candidate/v1":
            self.send_error(400, "Unexpected report schema")
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        name = f"phase-7-browser-candidate-{stamp}-{uuid4().hex[:8]}.json"
        target = RESULTS / name
        with target.open("x", encoding="utf-8") as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.write("\n")
        body = json.dumps({"saved": name}).encode("utf-8")
        self.send_response(201)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8080), Handler)
    print(f"Serving {ROOT} on http://127.0.0.1:8080", flush=True)
    server.serve_forever()
