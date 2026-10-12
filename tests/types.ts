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
