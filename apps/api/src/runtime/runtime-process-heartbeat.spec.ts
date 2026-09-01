import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRuntimeProcessHeartbeat } from "./runtime-process-heartbeat";
import { RuntimeReadinessContributorRegistry } from "./runtime-readiness-registry";

const identity = Object.freeze({
  attested: true as const,
  migration_revision: "20260816220000_production_parity_budget_runtime",
});

function fixture(
  heartbeat: ReturnType<typeof vi.fn>,
  migrationQuery: ReturnType<typeof vi.fn> = vi.fn(async () => [
    { migration_name: identity.migration_revision },
  ]),
  admitted = true,
) {
  const registry = new RuntimeReadinessContributorRegistry();
  const service = new ApiRuntimeProcessHeartbeat(
    {
      $queryRawUnsafe: migrationQuery,
    } as never,
    { current: () => ({ admitted }) } as never,
    { current: () => identity } as never,
    { heartbeat } as never,
    registry,
  );
  return { service, registry };
}

async function shutdown(service: ApiRuntimeProcessHeartbeat): Promise<void> {
  const lifecycle = service as unknown as {
    onModuleDestroy?: () => Promise<void>;
    beforeApplicationShutdown?: () => Promise<void>;
  };
  await lifecycle.onModuleDestroy?.();
  await lifecycle.beforeApplicationShutdown?.();
}

describe("ApiRuntimeProcessHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps API readiness closed when initial lease registration fails", async () => {
    const { service, registry } = fixture(
      vi.fn(async () => {
        throw new Error("writer password must not leak");
      }),
    );

    await service.onApplicationBootstrap();
    await expect(registry.check("api_runtime_lease")).resolves.toEqual({
      status: "failed",
      code: "API_RUNTIME_LEASE_NOT_READY",
    });
    await shutdown(service);
  });

  it("never starts migration or lease retries when static managed admission is closed", async () => {
    const heartbeat = vi.fn(async () => undefined);
    const migrationQuery = vi.fn(async () => [
      { migration_name: identity.migration_revision },
    ]);
    const { service, registry } = fixture(heartbeat, migrationQuery, false);

    await service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(registry.check("api_runtime_lease")).resolves.toEqual({
      status: "failed",
      code: "API_RUNTIME_LEASE_NOT_READY",
    });
    expect(migrationQuery).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    await shutdown(service);
  });

  it("publishes DRAINING before STOPPED and keeps terminalization fail-safe", async () => {
    const heartbeat = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("draining heartbeat unavailable"))
      .mockResolvedValueOnce(undefined);
    const { service } = fixture(heartbeat);

    await service.onApplicationBootstrap();
    expect(service.getReadiness()).toEqual({ status: "ok" });
    await shutdown(service);
    expect(service.getReadiness()).toEqual({
      status: "failed",
      code: "API_RUNTIME_LEASE_NOT_READY",
    });
    expect(heartbeat).toHaveBeenNthCalledWith(3, "API", "DRAINING", null);
    expect(heartbeat).toHaveBeenNthCalledWith(4, "API", "STOPPED", null);
  });

  it("terminalizes a registered API even after a transient heartbeat closes readiness", async () => {
    const heartbeat = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient heartbeat failure"))
      .mockResolvedValue(undefined);
    const { service } = fixture(heartbeat);

    await service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.getReadiness()).toEqual({
      status: "failed",
      code: "API_RUNTIME_LEASE_NOT_READY",
    });

    await shutdown(service);

    expect(heartbeat).toHaveBeenNthCalledWith(4, "API", "DRAINING", null);
    expect(heartbeat).toHaveBeenNthCalledWith(5, "API", "STOPPED", null);
  });

  it("waits for an in-flight READY heartbeat before publishing DRAINING and STOPPED", async () => {
    let releaseReady!: () => void;
    const readyBlocked = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const events: string[] = [];
    const heartbeat = vi.fn(async (_role: string, state: string) => {
      events.push(`start:${state}`);
      if (state === "READY" && heartbeat.mock.calls.length === 3) {
        await readyBlocked;
      }
      events.push(`end:${state}`);
    });
    const { service } = fixture(heartbeat);
    await service.onApplicationBootstrap();

    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
    const runtime = service as unknown as {
      publishReadyLease(): Promise<void>;
    };
    const concurrentPublish = runtime.publishReadyLease();
    const shutdownPromise = shutdown(service).then(() =>
      events.push("shutdown-complete"),
    );
    await Promise.resolve();

    expect(service.getReadiness()).toEqual({
      status: "failed",
      code: "API_RUNTIME_LEASE_NOT_READY",
    });
    expect(events).not.toContain("start:DRAINING");
    expect(events).not.toContain("shutdown-complete");
    releaseReady();
    await concurrentPublish;
    await shutdownPromise;

    expect(events.slice(-6)).toEqual([
      "end:READY",
      "start:DRAINING",
      "end:DRAINING",
      "start:STOPPED",
      "end:STOPPED",
      "shutdown-complete",
    ]);
    const terminalCallCount = heartbeat.mock.calls.length;
    await runtime.publishReadyLease();
    expect(heartbeat).toHaveBeenCalledTimes(terminalCallCount);
  });

  it("closes API readiness immediately when a running heartbeat fails and can recover", async () => {
    const heartbeat = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(undefined);
    const { service, registry } = fixture(heartbeat);

    await service.onApplicationBootstrap();
    await expect(registry.check("api_runtime_lease")).resolves.toEqual({
      status: "ok",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(registry.check("api_runtime_lease")).resolves.toEqual({
      status: "failed",
      code: "API_RUNTIME_LEASE_NOT_READY",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(registry.check("api_runtime_lease")).resolves.toEqual({
      status: "ok",
    });
    await shutdown(service);
  });

  it("never regresses an already READY API lease back to STARTING on a periodic heartbeat", async () => {
    const heartbeat = vi.fn(async () => undefined);
    const { service } = fixture(heartbeat);

    await service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(heartbeat).toHaveBeenNthCalledWith(1, "API", "STARTING", null);
    expect(heartbeat).toHaveBeenNthCalledWith(2, "API", "READY", null);
    expect(heartbeat).toHaveBeenNthCalledWith(3, "API", "READY", null);
    await shutdown(service);
  });

  it("retries migration admission after a transient bootstrap outage without reopening readiness early", async () => {
    const heartbeat = vi.fn(async () => undefined);
    const migrationQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary database outage"))
      .mockResolvedValue([{ migration_name: identity.migration_revision }]);
    const { service, registry } = fixture(heartbeat, migrationQuery);

    await service.onApplicationBootstrap();
    await expect(registry.check("api_runtime_lease")).resolves.toEqual({
      status: "failed",
      code: "API_RUNTIME_LEASE_NOT_READY",
    });
    expect(heartbeat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(registry.check("api_runtime_lease")).resolves.toEqual({
      status: "ok",
    });
    expect(heartbeat).toHaveBeenNthCalledWith(1, "API", "STARTING", null);
    expect(heartbeat).toHaveBeenNthCalledWith(2, "API", "READY", null);
    await shutdown(service);
  });
});
