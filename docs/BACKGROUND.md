# Detached tasks and delegated jobs

This SDK adds the native workflow contract pinned in `contracts/manifest.json`.
Create a dedicated `new EnvaiClient({baseUrl, apiKey, nativeTasks:true})`. This explicitly sends `X-Envai-Extensions: native-tasks-v1` on capabilities, native mutations, turn admission, SSE/reconnects and tool results. Default clients omit the extension and preserve the existing foreground event shape. Native helpers and strict-model admission require this opt-in.

It requires a server advertising the relevant capability; it makes no claim
about compatibility of previously published SDK packages.

The typed primitives are `deliverWorkflowResult`, `delegateToTeam`,
`getDetachedTask`, `cancelDetachedTask`, and `classifyPhase`, also available as
`client.chats.deliver/delegate/task/cancelTask/classifyPhase`. They select
`/api/v1/atp/v3`, acknowledge contract version 3, and preflight advertised features.
`sendChatMessage` and delegation accept `strict_model`; delegation additionally
accepts `notify_origin`. Phase workflows should set `notify_origin:false` to avoid
automatically waking the origin model. `classifyPhase` is an explicit, potentially
paid call, never invoked automatically by the job waiter.

```ts
const { receipt, task } = await client.delegateAndWait(originChatId, {
  workspace_id: workspaceId,
  event_id: persistedEventId,
  origin_turn_id: originTurnId,
  target_chat_id: targetChatId,
  prompt: 'Review this phase',
  notify_origin: false,
  strict_model: true,
}, { toolRunner, signal });
if (task.status === 'completed') {
  console.log(task.output, task.result_turn_id);
} else {
  console.log(task.status, task.error, task.delivery_error);
}
```

`delegateAndWait` requires `delegated_job_lifecycle` as well as delegation and
background capabilities. It opens target SSE and waits for its live subscription
ping before submitting once. It keeps that stream open through origin task
terminal status, including child cohorts and synthesis turns. Tools are verified
and answered on their execution chat. The returned `task.output` is the final
job output; `task.result_turn_id` identifies its final coordinator turn.
`receipt.turn_id` is the initial coordinator turn and may only acknowledge work.
`waitForDelegatedJob(originChatId, receipt, options)` resumes a known receipt
without resubmitting it and uses the same target stream and origin task polling.
Do not supply an origin-chat cursor as the target stream's `after` cursor.

`taskEvents(chatId, {toolRunner, signal})` is a separate chat-wide subscription
that stays open across foreground terminal events. `sendAndStream` and
`sendAndWait` still end at their foreground turn terminal. Consume `taskEvents`
when same-team detached tasks can outlive that turn. The runner unwraps the
actual `task.event.event_payload`, retains its signature and execution chat,
verifies before effects, and deduplicates by scoped chat/call ID. Task terminal
barriers survive runner recreation when the supplied store is durable. Replayed
results and terminals establish barriers before replayed requests execute.

Tool runners are caller-owned and may be shared. Helpers close their streams on
return, timeout or abort, but do not close a shared runner or implicitly cancel
remote work. Supply a common `AbortSignal` to the runner and helper, abort it and
close a dedicated runner in `finally`; see `examples/background.ts`. Handlers
must cooperate with cancellation. Inspect `runner.drain()` errors and durable
state for ambiguous tool submission outcomes. A task terminal cancels its local
pending tools; an origin turn terminal does not cancel detached tools.

To cancel remotely, call `cancelDetachedTask` with `body:{subtree:true}` when the
whole subtree should stop. Best-effort cancellation cannot undo external effects.
Failed and cancelled jobs are returned as explicit task states, never converted
to success. Native delivery receipts separately preserve queued, delivered,
failed and cancelled notification states.

Task snapshots, delivery receipts and event IDs are resident-runtime state. A
`404 task_unknown` after eviction/restart means an unknown outcome, not proof of
nonexecution. No helper resubmits paid work automatically. Classification
`request_id` admission is durable and cannot be reused after admission, including
on restart. Save successful results; pause and reconcile 502/503 or transport
uncertainty. The phase request requires non-null JSON `task_context`, a positive
integer `attempt`, and full final output. It never automatically retries POSTs.
