import { Injectable } from '@nestjs/common';
import {
  ExecutionBudgetAuthorityRepository,
  type ExecutionBudgetPlatformAccountPersistenceResult,
} from './execution-budget-authority.repository';
import type {
  PlatformExecutionBudgetRunExpectation,
  VerifiedExecutionBudgetAuthority,
} from './execution-budget-authority.types';
import { ExecutionBudgetGrantVerifier } from './execution-budget-grant.verifier';

export interface PlatformExecutionBudgetAuthorityAdmissionInput {
  readonly compactJws: string;
  readonly expected: PlatformExecutionBudgetRunExpectation;
}

function exactVerifiedPlatformAuthority(
  authority: VerifiedExecutionBudgetAuthority,
): VerifiedExecutionBudgetAuthority {
  return Object.freeze({
    schemaVersion: authority.schemaVersion,
    authorityKind: authority.authorityKind,
    issuer: authority.issuer,
    audience: authority.audience,
    jti: authority.jti,
    purpose: authority.purpose,
    workspaceId: authority.workspaceId,
    subjectType: authority.subjectType,
    subjectId: authority.subjectId,
    requestSha256: authority.requestSha256,
    scheduleId: authority.scheduleId,
    scheduleRequestSha256: authority.scheduleRequestSha256,
    workflowId: authority.workflowId,
    workflowRunId: authority.workflowRunId,
    technicalPolicyRevision: authority.technicalPolicyRevision,
    currency: authority.currency,
    unit: authority.unit,
    capMicrousd: authority.capMicrousd,
    capPerRunMicrousd: authority.capPerRunMicrousd,
    campaignCapMicrousd: authority.campaignCapMicrousd,
    maxRuns: authority.maxRuns,
    tokenSha256: authority.tokenSha256,
    issuedAt: authority.issuedAt,
    notBefore: authority.notBefore,
    expiresAt: authority.expiresAt,
  });
}

@Injectable()
export class PlatformExecutionBudgetAuthorityIngestionService {
  constructor(
    private readonly verifier: ExecutionBudgetGrantVerifier,
    private readonly repository: ExecutionBudgetAuthorityRepository,
  ) {}

  async ingestAndAdmit(
    input: PlatformExecutionBudgetAuthorityAdmissionInput,
  ): Promise<Readonly<ExecutionBudgetPlatformAccountPersistenceResult>> {
    const verified = exactVerifiedPlatformAuthority(
      await this.verifier.verifyPlatform(input.compactJws),
    );
    const admitted = await this.repository.ingestPlatformAndAdmit(
      verified,
      input.expected,
    );
    return Object.freeze({ ...admitted });
  }
}
