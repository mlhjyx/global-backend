import "dotenv/config";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { PrismaService } from "../src/prisma/prisma.service";
import { AiTraceSink } from "../src/model-gateway/ai-trace.sink";
import { ModelProviderRegistry } from "../src/model-gateway/model-provider.registry";
import { ModelRouter } from "../src/model-gateway/model-router";
import { buildGatewayProvider } from "../src/model-gateway/model-providers.config";
import { RouterModelGateway } from "../src/model-gateway/router-model-gateway";
import { SiteBuildCostLedger } from "../src/site-builder/site-build-cost-ledger";
import {
  SiteReleaseService,
  resolveSiteRendererBuildIdentity,
} from "../src/site-builder/site-release.service";
import { StorageService } from "../src/site-builder/storage.service";
import { createSiteBuilderActivities } from "../src/temporal/site-builder.activities";
import { previewRoot } from "../src/temporal/site-builder.activities";

function guard(): void {
  assert.equal(process.env.ALLOW_DEV_DB_VERIFIER, "true");
  assert.notEqual(process.env.NODE_ENV, "production");
  for (const name of ["DATABASE_URL", "APP_DATABASE_URL"]) {
    const url = new URL(process.env[name] ?? "");
    assert(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/global_dev");
  }
  assert(process.env.MODEL_GATEWAY_URL);
  assert(process.env.MODEL_GATEWAY_KEY);
  assert(process.env.S3_ACCESS_KEY);
}

guard();
const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const app = new PrismaService();
const storage = new StorageService();
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const companyProfileId = randomUUID();
const siteId = randomUUID();
const buildRunId = randomUUID();
const slug = `m1eb-${siteId}`;
const taskQueue = `m1eb-verify-${randomUUID()}`;
let nativeConnection: NativeConnection | undefined;
let clientConnection: Connection | undefined;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;
let artifactPrefix: string | undefined;

try {
  await Promise.all([owner.$connect(), app.$connect()]);
  await storage.onModuleInit();
  const gatewayUrl = process.env.MODEL_GATEWAY_URL!.replace(/\/$/, "");
  const models = await fetch(`${gatewayUrl}/models`, {
    headers: { authorization: `Bearer ${process.env.MODEL_GATEWAY_KEY}` },
  });
  assert.equal(models.ok, true, `new-api /models returned ${models.status}`);

  await owner.workspace.createMany({
    data: [
      { id: workspaceId, name: "__m1eb_verify__" },
      { id: otherWorkspaceId, name: "__m1eb_verify_rls__" },
    ],
  });
  await owner.companyProfile.create({
    data: {
      id: companyProfileId,
      workspaceId,
      name: "M1-e-B OEM verifier",
      industry: "custom OEM fabrication",
    },
  });
  await owner.site.create({
    data: {
      id: siteId,
      workspaceId,
      companyProfileId,
      name: "M1-e-B OEM verifier",
      slug,
      locales: ["en"],
      intake: {
        company: { nameEn: "M1-e-B OEM verifier" },
        industry: "custom OEM fabrication",
        products: ["industrial modules"],
        targetMarkets: ["DE"],
        hasWebsite: false,
        businessEmail: "m1eb-verifier@example.invalid",
      },
    },
  });
  await owner.siteBuildRun.create({
    data: {
      id: buildRunId,
      workspaceId,
      siteId,
      kind: "refurbish",
      status: "queued",
      scope: { scope: "site" },
    },
  });

  const costLedger = new SiteBuildCostLedger(app);
  await costLedger.ensureBudget({
    workspaceId,
    siteId,
    buildRunId,
    capMicrousd: 50_000_000n,
  });
  const registry = new ModelProviderRegistry();
  const provider = buildGatewayProvider();
  assert(provider, "new-api provider is not configured");
  registry.register(provider);
  const gateway = new RouterModelGateway(
    new ModelRouter(registry),
    new AiTraceSink(app),
  );
  gateway.paidLedger = costLedger;
  let gatewayCalls = 0;
  const meteredGateway = new Proxy(gateway, {
    get(target, property, receiver) {
      if (property !== "generateStructured") {
        return Reflect.get(target, property, receiver);
      }
      return (...args: Parameters<typeof gateway.generateStructured>) => {
        gatewayCalls += 1;
        return target.generateStructured(...args);
      };
    },
  });
  const rendererBuildIdentity = resolveSiteRendererBuildIdentity();
  const releaseService = new SiteReleaseService(app, storage, {
    buildIdentity: rendererBuildIdentity,
  });
  nativeConnection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  });
  worker = await Worker.create({
    connection: nativeConnection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue,
    workflowsPath: fileURLToPath(
      new URL("../src/temporal/workflows.ts", import.meta.url),
    ),
    activities: createSiteBuilderActivities({
      prisma: app,
      costLedger,
      gateway: meteredGateway,
      releaseService,
      storage,
      rendererBuildIdentity,
      imagePipeline: {
        listSiteImageIds: async () => [],
        processSiteImages: async () =>
          ({ processed: 0, failed: 0, skipped: 0 }) as never,
      },
      kb: {
        ingestText: async () => ({}) as never,
        processAsset: async () => ({ outcome: "not_due" }) as never,
        processQueued: async () => ({ processed: 0, failed: 0 }),
        digestSources: async () => [],
      },
    }),
  });
  workerRun = worker.run();
  clientConnection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  });
  const client = new Client({
    connection: clientConnection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  });
  const handle = await client.workflow.start("refurbishWorkflow", {
    taskQueue,
    workflowId: `site-refurbish-${buildRunId}`,
    args: [{ workspaceId, siteId, buildRunId, scope: { scope: "site" } }],
  });
  await handle.result();

  const result = await app.withWorkspace(workspaceId, async (tx) => {
    const run = await tx.siteBuildRun.findUniqueOrThrow({
      where: { id: buildRunId },
    });
    const site = await tx.site.findUniqueOrThrow({ where: { id: siteId } });
    const version = await tx.siteVersion.findUniqueOrThrow({
      where: { id: site.activeVersionId! },
      include: { release: true },
    });
    const steps = await tx.siteBuildStep.findMany({
      where: { buildRunId },
      orderBy: [{ progress: "asc" }, { key: "asc" }],
    });
    return { run, site, version, steps };
  });
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.progress, 1);
  assert.equal(result.version.specVersion, "1.1.0");
  assert.equal(result.version.release?.status, "ready");
  assert.equal(
    (result.version.release?.manifest as { schemaVersion?: string })
      .schemaVersion,
    "site-builder-release-manifest/v2",
  );
  assert.equal(
    result.steps.find(({ key }) => key === "design_spec")?.status,
    "done",
  );
  assert.equal(
    result.steps.find(({ key }) => key === "quality_loop")?.status,
    "skipped",
  );
  assert(gatewayCalls > 0, "controlled workflow did not reach new-api gateway");
  artifactPrefix = result.version.release?.artifactPrefix;
  assert(artifactPrefix);
  assert(
    await storage.head(
      `${artifactPrefix}/attempts/${result.version.release!.producerToken}/release-manifest.json`,
    ),
    "ReleaseManifest v2 is absent from MinIO",
  );
  const isolated = await app.withWorkspace(otherWorkspaceId, (tx) =>
    tx.siteVersion.count({ where: { siteId } }),
  );
  assert.equal(isolated, 0);
  console.log(
    "M1-e-B verify OK: real Temporal, PostgreSQL/RLS, new-api, Astro, MinIO and SiteRelease v2",
  );
} finally {
  if (worker) await worker.shutdown();
  await workerRun?.catch(() => undefined);
  await clientConnection?.close();
  await nativeConnection?.close();
  if (artifactPrefix) {
    await storage.deletePrefix(`${artifactPrefix}/`).catch(() => undefined);
  }
  await owner.site
    .update({
      where: { id: siteId },
      data: { activeVersionId: null },
    })
    .catch(() => undefined);
  await owner.siteRelease.deleteMany({ where: { siteId } });
  await owner.site.deleteMany({ where: { id: siteId } });
  await owner.companyProfile.deleteMany({ where: { id: companyProfileId } });
  await owner.workspace.deleteMany({
    where: { id: { in: [workspaceId, otherWorkspaceId] } },
  });
  await Promise.all([app.$disconnect(), owner.$disconnect()]);
  await rm(path.join(previewRoot(), slug), {
    recursive: true,
    force: true,
  });
}
