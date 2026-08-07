import "reflect-metadata";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { NativeConnection, Worker } from "@temporalio/worker";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ModelProviderRegistry } from "../model-gateway/model-provider.registry";
import { ModelRouter } from "../model-gateway/model-router";
import { RouterModelGateway } from "../model-gateway/router-model-gateway";
import { StubModelProvider } from "../model-gateway/providers/stub-model.provider";
import {
  buildGatewayProvider,
  stubAllowed,
} from "../model-gateway/model-providers.config";
import { AiTraceSink } from "../model-gateway/ai-trace.sink";
import { createUnderstandingActivities } from "./understanding.activities";
import { createDiscoveryActivities } from "./discovery.activities";
import { createQualifyActivities } from "./qualify.activities";
import { createAcquisitionActivities } from "./acquisition.activities";
import { buildSourceAdapterRegistry } from "../acquisition/registry";
import { createIntentActivities } from "./intent.activities";
import { createBacklogActivities } from "./backlog.activities";
import { createExternalIntentActivities } from "./external-intent.activities";
import { createDeletionActivities } from "./deletion.activities";
import { createPatentsCacheActivities } from "./patents-cache.activities";
import { createSanctionsRefreshActivities } from "./sanctions-refresh.activities";
import { createSiteBuilderActivities } from "./site-builder.activities";
import { createAssetCleanupActivities } from "./asset-cleanup.activities";
import { seedSanctions } from "../sanctions/sanctions-seed";
import { SanctionsScreeningService } from "../sanctions/sanctions-screening.service";
import { KbService } from "../site-builder/kb.service";
import { EmbeddingsClient } from "../site-builder/embeddings.client";
import { DoclingClient } from "../site-builder/docling.client";
import { StorageService } from "../site-builder/storage.service";
import { ImagePipelineService } from "../site-builder/image-pipeline.service";
import { IsolatedImagePipelineRunner } from "../site-builder/image-pipeline-runner";
import { ensurePlatformSchedules } from "./ensure-schedules";
import { seedJurisdictionPolicy } from "../compliance/jurisdiction-policy.seed";
import { Crawl4aiPageFetcher } from "../intent/page-fetcher";
import { DiscoveryProviderRegistry } from "../discovery/provider.registry";
import {
  buildToolBroker,
  sourcePolicyReaderFrom,
} from "../tools/tool-broker.factory";
import { TaxonomyResolver } from "../discovery/taxonomy-resolver";
import { SiteBuildCostLedger } from "../site-builder/site-build-cost-ledger";
import {
  SiteReleaseService,
  resolveSiteRendererBuildIdentity,
} from "../site-builder/site-release.service";
import { createSiteReleaseMaintenanceActivities } from "./site-release-maintenance.activities";
import { StorageQualityArtifactSink } from "../site-builder/quality/quality-artifact-sink";
import { DeterministicQualityService } from "../site-builder/quality/deterministic-quality.service";
import { ClosedRepairService } from "../site-builder/quality/closed-repair.service";
import { QualityCandidateService } from "../site-builder/quality/quality-candidate.service";
import { QualityNarrativeService } from "../site-builder/quality/quality-narrative.service";
import { startLangfuseRuntimeTelemetry } from "../model-runtime";
import {
  parseBoundedIntervalMs,
  resolveWorkerDomains,
  runWorkerFleet,
  type ResolvedWorkerDomain,
} from "./worker-topology";
import {
  RuntimeOpsWriter,
  buildWorkerIdentity,
  type WorkflowRunReceiptInput,
} from "../runtime-ops/runtime-ops.service";

/**
 * Standalone worker process (apps/worker-ai equivalent). Builds the deps it needs
 * directly — no Nest bootstrap — so it never starts HTTP or the relay.
 */
async function main(): Promise<void> {
  const runtimeTelemetry = await startLangfuseRuntimeTelemetry();
  const prisma = new PrismaService();
  await prisma.$connect();
  const costLedger = new SiteBuildCostLedger(prisma);
  const siteBuilderStorage = new StorageService();
  await siteBuilderStorage.onModuleInit();
  const rendererBuildIdentity = resolveSiteRendererBuildIdentity();
  const releaseService = new SiteReleaseService(prisma, siteBuilderStorage, {
    buildIdentity: rendererBuildIdentity,
  });
  const closedRepairService = new ClosedRepairService();
  const qualityCandidateService = new QualityCandidateService(
    prisma,
    new DeterministicQualityService(
      new StorageQualityArtifactSink(siteBuilderStorage),
    ),
    closedRepairService,
    releaseService,
  );
  const qualityNarrativeService = new QualityNarrativeService(
    siteBuilderStorage,
  );
  const imagePipeline = new ImagePipelineService(
    prisma,
    siteBuilderStorage,
    new IsolatedImagePipelineRunner(),
  );

  // owner 连接（DATABASE_URL）：① data_provider seed（平台配置表，app_user 无写权）；
  // ② 跨租户**只读**扫描（列 workspace / ACTIVE ICP——RLS 下 app_user 不可见）。
  // 与 OutboxRelayService 同一「受信系统扫描器」先例；租户数据读写仍走 withWorkspace。
  const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  await ownerDb.$connect();
  const runtimeOps = new RuntimeOpsWriter(ownerDb, buildWorkerIdentity(process.env));

  // seed 双保险：此前只在 API relay 启动时 seed 且失败静默——环境重置后只跑 worker 时，
  // 4 个 signal provider 对路由不可见（信号/富集层运行时 no-op）。失败必须大声。
  const providerRegistrySeed = new DiscoveryProviderRegistry();
  try {
    await providerRegistrySeed.seed(ownerDb);
    console.log("[worker] data_provider seed ok");
  } catch (err) {
    console.error(
      `[worker] data_provider seed FAILED — providers may be invisible to routing (no-op pipeline): ${String(err)}`,
    );
  }

  // 收口⑥：jurisdiction_policy seed（平台规则表，owner 写）。worker 的删除编排/合规判定需之；
  // 失败大声——规则空则 DataRights 对 red 数据 fail-closed。
  try {
    const n = await seedJurisdictionPolicy(ownerDb);
    console.log(`[worker] jurisdiction_policy seed ok (${n} rules)`);
  } catch (err) {
    console.error(
      `[worker] jurisdiction_policy seed FAILED — DataRights fail-closed for red data: ${String(err)}`,
    );
  }

  // 制裁名单源 + source_policy seed（第五门，owner 写平台表；全 DISABLED，真测绿后 ops 翻 ENABLED）。
  try {
    await seedSanctions(ownerDb);
    console.log(
      "[worker] sanctions source/policy seed ok (DISABLED until ops enables)",
    );
  } catch (err) {
    console.error(
      `[worker] sanctions seed FAILED — refresh/screening may be misconfigured: ${String(err)}`,
    );
  }

  // Schedule 自愈：dev Temporal（start-dev/SQLite）重置即丢 Schedule，靠人手跑脚本必然遗忘。
  try {
    await ensurePlatformSchedules({
      append: (receipt) => runtimeOps.appendScheduleDriftReceipt(receipt),
    });
  } catch (err) {
    console.error(
      `[worker] ensure schedules FAILED（定时 sweep 可能停摆，可手跑 scripts/ensure-*-schedule.mts）: ${String(err)}`,
    );
  }

  const registry = new ModelProviderRegistry();
  const gatewayProvider = buildGatewayProvider();
  if (gatewayProvider) registry.register(gatewayProvider);
  if (stubAllowed()) registry.register(new StubModelProvider());
  const gateway = new RouterModelGateway(
    new ModelRouter(registry),
    new AiTraceSink(prisma),
  );
  gateway.paidLedger = costLedger;

  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  });

  // 收口②：**唯一执行闸门**——全部原始出网（搜索/抓取/结构化 API/SMTP）经同一个 ToolBroker
  // （allowedTools 白名单 + source_policy fail-closed + 预算 reserve-settle + 限流 + Trace）。
  const sourcePolicyReader = sourcePolicyReaderFrom(prisma);
  const broker = buildToolBroker({
    sourcePolicyReader,
    paidLedger: costLedger,
  });
  const taxonomy = new TaxonomyResolver(
    prisma,
    gateway,
    runtimeTelemetry.telemetry,
  ); // discovery + external-intent sweep 共享一实例
  // 第五门制裁筛查引擎（worker 侧）：qualify 活动 screen 公司名 + 刷新活动重建索引。手工构造（非 Nest DI）；
  // 平台表无 RLS、app_user 只读 → prisma 读即可。DISABLED（Phase 1 默认）→ 空索引 → not_screened，no-op。
  const sanctionsScreening = new SanctionsScreeningService(prisma);
  await sanctionsScreening
    .rebuildIndex()
    .catch((err) =>
      console.error(
        `[worker] sanctions index build FAILED (fail-open, gate=not_screened): ${String(err)}`,
      ),
    );
  // prisma（app_user）给专利缓存读/enqueue 闭包（平台表无 RLS）——PATENT_SOURCE_MODE=cache 时零 BQ 字节读缓存。
  const providers = new DiscoveryProviderRegistry({
    gateway,
    broker,
    prisma,
    runtimeTelemetry: runtimeTelemetry.telemetry,
  });

  const receiptActivities = {
    recordWorkflowRunReceipt: (input: WorkflowRunReceiptInput) =>
      runtimeOps.appendWorkflowReceipt(input),
  };
  const acquisitionActivities = {
    ...createUnderstandingActivities({
      prisma,
      gateway,
      broker,
      runtimeTelemetry: runtimeTelemetry.telemetry,
    }),
    ...createDiscoveryActivities({
      prisma,
      providers,
      gateway,
      taxonomy,
      broker,
      runtimeTelemetry: runtimeTelemetry.telemetry,
    }),
    ...createQualifyActivities({ prisma, sanctionsScreening }),
    ...createAcquisitionActivities({
      prisma,
      registry: buildSourceAdapterRegistry(broker),
    }),
    ...createIntentActivities({
      prisma,
      fetcher: new Crawl4aiPageFetcher(broker),
      ownerDb,
      broker,
    }),
    ...createBacklogActivities({
      prisma,
      providers,
      gateway,
      ownerDb,
      broker,
      runtimeTelemetry: runtimeTelemetry.telemetry,
    }),
    ...createExternalIntentActivities({ prisma, taxonomy, ownerDb, broker }),
    ...receiptActivities,
  };
  const maintenanceActivities = {
    ...createDeletionActivities({ prisma }),
    ...createPatentsCacheActivities({ ownerDb }),
    ...createSanctionsRefreshActivities({
      ownerDb,
      broker,
      sanctionsScreening,
    }),
    ...createAssetCleanupActivities({ prisma, storage: siteBuilderStorage }),
    ...createSiteReleaseMaintenanceActivities({
      ownerDb,
      storage: siteBuilderStorage,
    }),
    ...receiptActivities,
  };
  const siteBuilderActivities = {
    ...createSiteBuilderActivities({
      prisma,
      costLedger,
      ownerDb,
      gateway,
      runtimeTelemetry: runtimeTelemetry.telemetry,
      broker,
      imagePipeline,
      releaseService,
      qualityCandidateService,
      qualityNarrativeService,
      closedRepairService,
      storage: siteBuilderStorage,
      rendererBuildIdentity,
      kb: new KbService(
        prisma,
        new EmbeddingsClient(),
        new DoclingClient(),
        siteBuilderStorage,
      ),
    }),
    ...receiptActivities,
  };
  const allActivities = {
    ...acquisitionActivities,
    ...siteBuilderActivities,
    ...maintenanceActivities,
  };
  const activitiesByDomain: Record<ResolvedWorkerDomain["domain"], object> = {
    legacy: allActivities,
    acquisition: acquisitionActivities,
    "site-builder": siteBuilderActivities,
    maintenance: maintenanceActivities,
  };
  const domains = resolveWorkerDomains(process.env);
  const workers = await Promise.all(
    domains.map((domain) =>
      Worker.create({
        connection,
        namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
        taskQueue: domain.taskQueue,
        workflowsPath: require.resolve("./workflows"),
        activities: activitiesByDomain[domain.domain],
        maxConcurrentActivityTaskExecutions: domain.activityConcurrency,
        maxConcurrentWorkflowTaskExecutions: domain.workflowConcurrency,
        interceptors: {
          workflowModules: [
            require.resolve("./workflow-run-receipt.interceptor"),
          ],
        },
      }),
    ),
  );

  const workerInstanceId = randomUUID();
  const heartbeatIntervalMs = parseBoundedIntervalMs(
    process.env.WORKER_HEARTBEAT_INTERVAL_MS,
    "WORKER_HEARTBEAT_INTERVAL_MS",
    15_000,
    5_000,
    60_000,
  );
  const scheduleObservationIntervalMs = parseBoundedIntervalMs(
    process.env.SCHEDULE_OBSERVATION_INTERVAL_MS,
    "SCHEDULE_OBSERVATION_INTERVAL_MS",
    5 * 60_000,
    60_000,
    60 * 60_000,
  );
  const heartbeat = (status: "POLLING" | "STOPPING") =>
    Promise.all(
      domains.map((domain) =>
        runtimeOps.recordWorkerHeartbeat({
          workerInstanceId,
          taskQueue: domain.taskQueue,
          status,
          observedAt: new Date(),
          activityConcurrency: domain.activityConcurrency,
          workflowConcurrency: domain.workflowConcurrency,
        }),
      ),
    ).then(() => undefined);
  await heartbeat("POLLING");
  let heartbeatInFlight = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void heartbeat("POLLING")
      .catch(() => console.error("[worker] heartbeat failed"))
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, heartbeatIntervalMs);
  let scheduleObservation: Promise<void> | null = null;
  const scheduleObservationTimer = setInterval(() => {
    if (scheduleObservation !== null) return;
    scheduleObservation = ensurePlatformSchedules({
      append: (receipt) => runtimeOps.appendScheduleDriftReceipt(receipt),
    })
      .catch(() => {
        console.error("[worker] schedule observation failed");
      })
      .finally(() => {
        scheduleObservation = null;
      });
  }, scheduleObservationIntervalMs);

  console.log(
    `[worker] polling task queues: ${domains.map((domain) => domain.taskQueue).join(", ")}`,
  );
  try {
    await runWorkerFleet(workers);
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(scheduleObservationTimer);
    await scheduleObservation;
    await heartbeat("STOPPING").catch(() =>
      console.error("[worker] final heartbeat failed"),
    );
    await runtimeTelemetry.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
