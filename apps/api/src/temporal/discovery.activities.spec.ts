import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createDiscoveryActivities } from "./discovery.activities";
import { resolveRunStatus } from "./discovery.run-status";
import {
  BudgetLedger,
  InMemoryBudgetStoreAdapter,
  TestBudgetExceededError as BudgetExceededError,
} from "@global/test-support";
import {
  BudgetOperationReplayError,
  BudgetUnsettledOperationsError,
  type BudgetStore,
} from "../tools/budget-store";

const budgetLedger = new BudgetLedger();
import type {
  CompanyDiscoveryAdapter,
  EnrichmentResult,
  ExecutionContext,
  ProviderCompanyRecord,
} from "../discovery/provider-contract";
import type { DurableExecutionReceipt } from "../durable-results/durable-execution-receipt";
import { DISCOVERY_COMPANY_RESULT_LINEAGE_V1 } from "../discovery/company-discovery-lineage";

const acknowledgementMocks = vi.hoisted(() => ({
  apply: vi.fn(
    async (input: {
      transaction: unknown;
      acknowledgements: Array<{ producerId: string }>;
      apply: (transaction: unknown) => Promise<unknown>;
    }) => ({
      status: "APPLIED",
      acknowledgements: input.acknowledgements.map(({ producerId }) => ({
        producerId,
        status: "APPLIED",
      })),
      value: await input.apply(input.transaction),
    }),
  ),
}));
const fitRuntimeMocks = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("@temporalio/activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@temporalio/activity")>()),
  heartbeat: vi.fn(),
}));

vi.mock("../model-runtime/structured-task-runtime-bridge", () => ({
  executeStructuredTaskWithRuntime: fitRuntimeMocks.execute,
}));

vi.mock("../durable-results/domain-ack-consumer-bindings", () => ({
  applyDomainAckConsumerTransactions: acknowledgementMocks.apply,
  applyPartitionedDomainAckConsumerTransactions: async (input: {
    transaction: unknown;
    apply: (
      transaction: unknown,
      companyFacts: readonly unknown[],
      auxiliaryFacts: readonly unknown[],
    ) => Promise<unknown>;
  }) => ({
    status: "APPLIED",
    companyFacts: [],
    auxiliaryFacts: [],
    value: await input.apply(input.transaction, [], []),
  }),
  applyDomainAckConsumerTransaction: async (input: {
    transaction: unknown;
    apply: (transaction: unknown) => Promise<unknown>;
  }) => input.apply(input.transaction),
}));

/**
 * executeQuery 预算截断透传单测（Codex PR #51 P1，根治版）：fan-out 中某源打穿 run 预算时，**真实 provider
 * 的 fail-safe catch 会把 BudgetExceededError 吞成空结果**（对源失败是对的）——所以 executeQuery 不能靠
 * 「某源 reject」判断，必须靠 BudgetLedger.wasExhausted 检出，据此返回 budgetTruncated 让 workflow 判 PARTIAL
 * 而非 DONE。本测用一个「reserve 打穿 → 自己吞掉」的假 adapter 复刻生产形态（而非直接抛错的合成 mock）。
 */

const REC: ProviderCompanyRecord = {
  externalId: "wikidata:Q1",
  name: "Acme GmbH",
  domain: "acme.de",
  attributes: {
    wikidata_qid: "Q1",
    source_class: "company_registry",
  },
  license: "CC0-1.0",
  provenance: {
    sourceUrl: "https://www.wikidata.org/wiki/Q1",
    fetchedAt: "2026-07-11T00:00:00.000Z",
    contentHash: "a".repeat(64),
    parserVersion: "wikidata/1",
  },
};

/** 模拟真实 provider：broker/gateway 的 reserve 打穿预算 → provider 自己 fail-safe 吞成空结果（不透传）。 */
function budgetSwallowingAdapter(key: string): CompanyDiscoveryAdapter {
  return {
    key,
    classes: ["public_intelligence"],
    discoverCompanies: async (_q: unknown, ctx: ExecutionContext) => {
      try {
        budgetLedger.reserve(ctx.runId ?? ctx.workspaceId, 10_000_000); // 远超 cap → 打穿
      } catch {
        /* 如真实 provider：fail-safe catch 吞掉 BudgetExceededError */
      }
      return { records: [], costCents: 0 };
    },
  } as unknown as CompanyDiscoveryAdapter;
}

function okAdapter(
  key: string,
  records: ProviderCompanyRecord[],
): CompanyDiscoveryAdapter {
  return {
    key,
    classes: ["public_intelligence"],
    discoverCompanies: async () => ({ records, costCents: 0 }),
  } as unknown as CompanyDiscoveryAdapter;
}

function makeDeps(adapters: CompanyDiscoveryAdapter[]) {
  const rows: Array<Record<string, unknown>> = [];
  let runStats: Record<string, unknown> = {};
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async (statement: {
      strings?: readonly string[];
      values: readonly unknown[];
    }) => {
      const sql = statement.strings?.join("?") ?? "";
      if (sql.includes("attest_discovery_query_lineage_v2")) {
        return [{
          status: "NOT_FOUND",
          query_receipt: null,
          budget_truncated: null,
          attempt_count: 0,
          item_count: 0,
          replay: false,
        }];
      }
      if (sql.includes("append_discovery_query_lineage_v2")) {
        const command = JSON.parse(String(statement.values[0])) as {
          lookup: { queryKey: string };
        };
        return [{
          status: "APPLIED",
          attempt_count: 0,
          item_count: 0,
          query_key: command.lookup.queryKey,
        }];
      }
      if (sql.includes("FROM discovery_run")) {
        return [
          {
            id: String(statement.values[0]),
            plan_id: "50000000-0000-4000-8000-000000000001",
            stats: runStats,
          },
        ];
      }
      const command = JSON.parse(String(statement.values[0])) as Record<
        string,
        unknown
      >;
      const databasePayloadHash = "f".repeat(64);
      const databasePayloadBytes = Buffer.byteLength(
        JSON.stringify(command.payload),
        "utf8",
      );
      const row = {
        id: `raw-${rows.length + 1}`,
        externalId: command.externalId,
        ingestKey: command.ingestKey,
        payloadHash: databasePayloadHash,
        payload: command.payload,
        ingestStatus: command.ingestStatus,
        sourceClass: command.sourceClass,
        ingestVersion: "raw-source/v2",
      };
      rows.push(row);
      return [
        {
          raw_record_id: row.id,
          payload_hash: databasePayloadHash,
          payload_bytes: databasePayloadBytes,
          ingest_status: command.ingestStatus,
          inserted: true,
        },
      ];
    },
    discoveryRun: {
      update: async ({
        data,
      }: {
        data: { stats: Record<string, unknown> };
      }) => {
        runStats = data.stats;
        return {};
      },
    },
    rawSourceRecord: {
      findMany: async () => rows,
      count: async ({ where }: { where: { ingestStatus?: string } }) =>
        rows.filter(
          (row) =>
            !where.ingestStatus || row.ingestStatus === where.ingestStatus,
        ).length,
    },
    usageLedger: { create: async () => ({}) },
  };
  const prisma = {
    sourcePolicy: {
      findMany: async () => [
        {
          id: "policy-acme",
          domain: "wikidata.org",
          retentionDays: 365,
          reviewStatus: "APPROVED",
          allowedPurpose: ["discovery"],
          updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        },
      ],
    },
    withWorkspace: async <T>(
      _ws: string,
      fn: (tx: unknown) => Promise<T>,
    ): Promise<T> => fn(tx),
  };
  const providers = { routeCompanyDiscovery: async () => adapters };
  return {
    prisma,
    providers,
    gateway: {},
    budgetStore: authorityBudgetStore(),
  } as unknown as Parameters<typeof createDiscoveryActivities>[0];
}

const QUERY = {
  source_class: "public_intelligence",
  filters: {},
  keywords: [],
  priority: 1,
};
const QUERY_RECEIPT_MODE = "raw-governance-query-receipt/v1" as const;
const DISCOVERY_BINDING = Object.freeze({
  authorityId: "20000000-0000-4000-8000-000000000002",
  replay: false,
  scopeKey: "10000000-0000-4000-8000-000000000001",
  accountKey: `discovery.run:discovery_run:request:${"a".repeat(64)}:${"a".repeat(64)}`,
  purpose: "discovery.run" as const,
  subjectType: "discovery_run",
  subjectId: `request:${"a".repeat(64)}`,
  requestSha256: "a".repeat(64),
});

const ENRICHMENT_RECEIPT: DurableExecutionReceipt = Object.freeze({
  schemaVersion: "durable-execution-receipt/v1",
  scopeKey: DISCOVERY_BINDING.scopeKey,
  authorityId: DISCOVERY_BINDING.authorityId,
  accountId: "30000000-0000-4000-8000-000000000001",
  operationId: "40000000-0000-4000-8000-000000000001",
  operationKey: "discovery-gleif-enrichment",
  resultStrategy: "typed_projection",
  resultSchema: "gleif-fetch/v1",
  resultDigest: "a".repeat(64),
  artifactId: null,
  usage: {
    currency: "USD",
    unit: "microusd",
    callCount: 1,
    upperBoundMicrousd: "10000",
  },
  costBasis: "estimated_upper_bound",
});

function authorityBudgetStore(): BudgetStore {
  const store = new InMemoryBudgetStoreAdapter(budgetLedger);
  if (
    !Number.isFinite(budgetLedger.remainingCents(DISCOVERY_BINDING.accountKey))
  ) {
    budgetLedger.open(DISCOVERY_BINDING.accountKey, 100);
  }
  store.attestAuthorized = vi.fn(async (input) => {
    return {
      accountId: "40000000-0000-4000-8000-000000000004",
      authorityId: input.authorityId,
      authorizedCapMicrousd: 1_000_000n,
      generation: 1,
    };
  });
  return store;
}

function testRunId(runId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)) {
    return runId;
  }
  const bytes = createHash("sha256").update(runId).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function discoveryArgs<T extends object>(runId: string, extra: T) {
  return {
    workspaceId: DISCOVERY_BINDING.scopeKey,
    runId: testRunId(runId),
    planId: "50000000-0000-4000-8000-000000000001",
    queryOrdinal: 0,
    queryReceiptMode: QUERY_RECEIPT_MODE,
    executionContractVersion: 2 as const,
    executionBudget: DISCOVERY_BINDING,
    ...extra,
  };
}

function materializationSqlText(query: unknown): string {
  if (Array.isArray(query)) return query.join(" ");
  if (!query || typeof query !== "object") return "";
  const strings = Object.getOwnPropertyDescriptor(query, "strings")?.value;
  return Array.isArray(strings) ? strings.join(" ") : "";
}

function suppressionSnapshotDigest(
  rows: readonly { id: string; type: string; value: string }[],
): string {
  const digest = createHash("sha256");
  for (const row of rows) for (const value of [row.id, row.type, row.value]) {
    digest.update(String(Buffer.byteLength(value, "utf8"))).update(":").update(value, "utf8");
  }
  return digest.digest("hex");
}

function legacyMaterializationQueryRaw(
  onOther: () => unknown = () => [{ pg_advisory_xact_lock: null }],
) {
  return vi.fn(async (query: unknown) => {
    if (
      materializationSqlText(query).includes(
        "admit_discovery_company_materialization_v1",
      )
    ) {
      return [
        {
          status: "APPLIED",
          admission_id: "60000000-0000-4000-8000-000000000006",
          mode: "LEGACY",
        },
      ];
    }
    return onOther();
  });
}

// executeQuery/enrichRun 不 close run 预算账户（finalizeRun 才 close）→ 测试自行 force-close，清打标防单例泄漏。
afterEach(() => {
  for (const k of [
    "run-budget-x",
    "run-ok-x",
    "run-enrich-x",
    "run-enrich-ok",
    "run-signal-x",
    "run-leak",
  ]) {
    budgetLedger.close(k, { force: true });
  }
  budgetLedger.close(DISCOVERY_BINDING.accountKey, { force: true });
});

/** 模拟真实富集源：enrichCompany 里 broker/gateway 的 reserve 打穿预算 → enrichRun 的 catch 吞掉。 */
const budgetSwallowingEnricher = {
  key: "gleif",
  enrichCompany: async (_c: unknown, ctx: ExecutionContext) => {
    budgetLedger.reserve(ctx.runId ?? ctx.workspaceId, 10_000_000); // 抛 → enrichRun catch 吞掉（fail-safe）
    return { matched: false } as EnrichmentResult;
  },
};

function makeEnrichDeps(enrichers: unknown[]) {
  const tx = {
    $queryRaw: async () => [{ locked: true }],
    rawSourceRecord: { findMany: async () => [{ id: "raw1" }] },
    identityLink: { findMany: async () => [{ canonicalId: "c1" }] },
    canonicalCompany: {
      findMany: async () => [
        {
          id: "c1",
          name: "C1",
          domain: "c1.de",
          country: "DE",
          region: null,
          attributes: {},
        },
      ],
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
      findUnique: async () => ({
        id: "c1",
        name: "C1",
        domain: "c1.de",
        status: "NEW",
      }),
    },
    suppressionRecord: { findMany: async () => [] },
    fieldEvidence: { create: async () => ({}) },
  };
  const prisma = {
    sourcePolicy: { findMany: async () => [] as { domain: string }[] },
    withWorkspace: async <T>(
      _ws: string,
      fn: (tx: unknown) => Promise<T>,
    ): Promise<T> => fn(tx),
  };
  const providers = {
    routeEnrichment: async () => enrichers,
    routeSignalEnrichment: async () => enrichers,
  };
  return {
    prisma,
    providers,
    gateway: {},
    budgetStore: authorityBudgetStore(),
  } as unknown as Parameters<typeof createDiscoveryActivities>[0];
}

describe("loadPlanQueries receipt identity inputs", () => {
  it("fails missing/non-ready plans and deterministically sorts nullable query fields", async () => {
    let plan: Record<string, unknown> | null = null;
    const tx = {
      discoveryQueryPlan: { findUnique: vi.fn(async () => plan) },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
      },
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);
    const args = {
      workspaceId: DISCOVERY_BINDING.scopeKey,
      planId: "50000000-0000-4000-8000-000000000001",
      executionContractVersion: 2 as const,
      executionBudget: DISCOVERY_BINDING,
    };

    await expect(activities.loadPlanQueries(args)).rejects.toThrow(
      "query plan 50000000-0000-4000-8000-000000000001 not found",
    );
    plan = { status: "DRAFT", queries: [] };
    await expect(activities.loadPlanQueries(args)).rejects.toThrow(
      "query plan is DRAFT",
    );
    plan = { status: "READY", queries: null };
    await expect(activities.loadPlanQueries(args)).resolves.toEqual({
      queries: [],
    });
    plan = {
      status: "EXECUTED",
      queries: [
        { ...QUERY, priority: undefined },
        { ...QUERY, priority: 1 },
      ],
    };
    await expect(activities.loadPlanQueries(args)).resolves.toEqual({
      queries: [
        { ...QUERY, priority: 1 },
        { ...QUERY, priority: undefined },
      ],
    });
  });
});

describe("executeQuery —— 预算截断显性上报（不假 DONE），靠 ledger 而非源抛错", () => {
  it("accepts the exact authority-era legacy shape without entering query-receipt persistence", async () => {
    const acts = createDiscoveryActivities(makeDeps([]));
    await expect(
      acts.executeQuery(
        discoveryArgs("run-ok-x", {
          planId: undefined,
          queryOrdinal: undefined,
          queryReceiptMode: undefined,
          query: QUERY,
        }),
      ),
    ).resolves.toEqual({
      rawCount: 0,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      costCents: 0,
      provider: null,
      budgetTruncated: false,
    });
  });

  it.each([
    {
      label: "receipt mode without plan identity",
      overrides: {
        planId: undefined,
        queryOrdinal: undefined,
        queryReceiptMode: QUERY_RECEIPT_MODE,
      },
    },
    {
      label: "plan identity without receipt mode",
      overrides: { queryReceiptMode: undefined },
    },
    {
      label: "forged receipt mode",
      overrides: { queryReceiptMode: "raw-governance-query-receipt/v0" },
    },
    {
      label: "out-of-range query ordinal",
      overrides: { queryOrdinal: 1_024 },
    },
  ])("fails closed for $label", async ({ overrides }) => {
    const acts = createDiscoveryActivities(makeDeps([]));
    await expect(
      acts.executeQuery(
        discoveryArgs("run-ok-x", { ...overrides, query: QUERY }),
      ),
    ).rejects.toMatchObject({
      type: "DISCOVERY_QUERY_RECEIPT_IDENTITY_INVALID",
      nonRetryable: true,
    });
  });

  it("persists a bounded zero receipt when a source hint routes to no adapter", async () => {
    const acts = createDiscoveryActivities(makeDeps([]));
    await expect(
      acts.executeQuery(
        discoveryArgs("run-ok-x", {
          query: { ...QUERY, filters: { source_hint: "missing" } },
        }),
      ),
    ).resolves.toMatchObject({
      rawCount: 0,
      rejectedCount: 0,
      quarantinedCount: 0,
      duplicateCount: 0,
      provider: null,
      queryReceipt: { providers: [], usageQuantity: 0 },
    });
  });

  it("normalizes taxonomy branches before applying a narrowed provider route", async () => {
    const discoverCompanies = vi.fn(async () => ({
      records: [],
      costCents: 0,
    }));
    const deps = makeDeps([
      {
        ...okAdapter("wikidata", []),
        discoverCompanies,
      },
      okAdapter("ted", []),
    ]);
    deps.taxonomy = {
      resolveMany: vi.fn(async () => [
        { wikidataQid: "Q1", osmTags: ["industrial=pump"], code: "pump" },
        { wikidataQid: null, osmTags: undefined, code: "valve" },
      ]),
      resolve: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ wikidataQid: "Q183", code: "DE" }),
    } as never;
    const acts = createDiscoveryActivities(deps);

    await acts.executeQuery(
      discoveryArgs("run-ok-x", {
        query: {
          source_class: "public_intelligence",
          filters: {
            source_hint: "wiki",
            industry: "pump",
            sub_industry: "valve",
            country: "Germany",
            region: "DACH",
          },
          keywords: undefined,
          priority: 1,
        } as never,
      }),
    );

    expect(discoverCompanies).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          _industryQids: ["Q1"],
          _osmTags: ["industrial=pump"],
          _industryCodes: ["pump", "valve"],
          _countryQid: "Q183",
          _countryCode: "DE",
        }),
        keywords: [],
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("fails closed on an unknown durable receipt producer", async () => {
    const provider: CompanyDiscoveryAdapter = {
      ...okAdapter("wikidata", []),
      discoverCompanies: vi.fn(async (_query, ctx) => {
        ctx.onDurableReceipt?.("unknown.producer", ENRICHMENT_RECEIPT);
        return { records: [], costCents: 0 };
      }),
    };
    const acts = createDiscoveryActivities(makeDeps([provider]));

    await expect(
      acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY })),
    ).rejects.toThrow("DOMAIN_ACK_CONSUMER_BINDING_MISSING");
  });

  it("contains an ordinary provider failure as a zero query receipt", async () => {
    const provider: CompanyDiscoveryAdapter = {
      ...okAdapter("wikidata", []),
      discoverCompanies: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    };
    const acts = createDiscoveryActivities(makeDeps([provider]));
    await expect(
      acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY })),
    ).resolves.toMatchObject({
      rawCount: 0,
      provider: null,
      queryReceipt: { providers: [] },
    });
  });

  it("uses the relayed authority account and rejects missing binding before provider execution", async () => {
    const discoverCompanies = vi.fn(async () => ({
      records: [],
      costCents: 0,
    }));
    const open = vi.fn(async () => undefined);
    const attestAuthorized = vi.fn(async () => ({
      accountId: "40000000-0000-4000-8000-000000000004",
      authorityId: DISCOVERY_BINDING.authorityId,
      authorizedCapMicrousd: 1_000_000n,
      generation: 1,
    }));
    const deps = makeDeps([
      { ...okAdapter("wikidata", []), discoverCompanies },
    ]);
    deps.budgetStore = {
      open,
      attestAuthorized,
      status: vi.fn(async () => ({
        remainingCents: 100,
        exhausted: false,
        open: true,
      })),
    } as never;
    const acts = createDiscoveryActivities(deps);

    await acts.executeQuery({
      workspaceId: DISCOVERY_BINDING.scopeKey,
      runId: "40000000-0000-4000-8000-000000000099",
      planId: "50000000-0000-4000-8000-000000000001",
      queryOrdinal: 0,
      queryReceiptMode: QUERY_RECEIPT_MODE,
      query: QUERY,
      executionContractVersion: 2,
      executionBudget: DISCOVERY_BINDING,
    });

    expect(attestAuthorized).toHaveBeenCalledWith({
      authorityId: DISCOVERY_BINDING.authorityId,
      scopeKey: DISCOVERY_BINDING.scopeKey,
      accountKey: DISCOVERY_BINDING.accountKey,
    });
    expect(open).not.toHaveBeenCalled();
    expect(discoverCompanies).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        workspaceId: DISCOVERY_BINDING.scopeKey,
        runId: DISCOVERY_BINDING.accountKey,
      }),
      expect.any(Object),
    );

    discoverCompanies.mockClear();
    await expect(
      acts.executeQuery({
        workspaceId: DISCOVERY_BINDING.scopeKey,
        runId: "run-row-id",
        planId: "50000000-0000-4000-8000-000000000001",
        queryOrdinal: 0,
        query: QUERY,
      } as never),
    ).rejects.toMatchObject({
      type: "EXECUTION_BUDGET_LEGACY_HISTORY_PARKED",
      nonRetryable: true,
    });
    expect(discoverCompanies).not.toHaveBeenCalled();
  });

  it("产品路径在调用 provider 和持久化之前拒绝 synthetic sandbox adapter", async () => {
    const discoverCompanies = vi.fn(async () => ({
      records: [REC],
      costCents: 0,
    }));
    const deps = makeDeps([
      {
        key: "sandbox",
        classes: ["public_intelligence"],
        discoverCompanies,
      } as CompanyDiscoveryAdapter,
    ]);
    const acts = createDiscoveryActivities(deps);

    await expect(
      acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY })),
    ).rejects.toMatchObject({ code: "SYNTHETIC_DISCOVERY_PROVENANCE" });
    expect(discoverCompanies).not.toHaveBeenCalled();
  });

  it("某源打穿 run 预算并被 fail-safe 吞掉 → wasExhausted 检出 budgetTruncated=true，其余源记录仍落库", async () => {
    const deps = makeDeps([
      budgetSwallowingAdapter("public_web"),
      okAdapter("wikidata", [REC]),
    ]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.executeQuery(
      discoveryArgs("run-budget-x", { query: QUERY }),
    );
    expect(r.budgetTruncated).toBe(true);
    expect(r.rawCount).toBe(1); // wikidata 的记录不因 public_web 打穿而丢失
  });

  it("全部源正常 → budgetTruncated=false，记录照常落库", async () => {
    const deps = makeDeps([okAdapter("wikidata", [REC])]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.executeQuery(
      discoveryArgs("run-ok-x", { query: QUERY }),
    );
    expect(r.budgetTruncated).toBe(false);
    expect(r.rawCount).toBe(1);
  });

  it("generic replay 不可恢复时拒绝 activity，而不是把已付费结果吞成空成功", async () => {
    const deps = makeDeps([
      {
        ...okAdapter("ted", []),
        discoverCompanies: async () => {
          throw new BudgetOperationReplayError("ted-op");
        },
      },
    ]);
    const acts = createDiscoveryActivities(deps);

    await expect(
      acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY })),
    ).rejects.toBeInstanceOf(BudgetOperationReplayError);
  });

  it("reads back the exact persisted query receipt after DomainAck response-loss replay", async () => {
    const secondRecord: ProviderCompanyRecord = {
      ...REC,
      externalId: "wikidata:Q2",
      name: "Valve GmbH",
      domain: "valve.example",
      attributes: { wikidata_qid: "Q2", source_class: "company_registry" },
      provenance: {
        ...REC.provenance!,
        sourceUrl: "https://www.wikidata.org/wiki/Q2",
        contentHash: "b".repeat(64),
      },
    };
    let runStats: Record<string, unknown> = {};
    const persistedRows: Array<Record<string, unknown>> = [];
    let writerInvocation = 0;
    const queryRaw = vi.fn(
      async (statement: {
        strings?: readonly string[];
        values?: readonly unknown[];
      }) => {
        const sql = statement.strings?.join("?") ?? "";
        if (sql.includes("attest_discovery_query_lineage_v2")) {
          return [{
            status: "NOT_FOUND",
            query_receipt: null,
            budget_truncated: null,
            attempt_count: 0,
            item_count: 0,
            replay: false,
          }];
        }
        if (sql.includes("FROM discovery_run")) {
          return [
            {
              id: "40000000-0000-4000-8000-000000000001",
              plan_id: "50000000-0000-4000-8000-000000000001",
              stats: runStats,
            },
          ];
        }
        const command = JSON.parse(String(statement.values?.[0])) as Record<
          string,
          unknown
        >;
        writerInvocation += 1;
        const inserted = writerInvocation === 2;
        if (inserted) {
          persistedRows.push({
            id: "raw-new",
            externalId: command.externalId,
            ingestKey: command.ingestKey,
            payloadHash: "f".repeat(64),
            payload: command.payload,
            ingestStatus: command.ingestStatus,
          });
        }
        return [
          {
            raw_record_id: inserted ? "raw-new" : "raw-existing",
            payload_hash: "f".repeat(64),
            payload_bytes: Buffer.byteLength(JSON.stringify(command.payload)),
            ingest_status: command.ingestStatus,
            inserted,
          },
        ];
      },
    );
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: queryRaw,
      rawSourceRecord: {
        findMany: vi.fn(async () => []),
        count: vi.fn(
          async ({ where }: { where: { ingestStatus: string } }) =>
            persistedRows.filter(
              (row) => row.ingestStatus === where.ingestStatus,
            ).length,
        ),
      },
      discoveryRun: {
        update: vi.fn(
          async ({ data }: { data: { stats: Record<string, unknown> } }) => {
            runStats = data.stats;
            return {};
          },
        ),
      },
      usageLedger: { create: vi.fn(async () => ({})) },
    };
    const durableReceipt: DurableExecutionReceipt = Object.freeze({
      ...ENRICHMENT_RECEIPT,
      operationId: "40000000-0000-4000-8000-000000000002",
      operationKey: "discovery-wikidata-query",
      resultSchema: "wikidata-sparql/v1",
      resultDigest: "b".repeat(64),
    });
    const provider: CompanyDiscoveryAdapter = {
      key: "wikidata",
      classes: ["public_intelligence"],
      discoverCompanies: vi.fn(async (_query, ctx) => {
        ctx.onDurableReceipt?.("wikidata.sparql", durableReceipt);
        return { records: [REC, secondRecord], costCents: 5 };
      }),
    };
    const activities = createDiscoveryActivities({
      prisma: {
        sourcePolicy: {
          findMany: vi.fn(async () => [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              domain: "wikidata.org",
              retentionDays: 365,
              reviewStatus: "APPROVED",
              allowedPurpose: ["discovery"],
              updatedAt: new Date("2026-08-20T00:00:00.000Z"),
            },
          ]),
        },
        withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
      },
      providers: { routeCompanyDiscovery: vi.fn(async () => [provider]) },
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);
    acknowledgementMocks.apply
      .mockImplementationOnce(async (input) => ({
        status: "APPLIED",
        acknowledgements: input.acknowledgements.map(({ producerId }) => ({
          producerId,
          status: "APPLIED",
        })),
        value: await input.apply(input.transaction),
      }))
      .mockImplementationOnce(
        async (input: {
          transaction: unknown;
          acknowledgements: Array<{ producerId: string }>;
          readback: (transaction: unknown) => Promise<unknown>;
        }) => ({
          status: "REPLAYED",
          acknowledgements: input.acknowledgements.map(({ producerId }) => ({
            producerId,
            status: "REPLAYED",
          })),
          value: await input.readback(input.transaction),
        }),
      );

    const args = discoveryArgs("40000000-0000-4000-8000-000000000001", {
      planId: "50000000-0000-4000-8000-000000000001",
      queryOrdinal: 0,
      query: QUERY,
    });
    const first = await activities.executeQuery(args);
    expect(first).toMatchObject({
      rawCount: 1,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 1,
      costCents: 5,
    });
    const second = await activities.executeQuery(args);

    expect(second).toEqual(first);
    expect(writerInvocation).toBe(2);
    expect(runStats).toMatchObject({
      perQuery: {
        [first.queryReceipt.queryKey]: first.queryReceipt,
      },
    });

    acknowledgementMocks.apply.mockImplementationOnce(async (input) => ({
      status: "APPLIED",
      acknowledgements: input.acknowledgements.map(({ producerId }) => ({
        producerId,
        status: "APPLIED",
      })),
      value: await input.apply(input.transaction),
    }));
    await expect(activities.executeQuery(args)).resolves.toEqual(first);
    expect(writerInvocation).toBe(2);
  });

  it("fails closed when DomainAck replay has no locked query receipt", async () => {
    const activities = createDiscoveryActivities(
      makeDeps([okAdapter("wikidata", [])]),
    );
    acknowledgementMocks.apply.mockImplementationOnce(
      async (input: {
        transaction: unknown;
        acknowledgements: Array<{ producerId: string }>;
        readback: (transaction: unknown) => Promise<unknown>;
      }) => ({
        status: "REPLAYED",
        acknowledgements: input.acknowledgements.map(({ producerId }) => ({
          producerId,
          status: "REPLAYED",
        })),
        value: await input.readback(input.transaction),
      }),
    );
    await expect(
      activities.executeQuery(discoveryArgs("run-ok-x", { query: QUERY })),
    ).rejects.toThrow("DISCOVERY_QUERY_RECEIPT_READBACK_MISSING");
  });

  it("executes one lineage-capable zero-result provider through Q-TX", async () => {
    const discoverCompanies = vi.fn(async () => ({
      records: [],
      costCents: 0,
      lineage: {
        schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
        recordCount: 0,
        attemptReceipts: [],
        receiptCoverage: [],
      },
    }));
    const activities = createDiscoveryActivities(makeDeps([{
      key: "public_web",
      classes: ["public_intelligence"],
      companyResultLineage: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      discoverCompanies,
    }]));

    await expect(activities.executeQuery(
      discoveryArgs("run-qtx-zero", { query: QUERY }),
    )).resolves.toMatchObject({
      rawCount: 0,
      queryReceipt: { providers: ["public_web"] },
      budgetTruncated: false,
    });
    expect(discoverCompanies).toHaveBeenCalledOnce();
  });

  it("keeps a capable plus legacy provider batch entirely on the legacy path", async () => {
    const capable = vi.fn(async () => ({
      records: [],
      costCents: 0,
      lineage: {
        schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
        recordCount: 0,
        attemptReceipts: [],
        receiptCoverage: [],
      },
    }));
    const legacy = vi.fn(async () => ({ records: [], costCents: 0 }));
    const activities = createDiscoveryActivities(makeDeps([
      {
        key: "public_web",
        classes: ["public_intelligence"],
        companyResultLineage: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
        discoverCompanies: capable,
      },
      { ...okAdapter("wikidata", []), discoverCompanies: legacy },
    ]));

    await expect(activities.executeQuery(
      discoveryArgs("run-mixed", { query: QUERY }),
    )).resolves.toMatchObject({
      rawCount: 0,
      provider: "public_web+wikidata",
    });
    expect(capable).toHaveBeenCalledOnce();
    expect(legacy).toHaveBeenCalledOnce();
  });

  it("rejects capable provider record-count drift before Raw persistence", async () => {
    const activities = createDiscoveryActivities(makeDeps([{
      key: "public_web",
      classes: ["public_intelligence"],
      companyResultLineage: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      discoverCompanies: vi.fn(async () => ({
        records: [REC],
        costCents: 0,
        lineage: {
          schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
          recordCount: 0,
          attemptReceipts: [],
          receiptCoverage: [],
        },
      })),
    }]));

    await expect(activities.executeQuery(
      discoveryArgs("run-lineage-drift", { query: QUERY }),
    )).rejects.toMatchObject({
      code: "DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH",
    });
  });
});

describe("canonicalizeRun —— suppression authority 线性化", () => {
  it("skips an accepted Raw row that has no canonical company name", async () => {
    const canonicalUpsert = vi.fn();
    const tx = {
      $queryRaw: legacyMaterializationQueryRaw(),
      rawSourceRecord: {
        findMany: vi.fn(async () => [
          {
            id: "raw-no-name",
            providerKey: "registry",
            ingestStatus: "ACCEPTED",
            ingestVersion: "raw-source/v2",
            payload: { externalId: "registry:no-name", attributes: {} },
          },
        ]),
      },
      rawSourceGovernanceDisposition: { findMany: vi.fn(async () => []) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      canonicalCompany: { upsert: canonicalUpsert },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
      },
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);
    await expect(
      activities.canonicalizeRun(discoveryArgs("run-no-name", {})),
    ).resolves.toEqual({ companies: 0, suppressed: 0 });
    expect(canonicalUpsert).not.toHaveBeenCalled();
  });

  it("excludes every legacy ingest version from downstream materialization", async () => {
    const rawFindMany = vi.fn(async () => []);
    const tx = {
      $queryRaw: legacyMaterializationQueryRaw(),
      rawSourceRecord: { findMany: rawFindMany },
      suppressionRecord: { findMany: vi.fn(async () => []) },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(
          async (
            _workspaceId: string,
            callback: (client: typeof tx) => Promise<unknown>,
          ) => callback(tx),
        ),
      },
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);

    await activities.canonicalizeRun(discoveryArgs("run-legacy", {}));

    expect(rawFindMany).toHaveBeenCalledWith({
      where: {
        runId: testRunId("run-legacy"),
        ingestStatus: "ACCEPTED",
        ingestVersion: "raw-source/v2",
      },
    });
  });

  it.each([
    { providerKey: "sandbox", payload: { name: "Synthetic Co" } },
    {
      providerKey: "public_web",
      payload: { name: "Synthetic Co", license: "sandbox" },
    },
  ])(
    "quarantines historical synthetic raw rows from canonical materialization: %j",
    async (raw) => {
      const canonicalUpsert = vi.fn();
      const identityCreate = vi.fn();
      const evidenceCreate = vi.fn();
      const tx = {
        $queryRaw: legacyMaterializationQueryRaw(),
        rawSourceRecord: {
          findMany: async () => [{ id: "raw-synthetic", ...raw }],
        },
        rawSourceGovernanceDisposition: { findMany: async () => [] },
        suppressionRecord: { findMany: async () => [] },
        canonicalCompany: { upsert: canonicalUpsert },
        identityLink: { findFirst: vi.fn(), create: identityCreate },
        fieldEvidence: { create: evidenceCreate },
      };
      const prisma = {
        withWorkspace: async <T>(
          _workspaceId: string,
          callback: (client: typeof tx) => Promise<T>,
        ): Promise<T> => callback(tx),
      };
      const activities = createDiscoveryActivities({
        prisma,
        providers: {},
        gateway: {},
        budgetStore: authorityBudgetStore(),
      } as never);

      await expect(
        activities.canonicalizeRun(discoveryArgs("run-1", {})),
      ).resolves.toEqual({
        companies: 0,
        suppressed: 0,
      });
      expect(canonicalUpsert).not.toHaveBeenCalled();
      expect(identityCreate).not.toHaveBeenCalled();
      expect(evidenceCreate).not.toHaveBeenCalled();
    },
  );

  it("在读 suppression 和任何 canonical write 前先取 workspace policy lock", async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: legacyMaterializationQueryRaw(() => {
        order.push("lock");
        return [{ pg_advisory_xact_lock: null }];
      }),
      rawSourceRecord: {
        findMany: async () => [
          {
            id: "raw-1",
            providerKey: "wikidata",
            payload: { name: "Acme GmbH", domain: "acme.de", country: "DE" },
          },
        ],
      },
      rawSourceGovernanceDisposition: { findMany: async () => [] },
      suppressionRecord: {
        findMany: async () => {
          order.push("suppression-read");
          return [];
        },
      },
      canonicalCompany: {
        findUnique: async () => null,
        updateMany: async () => ({ count: 0 }),
        upsert: async () => {
          order.push("canonical-write");
          return { id: "company-1" };
        },
      },
      identityLink: {
        findFirst: async () => null,
        create: async () => ({}),
      },
      fieldEvidence: { create: async () => ({}) },
    };
    const prisma = {
      withWorkspace: async <T>(
        _workspaceId: string,
        callback: (client: typeof tx) => Promise<T>,
      ): Promise<T> => callback(tx),
    };
    const activities = createDiscoveryActivities({
      prisma,
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);

    await activities.canonicalizeRun(discoveryArgs("run-1", {}));

    expect(order).toEqual([
      "lock",
      "suppression-read",
      "lock",
      "canonical-write",
    ]);
  });

  it("maps a post-read company IdentityLink P2002 to the stable identity conflict", async () => {
    const tx = {
      $queryRaw: legacyMaterializationQueryRaw(),
      rawSourceRecord: { findMany: vi.fn(async () => [{
        id: "raw-p2002", providerKey: "registry", ingestStatus: "ACCEPTED",
        ingestVersion: "raw-source/v2", payload: { name: "Race GmbH", domain: "race.example" },
      }]) },
      rawSourceGovernanceDisposition: { findMany: vi.fn(async () => []) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      canonicalCompany: {
        findUnique: vi.fn(async () => null), updateMany: vi.fn(),
        upsert: vi.fn(async () => ({ id: "company-race" })),
      },
      identityLink: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002", clientVersion: "test",
          });
        }),
      },
      fieldEvidence: { create: vi.fn() },
    };
    const activities = createDiscoveryActivities({
      prisma: { withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)) },
      providers: {}, gateway: {}, budgetStore: authorityBudgetStore(),
    } as never);
    await expect(activities.canonicalizeRun(
      discoveryArgs("run-p2002", {}),
    )).rejects.toMatchObject({ type: "DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT" });
  });

  it("ordinary discovery scrubs an existing Canonical to retained namespaces before linking current v2 Raw", async () => {
    let storedAttributes: Record<string, unknown> = {};
    const upsert = vi.fn(
      async (input: { update: { attributes?: unknown } }) => {
        storedAttributes = (input.update.attributes ?? {}) as Record<
          string,
          unknown
        >;
        return { id: "company-1" };
      },
    );
    const linkCreate = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: legacyMaterializationQueryRaw(),
      rawSourceRecord: {
        findMany: async () => [
          {
            id: "raw-v2",
            providerKey: "registry",
            payload: {
              externalId: "acme-1",
              name: "Acme GmbH",
              domain: "acme.example",
              country: "DE",
              attributes: { products: ["valve"] },
            },
          },
        ],
      },
      rawSourceGovernanceDisposition: { findMany: async () => [] },
      suppressionRecord: { findMany: async () => [] },
      canonicalCompany: {
        findUnique: async () => ({
          id: "company-1",
          name: "Acme GmbH",
          domain: "acme.example",
          dedupeKey: "d:acme.example",
          attributes: {
            products: ["pump", "person@example.test"],
            gleif: {
              lei: "529900T8BM49AURSDO55",
              legal_name: "Parker Hannifin",
            },
            contact_email: "person@example.test",
            owner_name: "alice van smith",
            custom_payload: { notes: "unbounded historical prose" },
          },
          status: "NEW",
        }),
        updateMany: async () => ({ count: 0 }),
        upsert,
        findMany: async () => [
          {
            id: "company-1",
            name: "Acme GmbH",
            domain: "acme.example",
            country: "DE",
            industry: null,
            attributes: storedAttributes,
          },
        ],
      },
      identityLink: {
        findFirst: async () => null,
        findMany: async () => [{ canonicalId: "company-1" }],
        create: linkCreate,
      },
      fieldEvidence: { create: async () => ({}) },
      icpDefinition: { findUnique: async () => null },
      lead: { upsert: async () => ({}) },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: async <T>(
          _workspaceId: string,
          callback: (client: typeof tx) => Promise<T>,
        ): Promise<T> => callback(tx),
      },
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);

    await expect(
      activities.canonicalizeRun(discoveryArgs("run-1", {})),
    ).resolves.toEqual({ companies: 1, suppressed: 0 });

    const update = upsert.mock.calls[0]![0].update as Record<string, unknown>;
    expect(update.attributes).toEqual({
      products: ["pump", "valve"],
      gleif: { lei: "529900T8BM49AURSDO55", legal_name: "Parker Hannifin" },
    });
    expect(JSON.stringify(update)).not.toMatch(
      /person@example|alice van smith|unbounded historical prose/u,
    );
    expect(linkCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ rawRecordId: "raw-v2" }),
    });

    fitRuntimeMocks.execute.mockResolvedValueOnce({
      provider: "test",
      data: {
        verdict: "match",
        material_gate: "match",
        role_gate: "match",
        process_gate: "match",
        business_model_gate: "match",
        reasons: ["safe"],
      },
    });
    await expect(
      activities.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ judged: 1, verdicts: { match: 1 } });
    const prompt = String(
      fitRuntimeMocks.execute.mock.calls.at(-1)?.[1]?.prompt,
    );
    expect(prompt).toContain("pump");
    expect(prompt).toContain("valve");
    expect(prompt).not.toMatch(
      /person@example|alice van smith|unbounded historical prose/u,
    );
  });

  it("既有 canonical identity 命中 suppression 时只修复状态，不再链接或写 evidence", async () => {
    const upsert = vi.fn();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const linkCreate = vi.fn();
    const evidenceCreate = vi.fn();
    const tx = {
      $queryRaw: legacyMaterializationQueryRaw(),
      rawSourceRecord: {
        findMany: async () => [
          {
            id: "raw-1",
            providerKey: "wikidata",
            payload: { name: "Source Listing Name", country: "DE" },
          },
        ],
      },
      rawSourceGovernanceDisposition: { findMany: async () => [] },
      suppressionRecord: {
        findMany: async () => [{ type: "domain", value: "blocked.example" }],
      },
      canonicalCompany: {
        findUnique: async () => ({
          id: "company-1",
          name: "Existing Legal Entity GmbH",
          domain: "blocked.example",
          attributes: {},
          status: "NEW",
        }),
        updateMany,
        upsert,
      },
      identityLink: { findFirst: vi.fn(), create: linkCreate },
      fieldEvidence: { create: evidenceCreate },
    };
    const prisma = {
      withWorkspace: async <T>(
        _workspaceId: string,
        callback: (client: typeof tx) => Promise<T>,
      ): Promise<T> => callback(tx),
    };
    const activities = createDiscoveryActivities({
      prisma,
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);

    await expect(
      activities.canonicalizeRun(discoveryArgs("run-1", {})),
    ).resolves.toEqual({
      companies: 0,
      suppressed: 1,
    });
    expect(updateMany).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
    expect(linkCreate).not.toHaveBeenCalled();
    expect(evidenceCreate).not.toHaveBeenCalled();
  });

  it("keeps response-loss and stale linked-Raw replay behind a later Canonical update as exact no-ops", async () => {
    const rawA = {
      id: "raw-replay",
      providerKey: "registry",
      ingestStatus: "ACCEPTED",
      ingestVersion: "raw-source/v2",
      payload: {
        externalId: "registry:acme",
        name: "Acme GmbH",
        domain: "acme.example",
        country: "DE",
        attributes: { products: ["pump"], stand: "A42" },
      },
    };
    const rawB = {
      ...rawA,
      id: "raw-intervening",
      providerKey: "directory",
      payload: {
        ...rawA.payload,
        externalId: "directory:acme",
        attributes: { products: ["pump", "valve"], stand: "B42" },
      },
    };
    let raws = [rawA];
    let company: Record<string, unknown> | null = null;
    const links: Array<Record<string, unknown>> = [];
    const evidence: Array<Record<string, unknown>> = [];
    let clock = 0;
    const upsert = vi.fn(
      async (input: {
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) => {
        clock += 1;
        if (!company) {
          company = {
            id: "company-replay",
            ...input.create,
            version: 1,
            updatedAt: new Date(`2026-08-26T00:00:0${clock}.000Z`),
          };
        } else {
          const attributes = input.update.attributes ?? company.attributes;
          company = {
            ...company,
            attributes,
            version: Number(company.version) + 1,
            updatedAt: new Date(`2026-08-26T00:00:0${clock}.000Z`),
          };
        }
        return { id: company.id };
      },
    );
    const tx = {
      $queryRaw: legacyMaterializationQueryRaw(),
      rawSourceRecord: { findMany: vi.fn(async () => raws) },
      rawSourceGovernanceDisposition: { findMany: vi.fn(async () => []) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      canonicalCompany: {
        findUnique: vi.fn(async () => company),
        updateMany: vi.fn(async () => ({ count: 0 })),
        upsert,
      },
      identityLink: {
        findFirst: vi.fn(
          async ({ where }: { where: { rawRecordId: string } }) =>
            links.find((row) => row.rawRecordId === where.rawRecordId) ?? null,
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          links.push({ id: `link-${links.length + 1}`, ...data });
          return {};
        }),
      },
      fieldEvidence: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          evidence.push({ id: `evidence-${evidence.length + 1}`, ...data });
          return {};
        }),
      },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
      },
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);

    await expect(
      activities.canonicalizeRun(discoveryArgs("run-replay", {})),
    ).resolves.toEqual({ companies: 1, suppressed: 0 });
    const committed = JSON.stringify(company);
    const committedVersion = company!.version;
    const committedUpdatedAt = company!.updatedAt;
    const committedLinkCount = links.length;
    const committedEvidenceCount = evidence.length;

    // Simulate that the transaction committed but its activity response was
    // lost. Temporal invokes the same activity again with the same Raw row.
    await expect(
      activities.canonicalizeRun(discoveryArgs("run-replay", {})),
    ).resolves.toEqual({ companies: 0, suppressed: 0 });

    expect(JSON.stringify(company)).toBe(committed);
    expect(company!.version).toBe(committedVersion);
    expect(company!.updatedAt).toEqual(committedUpdatedAt);
    expect(links).toHaveLength(committedLinkCount);
    expect(evidence).toHaveLength(committedEvidenceCount);
    expect(upsert).toHaveBeenCalledOnce();

    // A genuinely new Raw B may update the overlapping namespace once and
    // receives its own provenance rows.
    raws = [rawB];
    await expect(
      activities.canonicalizeRun(discoveryArgs("run-intervening", {})),
    ).resolves.toEqual({ companies: 1, suppressed: 0 });
    expect(company!.attributes).toMatchObject({
      products: ["pump", "valve"],
      stand: "B42",
    });
    const interveningBytes = JSON.stringify(company);
    const interveningVersion = company!.version;
    const interveningUpdatedAt = company!.updatedAt;
    const interveningStatus = company!.status;
    const interveningLinks = links.length;
    const interveningEvidence = evidence.length;

    // Temporal may retry the original activity after its response is lost.
    // Since Raw A is already linked, it cannot restore A42 over B42 or advance
    // any Canonical/provenance counter.
    raws = [rawA];
    await expect(
      activities.canonicalizeRun(discoveryArgs("run-replay", {})),
    ).resolves.toEqual({ companies: 0, suppressed: 0 });
    expect(JSON.stringify(company)).toBe(interveningBytes);
    expect(company!.version).toBe(interveningVersion);
    expect(company!.updatedAt).toEqual(interveningUpdatedAt);
    expect(company!.status).toBe(interveningStatus);
    expect(links).toHaveLength(interveningLinks);
    expect(evidence).toHaveLength(interveningEvidence);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("leaves current-state sanitizer cleanup to 2100/2200 instead of mutating through a linked Raw replay", async () => {
    const raw = {
      id: "raw-repair",
      providerKey: "registry",
      ingestStatus: "ACCEPTED",
      ingestVersion: "raw-source/v2",
      payload: {
        externalId: "registry:repair",
        name: "Repair GmbH",
        domain: "repair.example",
        country: "DE",
        attributes: { products: ["pump"] },
      },
    };
    let company: Record<string, unknown> = {
      id: "company-repair",
      workspaceId: DISCOVERY_BINDING.scopeKey,
      name: "Repair GmbH",
      domain: "repair.example",
      country: "DE",
      region: null,
      dedupeKey: "d:repair.example",
      attributes: {
        products: ["pump"],
        digital_footprint: { source: "Call 555-0100" },
      },
      status: "NEW",
      version: 3,
      updatedAt: new Date("2026-08-26T00:00:00.000Z"),
    };
    const evidenceCreate = vi.fn(async () => ({}));
    const upsert = vi.fn(async (input: { update: Record<string, unknown> }) => {
      company = {
        ...company,
        attributes: input.update.attributes,
        version: Number(company.version) + 1,
        updatedAt: new Date("2026-08-26T00:00:01.000Z"),
      };
      return { id: company.id };
    });
    const tx = {
      $queryRaw: legacyMaterializationQueryRaw(),
      rawSourceRecord: { findMany: vi.fn(async () => [raw]) },
      rawSourceGovernanceDisposition: { findMany: vi.fn(async () => []) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      canonicalCompany: {
        findUnique: vi.fn(async () => company),
        updateMany: vi.fn(async () => ({ count: 0 })),
        upsert,
      },
      identityLink: {
        findFirst: vi.fn(async () => ({
          id: "existing-link",
          canonicalId: "company-repair",
        })),
        create: vi.fn(),
      },
      fieldEvidence: { create: evidenceCreate },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
      },
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);

    const originalBytes = JSON.stringify(company);
    const originalUpdatedAt = company.updatedAt;
    await expect(
      activities.canonicalizeRun(discoveryArgs("run-repair", {})),
    ).resolves.toEqual({ companies: 0, suppressed: 0 });
    expect(JSON.stringify(company)).toBe(originalBytes);
    expect(company.version).toBe(3);
    expect(company.updatedAt).toEqual(originalUpdatedAt);
    expect(evidenceCreate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("resumes a governed terminal-only batch through query and run finalization without BudgetStore", async () => {
    const queryKey = "a".repeat(64);
    const suppressionRows = [{
      id: "60000000-0000-4000-8000-000000000099",
      type: "domain", value: "canonical-reused-blocked.example",
    }];
    const suppressionSha = suppressionSnapshotDigest(suppressionRows);
    let inspection = 0;
    const attestAuthorized = vi.fn(async () => {
      throw new Error("governed C-TX must not consult BudgetStore");
    });
    const tx = {
      suppressionRecord: { findMany: vi.fn(async () => suppressionRows) },
      canonicalCompany: {
        findUnique: vi.fn(async () => ({
          id: "86000000-0000-4000-8000-000000000007",
          dedupeKey: "id:registry:reused1", name: "Canonical Reused GmbH",
          domain: "canonical-reused-blocked.example", country: "DE", region: null,
          attributes: {}, status: "NEW", version: 1, updatedAt: new Date(),
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      $queryRaw: vi.fn(async (query: unknown) => {
        const sql = materializationSqlText(query);
        if (sql.includes("admit_discovery_company_materialization_v1")) {
          return [{
            status: "APPLIED",
            admission_id: "60000000-0000-4000-8000-000000000006",
            mode: "GOVERNED_C_TX",
          }];
        }
        if (sql.includes("inspect_discovery_company_materialization_v1")) {
          inspection += 1;
          if (inspection === 1) {
            return [{
              status: "NOT_FOUND",
              next_work: {
                kind: "BATCH",
                queryKey,
                queryOrdinal: 0,
                batchOrdinal: 0,
              },
              run_summary: null,
            }];
          }
          if (inspection === 2) {
            return [{
              status: "PARTIAL_RESUMABLE",
              next_work: { kind: "FINALIZE_QUERY", queryKey, queryOrdinal: 0 },
              run_summary: null,
            }];
          }
          return [{
            status: "PARTIAL_RESUMABLE",
            next_work: { kind: "FINALIZE_RUN" },
            run_summary: null,
          }];
        }
        if (sql.includes("lock_discovery_company_materialization_batch_facts_v1")) {
          return [{
            status: "APPLIED",
            fence_id: "70000000-0000-4000-8000-000000000007",
            snapshot_sha256: suppressionSha,
            facts: [{
              qItem: {
                queryItemId: "71000000-0000-4000-8000-000000000007",
                queryKey,
                queryOrdinal: 0,
                providerKey: "registry",
                recordIndex: 0,
                operationId: "72000000-0000-4000-8000-000000000007",
                rawRecordId: "73000000-0000-4000-8000-000000000007",
                rawGovernedSubjectId: "74000000-0000-4000-8000-000000000007",
                qRelationId: "75000000-0000-4000-8000-000000000007",
                qIngestStatus: "REJECTED",
              },
              lockedFacts: {
                rawStatus: "REJECTED",
                rawExpiredAt: null,
                restrictedDispositionId: null,
                suppressionSnapshotCount: 1,
                suppressionSnapshotSha256: suppressionSha,
                product: null,
              },
              exactExistingOutcome: null,
              reusableIdentity: null,
              reusableManifestCandidates: [],
              companyParse: null,
              canonicalWrite: null,
            }, {
              qItem: {
                queryItemId: "81000000-0000-4000-8000-000000000007",
                queryKey, queryOrdinal: 0, providerKey: "registry", recordIndex: 1,
                operationId: "82000000-0000-4000-8000-000000000007",
                rawRecordId: "83000000-0000-4000-8000-000000000007",
                rawGovernedSubjectId: "84000000-0000-4000-8000-000000000007",
                qRelationId: "85000000-0000-4000-8000-000000000007",
                qIngestStatus: "ACCEPTED",
              },
              lockedFacts: {
                rawStatus: "EXPIRED", rawExpiredAt: "2026-08-30T00:00:00.000Z",
                restrictedDispositionId: null, suppressionSnapshotCount: 1,
                suppressionSnapshotSha256: suppressionSha, product: null,
              },
              exactExistingOutcome: null,
              reusableIdentity: {
                canonicalCompanyId: "86000000-0000-4000-8000-000000000007",
                identityLinkId: "87000000-0000-4000-8000-000000000007",
                identityCanonicalType: "company",
                canonicalGovernedSubjectId: "88000000-0000-4000-8000-000000000007",
                cRelationId: null, cRelationKey: "discovery.canonical_company:1",
                matchRule: "identifier_exact", confidence: 1, mutationClass: "REUSED",
                evidenceCount: 1, evidenceManifestSha256: "9".repeat(64),
              },
              reusableManifestCandidates: [{
                workspaceId: DISCOVERY_BINDING.scopeKey,
                admissionId: "60000000-0000-4000-8000-000000000006",
                runId: testRunId("run-governed-terminal"),
                rawRecordId: "83000000-0000-4000-8000-000000000007",
                identityLinkId: "87000000-0000-4000-8000-000000000007",
                canonicalCompanyId: "86000000-0000-4000-8000-000000000007",
                contractSha256: "558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe",
                evidenceCount: 1, evidenceManifestSha256: "9".repeat(64),
                queryItemId: "89000000-0000-4000-8000-000000000007",
                operationId: "8a000000-0000-4000-8000-000000000007",
                cRelationId: "8b000000-0000-4000-8000-000000000007",
                cRelationKey: "discovery.canonical_company:0",
                sourceRefUuid: "89000000-0000-4000-8000-000000000007",
                recordIndex: 0, coveringBatchReceipt: true,
              }],
              companyParse: null, canonicalWrite: null,
            }],
          }];
        }
        if (sql.includes("append_discovery_company_materialization_batch_v1")) {
          return [{ status: "APPLIED", batch_ordinal: 0 }];
        }
        if (sql.includes("finalize_discovery_company_materialization_query_v1")) {
          return [{ status: "APPLIED", query_key: queryKey }];
        }
        if (sql.includes("finalize_discovery_company_materialization_run_v1")) {
          return [{ status: "APPLIED", companies: 0, suppressed: 1 }];
        }
        if (sql.includes("pg_advisory_xact_lock")) return [{ pg_advisory_xact_lock: null }];
        throw new Error(`unexpected governed C-TX query: ${sql}`);
      }),
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
      },
      providers: {},
      gateway: {},
      budgetStore: { attestAuthorized } as never,
    } as never);

    await expect(
      activities.canonicalizeRun(discoveryArgs("run-governed-terminal", {})),
    ).resolves.toEqual({ companies: 0, suppressed: 1 });
    expect(attestAuthorized).not.toHaveBeenCalled();
    expect(inspection).toBe(3);
    const append = tx.$queryRaw.mock.calls.find(([query]) =>
      materializationSqlText(query).includes("append_discovery_company_materialization_batch_v1"));
    const appendValues = Object.getOwnPropertyDescriptor(append?.[0] as object, "values")?.value;
    const command = JSON.parse(String(appendValues?.[0]));
    expect(command.items.map((item: Record<string, unknown>) => item.mutationClass))
      .toEqual([null, null]);
    expect(command.items[1]).toMatchObject({
      outcome: "SUPPRESSED",
      suppressionRecordIds: [suppressionRows[0]!.id],
      mutationClass: null,
    });
    expect(tx.canonicalCompany.updateMany).toHaveBeenCalledWith({
      where: { id: "86000000-0000-4000-8000-000000000007", status: { not: "SUPPRESSED" } },
      data: { status: "SUPPRESSED", version: { increment: 1 } },
    });
  });

  it("returns the exact governed run receipt on response-loss replay", async () => {
    const tx = {
      $queryRaw: vi.fn(async (query: unknown) => {
        const sql = materializationSqlText(query);
        if (sql.includes("admit_discovery_company_materialization_v1")) {
          return [{ status: "REPLAYED", admission_id: "60000000-0000-4000-8000-000000000006", mode: "GOVERNED_C_TX" }];
        }
        if (sql.includes("inspect_discovery_company_materialization_v1")) {
          return [{ status: "REPLAYED", next_work: null,
            run_summary: { companies: 7, suppressed: 2 } }];
        }
        throw new Error(`unexpected replay query: ${sql}`);
      }),
    };
    const activities = createDiscoveryActivities({
      prisma: { withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)) },
      providers: {}, gateway: {}, budgetStore: { attestAuthorized: vi.fn() } as never,
    } as never);
    await expect(activities.canonicalizeRun(
      discoveryArgs("run-governed-replay", {}),
    )).resolves.toEqual({ companies: 7, suppressed: 2 });
  });

  it.each([
    "admit", "admitStatus", "admitMode", "inspect", "inspectReplayNext",
    "inspectRunSummary", "inspectNextKind", "facts", "factsStatus", "factsEmpty",
    "factsSnapshot", "factsProductNaN", "factsTooMany", "append", "appendStatus", "appendOrdinal",
    "finalizeQuery", "finalizeQueryKey", "finalizeRun", "finalizeRunCount",
    "materializationDenied", "priorMissing", "existingLink", "identityP2002", "identityOther",
  ])(
    "fails closed on malformed %s database output",
    async (malformedStage) => {
      const queryKey = "2".repeat(64);
      const emptySha = suppressionSnapshotDigest([]);
      const canonicalStages = new Set([
        "materializationDenied", "priorMissing", "existingLink", "identityP2002", "identityOther",
      ]);
      let canonicalRead = 0;
      const tx = {
        suppressionRecord: { findMany: vi.fn(async () => []) },
        canonicalCompany: {
          findUnique: vi.fn(async () => {
            canonicalRead += 1;
            if (malformedStage === "materializationDenied") return {
              id: "76000000-0000-4000-8000-000000000007", name: "Denied GmbH",
              domain: "denied.example", country: "DE", region: null, industry: null,
              employeeCount: null, revenueUsd: null, dedupeKey: "d:denied.example",
              attributes: {}, status: "SUPPRESSED", version: 1, updatedAt: new Date(),
            };
            if (malformedStage === "priorMissing") return canonicalRead === 1 ? {
              id: "76000000-0000-4000-8000-000000000007", name: "Missing GmbH",
              domain: "missing.example", country: "DE", region: null, industry: null,
              employeeCount: null, revenueUsd: null, dedupeKey: "d:missing.example",
              attributes: {}, status: "NEW", version: 1, updatedAt: new Date(),
            } : null;
            return null;
          }),
          updateMany: vi.fn(async () => ({ count: 1 })),
          upsert: vi.fn(async () => ({ id: "76000000-0000-4000-8000-000000000007" })),
        },
        identityLink: {
          findFirst: vi.fn(async () => malformedStage === "existingLink"
            ? { id: "77000000-0000-4000-8000-000000000007", canonicalId: "76000000-0000-4000-8000-000000000007" }
            : null),
          create: vi.fn(async () => {
            if (malformedStage === "identityP2002") throw new Prisma.PrismaClientKnownRequestError("unique", {
              code: "P2002", clientVersion: "test",
            });
            if (malformedStage === "identityOther") throw new Error("identity-other");
            return { id: "77000000-0000-4000-8000-000000000007" };
          }),
        },
        fieldEvidence: { create: vi.fn(async () => ({})) },
        $queryRaw: vi.fn(async (query: unknown) => {
          const sql = materializationSqlText(query);
          if (sql.includes("admit_discovery_company_materialization_v1")) {
            return malformedStage === "admit" ? [{}] : [{
              status: malformedStage === "admitStatus" ? "INVALID" : "APPLIED",
              admission_id: "60000000-0000-4000-8000-000000000006",
              mode: malformedStage === "admitMode" ? "INVALID" : "GOVERNED_C_TX",
            }];
          }
          if (sql.includes("inspect_discovery_company_materialization_v1")) {
            if (malformedStage === "inspect") return [{}];
            if (malformedStage === "inspectReplayNext") return [{
              status: "REPLAYED", next_work: { kind: "FINALIZE_RUN" },
              run_summary: { companies: 0, suppressed: 0 },
            }];
            const next_work = malformedStage === "finalizeQuery"
              || malformedStage === "finalizeQueryKey"
              ? { kind: "FINALIZE_QUERY", queryKey, queryOrdinal: 0 }
              : malformedStage === "finalizeRun" || malformedStage === "finalizeRunCount"
                ? { kind: "FINALIZE_RUN" }
                : malformedStage === "inspectNextKind" ? { kind: "INVALID" }
                  : { kind: "BATCH", queryKey, queryOrdinal: 0, batchOrdinal: 0 };
            return [{ status: "NOT_FOUND", next_work,
              run_summary: malformedStage === "inspectRunSummary" ? {} : null }];
          }
          if (sql.includes("lock_discovery_company_materialization_batch_facts_v1")) {
            if (malformedStage === "facts") return [{}];
            return [{
              status: malformedStage === "factsStatus" ? "REPLAYED" : "APPLIED",
              fence_id: "70000000-0000-4000-8000-000000000007",
              snapshot_sha256: malformedStage === "factsSnapshot" ? "3".repeat(64) : emptySha,
              facts: malformedStage === "factsEmpty" ? [] : malformedStage === "factsTooMany"
                ? Array.from({ length: 129 }, () => ({})) : [{
                qItem: {
                  queryItemId: "71000000-0000-4000-8000-000000000007",
                  queryKey, queryOrdinal: 0, providerKey: "registry", recordIndex: 0,
                  operationId: "72000000-0000-4000-8000-000000000007",
                  rawRecordId: "73000000-0000-4000-8000-000000000007",
                  rawGovernedSubjectId: "74000000-0000-4000-8000-000000000007",
                  qRelationId: "75000000-0000-4000-8000-000000000007",
                  qIngestStatus: malformedStage === "factsProductNaN" || canonicalStages.has(malformedStage)
                    ? "ACCEPTED" : "REJECTED",
                },
                lockedFacts: {
                  rawStatus: malformedStage === "factsProductNaN" || canonicalStages.has(malformedStage)
                    ? "ACCEPTED" : "REJECTED",
                  rawExpiredAt: null,
                  restrictedDispositionId: null, suppressionSnapshotCount: 0,
                  suppressionSnapshotSha256: emptySha,
                  product: malformedStage === "factsProductNaN" ? { name: "Bad", score: Number.NaN }
                    : canonicalStages.has(malformedStage) ? {
                      name: malformedStage === "materializationDenied" ? "Denied GmbH"
                        : malformedStage === "priorMissing" ? "Missing GmbH" : "Created GmbH",
                      domain: malformedStage === "materializationDenied" ? "denied.example"
                        : malformedStage === "priorMissing" ? "missing.example" : "created.example",
                    } : null,
                },
                exactExistingOutcome: null, reusableIdentity: null,
                reusableManifestCandidates: [], companyParse: null, canonicalWrite: null,
              }],
            }];
          }
          if (sql.includes("append_discovery_company_materialization_batch_v1")) {
            return malformedStage === "append" ? [{}] : [{
              status: malformedStage === "appendStatus" ? "INVALID" : "APPLIED",
              batch_ordinal: malformedStage === "appendOrdinal" ? 1 : 0,
            }];
          }
          if (sql.includes("finalize_discovery_company_materialization_query_v1")) {
            return malformedStage === "finalizeQuery" ? [{}] : [{
              status: "APPLIED", query_key: malformedStage === "finalizeQueryKey" ? "4".repeat(64) : queryKey,
            }];
          }
          if (sql.includes("finalize_discovery_company_materialization_run_v1")) {
            return malformedStage === "finalizeRun" ? [{}] : [{
              status: "APPLIED", companies: malformedStage === "finalizeRunCount" ? -1 : 0,
              suppressed: 0,
            }];
          }
          if (sql.includes("pg_advisory_xact_lock")) return [{ pg_advisory_xact_lock: null }];
          throw new Error(`unexpected malformed-output query: ${sql}`);
        }),
      };
      const activities = createDiscoveryActivities({
        prisma: { withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)) },
        providers: {}, gateway: {}, budgetStore: { attestAuthorized: vi.fn() } as never,
      } as never);
      const execution = activities.canonicalizeRun(discoveryArgs(`run-malformed-${malformedStage}`, {}));
      if (malformedStage === "identityOther") {
        await expect(execution).rejects.toThrow("identity-other");
      } else {
        const hold = ["factsSnapshot", "materializationDenied", "priorMissing"].includes(malformedStage);
        const identity = ["existingLink", "identityP2002"].includes(malformedStage);
        await expect(execution).rejects.toMatchObject({ type: identity
          ? "DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT"
          : hold ? "DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD"
            : "DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID" });
      }
    },
  );

  it("materializes an accepted governed company and leaves A identity to the database append", async () => {
    const queryKey = "d".repeat(64);
    const canonicalCompanyId = "76000000-0000-4000-8000-000000000007";
    const identityLinkId = "77000000-0000-4000-8000-000000000007";
    let inspection = 0;
    let appendCommand: Record<string, unknown> | null = null;
    const suppressionRows = Array.from({ length: 130 }, (_, index) => ({
      id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000007`,
      type: "domain",
      value: `unmatched-${index}.example`,
    }));
    suppressionRows[7] = { ...suppressionRows[7]!, value: "bücher.example" };
    suppressionRows[129] = {
      ...suppressionRows[129]!, type: "company_name", value: "Mu\u0308ller GmbH",
    };
    suppressionRows[128] = { ...suppressionRows[128]!, value: "canonical-blocked.example" };
    const suppressionSha = suppressionSnapshotDigest(suppressionRows);
    const createdLinks = new Map<string, { id: string; canonicalId: string; matchRule: string; confidence: number }>();
    const canonicalState: Record<string, unknown> = {
      id: canonicalCompanyId, name: "Existing GmbH", dedupeKey: "id:registry:acme-1",
      domain: null, country: null, region: null, industry: null,
      employeeCount: null, revenueUsd: null, attributes: {}, status: "NEW",
      version: 1, updatedAt: new Date("2026-08-30T00:00:00.000Z"),
    };
    const canonicalSuppressedState: Record<string, unknown> = {
      ...canonicalState, id: "78000000-0000-4000-8000-000000000007",
      name: "Canonical Blocked GmbH", dedupeKey: "id:registry:canonical1",
      domain: "canonical-blocked.example", status: "NEW",
    };
    const governedFact = (index: number, product: Record<string, unknown>) => ({
      qItem: {
        queryItemId: `8${index}000000-0000-4000-8000-000000000007`,
        queryKey, queryOrdinal: 0, providerKey: "registry", recordIndex: index,
        operationId: `9${index}000000-0000-4000-8000-000000000007`,
        rawRecordId: `f${9 - index}000000-0000-4000-8000-000000000007`,
        rawGovernedSubjectId: `b${index}000000-0000-4000-8000-000000000007`,
        qRelationId: `c${index}000000-0000-4000-8000-000000000007`,
        qIngestStatus: "ACCEPTED",
      },
      lockedFacts: {
        rawStatus: "ACCEPTED", rawExpiredAt: null,
        restrictedDispositionId: null,
        suppressionSnapshotCount: suppressionRows.length,
        suppressionSnapshotSha256: suppressionSha,
        product,
      },
      exactExistingOutcome: null, reusableIdentity: null,
      reusableManifestCandidates: [], companyParse: null, canonicalWrite: null,
    });
    const tx = {
      suppressionRecord: { findMany: vi.fn(async (args: {
        take?: number; where?: { id?: { gt?: string } };
      }) => args.take === 128
        ? suppressionRows.filter((row) => !args.where?.id?.gt || row.id > args.where.id.gt).slice(0, 128)
        : suppressionRows) },
      canonicalCompany: {
        findUnique: vi.fn(async (args: { where: {
          id?: string; workspaceId_dedupeKey?: { dedupeKey: string };
        } }) => {
          const key = args.where.workspaceId_dedupeKey?.dedupeKey;
          return key === "id:registry:canonical1" || args.where.id === canonicalSuppressedState.id
            ? { ...canonicalSuppressedState } : { ...canonicalState };
        }),
        upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
          for (const scalar of ["domain", "country", "region", "industry", "employeeCount", "revenueUsd"]) {
            const value = update[scalar] as { set?: unknown } | undefined;
            if (value && Object.hasOwn(value, "set")) canonicalState[scalar] = value.set;
          }
          if (update.attributes) canonicalState.attributes = update.attributes;
          canonicalState.version = Number(canonicalState.version) + 1;
          return { id: canonicalCompanyId };
        }),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      identityLink: {
        findFirst: vi.fn(async ({ where }: { where: { rawRecordId: string } }) =>
          createdLinks.get(where.rawRecordId) ?? null),
        create: vi.fn(async ({ data }: { data: { rawRecordId: string; canonicalId: string;
          matchRule: string; confidence: number } }) => {
          const link = { id: identityLinkId, canonicalId: data.canonicalId,
            matchRule: data.matchRule, confidence: data.confidence };
          createdLinks.set(data.rawRecordId, link); return { id: identityLinkId };
        }),
      },
      fieldEvidence: { create: vi.fn(async () => ({})) },
      $queryRaw: vi.fn(async (query: unknown) => {
        const sql = materializationSqlText(query);
        const values = Object.getOwnPropertyDescriptor(query as object, "values")?.value;
        if (sql.includes("admit_discovery_company_materialization_v1")) {
          return [{ status: "APPLIED", admission_id: "60000000-0000-4000-8000-000000000006", mode: "GOVERNED_C_TX" }];
        }
        if (sql.includes("inspect_discovery_company_materialization_v1")) {
          inspection += 1;
          if (inspection === 1) return [{ status: "NOT_FOUND", next_work: {
            kind: "BATCH", queryKey, queryOrdinal: 0, batchOrdinal: 0,
          }, run_summary: null }];
          if (inspection === 2) return [{ status: "PARTIAL_RESUMABLE", next_work: {
            kind: "FINALIZE_QUERY", queryKey, queryOrdinal: 0,
          }, run_summary: null }];
          return [{ status: "PARTIAL_RESUMABLE", next_work: { kind: "FINALIZE_RUN" }, run_summary: null }];
        }
        if (sql.includes("lock_discovery_company_materialization_batch_facts_v1")) {
          return [{
            status: "APPLIED",
            fence_id: "70000000-0000-4000-8000-000000000007",
            snapshot_sha256: suppressionSha,
            facts: [
              governedFact(0, {
                name: "Acme GmbH", domain: "acme.example", country: "DE",
                region: "BE", industry: "industrial", employeeCount: 10,
                revenueUsd: 1000, attributes: { products: ["pump"] }, license: "licensed",
                identifier: { scheme: "registry", value: "acme-1" },
              }),
              governedFact(1, { domain: "missing.example" }),
              governedFact(2, { name: "Synthetic GmbH", license: "sandbox" }),
              governedFact(3, { name: "Broken GmbH", identifier: { scheme: 3, value: "x" } }),
              governedFact(4, { name: "IDN GmbH", domain: "xn--bcher-kva.example" }),
              governedFact(5, { name: "Müller GmbH" }),
              (() => {
                const duplicate = governedFact(6, {
                name: "Conflicting GmbH", domain: "wrong.example", country: "US",
                region: "CA", industry: "wrong", employeeCount: 99, revenueUsd: 9999,
                attributes: { products: ["pump"] },
                identifier: { scheme: "registry", value: "acme-1" },
                });
                duplicate.qItem.rawRecordId = "f9000000-0000-4000-8000-000000000007";
                return duplicate;
              })(),
              governedFact(7, {
                name: "Unmatched Source Alias",
                identifier: { scheme: "registry", value: "canonical-1" },
              }),
            ].reverse(),
          }];
        }
        if (sql.includes("FROM field_evidence evidence")) {
          return [{ evidence_count: 8, evidence_manifest_sha256: "f".repeat(64) }];
        }
        if (sql.includes("append_discovery_company_materialization_batch_v1")) {
          appendCommand = JSON.parse(String(values?.[0]));
          return [{ status: "APPLIED", batch_ordinal: 0 }];
        }
        if (sql.includes("finalize_discovery_company_materialization_query_v1")) {
          return [{ status: "APPLIED", query_key: queryKey }];
        }
        if (sql.includes("finalize_discovery_company_materialization_run_v1")) {
          return [{ status: "APPLIED", companies: 1, suppressed: 3 }];
        }
        if (sql.includes("pg_advisory_xact_lock")) return [{ pg_advisory_xact_lock: null }];
        throw new Error(`unexpected governed canonical query: ${sql}`);
      }),
    };
    const activities = createDiscoveryActivities({
      prisma: { withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)) },
      providers: {}, gateway: {},
      budgetStore: { attestAuthorized: vi.fn() } as never,
    } as never);

    await expect(activities.canonicalizeRun(
      discoveryArgs("run-governed-canonical", {}),
    )).resolves.toEqual({ companies: 1, suppressed: 3 });
    expect(tx.canonicalCompany.upsert).toHaveBeenCalledOnce();
    expect(tx.identityLink.create).toHaveBeenCalledOnce();
    expect(tx.fieldEvidence.create).toHaveBeenCalledTimes(8);
    expect(tx.canonicalCompany.upsert).toHaveBeenCalledOnce();
    expect(canonicalState).toMatchObject({
      domain: "acme.example", country: "DE", region: "BE", industry: "industrial",
      employeeCount: 10, revenueUsd: 1000, version: 2,
    });
    const item = (appendCommand?.items as Record<string, unknown>[])[0]!;
    expect(item).toMatchObject({
      outcome: "CANONICALIZED", canonicalCompanyId, identityLinkId,
      canonicalGovernedSubjectId: null, cRelationId: null,
      suppressionRecordIds: [],
    });
    const terminalReasons = (appendCommand?.items as Record<string, unknown>[])
      .map((outcome) => outcome.notCanonicalizableReasonCode)
      .filter((reason) => reason !== null);
    expect(terminalReasons).toEqual([
      "MISSING_NAME", "NON_PRODUCT_PROVENANCE", "COMPANY_IDENTITY_INVALID",
    ]);
    const suppressed = (appendCommand?.items as Record<string, unknown>[])
      .filter((outcome) => outcome.outcome === "SUPPRESSED");
    expect(suppressed.map((outcome) => outcome.suppressionRecordIds)).toEqual([
      [suppressionRows[7]!.id],
      [suppressionRows[129]!.id],
      [suppressionRows[128]!.id],
    ]);
    expect(tx.canonicalCompany.updateMany).toHaveBeenCalledWith({
      where: { id: canonicalSuppressedState.id, status: { not: "SUPPRESSED" } },
      data: { status: "SUPPRESSED", version: { increment: 1 } },
    });
    const canonicalized = (appendCommand?.items as Record<string, unknown>[])
      .filter((outcome) => outcome.outcome === "CANONICALIZED");
    expect(canonicalized.map((outcome) => outcome.mutationClass)).toEqual(["UPDATED", "LINKED"]);
    expect(tx.suppressionRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { id: "asc" }, take: 128,
    }));
  });
});

describe("finalizeRun durable query receipt readback", () => {
  const receipt = Object.freeze({
    schemaVersion: "discovery-query-receipt/v1" as const,
    queryKey: "a".repeat(64),
    queryOrdinal: 0,
    sourceClass: "public_intelligence",
    providers: Object.freeze(["ted"]),
    accepted: 1,
    quarantined: 0,
    rejected: 0,
    governanceDenied: 0,
    duplicate: 2,
    usageQuantity: 1,
    costCents: 3,
  });
  const derived = {
    perQuery: { [receipt.queryKey]: receipt },
    perSource: {
      public_intelligence: {
        rawCount: 1,
        quarantinedCount: 0,
        rejectedCount: 0,
        governanceDenied: 0,
        duplicateCount: 2,
        usageQuantity: 1,
        costCents: 3,
        providers: ["ted"],
        provider: "ted",
      },
    },
    rawGovernance: {
      accepted: 1,
      quarantined: 0,
      rejected: 0,
      governanceDenied: 0,
      duplicate: 2,
      usageQuantity: 1,
      costCents: 3,
    },
  };

  function finalizeHarness(stats: unknown = { perQuery: derived.perQuery }) {
    const update = vi.fn(async () => ({}));
    const outboxCreate = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: "40000000-0000-4000-8000-000000000001",
          plan_id: "50000000-0000-4000-8000-000000000001",
          stats,
        },
      ]),
      discoveryRun: { update },
      discoveryQueryPlan: { update: vi.fn(async () => ({})) },
      outboxEvent: { create: outboxCreate },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
      },
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);
    return { activities, outboxCreate, update };
  }

  it("merges the locked immutable receipt into final stats and Outbox metadata", async () => {
    const { activities, outboxCreate, update } = finalizeHarness();
    await activities.finalizeRun(
      discoveryArgs("40000000-0000-4000-8000-000000000001", {
        planId: "50000000-0000-4000-8000-000000000001",
        icpId: "60000000-0000-4000-8000-000000000001",
        status: "DONE" as const,
        stats: { ...derived, companies: 1 },
      }),
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: "40000000-0000-4000-8000-000000000001" },
      data: expect.objectContaining({
        status: "DONE",
        stats: { ...derived, companies: 1 },
        completedAt: expect.any(Date),
      }),
    });
    expect(outboxCreate.mock.calls[0]![0]).toMatchObject({
      data: {
        eventType: "DiscoveryRunCompleted",
        payload: { status: "DONE", stats: { ...derived, companies: 1 } },
      },
    });
    expect(JSON.stringify(outboxCreate.mock.calls)).not.toMatch(
      /keywords|filters|payloadBody|externalId|rawId|person@example/u,
    );
  });

  it("fails closed when final workflow totals drift from the locked receipts", async () => {
    const { activities, outboxCreate, update } = finalizeHarness();
    await expect(
      activities.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          status: "PARTIAL" as const,
          stats: {
            ...derived,
            rawGovernance: { ...derived.rawGovernance, duplicate: 0 },
          },
        }),
      ),
    ).rejects.toThrow("DISCOVERY_QUERY_RECEIPT_FINALIZE_DRIFT");
    expect(update).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it("preserves the legacy finalization shape when the locked run has no receipts", async () => {
    const { activities, outboxCreate, update } = finalizeHarness(null);
    await activities.finalizeRun(
      discoveryArgs("40000000-0000-4000-8000-000000000001", {
        planId: "50000000-0000-4000-8000-000000000001",
        status: "FAILED" as const,
        stats: { failures: 1 },
      }),
    );
    expect(update).toHaveBeenCalledOnce();
    expect(outboxCreate).toHaveBeenCalledOnce();
  });

  it("rejects finalization that omits a receipt already stored on the locked run", async () => {
    const { activities, outboxCreate, update } = finalizeHarness();
    await expect(
      activities.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          status: "FAILED" as const,
          stats: { failures: 1 },
        }),
      ),
    ).rejects.toThrow("DISCOVERY_QUERY_RECEIPT_FINALIZE_MISSING");
    expect(update).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it("rejects a missing or cross-plan locked run before final mutation", async () => {
    const { outboxCreate, update } = finalizeHarness();
    const invalid = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) =>
          callback({
            $queryRaw: vi.fn(async () => []),
            discoveryRun: { update },
            outboxEvent: { create: outboxCreate },
          }),
        ),
      },
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as never);
    await expect(
      invalid.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          status: "FAILED" as const,
          stats: { failures: 1 },
        }),
      ),
    ).rejects.toThrow("DISCOVERY_QUERY_RECEIPT_RUN_BINDING_INVALID");
    expect(update).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });
});

describe("enrichRun / resetRunBudget —— 富集阶段截断也上报 + 未知调用不重试", () => {
  it.each(["enrichRun", "enrichSignalsRun"] as const)(
    "%s parks a pending legacy activity before provider routing or early success",
    async (activityName) => {
      const routeEnrichment = vi.fn(async () => []);
      const routeSignalEnrichment = vi.fn(async () => []);
      const withWorkspace = vi.fn(
        async (
          _workspaceId: string,
          callback: (tx: unknown) => Promise<unknown>,
        ) => callback({}),
      );
      const activities = createDiscoveryActivities({
        prisma: { withWorkspace } as never,
        providers: { routeEnrichment, routeSignalEnrichment } as never,
        gateway: {} as never,
        budgetStore: authorityBudgetStore(),
      });

      await expect(
        activities[activityName]({
          workspaceId: DISCOVERY_BINDING.scopeKey,
          runId: "legacy-run",
          icpId: "icp-1",
        } as never),
      ).rejects.toMatchObject({
        type: "EXECUTION_BUDGET_LEGACY_HISTORY_PARKED",
        nonRetryable: true,
      });
      expect(withWorkspace).not.toHaveBeenCalled();
      expect(routeEnrichment).not.toHaveBeenCalled();
      expect(routeSignalEnrichment).not.toHaveBeenCalled();
    },
  );

  it("富集源预算控制失败上抛，不降级为 PARTIAL", async () => {
    const deps = makeEnrichDeps([budgetSwallowingEnricher]);
    const acts = createDiscoveryActivities(deps);
    await expect(
      acts.enrichRun(discoveryArgs("run-enrich-x", { icpId: "icp-1" })),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("富集正常 → enrichRun.budgetTruncated=false", async () => {
    const deps = makeEnrichDeps([
      { key: "gleif", enrichCompany: async () => ({ matched: false }) },
    ]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.enrichRun(
      discoveryArgs("run-enrich-ok", { icpId: "icp-1" }),
    );
    expect(r.budgetTruncated).toBe(false);
  });

  it.each(["enrichRun", "enrichSignalsRun"] as const)(
    "%s ACKs a valid no-match enrichment receipt on its exact workspace transaction",
    async (activityName) => {
      acknowledgementMocks.apply.mockClear();
      acknowledgementMocks.apply.mockImplementationOnce(
        async (input: {
          transaction: unknown;
          acknowledgements: Array<{ producerId: string }>;
          readback: (transaction: unknown) => Promise<unknown>;
        }) => ({
          status: "REPLAYED",
          acknowledgements: input.acknowledgements.map(({ producerId }) => ({
            producerId,
            status: "REPLAYED",
          })),
          value: await input.readback(input.transaction),
        }),
      );
      const enricher = {
        key: "gleif",
        enrichCompany: vi.fn(
          async (_company: unknown, ctx: ExecutionContext) => {
            ctx.onDurableReceipt?.("gleif.fetch", ENRICHMENT_RECEIPT);
            return { matched: false } as EnrichmentResult;
          },
        ),
      };
      const deps = makeEnrichDeps([enricher]);
      const result = await createDiscoveryActivities(deps)[activityName](
        discoveryArgs(`run-${activityName}`, { icpId: "icp-1" }),
      );

      expect(result).toMatchObject({ enriched: 1, matched: 0 });
      expect(acknowledgementMocks.apply).toHaveBeenCalledWith(
        expect.objectContaining({
          acknowledgements: [
            expect.objectContaining({
              producerId: "gleif.fetch",
              receipt: ENRICHMENT_RECEIPT,
            }),
          ],
        }),
      );
      const acknowledgement = acknowledgementMocks.apply.mock.calls.at(-1)?.[0];
      expect(acknowledgement.apply).toBeTypeOf("function");
      expect(acknowledgement.readback).toBeTypeOf("function");
    },
  );

  it("信号富集预算控制失败上抛，不降级为 best-effort", async () => {
    const deps = makeEnrichDeps([budgetSwallowingEnricher]);
    const acts = createDiscoveryActivities(deps);
    await expect(
      acts.enrichSignalsRun(discoveryArgs("run-signal-x", { icpId: "icp-1" })),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("authority workflow compatibility activity never closes a legacy run account", async () => {
    const deps = makeEnrichDeps([]);
    const close = vi.spyOn(deps.budgetStore!, "close");
    const acts = createDiscoveryActivities(deps);

    await acts.resetRunBudget(discoveryArgs("run-leak", {}));

    expect(close).not.toHaveBeenCalled();
  });

  it("propagates authority account open failures before provider execution", async () => {
    const close = vi.fn(async () => undefined);
    const attestAuthorized = vi.fn(async () => {
      throw new BudgetUnsettledOperationsError("run-unknown");
    });
    const adapter = vi.fn(async () => ({ records: [], costCents: 0 }));
    const deps = makeDeps([
      { ...okAdapter("public-web", []), discoverCompanies: adapter },
    ]);
    deps.budgetStore = {
      open: vi.fn(),
      attestAuthorized,
      close,
      reserve: vi.fn(),
      settle: vi.fn(),
      release: vi.fn(),
      status: vi.fn(),
    } as unknown as BudgetStore;
    const acts = createDiscoveryActivities(deps);

    await expect(
      acts.executeQuery(discoveryArgs("run-unknown", { query: QUERY })),
    ).rejects.toBeInstanceOf(BudgetUnsettledOperationsError);
    expect(close).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
  });
});

describe("resolveRunStatus —— 预算截断绝不判 DONE", () => {
  it("无失败无截断 → DONE", () => {
    expect(
      resolveRunStatus({
        failures: 0,
        totalQueries: 3,
        budgetTruncated: false,
      }),
    ).toBe("DONE");
  });
  it("预算截断（即使零失败）→ PARTIAL", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: true }),
    ).toBe("PARTIAL");
  });
  it("部分源失败 → PARTIAL", () => {
    expect(
      resolveRunStatus({
        failures: 1,
        totalQueries: 3,
        budgetTruncated: false,
      }),
    ).toBe("PARTIAL");
  });
  it("全部源失败 → FAILED", () => {
    expect(
      resolveRunStatus({
        failures: 3,
        totalQueries: 3,
        budgetTruncated: false,
      }),
    ).toBe("FAILED");
  });
});

/**
 * P1-1 kill-switch（Codex PR #93）：专利缓存冷启动 enqueue 必须受 data_provider.google_patents ENABLED 门控。
 * seed=DISABLED（未签 LIA/DPIA）时绝不 enqueue——不污染刷新队列（PII 物化的真正闸在 refreshPatentCache）。
 */
describe("enqueuePatentLookupsForRun · P1-1 kill-switch", () => {
  it("provider DISABLED → 不 enqueue（candidates:0, enqueued:0），且绝不查公司表", async () => {
    const prisma = {
      dataProvider: { findUnique: async () => ({ status: "DISABLED" }) },
      withWorkspace: async () => {
        throw new Error("DISABLED 时绝不应查公司表");
      },
    };
    const deps = {
      prisma,
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    const acts = createDiscoveryActivities(deps);
    const res = await acts.enqueuePatentLookupsForRun(
      discoveryArgs("run", { icpId: "icp" }),
    );
    expect(res).toEqual({ candidates: 0, enqueued: 0 });
  });

  it("provider ENABLED → 正常 enqueue 本 run fit=match 公司", async () => {
    const upserts: unknown[] = [];
    const tx = {
      rawSourceRecord: { findMany: async () => [{ id: "raw1" }] },
      identityLink: { findMany: async () => [{ canonicalId: "c1" }] },
      canonicalCompany: {
        findMany: async () => [{ name: "Acme GmbH", country: "DE" }],
      },
    };
    const prisma = {
      dataProvider: { findUnique: async () => ({ status: "ENABLED" }) },
      withWorkspace: async <T>(
        _ws: string,
        fn: (tx: unknown) => Promise<T>,
      ): Promise<T> => fn(tx),
      patentLookupRequest: {
        upsert: async ({ create }: { create: unknown }) => {
          upserts.push(create);
          return {};
        },
      },
    };
    const deps = {
      prisma,
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    const acts = createDiscoveryActivities(deps);
    const res = await acts.enqueuePatentLookupsForRun(
      discoveryArgs("run", { icpId: "icp" }),
    );
    expect(res).toEqual({ candidates: 1, enqueued: 1 });
    expect(upserts).toHaveLength(1);
  });
});
