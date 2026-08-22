import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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

export interface ExecutionBudgetWorkspaceAccountPersistenceResult extends ExecutionBudgetAuthorityPersistenceResult {
  accountId: string;
  generation: number;
  authorizedCapMicrousd: bigint;
}

export interface ExecutionBudgetAuthorityRevocationInput {
  readonly scopeKey: string;
  readonly authorityId: string;
  readonly reason: string;
  readonly revokedAt?: Date;
}

export interface ExecutionBudgetPlatformAuthorityRevocationInput {
  readonly authorityId: string;
  readonly reason: string;
  readonly revokedAt?: Date;
}

export interface ExecutionBudgetPlatformAuthorityRevocationResult {
  readonly revocationId: string;
  readonly replay: boolean;
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

type PlatformRevocationRow = {
  revocation_id: string;
  replay: boolean;
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

type PlatformWriterPrincipal = Readonly<{
  sessionUser: string;
  currentUser: string;
  canLogin: boolean;
  superuser: boolean;
  bypassRls: boolean;
  createDb: boolean;
  createRole: boolean;
  replication: boolean;
  inherit: boolean;
  memberships: string[];
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
  | (typeof DATABASE_ERROR_CODES)[number]
  | 'TOOL_BUDGET_UNSETTLED_OPERATIONS'
  | 'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE';

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
    rows.length !== 1 ||
    !row ||
    typeof row.authority_id !== 'string' ||
    !isExecutionBudgetUuid(row.authority_id) ||
    typeof row.replay !== 'boolean'
  ) {
    throw unavailable();
  }
  return { authorityId: row.authority_id, replay: row.replay };
}

function parsePlatformRevocationRow(
  rows: readonly PlatformRevocationRow[],
): ExecutionBudgetPlatformAuthorityRevocationResult {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    !isExecutionBudgetUuid(row.revocation_id) ||
    typeof row.replay !== 'boolean'
  ) {
    throw unavailable();
  }
  return { revocationId: row.revocation_id, replay: row.replay };
}

function numericDateToDatabaseTimestamp(value: number): Date {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
  }
  const timestamp = new Date(value * 1_000);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
  }
  return timestamp;
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
  const issuedAt = numericDateToDatabaseTimestamp(authority.issuedAt);
  const notBefore = numericDateToDatabaseTimestamp(authority.notBefore);
  const expiresAt = numericDateToDatabaseTimestamp(authority.expiresAt);
  return tx.$queryRaw<AuthorityRow[]>(
    Prisma.sql`SELECT * FROM consume_workspace_execution_authority(
      ${authority.issuer}, ${authority.audience}, ${authority.jti}::uuid,
      ${authority.tokenSha256}, ${authority.schemaVersion},
      ${authority.purpose}::"execution_budget_purpose",
      ${authority.workspaceId}::uuid, ${authority.subjectType},
      ${authority.subjectId}, ${authority.requestSha256},
      ${authority.currency}, ${authority.unit}, ${authority.capMicrousd},
      ${issuedAt}, ${notBefore}, ${expiresAt}
    )`,
  );
}

function platformAuthorityFreshnessQuery(now: Date): Prisma.Sql {
  return Prisma.sql`SELECT *
    FROM inspect_platform_execution_authority_freshness_v1(${now})`;
}

function platformWriterPrincipalQuery(): Prisma.Sql {
  return Prisma.sql`
    SELECT
      session_user::text AS "sessionUser",
      current_user::text AS "currentUser",
      principal.rolcanlogin AS "canLogin",
      principal.rolsuper AS "superuser",
      principal.rolbypassrls AS "bypassRls",
      principal.rolcreatedb AS "createDb",
      principal.rolcreaterole AS "createRole",
      principal.rolreplication AS "replication",
      principal.rolinherit AS "inherit",
      COALESCE(ARRAY(
        SELECT granted.rolname::text
          FROM pg_catalog.pg_auth_members membership
          JOIN pg_catalog.pg_roles granted
            ON granted.oid = membership.roleid
         WHERE membership.member = principal.oid
         ORDER BY granted.rolname
      ), ARRAY[]::text[]) AS "memberships"
    FROM pg_catalog.pg_roles principal
    WHERE principal.rolname = session_user
  `;
}

function isAuthorizedPlatformWriterPrincipal(
  rows: readonly PlatformWriterPrincipal[],
): boolean {
  const principal = rows[0];
  return Boolean(
    rows.length === 1 &&
      principal &&
      principal.sessionUser === principal.currentUser &&
      principal.canLogin &&
      !principal.superuser &&
      !principal.bypassRls &&
      !principal.createDb &&
      !principal.createRole &&
      !principal.replication &&
      principal.inherit &&
      Array.isArray(principal.memberships) &&
      principal.memberships.length === 1 &&
      principal.memberships[0] === 'execution_budget_platform_writer',
  );
}

export async function attestExecutionBudgetPlatformWriterTransaction(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  const principal = await transaction.$queryRaw<PlatformWriterPrincipal[]>(
    platformWriterPrincipalQuery(),
  );
  if (!isAuthorizedPlatformWriterPrincipal(principal)) throw unavailable();
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
        (tx) =>
          this.consumeWorkspaceAndOpenInTransaction(
            tx,
            authority,
            accountKey,
          ),
      );
    } catch (error) {
      throw mapExecutionBudgetPersistenceError(error);
    }
  }

  /**
   * Joins an existing workspace transaction so authority consumption/account
   * identity and the endpoint's first durable business facts commit together.
   */
  async consumeWorkspaceAndOpenInTransaction(
    tx: Prisma.TransactionClient,
    authority: VerifiedExecutionBudgetAuthority,
    accountKey: string,
  ): Promise<ExecutionBudgetWorkspaceAccountPersistenceResult> {
    try {
      assertWorkspaceAuthority(authority);
      assertBoundedText(accountKey, 200, 'EXECUTION_BUDGET_GRANT_INVALID');
      const consumption = parseAuthorityRow(
        await consumeWorkspaceWithTransaction(tx, authority),
      );
      if (consumption.replay) {
        throw new ExecutionBudgetGrantError(
          'EXECUTION_BUDGET_GRANT_REUSED',
        );
      }
      const opened = await tx.$queryRaw<AuthorizedOpenRow[]>(
        Prisma.sql`SELECT * FROM open_authorized_tool_budget_v1(
          ${authority.workspaceId}, ${consumption.authorityId}::uuid,
          ${accountKey}, ${true}
        )`,
      );
      return parseAuthorizedOpenRow(opened, consumption);
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
      const issuedAt = numericDateToDatabaseTimestamp(authority.issuedAt);
      const notBefore = numericDateToDatabaseTimestamp(authority.notBefore);
      const expiresAt = numericDateToDatabaseTimestamp(authority.expiresAt);

      const rows = await this.platformWriter.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 2000');
          await attestExecutionBudgetPlatformWriterTransaction(tx);
          return tx.$queryRaw<AuthorityRow[]>(
          Prisma.sql`SELECT * FROM ingest_platform_execution_authority(
            ${authority.issuer}, ${authority.audience}, ${authority.jti}::uuid,
            ${authority.tokenSha256}, ${authority.schemaVersion},
            ${authority.purpose}::"execution_budget_purpose",
            ${authority.subjectType}, ${authority.subjectId},
            ${authority.scheduleId}, ${authority.currency}, ${authority.unit},
            ${authority.capPerRunMicrousd}, ${authority.campaignCapMicrousd},
            ${authority.maxRuns}, ${issuedAt}, ${notBefore},
            ${expiresAt}
          )`,
          );
        },
        { maxWait: 1_000, timeout: 2_500 },
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
          try {
            await attestExecutionBudgetPlatformWriterTransaction(transaction);
          } catch {
            return Object.freeze({
              status: 'writer_unavailable' as const,
            });
          }
          const freshness = await transaction.$queryRaw<
            ExecutionBudgetPlatformAuthorityFreshnessRow[]
          >(platformAuthorityFreshnessQuery(now));
          return Object.freeze({
            status: 'available' as const,
            rows: Object.freeze(
              freshness.map((row) => Object.freeze({ ...row })),
            ),
          });
        },
        { maxWait: 1_000, timeout: 2_500 },
      );
      return rows;
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

  async revokePlatform(
    input: ExecutionBudgetPlatformAuthorityRevocationInput,
  ): Promise<ExecutionBudgetPlatformAuthorityRevocationResult> {
    try {
      assertExecutionBudgetAuthorityId(input.authorityId);
      assertBoundedText(input.reason, 80, 'EXECUTION_BUDGET_GRANT_INVALID');
      const revokedAt = input.revokedAt ?? new Date();
      if (!Number.isFinite(revokedAt.getTime())) {
        throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
      }
      if (!this.platformWriter) throw unavailable();

      const rows = await this.platformWriter.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe(
            'SET LOCAL statement_timeout = 2000',
          );
          await attestExecutionBudgetPlatformWriterTransaction(transaction);
          return transaction.$queryRaw<PlatformRevocationRow[]>(
            Prisma.sql`SELECT * FROM revoke_platform_execution_authority_v1(
              ${input.authorityId}::uuid, ${input.reason}, ${revokedAt}
            )`,
          );
        },
        { maxWait: 1_000, timeout: 2_500 },
      );
      return parsePlatformRevocationRow(rows);
    } catch (error) {
      throw mapExecutionBudgetPersistenceError(error);
    }
  }
}
