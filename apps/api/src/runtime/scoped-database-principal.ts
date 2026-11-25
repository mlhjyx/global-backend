import { Prisma, type PrismaClient } from '@prisma/client';

export const OUTBOX_RELAY_DATABASE_ROLE = 'runtime_outbox_relay_worker' as const;
export const MEMORY_OUTBOX_DATABASE_ROLE = 'runtime_memory_outbox_reader' as const;
export const CUSTOMER_WORKER_OPS_DATABASE_ROLE = 'runtime_customer_worker_ops' as const;
export const EXECUTION_BUDGET_PLATFORM_WRITER_ROLE =
  'execution_budget_platform_writer' as const;

export type ScopedRuntimeDatabaseRole =
  | typeof OUTBOX_RELAY_DATABASE_ROLE
  | typeof MEMORY_OUTBOX_DATABASE_ROLE
  | typeof CUSTOMER_WORKER_OPS_DATABASE_ROLE
  | typeof EXECUTION_BUDGET_PLATFORM_WRITER_ROLE;

export interface ScopedDatabasePrincipalRow {
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly sessionRole: string;
  readonly rolCanLogin: boolean;
  readonly rolInherit: boolean;
  readonly rolSuper: boolean;
  readonly rolBypassRls: boolean;
  readonly rolCreateDb: boolean;
  readonly rolCreateRole: boolean;
  readonly rolReplication: boolean;
  readonly memberships: readonly string[];
}

export class ScopedDatabasePrincipalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScopedDatabasePrincipalError';
    this.code = code;
  }
}

export type ScopedUrlCheck =
  | Readonly<{ status: 'ok' }>
  | Readonly<{ status: 'failed'; code: string }>;

const FORBIDDEN_SCOPED_USERNAMES = new Set(['global', 'app_user', 'postgres']);

interface DatabaseTarget {
  readonly hostname: string;
  readonly port: string;
  readonly database: string;
}

function parseDatabaseTarget(rawUrl: string | undefined): DatabaseTarget | undefined {
  if (!rawUrl?.trim()) return undefined;
  try {
    const url = new URL(rawUrl.trim());
    const database = decodeURIComponent(url.pathname.slice(1));
    if (
      (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
      !url.hostname ||
      !database ||
      !/^\/[A-Za-z0-9_.-]+$/u.test(url.pathname)
    ) {
      return undefined;
    }
    return {
      hostname: url.hostname.toLowerCase(),
      port: url.port || '5432',
      database,
    };
  } catch {
    return undefined;
  }
}

export function scopedDatabaseTargetsAppDatabase(
  scopedUrl: string | undefined,
  appUrl: string | undefined,
): boolean {
  const scoped = parseDatabaseTarget(scopedUrl);
  const app = parseDatabaseTarget(appUrl);
  return Boolean(
    scoped &&
      app &&
      scoped.hostname === app.hostname &&
      scoped.port === app.port &&
      scoped.database === app.database,
  );
}

export function inspectScopedDatabaseUrl(
  envVar: string,
  rawUrl: string | undefined,
): ScopedUrlCheck {
  if (!rawUrl?.trim()) {
    return { status: 'failed', code: `${envVar}_REQUIRED` };
  }
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return { status: 'failed', code: `${envVar}_INVALID` };
    }
    const username = decodeURIComponent(parsed.username);
    if (!username) {
      return { status: 'failed', code: `${envVar}_INVALID` };
    }
    if (FORBIDDEN_SCOPED_USERNAMES.has(username)) {
      return { status: 'failed', code: `${envVar}_ROLE_INVALID` };
    }
    return { status: 'ok' };
  } catch {
    return { status: 'failed', code: `${envVar}_INVALID` };
  }
}

export function isOwnerDatabaseUsername(rawUrl: string | undefined): boolean {
  if (!rawUrl?.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return false;
    }
    const username = decodeURIComponent(parsed.username);
    return username === 'global' || username === 'postgres';
  } catch {
    return false;
  }
}

/**
 * Verifies against pg_roles + pg_auth_members that the connected database
 * principal is a dedicated NOLOGIN-group member (NOSUPERUSER, NOBYPASSRLS,
 * NOCREATEDB, NOCREATEROLE, NOREPLICATION, no SET ROLE, not app_user/global).
 */
export async function assertScopedDatabasePrincipal(
  db: Pick<PrismaClient, '$queryRaw'>,
  expectedGroupRole: ScopedRuntimeDatabaseRole,
  sourceLabel: string,
): Promise<ScopedDatabasePrincipalRow> {
  const rows = await db.$queryRaw<ScopedDatabasePrincipalRow[]>(Prisma.sql`
    SELECT
      current_user::text AS "currentUser",
      session_user::text AS "sessionUser",
      COALESCE(current_setting('role', true), '')::text AS "sessionRole",
      principal.rolcanlogin AS "rolCanLogin",
      principal.rolinherit AS "rolInherit",
      principal.rolsuper AS "rolSuper",
      principal.rolbypassrls AS "rolBypassRls",
      principal.rolcreatedb AS "rolCreateDb",
      principal.rolcreaterole AS "rolCreateRole",
      principal.rolreplication AS "rolReplication",
      COALESCE(
        array_agg(granted.rolname::text ORDER BY granted.rolname)
          FILTER (WHERE granted.rolname IS NOT NULL),
        ARRAY[]::text[]
      ) AS "memberships"
    FROM pg_roles principal
    LEFT JOIN pg_auth_members membership ON membership.member = principal.oid
    LEFT JOIN pg_roles granted ON granted.oid = membership.roleid
    WHERE principal.rolname = session_user
    GROUP BY
      principal.oid,
      principal.rolcanlogin,
      principal.rolinherit,
      principal.rolsuper,
      principal.rolbypassrls,
      principal.rolcreatedb,
      principal.rolcreaterole,
      principal.rolreplication
  `);

  const row = rows[0];
  if (!row) {
    throw new ScopedDatabasePrincipalError(
      'SCOPED_DATABASE_PRINCIPAL_NOT_FOUND',
      `${sourceLabel}: session_user missing from pg_roles`,
    );
  }
  if (row.sessionUser !== row.currentUser || (row.sessionRole && row.sessionRole !== 'none')) {
    throw new ScopedDatabasePrincipalError(
      'SCOPED_DATABASE_PRINCIPAL_SET_ROLE_FORBIDDEN',
      `${sourceLabel}: active role (${row.currentUser}/${row.sessionRole}) must match session_user (${row.sessionUser})`,
    );
  }
  if (
    !row.rolCanLogin ||
    !row.rolInherit ||
    row.rolSuper ||
    row.rolBypassRls ||
    row.rolCreateDb ||
    row.rolCreateRole ||
    row.rolReplication ||
    FORBIDDEN_SCOPED_USERNAMES.has(row.sessionUser)
  ) {
    throw new ScopedDatabasePrincipalError(
      'SCOPED_DATABASE_PRINCIPAL_ATTRIBUTES_INVALID',
      `${sourceLabel}: principal ${row.sessionUser} failed NOSUPERUSER/NOBYPASSRLS/LOGIN/INHERIT invariants`,
    );
  }
  if (
    row.memberships.length !== 1 ||
    row.memberships[0] !== expectedGroupRole
  ) {
    throw new ScopedDatabasePrincipalError(
      'SCOPED_DATABASE_PRINCIPAL_MEMBERSHIP_INVALID',
      `${sourceLabel}: principal ${row.sessionUser} memberships [${row.memberships.join(', ')}] must equal [${expectedGroupRole}]`,
    );
  }
  return row;
}
