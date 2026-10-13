import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chatId, turnId, event, json, sse } from './helpers.mjs';

const build = mkdtempSync(resolve('.examples-test-'));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.examples.json', '--noEmit', 'false', '--outDir', build]);
cpSync('contracts', resolve(build, 'contracts'), { recursive: true });
after(() => rmSync(build, { recursive: true, force: true }));

for (const example of ['quickstart', 'client-tools']) {
 test(`public ${example} example runs with offline Fetch`, async t => {
  const oldEnv = { ...process.env };
  const originalListeners = process.listeners('SIGINT');
  const calls = [];
  Object.assign(process.env, {
   ENVAI_BASE_URL: 'https://example.test/api/v1', ENVAI_API_KEY: 'example-fixture',
   ENVAI_TEAM_ID: 'team-example', ENVAI_CHAT_ID: chatId, ENVAI_ACCOUNT_SCOPE: 'example/account',
  });
  delete process.env.ENVAI_REGISTER_TOOLS;
  t.after(() => {
   process.env = oldEnv;
   for (const listener of process.listeners('SIGINT')) {
    if (!originalListeners.includes(listener)) process.removeListener('SIGINT', listener);
   }
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
   const path = new URL(url).pathname;
   calls.push({ path, method: init.method });
   assert.equal(new Headers(init.headers).get('authorization'), 'Bearer example-fixture');
   if (path.endsWith('/events')) return sse([
    event('ping', 0), event('turn.started', 1), event('agent.text.delta', 2), event('turn.completed', 3),
   ]);
   if (path.endsWith('/messages')) return json({ status: 'accepted', turn_id: turnId }, 202);
   if (path.endsWith('/workspaces')) return json({ data: { id: 'ws-example' } }, 201);
   if (path.endsWith('/chats')) return json({ data: { id: chatId } }, 201);
   throw new Error(`Unexpected example request: ${init.method} ${path}`);
  });
  await import(pathToFileURL(resolve(build, 'examples', example + '.js')).href);
  assert.equal(calls.filter(call => call.path.endsWith('/messages')).length, 1);
  assert.ok(calls.findIndex(call => call.path.endsWith('/events')) < calls.findIndex(call => call.path.endsWith('/messages')));
  assert.ok(calls.every(call => !call.path.endsWith('/tools')), 'registration requires explicit opt-in');
 });
}
