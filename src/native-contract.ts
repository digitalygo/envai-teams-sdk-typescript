import { CompatibilityError } from './contract.js';
import { ProtocolError } from './errors.js';
import type { ChoiceClassificationRequest, ChoiceClassificationResult, DetachedTaskSnapshot, IndependentJobReceipt } from './generated.js';

export function validateChoiceRequest(value: ChoiceClassificationRequest): void {
  if (value.context === null) throw new ProtocolError('Choice context must be non-null JSON');
  for (const [text, limit] of [[value.request_id,128],[value.question,8192]] as const) {
    if (!text.trim() || Buffer.byteLength(text) > limit) throw new ProtocolError('Choice request exceeds UTF-8 bounds');
  }
  const labels = new Set<string>();
  for (const {label,description} of value.choices) {
    if (label.trim() !== label || Buffer.byteLength(label)>128 || /\p{Cc}/u.test(label) || labels.has(label) || !description.trim() || Buffer.byteLength(description)>4096) throw new ProtocolError('Choice labels must be unique and descriptions bounded');
    labels.add(label);
  }
  if (Buffer.byteLength(JSON.stringify(value))>1024*1024) throw new ProtocolError('Choice request exceeds one MiB');
}

export function validateNativeCorrelation(operation: string, data: unknown, values: Record<string,unknown>, independentJobs: boolean): void {
  if (operation === 'startIndependentJob') {
    const result=data as IndependentJobReceipt;
    if (!result.task_id || !result.turn_id) throw new ProtocolError('Independent receipt requires nonempty task and turn IDs');
  }
  if (operation === 'classifyChoice') {
    const result=data as ChoiceClassificationResult, request=values.body as ChoiceClassificationRequest;
    if (result.request_id!==request.request_id || !result.model || !result.invocation_id || !request.choices.some(choice=>choice.label===result.choice)) throw new ProtocolError('Choice result does not match requested classification');
  }
  if (operation === 'getDetachedTask') {
    const task=data as DetachedTaskSnapshot;
    if (task.task_id!==values.task_id) throw new ProtocolError('Task lookup returned a different task');
    if (task.origin_turn_id==='' && !independentJobs) throw new CompatibilityError('Originless task requires independent_jobs capability');
  }
}
