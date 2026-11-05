#!/usr/bin/env python3
"""Read-only audit of the locally recorded upstream flat-scan artifact."""

import base64
import hashlib
import json
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
JS_MODULES = ROOT.parent / "JS-modules"
EXPECTED_REF = "6e16aa8044d0a05bafa7c756c949f3537c23e92a"
REF = "origin/main"
MODULE = "modules/lfc-pack/"
REBUILT = Path(__file__).with_name("flatscan-origin-rebuild-20261102.wasm")


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(JS_MODULES), *args])


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


ref_commit = git("rev-parse", REF).decode().strip()
if ref_commit != EXPECTED_REF:
    raise SystemExit(f"{REF} changed: expected {EXPECTED_REF}, found {ref_commit}")

wasm_path = MODULE + "wasm/flatscan.wasm"
source_path = MODULE + "wasm/flatscan.c"
package_path = MODULE + "lfc-pack.js"
wasm = git("show", f"{REF}:{wasm_path}")
source = git("show", f"{REF}:{source_path}")
package = git("show", f"{REF}:{package_path}").decode("ascii")
embedded_match = re.search(r'FSB64\s*=\s*"([^"]+)"', package)
if not embedded_match:
    raise SystemExit("Could not locate FSB64 in the source package")
embedded = base64.b64decode(embedded_match.group(1), validate=True)

wasm_blob = git("rev-parse", f"{REF}:{wasm_path}").decode().strip()
source_blob = git("rev-parse", f"{REF}:{source_path}").decode().strip()
rebuilt = REBUILT.read_bytes()
report = {
    "ref": REF,
    "commit": ref_commit,
    "source": {"path": source_path, "gitBlob": source_blob, "bytes": len(source), "sha256": sha256(source)},
    "trackedWasm": {"path": wasm_path, "gitBlob": wasm_blob, "bytes": len(wasm), "sha256": sha256(wasm)},
    "embeddedWasm": {"bytes": len(embedded), "sha256": sha256(embedded), "byteIdenticalToTrackedWasm": embedded == wasm},
    "clang21Rebuild": {"path": str(REBUILT.relative_to(ROOT)), "bytes": len(rebuilt), "sha256": sha256(rebuilt), "byteIdenticalToTrackedWasm": rebuilt == wasm},
}
print(json.dumps(report, indent=2))
if embedded != wasm:
    raise SystemExit("Embedded FSB64 differs from tracked flatscan.wasm")
