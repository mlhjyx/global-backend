/**
 * MF0-A true PostgreSQL verifier (Ubuntu development only).
 *
 * Proves migration shape, explicit privileges, app_user/FORCE RLS A/B isolation,
 * compound Asset/source provenance, CHECK constraints, and concurrent recipe
 * idempotency. It does not exercise Sharp, SiteSpec deletion, or object cleanup;
 * those belong to M1-c and MF0-B respectively.
 *
 * Run from apps/api:
 *   ALLOW_DEV_DB_VERIFIER=true \
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *   node --import tsx scripts/verify-site-builder-mf0-a.mts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";

import { PrismaService } from "../src/prisma/prisma.service";

const checks: string[] = [];

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    hostname.toLowerCase(),
  );
}

function requireDevelopmentDatabase(): void {
  if (
    process.env.ALLOW_DEV_DB_VERIFIER !== "true" ||
    process.env.NODE_ENV === "production"
  ) {
    throw new Error(
      "refusing MF0-A verifier: require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV",
    );
  }
  for (const [name, raw] of [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["APP_DATABASE_URL", process.env.APP_DATABASE_URL],
  ] as const) {
    if (!raw) throw new Error(`${name} is required`);
    const target = new URL(raw);
    if (
      !isLoopback(target.hostname) ||
      (target.port || "5432") !== "5432" ||
      target.pathname !== "/global_dev"
    ) {
      throw new Error(
        `refusing ${name} target ${target.hostname}:${target.port}${target.pathname}; require loopback:5432/global_dev`,
      );
    }
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  checks.push(message);
  console.log(`  ✅ ${message}`);
}

async function rejects(message: string, action: () => Promise<unknown>) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  check(rejected, message);
}

function readyVariant(input: {
  workspaceId: string;
  siteId: string;
  assetId: string;
  recipeHash?: string;
  objectKey?: string;
  sourceVariantId?: string;
}): Prisma.AssetVariantUncheckedCreateInput {
  const suffix = randomUUID();
  return {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    assetId: input.assetId,
    sourceVariantId: input.sourceVariantId,
    variantType: "hero",
    mime: "image/avif",
    width: 1440,
    height: 810,
    sizeBytes: 123_456,
    objectKey:
      input.objectKey ??
      `ws/${input.workspaceId}/${input.siteId}/variants/${suffix}.avif`,
    contentHash: "b".repeat(64),
    pipelineVersion: "sharp-v1",
    recipeHash: input.recipeHash ?? randomUUID().replaceAll("-", "").repeat(2),
    status: "ready",
  };
}

async function main(): Promise<void> {
  requireDevelopmentDatabase();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const app = new PrismaService();
  const wsA = randomUUID();
  const wsB = randomUUID();
  const siteA = randomUUID();
  const siteA2 = randomUUID();
  const siteB = randomUUID();
  const assetA = randomUUID();
  const assetA2 = randomUUID();
  const assetB = randomUUID();
  let failure: unknown;

  try {
    await Promise.all([owner.$connect(), app.$connect()]);

    const role = await app.$queryRaw<
      { currentUser: string; isSuper: boolean; bypassRls: boolean }[]
    >`
      SELECT current_user AS "currentUser",
             r.rolsuper AS "isSuper",
             r.rolbypassrls AS "bypassRls"
        FROM pg_roles r
       WHERE r.rolname = current_user`;
    check(
      role[0]?.currentUser === "app_user" &&
        role[0]?.isSuper === false &&
        role[0]?.bypassRls === false,
      "app_user is non-superuser and non-BYPASSRLS",
    );

    const table = await owner.$queryRaw<
      {
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        appCrud: boolean;
        constraints: bigint;
      }[]
    >`
      SELECT c.relrowsecurity AS "rowSecurity",
             c.relforcerowsecurity AS "forceRowSecurity",
             has_table_privilege(
               'app_user',
               'asset_variant',
               'SELECT,INSERT,UPDATE,DELETE'
             ) AS "appCrud",
             (SELECT count(*)
                FROM pg_constraint con
               WHERE con.conrelid = 'asset_variant'::regclass
                 AND con.convalidated) AS constraints
        FROM pg_class c
       WHERE c.oid = 'asset_variant'::regclass`;
    check(
      table[0]?.rowSecurity && table[0]?.forceRowSecurity,
      "asset_variant has ENABLE + FORCE RLS",
    );
    check(table[0]?.appCrud, "asset_variant grants explicit app_user CRUD");
    check(
      Number(table[0]?.constraints ?? 0) >= 18,
      "asset_variant constraints are installed and validated",
    );

    await owner.workspace.createMany({
      data: [
        { id: wsA, name: "MF0-A verify A" },
        { id: wsB, name: "MF0-A verify B" },
      ],
    });
    await owner.site.createMany({
      data: [
        {
          id: siteA,
          workspaceId: wsA,
          name: "MF0-A Site A",
          slug: `mf0-a-${randomUUID()}`,
          intake: {},
        },
        {
          id: siteA2,
          workspaceId: wsA,
          name: "MF0-A Site A2",
          slug: `mf0-a2-${randomUUID()}`,
          intake: {},
        },
        {
          id: siteB,
          workspaceId: wsB,
          name: "MF0-A Site B",
          slug: `mf0-b-${randomUUID()}`,
          intake: {},
        },
      ],
    });
    await owner.asset.createMany({
      data: [
        {
          id: assetA,
          workspaceId: wsA,
          siteId: siteA,
          kind: "product_image",
          filename: "a.jpg",
          mime: "image/jpeg",
          sizeBytes: 10,
          objectKey: `ws/${wsA}/${siteA}/product_image/${"a".repeat(64)}.jpg`,
          contentHash: "a".repeat(64),
          processingStatus: "ready",
        },
        {
          id: assetA2,
          workspaceId: wsA,
          siteId: siteA,
          kind: "product_image",
          filename: "a2.jpg",
          mime: "image/jpeg",
          sizeBytes: 11,
          objectKey: `ws/${wsA}/${siteA}/product_image/${"c".repeat(64)}.jpg`,
          contentHash: "c".repeat(64),
          processingStatus: "ready",
        },
        {
          id: assetB,
          workspaceId: wsB,
          siteId: siteB,
          kind: "product_image",
          filename: "b.jpg",
          mime: "image/jpeg",
          sizeBytes: 12,
          objectKey: `ws/${wsB}/${siteB}/product_image/${"d".repeat(64)}.jpg`,
          contentHash: "d".repeat(64),
          processingStatus: "ready",
        },
      ],
    });

    const source = await app.withWorkspace(wsA, (tx) =>
      tx.assetVariant.create({ data: readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA }) }),
    );
    await app.withWorkspace(wsA, (tx) =>
      tx.assetVariant.create({
        data: readyVariant({
          workspaceId: wsA,
          siteId: siteA,
          assetId: assetA,
          sourceVariantId: source.id,
        }),
      }),
    );
    check(
      (await app.withWorkspace(wsA, (tx) => tx.assetVariant.count())) === 2,
      "workspace A can create and read its variants, including same-Asset provenance",
    );
    check(
      (await app.withWorkspace(wsB, (tx) => tx.assetVariant.count())) === 0,
      "workspace B cannot read workspace A variants",
    );
    check(
      (await app.assetVariant.count()) === 0,
      "unset workspace context sees zero variants",
    );
    check(
      (
        await app.withWorkspace(wsB, (tx) =>
          tx.assetVariant.updateMany({
            where: { id: source.id },
            data: { metadata: { forged: true } },
          }),
        )
      ).count === 0,
      "workspace B cannot update workspace A variants",
    );

    await rejects("cross-workspace parent provenance is rejected", () =>
      app.withWorkspace(wsB, (tx) =>
        tx.assetVariant.create({
          data: readyVariant({
            workspaceId: wsB,
            siteId: siteB,
            assetId: assetA,
          }),
        }),
      ),
    );
    await rejects("cross-site parent provenance is rejected", () =>
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: readyVariant({
            workspaceId: wsA,
            siteId: siteA2,
            assetId: assetA,
          }),
        }),
      ),
    );
    await rejects("sourceVariant cannot cross Asset scope", () =>
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: readyVariant({
            workspaceId: wsA,
            siteId: siteA,
            assetId: assetA2,
            sourceVariantId: source.id,
          }),
        }),
      ),
    );

    await rejects("invalid recipe hash is rejected", () =>
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: {
            ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA }),
            recipeHash: "not-a-sha256",
          },
        }),
      ),
    );
    await rejects("zero image width is rejected", () =>
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: {
            ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA }),
            width: 0,
          },
        }),
      ),
    );
    await rejects("unknown materialization status is rejected", () =>
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: {
            ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA }),
            status: "published",
          },
        }),
      ),
    );
    await rejects("staging object keys are rejected for publishable variants", () =>
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: readyVariant({
            workspaceId: wsA,
            siteId: siteA,
            assetId: assetA,
            objectKey: `ws/${wsA}/${siteA}/uploads/${randomUUID()}`,
          }),
        }),
      ),
    );
    await rejects("ready rows require checksum and byte size", () =>
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: {
            ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA }),
            contentHash: null,
            sizeBytes: null,
          },
        }),
      ),
    );

    const concurrentRecipe = "f".repeat(64);
    const concurrent = await Promise.allSettled([
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: readyVariant({
            workspaceId: wsA,
            siteId: siteA,
            assetId: assetA2,
            recipeHash: concurrentRecipe,
          }),
        }),
      ),
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: readyVariant({
            workspaceId: wsA,
            siteId: siteA,
            assetId: assetA2,
            recipeHash: concurrentRecipe,
          }),
        }),
      ),
    ]);
    check(
      concurrent.filter((result) => result.status === "fulfilled").length === 1 &&
        concurrent.filter((result) => result.status === "rejected").length === 1,
      "concurrent identical recipes materialize exactly one row",
    );
    check(
      (
        await app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.count({
            where: { assetId: assetA2, recipeHash: concurrentRecipe },
          }),
        )
      ) === 1,
      "recipe uniqueness persists exactly one authoritative row",
    );
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await owner.site.deleteMany({ where: { id: { in: [siteA, siteA2, siteB] } } });
      await owner.workspace.deleteMany({ where: { id: { in: [wsA, wsB] } } });
      const residue = await owner.assetVariant.count({
        where: { workspaceId: { in: [wsA, wsB] } },
      });
      check(residue === 0, "verifier leaves no AssetVariant fixture residue");
    } catch (error) {
      cleanupErrors.push(error);
    }
    await Promise.allSettled([owner.$disconnect(), app.$disconnect()]);
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(
        cleanupErrors,
        "MF0-A verifier cleanup failed",
      );
      failure = failure
        ? new AggregateError([failure, cleanupFailure], "verification and cleanup failed")
        : cleanupFailure;
    }
  }

  if (failure) throw failure;
  console.log(
    JSON.stringify({
      ok: true,
      environment: "ubuntu-development",
      checks,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
