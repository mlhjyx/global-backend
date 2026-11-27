const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const TERMINAL_STATUSES = new Set(['DONE', 'PARTIAL', 'FAILED', 'CANCELLED']);
const TASK_BINDING_FIELDS = ['workspaceId', 'planId', 'attemptId', 'requestSha256'] as const;
const TASK_REF_FIELDS = ['taskId', 'taskRunId', ...TASK_BINDING_FIELDS] as const;

export interface DiscoveryCompletionEnvelope {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

export function hasVersionedDiscoveryCompletion(payload: Record<string, unknown>): boolean {
  const taskRef = record(payload.taskRef);
  return payload.executionContractVersion !== undefined || payload.executionOrigin !== undefined ||
    payload.icpId !== undefined || Boolean(taskRef && TASK_BINDING_FIELDS.some((key) => Object.hasOwn(taskRef, key)));
}

export function matchesDiscoveryCompletionV3(
  payload: Record<string, unknown>,
  envelope: DiscoveryCompletionEnvelope,
): boolean {
  const runId = uuid(envelope.aggregateId);
  const workspaceId = uuid(envelope.workspaceId);
  const planId = uuid(payload.planId);
  if (envelope.schemaVersion !== 1 || envelope.aggregateType !== 'DiscoveryRun' ||
      payload.executionContractVersion !== 3 || typeof payload.status !== 'string' ||
      !TERMINAL_STATUSES.has(payload.status) || !runId || !workspaceId || !planId || !uuid(payload.icpId) ||
      [payload.run_id, payload.runId].some((id) => id !== undefined && uuid(id) !== runId)) {
    return false;
  }

  const { stats, cost, costBasis } = payload;
  if ((stats !== undefined && !record(stats)) ||
      (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) ||
      (costBasis !== undefined && (typeof costBasis !== 'string' || costBasis.length > 64)) ||
      payload.cost_usd !== undefined) {
    return false;
  }

  if (payload.executionOrigin === 'DIRECT') return payload.taskRef === undefined;
  if (payload.executionOrigin !== 'SAAS_TASK') return false;

  const taskRef = record(payload.taskRef);
  return Boolean(taskRef && Object.keys(taskRef).length === TASK_REF_FIELDS.length &&
    TASK_REF_FIELDS.every((key) => Object.hasOwn(taskRef, key)) &&
    uuid(taskRef.workspaceId) === workspaceId && uuid(taskRef.planId) === planId &&
    uuid(taskRef.taskId) && uuid(taskRef.taskRunId) && uuid(taskRef.attemptId) &&
    typeof taskRef.requestSha256 === 'string' && SHA256.test(taskRef.requestSha256));
}
