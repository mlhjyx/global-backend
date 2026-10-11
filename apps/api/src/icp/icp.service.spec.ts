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
import { DiscoveryProviderRegistry } from "../discovery/provider.registry";

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
    // data_provider kill switch: only public_web is ENABLED, as on the dev host.
    dataProvider: {
      findMany: vi.fn(async () => enabledProviders.map((key) => ({ key }))),
    },
  };
  const enabledProviders = ["public_web"];
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
  const providers = new DiscoveryProviderRegistry({ gateway: gateway as never });
  const service = new IcpService(
    prisma as never,
    gateway as never,
    {} as never,
    authority as never,
    providers,
  );
  const enable = (...keys: string[]) => enabledProviders.splice(0, enabledProviders.length, ...keys);
  /** As if `keys` declared governed company lineage, as TED and openFDA will once theirs lands. */
  const declareLineage = (...keys: string[]) => {
    const registered = providers.companyDiscoverySources.bind(providers);
    vi.spyOn(providers, "companyDiscoverySources").mockImplementation(() =>
      registered().map((source) =>
        keys.includes(source.providerKey) ? { ...source, hasCompanyLineage: true } : source));
  };
  return { icp, tx, prisma, authority, gateway, service, enable, declareLineage };
}

/** One planner query for keyword discovery, the only source ENABLED on the dev host. */
const PUBLIC_WEB_QUERY = Object.freeze({
  source_class: "public_intelligence",
  filters: { industry: "Pumpen", country: "Germany", source_hint: "public_web" },
  keywords: ["Kreiselpumpen"],
  rationale: "keyword discovery",
  priority: 2,
});
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
      f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: volume };
      const plan = await f.service.generateQueryPlan(ctx, f.icp.id);
      expect(plan).toMatchObject({
        status: "DRAFT",
        estimatedVolume: volume === undefined ? null : 3,
      });
    },
  );
  it.each([
    ["no provider row", []],
    ["only a non-discovery provider", ["gleif", "decision_maker"]],
    ["only the cold-path sources", ["ted", "openfda"]],
    ["only sources without governed lineage", ["wikidata", "openstreetmap", "ted", "openfda"]],
  ])(
    "refuses to plan with %s ENABLED, before any model call (BI-30)",
    async (_label, enabled) => {
      const f = generationFixture();
      f.icp.status = "ACTIVE";
      f.enable(...enabled);

      await expect(f.service.generateQueryPlan(ctx, f.icp.id)).rejects.toMatchObject({
        status: 409,
        response: {
          error: {
            code: "NO_ENABLED_DISCOVERY_SOURCE",
            message: "no ENABLED discovery data source with governed company lineage that the query planner can use",
          },
        },
      });
      expect(f.runtime).not.toHaveBeenCalled();
      expect(f.cpv).not.toHaveBeenCalled();
      expect(f.tx.discoveryQueryPlan.create).not.toHaveBeenCalled();
    },
  );
  it("tells the planner which sources it may use and nothing about the others (BI-30)", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: 10 };

    await f.service.generateQueryPlan(ctx, f.icp.id);

    const prompt = f.runtime.mock.calls[0]![1].prompt as string;
    expect(prompt).toContain("source_hint=public_web");
    expect(prompt).toContain("不要为表外的数据源出查询");
    for (const disabled of ["wikidata", "openstreetmap", "directory", "trade_fair", "openfda"]) {
      expect(prompt).not.toContain(disabled);
    }
    expect(prompt).not.toMatch(/\bted\b/u);
  });
  it("keeps only queries for ENABLED sources, names each query's source and scales the estimate (BI-30)", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.result.data = {
      estimated_volume: 1_000,
      queries: [
        { ...PUBLIC_WEB_QUERY, filters: { industry: "Pumpen", country: "Germany" } },
        { ...PUBLIC_WEB_QUERY, source_class: "industry_data", filters: { source_hint: "directory" } },
        { ...PUBLIC_WEB_QUERY, source_class: "industry_data", filters: { source_hint: "trade_fair" } },
        { ...PUBLIC_WEB_QUERY, filters: { source_hint: "ted" } },
        { ...PUBLIC_WEB_QUERY, source_class: "trade_data", filters: {} },
      ],
    };

    const plan = await f.service.generateQueryPlan(ctx, f.icp.id);

    const queries = plan.queries as Array<{ source_class: string; filters: Record<string, unknown>; rationale: string }>;
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({
      source_class: "public_intelligence",
      filters: { industry: "Pumpen", country: "Germany", source_hint: "public_web" },
    });
    expect(queries[0]!.rationale).toContain(
      "[source_filter] 已移出 4 条规划查询：SOURCE_DISABLED 2 条、SOURCE_UNKNOWN 1 条、SOURCE_SYSTEM_PLANNED 1 条",
    );
    // One of five planned queries will run: the estimate covers that one only.
    expect(plan).toMatchObject({ status: "DRAFT", estimatedVolume: 200 });
  });
  it("neither resolves nor injects TED or openFDA queries while those sources are DISABLED (BI-30)", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.icp.companyAttributes = { industry: "devices", product: "pump", trade_side: "importer" };
    f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: 10 };
    f.cpv.mockResolvedValue({ cpvCodes: ["42120000"], buyerCountries: ["DEU"], warnings: [] });
    f.fda.mockResolvedValue({
      productCodes: ["ABC"], panels: ["CV"], importerOnly: true, establishmentTypes: [], warnings: [],
    });

    const plan = await f.service.generateQueryPlan(ctx, f.icp.id);

    expect(f.cpv).not.toHaveBeenCalled();
    expect(f.fda).not.toHaveBeenCalled();
    expect((plan.queries as Array<{ filters: { source_hint: string } }>).map((q) => q.filters.source_hint))
      .toEqual(["public_web"]);
  });
  it("neither resolves nor injects TED or openFDA queries while they lack governed lineage, even ENABLED (lineage gate)", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.enable("public_web", "ted", "openfda");
    f.icp.companyAttributes = { industry: "devices", product: "pump", trade_side: "importer" };
    f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: 10 };
    f.cpv.mockResolvedValue({ cpvCodes: ["42120000"], buyerCountries: ["DEU"], warnings: [] });
    f.fda.mockResolvedValue({
      productCodes: ["ABC"], panels: ["CV"], importerOnly: true, establishmentTypes: [], warnings: [],
    });

    const plan = await f.service.generateQueryPlan(ctx, f.icp.id);

    expect(f.cpv).not.toHaveBeenCalled();
    expect(f.fda).not.toHaveBeenCalled();
    const queries = plan.queries as Array<{ filters: { source_hint: string }; rationale: string }>;
    expect(queries.map((q) => q.filters.source_hint)).toEqual(["public_web"]);
    // The plan review sees why the ENABLED cold-path sources added nothing.
    expect(queries[0]!.rationale).toBe(
      "keyword discovery\n[source_filter] 已移出 2 条规划查询：SOURCE_LINEAGE_UNAVAILABLE 2 条",
    );
  });
  it("keeps an ENABLED source without governed lineage out of the prompt and the plan, with its own reason (lineage gate)", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.enable("public_web", "wikidata", "openstreetmap");
    f.result.data = {
      estimated_volume: 10,
      queries: [
        PUBLIC_WEB_QUERY,
        { ...PUBLIC_WEB_QUERY, source_class: "company_registry", filters: { source_hint: "wikidata" } },
      ],
    };

    const plan = await f.service.generateQueryPlan(ctx, f.icp.id);

    const prompt = f.runtime.mock.calls[0]![1].prompt as string;
    expect(prompt).not.toContain("wikidata");
    expect(prompt).not.toContain("openstreetmap");
    const queries = plan.queries as Array<{ filters: Record<string, unknown>; rationale: string }>;
    expect(queries.map((q) => q.filters.source_hint)).toEqual(["public_web"]);
    expect(queries[0]!.rationale).toBe(
      "keyword discovery\n[source_filter] 已移出 1 条规划查询：SOURCE_LINEAGE_UNAVAILABLE 1 条",
    );
  });
  it("notes the left-out planner queries on the first planner query, not on an injected one (BI-30)", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.enable("public_web", "ted");
    f.declareLineage("ted");
    f.result.data = {
      estimated_volume: 10,
      queries: [
        PUBLIC_WEB_QUERY,
        { ...PUBLIC_WEB_QUERY, source_class: "industry_data", filters: { source_hint: "directory" } },
      ],
    };
    f.cpv.mockResolvedValue({ cpvCodes: ["42120000"], buyerCountries: ["DEU"], warnings: [] });

    const plan = await f.service.generateQueryPlan(ctx, f.icp.id);

    const queries = plan.queries as Array<{ filters: Record<string, unknown>; rationale: string }>;
    expect(queries.map((q) => q.filters.source_hint)).toEqual(["ted", "public_web"]);
    expect(queries[0]!.rationale).not.toContain("[source_filter]");
    expect(queries[1]!.rationale).toBe(
      "keyword discovery\n[source_filter] 已移出 1 条规划查询：SOURCE_DISABLED 1 条",
    );
  });
  it("keeps an injected TED query as the whole plan, with the note, when no planner query can run (BI-30)", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.enable("public_web", "ted");
    f.declareLineage("ted");
    f.result.data = {
      estimated_volume: 10,
      queries: [{ ...PUBLIC_WEB_QUERY, source_class: "trade_data", filters: {} }],
    };
    f.cpv.mockResolvedValue({ cpvCodes: ["42120000"], buyerCountries: ["DEU"], warnings: [] });

    const plan = await f.service.generateQueryPlan(ctx, f.icp.id);

    const queries = plan.queries as Array<{ filters: Record<string, unknown>; rationale: string }>;
    expect(queries).toHaveLength(1);
    expect(queries[0]!.filters).toMatchObject({ source_hint: "ted", cpv: "42120000" });
    expect(queries[0]!.rationale).toContain("[source_filter] 已移出 1 条规划查询：SOURCE_UNKNOWN 1 条");
    // The model's estimate covered only queries that will not run: the scale is unknown.
    expect(plan).toMatchObject({ estimatedVolume: null });
  });
  it("fails with NO_RUNNABLE_QUERIES and stores no plan when no planned query can run (BI-30)", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.result.data = {
      estimated_volume: 50,
      queries: [{ ...PUBLIC_WEB_QUERY, source_class: "company_registry", filters: { source_hint: "wikidata" } }],
    };

    await expect(f.service.generateQueryPlan(ctx, f.icp.id)).rejects.toMatchObject({
      status: 409,
      response: { error: { code: "NO_RUNNABLE_QUERIES" } },
    });
    expect(f.runtime).toHaveBeenCalledOnce();
    expect(f.tx.discoveryQueryPlan.create).not.toHaveBeenCalled();
  });
  it("asks the planner for keywords in the target market's language instead of Chinese", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    Object.assign(f.icp, { targetMarkets: ["德国", "奥地利", "瑞士（德语区优先）"] });
    f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: 1 };
    await f.service.generateQueryPlan(ctx, f.icp.id);
    const prompt = f.runtime.mock.calls[0]![1].prompt as string;
    expect(prompt).toContain("keywords");
    expect(prompt).toContain("必须全部用德语书写");
    expect(prompt).toContain("不得出现中文");
    expect(prompt).toContain("输出中文 rationale");
  });
  it("ties each query's keywords to its own country when the ICP spans several languages", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    Object.assign(f.icp, { targetMarkets: ["德国", "法国"] });
    f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: 1 };
    await f.service.generateQueryPlan(ctx, f.icp.id);
    const prompt = f.runtime.mock.calls[0]![1].prompt as string;
    expect(prompt).toContain("每条查询的 keywords 必须用该查询 filters.country 所在国家的语言书写");
    expect(prompt).toContain("德语、法语");
    expect(prompt).toContain("不得出现中文");
  });
  it("names the local language generically when no target market is recognised", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    Object.assign(f.icp, { targetMarkets: ["火星"] });
    f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: 1 };
    await f.service.generateQueryPlan(ctx, f.icp.id);
    const prompt = f.runtime.mock.calls[0]![1].prompt as string;
    expect(prompt).toContain("必须全部用目标市场的当地语言书写");
    expect(prompt).toContain("无法确定时用英语");
    expect(prompt).toContain("不得出现中文");
  });
  it("expands a DACH target market to Germany, Austria and Switzerland for the planner and its cold paths", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.enable("public_web", "ted", "openfda");
    f.declareLineage("ted", "openfda");
    Object.assign(f.icp, { targetMarkets: ["DACH区域"] });
    f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: 1 };
    await f.service.generateQueryPlan(ctx, f.icp.id);
    const prompt = f.runtime.mock.calls[0]![1].prompt as string;
    expect(prompt).toContain("必须全部用德语书写");
    expect(prompt).not.toContain("无法确定时用英语");
    expect(f.cpv.mock.calls[0]![1]).toMatchObject({ targetCountries: ["DE", "AT", "CH"] });
    expect(f.fda.mock.calls[0]![1]).toMatchObject({ targetCountries: ["DE", "AT", "CH"] });
  });
  it("injects deterministic TED/FDA facts from the taxonomy mapping, preserving seller filters", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.enable("public_web", "ted", "openfda");
    f.declareLineage("ted", "openfda");
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
  it("carries the ICP trade role into planner queries before the cold-path injections", async () => {
    const f = generationFixture();
    f.icp.status = "ACTIVE";
    f.enable("public_web", "ted");
    f.declareLineage("ted");
    f.icp.companyAttributes = { industry: "Pumpen", business_model: "Großhandel" };
    f.result.data = {
      estimated_volume: 20,
      queries: [
        {
          source_class: "public_intelligence",
          filters: { industry: "Pumpen", country: "Germany" },
          keywords: ["Kreiselpumpen"],
          rationale: "keyword discovery",
          priority: 2,
        },
      ],
    };
    f.cpv.mockResolvedValue({
      cpvCodes: ["42120000"],
      buyerCountries: ["DEU"],
      warnings: [],
    });
    const plan = await f.service.generateQueryPlan(ctx, f.icp.id);
    const queries = plan.queries as Array<{ filters: Record<string, unknown> }>;
    expect(queries).toHaveLength(2);
    expect(queries[0]!.filters).toMatchObject({ source_hint: "ted" });
    expect(queries[0]!.filters).not.toHaveProperty("trade_side");
    expect(queries[1]!.filters).toMatchObject({
      industry: "Pumpen",
      trade_side: "distributor",
    });
  });
  it.each(["cpv", "fda"] as const)(
    "preserves a plan after ordinary %s resolver failure",
    async (resolver) => {
      const f = generationFixture();
      f.icp.status = "ACTIVE";
      f.enable("public_web", "ted", "openfda");
      f.declareLineage("ted", "openfda");
      f.icp.companyAttributes = null;
      f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: 10 };
      f[resolver].mockRejectedValue(new Error("synthetic unavailable"));
      expect(await f.service.generateQueryPlan(ctx, f.icp.id)).toMatchObject({
        status: "DRAFT",
      });
      expect(f[resolver]).toHaveBeenCalledOnce();
    },
  );
  it.each([{ code: "BUDGET_EXCEEDED" }, { code: "EXECUTION_BUDGET_EXPIRED" }])(
    "propagates budget control errors instead of converting to partial success",
    async (failure) => {
      const f = generationFixture();
      f.icp.status = "ACTIVE";
      f.enable("public_web", "ted", "openfda");
      f.declareLineage("ted", "openfda");
      f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: 10 };
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
      f.enable("public_web", "ted");
      f.declareLineage("ted");
      f.result.data = { queries: [PUBLIC_WEB_QUERY], estimated_volume: 10 };
      f.cpv.mockRejectedValue(failure);
      expect(await f.service.generateQueryPlan(ctx, f.icp.id)).toMatchObject({
        status: "DRAFT",
      });
    },
  );
});
