import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { parseDocument } from 'yaml';
import { canonicalize } from './security.js';

export type DefinitionType = 'tool' | 'agent' | 'team';
export type DefinitionPayload = Record<string, unknown>;
export interface DefinitionManifest { format_version: '1'; tools: Record<string, DefinitionPayload>; agents: Record<string, DefinitionPayload>; teams: Record<string, DefinitionPayload> }
export const definitionTypes = ['tool', 'agent', 'team'] as const;
export const definitionMap = (type: DefinitionType): 'tools' | 'agents' | 'teams' => `${type}s`;
export function definitionObject(value: unknown): value is DefinitionPayload { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new TypeError(message); }
function names(value: unknown): { name: string }[] {
  requireValue(Array.isArray(value), 'Tool references must be arrays');
  const set = new Set<string>();
  for (const entry of value) { requireValue(definitionObject(entry) && typeof entry.name === 'string' && entry.name.length > 0 && Object.keys(entry).length === 1, 'Tool references require only a name'); set.add(entry.name); }
  return [...set].sort().map(name => ({ name }));
}
function noMaxTokens(value: unknown): void { if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { requireValue(key !== 'max_tokens', 'config.max_tokens is unsupported'); noMaxTokens(item); } }
/** Pure validation/normalization. No I/O, handlers, credentials, or server IDs enter the manifest. */
export function compileDefinitions(input: unknown, models?: readonly string[]): DefinitionManifest {
  requireValue(definitionObject(input) && input.format_version === '1', 'Definition format_version must be "1"');
  requireValue(Object.keys(input).every(k => ['format_version', 'tools', 'agents', 'teams'].includes(k)), 'Unknown manifest property');
  canonicalize(input); // Reject non-JSON values before cloning.
  const manifest = structuredClone(input) as unknown as DefinitionManifest;
  for (const type of definitionTypes) {
    const map = manifest[definitionMap(type)]; requireValue(definitionObject(map), `${type} definitions must be object maps`);
    const remoteNames = new Set<string>();
    for (const [key, payload] of Object.entries(map)) {
      requireValue(key.length > 0 && definitionObject(payload), 'Definition keys and payloads must be nonempty');
      requireValue(typeof payload.name === 'string' && payload.name.trim().length > 0 && !remoteNames.has(payload.name), `Invalid/duplicate ${type} name`); remoteNames.add(payload.name);
      const allowed = type === 'tool' ? ['name', 'kind', 'description', 'parameters', 'timeout_seconds'] : type === 'agent' ? ['name','description','system_prompt','mode','model','tools_enabled','external_tools_enabled','permissions','can_write_knowledge','can_write_skills','config'] : ['name','description','orchestrator_id','members'];
      requireValue(Object.keys(payload).every(k => allowed.includes(k)), `Unknown ${type} definition property`);
      if ('description' in payload) requireValue(payload.description === null || typeof payload.description === 'string', 'description must be string or null');
      if (type === 'tool') {
        requireValue(payload.name === key && payload.kind === 'client', 'Tool key must equal immutable client tool name');
        requireValue(definitionObject(payload.parameters) && payload.parameters.type === 'object', 'Tool parameters must have an object root');
        if (!('timeout_seconds' in payload)) payload.timeout_seconds = 120;
        requireValue(typeof payload.timeout_seconds === 'number' && Number.isInteger(payload.timeout_seconds), 'Tool timeout must be an integer');
        payload.timeout_seconds = Math.max(1, Math.min(600, payload.timeout_seconds));
      } else if (type === 'agent') {
        requireValue(typeof payload.system_prompt === 'string' && payload.system_prompt.trim().length > 0, 'Agent prompt must be nonempty');
        payload.system_prompt = payload.system_prompt.replace(/\r\n?/g, '\n');
        requireValue(['primary', 'subagent'].includes(String(payload.mode)), 'Invalid agent mode');
        for (const field of ['can_write_knowledge','can_write_skills']) requireValue(typeof payload[field] === 'boolean', `${field} must be boolean`);
        for (const field of ['permissions','config']) if (field in payload) requireValue(payload[field] === null || definitionObject(payload[field]), `${field} must be object or null`);
        noMaxTokens(payload.config);
        if ('model' in payload) requireValue(payload.model === null || typeof payload.model === 'string' && (!models || models.includes(payload.model)), 'Unknown/invalid model');
        for (const field of ['tools_enabled','external_tools_enabled']) if (field in payload && payload[field] !== null) payload[field] = names(payload[field]);
      }
    }
  }
  for (const agent of Object.values(manifest.agents)) for (const tool of (agent.external_tools_enabled ?? []) as { name: string }[]) requireValue(Object.hasOwn(manifest.tools, tool.name), `Unresolved client tool ${tool.name}`);
  for (const team of Object.values(manifest.teams)) {
    requireValue(typeof team.orchestrator_id === 'string' && manifest.agents[team.orchestrator_id]?.mode === 'primary', 'Team orchestrator must reference a primary agent');
    requireValue(Array.isArray(team.members), 'Team members must be an array');
    const seen = new Set<string>();
    for (const member of team.members) {
      requireValue(definitionObject(member) && Object.keys(member).every(k => ['agent_definition_id','role'].includes(k)), 'Invalid team member');
      const key = member.agent_definition_id;
      requireValue(typeof key === 'string' && !seen.has(key) && key !== team.orchestrator_id && manifest.agents[key]?.mode === 'subagent', 'Team members must reference distinct subagents');
      requireValue(member.role === null || typeof member.role === 'string', 'Member role must be string or null'); seen.add(key);
    }
  }
  return manifest;
}
export function definitionHash(value: unknown): string { return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`; }
export function manifestHash(manifest: DefinitionManifest): string { return definitionHash(compileDefinitions(manifest)); }
export function resourceHash(type: DefinitionType, key: string, payload: DefinitionPayload): string { return definitionHash({format_version:'1',tools:{},agents:{},teams:{},[definitionMap(type)]:{[key]:payload}}); }
export function compileAgentMarkdown(key: string, source: string): DefinitionPayload {
  const text = source.replace(/\r\n?/g, '\n'); const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  requireValue(match, 'Agent Markdown requires YAML frontmatter delimiters');
  const document = parseDocument(match[1]!, { uniqueKeys: true }); requireValue(document.errors.length === 0, 'Invalid YAML frontmatter');
  const front = document.toJS({maxAliasCount: 0}) as unknown; requireValue(definitionObject(front) && front.format === 1, 'Agent format must be 1');
  requireValue(Object.keys(front).every(k => ['format','name','description','mode','model','tools','permissions','can_write_knowledge','can_write_skills','config'].includes(k)), 'Unknown frontmatter property');
  const payload: DefinitionPayload = { name: front.name ?? key, system_prompt: match[2]!.trim(), mode: front.mode, can_write_knowledge: front.can_write_knowledge ?? false, can_write_skills: front.can_write_skills ?? false };
  for (const field of ['description','model','permissions','config']) if (field in front) payload[field] = front[field];
  if ('tools' in front) {
    requireValue(definitionObject(front.tools) && Object.keys(front.tools).every(k => ['server','client'].includes(k)), 'Invalid tools mapping');
    for (const [kind, field] of [['server','tools_enabled'],['client','external_tools_enabled']] as const) if (kind in front.tools) { const items = front.tools[kind]; requireValue(Array.isArray(items) && items.every(v => typeof v === 'string'), 'Tool names must be strings'); payload[field] = items.map(name => ({name})); }
  }
  // The complete compiler resolves client references; validate this agent with placeholder tools here.
  const tools = Object.fromEntries(((payload.external_tools_enabled ?? []) as {name:string}[]).map(({name}) => [name,{name,kind:'client',parameters:{type:'object'}}]));
  return compileDefinitions({format_version:'1',tools,agents:{[key]:payload},teams:{}}).agents[key]!;
}
/** A JSON file, or directory containing manifest.json and optional agents/*.md. */
export async function loadDefinitions(path: string): Promise<DefinitionManifest> {
  if (extname(path) === '.json') return compileDefinitions(JSON.parse(await readFile(path,'utf8')));
  const input = JSON.parse(await readFile(join(path,'manifest.json'),'utf8')) as DefinitionManifest;
  let files: string[]; try { files = await readdir(join(path,'agents')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files = []; }
  for (const file of files.sort()) if (file.endsWith('.md')) { const key = basename(file,'.md'); requireValue(!Object.hasOwn(input.agents,key), `Duplicate agent key ${key}`); input.agents[key] = compileAgentMarkdown(key,await readFile(join(path,'agents',file),'utf8')); }
  return compileDefinitions(input);
}
/** Comparison strips server enrichment; manifest identity deliberately preserves optional presence. */
export function normalizeDefinition(type: DefinitionType, input: DefinitionPayload, agentIds: Record<string,string> = {}): DefinitionPayload {
  const payload = structuredClone(input);
  for (const key of ['id','user_id','created_at','updated_at']) delete payload[key];
  if (type === 'agent') {
    for (const field of ['tools_enabled','external_tools_enabled']) if (payload[field] != null) payload[field] = names(payload[field]);
    for (const field of ['description','model','tools_enabled','external_tools_enabled','permissions','config']) if (payload[field] == null || typeof payload[field] === 'object' && Object.keys(payload[field] as object).length === 0) delete payload[field];
  } else if (payload.description === null) delete payload.description;
  if (type === 'team') {
    payload.orchestrator_id = agentIds[String(payload.orchestrator_id)] ?? payload.orchestrator_id;
    if (Array.isArray(payload.members)) payload.members = payload.members.map(member => { const copy = {...member}; copy.agent_definition_id = agentIds[String(copy.agent_definition_id)] ?? copy.agent_definition_id; delete copy.name; delete copy.position; return copy; });
  }
  return payload;
}
