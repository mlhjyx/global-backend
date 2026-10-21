import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import { workerIdentity } from "./worker-composition";
import { PrismaService } from "../prisma/prisma.service";
import { ModelProviderRegistry } from "../model-gateway/model-provider.registry";
import { ModelRouter } from "../model-gateway/model-router";
import { RouterModelGateway } from "../model-gateway/router-model-gateway";
import { buildGatewayProvider } from "../model-gateway/model-providers.config";
import { AiTraceSink } from "../model-gateway/ai-trace.sink";
import { createUnderstandingActivities } from "./understanding.activities";
import { createDiscoveryActivities } from "./discovery.activities";
import { prismaDiscoveryRunLeaseReader } from "./discovery-run-lease";
import { createQualifyActivities } from "./qualify.activities";
import {
  costReconciliationCatalogCoversRoutes,
  createSiteBuildCostReconciliationCatalogFromEnv,
  createSiteBuildSettlementReadbackRuntimeFromEnv,
} from "../site-builder/site-build-cost-reconciliation-resolver";
import {
  resolveTaskRoute,
  SITE_BUILDER_GENERATIVE_TASK_IDS,
} from "../site-builder/agents/task-routes";
import { SanctionsScreeningService } from "../sanctions/sanctions-screening.service";
import { DiscoveryProviderRegistry } from "../discovery/provider.registry";
import {
  buildToolBroker,
  sourcePolicyReaderFrom,
} from "../tools/tool-broker.factory";
import { TaxonomyResolver } from "../discovery/taxonomy-resolver";
import { SiteBuildCostLedger } from "../site-builder/site-build-cost-ledger";
import { createSiteBuildProviderWireDatabaseFromEnv } from "../site-builder/site-build-provider-wire.database";
import { startLangfuseRuntimeTelemetry } from "../model-runtime";
import { assertMigrationRevision } from "../runtime/runtime-process-lease";
import { PostgresBudgetStore } from "../tools/budget-store";
import {
  checkGenericArtifactStorageReadiness,
  checkModelGatewayReadiness,
  checkRedisReadiness,
  checkSiteBuildSettlementReadbackReadiness,
} from "../runtime/managed-dependency-readiness";
import {
  createIdempotentWorkerShutdown,
  startWorkerProcessSignalCoordinator,
} from "../runtime/worker-lease-heartbeat";
import {
  selectWorkerDependencyAdmission,
  waitForWorkerDependencyAdmission,
} from "../runtime/worker-dependency-admission";
import { startWorkerDependencyHeartbeat } from "../runtime/worker-dependency-heartbeat";
import {
  checkDevFastLaneSourceSchema,
  NULL_LEASE_WRITER,
  type EnabledDevFastLane,
} from "../runtime/dev-fast-lane";
import {
  DEV_FAST_LANE_PRISMA_ROOT_FROM_DIST_TEMPORAL,
  readDevFastLaneSourceProvenance,
} from "../runtime/dev-fast-lane-source";

const NOT_READY_LOG_INTERVAL_MS = 30_000;

function holdNotReady(code: string): Promise<never> {
  console.error(
    `[worker] not ready: ${code}; Temporal polling remains disabled`,
  );
  return new Promise<never>(() => {
    setInterval(() => {
      console.error(`[worker] still not ready: ${code}`);
    }, NOT_READY_LOG_INTERVAL_MS);
  });
}

/**
 * Development fast-lane customer worker (runtime/dev-fast-lane.ts). worker.ts
 * forks here only for an unattested development build whose single failed
 * admission check is the missing build receipt while the lane switch is on.
 *
 * Differences from the managed worker, all deliberate:
 * - polls only the lane workspace's queue on the loopback development Temporal
 *   (plaintext, no machine token), never 'understanding' on native Temporal;
 * - writes no runtime_process_lease row, so the managed worker and readiness
 *   never see it;
 * - holds no owner database connection and runs no platform seeds;
 * - registers only the activities of the three routed workflows, so no
 *   site-builder, browser, renderer or erasure dependency is needed;
 * - takes migration revision and schema digest from its source tree, and
 *   requires the schema digest to equal the managed image's.
 * The gateway, broker and activity wiring stays textually identical to
 * worker.ts (worker-dev-fast-lane.source.spec.ts enforces it).
 */
export async function runDevFastLaneWorker(
  lane: EnabledDevFastLane,
): Promise<void> {
  console.error(
    `[worker] DEV FAST LANE: unattested source worker for workspace ${lane.workspaceId} on task queue '${lane.taskQueue}' at ${lane.temporalAddress}; tolerated admission failure: build:DEV_FAST_LANE_UNATTESTED`,
  );
  const source = await readDevFastLaneSourceProvenance(
    resolve(__dirname, DEV_FAST_LANE_PRISMA_ROOT_FROM_DIST_TEMPORAL),
  ).catch(() => holdNotReady("DEV_FAST_LANE_SOURCE_PROVENANCE_UNAVAILABLE"));
  const schema = checkDevFastLaneSourceSchema(lane, source.schemaDigest);
  if (schema.status !== "ok") return holdNotReady(schema.code);

  const runtimeTelemetry = await startLangfuseRuntimeTelemetry();
  const prisma = new PrismaService();
  const configuredProviderWireDatabase = (() => {
    try {
      return createSiteBuildProviderWireDatabaseFromEnv(
        process.env,
        undefined,
        source.migrationRevision,
      );
    } catch {
      return undefined;
    }
  })();
  if (!configuredProviderWireDatabase) {
    await runtimeTelemetry.shutdown();
    return holdNotReady("SITE_BUILD_PROVIDER_WIRE_DATABASE_UNAVAILABLE");
  }
  const providerWireDatabase = configuredProviderWireDatabase;
  const holdLaneNotReady = async (code: string): Promise<never> => {
    await providerWireDatabase.disconnect().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await runtimeTelemetry.shutdown();
    return holdNotReady(code);
  };
  const controlledSignals = startWorkerProcessSignalCoordinator({
    leases: NULL_LEASE_WRITER,
    taskQueue: lane.taskQueue,
    onEarlyCleanup: async () => {
      await runtimeTelemetry.shutdown().catch(() => undefined);
      await providerWireDatabase.disconnect().catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    },
    onEarlyExit: (signal) => {
      process.kill(process.pid, signal);
    },
  });
  await controlledSignals.registered;
  const dependencyBlocked = (code: string): void =>
    console.error(
      `[worker] not ready: ${code}; Temporal polling remains disabled`,
    );
  await waitForWorkerDependencyAdmission({
    check: async () => {
      const appDatabaseReadiness = await prisma.reconnect();
      if (appDatabaseReadiness.status !== "ready") {
        return { status: "failed", code: appDatabaseReadiness.code } as const;
      }
      try {
        await assertMigrationRevision(prisma, source.migrationRevision);
        return { status: "ok" } as const;
      } catch {
        return {
          status: "failed",
          code: "MIGRATION_REVISION_MISMATCH",
        } as const;
      }
    },
    onBlocked: dependencyBlocked,
  });
  await waitForWorkerDependencyAdmission({
    check: () => providerWireDatabase.checkReadiness(),
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
  const costLedger = new SiteBuildCostLedger(prisma, {
    providerWireDatabase,
  });
  const budgetStore = new PostgresBudgetStore(prisma);

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
    await holdLaneNotReady(
      "SITE_BUILD_COST_RECONCILIATION_CATALOG_UNAVAILABLE",
    );
  }
  gateway.costReconciliationCatalog = costReconciliationCatalog;
  const settlementReadbackRuntime =
    createSiteBuildSettlementReadbackRuntimeFromEnv(costLedger);
  if (!settlementReadbackRuntime) {
    await holdLaneNotReady("SITE_BUILD_MODEL_SETTLEMENT_READBACK_UNAVAILABLE");
  }
  gateway.settlementDerivationKeyring = settlementReadbackRuntime?.keyring;
  gateway.settlementReadbackResolver = settlementReadbackRuntime?.resolver;

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
  );
  const sanctionsScreening = new SanctionsScreeningService(prisma);
  try {
    await sanctionsScreening.rebuildIndex();
  } catch {
    await holdLaneNotReady("SANCTIONS_INDEX_UNAVAILABLE");
  }
  const providers = new DiscoveryProviderRegistry({
    gateway,
    broker,
    prisma,
    runtimeTelemetry: runtimeTelemetry.telemetry,
  });

  const connection = await NativeConnection.connect({
    address: lane.temporalAddress,
  }).catch(async () => holdLaneNotReady("DEV_FAST_LANE_TEMPORAL_UNAVAILABLE"));
  const worker = await Worker.create({
    connection,
    dataConverter: {
      failureConverterPath: require.resolve("./diagnostic-failure-converter"),
    },
    namespace: lane.temporalNamespace,
    identity: workerIdentity("dev-fast-lane", randomUUID()),
    taskQueue: lane.taskQueue,
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
        runLease: prismaDiscoveryRunLeaseReader(prisma),
      }),
      ...createQualifyActivities({ prisma, sanctionsScreening }),
    },
  }).catch(async () => {
    await connection.close().catch(() => undefined);
    return holdLaneNotReady("WORKER_INITIALIZATION_UNAVAILABLE");
  });

  console.log(
    `[worker] dev fast lane worker up on task queue '${lane.taskQueue}'`,
  );
  const workerShutdown = createIdempotentWorkerShutdown(worker, () =>
    console.error(
      "[worker] duplicate or invalid shutdown request was contained",
    ),
  );
  const dependencyHeartbeat = await startWorkerDependencyHeartbeat({
    check: async () => {
      const database = await prisma.reconnect();
      if (database.status !== "ready") {
        return { status: "failed", code: database.code } as const;
      }
      try {
        await assertMigrationRevision(prisma, source.migrationRevision);
      } catch {
        return {
          status: "failed",
          code: "MIGRATION_REVISION_MISMATCH",
        } as const;
      }
      const checks = await Promise.all([
        providerWireDatabase.checkReadiness(),
        checkGenericArtifactStorageReadiness(process.env),
        checkRedisReadiness(process.env),
        checkModelGatewayReadiness(process.env),
        checkSiteBuildSettlementReadbackReadiness(process.env),
      ]);
      return selectWorkerDependencyAdmission({
        hardChecks: checks,
        authorityCapabilities: [],
      });
    },
    leases: NULL_LEASE_WRITER,
    worker: workerShutdown,
    taskQueue: lane.taskQueue,
    onBlocked: (code) =>
      console.error(
        `[worker] dependency became unavailable: ${code}; polling is shutting down`,
      ),
  });
  if (!dependencyHeartbeat.admitted) {
    await connection.close().catch(() => undefined);
    await holdLaneNotReady("WORKER_DEPENDENCY_UNAVAILABLE");
  }
  controlledSignals.attach({
    shutdown: workerShutdown,
    stopHeartbeats: () => dependencyHeartbeat.stop(),
  });
  const runPromise = worker.run();
  workerShutdown.markRunning();
  try {
    await runPromise;
  } finally {
    await controlledSignals.stop();
    dependencyHeartbeat.stop();
    await runtimeTelemetry.shutdown();
    await connection.close().catch(() => undefined);
    await providerWireDatabase.disconnect().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}
