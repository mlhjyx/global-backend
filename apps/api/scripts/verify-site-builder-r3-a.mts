/**
 * R3-A BuildRun database backstops against the real Ubuntu development PostgreSQL.
 *
 * Proves app_user/FORCE RLS isolation, composite tenant provenance, legal states,
 * and database-level single-flight under two concurrent connections. All fixtures
 * are isolated by random UUIDs and removed in finally.
 *
 * Run from apps/api:
 *   ALLOW_DEV_DB_VERIFIER=true \
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-site-builder-r3-a.mts
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

function requireDevelopmentDatabase(): void {
  if (
    process.env.ALLOW_DEV_DB_VERIFIER !== "true" ||
    process.env.NODE_ENV === "production"
  ) {
    throw new Error(
      "refusing R3-A verifier: require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV",
    );
  }

  for (const [name, raw] of [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["APP_DATABASE_URL", process.env.APP_DATABASE_URL],
  ] as const) {
    if (!raw) throw new Error(`${name} is required`);
    const target = new URL(raw);
    if (
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(
        target.hostname.toLowerCase(),
      ) ||
      target.pathname !== "/global_dev"
    ) {
      throw new Error(
        `refusing ${name} target ${target.hostname}${target.pathname}; require loopback/global_dev`,
      );
    }
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`  ✅ ${message}`);
}

function rejectedReason(
  result: PromiseSettledResult<unknown> | undefined,
): unknown {
  return result?.status === "rejected" ? result.reason : undefined;
}

function isKnownPrismaError(
  error: unknown,
  code: string,
  constraint?: string,
): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== code) return false;
  if (!constraint) return true;
  return error.meta?.constraint === constraint;
}

async function withWorkspace<T>(
  client: PrismaClient,
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });
}

requireDevelopmentDatabase();

const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const appA = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL });
const appB = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL });
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const siteId = randomUUID();

try {
  const [ownerRole] = await owner.$queryRaw<
    Array<{ currentUser: string; isSuper: boolean; bypassRls: boolean }>
  >`SELECT current_user AS "currentUser", rolsuper AS "isSuper", rolbypassrls AS "bypassRls"
    FROM pg_roles WHERE rolname = current_user`;
  check(
    ownerRole?.currentUser !== "app_user" &&
      (ownerRole?.isSuper || ownerRole?.bypassRls),
    "DATABASE_URL is a trusted owner/BYPASSRLS connection",
  );

  const [role] = await appA.$queryRaw<
    Array<{ currentUser: string; isSuper: boolean; bypassRls: boolean }>
  >`SELECT current_user AS "currentUser", rolsuper AS "isSuper", rolbypassrls AS "bypassRls"
    FROM pg_roles WHERE rolname = current_user`;
  check(
    role?.currentUser === "app_user" && !role.isSuper && !role.bypassRls,
    "APP_DATABASE_URL is non-superuser app_user without BYPASSRLS",
  );

  const [catalog] = await owner.$queryRaw<
    Array<{
      fkValidated: boolean;
      fkUpdateAction: string;
      checkValidated: boolean;
      activeIndex: string | null;
    }>
  >`SELECT
      (SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'site_build_run'::regclass
          AND conname = 'site_build_run_site_id_workspace_id_fkey') AS "fkValidated",
      (SELECT confupdtype::text FROM pg_constraint
        WHERE conrelid = 'site_build_run'::regclass
          AND conname = 'site_build_run_site_id_workspace_id_fkey') AS "fkUpdateAction",
      (SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'site_build_run'::regclass
          AND conname = 'site_build_run_status_check') AS "checkValidated",
      (SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'site_build_run'
          AND indexname = 'site_build_run_one_active_per_site_idx') AS "activeIndex"`;
  check(
    catalog?.fkValidated === true &&
      catalog.fkUpdateAction === "a" &&
      catalog.checkValidated === true &&
      catalog.activeIndex?.includes("UNIQUE INDEX") &&
      catalog.activeIndex.includes("queued") &&
      catalog.activeIndex.includes("running"),
    "catalog confirms validated NO ACTION FK/CHECK and partial active unique index",
  );

  await withWorkspace(appA, workspaceA, (tx) =>
    tx.site.create({
      data: {
        id: siteId,
        workspaceId: workspaceA,
        name: "R3-A verifier",
        slug: `r3-a-${siteId}`,
        intake: {},
      },
    }),
  );

  const competing = [appA, appB].map((client) =>
    withWorkspace(client, workspaceA, (tx) =>
      tx.siteBuildRun.create({
        data: {
          id: randomUUID(),
          workspaceId: workspaceA,
          siteId,
          kind: "refurbish",
          status: "queued",
        },
      }),
    ),
  );
  const results = await Promise.allSettled(competing);
  const concurrencyFailures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  check(
    results.filter((result) => result.status === "fulfilled").length === 1 &&
      concurrencyFailures.length === 1 &&
      isKnownPrismaError(concurrencyFailures[0]?.reason, "P2002"),
    "partial unique index admits exactly one concurrent active run (P2002 loser)",
  );

  const crossWorkspace = await Promise.allSettled([
    withWorkspace(appA, workspaceB, (tx) =>
      tx.siteBuildRun.create({
        data: {
          id: randomUUID(),
          workspaceId: workspaceB,
          siteId,
          kind: "refurbish",
          status: "succeeded",
        },
      }),
    ),
  ]);
  check(
    isKnownPrismaError(
      rejectedReason(crossWorkspace[0]),
      "P2003",
      "site_build_run_site_id_workspace_id_fkey",
    ),
    "composite FK rejects a cross-workspace Site reference with its constraint name",
  );

  const parentMove = await Promise.allSettled([
    owner.site.update({
      where: { id: siteId },
      data: { workspaceId: workspaceB },
    }),
  ]);
  check(
    isKnownPrismaError(
      rejectedReason(parentMove[0]),
      "P2003",
      "site_build_run_site_id_workspace_id_fkey",
    ),
    "NO ACTION provenance FK rejects implicit parent workspace reassignment",
  );

  const illegalState = await Promise.allSettled([
    withWorkspace(appA, workspaceA, (tx) =>
      tx.siteBuildRun.create({
        data: {
          id: randomUUID(),
          workspaceId: workspaceA,
          siteId,
          kind: "refurbish",
          status: "mystery",
        },
      }),
    ),
  ]);
  const illegalReason = rejectedReason(illegalState[0]);
  check(
    illegalReason instanceof Prisma.PrismaClientUnknownRequestError &&
      String(illegalReason).includes("23514") &&
      String(illegalReason).includes("site_build_run_status_check"),
    "status CHECK rejects an illegal value with SQLSTATE 23514 and constraint name",
  );

  const visibleA = await withWorkspace(appA, workspaceA, (tx) =>
    tx.siteBuildRun.count({ where: { siteId } }),
  );
  const visibleB = await withWorkspace(appA, workspaceB, (tx) =>
    tx.siteBuildRun.count({ where: { siteId } }),
  );
  check(
    visibleA === 1 && visibleB === 0,
    "FORCE RLS isolates BuildRuns by workspace",
  );

  const active = await withWorkspace(appA, workspaceA, (tx) =>
    tx.siteBuildRun.findFirstOrThrow({ where: { siteId } }),
  );
  check(
    active.temporalWorkflowId === null,
    "workflow identity remains nullable until the launcher persists its ACK",
  );
} finally {
  const deleted = await owner.site.deleteMany({ where: { id: siteId } });
  const [sitesLeft, runsLeft] = await Promise.all([
    owner.site.count({ where: { id: siteId } }),
    owner.siteBuildRun.count({ where: { siteId } }),
  ]);
  check(
    deleted.count === 1 && sitesLeft === 0 && runsLeft === 0,
    "owner cleanup removed the Site and cascaded every verifier BuildRun",
  );
  await Promise.all([
    owner.$disconnect(),
    appA.$disconnect(),
    appB.$disconnect(),
  ]);
}

console.log("R3-A development database verification passed; fixtures cleaned.");
