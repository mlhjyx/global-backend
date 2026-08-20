import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertAuthorityPurposeShape,
  ExecutionBudgetGrantError,
  type ExecutionBudgetGrantErrorCode,
  type VerifiedExecutionBudgetAuthority,
} from './execution-budget-authority.types';

export const EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE = Symbol(
  'EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE',
);

export interface ExecutionBudgetAuthorityPersistenceResult {
  authorityId: string;
  replay: boolean;
}

export interface ExecutionBudgetAuthorityRevocationInput {
  scopeKey: string;
  authorityId: string;
  reason: string;
  revokedAt?: Date;
}

type AuthorityRow = {
  authority_id: string;
  replay: boolean;
};

const DATABASE_ERROR_CODES = [
  'EXECUTION_BUDGET_GRANT_INVALID',
  'EXECUTION_BUDGET_GRANT_EXPIRED',
  'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
  'EXECUTION_BUDGET_GRANT_REUSED',
  'EXECUTION_BUDGET_AUTHORITY_REVOKED',
  'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED',
] as const satisfies readonly ExecutionBudgetGrantErrorCode[];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unavailable(): ExecutionBudgetGrantError {
  return new ExecutionBudgetGrantError(
    'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
  );
}

/**
 * Converts database implementation details into the public authority contract.
 * Callers must never rethrow the original persistence error.
 */
export function mapExecutionBudgetPersistenceError(error: unknown): Error {
  if (error instanceof ExecutionBudgetGrantError) return error;
  const message = error instanceof Error ? error.message : '';
  const code = DATABASE_ERROR_CODES.find((candidate) =>
    message.includes(candidate),
  );
  return code ? new ExecutionBudgetGrantError(code) : unavailable();
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
  }
}

function assertBoundedText(
  value: string,
  maximumLength: number,
  errorCode: ExecutionBudgetGrantErrorCode,
): void {
  if (
    value.length < 1 ||
    value.length > maximumLength ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new ExecutionBudgetGrantError(errorCode);
  }
}

function parseAuthorityRow(rows: readonly AuthorityRow[]): ExecutionBudgetAuthorityPersistenceResult {
  const row = rows[0];
  if (
    !row ||
    typeof row.authority_id !== 'string' ||
    !UUID_PATTERN.test(row.authority_id) ||
    typeof row.replay !== 'boolean'
  ) {
    throw unavailable();
  }
  return { authorityId: row.authority_id, replay: row.replay };
}

@Injectable()
export class ExecutionBudgetAuthorityRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE)
    private readonly platformWriter?: PrismaClient,
  ) {}

  async consumeWorkspace(
    authority: VerifiedExecutionBudgetAuthority,
  ): Promise<ExecutionBudgetAuthorityPersistenceResult> {
    try {
      assertAuthorityPurposeShape(authority);
      if (
        authority.authorityKind !== 'WORKSPACE_GRANT' ||
        authority.workspaceId === null ||
        authority.requestSha256 === null ||
        authority.capMicrousd === null
      ) {
        throw new ExecutionBudgetGrantError(
          'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
        );
      }

      const rows = await this.prisma.withWorkspace(
        authority.workspaceId,
        (tx) =>
          tx.$queryRaw<AuthorityRow[]>(
            Prisma.sql`SELECT * FROM consume_workspace_execution_authority(
              ${authority.issuer}, ${authority.audience}, ${authority.jti}::uuid,
              ${authority.tokenSha256}, ${authority.schemaVersion},
              ${authority.purpose}::"execution_budget_purpose",
              ${authority.workspaceId}::uuid, ${authority.subjectType},
              ${authority.subjectId}, ${authority.requestSha256},
              ${authority.currency}, ${authority.unit}, ${authority.capMicrousd},
              ${authority.issuedAt}, ${authority.notBefore}, ${authority.expiresAt}
            )`,
          ),
      );
      return parseAuthorityRow(rows);
    } catch (error) {
      throw mapExecutionBudgetPersistenceError(error);
    }
  }

  async ingestPlatform(
    authority: VerifiedExecutionBudgetAuthority,
  ): Promise<ExecutionBudgetAuthorityPersistenceResult> {
    try {
      assertAuthorityPurposeShape(authority);
      if (
        authority.authorityKind !== 'PLATFORM_GRANT' ||
        authority.scheduleId === null ||
        authority.capPerRunMicrousd === null ||
        authority.campaignCapMicrousd === null ||
        authority.maxRuns === null
      ) {
        throw new ExecutionBudgetGrantError(
          'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
        );
      }
      if (!this.platformWriter) throw unavailable();

      const rows = await this.platformWriter.$transaction((tx) =>
        tx.$queryRaw<AuthorityRow[]>(
          Prisma.sql`SELECT * FROM ingest_platform_execution_authority(
            ${authority.issuer}, ${authority.audience}, ${authority.jti}::uuid,
            ${authority.tokenSha256}, ${authority.schemaVersion},
            ${authority.purpose}::"execution_budget_purpose",
            ${authority.subjectType}, ${authority.subjectId},
            ${authority.scheduleId}, ${authority.currency}, ${authority.unit},
            ${authority.capPerRunMicrousd}, ${authority.campaignCapMicrousd},
            ${authority.maxRuns}, ${authority.issuedAt}, ${authority.notBefore},
            ${authority.expiresAt}
          )`,
        ),
      );
      return parseAuthorityRow(rows);
    } catch (error) {
      throw mapExecutionBudgetPersistenceError(error);
    }
  }

  async revoke(input: ExecutionBudgetAuthorityRevocationInput): Promise<void> {
    try {
      assertBoundedText(
        input.scopeKey,
        200,
        'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
      );
      assertUuid(input.authorityId);
      assertBoundedText(
        input.reason,
        80,
        'EXECUTION_BUDGET_GRANT_INVALID',
      );
      const revokedAt = input.revokedAt ?? new Date();
      if (!Number.isFinite(revokedAt.getTime())) {
        throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
      }

      const append = (tx: Prisma.TransactionClient) =>
        tx.$queryRaw(
          Prisma.sql`INSERT INTO "execution_budget_authority_revocation" (
            "scope_key", "authority_id", "reason", "revoked_at"
          ) VALUES (
            ${input.scopeKey}, ${input.authorityId}::uuid, ${input.reason}, ${revokedAt}
          ) ON CONFLICT ("authority_id") DO NOTHING
          RETURNING "authority_id"`,
        );

      if (input.scopeKey === 'platform') {
        if (!this.platformWriter) throw unavailable();
        await this.platformWriter.$transaction(append);
        return;
      }
      await this.prisma.withWorkspace(input.scopeKey, append);
    } catch (error) {
      throw mapExecutionBudgetPersistenceError(error);
    }
  }
}
