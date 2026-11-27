import { createHash } from 'node:crypto';

/** Canonical request and service-signed admission claim shared by the API and worker dispatch. */
export const DISCOVERY_V3_JWT_CLAIM = 'discoveryExecutionV3';
export const DISCOVERY_V3_VERSION = 3;
const EXECUTE_OPERATION = 'POST /query-plans/:planId/execute';
const URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const TASK_FIELDS = ['workspaceId', 'planId', 'taskId', 'taskRunId', 'attemptId', 'requestSha256'] as const;

export type ManufacturerRevision = 'manufacturer-network/v1' | 'manufacturer-network/v2';
export type DiscoveryV3TaskIdentity = { readonly taskId: string; readonly taskRunId: string };
export type DiscoveryV3TaskClaim = DiscoveryV3TaskIdentity & {
  readonly workspaceId: string;
  readonly planId: string;
  readonly attemptId: string;
  readonly requestSha256: string;
  readonly expectedIcpId?: string;
  readonly dispatchNotAfter?: string;
  readonly admissionMode?: 'read-only' | 'dispatch';
};

export function discoveryV3Uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('DISCOVERY_V3_INVALID_ID');
  return value.toLowerCase();
}

export function discoveryV3Attempt(workspaceId: string, planId: string, explicit?: string): string {
  const workspace = discoveryV3Uuid(workspaceId);
  const plan = discoveryV3Uuid(planId);
  const name = `https://gainos/contracts/discovery-execution/v3/initial/${workspace}/${plan}`;
  const bytes = createHash('sha1').update(URL_NAMESPACE).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // UUID v5 namespace identity
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const initial = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  if (explicit === undefined) return initial;
  const attempt = discoveryV3Uuid(explicit);
  if (attempt === initial) throw new Error('DISCOVERY_RESERVED_ATTEMPT');
  return attempt;
}

/** The ordered JSON tuple is the versioned cross-repository request contract. */
export function discoveryV3RequestSha256(input: {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly planId: string;
  readonly attemptId: string;
  readonly manufacturerNetworkRevision?: ManufacturerRevision;
  readonly task?: DiscoveryV3TaskIdentity;
}): string {
  const tuple = [
    DISCOVERY_V3_VERSION, EXECUTE_OPERATION, input.task ? 'SAAS_TASK' : 'DIRECT',
    discoveryV3Uuid(input.workspaceId), input.actorId, discoveryV3Uuid(input.planId),
    discoveryV3Uuid(input.attemptId), input.manufacturerNetworkRevision ?? null,
    input.task ? discoveryV3Uuid(input.task.taskId) : null,
    input.task ? discoveryV3Uuid(input.task.taskRunId) : null,
  ];
  return createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
}

export function parseDiscoveryV3TaskClaim(value: unknown): DiscoveryV3TaskClaim {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('DISCOVERY_V3_INVALID_TASK_CLAIM');
  const row = value as Record<string, unknown>;
  const expectedIcpId = Object.hasOwn(row, 'expectedIcpId') ? discoveryV3Uuid(row.expectedIcpId) : undefined;
  const dispatchNotAfter = row.dispatchNotAfter;
  const admissionMode = row.admissionMode;
  if (Object.keys(row).length !== TASK_FIELDS.length + Number(expectedIcpId !== undefined) + Number(dispatchNotAfter !== undefined) + Number(admissionMode !== undefined) ||
      (admissionMode !== undefined && admissionMode !== 'read-only' && admissionMode !== 'dispatch') ||
      (dispatchNotAfter !== undefined && (typeof dispatchNotAfter !== 'string' || !Number.isFinite(Date.parse(dispatchNotAfter)) ||
        new Date(dispatchNotAfter).toISOString() !== dispatchNotAfter)) ||
      !TASK_FIELDS.every((key) => Object.hasOwn(row, key)) ||
      typeof row.requestSha256 !== 'string' || !SHA256.test(row.requestSha256)) {
    throw new Error('DISCOVERY_V3_INVALID_TASK_CLAIM');
  }
  return Object.freeze({
    workspaceId: discoveryV3Uuid(row.workspaceId),
    planId: discoveryV3Uuid(row.planId),
    taskId: discoveryV3Uuid(row.taskId),
    taskRunId: discoveryV3Uuid(row.taskRunId),
    attemptId: discoveryV3Uuid(row.attemptId),
    requestSha256: row.requestSha256,
    ...(expectedIcpId ? { expectedIcpId } : {}),
    ...(dispatchNotAfter ? { dispatchNotAfter } : {}),
    ...(admissionMode ? { admissionMode } : {}),
  });
}
