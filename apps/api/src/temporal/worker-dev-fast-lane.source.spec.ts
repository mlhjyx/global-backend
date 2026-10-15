import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Process entry points have no unit harness; these guards pin their wiring the
// same way worker-runtime-admission.spec.ts does for the managed worker.
const worker = readFileSync(join(import.meta.dirname, "worker.ts"), "utf8");
const lane = readFileSync(
  join(import.meta.dirname, "dev-fast-lane-worker.ts"),
  "utf8",
);

/** The call starting at `anchor`, through its balanced closing parenthesis. */
function call(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`missing ${anchor}`);
  let depth = 0;
  for (
    let index = source.indexOf("(", start);
    index < source.length;
    index += 1
  ) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1).replace(/\s+/g, " ");
  }
  throw new Error(`unbalanced ${anchor}`);
}

describe("customer worker fork into the development fast lane", () => {
  it("resolves the lane before the release identity and forks before any managed side effect", () => {
    // Arrange
    const resolveLane = worker.indexOf(
      "resolveDevFastLane(runtimeSettings.mode, process.env)",
    );
    const identity = worker.indexOf("await loadRuntimeReleaseIdentity");
    const decision = worker.indexOf(
      "devFastLaneWorkerLane(devFastLane, releaseIdentity, admission)",
    );
    const fork = worker.indexOf("return runDevFastLaneWorker(");
    const managedHold = worker.indexOf("if (!admission.admitted)");

    // Act
    const identityCall = call(worker, "await loadRuntimeReleaseIdentity");

    // Assert
    expect(resolveLane).toBeGreaterThan(-1);
    expect(resolveLane).toBeLessThan(identity);
    expect(identityCall).toContain("devFastLane,");
    expect(decision).toBeGreaterThan(
      worker.indexOf("inspectRuntimeAdmission("),
    );
    expect(fork).toBeGreaterThan(decision);
    expect(fork).toBeLessThan(managedHold);
    expect(fork).toBeLessThan(
      worker.indexOf("await startLangfuseRuntimeTelemetry"),
    );
    expect(fork).toBeLessThan(worker.indexOf("new PrismaService()"));
    expect(fork).toBeLessThan(
      worker.indexOf("new PrismaRuntimeProcessLeaseStore"),
    );
  });
});

describe("development fast-lane worker", () => {
  it("polls only the lane queue of the loopback development Temporal with the managed converter", () => {
    // Act
    const create = call(lane, "Worker.create(");

    // Assert
    expect(lane.match(/Worker\.create\(/g)).toHaveLength(1);
    expect(create).toContain("taskQueue: lane.taskQueue");
    expect(create).toContain("namespace: lane.temporalNamespace");
    expect(create).toContain(
      'failureConverterPath: require.resolve("./diagnostic-failure-converter")',
    );
    expect(create).toContain(
      'workflowsPath: require.resolve("./customer-workflows")',
    );
    expect(call(lane, "NativeConnection.connect(")).toBe(
      "NativeConnection.connect({ address: lane.temporalAddress, })",
    );
  });

  it("registers only the acquisition activities its routed workflows call", () => {
    // Act
    const create = call(lane, "Worker.create(");
    const registered = [
      ...create.matchAll(/\.\.\.(create\w+Activities)\(/g),
    ].map((match) => match[1]);

    // Assert
    expect(registered).toEqual([
      "createUnderstandingActivities",
      "createDiscoveryActivities",
      "createQualifyActivities",
    ]);
  });

  it("holds no owner, lease, machine or site-builder authority", () => {
    for (const forbidden of [
      "ownerDb",
      "new PrismaClient(",
      "DATABASE_URL",
      ".seed(",
      "seedJurisdictionPolicy",
      "seedSanctions",
      "RuntimeProcessLeaseService(",
      "PrismaRuntimeProcessLeaseStore",
      "waitForWorkerQueueAdmission",
      "createRuntimeMachineTokenClient",
      "connectNativeMachine",
      "build-attestation.json",
      "RUNTIME_IMAGE_REFERENCE",
      "rendererRuntimeIdentity",
      "checkBrowserReadiness",
      "checkImagePipelineIsolationReadiness",
      "createSiteBuilderActivities",
      "createBacklogActivities",
      "createExternalIntentActivities",
      "createDeletionActivities",
      "createPersonalArtifactCleanupActivities",
      "createAssetCleanupActivities",
      "createSiteReleaseMaintenanceActivities",
      "UNDERSTANDING_TASK_QUEUE",
    ]) {
      expect(lane, forbidden).not.toContain(forbidden);
    }
  });

  it("checks source schema and migration before polling and drains without writing a lease", () => {
    // Arrange
    const poll = lane.indexOf("worker.run()");

    // Act
    const order = [
      lane.indexOf("readDevFastLaneSourceProvenance("),
      lane.indexOf("checkDevFastLaneSourceSchema("),
      lane.indexOf("new PrismaService()"),
      lane.indexOf("assertMigrationRevision(prisma, source.migrationRevision)"),
      lane.indexOf("Worker.create("),
      lane.indexOf("startWorkerDependencyHeartbeat("),
      poll,
    ];

    // Assert
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(call(lane, "startWorkerProcessSignalCoordinator(")).toContain(
      "leases: NULL_LEASE_WRITER",
    );
    expect(call(lane, "startWorkerDependencyHeartbeat(")).toContain(
      "leases: NULL_LEASE_WRITER",
    );
    expect(call(lane, "startWorkerDependencyHeartbeat(")).toContain(
      "assertMigrationRevision(prisma, source.migrationRevision)",
    );
  });

  it("builds the gateway, broker and acquisition activities exactly as the managed worker does", () => {
    for (const anchor of [
      "new RouterModelGateway(",
      "createSiteBuildCostReconciliationCatalogFromEnv(",
      "SITE_BUILDER_GENERATIVE_TASK_IDS.flatMap(",
      "costReconciliationCatalogCoversRoutes(",
      "createSiteBuildSettlementReadbackRuntimeFromEnv(",
      "sourcePolicyReaderFrom(",
      "buildToolBroker(",
      "new TaxonomyResolver(",
      "new SanctionsScreeningService(",
      "new DiscoveryProviderRegistry({",
      "createUnderstandingActivities(",
      "createDiscoveryActivities(",
      "createQualifyActivities(",
      "new SiteBuildCostLedger(",
      "new PostgresBudgetStore(",
    ]) {
      expect(call(lane, anchor), anchor).toBe(call(worker, anchor));
    }
    for (const statement of [
      "gateway.paidLedger = costLedger;",
      "gateway.costReconciliationCatalog = costReconciliationCatalog;",
      "gateway.settlementDerivationKeyring = settlementReadbackRuntime?.keyring;",
      "gateway.settlementReadbackResolver = settlementReadbackRuntime?.resolver;",
      "if (gatewayProvider) registry.register(gatewayProvider);",
      "await sanctionsScreening.rebuildIndex();",
    ]) {
      expect(lane, statement).toContain(statement);
      expect(worker, statement).toContain(statement);
    }
  });
});
