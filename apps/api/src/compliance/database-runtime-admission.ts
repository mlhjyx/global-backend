import { Prisma } from '@prisma/client';

export type DeploymentStage = "development" | "pilot" | "production";

export interface ApplicationDatabaseRoleFacts {
  roleName: string;
  superuser: boolean;
  bypassRls: boolean;
  databaseOwnerMember: boolean;
  ownsApplicationRelations: boolean;
}

export interface ApplicationDatabaseRoleProbe {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
}

const DATABASE_ROLE_QUERY = Prisma.sql`
  SELECT
    current_user::text AS "roleName",
    r.rolsuper AS "superuser",
    r.rolbypassrls AS "bypassRls",
    pg_has_role(current_user, d.datdba, 'MEMBER') AS "databaseOwnerMember",
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_toast'
        AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
        AND pg_has_role(current_user, c.relowner, 'MEMBER')
    ) AS "ownsApplicationRelations"
  FROM pg_catalog.pg_roles r
  JOIN pg_catalog.pg_database d ON d.datname = current_database()
  WHERE r.rolname = current_user
`;

type DatabaseEnvironment = Partial<
  Record<
    | "DEPLOYMENT_STAGE"
    | "NODE_ENV"
    | "APP_DATABASE_URL"
    | "DATABASE_URL"
    | "OWNER_DATABASE_URL",
    string
  >
>;

export function resolveDatabaseDeploymentStage(
  env: DatabaseEnvironment,
): DeploymentStage {
  const explicit = env.DEPLOYMENT_STAGE?.trim().toLowerCase();
  if (explicit) {
    if (
      explicit !== "development" &&
      explicit !== "pilot" &&
      explicit !== "production"
    ) {
      throw new Error("DEPLOYMENT_STAGE_INVALID");
    }
    if (env.NODE_ENV === "production" && explicit === "development") {
      throw new Error("DEPLOYMENT_STAGE_DOWNGRADE_FORBIDDEN");
    }
    return explicit;
  }
  return env.NODE_ENV === "production" ? "production" : "development";
}

function assertPostgresUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("APP_DATABASE_URL_INVALID");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("APP_DATABASE_URL_INVALID");
  }
  return value;
}

/** Resolve the app connection without ever including a credential-bearing URL in errors. */
export function resolveApplicationDatabaseUrl(
  env: DatabaseEnvironment,
): string {
  const stage = resolveDatabaseDeploymentStage(env);
  const appUrl = env.APP_DATABASE_URL?.trim();
  if (appUrl) return assertPostgresUrl(appUrl);
  if (stage !== "development") {
    throw new Error("APP_DATABASE_URL_REQUIRED");
  }
  const developmentUrl = env.DATABASE_URL?.trim();
  if (!developmentUrl) throw new Error("APP_DATABASE_URL_REQUIRED");
  return assertPostgresUrl(developmentUrl);
}

/**
 * Resolve the privileged platform-worker connection. This deliberately has no
 * development fallback: selecting an owner connection must always be an
 * explicit operator decision, and it must not alias the ordinary app role.
 */
export function resolvePlatformOwnerDatabaseUrl(
  env: DatabaseEnvironment,
): string {
  const value = env.OWNER_DATABASE_URL?.trim();
  if (!value) throw new Error("OWNER_DATABASE_URL_REQUIRED");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OWNER_DATABASE_URL_REJECTED");
  }
  if (
    (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") ||
    !parsed.username
  ) {
    throw new Error("OWNER_DATABASE_URL_REJECTED");
  }
  let username: string;
  try {
    username = decodeURIComponent(parsed.username).toLowerCase();
  } catch {
    throw new Error("OWNER_DATABASE_URL_REJECTED");
  }
  if (username === "app_user") {
    throw new Error("OWNER_DATABASE_URL_REJECTED");
  }

  const appValue = env.APP_DATABASE_URL?.trim();
  if (appValue) {
    try {
      if (parsed.href === new URL(appValue).href) {
        throw new Error("OWNER_DATABASE_URL_REJECTED");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "OWNER_DATABASE_URL_REJECTED"
      ) {
        throw error;
      }
      // A malformed APP_DATABASE_URL is rejected by the app admission path;
      // its value must not affect or appear in this owner-path error surface.
    }
  }
  return value;
}

export function assertSafeApplicationDatabaseRole(
  facts: ApplicationDatabaseRoleFacts,
): ApplicationDatabaseRoleFacts {
  if (
    !facts ||
    typeof facts.roleName !== "string" ||
    facts.roleName.length < 1 ||
    typeof facts.superuser !== "boolean" ||
    typeof facts.bypassRls !== "boolean" ||
    typeof facts.databaseOwnerMember !== "boolean" ||
    typeof facts.ownsApplicationRelations !== "boolean"
  ) {
    throw new Error("APP_DATABASE_ROLE_UNVERIFIED");
  }
  if (
    facts.superuser ||
    facts.bypassRls ||
    facts.databaseOwnerMember ||
    facts.ownsApplicationRelations
  ) {
    throw new Error("APP_DATABASE_ROLE_UNSAFE");
  }
  return { ...facts };
}

/** Static catalog query; no credential, workspace, or customer value is interpolated. */
export async function verifyApplicationDatabaseRole(
  client: ApplicationDatabaseRoleProbe,
): Promise<ApplicationDatabaseRoleFacts> {
  const rows =
    await client.$queryRaw<ApplicationDatabaseRoleFacts[]>(
      DATABASE_ROLE_QUERY,
    );
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("APP_DATABASE_ROLE_UNVERIFIED");
  }
  return assertSafeApplicationDatabaseRole(rows[0]);
}

/**
 * Verify that the explicit platform connection is actually privileged for the
 * approved maintenance surface. URL naming alone is never treated as proof.
 */
export async function verifyPlatformOwnerDatabaseRole(
  client: ApplicationDatabaseRoleProbe,
): Promise<ApplicationDatabaseRoleFacts> {
  const rows =
    await client.$queryRaw<ApplicationDatabaseRoleFacts[]>(
      DATABASE_ROLE_QUERY,
    );
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("OWNER_DATABASE_ROLE_UNVERIFIED");
  }
  const facts = rows[0];
  if (
    !facts ||
    typeof facts.roleName !== "string" ||
    facts.roleName.length < 1 ||
    typeof facts.superuser !== "boolean" ||
    typeof facts.bypassRls !== "boolean" ||
    typeof facts.databaseOwnerMember !== "boolean" ||
    typeof facts.ownsApplicationRelations !== "boolean"
  ) {
    throw new Error("OWNER_DATABASE_ROLE_UNVERIFIED");
  }
  if (
    facts.roleName.toLowerCase() === "app_user" ||
    (!facts.databaseOwnerMember && !facts.ownsApplicationRelations)
  ) {
    throw new Error("OWNER_DATABASE_ROLE_UNSAFE");
  }
  return { ...facts };
}
