import { afterEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../model-runtime/structured-task-runtime-bridge", () => ({
  executeStructuredTaskWithRuntime: fitRuntimeMocks.execute,
}));

vi.mock("../durable-results/domain-ack-consumer-bindings", () => ({
  applyDomainAckConsumerTransactions: acknowledgementMocks.apply,
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
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async (statement: { values: readonly unknown[] }) => {
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

function discoveryArgs<T extends object>(runId: string, extra: T) {
  return {
    workspaceId: DISCOVERY_BINDING.scopeKey,
    runId,
    planId: "50000000-0000-4000-8000-000000000001",
    queryOrdinal: 0,
    executionContractVersion: 2 as const,
    executionBudget: DISCOVERY_BINDING,
    ...extra,
  };
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

describe("executeQuery —— 预算截断显性上报（不假 DONE），靠 ledger 而非源抛错", () => {
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
      runId: "run-row-id",
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
      async (statement: { strings?: readonly string[]; values?: readonly unknown[] }) => {
        const sql = statement.strings?.join("?") ?? "";
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
        count: vi.fn(async ({ where }: { where: { ingestStatus: string } }) =>
          persistedRows.filter((row) => row.ingestStatus === where.ingestStatus).length),
      },
      discoveryRun: {
        update: vi.fn(async ({ data }: { data: { stats: Record<string, unknown> } }) => {
          runStats = data.stats;
          return {};
        }),
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
      .mockImplementationOnce(async (input: {
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
      }));

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
  });
});

describe("canonicalizeRun —— suppression authority 线性化", () => {
  it("excludes every legacy ingest version from downstream materialization", async () => {
    const rawFindMany = vi.fn(async () => []);
    const tx = {
      $queryRaw: vi.fn(async () => [{ pg_advisory_xact_lock: null }]),
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
        runId: "run-legacy",
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
        $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
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
      $queryRaw: async () => {
        order.push("lock");
        return [{ pg_advisory_xact_lock: null }];
      },
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
        findFirst: async () => ({ id: "existing-link" }),
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

    expect(order).toEqual(["lock", "suppression-read", "canonical-write"]);
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
      $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
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
              lei: "529900SAFEENTITY001",
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
      gleif: { lei: "529900SAFEENTITY001", legal_name: "Parker Hannifin" },
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
      $queryRaw: async () => [{ pg_advisory_xact_lock: null }],
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

  it("treats an activity response-loss retry for the same Raw link as an exact canonical no-op", async () => {
    const raw = {
      id: "raw-replay",
      providerKey: "registry",
      ingestStatus: "ACCEPTED",
      ingestVersion: "raw-source/v2",
      payload: {
        externalId: "registry:acme",
        name: "Acme GmbH",
        domain: "acme.example",
        country: "DE",
        attributes: { products: ["pump"] },
      },
    };
    let company: Record<string, unknown> | null = null;
    const links: Array<Record<string, unknown>> = [];
    const evidence: Array<Record<string, unknown>> = [];
    let clock = 0;
    const upsert = vi.fn(async (input: {
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
    });
    const tx = {
      $queryRaw: vi.fn(async () => [{ pg_advisory_xact_lock: null }]),
      rawSourceRecord: { findMany: vi.fn(async () => [raw]) },
      rawSourceGovernanceDisposition: { findMany: vi.fn(async () => []) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      canonicalCompany: {
        findUnique: vi.fn(async () => company),
        updateMany: vi.fn(async () => ({ count: 0 })),
        upsert,
      },
      identityLink: {
        findFirst: vi.fn(async ({ where }: { where: { rawRecordId: string } }) =>
          links.find((row) => row.rawRecordId === where.rawRecordId) ?? null),
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
  });

  it("applies a real sanitizer repair once and carries governed evidence without relinking Raw", async () => {
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
      $queryRaw: vi.fn(async () => [{ pg_advisory_xact_lock: null }]),
      rawSourceRecord: { findMany: vi.fn(async () => [raw]) },
      rawSourceGovernanceDisposition: { findMany: vi.fn(async () => []) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      canonicalCompany: {
        findUnique: vi.fn(async () => company),
        updateMany: vi.fn(async () => ({ count: 0 })),
        upsert,
      },
      identityLink: {
        findFirst: vi.fn(async () => ({ id: "existing-link" })),
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

    await expect(
      activities.canonicalizeRun(discoveryArgs("run-repair", {})),
    ).resolves.toEqual({ companies: 1, suppressed: 0 });
    expect(company.attributes).toEqual({ products: ["pump"] });
    expect(company.version).toBe(4);
    expect(evidenceCreate).toHaveBeenCalledOnce();
    expect(evidenceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rawRecordId: raw.id,
        field: "attributes",
        value: { products: ["pump"] },
      }),
    });

    const repairedBytes = JSON.stringify(company);
    await expect(
      activities.canonicalizeRun(discoveryArgs("run-repair", {})),
    ).resolves.toEqual({ companies: 0, suppressed: 0 });
    expect(JSON.stringify(company)).toBe(repairedBytes);
    expect(evidenceCreate).toHaveBeenCalledOnce();
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
