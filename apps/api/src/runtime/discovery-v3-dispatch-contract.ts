import { discoveryV3Uuid, type ManufacturerRevision } from '../auth/discovery-v3-admission-contract';

export { discoveryV3Uuid } from '../auth/discovery-v3-admission-contract';

export const DISCOVERY_V3_WORKFLOW = 'discoveryExecutionV3Workflow';
const KEYS = ['executionContractVersion', 'workspaceId', 'runId', 'planId', 'icpId', 'attemptId',
  'requestSha256', 'taskQueue', 'dispatchExpiresAt'] as const;

export interface DiscoveryV3Dispatch {
  readonly executionContractVersion: 3;
  readonly workspaceId: string;
  readonly runId: string;
  readonly planId: string;
  readonly icpId: string;
  readonly attemptId: string;
  readonly requestSha256: string;
  readonly taskQueue: 'understanding' | 'batch-discovery';
  readonly dispatchExpiresAt: string;
  readonly manufacturerNetworkRevision?: ManufacturerRevision;
}

export function parseDiscoveryV3Dispatch(value: unknown): DiscoveryV3Dispatch {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('DISCOVERY_V3_INVALID_COMMAND');
  const row = value as Record<string, unknown>;
  const revision = row.manufacturerNetworkRevision;
  if (row.executionContractVersion !== 3 || !KEYS.every((key) => Object.hasOwn(row, key)) ||
      Object.keys(row).length !== KEYS.length + Number(revision !== undefined) ||
      (revision !== undefined && revision !== 'manufacturer-network/v1' && revision !== 'manufacturer-network/v2') ||
      typeof row.requestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.requestSha256) ||
      (row.taskQueue !== 'understanding' && row.taskQueue !== 'batch-discovery') ||
      typeof row.dispatchExpiresAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.dispatchExpiresAt) ||
      !Number.isFinite(Date.parse(row.dispatchExpiresAt)) ||
      new Date(row.dispatchExpiresAt).toISOString() !== row.dispatchExpiresAt) {
    throw new Error('DISCOVERY_V3_INVALID_COMMAND');
  }
  return {
    executionContractVersion: 3,
    workspaceId: discoveryV3Uuid(row.workspaceId), runId: discoveryV3Uuid(row.runId),
    planId: discoveryV3Uuid(row.planId), icpId: discoveryV3Uuid(row.icpId), attemptId: discoveryV3Uuid(row.attemptId),
    requestSha256: row.requestSha256, taskQueue: row.taskQueue, dispatchExpiresAt: row.dispatchExpiresAt,
    ...(revision ? { manufacturerNetworkRevision: revision } : {}),
  };
}
