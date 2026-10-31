import { EnvaiClient, type ChatCreateRequest, type AgentCreateRequest, type ToolOutputRequest, type ATPEvent, isEvent } from '../src/index.js';
const client = new EnvaiClient({ baseUrl: 'https://example.test' });
void client.chats.create({ workspace_id: 'wsp_example', body: { team_id: 'team_example' } });
// @ts-expect-error team_id is mandatory, not a runtime fallback.
const missingTeam: ChatCreateRequest = {};
// @ts-expect-error client tool visibility contains objects, not strings.
const wrongAgent: AgentCreateRequest = { name: 'agent', system_prompt: 'text', mode: 'primary', external_tools_enabled: ['echo'] };
// @ts-expect-error structured outputs must first be serialized into a string.
const wrongOutput: ToolOutputRequest = { call_id: 'tc_example', output: { ok: true } };
function consume(event: ATPEvent) {
  if (isEvent(event, 'agent.text.delta')) { const text: string = event.data.delta; return text; }
  if (isEvent(event, 'turn.completed')) { const duration: number = event.data.usage.duration_ms; return duration; }
  return event.type;
}
void missingTeam; void wrongAgent; void wrongOutput; void consume;

import { type LegacyAtpUsage, type AtpUsage, type UsageCost, parseEvent, type WikiSource, type WikiWebhookEvent } from '../src/index.js';
// @ts-expect-error Legacy ATPv2 cost is strictly numeric.
const invalidLegacy: LegacyAtpUsage = { input_tokens: 0, output_tokens: 0, cost_usd: null, duration_ms: 0 };
const nullable: AtpUsage = { input_tokens: 0, output_tokens: 0, cost_usd: null, duration_ms: 0 };
// @ts-expect-error Decimal amount is a string, not a JavaScript number.
const rounded: UsageCost['priced_subtotals'][number] = { currency: 'USD', amount: 0.1 };
// @ts-expect-error Upload/run keys are explicit and mandatory.
void client.wiki.inbox({ workspace_id: 'w', body: { webhook_url: 'https://app.example/hook' } });
function legacyCost(raw: unknown) {
  const parsed = parseEvent(raw, 2);
  if (parsed.known && parsed.type === 'turn.completed') { const amount: number = parsed.data.cost; return amount; }
}
function sourceState(source: WikiSource) { const status: 'queued' | 'running' | 'completed' | 'failed' | 'not_required' = source.conversion.status; return status; }
function webhookState(event: WikiWebhookEvent) {
  if (event.event_type === 'wiki.inbox.file.processed') { const revision: number = event.source_revision; return revision; }
  if (event.event_type === 'wiki.outbox.file.deleted') { const old: string | null = event.previous_canonical_raw_path; return old; }
  const total: UsageCost['totals'] = event.usage_cost.totals; return total;
}
void invalidLegacy; void nullable; void rounded; void legacyCost; void sourceState; void webhookState;

import type { WorkspaceUpdateRequest, UserToolUpdateRequest, AgentUpdateRequest, TeamUpdateRequest, CompletionPageParams } from '../src/index.js';
const workspaceUpdate: WorkspaceUpdateRequest = { name: 'updated' };
const toolUpdate: UserToolUpdateRequest = { description: null };
const agentUpdate: AgentUpdateRequest = { model: null, can_write_skills: true };
const teamUpdate: TeamUpdateRequest = { members: [] };
// @ts-expect-error Updates require at least one declared field.
const emptyWorkspaceUpdate: WorkspaceUpdateRequest = {};
// @ts-expect-error The optional field still has its declared type.
const invalidWorkspaceUpdate: WorkspaceUpdateRequest = { name: false };
// @ts-expect-error Tool updates cannot set name.
const invalidToolUpdate: UserToolUpdateRequest = { name: 'rename' };
// @ts-expect-error Agent model is string or null, not a number.
const invalidAgentUpdate: AgentUpdateRequest = { model: 123 };
// @ts-expect-error Agent updates require an updatable property.
const emptyAgentUpdate: AgentUpdateRequest = {};
// @ts-expect-error Team member replacement is an array.
const invalidTeamUpdate: TeamUpdateRequest = { members: 'all' };
// @ts-expect-error Team updates require an updatable property.
const emptyTeamUpdate: TeamUpdateRequest = {};
const completionPage: CompletionPageParams = {workspace_id:'w',chat_id:'c',page:2};
void workspaceUpdate; void toolUpdate; void agentUpdate; void teamUpdate; void emptyWorkspaceUpdate; void invalidWorkspaceUpdate; void invalidToolUpdate; void invalidAgentUpdate; void emptyAgentUpdate; void invalidTeamUpdate; void emptyTeamUpdate; void completionPage;
