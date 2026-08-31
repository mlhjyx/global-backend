export const GOVERNED_OPERATION_SUBJECT_INVALID =
  'GOVERNED_OPERATION_SUBJECT_INVALID' as const;
export const GOVERNED_SUBJECT_INVALID = 'GOVERNED_SUBJECT_INVALID' as const;
export const GOVERNED_SUBJECT_RELATION_INVALID =
  'GOVERNED_SUBJECT_RELATION_INVALID' as const;
export const GOVERNED_SUBJECT_RELATION_CONFLICT =
  'GOVERNED_SUBJECT_RELATION_CONFLICT' as const;
export const GOVERNED_SUBJECT_TOMBSTONED = 'GOVERNED_SUBJECT_TOMBSTONED' as const;
export const GOVERNED_SUBJECT_AUTHORITY_REVOKED =
  'GOVERNED_SUBJECT_AUTHORITY_REVOKED' as const;
export const GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE =
  'GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE' as const;

export type GovernedSubjectDataClass = 'PERSONAL' | 'NON_PERSONAL';
export type GovernedSubjectRelationKind = 'MATERIALIZED_CHILD' | 'DERIVED_FROM';

export interface GovernedSubjectSourceRef {
  readonly namespace: string;
  readonly uuid: string | null;
  readonly sha256: string | null;
}

export interface GovernedSubjectRelationInput {
  readonly workspaceId: string;
  readonly authorityId: string;
  readonly accountId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly ackId: string;
  readonly resultDigest: string;
  readonly rootSubjectType: 'tool_operation';
  readonly rootSubjectId: string;
  readonly rootDataClass: 'NON_PERSONAL';
  readonly rootDsrSubjectType: null;
  readonly rootDsrSubjectId: null;
  readonly parentGovernedSubjectId: string | null;
  readonly childSubjectType: string;
  readonly childSubjectId: string;
  readonly childDataClass: GovernedSubjectDataClass;
  readonly childDsrSubjectType: string | null;
  readonly childDsrSubjectId: string | null;
  readonly relationKey: string;
  readonly relationKind: GovernedSubjectRelationKind;
  readonly sourceRef: GovernedSubjectSourceRef;
  readonly contractSha256: string;
}

export interface GovernedSubjectRelationResult {
  readonly operationSubjectId: string;
  readonly parentSubjectId: string;
  readonly childSubjectId: string;
  readonly relationId: string;
  readonly replay: boolean;
}

export type GovernedSubjectTombstoneOutcome =
  'FENCE_CREATED' | 'REPLAYED' | 'AUDIT_APPENDED_WITH_EXISTING_FENCE';

export interface GovernedSubjectTombstoneInput {
  readonly workspaceId: string;
  readonly governedSubjectId: string;
  readonly deletionRequestId: string;
}

export interface GovernedSubjectTombstoneResult {
  readonly governedSubjectId: string;
  readonly tombstonedAt: string;
  readonly auditId: string;
  readonly outcome: GovernedSubjectTombstoneOutcome;
}
