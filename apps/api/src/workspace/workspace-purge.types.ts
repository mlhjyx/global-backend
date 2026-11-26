export const WORKSPACE_PURGE_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
] as const;

export type WorkspacePurgeStatus = (typeof WORKSPACE_PURGE_STATUSES)[number];

export interface WorkspacePurgeWorkflowInput {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly campaignPlanJobIds?: readonly string[];
}

export interface WorkspacePurgePersonalObjectTarget {
  readonly objectKey: string;
  readonly sha256: string;
  readonly versionId: string;
  readonly objectScope: 'workspace' | 'legacy_global';
}

export interface WorkspacePurgeTargets {
  readonly workflowIds: string[];
  readonly siteIds: string[];
  readonly legacyReleasePrefixes: string[];
  readonly exportObjectKeys: string[];
}

export interface WorkspacePurgeStorageCounts {
  readonly sellerDocuments: number;
  readonly siteBuilder: number;
  readonly operationArtifacts: number;
}

export interface WorkspacePurgeReceiptRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly status: WorkspacePurgeStatus;
  readonly requestedBy: string | null;
  readonly cleanupManifest: Record<string, unknown>;
  readonly dbRowsDeleted: Record<string, number> | null;
  readonly minioObjectsDeleted: WorkspacePurgeStorageCounts | null;
  readonly redisKeysDeleted: number;
  readonly temporalWorkflowsCancelled: number;
  readonly errorCode: string | null;
  readonly ruleVersion: string;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
