import { describe, expect, it, vi } from "vitest";

import { ExecutionControlError } from "../execution-budget/execution-control-error";
import { TradeFairSourceAdapter } from "../acquisition/adapters/trade-fair.source";
import { Crawl4aiPageFetcher } from "../intent/page-fetcher";
import { ModelProviderRegistry } from "../model-gateway/model-provider.registry";
import type { ModelProvider } from "../model-gateway/model-provider";
import { ModelRouter } from "../model-gateway/model-router";
import { RouterModelGateway } from "../model-gateway/router-model-gateway";
import type { BudgetStore } from "../tools/budget-store";
import { ToolBroker } from "../tools/tool-broker";
import type { Tool } from "../tools/tool-contract";
import { ToolRegistry } from "../tools/tool-registry";
import { SanctionsRefreshService } from "../sanctions/sanctions-refresh.service";
import { createPatentCacheBrokerScanner } from "../temporal/patent-cache-broker-scanner";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "./platform-execution-contract";
import { assertPlatformEgressFenceAvailable } from "./platform-egress-fence";

const HOLD = "PLATFORM_EGRESS_FENCE_UNAVAILABLE";

function platformToolComposition() {
  const execute = vi.fn(async () => ({ data: { ok: true }, costCents: 0 }));
  const tool: Tool = {
    id: "platform.fence.probe",
    version: "1.0.0",
    category: "search",
    sourceClass: "public_intelligence",
    cost: { unit: "call", estimatedCents: 0, external: false },
    rateLimit: { rps: 1, concurrency: 1 },
    compliance: {
      sourcePolicy: "none",
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ["discovery"],
      reversible: true,
      authRequired: false,
      risk: "low",
    },
    capabilities: { accepts: ["query"], produces: ["record"] },
    idempotencyKey: () => "platform-fence-probe",
    durableResultStrategy: { kind: "no_physical_call" },
    healthCheck: async () => ({ healthy: true }),
    execute,
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  const registryGet = vi.spyOn(registry, "get");
  const budget = {
    reserve: vi.fn(),
    settle: vi.fn(),
    release: vi.fn(),
    status: vi.fn(),
    open: vi.fn(),
    admitPlatformRun: vi.fn(),
  } as unknown as BudgetStore;
  const limiter = {
    configure: vi.fn(),
    acquire: vi.fn(),
    respectDomainDelay: vi.fn(),
  };
  const broker = new ToolBroker({
    registry,
    budgetStore: budget,
    limiter,
  });
  return { broker, budget, limiter, execute, registryGet, tool };
}

function platformModelComposition() {
  const generateText = vi.fn(async () => ({
    data: "must-not-run",
    provider: "platform-fence-provider",
    model: "never",
  }));
  const provider: ModelProvider = {
    id: "platform-fence-provider",
    supports: () => true,
    health: async () => ({ healthy: true }),
    generateText,
    generateStructured: vi.fn(),
    reviewVision: vi.fn(),
    embed: vi.fn(),
  } as unknown as ModelProvider;
  const providers = new ModelProviderRegistry();
  providers.register(provider);
  const router = new ModelRouter(providers);
  const route = vi.spyOn(router, "route");
  const budget = {
    reserve: vi.fn(),
    settle: vi.fn(),
    release: vi.fn(),
    status: vi.fn(),
    open: vi.fn(),
    admitPlatformRun: vi.fn(),
  } as unknown as BudgetStore;
  const gateway = new RouterModelGateway(router, undefined, budget);
  return { gateway, route, budget, generateText };
}

describe("pre-4D Platform product-boundary egress hold", () => {
  it("does not alter non-Platform product contexts", () => {
    expect(() =>
      assertPlatformEgressFenceAvailable({
        workspaceId: "11111111-1111-4111-8111-111111111111",
      }),
    ).not.toThrow();
  });

  it("rejects all four exact schedules before Tool registry, budget, limiter or execute", async () => {
    const composition = platformToolComposition();

    for (const row of PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows) {
      await expect(
        composition.broker.invoke(
          composition.tool.id,
          { scheduleId: row.scheduleId },
          {
            workspaceId: "platform",
            correlationId: row.rowId,
            purpose: row.purpose,
          },
        ),
      ).rejects.toEqual(new ExecutionControlError(HOLD));
    }

    expect(composition.registryGet).not.toHaveBeenCalled();
    expect(composition.budget.reserve).not.toHaveBeenCalled();
    expect(composition.limiter.acquire).not.toHaveBeenCalled();
    expect(composition.execute).not.toHaveBeenCalled();
  });

  it("rejects all four exact schedules before Model routing, budget or Provider", async () => {
    const composition = platformModelComposition();

    for (const row of PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows) {
      await expect(
        composition.gateway.generateText(
          {
            task: `platform.readiness.${row.scheduleId}`,
            prompt: "must never reach a provider",
            maxCostCents: 1,
          },
          {
            workspaceId: "platform",
            correlationId: row.rowId,
          },
        ),
      ).rejects.toEqual(new ExecutionControlError(HOLD));
    }

    expect(composition.route).not.toHaveBeenCalled();
    expect(composition.budget.reserve).not.toHaveBeenCalled();
    expect(composition.generateText).not.toHaveBeenCalled();
  });

  it("holds every existing schedule domain path at the same real ToolBroker composition", async () => {
    const composition = platformToolComposition();
    const context = {
      workspaceId: "platform",
      runId: "platform-account-key",
      correlationId: "platform-account-key",
    };
    const acquisition = new TradeFairSourceAdapter(composition.broker);
    const intent = new Crawl4aiPageFetcher(composition.broker);
    const sanctions = new SanctionsRefreshService({
      broker: composition.broker,
      ownerDb: {
        sanctionsSource: {
          findUniqueOrThrow: vi.fn(async () => ({
            id: "ofac-source",
            key: "ofac_sdn",
            format: "ofac_sdn_xml",
            url: "https://sanctions.example.test/list.xml",
            config: null,
          })),
        },
      } as never,
    });
    const patents = createPatentCacheBrokerScanner({
      broker: composition.broker,
      accountKey: context.runId,
    });

    const paths = [
      () =>
        acquisition.fetch(
          {
            fairSlug: "fair",
            algolia: {
              appId: "bounded-app",
              apiKey: "bounded-key",
              indexName: "exhibitors",
              eventEditionId: "event-1",
            },
          },
          1,
          context,
        ),
      () => intent.fetch("https://example.test/", context),
      () => sanctions.refreshSource("ofac-source", context.runId),
      () =>
        patents.searchInventorsForAnchorsWithStats(["Pump GmbH"], {
          maxRows: 1,
        }),
    ];

    for (const path of paths) {
      await expect(path()).rejects.toEqual(new ExecutionControlError(HOLD));
    }
    expect(composition.budget.reserve).not.toHaveBeenCalled();
    expect(composition.limiter.acquire).not.toHaveBeenCalled();
    expect(composition.execute).not.toHaveBeenCalled();
  });
});

describe("4D dispatcher composition", () => {
  it("wraps a non-platform ToolBroker wire with the injected durable dispatcher", async () => {
    const execute = vi.fn(async () => ({ data: { ok: true }, costCents: 0 }));
    const tool: Tool = {
      id: "dispatcher.probe",
      version: "1.0.0",
      category: "search",
      sourceClass: "public_intelligence",
      cost: { unit: "call", estimatedCents: 0, external: false },
      rateLimit: { rps: 10, concurrency: 1 },
      compliance: {
        sourcePolicy: "none",
        respectsRobots: false,
        personalData: false,
        allowedPurpose: ["discovery"],
        reversible: true,
        authRequired: false,
        risk: "low",
      },
      capabilities: { accepts: ["query"], produces: ["record"] },
      idempotencyKey: () => "dispatcher-probe",
      durableResultStrategy: { kind: "no_physical_call" },
      healthCheck: async () => ({ healthy: true }),
      execute,
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const budget = {
      reserve: vi.fn(async () => ({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        accountKey: "run-1",
        operationId: "22222222-2222-4222-8222-222222222222",
        estimatedMicrousd: 0n,
        replay: false,
      })),
      settle: vi.fn(async () => ({
        chargedMicrousd: 0n,
        observedMicrousd: 0n,
        capVariance: false,
        replay: false,
      })),
      release: vi.fn(),
      status: vi.fn(),
      open: vi.fn(),
      admitPlatformRun: vi.fn(),
    } as unknown as BudgetStore;
    const dispatch = vi.fn(async (_operationKey: string, run: () => Promise<unknown>) => run());
    const broker = new ToolBroker({
      registry,
      budgetStore: budget,
      limiter: {
        configure: vi.fn(),
        acquire: vi.fn(async () => vi.fn()),
        respectDomainDelay: vi.fn(),
      },
    });

    await broker.invoke(
      tool.id,
      { query: "x" },
      {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        runId: "run-1",
        platformEgress: { authorizeAndDispatch: dispatch },
      },
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("wraps a non-platform ModelGateway provider call with the same dispatcher", async () => {
    const composition = platformModelComposition();
    composition.budget.reserve.mockResolvedValue({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      accountKey: "run-1",
      operationId: "22222222-2222-4222-8222-222222222222",
      estimatedMicrousd: 10_000n,
      replay: false,
    });
    composition.budget.settle.mockResolvedValue({
      chargedMicrousd: 10_000n,
      observedMicrousd: 10_000n,
      capVariance: false,
      replay: false,
    });
    const dispatch = vi.fn(async (_operationKey: string, run: () => Promise<unknown>) => run());

    await composition.gateway.generateText(
      { task: "dispatcher.model.probe", prompt: "x", maxCostCents: 1 },
      {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        runId: "run-1",
        platformEgress: { authorizeAndDispatch: dispatch },
      },
    );

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(composition.generateText).toHaveBeenCalledOnce();
  });
});
