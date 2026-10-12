# HTTP operation inventory

Generated contract snapshot: API 2.0.0, 52 operations. Paths are relative to the API prefix except the origin-level JWKS endpoint.

| Operation ID / client method | HTTP | Path | Bearer |
| --- | --- | --- | --- |
| sendChatMessage | POST | `/chats/{chat_id}/messages` | Yes |
| streamChatEvents | GET | `/chats/{chat_id}/events` | Yes |
| cancelChatTurn | POST | `/chats/{chat_id}/cancel` | Yes |
| steerChatTurn | POST | `/chats/{chat_id}/steer` | Yes |
| resolveChatTool | POST | `/chats/{chat_id}/tool-output` | Yes |
| resolveChatApproval | POST | `/chats/{chat_id}/approval` | Yes |
| forkChat | POST | `/chats/{chat_id}/fork` | Yes |
| restoreChat | POST | `/chats/{chat_id}/restore` | Yes |
| getCapabilities | GET | `/capabilities` | Yes |
| healthCheck | GET | `/up` | No |
| getJwks | GET | `/.well-known/jwks.json` | No |
| createWorkspace | POST | `/workspaces` | Yes |
| listWorkspaces | GET | `/workspaces` | Yes |
| getWorkspace | GET | `/workspaces/{workspace_id}` | Yes |
| updateWorkspace | PUT | `/workspaces/{workspace_id}` | Yes |
| createUserTool | POST | `/tools` | Yes |
| listUserTools | GET | `/tools` | Yes |
| getUserTool | GET | `/tools/{name}` | Yes |
| updateUserTool | PUT | `/tools/{name}` | Yes |
| deleteUserTool | DELETE | `/tools/{name}` | Yes |
| createChat | POST | `/workspaces/{workspace_id}/chats` | Yes |
| listChats | GET | `/workspaces/{workspace_id}/chats` | Yes |
| getChat | GET | `/workspaces/{workspace_id}/chats/{chat_id}` | Yes |
| listCompletions | GET | `/workspaces/{workspace_id}/chats/{chat_id}/completions` | Yes |
| getCompletion | GET | `/workspaces/{workspace_id}/chats/{chat_id}/completions/{completion_id}` | Yes |
| indexWorkspaceFiles | GET | `/workspaces/{workspace_id}/files` | Yes |
| createWorkspaceFile | POST | `/workspaces/{workspace_id}/files` | Yes |
| updateWorkspaceFile | PUT | `/workspaces/{workspace_id}/files` | Yes |
| deleteWorkspaceFile | DELETE | `/workspaces/{workspace_id}/files` | Yes |
| downloadWorkspaceFile | GET | `/workspaces/{workspace_id}/files/download` | Yes |
| convertWorkspaceFileToPdf | POST | `/workspaces/{workspace_id}/files/convert-to-pdf` | Yes |
| createAgent | POST | `/agents` | Yes |
| listAgents | GET | `/agents` | Yes |
| getAgent | GET | `/agents/{agent_id}` | Yes |
| updateAgent | PUT | `/agents/{agent_id}` | Yes |
| deleteAgent | DELETE | `/agents/{agent_id}` | Yes |
| createTeam | POST | `/teams` | Yes |
| listTeams | GET | `/teams` | Yes |
| getTeam | GET | `/teams/{team_id}` | Yes |
| updateTeam | PUT | `/teams/{team_id}` | Yes |
| deleteTeam | DELETE | `/teams/{team_id}` | Yes |
| listModels | GET | `/models` | Yes |
| createApiKey | POST | `/api-keys` | Yes |
| listApiKeys | GET | `/api-keys` | Yes |
| deleteApiKey | DELETE | `/api-keys/{key_id}` | Yes |
| testGenerateImage | POST | `/tests/images/generate` | No |
| createImageGeneration | POST | `/images/generations` | Yes |
| getImageGeneration | GET | `/images/generations/{record}` | Yes |
| uploadImage | POST | `/images/uploads` | Yes |
| listImageModels | GET | `/images/models` | Yes |
| downloadArtifact | GET | `/artifacts/download` | No |
| handleProviderWebhook | POST | `/webhooks/providers/{provider}` | No |
