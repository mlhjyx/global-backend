import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "worker.ts"), "utf8");

describe("worker runtime admission wiring", () => {
  it("loads and validates the release identity before any external connection", () => {
    const identity = source.indexOf("await loadRuntimeReleaseIdentity");
    const telemetry = source.indexOf("await startLangfuseRuntimeTelemetry");
    const prisma = source.indexOf("new PrismaService()");
    const temporal = source.indexOf("NativeConnection.connect");

    expect(identity).toBeGreaterThan(-1);
    expect(identity).toBeLessThan(telemetry);
    expect(identity).toBeLessThan(prisma);
    expect(identity).toBeLessThan(temporal);
    expect(source).toContain("inspectRuntimeAdmission");
  });

  it("never imports or registers a product StubModelProvider", () => {
    expect(source).not.toContain("StubModelProvider");
    expect(source).not.toContain("stubAllowed");
  });

  it("checks migration, storage, native isolation and mixed worker identities before polling", () => {
    const migration = source.indexOf("assertMigrationCompatible");
    const storage = source.indexOf("checkReadiness()");
    const browser = source.indexOf("checkBrowserReadiness");
    const imageIsolation = source.indexOf(
      "checkImagePipelineIsolationReadiness",
    );
    const queue = source.lastIndexOf("waitForWorkerQueueAdmission");
    const poll = source.indexOf("worker.run()");

    expect(migration).toBeGreaterThan(-1);
    expect(storage).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(-1);
    expect(browser).toBeGreaterThan(-1);
    expect(imageIsolation).toBeGreaterThan(-1);
    expect(migration).toBeLessThan(poll);
    expect(storage).toBeLessThan(poll);
    expect(queue).toBeLessThan(poll);
    expect(browser).toBeLessThan(poll);
    expect(imageIsolation).toBeLessThan(poll);
  });

  it("holds without polling when owner database, platform seeds or schedules are unavailable", () => {
    const poll = source.indexOf("worker.run()");
    for (const code of [
      "OWNER_DATABASE_UNAVAILABLE",
      "RUNTIME_PROCESS_LEASE_PUBLISH_UNAVAILABLE",
      "PROVIDER_REGISTRY_SEED_UNAVAILABLE",
      "JURISDICTION_POLICY_SEED_UNAVAILABLE",
      "SANCTIONS_SEED_UNAVAILABLE",
      "PLATFORM_SCHEDULES_UNAVAILABLE",
      "SANCTIONS_INDEX_UNAVAILABLE",
    ]) {
      expect(source).toContain(`"${code}"`);
      expect(source.indexOf(`"${code}"`)).toBeLessThan(poll);
    }
  });

  it("shuts polling down when the durable READY lease is lost", () => {
    expect(source).toContain("startWorkerLeaseHeartbeat");
    expect(source).toContain("runtime lease lost; polling is shutting down");
    expect(source).not.toContain(
      '.heartbeat("WORKER", "READY", UNDERSTANDING_TASK_QUEUE)\n      .catch(() => undefined)',
    );
  });

  it("retries managed dependency readiness without enabling polling or using a fallback", () => {
    const poll = source.indexOf("worker.run()");
    const dependencyAdmission = source.indexOf(
      "waitForWorkerDependencyAdmission",
    );
    expect(dependencyAdmission).toBeGreaterThan(-1);
    expect(dependencyAdmission).toBeLessThan(poll);
    expect(source).not.toContain(
      "await holdWorkerNotReady(redisReadiness.code",
    );
    expect(source).not.toContain(
      "await holdWorkerNotReady(gatewayReadiness.code",
    );
  });

  it("does not promote additive execution authority capabilities into Worker polling admission", () => {
    expect(source).not.toContain("checkExecutionBudgetJwksReadiness");
    expect(source).not.toContain("checkPlatformBudgetAuthorityReadiness");
    expect(source).not.toContain("workspace_budget_authority");
    expect(source).not.toContain("platform_budget_authority");
  });

  it("retries app-user database and migration admission before creating a worker lease", () => {
    const databaseAdmission = source.indexOf("appDatabaseReadiness");
    const lease = source.indexOf("new PrismaRuntimeProcessLeaseStore");
    expect(databaseAdmission).toBeGreaterThan(-1);
    expect(databaseAdmission).toBeLessThan(lease);
    expect(source).toContain("check: async () => {");
    expect(source).not.toContain(
      "await holdWorkerNotReady(appDatabaseReadiness.code",
    );
    expect(source).not.toContain(
      'await holdWorkerNotReady("MIGRATION_REVISION_MISMATCH")',
    );
  });

  it("starts a recurring managed dependency gate before worker polling", () => {
    const recurring = source.indexOf("startWorkerDependencyHeartbeat");
    const poll = source.indexOf("worker.run()");
    expect(recurring).toBeGreaterThan(-1);
    expect(recurring).toBeLessThan(poll);
  });

  it("includes app-user database and exact migration compatibility in the recurring drain gate", () => {
    const recurring = source.slice(
      source.indexOf("startWorkerDependencyHeartbeat"),
    );
    expect(recurring).toContain("prisma.reconnect()");
    expect(recurring).toContain(
      "assertMigrationCompatible(prisma, releaseIdentity)",
    );
  });
});
