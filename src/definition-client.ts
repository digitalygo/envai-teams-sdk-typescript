import type { EnvaiClient } from './client.js';
import type { DefinitionRemote } from './definition-sync.js';
import type { DefinitionPayload, DefinitionType } from './definitions.js';
import type { AgentCreateRequest, AgentUpdateRequest, TeamCreateRequest, TeamUpdateRequest, UserToolCreateRequest, UserToolUpdateRequest } from './generated.js';
import { EnvaiError } from './errors.js';

/** Uses the client's authenticated, validated transport; only a real HTTP 404 means absent. */
export class ClientDefinitionRemote implements DefinitionRemote {
  constructor(readonly client: EnvaiClient) {}
  async models(): Promise<readonly string[]> { return (await this.client.listModels()).data.filter(model => model.type === 'llm').map(model => model.id); }
  async list(type: DefinitionType): Promise<DefinitionPayload[]> {
    if (type === 'tool') return this.client.listUserTools();
    if (type === 'agent') return this.client.listAgents();
    return this.client.listTeams();
  }
  async get(type: DefinitionType, id: string, name: string): Promise<DefinitionPayload | undefined> {
    try {
      if (type === 'tool') return await this.client.getUserTool({ name });
      if (type === 'agent') return await this.client.getAgent({ agent_id: id });
      return await this.client.getTeam({ team_id: id });
    } catch (error) { if (error instanceof EnvaiError && error.httpStatus === 404) return undefined; throw error; }
  }
  async create(type: DefinitionType, payload: DefinitionPayload): Promise<DefinitionPayload> {
    if (type === 'tool') return this.client.createUserTool({ body: payload as UserToolCreateRequest });
    if (type === 'agent') return this.client.createAgent({ body: payload as AgentCreateRequest });
    return this.client.createTeam({ body: payload as TeamCreateRequest });
  }
  async update(type: DefinitionType, id: string, name: string, payload: DefinitionPayload): Promise<DefinitionPayload> {
    if (type === 'tool') {
      const { name: _name, kind: _kind, ...body } = payload;
      return this.client.updateUserTool({ name, body: body as UserToolUpdateRequest });
    }
    if (type === 'agent') return this.client.updateAgent({ agent_id: id, body: payload as AgentUpdateRequest });
    return this.client.updateTeam({ team_id: id, body: payload as TeamUpdateRequest });
  }
  async delete(type: DefinitionType, id: string, name: string): Promise<void> {
    if (type === 'tool') return this.client.deleteUserTool({ name });
    if (type === 'agent') return this.client.deleteAgent({ agent_id: id });
    return this.client.deleteTeam({ team_id: id });
  }
}
