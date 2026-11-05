#!/usr/bin/env python3
"""Loopback static server for Phase 8 CSP and Worker qualification."""

import json
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[4]
RESULTS = ROOT / "benchmarks" / "results"
MAX_BYTES = 2_000_000
POLICIES = {
    "strict": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "no_wasm": "default-src 'none'; script-src 'self'; style-src 'self'; worker-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "no_blob_worker": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "no_connect": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; worker-src blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def policy_id(self):
        query = parse_qs(urlsplit(self.path).query)
        return query.get("policy", ["strict"])[0]

    def end_headers(self):
        policy = POLICIES.get(self.policy_id(), POLICIES["strict"])
        self.send_header("Content-Security-Policy", policy)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if urlsplit(self.path).path != "/__phase8_result":
            self.send_error(404)
            return
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        if host != f"127.0.0.1:{self.server.server_port}" or origin != f"http://{host}":
            self.send_error(403, "Loopback same-origin submissions only")
            return
        policy_id = self.policy_id()
        if policy_id not in POLICIES:
            self.send_error(400, "Unknown policy")
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
        if not isinstance(report, dict) or report.get("schema") != "lfcp-workbench-phase8-browser-qualification/v1":
            self.send_error(400, "Unexpected report schema")
            return
        if report.get("policyId") != policy_id or report.get("csp") != POLICIES[policy_id]:
            self.send_error(400, "Report policy does not match response header")
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        name = f"phase-8-browser-{policy_id}-{stamp}-{uuid4().hex[:8]}.json"
        with (RESULTS / name).open("x", encoding="utf-8") as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.write("\n")
        body = json.dumps({"saved": name}).encode("utf-8")
        self.send_response(201)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8080), Handler)
    print(f"Serving {ROOT} on http://127.0.0.1:8080", flush=True)
    print("Policies: " + ", ".join(POLICIES), flush=True)
    server.serve_forever()
