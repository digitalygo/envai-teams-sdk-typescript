# Installation and configuration

[README](../README.md) · [API reference](api-reference.md) · [Streaming](streaming.md) · [Client tools](client-tools.md)

## Install the release archive

Requires Node.js 22 or newer and npm. This is an ESM package for Node.js; browser and CommonJS support are not claimed. Use a supported, patched Node release.

[`v1.0.0-alpha.1`](https://github.com/digitalygo/envai-teams-sdk-typescript/releases/tag/v1.0.0-alpha.1) is a published GitHub prerelease. The package is not currently published to the npm registry. Install its package archive directly:

```sh
npm install "https://github.com/digitalygo/envai-teams-sdk-typescript/releases/download/v1.0.0-alpha.1/digitalygo-envai-client-1.0.0-alpha.1.tgz"
```

The pinned archive below is the historical pre-Wiki release. Wiki V1 requires an alpha artifact containing this contract-3 change.

The archive installs `@digitalygo/envai-client` version `1.0.0-alpha.1`. Prerelease APIs may change; commit your application's lock file and review upgrades deliberately. The release asset's SHA-256 is `a8e8a5b539f2d3a00b27a4ff8643a675859e12a1fa8f78a80bdf63f4ab6f67eb`.

## Build from public source instead

```sh
git clone --branch v1.0.0-alpha.1 https://github.com/digitalygo/envai-teams-sdk-typescript.git
cd envai-teams-sdk-typescript
npm ci --ignore-scripts
npm run build
npm pack
```

The package name is `@digitalygo/envai-client`. Install the `.tgz` filename printed by `npm pack` into your application with `npm install /absolute/path/to/that-file.tgz`. Use the actual filename rather than assuming a version. The release tag gives a repeatable source checkout. For unreleased changes, explicitly choose the moving `alpha` branch or a reviewed commit SHA instead.

The packed package contains runtime code, TypeScript declarations, contract schemas, README, and license. Full source guides and runnable examples are in this GitHub repository. In your application, import from `@digitalygo/envai-client`; the repository examples import local source so they can be typechecked together.

## Configure a client

`new EnvaiClient(options)` makes no network call and does not read environment variables. Supply a trusted `baseUrl` and `apiKey` explicitly. An origin-only URL gets `/api/v1`; an explicit path is the complete API prefix. Do not include URL credentials, query, or fragment. Use HTTPS in production; HTTP is accepted for intentional local development and is not upgraded automatically.

| Option | Default / behavior |
| --- | --- |
| `contractVersion` | `3`; use `2` only for explicit historical read-only access. |
| `baseUrl` | Required trusted API URL. |
| `apiKey` | Explicit bearer key for authenticated operations; omitted on public/signed operations. |
| `jwksUrl` | Origin-level `/.well-known/jwks.json`; override only with a trusted signing-key endpoint. |
| `requestTimeoutMs` | 30,000 ms for ordinary request/JSON-body handling. |
| `streamConnectTimeoutMs` | 15,000 ms. |
| `retry` | Two eligible GET retries, 250 ms base delay, 30,000 ms maximum delay. |
| `fetch` | Native Fetch by default; supply a compatible implementation for mocks/routing. It must honor signals and manual redirects. |
| `onObservation` | Structural lifecycle/ID/status events, excluding bodies and secrets. |
| `jwksCacheTtlMs` | Five-minute cache; `jwksCache` may supply an application-owned `JwksSource`. |

Never commit API keys, log signed artifact URLs, or expose private `ProtocolError.raw` data indiscriminately. Reuse the client and provide an `AbortSignal` for bounded workflows and caller-managed binary reads.

## Run the examples

From the repository checkout, compile examples with the existing TypeScript configuration:

```sh
npm run typecheck
npx --no-install tsc -p tsconfig.examples.json --noEmit false --outDir .example-build
node -e "require('node:fs').cpSync('contracts', '.example-build/contracts', { recursive: true })"
node .example-build/examples/quickstart.js
```

Before running, set `ENVAI_BASE_URL`, `ENVAI_API_KEY`, and an existing `ENVAI_TEAM_ID`. The quickstart creates a workspace/chat and sends a real, potentially billable turn. It prints the terminal status and does not delete the created resources. Ctrl-C stops local work; it does not implicitly cancel the remote turn.

For the harmless echo handler, additionally set `ENVAI_CHAT_ID` and `ENVAI_ACCOUNT_SCOPE`, configure the remote tool/agent as described in [client tools](client-tools.md), then run `node .example-build/examples/client-tools.js`. `ENVAI_REGISTER_TOOLS=1` explicitly opts into first-time remote tool creation. Leave it unset for an already registered tool. The example memory store is not suitable for production side effects.

The supported `PostgresToolStateStore` accepts your database connection and uses an explicit reviewed migration. CI exercises it against PostgreSQL 18 and SQL test doubles. Local database tests require `ENVAI_TEST_PG_URL` pointing to a disposable test database; the SDK creates no schema automatically.

## Offline verification

```sh
npm run check
npm run check:package
```

The suite verifies generated files, types, HTTP operations, schemas, SSE, signatures, state transitions, examples, coverage, and a packed-package import. Tests do not contact an Envai deployment or use account credentials. The example tests replace Fetch with offline responses. This verifies client behavior, not your deployment's availability or feature configuration.

