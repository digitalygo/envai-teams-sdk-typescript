import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ProtocolError } from './errors.js';

export type ContractVersion = 2 | 3;
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
  const root = ['Completion', 'CompletionCollection', 'ChatAttachment', 'ChatAttachmentCollection'].includes(name) ? `urn:envai:http:v${version}#/components/schemas/` : 'urn:envai:wiki#/$defs/';
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
  uploadChatAttachment: 'ChatAttachment', getChatAttachment: 'ChatAttachment', retryChatAttachment: 'ChatAttachment', deleteChatAttachment: 'ChatAttachment',
  uploadWikiSource: 'WikiSource', getWikiSource: 'WikiSource', withdrawWikiSource: 'WikiSource',
  createWikiInboxRun: 'WikiOperation', createWikiOutboxRun: 'WikiOperation', createWikiSyncRun: 'WikiOperation', getWikiOperation: 'WikiOperation',
  listWikiCategories: 'Categories', getWikiCategoryIndex: 'CategoryIndex', getCompletion: 'Completion', listCompletions: 'CompletionCollection',
};
export function validateResponse(id: string, value: unknown, version: ContractVersion): unknown {
  if (['getCapabilities', 'getCapabilitiesLegacy', 'negotiateContract'].includes(id)) {
    const capability = value as { protocol_version?: unknown; contract_version?: unknown; supported_contract_versions?: unknown; legacy_v2_mode?: unknown } | null;
    if (!capability || capability.protocol_version !== version || version === 3 && (capability.contract_version !== 3 || !Array.isArray(capability.supported_contract_versions) || !capability.supported_contract_versions.includes(2) || !capability.supported_contract_versions.includes(3) || capability.legacy_v2_mode !== 'historical_reads_replay_only')) throw new CompatibilityError('Server capabilities do not acknowledge the selected contract');
  }
  if (id === 'listChatAttachments') validateContractValue('ChatAttachmentCollection', { data: value }, version);
  const name = responseSchemas[id];
  return name ? validateContractValue(name, value, version) : value;
}
