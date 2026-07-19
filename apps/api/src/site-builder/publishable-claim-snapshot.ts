import { createHash } from 'node:crypto';
import { hasValidClaimApprovalAudit } from '../claim/claim-verification';
import { isCertificationClaim } from './claim-classification';

export const PUBLISHABLE_CLAIM_SNAPSHOT_SCHEMA_VERSION =
  'site-builder-publishable-claim-snapshot/v1' as const;

type ClaimStatus =
  | 'INGESTED'
  | 'EXTRACTED'
  | 'NEEDS_REVIEW'
  | 'APPROVED'
  | 'EXPIRED'
  | 'REVOKED';

export interface PublishableClaimCandidate {
  claimId: string;
  workspaceId: string;
  companyProfileId: string;
  sourceId: string | null;
  originKey: string | null;
  claimVersion: number;
  factKey: string;
  claimType: string;
  statement: string;
  status: ClaimStatus;
  validUntil: Date | null;
  verifiedBy: string;
  verifiedAt: Date;
  verificationMethod: string;
  verificationProof: unknown;
  bridgeId: string | null;
  brandProfileId: string;
  evidenceRefId: string;
  evidenceId: string;
  sourceSnapshotId: string;
  sourceContentHash: string;
  quote: string;
  quoteStart: number;
  quoteEnd: number;
  quotePrefix: string | null;
  quoteSuffix: string | null;
  certAssetId: string | null;
  certificationProofValid: boolean;
}

export interface PublishableClaimSnapshotItem {
  claimId: string;
  claimVersion: number;
  factKey: string;
  claimType: string;
  statement: string;
  validUntil: string | null;
  approvedBy: string;
  approvedAt: string;
  bridgeId: string;
  brandProfileId: string;
  evidenceRefId: string;
  evidenceId: string;
  sourceSnapshotId: string;
  sourceContentHash: string;
  quote: string;
  selector: {
    start: number;
    end: number;
    prefix?: string;
    suffix?: string;
  };
  certAssetId?: string;
}

export interface PublishableClaimSnapshot {
  schemaVersion: typeof PUBLISHABLE_CLAIM_SNAPSHOT_SCHEMA_VERSION;
  workspaceId: string;
  siteId: string;
  companyProfileId: string;
  buildRunId: string;
  capturedAt: string;
  digest: string;
  items: PublishableClaimSnapshotItem[];
}

export interface CurrentPublishableClaimState {
  claimId: string;
  claimVersion: number;
  status: ClaimStatus;
  validUntil: string | Date | null;
  bridgeId: string | null;
  certificationProofValid: boolean;
}

export class PublishableClaimSnapshotError extends Error {
  constructor(
    readonly code:
      | 'COPY_CLAIM_NOT_PUBLISHABLE'
      | 'COPY_CLAIM_SNAPSHOT_STALE',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PublishableClaimSnapshotError';
  }
}

function isFutureOrUnbounded(value: Date | null, now: Date): boolean {
  return value === null || (Number.isFinite(value.getTime()) && value > now);
}

function assertCandidate(
  candidate: PublishableClaimCandidate,
  scope: {
    workspaceId: string;
    companyProfileId: string;
    capturedAt: Date;
  },
): void {
  const certification = isCertificationClaim({
    type: candidate.claimType,
    key: candidate.factKey,
    value: candidate.statement,
  });
  const audited = hasValidClaimApprovalAudit({
    id: candidate.claimId,
    workspaceId: candidate.workspaceId,
    companyId: candidate.companyProfileId,
    sourceId: candidate.sourceId,
    originKey: candidate.originKey,
    factKey: candidate.factKey,
    type: candidate.claimType,
    statement: candidate.statement,
    validUntil: candidate.validUntil,
    version: candidate.claimVersion,
    verifiedBy: candidate.verifiedBy,
    verifiedAt: candidate.verifiedAt,
    verificationMethod: candidate.verificationMethod,
    verificationProof: candidate.verificationProof,
  });
  if (
    candidate.workspaceId !== scope.workspaceId ||
    candidate.companyProfileId !== scope.companyProfileId ||
    candidate.status !== 'APPROVED' ||
    candidate.bridgeId === null ||
    !isFutureOrUnbounded(candidate.validUntil, scope.capturedAt) ||
    !audited ||
    (certification && !candidate.certificationProofValid)
  ) {
    throw new PublishableClaimSnapshotError(
      'COPY_CLAIM_NOT_PUBLISHABLE',
      `claim ${candidate.claimId} is not approved, current, audited, and exactly bridged to the Site`,
    );
  }
}

function toItem(candidate: PublishableClaimCandidate): PublishableClaimSnapshotItem {
  return {
    claimId: candidate.claimId,
    claimVersion: candidate.claimVersion,
    factKey: candidate.factKey,
    claimType: candidate.claimType,
    statement: candidate.statement,
    validUntil: candidate.validUntil?.toISOString() ?? null,
    approvedBy: candidate.verifiedBy,
    approvedAt: candidate.verifiedAt.toISOString(),
    bridgeId: candidate.bridgeId!,
    brandProfileId: candidate.brandProfileId,
    evidenceRefId: candidate.evidenceRefId,
    evidenceId: candidate.evidenceId,
    sourceSnapshotId: candidate.sourceSnapshotId,
    sourceContentHash: candidate.sourceContentHash,
    quote: candidate.quote,
    selector: {
      start: candidate.quoteStart,
      end: candidate.quoteEnd,
      ...(candidate.quotePrefix ? { prefix: candidate.quotePrefix } : {}),
      ...(candidate.quoteSuffix ? { suffix: candidate.quoteSuffix } : {}),
    },
    ...(candidate.certAssetId ? { certAssetId: candidate.certAssetId } : {}),
  };
}

export function buildPublishableClaimSnapshot(input: {
  workspaceId: string;
  siteId: string;
  companyProfileId: string;
  buildRunId: string;
  capturedAt: Date;
  candidates: readonly PublishableClaimCandidate[];
}): PublishableClaimSnapshot {
  for (const candidate of input.candidates) {
    assertCandidate(candidate, input);
  }
  const items = [...input.candidates]
    .sort((left, right) =>
      left.claimId < right.claimId ? -1 : left.claimId > right.claimId ? 1 : 0,
    )
    .map(toItem);
  const envelope = {
    schemaVersion: PUBLISHABLE_CLAIM_SNAPSHOT_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    companyProfileId: input.companyProfileId,
    buildRunId: input.buildRunId,
    capturedAt: input.capturedAt.toISOString(),
    items,
  };
  return {
    ...envelope,
    digest: createHash('sha256')
      .update(JSON.stringify(envelope), 'utf8')
      .digest('hex'),
  };
}

export function assertPublishableClaimSnapshotCurrent(
  snapshot: PublishableClaimSnapshot,
  current: readonly CurrentPublishableClaimState[],
  now: Date,
): void {
  const byClaim = new Map(current.map((claim) => [claim.claimId, claim]));
  const stale = snapshot.items.find((item) => {
    const live = byClaim.get(item.claimId);
    const validUntil =
      live?.validUntil == null
        ? null
        : live.validUntil instanceof Date
          ? live.validUntil
          : new Date(live.validUntil);
    const certification = item.certAssetId !== undefined;
    return (
      !live ||
      live.status !== 'APPROVED' ||
      live.claimVersion !== item.claimVersion ||
      live.bridgeId !== item.bridgeId ||
      !isFutureOrUnbounded(validUntil, now) ||
      (certification && !live.certificationProofValid)
    );
  });
  if (stale || current.length !== snapshot.items.length) {
    throw new PublishableClaimSnapshotError(
      'COPY_CLAIM_SNAPSHOT_STALE',
      stale
        ? `claim ${stale.claimId} changed after ${snapshot.capturedAt}`
        : 'the current Claim set no longer matches the frozen snapshot',
    );
  }
}
