# LFC-pack 0.4.19 upstream issue — review draft

## Destination

GitHub issue tracker: https://github.com/lfcfoundry/JS-modules/issues/new

**Not submitted.** This is a local review artifact. Production integration remains NO-GO.

## Issue title

Clarify flatscan.wasm build provenance and review empty-string strdict() correction

## Proposed issue body

I found a variable-length string round-trip defect in LFC-pack 0.4.19 / API 0's optimized flat writer.

### Reproduction

With the optimized flat-row writer:

```javascript
const rows = [
  { id: 0, body: '' },
  { id: 1, body: 'A' },
  { id: 2, body: 'B' },
  { id: 3, body: 'C' }
];

await LfcPack.init();
const bytes = await LfcPack.packRows(rows, {
  block: 'flat',
  templates: false
});
const decoded = LfcPack.unpackRows(bytes);
```

Expected body values are ['', 'A', 'B', 'C']. The retained negative-control record reports shifted values A, B, and C, followed by an undefined/missing body value for the fourth row. This is the recorded runtime result, not a JSON-serialized representation. Footer validation succeeds, and both footer and returned row counts remain four.

### Proposed correction

In modules/lfc-pack/wasm/flatscan.c, strdict() has two all-values branches that use the output byte offset (o) to decide whether to emit a NUL separator. When the first value is empty, o remains zero, so the next value is treated as the first. The proposed minimal correction changes both checks from if(o) to if(i), basing separator emission on the value's ordinal position.

The patch proposes no format, API, JavaScript fallback, dictionary-encoding, or reader change. It is based on the locally recorded JS-modules origin/main reference at commit 6e16aa8044d0a05bafa7c756c949f3537c23e92a, source file modules/lfc-pack/wasm/flatscan.c, blob 21a0aeb1a3e9fa4fd74deddc9952df710d604890. I have not established that this is the authoritative source for the distributed Wasm.

### Regression evidence

- The targeted matrix passed 19/19 candidate cases; eight corresponding pinned-vendor cases reproduced the defect.
- The 49-case candidate run had zero failed checks. The pinned-vendor negative control had 98 failed checks across 49 cases.
- Android Chrome 156 on an Android phone passed 20/20 Phase 8 checks under the recorded strict CSP. Two actual parallel Workers initialized and completed jobs, and their output matched sequential output.
- The tested policy required wasm-unsafe-eval for WebAssembly and worker-src blob: for the parallel path. The connect-src none control also passed. Firefox was not available; no Firefox compatibility claim is made.

### Wasm build provenance

The corrected candidate was rebuilt with Clang 21.1.8 / wasm-ld 21.1.8. The 13,391-byte output matches the candidate Wasm, SHA-256 80a8332b64fa28697fbea3a054579076ed217b64e1c28078fc95fedd5a6d3c8a.

This does not reproduce the historical upstream Wasm. At the cited source reference, the tracked 13,718-byte upstream module has Git blob 3042d8691f13d53c76c3497ea19479282f4a93ad and SHA-256 a6611fa9e977d8b8c998f231130c89a4e46f695ce9549a9fd7c6b6cc34f4e31c. The embedded FSB64 matches that tracked module, but build.py embeds a prebuilt module and does not compile flatscan.c. The inspected source snapshot has no documented flat-scan compiler/linker recipe. Compiling unmodified source with the candidate flags produced a different 13,342-byte module, SHA-256 92494f9689651d2725f159fff06739593b213d659bad6cf774c3c197643432f7. That difference does not establish why the historical binary differs. Git history pairing source and binary does not prove the original build process.

### Questions for maintainers

1. Is modules/lfc-pack/wasm/flatscan.c authoritative for the flatscan.wasm distributed in 0.4.19? If not, what is the source of truth?
2. Which compiler, linker, and exact flags produced the tracked Wasm? Are historical build logs, CI definitions, scripts, or archived environments available?
3. Can that build environment be recovered? If not, would you prefer a new pinned recipe and deliberate Wasm regeneration?
4. Is the two-condition correction appropriate for upstream, and what source branch, test process, and version/release process should be used?
5. Which Firefox version/environment is appropriate for release qualification, and can maintainers facilitate a test?

Supporting evidence has been assembled locally and SHA-256 verified, but has not been attached, published, or made available at a public URL. No local path in this draft is an external link; the evidence files require separate uploading through an approved route.

This is an inquiry and correction proposal, not production integration approval. Production integration remains NO-GO.

## Evidence files for separate upload

These package-relative paths identify local files to upload; they are not links accessible to maintainers. The table hashes identify the exact copies in the Phase 11 package.

| Evidence file | SHA-256 |
|---|---|
| patch/flatscan-string-separator.patch | 7b62b95cd2671f5c96fabac835e9241fb48ba6f56a1a8fdbc1e34fd9f1f9b058 |
| UPSTREAM-PATCH-PROPOSAL.md | 9aebd7ae92f0dc57d8deab44b2546664474722c2c5c74305f887c57ae26d202a |
| BUILD-PROPOSAL.md | 8eea6aa198afbb4a6bad78bc2926d5a9a76fa74efce2ee5f93ec6e500226ae68 |
| evidence/phase9/UPSTREAM-INTEGRATION-PHASE9.md | 37ce2cc6481f62489c3db04afa1a5bcd85d27506319663cc47d25eb839120bee |
| evidence/phase9/results/phase9-19case-targeted.json | 8dd51eb155337bcf4db4d64635ee52bbdfac9ee21c5f9dcd589b595036091168 |
| evidence/phase9/results/phase9-49case-candidate.json | eb8f59f20f0d9b88fc237c2aab3024b9015e190dfd6aafe39367dbaec15675c0 |
| evidence/phase9/results/phase9-49case-vendor-negative-control.json | e144450041dd44e798f892197738299e2dde4ffbb32f49f648e1e93b209158e8 |
| evidence/phase8/DEPLOYMENT-QUALIFICATION-PHASE8.md | ebc9513bfe3e32b3ce9769a86f3ce6e3e3cef9d1d49be74f21127eff4b720766 |
| evidence/phase8/results/phase-8-browser-strict-20261102T192745Z-afbc49f8.json | ffb08d55264695d15f8803dc0b833cb750c802863229a29126652900363c38b4 |
| evidence/phase8/results/phase-8-browser-no_wasm-20261102T192745Z-e72d5ac0.json | ccbb58cb05e311db995849fbf770ae4a5193b8ffa51623ebffa0bc934277883f |
| evidence/phase8/results/phase-8-browser-no_blob_worker-20261102T192746Z-336f5ecc.json | 3236a8d0e0b514e08218ae776a53688f2058368bb25a72483ce67f0e60e38718 |
| evidence/phase8/results/phase-8-browser-no_connect-20261102T192748Z-d586bb7d.json | 2d217cc4e2d9328db8079a4e35018cb156f50f894b800a3774b4fa678284fbb0 |
| SHA256SUMS manifest file | e83e67168a7425ff89a55e25ddd44941dca50ea0fd4feb198ab043d67d5b9c74 |

The SHA-256 above for SHA256SUMS identifies the manifest file itself. The manifest lists and verifies 40 payload files and excludes its own digest; its hash is distinct from those 40 payload hashes.

## Submission limitation

The available GitHub issue-creation connector accepts issue text and metadata but has no file-upload field. The evidence above cannot be attached through that connector, and the package has no public URL. No issue has been created, and no evidence has been uploaded or published.

