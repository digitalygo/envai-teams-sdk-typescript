#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnvaiClient } from './client.js';
import { ClientDefinitionRemote } from './definition-client.js';
import { FileDefinitionStateStore, MemoryDefinitionStateStore, type DefinitionStateStore } from './definition-state.js';
import { DefinitionSynchronizer, type DefinitionSyncOptions } from './definition-sync.js';
import { loadDefinitions, manifestHash } from './definitions.js';

export interface DefinitionsCliIO { out(text: string): void; err(text: string): void; }
/** Explicit entry point. Importing this module performs no I/O or synchronization. */
export async function runDefinitionsCli(args: string[], env: NodeJS.ProcessEnv = process.env, io: DefinitionsCliIO = { out: text => process.stdout.write(text), err: text => process.stderr.write(text) }): Promise<number> {
  try {
    const [command, ...flags] = args;
    if (!command || !['validate','plan','sync','status','state'].includes(command)) throw new Error('Invalid command');
    const values: Record<string,string> = {};
    const switches = new Set<string>();
    for (let i = 0; i < flags.length; i++) {
      const original = flags[i]!; const flag = ({'--connection':'--scope','--path':'--manifest'} as Record<string,string>)[original] ?? original;
      if (['--json','--strict-validation','--dry-run','--adopt','--overwrite-drift','--recreate-missing','--prune','--fail-on-drift'].includes(flag)) switches.add(flag);
      else if (['--manifest','--state','--scope','--env','--only','--store'].includes(flag)) {
        const value = flags[++i]; if (!value || value.startsWith('--') || values[flag]) throw new Error('Invalid option'); values[flag] = value;
      } else throw new Error('Unknown option');
    }
    if (values['--env'] && !/^[a-zA-Z0-9_]+$/.test(values['--env'])) throw new Error('Invalid environment selector');
    const prefix = values['--env'] ? `ENVAI_${values['--env'].toUpperCase()}_` : 'ENVAI_';
    const manifest = await loadDefinitions(values['--manifest'] ?? env[`${prefix}DEFINITIONS_PATH`] ?? env[`${prefix}DEFINITIONS`] ?? 'manifest.json');
    const emit = (result: unknown) => io.out(`${JSON.stringify(result, null, switches.has('--json') ? undefined : 2)}\n`);
    if (command === 'validate') { emit({ format_version:'1', status: 'valid', manifest_hash: manifestHash(manifest) }); return 0; }
    const scope = values['--scope'] ?? env[`${prefix}CONNECTION`] ?? env[`${prefix}DEFINITION_SCOPE`];
    if (!scope) throw new Error('An explicit nonsecret connection scope is required');
    const path = values['--state'] ?? env[`${prefix}STATE_PATH`] ?? env[`${prefix}DEFINITION_STATE`] ?? '.envai/definitions.json';
    const file = new FileDefinitionStateStore(path);
    let store: DefinitionStateStore = file;
    const driver = env[`${prefix}STATE_DRIVER`];
    const storeModule = values['--store'] ?? env[`${prefix}DEFINITION_STORE`] ?? (driver && !['file','memory'].includes(driver) ? driver : undefined);
    if (storeModule) {
      const factory = await import(pathToFileURL(resolve(storeModule)).href) as { createDefinitionStateStore?: (environment: NodeJS.ProcessEnv) => Promise<DefinitionStateStore> | DefinitionStateStore };
      if (typeof factory.createDefinitionStateStore !== 'function') throw new Error('State module must export createDefinitionStateStore');
      store = await factory.createDefinitionStateStore(env);
      if (!store || typeof store.withScope !== 'function') throw new Error('Invalid state store');
    } else if (driver === 'memory') store = new MemoryDefinitionStateStore();
    else if (command === 'sync' && !switches.has('--dry-run')) await file.initialize();
    else { try { await access(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; store = new MemoryDefinitionStateStore(); } }
    if (command === 'state') { emit({format_version:'1',...await store.withScope(scope, session => session.read())}); return 0; }
    const baseUrl = env[`${prefix}BASE_URL`], apiKey = env[`${prefix}API_KEY`];
    if (!baseUrl || !apiKey) throw new Error('Connection configuration is required');
    const strictSetting = env[`${prefix}STRICT_VALIDATION`];
    if(strictSetting !== undefined && !['true','false'].includes(strictSetting)) throw new Error('STRICT_VALIDATION must be true or false');
    const client = new EnvaiClient({ baseUrl, apiKey, strictValidation: switches.has('--strict-validation') || strictSetting === 'true' });
    const synchronizer = new DefinitionSynchronizer(scope, store, new ClientDefinitionRemote(client), manifest);
    const only = values['--only'];
    if (only && !['all','tools','agents','teams'].includes(only)) throw new Error('Invalid resource selection');
    const options: DefinitionSyncOptions = { adopt: switches.has('--adopt'), overwriteDrift: switches.has('--overwrite-drift'), recreateMissing: switches.has('--recreate-missing'), prune: switches.has('--prune'), dryRun: switches.has('--dry-run'), failOnDrift: switches.has('--fail-on-drift'), ...(only ? { scope: only as NonNullable<DefinitionSyncOptions['scope']> } : {}) };
    if (command === 'sync') { const report = await synchronizer.sync(options); emit(report); return report.status === 'blocked' || options.failOnDrift && report.plan.operations.some(operation => ['drift','conflict'].includes(operation.classification)) ? 2 : ['succeeded','dry_run'].includes(report.status) ? 0 : 1; }
    const plan = await synchronizer.plan(options); emit(plan);
    return plan.operations.some(operation => operation.blocking || options.failOnDrift && ['drift','conflict'].includes(operation.classification)) ? 2 : 0;
  } catch (error) { if (error instanceof Error && error.name === 'DefinitionDriftError' && 'plan' in error) { io.out(`${JSON.stringify({format_version:'1',status:'drift',plan:error.plan})}\n`); return 2; } io.err('Definition command failed; check arguments, configuration, definitions, and state. No credentials are printed.\n'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runDefinitionsCli(process.argv.slice(2));
