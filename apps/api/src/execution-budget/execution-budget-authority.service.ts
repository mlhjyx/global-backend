import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../auth/request-context';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';
import {
  ExecutionBudgetGrantError,
  type ExecutionBudgetPurpose,
  type VerifiedExecutionBudgetAuthority,
} from './execution-budget-authority.types';
import { ExecutionBudgetGrantVerifier } from './execution-budget-grant.verifier';

const MAX_ACCOUNT_KEY_LENGTH = 200;

export interface WorkspaceExecutionBudgetScope {
  readonly purpose: ExecutionBudgetPurpose;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly requestSha256: string;
}

export interface WorkspaceExecutionBudgetGrantInput {
  readonly compactJws?: string;
  readonly identity: Readonly<Pick<RequestContext, 'workspaceId'>>;
  readonly scope: Readonly<WorkspaceExecutionBudgetScope>;
}

export interface ExecutionBudgetBinding {
  readonly authorityId: string;
  readonly scopeKey: string;
  readonly accountKey: string;
  readonly purpose: ExecutionBudgetPurpose;
  readonly subjectType: string;
  readonly subjectId: string;
}

function invalid(): ExecutionBudgetGrantError {
  return new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
}

function exactVerifiedAuthority(
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

function workspaceBindingIdentity(
  authority: VerifiedExecutionBudgetAuthority,
): Readonly<{ accountKey: string; scopeKey: string }> {
  if (
    authority.authorityKind !== 'WORKSPACE_GRANT' ||
    authority.workspaceId === null ||
    authority.requestSha256 === null
  ) {
    throw new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    );
  }
  const accountKey = [
    authority.purpose,
    authority.subjectType,
    authority.subjectId,
    authority.requestSha256,
  ].join(':');
  if (
    accountKey.length < 1 ||
    accountKey.length > MAX_ACCOUNT_KEY_LENGTH ||
    [...accountKey].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw invalid();
  }
  return Object.freeze({ accountKey, scopeKey: authority.workspaceId });
}

@Injectable()
export class ExecutionBudgetAuthorityService {
  constructor(
    private readonly verifier: ExecutionBudgetGrantVerifier,
    private readonly repository: ExecutionBudgetAuthorityRepository,
  ) {}

  async verifyWorkspaceGrant(
    input: WorkspaceExecutionBudgetGrantInput,
  ): Promise<VerifiedExecutionBudgetAuthority> {
    return this.verifier.verify(input.compactJws, {
      authorityKind: 'WORKSPACE_GRANT',
      workspaceId: input.identity.workspaceId,
      purpose: input.scope.purpose,
      subjectType: input.scope.subjectType,
      subjectId: input.scope.subjectId,
      requestSha256: input.scope.requestSha256,
    });
  }

  async consumeWorkspaceGrant(
    input: WorkspaceExecutionBudgetGrantInput,
  ): Promise<ExecutionBudgetBinding> {
    const authority = exactVerifiedAuthority(
      await this.verifyWorkspaceGrant(input),
    );
    const { accountKey, scopeKey } = workspaceBindingIdentity(authority);
    const consumed = await this.repository.consumeWorkspaceAndOpen(
      authority,
      accountKey,
    );
    return Object.freeze({
      authorityId: consumed.authorityId,
      scopeKey,
      accountKey,
      purpose: authority.purpose,
      subjectType: authority.subjectType,
      subjectId: authority.subjectId,
    });
  }
}
