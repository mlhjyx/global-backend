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
import { buildVariantObjectKey } from "../src/site-builder/object-key";

const checks: string[] = [];
const VERIFIER_WORKSPACE_PREFIX = "__codex_mf0a_verifier__:";
const VERIFIER_ADVISORY_LOCK = "746381726451";

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

async function rejectsDb(
  message: string,
  action: () => Promise<unknown>,
  expected: { codes: readonly string[]; evidence: RegExp },
) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  const shaped = caught as
    | { code?: unknown; message?: unknown; meta?: unknown }
    | undefined;
  const code = typeof shaped?.code === "string" ? shaped.code : "";
  const evidence = `${String(shaped?.message ?? "")} ${JSON.stringify(shaped?.meta ?? {})}`;
  const postgresCode =
    evidence.match(/PostgresError \{ code: "([0-9A-Z]+)"/)?.[1] ?? "";
  const observedCodes = [code, postgresCode].filter(Boolean);
  if (
    !observedCodes.some((observed) => expected.codes.includes(observed)) ||
    !expected.evidence.test(evidence)
  ) {
    throw new Error(
      `unexpected DB rejection for ${message}: codes=${observedCodes.join(",") || "<none>"}; evidence=${evidence}`,
    );
  }
  check(
    true,
    `${message} (${observedCodes.join("/")}, ${expected.evidence.source})`,
  );
}

function readyVariant(input: {
  workspaceId: string;
  siteId: string;
  assetId: string;
  recipeHash?: string;
  objectKey?: string;
  sourceVariantId?: string;
  format?: "avif" | "webp";
}): Prisma.AssetVariantUncheckedCreateInput {
  const recipeHash =
    input.recipeHash ?? randomUUID().replaceAll("-", "").repeat(2);
  const format = input.format ?? "avif";
  return {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    assetId: input.assetId,
    sourceVariantId: input.sourceVariantId,
    variantType: "hero",
    mime: `image/${format}`,
    width: 1440,
    height: 810,
    sizeBytes: 123_456,
    objectKey:
      input.objectKey ??
      buildVariantObjectKey(
        input.workspaceId,
        input.siteId,
        input.assetId,
        recipeHash,
        format,
      ),
    contentHash: "b".repeat(64),
    pipelineVersion: "sharp-v1",
    recipeHash,
    status: "ready",
  };
}

function singleConnectionUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.set("connection_limit", "1");
  return url.toString();
}

async function cleanupVerifierWorkspaces(
  owner: PrismaClient,
  workspaceIds: readonly string[],
): Promise<void> {
  if (workspaceIds.length === 0) return;
  await owner.assetVariant.deleteMany({
    where: {
      workspaceId: { in: [...workspaceIds] },
      sourceVariantId: { not: null },
    },
  });
  await owner.assetVariant.deleteMany({
    where: { workspaceId: { in: [...workspaceIds] } },
  });
  await owner.site.deleteMany({
    where: { workspaceId: { in: [...workspaceIds] } },
  });
  await owner.workspace.deleteMany({
    where: { id: { in: [...workspaceIds] } },
  });
}

async function cleanupAbandonedVerifierFixtures(owner: PrismaClient): Promise<void> {
  const abandoned = await owner.workspace.findMany({
    where: { name: { startsWith: VERIFIER_WORKSPACE_PREFIX } },
    select: { id: true },
  });
  await cleanupVerifierWorkspaces(
    owner,
    abandoned.map(({ id }) => id),
  );
  check(
    true,
    `startup sweep removed ${abandoned.length} abandoned verifier workspace(s)`,
  );
}

async function main(): Promise<void> {
  requireDevelopmentDatabase();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const lock = new PrismaClient({
    datasourceUrl: singleConnectionUrl(process.env.DATABASE_URL!),
  });
  const app = new PrismaService();
  const verifierRunId = randomUUID();
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
    await lock.$connect();
    await lock.$executeRawUnsafe(
      `SELECT pg_advisory_lock(${VERIFIER_ADVISORY_LOCK}::bigint)`,
    );
    await Promise.all([owner.$connect(), app.$connect()]);
    await cleanupAbandonedVerifierFixtures(owner);

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
        { id: wsA, name: `${VERIFIER_WORKSPACE_PREFIX}${verifierRunId}:A` },
        { id: wsB, name: `${VERIFIER_WORKSPACE_PREFIX}${verifierRunId}:B` },
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
    const child = await app.withWorkspace(wsA, (tx) =>
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
    const processingSource = await app.withWorkspace(wsA, (tx) =>
      tx.assetVariant.create({
        data: {
          ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA2 }),
          status: "processing",
          contentHash: null,
          sizeBytes: null,
        },
      }),
    );
    const failedSource = await app.withWorkspace(wsA, (tx) =>
      tx.assetVariant.create({
        data: {
          ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA2 }),
          status: "failed",
          contentHash: null,
          sizeBytes: null,
          error: "verifier source failure",
        },
      }),
    );
    for (const [status, nonReadySource] of [
      ["processing", processingSource],
      ["failed", failedSource],
    ] as const) {
      await rejectsDb(
        `${status} source Variant cannot authorize a derivative`,
        () =>
          app.withWorkspace(wsA, (tx) =>
            tx.assetVariant.create({
              data: readyVariant({
                workspaceId: wsA,
                siteId: siteA,
                assetId: assetA2,
                sourceVariantId: nonReadySource.id,
              }),
            }),
          ),
        {
          codes: ["P2004", "23514"],
          evidence:
            /asset_variant_source_ready_check|AssetVariant source must be ready and checksummed/,
        },
      );
    }
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
    check(
      (
        await app.withWorkspace(wsB, (tx) =>
          tx.assetVariant.deleteMany({ where: { id: source.id } }),
        )
      ).count === 0,
      "workspace B cannot delete workspace A variants",
    );
    check(
      (
        await app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.updateMany({
            where: { id: source.id },
            data: { metadata: { verified: true } },
          }),
        )
      ).count === 1,
      "workspace A can update mutable metadata on its variant",
    );

    await rejectsDb(
      "RLS WITH CHECK rejects an A row forged inside B context",
      () =>
        app.withWorkspace(wsB, (tx) =>
          tx.assetVariant.create({
            data: readyVariant({
              workspaceId: wsA,
              siteId: siteA,
              assetId: assetA,
            }),
          }),
        ),
      { codes: ["42501"], evidence: /row-level security/i },
    );

    await rejectsDb(
      "cross-workspace parent provenance is rejected",
      () =>
        app.withWorkspace(wsB, (tx) =>
          tx.assetVariant.create({
            data: readyVariant({
              workspaceId: wsB,
              siteId: siteB,
              assetId: assetA,
            }),
          }),
        ),
      { codes: ["P2003", "23503"], evidence: /asset_variant_asset_scope_fkey/ },
    );
    await rejectsDb(
      "cross-site parent provenance is rejected",
      () =>
        app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.create({
            data: readyVariant({
              workspaceId: wsA,
              siteId: siteA2,
              assetId: assetA,
            }),
          }),
        ),
      { codes: ["P2003", "23503"], evidence: /asset_variant_asset_scope_fkey/ },
    );
    await rejectsDb(
      "sourceVariant cannot cross Asset scope",
      () =>
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
      { codes: ["P2003", "23503"], evidence: /asset_variant_source_scope_fkey/ },
    );

    await rejectsDb(
      "invalid recipe hash is rejected",
      () =>
        app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.create({
            data: {
              ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA }),
              recipeHash: "not-a-sha256",
            },
          }),
        ),
      {
        codes: ["P2004", "23514"],
        evidence: /asset_variant_(recipe_hash|object_key_scope)_check/,
      },
    );
    await rejectsDb(
      "zero image width is rejected",
      () =>
        app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.create({
            data: {
              ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA }),
              width: 0,
            },
          }),
        ),
      {
        codes: ["P2004", "23514"],
        evidence: /asset_variant_(width|ready_image_dimensions)_check/,
      },
    );
    await rejectsDb(
      "ready image dimensions cannot be null",
      () =>
        app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.create({
            data: {
              ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA }),
              width: null,
              height: null,
            },
          }),
        ),
      {
        codes: ["P2004", "23514"],
        evidence: /asset_variant_ready_image_dimensions_check/,
      },
    );
    await rejectsDb(
      "unknown materialization status is rejected",
      () =>
        app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.create({
            data: {
              ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA }),
              status: "published",
            },
          }),
        ),
      {
        codes: ["P2004", "23514"],
        evidence: /asset_variant_(status|state_payload)_check/,
      },
    );
    for (const [label, objectKey] of [
      ["staging", `ws/${wsA}/${siteA}/uploads/${randomUUID()}`],
      [
        "original Asset collision",
        `ws/${wsA}/${siteA}/product_image/${"a".repeat(64)}.jpg`,
      ],
    ] as const) {
      await rejectsDb(
        `${label} object key is rejected for a Variant`,
        () =>
          app.withWorkspace(wsA, (tx) =>
            tx.assetVariant.create({
              data: readyVariant({
                workspaceId: wsA,
                siteId: siteA,
                assetId: assetA,
                objectKey,
              }),
            }),
          ),
        {
          codes: ["P2004", "23514"],
          evidence: /asset_variant_object_key_scope_check/,
        },
      );
    }
    {
      const recipeHash = "9".repeat(64);
      await rejectsDb(
        "Variant object-key extension must match its MIME",
        () =>
          app.withWorkspace(wsA, (tx) =>
            tx.assetVariant.create({
              data: readyVariant({
                workspaceId: wsA,
                siteId: siteA,
                assetId: assetA,
                recipeHash,
                objectKey: `ws/${wsA}/${siteA}/variants/${assetA}/${recipeHash}.webp`,
              }),
            }),
          ),
        {
          codes: ["P2004", "23514"],
          evidence: /asset_variant_object_key_scope_check/,
        },
      );
    }
    await rejectsDb(
      "ready rows require checksum and byte size",
      () =>
        app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.create({
            data: {
              ...readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA }),
              contentHash: null,
              sizeBytes: null,
            },
          }),
        ),
      {
        codes: ["P2004", "23514"],
        evidence: /asset_variant_state_payload_check/,
      },
    );

    await rejectsDb(
      "source Variant deletion is NO ACTION while a descendant exists",
      () =>
        app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.delete({ where: { id: source.id } }),
        ),
      { codes: ["P2003", "23503"], evidence: /asset_variant_source_scope_fkey/ },
    );
    check(
      (await app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.count({ where: { id: child.id } }),
      )) === 1,
      "failed source deletion preserves descendant ledger",
    );
    await rejectsDb(
      "Variant provenance cannot be reparented after insert",
      () =>
        app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.update({
            where: { id: source.id },
            data: { assetId: assetA2 },
          }),
        ),
      {
        codes: ["P2004", "23514"],
        evidence:
          /asset_variant_provenance_immutable|AssetVariant provenance is immutable/,
      },
    );
    await rejectsDb(
      "Variant surrogate identity cannot be rewritten after insert",
      () =>
        app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.update({
            where: { id: source.id },
            data: { id: randomUUID() },
          }),
        ),
      {
        codes: ["P2004", "23514"],
        evidence:
          /asset_variant_ledger_identity_immutable|AssetVariant ledger identity is immutable/,
      },
    );
    await rejectsDb(
      "Variant creation timestamp cannot be rewritten after insert",
      () =>
        app.withWorkspace(wsA, (tx) =>
          tx.assetVariant.update({
            where: { id: source.id },
            data: { createdAt: new Date("2000-01-01T00:00:00.000Z") },
          }),
        ),
      {
        codes: ["P2004", "23514"],
        evidence:
          /asset_variant_ledger_identity_immutable|AssetVariant ledger identity is immutable/,
      },
    );

    const disposable = await app.withWorkspace(wsA, (tx) =>
      tx.assetVariant.create({
        data: readyVariant({ workspaceId: wsA, siteId: siteA, assetId: assetA2 }),
      }),
    );
    await app.withWorkspace(wsA, (tx) =>
      tx.assetVariant.delete({ where: { id: disposable.id } }),
    );
    check(
      (await app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.count({ where: { id: disposable.id } }),
      )) === 0,
      "workspace A can explicitly delete its unreferenced leaf Variant",
    );

    const concurrentRecipe = "f".repeat(64);
    const concurrentAvif = readyVariant({
      workspaceId: wsA,
      siteId: siteA,
      assetId: assetA2,
      recipeHash: concurrentRecipe,
      format: "avif",
    });
    const concurrentWebp = readyVariant({
      workspaceId: wsA,
      siteId: siteA,
      assetId: assetA2,
      recipeHash: concurrentRecipe,
      format: "webp",
    });
    check(
      concurrentAvif.objectKey !== concurrentWebp.objectKey,
      "concurrent recipe probe uses distinct object keys to isolate recipe uniqueness",
    );
    const concurrent = await Promise.allSettled([
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: concurrentAvif,
        }),
      ),
      app.withWorkspace(wsA, (tx) =>
        tx.assetVariant.create({
          data: concurrentWebp,
        }),
      ),
    ]);
    check(
      concurrent.filter((result) => result.status === "fulfilled").length === 1 &&
        concurrent.filter((result) => result.status === "rejected").length === 1,
      "concurrent identical recipes materialize exactly one row",
    );
    const concurrentRejection = concurrent.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    const concurrentError = concurrentRejection?.reason as
      | { code?: unknown; message?: unknown; meta?: unknown }
      | undefined;
    const concurrentEvidence = `${String(concurrentError?.message ?? "")} ${JSON.stringify(concurrentError?.meta ?? {})}`;
    check(
      concurrentError?.code === "P2002" &&
        /Unique constraint failed/.test(concurrentEvidence),
      "concurrent recipe loser returns Prisma unique-conflict P2002",
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
      await cleanupVerifierWorkspaces(owner, [wsA, wsB]);
      const residue = await Promise.all([
        owner.assetVariant.count({ where: { workspaceId: { in: [wsA, wsB] } } }),
        owner.asset.count({ where: { workspaceId: { in: [wsA, wsB] } } }),
        owner.site.count({ where: { workspaceId: { in: [wsA, wsB] } } }),
        owner.workspace.count({ where: { id: { in: [wsA, wsB] } } }),
      ]);
      check(
        residue.every((count) => count === 0),
        "verifier leaves no workspace/site/Asset/Variant fixture residue",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    await Promise.allSettled([
      owner.$disconnect(),
      app.$disconnect(),
      lock.$disconnect(),
    ]);
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
