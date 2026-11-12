---
status: completed
created_at: 2026-11-12
files_edited:
  - README.md
  - contracts/manifest.json
  - contracts/openapi.json
  - contracts/openapi.yaml
  - docs/api-inventory.md
  - docs/api-reference.md
  - docs/getting-started.md
  - docs/streaming.md
  - scripts/check-package.mjs
  - scripts/generate.mjs
  - scripts/sdk-operations.json
  - src/client.ts
  - src/errors.ts
  - src/generated.ts
  - src/http.ts
  - src/index.ts
  - src/operations.ts
  - src/project-resources.ts
  - tests/http.test.mjs
  - tests/project-resources.test.mjs
  - tests/strict-http.test.mjs
  - tests/tenancy.test.mjs
  - tests/types.ts
  - tests/wiki-contract.test.mjs
rationale:
  - Expose the existing project-key API surface without adding human-session or financial-management rights.
  - Preserve typed reports, safe pagination, exact amounts and conservative mutation handling.
supporting_docs:
  - ../../../AGENTS.md
  - ../../../docs/api-reference.md
  - ../../../docs/api-inventory.md
  - ../../../contracts/manifest.json
  - https://github.com/digitalygo/1-1-5-envai-aaas/tree/ba021aa61e30e379880f809d45f90e5d3564d43e
---

# Project-resource SDK alignment

## Summary of changes

Aligned this SDK with backend `feature/user-company-projects`, pinned at
`ba021aa61e30e379880f809d45f90e5d3564d43e`. The working branch is
`feature/user-company-projects`, based on a clean, synchronized `alpha` at
`bfe1840a11d10f1ddde3f0325948e33b5772bfde`.

Added 14 operations: five project-skill operations, four manual cron operations,
project usage and logs, chat title updates, and workspace/chat deletion. The
reviewed inventory is 92 operations, including three existing locally rejected
API-key management stubs, against 146 server operations.

## Technical reasoning

The canonical schemas already described the project-key operations. The change
extends the reviewed allowlist and existing generator instead of introducing a
second client or exposing all administrative endpoints.

- Added grouped methods and typed report helpers for events, analytics and the
  event-type catalog. Numeric pagination stays on the configured origin,
  preserves filters and explicit start pages, honors cancellation and never
  follows response-provided links.
- Log lists use repeated bracketed query keys. Local validation rejects malformed
  lists, conflicting filters and invalid view combinations. An explicit project
  argument cannot be overridden by a filter object.
- Only exact empty arrays in log-entry `agent` and `data` are normalized to
  objects. Canonical schema bytes and unrelated validation remain unchanged.
- Workspace/chat deletion returns the HTTP 200 cleanup state, not a claim of
  physical purge. Cron/skill deletion returns HTTP 204. Mutations never retry or
  cancel protected work automatically after 409, 402 or 503 responses.
- Added `PaymentRequiredError` while preserving the existing base error contract.
  Provider configuration failures retain `ServerError` and their machine code.
- Existing title, cron and billing events remain typed. Billing notices are not
  terminals and may have null turn IDs before admission. Native tasks stay
  opt-in, and historical ATP v2 bytes stay frozen.
- Refreshed the OpenAPI source and derived artifacts, and pinned all six source
  contracts to the real backend repository and revision. Older captured fixture
  provenance remains historical.

Independent verification corrected two initial issues: a usage filter could
replace the explicit project argument, and iterator bounds admitted fractional
values. Regression tests now cover both cases. The generator's canonical
repository identity was also corrected and asserted by a provenance test.

## Impact assessment

These are unreleased source additions on top of the `1.0.0-alpha.5` baseline.
No version bump, dependency change, release, deployment, commit or push was
performed in this operation. Backend, PHP and unrelated repositories were not
modified by this SDK slice.

Human administration, financial management and public cron creation remain
excluded. Existing public methods and project-tool aliases remain compatible.
Money remains a decimal string per currency; unknown values are not fabricated.
Documentation distinguishes the new source surface from historical releases.

## Validation steps

The orchestrator independently ran:

- `npm run check`: deterministic generation, type checking and 468 tests passed,
  with zero skips, on Node 24.20.0 and isolated MySQL 8.4/PostgreSQL 18 databases.
- `npm run check:package`: packed import and exports passed, 98 packaged files.
- Coverage gates passed: 99.58% lines, 97.81% branches and 98.40% functions,
  exceeding the unchanged 95/90/95 thresholds. V8 coverage mapped through source
  maps covered 579 of 579 changed runtime lines. Type-only declarations have no
  executable lines.
- All six source snapshots matched the pinned backend bytes; frozen v2 matched
  the SDK baseline, and source hashes and operation counts were verified.
- Markdown structural checks, local links and `git diff --check` passed.
- Independent quality judgment: PASS. Independent security review: PASS.

Node 22 was not run locally. No live backend or paid-provider integration is
claimed. The reviewer noted that local skill-name checking can admit a trailing
newline which the backend rejects; server validation remains authoritative.

Evidence is retained locally in `/tmp/envai-sdk-typescript-leader-final.log`,
`/tmp/envai-sdk-typescript-leader-delta-coverage.json` and
`/tmp/envai-sdk-typescript-review-snapshot.json`. The reviewed non-trace
path-and-content SHA-256 is
`baad5a042b8d05f8eb454c2eba8462b2752301eb321ce4746af0831cb534e9a5`.

The backend advanced independently during verification, but its contracts,
request/resource definitions and routes remained unchanged relative to the pin.
Shared temporary test databases were isolated by SDK; their containers and
private connection files are removed at task closure.
