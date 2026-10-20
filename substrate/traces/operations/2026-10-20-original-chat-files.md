---
status: completed
created_at: 2026-10-20
files_edited:
  - contracts/manifest.json
  - contracts/openapi.json
  - contracts/openapi.yaml
  - contracts/wiki.json
  - docs/CHAT_ATTACHMENTS.md
  - docs/MIGRATION_V3.md
  - docs/WIKI.md
  - docs/WIKI_VALIDATION.md
  - scripts/generate.mjs
  - src/attachments.ts
  - src/contract.ts
  - src/generated.ts
  - src/http.ts
  - src/wiki.ts
  - testdata/capabilities/canonical-v3.json
  - testdata/capabilities/provenance.json
  - testdata/chat-attachments/original-ready.json
  - testdata/wiki/source-original-ready.json
  - tests/attachments.test.mjs
  - tests/types.ts
  - tests/wiki-contract.test.mjs
rationale:
  - Align native original handling with the merged server and PHP SDK.
  - Preserve default wiki upload requests and public feature types.
  - Stop original-mode polling and fail unsupported uploads before mutation.
supporting_docs:
  - https://github.com/digitalygo/envai-teams/commit/7192fc05ebec817bddc705186c8f195cc0dc5ec5
  - https://github.com/digitalygo/envai-teams-sdk-php/commit/93eafc02271035065ac975f91cd4f77d148c9d2c
---

# Original chat files SDK alignment

## Summary of changes

Aligned attachment upload guards, original readiness, wiki original-only uploads and capability parsing with the merged server and PHP reference. Refreshed immutable current contract snapshots, generated declarations and provenance while preserving frozen v2 artifacts.

## Technical reasoning

Native uploads require both `chat_attachments` and `chat_attachment_originals`; other attachment operations and messages keep their previous requirement. Feature discovery accepts homogeneous string lists or strict boolean maps and normalizes maps to enabled names, preserving the public list type. Malformed advertisements cannot enable original uploads.

`uploadSourceFile` accepts `processing: 'original'` in its options. Both helper and low-level calls require `wiki_original_sources`; omitted or explicit `convert` keeps the existing request unchanged. Attachment waits require lifecycle `ready` with `not_required`, while source waits recognize original inbox/raw readiness. Polling never starts indexing or resubmits a mutation. Existing transport, file-backed multipart, schema and polling facilities were reused without new dependencies.

## Impact assessment

Baseline: `621ab941b6c8689f2b5e5ba6770e73ad5c2c57a3`. All five current source snapshots match immutable server `7192fc05ebec817bddc705186c8f195cc0dc5ec5`; PHP `93eafc02271035065ac975f91cd4f77d148c9d2c` is the implementation reference. Sibling Python and Go SDKs were aligned in the same task. Server and PHP files were not modified.

Original bytes, filenames and idempotency keys remain intact. There is no silent OCR fallback or automatic mutation retry. Dependencies, workflows, package versions, migrations, tags, releases and deployments are unchanged. Work remains local and uncommitted.

## Validation steps

The leader independently ran these checks on Node 24.20.0 with a dedicated disposable PostgreSQL 18 database:

```bash
npm run check
npm run check:package
npm audit --audit-level=high
npm test --prefix .github/release-tools
npm audit --audit-level=high --prefix .github/release-tools
git diff --check
```

`ENVAI_TEST_PG_URL` selected only the disposable SDK database. Deterministic generation, typechecking, build and all 309 tests passed with zero failures or skips. Runtime coverage was 99.81% lines, 97.50% branches and 99.11% functions, exceeding the unchanged 95/90/95 gates. All four modified handwritten runtime modules had 100% compiled-line coverage. New enum and manifest declarations were verified through hydration/type tests and the generated-file drift check. Packed import passed with 66 files; all 91 release-tool tests passed, and both dependency audits reported zero vulnerabilities.

Quality judgment: PASS. Focused cross-SDK security judgment: PASS. Reviewed 21-file package SHA-256: `8fb11daf93f352a77856c286af420b241dea271a303f9bd558b0d267ee89e797`, excluding this operation record. Non-blocking review suggestions were explicit v2 map-normalization tests and a narrower invalid-processing error assertion; the shared v3 path and pre-mutation rejection are covered.

Node 22 remains a CI-matrix check, not a locally claimed result. No production service, real user file or paid provider was used. The disposable PostgreSQL container was stopped and removed after combined verification.
