import "reflect-metadata";
import "dotenv/config";
import { resolve } from "node:path";
import { Runtime, Worker } from "@temporalio/worker";
import { workerIdentity } from "./worker-composition";
import { createRuntimeMachineTokenClient } from "../platform-authority/machine-token-runtime";
import {
  bindNativeMachineCredential,
  connectNativeMachine,
} from "./native-machine-connection";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ModelProviderRegistry } from "../model-gateway/model-provider.registry";
import { ModelRouter } from "../model-gateway/model-router";
import { RouterModelGateway } from "../model-gateway/router-model-gateway";
import { buildGatewayProvider } from "../model-gateway/model-providers.config";
import { AiTraceSink } from "../model-gateway/ai-trace.sink";
import { createUnderstandingActivities } from "./understanding.activities";
import { createDiscoveryActivities } from "./discovery.activities";
import { createRawSourceActivities } from "./raw-source.activities";
import { createQualifyActivities } from "./qualify.activities";
import { createBacklogActivities } from "./backlog.activities";
import { createExternalIntentActivities } from "./external-intent.activities";
import { createDeletionActivities } from "./deletion.activities";
import { createPersonalArtifactCleanupActivities } from "./personal-artifact-cleanup.activities";
import { PersonalArtifactCleanupService } from "../durable-results/artifact/personal-artifact-cleanup.contract";
import {
  personalArtifactCleanupPersistence,
  PrismaPersonalArtifactCleanupCommandRepository,
} from "../durable-results/artifact/personal-artifact-cleanup.repository";
import { createPersonalArtifactCleanupRuntime } from "../durable-results/artifact/personal-artifact-cleanup.runtime";
import { createSiteBuilderActivities } from "./site-builder.activities";
import {
  costReconciliationCatalogCoversRoutes,
  createSiteBuildCostReconciliationCatalogFromEnv,
  createSiteBuildSettlementReadbackRuntimeFromEnv,
} from "../site-builder/site-build-cost-reconciliation-resolver";
import {
  resolveTaskRoute,
  SITE_BUILDER_GENERATIVE_TASK_IDS,
} from "../site-builder/agents/task-routes";
import { createAssetCleanupActivities } from "./asset-cleanup.activities";
import { seedSanctions } from "../sanctions/sanctions-seed";
import { SanctionsScreeningService } from "../sanctions/sanctions-screening.service";
import { KbService } from "../site-builder/kb.service";
import { EmbeddingsClient } from "../site-builder/embeddings.client";
import { DoclingClient } from "../site-builder/docling.client";
import { StorageService } from "../site-builder/storage.service";
import { ImagePipelineService } from "../site-builder/image-pipeline.service";
import { IsolatedImagePipelineRunner } from "../site-builder/image-pipeline-runner";
import { seedJurisdictionPolicy } from "../compliance/jurisdiction-policy.seed";
import { DiscoveryProviderRegistry } from "../discovery/provider.registry";
import {
  buildToolBroker,
  sourcePolicyReaderFrom,
} from "../tools/tool-broker.factory";
import { TaxonomyResolver } from "../discovery/taxonomy-resolver";
import { UNDERSTANDING_TASK_QUEUE } from "./understanding.constants";
import { SiteBuildCostLedger } from "../site-builder/site-build-cost-ledger";
import { createSiteBuildProviderWireDatabaseFromEnv } from "../site-builder/site-build-provider-wire.database";
import { SiteReleaseService } from "../site-builder/site-release.service";
import { createSiteReleaseMaintenanceActivities } from "./site-release-maintenance.activities";
import { StorageQualityArtifactSink } from "../site-builder/quality/quality-artifact-sink";
import { DeterministicQualityService } from "../site-builder/quality/deterministic-quality.service";
import { ClosedRepairService } from "../site-builder/quality/closed-repair.service";
import { QualityCandidateService } from "../site-builder/quality/quality-candidate.service";
import { QualityNarrativeService } from "../site-builder/quality/quality-narrative.service";
import { startLangfuseRuntimeTelemetry } from "../model-runtime";
import { resolveRuntimeSettings } from "../runtime/runtime-environment";
import { loadRuntimeReleaseIdentity } from "../runtime/runtime-release-identity";
import { inspectRuntimeAdmission } from "../runtime/runtime-admission";
import {
  assertMigrationCompatible,
  PrismaRuntimeProcessLeaseStore,
  RuntimeProcessLeaseService,
} from "../runtime/runtime-process-lease";
import { PostgresBudgetStore } from "../tools/budget-store";
import {
  checkBrowserReadiness,
  checkGenericArtifactStorageReadiness,
  checkImagePipelineIsolationReadiness,
  checkModelGatewayReadiness,
  checkRedisReadiness,
  checkSiteBuildSettlementReadbackReadiness,
  rendererRuntimeIdentity,
} from "../runtime/managed-dependency-readiness";
import {
  createIdempotentWorkerShutdown,
  createWorkerCredentialFailure,
  startWorkerProcessSignalCoordinator,
  startWorkerLeaseHeartbeat,
} from "../runtime/worker-lease-heartbeat";
import { waitForWorkerQueueAdmission } from "../runtime/worker-queue-admission";
import {
  selectWorkerDependencyAdmission,
  waitForWorkerDependencyAdmission,
} from "../runtime/worker-dependency-admission";
import { startWorkerDependencyHeartbeat } from "../runtime/worker-dependency-heartbeat";

const WORKER_NOT_READY_LOG_INTERVAL_MS = 30_000;

async function holdWorkerNotReady(
  code: string,
  leases?: RuntimeProcessLeaseService,
): Promise<never> {
  console.error(
    `[worker] not ready: ${code}; Temporal polling remains disabled`,
  );
  return new Promise<never>(() => {
    setInterval(() => {
      console.error(`[worker] still not ready: ${code}`);
      void leases
        ?.heartbeat("WORKER", "STARTING", UNDERSTANDING_TASK_QUEUE)
        .catch(() => undefined);
    }, WORKER_NOT_READY_LOG_INTERVAL_MS);
  });
}

/**
 * Standalone worker process (apps/worker-ai equivalent). Builds the deps it needs
 * directly — no Nest bootstrap — so it never starts HTTP or the relay.
 */
async function main(): Promise<void> {
  Runtime.install({ shutdownSignals: [] });
  const runtimeSettings = resolveRuntimeSettings(process.env);
  const releaseIdentity = await loadRuntimeReleaseIdentity({
    mode: runtimeSettings.mode,
    artifactRoot: resolve(__dirname, ".."),
    env: process.env,
  });
  const admission = inspectRuntimeAdmission(
    runtimeSettings,
    process.env,
    releaseIdentity,
    "WORKER",
  );
  if (!admission.admitted) {
    const failed = Object.entries(admission.checks)
      .filter(([, check]) => check.status === "failed")
      .map(([name, check]) => `${name}:${check.code ?? "FAILED"}`)
      .join(",");
    await holdWorkerNotReady(failed || "RUNTIME_ADMISSION_FAILED");
  }

  const runtimeTelemetry = await startLangfuseRuntimeTelemetry();
  const prisma = new PrismaService();
  const configuredProviderWireDatabase = (() => {
    try {
      return createSiteBuildProviderWireDatabaseFromEnv(
        process.env,
        undefined,
        releaseIdentity.attested
          ? releaseIdentity.migration_revision
          : undefined,
      );
    } catch {
      return undefined;
    }
  })();
  if (!configuredProviderWireDatabase) {
    await runtimeTelemetry.shutdown();
    return holdWorkerNotReady("SITE_BUILD_PROVIDER_WIRE_DATABASE_UNAVAILABLE");
  }
  const providerWireDatabase = configuredProviderWireDatabase;
  await waitForWorkerDependencyAdmission({
    check: async () => {
      const appDatabaseReadiness = await prisma.reconnect();
      if (appDatabaseReadiness.status !== "ready") {
        return { status: "failed", code: appDatabaseReadiness.code } as const;
      }
      try {
        await assertMigrationCompatible(prisma, releaseIdentity);
        return { status: "ok" } as const;
      } catch {
        return {
          status: "failed",
          code: "MIGRATION_REVISION_MISMATCH",
        } as const;
      }
    },
    onBlocked: (code) =>
      console.error(
        `[worker] not ready: ${code}; Temporal polling remains disabled`,
      ),
  });
  const runtimeLeaseStore = new PrismaRuntimeProcessLeaseStore(prisma, {
    roles: ["WORKER"],
  });
  const runtimeLeases = new RuntimeProcessLeaseService(runtimeLeaseStore, {
    identity: releaseIdentity,
  });
  const controlledSignals = startWorkerProcessSignalCoordinator({
    leases: runtimeLeases,
    taskQueue: UNDERSTANDING_TASK_QUEUE,
    onDrainLeaseFailure: () =>
      console.error(
        "[worker] draining lease unavailable; process exit continues fail-closed",
      ),
    terminalizeUncertainRegistration: () =>
      runtimeLeases.terminalize("WORKER", UNDERSTANDING_TASK_QUEUE),
    onEarlyCleanup: async () => {
      await runtimeTelemetry.shutdown().catch(() => undefined);
      await providerWireDatabase.disconnect().catch(() => undefined);
      await runtimeLeaseStore.disconnectWriters().catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    },
    onEarlyExit: (signal) => {
      process.kill(process.pid, signal);
    },
  });
  try {
    await controlledSignals.registered;
  } catch {
    await runtimeTelemetry.shutdown();
    await holdWorkerNotReady("RUNTIME_PROCESS_LEASE_PUBLISH_UNAVAILABLE");
  }
  const startingHeartbeat = setInterval(() => {
    void runtimeLeases
      .heartbeat("WORKER", "STARTING", UNDERSTANDING_TASK_QUEUE)
      .catch(() => undefined);
  }, 10_000);
  startingHeartbeat.unref();
  await waitForWorkerQueueAdmission({
    leases: runtimeLeases,
    taskQueue: UNDERSTANDING_TASK_QUEUE,
    onBlocked: (code) =>
      console.error(
        `[worker] not ready: ${code}; Temporal polling remains disabled`,
      ),
  });
  await waitForWorkerDependencyAdmission({
    check: () => providerWireDatabase.checkReadiness(),
    onBlocked: (code) =>
      console.error(
        `[worker] not ready: ${code}; Temporal polling remains disabled`,
      ),
  });
  const costLedger = new SiteBuildCostLedger(prisma, {
    providerWireDatabase,
  });
  const siteBuilderStorage = new StorageService();
  await siteBuilderStorage.onModuleInit();
  const dependencyBlocked = (code: string): void =>
    console.error(
      `[worker] not ready: ${code}; Temporal polling remains disabled`,
    );
  await waitForWorkerDependencyAdmission({
    check: () => siteBuilderStorage.checkReadiness(),
    onBlocked: dependencyBlocked,
  });
  await waitForWorkerDependencyAdmission({
    check: () => checkGenericArtifactStorageReadiness(process.env),
    onBlocked: dependencyBlocked,
  });
  await waitForWorkerDependencyAdmission({
    check: () => checkRedisReadiness(process.env),
    onBlocked: dependencyBlocked,
  });
  await waitForWorkerDependencyAdmission({
    check: () => checkModelGatewayReadiness(process.env),
    onBlocked: dependencyBlocked,
  });
  await waitForWorkerDependencyAdmission({
    check: () => checkSiteBuildSettlementReadbackReadiness(process.env),
    onBlocked: dependencyBlocked,
  });
  await waitForWorkerDependencyAdmission({
    check: () => checkBrowserReadiness(process.env),
    onBlocked: dependencyBlocked,
  });
  await waitForWorkerDependencyAdmission({
    check: () => checkImagePipelineIsolationReadiness(),
    onBlocked: dependencyBlocked,
  });
  const personalArtifactCleanupRuntime = await (async () => {
    try {
      return createPersonalArtifactCleanupRuntime(process.env);
    } catch {
      await runtimeTelemetry.shutdown();
      return holdWorkerNotReady(
        "PERSONAL_ARTIFACT_CLEANUP_CONFIG_INVALID",
        runtimeLeases,
      );
    }
  })();
  const personalArtifactCleanupService = new PersonalArtifactCleanupService(
    new PrismaPersonalArtifactCleanupCommandRepository(
      personalArtifactCleanupPersistence(prisma),
    ),
    personalArtifactCleanupRuntime.port,
  );
  await waitForWorkerDependencyAdmission({
    check: () => personalArtifactCleanupRuntime.checkReadiness(),
    onBlocked: dependencyBlocked,
  });
  const rendererBuildIdentity = rendererRuntimeIdentity(releaseIdentity);
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
  const holdPlatformNotReady = async (code: string): Promise<never> => {
    clearInterval(startingHeartbeat);
    personalArtifactCleanupRuntime.destroy();
    await providerWireDatabase.disconnect().catch(() => undefined);
    await ownerDb.$disconnect().catch(() => undefined);
    await runtimeTelemetry.shutdown();
    return holdWorkerNotReady(code, runtimeLeases);
  };
  try {
    await ownerDb.$connect();
  } catch {
    await holdPlatformNotReady("OWNER_DATABASE_UNAVAILABLE");
  }
  const budgetStore = new PostgresBudgetStore(prisma);

  // seed 双保险：此前只在 API relay 启动时 seed 且失败静默——环境重置后只跑 worker 时，
  // 4 个 signal provider 对路由不可见（信号/富集层运行时 no-op）。失败必须大声。
  const providerRegistrySeed = new DiscoveryProviderRegistry();
  try {
    await providerRegistrySeed.seed(ownerDb);
    console.log("[worker] data_provider seed ok");
  } catch {
    await holdPlatformNotReady("PROVIDER_REGISTRY_SEED_UNAVAILABLE");
  }

  // 收口⑥：jurisdiction_policy seed（平台规则表，owner 写）。worker 的删除编排/合规判定需之；
  // 失败大声——规则空则 DataRights 对 red 数据 fail-closed。
  try {
    const n = await seedJurisdictionPolicy(ownerDb);
    console.log(`[worker] jurisdiction_policy seed ok (${n} rules)`);
  } catch {
    await holdPlatformNotReady("JURISDICTION_POLICY_SEED_UNAVAILABLE");
  }

  // 制裁名单源 + source_policy seed（第五门，owner 写平台表；全 DISABLED，真测绿后 ops 翻 ENABLED）。
  try {
    await seedSanctions(ownerDb);
    console.log(
      "[worker] sanctions source/policy seed ok (DISABLED until ops enables)",
    );
  } catch {
    await holdPlatformNotReady("SANCTIONS_SEED_UNAVAILABLE");
  }

  // Schedule provisioning is an independently authorized operator action.

  const registry = new ModelProviderRegistry();
  const gatewayProvider = buildGatewayProvider();
  if (gatewayProvider) registry.register(gatewayProvider);
  const gateway = new RouterModelGateway(
    new ModelRouter(registry),
    new AiTraceSink(prisma),
    budgetStore,
  );
  gateway.paidLedger = costLedger;
  const costReconciliationCatalog =
    createSiteBuildCostReconciliationCatalogFromEnv();
  const activeSettlementRoutes = (() => {
    try {
      return SITE_BUILDER_GENERATIVE_TASK_IDS.flatMap((taskId) => {
        const route = resolveTaskRoute(taskId, process.env);
        return [route.primary, ...route.fallbacks].map((alias) =>
          Object.freeze({
            taskId,
            alias,
            maxOutputTokens: route.maxTokens,
          }),
        );
      });
    } catch {
      return undefined;
    }
  })();
  if (
    !activeSettlementRoutes ||
    !costReconciliationCatalogCoversRoutes(
      costReconciliationCatalog,
      activeSettlementRoutes,
    )
  ) {
    await holdPlatformNotReady(
      "SITE_BUILD_COST_RECONCILIATION_CATALOG_UNAVAILABLE",
    );
  }
  gateway.costReconciliationCatalog = costReconciliationCatalog;
  const settlementReadbackRuntime =
    createSiteBuildSettlementReadbackRuntimeFromEnv(costLedger);
  if (!settlementReadbackRuntime) {
    await holdPlatformNotReady(
      "SITE_BUILD_MODEL_SETTLEMENT_READBACK_UNAVAILABLE",
    );
  }
  gateway.settlementDerivationKeyring = settlementReadbackRuntime?.keyring;
  gateway.settlementReadbackResolver = settlementReadbackRuntime?.resolver;
  const costReconciliationResolver =
    settlementReadbackRuntime?.reconciliationResolver;

  // 收口②：**唯一执行闸门**——全部原始出网（搜索/抓取/结构化 API/SMTP）经同一个 ToolBroker
  // （allowedTools 白名单 + source_policy fail-closed + 预算 reserve-settle + 限流 + Trace）。
  const sourcePolicyReader = sourcePolicyReaderFrom(prisma);
  const broker = buildToolBroker({
    sourcePolicyReader,
    paidLedger: costLedger,
    budgetStore,
    prisma,
  });
  const taxonomy = new TaxonomyResolver(
    prisma,
    gateway,
    runtimeTelemetry.telemetry,
    budgetStore,
  ); // discovery + external-intent sweep 共享一实例
  // 第五门制裁筛查引擎（worker 侧）：qualify 活动 screen 公司名 + 刷新活动重建索引。手工构造（非 Nest DI）；
  // 平台表无 RLS、app_user 只读 → prisma 读即可。DISABLED（Phase 1 默认）→ 空索引 → not_screened，no-op。
  const sanctionsScreening = new SanctionsScreeningService(prisma);
  try {
    await sanctionsScreening.rebuildIndex();
  } catch {
    await holdPlatformNotReady("SANCTIONS_INDEX_UNAVAILABLE");
  }
  // prisma（app_user）给专利缓存读/enqueue 闭包（平台表无 RLS）——PATENT_SOURCE_MODE=cache 时零 BQ 字节读缓存。
  const providers = new DiscoveryProviderRegistry({
    gateway,
    broker,
    prisma,
    runtimeTelemetry: runtimeTelemetry.telemetry,
  });

  if (!releaseIdentity.attested)
    throw new Error("RUNTIME_RELEASE_IDENTITY_UNAVAILABLE");
  const machine = await createRuntimeMachineTokenClient(
    "temporal-customer-worker",
    releaseIdentity.artifact_digest.replace(/^sha256:/, ""),
  );
  const connection = await connectNativeMachine(machine.client).catch(
    async () => holdPlatformNotReady("TEMPORAL_WORKER_CONNECTION_UNAVAILABLE"),
  );
  const worker = await Worker.create({
    connection,
    dataConverter: {
      failureConverterPath: require.resolve("./diagnostic-failure-converter"),
    },
    namespace: "default",
    identity: workerIdentity(
      machine.subject,
      runtimeLeases.instanceId("WORKER"),
    ),
    taskQueue: UNDERSTANDING_TASK_QUEUE,
    workflowsPath: require.resolve("./customer-workflows"),
    activities: {
      ...createUnderstandingActivities({
        prisma,
        gateway,
        broker,
        runtimeTelemetry: runtimeTelemetry.telemetry,
        budgetStore,
      }),
      ...createDiscoveryActivities({
        prisma,
        providers,
        gateway,
        taxonomy,
        broker,
        runtimeTelemetry: runtimeTelemetry.telemetry,
        budgetStore,
      }),
      ...createRawSourceActivities({ prisma }),
      ...createQualifyActivities({ prisma, sanctionsScreening }),
      ...createBacklogActivities({
        prisma,
        providers,
        gateway,
        ownerDb,
        broker,
        runtimeTelemetry: runtimeTelemetry.telemetry,
        budgetStore,
      }),
      // 外部源 intent sweep（TED 招标 + openFDA 510k 清关 → ACTIVE ICP 投影，externalIntentSweepWorkflow 调度）
      ...createExternalIntentActivities({
        prisma,
        taxonomy,
        ownerDb,
        broker,
        budgetStore,
      }),
      // 收口⑥ PR-B 删除编排（GDPR Art.17，on-demand：DeletionService 按 deletion_request 触发 deletionWorkflow）
      ...createDeletionActivities({ prisma }),
      ...createPersonalArtifactCleanupActivities({
        service: personalArtifactCleanupService,
      }),
      // 独立站建设（demo v0 + 精装修 refurbish；broker=brandProfile web 研究的唯一出网闸门）
      ...createSiteBuilderActivities({
        prisma,
        costLedger,
        costReconciliationResolver,
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
      ...createAssetCleanupActivities({
        prisma,
        storage: siteBuilderStorage,
      }),
      ...createSiteReleaseMaintenanceActivities({
        ownerDb,
        storage: siteBuilderStorage,
      }),
    },
  }).catch(async () => {
    await connection.close().catch(() => undefined);
    return holdPlatformNotReady("WORKER_INITIALIZATION_UNAVAILABLE");
  });

  console.log(
    `[worker] understanding worker up on task queue '${UNDERSTANDING_TASK_QUEUE}'`,
  );
  clearInterval(startingHeartbeat);
  const workerShutdown = createIdempotentWorkerShutdown(worker, () =>
    console.error(
      "[worker] duplicate or invalid shutdown request was contained",
    ),
  );
  const readyHeartbeat = await startWorkerLeaseHeartbeat({
    leases: runtimeLeases,
    worker: workerShutdown,
    taskQueue: UNDERSTANDING_TASK_QUEUE,
    onLeaseLost: () =>
      console.error(
        "[worker] runtime lease lost; polling is shutting down and readiness is closed",
      ),
  });
  const credentialFailure = createWorkerCredentialFailure({
    role: "WORKER",
    leases: runtimeLeases,
    heartbeat: readyHeartbeat,
    worker: workerShutdown,
    taskQueue: UNDERSTANDING_TASK_QUEUE,
  });
  const stopCredentialBinding = bindNativeMachineCredential(
    machine.client,
    connection,
    credentialFailure.fail,
  );
  const dependencyHeartbeat = await startWorkerDependencyHeartbeat({
    check: async () => {
      const queueIdentity = await runtimeLeases.inspectWorkerQueue(
        UNDERSTANDING_TASK_QUEUE,
      );
      if (queueIdentity.status !== "ok") return queueIdentity;
      const database = await prisma.reconnect();
      if (database.status !== "ready") {
        return { status: "failed", code: database.code } as const;
      }
      try {
        await assertMigrationCompatible(prisma, releaseIdentity);
      } catch {
        return {
          status: "failed",
          code: "MIGRATION_REVISION_MISMATCH",
        } as const;
      }
      const checks = await Promise.all([
        providerWireDatabase.checkReadiness(),
        siteBuilderStorage.checkReadiness(),
        checkGenericArtifactStorageReadiness(process.env),
        personalArtifactCleanupRuntime.checkReadiness(),
        checkRedisReadiness(process.env),
        checkModelGatewayReadiness(process.env),
        checkSiteBuildSettlementReadbackReadiness(process.env),
        checkBrowserReadiness(process.env),
        checkImagePipelineIsolationReadiness(),
      ]);
      return selectWorkerDependencyAdmission({
        hardChecks: checks,
        authorityCapabilities: [],
      });
    },
    leases: runtimeLeases,
    worker: workerShutdown,
    taskQueue: UNDERSTANDING_TASK_QUEUE,
    onBlocked: (code) =>
      console.error(
        `[worker] dependency became unavailable: ${code}; polling is shutting down`,
      ),
  });
  if (!dependencyHeartbeat.admitted) {
    readyHeartbeat.stop();
    await holdPlatformNotReady("WORKER_DEPENDENCY_UNAVAILABLE");
  }
  controlledSignals.attach({
    shutdown: workerShutdown,
    stopHeartbeats: () => {
      dependencyHeartbeat.stop();
      readyHeartbeat.stop();
    },
  });
  if (!credentialFailure.available())
    throw new Error("WORKER_MACHINE_CREDENTIAL_UNAVAILABLE");
  machine.client.currentToken();
  const runPromise = worker.run();
  workerShutdown.markRunning();
  try {
    await runPromise;
  } finally {
    await controlledSignals.stop();
    stopCredentialBinding();
    machine.client.close();
    dependencyHeartbeat.stop();
    readyHeartbeat.stop();
    await runtimeLeases
      .heartbeat("WORKER", "STOPPED", UNDERSTANDING_TASK_QUEUE)
      .catch(() => undefined);
    await runtimeTelemetry.shutdown();
    personalArtifactCleanupRuntime.destroy();
    await connection.close().catch(() => undefined);
    await providerWireDatabase.disconnect().catch(() => undefined);
    await ownerDb.$disconnect().catch(() => undefined);
    await runtimeLeaseStore.disconnectWriters();
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch(() => {
  console.error("[customer-worker] startup failed; polling disabled");
  process.exit(1);
});
