import "reflect-metadata";
import "dotenv/config";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { Runtime, Worker } from "@temporalio/worker";
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
import { waitForWorkerDependencyAdmission } from "../runtime/worker-dependency-admission";
import { waitForWorkerQueueAdmission } from "../runtime/worker-queue-admission";
import { PostgresBudgetStore } from "../tools/budget-store";
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
  const ownerDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
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
      ownerDb.$disconnect(),
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
  capability = startCapabilityRuntime({
    registry,
    identity,
    admitted: () => inspectRuntimeAdmission(settings, process.env, identity, "PLATFORM_WORKER").admitted,
  });
  const quote = new PlatformTechnicalQuoteAuthenticationReadinessContributor(
    new JwksPlatformTechnicalQuoteServiceAuthenticationVerifier(),
    registry,
  );
  quote.onModuleInit();
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
      await ownerDb.$connect();
      await writer.$connect();
    } catch {
      return {
        status: "failed",
        code: "PLATFORM_WORKER_DATABASE_UNAVAILABLE",
      } as const;
    }
    return checkPlatformAuthorityReady(() =>
      inspectPlatformBudgetAuthorityReadiness(repository, registry),
    );
  };
  await waitForWorkerDependencyAdmission({ check, onBlocked: blocked });
  const budgetStore = new PostgresBudgetStore(prisma, writer);
  const broker = buildToolBroker({
    sourcePolicyReader: sourcePolicyReaderFrom(prisma),
    budgetStore,
    prisma,
  });
  const platformEgressFence = new PlatformEgressFence(
    new PrismaPlatformEgressFencePort(writer),
  );
  const sanctionsScreening = new SanctionsScreeningService(prisma);
  await sanctionsScreening.rebuildIndex();
  const machine = await createRuntimeMachineTokenClient(
    composition.profile,
    identity.artifact_digest.replace(/^sha256:/, ""),
  );
  const connection = await connectNativeMachine(machine.client);
  const worker = await Worker.create({
    connection,
    namespace: composition.namespace,
    taskQueue: composition.taskQueue,
    identity: workerIdentity(
      machine.subject,
      leases.instanceId("PLATFORM_WORKER"),
    ),
    workflowsPath: require.resolve("./platform-workflows"),
    dataConverter: {
      failureConverterPath: require.resolve("./diagnostic-failure-converter"),
    },
    activities: {
      ...createPlatformScheduleAuthorityActivities({ budgetStore }),
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
        ownerDb,
        broker,
        budgetStore,
        platformWriter: writer,
        platformEgressFence,
      }),
      ...createPatentsCacheActivities({
        ownerDb,
        broker,
        budgetStore,
        platformWriter: writer,
        platformEgressFence,
      }),
      ...createSanctionsRefreshActivities({
        ownerDb,
        broker,
        sanctionsScreening,
        budgetStore,
        platformWriter: writer,
        platformEgressFence,
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
  const unbind = bindNativeMachineCredential(
    machine.client,
    connection,
    credentialFailure.fail,
  );
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
    machine.client.currentToken();
    const running = worker.run();
    shutdown.markRunning();
    await running;
  } finally {
    capability?.stop();
    unbind();
    machine.client.close();
    heartbeat.stop();
    dependencies.stop();
    quote.onModuleDestroy();
    await signals.stop();
    await leases
      .heartbeat("PLATFORM_WORKER", "STOPPED", composition.taskQueue)
      .catch(() => undefined);
    await connection.close().catch(() => undefined);
    await cleanup();
  }
}

main().catch(() => {
  console.error("[platform-worker] startup failed; polling disabled");
  process.exit(1);
});
