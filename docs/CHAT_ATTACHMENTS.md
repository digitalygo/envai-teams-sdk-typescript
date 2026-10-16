# Chat attachments

This unreleased feature requires a matching backend advertising `chat_attachments` in contract-3 capabilities. The SDK checks this before attachment mutations and messages containing attachment IDs. It never falls back to sending the text alone.

Upload one immutable original with an upload idempotency key, poll its conversion, then send ordered attachment IDs with a separate stable message idempotency key. A message acknowledgment must contain those same IDs. Pending or failed selected files block the whole turn; explicitly retry a permitted conversion or remove that file before sending. Successful conversions are reused. Poll timeouts cancel only the local wait. Mutations are never automatically retried, even with a key: reconcile an uncertain response before explicitly replaying the same payload/key.

Supported inputs are `.md`, `.txt`, `.csv`, `.xlsx`, `.pdf`, `.docx`, `.mp3`, and `.mp4`. PDF/DOCX use existing Mistral OCR; MP3 and the mixed audio tracks of MP4 use direct ElevenLabs Scribe. MP4 visual frames are not analyzed. Native workbook conversion does not execute formulas. There is no model-specific multimodal routing, automatic Wiki indexing, guaranteed Office editing/export, or automatic mounting of original files in tools.

The complete textual projection must fit the server and model context budgets; oversized input fails explicitly and the converted attachment stays available. No silent truncation occurs. Originals and derivatives remain private and scoped to the owning user, workspace and chat. Forked/restored text does not grant access to originals. Status/list/download/retry/delete are separate operations. Download selects `kind=original` or `kind=derived`.

Draft retention defaults to 24 hours; accepted attachments and input snapshots default to 14 days. Idempotent replay is guaranteed while the retained input snapshot exists. Withdrawal blocks new reads immediately; physical cleanup may wait for live conversion leases. Deletion does not erase already accepted conversation content.

Conversion cost is exposed in the attachment's `usage_cost`; inference is attributed to the turn. Missing tariffs and uncertain outcomes stay pending with null totals. An explicit conversion retry creates a linked accounting cycle, preserving previous cost evidence. Wiki file outcomes may now include `deferred` for infrastructure failures; applications should display that outcome without describing the original document as defective.

```ts
import { EnvaiClient, uploadAttachmentFile, waitForAttachment } from '@digitalygo/envai-client';

const client = new EnvaiClient({ baseUrl, apiKey });
const uploaded = await uploadAttachmentFile(client, workspaceId, chatId, './invoice.pdf', 'upload-invoice-1');
const ready = await waitForAttachment(client, workspaceId, chatId, uploaded.attachment_id, { timeoutMs: 600_000, signal });
if (ready.lifecycle !== 'ready' || ready.conversion.status !== 'completed') throw new Error('Resolve or remove the failed attachment before sending');
const result = await client.sendAndWait(chatId, { message: 'Summarize the invoice.', attachment_ids: [ready.attachment_id] }, { idempotencyKey: 'message-invoice-1', signal });
```

Low-level methods are grouped under `client.attachments`: `upload`, `list`, `get`, `retry`, `delete`, `download`. `sendChatMessage` takes `idempotencyKey`; stream helpers take it in `TurnOptions`. Keep keys stable across deliberate network recovery. `waitForAttachment` accepts bounded polling and an `AbortSignal` and returns terminal failure for explicit handling.

See the matching backend [attachment guide](https://github.com/digitalygo/envai-teams/blob/6a4e45bafe6f5856ef92a57b37db08769738b412/docs/guides/chat-attachments.md) for limits, operator settings, and retention. Publishing this SDK does not deploy the backend.

With a stable message key, turn helpers retain the initial replay until the acknowledgment identifies the accepted turn. A previously completed turn can therefore finish from retained events without another inference call. The pre-send replay buffer is limited to 16 MiB; exceeding it fails before submitting the message. Resume a known turn with its event cursor when the retained stream is larger or a replay gap is reported.
