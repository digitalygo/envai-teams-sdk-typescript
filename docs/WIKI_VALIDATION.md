# Wiki V1 / contract 3 validation

## Chat attachments contract update (2026-10-20)

Current source schemas are pinned to backend commit `7192fc05ebec817bddc705186c8f195cc0dc5ec5`: 71 HTTP operations, 115 HTTP models and 29 ATP event types. The manifest separates exact upstream YAML/JSON schemas, the generated OpenAPI JSON representation, and shared synthetic attachment fixtures. Historical v2 provenance remains unchanged. See [chat attachments](CHAT_ATTACHMENTS.md) for conversion, context, retention and retry semantics. Publishing the SDK does not deploy the backend.

Local checks (Node 24.20.0, real disposable PostgreSQL 18): `npm run check` passed 309 tests with zero failures/skips; line coverage 99.81%, branch coverage 97.50%, function coverage 99.11%. `npm run check:package`, release-tooling checks, and dependency audits passed.

## Earlier validation records

The following counts and source pins describe earlier checkpoints.

Validated 2026-10-13 against TypeScript alpha baseline `402af49ec08e2977f297b598a655728be4d66827` (tree `4fb8d4664e43794d83a685ecbb6a4e5038090561`). Shared contracts are pinned to [Envai Teams `c27963d0848540679bccf30d2aeab354097b1a38`](https://github.com/digitalygo/envai-teams/commit/c27963d0848540679bccf30d2aeab354097b1a38), tree `898d7b58c5d10d2d79c160ab551830a2ae2e7196`.

All five shared schema files independently match the upstream tree's Git blob SHA, SHA-256 and byte length. `contracts/manifest.json` records those values. Original SDK v2 fixtures and their original provenance remain separately preserved. Current source schemas generate 65 HTTP operations, 109 HTTP models and 29 ATP event types. String aspect-ratio enums remain strings in YAML, generated JSON and TypeScript types.

## Results

- Node 22.23.3: **277 tests passed, zero failures/skips**, with real PostgreSQL 18.
- Node 24.19.0: **277 tests passed, zero failures/skips**, with real PostgreSQL 18.
- Aggregate runtime coverage: **99.73% lines, 97.42% branches, 99.03% functions**. Existing 95% line/function and 90% branch gates remain unchanged.
- Handwritten runtime delta: **404/406 changed compiled lines covered, 99.51%**. See [the line-level report](wiki-delta-coverage.json). The two uncovered lines are the defensive Node crypto key-construction catch. Generated declarations/operation metadata are excluded from this delta calculation. It is compiled-line coverage, not a statement-count claim.
- Clean `npm ci --ignore-scripts`, generated-file drift check, runtime build, example/type regression checks: passed.
- Package build/import smoke checks on Node 22 and 24: passed. The archive contains current/legacy/wiki schemas, PostgreSQL migration, migration/integration docs and all new exports.
- Existing release-tooling suite: **91 tests passed**; release-tooling and SDK dependency audits reported zero vulnerabilities.
- All workflow YAML passed actionlint; `git diff --check` passed. This repository has no separate configured source lint/format command.

## Behaviors exercised

- Default v3 selector, canonical `/atp/v3` namespace, positive capability/response acknowledgment, readonly v2 mode, old-server/preflight failure, version mismatch, old-server race and no ambiguous mutation retry/downgrade.
- Strict numeric legacy costs, opted-in nullable v3 cost-bearing events, immutable runtime selection and mixed historical/current replay with pinned reconnects. Original client-tool signature vectors remain unchanged.
- Atomic finite v2 replay: complete snapshot validation before any yield, 64 MiB configurable wire limit, wrong-chat/mixed/malformed/truncated tails, duplicate/backward/pre-cursor sequences, cancellation, no EOF reconnect and no partial prefix on failure. V3 remains incremental with its existing deduplication.
- Current and legacy completion reads, whole-page validation, recursive reserved legacy costs under usage, finite monetary projections, safe integer revisions, current-vs-immutable terminal cost reconciliation and exact production-code-path synthetic terminal fixtures.
- Actual captured control-plane source/pending-completion/legacy-completion HTTP payloads and acknowledgment headers hydrate through the typed SDK. Their separate provenance file records complete hashes.
- Source upload/status/download, explicit conversion states and retry diagnostics, immediate withdrawal, inbox/outbox/sync, operation polling, exhaustive category/range/type/revision reads, encoded scope IDs, explicit idempotency keys and no automatic mutation retries.
- File-backed Node upload at the inclusive 1,000,000,000-byte boundary, oversized rejection before a request, original filename/content fidelity, cancellation and polling timeout. The size-boundary fixture is sparse and never sent to a live service.
- Exact-byte domain-separated Ed25519 verification, POST/JSON content type, duplicate/malformed signing headers, canonical timestamp/base64url grammar, replay bounds, key metadata and unknown-key rotation, scope/identity binding and all event discriminators. Incoming provider HMAC and client-tool signatures are separate protocols.
- PostgreSQL atomic receipt/application-outbox enqueue, verification before SQL, rollback/retry, immutable collision detection, independent connection scopes, commit ambiguity and duplicate delivery after recreation.
- Eight independent PostgreSQL connections contend for one receipt; one accepts and seven deduplicate. Twenty additional eight-way contention rounds verify both uniqueness indexes. A real concurrent secondary-index conflict discovered during validation was fixed by handling either unique conflict and retaining the locked receipt hash check.

## Reproducing checks

Use a disposable PostgreSQL database. Integration tests create a uniquely named temporary schema and remove only that schema. Package constructors never run migrations; application deployment must explicitly apply `migrations/wiki-webhook-inbox.sql`.

```sh
npm ci --ignore-scripts
ENVAI_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/envai_test npm run check
npm run check:package
npm ci --ignore-scripts --prefix .github/release-tools
node .github/release-tools/patch-semantic-release.mjs
npm test --prefix .github/release-tools
npm audit --audit-level=high --prefix .github/release-tools
npm audit --audit-level=high
actionlint .github/workflows/*.yml
git diff --check
```

Run the matrix with Node 22 and 24. Without a PostgreSQL URL, the real-database test is explicitly skipped; that is not equivalent to the complete runs above. The CI workflow now provides PostgreSQL on both Node versions.

All service fixtures are synthetic. No paid provider call, production migration, credential provisioning, deployment, manual release or remote-history rewrite was performed by these local checks. Remote branch CI/release results are separate. Public-only Wiki V1 is supported; internal Decisions QUERY and artifact-writer capabilities are not represented by invented public SDK routes. See [migration](MIGRATION_V3.md) and [integration](WIKI.md).
