# Portable definitions and synchronization

Definitions are explicit account-scoped configuration. Importing modules or constructing a client never synchronizes remote resources. JSON manifests use `format_version: "1"` and object maps `tools`, `agents`, and `teams`. Client tools are keyed by their immutable name; agents and teams use local keys. Team orchestrators and members refer to agent local keys until synchronization resolves remote IDs.

```ts
import {
  EnvaiClient, loadDefinitions, FileDefinitionStateStore,
  ClientDefinitionRemote, DefinitionSynchronizer,
} from '@digitalygo/envai-client';

const manifest = await loadDefinitions('./definitions');
const store = new FileDefinitionStateStore('./state/definitions.json');
await store.initialize(); // Explicit provisioning; existing state is validated.
const client = new EnvaiClient({baseUrl: process.env.ENVAI_BASE_URL!, apiKey: process.env.ENVAI_API_KEY!});
const sync = new DefinitionSynchronizer('production-account', store, new ClientDefinitionRemote(client), manifest);
const plan = await sync.plan(); // Reads only.
console.log(plan);
// Invoke explicitly after reviewing the plan:
const report = await sync.sync();
if (!report.manifest_ready) throw new Error('Definitions require attention');
const teamId = await sync.team('support');
```

`loadDefinitions` reads a JSON manifest or a directory containing `manifest.json` and optional `agents/*.md` with YAML frontmatter. `compileDefinitions` accepts a plain object, while `compileAgentMarkdown` supports individual Markdown inputs. The compiler normalizes tool name sets, preserves ordered team members and JSON null/object/array distinctions, checks local references, and rejects unsupported `max_tokens`. Synchronization checks the live model catalog and fails closed when it is unavailable.

Planning compares desired definitions, durable last-applied state, and current remote state. Drift requires `overwriteDrift`; unmanaged resources require `adopt`; missing managed resources require `recreateMissing`; deletion requires `prune`. Concurrent desired and remote changes remain conflicts. Adoption without overwrite records actual remote content and does not mark a differing desired manifest ready. Creation follows tool/agent/team dependencies; pruning reverses that order. Successful partial progress persists even when a later operation fails.

State records a mutation intent before sending it. A lost response triggers readback, never an unconditional retry. An unresolved intent remains blocked across process restarts until its outcome is reconciled. Resolve remote ambiguity and inspect state before retrying; never delete state or a lock merely to force a second create. A failed or blocked apply invalidates previous readiness. `requireSynchronized`, `team`, `agent`, and `tool` guard access by manifest hash. `gate` offers explicit readiness policies and TTL checks; lazy synchronization must be chosen deliberately.

The file store uses private atomic files and a process lock; crash locks require operator inspection. Use `PostgresDefinitionStateStore` with a caller-owned database pool for distributed instances; provision its documented schema explicitly. `MemoryDefinitionStateStore` is ephemeral and intended for isolated development/tests. Use a stable nonsecret connection scope unique to an account/environment. Keep state files private, durable, and out of version control.

## CLI

The package installs `envai-definitions`. Commands are `validate`, `plan`, `sync`, `status`, and `state`:

```sh
envai-definitions validate --manifest ./definitions --json
envai-definitions plan --manifest ./definitions --scope production --state ./state/definitions.json
envai-definitions sync --manifest ./definitions --scope production --state ./state/definitions.json --dry-run
```

Remote commands use `ENVAI_BASE_URL` and `ENVAI_API_KEY`. Optional defaults are `ENVAI_DEFINITIONS`, `ENVAI_DEFINITION_SCOPE`, and `ENVAI_DEFINITION_STATE`. `--env staging` selects the equivalent `ENVAI_STAGING_*` variables without falling back to another account. `--only tools|agents|teams|all` limits scope. Explicit mutation options are `--adopt`, `--overwrite-drift`, `--recreate-missing`, and `--prune`. `--fail-on-drift` makes drift exit with code 2; blocked plans/sync also exit 2. Failed/ambiguous sync exits 1. Fresh resources needing creation are not drift. `--json` emits compact JSON. Failures print a redacted diagnostic.

Validate is entirely local. Plan/status/state and dry-run do not create missing state files or mutate remote resources. A real sync explicitly provisions file state. No command invokes an LLM, starts a chat, or publishes a release. The programmatic `runDefinitionsCli` entry point accepts an argument array, environment mapping, and output handlers for embedding or testing.

For database-backed CLI state, pass `--store ./definition-store.mjs` (or `ENVAI_DEFINITION_STORE`). This explicitly imports your local module, which exports `createDefinitionStateStore(environment)` returning a `DefinitionStateStore`, synchronously or asynchronously. Construct the PostgreSQL or SQL adapter with your installed driver in that factory; provision schema separately. The CLI never creates a file state alongside a custom store. The factory receives the supplied environment mapping and owns pool configuration/lifetime; use a bounded idle timeout or an unreferenced pool so a command can exit. Only load trusted local code. This extension keeps database drivers optional and also supports application-owned storage integration.

## SQLite and MySQL state

`SQLiteDefinitionStateStore` and `MySQLDefinitionStateStore` implement the same
`DefinitionStateStore` interface through caller-owned driver connections. The SDK
opens no database, installs no driver and executes no DDL automatically. Apply the
statements returned by `definitionSQLSchema('sqlite' | 'mysql')` explicitly through
your migration system before use.

For Node's built-in SQLite (Node 22.13+), create a separate connection for each
checked-out session:

```ts
import { DatabaseSync } from 'node:sqlite';
import { SQLiteDefinitionStateStore, sqliteDefinitionConnection } from '@digitalygo/envai-client';
const store = new SQLiteDefinitionStateStore({
  async connect() {
    const database = new DatabaseSync('/private/envai-state.sqlite');
    return sqliteDefinitionConnection(database, () => database.close());
  },
});
```

For a caller-installed `mysql2/promise` pool:

```ts
import { createPool } from 'mysql2/promise';
import { MySQLDefinitionStateStore, mysqlDefinitionConnection } from '@digitalygo/envai-client';
const pool = createPool(process.env.ENVAI_STATE_DSN!);
const store = new MySQLDefinitionStateStore({
  async connect() { return mysqlDefinitionConnection(await pool.getConnection()); },
});
// The application owns pool.end() after all synchronization has finished.
```

Other drivers can implement `DefinitionDatabasePool` directly: parameterized
`query(sql, values)` returns `{ rows, rowCount }`, and `release()` returns the
exclusive checked-out connection. Queries use `?` placeholders. Connections must
use autocommit outside the explicit checkpoint transactions. SQLite connections
must share the same local database file; SQLite is not a multi-host database.

For CLI use, export `createDefinitionStateStore(env)` from your provider module
and select it using `--store /absolute/path/provider.mjs`. Return a store built
with the configured driver and credentials; never serialize credentials into the
connection scope, manifest, state, or CLI output.

SQL stores commit unique scope/owner lock rows before planning. Locks have no
automatic expiry or takeover: a crashed process leaves an abandoned row that
blocks further applies. After verifying the process is gone and reconciling its
remote effects, an operator may remove that exact scope/owner row from
`envai_definition_locks`. Every checkpoint verifies ownership inside its database
transaction; owner loss aborts the write. Failed checkpoints roll back while
previous successful mutation mappings remain durable. Read-only operations and
failed callbacks release locks; escaped sessions cannot be reused afterward.
Use `lockTimeoutMs` to bound contention waits and `pollIntervalMs` to tune polling.
Neither option allows lock stealing or automatic retries of remote mutations.

Portable selectors `ENVAI_DEFINITIONS_PATH`, `ENVAI_CONNECTION`, `ENVAI_STATE_PATH` and `ENVAI_STATE_DRIVER` are also accepted. The driver is `file`, explicit ephemeral `memory`, or a local provider module path. `--path` aliases `--manifest`, and `--connection` aliases `--scope`. Machine-readable output includes `format_version: "1"`.

MySQL scope columns must be `VARBINARY(191)` in both state and lock tables. This
keeps case, accents and trailing spaces distinct. Each scope acquisition checks
existing column types and fails before locking or state access when an older
text/collation-based schema is present. Migrate such schemas explicitly; the SDK
never silently reuses or converts them. Inspect potentially colliding historical
scope identities before migration.

For PostgreSQL custom pool adapters, `release(error)` must discard an uncertain
connection rather than return it to the pool (the standard `pg` pool does this).
The store supplies an error when advisory lock acquisition or release cannot be
confirmed. Memory, file and SQL sessions serialize concurrent operations and
expire after their `withScope` callback completes.
