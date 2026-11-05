#!/usr/bin/env python3
"""Local-only static server and opt-in receiver for generated browser test results."""

import json
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4


ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "benchmarks" / "results"
MAX_REPORT_BYTES = 3 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        if self.path != "/__lfcp_test_results":
            self.send_error(404)
            return
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        if host not in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}") or origin != f"http://{host}":
            self.send_error(403, "Same-origin loopback reports only")
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_REPORT_BYTES:
            self.send_error(413, "Report size is invalid or exceeds 3 MiB")
            return
        try:
            report = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_error(400, "Invalid JSON report")
            return
        if not isinstance(report, dict) or report.get("schema") != "lfcp-workbench-browser-validation/v1":
            self.send_error(400, "Unexpected report schema")
            return

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        phase = report.get("phase", 2)
        prefix = "phase-3-browser" if phase == 3 else "phase-2-browser"
        name = f"{prefix}-{stamp}-{uuid4().hex[:8]}.json"
        path = RESULTS / name
        with path.open("x", encoding="utf-8") as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.write("\n")
        body = json.dumps({"saved": name}).encode("utf-8")
        self.send_response(201)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 8080), Handler)
    print(f"Serving {ROOT} on http://127.0.0.1:8080", flush=True)
    print("Report capture is same-origin, opt-in, and accepts only generated validation JSON.", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
