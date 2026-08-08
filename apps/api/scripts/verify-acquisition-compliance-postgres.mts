import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
export const ACQUISITION_COMPLIANCE_ISOLATED_DATABASE_AUTHORIZATION =
  "I_ACKNOWLEDGE_THIS_IS_AN_ISOLATED_DISPOSABLE_DATABASE";
export const ACQUISITION_COMPLIANCE_POSTGRES_NOT_RUN =
  "NOT_RUN_REQUIRES_ISOLATED_TEST_DB_AUTHORIZATION";
export const SUPPRESSION_RELEASE_GOVERNANCE_MIGRATION =
  "20260807234500_suppression_release_governance";
const OWNER_URL_ENV = "ACQUISITION_COMPLIANCE_TEST_OWNER_DATABASE_URL" as const;
const APP_URL_ENV = "ACQUISITION_COMPLIANCE_TEST_APP_DATABASE_URL" as const;
const AUTHORIZATION_ENV =
  "ACQUISITION_COMPLIANCE_TEST_DB_AUTHORIZATION" as const;
const DISPOSABLE_DATABASE_PATTERN =
  /^codex_acquisition_compliance_test_[a-z0-9_]+$/;
const PROTECTED_TABLES = [
  "suppression_record",
  "suppression_release_decision",
  "policy_decision_log",
] as const;
const SAFE_FAILURE_CODES: ReadonlySet<string> = new Set([
  ACQUISITION_COMPLIANCE_POSTGRES_NOT_RUN,
  ...`ACQUISITION_COMPLIANCE_TEST_DATABASE_REJECTED ACQUISITION_COMPLIANCE_OWNER_ROLE_UNSAFE ACQUISITION_COMPLIANCE_APP_ROLE_UNSAFE
ACQUISITION_COMPLIANCE_MIGRATION_MISSING ACQUISITION_COMPLIANCE_RLS_UNSAFE ACQUISITION_COMPLIANCE_APPEND_ONLY_UNSAFE
ACQUISITION_COMPLIANCE_DATABASE_ROLE_UNVERIFIED ACQUISITION_COMPLIANCE_CATALOG_UNVERIFIED ACQUISITION_COMPLIANCE_WORKSPACE_ISOLATION_FAILED
ACQUISITION_COMPLIANCE_DENIAL_UNVERIFIED ACQUISITION_COMPLIANCE_MUTATION_UNEXPECTEDLY_ALLOWED
ACQUISITION_COMPLIANCE_VERIFICATION_AND_CLEANUP_FAILED ACQUISITION_COMPLIANCE_VERIFICATION_AND_DISCONNECT_FAILED`.split(
    /\s+/,
  ),
]);
type ProtectedTable = (typeof PROTECTED_TABLES)[number];
export interface AcquisitionComplianceVerifierEnvironment {
  readonly ownerUrl: string;
  readonly appUrl: string;
  readonly databaseName: string;
  readonly ownerRoleName: string;
  readonly appRoleName: string;
}
export interface DatabaseRoleFacts {
  readonly roleName: string;
  readonly databaseName: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  readonly databaseOwnerMember: boolean;
  readonly ownsAnyRequiredRelation: boolean;
  readonly ownsAllRequiredRelations: boolean;
}
interface RelationSecurityFact {
  readonly tableName: string;
  readonly rowLevelSecurity: boolean;
  readonly forceRowLevelSecurity: boolean;
}
interface TablePrivilegeFact {
  readonly tableName: string;
  readonly select: boolean;
  readonly insert: boolean;
  readonly update: boolean;
  readonly delete: boolean;
  readonly truncate: boolean;
}
export interface ComplianceCatalogFacts {
  readonly migrationApplied: boolean;
  readonly relations: readonly RelationSecurityFact[];
  readonly privileges: readonly TablePrivilegeFact[];
}
interface ParsedPostgresUrl {
  readonly value: string;
  readonly databaseName: string;
  readonly roleName: string;
  readonly hostname: string;
  readonly port: string;
}
interface SyntheticFixture {
  readonly workspaceId: string;
  readonly suppressionId: string;
  readonly releaseDecisionId: string;
  readonly policyDecisionId: string;
  readonly suppressionValue: string;
  readonly actorId: string;
}
interface VerifiedIsolation {
  readonly config: AcquisitionComplianceVerifierEnvironment;
  readonly owner: DatabaseRoleFacts;
  readonly app: DatabaseRoleFacts;
}
function fail(code: string): never {
  throw new Error(code);
}
function parsePostgresUrl(value: string | undefined): ParsedPostgresUrl {
  if (!value) fail(ACQUISITION_COMPLIANCE_POSTGRES_NOT_RUN);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("ACQUISITION_COMPLIANCE_TEST_DATABASE_REJECTED");
  }
  if (
    (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") ||
    !parsed.hostname ||
    !parsed.username
  ) {
    fail("ACQUISITION_COMPLIANCE_TEST_DATABASE_REJECTED");
  }
  let databaseName: string;
  let roleName: string;
  try {
    const encodedDatabaseName = parsed.pathname.replace(/^\//, "");
    if (!encodedDatabaseName || encodedDatabaseName.includes("/")) {
      fail("ACQUISITION_COMPLIANCE_TEST_DATABASE_REJECTED");
    }
    databaseName = decodeURIComponent(encodedDatabaseName);
    roleName = decodeURIComponent(parsed.username);
  } catch {
    fail("ACQUISITION_COMPLIANCE_TEST_DATABASE_REJECTED");
  }
  if (!DISPOSABLE_DATABASE_PATTERN.test(databaseName) || !roleName) {
    fail("ACQUISITION_COMPLIANCE_TEST_DATABASE_REJECTED");
  }
  return Object.freeze({
    value,
    databaseName,
    roleName,
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
  });
}
export function resolveAcquisitionComplianceVerifierEnvironment(
  env: NodeJS.ProcessEnv,
): AcquisitionComplianceVerifierEnvironment {
  if (
    env[AUTHORIZATION_ENV] !==
    ACQUISITION_COMPLIANCE_ISOLATED_DATABASE_AUTHORIZATION
  ) {
    fail(ACQUISITION_COMPLIANCE_POSTGRES_NOT_RUN);
  }
  const owner = parsePostgresUrl(env[OWNER_URL_ENV]);
  const app = parsePostgresUrl(env[APP_URL_ENV]);
  if (
    owner.databaseName !== app.databaseName ||
    owner.hostname !== app.hostname ||
    owner.port !== app.port ||
    owner.roleName === app.roleName
  ) {
    fail("ACQUISITION_COMPLIANCE_TEST_DATABASE_REJECTED");
  }
  return Object.freeze({
    ownerUrl: owner.value,
    appUrl: app.value,
    databaseName: owner.databaseName,
    ownerRoleName: owner.roleName,
    appRoleName: app.roleName,
  });
}
function hasCompleteRoleFacts(facts: DatabaseRoleFacts): boolean {
  return Boolean(
    facts &&
    typeof facts.roleName === "string" &&
    facts.roleName.length > 0 &&
    typeof facts.databaseName === "string" &&
    facts.databaseName.length > 0 &&
    typeof facts.superuser === "boolean" &&
    typeof facts.bypassRls === "boolean" &&
    typeof facts.databaseOwnerMember === "boolean" &&
    typeof facts.ownsAnyRequiredRelation === "boolean" &&
    typeof facts.ownsAllRequiredRelations === "boolean",
  );
}
export function assertIsolatedDatabaseRoleFacts(
  config: AcquisitionComplianceVerifierEnvironment,
  owner: DatabaseRoleFacts,
  app: DatabaseRoleFacts,
): { readonly owner: DatabaseRoleFacts; readonly app: DatabaseRoleFacts } {
  if (
    !hasCompleteRoleFacts(owner) ||
    owner.databaseName !== config.databaseName ||
    owner.roleName !== config.ownerRoleName ||
    owner.roleName === config.appRoleName ||
    !owner.databaseOwnerMember ||
    !owner.ownsAnyRequiredRelation ||
    !owner.ownsAllRequiredRelations
  ) {
    fail("ACQUISITION_COMPLIANCE_OWNER_ROLE_UNSAFE");
  }
  if (
    !hasCompleteRoleFacts(app) ||
    app.databaseName !== config.databaseName ||
    app.roleName !== config.appRoleName ||
    app.roleName === owner.roleName ||
    app.superuser ||
    app.bypassRls ||
    app.databaseOwnerMember ||
    app.ownsAnyRequiredRelation ||
    app.ownsAllRequiredRelations
  ) {
    fail("ACQUISITION_COMPLIANCE_APP_ROLE_UNSAFE");
  }
  return Object.freeze({ owner: { ...owner }, app: { ...app } });
}

function exactFactMap<T extends { readonly tableName: string }>(
  facts: readonly T[],
  failureCode: string,
): ReadonlyMap<ProtectedTable, T> {
  const byName = new Map<string, T>();
  for (const fact of facts) byName.set(fact.tableName, fact);
  if (
    facts.length !== PROTECTED_TABLES.length ||
    byName.size !== PROTECTED_TABLES.length ||
    PROTECTED_TABLES.some((tableName) => !byName.has(tableName))
  ) {
    fail(failureCode);
  }
  return byName as ReadonlyMap<ProtectedTable, T>;
}

export function assertComplianceCatalogFacts(
  facts: ComplianceCatalogFacts,
): ComplianceCatalogFacts {
  if (!facts?.migrationApplied) {
    fail("ACQUISITION_COMPLIANCE_MIGRATION_MISSING");
  }
  const relations = exactFactMap(
    facts.relations,
    "ACQUISITION_COMPLIANCE_RLS_UNSAFE",
  );
  for (const tableName of PROTECTED_TABLES) {
    const relation = relations.get(tableName);
    if (!relation?.rowLevelSecurity || !relation.forceRowLevelSecurity) {
      fail("ACQUISITION_COMPLIANCE_RLS_UNSAFE");
    }
  }

  const privileges = exactFactMap(
    facts.privileges,
    "ACQUISITION_COMPLIANCE_APPEND_ONLY_UNSAFE",
  );
  for (const tableName of PROTECTED_TABLES) {
    const privilege = privileges.get(tableName);
    if (
      !privilege?.select ||
      !privilege.insert ||
      privilege.update ||
      privilege.delete ||
      privilege.truncate
    ) {
      fail("ACQUISITION_COMPLIANCE_APPEND_ONLY_UNSAFE");
    }
  }
  return Object.freeze({
    migrationApplied: true,
    relations: facts.relations.map((fact) => ({ ...fact })),
    privileges: facts.privileges.map((fact) => ({ ...fact })),
  });
}

async function readDatabaseRoleFacts(
  client: PrismaClient,
): Promise<DatabaseRoleFacts> {
  const rows = await client.$queryRaw<DatabaseRoleFacts[]>`
    SELECT
      current_user::text AS "roleName",
      current_database()::text AS "databaseName",
      r.rolsuper AS "superuser",
      r.rolbypassrls AS "bypassRls",
      pg_has_role(current_user, d.datdba, 'MEMBER') AS "databaseOwnerMember",
      EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname IN (
            'suppression_record',
            'suppression_release_decision',
            'policy_decision_log'
          )
          AND pg_has_role(current_user, c.relowner, 'MEMBER')
      ) AS "ownsAnyRequiredRelation",
      (
        SELECT COUNT(*) = 3
          AND COALESCE(
            BOOL_AND(pg_has_role(current_user, c.relowner, 'MEMBER')),
            false
          )
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname IN (
            'suppression_record',
            'suppression_release_decision',
            'policy_decision_log'
          )
      ) AS "ownsAllRequiredRelations"
    FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_database d ON d.datname = current_database()
    WHERE r.rolname = current_user
  `;
  if (rows.length !== 1 || !hasCompleteRoleFacts(rows[0])) {
    fail("ACQUISITION_COMPLIANCE_DATABASE_ROLE_UNVERIFIED");
  }
  return { ...rows[0] };
}

async function readComplianceCatalogFacts(
  owner: PrismaClient,
  app: PrismaClient,
): Promise<ComplianceCatalogFacts> {
  const migration = await owner.$queryRaw<{ migrationApplied: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM "public"."_prisma_migrations"
      WHERE "migration_name" = ${SUPPRESSION_RELEASE_GOVERNANCE_MIGRATION}
        AND "finished_at" IS NOT NULL
        AND "rolled_back_at" IS NULL
    ) AS "migrationApplied"
  `;
  const relations = await owner.$queryRaw<RelationSecurityFact[]>`
    SELECT
      c.relname::text AS "tableName",
      c.relrowsecurity AS "rowLevelSecurity",
      c.relforcerowsecurity AS "forceRowLevelSecurity"
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname IN (
        'suppression_record',
        'suppression_release_decision',
        'policy_decision_log'
      )
    ORDER BY c.relname
  `;
  const privileges = await app.$queryRaw<TablePrivilegeFact[]>`
    SELECT
      required."tableName",
      has_table_privilege(current_user, 'public.' || required."tableName", 'SELECT') AS "select",
      has_table_privilege(current_user, 'public.' || required."tableName", 'INSERT') AS "insert",
      has_table_privilege(current_user, 'public.' || required."tableName", 'UPDATE') AS "update",
      has_table_privilege(current_user, 'public.' || required."tableName", 'DELETE') AS "delete",
      has_table_privilege(current_user, 'public.' || required."tableName", 'TRUNCATE') AS "truncate"
    FROM (
      VALUES
        ('suppression_record'),
        ('suppression_release_decision'),
        ('policy_decision_log')
    ) AS required("tableName")
    ORDER BY required."tableName"
  `;
  if (
    migration.length !== 1 ||
    typeof migration[0]?.migrationApplied !== "boolean"
  ) {
    fail("ACQUISITION_COMPLIANCE_CATALOG_UNVERIFIED");
  }
  return {
    migrationApplied: migration[0].migrationApplied,
    relations: relations.map((fact) => ({ ...fact })),
    privileges: privileges.map((fact) => ({ ...fact })),
  };
}

function createSyntheticFixture(): SyntheticFixture {
  const workspaceId = randomUUID();
  return Object.freeze({
    workspaceId,
    suppressionId: randomUUID(),
    releaseDecisionId: randomUUID(),
    policyDecisionId: randomUUID(),
    suppressionValue: `synthetic-${randomUUID()}.invalid`,
    actorId: `synthetic-verifier-${randomUUID()}`,
  });
}

async function withWorkspace<T>(
  client: PrismaClient,
  workspaceId: string,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      SELECT set_config('app.current_workspace_id', ${workspaceId}, true)
    `;
    return operation(transaction);
  });
}

async function seedSyntheticFixture(
  owner: PrismaClient,
  fixture: SyntheticFixture,
): Promise<void> {
  await withWorkspace(owner, fixture.workspaceId, async (transaction) => {
    await transaction.$executeRaw`
      INSERT INTO "public"."workspace" ("id", "name", "created_at", "updated_at")
      VALUES (
        ${fixture.workspaceId}::uuid,
        ${`isolated-compliance-verifier-${fixture.workspaceId}`}::text,
        clock_timestamp(),
        clock_timestamp()
      )
    `;
    await transaction.$executeRaw`
      INSERT INTO "public"."suppression_record" (
        "id", "workspace_id", "type", "value", "reason"
      ) VALUES (
        ${fixture.suppressionId}::uuid,
        ${fixture.workspaceId}::uuid,
        'domain',
        ${fixture.suppressionValue},
        'manual'
      )
    `;
    await transaction.$executeRaw`
      INSERT INTO "public"."suppression_release_decision" (
        "id", "workspace_id", "suppression_record_id", "request_kind",
        "status", "justification", "actor_id"
      ) VALUES (
        ${fixture.releaseDecisionId}::uuid,
        ${fixture.workspaceId}::uuid,
        ${fixture.suppressionId}::uuid,
        'USER_PREFERENCE',
        'PENDING_REVIEW',
        'synthetic isolated verifier review fact',
        ${fixture.actorId}
      )
    `;
    await transaction.$executeRaw`
      INSERT INTO "public"."policy_decision_log" (
        "id", "workspace_id", "action", "data_class",
        "subject_jurisdiction", "processor_jurisdiction", "effect",
        "allowed", "reason", "rule_version", "actor_id", "correlation_id"
      ) VALUES (
        ${fixture.policyDecisionId}::uuid,
        ${fixture.workspaceId}::uuid,
        'STORE',
        'green',
        'OTHER',
        'OTHER',
        'ALLOW',
        true,
        'synthetic isolated verifier decision',
        'isolated-verifier-v1',
        ${fixture.actorId},
        ${`synthetic-${randomUUID()}`}
      )
    `;
  });
}

interface VisibleFixtureRow {
  readonly tableName: ProtectedTable;
  readonly id: string;
  readonly workspaceId: string;
}

async function assertWorkspaceView(
  app: PrismaClient,
  visible: SyntheticFixture,
  hidden: SyntheticFixture,
): Promise<void> {
  const rows = await withWorkspace(app, visible.workspaceId, (transaction) =>
    transaction.$queryRaw<VisibleFixtureRow[]>(Prisma.sql`
      SELECT
        'suppression_record'::text AS "tableName",
        "id"::text AS "id",
        "workspace_id"::text AS "workspaceId"
      FROM "public"."suppression_record"
      WHERE "id" IN (${visible.suppressionId}::uuid, ${hidden.suppressionId}::uuid)
      UNION ALL
      SELECT
        'suppression_release_decision'::text,
        "id"::text,
        "workspace_id"::text
      FROM "public"."suppression_release_decision"
      WHERE "id" IN (${visible.releaseDecisionId}::uuid, ${hidden.releaseDecisionId}::uuid)
      UNION ALL
      SELECT
        'policy_decision_log'::text,
        "id"::text,
        "workspace_id"::text
      FROM "public"."policy_decision_log"
      WHERE "id" IN (${visible.policyDecisionId}::uuid, ${hidden.policyDecisionId}::uuid)
      ORDER BY 1
    `),
  );
  const expectedIds = [
    visible.policyDecisionId,
    visible.releaseDecisionId,
    visible.suppressionId,
  ].sort();
  const actualIds = rows.map((row) => row.id).sort();
  if (
    rows.length !== PROTECTED_TABLES.length ||
    rows.some((row) => row.workspaceId !== visible.workspaceId) ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    fail("ACQUISITION_COMPLIANCE_WORKSPACE_ISOLATION_FAILED");
  }
}

async function expectPostgresDenial(
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const directCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    const meta =
      typeof error === "object" && error !== null && "meta" in error
        ? error.meta
        : undefined;
    const postgresCode =
      typeof meta === "object" && meta !== null && "code" in meta
        ? String(meta.code)
        : directCode;
    if (postgresCode === "42501") return;
    fail("ACQUISITION_COMPLIANCE_DENIAL_UNVERIFIED");
  }
  fail("ACQUISITION_COMPLIANCE_MUTATION_UNEXPECTEDLY_ALLOWED");
}

async function verifyWorkspaceIsolation(
  app: PrismaClient,
  workspaceFixture: SyntheticFixture,
  otherWorkspaceFixture: SyntheticFixture,
): Promise<void> {
  await assertWorkspaceView(app, workspaceFixture, otherWorkspaceFixture);
  await assertWorkspaceView(app, otherWorkspaceFixture, workspaceFixture);

  const otherWorkspaceId = otherWorkspaceFixture.workspaceId;
  await expectPostgresDenial(() =>
    withWorkspace(
      app,
      workspaceFixture.workspaceId,
      (transaction) =>
        transaction.$executeRaw`
        INSERT INTO "public"."suppression_record" (
          "id", "workspace_id", "type", "value", "reason"
        ) VALUES (
          ${randomUUID()}::uuid,
          ${otherWorkspaceId}::uuid,
          'domain',
          ${`cross-workspace-${randomUUID()}.invalid`},
          'manual'
        )
      `,
    ),
  );
  await expectPostgresDenial(() =>
    withWorkspace(
      app,
      workspaceFixture.workspaceId,
      (transaction) =>
        transaction.$executeRaw`
        INSERT INTO "public"."suppression_release_decision" (
          "id", "workspace_id", "suppression_record_id", "request_kind",
          "status", "justification", "actor_id"
        ) VALUES (
          ${randomUUID()}::uuid,
          ${otherWorkspaceId}::uuid,
          ${otherWorkspaceFixture.suppressionId}::uuid,
          'USER_PREFERENCE',
          'PENDING_REVIEW',
          'synthetic cross-workspace denial probe',
          ${workspaceFixture.actorId}
        )
      `,
    ),
  );
  await expectPostgresDenial(() =>
    withWorkspace(
      app,
      workspaceFixture.workspaceId,
      (transaction) =>
        transaction.$executeRaw`
        INSERT INTO "public"."policy_decision_log" (
          "id", "workspace_id", "action", "data_class",
          "subject_jurisdiction", "processor_jurisdiction", "effect",
          "allowed", "reason", "rule_version"
        ) VALUES (
          ${randomUUID()}::uuid,
          ${otherWorkspaceId}::uuid,
          'STORE',
          'green',
          'OTHER',
          'OTHER',
          'ALLOW',
          true,
          'synthetic cross-workspace denial probe',
          'isolated-verifier-v1'
        )
      `,
    ),
  );
}

async function verifyAppendOnlyMutationsDenied(
  app: PrismaClient,
  fixture: SyntheticFixture,
): Promise<void> {
  await expectPostgresDenial(() =>
    withWorkspace(
      app,
      fixture.workspaceId,
      (transaction) =>
        transaction.$executeRaw`
        UPDATE "public"."suppression_record"
        SET "reason" = 'synthetic-mutation-must-fail'
        WHERE "id" = ${fixture.suppressionId}::uuid
      `,
    ),
  );
  await expectPostgresDenial(() =>
    withWorkspace(
      app,
      fixture.workspaceId,
      (transaction) =>
        transaction.$executeRaw`
        DELETE FROM "public"."suppression_record"
        WHERE "id" = ${fixture.suppressionId}::uuid
      `,
    ),
  );
  await expectPostgresDenial(() =>
    withWorkspace(
      app,
      fixture.workspaceId,
      (transaction) =>
        transaction.$executeRaw`
        UPDATE "public"."suppression_release_decision"
        SET "status" = 'PENDING_REVIEW'
        WHERE "id" = ${fixture.releaseDecisionId}::uuid
      `,
    ),
  );
  await expectPostgresDenial(() =>
    withWorkspace(
      app,
      fixture.workspaceId,
      (transaction) =>
        transaction.$executeRaw`
        DELETE FROM "public"."suppression_release_decision"
        WHERE "id" = ${fixture.releaseDecisionId}::uuid
      `,
    ),
  );
  await expectPostgresDenial(() =>
    withWorkspace(
      app,
      fixture.workspaceId,
      (transaction) =>
        transaction.$executeRaw`
        UPDATE "public"."policy_decision_log"
        SET "reason" = 'synthetic-mutation-must-fail'
        WHERE "id" = ${fixture.policyDecisionId}::uuid
      `,
    ),
  );
  await expectPostgresDenial(() =>
    withWorkspace(
      app,
      fixture.workspaceId,
      (transaction) =>
        transaction.$executeRaw`
        DELETE FROM "public"."policy_decision_log"
        WHERE "id" = ${fixture.policyDecisionId}::uuid
      `,
    ),
  );
}

async function cleanupVerifiedIsolatedDatabaseFixtures(
  owner: PrismaClient,
  verified: VerifiedIsolation,
  fixtures: readonly SyntheticFixture[],
): Promise<void> {
  const currentOwner = await readDatabaseRoleFacts(owner);
  assertIsolatedDatabaseRoleFacts(verified.config, currentOwner, verified.app);
  for (const fixture of fixtures) {
    await withWorkspace(owner, fixture.workspaceId, async (transaction) => {
      await transaction.$executeRaw`
        DELETE FROM "public"."policy_decision_log"
        WHERE "workspace_id" = ${fixture.workspaceId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM "public"."suppression_release_decision"
        WHERE "workspace_id" = ${fixture.workspaceId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM "public"."suppression_record"
        WHERE "workspace_id" = ${fixture.workspaceId}::uuid
      `;
      await transaction.$executeRaw`
        DELETE FROM "public"."workspace"
        WHERE "id" = ${fixture.workspaceId}::uuid
      `;
    });
  }
}

function aggregateFailure(
  existing: unknown,
  next: unknown,
  code: string,
): unknown {
  if (existing === undefined) return next;
  return new AggregateError([existing, next], code);
}

export async function runAcquisitionCompliancePostgresVerifier(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = resolveAcquisitionComplianceVerifierEnvironment(env);
  const owner = new PrismaClient({ datasourceUrl: config.ownerUrl });
  const app = new PrismaClient({ datasourceUrl: config.appUrl });
  const workspaceFixture = createSyntheticFixture();
  const otherWorkspaceFixture = createSyntheticFixture();
  const fixtures = [workspaceFixture, otherWorkspaceFixture] as const;
  let verified: VerifiedIsolation | undefined;
  let failure: unknown;

  try {
    await Promise.all([owner.$connect(), app.$connect()]);
    const [ownerFacts, appFacts] = await Promise.all([
      readDatabaseRoleFacts(owner),
      readDatabaseRoleFacts(app),
    ]);
    const roles = assertIsolatedDatabaseRoleFacts(config, ownerFacts, appFacts);
    assertComplianceCatalogFacts(await readComplianceCatalogFacts(owner, app));
    verified = Object.freeze({ config, ...roles });

    await seedSyntheticFixture(owner, workspaceFixture);
    await seedSyntheticFixture(owner, otherWorkspaceFixture);
    await verifyWorkspaceIsolation(
      app,
      workspaceFixture,
      otherWorkspaceFixture,
    );
    await verifyAppendOnlyMutationsDenied(app, workspaceFixture);
    await verifyAppendOnlyMutationsDenied(app, otherWorkspaceFixture);
  } catch (error) {
    failure = error;
  }

  if (verified) {
    try {
      await cleanupVerifiedIsolatedDatabaseFixtures(owner, verified, fixtures);
    } catch (error) {
      failure = aggregateFailure(
        failure,
        error,
        "ACQUISITION_COMPLIANCE_VERIFICATION_AND_CLEANUP_FAILED",
      );
    }
  }

  const disconnectResults = await Promise.allSettled([
    owner.$disconnect(),
    app.$disconnect(),
  ]);
  for (const result of disconnectResults) {
    if (result.status === "rejected") {
      failure = aggregateFailure(
        failure,
        result.reason,
        "ACQUISITION_COMPLIANCE_VERIFICATION_AND_DISCONNECT_FAILED",
      );
    }
  }
  if (failure !== undefined) throw failure;
  console.log("ACQUISITION_COMPLIANCE_POSTGRES_VERIFIED");
}

export function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return resolve(entrypoint) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

export function safeAcquisitionComplianceFailureCode(error: unknown): string {
  if (error instanceof Error && SAFE_FAILURE_CODES.has(error.message)) {
    return error.message;
  }
  return "ACQUISITION_COMPLIANCE_POSTGRES_VERIFICATION_FAILED";
}

if (isDirectExecution()) {
  void runAcquisitionCompliancePostgresVerifier().catch((error: unknown) => {
    console.error(safeAcquisitionComplianceFailureCode(error));
    process.exitCode = 1;
  });
}
