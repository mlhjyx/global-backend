import "reflect-metadata";
import "dotenv/config";
import { resolve } from "node:path";
import { NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { DETERMINISTIC_LEDGER_FAILURE_INTERCEPTORS } from "./deterministic-ledger-failure.interceptor";
import { PrismaService } from "../prisma/prisma.service";
import { createExecutionBudgetPlatformWriterClient } from "../execution-budget/execution-budget-platform-writer.database";
import { ExecutionBudgetAuthorityRepository } from "../execution-budget/execution-budget-authority.repository";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";
import { inspectPlatformBudgetAuthorityReadiness } from "../runtime/managed-dependency-readiness";
import { JwksPlatformTechnicalQuoteServiceAuthenticationVerifier } from "../platform-authority/platform-technical-quote-jwks-verifier";
import { PlatformTechnicalQuoteAuthenticationReadinessContributor } from "../platform-authority/platform-technical-quote-service-auth";
import { PlatformEgressFence } from "../platform-authority/platform-egress-fence";
import { PrismaPlatformEgressFencePort } from "../platform-authority/platform-egress-fence.prisma";
import { createRuntimeMachineTokenClient } from "../platform-authority/machine-token-runtime";
import { startCapabilityRuntime, type CapabilityRuntime } from "../platform-authority/platform-capability-runtime";
import { resolveRuntimeSettings } from "../runtime/runtime-environment";
import { loadRuntimeReleaseIdentity } from "../runtime/runtime-release-identity";
import { inspectRuntimeAdmission } from "../runtime/runtime-admission";
import {
  assertScopedDatabasePrincipal,
  EXECUTION_BUDGET_PLATFORM_WRITER_ROLE,
} from "../runtime/scoped-database-principal";
import {
  assertMigrationCompatible,
  PrismaRuntimeProcessLeaseStore,
  RuntimeProcessLeaseService,
} from "../runtime/runtime-process-lease";
import {
  createIdempotentWorkerShutdown,
  createWorkerCredentialFailure,
  startWorkerLeaseHeartbeat,
  startWorkerProcessSignalCoordinator,
} from "../runtime/worker-lease-heartbeat";
import { startWorkerDependencyHeartbeat } from "../runtime/worker-dependency-heartbeat";
import {
  migrationCheckFailure,
  waitForWorkerDependencyAdmission,
} from "../runtime/worker-dependency-admission";
import {
  WORKER_SHUTDOWN_OPTIONS,
  armWorkerExitDeadline,
} from "../runtime/worker-shutdown-policy";
import { waitForWorkerQueueAdmission } from "../runtime/worker-queue-admission";
import { PostgresBudgetStore } from "../tools/budget-store";
import { ExecutionBudgetGrantVerifier } from "../execution-budget/execution-budget-grant.verifier";
import { PlatformExecutionBudgetAuthorityIngestionService } from "../execution-budget/platform-authority-ingestion.service";
import { loadVerifiedPlatformAuthorityPolicyAsset } from "../platform-authority/platform-authority-policy-asset";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "../platform-authority/platform-execution-contract";
import { PlatformExecutionTechnicalQuoteService } from "../platform-authority/platform-execution-technical-quote";
import { PlatformGrantClient } from "./platform-grant.client";
import { PlatformGrantAdmission } from "./platform-grant-admission";
import { PlatformCrawlGrantClient } from "./platform-crawl-grant.client";
import { createChannelCrawlActivities } from "./channel-crawl.activities";
import { recordChannelRunInTransaction } from "../channels/channel-run-recorder";
import { materializeChannelRecords } from "../channels/channel-records";
import { createPrismaChannelRecordWriter } from "../channels/channel-records.prisma";
import {
  buildToolBroker,
  sourcePolicyReaderFrom,
} from "../tools/tool-broker.factory";
import { buildSourceAdapterRegistry } from "../acquisition/registry";
import { Crawl4aiPageFetcher } from "../intent/page-fetcher";
import { SanctionsScreeningService } from "../sanctions/sanctions-screening.service";
import { createAcquisitionActivities } from "./acquisition.activities";
import { createIntentActivities } from "./intent.activities";
import { createPatentsCacheActivities } from "./patents-cache.activities";
import { createSanctionsRefreshActivities } from "./sanctions-refresh.activities";
import { createPlatformScheduleAuthorityActivities } from "./platform-schedule-authority.activities";
import { checkPlatformAuthorityReady } from "./platform-authority-readiness-gate";
import {
  bindNativeMachineCredential,
  connectNativeMachine,
} from "./native-machine-connection";
import { workerComposition, workerIdentity } from "./worker-composition";
import { resolveCustomerTemporalConfig } from "./temporal-config";
import { isInternalDbPlatformAuthorityMode } from "../platform-authority/platform-authority-mode";
import { PlatformScheduleConfigService } from "../platform-authority/platform-schedule-config.service";
import {
  createInternalDbPlatformBudgetStore,
  inspectInternalDbPlatformAuthorityReadiness,
  InternalDbPlatformEgressFencePort,
  InternalDbPlatformScheduleAdmission,
} from "../platform-authority/internal-db-platform-authority";

/** Fixed platform composition: no customer renderer, model gateway, or provider-wire principal. */
async function main(): Promise<void> {
  Runtime.install({ shutdownSignals: [] });
  const composition = workerComposition("platform-worker");
  const settings = resolveRuntimeSettings(process.env);
  const identity = await loadRuntimeReleaseIdentity({
    mode: settings.mode,
    artifactRoot: resolve(__dirname, ".."),
    env: process.env,
  });
  if (
    !identity.attested ||
    !inspectRuntimeAdmission(settings, process.env, identity, "PLATFORM_WORKER")
      .admitted
  )
    throw new Error("PLATFORM_WORKER_RUNTIME_ADMISSION_UNAVAILABLE");
  const prisma = new PrismaService();
  const blocked = (code: string) =>
    console.error(`[platform-worker] not ready: ${code}; polling disabled`);
  await waitForWorkerDependencyAdmission({
    check: async () => {
      const database = await prisma.reconnect();
      if (database.status !== "ready")
        return { status: "failed", code: database.code } as const;
      try {
        await assertMigrationCompatible(prisma, identity);
        return { status: "ok" } as const;
      } catch {
        return {
          status: "failed",
          code: "MIGRATION_REVISION_MISMATCH",
        } as const;
      }
    },
    onBlocked: blocked,
  });
  const store = new PrismaRuntimeProcessLeaseStore(prisma, {
    roles: ["PLATFORM_WORKER"],
  });
  const leases = new RuntimeProcessLeaseService(store, {
    identity,
    workerRole: "PLATFORM_WORKER",
  });
  const writer = createExecutionBudgetPlatformWriterClient(process.env);
  if (!writer)
    throw new ExecutionControlError(
      "PLATFORM_BUDGET_AUTHORITY_WRITER_UNAVAILABLE",
    );
  // Early signal cleanup can run before capability startup reaches its assignment.
  let capability: CapabilityRuntime | undefined = undefined;
  const cleanup = async () => {
    capability?.stop();
    await Promise.all([
      prisma.$disconnect(),
      writer.$disconnect(),
      store.disconnectWriters(),
    ]);
  };
  const signals = startWorkerProcessSignalCoordinator({
    role: "PLATFORM_WORKER",
    leases,
    taskQueue: composition.taskQueue,
    terminalizeUncertainRegistration: () =>
      leases.terminalize("PLATFORM_WORKER", composition.taskQueue),
    onEarlyCleanup: cleanup,
    onEarlyExit: (signal) => process.kill(process.pid, signal),
  });
  await signals.registered;
  const starting = setInterval(() => {
    void leases
      .heartbeat("PLATFORM_WORKER", "STARTING", composition.taskQueue)
      .catch(() => undefined);
  }, 10_000);
  starting.unref();
  await waitForWorkerQueueAdmission({
    leases,
    taskQueue: composition.taskQueue,
    onBlocked: blocked,
  });
  const registry = new RuntimeReadinessContributorRegistry();
  const internalDbAuthority = isInternalDbPlatformAuthorityMode(process.env);
  const scheduleConfigService = new PlatformScheduleConfigService({
    reader: prisma,
    writer,
  });
  let quote: PlatformTechnicalQuoteAuthenticationReadinessContributor | undefined;
  if (!internalDbAuthority) {
    capability = startCapabilityRuntime({
      registry,
      identity,
      admitted: () => inspectRuntimeAdmission(settings, process.env, identity, "PLATFORM_WORKER").admitted,
    });
    quote = new PlatformTechnicalQuoteAuthenticationReadinessContributor(
      new JwksPlatformTechnicalQuoteServiceAuthenticationVerifier(),
      registry,
    );
    quote.onModuleInit();
  }
  const repository = new ExecutionBudgetAuthorityRepository(prisma, writer);
  const check = async () => {
    const queueIdentity = await leases.inspectWorkerQueue(
      composition.taskQueue,
      { requireReady: false },
    );
    if (queueIdentity.status !== "ok") return queueIdentity;
    const database = await prisma.reconnect();
    if (database.status !== "ready")
      return { status: "failed", code: database.code } as const;
    try {
      await assertMigrationCompatible(prisma, identity);
    } catch (error) {
      // Only the deterministic revision mismatch drains at once; an unreadable
      // database stays on the heartbeat's consecutive-failure tolerance.
      return migrationCheckFailure(
        error,
        "PLATFORM_WORKER_DATABASE_UNAVAILABLE",
      );
    }
    try {
      await writer.$connect();
      await assertScopedDatabasePrincipal(
        writer,
        EXECUTION_BUDGET_PLATFORM_WRITER_ROLE,
        "platform-worker",
      );
    } catch {
      return {
        status: "failed",
        code: "PLATFORM_WORKER_DATABASE_UNAVAILABLE",
      } as const;
    }
    return checkPlatformAuthorityReady(() =>
      internalDbAuthority
        ? inspectInternalDbPlatformAuthorityReadiness(scheduleConfigService)
        : inspectPlatformBudgetAuthorityReadiness(repository, registry),
    );
  };
  await waitForWorkerDependencyAdmission({ check, onBlocked: blocked });
  const budgetStore = internalDbAuthority
    ? createInternalDbPlatformBudgetStore(scheduleConfigService)
    : new PostgresBudgetStore(prisma, writer);
  const broker = buildToolBroker({
    sourcePolicyReader: sourcePolicyReaderFrom(prisma),
    budgetStore,
    prisma,
  });
  const platformEgressFence = new PlatformEgressFence(
    internalDbAuthority
      ? new InternalDbPlatformEgressFencePort(scheduleConfigService)
      : new PrismaPlatformEgressFencePort(writer),
  );
  const sanctionsScreening = new SanctionsScreeningService(prisma);
  await sanctionsScreening.rebuildIndex();
  // 平台运行准入：默认 r4 走 quote → 权威（gain-saas）签发 Grant → 验签并 ingest+admit；
  // PLATFORM_AUTHORITY_MODE=internal_db 改走 platform_schedule_config 数据库 Kill Switch，免除 7 天 binding 与 5 套 RSA 密钥。
  const platformAdmission = internalDbAuthority
    ? new InternalDbPlatformScheduleAdmission(scheduleConfigService)
    : new PlatformGrantAdmission({
        quoteService: new PlatformExecutionTechnicalQuoteService({
          policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
          technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
        }),
        ingestion: new PlatformExecutionBudgetAuthorityIngestionService(
          new ExecutionBudgetGrantVerifier(process.env),
          repository,
        ),
        client: new PlatformGrantClient(process.env),
      });
  const useInternalTemporalDirect =
    internalDbAuthority && !(process.env.MACHINE_BOOTSTRAP_ENDPOINT ?? "").trim();
  const machine = useInternalTemporalDirect
    ? undefined
    : await createRuntimeMachineTokenClient(
        composition.profile,
        identity.artifact_digest.replace(/^sha256:/, ""),
      );
  const connection = machine
    ? await connectNativeMachine(machine.client)
    : await NativeConnection.connect({
        address: resolveCustomerTemporalConfig(process.env).address,
      });
  const workerNamespace = useInternalTemporalDirect
    ? (process.env.TEMPORAL_PLATFORM_NAMESPACE?.trim() ||
        resolveCustomerTemporalConfig(process.env).namespace)
    : composition.namespace;
  const worker = await Worker.create({
    connection,
    // B2（F5）：确定性账本错误在活动边界标 nonRetryable。
    interceptors: DETERMINISTIC_LEDGER_FAILURE_INTERCEPTORS,
    namespace: workerNamespace,
    taskQueue: composition.taskQueue,
    identity: workerIdentity(
      machine?.subject ?? "platform-worker-internal-db",
      leases.instanceId("PLATFORM_WORKER"),
    ),
    workflowsPath: require.resolve("./platform-workflows"),
    ...WORKER_SHUTDOWN_OPTIONS,
    dataConverter: {
      failureConverterPath: require.resolve("./diagnostic-failure-converter"),
    },
    activities: {
      ...createPlatformScheduleAuthorityActivities({ platformAdmission }),
      ...createAcquisitionActivities({
        prisma,
        registry: buildSourceAdapterRegistry(broker),
        budgetStore,
        platformWriter: writer,
        platformEgressFence,
      }),
      ...createIntentActivities({
        prisma,
        fetcher: new Crawl4aiPageFetcher(broker),
        broker,
        budgetStore,
        platformWriter: writer,
        platformEgressFence,
      }),
      ...createPatentsCacheActivities({
        ownerDb: writer,
        broker,
        budgetStore,
        platformWriter: writer,
        platformEgressFence,
      }),
      ...createSanctionsRefreshActivities({
        ownerDb: writer,
        broker,
        sanctionsScreening,
        budgetStore,
        platformWriter: writer,
        platformEgressFence,
      }),
      ...createChannelCrawlActivities({
        prisma,
        recordRun: (input) =>
          writer.$transaction((tx) =>
            recordChannelRunInTransaction(tx as never, input),
          ),
        grantClient: new PlatformCrawlGrantClient(process.env),
        ingestion: new PlatformExecutionBudgetAuthorityIngestionService(
          new ExecutionBudgetGrantVerifier(process.env),
          repository,
        ),
        budgetStore,
        fence: platformEgressFence,
        fetchPage: (url, context) =>
          new Crawl4aiPageFetcher(broker).fetch(url, context),
        // 紧急停写开关：CHANNEL_CRAWL_MATERIALIZE=off 回到「仅计数」行为（记录丢弃），默认开。
        materializeRecords:
          (process.env.CHANNEL_CRAWL_MATERIALIZE ?? "").trim() === "off"
            ? async () => 0
            : (input) =>
                materializeChannelRecords(createPrismaChannelRecordWriter(writer), input),
      }),
    },
  });
  const shutdown = createIdempotentWorkerShutdown(worker);
  clearInterval(starting);
  const heartbeat = await startWorkerLeaseHeartbeat({
    role: "PLATFORM_WORKER",
    leases,
    worker: shutdown,
    taskQueue: composition.taskQueue,
  });
  const credentialFailure = createWorkerCredentialFailure({
    role: "PLATFORM_WORKER",
    leases,
    heartbeat,
    worker: shutdown,
    taskQueue: composition.taskQueue,
  });
  const unbind = machine
    ? bindNativeMachineCredential(
        machine.client,
        connection,
        credentialFailure.fail,
      )
    : () => undefined;
  const dependencies = await startWorkerDependencyHeartbeat({
    role: "PLATFORM_WORKER",
    leases,
    worker: shutdown,
    taskQueue: composition.taskQueue,
    check,
    onBlocked: blocked,
  });
  signals.attach({
    shutdown,
    stopHeartbeats: () => {
      heartbeat.stop();
      dependencies.stop();
    },
  });
  try {
    if (!dependencies.admitted)
      throw new Error("PLATFORM_WORKER_DEPENDENCY_UNAVAILABLE");
    if (!credentialFailure.available())
      throw new Error("WORKER_MACHINE_CREDENTIAL_UNAVAILABLE");
    machine?.client.currentToken();
    const running = worker.run();
    shutdown.markRunning();
    await running;
  } finally {
    // The worker has stopped polling. If anything below hangs, the process
    // must still exit so the container's restart policy re-enters the startup
    // gates instead of leaving a drained container alive (2026-11-05).
    const exitDeadline = armWorkerExitDeadline();
    capability?.stop();
    unbind();
    machine?.client.close();
    heartbeat.stop();
    dependencies.stop();
    quote?.onModuleDestroy();
    await signals.stop();
    await leases
      .heartbeat("PLATFORM_WORKER", "STOPPED", composition.taskQueue)
      .catch(() => undefined);
    await connection.close().catch(() => undefined);
    await cleanup();
    exitDeadline.clear();
  }
}

main().catch(() => {
  console.error("[platform-worker] startup failed; polling disabled");
  process.exit(1);
});
