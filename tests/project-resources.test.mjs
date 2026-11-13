import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  EnvaiClient, operations, HttpTransport, CompatibilityError, EnvaiError, PaymentRequiredError,
  AuthenticationError, AccessDeniedError, NotFoundError, ConflictError, ValidationError, RateLimitError,
  ServerError, ProtocolError, parseEvent, isTerminal, knownEventTypes, isProjectResourceOperation,
  validateProjectResourceRequest, validateUsageQuery, validateLogQuery, projectUsageParams, projectLogParams, prepareProjectLogResponse,
} from '../dist/index.js';
import { json } from './helpers.mjs';

const baseUrl = 'https://example.test';
const apiKey = 'project-test-key';
const ids = {
  workspace_id: 'wsp_01j5abcdefghjkmnpqrstvwxyz',
  chat_id: 'cht_01j5abcdefghjkmnpqrstvwxyz',
  cron_id: 'cron_01j5abcdefghjkmnpqrstvwxyz',
  project_id: 'prj_01j5abcdefghjkmnpqrstvwxyz',
  other_project_id: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  skill_id: 'psk_01j5abcdefghjkmnpqrstvwxyz',
  team_id: 'team_01j5abcdefghjkmnpqrstvwxyz',
  api_key_id: 'key_01j5abcdefghjkmnpqrstvwxyz',
  completion_id: 'cmpl_01j5abcdefghjkmnpqrstvwxyz',
  occurrence_id: 'occ_01j5abcdefghjkmnpqrstvwxyz',
  event_id: 'evt_01j5abcdefghjkmnpqrstvwxyz',
};
const spec = JSON.parse(readFileSync(new URL('../contracts/openapi.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../contracts/manifest.json', import.meta.url), 'utf8'));
const canonical = Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method: method.toUpperCase(), op })));
const findSpec = id => canonical.find(entry => entry.op?.operationId === id);
const sha256 = path => createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex');
const noContent = () => new Response(null, { status: 204, headers: { 'X-Envai-Contract-Version': '3' } });
const fixed = (payload, status = 200) => () => status === 204 ? noContent() : json(payload, status, { 'X-Envai-Contract-Version': '3', 'x-request-id': 'req-ok' });
const sequence = (...responses) => (_url, _init, index) => responses[index];
function makeClient(handler, options = {}) {
  const calls = [];
  const client = new EnvaiClient({
    baseUrl, apiKey, strictValidation: options.strictValidation ?? false,
    retry: options.retry ?? { maxRetries: 0, baseDelayMs: 0 },
    contractVersion: options.contractVersion ?? 3,
    fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length - 1); },
  });
  return { client, calls };
}
const urlOf = call => new URL(call.url);
const pathOf = call => urlOf(call).pathname;
const queryOf = call => urlOf(call).searchParams;
const chat = {
  id: ids.chat_id, workspace_id: ids.workspace_id, project_id: ids.project_id,
  created_by_user_id: null, team_id: ids.team_id, title: null,
  created_at: '2026-11-10T09:00:00+00:00', updated_at: '2026-11-10T09:00:00+00:00',
};
const cron = {
  id: ids.cron_id, workspace_id: ids.workspace_id, origin_chat_id: ids.chat_id,
  team_id: ids.team_id, target_mode: 'same_chat', prompt: 'Summarize the last week of traffic',
  interval_minutes: 15, daily_at: null, timezone: 'UTC', start_at: null, repeat_count: null, until: null,
  status: 'active', scheduled_count: 0, delivery_count: 0,
  next_due_at: '2026-11-11T09:15:00+00:00', max_until: '2026-12-10T09:00:00+00:00',
  created_at: '2026-11-10T09:00:00+00:00', updated_at: '2026-11-10T09:00:00+00:00',
};
const skill = {
  id: ids.skill_id, project_id: ids.project_id, created_by_user_id: null,
  name: 'incident_response', description: 'Safe incident handling',
  content: '# Incident response\n\nEscalate after triage.\n',
  created_at: '2026-11-10T09:00:00+00:00', updated_at: '2026-11-10T09:00:00+00:00',
};
const cleanup = (resource_type, resource_id) => ({
  resource_type, resource_id, cleanup: [{
    id: 'cln_01j5abcdefghjkmnpqrstvwxyz', kind: resource_type, status: 'pending', attempts: 0,
    deadline_at: null, started_at: null, finished_at: null, last_error_code: null,
  }],
});
const links = (resource, lastPage) => ({
  first: `${baseUrl}/api/v1/projects/${ids.project_id}/${resource}?page=1`,
  last: `${baseUrl}/api/v1/projects/${ids.project_id}/${resource}?page=${lastPage}`,
  prev: null,
  next: `https://remote.invalid/api/v1/projects/${ids.other_project_id}/${resource}?page=2`,
  future_link: 'kept',
});
const meta = (currentPage, lastPage) => ({
  current_page: currentPage, from: currentPage, last_page: lastPage,
  per_page: 25, to: currentPage, total: 2, future_meta: 7,
});
const usageKey = {
  api_key_id: ids.api_key_id, totals: [{ currency: 'USD', amount: '0' }],
  invocation_count: 0, unknown_invocations: 0, not_submitted_invocations: 0,
  completion_count: 0, unknown_currency_observations: 1,
};
const usageDay = {
  date: '2026-10-10',
  totals: [{ currency: 'EUR', amount: '0.100000000000' }, { currency: 'USD', amount: '1.250000000000' }],
  invocation_count: 0, unknown_invocations: 1, not_submitted_invocations: 0, completion_count: 0,
  by_api_key: [usageKey],
  media: {
    totals: [{ currency: 'USD', amount: '2.500000000000' }], priced_observations: 2,
    unknown_observations: 1, unknown_currency_observations: 1, by_api_key: [usageKey],
  },
  by_project: null, future_marker: 'kept',
};
const usagePage = (currentPage, lastPage) => ({ data: [usageDay], links: links('usage', lastPage), meta: meta(currentPage, lastPage) });
const logEntry = {
  id: ids.event_id, project_id: ids.project_id, api_key_id: null, actor_api_key_id: null,
  chat_id: ids.chat_id, workspace_id: ids.workspace_id, seq: 0, turn_id: null,
  type: 'agent.started', ts: '2026-10-10T12:00:00Z', agent: [], data: [], future_marker: 'kept',
};
const logPage = (currentPage, lastPage) => ({ data: [logEntry], links: links('logs', lastPage), meta: meta(currentPage, lastPage) });
const normalizedLogPage = (currentPage, lastPage) => ({ ...logPage(currentPage, lastPage), data: [{ ...logEntry, agent: {}, data: {} }] });
const dailyCounts = date => ({
  date, event_count: 0, tool_start_count: 0, file_read_start_count: 0,
  turn_failure_count: 0, agent_failure_count: 0, tool_failure_count: 0,
});
const durationDistribution = () => {
  const bounds = [0, 100, 500, 1000, 2000, 5000, 10000, 30000];
  return {
    candidate_count: 0, sample_count: 0, missing_count: 0, invalid_count: 0, zero_count: 0,
    min_ms: null, max_ms: null, avg_ms: null, p50_ms: null, p95_ms: null,
    buckets: bounds.map((lower_ms, index) => ({ lower_ms, upper_ms: bounds[index + 1] ?? null, count: 0 })),
  };
};
const analytics = {
  window: { from: '2026-10-01', to: '2026-10-10', timezone: 'UTC', api_key_id: ids.api_key_id, chat_id: ids.chat_id },
  coverage: {
    source: 'retained_chat_events', aggregation: 'all_retained_matching_rows',
    execution_history_complete: false, configured_retention_days: 30, observed_event_count: 0,
    oldest_observed_at: null, newest_observed_at: null,
  },
  daily: [dailyCounts('2026-10-01'), dailyCounts('2026-10-02')],
  event_types: { items: [], other_count: 0, omitted_group_count: 0 },
  tools: { items: [], other_count: 0, omitted_group_count: 0, missing_name_count: 0 },
  failures: { turn_event_count: 0, agent_event_count: 0, tool_event_count: 0, tool_result_unknown_status_count: 0 },
  durations: { tool_execution: durationDistribution(), turn_execution: durationDistribution() },
  file_reads: ['read', 'wiki_read', 'skill_read', 'wiki_read_source', 'wiki_read_artifact'].map(tool_name => ({ tool_name, count: 0 })),
};
const catalog = { data: { types: ['agent.started', 'turn.completed'] } };
const operationCases = [
  { id: 'deleteWorkspace', method: 'DELETE', path: '/workspaces/{workspace_id}', expectedPath: `/api/v1/workspaces/${ids.workspace_id}`, params: { workspace_id: ids.workspace_id }, status: 200, payload: { data: cleanup('workspace', ids.workspace_id) }, result: cleanup('workspace', ids.workspace_id) },
  { id: 'updateChat', method: 'PUT', path: '/workspaces/{workspace_id}/chats/{chat_id}', expectedPath: `/api/v1/workspaces/${ids.workspace_id}/chats/${ids.chat_id}`, params: { workspace_id: ids.workspace_id, chat_id: ids.chat_id, body: { title: 'Q3 rollout plan' } }, status: 200, payload: { data: { ...chat, title: 'Q3 rollout plan' } }, result: { ...chat, title: 'Q3 rollout plan' } },
  { id: 'deleteChat', method: 'DELETE', path: '/workspaces/{workspace_id}/chats/{chat_id}', expectedPath: `/api/v1/workspaces/${ids.workspace_id}/chats/${ids.chat_id}`, params: { workspace_id: ids.workspace_id, chat_id: ids.chat_id }, status: 200, payload: { data: cleanup('chat', ids.chat_id) }, result: cleanup('chat', ids.chat_id) },
  { id: 'listChatCrons', method: 'GET', path: '/workspaces/{workspace_id}/crons', expectedPath: `/api/v1/workspaces/${ids.workspace_id}/crons`, params: { workspace_id: ids.workspace_id, origin_chat_id: ids.chat_id, status: 'active' }, status: 200, payload: { data: [cron] }, result: [cron] },
  { id: 'getChatCron', method: 'GET', path: '/workspaces/{workspace_id}/crons/{cron_id}', expectedPath: `/api/v1/workspaces/${ids.workspace_id}/crons/${ids.cron_id}`, params: { workspace_id: ids.workspace_id, cron_id: ids.cron_id }, status: 200, payload: { data: cron }, result: cron },
  { id: 'updateChatCron', method: 'PATCH', path: '/workspaces/{workspace_id}/crons/{cron_id}', expectedPath: `/api/v1/workspaces/${ids.workspace_id}/crons/${ids.cron_id}`, params: { workspace_id: ids.workspace_id, cron_id: ids.cron_id, body: { target_mode: 'new_chat', prompt: 'Updated', interval_minutes: null, daily_at: null, timezone: null, start_at: null, repeat_count: null, until: null } }, status: 200, payload: { data: { ...cron, target_mode: 'new_chat' } }, result: { ...cron, target_mode: 'new_chat' } },
  { id: 'deleteChatCron', method: 'DELETE', path: '/workspaces/{workspace_id}/crons/{cron_id}', expectedPath: `/api/v1/workspaces/${ids.workspace_id}/crons/${ids.cron_id}`, params: { workspace_id: ids.workspace_id, cron_id: ids.cron_id }, status: 204, payload: undefined, result: undefined },
  { id: 'listProjectSkills', method: 'GET', path: '/projects/{project_id}/skills', expectedPath: `/api/v1/projects/${ids.project_id}/skills`, params: { project_id: ids.project_id }, status: 200, payload: { data: [skill] }, result: [skill] },
  { id: 'createProjectSkill', method: 'POST', path: '/projects/{project_id}/skills', expectedPath: `/api/v1/projects/${ids.project_id}/skills`, params: { project_id: ids.project_id, body: { name: 'incident_response', content: '# Incident response\n', description: null } }, status: 201, payload: { data: skill }, result: skill },
  { id: 'getProjectSkill', method: 'GET', path: '/projects/{project_id}/skills/{skill_id}', expectedPath: `/api/v1/projects/${ids.project_id}/skills/${ids.skill_id}`, params: { project_id: ids.project_id, skill_id: ids.skill_id }, status: 200, payload: { data: skill }, result: skill },
  { id: 'updateProjectSkill', method: 'PUT', path: '/projects/{project_id}/skills/{skill_id}', expectedPath: `/api/v1/projects/${ids.project_id}/skills/${ids.skill_id}`, params: { project_id: ids.project_id, skill_id: ids.skill_id, body: { description: null, content: '  # Updated  \n' } }, status: 200, payload: { data: { ...skill, description: null, content: '  # Updated  \n' } }, result: { ...skill, description: null, content: '  # Updated  \n' } },
  { id: 'deleteProjectSkill', method: 'DELETE', path: '/projects/{project_id}/skills/{skill_id}', expectedPath: `/api/v1/projects/${ids.project_id}/skills/${ids.skill_id}`, params: { project_id: ids.project_id, skill_id: ids.skill_id }, status: 204, payload: undefined, result: undefined },
  { id: 'getProjectUsage', method: 'GET', path: '/projects/{project_id}/usage', expectedPath: `/api/v1/projects/${ids.project_id}/usage`, params: { project_id: ids.project_id, from: '2026-10-01', to: '2026-10-10', api_key_id: ids.api_key_id, page: 2, per_page: 25 }, status: 200, payload: usagePage(2, 2), result: usagePage(2, 2) },
  { id: 'getProjectLogs', method: 'GET', path: '/projects/{project_id}/logs', expectedPath: `/api/v1/projects/${ids.project_id}/logs`, params: { project_id: ids.project_id, view: 'events', from: '2026-10-01', to: '2026-10-10', 'types[]': ['agent.started'], page: 1, per_page: 25 }, status: 200, payload: logPage(1, 1), result: normalizedLogPage(1, 1) },
];

test('all 14 project-key operations match canonical path, method, auth, body and envelope', async () => {
  for (const strictValidation of [false, true]) for (const entry of operationCases) {
    const specEntry = findSpec(entry.id);
    assert.ok(specEntry, entry.id);
    assert.equal(specEntry.method, entry.method);
    assert.equal(specEntry.path, entry.path);
    assert.ok(specEntry.op.security.some(scheme => Object.hasOwn(scheme, 'bearerAuth')));
    assert.ok(Object.hasOwn(specEntry.op.responses, String(entry.status)));
    assert.equal(operations[entry.id].method, entry.method);
    assert.equal(operations[entry.id].path, entry.path);
    assert.equal(operations[entry.id].public, false);
    assert.equal(operations[entry.id].bodyRequired, !!specEntry.op.requestBody?.required);
    if (entry.status === 204) assert.equal(operations[entry.id].mode, 'empty');
    const { client, calls } = makeClient(fixed(entry.payload, entry.status), { strictValidation });
    const actual = await client[entry.id](entry.params);
    assert.equal(calls.length, 1, entry.id);
    const call = calls[0];
    assert.equal(urlOf(call).origin, baseUrl);
    assert.equal(pathOf(call), entry.expectedPath);
    assert.equal(call.init.method, entry.method);
    assert.equal(call.init.headers.get('authorization'), `Bearer ${apiKey}`);
    assert.equal(call.init.headers.get('x-envai-project-id'), null);
    if (entry.params.body === undefined) assert.equal(call.init.body, undefined);
    else assert.deepEqual(JSON.parse(call.init.body), entry.params.body);
    assert.deepEqual(actual, entry.result);
  }
});

test('generated convenience groups preserve flat aliases and expose no automatic recovery methods', () => {
  const client = new EnvaiClient({ baseUrl, apiKey, fetch: async () => json({ data: [] }) });
  for (const [group, methods] of Object.entries({
    workspaces: ['create', 'list', 'get', 'update', 'delete'],
    chats: ['create', 'list', 'get', 'update', 'delete', 'sendMessage'],
    chatCrons: ['list', 'get', 'update', 'delete'],
    projectSkills: ['list', 'create', 'get', 'update', 'delete'],
    projectReports: ['usageRequest', 'logsRequest', 'usage', 'usagePage', 'iterateUsage', 'logs', 'events', 'logsPage', 'eventsPage', 'iterateLogs', 'iterateEvents', 'analytics', 'filters', 'eventTypes'],
  })) for (const method of methods) assert.equal(typeof client[group][method], 'function', `${group}.${method}`);
  for (const name of ['cancel', 'create', 'resume', 'fund', 'topUp', 'addCredit', 'retryPayment']) {
    assert.equal(client.chatCrons[name], undefined);
    assert.equal(client.projectReports[name], undefined);
  }
  for (const name of ['createCompany', 'getCompanyUsage', 'getProjectSpendLimit', 'updateProjectSpendLimit', 'createCompanyBillingTopup', 'reserveBilling', 'internalWikiDispatch', 'updateApiKeySpendLimit']) assert.equal(client[name], undefined);
  assert.equal(Object.keys(operations).length, 92);
  assert.equal(isProjectResourceOperation('getProjectLogs'), true);
  assert.equal(isProjectResourceOperation('createCompany'), false);
});

test('repeated bracket query keys are serialized locally in strict and normal modes', async () => {
  for (const strictValidation of [false, true]) for (const direct of [false, true]) {
    const { client, calls } = makeClient(fixed(logPage(1, 1)), { strictValidation });
    const params = direct ? {
      project_id: ids.project_id, view: 'events', 'types[]': ['alpha', 'beta'],
      'workspace_ids[]': [ids.workspace_id], 'api_key_ids[]': [ids.api_key_id],
    } : null;
    const result = direct ? await client.getProjectLogs(params) : await client.projectReports.logs(ids.project_id, {
      view: 'events', types: ['alpha', 'beta'], workspace_ids: [ids.workspace_id], api_key_ids: [ids.api_key_id],
    });
    const query = queryOf(calls[0]);
    assert.deepEqual(query.getAll('types[]'), ['alpha', 'beta']);
    assert.deepEqual(query.getAll('workspace_ids[]'), [ids.workspace_id]);
    assert.deepEqual(query.getAll('api_key_ids[]'), [ids.api_key_id]);
    assert.equal(query.get('view'), 'events');
    assert.deepEqual(result, normalizedLogPage(1, 1));
    assert.equal(calls[0].url.includes('remote.invalid'), false);
  }
});

test('the transport rejects malformed repeated query values instead of stringifying arrays', async () => {
  const probe = name => ({ id: 'queryArrayProbe', method: 'GET', path: '/probe', public: true, origin: false, parameters: [{ name, in: 'query', required: false }], bodyRequired: false, mode: 'json', unwrap: false });
  let captured;
  const transport = new HttpTransport({ baseUrl, fetch: async url => { captured = url; return json({}); } });
  await transport.request(probe('types[]'), { 'types[]': ['alpha', 'beta'] });
  assert.deepEqual(new URL(captured).searchParams.getAll('types[]'), ['alpha', 'beta']);
  await transport.request(probe('status'), { status: 'active' });
  assert.equal(new URL(captured).searchParams.get('status'), 'active');
  for (const [name, params] of [
    ['types[]', { 'types[]': [] }],
    ['types[]', { 'types[]': ['alpha', 7] }],
    ['types[]', { 'types[]': 'alpha' }],
    ['status', { status: ['active'] }],
  ]) await assert.rejects(transport.request(probe(name), params), TypeError);
});

test('project report query validation rejects malformed ranges, ids, arrays, pages and view combinations', async () => {
  const usage = patch => ({ project_id: ids.project_id, ...patch });
  const logs = patch => ({ project_id: ids.project_id, ...patch });
  const invalidUsage = [
    { from: 7 }, { from: '2026-1-01' }, { from: '9999-99-99' }, { from: '2026-02-30' },
    { from: '2026-10-20', to: '2026-10-01' }, { from: '2026-01-01', to: '2026-10-10' },
    { api_key_id: 'key_1' }, { chat_id: ids.chat_id }, { type: 'alpha' },
    { page: '2' }, { page: 1.5 }, { page: 0 },
    { per_page: '25' }, { per_page: 1.5 }, { per_page: 0 }, { per_page: 101 },
    { from: undefined }, { from: null }, { unexpected: 1 }, { view: 'events' }, { project_id: 'bad' },
  ];
  const sparse = [];
  sparse.length = 1;
  const invalidLogs = [
    { view: 'other' }, { 'types[]': 'alpha' }, { 'types[]': [] }, { 'types[]': Array.from({ length: 51 }, (_, i) => 'type.' + i) },
    { 'types[]': ['alpha', 'alpha'] }, { 'types[]': [1] }, { 'types[]': [''] }, { 'types[]': ['a'.repeat(81)] },
    { 'types[]': sparse }, { 'workspace_ids[]': ['w'.repeat(31)] }, { 'api_key_ids[]': ['k'.repeat(31)] },
    { type: 'alpha', 'types[]': ['beta'] }, { api_key_id: ids.api_key_id, 'api_key_ids[]': [ids.api_key_id] },
    { type: 7 }, { type: 'a'.repeat(81) }, { chat_id: 'cht_1' }, { api_key_id: 'key_1' }, { project_id: 'bad' },
    { page: 0 }, { per_page: 101 }, { unexpected: 1 },
    { view: 'analytics', type: 'alpha' }, { view: 'analytics', 'types[]': ['alpha'] },
    { view: 'analytics', 'workspace_ids[]': [ids.workspace_id] }, { view: 'analytics', 'api_key_ids[]': [ids.api_key_id] },
    { view: 'analytics', page: 1 }, { view: 'analytics', per_page: 25 },
    { view: 'filters', type: 'alpha' }, { view: 'filters', api_key_id: ids.api_key_id },
    { view: 'filters', chat_id: ids.chat_id }, { view: 'filters', 'types[]': ['alpha'] },
    { view: 'filters', page: 1 }, { view: 'filters', per_page: 25 },
  ];
  assert.doesNotThrow(() => validateUsageQuery(usage({ from: '2026-10-01', to: '2026-10-10', api_key_id: ids.api_key_id, page: 2, per_page: 25 })));
  for (const patch of invalidUsage) assert.throws(() => validateUsageQuery(usage(patch)), TypeError, JSON.stringify(patch));
  for (const patch of invalidLogs) assert.throws(() => validateLogQuery(logs(patch)), TypeError, JSON.stringify(patch));
  assert.doesNotThrow(() => validateLogQuery(logs({ view: 'events', 'types[]': ['alpha'], page: 2, per_page: 25 })));
  assert.doesNotThrow(() => validateLogQuery(logs({ view: 'analytics', from: '2026-10-01', to: '2026-10-10', api_key_id: ids.api_key_id, chat_id: ids.chat_id })));
  assert.doesNotThrow(() => validateLogQuery(logs({ view: 'filters', from: '2026-10-01', to: '2026-10-10' })));
  assert.throws(() => validateProjectResourceRequest('getProjectLogs', logs({ unexpected: 1 }), operations.getProjectLogs.parameters), TypeError);
  assert.doesNotThrow(() => validateProjectResourceRequest('listChatCrons', { workspace_id: ids.workspace_id }, operations.listChatCrons.parameters));
  assert.throws(() => validateProjectResourceRequest('deleteWorkspace', { workspace_id: ids.workspace_id, body: {} }, operations.deleteWorkspace.parameters), TypeError);
  for (const strictValidation of [false, true]) for (const patch of [invalidUsage[0], invalidLogs[0], { view: 'analytics', page: 1 }]) {
    const method = patch.view === 'analytics' || patch.view === 'other' ? 'getProjectLogs' : 'getProjectUsage';
    const { client, calls } = makeClient(async () => { throw Error('unexpected fetch'); }, { strictValidation });
    await assert.rejects(client[method](method === 'getProjectUsage' ? usage(patch) : logs(patch)));
    assert.equal(calls.length, 0);
  }
});

test('report parameter builders preserve start pages, arrays, explicit nulls and local view selection', () => {
  assert.throws(() => projectUsageParams(ids.project_id, null), TypeError);
  assert.throws(() => projectUsageParams(ids.project_id, {}, 0), TypeError);
  assert.throws(() => projectUsageParams(ids.project_id, { page: 0 }, 0), TypeError);
  assert.throws(() => projectUsageParams(ids.project_id, { from: null }), TypeError);
  assert.throws(() => projectUsageParams(ids.project_id, { project_id: ids.other_project_id }), TypeError);
  assert.throws(() => projectUsageParams(ids.project_id, { view: 'events' }), TypeError);
  const usageDefault = projectUsageParams(ids.project_id, { from: '2026-10-01', to: undefined });
  assert.equal(Object.hasOwn(usageDefault, 'page'), false);
  assert.equal(Object.hasOwn(usageDefault, 'to'), false);
  assert.deepEqual(projectUsageParams(ids.project_id), { project_id: ids.project_id });
  assert.equal(Object.hasOwn(projectUsageParams(ids.project_id, {}, 1), 'page'), false);
  assert.equal(projectUsageParams(ids.project_id, { page: 2 }, 1).page, 1);
  assert.equal(projectUsageParams(ids.project_id, {}, 2).page, 2);
  assert.throws(() => projectLogParams(ids.project_id, null, 'events'), TypeError);
  assert.throws(() => projectLogParams(ids.project_id, { project_id: ids.other_project_id }, 'events'), TypeError);
  assert.throws(() => projectLogParams(ids.project_id, { view: 'analytics' }, 'events'), TypeError);
  assert.throws(() => projectLogParams(ids.project_id, { types: ['alpha'], 'types[]': ['beta'] }, 'events'), TypeError);
  assert.throws(() => projectLogParams(ids.project_id, { types: ['alpha'], type: 'beta' }, 'events'), TypeError);
  assert.throws(() => projectLogParams(ids.project_id, { api_key_ids: [ids.api_key_id], api_key_id: ids.api_key_id }, 'events'), TypeError);
  assert.throws(() => projectLogParams(ids.project_id, { page: 2 }, 'analytics'), TypeError);
  assert.throws(() => projectLogParams(ids.project_id, { type: 'alpha' }, 'filters'), TypeError);
  assert.throws(() => projectLogParams(ids.project_id, { page: 2 }, 'events', 0), TypeError);
  const eventParams = projectLogParams(ids.project_id, {
    view: 'events', from: undefined, types: ['alpha'], workspace_ids: [ids.workspace_id], api_key_ids: [ids.api_key_id], page: 2,
  }, 'events', 1);
  assert.equal(eventParams.view, 'events');
  assert.deepEqual(eventParams['types[]'], ['alpha']);
  assert.deepEqual(eventParams['workspace_ids[]'], [ids.workspace_id]);
  assert.deepEqual(eventParams['api_key_ids[]'], [ids.api_key_id]);
  assert.equal(eventParams.page, 1);
  assert.equal(Object.hasOwn(eventParams, 'from'), false);
  assert.equal(Object.hasOwn(projectLogParams(ids.project_id, {}, 'events', 1), 'page'), false);
  assert.equal(projectLogParams(ids.project_id, {}, 'events', 2).page, 2);
  assert.equal(projectLogParams(ids.project_id, { view: 'analytics', from: '2026-10-01', to: '2026-10-10' }, 'analytics').view, 'analytics');
  assert.equal(projectLogParams(ids.project_id, { view: 'filters', from: '2026-10-01', to: '2026-10-10' }, 'filters').view, 'filters');
});

test('chat and skill request bodies are narrow, preserve null and exact Markdown whitespace, and never send ownership', async () => {
  for (const strictValidation of [false, true]) {
    const invalidTitle = [
      { workspace_id: ids.workspace_id, chat_id: ids.chat_id, body: {} },
      { workspace_id: ids.workspace_id, chat_id: ids.chat_id, body: { title: undefined } },
      { workspace_id: ids.workspace_id, chat_id: ids.chat_id, body: { title: 7 } },
      { workspace_id: ids.workspace_id, chat_id: ids.chat_id, body: { title: 'a'.repeat(256) } },
      { workspace_id: ids.workspace_id, chat_id: ids.chat_id, body: { title: 'x', team_id: ids.team_id } },
    ];
    const invalidSkills = [
      { project_id: ids.project_id, body: { name: 'runbook' } },
      { project_id: ids.project_id, body: { name: 7, content: '# Body' } },
      { project_id: ids.project_id, body: { name: 'filesystem', content: '# Body' } },
      { project_id: ids.project_id, body: { name: 'Bad_Name', content: '# Body' } },
      { project_id: ids.project_id, body: { name: 'a'.repeat(65), content: '# Body' } },
      { project_id: ids.project_id, body: { name: 'bad\0name', content: '# Body' } },
      { project_id: ids.project_id, body: { name: 'runbook', content: '# Body', description: 'bad\0text' } },
      { project_id: ids.project_id, body: { name: 'runbook', content: 'bad\0markdown' } },
      { project_id: ids.project_id, body: { name: 'runbook', content: '  \n\t  ' } },
      { project_id: ids.project_id, body: { name: 'runbook', content: '# Body', project_id: ids.project_id } },
    ];
    const invalidCron = { workspace_id: ids.workspace_id, cron_id: ids.cron_id, body: { prompt: 'x', status: 'active' } };
    const { client, calls } = makeClient(async () => { throw Error('unexpected fetch'); }, { strictValidation });
    for (const params of invalidTitle) await assert.rejects(client.updateChat(params));
    for (const params of invalidSkills) await assert.rejects(client.createProjectSkill(params));
    await assert.rejects(client.updateChatCron(invalidCron));
    assert.equal(calls.length, 0);
  }
  const markdown = '  \n# Heading\n\n  indented body  \n\t\n';
  const { client, calls } = makeClient(sequence(json({ data: chat }), json({ data: skill }, 201), json({ data: skill }, 201), json({ data: skill }), json({ data: cron })));
  await client.updateChat({ workspace_id: ids.workspace_id, chat_id: ids.chat_id, body: { title: null } });
  await client.createProjectSkill({ project_id: ids.project_id, body: { name: 'runbook', content: markdown, description: undefined } });
  await client.createProjectSkill({ project_id: ids.project_id, body: { name: 'runbook', content: markdown, description: null } });
  await client.updateProjectSkill({ project_id: ids.project_id, skill_id: ids.skill_id, body: { description: null } });
  await client.updateChatCron({ workspace_id: ids.workspace_id, cron_id: ids.cron_id, body: { interval_minutes: null, daily_at: null, timezone: null, start_at: null, repeat_count: null, until: null } });
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: null });
  assert.deepEqual(JSON.parse(calls[1].init.body), { name: 'runbook', content: markdown });
  assert.deepEqual(JSON.parse(calls[2].init.body), { name: 'runbook', content: markdown, description: null });
  assert.deepEqual(JSON.parse(calls[3].init.body), { description: null });
  assert.deepEqual(JSON.parse(calls[4].init.body), { interval_minutes: null, daily_at: null, timezone: null, start_at: null, repeat_count: null, until: null });
});

test('three project log views correlate their response envelopes and typed helper returns', async () => {
  for (const strictValidation of [false, true]) {
    const usage = makeClient(fixed(usagePage(1, 2)), { strictValidation });
    const usageResult = await usage.client.projectReports.usage(ids.project_id, { from: '2026-10-01', to: '2026-10-10', api_key_id: ids.api_key_id, per_page: 25 });
    assert.deepEqual(usageResult, usagePage(1, 2));
    assert.equal(usageResult.data[0].totals[0].amount, '0.100000000000');
    assert.equal(usageResult.data[0].by_project, null);
    assert.equal(queryOf(usage.calls[0]).get('from'), '2026-10-01');
    assert.equal(queryOf(usage.calls[0]).get('to'), '2026-10-10');
    assert.equal(queryOf(usage.calls[0]).get('api_key_id'), ids.api_key_id);
    assert.equal(queryOf(usage.calls[0]).get('per_page'), '25');
    assert.equal(queryOf(usage.calls[0]).has('page'), false);
    assert.equal(usage.calls[0].url.includes('remote.invalid'), false);
    const logs = makeClient(fixed(logPage(1, 2)), { strictValidation });
    const logsResult = await logs.client.projectReports.logs(ids.project_id, { from: '2026-10-01', to: '2026-10-10', api_key_id: ids.api_key_id, chat_id: ids.chat_id, type: 'agent.started', per_page: 25 });
    assert.deepEqual(logsResult, normalizedLogPage(1, 2));
    assert.deepEqual(logsResult.data[0].agent, {});
    assert.deepEqual(logsResult.data[0].data, {});
    assert.equal(queryOf(logs.calls[0]).get('view'), 'events');
    const analyticsClient = makeClient(fixed({ data: analytics }), { strictValidation });
    const analyticsResult = await analyticsClient.client.projectReports.analytics(ids.project_id, { from: '2026-10-01', to: '2026-10-10', api_key_id: ids.api_key_id, chat_id: ids.chat_id });
    assert.deepEqual(analyticsResult, analytics);
    assert.equal(queryOf(analyticsClient.calls[0]).get('view'), 'analytics');
    assert.equal(queryOf(analyticsClient.calls[0]).get('page'), null);
    const filtersClient = makeClient(sequence(json(catalog), json(catalog)), { strictValidation });
    const filtersResult = await filtersClient.client.projectReports.filters(ids.project_id, { from: '2026-10-01', to: '2026-10-10' });
    const eventTypesResult = await filtersClient.client.projectReports.eventTypes(ids.project_id, { from: '2026-10-01', to: '2026-10-10' });
    assert.deepEqual(filtersResult, catalog.data);
    assert.deepEqual(eventTypesResult, catalog.data);
    for (const call of filtersClient.calls) assert.equal(queryOf(call).get('view'), 'filters');
    for (const [view, payload] of [['events', catalog], ['analytics', logPage(1, 1)], ['filters', analytics]]) {
      const wrong = makeClient(fixed(payload), { strictValidation });
      await assert.rejects(wrong.client.getProjectLogs({ project_id: ids.project_id, view }), ProtocolError);
      assert.equal(wrong.calls.length, 1);
    }
  }
});

test('typed report helpers accept default selectors and retain flat request aliases', async () => {
  const { client, calls } = makeClient(sequence(
    json(usagePage(1, 1)), json(logPage(1, 1)), json({ data: analytics }), json(catalog),
    json(usagePage(1, 1)), json(logPage(1, 1)), json(usagePage(1, 1)), json(logPage(1, 1)),
  ));
  await client.projectReports.usage(ids.project_id);
  await client.projectReports.logs(ids.project_id);
  await client.projectReports.analytics(ids.project_id);
  await client.projectReports.filters(ids.project_id);
  await client.projectReports.usagePage(ids.project_id);
  await client.projectReports.logsPage(ids.project_id);
  await client.projectReports.usageRequest({ project_id: ids.project_id });
  await client.projectReports.logsRequest({ project_id: ids.project_id });
  assert.equal(calls.length, 8);
  assert.equal(queryOf(calls[1]).get('view'), 'events');
  assert.equal(queryOf(calls[2]).get('view'), 'analytics');
  assert.equal(queryOf(calls[3]).get('view'), 'filters');
  assert.equal(queryOf(calls[4]).has('page'), false);
  assert.equal(queryOf(calls[5]).has('page'), false);
});

test('usage helpers refuse project overrides, and iteration bounds require positive safe integers', async () => {
  for (const strictValidation of [false, true]) {
    for (const filters of [{ project_id: ids.other_project_id }, { view: 'events' }]) {
      for (const run of [
        async client => { await client.projectUsage(ids.project_id, filters); },
        async client => { await client.projectUsagePage(ids.project_id, 1, filters); },
        async client => { for await (const _ of client.projectReports.iterateUsage(ids.project_id, filters)) void _; },
      ]) {
        const { client, calls } = makeClient(async () => { throw Error('unexpected fetch'); }, { strictValidation });
        await assert.rejects(run(client), TypeError);
        assert.equal(calls.length, 0, `${strictValidation} ${JSON.stringify(filters)}`);
      }
    }
    for (const method of ['iterateUsage', 'iterateLogs']) {
      for (const [filters, options] of [
        [{}, { maxPages: 1.5 }], [{}, { maxPages: Number.MAX_SAFE_INTEGER + 1 }],
        [{}, { startPage: 1.5 }], [{}, { startPage: Number.MAX_SAFE_INTEGER + 1 }],
        [{ page: 1.5 }, {}], [{ page: Number.MAX_SAFE_INTEGER + 1 }, {}],
      ]) {
        const { client, calls } = makeClient(async () => { throw Error('unexpected fetch'); }, { strictValidation });
        await assert.rejects(async () => { for await (const _ of client.projectReports[method](ids.project_id, filters, options)) void _; }, RangeError, `${method} ${strictValidation} ${JSON.stringify({ filters, options })}`);
        assert.equal(calls.length, 0, `${method} ${strictValidation} ${JSON.stringify({ filters, options })}`);
      }
    }
  }
});

test('project log response normalization is narrow and rejects non-object metadata arrays', () => {
  const usagePayload = usagePage(1, 1);
  assert.equal(prepareProjectLogResponse('getProjectUsage', usagePayload, {}), usagePayload);
  assert.deepEqual(prepareProjectLogResponse('getProjectLogs', logPage(1, 1), { view: 'events' }), normalizedLogPage(1, 1));
  const analyticsPayload = { data: analytics };
  assert.equal(prepareProjectLogResponse('getProjectLogs', analyticsPayload, { view: 'analytics' }), analyticsPayload);
  const invalid = [
    [null, { view: 'events' }],
    [{ data: {}, links: {}, meta: {} }, { view: 'events' }],
    [{ data: [], links: null, meta: {} }, { view: 'events' }],
    [{ data: [], links: {}, meta: null }, { view: 'events' }],
    [{ data: ['bad'], links: {}, meta: {} }, { view: 'events' }],
    [{ ...logPage(1, 1), data: [{ ...logEntry, agent: ['bad'] }] }, { view: 'events' }],
    [{ ...logPage(1, 1), data: [{ ...logEntry, data: ['bad'] }] }, { view: 'events' }],
    [{ ...logPage(1, 1), data: [{ ...logEntry, agent: 'bad' }] }, { view: 'events' }],
    [logPage(1, 1), { view: 'analytics' }],
    [{ data: { ...analytics, window: null } }, { view: 'analytics' }],
    [{ data: { ...analytics, coverage: null } }, { view: 'analytics' }],
    [{ data: { ...analytics, daily: {} } }, { view: 'analytics' }],
    [{ data: { ...analytics, event_types: null } }, { view: 'analytics' }],
    [{ data: { ...analytics, tools: null } }, { view: 'analytics' }],
    [{ data: { ...analytics, failures: null } }, { view: 'analytics' }],
    [{ data: { ...analytics, durations: null } }, { view: 'analytics' }],
    [{ data: { ...analytics, file_reads: {} } }, { view: 'analytics' }],
    [logPage(1, 1), { view: 'filters' }],
    [{ data: { types: 'bad' } }, { view: 'filters' }],
  ];
  for (const [payload, params] of invalid) assert.throws(() => prepareProjectLogResponse('getProjectLogs', payload, params), ProtocolError);
  assert.deepEqual(prepareProjectLogResponse('getProjectLogs', { data: catalog.data }, { view: 'filters' }), { data: catalog.data });
});

test('local numeric pagination preserves filters, start pages, cancellation and ignores external links', async () => {
  const usage = makeClient(sequence(json(usagePage(1, 2)), json(usagePage(2, 2))));
  const usageItems = [];
  for await (const item of usage.client.projectReports.iterateUsage(ids.project_id, { from: '2026-10-01', to: '2026-10-10', api_key_id: ids.api_key_id, per_page: 25 })) usageItems.push(item);
  assert.equal(usageItems.length, 2);
  assert.equal(queryOf(usage.calls[0]).get('page'), null);
  assert.equal(queryOf(usage.calls[1]).get('page'), '2');
  for (const call of usage.calls) {
    assert.equal(queryOf(call).get('from'), '2026-10-01');
    assert.equal(queryOf(call).get('api_key_id'), ids.api_key_id);
    assert.equal(call.url.includes('remote.invalid'), false);
    assert.equal(call.url.includes(ids.other_project_id), false);
  }
  const logs = makeClient(sequence(json(logPage(2, 3)), json(logPage(3, 3))));
  const logItems = [];
  for await (const item of logs.client.projectReports.iterateLogs(ids.project_id, { from: '2026-10-01', to: '2026-10-10', page: 2, per_page: 25 })) logItems.push(item);
  assert.equal(logItems.length, 2);
  assert.equal(queryOf(logs.calls[0]).get('page'), '2');
  assert.equal(queryOf(logs.calls[1]).get('page'), '3');
  for (const call of logs.calls) assert.equal(queryOf(call).get('view'), 'events');
  const start = makeClient(sequence(json(usagePage(3, 4)), json(usagePage(4, 4)), json(logPage(2, 3)), json(logPage(3, 3))));
  for await (const _ of start.client.projectReports.iterateUsage(ids.project_id, { page: 1 }, { startPage: 3, maxPages: 2 })) void _;
  for await (const _ of start.client.projectReports.iterateEvents(ids.project_id, { page: 5 }, { startPage: 2, maxPages: 2 })) void _;
  assert.deepEqual(start.calls.map(call => queryOf(call).get('page')), ['3', '4', '2', '3']);
  const pages = makeClient(sequence(json(usagePage(1, 2)), json(logPage(2, 3))));
  await pages.client.projectReports.usagePage(ids.project_id, 1, { page: 2 });
  await pages.client.projectReports.logsPage(ids.project_id, 2, { page: 1 });
  assert.equal(queryOf(pages.calls[0]).get('page'), '1');
  assert.equal(queryOf(pages.calls[1]).get('page'), '2');
  for (const [method, filters, options] of [
    ['iterateUsage', {}, { startPage: 0 }], ['iterateUsage', {}, { maxPages: 0 }],
    ['iterateLogs', { page: 0 }, {}], ['iterateLogs', {}, { maxPages: 0 }],
  ]) {
    const invalid = makeClient(async () => { throw Error('unexpected fetch'); });
    await assert.rejects(async () => { for await (const _ of invalid.client.projectReports[method](ids.project_id, filters, options)) void _; }, RangeError);
    assert.equal(invalid.calls.length, 0);
  }
  for (const badMeta of [{ current_page: 9 }, { last_page: undefined }, { last_page: 1.5 }, { last_page: 0 }]) {
    const usageBad = makeClient(fixed({ ...usagePage(1, 1), meta: { ...usagePage(1, 1).meta, ...badMeta } }));
    await assert.rejects(async () => { for await (const _ of usageBad.client.projectReports.iterateUsage(ids.project_id)) void _; }, ProtocolError);
    const logsBad = makeClient(fixed({ ...logPage(1, 1), meta: { ...logPage(1, 1).meta, ...badMeta } }));
    await assert.rejects(async () => { for await (const _ of logsBad.client.projectReports.iterateLogs(ids.project_id)) void _; }, ProtocolError);
  }
  const exceededUsage = makeClient(fixed(usagePage(1, 3)));
  await assert.rejects(async () => { for await (const _ of exceededUsage.client.projectReports.iterateUsage(ids.project_id, {}, { maxPages: 1 })) void _; }, /Usage pagination exceeded maxPages/);
  const exceededLogs = makeClient(fixed(logPage(1, 3)));
  await assert.rejects(async () => { for await (const _ of exceededLogs.client.projectReports.iterateLogs(ids.project_id, {}, { maxPages: 1 })) void _; }, /Project log pagination exceeded maxPages/);
  for (const method of ['iterateUsage', 'iterateLogs']) {
    const controller = new AbortController();
    const first = method === 'iterateUsage' ? usagePage(1, 2) : logPage(1, 2);
    const second = method === 'iterateUsage' ? usagePage(2, 2) : logPage(2, 2);
    const cancelled = makeClient(sequence(json(first), json(second)));
    const iterator = cancelled.client.projectReports[method](ids.project_id, {}, { signal: controller.signal });
    assert.equal((await iterator.next()).done, false);
    controller.abort();
    await assert.rejects(iterator.next(), error => error.name === 'AbortError');
    assert.equal(cancelled.calls.length, 1);
    const preaborted = new AbortController();
    preaborted.abort();
    const blocked = makeClient(async () => { throw Error('unexpected fetch'); });
    await assert.rejects(async () => { for await (const _ of blocked.client.projectReports[method](ids.project_id, {}, { signal: preaborted.signal })) void _; }, error => error.name === 'AbortError');
    assert.equal(blocked.calls.length, 0);
  }
});

test('project resources refuse contract 2 and keep typed HTTP errors without retries or recovery calls', async () => {
  for (const [id, params] of [['getProjectUsage', { project_id: ids.project_id }], ['getProjectLogs', { project_id: ids.project_id }], ['deleteWorkspace', { workspace_id: ids.workspace_id }]]) {
    const { client, calls } = makeClient(async () => { throw Error('unexpected fetch'); }, { contractVersion: 2 });
    await assert.rejects(client[id](params), CompatibilityError);
    assert.equal(calls.length, 0);
  }
  const statusCases = [
    [401, 'unauthenticated', 'unauthenticated', AuthenticationError],
    [402, 'billing_error', 'credit_exhausted', PaymentRequiredError],
    [403, 'access_denied', 'access_denied', AccessDeniedError],
    [404, 'not_found', 'not_found', NotFoundError],
    [409, 'conflict', 'active_cron', ConflictError],
    [422, 'validation_error', 'validation_error', ValidationError],
    [429, 'too_many_requests', 'too_many_requests', RateLimitError],
    [503, 'server_error', 'server_error', ServerError],
  ];
  for (const strictValidation of [false, true]) for (const entry of operationCases) for (const [status, type, code, Klass] of statusCases) {
    const { client, calls } = makeClient(fixed({ error: { type, code, message: 'Rejected', details: { status } } }, status), { strictValidation });
    await assert.rejects(client[entry.id](entry.params), error => error instanceof EnvaiError && error instanceof Klass && error.httpStatus === status && error.type === type && error.code === code && error.requestId === 'req-ok');
    assert.equal(calls.length, 1, entry.id);
  }
  const mutations = operationCases.filter(entry => entry.method !== 'GET');
  for (const entry of mutations) for (const [status, type, code] of [[409, 'conflict', 'active_cron'], [402, 'billing_error', 'credit_exhausted'], [503, 'provider_configuration_error', 'provider_configuration_error']]) {
    const { client, calls } = makeClient(fixed({ error: { type, code, message: 'Rejected', details: { active: true } } }, status), { retry: { maxRetries: 3, baseDelayMs: 0 } });
    await assert.rejects(client[entry.id](entry.params), error => error instanceof EnvaiError && error.httpStatus === status && error.code === code);
    assert.equal(calls.length, 1, `${entry.id} ${status}`);
    assert.equal(calls[0].init.method, entry.method);
    assert.equal(calls[0].url.includes('/billing/'), false);
    assert.equal(calls[0].url.includes('remote.invalid'), false);
  }
});

test('four current events are typed, billing events are non-terminal with null turns, and v2 stays frozen', () => {
  const envelope = (type, data, turn_id = ids.completion_id) => ({ v: 3, id: ids.event_id, seq: 1, ts: '2026-11-11T09:00:00Z', chat_id: ids.chat_id, turn_id, agent: null, type, data });
  const events = [
    ['chat.title.updated', { title: 'Q3 rollout plan' }, ids.completion_id],
    ['chat.cron.wakeup', { cron_id: ids.cron_id, occurrence_id: ids.occurrence_id, scheduled_at: '2026-11-11T09:00:00Z', delivered_at: '2026-11-11T09:00:01Z', prompt: 'Summarize', target_mode: 'same_chat', dispatch_mode: 'turn_started' }, ids.completion_id],
    ['billing.limit_reached', { reason: 'limit_reached', scope: 'project', currency: 'EUR', reset_at: null, amount: '10.00', remaining: '0.00' }, null],
    ['billing.credit_exhausted', { reason: 'credit_exhausted', scope: 'company', currency: 'EUR' }, null],
  ];
  for (const [type, data, turn_id] of events) {
    const parsed = parseEvent(envelope(type, data, turn_id), 3);
    assert.equal(parsed.known, true);
    assert.equal(parsed.type, type);
    assert.equal(parsed.turn_id, turn_id);
    assert.equal(isTerminal(parsed), false);
    assert.ok(knownEventTypes.includes(type));
  }
  assert.equal(parseEvent({ ...envelope('chat.title.updated', { title: 'Q3 rollout plan' }, ids.completion_id), v: 2 }, 2).known, true);
  assert.equal(parseEvent({ ...envelope('chat.cron.wakeup', {}), v: 2 }, 2).known, false);
  assert.throws(() => parseEvent(envelope('billing.credit_exhausted', { reason: 'credit_exhausted', scope: 'company', currency: 'EUR' }, null), 2), ProtocolError);
  assert.equal(sha256('contracts/events-v2.json'), '88d41835f88c0cc4ad071b06ed4623882c6b64144baf312c4a095504c98cd7d6');
  assert.equal(sha256('contracts/openapi-v2.json'), 'bbe7fcc23415e25012fdb88f1931fd8d12a96f7884de8d58c875459a557c5155');
});

test('six refreshed contracts carry exact backend hashes, canonical provenance and the new provider error', () => {
  const expected = {
    'smidja-native.json': ['035065640fa4946a2e54297b1a22c69ea736827d38765b0cdaa80a28c3058f8b', '6fd7074e23381d8875fc6e0b3aef4df99ab6297d'],
    'openapi.yaml': ['4e153677561938241d42335c4ecbbfd8c0d9de0fbcbd59b75aa10dfbb17c0691', 'fa965e896047f94084ddc7160a5a3cbf9633b986'],
    'events.json': ['7522d63756d624e7ebc7a2a5787f8ab2d6fc0099c5c70e56e65cf08e93daae85', 'e4713436407e2c27cdecb8d49dd3f815cc2e5870'],
    'events-v2.json': ['88d41835f88c0cc4ad071b06ed4623882c6b64144baf312c4a095504c98cd7d6', '02b13b23cd06eacd81059d1ed99e0027769d75e4'],
    'wiki.json': ['e360060a42c1d69a6cd15de3ea33745567d23166785efcb08f161c7acb38d30c', '3d495bbe3b4cf53af3cab29d86d3a032a7fa8b8c'],
    'terminal-snapshot.json': ['c132b27031595c94a8b05eaf008545ccc3ac21d4dd170dd800c5e15b7f93e9bf', '77d885bda661800972ed56837e69a57ab613da82'],
  };
  assert.equal(manifest.repository, 'digitalygo/envai-teams');
  assert.equal(manifest.commit, '7f4085dbfdd3f208b82716119cff1860fbd502bb');
  assert.equal(manifest.operationCount, 92);
  assert.equal(manifest.serverOperationCount, 146);
  for (const [name, [hash, blob]] of Object.entries(expected)) {
    assert.equal(sha256('contracts/' + name), hash, name);
    assert.equal(manifest.sources[name].sha256, hash, name);
    assert.equal(manifest.sources[name].git_blob_sha, blob, name);
    assert.equal(manifest.sources[name].repository_path, 'packages/contracts/' + name, name);
  }
  assert.equal(sha256('contracts/openapi.json'), manifest.derived_artifacts['openapi.json'].sha256);
  assert.equal(spec.paths['/images/generations'].post.responses['503'].$ref, '#/components/responses/ProviderConfigurationError');
  assert.equal(spec.components.responses.ProviderConfigurationError.content['application/json'].example.error.type, 'provider_configuration_error');
  assert.match(manifest.sdk_fixtures['tenancy-responses.json'].origin, /Synthetic/);
  for (const entry of Object.values(manifest.shared_fixtures)) assert.doesNotMatch(entry.origin, /captured production traffic/i);
});
