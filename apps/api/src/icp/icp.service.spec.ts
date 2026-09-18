import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IcpService } from "./icp.service";
import * as BudgetExecution from "./icp-budget-execution";
import * as RuntimeBridge from "../model-runtime/structured-task-runtime-bridge";
import * as Cpv from "../discovery/icp-to-cpv";
import * as Fda from "../discovery/icp-to-fda";

const ctx = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  userId: "50000000-0000-4000-8000-000000000001",
  roles: [],
};
const binding = {
  authorityId: "30000000-0000-4000-8000-000000000001",
  replay: false,
  scopeKey: ctx.workspaceId,
  accountKey: "synthetic-account",
  purpose: "icp.design",
  subjectType: "company",
  subjectId: "company",
  requestSha256: "a".repeat(64),
};
function fixture() {
  const icp = {
    id: "icp-1",
    name: "Synthetic ICP",
    status: "HYPOTHESIS",
    companyId: "company",
    version: 2,
    companyAttributes: {} as unknown,
    targetMarkets: [],
    triggerSignals: [],
    exclusions: [],
    rules: [
      {
        id: "rule-1",
        kind: "MUST_HAVE",
        field: "country",
        operator: "eq",
        value: "DE",
        weight: 1,
      },
    ],
  };
  const tx = {
    companyProfile: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: "company",
          name: "Synthetic Seller",
          website: null,
        }),
    },
    claim: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ type: "product", statement: "Produces pumps" }]),
    },
    offering: { findMany: vi.fn().mockResolvedValue([]) },
    icpDefinition: {
      findUnique: vi.fn().mockResolvedValue(icp),
      findMany: vi.fn().mockResolvedValue([icp]),
      create: vi.fn().mockResolvedValue(icp),
      update: vi.fn().mockResolvedValue(icp),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    persona: { create: vi.fn().mockResolvedValue({}) },
    buyingCommitteeRole: { create: vi.fn().mockResolvedValue({}) },
    qualificationRule: {
      findUnique: vi.fn().mockResolvedValue({ id: "rule-1" }),
      create: vi.fn().mockResolvedValue({ id: "rule-1" }),
      update: vi.fn().mockResolvedValue({ id: "rule-1" }),
      delete: vi.fn().mockResolvedValue({}),
    },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    icpBacktest: {
      create: vi.fn(async ({ data }) => data),
      findMany: vi.fn().mockResolvedValue([]),
    },
    discoveryQueryPlan: {
      findUnique: vi.fn().mockResolvedValue({ id: "plan-1", status: "DRAFT" }),
      create: vi.fn(async ({ data }) => ({ id: "plan-1", ...data })),
      update: vi.fn().mockResolvedValue({ id: "plan-1", status: "READY" }),
      findMany: vi.fn().mockResolvedValue([]),
      findUniqueOrThrow: vi.fn(),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_workspace, operation) => operation(tx)),
  };
  const authority = {
    consumeWorkspaceGrant: vi.fn().mockResolvedValue(binding),
  };
  const gateway = {
    generateStructured: vi.fn(() => {
      throw new Error("unexpected external dispatch");
    }),
  };
  const service = new IcpService(
    prisma as never,
    gateway as never,
    {} as never,
    authority as never,
  );
  return { icp, tx, prisma, authority, gateway, service };
}
afterEach(() => vi.restoreAllMocks());

describe("ICP human state and workspace boundaries", () => {
  it("reads ICPs and their child records inside the selected workspace", async () => {
    const f = fixture();
    expect(await f.service.list(ctx)).toEqual([f.icp]);
    await f.service.list(ctx, "company");
    expect(await f.service.get(ctx, f.icp.id)).toBe(f.icp);
    await f.service.listBacktests(ctx, f.icp.id);
    await f.service.listQueryPlans(ctx, f.icp.id);
    expect(
      f.tx.icpDefinition.findMany.mock.calls.map(([args]) => args.where),
    ).toEqual([{}, { companyId: "company" }]);
    expect(
      f.prisma.withWorkspace.mock.calls.every(
        ([workspace]) => workspace === ctx.workspaceId,
      ),
    ).toBe(true);
  });
  it.each(["DRAFT", "HYPOTHESIS", "VALIDATING"])(
    "activates %s and supersedes prior active siblings before emitting the command",
    async (status) => {
      const f = fixture();
      f.icp.status = status;
      expect(await f.service.activate(ctx, f.icp.id)).toBe(f.icp);
      expect(f.tx.icpDefinition.updateMany).toHaveBeenCalledWith({
        where: {
          companyId: "company",
          status: "ACTIVE",
          id: { not: f.icp.id },
        },
        data: { status: "SUPERSEDED" },
      });
      expect(f.tx.icpDefinition.update).toHaveBeenCalledWith({
        where: { id: f.icp.id },
        data: { status: "ACTIVE", version: { increment: 1 } },
      });
      expect(f.tx.outboxEvent.create).toHaveBeenCalledWith({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: "ICPActivated",
          aggregateType: "ICP",
          aggregateId: f.icp.id,
          payload: { companyId: "company" },
        },
      });
    },
  );
  it.each(["ACTIVE", "SUPERSEDED", "ARCHIVED"])(
    "refuses activation from %s without another outbox event",
    async (status) => {
      const f = fixture();
      f.icp.status = status;
      await expect(f.service.activate(ctx, f.icp.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
    },
  );
  it.each(["get", "activate", "update", "runBacktest"] as const)(
    "returns not found from %s for a workspace-invisible ICP",
    async (operation) => {
      const f = fixture();
      f.tx.icpDefinition.findUnique.mockResolvedValue(null);
      const call =
        operation === "get"
          ? f.service.get(ctx, "other")
          : operation === "activate"
            ? f.service.activate(ctx, "other")
            : operation === "update"
              ? f.service.update(ctx, "other", {})
              : f.service.runBacktest(ctx, "other", []);
      await expect(call).rejects.toBeInstanceOf(NotFoundException);
      expect(f.tx.icpDefinition.update).not.toHaveBeenCalled();
    },
  );
  it.each(["SUPERSEDED", "ARCHIVED"])(
    "does not edit terminal %s records",
    async (status) => {
      const f = fixture();
      f.icp.status = status;
      await expect(
        f.service.update(ctx, f.icp.id, { name: "new" }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(f.tx.icpDefinition.update).not.toHaveBeenCalled();
    },
  );
  it("rejects stale optimistic version before any mutation", async () => {
    const f = fixture();
    await expect(f.service.update(ctx, f.icp.id, {}, 1)).rejects.toMatchObject({
      response: {
        error: { code: "VERSION_CONFLICT", details: { current: 2 } },
      },
    });
    expect(f.tx.icpDefinition.update).not.toHaveBeenCalled();
  });
  it("preserves explicit empty arrays and updates only supplied fields", async () => {
    const f = fixture();
    const patch = {
      name: "",
      companyAttributes: {},
      painPoints: [],
      triggerSignals: [],
      exclusions: [],
      valueProps: [],
      targetMarkets: [],
    };
    await f.service.update(ctx, f.icp.id, patch, 2);
    expect(f.tx.icpDefinition.update.mock.calls[0][0].data).toEqual({
      ...patch,
      version: { increment: 1 },
    });
    await f.service.update(ctx, f.icp.id, {});
    expect(f.tx.icpDefinition.update.mock.calls[1][0].data).toEqual({
      version: { increment: 1 },
    });
  });
});

describe("ICP qualification-rule editing and deterministic backtest", () => {
  const rule = {
    kind: "must_have",
    field: "country",
    operator: "eq",
    value: "DE",
  };
  it.each([
    { ...rule, kind: "OTHER" },
    { ...rule, operator: "arbitrary-sql" },
  ])(
    "rejects malformed rule proposals before database access",
    async (input) => {
      const f = fixture();
      await expect(f.service.addRule(ctx, "icp", input)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(f.prisma.withWorkspace).not.toHaveBeenCalled();
    },
  );
  it("requires an existing visible ICP before adding a rule", async () => {
    const f = fixture();
    f.tx.icpDefinition.findUnique.mockResolvedValue(null);
    await expect(f.service.addRule(ctx, "icp", rule)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.tx.qualificationRule.create).not.toHaveBeenCalled();
  });
  it("normalizes rule kind and preserves explicit weight and rationale", async () => {
    const f = fixture();
    await f.service.addRule(ctx, "icp", { ...rule, value: undefined });
    await f.service.addRule(ctx, "icp", { ...rule, weight: 0, rationale: "" });
    expect(f.tx.qualificationRule.create.mock.calls[0][0].data).toMatchObject({
      kind: "MUST_HAVE",
      value: null,
      weight: 1,
      rationale: null,
    });
    expect(f.tx.qualificationRule.create.mock.calls[1][0].data).toMatchObject({
      value: "DE",
      weight: 0,
      rationale: "",
    });
  });
  it.each(["update", "delete"])(
    "refuses %s of a workspace-invisible rule",
    async (operation) => {
      const f = fixture();
      f.tx.qualificationRule.findUnique.mockResolvedValue(null);
      await expect(
        operation === "update"
          ? f.service.updateRule(ctx, "other", {})
          : f.service.deleteRule(ctx, "other"),
      ).rejects.toBeInstanceOf(NotFoundException);
    },
  );
  it("edits selected rule fields while preserving explicit null, zero and empty rationale", async () => {
    const f = fixture();
    const patch = {
      kind: "nice_to_have",
      field: "size",
      operator: "gte",
      value: null,
      weight: 0,
      rationale: "",
    };
    await f.service.updateRule(ctx, "rule", patch);
    expect(f.tx.qualificationRule.update.mock.calls[0][0].data).toEqual({
      ...patch,
      kind: "NICE_TO_HAVE",
      version: { increment: 1 },
    });
    await f.service.updateRule(ctx, "rule", {});
    await f.service.updateRule(ctx, "rule", { operator: "eq" });
    await f.service.updateRule(ctx, "rule", { kind: "exclusion" });
    expect(f.tx.qualificationRule.update.mock.calls[1][0].data).toEqual({
      version: { increment: 1 },
    });
    expect(await f.service.deleteRule(ctx, "rule")).toEqual({ deleted: true });
  });
  it("requires rules before claiming validation evidence", async () => {
    const f = fixture();
    f.icp.rules = [];
    await expect(
      f.service.runBacktest(ctx, f.icp.id, []),
    ).rejects.toMatchObject({ response: { error: { code: "NO_RULES" } } });
    expect(f.tx.icpBacktest.create).not.toHaveBeenCalled();
  });
  it("records correct match and exclude evidence while moving a hypothesis to validating", async () => {
    const f = fixture();
    const result = await f.service.runBacktest(ctx, f.icp.id, [
      {
        name: "match",
        domain: "example.test",
        attributes: { country: "DE" },
        expected: "match",
      },
      { name: "exclude", attributes: { country: "FR" }, expected: "exclude" },
    ]);
    expect(result.metrics).toMatchObject({
      matchHitRate: 1,
      excludeCatchRate: 1,
      unknownFieldRate: 0,
      recommendation: "promote",
    });
    expect(f.tx.icpDefinition.update).toHaveBeenCalledWith({
      where: { id: f.icp.id },
      data: { status: "VALIDATING" },
    });
  });
  it.each(["match", "exclude"] as const)(
    "recommends revision on failed expected %s samples without auto-activating",
    async (expected) => {
      const f = fixture();
      f.icp.status = "ACTIVE";
      const result = await f.service.runBacktest(ctx, f.icp.id, [
        {
          name: "incorrect",
          attributes: { country: expected === "match" ? "FR" : "DE" },
          expected,
        },
      ]);
      expect(result.metrics).toMatchObject({ recommendation: "revise" });
      expect(f.tx.icpDefinition.update).not.toHaveBeenCalled();
    },
  );
  it("reports unknown and empty sample metrics explicitly", async () => {
    const f = fixture();
    const unknown = await f.service.runBacktest(ctx, f.icp.id, [
      { name: "unknown", attributes: undefined, expected: "match" },
    ] as never);
    expect(unknown.metrics).toMatchObject({ unknownFieldRate: 1 });
    const empty = await f.service.runBacktest(ctx, f.icp.id, []);
    expect(empty.metrics).toEqual({
      matchHitRate: null,
      excludeCatchRate: null,
      unknownFieldRate: null,
      recommendation: "promote",
    });
  });
  it.each(["missing", "READY"])(
    "does not confirm a %s query plan",
    async (state) => {
      const f = fixture();
      f.tx.discoveryQueryPlan.findUnique.mockResolvedValue(
        state === "missing" ? null : { status: state },
      );
      await expect(f.service.confirmQueryPlan(ctx, "plan")).rejects.toThrow();
      expect(f.tx.discoveryQueryPlan.update).not.toHaveBeenCalled();
    },
  );
  it("requires human confirmation to advance a DRAFT query plan", async () => {
    const f = fixture();
    expect(await f.service.confirmQueryPlan(ctx, "plan-1")).toMatchObject({
      status: "READY",
    });
    expect(f.tx.discoveryQueryPlan.update).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: { status: "READY", version: { increment: 1 } },
    });
  });
});

function generationFixture() {
  const f = fixture();
  const result: { data: Record<string, unknown> } = { data: {} };
  const runtime = vi
    .spyOn(RuntimeBridge, "executeStructuredTaskWithRuntime")
    .mockImplementation(async () => result as never);
  vi.spyOn(BudgetExecution, "executeIcpBudgetedTask").mockImplementation(
    async (input) => input.execute({} as never),
  );
  const cpv = vi
    .spyOn(Cpv, "resolveIcpToCpv")
    .mockResolvedValue({ cpvCodes: [], buyerCountries: [], warnings: [] });
  const fda = vi
    .spyOn(Fda, "resolveIcpToFda")
    .mockResolvedValue({
      productCodes: [],
      panels: [],
      importerOnly: true,
      establishmentTypes: [],
      warnings: [],
    });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { ...f, result, runtime, cpv, fda };
}
describe("ICP generation authority and controlled enrichment", () => {
  it.each(["company", "claims"])(
    "rejects missing %s evidence without model execution",
    async (missing) => {
      const f = generationFixture();
      if (missing === "company")
        f.tx.companyProfile.findUnique.mockResolvedValue(null);
      else f.tx.claim.findMany.mockResolvedValue([]);
      await expect(
        f.service.generateFromCompany(ctx, "company"),
      ).rejects.toThrow();
      expect(f.runtime).not.toHaveBeenCalled();
    },
  );
  it("refuses a consumed grant before reading tenant data", async () => {
    const f = generationFixture();
    f.authority.consumeWorkspaceGrant.mockResolvedValue({
      ...binding,
      replay: true,
    });
    await expect(f.service.generateFromCompany(ctx, "company")).rejects.toThrow(
      "REUSED",
    );
    expect(f.prisma.withWorkspace).not.toHaveBeenCalled();
  });
  it("stores missing optional generation fields with stable defaults", async () => {
    const f = generationFixture();
    await f.service.generateFromCompany(ctx, "company");
    expect(f.tx.icpDefinition.create.mock.calls[0][0].data).toMatchObject({
      name: "未命名 ICP",
      status: "HYPOTHESIS",
      companyAttributes: [],
      painPoints: [],
    });
    expect(f.tx.persona.create).not.toHaveBeenCalled();
  });
  it("includes approved facts and offerings but discards invalid proposed rules", async () => {
    const f = generationFixture();
    f.tx.companyProfile.findUnique.mockResolvedValue({
      name: "Synthetic Seller",
      website: "https://example.test",
    });
    f.tx.offering.findMany.mockResolvedValue([
      { name: "pump", description: "industrial" },
      { name: "valve", description: null },
    ]);
    f.result.data = {
      name: "Generated",
      company_attributes: {},
      pain_points: [],
      trigger_signals: [],
      exclusions: [],
      value_props: [],
      target_markets: [],
      personas: [{ title: "Buyer", goals: [], pain_points: null }],
      buying_committee: [{ role: "buyer", title: "Director", concerns: [] }],
      qualification_rules: [
        { kind: "MUST_HAVE", field: "country", operator: "eq" },
        {
          kind: "nice_to_have",
          field: "country",
          operator: "eq",
          value: "DE",
          weight: 0,
          rationale: "",
        },
        { kind: "unsupported", operator: "eq" },
        { kind: "MUST_HAVE", operator: "unsupported" },
      ],
    };
    await f.service.generateFromCompany(ctx, "company");
    const prompt = f.runtime.mock.calls[0][1].prompt;
    expect(prompt).toContain("https://example.test");
    expect(prompt).toContain("industrial");
    expect(f.tx.qualificationRule.create).toHaveBeenCalledTimes(2);
    expect(f.tx.persona.create).toHaveBeenCalledOnce();
    expect(f.tx.buyingCommitteeRole.create).toHaveBeenCalledOnce();
  });
  it.each(["missing", "HYPOTHESIS"])(
    "refuses query generation for %s ICP",
    async (status) => {
      const f = generationFixture();
      f.tx.icpDefinition.findUnique.mockResolvedValue(
        status === "missing" ? null : { ...f.icp, status },
      );
      await expect(f.service.generateQueryPlan(ctx, "icp-1")).rejects.toThrow();
      expect(f.runtime).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 2.6])(
    "stores a draft query plan with bounded estimated-volume representation %s",
    async (volume) => {
      const f = generationFixture();
      f.icp.status = "ACTIVE";
      f.result.data = { estimated_volume: volume };
      const plan = await f.service.generateQueryPlan(ctx, f.icp.id);
      expect(plan).toMatchObject({
        status: "DRAFT",
        estimatedVolume: volume === undefined ? null : 3,
      });
    },
  );
  it("injects deterministic TED/FDA facts from the taxonomy mapping, preserving seller filters", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.icp.companyAttributes = {
      industry: "devices",
      product: "pump",
      trade_side: "importer",
    };
    f.cpv.mockResolvedValue({
      cpvCodes: ["42120000"],
      buyerCountries: ["DEU"],
      warnings: [],
    });
    f.fda.mockResolvedValue({
      productCodes: ["ABC"],
      panels: ["CV"],
      importerOnly: true,
      establishmentTypes: [],
      warnings: [],
    });
    const plan = await f.service.generateQueryPlan(ctx, f.icp.id);
    expect(plan.queries).toHaveLength(2);
    expect(f.cpv.mock.calls[0][1]).toMatchObject({ product: "pump" });
    expect(f.fda.mock.calls[0][1]).toMatchObject({ tradeSide: "importer" });
  });
  it.each(["cpv", "fda"] as const)(
    "preserves a plan after ordinary %s resolver failure",
    async (resolver) => {
      const f = generationFixture();
      f.icp.status = "ACTIVE";
      f.icp.companyAttributes = null;
      f[resolver].mockRejectedValue(new Error("synthetic unavailable"));
      expect(await f.service.generateQueryPlan(ctx, f.icp.id)).toMatchObject({
        status: "DRAFT",
      });
    },
  );
  it.each([{ code: "BUDGET_EXCEEDED" }, { code: "EXECUTION_BUDGET_EXPIRED" }])(
    "propagates budget control errors instead of converting to partial success",
    async (failure) => {
      const f = generationFixture();
      f.icp.status = "ACTIVE";
      f.cpv.mockRejectedValue(failure);
      await expect(f.service.generateQueryPlan(ctx, f.icp.id)).rejects.toBe(
        failure,
      );
      expect(f.tx.discoveryQueryPlan.create).not.toHaveBeenCalled();
      f.cpv.mockResolvedValue({
        cpvCodes: [],
        buyerCountries: [],
        warnings: [],
      });
      f.fda.mockRejectedValue(failure);
      await expect(f.service.generateQueryPlan(ctx, f.icp.id)).rejects.toBe(
        failure,
      );
    },
  );
  it.each([
    null,
    "synthetic failure",
    { code: 123 },
    { code: "ORDINARY_FAILURE" },
  ])(
    "keeps non-control resolver failures distinct from budget denial",
    async (failure) => {
      const f = generationFixture();
      f.icp.status = "ACTIVE";
      f.cpv.mockRejectedValue(failure);
      expect(await f.service.generateQueryPlan(ctx, f.icp.id)).toMatchObject({
        status: "DRAFT",
      });
    },
  );
});
