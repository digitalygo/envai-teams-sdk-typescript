import { ProtocolError } from './errors.js';
import type { RequestOptions } from './http.js';
import type { GetProjectLogsParams, GetProjectUsageParams } from './generated.js';

const projectResourceOperations = new Set([
  'deleteWorkspace', 'updateChat', 'deleteChat',
  'listChatCrons', 'getChatCron', 'updateChatCron', 'deleteChatCron',
  'listProjectSkills', 'createProjectSkill', 'getProjectSkill', 'updateProjectSkill', 'deleteProjectSkill',
  'getProjectUsage', 'getProjectLogs',
]);
export function isProjectResourceOperation(id: string): boolean { return projectResourceOperations.has(id); }

export type ProjectLogView = 'events' | 'analytics' | 'filters';
export interface ProjectUsageFilters {
  from?: string;
  to?: string;
  api_key_id?: string;
  page?: number;
  per_page?: number;
}
export interface ProjectEventFilters extends ProjectUsageFilters {
  view?: 'events';
  chat_id?: string;
  type?: string;
  types?: readonly string[];
  workspace_ids?: readonly string[];
  api_key_ids?: readonly string[];
}
export interface ProjectAnalyticsFilters {
  view?: 'analytics';
  from?: string;
  to?: string;
  api_key_id?: string;
  chat_id?: string;
}
export interface ProjectTypeCatalogFilters {
  view?: 'filters';
  from?: string;
  to?: string;
}
export interface ProjectReportIterationOptions extends RequestOptions {
  startPage?: number;
  maxPages?: number;
}

const ulid = '[0-7][0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{25}';
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const nul = /\0/u;
const nonWhitespace = /\S/u;
const skillNamePattern = /^[a-z][a-z0-9_-]{0,63}$/;
const reservedSkillNames = new Set(['filesystem', 'read_wiki', 'read_skills', 'memory', 'execute', 'server_tools', 'write_wiki', 'create_skills']);
const usageKeys = ['project_id', 'from', 'to', 'api_key_id', 'page', 'per_page'];
const eventKeys = ['project_id', 'view', 'from', 'to', 'api_key_id', 'chat_id', 'type', 'types[]', 'workspace_ids[]', 'api_key_ids[]', 'page', 'per_page'];
const analyticsKeys = ['project_id', 'view', 'from', 'to', 'api_key_id', 'chat_id'];
const filtersKeys = ['project_id', 'view', 'from', 'to'];
const titleKeys = ['title'];
const skillKeys = ['name', 'description', 'content'];
const cronKeys = ['target_mode', 'prompt', 'interval_minutes', 'daily_at', 'timezone', 'start_at', 'repeat_count', 'until'];
const listKeys: Record<string, string> = { types: 'types[]', workspace_ids: 'workspace_ids[]', api_key_ids: 'api_key_ids[]' };
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const codePoints = (value: string): number => Array.from(value).length;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function requestObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}
function responseObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError(`Invalid ${label}`, value);
  return value;
}
function responseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError(`Invalid ${label}`, value);
  return value;
}
function assertDate(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !datePattern.test(value)) throw new TypeError(`Project report filter ${field} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  const time = date.getTime();
  if (!Number.isFinite(time) || date.toISOString().slice(0, 10) !== value) throw new TypeError(`Project report filter ${field} must use a real UTC date`);
}
function assertWindow(source: Record<string, unknown>): void {
  if (source.from === undefined || source.to === undefined) return;
  const from = Date.parse(`${source.from}T00:00:00.000Z`);
  const to = Date.parse(`${source.to}T00:00:00.000Z`);
  if (from > to) throw new TypeError('Project report range start must not be after its end');
  if ((to - from) / 86_400_000 + 1 > 90) throw new TypeError('Project report range exceeds the maximum window');
}
function assertId(value: unknown, field: string): void {
  if (value === undefined) return;
  const prefix = field === 'chat_id' ? '[cC][hH][tT]' : field === 'api_key_id' ? '[kK][eE][yY]' : '[pP][rR][jJ]';
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_${ulid}$`).test(value)) throw new TypeError(`Project report filter ${field} is not a valid id`);
}
function assertType(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || codePoints(value) > 80) throw new TypeError('Project report event type filter is invalid');
}
function assertList(value: unknown, field: string, maximum: number): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 50 || Object.keys(value).length !== value.length) throw new TypeError(`Project report filter ${field} must be a list of 1 to 50 values`);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || codePoints(item) < 1 || codePoints(item) > maximum || seen.has(item)) throw new TypeError(`Project report filter ${field} contains an invalid or duplicate value`);
    seen.add(item);
  }
}
function assertPage(value: unknown, field = 'page'): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`);
}
function assertPerPage(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) throw new TypeError('per_page must be a safe integer between 1 and 100');
}
function assertReportFields(source: Record<string, unknown>, allowed: readonly string[]): void {
  for (const [key, value] of Object.entries(source)) {
    if (!allowed.includes(key)) throw new TypeError(`Unsupported project report filter ${key}`);
    if (value === undefined || value === null) throw new TypeError(`Project report filter ${key} must not be null`);
  }
  assertDate(source.from, 'from');
  assertDate(source.to, 'to');
  assertWindow(source);
  assertId(source.api_key_id, 'api_key_id');
  assertId(source.chat_id, 'chat_id');
  assertType(source.type);
  assertList(source.types ?? source['types[]'], 'types', 80);
  assertList(source.workspace_ids ?? source['workspace_ids[]'], 'workspace_ids', 30);
  assertList(source.api_key_ids ?? source['api_key_ids[]'], 'api_key_ids', 30);
  assertPage(source.page);
  assertPerPage(source.per_page);
}
function logView(source: Record<string, unknown>): ProjectLogView {
  const view = source.view;
  if (view === undefined) return 'events';
  if (view === 'events' || view === 'analytics' || view === 'filters') return view;
  throw new TypeError('Invalid project log view');
}
export function validateUsageQuery(params: Record<string, unknown>): void {
  const source = requestObject(params, 'project usage query');
  assertReportFields(source, usageKeys);
  assertId(source.project_id, 'project_id');
}
export function validateLogQuery(params: Record<string, unknown>): void {
  const source = requestObject(params, 'project log query');
  const view = logView(source);
  const allowed = view === 'analytics' ? analyticsKeys : view === 'filters' ? filtersKeys : eventKeys;
  assertReportFields(source, allowed);
  assertId(source.project_id, 'project_id');
  if (own(source, 'type') && own(source, 'types[]')) throw new TypeError('Scalar and array event type filters conflict');
  if (own(source, 'api_key_id') && own(source, 'api_key_ids[]')) throw new TypeError('Scalar and array api key filters conflict');
}
function assertAllowedKeys(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const source = requestObject(value, label);
  for (const key of Object.keys(source)) if (!allowed.includes(key)) throw new TypeError(`Unsupported ${label} field ${key}`);
  return source;
}
function assertTitleBody(value: unknown): void {
  const body = assertAllowedKeys(value, titleKeys, 'chat update request');
  if (!own(body, 'title') || body.title === undefined || body.title !== null && (typeof body.title !== 'string' || codePoints(body.title) > 255)) throw new TypeError('Chat update request requires title as a string, null to clear, or no other field');
}
function assertSkillBody(id: string, value: unknown): void {
  const body = assertAllowedKeys(value, skillKeys, `${id} request`);
  if (id === 'createProjectSkill' && (body.name === undefined || body.content === undefined)) throw new TypeError('Project skill creation requires name and content');
  if (typeof body.name === 'string' && (nul.test(body.name) || codePoints(body.name) > 64 || !skillNamePattern.test(body.name) || reservedSkillNames.has(body.name))) throw new TypeError('Invalid project skill name');
  if (typeof body.description === 'string' && nul.test(body.description)) throw new TypeError('Invalid project skill description');
  if (typeof body.content === 'string' && (nul.test(body.content) || !nonWhitespace.test(body.content))) throw new TypeError('Invalid project skill Markdown');
}
function assertCronBody(value: unknown): void {
  assertAllowedKeys(value, cronKeys, 'chat cron update request');
}
export function validateProjectResourceRequest(id: string, params: Record<string, unknown>, parameters: readonly { readonly name: string; readonly in: string }[]): void {
  const declared = new Set<string>(['body']);
  for (const parameter of parameters) if (parameter.in === 'path' || parameter.in === 'query') declared.add(parameter.name);
  for (const key of Object.keys(params)) if (!declared.has(key)) throw new TypeError(`Unsupported ${id} parameter ${key}`);
  if (id === 'getProjectUsage') validateUsageQuery(params);
  else if (id === 'getProjectLogs') validateLogQuery(params);
  else if (id === 'updateChat') assertTitleBody(params.body);
  else if (id === 'createProjectSkill' || id === 'updateProjectSkill') assertSkillBody(id, params.body);
  else if (id === 'updateChatCron') assertCronBody(params.body);
  else if (params.body !== undefined) throw new TypeError(`${id} does not accept a request body`);
}
export function projectUsageParams(projectId: string, filters: ProjectUsageFilters = {}, page?: number): GetProjectUsageParams {
  const source = requestObject(filters, 'project usage filters');
  const params: Record<string, unknown> = { project_id: projectId };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!usageKeys.includes(key)) throw new TypeError(`Unsupported project report filter ${key}`);
    if (own(params, key)) throw new TypeError(`Duplicate project report filter ${key}`);
    params[key] = value;
  }
  validateUsageQuery(params);
  if (page !== undefined) {
    assertPage(page);
    if (page > 1 || own(source, 'page')) params.page = page;
  }
  return params as GetProjectUsageParams;
}
export function projectLogParams(projectId: string, filters: ProjectEventFilters | ProjectAnalyticsFilters | ProjectTypeCatalogFilters, view: ProjectLogView, page?: number): GetProjectLogsParams {
  const source = requestObject(filters, 'project log filters');
  const params: Record<string, unknown> = { project_id: projectId, view };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key === 'view') {
      if (value !== view) throw new TypeError('Conflicting project log view');
      continue;
    }
    const mapped = listKeys[key] ?? key;
    if (own(params, mapped)) throw new TypeError(`Duplicate project report filter ${key}`);
    params[mapped] = value;
  }
  validateLogQuery(params);
  if (page !== undefined) {
    assertPage(page);
    if (page > 1 || own(source, 'page')) params.page = page;
  }
  return params as GetProjectLogsParams;
}
export function prepareProjectLogResponse(id: string, value: unknown, params: Record<string, unknown>): unknown {
  if (id !== 'getProjectLogs') return value;
  const view = params.view === 'analytics' ? 'analytics' : params.view === 'filters' ? 'filters' : 'events';
  const root = responseObject(value, 'project log response');
  if (view === 'events') {
    const data = responseArray(root.data, 'project log events');
    responseObject(root.links, 'project log links');
    responseObject(root.meta, 'project log meta');
    return { ...root, data: data.map(entry => {
      const item = responseObject(entry, 'project log entry');
      const result: Record<string, unknown> = { ...item };
      for (const field of ['agent', 'data']) {
        const fieldValue = result[field];
        if (Array.isArray(fieldValue)) {
          if (fieldValue.length !== 0) throw new ProtocolError(`Project log ${field} must be an empty array or object`, value);
          result[field] = {};
        } else responseObject(fieldValue, `project log ${field}`);
      }
      return result;
    }) };
  }
  const data = responseObject(root.data, 'project log view data');
  if (view === 'analytics') {
    responseObject(data.window, 'project analytics window');
    responseObject(data.coverage, 'project analytics coverage');
    responseArray(data.daily, 'project analytics daily');
    responseObject(data.event_types, 'project analytics event types');
    responseObject(data.tools, 'project analytics tools');
    responseObject(data.failures, 'project analytics failures');
    responseObject(data.durations, 'project analytics durations');
    responseArray(data.file_reads, 'project analytics file reads');
    return value;
  }
  responseArray(data.types, 'project log filter types');
  return value;
}
