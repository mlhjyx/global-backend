import "dotenv/config";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../src/prisma/prisma.service";
import { SiteBuildCostLedger } from "../src/site-builder/site-build-cost-ledger";
import { createSiteBuilderActivities } from "../src/temporal/site-builder.activities";

const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const app = new PrismaService();
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const companyProfileId = randomUUID();
const siteId = randomUUID();
const buildRunId = randomUUID();
const previewDir = await mkdtemp(`${tmpdir()}/m1d-preview-`);

async function main(): Promise<void> {
  assert(process.env.DATABASE_URL, "DATABASE_URL is required");
  assert(process.env.APP_DATABASE_URL, "APP_DATABASE_URL is required");
  await Promise.all([owner.$connect(), app.$connect()]);
  process.env.PREVIEW_DIR = previewDir;
  try {
    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: "M1-d verifier" },
        { id: otherWorkspaceId, name: "M1-d RLS verifier" },
      ],
    });
    await owner.companyProfile.create({
      data: {
        id: companyProfileId,
        workspaceId,
        name: "M1-d verifier company",
      },
    });
    await owner.site.create({
      data: {
        id: siteId,
        workspaceId,
        companyProfileId,
        name: "M1-d verifier site",
        slug: `m1d-${siteId}`,
        intake: {
          company: { nameZh: "验证站", nameEn: "M1-d verifier" },
          industry: "isic-2813",
          products: ["industrial solution"],
          targetMarkets: ["DE"],
          hasWebsite: false,
          businessEmail: "verify@example.invalid",
        },
      },
    });
    await owner.siteBuildRun.create({
      data: {
        id: buildRunId,
        workspaceId,
        siteId,
        kind: "refurbish",
        status: "running",
      },
    });
    const costLedger = new SiteBuildCostLedger(app);
    await costLedger.ensureBudget({
      workspaceId,
      siteId,
      buildRunId,
      capMicrousd: 5_000_000n,
    });
    let gatewayCalls = 0;
    const gateway = {
      generateStructured: async () => {
        gatewayCalls += 1;
        throw new Error("empty snapshot must not call the model");
      },
    };
    const activities = createSiteBuilderActivities({
      prisma: app,
      costLedger,
      gateway: gateway as never,
    });
    const baseInput = {
      workspaceId,
      siteId,
      buildRunId,
      scope: {
        scope: "site" as const,
        options: { locales: ["en", "de-DE"] },
      },
    };
    const copy = await activities.generateCopyBundles(baseInput);
    assert.deepEqual(Object.keys(copy.set.bundles), ["en", "de-DE"]);
    assert.equal(copy.degradedLocales.length, 0);
    assert.equal(gatewayCalls, 0);

    const build = await activities.assembleAndBuild({ ...baseInput, copy });
    await activities.finalizeRefurbish({
      ...baseInput,
      copy,
      kb: { processed: 0, failed: 0, degraded: false },
      profile: { status: "done", gaps: 0 },
      images: { status: "done", processed: 0, failed: 0, variants: 0 },
      build,
    });

    const own = await app.withWorkspace(workspaceId, async (tx) => ({
      snapshots: await tx.sitePublishableClaimSnapshot.count({
        where: { buildRunId },
      }),
      snapshotItems: await tx.sitePublishableClaimSnapshotItem.count({
        where: { snapshot: { buildRunId } },
      }),
      bundles: await tx.siteCopyBundle.findMany({
        where: { buildRunId },
        select: { locale: true, schemaVersion: true },
        orderBy: { locale: "asc" },
      }),
      site: await tx.site.findUniqueOrThrow({
        where: { id: siteId },
        select: { activeVersionId: true },
      }),
    }));
    const isolated = await app.withWorkspace(otherWorkspaceId, (tx) =>
      tx.siteCopyBundle.count({ where: { buildRunId } }),
    );
    assert.equal(own.snapshots, 1);
    assert.equal(own.snapshotItems, 0);
    assert.deepEqual(own.bundles, [
      { locale: "de-DE", schemaVersion: "site-builder-copy-bundle/v1" },
      { locale: "en", schemaVersion: "site-builder-copy-bundle/v1" },
    ]);
    assert.equal(own.site.activeVersionId, build.versionId);
    assert.equal(isolated, 0);
    console.log(
      "M1-d verify OK: empty immutable snapshot, neutral en/de-DE bundles, Astro build, activation recheck, and RLS isolation",
    );
  } finally {
    await owner.site.deleteMany({ where: { id: siteId } });
    await owner.companyProfile.deleteMany({ where: { id: companyProfileId } });
    await owner.workspace.deleteMany({
      where: { id: { in: [workspaceId, otherWorkspaceId] } },
    });
    await Promise.all([app.$disconnect(), owner.$disconnect()]);
    await rm(previewDir, { recursive: true, force: true });
  }
}

await main();
