import { Prisma, PrismaClient } from "@prisma/client";

const PROVIDER_WIRE_STATEMENT_TIMEOUT_MS = 4_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOGIN = /^[a-z_][a-z0-9_]{2,62}$/u;
const FORBIDDEN_LOGIN = new Set([
  "app_user",
  "global",
  "postgres",
  "runtime_api",
  "runtime_outbox_relay",
  "runtime_worker",
]);
const ALLOWED_QUERY_PARAMETERS = new Set([
  "application_name",
  "connect_timeout",
  "connection_limit",
  "options",
  "pool_timeout",
  "schema",
  "socket_timeout",
  "sslmode",
]);
const MIGRATION_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{2,190}$/u;

export interface SiteBuildProviderWireMembership {
  role: string;
  adminOption: boolean;
  inheritOption: boolean;
}

export interface SiteBuildProviderWirePrincipal {
  sessionUser: string;
  currentUser: string;
  statementTimeout: string;
  superuser: boolean;
  bypassRls: boolean;
  createDb: boolean;
  createRole: boolean;
  replication: boolean;
  inherit: boolean;
  memberships: SiteBuildProviderWireMembership[];
}

interface SiteBuildProviderWireReadinessRow
  extends SiteBuildProviderWirePrincipal {
  databaseName: string;
  migrationRevision: string | null;
  requiredFunctionsReady: boolean;
  directWritesDenied: boolean;
  rlsForced: boolean;
}

export type SiteBuildProviderWireReadiness =
  | Readonly<{ status: "ok" }>
  | Readonly<{
      status: "failed";
      code:
        | "SITE_BUILD_PROVIDER_WIRE_DATABASE_UNAVAILABLE"
        | "SITE_BUILD_PROVIDER_WIRE_DATABASE_PRINCIPAL_INVALID"
        | "SITE_BUILD_PROVIDER_WIRE_DATABASE_IDENTITY_INVALID"
        | "SITE_BUILD_PROVIDER_WIRE_DATABASE_CONTRACT_INVALID";
    }>;

export interface SiteBuildProviderWireWorkspaceDatabase {
  withWorkspace<T>(
    workspaceId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

interface ProviderWireClient {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $transaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

type ProviderWireClientFactory = (databaseUrl: string) => ProviderWireClient;

interface DatabaseTarget {
  hostname: string;
  port: string;
  database: string;
}

function databaseTarget(value: string): DatabaseTarget | undefined {
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (
      !new Set(["postgres:", "postgresql:"]).has(url.protocol) ||
      !url.hostname ||
      !database ||
      !/^\/[A-Za-z0-9_.-]+$/u.test(url.pathname)
    ) {
      return undefined;
    }
    return {
      hostname: url.hostname.toLowerCase(),
      port: url.port || "5432",
      database,
    };
  } catch {
    return undefined;
  }
}

export function siteBuildProviderWireTargetsAppDatabase(
  writerUrl: string,
  appUrl: string,
): boolean {
  const writer = databaseTarget(writerUrl);
  const app = databaseTarget(appUrl);
  return Boolean(
    writer &&
      app &&
      writer.hostname === app.hostname &&
      writer.port === app.port &&
      writer.database === app.database,
  );
}

export function withSiteBuildProviderWireStatementTimeout(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SITE_BUILD_PROVIDER_WIRE_DATABASE_URL_INVALID");
  }
  let login: string;
  let password: string;
  let database: string;
  try {
    login = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("SITE_BUILD_PROVIDER_WIRE_DATABASE_URL_INVALID");
  }
  const queryKeys = [...url.searchParams.keys()];
  if (
    !new Set(["postgres:", "postgresql:"]).has(url.protocol) ||
    !LOGIN.test(login) ||
    FORBIDDEN_LOGIN.has(login) ||
    !password ||
    !database ||
    /[\0\r\n]/u.test(`${login}${password}${database}`) ||
    !url.hostname ||
    !/^\/[A-Za-z0-9_.-]+$/u.test(url.pathname) ||
    queryKeys.some(
      (key, index) =>
        !ALLOWED_QUERY_PARAMETERS.has(key) ||
        queryKeys.indexOf(key) !== index ||
        /[\0\r\n]/u.test(url.searchParams.get(key) ?? ""),
    ) ||
    url.hash
  ) {
    throw new Error("SITE_BUILD_PROVIDER_WIRE_DATABASE_URL_INVALID");
  }
  const existingOptions = url.searchParams.get("options")?.trim();
  url.searchParams.set(
    "options",
    [
      existingOptions,
      `-c statement_timeout=${PROVIDER_WIRE_STATEMENT_TIMEOUT_MS}`,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return url.toString();
}

export function isAuthorizedSiteBuildProviderWirePrincipal(
  evidence: SiteBuildProviderWirePrincipal | undefined,
): boolean {
  return Boolean(
    evidence &&
      LOGIN.test(evidence.sessionUser) &&
      !FORBIDDEN_LOGIN.has(evidence.sessionUser) &&
      evidence.currentUser === evidence.sessionUser &&
      evidence.statementTimeout === "4s" &&
      !evidence.superuser &&
      !evidence.bypassRls &&
      !evidence.createDb &&
      !evidence.createRole &&
      !evidence.replication &&
      evidence.inherit &&
      Array.isArray(evidence.memberships) &&
      evidence.memberships.length === 2 &&
      evidence.memberships[0]?.role === "app_user" &&
      evidence.memberships[1]?.role === "runtime_worker" &&
      evidence.memberships.every(
        (membership) =>
          membership.adminOption === false && membership.inheritOption === true,
      ),
  );
}

export class SiteBuildProviderWireDatabase
  implements SiteBuildProviderWireWorkspaceDatabase
{
  private principalVerified = false;

  constructor(
    private readonly client: ProviderWireClient,
    private readonly expected: {
      databaseName: string;
      migrationRevision: string;
    },
  ) {}

  async checkReadiness(): Promise<SiteBuildProviderWireReadiness> {
    try {
      await this.client.$connect();
      const rows = await this.client.$queryRawUnsafe<
        SiteBuildProviderWireReadinessRow[]
      >(`SELECT p.rolname::text AS "sessionUser",
                current_user::text AS "currentUser",
                current_database()::text AS "databaseName",
                current_setting('statement_timeout')::text AS "statementTimeout",
                p.rolsuper AS "superuser", p.rolbypassrls AS "bypassRls",
                p.rolcreatedb AS "createDb", p.rolcreaterole AS "createRole",
                p.rolreplication AS "replication", p.rolinherit AS "inherit",
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'role', granted.rolname::text,
                    'adminOption', membership.admin_option,
                    'inheritOption', membership.inherit_option
                  ) ORDER BY granted.rolname)
                    FROM pg_catalog.pg_auth_members membership
                    JOIN pg_catalog.pg_roles granted
                      ON granted.oid = membership.roleid
                   WHERE membership.member = p.oid
                ), '[]'::jsonb) AS "memberships",
                (SELECT migration_name
                   FROM public."_prisma_migrations"
                  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
                  ORDER BY finished_at DESC, migration_name DESC LIMIT 1
                )::text AS "migrationRevision",
                COALESCE((SELECT bool_and(
                  pg_catalog.to_regprocedure(signature) IS NOT NULL AND
                  pg_catalog.has_function_privilege(
                    session_user,
                    pg_catalog.to_regprocedure(signature),
                    'EXECUTE'
                  )
                ) FROM unnest(ARRAY[
                  'public.reserve_site_build_model_spend_v1(uuid,uuid,uuid,uuid,character varying,text,text,bigint,jsonb,character varying,character varying,character varying,character varying,character varying,character varying,integer,integer,integer,integer,integer,bigint,character varying,character varying,character varying,bigint,bigint,bigint)',
                  'public.allocate_site_build_provider_wire_v1(uuid,uuid,uuid,character varying,uuid,character varying,character varying,character varying)',
                  'public.begin_site_build_provider_wire_v1(uuid,uuid,uuid)',
                  'public.claim_site_build_provider_readback_probe_v1(uuid,uuid,integer)',
                  'public.record_site_build_provider_readback_probe_v1(uuid,uuid,character varying,integer,timestamp with time zone)',
                  'public.record_site_build_provider_wire_receipt_v1(uuid,uuid,character varying,character varying,character varying,integer,bigint,integer,integer,bigint,character varying,timestamp with time zone)',
                  'public.finalize_site_build_provider_wire_v1(uuid,uuid,character varying,character varying,character varying,character varying,character varying,timestamp with time zone)',
                  'public.finalize_site_build_provider_wire_from_receipt_v1(uuid,uuid)',
                  'public.finalize_site_build_provider_wire_not_dispatched_v1(uuid,uuid)'
                ]) signature), false)
                  AS "requiredFunctionsReady",
                (pg_catalog.has_table_privilege(session_user, 'public.site_build_provider_wire_attempt', 'SELECT')
                  AND pg_catalog.has_table_privilege(session_user, 'public.site_build_provider_wire_receipt', 'SELECT')
                  AND pg_catalog.has_table_privilege(session_user, 'public.site_build_provider_readback_probe', 'SELECT')
                  AND pg_catalog.has_table_privilege(session_user, 'public.site_build_provider_readback_probe_observation', 'SELECT')
                  AND NOT pg_catalog.has_table_privilege(session_user, 'public.site_build_provider_wire_attempt', 'INSERT,UPDATE,DELETE')
                  AND NOT pg_catalog.has_table_privilege(session_user, 'public.site_build_provider_wire_receipt', 'INSERT,UPDATE,DELETE')
                  AND NOT pg_catalog.has_table_privilege(session_user, 'public.site_build_provider_readback_probe', 'INSERT,UPDATE,DELETE')
                  AND NOT pg_catalog.has_table_privilege(session_user, 'public.site_build_provider_readback_probe_observation', 'INSERT,UPDATE,DELETE'))
                  AS "directWritesDenied",
                COALESCE((SELECT count(*) = 4 AND
                    bool_and(c.relrowsecurity AND c.relforcerowsecurity)
                  FROM pg_catalog.pg_class c
                  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = ANY(ARRAY[
                   'site_build_provider_wire_attempt',
                   'site_build_provider_wire_receipt',
                   'site_build_provider_readback_probe',
                   'site_build_provider_readback_probe_observation'
                 ])), false) AS "rlsForced"
           FROM pg_catalog.pg_roles p
          WHERE p.rolname = session_user`);
      const row = rows.length === 1 ? rows[0] : undefined;
      if (!row || !isAuthorizedSiteBuildProviderWirePrincipal(row)) {
        this.principalVerified = false;
        return Object.freeze({
            status: "failed" as const,
            code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_PRINCIPAL_INVALID" as const,
          });
      }
      if (
        row.databaseName !== this.expected.databaseName ||
        row.migrationRevision !== this.expected.migrationRevision
      ) {
        this.principalVerified = false;
        return Object.freeze({
          status: "failed" as const,
          code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_IDENTITY_INVALID" as const,
        });
      }
      if (
        !row.requiredFunctionsReady ||
        !row.directWritesDenied ||
        !row.rlsForced
      ) {
        this.principalVerified = false;
        return Object.freeze({
          status: "failed" as const,
          code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_CONTRACT_INVALID" as const,
        });
      }
      this.principalVerified = true;
      return Object.freeze({ status: "ok" as const });
    } catch {
      this.principalVerified = false;
      return Object.freeze({
        status: "failed" as const,
        code: "SITE_BUILD_PROVIDER_WIRE_DATABASE_UNAVAILABLE" as const,
      });
    }
  }

  async withWorkspace<T>(
    workspaceId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    if (!UUID.test(workspaceId)) {
      throw new Error("SITE_BUILD_PROVIDER_WIRE_WORKSPACE_INVALID");
    }
    if (!this.principalVerified) {
      const readiness = await this.checkReadiness();
      if (readiness.status !== "ok") {
        throw new Error(readiness.code);
      }
    }
    return this.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        "SELECT set_config('app.current_workspace_id', $1, true)",
        workspaceId,
      );
      return operation(transaction);
    }, options);
  }

  async disconnect(): Promise<void> {
    this.principalVerified = false;
    await this.client.$disconnect();
  }
}

export function createSiteBuildProviderWireDatabaseFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  clientFactory: ProviderWireClientFactory = (databaseUrl) =>
    new PrismaClient({ datasourceUrl: databaseUrl }),
  expectedMigrationRevision?: string,
): SiteBuildProviderWireDatabase | undefined {
  const configured = env.SITE_BUILD_PROVIDER_WIRE_DATABASE_URL?.trim();
  if (!configured) return undefined;
  const appDatabaseUrl = env.APP_DATABASE_URL;
  const target = databaseTarget(configured);
  if (
    !appDatabaseUrl ||
    !target ||
    !siteBuildProviderWireTargetsAppDatabase(configured, appDatabaseUrl) ||
    !expectedMigrationRevision ||
    !MIGRATION_REVISION.test(expectedMigrationRevision)
  ) {
    throw new Error("SITE_BUILD_PROVIDER_WIRE_DATABASE_EXPECTATION_INVALID");
  }
  return new SiteBuildProviderWireDatabase(
    clientFactory(withSiteBuildProviderWireStatementTimeout(configured)),
    {
      databaseName: target.database,
      migrationRevision: expectedMigrationRevision,
    },
  );
}
