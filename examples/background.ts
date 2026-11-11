import { EnvaiClient, ClientToolRegistry, MemoryToolStateStore } from '../src/index.js';

// Construct client with nativeTasks:true to select the native-tasks-v1 extension.
export async function runPhase(client: EnvaiClient, originChatId: string, targetChatId: string, originTurnId: string, workspaceId: string, eventId: string) {
  const controller = new AbortController();
  const registry = new ClientToolRegistry().register({name:'local_lookup',parameters:{type:'object'},handler:async (_args, context) => {
    context.signal.throwIfAborted();
    return 'local result';
  }});
  // Use a durable ToolStateStore in production. Memory storage does not survive restarts.
  const runner = client.createToolRunner({scope:'my-deployment/my-account',store:new MemoryToolStateStore(),registry,signal:controller.signal});
  try {
    const result = await client.delegateAndWait(originChatId, {
      workspace_id:workspaceId,event_id:eventId,origin_turn_id:originTurnId,
      target_chat_id:targetChatId,prompt:'Complete the review phase',notify_origin:false,strict_model:true,
    }, {toolRunner:runner,signal:controller.signal});
    await runner.drain(controller.signal);
    // Check failed/cancelled explicitly. receipt.turn_id is only the initial acknowledgment turn.
    return {status:result.task.status,output:result.task.output,resultTurnId:result.task.result_turn_id};
  } finally {
    controller.abort();
    runner.close();
  }
}
