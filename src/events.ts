import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ProtocolError } from './errors.js';
import { knownEventTypes, type ATPEvent, type EventType, type KnownEvent } from './event-types.js';
const schema = JSON.parse(readFileSync(new URL('../contracts/events.json', import.meta.url), 'utf8'));
const legacy = JSON.parse(readFileSync(new URL('../contracts/events-v2.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, strictNumbers: true, allErrors: true });
// Ajv's CommonJS export carries the callable function as default in NodeNext.
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
ajv.addSchema(legacy, 'urn:envai:atp:v2');
ajv.addSchema(schema, 'urn:envai:atp:v3');
const validators = { 2: ajv.compile({ $ref: 'urn:envai:atp:v2#/$defs/Event' }), 3: ajv.compile({ $ref: 'urn:envai:atp:v3#/$defs/Event' }) };
const known = new Set<string>(knownEventTypes);
export function parseEvent(raw: string | unknown, contractVersion: 2): import('./legacy-event-types.js').LegacyATPEvent;
export function parseEvent(raw: string | unknown, contractVersion?: 2 | 3): ATPEvent;
export function parseEvent(raw: string | unknown, contractVersion: 2 | 3 = 3): ATPEvent {
  if (contractVersion !== 2 && contractVersion !== 3) throw new ProtocolError('Unsupported selected ATP version');
  let value: unknown;
  try { value = typeof raw === 'string' ? raw : structuredClone(raw); } catch { throw new ProtocolError('Event is not structured JSON'); }
  if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { throw new ProtocolError('Invalid SSE JSON', raw); } }
  if (!value || typeof value !== 'object') throw new ProtocolError('Invalid ATP envelope', value);
  const object = value as Record<string, unknown>;
  if ((object.v !== 2 && object.v !== 3) || (contractVersion === 2 && object.v !== 2)) throw new ProtocolError('Unsupported ATP version', value);
  if (!Number.isSafeInteger(object.seq)) throw new ProtocolError('Unsafe ATP sequence number', value);
  const validate = validators[object.v as 2 | 3];
  if (!validate(value)) throw new ProtocolError('Invalid ATP event: ' + ajv.errorsText(validate.errors?.slice(0, 3)), value);
  if (object.data && typeof object.data === 'object' && 'turn_id' in object.data && (object.data as Record<string, unknown>).turn_id !== object.turn_id) throw new ProtocolError('Event turn_id disagrees with its payload', value);
  return { ...object, known: known.has(String(object.type)) && (object.v === 3 || Object.hasOwn(legacy.$defs, String(object.type))) } as ATPEvent;
}
export function isEvent<T extends EventType>(event: ATPEvent, type: T): event is Extract<ATPEvent, { type: T; known: true }> { return event.known && event.type === type; }
export function isTerminal(event: ATPEvent): event is KnownEvent<'turn.completed' | 'turn.failed' | 'turn.cancelled'> {
  return isEvent(event, 'turn.completed') || isEvent(event, 'turn.failed') || isEvent(event, 'turn.cancelled');
}
