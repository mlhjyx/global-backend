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
import { ExternalToolActionDeniedError, type Tool, type ToolContext } from "../tools/tool-contract";
import { ToolRegistry } from "../tools/tool-registry";
import { SanctionsRefreshService } from "../sanctions/sanctions-refresh.service";
import { createPatentCacheBrokerScanner } from "../temporal/patent-cache-broker-scanner";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "./platform-execution-contract";
import { assertPlatformEgressFenceAvailable } from "./platform-egress-fence";

const HOLD = "PLATFORM_EGRESS_FENCE_UNAVAILABLE";

function platformToolComposition() {
  const execute = vi.fn(async (_input: unknown, context: ToolContext) => {
    const wire = async () => ({ data: { ok: true }, costCents: 0 });
    return context.dispatchPhysicalWire
      ? context.dispatchPhysicalWire("tradefair.algolia.page", wire)
      : wire();
  });
  const tool: Tool = {
    id: "tradefair.algolia",
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
  it("injects the physical-wire dispatcher for a declared tool without mutating the caller context", async () => {
    const execute = vi.fn(async (_input: unknown, context: ToolContext) =>
      context.dispatchPhysicalWire!("tradefair.algolia.page", async () => ({ data: { ok: true }, costCents: 0 })));
    const tool: Tool = {
      id: "tradefair.algolia",
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
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      budgetOperationId: "22222222-2222-4222-8222-222222222222",
      budgetOperationKey: budget.reserve.mock.calls[0][0].operationKey,
      reservedMicrousd: 0n,
      execution: { kind: "tool", toolId: "tradefair.algolia", toolVersion: "1.0.0" },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  function reservedTool() {
    const composition = platformToolComposition();
    composition.budget.reserve.mockResolvedValue({ workspaceId: "platform", accountKey: "run-1",
      operationId: "22222222-2222-4222-8222-222222222222", estimatedMicrousd: 0n, replay: false });
    composition.budget.settle.mockResolvedValue({ chargedMicrousd: 0n, observedMicrousd: 0n, capVariance: false, replay: false });
    const dispatch = vi.fn(async (_operation: unknown, wire: () => Promise<unknown>) => wire());
    const context: ToolContext = { workspaceId: "platform", runId: "run-1", platformEgress: { authorizeAndDispatch: dispatch } };
    return { ...composition, dispatch, context };
  }

  it("fences each of two pages with distinct child keys and the same reserved budget", async () => {
    const fixture = reservedTool();
    const wire = vi.fn(async () => "page");
    fixture.execute.mockImplementation(async (_input, context) => {
      for (let wireIndex = 0; wireIndex < 2; wireIndex++) {
        await context.dispatchPhysicalWire!("tradefair.algolia.page", wire);
      }
      return { data: { ok: true }, costCents: 0 };
    });
    await fixture.broker.invoke(fixture.tool.id, {}, fixture.context);
    expect(wire).toHaveBeenCalledTimes(2);
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    const [first, second] = fixture.dispatch.mock.calls.map(call => call[0]) as Array<Record<string, unknown>>;
    expect(first.operationKey).not.toBe(second.operationKey);
    for (const operation of [first, second]) expect(operation).toMatchObject({
      budgetOperationId: "22222222-2222-4222-8222-222222222222",
      budgetOperationKey: fixture.budget.reserve.mock.calls[0][0].operationKey, reservedMicrousd: 0n });
    expect(fixture.budget.reserve).toHaveBeenCalledOnce();
    expect(fixture.budget.settle).toHaveBeenCalledOnce();
    expect(fixture.context).not.toHaveProperty("dispatchPhysicalWire");
    expect(fixture.execute.mock.calls[0][1]).not.toBe(fixture.context);
  });

  it.each(["fence", "suppression"])("retains the reservation after the first page when the second %s check fails", async failure => {
    const fixture = reservedTool();
    const wire = vi.fn(async () => "page");
    if (failure === "fence") fixture.dispatch.mockImplementationOnce(async (_operation, send) => send())
      .mockRejectedValueOnce(new Error("PLATFORM_EGRESS_SEND_CAS_REJECTED"));
    fixture.execute.mockImplementation(async (_input, context) => {
      await context.dispatchPhysicalWire!("tradefair.algolia.page", wire);
      if (failure === "suppression") throw new ExternalToolActionDeniedError();
      await context.dispatchPhysicalWire!("tradefair.algolia.page", wire);
      return { data: { ok: true }, costCents: 0 };
    });
    await expect(fixture.broker.invoke(fixture.tool.id, {}, fixture.context)).rejects.toThrow();
    expect(wire).toHaveBeenCalledOnce();
    expect(fixture.budget.release).not.toHaveBeenCalled();
    expect(fixture.budget.settle).not.toHaveBeenCalled();
  });

  it("preserves an ordinary tool context without injecting a Platform wire dispatcher", async () => {
    const fixture = reservedTool();
    const context: ToolContext = { workspaceId: "workspace", runId: "run-1" };
    fixture.budget.reserve.mockResolvedValue({ workspaceId: "workspace", accountKey: "run-1",
      operationId: "22222222-2222-4222-8222-222222222222", estimatedMicrousd: 0n, replay: false });
    await fixture.broker.invoke(fixture.tool.id, {}, context);
    expect(fixture.execute.mock.calls[0][1]).toBe(context);
    expect(context).not.toHaveProperty("dispatchPhysicalWire");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("does not settle a fallback result after the tool swallowed a physical-wire failure", async () => {
    const fixture = reservedTool();
    const wire = vi.fn(async () => "page");
    fixture.dispatch.mockImplementationOnce(async (_operation, send) => send())
      .mockRejectedValueOnce(new Error("lost acknowledgement"));
    fixture.execute.mockImplementation(async (_input, context) => {
      await context.dispatchPhysicalWire!("tradefair.algolia.page", wire);
      try { await context.dispatchPhysicalWire!("tradefair.algolia.page", wire); }
      catch { /* Test producer attempts a fallback; Broker must reject it. */ }
      return { data: { ok: true }, costCents: 0 };
    });
    await expect(fixture.broker.invoke(fixture.tool.id, {}, fixture.context))
      .rejects.toThrow("PLATFORM_EGRESS_PHYSICAL_WIRE_FAILED");
    expect(wire).toHaveBeenCalledOnce();
    expect(fixture.budget.release).not.toHaveBeenCalled();
    expect(fixture.budget.settle).not.toHaveBeenCalled();
  });

  it("does not release an uncertain dispatcher failure relabeled by the tool as suppression", async () => {
    const fixture = reservedTool();
    fixture.dispatch.mockRejectedValueOnce(new Error("send-cut commit acknowledgement lost"));
    fixture.execute.mockImplementation(async (_input, context) => {
      try { await context.dispatchPhysicalWire!("tradefair.algolia.page", async () => "page"); }
      catch { throw new ExternalToolActionDeniedError(); }
      return { data: { ok: true }, costCents: 0 };
    });
    await expect(fixture.broker.invoke(fixture.tool.id, {}, fixture.context)).rejects.toThrow();
    expect(fixture.budget.release).not.toHaveBeenCalled();
    expect(fixture.budget.settle).not.toHaveBeenCalled();
  });

  it("rejects an undeclared Platform tool before entering execute", async () => {
    const fixture = reservedTool();
    fixture.tool.id = "undeclared.probe";
    await expect(fixture.broker.invoke("tradefair.algolia", {}, fixture.context)).rejects.toThrow();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
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
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      operationKey: expect.stringMatching(/^[0-9a-f]{64}$/u),
      budgetOperationId: "22222222-2222-4222-8222-222222222222",
      budgetOperationKey: composition.budget.reserve.mock.calls[0][0].operationKey,
      reservedMicrousd: 10_000n,
      execution: { kind: "model", modelOp: "generateText", taskId: "dispatcher.model.probe", providerId: "platform-fence-provider" },
    });
    expect(composition.generateText).toHaveBeenCalledOnce();
  });

  it.each(["tool", "model"])("refuses a %s wire when reserve returned no durable operation identity", async kind => {
    const composition = kind === "tool" ? platformToolComposition() : platformModelComposition();
    composition.budget.reserve.mockResolvedValue({ workspaceId: "platform", accountKey: "run-1", estimatedMicrousd: 0n, replay: false });
    const dispatch = vi.fn(async (_operation: unknown, wire: () => Promise<unknown>) => wire());
    const ctx = { workspaceId: "platform", runId: "run-1", platformEgress: { authorizeAndDispatch: dispatch } };
    const promise = "broker" in composition
      ? composition.broker.invoke(composition.tool.id, {}, ctx)
      : composition.gateway.generateText({ task: "reservation.probe", prompt: "x", maxCostCents: 0 }, ctx);
    await expect(promise).rejects.toThrow("PLATFORM_EGRESS_RESERVATION_INVALID");
    expect(dispatch).not.toHaveBeenCalled();
    expect("execute" in composition ? composition.execute : composition.generateText).not.toHaveBeenCalled();
  });

  it.each(["tool", "model"])("carries the actual zero-cost Platform %s reservation into the dispatcher", async kind => {
    const composition = kind === "tool" ? platformToolComposition() : platformModelComposition();
    composition.budget.reserve.mockResolvedValue({ workspaceId: "platform", accountKey: "run-1",
      operationId: "22222222-2222-4222-8222-222222222222", estimatedMicrousd: 0n, replay: false });
    composition.budget.settle.mockResolvedValue({ chargedMicrousd: 0n, observedMicrousd: 0n, capVariance: false, replay: false });
    const dispatch = vi.fn(async (_operation: unknown, wire: () => Promise<unknown>) => wire());
    const ctx = { workspaceId: "platform", runId: "run-1", platformEgress: { authorizeAndDispatch: dispatch } };
    if ("broker" in composition) await composition.broker.invoke(composition.tool.id, {}, ctx);
    else await composition.gateway.generateText({ task: "reservation.probe", model: "explicit-model", prompt: "x", maxCostCents: 0 }, ctx);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ budgetOperationId: "22222222-2222-4222-8222-222222222222",
      budgetOperationKey: composition.budget.reserve.mock.calls[0][0].operationKey, reservedMicrousd: 0n });
    if (kind === "model") expect(dispatch.mock.calls[0][0]).toMatchObject({ execution: {
      kind: "model", providerId: "platform-fence-provider", requestedModel: "explicit-model", taskId: "reservation.probe" } });
    expect("execute" in composition ? composition.execute : composition.generateText).toHaveBeenCalledOnce();
  });

  it.each(["tool", "model"])("rejects mixed Platform/SiteBuilder paidCost before %s budget or routing", async kind => {
    const composition = kind === "tool" ? platformToolComposition() : platformModelComposition();
    const ctx = { workspaceId: "platform", runId: "run-1", paidCost: {} as never,
      platformEgress: { authorizeAndDispatch: vi.fn() } };
    const promise = "broker" in composition
      ? composition.broker.invoke(composition.tool.id, {}, ctx)
      : composition.gateway.generateText({ task: "mixed.probe", prompt: "x", maxCostCents: 1 }, ctx);
    await expect(promise).rejects.toThrow("PLATFORM_EGRESS_PAID_CONTEXT_INVALID");
    expect(composition.budget.reserve).not.toHaveBeenCalled();
    expect("registryGet" in composition ? composition.registryGet : composition.route).not.toHaveBeenCalled();
  });
});
