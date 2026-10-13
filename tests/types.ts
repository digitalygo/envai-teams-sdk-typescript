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
function sourceState(source: WikiSource) { const status: 'queued' | 'running' | 'completed' | 'failed' = source.conversion.status; return status; }
function webhookState(event: WikiWebhookEvent) {
  if (event.event_type === 'wiki.inbox.file.processed') { const revision: number = event.source_revision; return revision; }
  if (event.event_type === 'wiki.outbox.file.deleted') { const old: string | null = event.previous_canonical_raw_path; return old; }
  const total: UsageCost['totals'] = event.usage_cost.totals; return total;
}
void invalidLegacy; void nullable; void rounded; void legacyCost; void sourceState; void webhookState;
