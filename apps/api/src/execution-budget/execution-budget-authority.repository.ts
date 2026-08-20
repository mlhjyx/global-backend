import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertAuthorityPurposeShape,
  EXECUTION_BUDGET_PLATFORM_PURPOSES,
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

export interface ExecutionBudgetWorkspaceAccountPersistenceResult extends ExecutionBudgetAuthorityPersistenceResult {
  accountId: string;
  generation: number;
  authorizedCapMicrousd: bigint;
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

type AuthorizedOpenRow = {
  account_id: string;
  generation: number;
  authority_id: string;
  authorized_cap_microusd: bigint;
};

export type ExecutionBudgetPlatformAuthorityFreshnessRow = Readonly<{
  purpose: string;
  state: string;
}>;

export type ExecutionBudgetPlatformAuthorityFreshness =
  | Readonly<{ status: 'writer_unavailable' }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{
      status: 'available';
      rows: readonly ExecutionBudgetPlatformAuthorityFreshnessRow[];
    }>;

type VerifiedWorkspaceExecutionBudgetAuthority =
  VerifiedExecutionBudgetAuthority & {
    authorityKind: 'WORKSPACE_GRANT';
    workspaceId: string;
    requestSha256: string;
    capMicrousd: bigint;
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

type TrustedDatabaseMarker =
  (typeof DATABASE_ERROR_CODES)[number] | 'TOOL_BUDGET_UNSETTLED_OPERATIONS';

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
  const code = DATABASE_ERROR_CODES.find((candidate) =>
    isTrustedExecutionBudgetDatabaseMarker(error, candidate),
  );
  return code ? new ExecutionBudgetGrantError(code) : unavailable();
}

export function isExecutionBudgetUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isTrustedExecutionBudgetDatabaseMarker(
  error: unknown,
  marker: TrustedDatabaseMarker,
): boolean {
  return Boolean(
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010' &&
    error.meta?.code === 'P0001' &&
    error.meta?.message === `ERROR: ${marker}`,
  );
}

export function assertExecutionBudgetAuthorityId(value: string): void {
  if (!isExecutionBudgetUuid(value)) {
    throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
  }
}

export function assertExecutionBudgetScopeKey(
  value: string,
  options: { allowPlatform: boolean },
): void {
  if (value === 'platform') {
    if (options.allowPlatform) return;
    throw new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    );
  }
  if (!isExecutionBudgetUuid(value)) {
    throw new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    );
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

function parseAuthorityRow(
  rows: readonly AuthorityRow[],
): ExecutionBudgetAuthorityPersistenceResult {
  const row = rows[0];
  if (
    !row ||
    typeof row.authority_id !== 'string' ||
    !isExecutionBudgetUuid(row.authority_id) ||
    typeof row.replay !== 'boolean'
  ) {
    throw unavailable();
  }
  return { authorityId: row.authority_id, replay: row.replay };
}

function parseAuthorizedOpenRow(
  rows: readonly AuthorizedOpenRow[],
  consumption: ExecutionBudgetAuthorityPersistenceResult,
): ExecutionBudgetWorkspaceAccountPersistenceResult {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    !isExecutionBudgetUuid(row.account_id) ||
    !isExecutionBudgetUuid(row.authority_id) ||
    row.authority_id !== consumption.authorityId ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    typeof row.authorized_cap_microusd !== 'bigint' ||
    row.authorized_cap_microusd < 1n
  ) {
    throw unavailable();
  }
  return {
    ...consumption,
    accountId: row.account_id,
    generation: row.generation,
    authorizedCapMicrousd: row.authorized_cap_microusd,
  };
}

function assertWorkspaceAuthority(
  authority: VerifiedExecutionBudgetAuthority,
): asserts authority is VerifiedWorkspaceExecutionBudgetAuthority {
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
  assertExecutionBudgetScopeKey(authority.workspaceId, {
    allowPlatform: false,
  });
  assertExecutionBudgetAuthorityId(authority.jti);
}

function consumeWorkspaceWithTransaction(
  tx: Prisma.TransactionClient,
  authority: VerifiedWorkspaceExecutionBudgetAuthority,
): Promise<AuthorityRow[]> {
  return tx.$queryRaw<AuthorityRow[]>(
    Prisma.sql`SELECT * FROM consume_workspace_execution_authority(
      ${authority.issuer}, ${authority.audience}, ${authority.jti}::uuid,
      ${authority.tokenSha256}, ${authority.schemaVersion},
      ${authority.purpose}::"execution_budget_purpose",
      ${authority.workspaceId}::uuid, ${authority.subjectType},
      ${authority.subjectId}, ${authority.requestSha256},
      ${authority.currency}, ${authority.unit}, ${authority.capMicrousd},
      ${authority.issuedAt}, ${authority.notBefore}, ${authority.expiresAt}
    )`,
  );
}

function platformAuthorityFreshnessQuery(now: Date): Prisma.Sql {
  const requiredPurposeRows = Prisma.join(
    EXECUTION_BUDGET_PLATFORM_PURPOSES.map(
      (purpose) => Prisma.sql`(${purpose}::"execution_budget_purpose")`,
    ),
  );
  const purposeOrder = Prisma.join(
    EXECUTION_BUDGET_PLATFORM_PURPOSES.map((purpose) => Prisma.sql`${purpose}`),
  );
  return Prisma.sql`
    WITH required("purpose") AS (
      VALUES ${requiredPurposeRows}
    ), observations AS (
      SELECT
        required."purpose",
        count(authority."id") AS authority_count,
        bool_or(
          authority."id" IS NOT NULL
          AND authority."revoked_at" IS NULL
          AND revocation."authority_id" IS NULL
          AND authority."not_before" <= ${now}
          AND authority."expires_at" > ${now}
          AND authority."runs_consumed" < authority."max_runs"
        ) AS active,
        bool_or(
          authority."id" IS NOT NULL
          AND authority."revoked_at" IS NULL
          AND revocation."authority_id" IS NULL
          AND authority."not_before" > ${now}
          AND authority."expires_at" > ${now}
          AND authority."runs_consumed" < authority."max_runs"
        ) AS not_yet_valid,
        bool_or(
          authority."id" IS NOT NULL
          AND authority."revoked_at" IS NULL
          AND revocation."authority_id" IS NULL
          AND authority."not_before" <= ${now}
          AND authority."expires_at" > ${now}
          AND authority."runs_consumed" >= authority."max_runs"
        ) AS exhausted,
        bool_or(
          authority."id" IS NOT NULL
          AND authority."revoked_at" IS NULL
          AND revocation."authority_id" IS NULL
          AND authority."expires_at" <= ${now}
        ) AS expired,
        bool_or(
          authority."id" IS NOT NULL
          AND (
            authority."revoked_at" IS NOT NULL
            OR revocation."authority_id" IS NOT NULL
          )
        ) AS revoked
      FROM required
      LEFT JOIN "execution_budget_authority" authority
        ON authority."scope_key" = 'platform'
       AND authority."authority_kind" = 'PLATFORM_GRANT'
       AND authority."purpose" = required."purpose"
      LEFT JOIN "execution_budget_authority_revocation" revocation
        ON revocation."scope_key" = 'platform'
       AND revocation."authority_id" = authority."id"
      GROUP BY required."purpose"
    )
    SELECT
      "purpose"::text AS purpose,
      CASE
        WHEN active THEN 'active'
        WHEN authority_count = 0 THEN 'missing'
        WHEN not_yet_valid THEN 'not_yet_valid'
        WHEN exhausted THEN 'exhausted'
        WHEN expired THEN 'expired'
        WHEN revoked THEN 'revoked'
        ELSE 'invalid'
      END AS state
    FROM observations
    ORDER BY array_position(ARRAY[${purposeOrder}]::text[], "purpose"::text)
  `;
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
      assertWorkspaceAuthority(authority);
      const rows = await this.prisma.withWorkspace(
        authority.workspaceId,
        (tx) => consumeWorkspaceWithTransaction(tx, authority),
      );
      return parseAuthorityRow(rows);
    } catch (error) {
      throw mapExecutionBudgetPersistenceError(error);
    }
  }

  async consumeWorkspaceAndOpen(
    authority: VerifiedExecutionBudgetAuthority,
    accountKey: string,
  ): Promise<ExecutionBudgetWorkspaceAccountPersistenceResult> {
    try {
      assertWorkspaceAuthority(authority);
      assertBoundedText(accountKey, 200, 'EXECUTION_BUDGET_GRANT_INVALID');

      return await this.prisma.withWorkspace(
        authority.workspaceId,
        async (tx) => {
          const consumption = parseAuthorityRow(
            await consumeWorkspaceWithTransaction(tx, authority),
          );
          const opened = await tx.$queryRaw<AuthorizedOpenRow[]>(
            Prisma.sql`SELECT * FROM open_authorized_tool_budget_v1(
            ${authority.workspaceId}, ${consumption.authorityId}::uuid,
            ${accountKey}, ${true}
          )`,
          );
          return parseAuthorizedOpenRow(opened, consumption);
        },
      );
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
      assertExecutionBudgetAuthorityId(authority.jti);
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

  async inspectPlatformAuthorityFreshness(
    now: Date = new Date(),
  ): Promise<ExecutionBudgetPlatformAuthorityFreshness> {
    if (!this.platformWriter) {
      return Object.freeze({ status: 'writer_unavailable' });
    }
    if (!Number.isFinite(now.getTime())) {
      return Object.freeze({ status: 'unavailable' });
    }
    try {
      const rows = await this.platformWriter.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe(
            'SET LOCAL statement_timeout = 2000',
          );
          return transaction.$queryRaw<
            ExecutionBudgetPlatformAuthorityFreshnessRow[]
          >(platformAuthorityFreshnessQuery(now));
        },
        { maxWait: 1_000, timeout: 2_500 },
      );
      return Object.freeze({
        status: 'available',
        rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
      });
    } catch {
      return Object.freeze({ status: 'unavailable' });
    }
  }

  async revoke(input: ExecutionBudgetAuthorityRevocationInput): Promise<void> {
    try {
      assertExecutionBudgetScopeKey(input.scopeKey, { allowPlatform: false });
      assertExecutionBudgetAuthorityId(input.authorityId);
      assertBoundedText(input.reason, 80, 'EXECUTION_BUDGET_GRANT_INVALID');
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

      await this.prisma.withWorkspace(input.scopeKey, append);
    } catch (error) {
      throw mapExecutionBudgetPersistenceError(error);
    }
  }
}
