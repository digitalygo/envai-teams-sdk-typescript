import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ProtocolError } from './errors.js';

export type ContractVersion = 2 | 3;
export type CapabilityFeatures = string[] | Record<string, boolean>;
export function isCapabilityFeatures(value: unknown): value is CapabilityFeatures {
  if (Array.isArray(value)) return value.every(feature => typeof feature === 'string');
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).every(key => typeof (value as Record<string, unknown>)[key] === 'boolean');
}
export function hasCapabilityFeature(value: unknown, name: string): boolean {
  if (Array.isArray(value)) return value.every(feature => typeof feature === 'string') && value.includes(name);
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).every(key => typeof (value as Record<string, unknown>)[key] === 'boolean') && (value as Record<string, unknown>)[name] === true;
}
export class CompatibilityError extends ProtocolError {
  constructor(message = 'Server does not support the selected Envai contract; no automatic downgrade or mutation resubmission is safe') { super(message); }
}
const ajv = new Ajv2020({ strict: false, strictNumbers: true, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
function safeIntegers(schema: unknown): unknown {
  if (schema && typeof schema === 'object') {
    const object = schema as Record<string, unknown>;
    if (object.type === 'integer' || Array.isArray(object.type) && object.type.includes('integer')) {
      object.maximum = Math.min(typeof object.maximum === 'number' ? object.maximum : Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      object.minimum = Math.max(typeof object.minimum === 'number' ? object.minimum : Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);
    }
    for (const value of Object.values(object)) safeIntegers(value);
  }
  return schema;
}
const read = (name: string) => safeIntegers(JSON.parse(readFileSync(new URL('../contracts/' + name, import.meta.url), 'utf8'))) as object;
const wiki = read('wiki.json');
ajv.addSchema(wiki, 'urn:envai:wiki');
const current = read('openapi.json');
const legacy = read('openapi-v2.json');
ajv.addSchema(current, 'urn:envai:http:v3');
ajv.addSchema(legacy, 'urn:envai:http:v2');
const validators = new Map<string, ValidateFunction>();
function assertLegacyUsageCosts(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (['cost', 'cost_usd', 'chat_cost'].includes(key) && (typeof nested !== 'number' || !Number.isFinite(nested) || nested < 0)) throw new ProtocolError('Legacy usage contains an unrepresentable cost', value);
    assertLegacyUsageCosts(nested);
  }
}

export function validateContractValue<T>(name: string, value: unknown, version: ContractVersion = 3): T {
  if (version !== 2 && version !== 3) throw new CompatibilityError('Unsupported selected contract version');
  const root = ['Completion', 'CompletionCollection', 'ChatAttachment', 'ChatAttachmentCollection', 'AttachmentManifest', 'ChatMessageAccepted', 'NativeDeliveryReceipt', 'TeamDelegationReceipt', 'DetachedTaskSnapshot', 'PhaseClassificationResult', 'NativeDeliveryRequest', 'TeamDelegationRequest', 'PhaseClassificationRequest'].includes(name) ? `urn:envai:http:v${version}#/components/schemas/` : 'urn:envai:wiki#/$defs/';
  const ref = root + name;
  let validate = validators.get(ref);
  if (!validate) { validate = ajv.compile({ $ref: ref }); validators.set(ref, validate); }
  if (!validate(value)) throw new ProtocolError(`Invalid ${name}: ` + ajv.errorsText(validate.errors?.slice(0, 3)), value);
  if (name === 'Completion') {
    const c = value as { id: string; usage?: unknown; terminal_snapshot?: { data: { turn_id: string } } | null };
    if (version === 2) assertLegacyUsageCosts(c.usage);
    if (c.terminal_snapshot && c.terminal_snapshot.data.turn_id !== c.id) throw new ProtocolError('Completion terminal snapshot belongs to another turn', value);
  }
  if (name === 'CompletionCollection') for (const item of (value as { data: unknown[] }).data) validateContractValue('Completion', item, version);
  return value as T;
}
const responseSchemas: Record<string, string> = {
  sendChatMessage: 'ChatMessageAccepted',
  deliverWorkflowResult: 'NativeDeliveryReceipt', delegateToTeam: 'TeamDelegationReceipt', getDetachedTask: 'DetachedTaskSnapshot', classifyPhase: 'PhaseClassificationResult',
  uploadChatAttachment: 'ChatAttachment', getChatAttachment: 'ChatAttachment', retryChatAttachment: 'ChatAttachment', deleteChatAttachment: 'ChatAttachment',
  uploadWikiSource: 'WikiSource', getWikiSource: 'WikiSource', withdrawWikiSource: 'WikiSource',
  createWikiInboxRun: 'WikiOperation', createWikiOutboxRun: 'WikiOperation', createWikiSyncRun: 'WikiOperation', getWikiOperation: 'WikiOperation',
  listWikiCategories: 'Categories', getWikiCategoryIndex: 'CategoryIndex', getCompletion: 'Completion', listCompletions: 'CompletionCollection',
};
export function validateResponse(id: string, value: unknown, version: ContractVersion): unknown {
  if (['getCapabilities', 'getCapabilitiesLegacy', 'negotiateContract'].includes(id)) {
    const capability = value as { protocol_version?: unknown; contract_version?: unknown; supported_contract_versions?: unknown; legacy_v2_mode?: unknown; features?: unknown } | null;
    if (!capability || capability.protocol_version !== version || version === 3 && (capability.contract_version !== 3 || !Array.isArray(capability.supported_contract_versions) || !capability.supported_contract_versions.includes(2) || !capability.supported_contract_versions.includes(3) || capability.legacy_v2_mode !== 'historical_reads_replay_only' || !isCapabilityFeatures(capability.features))) throw new CompatibilityError('Server capabilities do not acknowledge the selected contract');
    if (version === 2 && capability.features !== undefined && !isCapabilityFeatures(capability.features)) throw new CompatibilityError('Server capabilities do not acknowledge the selected contract');
    const features = capability.features;
    if (features !== undefined && !Array.isArray(features)) value = { ...capability, features: Object.keys(features as Record<string, boolean>).filter(name => (features as Record<string, boolean>)[name]).map(name => name) };
  }
  if (id === 'cancelDetachedTask') {
    const result = value as { task_id?: unknown; status?: unknown; subtree?: unknown } | null;
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.task_id !== 'string' || !result.task_id || result.status !== 'cancelled' || typeof result.subtree !== 'boolean' || Object.keys(result).some(key => !['task_id', 'status', 'subtree'].includes(key))) throw new ProtocolError('Invalid task cancellation receipt', value);
  }
  if (id === 'listChatAttachments') validateContractValue('ChatAttachmentCollection', { data: value }, version);
  const name = responseSchemas[id];
  return name ? validateContractValue(name, value, version) : value;
}

export function validateBackgroundRequest(id: string, value: unknown): void {
  const name = ({ deliverWorkflowResult: 'NativeDeliveryRequest', delegateToTeam: 'TeamDelegationRequest', classifyPhase: 'PhaseClassificationRequest' } as Record<string, string>)[id];
  if (name) validateContractValue(name, value);
  if (id === 'classifyPhase' && (value as { task_context: unknown }).task_context === null) throw new ProtocolError('task_context must be non-null JSON');
  if (id === 'cancelDetachedTask' && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'subtree') || ('subtree' in value && typeof value.subtree !== 'boolean'))) throw new ProtocolError('Invalid task cancellation body');
}

// Optional complete HTTP boundary validation. References stay in the pinned
// document, so schema composition, required fields and additive-field policy
// are the canonical contract rather than a separately maintained model list.
type SchemaObject = Record<string, unknown>;
interface HttpSchemaOperation { root: SchemaObject; prefix: string; item: SchemaObject; operation: SchemaObject; pointer: string; itemPointer: string }
const pointerToken = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');
function schemaObject(value: unknown): SchemaObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as SchemaObject : {}; }
function resolveSchema(root: SchemaObject, value: unknown, pointer: string): { value: SchemaObject; pointer: string } {
  let object = schemaObject(value); const seen = new Set<string>();
  while (typeof object.$ref === 'string') {
    const ref = object.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) throw new ProtocolError('Unsupported or cyclic HTTP schema reference');
    seen.add(ref); pointer = ref;
    object = schemaObject(ref.slice(2).split('/').reduce<unknown>((node, key) => schemaObject(node)[key.replace(/~1/g, '/').replace(/~0/g, '~')], root));
  }
  return { value: object, pointer };
}
const httpSchemaOperations = new Map<string, HttpSchemaOperation>();
for (const [version, document] of [[3, current], [2, legacy]] as const) {
  const root = document as SchemaObject;
  for (const [path, rawItem] of Object.entries(schemaObject(root.paths))) {
    const item = schemaObject(rawItem), itemPointer = `#/paths/${pointerToken(path)}`;
    for (const [method, rawOperation] of Object.entries(item)) {
      const operation = schemaObject(rawOperation);
      if (typeof operation.operationId === 'string') httpSchemaOperations.set(`${version}:${operation.operationId}`, { root, prefix: `urn:envai:http:v${version}`, item, operation, pointer: `${itemPointer}/${method}`, itemPointer });
    }
  }
}
ajv.addFormat('binary', true);
function httpOperation(id: string, version: ContractVersion): HttpSchemaOperation {
  const operation = httpSchemaOperations.get(`${version}:${id === 'negotiateContract' ? 'getCapabilities' : version === 2 ? id.replace(/Legacy$/, '') : id}`);
  if (!operation) throw new ProtocolError(`No canonical HTTP schema for ${id} in contract ${version}`);
  return operation;
}
function assertHttpSchema(operation: HttpSchemaOperation, pointer: string, value: unknown, label: string): void {
  const ref = operation.prefix + pointer; let validate = validators.get(ref);
  if (!validate) { validate = ajv.compile({ $ref: ref }); validators.set(ref, validate); }
  if (!validate(value)) throw new ProtocolError(`Invalid ${label}: ` + ajv.errorsText(validate.errors?.slice(0, 3)));
}
/** Project actual binary values only at declared binary slots, without changing request data. */
function projectHttpBody(operation: HttpSchemaOperation, schema: unknown, value: unknown): unknown {
  const resolved = resolveSchema(operation.root, schema, '').value;
  if (resolved.format === 'binary') { if (!(value instanceof Blob)) throw new ProtocolError('HTTP binary request field must be a Blob'); return ''; }
  if (Array.isArray(value) && resolved.items) return value.map(item => projectHttpBody(operation, resolved.items, item));
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    const properties = schemaObject(resolved.properties);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, properties[key] ? projectHttpBody(operation, properties[key], item) : item]));
  }
  return value;
}
export function validateHttpRequest(id: string, params: Record<string, unknown>, version: ContractVersion): void {
  const operation = httpOperation(id, version);
  for (const [owner, pointer] of [[operation.item, operation.itemPointer], [operation.operation, operation.pointer]] as const) {
    const parameters = owner.parameters;
    if (!Array.isArray(parameters)) continue;
    parameters.forEach((raw, index) => {
      const parameter = resolveSchema(operation.root, raw, `${pointer}/parameters/${index}`);
      if (!['path', 'query'].includes(String(parameter.value.in))) return;
      const value = params[String(parameter.value.name)];
      if (value === undefined) { if (parameter.value.required) throw new ProtocolError(`Missing HTTP ${String(parameter.value.name)}`); return; }
      if (parameter.value.schema !== undefined) assertHttpSchema(operation, `${parameter.pointer}/schema`, value, `${id} ${String(parameter.value.name)}`);
    });
  }
  if (operation.operation.requestBody !== undefined) {
    const body = resolveSchema(operation.root, operation.operation.requestBody, `${operation.pointer}/requestBody`);
    if (params.body === undefined) { if (body.value.required) throw new ProtocolError(`Missing ${id} request body`); return; }
    const [mime, entry] = Object.entries(schemaObject(body.value.content))[0] ?? [];
    const schema = schemaObject(entry).schema;
    if (mime && schema !== undefined) {
      let projected: unknown;
      try { projected = JSON.parse(JSON.stringify(projectHttpBody(operation, schema, params.body), (_key, value: unknown) => { if(typeof value === 'number' && !Number.isFinite(value)) throw new ProtocolError('HTTP request numbers must be finite'); return value; })); }
      catch(error) { if(error instanceof ProtocolError) throw error; throw new ProtocolError('HTTP request body is not serializable JSON'); }
      assertHttpSchema(operation, `${body.pointer}/content/${pointerToken(mime)}/schema`, projected, `${id} request body`);
    }
  }
}
export function validateHttpResponse(id: string, status: number, value: unknown, version: ContractVersion): void {
  const operation = httpOperation(id, version), responses = schemaObject(operation.operation.responses);
  const code = Object.hasOwn(responses, String(status)) ? String(status) : Object.hasOwn(responses, '2XX') ? '2XX' : undefined;
  if (!code) throw new ProtocolError(`Undeclared success status for ${id}`);
  const response = resolveSchema(operation.root, responses[code], `${operation.pointer}/responses/${code}`);
  const schema = schemaObject(schemaObject(response.value.content)['application/json']).schema;
  if (schema !== undefined) assertHttpSchema(operation, `${response.pointer}/content/application~1json/schema`, value, `${id} response`);
}
