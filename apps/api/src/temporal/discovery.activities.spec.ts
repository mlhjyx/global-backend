import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ApplicationFailure } from "@temporalio/activity";
import {
  createDiscoveryActivities,
  ENRICH_PASS_TIME_BOX_MS,
  FIT_CONCURRENCY,
  FIT_PASS_TIME_BOX_MS,
  PROFILE_PASS_TIME_BOX_MS,
} from "./discovery.activities";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import { DISCOVERY_CANONICALIZE_TRANSACTION_OPTIONS } from "./discovery-company-materialization";
import { ToolPolicyDenied } from "../tools/tool-broker";
import { MAX_DISCOVERY_PLAN_QUERIES, MAX_DISCOVERY_PROFILE_COMPANIES } from "../discovery/execution-envelope";
import { resolveRunStatus } from "./discovery.run-status";
import {
  ProviderOutputError,
  ProviderTransportError,
} from "../model-gateway/providers/provider-output-error";
import {
  BudgetLedger,
  InMemoryBudgetStoreAdapter,
  TestBudgetExceededError as BudgetExceededError,
} from "@global/test-support";
import {
  BudgetExceededError as StoreBudgetExceededError,
  BudgetOperationReplayError,
  BudgetUnsettledOperationsError,
  type BudgetStore,
} from "../tools/budget-store";
import {
  ExecutionBudgetGrantError,
  type ExecutionBudgetGrantErrorCode,
} from "../execution-budget/execution-budget-authority.types";

const budgetLedger = new BudgetLedger();
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  EnrichmentResult,
  ExecutionContext,
  ProviderCompanyRecord,
} from "../discovery/provider-contract";
import { ProviderHttpError } from "../model-gateway/providers/provider-output-error";
import type { DurableExecutionReceipt } from "../durable-results/durable-execution-receipt";
import { DISCOVERY_COMPANY_RESULT_LINEAGE_V1 } from "../discovery/company-discovery-lineage";
import { DiscoveryProviderRegistry } from "../discovery/provider.registry";
import { OpenFdaDiscoveryProvider } from "../discovery/providers/openfda.provider";
import { OsmDiscoveryProvider } from "../discovery/providers/osm.provider";
import { PublicWebDiscoveryProvider } from "../discovery/providers/public-web.provider";
import { TedDiscoveryProvider } from "../discovery/providers/ted.provider";
import { WikidataDiscoveryProvider } from "../discovery/providers/wikidata.provider";
import { discoveryQueryKey } from "../discovery/discovery-query-receipt";
import {
  DISCOVERY_LEASE_FINALIZATION_RESERVE_MS,
  DISCOVERY_LEASE_UNIT_MS,
} from "./discovery-run-lease";
import { discoveryActivityTimeouts, timeoutMilliseconds } from "./testing/discovery-activity-timeouts";

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
  const providers = {
    routeCompanyDiscovery: async () => adapters,
    companyDiscoverySources: () => REGISTERED_DISCOVERY_SOURCES,
  };
  return {
    prisma,
    providers,
    gateway: {},
    budgetStore: authorityBudgetStore(),
  } as unknown as Parameters<typeof createDiscoveryActivities>[0];
}

/** The company discovery sources a gateway-backed registry registers (BI-30), with their lineage. */
const REGISTERED_DISCOVERY_SOURCES = Object.freeze([
  { sourceClass: "public_intelligence", providerKey: "public_web", hasCompanyLineage: true },
  { sourceClass: "industry_data", providerKey: "public_web", hasCompanyLineage: true },
  { sourceClass: "industry_data", providerKey: "directory", hasCompanyLineage: true },
  { sourceClass: "company_registry", providerKey: "wikidata", hasCompanyLineage: false },
  { sourceClass: "industry_data", providerKey: "wikidata", hasCompanyLineage: false },
  { sourceClass: "industry_data", providerKey: "openstreetmap", hasCompanyLineage: false },
  { sourceClass: "industry_data", providerKey: "trade_fair", hasCompanyLineage: true },
  { sourceClass: "public_intelligence", providerKey: "ted", hasCompanyLineage: false },
  { sourceClass: "public_intelligence", providerKey: "openfda", hasCompanyLineage: false },
]);

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

const MINUTE = 60_000;

/**
 * A run-lease reader that leaves `slackMs` before the finalization reserve when it is read; with a
 * clock that stands still, every check in the activity sees the same room.
 */
function leaseLeaving(slackMs: number) {
  return vi.fn(async () => DISCOVERY_LEASE_FINALIZATION_RESERVE_MS + slackMs);
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

  it("fails closed when a plan exceeds the quoted query ceiling (planner + cold-path queries)", async () => {
    const plan: Record<string, unknown> = { status: "READY", queries: [] };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) =>
          callback({ discoveryQueryPlan: { findUnique: vi.fn(async () => plan) } }),
        ),
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

    plan.queries = Array.from({ length: MAX_DISCOVERY_PLAN_QUERIES }, () => QUERY);
    await expect(activities.loadPlanQueries(args)).resolves.toMatchObject({
      queries: { length: MAX_DISCOVERY_PLAN_QUERIES },
    });
    plan.queries = Array.from({ length: MAX_DISCOVERY_PLAN_QUERIES + 1 }, () => QUERY);
    await expect(activities.loadPlanQueries(args)).rejects.toThrow(
      "EXECUTION_BUDGET_ENVELOPE_EXCEEDED",
    );
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
      // BI-30: no ENABLED adapter serves the query's class, so it was skipped.
      skipReason: "SOURCE_DISABLED",
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

  it("returns the model extractions its providers made and dropped, summed across providers", async () => {
    const deps = makeDeps([
      {
        ...okAdapter("wikidata", []),
        discoverCompanies: vi.fn(async () => ({
          records: [],
          costCents: 0,
          modelExtractions: {
            invoked: 3,
            failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1 },
          },
        })),
      },
      {
        ...okAdapter("ted", []),
        discoverCompanies: vi.fn(async () => ({
          records: [],
          costCents: 0,
          modelExtractions: {
            invoked: 2,
            failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1, MODEL_CALL_FAILED: 1 },
          },
        })),
      },
    ]);
    const acts = createDiscoveryActivities(deps);

    await expect(
      acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY })),
    ).resolves.toMatchObject({
      modelExtractions: {
        invoked: 5,
        failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 2, MODEL_CALL_FAILED: 1 },
      },
    });
  });

  it("returns no model extractions when no provider made a model call", async () => {
    const acts = createDiscoveryActivities(makeDeps([okAdapter("wikidata", [])]));

    const result = await acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));

    expect(result).not.toHaveProperty("modelExtractions");
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

  it("generic replay 不可恢复时，这条查询以零回执结束并标记，而不是把已付费结果吞成空成功", async () => {
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
    ).resolves.toMatchObject({
      rawCount: 0,
      unreplayable: true,
      queryReceipt: { providers: ["ted"], accepted: 0 },
    });
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

describe("executeQuery —— 数据源在规划后被停用时跳过查询（BI-30）", () => {
  const DISABLED_QUERY = {
    source_class: "industry_data",
    filters: { source_hint: "directory", industry: "pumps", country: "Germany" },
    keywords: [],
    priority: 1,
  };

  function taxonomySpy() {
    return {
      resolveMany: vi.fn(async () => []),
      resolve: vi.fn(async () => null),
    };
  }

  it("skips a query whose source is DISABLED: no taxonomy model call, no provider call, one zero receipt", async () => {
    const deps = makeDeps([]);
    const taxonomy = taxonomySpy();
    deps.taxonomy = taxonomy as never;
    const acts = createDiscoveryActivities(deps);

    const result = await acts.executeQuery(
      discoveryArgs("run-ok-x", { query: DISABLED_QUERY }),
    );

    expect(taxonomy.resolveMany).not.toHaveBeenCalled();
    expect(taxonomy.resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      rawCount: 0,
      costCents: 0,
      provider: null,
      skipReason: "SOURCE_DISABLED",
      // The materialization admission needs one receipt per plan query.
      queryReceipt: {
        sourceClass: "industry_data",
        providers: [],
        accepted: 0,
        usageQuantity: 0,
        costCents: 0,
      },
    });
  });

  it.each([
    ["a source class no provider serves", { source_class: "trade_data", filters: {} }],
    ["a hint that names no registered source", { source_class: "public_intelligence", filters: { source_hint: "missing" } }],
  ])("reports SOURCE_UNKNOWN for %s", async (_label, routing) => {
    const acts = createDiscoveryActivities(makeDeps([]));

    await expect(
      acts.executeQuery(
        discoveryArgs("run-ok-x", { query: { ...routing, keywords: [], priority: 1 } }),
      ),
    ).resolves.toMatchObject({ skipReason: "SOURCE_UNKNOWN", queryReceipt: { providers: [] } });
  });

  it("runs a routed source as before, with no skip reason", async () => {
    const deps = makeDeps([okAdapter("wikidata", [REC])]);
    const taxonomy = taxonomySpy();
    deps.taxonomy = taxonomy as never;
    const acts = createDiscoveryActivities(deps);

    const result = await acts.executeQuery(
      discoveryArgs("run-ok-x", {
        query: {
          ...DISABLED_QUERY,
          source_class: "public_intelligence",
          filters: { ...DISABLED_QUERY.filters, source_hint: "wikidata" },
        },
      }),
    );

    expect(result).toMatchObject({ rawCount: 1, provider: "wikidata" });
    expect(result).not.toHaveProperty("skipReason");
    expect(taxonomy.resolveMany).toHaveBeenCalledOnce();
  });

  it("skips a query with an unusable hint instead of failing it", async () => {
    const discoverCompanies = vi.fn(async () => ({ records: [REC], costCents: 0 }));
    const acts = createDiscoveryActivities(
      makeDeps([{ ...okAdapter("public_web", []), discoverCompanies }]),
    );

    await expect(
      acts.executeQuery(
        discoveryArgs("run-ok-x", {
          query: { ...QUERY, filters: { source_hint: 42 } },
        }),
      ),
    ).resolves.toMatchObject({ skipReason: "SOURCE_UNKNOWN", rawCount: 0 });
    expect(discoverCompanies).not.toHaveBeenCalled();
  });

  it("routes a list hint to each named source and to nothing else", async () => {
    const wikidata = vi.fn(async () => ({ records: [], costCents: 0 }));
    const ted = vi.fn(async () => ({ records: [], costCents: 0 }));
    const publicWeb = vi.fn(async () => ({ records: [], costCents: 0 }));
    const acts = createDiscoveryActivities(
      makeDeps([
        { ...okAdapter("public_web", []), discoverCompanies: publicWeb },
        { ...okAdapter("wikidata", []), discoverCompanies: wikidata },
        { ...okAdapter("ted", []), discoverCompanies: ted },
      ]),
    );

    const result = await acts.executeQuery(
      discoveryArgs("run-ok-x", {
        query: { ...QUERY, filters: { source_hint: ["Wikidata", "ted"] } },
      }),
    );

    expect(wikidata).toHaveBeenCalledOnce();
    expect(ted).toHaveBeenCalledOnce();
    expect(publicWeb).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("skipReason");
  });

  it.each([
    ["a switched-off source", DISABLED_QUERY, "SOURCE_DISABLED"],
    [
      "a source without governed lineage",
      { ...DISABLED_QUERY, source_class: "company_registry", filters: { source_hint: "wikidata" } },
      "SOURCE_LINEAGE_UNAVAILABLE",
    ],
  ])("reports the skip again when a retry replays a zero-provider lineage receipt for %s", async (
    _label,
    replayedQuery,
    expectedReason,
  ) => {
    const workspaceId = DISCOVERY_BINDING.scopeKey;
    const runId = "20000000-0000-4000-8000-000000000001";
    const planId = "30000000-0000-4000-8000-000000000001";
    const queryKey = discoveryQueryKey({
      runId,
      planId,
      queryOrdinal: 0,
      query: replayedQuery,
    });
    const route = vi.fn();
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) =>
          callback({
            $queryRaw: vi.fn(async () => [{
              status: "REPLAYED",
              query_receipt: {
                schemaVersion: "discovery-query-receipt/v1",
                queryKey,
                queryOrdinal: 0,
                sourceClass: replayedQuery.source_class,
                providers: [],
                accepted: 0,
                quarantined: 0,
                rejected: 0,
                governanceDenied: 0,
                duplicate: 0,
                usageQuantity: 0,
                costCents: 0,
              },
              budget_truncated: false,
              attempt_count: 0,
              item_count: 0,
              replay: true,
            }]),
          })),
      },
      providers: {
        routeCompanyDiscovery: route,
        companyDiscoverySources: () => REGISTERED_DISCOVERY_SOURCES,
      },
      gateway: {},
      budgetStore: { attestAuthorized: vi.fn(), status: vi.fn() },
    } as never);

    await expect(
      activities.executeQuery({
        workspaceId,
        runId,
        planId,
        queryOrdinal: 0,
        queryReceiptMode: QUERY_RECEIPT_MODE,
        query: replayedQuery,
        executionContractVersion: 2,
        executionBudget: DISCOVERY_BINDING,
      }),
    ).resolves.toMatchObject({
      rawCount: 0,
      skipReason: expectedReason,
      queryReceipt: { providers: [] },
    });
    expect(route).not.toHaveBeenCalled();
  });
});

describe("executeQuery —— 没有受治理血缘的数据源即使 ENABLED 也不路由（lineage gate）", () => {
  afterEach(() => vi.restoreAllMocks());

  /** executeQuery on the real registry, with every company discovery source ENABLED. */
  function registryDeps() {
    const registry = new DiscoveryProviderRegistry({ gateway: {} as never });
    const keys = [...new Set(registry.companyDiscoverySources().map((source) => source.providerKey))];
    const db = { dataProvider: { findMany: async () => keys.map((key) => ({ key })) } };
    const deps = makeDeps([]);
    deps.providers = {
      routeCompanyDiscovery: (_tx: unknown, sourceClass: never) =>
        registry.routeCompanyDiscovery(db as never, sourceClass),
      companyDiscoverySources: () => registry.companyDiscoverySources(),
    } as never;
    const taxonomy = { resolveMany: vi.fn(async () => []), resolve: vi.fn(async () => null) };
    deps.taxonomy = taxonomy as never;
    return { deps, taxonomy };
  }

  it.each([
    ["Wikidata", WikidataDiscoveryProvider, "company_registry", { source_hint: "wikidata", industry: "pumps" }],
    ["OpenStreetMap", OsmDiscoveryProvider, "industry_data", { source_hint: "openstreetmap", industry: "pumps" }],
    ["TED", TedDiscoveryProvider, "public_intelligence", { source_hint: "ted", cpv_codes: ["42122000"] }],
    ["openFDA", OpenFdaDiscoveryProvider, "public_intelligence", { source_hint: "openfda", product_codes: ["LZG"] }],
  ] as const)("skips an ENABLED %s query with one zero receipt and SOURCE_LINEAGE_UNAVAILABLE", async (
    _label,
    Provider,
    sourceClass,
    filters,
  ) => {
    const discover = vi.spyOn(Provider.prototype, "discoverCompanies");
    const { deps, taxonomy } = registryDeps();
    const acts = createDiscoveryActivities(deps);

    const result = await acts.executeQuery(discoveryArgs("run-ok-x", {
      query: { source_class: sourceClass, filters: { ...filters }, keywords: [], priority: 1 },
    }));

    expect(discover).not.toHaveBeenCalled();
    expect(taxonomy.resolveMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      rawCount: 0,
      costCents: 0,
      provider: null,
      skipReason: "SOURCE_LINEAGE_UNAVAILABLE",
      queryReceipt: { sourceClass, providers: [], accepted: 0, usageQuantity: 0, costCents: 0 },
    });
  });

  it("runs only the lineage source of a hint-less query whose class also has ENABLED lineage-less sources", async () => {
    const ted = vi.spyOn(TedDiscoveryProvider.prototype, "discoverCompanies");
    const openFda = vi.spyOn(OpenFdaDiscoveryProvider.prototype, "discoverCompanies");
    const publicWeb = vi.spyOn(PublicWebDiscoveryProvider.prototype, "discoverCompanies")
      .mockResolvedValue({
        records: [],
        costCents: 0,
        lineage: {
          schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
          recordCount: 0,
          attemptReceipts: [],
          receiptCoverage: [],
        },
      });
    const acts = createDiscoveryActivities(registryDeps().deps);

    const result = await acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));

    expect(publicWeb).toHaveBeenCalledOnce();
    expect(ted).not.toHaveBeenCalled();
    expect(openFda).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provider: "public_web", queryReceipt: { providers: ["public_web"] } });
    expect(result).not.toHaveProperty("skipReason");
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
    const withWorkspace = vi.fn(
      async (
        _workspaceId: string,
        callback: (client: typeof tx) => Promise<unknown>,
        _options?: unknown,
      ) => callback(tx),
    );
    const activities = createDiscoveryActivities({
      prisma: { withWorkspace },
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
    // Admission keeps the client defaults; the whole-run legacy pass carries the canonicalize options.
    expect(withWorkspace.mock.calls.map((call) => call[2]))
      .toEqual([undefined, DISCOVERY_CANONICALIZE_TRANSACTION_OPTIONS]);
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

    // One unusable answer skips that company but is counted, so the run cannot end DONE.
    fitRuntimeMocks.execute.mockRejectedValueOnce(
      new ProviderOutputError(
        "gateway deepseek-v4-pro: structured output is not valid JSON",
        { inputTokens: 520, outputTokens: 11 },
        { reasonCode: "STRUCTURED_OUTPUT_NOT_JSON" },
      ),
    );
    await expect(
      activities.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ judged: 0, unjudged: 1 });

    // A single stream the gateway settled as cut short skips that company too; two in a row
    // stop the activity (see "qualifyFitForRun —— 流截断").
    const cut = new ProviderTransportError("CHAT_COMPLETIONS_STREAM_TRUNCATED", { inputTokens: 520 });
    fitRuntimeMocks.execute.mockRejectedValueOnce(cut);
    await expect(
      activities.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ judged: 0, unjudged: 1 });
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
          return [{ status: "APPLIED", companies: 0n, suppressed: 1n }];
        }
        if (sql.includes("pg_advisory_xact_lock")) return [{ pg_advisory_xact_lock: null }];
        throw new Error(`unexpected governed C-TX query: ${sql}`);
      }),
    };
    const transactions: Array<{ options: unknown; sql: string[] }> = [];
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback, options) => {
          const before = tx.$queryRaw.mock.calls.length;
          const result = await callback(tx);
          transactions.push({
            options,
            sql: tx.$queryRaw.mock.calls.slice(before).map(([query]) => materializationSqlText(query)),
          });
          return result;
        }),
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
    // Only the batch transaction carries the canonicalize options; admission, inspection and
    // the two finalizations keep the client defaults.
    const batch = transactions.filter(({ sql }) =>
      sql.some((text) => text.includes("lock_discovery_company_materialization_batch_facts_v1")));
    expect(batch).toHaveLength(1);
    expect(batch[0]!.options).toBe(DISCOVERY_CANONICALIZE_TRANSACTION_OPTIONS);
    expect(transactions.filter(({ options }) => options !== undefined)).toEqual(batch);
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
    "finalizeQuery", "finalizeQueryKey", "finalizeRun", "finalizeRunCount", "finalizeRunNumber",
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
                || malformedStage === "finalizeRunNumber"
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
            // PostgreSQL BIGINT reaches Prisma raw queries as bigint; a plain number is malformed.
            return malformedStage === "finalizeRun" ? [{}] : [{
              status: "APPLIED",
              companies: malformedStage === "finalizeRunCount" ? -1n
                : malformedStage === "finalizeRunNumber" ? 0 : 0n,
              suppressed: 0n,
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
          return [{ status: "APPLIED", companies: 1n, suppressed: 3n }];
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

  function finalizeHarness(
    stats: unknown = { perQuery: derived.perQuery },
    budgetStore: BudgetStore = authorityBudgetStore(),
    // The run's status at each read of its row, the last repeating: finalizeRun reads the row
    // before attesting and again under the write lock.
    runStatus: string | readonly string[] = "RUNNING",
    // Lead rows of the run's companies: a FAILED run that stopped at or after the fit stage
    // consults them for fit verdicts when its own stats carry none (the failure path builds
    // stats without `fit`).
    leadFindFirst: ReturnType<typeof vi.fn> = vi.fn(async () => null),
  ) {
    const update = vi.fn(async () => ({}));
    const outboxCreate = vi.fn(async () => ({}));
    const planUpdate = vi.fn(async () => ({}));
    // The run's accepted raw records and the companies they resolved to.
    const rawFindMany = vi.fn(async () => [{ id: RUN_RAW_RECORD_ID }]);
    const identityLinkFindMany = vi.fn(async () => [
      { canonicalId: RUN_COMPANY_ID },
      { canonicalId: RUN_COMPANY_ID },
    ]);
    const statuses = typeof runStatus === "string" ? [runStatus] : runStatus;
    let runReads = 0;
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: "40000000-0000-4000-8000-000000000001",
          plan_id: "50000000-0000-4000-8000-000000000001",
          stats,
          status: statuses[Math.min(runReads++, statuses.length - 1)],
        },
      ]),
      discoveryRun: { update },
      discoveryQueryPlan: { update: planUpdate },
      lead: { findFirst: leadFindFirst },
      rawSourceRecord: { findMany: rawFindMany },
      identityLink: { findMany: identityLinkFindMany },
      outboxEvent: { create: outboxCreate },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) => callback(tx)),
      },
      providers: {},
      gateway: {},
      budgetStore,
    } as never);
    return { activities, outboxCreate, update, planUpdate, leadFindFirst, rawFindMany, identityLinkFindMany };
  }

  const RUN_RAW_RECORD_ID = "80000000-0000-4000-8000-000000000001";
  const RUN_COMPANY_ID = "90000000-0000-4000-8000-000000000001";

  function endedAuthorityStore(code: ExecutionBudgetGrantErrorCode): BudgetStore {
    const store = authorityBudgetStore();
    store.attestAuthorized = vi.fn(async () => {
      throw new ExecutionBudgetGrantError(code);
    });
    return store;
  }

  const FAILURE_STATS = Object.freeze({
    failures: 0,
    failure: { stage: "fit", errorType: "ProviderTransportError", control: false },
  });

  it.each([
    "EXECUTION_BUDGET_GRANT_EXPIRED",
    "EXECUTION_BUDGET_AUTHORITY_REVOKED",
    "EXECUTION_BUDGET_AUTHORITY_EXHAUSTED",
  ] as const)(
    "still records a FAILED outcome after the run's authority ended (%s)",
    async (code) => {
      const { activities, outboxCreate, update, planUpdate } = finalizeHarness(
        null,
        endedAuthorityStore(code),
      );

      await activities.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          icpId: "60000000-0000-4000-8000-000000000001",
          status: "FAILED" as const,
          stats: FAILURE_STATS,
        }),
      );

      expect(update).toHaveBeenCalledWith({
        where: { id: "40000000-0000-4000-8000-000000000001" },
        data: expect.objectContaining({ status: "FAILED", stats: FAILURE_STATS }),
      });
      // FAILED starts nothing here: the plan stays READY, and with no fit verdict on the run's
      // companies no QualifyRequested is written.
      expect(planUpdate).not.toHaveBeenCalled();
      expect(outboxCreate).toHaveBeenCalledOnce();
      expect(outboxCreate.mock.calls[0]![0]).toMatchObject({
        data: {
          eventType: "DiscoveryRunCompleted",
          payload: { status: "FAILED", stats: FAILURE_STATS },
        },
      });
    },
  );

  // A run that failed after the fit stage leaves judged-but-unscored companies behind: their
  // queue is the fit-gate preset, their six scores are NULL and the sanctions gate never ran
  // (xin, 2026-10-14: 179 such leads from 11 FAILED runs). Scoring is deterministic and spends
  // no execution budget, so the FAILED write still requests it; the plan stays READY and
  // DiscoveryRunCompleted keeps reporting FAILED.
  const FAILED_AFTER_FIT_STATS = Object.freeze({
    failures: 0,
    failure: { stage: "signals", errorType: "ProviderTransportError", control: false },
  });

  it("requests scoring for a FAILED run whose stats show the fit stage judged companies", async () => {
    const { activities, outboxCreate, planUpdate, leadFindFirst } = finalizeHarness(null);

    await activities.finalizeRun(
      discoveryArgs("40000000-0000-4000-8000-000000000001", {
        planId: "50000000-0000-4000-8000-000000000001",
        icpId: "60000000-0000-4000-8000-000000000001",
        status: "FAILED" as const,
        stats: { ...FAILED_AFTER_FIT_STATS, fit: { match: 2, weak: 0, mismatch: 1 } },
      }),
    );

    expect(planUpdate).not.toHaveBeenCalled();
    expect(leadFindFirst).not.toHaveBeenCalled();
    expect(outboxCreate).toHaveBeenCalledTimes(2);
    expect(outboxCreate.mock.calls[0]![0]).toMatchObject({
      data: { eventType: "DiscoveryRunCompleted", payload: { status: "FAILED" } },
    });
    expect(outboxCreate.mock.calls[1]![0]).toMatchObject({
      data: {
        workspaceId: DISCOVERY_BINDING.scopeKey,
        eventType: "QualifyRequested",
        aggregateType: "ICP",
        aggregateId: "60000000-0000-4000-8000-000000000001",
        payload: {
          reason: "discovery_run_failed_after_fit",
          runId: "40000000-0000-4000-8000-000000000001",
        },
      },
    });
  });

  it.each(["fit", "enrich", "signals", "watches", "patentEnqueue"] as const)(
    "requests scoring for a FAILED run that stopped at stage %s once the run's own companies hold a fit verdict (the failure path's stats shape)",
    async (stage) => {
      const leadFindFirst = vi.fn(async () => ({ id: "70000000-0000-4000-8000-000000000001" }));
      const { activities, outboxCreate, planUpdate, rawFindMany, identityLinkFindMany } = finalizeHarness(
        null,
        authorityBudgetStore(),
        "RUNNING",
        leadFindFirst,
      );

      await activities.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          icpId: "60000000-0000-4000-8000-000000000001",
          status: "FAILED" as const,
          stats: { ...FAILED_AFTER_FIT_STATS, failure: { ...FAILED_AFTER_FIT_STATS.failure, stage } },
        }),
      );

      // Scoped to this run: its accepted raw records → the companies they resolved to → their
      // leads for this ICP. Another run's verdicts on other companies do not count.
      expect(rawFindMany).toHaveBeenCalledWith({
        where: { runId: "40000000-0000-4000-8000-000000000001", ingestStatus: "ACCEPTED" },
        select: { id: true },
      });
      expect(identityLinkFindMany).toHaveBeenCalledWith({
        where: { canonicalType: "company", rawRecordId: { in: [RUN_RAW_RECORD_ID] } },
        select: { canonicalId: true },
      });
      expect(leadFindFirst).toHaveBeenCalledWith({
        where: {
          icpId: "60000000-0000-4000-8000-000000000001",
          canonicalCompanyId: { in: [RUN_COMPANY_ID] },
          fitVerdict: { not: null },
        },
        select: { id: true },
      });
      expect(planUpdate).not.toHaveBeenCalled();
      expect(outboxCreate).toHaveBeenCalledTimes(2);
      expect(outboxCreate.mock.calls[1]![0]).toMatchObject({
        data: {
          eventType: "QualifyRequested",
          aggregateId: "60000000-0000-4000-8000-000000000001",
          payload: { reason: "discovery_run_failed_after_fit" },
        },
      });
    },
  );

  it.each(["plan", "query", "canonicalize", "websiteProfile"] as const)(
    "writes no QualifyRequested for a FAILED run that stopped at stage %s, before fit, whatever the ICP's leads hold",
    async (stage) => {
      // Another run left fit verdicts on this ICP's leads; this run never reached fit.
      const leadFindFirst = vi.fn(async () => ({ id: "70000000-0000-4000-8000-000000000001" }));
      const { activities, outboxCreate, rawFindMany } = finalizeHarness(
        null,
        authorityBudgetStore(),
        "RUNNING",
        leadFindFirst,
      );

      await activities.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          icpId: "60000000-0000-4000-8000-000000000001",
          status: "FAILED" as const,
          stats: { failures: 1, failure: { stage, errorType: "BudgetOperationReplayError", control: false } },
        }),
      );

      expect(rawFindMany).not.toHaveBeenCalled();
      expect(leadFindFirst).not.toHaveBeenCalled();
      expect(outboxCreate).toHaveBeenCalledOnce();
      expect(outboxCreate.mock.calls[0]![0]).toMatchObject({
        data: { eventType: "DiscoveryRunCompleted", payload: { status: "FAILED" } },
      });
    },
  );

  it("writes no QualifyRequested for a FAILED run whose stats carry neither fit counts nor a failure stage", async () => {
    const leadFindFirst = vi.fn(async () => ({ id: "70000000-0000-4000-8000-000000000001" }));
    const { activities, outboxCreate, rawFindMany } = finalizeHarness(
      null,
      authorityBudgetStore(),
      "RUNNING",
      leadFindFirst,
    );

    await activities.finalizeRun(
      discoveryArgs("40000000-0000-4000-8000-000000000001", {
        planId: "50000000-0000-4000-8000-000000000001",
        icpId: "60000000-0000-4000-8000-000000000001",
        status: "FAILED" as const,
        stats: { failures: 1 },
      }),
    );

    expect(rawFindMany).not.toHaveBeenCalled();
    expect(leadFindFirst).not.toHaveBeenCalled();
    expect(outboxCreate).toHaveBeenCalledOnce();
  });

  it("writes no QualifyRequested for a FAILED run past fit whose own companies hold no fit verdict", async () => {
    const { activities, outboxCreate, leadFindFirst } = finalizeHarness(null);

    await activities.finalizeRun(
      discoveryArgs("40000000-0000-4000-8000-000000000001", {
        planId: "50000000-0000-4000-8000-000000000001",
        icpId: "60000000-0000-4000-8000-000000000001",
        status: "FAILED" as const,
        stats: FAILED_AFTER_FIT_STATS,
      }),
    );

    expect(leadFindFirst).toHaveBeenCalledOnce();
    expect(outboxCreate).toHaveBeenCalledOnce();
    expect(outboxCreate.mock.calls[0]![0]).toMatchObject({
      data: { eventType: "DiscoveryRunCompleted" },
    });
  });

  it("writes no QualifyRequested for a FAILED run past fit that accepted no raw record, without a lead lookup", async () => {
    const { activities, outboxCreate, leadFindFirst, rawFindMany, identityLinkFindMany } = finalizeHarness(null);
    rawFindMany.mockResolvedValueOnce([]);

    await activities.finalizeRun(
      discoveryArgs("40000000-0000-4000-8000-000000000001", {
        planId: "50000000-0000-4000-8000-000000000001",
        icpId: "60000000-0000-4000-8000-000000000001",
        status: "FAILED" as const,
        stats: FAILED_AFTER_FIT_STATS,
      }),
    );

    expect(identityLinkFindMany).not.toHaveBeenCalled();
    expect(leadFindFirst).not.toHaveBeenCalled();
    expect(outboxCreate).toHaveBeenCalledOnce();
  });

  it("writes no QualifyRequested for a FAILED run whose own fit counts are all zero, without consulting lead rows", async () => {
    // The ICP's leads hold verdicts from an earlier run; this run's fit stage judged nothing.
    const leadFindFirst = vi.fn(async () => ({ id: "70000000-0000-4000-8000-000000000001" }));
    const { activities, outboxCreate, rawFindMany } = finalizeHarness(
      null,
      authorityBudgetStore(),
      "RUNNING",
      leadFindFirst,
    );

    await activities.finalizeRun(
      discoveryArgs("40000000-0000-4000-8000-000000000001", {
        planId: "50000000-0000-4000-8000-000000000001",
        icpId: "60000000-0000-4000-8000-000000000001",
        status: "FAILED" as const,
        stats: { ...FAILED_AFTER_FIT_STATS, fit: { match: 0, weak: 0, mismatch: 0 } },
      }),
    );

    expect(rawFindMany).not.toHaveBeenCalled();
    expect(leadFindFirst).not.toHaveBeenCalled();
    expect(outboxCreate).toHaveBeenCalledOnce();
    expect(outboxCreate.mock.calls[0]![0]).toMatchObject({
      data: { eventType: "DiscoveryRunCompleted" },
    });
  });

  it.each([
    "EXECUTION_BUDGET_GRANT_EXPIRED",
    "EXECUTION_BUDGET_AUTHORITY_REVOKED",
    "EXECUTION_BUDGET_AUTHORITY_EXHAUSTED",
  ] as const)(
    "still requests scoring for a FAILED run after its authority ended (%s): scoring spends no budget",
    async (code) => {
      const leadFindFirst = vi.fn(async () => ({ id: "70000000-0000-4000-8000-000000000001" }));
      const { activities, outboxCreate, planUpdate } = finalizeHarness(
        null,
        endedAuthorityStore(code),
        "RUNNING",
        leadFindFirst,
      );

      await activities.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          icpId: "60000000-0000-4000-8000-000000000001",
          status: "FAILED" as const,
          stats: FAILED_AFTER_FIT_STATS,
        }),
      );

      expect(planUpdate).not.toHaveBeenCalled();
      expect(outboxCreate).toHaveBeenCalledTimes(2);
      expect(outboxCreate.mock.calls[1]![0]).toMatchObject({
        data: { eventType: "QualifyRequested", payload: { reason: "discovery_run_failed_after_fit" } },
      });
    },
  );

  it("keeps the completed-run reason on a DONE run's QualifyRequested without consulting lead rows", async () => {
    const { activities, outboxCreate, leadFindFirst } = finalizeHarness(null);

    await activities.finalizeRun(
      discoveryArgs("40000000-0000-4000-8000-000000000001", {
        planId: "50000000-0000-4000-8000-000000000001",
        icpId: "60000000-0000-4000-8000-000000000001",
        status: "DONE" as const,
        stats: { failures: 0, fit: { match: 0, weak: 0, mismatch: 0 } },
      }),
    );

    expect(leadFindFirst).not.toHaveBeenCalled();
    expect(outboxCreate).toHaveBeenCalledTimes(2);
    expect(outboxCreate.mock.calls[1]![0]).toMatchObject({
      data: { eventType: "QualifyRequested", payload: { reason: "discovery_run_completed" } },
    });
  });

  // A DONE or PARTIAL write after the authority ended used to throw before writing anything, so the
  // run stayed RUNNING for good (the workflow fails on a finalize error). The admission lease design
  // records a run past its authority as FAILED, so the activity writes that outcome itself, keeping
  // the ended code, then fails without retrying.
  it.each([
    ["DONE", "EXECUTION_BUDGET_GRANT_EXPIRED"],
    ["PARTIAL", "EXECUTION_BUDGET_AUTHORITY_REVOKED"],
    ["DONE", "EXECUTION_BUDGET_AUTHORITY_EXHAUSTED"],
  ] as const)(
    "records a %s outcome as FAILED at the finalize stage once the run's authority has ended (%s)",
    async (status, code) => {
      const { activities, outboxCreate, update, planUpdate } = finalizeHarness(null, endedAuthorityStore(code));

      await expect(
        activities.finalizeRun(
          discoveryArgs("40000000-0000-4000-8000-000000000001", {
            planId: "50000000-0000-4000-8000-000000000001",
            icpId: "60000000-0000-4000-8000-000000000001",
            status,
            stats: { failures: 0, fit: { match: 1, weak: 0, mismatch: 0 } },
          }),
        ),
      ).rejects.toMatchObject({ type: "ExecutionBudgetGrantError", nonRetryable: true });

      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0]![0]).toMatchObject({
        data: {
          status: "FAILED",
          stats: {
            fit: { match: 1 },
            failure: { stage: "finalize", errorType: code, control: true },
          },
        },
      });
      expect(planUpdate).not.toHaveBeenCalled();
      expect(outboxCreate.mock.calls.map(([call]) => call.data.eventType)).toEqual([
        "DiscoveryRunCompleted",
        "QualifyRequested",
      ]);
      expect(outboxCreate.mock.calls[0]![0]).toMatchObject({ data: { payload: { status: "FAILED" } } });
    },
  );

  // finalizeRun writes a run's outcome once: a retry of a write that already committed (its result
  // was lost) answers without attesting again, writing again or emitting a second event.
  it.each(["DONE", "PARTIAL"] as const)(
    "answers a retried %s write that already committed without a second write or event, even after the authority ended",
    async (status) => {
      const budgetStore = endedAuthorityStore("EXECUTION_BUDGET_GRANT_EXPIRED");
      const { activities, outboxCreate, update, planUpdate } = finalizeHarness(null, budgetStore, status);

      await activities.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          icpId: "60000000-0000-4000-8000-000000000001",
          status,
          stats: { failures: 0 },
        }),
      );

      expect(budgetStore.attestAuthorized).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(planUpdate).not.toHaveBeenCalled();
      expect(outboxCreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["DONE", "FAILED"],
    ["PARTIAL", "DONE"],
    ["DONE", "PARTIAL"],
  ] as const)(
    "refuses a %s write over a run already recorded %s, without retrying",
    async (status, runStatus) => {
      const { activities, outboxCreate, update, planUpdate } = finalizeHarness(null, authorityBudgetStore(), runStatus);

      await expect(
        activities.finalizeRun(
          discoveryArgs("40000000-0000-4000-8000-000000000001", {
            planId: "50000000-0000-4000-8000-000000000001",
            status,
            stats: { failures: 0 },
          }),
        ),
      ).rejects.toMatchObject({ type: "DISCOVERY_RUN_ALREADY_FINALIZED", nonRetryable: true });
      expect(update).not.toHaveBeenCalled();
      expect(planUpdate).not.toHaveBeenCalled();
      expect(outboxCreate).not.toHaveBeenCalled();
    },
  );

  // Another attempt can commit the same outcome between this attempt's first read and its write
  // lock. The write then succeeded, even when the authority ended in between.
  it.each([
    ["a live authority", authorityBudgetStore],
    ["an ended authority", () => endedAuthorityStore("EXECUTION_BUDGET_GRANT_EXPIRED")],
  ] as const)(
    "answers a DONE write that an overlapping attempt committed first, with %s",
    async (_label, budgetStore) => {
      const { activities, outboxCreate, update, planUpdate } = finalizeHarness(
        null,
        budgetStore(),
        ["RUNNING", "DONE"],
      );

      await activities.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          icpId: "60000000-0000-4000-8000-000000000001",
          status: "DONE" as const,
          stats: { failures: 0 },
        }),
      );

      expect(update).not.toHaveBeenCalled();
      expect(planUpdate).not.toHaveBeenCalled();
      expect(outboxCreate).not.toHaveBeenCalled();
    },
  );

  // Only an ended authority turns DONE or PARTIAL into FAILED: any other attestation failure is
  // raised as it is, with nothing written.
  it.each([
    ["DONE", "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH"],
    ["PARTIAL", "EXECUTION_BUDGET_GRANT_INVALID"],
    ["DONE", "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE"],
  ] as const)(
    "refuses a %s outcome without writing when attestation reports %s",
    async (status, code) => {
      const { activities, outboxCreate, update, planUpdate } = finalizeHarness(null, endedAuthorityStore(code));

      await expect(
        activities.finalizeRun(
          discoveryArgs("40000000-0000-4000-8000-000000000001", {
            planId: "50000000-0000-4000-8000-000000000001",
            status,
            stats: { failures: 0 },
          }),
        ),
      ).rejects.toMatchObject({ code });
      expect(update).not.toHaveBeenCalled();
      expect(planUpdate).not.toHaveBeenCalled();
      expect(outboxCreate).not.toHaveBeenCalled();
    },
  );

  it("keeps the ended authority as the error when the FAILED write it falls back to is refused", async () => {
    // The stored receipts are missing from the requested stats, so the FAILED write is refused.
    const { activities, outboxCreate, update } = finalizeHarness(
      undefined,
      endedAuthorityStore("EXECUTION_BUDGET_AUTHORITY_REVOKED"),
    );

    await expect(
      activities.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          status: "DONE" as const,
          stats: { failures: 0 },
        }),
      ),
    ).rejects.toMatchObject({
      type: "ExecutionBudgetGrantError",
      nonRetryable: true,
      cause: { message: "DISCOVERY_QUERY_RECEIPT_FINALIZE_MISSING" },
    });
    expect(update).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it.each([
    "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
    "EXECUTION_BUDGET_GRANT_INVALID",
    "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
  ] as const)(
    "still refuses a FAILED outcome when attestation reports %s",
    async (code) => {
      const { activities, outboxCreate, update } = finalizeHarness(
        null,
        endedAuthorityStore(code),
      );

      await expect(
        activities.finalizeRun(
          discoveryArgs("40000000-0000-4000-8000-000000000001", {
            planId: "50000000-0000-4000-8000-000000000001",
            status: "FAILED" as const,
            stats: FAILURE_STATS,
          }),
        ),
      ).rejects.toMatchObject({ code });
      expect(update).not.toHaveBeenCalled();
      expect(outboxCreate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a finished run", "DONE", authorityBudgetStore],
    ["a partial run whose grant has since expired", "PARTIAL", () =>
      endedAuthorityStore("EXECUTION_BUDGET_GRANT_EXPIRED")],
    ["a run already recorded FAILED (retried write)", "FAILED", authorityBudgetStore],
  ] as const)(
    "never overwrites %s with a FAILED outcome",
    async (_label, runStatus, budgetStore) => {
      const { activities, outboxCreate, update, planUpdate } = finalizeHarness(
        { perQuery: derived.perQuery },
        budgetStore(),
        runStatus,
      );

      await activities.finalizeRun(
        discoveryArgs("40000000-0000-4000-8000-000000000001", {
          planId: "50000000-0000-4000-8000-000000000001",
          icpId: "60000000-0000-4000-8000-000000000001",
          status: "FAILED" as const,
          stats: FAILURE_STATS,
        }),
      );

      expect(update).not.toHaveBeenCalled();
      expect(planUpdate).not.toHaveBeenCalled();
      expect(outboxCreate).not.toHaveBeenCalled();
    },
  );

  it("records workflow-built FAILED stats over the locked receipts without drift", async () => {
    const { activities, outboxCreate, update } = finalizeHarness();
    const stats = { ...derived, queries: 1, ...FAILURE_STATS };

    await activities.finalizeRun(
      discoveryArgs("40000000-0000-4000-8000-000000000001", {
        planId: "50000000-0000-4000-8000-000000000001",
        icpId: "60000000-0000-4000-8000-000000000001",
        status: "FAILED" as const,
        stats,
      }),
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: "40000000-0000-4000-8000-000000000001" },
      data: expect.objectContaining({ status: "FAILED", stats }),
    });
    expect(outboxCreate).toHaveBeenCalledOnce();
  });

  it("keeps a FAILED outcome without a v2 envelope parked", async () => {
    const { activities, outboxCreate, update } = finalizeHarness(
      null,
      endedAuthorityStore("EXECUTION_BUDGET_GRANT_EXPIRED"),
    );

    await expect(
      activities.finalizeRun({
        workspaceId: DISCOVERY_BINDING.scopeKey,
        runId: "40000000-0000-4000-8000-000000000001",
        planId: "50000000-0000-4000-8000-000000000001",
        status: "FAILED",
        stats: FAILURE_STATS,
      } as never),
    ).rejects.toMatchObject({
      type: "EXECUTION_BUDGET_LEGACY_HISTORY_PARKED",
      nonRetryable: true,
    });
    expect(update).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it("keeps a DONE outcome without a v2 envelope parked, even over a run already recorded DONE", async () => {
    const { activities, outboxCreate, update } = finalizeHarness(null, authorityBudgetStore(), "DONE");

    await expect(
      activities.finalizeRun({
        workspaceId: DISCOVERY_BINDING.scopeKey,
        runId: "40000000-0000-4000-8000-000000000001",
        planId: "50000000-0000-4000-8000-000000000001",
        status: "DONE",
        stats: { failures: 0 },
      } as never),
    ).rejects.toMatchObject({
      type: "EXECUTION_BUDGET_LEGACY_HISTORY_PARKED",
      nonRetryable: true,
    });
    expect(update).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

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
    const queryRaw = vi.fn(async (_statement: { strings: readonly string[] }) => []);
    const invalid = createDiscoveryActivities({
      prisma: {
        withWorkspace: vi.fn(async (_workspaceId, callback) =>
          callback({
            $queryRaw: queryRaw,
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
    // Prisma binds a string as text, and PostgreSQL has no uuid = text operator.
    expect(queryRaw.mock.calls[0]?.[0].strings.join("?")).toMatch(
      /WHERE id\s*=\s*\?::uuid\b/,
    );
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

  // enrichSignalsRun ACKs a miss's receipts one at a time: discovery.signals-retry.spec.ts.
  it.each(["enrichRun"] as const)(
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

/** Gives a makeEnrichDeps fixture several fit=match companies with their own domains. */
async function withMatchCompanies<T>(deps: T, ids: string[]): Promise<T> {
  const fixture = deps as unknown as {
    prisma: { withWorkspace: (ws: string, fn: (tx: Record<string, Record<string, unknown>>) => Promise<unknown>) => Promise<unknown> };
  };
  await fixture.prisma.withWorkspace("ws", async (tx) => {
    tx.canonicalCompany!.findMany = vi.fn(async () =>
      ids.map((id) => ({
        id,
        name: id.toUpperCase(),
        domain: `${id}.de`,
        country: "DE",
        region: null,
        attributes: {},
      })),
    );
  });
  return deps;
}

describe("尽力而为的阶段：无法重放的公司跳过并计数", () => {
  const unreplayable = (operationId: string) => new BudgetOperationReplayError(operationId);

  it("signals skip a company whose operation cannot be replayed, count it, and enrich the rest", async () => {
    const enricher = {
      key: "digital_footprint",
      enrichCompany: vi
        .fn()
        .mockRejectedValueOnce(unreplayable("op-1"))
        .mockResolvedValue({ matched: false } as EnrichmentResult),
    };
    const deps = await withMatchCompanies(makeEnrichDeps([enricher]), ["c1", "c2"]);

    await expect(
      createDiscoveryActivities(deps).enrichSignalsRun(
        discoveryArgs("run-signal-unreplayable", { icpId: "icp-1" }),
      ),
    ).resolves.toMatchObject({ enriched: 1, unreplayable: 1, skippedSubjects: 0 });
    expect(enricher.enrichCompany).toHaveBeenCalledTimes(2);
  });

  it("signals still stop when two companies in a row cannot be replayed", async () => {
    const second = unreplayable("op-2");
    const enricher = {
      key: "digital_footprint",
      enrichCompany: vi.fn().mockRejectedValueOnce(unreplayable("op-1")).mockRejectedValueOnce(second),
    };
    const deps = await withMatchCompanies(makeEnrichDeps([enricher]), ["c1", "c2", "c3"]);

    await expect(
      createDiscoveryActivities(deps).enrichSignalsRun(
        discoveryArgs("run-signal-unreplayable-twice", { icpId: "icp-1" }),
      ),
    ).rejects.toBe(second);
  });

  it("signals absorb unreplayable companies that an enriched company separates", async () => {
    const enricher = {
      key: "digital_footprint",
      enrichCompany: vi
        .fn()
        .mockRejectedValueOnce(unreplayable("op-1"))
        .mockResolvedValueOnce({ matched: false } as EnrichmentResult)
        .mockRejectedValueOnce(unreplayable("op-3")),
    };
    const deps = await withMatchCompanies(makeEnrichDeps([enricher]), ["c1", "c2", "c3"]);

    await expect(
      createDiscoveryActivities(deps).enrichSignalsRun(
        discoveryArgs("run-signal-unreplayable-apart", { icpId: "icp-1" }),
      ),
    ).resolves.toMatchObject({ enriched: 1, unreplayable: 2 });
  });

  function watchDeps(invoke: ReturnType<typeof vi.fn>) {
    const deps = makeEnrichDeps([]) as unknown as {
      prisma: { withWorkspace: (ws: string, fn: (tx: Record<string, Record<string, unknown>>) => Promise<unknown>) => Promise<unknown> };
      broker?: unknown;
      platformWriter?: unknown;
    };
    deps.broker = { invoke };
    deps.platformWriter = { $transaction: vi.fn() };
    return deps;
  }

  it("watch registration skips a company whose sitemap read cannot be replayed and counts it", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(unreplayable("op-1")).mockRejectedValueOnce(
      new ToolPolicyDenied("http.get", "GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED"),
    );
    const deps = await withMatchCompanies(watchDeps(invoke), ["c1", "c2"]);
    await deps.prisma.withWorkspace("ws", async (tx) => {
      tx.fieldEvidence!.findMany = async () => [];
    });

    await expect(
      createDiscoveryActivities(deps as never).registerWatchesForRun(
        discoveryArgs("run-watch-unreplayable", { icpId: "icp-1" }) as never,
      ),
    ).resolves.toEqual({ candidates: 2, registered: 0, skippedSubjects: 1, unreplayable: 1 });
  });

  it("watch registration stops for the admission lease and counts the companies it left", async () => {
    const invoke = vi.fn();
    const deps = await withMatchCompanies(watchDeps(invoke), ["c1", "c2"]);
    Object.assign(deps, { now: () => 0, runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.watches - 1) });

    await expect(
      createDiscoveryActivities(deps as never).registerWatchesForRun(
        discoveryArgs("run-watch-lease", { icpId: "icp-1" }) as never,
      ),
    ).resolves.toEqual({ candidates: 2, registered: 0, skippedSubjects: 0, unreplayable: 0, skippedForLease: 2 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("watch registration still stops when two companies in a row cannot be replayed", async () => {
    const second = unreplayable("op-2");
    const invoke = vi.fn().mockRejectedValueOnce(unreplayable("op-1")).mockRejectedValueOnce(second);
    const deps = await withMatchCompanies(watchDeps(invoke), ["c1", "c2"]);
    await deps.prisma.withWorkspace("ws", async (tx) => {
      tx.fieldEvidence!.findMany = async () => [];
    });

    await expect(
      createDiscoveryActivities(deps as never).registerWatchesForRun(
        discoveryArgs("run-watch-unreplayable-twice", { icpId: "icp-1" }) as never,
      ),
    ).rejects.toBe(second);
  });
});

describe("enrichRun —— 按时限把余下公司交给下一次活动", () => {
  const gleif = () => ({
    key: "gleif",
    enrichCompany: vi.fn(async () => ({ matched: false }) as EnrichmentResult),
  });

  it("hands the companies left to the next enrich activity once its time box is spent", async () => {
    const enricher = gleif();
    const deps = await withMatchCompanies(makeEnrichDeps([enricher]), ["c1", "c2", "c3"]);
    (deps as { now?: () => number }).now = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValue(ENRICH_PASS_TIME_BOX_MS);

    await expect(
      createDiscoveryActivities(deps).enrichRun(discoveryArgs("run-enrich-pass", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ enriched: 1, nextIndex: 1 });
    expect(enricher.enrichCompany).toHaveBeenCalledOnce();
  });

  it("resumes at the index it was handed, in id order, and hands nothing on once done", async () => {
    const enricher = gleif();
    const deps = await withMatchCompanies(makeEnrichDeps([enricher]), ["c1", "c2", "c3"]);
    (deps as { now?: () => number }).now = () => 0;
    const findMany = (
      (await (deps.prisma as unknown as {
        withWorkspace: (ws: string, fn: (tx: Record<string, Record<string, unknown>>) => Promise<unknown>) => Promise<unknown>;
      }).withWorkspace("ws", async (tx) => tx.canonicalCompany!.findMany)) as ReturnType<typeof vi.fn>
    );

    await expect(
      createDiscoveryActivities(deps).enrichRun(
        discoveryArgs("run-enrich-resume", { icpId: "icp-1", startIndex: 1 }),
      ),
    ).resolves.toMatchObject({ enriched: 2, nextIndex: null });
    expect(enricher.enrichCompany.mock.calls.map(([company]) => (company as { domain: string }).domain)).toEqual([
      "c2.de",
      "c3.de",
    ]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { id: "asc" }, take: 50 }));
  });

  it("stops for the admission lease: the companies left count as skipped for it and nothing is handed on", async () => {
    const enricher = gleif();
    const deps = await withMatchCompanies(makeEnrichDeps([enricher]), ["c1", "c2", "c3"]);
    let now = 0;
    enricher.enrichCompany.mockImplementation(async () => {
      now += MINUTE;
      return { matched: false } as EnrichmentResult;
    });
    Object.assign(deps, { now: () => now, runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.enrich) });

    await expect(
      createDiscoveryActivities(deps).enrichRun(discoveryArgs("run-enrich-lease", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ enriched: 1, nextIndex: null, skippedForLease: 2 });
    expect(enricher.enrichCompany).toHaveBeenCalledOnce();
  });

  it("does not count a company every enricher already read as left for the lease", async () => {
    const enricher = gleif();
    const deps = await withMatchCompanies(makeEnrichDeps([enricher]), ["c1", "c2"]);
    const prisma = deps.prisma as unknown as {
      withWorkspace: (ws: string, fn: (tx: Record<string, Record<string, unknown>>) => Promise<unknown>) => Promise<unknown>;
    };
    await prisma.withWorkspace("ws", async (tx) => {
      const findMany = tx.canonicalCompany!.findMany as (args: unknown) => Promise<Array<Record<string, unknown>>>;
      tx.canonicalCompany!.findMany = async (args: unknown) =>
        (await findMany(args)).map((company) => ({ ...company, attributes: { gleif: { lei: "x" } } }));
    });
    Object.assign(deps, { now: () => 0, runLease: leaseLeaving(0) });

    const result = await createDiscoveryActivities(deps).enrichRun(
      discoveryArgs("run-enrich-lease-done", { icpId: "icp-1" }),
    );
    expect(result).toMatchObject({ enriched: 0, nextIndex: null });
    expect(result).not.toHaveProperty("skippedForLease");
    expect(enricher.enrichCompany).not.toHaveBeenCalled();
  });

  it("counts a company one of several enrichers has not read yet as left for the lease", async () => {
    const enricher = gleif();
    const wikidata = { key: "wikidata", enrichCompany: vi.fn(async () => ({ matched: false }) as EnrichmentResult) };
    const deps = await withMatchCompanies(makeEnrichDeps([enricher, wikidata]), ["c1", "c2"]);
    const prisma = deps.prisma as unknown as {
      withWorkspace: (ws: string, fn: (tx: Record<string, Record<string, unknown>>) => Promise<unknown>) => Promise<unknown>;
    };
    await prisma.withWorkspace("ws", async (tx) => {
      const findMany = tx.canonicalCompany!.findMany as (args: unknown) => Promise<Array<Record<string, unknown>>>;
      tx.canonicalCompany!.findMany = async (args: unknown) =>
        (await findMany(args)).map((company) => ({ ...company, attributes: { gleif: { lei: "x" } } }));
    });
    Object.assign(deps, { now: () => 0, runLease: leaseLeaving(0) });

    await expect(
      createDiscoveryActivities(deps).enrichRun(discoveryArgs("run-enrich-lease-partial", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ enriched: 0, nextIndex: null, skippedForLease: 2 });
  });

  it("reports no lease skip while the lease has room", async () => {
    const deps = await withMatchCompanies(makeEnrichDeps([gleif()]), ["c1", "c2"]);
    Object.assign(deps, { now: () => 0, runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.enrich) });

    const result = await createDiscoveryActivities(deps).enrichRun(
      discoveryArgs("run-enrich-lease-room", { icpId: "icp-1" }),
    );
    expect(result).toMatchObject({ enriched: 2, nextIndex: null });
    expect(result).not.toHaveProperty("skippedForLease");
  });

  it.each([-1, 1.5, 51, "1"])("rejects a continuation index of %s before any enrichment", async (startIndex) => {
    const enricher = gleif();
    const deps = makeEnrichDeps([enricher]);

    await expect(
      createDiscoveryActivities(deps).enrichRun(
        discoveryArgs("run-enrich-bad", { icpId: "icp-1", startIndex }) as never,
      ),
    ).rejects.toMatchObject({ type: "DISCOVERY_STAGE_CONTINUATION_INVALID", nonRetryable: true });
    expect(enricher.enrichCompany).not.toHaveBeenCalled();
  });
});

describe("enrichSignalsRun —— 按时限把余下公司留给下一次 run", () => {
  const signalEnricher = () => ({
    key: "digital_footprint",
    enrichCompany: vi.fn(async () => ({ matched: false }) as EnrichmentResult),
  });

  it("stops at the first company the lease has no room for and counts the rest", async () => {
    const enricher = signalEnricher();
    const deps = await withMatchCompanies(makeEnrichDeps([enricher]), ["c1", "c2", "c3"]);
    Object.assign(deps, { now: () => 0, runLease: leaseLeaving(0) });

    await expect(
      createDiscoveryActivities(deps).enrichSignalsRun(discoveryArgs("run-signal-lease", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ enriched: 0, skippedForLease: 3 });
    expect(enricher.enrichCompany).not.toHaveBeenCalled();
  });

  it("does not count a company every signal source already read as left for the lease", async () => {
    const enricher = signalEnricher();
    const deps = await withMatchCompanies(makeEnrichDeps([enricher]), ["c1", "c2"]);
    const prisma = deps.prisma as unknown as {
      withWorkspace: (ws: string, fn: (tx: Record<string, Record<string, unknown>>) => Promise<unknown>) => Promise<unknown>;
    };
    await prisma.withWorkspace("ws", async (tx) => {
      const findMany = tx.canonicalCompany!.findMany as (args: unknown) => Promise<Array<Record<string, unknown>>>;
      tx.canonicalCompany!.findMany = async (args: unknown) =>
        (await findMany(args)).map((company) => ({
          ...company,
          attributes: { digital_footprint: { _ts: new Date().toISOString() } },
        }));
    });
    Object.assign(deps, { now: () => 0, runLease: leaseLeaving(0) });

    const result = await createDiscoveryActivities(deps).enrichSignalsRun(
      discoveryArgs("run-signal-lease-done", { icpId: "icp-1" }),
    );
    expect(result).toMatchObject({ enriched: 0 });
    expect(result).not.toHaveProperty("skippedForLease");
    expect(enricher.enrichCompany).not.toHaveBeenCalled();
  });

  it("reports no lease skip while the lease has room", async () => {
    const deps = await withMatchCompanies(makeEnrichDeps([signalEnricher()]), ["c1", "c2"]);
    Object.assign(deps, { now: () => 0, runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.enrich) });

    const result = await createDiscoveryActivities(deps).enrichSignalsRun(
      discoveryArgs("run-signal-lease-room", { icpId: "icp-1" }),
    );
    expect(result).toMatchObject({ enriched: 2 });
    expect(result).not.toHaveProperty("skippedForLease");
  });
});

describe("company-subject call sites (G3 5.5)", () => {
  it("binds every signal-enrichment wire to the canonical company it enriches", async () => {
    const enricher = {
      key: "digital_footprint",
      enrichCompany: vi.fn(async () => ({ matched: false }) as EnrichmentResult),
    };

    await createDiscoveryActivities(makeEnrichDeps([enricher])).enrichSignalsRun(
      discoveryArgs("run-signal-subject", { icpId: "icp-1" }),
    );

    expect(enricher.enrichCompany).toHaveBeenCalledOnce();
    expect(enricher.enrichCompany.mock.calls[0]![1]).toMatchObject({
      artifactSubject: { subjectType: "company", subjectId: "c1" },
    });
  });

  it.each([
    "GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED",
    "GENERIC_OPERATION_ARTIFACT_SUBJECT_SUPPRESSED",
  ])("skips a company whose subject is denied (%s) and reports it instead of failing the run", async (reason) => {
    const later = {
      key: "structured_harvest",
      enrichCompany: vi.fn(async () => ({ matched: true, attributes: { x: 1 } }) as unknown as EnrichmentResult),
    };
    const denied = {
      key: "digital_footprint",
      enrichCompany: vi.fn(async () => {
        throw new ToolPolicyDenied("crawl4ai.render", reason);
      }),
    };

    const result = await createDiscoveryActivities(makeEnrichDeps([denied, later])).enrichSignalsRun(
      discoveryArgs(`run-signal-skip-${reason}`, { icpId: "icp-1" }),
    );

    expect(result).toMatchObject({ enriched: 0, matched: 0, skippedSubjects: 1 });
    expect(later.enrichCompany).not.toHaveBeenCalled();
  });

  it("skips a company whose watch sitemap wire is denied for its subject", async () => {
    const deps = makeEnrichDeps([]) as unknown as {
      prisma: { withWorkspace: (ws: string, fn: (tx: Record<string, Record<string, unknown>>) => Promise<unknown>) => Promise<unknown> };
      broker?: unknown;
      platformWriter?: unknown;
    };
    await deps.prisma.withWorkspace("ws", async (tx) => {
      tx.fieldEvidence!.findMany = async () => [];
    });
    const invoke = vi.fn(async () => {
      throw new ToolPolicyDenied("http.get", "GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED");
    });
    deps.broker = { invoke };
    const $transaction = vi.fn();
    deps.platformWriter = { $transaction };

    const result = await createDiscoveryActivities(deps as never).registerWatchesForRun(
      discoveryArgs("run-watch-skip", { icpId: "icp-1" }) as never,
    );

    expect(invoke).toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 1, registered: 0, skippedSubjects: 1, unreplayable: 0 });
  });

  it("registers no watch and fetches no sitemap in a worker without the platform writer", async () => {
    // A watch is a platform row. The sitemap reads behind it return durable receipts that only
    // the platform writer's transaction may acknowledge, and the customer worker has no
    // platform writer: registering would end in DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE, a
    // control error that fails the whole run after its leads were already written.
    const deps = makeEnrichDeps([]) as unknown as {
      prisma: { withWorkspace: (ws: string, fn: (tx: Record<string, Record<string, unknown>>) => Promise<unknown>) => Promise<unknown> };
      broker?: unknown;
    };
    await deps.prisma.withWorkspace("ws", async (tx) => {
      tx.fieldEvidence!.findMany = async () => [];
    });
    // What the broker really returns for a budgeted sitemap read: an http-get artifact receipt.
    const httpReceipt: DurableExecutionReceipt = Object.freeze({
      ...ENRICHMENT_RECEIPT,
      operationKey: "watch-sitemap-http-get",
      resultStrategy: "artifact_reference",
      resultSchema: "http-get/v1",
      artifactId: "50000000-0000-4000-8000-000000000001",
    });
    const invoke = vi.fn(async () => ({
      data: { status: 404, ok: false, mediaType: "text/plain", text: "" },
      costCents: 0,
      durableReceipt: httpReceipt,
    }));
    deps.broker = { invoke };

    await expect(
      createDiscoveryActivities(deps as never).registerWatchesForRun(
        discoveryArgs("run-watch-no-platform-writer", { icpId: "icp-1" }) as never,
      ),
    ).resolves.toEqual({ candidates: 1, registered: 0, skippedSubjects: 0, unreplayable: 0 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still fails the run when the artifact store itself is unavailable", async () => {
    const enricher = {
      key: "digital_footprint",
      enrichCompany: vi.fn(async () => {
        throw new ToolPolicyDenied("crawl4ai.render", "GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE");
      }),
    };

    await expect(
      createDiscoveryActivities(makeEnrichDeps([enricher])).enrichSignalsRun(
        discoveryArgs("run-signal-storage", { icpId: "icp-1" }),
      ),
    ).rejects.toThrow("GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE");
  });
});

describe("profileWebsitesForRun (G3 5.4b)", () => {
  const PROFILE = {
    homepageUrl: "https://c1.de/",
    impressumUrl: "https://c1.de/impressum",
    tradeRole: "distributor",
    tradeRoleSource: "rules",
    tradeRoleConfidence: 0.7,
    ownManufacturing: null,
    carriedBrands: [{ name: "Grundfos", country: "dk" }],
    carriesChineseBrand: false,
    carriesForeignBrand: true,
    legalName: "C1 Pumpen GmbH",
    register: { type: "HRB", number: "1", court: "Köln", key: "de-hrb:koeln:1" },
    vatId: "DE136695976",
    evidence: ["Großhandel für Pumpen"],
  };

  async function makeProfileDeps(
    profile: ReturnType<typeof vi.fn>,
    options: {
      status?: string;
      attributes?: Record<string, unknown>;
      companies?: string[];
      now?: () => number;
      runLease?: () => Promise<number>;
    } = {},
  ) {
    const deps = makeEnrichDeps([]) as unknown as {
      prisma: { withWorkspace: (ws: string, fn: (tx: Record<string, Record<string, unknown>>) => Promise<unknown>) => Promise<unknown> };
      websiteProfile?: unknown;
      now?: () => number;
      runLease?: () => Promise<number>;
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async () =>
      (options.companies ?? ["c1"]).map((id) => ({
        id,
        name: id.toUpperCase(),
        domain: `${id}.de`,
        country: "DE",
        attributes: options.attributes ?? {},
      })),
    );
    await deps.prisma.withWorkspace("ws", async (tx) => {
      // BI-14's company_contact switch keeps its seeded DISABLED here; its own cases are below.
      tx.dataProvider = {
        findUnique: vi.fn(async ({ where }: { where: { key: string } }) => ({
          status: where.key === "company_contact" ? "DISABLED" : options.status ?? "ENABLED",
        })),
      };
      tx.icpDefinition = {
        findUnique: vi.fn(async () => ({
          companyAttributes: { industry: "Pumpen", product: "Kreiselpumpen" },
          targetMarkets: ["德国（DACH）"],
        })),
      };
      tx.canonicalCompany!.updateMany = updateMany;
      tx.canonicalCompany!.findMany = findMany;
      tx.fieldEvidence!.findMany = async () => [];
    });
    deps.websiteProfile = { profile };
    if (options.now) deps.now = options.now;
    if (options.runLease) deps.runLease = options.runLease;
    return { acts: createDiscoveryActivities(deps as never), updateMany, findMany };
  }

  it("stops for the admission lease and counts the run's companies it left unprofiled", async () => {
    let now = 0;
    const profile = vi.fn(async () => {
      now += 2 * MINUTE;
      return PROFILE;
    });
    const { acts } = await makeProfileDeps(profile, {
      companies: ["c1", "c2", "c3"],
      now: () => now,
      runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.websiteProfile),
    });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-lease", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 1, nextIndex: null, skippedForLease: 2 });
    expect(profile).toHaveBeenCalledOnce();
  });

  it("does not count a fresh profile as left for the lease", async () => {
    const profile = vi.fn();
    const { acts } = await makeProfileDeps(profile, {
      companies: ["c1", "c2"],
      attributes: { website_profile: { _ts: new Date().toISOString() } },
      now: () => 0,
      runLease: leaseLeaving(0),
    });

    const result = await acts.profileWebsitesForRun(discoveryArgs("run-profile-lease-fresh", { icpId: "icp-1" }));
    expect(result).toMatchObject({ profiled: 0, nextIndex: null });
    expect(result).not.toHaveProperty("skippedForLease");
    expect(profile).not.toHaveBeenCalled();
  });

  it("stops for the lease instead of failing when an unavailable upstream's wait does not fit", async () => {
    const profile = vi.fn(async () => {
      throw new ProviderHttpError({ status: 503, provider: "gateway", model: "deepseek-v4-pro" });
    });
    const { acts } = await makeProfileDeps(profile, {
      companies: ["c1", "c2"],
      now: () => 0,
      runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.websiteProfile),
    });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-lease-upstream", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 0, nextIndex: null, skippedForLease: 2 });
  });

  it("is a no-op while the website_profile source is not ENABLED", async () => {
    const profile = vi.fn();
    const { acts } = await makeProfileDeps(profile, { status: "DISABLED" });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-off", { icpId: "icp-1" })),
    ).resolves.toEqual({
      profiled: 0,
      matched: 0,
      skippedSubjects: 0,
      budgetTruncated: false,
      unclassified: 0,
      nextIndex: null,
      unreplayable: 0,
      previousUnreplayable: false,
      backfilled: 0,
    });
    expect(profile).not.toHaveBeenCalled();
  });

  it("profiles run companies bound to their subject and stores the company-level profile", async () => {
    const profile = vi.fn(async () => PROFILE);
    const { acts, updateMany } = await makeProfileDeps(profile);

    const result = await acts.profileWebsitesForRun(discoveryArgs("run-profile", { icpId: "icp-1" }));

    expect(result).toMatchObject({ profiled: 1, matched: 1, skippedSubjects: 0 });
    const [input, ctx] = profile.mock.calls[0]!;
    expect(input).toMatchObject({ domain: "c1.de", homeCountry: "de" });
    expect(input.icpContext).toContain("Pumpen");
    expect(ctx).toMatchObject({ artifactSubject: { subjectType: "company", subjectId: "c1" } });
    const attributes = (updateMany.mock.calls[0]![0] as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(attributes.website_profile).toMatchObject({
      trade_role: "distributor",
      trade_role_source: "rules",
      carried_brands: [{ name: "Grundfos", country: "dk" }],
      carries_foreign_brand: true,
      legal_name: "C1 Pumpen GmbH",
      register_key: "de-hrb:koeln:1",
      vat_id: "DE136695976",
      evidence: ["Großhandel für Pumpen"],
    });
  });

  it("judges brand foreignness from the company's own country before the ICP market", async () => {
    const profile = vi.fn(async () => PROFILE);
    const { acts } = await makeProfileDeps(profile);
    // makeProfileDeps: company country "DE"; its ICP market ("德国（DACH）") is unrecognizable.
    await acts.profileWebsitesForRun(discoveryArgs("run-profile-home", { icpId: "icp-1" }));

    expect(profile.mock.calls[0]![0]).toMatchObject({ homeCountry: "de" });
  });

  it("does not refetch a company profiled within the profile TTL", async () => {
    const profile = vi.fn(async () => PROFILE);
    const { acts } = await makeProfileDeps(profile, {
      attributes: { website_profile: { trade_role: "distributor", _ts: new Date().toISOString() } },
    });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-fresh", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 0 });
    expect(profile).not.toHaveBeenCalled();
  });

  it("skips a company whose subject is denied and reports it", async () => {
    const profile = vi.fn(async () => {
      throw new ToolPolicyDenied("crawl4ai.fetch", "GENERIC_OPERATION_ARTIFACT_SUBJECT_TOMBSTONED");
    });
    const { acts, updateMany } = await makeProfileDeps(profile);

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-skip", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 0, matched: 0, skippedSubjects: 1 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("ends the attempt with a retryable failure that waits when the model upstream is unavailable", async () => {
    const error = new ProviderHttpError({ status: 521, provider: "gateway", model: "deepseek-v4-pro" });
    const profile = vi.fn(async () => {
      throw error;
    });
    const { acts, updateMany } = await makeProfileDeps(profile, { companies: ["c1", "c2"] });

    const failure = await acts
      .profileWebsitesForRun(discoveryArgs("run-profile-upstream", { icpId: "icp-1" }))
      .then(() => undefined, (reason: unknown) => reason);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({ type: "ProviderHttpError", nonRetryable: false, nextRetryDelay: expect.any(String) });
    // The outage stops the pass at the first company instead of burning through the rest.
    expect(profile).toHaveBeenCalledOnce();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("fails the run when the artifact store is unavailable", async () => {
    const profile = vi.fn(async () => {
      throw new ToolPolicyDenied("crawl4ai.fetch", "GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE");
    });
    const { acts } = await makeProfileDeps(profile);

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-storage", { icpId: "icp-1" })),
    ).rejects.toThrow("GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE");
  });

  it("hands the companies left to the next activity once its time box is spent", async () => {
    const profile = vi.fn(async () => PROFILE);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(PROFILE_PASS_TIME_BOX_MS);
    const { acts } = await makeProfileDeps(profile, { companies: ["c1", "c2", "c3"], now });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-pass", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 1, nextIndex: 1 });
    expect(profile).toHaveBeenCalledOnce();
  });

  it("resumes at the index it was handed, in a stable order, and hands nothing on once done", async () => {
    const profile = vi.fn(async () => PROFILE);
    const { acts, findMany } = await makeProfileDeps(profile, {
      companies: ["c1", "c2", "c3"],
      now: () => 0,
    });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-resume", { icpId: "icp-1", startIndex: 1 })),
    ).resolves.toMatchObject({ profiled: 2, nextIndex: null });
    expect(profile.mock.calls.map(([input]) => (input as { domain: string }).domain)).toEqual([
      "c2.de",
      "c3.de",
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    );
  });

  it("skips a company whose fetch cannot be replayed, counts it, and profiles the rest", async () => {
    const profile = vi
      .fn()
      .mockRejectedValueOnce(new BudgetOperationReplayError("op-1"))
      .mockResolvedValue(PROFILE);
    const { acts } = await makeProfileDeps(profile, { companies: ["c1", "c2"], now: () => 0 });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-unreplayable", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 1, unreplayable: 1, previousUnreplayable: false, nextIndex: null });
  });

  it("still stops when two companies in a row cannot be replayed", async () => {
    const second = new BudgetOperationReplayError("op-2");
    const profile = vi
      .fn()
      .mockRejectedValueOnce(new BudgetOperationReplayError("op-1"))
      .mockRejectedValueOnce(second);
    const { acts } = await makeProfileDeps(profile, { companies: ["c1", "c2", "c3"], now: () => 0 });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-unreplayable-twice", { icpId: "icp-1" })),
    ).rejects.toBe(second);
  });

  it("stops on an unreplayable company that follows the one the previous pass ended on", async () => {
    const second = new BudgetOperationReplayError("op-2");
    const profile = vi.fn().mockRejectedValueOnce(second);
    const { acts } = await makeProfileDeps(profile, { companies: ["c1", "c2"], now: () => 0 });

    await expect(
      acts.profileWebsitesForRun(
        discoveryArgs("run-profile-unreplayable-carried", {
          icpId: "icp-1",
          startIndex: 1,
          previousUnreplayable: true,
        }),
      ),
    ).rejects.toBe(second);
  });

  it("tells the next pass that it ended on an unreplayable company", async () => {
    const profile = vi.fn().mockRejectedValueOnce(new BudgetOperationReplayError("op-1"));
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(PROFILE_PASS_TIME_BOX_MS);
    const { acts } = await makeProfileDeps(profile, { companies: ["c1", "c2"], now });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-profile-unreplayable-handoff", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ unreplayable: 1, nextIndex: 1, previousUnreplayable: true });
  });

  it("rejects an unreplayable flag that is not a boolean", async () => {
    const profile = vi.fn(async () => PROFILE);
    const { acts } = await makeProfileDeps(profile);

    await expect(
      acts.profileWebsitesForRun(
        discoveryArgs("run-profile-bad-flag", { icpId: "icp-1", previousUnreplayable: "yes" }) as never,
      ),
    ).rejects.toMatchObject({ type: "DISCOVERY_STAGE_CONTINUATION_INVALID", nonRetryable: true });
    expect(profile).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, 51, "1"])("rejects a continuation index of %s before any fetch", async (startIndex) => {
    const profile = vi.fn(async () => PROFILE);
    const { acts } = await makeProfileDeps(profile);

    await expect(
      acts.profileWebsitesForRun(
        discoveryArgs("run-profile-bad", { icpId: "icp-1", startIndex }) as never,
      ),
    ).rejects.toMatchObject({ type: "DISCOVERY_STAGE_CONTINUATION_INVALID", nonRetryable: true });
    expect(profile).not.toHaveBeenCalled();
  });
});

describe("profileWebsitesForRun contact paths (BI-14)", () => {
  // Synthetic `.example` company and made-up slugs and handles only.
  const SITE = "https://pumpen-handel.example";
  const COMPANY = { id: "c1", name: "Pumpen Handel GmbH", domain: "pumpen-handel.example", country: "DE" };
  const PATHS = {
    contactPage: `${SITE}/kontakt`,
    impressumPage: `${SITE}/impressum`,
    supplierPage: `${SITE}/lieferanten`,
    linkedinCompanyPage: "https://www.linkedin.com/company/pumpen-handel-example",
    xCompanyAccount: "https://x.com/pumpenhandel",
    linksChecked: true,
    contactForm: `${SITE}/kontakt`,
    contactFormChecked: true,
  };
  const PROFILE = {
    homepageUrl: `${SITE}/`,
    impressumUrl: `${SITE}/impressum`,
    tradeRole: "distributor",
    tradeRoleSource: "rules",
    tradeRoleConfidence: 0.7,
    ownManufacturing: null,
    carriedBrands: [],
    carriesChineseBrand: false,
    carriesForeignBrand: false,
    legalName: "Pumpen Handel GmbH",
    register: null,
    vatId: null,
    evidence: [],
  };

  type Committed = {
    where?: { id?: string };
    data: { attributes: Record<string, Record<string, unknown>> };
  };
  type Row = { id: string; name: string; domain: string; country: string; attributes: unknown };

  async function makeContactDeps(
    profile: ReturnType<typeof vi.fn>,
    options: {
      contactStatus?: string;
      attributes?: Record<string, unknown>;
      lockedStatus?: string;
      /** Workspace companies outside the run whose contact paths were never read (the backfill candidates). */
      backfill?: Array<{ id: string; name: string; domain: string; country: string; attributes: Record<string, unknown> }>;
      runCompanies?: Array<{ id: string; name: string; domain: string; country: string }>;
      /** What a re-read of the company finds now (e.g. stamped by a concurrent run since the list was read). */
      current?: Record<string, Record<string, unknown>>;
    } = {},
  ) {
    const deps = makeEnrichDeps([]) as unknown as {
      prisma: { withWorkspace: (ws: string, fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
      websiteProfile?: unknown;
    };
    const attributes = options.attributes ?? {};
    // The stored companies: re-reads and writes go through this map, like the rows of one database.
    const rows = new Map<string, Row>();
    for (const company of options.runCompanies ?? [COMPANY]) rows.set(company.id, { ...company, attributes });
    for (const company of options.backfill ?? []) rows.set(company.id, { ...company });
    for (const [id, current] of Object.entries(options.current ?? {})) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, attributes: current });
    }
    const updateMany = vi.fn(async (args: Committed) => {
      const row = args.where?.id ? rows.get(args.where.id) : undefined;
      if (row && args.data.attributes !== undefined) row.attributes = args.data.attributes;
      return { count: 1 };
    });
    const points = {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const backfillQueries: unknown[][] = [];
    await deps.prisma.withWorkspace("ws", async (raw) => {
      const tx = raw as Record<string, unknown> & { canonicalCompany: Record<string, unknown> };
      tx.$queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("FOR SHARE")) {
          return [{ status: options.lockedStatus ?? "NEW", name: COMPANY.name, domain: COMPANY.domain }];
        }
        if (sql.includes("_contact_parser")) {
          backfillQueries.push(values);
          return options.backfill ?? [];
        }
        return [{ locked: true }];
      });
      tx.discoveryRun = { findUnique: vi.fn(async () => ({ createdAt: new Date("2026-10-14T00:00:00Z") })) };
      tx.dataProvider = {
        findUnique: vi.fn(async ({ where }: { where: { key: string } }) => ({
          status: where.key === "company_contact" ? options.contactStatus ?? "DISABLED" : "ENABLED",
        })),
      };
      tx.icpDefinition = {
        findUnique: vi.fn(async () => ({ companyAttributes: { industry: "Pumpen" }, targetMarkets: ["DE"] })),
      };
      tx.canonicalCompany.updateMany = updateMany;
      tx.canonicalCompany.findMany = async () =>
        (options.runCompanies ?? [COMPANY]).map((company) => ({ ...company, attributes }));
      tx.canonicalCompany.findUnique = async ({ where }: { where: { id: string } }) => ({
        ...(rows.get(where.id) ?? { ...COMPANY, attributes }),
        status: "NEW",
      });
      tx.companyContactPoint = points;
    });
    deps.websiteProfile = { profile };
    return { acts: createDiscoveryActivities(deps as never), updateMany, points, backfillQueries, rows };
  }

  const websiteProfileOf = (row: Row | undefined) =>
    ((row?.attributes ?? {}) as { website_profile?: Record<string, unknown> }).website_profile ?? {};
  const stampWrites = (updateMany: ReturnType<typeof vi.fn>) =>
    updateMany.mock.calls.filter(([args]) => JSON.stringify((args as Committed).data).includes("_contact_attempt_at"));

  it("leaves contact paths alone while company_contact is DISABLED: nothing asked for, no points", async () => {
    // A provider that returns contact paths anyway is ignored.
    const profile = vi.fn(async () => ({ ...PROFILE, contactPaths: PATHS }));
    const { acts, updateMany, points } = await makeContactDeps(profile);

    await acts.profileWebsitesForRun(discoveryArgs("run-contact-off", { icpId: "icp-1" }));

    expect(profile.mock.calls[0]![0]).toMatchObject({ contactPaths: false });
    expect(points.findMany).not.toHaveBeenCalled();
    expect(points.createMany).not.toHaveBeenCalled();
    expect(points.updateMany).not.toHaveBeenCalled();
    const profileAttributes = updateMany.mock.calls[0]![0].data.attributes.website_profile;
    expect(profileAttributes).not.toHaveProperty("_contact_parser");
    // The source page of the profile facts is kept either way (A4).
    expect(profileAttributes).toMatchObject({ source_url: `${SITE}/impressum` });
    // Contact paths were not read, so no attempt is recorded either (W5-f).
    expect(stampWrites(updateMany)).toEqual([]);
  });

  it("asks for contact paths while company_contact is ENABLED and stores them in the profile transaction", async () => {
    const profile = vi.fn(async () => ({ ...PROFILE, contactPaths: PATHS }));
    const { acts, updateMany, points } = await makeContactDeps(profile, { contactStatus: "ENABLED" });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-contact-on", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 1, matched: 1 });

    expect(profile.mock.calls[0]![0]).toMatchObject({ domain: "pumpen-handel.example", contactPaths: true });
    expect(points.createMany).toHaveBeenCalledOnce();
    const created = points.createMany.mock.calls[0]![0] as {
      data: Array<Record<string, unknown>>;
      skipDuplicates: boolean;
    };
    expect(created.skipDuplicates).toBe(true);
    expect(created.data.map(({ kind, value, status, dataClass, providerKey }) =>
      [kind, value, status, dataClass, providerKey])).toEqual([
      ["contact_page", PATHS.contactPage, "UNVERIFIED", "green", "company_contact"],
      ["impressum_page", PATHS.impressumPage, "UNVERIFIED", "green", "company_contact"],
      ["supplier_page", PATHS.supplierPage, "UNVERIFIED", "green", "company_contact"],
      ["linkedin_company_page", PATHS.linkedinCompanyPage, "UNVERIFIED", "green", "company_contact"],
      ["x_company_account", PATHS.xCompanyAccount, "UNVERIFIED", "green", "company_contact"],
      ["contact_form", PATHS.contactForm, "UNVERIFIED", "green", "company_contact"],
    ]);
    expect(updateMany.mock.calls[0]![0].data.attributes.website_profile).toMatchObject({
      _contact_parser: "company_contact/v1",
      source_url: `${SITE}/impressum`,
    });
  });

  it("re-reads a recently profiled company once when its contact paths were never read under the current rules", async () => {
    const fresh = new Date().toISOString();
    const cases: Array<[Record<string, unknown>, string, number]> = [
      [{ trade_role: "distributor", _ts: fresh }, "ENABLED", 1],
      [{ trade_role: "distributor", _ts: fresh, _contact_parser: "company_contact/v1" }, "ENABLED", 0],
      [{ trade_role: "distributor", _ts: fresh }, "DISABLED", 0],
    ];
    for (const [websiteProfile, contactStatus, profiles] of cases) {
      const profile = vi.fn(async () => PROFILE);
      const { acts } = await makeContactDeps(profile, {
        contactStatus,
        attributes: { website_profile: websiteProfile },
      });
      await acts.profileWebsitesForRun(discoveryArgs(`run-contact-ttl-${profiles}`, { icpId: "icp-1" }));
      expect(profile, `${contactStatus} ${JSON.stringify(websiteProfile)}`).toHaveBeenCalledTimes(profiles);
    }
  });

  it("re-reads the company FOR SHARE before writing points: a company suppressed meanwhile gets none", async () => {
    const profile = vi.fn(async () => ({ ...PROFILE, contactPaths: PATHS }));
    const { acts, points } = await makeContactDeps(profile, {
      contactStatus: "ENABLED",
      lockedStatus: "SUPPRESSED",
    });

    await acts.profileWebsitesForRun(discoveryArgs("run-contact-suppressed", { icpId: "icp-1" }));

    expect(profile).toHaveBeenCalledOnce();
    expect(points.findMany).not.toHaveBeenCalled();
    expect(points.createMany).not.toHaveBeenCalled();
    expect(points.updateMany).not.toHaveBeenCalled();
  });

  // ── 评分规则 v3：补联系路径（backfill）——开关打开后，每个 run 用画像配额的余量读工作区里还没读过联系路径的公司 ──
  const BACKFILL = [
    { id: "b1", name: "B1 Pumpen", domain: "b1-pumpen.example", country: "DE", attributes: {} },
    { id: "b2", name: "B2 Armaturen", domain: "b2-armaturen.example", country: "AT", attributes: {} },
  ];

  it("fills the remaining profile quota with workspace companies whose contact paths were never read (switch ENABLED)", async () => {
    const profile = vi.fn(async () => ({ ...PROFILE, contactPaths: PATHS }));
    const { acts, backfillQueries } = await makeContactDeps(profile, { contactStatus: "ENABLED", backfill: BACKFILL });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-contact-backfill", { icpId: "icp-1" })),
    // profiled / matched count the run's own companies only; the backfill companies are counted apart (W5-f).
    ).resolves.toMatchObject({ profiled: 1, matched: 1, backfilled: 2, nextIndex: null });

    expect(profile.mock.calls.map((call) => (call[0] as { domain: string }).domain)).toEqual([
      COMPANY.domain,
      "b1-pumpen.example",
      "b2-armaturen.example",
    ]);
    // The candidate query takes only the quota the run's own companies left over.
    expect(backfillQueries).toHaveLength(1);
    expect(backfillQueries[0]).toContain(MAX_DISCOVERY_PROFILE_COMPANIES - 1);
  });

  it("does not look for backfill candidates while company_contact is DISABLED", async () => {
    const profile = vi.fn(async () => PROFILE);
    const { acts, backfillQueries } = await makeContactDeps(profile, { backfill: BACKFILL });

    await acts.profileWebsitesForRun(discoveryArgs("run-contact-backfill-off", { icpId: "icp-1" }));

    expect(backfillQueries).toHaveLength(0);
    expect(profile).toHaveBeenCalledOnce();
  });

  it("a continuation activity starting past the run's own list profiles the backfill companies only", async () => {
    const profile = vi.fn(async () => ({ ...PROFILE, contactPaths: PATHS }));
    const { acts } = await makeContactDeps(profile, { contactStatus: "ENABLED", backfill: BACKFILL });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-contact-backfill-resume", { icpId: "icp-1", startIndex: 1 })),
    ).resolves.toMatchObject({ profiled: 0, matched: 0, backfilled: 2 });

    expect(profile.mock.calls.map((call) => (call[0] as { domain: string }).domain)).toEqual([
      "b1-pumpen.example",
      "b2-armaturen.example",
    ]);
  });

  it("does not look for backfill candidates when the run's own companies already fill the quota", async () => {
    const profile = vi.fn(async () => null);
    const runCompanies = Array.from({ length: MAX_DISCOVERY_PROFILE_COMPANIES }, (_, index) => ({
      id: `r${index}`,
      name: `R${index}`,
      domain: `r${index}.example`,
      country: "DE",
    }));
    const { acts, backfillQueries } = await makeContactDeps(profile, {
      contactStatus: "ENABLED",
      backfill: BACKFILL,
      runCompanies,
    });

    await acts.profileWebsitesForRun(discoveryArgs("run-contact-backfill-full", { icpId: "icp-1" }));

    expect(backfillQueries).toHaveLength(0);
    expect(profile).toHaveBeenCalledTimes(MAX_DISCOVERY_PROFILE_COMPANIES);
  });

  it("skips a backfill candidate this run already read (it stays in the list so continuation indexes hold)", async () => {
    const profile = vi.fn(async () => ({ ...PROFILE, contactPaths: PATHS }));
    const alreadyRead = {
      ...BACKFILL[0]!,
      attributes: {
        website_profile: { trade_role: "distributor", _ts: new Date().toISOString(), _contact_parser: "company_contact/v1" },
      },
    };
    const { acts } = await makeContactDeps(profile, { contactStatus: "ENABLED", backfill: [alreadyRead, BACKFILL[1]!] });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-contact-backfill-read", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 1, backfilled: 1 });

    expect(profile.mock.calls.map((call) => (call[0] as { domain: string }).domain)).toEqual([
      COMPANY.domain,
      "b2-armaturen.example",
    ]);
  });

  // ── W5-f：尝试水位与 7 天冷却——画像返回空、死站、主体被拒的公司不再永远占着候选最前面 ──
  it("stamps every contact-path attempt, also one whose profile came back empty, and keeps the facts of a read one", async () => {
    const profile = vi.fn(async (input: { domain: string }) =>
      input.domain === "b1-pumpen.example" ? null : { ...PROFILE, contactPaths: PATHS },
    );
    const { acts, rows } = await makeContactDeps(profile, { contactStatus: "ENABLED", backfill: BACKFILL });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-contact-attempt", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 1, matched: 1, backfilled: 2 });

    // Robots-blocked / empty / dead site: no facts, no parser marker, but the attempt is on record.
    const empty = websiteProfileOf(rows.get("b1"));
    expect(Date.parse(String(empty._contact_attempt_at))).not.toBeNaN();
    expect(empty).not.toHaveProperty("_contact_attempt_prev");
    expect(empty).not.toHaveProperty("_contact_parser");
    expect(empty).not.toHaveProperty("trade_role");
    // A company read successfully keeps its facts and parser marker next to the stamp.
    for (const id of [COMPANY.id, "b2"]) {
      expect(websiteProfileOf(rows.get(id)), id).toMatchObject({
        _contact_parser: "company_contact/v1",
        source_url: `${SITE}/impressum`,
        _contact_attempt_at: expect.any(String),
      });
    }
  });

  it("stamps a backfill company whose subject is denied (bookkeeping only, no facts)", async () => {
    const profile = vi.fn(async (input: { domain: string }) => {
      if (input.domain === "b1-pumpen.example") {
        throw new ToolPolicyDenied("http.get", "GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD");
      }
      return { ...PROFILE, contactPaths: PATHS };
    });
    const { acts, rows } = await makeContactDeps(profile, { contactStatus: "ENABLED", backfill: BACKFILL });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-contact-denied", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ skippedSubjects: 1, backfilled: 1 });

    const denied = websiteProfileOf(rows.get("b1"));
    expect(Object.keys(denied)).toEqual(["_contact_attempt_at"]);
  });

  it("keeps the attempt before this run as `previous` and stamps a company tried before the cooldown again", async () => {
    const tried = {
      ...BACKFILL[0]!,
      attributes: { website_profile: { _contact_attempt_at: "2026-09-01T00:00:00.000Z" } },
    };
    const profile = vi.fn(async () => null);
    const { acts, rows } = await makeContactDeps(profile, { contactStatus: "ENABLED", backfill: [tried] });

    await acts.profileWebsitesForRun(discoveryArgs("run-contact-retry", { icpId: "icp-1" }));

    expect(profile.mock.calls.map((call) => (call[0] as { domain: string }).domain)).toContain("b1-pumpen.example");
    expect(websiteProfileOf(rows.get("b1"))).toMatchObject({
      _contact_attempt_at: expect.any(String),
      _contact_attempt_prev: "2026-09-01T00:00:00.000Z",
    });
  });

  it("re-reads each backfill company before profiling it: one a concurrent run attempted since this run began is skipped", async () => {
    const profile = vi.fn(async () => ({ ...PROFILE, contactPaths: PATHS }));
    const { acts, updateMany } = await makeContactDeps(profile, {
      contactStatus: "ENABLED",
      backfill: BACKFILL,
      // The list still shows b1 unread; the stored row was stamped since by another run whose read failed.
      current: { b1: { website_profile: { _contact_attempt_at: "2026-10-14T03:00:00.000Z" } } },
    });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-contact-dedupe", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 1, backfilled: 1 });

    expect(profile.mock.calls.map((call) => (call[0] as { domain: string }).domain)).toEqual([
      COMPANY.domain,
      "b2-armaturen.example",
    ]);
    expect(stampWrites(updateMany).some(([args]) => (args as Committed).where?.id === "b1")).toBe(false);
  });

  it("a replayed profile commit counts as matched only when the namespace holds profile facts, not just an attempt stamp", async () => {
    acknowledgementMocks.apply.mockImplementationOnce(
      async (input: {
        transaction: unknown;
        acknowledgements: Array<{ producerId: string }>;
        readback: (transaction: unknown) => Promise<unknown>;
      }) => ({
        status: "REPLAYED",
        acknowledgements: input.acknowledgements.map(({ producerId }) => ({ producerId, status: "REPLAYED" })),
        value: await input.readback(input.transaction),
      }),
    );
    const profile = vi.fn(async (_input: unknown, ctx: ExecutionContext) => {
      ctx.onDurableReceipt?.("http.get", ENRICHMENT_RECEIPT);
      return { ...PROFILE, contactPaths: PATHS };
    });
    // An earlier attempt left only its stamp: no profile facts, so no `_ts`.
    const { acts } = await makeContactDeps(profile, {
      contactStatus: "ENABLED",
      attributes: { website_profile: { _contact_attempt_at: "2026-10-13T00:00:00.000Z" } },
    });

    await expect(
      acts.profileWebsitesForRun(discoveryArgs("run-contact-readback", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ profiled: 1, matched: 0 });
  });

  it("asks for candidates outside the 7-day cooldown, counted from the run's creation", async () => {
    const profile = vi.fn(async () => null);
    const { acts, backfillQueries } = await makeContactDeps(profile, { contactStatus: "ENABLED", backfill: [] });

    await acts.profileWebsitesForRun(discoveryArgs("run-contact-cutoff", { icpId: "icp-1" }));

    // The run was created 2026-10-14T00:00Z (see makeContactDeps): attempts from 2026-10-07T00:00Z on are cooling.
    expect(backfillQueries[0]).toContain("2026-10-14T00:00:00.000Z");
    expect(backfillQueries[0]).toContain("2026-10-07T00:00:00.000Z");
  });
});

describe("resolveRunStatus —— Fit 判定按公司吸收的模型失败", () => {
  it("有公司没判出来 → 至少 PARTIAL，绝不 DONE", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, fitUnjudged: 1 }),
    ).toBe("PARTIAL");
  });
  it("最后一次尝试一家都没判出也只是 PARTIAL：之前的尝试可能已存下结论，FAILED 会让它们不进评分", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, fitUnjudged: 3 }),
    ).toBe("PARTIAL");
  });
  it("不会把查询全失败的 run 抬成 PARTIAL", () => {
    expect(
      resolveRunStatus({ failures: 3, totalQueries: 3, budgetTruncated: false, fitUnjudged: 1 }),
    ).toBe("FAILED");
  });
  it("没有判定失败时保持原语义，包括旧历史重放时缺这个字段", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, fitUnjudged: 0 }),
    ).toBe("DONE");
    expect(resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false })).toBe("DONE");
  });
});

describe("resolveRunStatus —— a website-profile stage the workflow absorbed", () => {
  it("is at least PARTIAL: the companies after the failure were judged without their profile", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, profileStageFailed: true }),
    ).toBe("PARTIAL");
  });
  it("keeps DONE when the stage finished, including replays of histories without the field", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, profileStageFailed: false }),
    ).toBe("DONE");
  });
});

describe("resolveRunStatus —— 按公司跳过（G3 5.2）", () => {
  it("有公司因禁令类拒绝被跳过 → 至少 PARTIAL，绝不 DONE", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, skippedSubjects: 2 }),
    ).toBe("PARTIAL");
  });
  it("跳过不会把全失败的 run 改成 PARTIAL", () => {
    expect(
      resolveRunStatus({ failures: 3, totalQueries: 3, budgetTruncated: false, skippedSubjects: 1 }),
    ).toBe("FAILED");
  });
  it("零跳过保持原语义", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, skippedSubjects: 0 }),
    ).toBe("DONE");
  });
});

describe("resolveRunStatus —— 数据源停用而跳过的查询（BI-30）", () => {
  it("有查询因数据源停用被跳过 → 至少 PARTIAL，绝不 DONE", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, skippedQueries: 1 }),
    ).toBe("PARTIAL");
  });
  it("全部查询被跳过也只是 PARTIAL，不让 run 失败", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 2, budgetTruncated: false, skippedQueries: 2 }),
    ).toBe("PARTIAL");
  });
  it("零跳过与旧历史（缺这个字段）保持原语义", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, skippedQueries: 0 }),
    ).toBe("DONE");
    expect(resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false })).toBe("DONE");
  });
});

describe("qualifyFitForRun —— 流截断", () => {
  const FIT = {
    provider: "test",
    data: {
      verdict: "match",
      material_gate: "match",
      role_gate: "match",
      process_gate: "match",
      business_model_gate: "match",
      reasons: ["safe"],
    },
  };
  const cut = () =>
    new ProviderTransportError("CHAT_COMPLETIONS_STREAM_TRUNCATED", { inputTokens: 520 });

  function fitActivities(companyIds: string[]) {
    const company = (id: string) => ({
      id,
      name: `${id} GmbH`,
      domain: `${id}.example`,
      country: "DE",
      industry: null,
      status: "NEW",
      attributes: {},
    });
    const tx = {
      $queryRaw: legacyMaterializationQueryRaw(),
      rawSourceRecord: {
        findMany: async () =>
          companyIds.map((id) => ({
            id: `raw-${id}`,
            providerKey: "registry",
            payload: { externalId: id, name: `${id} GmbH`, domain: `${id}.example`, country: "DE" },
          })),
      },
      identityLink: {
        findMany: async () => companyIds.map((id) => ({ canonicalId: id })),
      },
      canonicalCompany: {
        findMany: async () => companyIds.map(company),
        findUnique: async ({ where }: { where: { id: string } }) => company(where.id),
        updateMany: async () => ({ count: 0 }),
      },
      suppressionRecord: { findMany: async () => [] },
      icpDefinition: { findUnique: async () => null },
      lead: { upsert: async () => ({}) },
    };
    return createDiscoveryActivities({
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
  }

  beforeEach(() => {
    fitRuntimeMocks.execute.mockReset();
  });

  it("counts one cut stream as an unjudged company and judges the rest", async () => {
    fitRuntimeMocks.execute
      .mockResolvedValueOnce(FIT)
      .mockRejectedValueOnce(cut())
      .mockResolvedValueOnce(FIT);

    await expect(
      fitActivities(["c1", "c2", "c3"]).qualifyFitForRun(
        discoveryArgs("run-1", { icpId: "icp-1" }),
      ),
    ).resolves.toMatchObject({ judged: 2, unjudged: 1, verdicts: { match: 2 } });
  });

  it("absorbs cut streams that a judged company separates", async () => {
    fitRuntimeMocks.execute
      .mockRejectedValueOnce(cut())
      .mockResolvedValueOnce(FIT)
      .mockRejectedValueOnce(cut());

    await expect(
      fitActivities(["c1", "c2", "c3"]).qualifyFitForRun(
        discoveryArgs("run-1", { icpId: "icp-1" }),
      ),
    ).resolves.toMatchObject({ judged: 1, unjudged: 2 });
  });

  it("stops the activity when two companies in a row lose their fit call to a cut stream", async () => {
    const second = cut();
    fitRuntimeMocks.execute.mockRejectedValueOnce(cut()).mockRejectedValueOnce(second);

    await expect(
      fitActivities(["c1", "c2", "c3"]).qualifyFitForRun(
        discoveryArgs("run-1", { icpId: "icp-1" }),
      ),
    ).rejects.toBe(second);
    // The three companies were in flight together; nothing starts after the stop.
    expect(fitRuntimeMocks.execute).toHaveBeenCalledTimes(FIT_CONCURRENCY);
  });

  it("stops on a second cut after an unusable answer, which is no sign the upstream recovered", async () => {
    const second = cut();
    fitRuntimeMocks.execute
      .mockRejectedValueOnce(cut())
      .mockRejectedValueOnce(
        new ProviderOutputError("STRUCTURED_OUTPUT_NOT_JSON: not JSON", { inputTokens: 520 }),
      )
      .mockRejectedValueOnce(second);

    await expect(
      fitActivities(["c1", "c2", "c3"]).qualifyFitForRun(
        discoveryArgs("run-1", { icpId: "icp-1" }),
      ),
    ).rejects.toBe(second);
  });

  it("leaves a company whose operation cannot be replayed unjudged and judges the rest", async () => {
    // What a retry meets after the previous attempt lost this company's call to a broken stream.
    fitRuntimeMocks.execute
      .mockResolvedValueOnce(FIT)
      .mockRejectedValueOnce(new BudgetOperationReplayError("op-2"))
      .mockResolvedValueOnce(FIT);

    await expect(
      fitActivities(["c1", "c2", "c3"]).qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ judged: 2, unjudged: 1, unreplayable: 1 });
  });

  // A retry meets up to FIT_CONCURRENCY calls an attempt that timed out left behind: losing them
  // says nothing about the upstream, so it neither starts nor continues the two-in-a-row rule.
  it("absorbs an unreplayable company right after a cut stream, and keeps the cut in the row", async () => {
    fitRuntimeMocks.execute
      .mockRejectedValueOnce(cut())
      .mockRejectedValueOnce(new BudgetOperationReplayError("op-2"))
      .mockResolvedValueOnce(FIT);

    await expect(
      fitActivities(["c1", "c2", "c3"]).qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ judged: 1, unjudged: 2, unreplayable: 1, previousCallCut: false });
  });

  it("still stops on a cut stream after an unreplayable company that followed a cut", async () => {
    const second = cut();
    fitRuntimeMocks.execute
      .mockRejectedValueOnce(cut())
      .mockRejectedValueOnce(new BudgetOperationReplayError("op-2"))
      .mockRejectedValueOnce(second);

    await expect(
      fitActivities(["c1", "c2", "c3"]).qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).rejects.toBe(second);
  });

  it("absorbs several unreplayable companies in a row", async () => {
    fitRuntimeMocks.execute
      .mockRejectedValueOnce(new BudgetOperationReplayError("op-1"))
      .mockRejectedValueOnce(new BudgetOperationReplayError("op-2"))
      .mockRejectedValueOnce(new BudgetOperationReplayError("op-3"))
      .mockResolvedValueOnce(FIT);

    await expect(
      fitActivities(["c1", "c2", "c3", "c4"]).qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ judged: 1, unjudged: 3, unreplayable: 3, previousCallCut: false });
  });

  it("still stops on any other transport failure", async () => {
    const failure = new ProviderTransportError("CHAT_COMPLETIONS_STREAM_TRUNCATED", undefined, {
      cause: new ExecutionControlError("EXECUTION_BUDGET_EXHAUSTED"),
    });
    fitRuntimeMocks.execute.mockResolvedValueOnce(FIT).mockRejectedValueOnce(failure);

    await expect(
      fitActivities(["c1", "c2"]).qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).rejects.toBe(failure);
  });
});

describe("qualifyFitForRun —— 按时限把余下公司交给下一次活动", () => {
  const FIT = {
    provider: "test",
    data: {
      verdict: "match",
      material_gate: "match",
      role_gate: "match",
      process_gate: "match",
      business_model_gate: "match",
      reasons: ["safe"],
    },
  };
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const cut = () =>
    new ProviderTransportError("CHAT_COMPLETIONS_STREAM_TRUNCATED", { inputTokens: 520 });

  /** Companies come back in id order after the cursor, as the database returns them. */
  function passActivities(companyIds: string[], now: () => number, runLease?: () => Promise<number>) {
    const leadUpsert = vi.fn(async (..._args: unknown[]) => ({}));
    const company = (companyId: string) => ({
      id: companyId,
      name: `${companyId.slice(-2)} GmbH`,
      domain: `c${companyId.slice(-2)}.example`,
      country: "DE",
      industry: null,
      status: "NEW",
      attributes: {},
    });
    const findMany = vi.fn(async ({ where }: { where: { id: { in: string[]; gt?: string } } }) =>
      [...companyIds]
        .sort()
        .filter((companyId) => where.id.gt === undefined || companyId > where.id.gt)
        .map(company),
    );
    // A company the lookup does not find may not use external processing.
    const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => company(where.id) as ReturnType<typeof company> | null);
    const tx = {
      $queryRaw: legacyMaterializationQueryRaw(),
      rawSourceRecord: {
        findMany: async () =>
          companyIds.map((companyId) => ({
            id: `raw-${companyId}`,
            providerKey: "registry",
            payload: {
              externalId: companyId,
              name: `${companyId.slice(-2)} GmbH`,
              domain: `c${companyId.slice(-2)}.example`,
              country: "DE",
            },
          })),
      },
      identityLink: {
        findMany: async () => companyIds.map((companyId) => ({ canonicalId: companyId })),
      },
      canonicalCompany: {
        findMany,
        findUnique,
        updateMany: async () => ({ count: 0 }),
      },
      suppressionRecord: { findMany: async () => [] },
      icpDefinition: { findUnique: async () => null },
      lead: { upsert: leadUpsert },
    };
    const acts = createDiscoveryActivities({
      prisma: {
        withWorkspace: async <T>(
          _workspaceId: string,
          callback: (client: typeof tx) => Promise<T>,
        ): Promise<T> => callback(tx),
      },
      providers: {},
      gateway: {},
      budgetStore: authorityBudgetStore(),
      now,
      ...(runLease ? { runLease } : {}),
    } as never);
    return { acts, findMany, findUnique, leadUpsert };
  }

  beforeEach(() => {
    fitRuntimeMocks.execute.mockReset();
  });

  it("hands the companies left to the next activity once its time box is spent", async () => {
    fitRuntimeMocks.execute.mockResolvedValue(FIT);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(FIT_PASS_TIME_BOX_MS);
    const { acts } = passActivities([id(1), id(2), id(3)], now);

    await expect(
      acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ judged: 1, nextCompanyId: id(1), previousCallCut: false });
    expect(fitRuntimeMocks.execute).toHaveBeenCalledTimes(1);
  });

  it("resumes after the company it was handed, in id order, and hands nothing on once done", async () => {
    fitRuntimeMocks.execute.mockResolvedValue(FIT);
    const { acts, findMany } = passActivities([id(3), id(1), id(2)], () => 0);

    await expect(
      acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1", afterCompanyId: id(1) })),
    ).resolves.toMatchObject({ judged: 2, nextCompanyId: null });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: expect.objectContaining({ gt: id(1) }) }),
        orderBy: { id: "asc" },
      }),
    );
  });

  it("stops on a cut stream that follows the one the previous activity ended on", async () => {
    const second = cut();
    fitRuntimeMocks.execute.mockRejectedValueOnce(second);
    const { acts } = passActivities([id(2), id(3)], () => 0);

    await expect(
      acts.qualifyFitForRun(
        discoveryArgs("run-1", { icpId: "icp-1", afterCompanyId: id(1), previousCallCut: true }),
      ),
    ).rejects.toBe(second);
  });

  it("tells the next activity that it ended on a cut stream", async () => {
    fitRuntimeMocks.execute.mockResolvedValueOnce(FIT).mockRejectedValueOnce(cut());
    const now = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(FIT_PASS_TIME_BOX_MS);
    const { acts } = passActivities([id(1), id(2), id(3)], now);

    await expect(
      acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).resolves.toMatchObject({
      judged: 1,
      unjudged: 1,
      nextCompanyId: id(2),
      previousCallCut: true,
    });
  });

  describe("with up to FIT_CONCURRENCY judgments in flight", () => {
    const http = (status: number) =>
      new ProviderHttpError({ status, provider: "gateway", model: "deepseek-v4-pro" });
    const nameOf = (request: unknown) =>
      /"name": "([^"]+)"/u.exec((request as { prompt?: string }).prompt ?? "")?.[1] ?? "";
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    /** Fit calls that wait until the test settles them, by company name ("01 GmbH" for id(1)). */
    function heldJudgments() {
      const started: string[] = [];
      const held = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
      fitRuntimeMocks.execute.mockImplementation(
        (_gateway: unknown, request: unknown) =>
          new Promise((resolve, reject) => {
            const name = nameOf(request);
            started.push(name);
            held.set(name, { resolve, reject });
          }),
      );
      const judge = async (name: string) => {
        held.get(name)!.resolve(FIT);
        await flush();
      };
      const fail = async (name: string, error: unknown) => {
        held.get(name)!.reject(error);
        await flush();
      };
      return { started, judge, fail };
    }
    const done = (promise: Promise<unknown>) => {
      const state = { settled: false };
      void promise.then(
        () => (state.settled = true),
        () => (state.settled = true),
      );
      return state;
    };

    it("starts at most FIT_CONCURRENCY judgments, and the next as soon as any of them settles", async () => {
      const judgments = heldJudgments();
      const { acts } = passActivities([id(1), id(2), id(3), id(4), id(5)], () => 0);

      const pass = acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }));
      await flush();
      expect(judgments.started).toEqual(["01 GmbH", "02 GmbH", "03 GmbH"]);
      // A later company settling first still frees its slot.
      await judgments.judge("02 GmbH");
      expect(judgments.started).toEqual(["01 GmbH", "02 GmbH", "03 GmbH", "04 GmbH"]);
      for (const name of ["01 GmbH", "03 GmbH", "04 GmbH"]) await judgments.judge(name);
      await judgments.judge("05 GmbH");

      await expect(pass).resolves.toMatchObject({ judged: 5, nextCompanyId: null });
      expect(FIT_CONCURRENCY).toBe(3);
    });

    it("stores a sibling's verdict before a failure ends the activity, and fails only once the siblings settled", async () => {
      const judgments = heldJudgments();
      const failure = http(401);
      const { acts, leadUpsert } = passActivities([id(1), id(2), id(3)], () => 0);

      const pass = acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }));
      const state = done(pass);
      await flush();
      await judgments.fail("02 GmbH", failure);
      expect(state.settled).toBe(false);
      await judgments.judge("01 GmbH");
      // c2's failure is folded now and stops the activity, but c3 is still running.
      expect(state.settled).toBe(false);
      await judgments.judge("03 GmbH");

      await expect(pass).rejects.toBe(failure);
      expect(leadUpsert).toHaveBeenCalledTimes(2);
    });

    it("folds outcomes in id order: two cut streams in a row stop the activity whichever settles first", async () => {
      const judgments = heldJudgments();
      const third = cut();
      const { acts } = passActivities([id(1), id(2), id(3)], () => 0);

      // Caught at once: the pass fails while the test is still settling the judgments.
      const failure = acts
        .qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }))
        .then(() => undefined, (error: unknown) => error);
      await flush();
      await judgments.fail("03 GmbH", third);
      await judgments.fail("02 GmbH", cut());
      await judgments.judge("01 GmbH");

      // In settling order c2 would be the second cut; in id order it is c3.
      expect(await failure).toBe(third);
    });

    it("hands on the last company it started once its time box is spent, after the ones in flight finish", async () => {
      const judgments = heldJudgments();
      let now = 0;
      const { acts } = passActivities([id(1), id(2), id(3), id(4), id(5)], () => now);

      const pass = acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }));
      await flush();
      now = FIT_PASS_TIME_BOX_MS;
      for (const name of ["01 GmbH", "02 GmbH", "03 GmbH"]) await judgments.judge(name);

      await expect(pass).resolves.toMatchObject({ judged: 3, nextCompanyId: id(3) });
      expect(judgments.started).toEqual(["01 GmbH", "02 GmbH", "03 GmbH"]);
    });

    // Review of #675 (HIGH): a failure that settled behind a slow judgment was only folded once the
    // slow one settled, and the pool refilled meanwhile, starting all 60 companies of a probe.
    it.each([
      ["an unavailable upstream", () => http(503)],
      ["a spent budget", () => new StoreBudgetExceededError("account", 1n, 0n)],
      ["a cut stream", () => cut()],
    ] as const)("starts nothing new while %s behind a slow judgment waits to be folded", async (_label, failure) => {
      const judgments = heldJudgments();
      const { acts } = passActivities([id(1), id(2), id(3), id(4), id(5), id(6)], () => 0);

      const result = acts
        .qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }))
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      await flush();
      await judgments.fail("02 GmbH", failure());
      await judgments.fail("03 GmbH", failure());
      // Two slots are free and the run's first company still runs: nothing more starts.
      expect(judgments.started).toEqual(["01 GmbH", "02 GmbH", "03 GmbH"]);
      await judgments.judge("01 GmbH");

      expect(judgments.started.length).toBeLessThanOrEqual(FIT_CONCURRENCY);
      await result;
    });

    it("resumes starting once the failure it waited on is folded and absorbed", async () => {
      const judgments = heldJudgments();
      const { acts } = passActivities([id(1), id(2), id(3), id(4)], () => 0);

      const pass = acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }));
      await flush();
      await judgments.fail("02 GmbH", cut());
      expect(judgments.started).toEqual(["01 GmbH", "02 GmbH", "03 GmbH"]);
      // c1 judged, then c2's cut is the first in a row and absorbed: the pool fills again.
      await judgments.judge("01 GmbH");
      expect(judgments.started).toEqual(["01 GmbH", "02 GmbH", "03 GmbH", "04 GmbH"]);
      await judgments.judge("03 GmbH");
      await judgments.judge("04 GmbH");

      await expect(pass).resolves.toMatchObject({ judged: 3, unjudged: 1 });
    });

    it("counts a company lost on replay after a budget stop as unreplayable, not as skipped", async () => {
      const judgments = heldJudgments();
      const { acts } = passActivities([id(1), id(2), id(3)], () => 0);

      const pass = acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }));
      await flush();
      await judgments.fail("01 GmbH", new StoreBudgetExceededError("account", 1n, 0n));
      await judgments.fail("02 GmbH", new BudgetOperationReplayError("op-2"));
      await judgments.fail("03 GmbH", new StoreBudgetExceededError("account", 1n, 0n));

      await expect(pass).resolves.toMatchObject({ unjudged: 1, unreplayable: 1, skippedForBudget: 2 });
    });

    it("starts no company once a spent budget is folded", async () => {
      const judgments = heldJudgments();
      const { acts } = passActivities([id(1), id(2), id(3), id(4), id(5)], () => 0);

      const pass = acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }));
      await flush();
      await judgments.fail("01 GmbH", new StoreBudgetExceededError("account", 1n, 0n));
      await judgments.judge("02 GmbH");
      await judgments.judge("03 GmbH");

      expect(judgments.started).toEqual(["01 GmbH", "02 GmbH", "03 GmbH"]);
      await expect(pass).resolves.toMatchObject({ judged: 2, skippedForBudget: 3, nextCompanyId: null });
    });

    it("starts no company once a second cut stream in a row is folded", async () => {
      const judgments = heldJudgments();
      const second = cut();
      const { acts } = passActivities([id(1), id(2), id(3), id(4), id(5)], () => 0);

      const failure = acts
        .qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }))
        .then(() => undefined, (error: unknown) => error);
      await flush();
      // c1's cut is the first in a row: absorbed, and c4 takes its slot.
      await judgments.fail("01 GmbH", cut());
      await judgments.fail("02 GmbH", second);
      await judgments.judge("03 GmbH");
      await judgments.judge("04 GmbH");

      expect(judgments.started).toEqual(["01 GmbH", "02 GmbH", "03 GmbH", "04 GmbH"]);
      expect(await failure).toBe(second);
    });

    it("keeps the first stop in id order when a later company fails, and logs the failure it leaves out", async () => {
      const judgments = heldJudgments();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const { acts } = passActivities([id(1), id(2), id(3)], () => 0);

        const pass = acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }));
        await flush();
        await judgments.fail("02 GmbH", http(401));
        await judgments.fail("01 GmbH", new StoreBudgetExceededError("account", 1n, 0n));
        await judgments.judge("03 GmbH");

        // One company after another, c2 would never have been called: the budget stop stands.
        await expect(pass).resolves.toMatchObject({ judged: 1, skippedForBudget: 2 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("ProviderHttpError"));
      } finally {
        warn.mockRestore();
      }
    });

    it("counts every company settled before a budget stop and skips only the rest", async () => {
      const judgments = heldJudgments();
      const { acts, findUnique } = passActivities([id(1), id(2), id(3), id(4), id(5), id(6)], () => 0);
      // c1 may not use external processing, so its judgment never reaches the model.
      findUnique.mockImplementationOnce(async () => null);

      const pass = acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }));
      await flush();
      expect(judgments.started).toEqual(["02 GmbH", "03 GmbH", "04 GmbH"]);
      await judgments.fail("02 GmbH", new Error("model answered nonsense"));
      await judgments.fail("03 GmbH", new BudgetOperationReplayError("op-3"));
      await judgments.fail("04 GmbH", new StoreBudgetExceededError("account", 1n, 0n));
      await judgments.judge("05 GmbH");
      await judgments.judge("06 GmbH");

      // c1 not allowed, c2 unusable, c3 lost on replay, c5 and c6 judged: only c4 is left.
      await expect(pass).resolves.toMatchObject({
        judged: 2,
        unjudged: 2,
        unreplayable: 1,
        skippedForBudget: 1,
      });
    });

    it("fails the activity when a verdict cannot be stored", async () => {
      fitRuntimeMocks.execute.mockResolvedValue(FIT);
      const unavailable = new Error("lead table unavailable");
      const { acts, leadUpsert } = passActivities([id(1)], () => 0);
      leadUpsert.mockRejectedValueOnce(unavailable);

      await expect(acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }))).rejects.toBe(unavailable);
    });

    // Review of #675 (LOW): the lease check before the next start ended the pass at once, so a
    // budget stop or a failure of a company already in flight read as skipped for the lease.
    it.each([
      [
        "a spent budget ends the pass for the budget",
        () => new StoreBudgetExceededError("account", 1n, 0n),
        { resolves: { judged: 2, skippedForBudget: 3 } },
      ],
      ["a rejected credential fails the activity", () => http(401), { rejects: true }],
    ] as const)(
      "lets a company that started before the lease ran short decide the stop: %s",
      async (_label, failure, expected) => {
        const judgments = heldJudgments();
        let now = 0;
        const { acts } = passActivities(
          [id(1), id(2), id(3), id(4), id(5)],
          () => now,
          leaseLeaving(DISCOVERY_LEASE_UNIT_MS.fit + MINUTE),
        );

        const result = acts
          .qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }))
          .then((value) => ({ value }), (error: unknown) => ({ error }));
        await flush();
        now = 2 * MINUTE;
        // c1 frees a slot, but the lease has no room for another judgment: nothing more starts.
        await judgments.judge("01 GmbH");
        const error = failure();
        await judgments.fail("02 GmbH", error);
        await judgments.judge("03 GmbH");

        expect(judgments.started).toEqual(["01 GmbH", "02 GmbH", "03 GmbH"]);
        const outcome = await result;
        if ("rejects" in expected) {
          expect(outcome).toEqual({ error });
        } else {
          expect(outcome).toMatchObject({ value: expected.resolves });
          expect((outcome as { value: object }).value).not.toHaveProperty("skippedForLease");
        }
      },
    );

    it("keeps the pass, plus one judgment, inside the fit activity's timeout", () => {
      const timeout = Math.max(...discoveryActivityTimeouts().get("qualifyFitForRun")!.map(timeoutMilliseconds));
      expect(FIT_PASS_TIME_BOX_MS + DISCOVERY_LEASE_UNIT_MS.fit).toBeLessThanOrEqual(timeout - MINUTE);
    });
  });

  describe("near the end of the admission lease", () => {
    const http = (status: number) =>
      new ProviderHttpError({ status, provider: "gateway", model: "deepseek-v4-pro" });

    it("judges nothing when the lease has no room for one judgment, and hands nothing on", async () => {
      const { acts } = passActivities([id(1), id(2), id(3)], () => 0, leaseLeaving(DISCOVERY_LEASE_UNIT_MS.fit - 1));

      await expect(acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }))).resolves.toMatchObject({
        judged: 0,
        nextCompanyId: null,
        skippedForLease: 3,
      });
      expect(fitRuntimeMocks.execute).not.toHaveBeenCalled();
    });

    it("keeps the judgments it made and counts the rest once the lease runs out mid-pass", async () => {
      let now = 0;
      fitRuntimeMocks.execute.mockImplementation(async () => {
        now += 6 * MINUTE;
        return FIT;
      });
      // The first FIT_CONCURRENCY companies start with room; after the first of them settles the
      // lease has none, so the remaining two never start.
      const { acts } = passActivities(
        [id(1), id(2), id(3), id(4), id(5)],
        () => now,
        leaseLeaving(DISCOVERY_LEASE_UNIT_MS.fit + 5 * MINUTE),
      );

      await expect(acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }))).resolves.toMatchObject({
        judged: 3,
        verdicts: { match: 3 },
        nextCompanyId: null,
        skippedForLease: 2,
      });
      expect(fitRuntimeMocks.execute).toHaveBeenCalledTimes(3);
    });

    it("reports no lease skip while the lease has room", async () => {
      fitRuntimeMocks.execute.mockResolvedValue(FIT);
      const { acts } = passActivities([id(1), id(2)], () => 0, leaseLeaving(DISCOVERY_LEASE_UNIT_MS.fit));

      const result = await acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }));
      expect(result).toMatchObject({ judged: 2, nextCompanyId: null });
      expect(result).not.toHaveProperty("skippedForLease");
    });

    // The design review's blocking case: an outage in the lease's last half hour used to retry
    // without the wait, spend the attempts within seconds and fail the run.
    it("stops for the lease instead of failing when an unavailable upstream's wait does not fit", async () => {
      fitRuntimeMocks.execute
        .mockResolvedValueOnce(FIT)
        .mockRejectedValueOnce(http(503))
        .mockResolvedValueOnce(FIT);
      const { acts } = passActivities(
        [id(1), id(2), id(3), id(4)],
        () => 0,
        leaseLeaving(DISCOVERY_LEASE_UNIT_MS.fit + 4 * MINUTE),
      );

      // The companies that ran alongside the failed c2 keep their outcomes; c2, and whatever had not
      // started when its failure was folded, count as skipped for the lease.
      const result = await acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }));
      expect(result).toMatchObject({ nextCompanyId: null });
      expect(result.judged).toBeGreaterThanOrEqual(2);
      expect(result.skippedForLease).toBeGreaterThanOrEqual(1);
      expect(result.judged + result.unjudged + (result.skippedForLease ?? 0)).toBe(4);
    });

    it("still waits for the upstream when the lease holds the wait and one more judgment", async () => {
      fitRuntimeMocks.execute.mockRejectedValueOnce(http(503));
      const { acts } = passActivities(
        [id(1), id(2)],
        () => 0,
        leaseLeaving(5 * MINUTE + DISCOVERY_LEASE_UNIT_MS.fit),
      );

      await expect(acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }))).rejects.toMatchObject({
        type: "ProviderHttpError",
        nextRetryDelay: "5 minutes",
      });
    });
  });

  it("counts every company after the cursor as skipped for budget and hands nothing on", async () => {
    fitRuntimeMocks.execute.mockRejectedValue(new StoreBudgetExceededError("account", 1n, 0n));
    const { acts } = passActivities([id(1), id(2), id(3)], () => 0);

    await expect(
      acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
    ).resolves.toMatchObject({ judged: 0, skippedForBudget: 3, nextCompanyId: null });
  });

  it.each([
    ["a company id that is not a UUID", { afterCompanyId: "c1" }],
    ["a cut flag that is not a boolean", { previousCallCut: "yes" }],
  ])("rejects a continuation with %s before any model call", async (_label, extra) => {
    const { acts } = passActivities([id(1)], () => 0);

    await expect(
      acts.qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1", ...extra }) as never),
    ).rejects.toMatchObject({ type: "DISCOVERY_STAGE_CONTINUATION_INVALID", nonRetryable: true });
    expect(fitRuntimeMocks.execute).not.toHaveBeenCalled();
  });
});

describe("resolveRunStatus —— 公司抽取因模型失败被跳过", () => {
  it("有抽取被跳过 → 至少 PARTIAL，绝不 DONE", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, droppedExtractions: 1 }),
    ).toBe("PARTIAL");
  });
  it("不单独判 FAILED：全部查询都失败时才是 FAILED", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 1, budgetTruncated: false, droppedExtractions: 5 }),
    ).toBe("PARTIAL");
    expect(
      resolveRunStatus({ failures: 1, totalQueries: 1, budgetTruncated: false, droppedExtractions: 5 }),
    ).toBe("FAILED");
  });
  it("零跳过与旧历史（缺这个字段）保持原语义", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, droppedExtractions: 0 }),
    ).toBe("DONE");
  });
});

describe("resolveRunStatus —— 尽力而为的阶段跳过了无法重放的公司", () => {
  it("有跳过 → 至少 PARTIAL，绝不 DONE", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, unreplayableSkips: 1 }),
    ).toBe("PARTIAL");
  });
  it("不单独判 FAILED；零跳过与旧历史（缺这个字段）保持原语义", () => {
    expect(
      resolveRunStatus({ failures: 1, totalQueries: 1, budgetTruncated: false, unreplayableSkips: 2 }),
    ).toBe("FAILED");
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, unreplayableSkips: 0 }),
    ).toBe("DONE");
  });
});

describe("resolveRunStatus —— 信号源所在站点断开连接", () => {
  it("marks the run PARTIAL rather than DONE when a company lost one source", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, transportFailedSkips: 1 }),
    ).toBe("PARTIAL");
  });

  it("stays DONE when no source was lost", () => {
    expect(
      resolveRunStatus({ failures: 0, totalQueries: 3, budgetTruncated: false, transportFailedSkips: 0 }),
    ).toBe("DONE");
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

describe("executeQuery —— a provider whose operation cannot be replayed ends the query with a zero receipt (#643)", () => {
  const lost = () => new BudgetOperationReplayError("public-web-op");
  const lineageAdapter = (discoverCompanies: () => Promise<unknown>) => ({
    key: "public_web",
    classes: ["public_intelligence"],
    companyResultLineage: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
    discoverCompanies,
  });
  it("lists the provider on a zero receipt through Q-TX and flags the loss, with no skip reason", async () => {
    const discoverCompanies = vi.fn(async () => {
      throw lost();
    });
    const activities = createDiscoveryActivities(makeDeps([lineageAdapter(discoverCompanies)]));

    const result = await activities.executeQuery(discoveryArgs("run-lost", { query: QUERY }));

    expect(discoverCompanies).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      rawCount: 0,
      costCents: 0,
      provider: "public_web",
      unreplayable: true,
      // The materialization admission needs one receipt per plan query; this one says the
      // provider was routed and answered with nothing.
      queryReceipt: { providers: ["public_web"], accepted: 0, usageQuantity: 0, costCents: 0 },
    });
    expect(result).not.toHaveProperty("skipReason");
  });

  it("keeps the records of the providers that answered beside the one that was lost", async () => {
    const activities = createDiscoveryActivities(
      makeDeps([
        okAdapter("wikidata", [REC]),
        {
          ...okAdapter("ted", []),
          discoverCompanies: async () => {
            throw lost();
          },
        },
      ]),
    );

    await expect(
      activities.executeQuery(discoveryArgs("run-lost-one", { query: QUERY })),
    ).resolves.toMatchObject({
      rawCount: 1,
      unreplayable: true,
      queryReceipt: { providers: ["ted", "wikidata"], accepted: 1 },
    });
  });

  it("flags nothing when every provider answered", async () => {
    const activities = createDiscoveryActivities(makeDeps([okAdapter("wikidata", [REC])]));

    const result = await activities.executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));

    expect(result).not.toHaveProperty("unreplayable");
  });

  it("fails the query instead when the query before lost a provider the same way", async () => {
    const error = lost();
    const activities = createDiscoveryActivities(
      makeDeps([
        lineageAdapter(async () => {
          throw error;
        }),
      ]),
    );

    await expect(
      activities.executeQuery(
        discoveryArgs("run-lost-twice", { query: QUERY, previousQueryUnreplayable: true }),
      ),
    ).rejects.toBe(error);
  });

  it("rejects a hand-off flag that is not a boolean before any call", async () => {
    const discoverCompanies = vi.fn(async () => ({ records: [REC], costCents: 0 }));
    const activities = createDiscoveryActivities(
      makeDeps([{ ...okAdapter("wikidata", [REC]), discoverCompanies }]),
    );

    await expect(
      activities.executeQuery(
        discoveryArgs("run-lost-flag", { query: QUERY, previousQueryUnreplayable: "yes" as never }),
      ),
    ).rejects.toMatchObject({ type: "DISCOVERY_STAGE_CONTINUATION_INVALID", nonRetryable: true });
    expect(discoverCompanies).not.toHaveBeenCalled();
  });

  it("still fails the query on every other control error of a provider", async () => {
    const error = new ExecutionControlError("EXECUTION_BUDGET_AUTHORITY_REVOKED");
    const activities = createDiscoveryActivities(
      makeDeps([
        lineageAdapter(async () => {
          throw error;
        }),
      ]),
    );

    await expect(
      activities.executeQuery(discoveryArgs("run-lost-other", { query: QUERY })),
    ).rejects.toBe(error);
  });
});

describe("an unavailable model upstream makes the next activity attempt wait instead of retrying within seconds", () => {
  // Run 097593b7 (xin, 2026-10-19 12:03 UTC): mining one domain met openox 521; the three
  // attempts of the query fell inside 6 seconds and the run failed while openox stayed down
  // for 28 minutes. The ledger already released each attempt's reservation (D13).
  const http = (status: number) =>
    new ProviderHttpError({ status, provider: "gateway", model: "deepseek-v4-pro" });
  const miningAdapter = (discoverCompanies: () => Promise<unknown>) => ({
    key: "public_web",
    classes: ["public_intelligence"],
    companyResultLineage: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
    discoverCompanies,
  });

  it("fails the query with a retryable failure that waits before the next attempt", async () => {
    const error = http(521);
    const activities = createDiscoveryActivities(
      makeDeps([
        miningAdapter(async () => {
          throw error;
        }),
      ]),
    );

    const failure = await activities
      .executeQuery(discoveryArgs("run-upstream-521", { query: QUERY }))
      .then(() => undefined, (reason: unknown) => reason);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({
      type: "ProviderHttpError",
      message: error.message,
      nonRetryable: false,
      nextRetryDelay: "5 minutes",
    });
  });

  it("waits the same way when the gateway itself refuses the connection", async () => {
    // What Node fetch throws when nothing listens on the gateway port: the cause is a system error.
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3001"), {
      errno: -111,
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "127.0.0.1",
      port: 3001,
    });
    const error = new TypeError("fetch failed", { cause: refused });
    const activities = createDiscoveryActivities(
      makeDeps([
        miningAdapter(async () => {
          throw error;
        }),
      ]),
    );

    const failure = await activities
      .executeQuery(discoveryArgs("run-gateway-refused", { query: QUERY }))
      .then(() => undefined, (reason: unknown) => reason);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({ type: "TypeError", nonRetryable: false, nextRetryDelay: "5 minutes" });
  });

  it("still fails the query at once on a gateway timeout, which the upstream may have billed", async () => {
    const error = http(504);
    const activities = createDiscoveryActivities(
      makeDeps([
        miningAdapter(async () => {
          throw error;
        }),
      ]),
    );

    await expect(
      activities.executeQuery(discoveryArgs("run-upstream-504", { query: QUERY })),
    ).rejects.toBe(error);
  });

  describe("in the fit pass", () => {
    const FIT_COMPANY = { id: "c1", name: "c1 GmbH", domain: "c1.example", country: "DE", industry: null, status: "NEW", attributes: {} };
    function fitActivities() {
      const tx = {
        $queryRaw: legacyMaterializationQueryRaw(),
        rawSourceRecord: {
          findMany: async () => [
            { id: "raw-c1", providerKey: "registry", payload: { externalId: "c1", name: "c1 GmbH", domain: "c1.example", country: "DE" } },
          ],
        },
        identityLink: { findMany: async () => [{ canonicalId: "c1" }] },
        canonicalCompany: {
          findMany: async () => [FIT_COMPANY],
          findUnique: async () => FIT_COMPANY,
          updateMany: async () => ({ count: 0 }),
        },
        suppressionRecord: { findMany: async () => [] },
        icpDefinition: { findUnique: async () => null },
        lead: { upsert: async () => ({}) },
      };
      return createDiscoveryActivities({
        prisma: {
          withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> =>
            callback(tx),
        },
        providers: {},
        gateway: {},
        budgetStore: authorityBudgetStore(),
      } as never);
    }

    beforeEach(() => {
      fitRuntimeMocks.execute.mockReset();
    });

    it("stops the fit pass with a retryable failure that waits before the next attempt", async () => {
      const error = http(523);
      fitRuntimeMocks.execute.mockRejectedValueOnce(error);

      const failure = await fitActivities()
        .qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" }))
        .then(() => undefined, (reason: unknown) => reason);

      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure).toMatchObject({
        type: "ProviderHttpError",
        message: error.message,
        nonRetryable: false,
        nextRetryDelay: "5 minutes",
      });
    });

    it("still stops the fit pass at once on an upstream 4xx", async () => {
      const error = http(401);
      fitRuntimeMocks.execute.mockRejectedValueOnce(error);

      await expect(
        fitActivities().qualifyFitForRun(discoveryArgs("run-1", { icpId: "icp-1" })),
      ).rejects.toBe(error);
    });
  });
});

describe("executeQuery —— term normalization: keyed per query, skipped when no routed source reads it, falling back to the built-in vocabulary (W2)", () => {
  // Seller #26, run 3e78eb4e (xin, 2026-10-13 11:36 UTC): the taxonomy model answered 503 on
  // the first query and the gateway settled the operation without a result. Its key held only
  // run, task, prompt and schema, so every later query that shared the term met the dead
  // operation on its first attempt, and the second one in a row failed the run.
  const TERMS = { industry: "pump", country: "Germany" };
  const query = { ...QUERY, filters: TERMS };
  type TaxonomyOptions = { correlationId?: string; allowLlm?: boolean };
  const taxonomySpy = (
    resolveMany: (kind: string, terms: string[], options?: TaxonomyOptions) => Promise<unknown>,
    resolve: (kind: string, term: string, options?: TaxonomyOptions) => Promise<unknown> = async () => null,
  ) => ({ resolveMany: vi.fn(resolveMany), resolve: vi.fn(resolve) });
  const discoverer = () => vi.fn(async (_query: CompanyDiscoveryQuery) => ({ records: [REC], costCents: 0 }));
  // wikidata and openstreetmap read the resolved codes executeQuery injects.
  const consumer = (discoverCompanies = discoverer()) => ({
    ...okAdapter("wikidata", [REC]),
    consumesResolvedTaxonomy: true,
    discoverCompanies,
  }) as unknown as CompanyDiscoveryAdapter;

  it("sends term normalization a per-query correlation id, so two queries that share a term use distinct model operations", async () => {
    const taxonomy = taxonomySpy(async () => []);
    const deps = makeDeps([consumer()]);
    deps.taxonomy = taxonomy as never;
    const activities = createDiscoveryActivities(deps);
    const runId = testRunId("run-keyed");
    const planId = "50000000-0000-4000-8000-000000000001";
    const expectedKey = (queryOrdinal: number) =>
      `${discoveryQueryKey({ runId, planId, queryOrdinal, query })}:${queryOrdinal}`;

    await activities.executeQuery(discoveryArgs(runId, { query, queryOrdinal: 0 }));
    await activities.executeQuery(discoveryArgs(runId, { query, queryOrdinal: 1 }));

    expect(expectedKey(0)).not.toBe(expectedKey(1));
    expect(taxonomy.resolveMany.mock.calls.map(([, , options]) => options?.correlationId))
      .toEqual([expectedKey(0), expectedKey(1)]);
    expect(taxonomy.resolve.mock.calls.map(([, , options]) => options?.correlationId))
      .toEqual([expectedKey(0), expectedKey(1)]);
  });

  it("keeps term normalization deterministic for a query routed only to sources that never read resolved codes", async () => {
    const taxonomy = taxonomySpy(async () => []);
    const discoverCompanies = discoverer();
    const deps = makeDeps([{ ...okAdapter("public_web", []), discoverCompanies } as unknown as CompanyDiscoveryAdapter]);
    deps.taxonomy = taxonomy as never;
    const activities = createDiscoveryActivities(deps);

    const result = await activities.executeQuery(discoveryArgs("run-public-web-only", { query }));

    expect(taxonomy.resolveMany).toHaveBeenCalledWith("industry", ["pump"], expect.objectContaining({ allowLlm: false }));
    expect(taxonomy.resolve).toHaveBeenCalledWith("country", "Germany", expect.objectContaining({ allowLlm: false }));
    expect(discoverCompanies).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ taxonomyModelSkipped: true, queryReceipt: { providers: ["public_web"] } });
    expect(result).not.toHaveProperty("taxonomyFallback");
  });

  it("lets term normalization call the model once a routed source reads resolved codes", async () => {
    const taxonomy = taxonomySpy(async () => []);
    const deps = makeDeps([okAdapter("public_web", [REC]), consumer()]);
    deps.taxonomy = taxonomy as never;
    const activities = createDiscoveryActivities(deps);

    const result = await activities.executeQuery(discoveryArgs("run-mixed-sources", { query }));

    expect(taxonomy.resolveMany.mock.calls[0]![2]?.allowLlm).toBeUndefined();
    expect(taxonomy.resolve.mock.calls[0]![2]?.allowLlm).toBeUndefined();
    expect(result).not.toHaveProperty("taxonomyModelSkipped");
    expect(result).not.toHaveProperty("taxonomyFallback");
  });

  it("falls back to the built-in vocabulary and still dispatches the query when term normalization meets an upstream 5xx", async () => {
    const discoverCompanies = discoverer();
    const deps = makeDeps([consumer(discoverCompanies)]);
    deps.taxonomy = taxonomySpy(async () => {
      throw new ProviderHttpError({ status: 503, provider: "gateway", model: "deepseek-v4-pro" });
    }) as never;
    const activities = createDiscoveryActivities(deps);

    const result = await activities.executeQuery(discoveryArgs("run-taxonomy-503", { query }));

    expect(discoverCompanies).toHaveBeenCalledOnce();
    expect(discoverCompanies.mock.calls[0]![0].filters).toEqual(TERMS);
    expect(result).toMatchObject({
      rawCount: 1,
      taxonomyFallback: true,
      queryReceipt: { providers: ["wikidata"], accepted: 1 },
    });
    expect(result).not.toHaveProperty("unreplayable");
    expect(result).not.toHaveProperty("skipReason");
  });

  it("falls back the same way when the normalization operation cannot be replayed, even right after a query that lost a provider", async () => {
    const discoverCompanies = discoverer();
    const deps = makeDeps([consumer(discoverCompanies)]);
    deps.taxonomy = taxonomySpy(async () => {
      throw new BudgetOperationReplayError("taxonomy-op");
    }) as never;
    const activities = createDiscoveryActivities(deps);

    const result = await activities.executeQuery(
      discoveryArgs("run-taxonomy-replay", { query, previousQueryUnreplayable: true }),
    );

    expect(discoverCompanies).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ rawCount: 1, taxonomyFallback: true });
    expect(result).not.toHaveProperty("unreplayable");
  });

  it("keeps the industries resolved before the country lookup fell back", async () => {
    const discoverCompanies = discoverer();
    const deps = makeDeps([consumer(discoverCompanies)]);
    deps.taxonomy = taxonomySpy(
      async () => [{ wikidataQid: "Q1", osmTags: null, code: "2812" }],
      async () => {
        throw new ProviderHttpError({ status: 502, provider: "gateway", model: "deepseek-v4-pro" });
      },
    ) as never;
    const activities = createDiscoveryActivities(deps);

    const result = await activities.executeQuery(discoveryArgs("run-taxonomy-502", { query }));

    const dispatched = discoverCompanies.mock.calls[0]![0].filters;
    expect(dispatched).toMatchObject({ _industryCodes: ["2812"], _industryQids: ["Q1"] });
    expect(dispatched).not.toHaveProperty("_countryCode");
    expect(result).toMatchObject({ rawCount: 1, taxonomyFallback: true });
  });

  it("fails the query with a failure that waits when term normalization meets an upstream 429", async () => {
    const error = new ProviderHttpError({ status: 429, provider: "gateway", model: "deepseek-v4-pro" });
    const discoverCompanies = discoverer();
    const deps = makeDeps([consumer(discoverCompanies)]);
    deps.taxonomy = taxonomySpy(async () => {
      throw error;
    }) as never;
    const activities = createDiscoveryActivities(deps);

    const failure = await activities
      .executeQuery(discoveryArgs("run-taxonomy-429", { query }))
      .then(() => undefined, (reason: unknown) => reason);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({ type: "ProviderHttpError", nonRetryable: false, nextRetryDelay: "5 minutes" });
    expect(discoverCompanies).not.toHaveBeenCalled();
  });

  it.each([
    ["an upstream 4xx", new ProviderHttpError({ status: 401, provider: "gateway", model: "deepseek-v4-pro" })],
    ["another control error", new ExecutionControlError("EXECUTION_BUDGET_AUTHORITY_REVOKED")],
  ])("still fails the query when term normalization meets %s", async (_label, error) => {
    const discoverCompanies = discoverer();
    const deps = makeDeps([consumer(discoverCompanies)]);
    deps.taxonomy = taxonomySpy(async () => {
      throw error;
    }) as never;
    const activities = createDiscoveryActivities(deps);

    await expect(
      activities.executeQuery(discoveryArgs("run-taxonomy-closed", { query })),
    ).rejects.toBe(error);
    expect(discoverCompanies).not.toHaveBeenCalled();
  });
});

describe("executeQuery —— a query the run's admission lease has no room for ends with a zero receipt", () => {
  const http = (status: number) =>
    new ProviderHttpError({ status, provider: "gateway", model: "deepseek-v4-pro" });
  const lineageAdapter = (discoverCompanies: () => Promise<unknown>) => ({
    key: "public_web",
    classes: ["public_intelligence"],
    companyResultLineage: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
    discoverCompanies,
  });
  const noRecords = async () => ({
    records: [],
    costCents: 0,
    lineage: {
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount: 0,
      attemptReceipts: [],
      receiptCoverage: [],
    },
  });

  /** makeDeps whose query lineage attest answers REPLAYED with `receipt`, as for a retried attempt. */
  function replaying(deps: ReturnType<typeof makeDeps>, receipt: unknown) {
    const prisma = deps.prisma as unknown as {
      withWorkspace: <T>(ws: string, fn: (tx: Record<string, unknown>) => Promise<T>) => Promise<T>;
    };
    return {
      ...deps,
      prisma: {
        ...prisma,
        withWorkspace: <T>(ws: string, fn: (tx: Record<string, unknown>) => Promise<T>) =>
          prisma.withWorkspace(ws, (tx) =>
            fn({
              ...tx,
              $queryRaw: async (statement: { strings?: readonly string[] }) =>
                statement.strings?.join("?").includes("attest_discovery_query_lineage_v2")
                  ? [{
                      status: "REPLAYED",
                      query_receipt: receipt,
                      budget_truncated: false,
                      attempt_count: 1,
                      item_count: 0,
                      replay: true,
                    }]
                  : (tx.$queryRaw as (statement: unknown) => Promise<unknown>)(statement),
            }),
          ),
      },
    } as unknown as ReturnType<typeof makeDeps>;
  }

  it("routes nothing, normalizes no term and calls no provider, and says it stopped for the lease", async () => {
    const discoverCompanies = vi.fn(noRecords);
    const deps = makeDeps([lineageAdapter(discoverCompanies)]);
    const providers = deps.providers as unknown as { routeCompanyDiscovery: () => Promise<unknown> };
    const routeCompanyDiscovery = vi.fn(providers.routeCompanyDiscovery);
    const taxonomy = { resolveMany: vi.fn(async () => []), resolve: vi.fn(async () => null) };
    const runLease = leaseLeaving(DISCOVERY_LEASE_UNIT_MS.query - 1);
    const acts = createDiscoveryActivities({
      ...deps,
      providers: { ...providers, routeCompanyDiscovery } as never,
      taxonomy: taxonomy as never,
      runLease,
      now: () => 0,
    });

    const result = await acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));

    expect(result).toMatchObject({
      rawCount: 0,
      costCents: 0,
      provider: null,
      skippedForLease: true,
      // The materialization admission still gets its receipt for this plan query.
      queryReceipt: { providers: [], accepted: 0, usageQuantity: 0, costCents: 0 },
    });
    expect(result).not.toHaveProperty("skipReason");
    expect(routeCompanyDiscovery).not.toHaveBeenCalled();
    expect(taxonomy.resolveMany).not.toHaveBeenCalled();
    expect(discoverCompanies).not.toHaveBeenCalled();
    expect(runLease).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityId: DISCOVERY_BINDING.authorityId,
        scopeKey: DISCOVERY_BINDING.scopeKey,
      }),
    );
  });

  it("runs a query the lease has room for as before", async () => {
    const discoverCompanies = vi.fn(noRecords);
    const acts = createDiscoveryActivities({
      ...makeDeps([lineageAdapter(discoverCompanies)]),
      runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.query),
      now: () => 0,
    });

    const result = await acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));
    expect(result).toMatchObject({ queryReceipt: { providers: ["public_web"] } });
    expect(result).not.toHaveProperty("skippedForLease");
    expect(discoverCompanies).toHaveBeenCalledOnce();
  });

  it("keeps the BI-30 skip reason for a query whose source is off while the lease has room", async () => {
    const acts = createDiscoveryActivities({
      ...makeDeps([]),
      runLease: leaseLeaving(3 * 60 * MINUTE),
      now: () => 0,
    });

    const result = await acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));
    expect(result).toHaveProperty("skipReason");
    expect(result).not.toHaveProperty("skippedForLease");
  });

  it("answers a replayed lease stop as a lease stop, and any other replayed zero receipt by its reason", async () => {
    const first = await createDiscoveryActivities({
      ...makeDeps([]),
      runLease: leaseLeaving(0),
      now: () => 0,
    }).executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));

    // Just short of one query unit: the query deadline has passed, whatever the other stages' units.
    const pastDeadline = await createDiscoveryActivities({
      ...replaying(makeDeps([]), first.queryReceipt),
      runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.query - 1),
      now: () => 0,
    }).executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));
    expect(pastDeadline).toMatchObject({ skippedForLease: true, queryReceipt: first.queryReceipt });
    expect(pastDeadline).not.toHaveProperty("skipReason");

    const withRoom = await createDiscoveryActivities({
      ...replaying(makeDeps([]), first.queryReceipt),
      runLease: leaseLeaving(3 * 60 * MINUTE),
      now: () => 0,
    }).executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));
    expect(withRoom).toHaveProperty("skipReason");
    expect(withRoom).not.toHaveProperty("skippedForLease");
  });

  it("fails the attempt of a replayed zero receipt whose lease cannot be read rather than guess its label, without attest or routing", async () => {
    const first = await createDiscoveryActivities({
      ...makeDeps([lineageAdapter(vi.fn(noRecords))]),
      runLease: leaseLeaving(0),
      now: () => 0,
    }).executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));
    expect(first).toMatchObject({ skippedForLease: true });
    const deps = replaying(makeDeps([lineageAdapter(vi.fn(noRecords))]), first.queryReceipt);
    const providers = deps.providers as unknown as { routeCompanyDiscovery: () => Promise<unknown> };
    const routeCompanyDiscovery = vi.fn(providers.routeCompanyDiscovery);
    const budgetStore = deps.budgetStore as unknown as { attestAuthorized: ReturnType<typeof vi.fn> };
    const readFailure = new ExecutionBudgetGrantError("EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE");

    const failure = await createDiscoveryActivities({
      ...deps,
      providers: { ...providers, routeCompanyDiscovery } as never,
      runLease: vi.fn(async () => {
        throw readFailure;
      }),
      now: () => 0,
    })
      .executeQuery(discoveryArgs("run-ok-x", { query: QUERY }))
      .then(() => undefined, (reason: unknown) => reason);

    // The read failure itself, as on a fresh query: the proxy retries it, and a source that is on
    // is never reported as SOURCE_DISABLED.
    expect(failure).toBe(readFailure);
    expect(budgetStore.attestAuthorized).not.toHaveBeenCalled();
    expect(routeCompanyDiscovery).not.toHaveBeenCalled();
  });

  it("keeps the skip reason of a replayed zero receipt while the lease still holds exactly one query", async () => {
    const first = await createDiscoveryActivities({
      ...makeDeps([]),
      runLease: leaseLeaving(0),
      now: () => 0,
    }).executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));

    const replayed = await createDiscoveryActivities({
      ...replaying(makeDeps([]), first.queryReceipt),
      runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.query),
      now: () => 0,
    }).executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));
    expect(replayed).toHaveProperty("skipReason");
    expect(replayed).not.toHaveProperty("skippedForLease");
  });

  it("never stops a query without a receipt identity (legacy history) for the lease", async () => {
    const discoverCompanies = vi.fn(async () => ({ records: [], costCents: 0 }));
    const acts = createDiscoveryActivities({
      ...makeDeps([{ ...okAdapter("wikidata", []), discoverCompanies }]),
      runLease: leaseLeaving(0),
      now: () => 0,
    });

    const result = await acts.executeQuery({
      workspaceId: DISCOVERY_BINDING.scopeKey,
      runId: testRunId("run-legacy-lease"),
      query: QUERY,
      executionContractVersion: 2,
      executionBudget: DISCOVERY_BINDING,
    });
    expect(result).not.toHaveProperty("skippedForLease");
    expect(discoverCompanies).toHaveBeenCalledOnce();
  });

  it("starts the next attempt past the query deadline when term normalization meets an unavailable upstream", async () => {
    const deps = makeDeps([
      { ...lineageAdapter(vi.fn(noRecords)), consumesResolvedTaxonomy: true } as never,
    ]);
    const taxonomy = {
      resolveMany: vi.fn(async () => {
        throw http(429);
      }),
      resolve: vi.fn(async () => null),
    };
    const acts = createDiscoveryActivities({
      ...deps,
      taxonomy: taxonomy as never,
      runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.query + 2 * MINUTE),
      now: () => 0,
    });

    await expect(acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY }))).rejects.toMatchObject({
      type: "ProviderHttpError",
      nextRetryDelay: 2 * MINUTE + 1_000,
    });
    expect(taxonomy.resolveMany).toHaveBeenCalledOnce();
  });

  it("does not read the lease to replay a receipt that ran on a provider", async () => {
    const first = await createDiscoveryActivities(
      makeDeps([lineageAdapter(noRecords)]),
    ).executeQuery(discoveryArgs("run-ok-x", { query: QUERY }));
    const runLease = leaseLeaving(0);

    await expect(
      createDiscoveryActivities({
        ...replaying(makeDeps([]), first.queryReceipt),
        runLease,
        now: () => 0,
      }).executeQuery(discoveryArgs("run-ok-x", { query: QUERY })),
    ).resolves.toMatchObject({ queryReceipt: { providers: ["public_web"] } });
    expect(runLease).not.toHaveBeenCalled();
  });

  // The design review's blocking case for queries: a retry without the wait spent the attempts on
  // the same outage within seconds. The next attempt now starts just past the query deadline and
  // ends the query with a zero receipt for the lease.
  it("starts the next attempt just past the query deadline when an unavailable upstream's wait does not fit", async () => {
    const acts = createDiscoveryActivities({
      ...makeDeps([
        lineageAdapter(async () => {
          throw http(521);
        }),
      ]),
      runLease: leaseLeaving(DISCOVERY_LEASE_UNIT_MS.query + 3 * MINUTE),
      now: () => 0,
    });

    const failure = await acts
      .executeQuery(discoveryArgs("run-ok-x", { query: QUERY }))
      .then(() => undefined, (reason: unknown) => reason);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({
      type: "ProviderHttpError",
      nonRetryable: false,
      nextRetryDelay: 3 * MINUTE + 1_000,
    });
  });

  it("still waits the full upstream delay when the lease holds it", async () => {
    const acts = createDiscoveryActivities({
      ...makeDeps([
        lineageAdapter(async () => {
          throw http(521);
        }),
      ]),
      runLease: leaseLeaving(3 * 60 * MINUTE),
      now: () => 0,
    });

    await expect(acts.executeQuery(discoveryArgs("run-ok-x", { query: QUERY }))).rejects.toMatchObject({
      nextRetryDelay: "5 minutes",
    });
  });
});

describe("resolveRunStatus —— 准入租约没有余量而提前停下", () => {
  it("never reports DONE when a stage left work for the lease", () => {
    expect(resolveRunStatus({ failures: 0, totalQueries: 4, budgetTruncated: false, leaseSkips: 7 })).toBe("PARTIAL");
  });

  it("does not fail a run on lease skips alone", () => {
    expect(resolveRunStatus({ failures: 3, totalQueries: 4, budgetTruncated: false, leaseSkips: 1 })).toBe("PARTIAL");
  });

  it("is unchanged without lease skips", () => {
    expect(resolveRunStatus({ failures: 0, totalQueries: 4, budgetTruncated: false })).toBe("DONE");
    expect(resolveRunStatus({ failures: 0, totalQueries: 4, budgetTruncated: false, leaseSkips: 0 })).toBe("DONE");
  });
});
