import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { RuntimeReadinessService } from "../health/runtime-readiness.service";
import { SiteBuildRuntimeGuard } from "./site-build-runtime.guard";

const PLATFORM_WORKER_NOT_READY = Object.freeze({
  status: "failed",
  code: "PLATFORM_WORKER_NOT_READY",
});
// The initial snapshot carries every hard component the service reports.
const HARD_COMPONENTS = Object.keys(
  new RuntimeReadinessService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  ).current().components,
);

function notReadyReport(
  overrides: Readonly<Record<string, unknown>>,
  settlement: Readonly<Record<string, unknown>> = { status: "ok" },
) {
  return {
    status: "not_ready",
    components: {
      ...Object.fromEntries(
        HARD_COMPONENTS.map((name) => [name, { status: "ok" }]),
      ),
      ...overrides,
    },
    capabilities: { site_builder_model_settlement_readback: settlement },
  };
}

function guardOver(report: Readonly<Record<string, unknown>>) {
  return new SiteBuildRuntimeGuard({
    checkHardComponents: vi.fn(async () => report),
    checkSiteBuilderPaidCapability: vi.fn(async () => report),
  } as never);
}

async function rejection(
  guard: SiteBuildRuntimeGuard,
  paidReachable: boolean,
): Promise<unknown> {
  return guard
    .assertReady({ paidReachable })
    .then(() => undefined)
    .catch((caught: unknown) => caught);
}

describe("SiteBuildRuntimeGuard", () => {
  it("admits intake and paid builds while only the separate platform worker is absent or not yet READY", async () => {
    const guard = guardOver(
      notReadyReport({ platform_worker: PLATFORM_WORKER_NOT_READY }),
    );

    await expect(
      guard.assertReady({ paidReachable: false }),
    ).resolves.toBeUndefined();
    await expect(
      guard.assertReady({ paidReachable: true }),
    ).resolves.toBeUndefined();
  });

  it("still rejects a platform worker integrity failure and lists every failed component", async () => {
    const mixed = {
      status: "failed",
      code: "PLATFORM_WORKER_MIXED_RELEASE_IDENTITY",
    };
    for (const paidReachable of [false, true]) {
      const error = await rejection(
        guardOver(notReadyReport({ platform_worker: mixed })),
        paidReachable,
      );
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(
        (error as ServiceUnavailableException).getResponse(),
      ).toMatchObject({
        error: {
          code: "SITE_BUILD_RUNTIME_NOT_READY",
          details: {
            failedComponents: [
              {
                component: "platform_worker",
                code: "PLATFORM_WORKER_MIXED_RELEASE_IDENTITY",
              },
            ],
          },
        },
      });
    }

    const customerAndPlatform = await rejection(
      guardOver(
        notReadyReport({
          worker: { status: "failed", code: "MATCHING_WORKER_NOT_READY" },
          platform_worker: PLATFORM_WORKER_NOT_READY,
        }),
      ),
      false,
    );
    expect(customerAndPlatform).toBeInstanceOf(ServiceUnavailableException);
    expect(
      (customerAndPlatform as ServiceUnavailableException).getResponse(),
    ).toEqual({
      error: {
        code: "SITE_BUILD_RUNTIME_NOT_READY",
        message: "site build runtime is not ready",
        details: {
          failedComponents: [
            { component: "worker", code: "MATCHING_WORKER_NOT_READY" },
            { component: "platform_worker", code: "PLATFORM_WORKER_NOT_READY" },
          ],
          failedCapabilities: [],
        },
      },
    });
  });

  it("still requires settlement readback for a paid build while the platform worker is not READY", async () => {
    const guard = guardOver(
      notReadyReport(
        { platform_worker: PLATFORM_WORKER_NOT_READY },
        {
          status: "failed",
          code: "SITE_BUILD_MODEL_SETTLEMENT_READBACK_UNAVAILABLE",
        },
      ),
    );

    await expect(
      guard.assertReady({ paidReachable: false }),
    ).resolves.toBeUndefined();
    const error = await rejection(guard, true);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      error: {
        code: "SITE_BUILD_RUNTIME_NOT_READY",
        message: "site build runtime is not ready",
        details: {
          failedComponents: [
            { component: "platform_worker", code: "PLATFORM_WORKER_NOT_READY" },
          ],
          failedCapabilities: [
            {
              capability: "site_builder_model_settlement_readback",
              code: "SITE_BUILD_MODEL_SETTLEMENT_READBACK_UNAVAILABLE",
            },
          ],
        },
      },
    });
  });

  it("allows a build only when the shared runtime report is ready", async () => {
    const readiness = {
      checkHardComponents: vi.fn(async () => ({
        status: "ready",
        components: {},
      })),
      checkSiteBuilderPaidCapability: vi.fn(async () => ({
        status: "ready",
        components: {},
        capabilities: {
          site_builder_model_settlement_readback: { status: "ok" },
        },
      })),
    };
    await expect(
      new SiteBuildRuntimeGuard(readiness as never).assertReady({
        paidReachable: true,
      }),
    ).resolves.toBeUndefined();
    expect(readiness.checkHardComponents).not.toHaveBeenCalled();
  });

  it("uses the paid report as the single hard-readiness snapshot", async () => {
    const readiness = {
      checkHardComponents: vi.fn(async () => ({
        status: "ready",
        components: {},
      })),
      checkSiteBuilderPaidCapability: vi.fn(async () => ({
        status: "not_ready",
        components: {
          worker: { status: "failed", code: "MATCHING_WORKER_NOT_READY" },
        },
        capabilities: {
          site_builder_model_settlement_readback: { status: "ok" },
        },
      })),
    };
    const error = await new SiteBuildRuntimeGuard(readiness as never)
      .assertReady({ paidReachable: true })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(readiness.checkHardComponents).not.toHaveBeenCalled();
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      error: {
        details: {
          failedComponents: [
            { component: "worker", code: "MATCHING_WORKER_NOT_READY" },
          ],
          failedCapabilities: [],
        },
      },
    });
  });

  it("returns the stable public error without leaking dependency diagnostics", async () => {
    const readiness = {
      checkHardComponents: vi.fn(async () => ({
        status: "not_ready",
        components: {
          database: { status: "failed", code: "DATABASE_UNAVAILABLE" },
          worker: { status: "failed", code: "MATCHING_WORKER_NOT_READY" },
        },
        internal: "postgresql://owner:secret@db/customer",
      })),
    };
    const guard = new SiteBuildRuntimeGuard(readiness as never);

    let error: unknown;
    try {
      await guard.assertReady({ paidReachable: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      error: {
        code: "SITE_BUILD_RUNTIME_NOT_READY",
        message: "site build runtime is not ready",
        details: {
          failedComponents: [
            { component: "database", code: "DATABASE_UNAVAILABLE" },
            { component: "worker", code: "MATCHING_WORKER_NOT_READY" },
          ],
          failedCapabilities: [],
        },
      },
    });
    expect(
      JSON.stringify((error as ServiceUnavailableException).getResponse()),
    ).not.toContain("secret");
  });

  it("refreshes hard dependencies through the product guard without executing authority capability probes", async () => {
    const transactionClient = {
      $executeRawUnsafe: vi.fn(async () => 0),
      $queryRawUnsafe: vi.fn(async (query: string) =>
        query === "SELECT 1"
          ? [{ ok: 1 }]
          : [{ migration_name: "20260816000000_runtime_process_lease" }],
      ),
    };
    const executionBudgetJwks = vi.fn(async () => ({
      status: "failed",
      code: "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
    }));
    const platformFreshness = vi.fn(async () => ({
      status: "failed",
      code: "PLATFORM_BUDGET_AUTHORITY_WRITER_UNAVAILABLE",
    }));
    const hardContributor = vi.fn(async () => ({ status: "ok" }));
    const service = new RuntimeReadinessService(
      {
        $transaction: vi.fn(
          async (
            operation: (client: typeof transactionClient) => Promise<unknown>,
          ) => operation(transactionClient),
        ),
      } as never,
      { probe: vi.fn(async () => ({ connected: true })) } as never,
      { current: vi.fn(() => ({ admitted: true })) } as never,
      {
        current: vi.fn(() => ({
          attested: true,
          migration_revision: "20260816000000_runtime_process_lease",
        })),
      } as never,
      {
        inspectWorkerQueue: vi.fn(async () => ({
          status: "failed",
          code: "MATCHING_WORKER_NOT_READY",
        })),
        inspectRole: vi.fn(async () => ({ status: "ok" })),
      } as never,
      {
        check: vi.fn((name: string) => {
          if (name === "execution_budget_jwks") return executionBudgetJwks();
          if (name === "platform_budget_authority") return platformFreshness();
          return hardContributor();
        }),
      } as never,
    );

    await service.check();
    executionBudgetJwks.mockClear();
    platformFreshness.mockClear();
    hardContributor.mockClear();
    transactionClient.$queryRawUnsafe.mockClear();

    await expect(
      new SiteBuildRuntimeGuard(service).assertReady({ paidReachable: false }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(transactionClient.$queryRawUnsafe).toHaveBeenCalledWith("SELECT 1");
    expect(hardContributor).toHaveBeenCalled();
    expect(executionBudgetJwks).not.toHaveBeenCalled();
    expect(platformFreshness).not.toHaveBeenCalled();
    expect(service.current()).toMatchObject({
      status: "not_ready",
      capabilities: {
        execution_budget_jwks: {
          status: "failed",
          code: "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
        },
        platform_budget_authority: {
          status: "failed",
          code: "PLATFORM_BUDGET_AUTHORITY_WRITER_UNAVAILABLE",
        },
      },
      components: {
        worker: { status: "failed", code: "MATCHING_WORKER_NOT_READY" },
      },
    });
  });

  it("allows deterministic intake but rejects a paid-reachable build when exact readback is unavailable", async () => {
    const readiness = {
      checkHardComponents: vi.fn(async () => ({
        status: "ready",
        components: {},
      })),
      checkSiteBuilderPaidCapability: vi.fn(async () => ({
        status: "ready",
        components: {},
        capabilities: {
          site_builder_model_settlement_readback: {
            status: "failed",
            code: "SITE_BUILD_MODEL_SETTLEMENT_READBACK_UNAVAILABLE",
          },
        },
      })),
    };
    const guard = new SiteBuildRuntimeGuard(readiness as never);

    await expect(
      guard.assertReady({ paidReachable: false }),
    ).resolves.toBeUndefined();
    const error = await guard
      .assertReady({ paidReachable: true })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      error: {
        code: "SITE_BUILD_RUNTIME_NOT_READY",
        message: "site build runtime is not ready",
        details: {
          failedComponents: [],
          failedCapabilities: [
            {
              capability: "site_builder_model_settlement_readback",
              code: "SITE_BUILD_MODEL_SETTLEMENT_READBACK_UNAVAILABLE",
            },
          ],
        },
      },
    });
  });
});
