import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvaiClient, EnvaiError, ProtocolError, CompatibilityError, parseEvent } from '../dist/index.js';
import { capabilities, chatId, turnId, event, json } from './helpers.mjs';

const model = 'z-ai/glm-5.3-flash';
const accepted = { status: 'accepted', turn_id: turnId };
const client = (fetch, options = {}) => new EnvaiClient({ baseUrl: 'https://offline.test', fetch, ...options });

test('exact model and omitted model remain independent across low-level requests', async () => {
 const requests = [];
 const c = client(async (url, init) => {
  if (url.endsWith('/capabilities')) return json(capabilities);
  requests.push({ body: JSON.parse(init.body), key: init.headers.get('Idempotency-Key'), extension: init.headers.get('X-Envai-Extensions') });
  return json({ ...accepted, ...(JSON.parse(init.body).attachment_ids ? { attachment_ids: JSON.parse(init.body).attachment_ids } : {}) }, 202);
 });
 await c.sendChatMessage({ chat_id: chatId, body: { message: 'first', model, attachment_ids: ['file_1'] }, idempotencyKey: 'exact-key' }).catch(e => { if (!(e instanceof CompatibilityError)) throw e; });
 assert.equal(requests.length, 0);
 const d = client(async (url, init) => {
  if (url.endsWith('/capabilities')) return json({ ...capabilities, features: ['chat_attachments'] });
  const body = JSON.parse(init.body); requests.push({ body, key: init.headers.get('Idempotency-Key'), extension: init.headers.get('X-Envai-Extensions') });
  return json({ ...accepted, ...(body.attachment_ids ? { attachment_ids: body.attachment_ids } : {}) }, 202);
 });
 await d.sendChatMessage({ chat_id: chatId, body: { message: 'first', model, attachment_ids: ['file_1'] }, idempotencyKey: 'exact-key' });
 await d.sendChatMessage({ chat_id: chatId, body: { message: 'second' } });
 assert.deepEqual(requests, [{ body: { message: 'first', model, attachment_ids: ['file_1'] }, key: 'exact-key', extension: null }, { body: { message: 'second' }, key: null, extension: null }]);
});

test('raw invalid model shapes are not normalized and strict validation rejects them', async () => {
 for (const invalid of [null, 7, false, {}, '', ' x', 'x ', '\tx']) {
  let posted;
  const fetch = async (url, init) => {
   if (url.endsWith('/capabilities')) return json(capabilities);
   posted = JSON.parse(init.body);
   return json({ error: { type: 'validation_error', code: 'invalid_model', message: 'invalid' } }, 422);
  };
  await assert.rejects(client(fetch).sendChatMessage({ chat_id: chatId, body: { message: 'hi', model: invalid } }), e => e instanceof EnvaiError && e.code === 'invalid_model');
  assert.deepEqual(posted.model, invalid);
  posted = undefined;
  await assert.rejects(client(fetch, { strictValidation: true }).sendChatMessage({ chat_id: chatId, body: { message: 'hi', model: invalid } }), ProtocolError);
  assert.equal(posted, undefined);
 }
});

test('all Go whitespace boundaries are forwarded by default and rejected before strict message posts', async () => {
 const whitespace = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
 for (const padding of [...whitespace.map(code => String.fromCodePoint(code)), '\r\n']) for (const value of [`${padding}模型`, `模型${padding}`]) {
  const posts = [];
  const fetch = async (url, init) => {
   if (url.endsWith('/capabilities')) return json(capabilities);
   posts.push({ url, body: JSON.parse(init.body) });
   return json({ error: { type: 'validation_error', code: 'invalid_model', message: 'invalid' } }, 422);
  };
  await assert.rejects(client(fetch).sendChatMessage({ chat_id: chatId, body: { message: 'hi', model: value } }), e => e instanceof EnvaiError && e.code === 'invalid_model');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { message: 'hi', model: value });
  assert.ok(posts[0].url.endsWith(`/chats/${chatId}/messages`));
  posts.length = 0;
  await assert.rejects(client(fetch, { strictValidation: true }).sendChatMessage({ chat_id: chatId, body: { message: 'hi', model: value } }), ProtocolError);
  assert.equal(posts.length, 0, `strict mode posted model ${JSON.stringify(value)}`);
 }
});

test('strict validation preserves valid Unicode and non-boundary whitespace without model stickiness', async () => {
 const bodies = [];
 const c = client(async (url, init) => {
  if (url.endsWith('/capabilities')) return json(capabilities);
  bodies.push(JSON.parse(init.body));
  return json(accepted, 202);
 }, { strictValidation: true });
 for (const value of ['UnicodeVendor/模型', 'Vendor/Case', 'x \ty', 'x\ny', 'x\u00a0y', '\ufeffx\ufeff', ...[0x1c, 0x1d, 0x1e, 0x1f].map(code => `${String.fromCodePoint(code)}x${String.fromCodePoint(code)}`)]) {
  await c.sendChatMessage({ chat_id: chatId, body: { message: 'hi', model: value } });
 }
 await c.sendChatMessage({ chat_id: chatId, body: { message: 'omitted' } });
 assert.deepEqual(bodies, ['UnicodeVendor/模型', 'Vendor/Case', 'x \ty', 'x\ny', 'x\u00a0y', '\ufeffx\ufeff', ...[0x1c, 0x1d, 0x1e, 0x1f].map(code => `${String.fromCodePoint(code)}x${String.fromCodePoint(code)}`)].map(model => ({ message: 'hi', model })).concat({ message: 'omitted' }));
});

test('strict_model remains independently gated alongside the model', async () => {
 for (const value of [undefined, false, true]) {
  const seen = [];
  const c = client(async (url, init) => {
   if (url.endsWith('/capabilities')) return json({ ...capabilities, features: ['detached_background', 'strict_model'] }, 200, { 'X-Envai-Extensions': 'native-tasks-v1' });
   seen.push(JSON.parse(init.body)); return json(accepted, 202, { 'X-Envai-Extensions': 'native-tasks-v1' });
  }, { nativeTasks: true, strictValidation: true });
  const body = { message: 'hi', model, ...(value === undefined ? {} : { strict_model: value }) };
  await c.sendChatMessage({ chat_id: chatId, body }); assert.deepEqual(seen, [body]);
 }
 await assert.rejects(client(async () => { throw Error('unexpected'); }).sendChatMessage({ chat_id: chatId, body: { message: 'hi', model, strict_model: true } }), CompatibilityError);
});

test('both turn helpers send exact per-call bodies and do not carry a prior model', async () => {
 const bodies = []; let stream;
 const c = client(async (url, init) => {
  if (url.endsWith('/capabilities')) return json(capabilities);
  if (init.method === 'GET') return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event('ping', 0))}\n\n`)); } }), { headers: { 'content-type': 'text/event-stream', 'X-Envai-Contract-Version': '3' } });
  bodies.push(JSON.parse(init.body));
  stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event('turn.completed', 1))}\n\n`));
  return json(accepted, 202);
 });
 const received = []; for await (const item of c.sendAndStream(chatId, { message: 'one', model })) received.push(item);
 assert.equal(received.at(-1).type, 'turn.completed');
 assert.equal((await c.sendAndWait(chatId, { message: 'two' })).terminal.type, 'turn.completed');
 assert.deepEqual(bodies, [{ message: 'one', model }, { message: 'two' }]);
});

test('model errors retain status and code with no mutation resend', async () => {
 for (const [status, code] of [[422, 'invalid_model'], [422, 'unknown_model'], [422, 'model_unavailable'], [422, 'model_incompatible'], [503, 'model_catalog_unavailable'], [409, 'idempotency_conflict']]) {
  let posts = 0;
  const c = client(async (url) => {
   if (url.endsWith('/capabilities')) return json(capabilities);
   posts++; return json({ error: { type: status === 503 ? 'server_error' : 'validation_error', code, message: 'rejected' } }, status);
  });
  await assert.rejects(c.sendChatMessage({ chat_id: chatId, body: { message: 'hi', model }, idempotencyKey: 'key' }), e => e instanceof EnvaiError && e.httpStatus === status && e.code === code);
  assert.equal(posts, 1);
 }
});

test('catalog keeps selectable false and events preserve requested and observed model values', async () => {
 const entry = { id: model, object: 'model', created: 1, owned_by: 'z-ai', type: 'llm', deprecated: false, selectable: false, sunset_at: null };
 const catalog = { object: 'list', data: [entry], defaults: { orchestrator: model, subagent: model } };
 const c = client(async () => json(catalog));
 assert.deepEqual((await c.listModels()).data, [entry]);
 const started = event('agent.started'); started.data.model = model;
 assert.equal(parseEvent(started).data.model, model);
 const done = { ...started, v: 3, type: 'agent.done', data: { status: 'completed', summary: 'done', usage: event('turn.completed').data.usage, duration_ms: 1, requested_model: model, model: 'provider/observed' } };
 const parsed = parseEvent(done); assert.equal(parsed.data.requested_model, model); assert.equal(parsed.data.model, 'provider/observed');
});
