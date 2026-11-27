import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { assertCandidateGrantAllocated } from '../runtime/development-candidate-budget';
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../auth/request-context';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';
import {
  assertAuthorityPurposeShape,
  ExecutionBudgetGrantError,
  type ExecutionBudgetPurpose,
  type VerifiedExecutionBudgetAuthority,
} from './execution-budget-authority.types';
import {
  EXECUTION_BUDGET_GRANT_AUDIENCE,
  ExecutionBudgetGrantVerifier,
} from './execution-budget-grant.verifier';
import {
  isAllowedWorkspaceAccountKey,
  type ExecutionBudgetBinding,
} from './execution-budget-binding';
import {
  bypassTechnicalCapMicrousdForPurpose,
  isLegacyExecutionBudgetBypass,
} from './legacy-execution-budget-mode';
export type { ExecutionBudgetBinding } from './execution-budget-binding';

const MAX_ACCOUNT_KEY_LENGTH = 200;
const BYPASS_SYNTHETIC_ISSUER = 'urn:global-backend:legacy-budget-bypass' as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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
): Readonly<{ accountKey: string; scopeKey: string; requestSha256: string }> {
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
  return Object.freeze({
    accountKey,
    scopeKey: authority.workspaceId,
    requestSha256: authority.requestSha256,
  });
}

function executionBudgetBinding(
  authority: VerifiedExecutionBudgetAuthority,
  authorityId: string,
  replay: boolean,
  openedAccountKey: string,
): ExecutionBudgetBinding {
  const { accountKey, scopeKey, requestSha256 } =
    workspaceBindingIdentity(authority);
  if (
    !isAllowedWorkspaceAccountKey({
      purpose: authority.purpose,
      derivedAccountKey: accountKey,
      accountKey: openedAccountKey,
      authorityId,
    })
  ) {
    throw invalid();
  }
  return Object.freeze({
    authorityId,
    replay,
    scopeKey,
    accountKey: openedAccountKey,
    purpose: authority.purpose,
    subjectType: authority.subjectType,
    subjectId: authority.subjectId,
    requestSha256,
  });
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
    if (isLegacyExecutionBudgetBypass()) {
      const workspaceId = input.identity.workspaceId;
      const { purpose, subjectType, subjectId, requestSha256 } = input.scope;
      if (
        !UUID_PATTERN.test(workspaceId) ||
        !SHA256_PATTERN.test(requestSha256)
      ) {
        throw new ExecutionBudgetGrantError(
          'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
        );
      }
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const jti = randomUUID();
      const synthetic: VerifiedExecutionBudgetAuthority = Object.freeze({
        schemaVersion: 'execution-budget-grant/v1',
        authorityKind: 'WORKSPACE_GRANT',
        issuer: BYPASS_SYNTHETIC_ISSUER,
        audience: EXECUTION_BUDGET_GRANT_AUDIENCE,
        jti,
        purpose,
        workspaceId,
        subjectType,
        subjectId,
        requestSha256,
        scheduleId: null,
        currency: 'USD',
        unit: 'microusd',
        capMicrousd: bypassTechnicalCapMicrousdForPurpose(purpose),
        capPerRunMicrousd: null,
        campaignCapMicrousd: null,
        maxRuns: null,
        tokenSha256: createHash('sha256')
          .update(`bypass:${jti}:${workspaceId}:${requestSha256}`)
          .digest('hex'),
        issuedAt: nowSeconds,
        notBefore: nowSeconds,
        expiresAt: nowSeconds + 240,
      });
      assertAuthorityPurposeShape(synthetic);
      return exactVerifiedAuthority(synthetic);
    }
    return exactVerifiedAuthority(
      await this.verifier.verify(input.compactJws, {
        authorityKind: 'WORKSPACE_GRANT',
        workspaceId: input.identity.workspaceId,
        purpose: input.scope.purpose,
        subjectType: input.scope.subjectType,
        subjectId: input.scope.subjectId,
        requestSha256: input.scope.requestSha256,
      }),
    );
  }

  async consumeWorkspaceGrant(
    input: WorkspaceExecutionBudgetGrantInput,
  ): Promise<ExecutionBudgetBinding> {
    return this.consumeVerifiedWorkspaceGrant(
      await this.verifyWorkspaceGrant(input),
    );
  }

  /**
   * Consumes a grant that was already verified. Callers use this to check the
   * operation's own preconditions first, so a rejected request never burns a
   * one-time grant (and never leaves its request scope account occupied).
   */
  async consumeVerifiedWorkspaceGrant(
    authority: VerifiedExecutionBudgetAuthority,
  ): Promise<ExecutionBudgetBinding> {
    const exact = exactVerifiedAuthority(authority);
    const { accountKey } = workspaceBindingIdentity(exact);
    if (isLegacyExecutionBudgetBypass()) {
      return executionBudgetBinding(exact, randomUUID(), false, accountKey);
    }
    await assertCandidateGrantAllocated(exact);
    const consumed = await this.repository.consumeWorkspaceAndOpen(
      exact,
      accountKey,
    );
    return executionBudgetBinding(
      exact,
      consumed.authorityId,
      consumed.replay,
      consumed.accountKey,
    );
  }

  async consumeVerifiedWorkspaceGrantInTransaction(
    authority: VerifiedExecutionBudgetAuthority,
    transaction: Prisma.TransactionClient,
  ): Promise<ExecutionBudgetBinding> {
    const exact = exactVerifiedAuthority(authority);
    const { accountKey } = workspaceBindingIdentity(exact);
    if (isLegacyExecutionBudgetBypass()) {
      if (exact.purpose !== 'market.candidates.generate') {
        return executionBudgetBinding(exact, randomUUID(), false, accountKey);
      }
      // Market candidate generation enforces PostgreSQL attempt-binding and
      // terminal triggers over execution_budget_authority + tool_budget_account,
      // so bypass mode persists the local 80c technical-cap authority directly
      // without RS256 JWKS verification or candidate-grant allocation.
      const consumed =
        await this.repository.consumeWorkspaceAndOpenInTransaction(
          transaction,
          exact,
          accountKey,
        );
      return executionBudgetBinding(
        exact,
        consumed.authorityId,
        consumed.replay,
        consumed.accountKey,
      );
    }
    await assertCandidateGrantAllocated(exact);
    const consumed =
      await this.repository.consumeWorkspaceAndOpenInTransaction(
        transaction,
        exact,
        accountKey,
      );
    return executionBudgetBinding(
      exact,
      consumed.authorityId,
      consumed.replay,
      consumed.accountKey,
    );
  }
}

export function assertFreshExecutionBudgetBinding(
  binding: ExecutionBudgetBinding,
): void {
  if (binding.replay) {
    throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REUSED');
  }
}
