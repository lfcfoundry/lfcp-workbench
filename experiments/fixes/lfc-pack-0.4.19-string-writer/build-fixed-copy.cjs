'use strict';

// Build an isolated LFCP test artifact by swapping only the flat-scan Wasm
// module in a byte-for-byte copy of the pinned JavaScript wrapper.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const vendorPath = path.resolve(__dirname, '../../../vendor/lfcp/0.4.19/lfc-pack.js');
const wasmPath = path.join(__dirname, 'flatscan-fixed-v2.wasm');
const outputPath = path.join(__dirname, 'lfc-pack-fixed.js');
const expectedVendorSha256 = '8c312582c7c739fa43b9df82a418a9ac6cdebfcb27cc32ed2e92642dc646c259';
const source = fs.readFileSync(vendorPath, 'utf8');
const wasm = fs.readFileSync(wasmPath);
const actualVendorSha256 = crypto.createHash('sha256').update(source).digest('hex');

assert.equal(actualVendorSha256, expectedVendorSha256, 'pinned vendor input does not match the Phase 5 artifact');
const wasmModule = new WebAssembly.Module(wasm);
const exportNames = new Set(WebAssembly.Module.exports(wasmModule).map((item) => item.name));
for (const name of ['memory', 'scan', 'strdict', 'rawjoin', 'gather', '__heap_base']) assert(exportNames.has(name), `flat-scan Wasm export missing: ${name}`);

const encoded = wasm.toString('base64');
const replaced = source.replace(/(var FSW = null, FSB64 = ")[^"]+(";)/, `$1${encoded}$2`);
assert.notEqual(replaced, source, 'flat-scan module marker was not found');
fs.writeFileSync(outputPath, replaced, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ output: path.basename(outputPath), vendorSha256: actualVendorSha256, wasmBytes: wasm.length, wasmSha256: crypto.createHash('sha256').update(wasm).digest('hex'), outputSha256: crypto.createHash('sha256').update(replaced).digest('hex') })}\n`);
