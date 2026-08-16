import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../discovery/fit-judge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../discovery/fit-judge")>();
  return {
    ...actual,
    judgeFitCompany: vi.fn(actual.judgeFitCompany),
  };
});

vi.mock("../discovery/sec-edgar-submission-observation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../discovery/sec-edgar-submission-observation")>();
  return {
    ...actual,
    loadSecEdgarDirectoryBinding: vi.fn(),
    persistSecEdgarSubmissionObservation: vi.fn(),
  };
});

import { createDiscoveryActivities } from "./discovery.activities";
import { resolveRunStatus } from "./discovery.run-status";
import type {
  BrazilPncpNotice,
  ProcurementPage,
  UkProcurementOrganization,
} from "../adapters/public-procurement";
import {
  BrazilPncpDiscoveryProvider,
  UkContractsFinderDiscoveryProvider,
} from "../discovery/providers/public-procurement.providers";
import { budgetLedger } from "../tools/budget";
import type {
  CompanyDiscoveryAdapter,
  EnrichmentResult,
  ExecutionContext,
  ProviderCompanyRecord,
} from "../discovery/provider-contract";
import { judgeFitCompany } from "../discovery/fit-judge";
import {
  loadSecEdgarDirectoryBinding,
  persistSecEdgarSubmissionObservation,
} from "../discovery/sec-edgar-submission-observation";
import type {
  ExecutionBroker,
  ToolContext,
  ToolResult,
} from "../tools/tool-contract";

/**
 * executeQuery 预算截断透传单测（Codex PR #51 P1，根治版）：fan-out 中某源打穿 run 预算时，**真实 provider
 * 的 fail-safe catch 会把 BudgetExceededError 吞成空结果**（对源失败是对的）——所以 executeQuery 不能靠
 * 「某源 reject」判断，必须靠 BudgetLedger.wasExhausted 检出，据此返回 budgetTruncated 让 workflow 判 PARTIAL
 * 而非 DONE。本测用一个「reserve 打穿 → 自己吞掉」的假 adapter 复刻生产形态（而非直接抛错的合成 mock）。
 */

const REC: ProviderCompanyRecord = {
  externalId: "acme.de",
  name: "Acme",
  domain: "acme.de",
  attributes: {},
  provenance: {
    sourceUrl: "https://acme.de/",
    fetchedAt: "2026-07-11T00:00:00.000Z",
    contentHash: "h",
    parserVersion: "v1",
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

function makeDeps(
  adapters: CompanyDiscoveryAdapter[],
  existingRaw: unknown[] = [],
  usageLedgerCreate: (args: unknown) => Promise<unknown> = async () => ({}),
) {
  const tx = {
    $executeRaw: async () => 1,
    rawSourceRecord: {
      findMany: async () => existingRaw,
      createMany: async ({ data }: { data: unknown[] }) => ({
        count: data.length,
      }),
    },
    usageLedger: { create: usageLedgerCreate },
  };
  const prisma = {
    sourcePolicy: { findMany: async () => [] as { domain: string }[] },
    withWorkspace: async <T>(
      _ws: string,
      fn: (tx: unknown) => Promise<T>,
    ): Promise<T> => fn(tx),
  };
  const providers = { routeCompanyDiscovery: async () => adapters };
  return { prisma, providers, gateway: {} } as unknown as Parameters<
    typeof createDiscoveryActivities
  >[0];
}

const QUERY = {
  source_class: "public_intelligence",
  filters: {},
  keywords: [],
  priority: 1,
};

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
});

/** 模拟真实富集源：enrichCompany 里 broker/gateway 的 reserve 打穿预算 → enrichRun 的 catch 吞掉。 */
const budgetSwallowingEnricher = {
  key: "gleif",
  enrichCompany: async (_c: unknown, ctx: ExecutionContext) => {
    budgetLedger.reserve(ctx.runId ?? ctx.workspaceId, 10_000_000); // 抛 → enrichRun catch 吞掉（fail-safe）
    return { matched: false } as EnrichmentResult;
  },
};

function makeEnrichDeps(
  enrichers: unknown[],
  existingAttributes: Record<string, unknown> = {},
  updateMany: (args: unknown) => Promise<{ count: number }> = async () => ({
    count: 1,
  }),
) {
  const tx = {
    $queryRaw: async () => [{ locked: true }],
    $executeRaw: async () => 1,
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
          attributes: existingAttributes,
        },
      ],
      updateMany,
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
    routeFitEvidenceEnrichment: async () => enrichers,
    routeSignalEnrichment: async () => enrichers,
  };
  return { prisma, providers, gateway: {} } as unknown as Parameters<
    typeof createDiscoveryActivities
  >[0];
}

describe("executeQuery —— 预算截断显性上报（不假 DONE），靠 ledger 而非源抛错", () => {
  it("按实际 Provider 调用数记 public_web 成本，并持久化 backend/阶段明细，即使零 Raw", async () => {
    const usageLedgerCreate = vi.fn(async () => ({}));
    const providerUsage = {
      callCount: 3,
      breakdown: [
        { phase: "search", backend: "searxng.search", callCount: 2, completedCount: 2, costCents: 2 },
        { phase: "crawl", backend: "crawl4ai.render", callCount: 1, completedCount: 1, costCents: 1 },
      ],
    } as const;
    const adapter = {
      key: "public_web",
      classes: ["public_intelligence"],
      discoverCompanies: vi.fn(async () => ({
        records: [],
        costCents: 3,
        usage: providerUsage,
      })),
    } as unknown as CompanyDiscoveryAdapter;
    const acts = createDiscoveryActivities(
      makeDeps([adapter], [], usageLedgerCreate),
    );

    const result = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: { ...QUERY, limit: 5 },
    });

    expect(result).toMatchObject({ rawCount: 0, costCents: 3 });
    expect(usageLedgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resourceType: "provider_call",
        quantity: 3,
        costUsd: 0.03,
        meta: expect.objectContaining({
          providerUsage: [{
            providerKey: "public_web",
            accounting: "reported_calls",
            rawCount: 0,
            costCents: 3,
            callCount: 3,
            breakdown: providerUsage.breakdown,
          }],
        }),
      }),
    });
  });

  it("零成本 Provider 调用也持久化 backend/阶段明细", async () => {
    const usageLedgerCreate = vi.fn(async () => ({}));
    const providerUsage = {
      callCount: 2,
      breakdown: [
        { phase: "search", backend: "searxng.search", callCount: 2, completedCount: 2, costCents: 0 },
      ],
    } as const;
    const adapter = {
      key: "public_web",
      classes: ["public_intelligence"],
      discoverCompanies: vi.fn(async () => ({
        records: [],
        costCents: 0,
        usage: providerUsage,
      })),
    } as unknown as CompanyDiscoveryAdapter;
    const acts = createDiscoveryActivities(
      makeDeps([adapter], [], usageLedgerCreate),
    );

    await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-zero-cost",
      query: { ...QUERY, limit: 5 },
    });

    expect(usageLedgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resourceType: "provider_call",
        quantity: 2,
        costUsd: 0,
        meta: expect.objectContaining({
          providerUsage: [expect.objectContaining({
            providerKey: "public_web",
            costCents: 0,
            callCount: 2,
            breakdown: providerUsage.breakdown,
          })],
        }),
      }),
    });
  });

  it("does not fan out to explicit-only ROR, SEC or FMCSA unless source_hint names one exactly", async () => {
    const rorDiscover = vi.fn().mockResolvedValue({ records: [REC], costCents: 0 });
    const secDiscover = vi.fn().mockResolvedValue({ records: [REC], costCents: 0 });
    const fmcsaDiscover = vi.fn().mockResolvedValue({ records: [REC], costCents: 0 });
    const wikidataDiscover = vi
      .fn()
      .mockResolvedValue({ records: [], costCents: 0 });
    const acts = createDiscoveryActivities(
      makeDeps([
        {
          key: "ror",
          classes: ["company_registry"],
          discoverCompanies: rorDiscover,
        } as unknown as CompanyDiscoveryAdapter,
        {
          key: "wikidata",
          classes: ["company_registry"],
          discoverCompanies: wikidataDiscover,
        } as unknown as CompanyDiscoveryAdapter,
        {
          key: "sec_edgar",
          classes: ["company_registry"],
          discoverCompanies: secDiscover,
        } as unknown as CompanyDiscoveryAdapter,
        {
          key: "fmcsa_qcmobile",
          classes: ["company_registry"],
          discoverCompanies: fmcsaDiscover,
        } as unknown as CompanyDiscoveryAdapter,
      ]),
    );

    await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: { ...QUERY, source_class: "company_registry", limit: 5 },
    });

    expect(rorDiscover).not.toHaveBeenCalled();
    expect(secDiscover).not.toHaveBeenCalled();
    expect(fmcsaDiscover).not.toHaveBeenCalled();
    expect(wikidataDiscover).toHaveBeenCalledOnce();

    rorDiscover.mockClear();
    wikidataDiscover.mockClear();
    await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: {
        ...QUERY,
        source_class: "company_registry",
        filters: { source_hint: "ror" },
        limit: 1,
      },
    });

    expect(rorDiscover).toHaveBeenCalledOnce();
    expect(secDiscover).not.toHaveBeenCalled();
    expect(fmcsaDiscover).not.toHaveBeenCalled();
    expect(wikidataDiscover).not.toHaveBeenCalled();

    rorDiscover.mockClear();
    await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: {
        ...QUERY,
        source_class: "company_registry",
        filters: { source_hint: " SEC_EDGAR " },
        keywords: ["ACME"],
        limit: 1,
      },
    });
    expect(secDiscover).toHaveBeenCalledOnce();
    expect(rorDiscover).not.toHaveBeenCalled();
    expect(fmcsaDiscover).not.toHaveBeenCalled();
    expect(wikidataDiscover).not.toHaveBeenCalled();

    secDiscover.mockClear();
    await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: {
        ...QUERY,
        source_class: "company_registry",
        filters: { source_hint: "fmcsa_qcmobile" },
        keywords: ["ACME LOGISTICS LLC"],
        limit: 1,
      },
    });
    expect(fmcsaDiscover).toHaveBeenCalledOnce();
    expect(secDiscover).not.toHaveBeenCalled();
    expect(rorDiscover).not.toHaveBeenCalled();
    expect(wikidataDiscover).not.toHaveBeenCalled();
  });

  it("does not fan out to EU Ecolabel, SBIR or KONEPS without an exact source_hint", async () => {
    const euDiscover = vi.fn().mockResolvedValue({ records: [REC], costCents: 0 });
    const sbirDiscover = vi.fn().mockResolvedValue({ records: [REC], costCents: 0 });
    const konepsDiscover = vi.fn().mockResolvedValue({ records: [REC], costCents: 0 });
    const wikidataDiscover = vi.fn().mockResolvedValue({ records: [], costCents: 0 });
    const acts = createDiscoveryActivities(makeDeps([
      { key: "eu_ecolabel", classes: ["public_intelligence"], discoverCompanies: euDiscover },
      { key: "sbir_sttr_companies", classes: ["public_intelligence"], discoverCompanies: sbirDiscover },
      { key: "koneps", classes: ["public_intelligence"], discoverCompanies: konepsDiscover },
      { key: "wikidata", classes: ["public_intelligence"], discoverCompanies: wikidataDiscover },
    ] as CompanyDiscoveryAdapter[]));

    await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: { ...QUERY, limit: 5 },
    });
    expect(euDiscover).not.toHaveBeenCalled();
    expect(sbirDiscover).not.toHaveBeenCalled();
    expect(konepsDiscover).not.toHaveBeenCalled();
    expect(wikidataDiscover).toHaveBeenCalledOnce();

    await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: { ...QUERY, filters: { source_hint: " EU_ECOLABEL " }, limit: 1 },
    });
    expect(euDiscover).toHaveBeenCalledOnce();
    expect(sbirDiscover).not.toHaveBeenCalled();
    expect(konepsDiscover).not.toHaveBeenCalled();
  });

  it("rejects non-string and empty source_hint values before routing", async () => {
    const acts = createDiscoveryActivities(makeDeps([]));

    await expect(
      acts.executeQuery({
        workspaceId: "ws-1",
        runId: "run-ok-x",
        query: {
          ...QUERY,
          filters: { source_hint: ["ror"] },
          limit: 5,
        },
      }),
    ).rejects.toThrow("DISCOVERY_SOURCE_HINT_INVALID");
    await expect(
      acts.executeQuery({
        workspaceId: "ws-1",
        runId: "run-ok-x",
        query: { ...QUERY, filters: { source_hint: "  " }, limit: 5 },
      }),
    ).rejects.toThrow("DISCOVERY_SOURCE_HINT_INVALID");
  });

  it("treats an explicit disabled or unroutable provider hint as a failed attempt", async () => {
    const acts = createDiscoveryActivities(makeDeps([]));
    const result = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: {
        ...QUERY,
        filters: { source_hint: "singapore_gebiz" },
        limit: 5,
      },
    });

    expect(result).toMatchObject({
      provider: "singapore_gebiz",
      rawCount: 0,
      failedProviderCount: 1,
      perProvider: {
        singapore_gebiz: {
          attemptedCount: 1,
          successCount: 0,
          failureCount: 1,
          zeroResultCount: 0,
        },
      },
    });
  });

  it("安全消费 provider 游标，最多三页且总记录不超过查询计划上限", async () => {
    const discoverCompanies = vi
      .fn()
      .mockResolvedValueOnce({
        records: [{ ...REC, externalId: "p1" }],
        costCents: 0,
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        records: [{ ...REC, externalId: "p2" }],
        costCents: 0,
        nextCursor: "cursor-3",
      })
      .mockResolvedValueOnce({
        records: [{ ...REC, externalId: "p3" }],
        costCents: 0,
        nextCursor: "cursor-4",
      });
    const deps = makeDeps([
      {
        key: "world_bank_procurement",
        classes: ["public_intelligence"],
        discoverCompanies,
      } as CompanyDiscoveryAdapter,
    ]);
    const acts = createDiscoveryActivities(deps);

    const result = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: { ...QUERY, limit: 5 },
    });

    expect(discoverCompanies).toHaveBeenCalledTimes(3);
    expect(discoverCompanies.mock.calls.map((call) => call[2]?.cursor)).toEqual(
      [undefined, "cursor-2", "cursor-3"],
    );
    expect(result).toMatchObject({
      rawCount: 3,
      paginationTruncated: true,
      failedProviderCount: 0,
    });
  });

  it("一页达到 query.limit 就停止，即使 provider 返回后续游标也不误报截断", async () => {
    const discoverCompanies = vi.fn().mockResolvedValue({
      records: Array.from({ length: 30 }, (_, index) => ({
        ...REC,
        externalId: `p${index + 1}`,
      })),
      costCents: 0,
      nextCursor: "cursor-2",
    });
    const deps = makeDeps([
      {
        key: "world_bank_procurement",
        classes: ["public_intelligence"],
        discoverCompanies,
      } as CompanyDiscoveryAdapter,
    ]);
    const acts = createDiscoveryActivities(deps);

    const result = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: { ...QUERY, limit: 25 },
    });

    expect(discoverCompanies).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      rawCount: 25,
      paginationTruncated: false,
      failedProviderCount: 0,
    });
  });

  it("Contracts Finder 前两页被地区和关键词过滤为空时继续到第三页，并在仍有游标时显式截断", async () => {
    const provenance = {
      sourceUrl:
        "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search",
      fetchedAt: "2026-08-14T00:00:00.000Z",
      contentHash: "a".repeat(64),
      parserVersion: "uk-contracts-finder-ocds/v4",
    };
    const buyer = (
      externalId: string,
      region: UkProcurementOrganization["region"],
      title: string,
    ): UkProcurementOrganization => ({
      externalId,
      ocid: `ocds-${externalId}`,
      releaseId: `release-${externalId}`,
      organizationName: `Buyer ${externalId}`,
      organizationRole: "buyer",
      signalStage: "planning_or_tender",
      country: "United Kingdom",
      region,
      title,
      status: "active",
      deadline: "2099-12-31T23:59:59Z",
    });
    const pages: ProcurementPage<UkProcurementOrganization>[] = [
      {
        records: [
          buyer("england", "England", "Industrial maintenance services"),
        ],
        nextCursor: "cursor-2",
        provenance,
      },
      {
        records: [buyer("wales-office", "Wales", "Office stationery")],
        nextCursor: "cursor-3",
        provenance,
      },
      {
        records: [
          buyer(
            "wales-maintenance",
            "Wales",
            "Industrial maintenance services",
          ),
        ],
        nextCursor: "cursor-4",
        provenance,
      },
    ];
    const invokeMock = vi.fn(
      async (
        _toolId: string,
        _input: unknown,
        _ctx: ToolContext,
      ): Promise<ToolResult<unknown>> => {
        const page = pages.shift();
        if (!page) throw new Error("unexpected fourth Contracts Finder page");
        return { data: page, costCents: 0, provenance: page.provenance };
      },
    );
    const broker: ExecutionBroker = {
      checkSourcePolicy: async () => ({ allowed: true }),
      invoke: invokeMock as ExecutionBroker["invoke"],
    };
    const adapter = new UkContractsFinderDiscoveryProvider({ broker });
    const acts = createDiscoveryActivities(makeDeps([adapter]));

    const result = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: {
        ...QUERY,
        filters: {
          source_hint: "uk_contracts_finder",
          country: "United Kingdom",
          region: "Wales",
          procurement_role: "buyer",
        },
        keywords: ["maintenance"],
        limit: 5,
      },
    });

    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(
      invokeMock.mock.calls.map(
        (call) => (call[1] as { cursor?: string }).cursor,
      ),
    ).toEqual([undefined, "cursor-2", "cursor-3"]);
    expect(result).toMatchObject({
      provider: "uk_contracts_finder",
      rawCount: 1,
      paginationTruncated: true,
      failedProviderCount: 0,
      perProvider: {
        uk_contracts_finder: {
          attemptedCount: 1,
          successCount: 1,
          zeroResultCount: 0,
          failureCount: 0,
          rawCount: 1,
        },
      },
    });
  });

  it("PNCP continuation survives the orchestrator reducing the remaining business limit", async () => {
    const provenance = {
      sourceUrl: "https://pncp.gov.br/api/consulta/v1/contratacoes/proposta",
      fetchedAt: "2026-08-14T00:00:00.000Z",
      contentHash: "b".repeat(64),
      parserVersion: "brazil-pncp-proposals/v3",
    };
    const notice = (
      controlNumber: string,
      organizationName: string,
    ): BrazilPncpNotice => ({
      controlNumber,
      organizationName,
      organizationRole: "buyer",
      signalStage: "open_for_proposals",
      title: `Serviço industrial ${controlNumber}`,
      deadline: "2099-12-31T23:59:59",
    });
    const pages: ProcurementPage<BrazilPncpNotice>[] = [
      { records: [notice("A-1", "Buyer A")], nextCursor: "2", provenance },
      { records: [notice("B-2", "Buyer B")], provenance },
    ];
    const invokeMock = vi.fn(
      async (
        _toolId: string,
        _input: unknown,
        _ctx: ToolContext,
      ): Promise<ToolResult<unknown>> => {
        const page = pages.shift();
        if (!page) throw new Error("unexpected third PNCP page");
        return { data: page, costCents: 0, provenance: page.provenance };
      },
    );
    const broker: ExecutionBroker = {
      checkSourcePolicy: async () => ({ allowed: true }),
      invoke: invokeMock as ExecutionBroker["invoke"],
    };
    const acts = createDiscoveryActivities(
      makeDeps([new BrazilPncpDiscoveryProvider({ broker })]),
    );

    const result = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: {
        ...QUERY,
        filters: {
          source_hint: "brazil_pncp",
          country: "BR",
          procurement_role: "buyer",
        },
        keywords: ["serviço"],
        limit: 2,
      },
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(
      invokeMock.mock.calls.map(
        (call) => call[1] as { page: number; pageSize: number },
      ),
    ).toEqual([
      expect.objectContaining({ page: 1, pageSize: 50 }),
      expect.objectContaining({ page: 2, pageSize: 50 }),
    ]);
    expect(result).toMatchObject({
      provider: "brazil_pncp",
      rawCount: 2,
      paginationTruncated: false,
      failedProviderCount: 0,
    });
  });

  it("stops a repeated cursor and marks the provider partial instead of looping", async () => {
    const discoverCompanies = vi
      .fn()
      .mockResolvedValueOnce({
        records: [{ ...REC, externalId: "p1" }],
        costCents: 0,
        nextCursor: "same",
      })
      .mockResolvedValueOnce({
        records: [{ ...REC, externalId: "p2" }],
        costCents: 0,
        nextCursor: "same",
      });
    const deps = makeDeps([
      {
        key: "world_bank_procurement",
        classes: ["public_intelligence"],
        discoverCompanies,
      } as CompanyDiscoveryAdapter,
    ]);
    const acts = createDiscoveryActivities(deps);

    const result = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: { ...QUERY, limit: 5 },
    });

    expect(discoverCompanies).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      rawCount: 2,
      paginationTruncated: true,
      failedProviderCount: 1,
    });
  });

  it("keeps earlier pages but records a later-page failure as a partial provider result", async () => {
    const discoverCompanies = vi
      .fn()
      .mockResolvedValueOnce({
        records: [{ ...REC, externalId: "p1" }],
        costCents: 0,
        nextCursor: "cursor-2",
      })
      .mockRejectedValueOnce(new Error("UPSTREAM_PAGE_FAILED"));
    const deps = makeDeps([
      {
        key: "world_bank_procurement",
        classes: ["public_intelligence"],
        discoverCompanies,
      } as CompanyDiscoveryAdapter,
    ]);
    const acts = createDiscoveryActivities(deps);

    const result = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: { ...QUERY, limit: 5 },
    });

    expect(result).toMatchObject({
      rawCount: 1,
      paginationTruncated: true,
      failedProviderCount: 1,
    });
    expect(result.perProvider.world_bank_procurement).toMatchObject({
      attemptedCount: 1,
      successCount: 0,
      failureCount: 1,
      rawCount: 1,
    });
  });

  it("保留单源失败计数，不把 reject 当成正常零结果", async () => {
    const deps = makeDeps([
      {
        key: "wikidata",
        classes: ["company_registry"],
        discoverCompanies: vi.fn(async () => {
          throw Object.assign(new Error("operation timed out"), {
            name: "TimeoutError",
          });
        }),
      } as unknown as CompanyDiscoveryAdapter,
    ]);
    const acts = createDiscoveryActivities(deps);

    const result = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: QUERY,
    });

    expect(result).toMatchObject({
      rawCount: 0,
      provider: null,
      failedProviderCount: 1,
      perProvider: {
        wikidata: {
          attemptedCount: 1,
          successCount: 0,
          zeroResultCount: 0,
          failureCount: 1,
          rawCount: 0,
          quarantinedCount: 0,
          rejectedCount: 0,
          duplicateCount: 0,
        },
      },
    });
  });

  it("为每个实际路由的 provider 保留独立统计，包括零结果和失败", async () => {
    const deps = makeDeps([
      okAdapter("wikidata", []),
      {
        key: "ted",
        classes: ["public_intelligence"],
        discoverCompanies: vi.fn(async () => {
          throw new Error("upstream unavailable");
        }),
      } as unknown as CompanyDiscoveryAdapter,
      okAdapter("openfda", [REC]),
    ]);
    const acts = createDiscoveryActivities(deps);

    const result = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: QUERY,
    });

    expect(result.perProvider).toEqual({
      openfda: {
        attemptedCount: 1,
        successCount: 1,
        zeroResultCount: 0,
        failureCount: 0,
        rawCount: 1,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
      },
      ted: {
        attemptedCount: 1,
        successCount: 0,
        zeroResultCount: 0,
        failureCount: 1,
        rawCount: 0,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
      },
      wikidata: {
        attemptedCount: 1,
        successCount: 1,
        zeroResultCount: 1,
        failureCount: 0,
        rawCount: 0,
        quarantinedCount: 0,
        rejectedCount: 0,
        duplicateCount: 0,
      },
    });
  });

  it("遵守查询计划的小批量上限，不把单家金丝雀放大成默认 25 家", async () => {
    const discoverCompanies = vi.fn(async () => ({
      records: [],
      costCents: 0,
    }));
    const deps = makeDeps([
      {
        key: "wikidata",
        classes: ["company_registry"],
        discoverCompanies,
      } as unknown as CompanyDiscoveryAdapter,
    ]);
    const acts = createDiscoveryActivities(deps);

    await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: { ...QUERY, limit: 1 },
    });

    expect(discoverCompanies).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("某源打穿 run 预算并被 fail-safe 吞掉 → wasExhausted 检出 budgetTruncated=true，其余源记录仍落库", async () => {
    const deps = makeDeps([
      budgetSwallowingAdapter("public_web"),
      okAdapter("wikidata", [REC]),
    ]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-budget-x",
      query: QUERY,
    });
    expect(r.budgetTruncated).toBe(true);
    expect(r.rawCount).toBe(1); // wikidata 的记录不因 public_web 打穿而丢失
  });

  it("全部源正常 → budgetTruncated=false，记录照常落库", async () => {
    const deps = makeDeps([okAdapter("wikidata", [REC])]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.executeQuery({
      workspaceId: "ws-1",
      runId: "run-ok-x",
      query: QUERY,
    });
    expect(r.budgetTruncated).toBe(false);
    expect(r.rawCount).toBe(1);
  });

  it("同一 provider processing key 内容漂移时隔离并留下审计回执", async () => {
    const deps = makeDeps(
      [okAdapter("wikidata", [REC])],
      [
        {
          id: "raw-existing",
          externalId: REC.externalId,
          ingestKey: null,
          payloadHash: null,
          payload: { ...REC, name: "Different Company" },
        },
      ],
    );
    const acts = createDiscoveryActivities(deps);
    await expect(
      acts.executeQuery({
        workspaceId: "ws-1",
        runId: "run-ok-x",
        query: QUERY,
      }),
    ).resolves.toMatchObject({
      rawCount: 0,
      quarantinedCount: 1,
    });
  });
});

describe("canonicalizeRun —— suppression authority 线性化", () => {
  it("在读 suppression 和任何 canonical write 前先取 workspace policy lock", async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: async () => {
        order.push("lock");
        return [{ locked: "" }];
      },
      $executeRaw: async () => 1,
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
        findMany: async () => [],
        findFirst: async () => ({ id: "existing-link" }),
        create: async () => ({}),
      },
      organizationIdentifier: {
        findMany: async () => [],
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
    } as never);

    await activities.canonicalizeRun({ workspaceId: "ws-1", runId: "run-1" });

    expect(order[0]).toBe("lock");
    expect(order.indexOf("suppression-read")).toBeLessThan(
      order.indexOf("canonical-write"),
    );
  });

  it("既有 canonical identity 命中 suppression 时只修复状态，不再链接或写 evidence", async () => {
    const upsert = vi.fn();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const linkCreate = vi.fn();
    const evidenceCreate = vi.fn();
    const tx = {
      $queryRaw: async () => [{ locked: "" }],
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
    } as never);

    await expect(
      activities.canonicalizeRun({ workspaceId: "ws-1", runId: "run-1" }),
    ).resolves.toEqual({
      companies: 0,
      suppressed: 1,
      manualFollowup: 0,
      identityQuality: {
        wikidata: {
          acceptedRows: 1,
          namedRows: 1,
          domainRows: 0,
          authorityIdentifierRows: 0,
          officialRegistrationRows: 0,
          boundRows: 0,
          uniqueCompanies: 0,
          conflictRows: 0,
          suppressedRows: 1,
          replayedRows: 0,
        },
      },
    });
    expect(updateMany).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
    expect(linkCreate).not.toHaveBeenCalled();
    expect(evidenceCreate).not.toHaveBeenCalled();
  });

  it("永久限制的 Raw 不进入 resolver/evidence，且 owner-bypass 重放仍显式计入 suppressed", async () => {
    const resolution = vi.fn();
    const evidenceCreate = vi.fn();
    const rawRows = [
      {
        id: "raw-restricted",
        providerKey: "usaspending_awards",
        payload: { name: "Must Not Materialize" },
      },
      {
        id: "raw-safe",
        providerKey: "wikidata",
        payload: {},
      },
    ];
    const tx = {
      $queryRaw: async () => [{ locked: "" }],
      rawSourceGovernanceDisposition: {
        findMany: async () => [
          {
            rawRecordId: "raw-restricted",
            providerKey: "usaspending_awards",
          },
        ],
      },
      // Deliberately ignores the second query's id filter to simulate a custom
      // owner/BYPASSRLS client. The second in-memory partition must still win.
      rawSourceRecord: { findMany: async () => rawRows },
      suppressionRecord: { findMany: async () => [] },
      canonicalCompany: { findUnique: async () => null },
      identityLink: {
        findMany: resolution,
        findFirst: resolution,
        create: resolution,
      },
      organizationIdentifier: {
        findMany: resolution,
        findFirst: resolution,
        create: resolution,
      },
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
    } as never);

    await expect(
      activities.canonicalizeRun({ workspaceId: "ws-1", runId: "run-1" }),
    ).resolves.toEqual({
      companies: 0,
      suppressed: 1,
      manualFollowup: 0,
      identityQuality: {
        usaspending_awards: {
          acceptedRows: 0,
          namedRows: 0,
          domainRows: 0,
          authorityIdentifierRows: 0,
          officialRegistrationRows: 0,
          boundRows: 0,
          uniqueCompanies: 0,
          conflictRows: 0,
          suppressedRows: 1,
          replayedRows: 0,
        },
        wikidata: {
          acceptedRows: 1,
          namedRows: 0,
          domainRows: 0,
          authorityIdentifierRows: 0,
          officialRegistrationRows: 0,
          boundRows: 0,
          uniqueCompanies: 0,
          conflictRows: 0,
          suppressedRows: 0,
          replayedRows: 0,
        },
      },
    });
    expect(resolution).not.toHaveBeenCalled();
    expect(evidenceCreate).not.toHaveBeenCalled();
  });
});

describe("enrichRun / resetRunBudget —— 富集阶段截断也上报 + 崩溃重试清账", () => {
  it("uses the persisted SEC directory binding for pre-fit submissions and reports sanitized Raw facts", async () => {
    const binding = {
      rawRecordId: "raw-directory-1",
      companyId: "c1",
      companyName: "C1",
      cik: "0000000123",
      identitySnapshot: "snapshot-1",
      externalId: "sec-edgar:0000000123",
      sourceUrl: "https://www.sec.gov/files/company_tickers_exchange.json" as const,
      parserVersion: "sec-edgar-company-tickers-exchange/1" as const,
    };
    vi.mocked(loadSecEdgarDirectoryBinding).mockResolvedValueOnce(binding);
    vi.mocked(persistSecEdgarSubmissionObservation).mockResolvedValueOnce({
      rawRecordId: "raw-submission-1",
      rawCreated: 1,
      replayed: false,
      evidenceWritten: 4,
    });
    const enrichCompany = vi.fn(async () => ({
      matched: true,
      confidence: 1,
      attributes: {
        submission_entity_type: "operating",
        submission_schema_version: "sec-edgar-submission-observation/v1",
      },
      provenance: {
        sourceUrl: "https://data.sec.gov/submissions/CIK0000000123.json",
        fetchedAt: "2026-08-14T00:00:00.000Z",
        contentHash: "a".repeat(64),
        parserVersion: "sec-edgar-submissions/1",
      },
      rawObservation: {
        externalId: "sec-edgar-submission:0000000123",
        sourceClass: "company_registry" as const,
        license: "US-GOV-PUBLIC-INFO",
        payload: {},
      },
      costCents: 0,
    }));
    const deps = makeEnrichDeps(
      [{ key: "sec_edgar", enrichCompany }],
      { sec_edgar: { cik: "0000000123", ticker: "C1" } },
    );

    const result = await createDiscoveryActivities(deps).enrichRun({
      workspaceId: "ws-1",
      runId: "run-enrich-ok",
      icpId: "icp-1",
      phase: "pre_fit_evidence",
    });

    expect(enrichCompany).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "fit_evidence",
        sourceBindings: [expect.objectContaining({
          rawRecordId: "raw-directory-1",
          identifier: { scheme: "cik", jurisdiction: "US", value: "0000000123" },
        })],
      }),
      expect.any(Object),
    );
    expect(persistSecEdgarSubmissionObservation).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      matched: 1,
      provider: "sec_edgar",
      dataQualityBlocked: false,
      perProvider: {
        sec_edgar: {
          attemptedCount: 1,
          successCount: 1,
          failureCount: 0,
          rawCount: 1,
          duplicateCount: 0,
        },
      },
      identityQuality: {
        sec_edgar: {
          acceptedRows: 1,
          namedRows: 0,
          domainRows: 0,
          authorityIdentifierRows: 0,
          officialRegistrationRows: 0,
          boundRows: 1,
          uniqueCompanies: 1,
          conflictRows: 0,
          suppressedRows: 0,
          replayedRows: 0,
        },
      },
    });
  });

  it("名称企业先安全补域名，再在同一轮把域名交给官网证据源", async () => {
    const state = {
      id: "c1",
      name: "Acme Ltd",
      domain: null as string | null,
      country: "GB",
      region: null,
      dedupeKey: "n:acme:gb",
      attributes: {} as Record<string, unknown>,
      status: "NEW",
    };
    const identifiers: unknown[] = [];
    const evidence: unknown[] = [];
    const wikidataEnrich = vi.fn(async () => ({
      matched: true,
      confidence: 1,
      attributes: {
        qid: "Q1",
        website: "acme.example",
        identity_evidence_version: "wikidata-enrich/v2",
      },
      identifiers: [
        { scheme: "domain", jurisdiction: "GLOBAL", value: "acme.example" },
        { scheme: "wikidata-qid", jurisdiction: "GLOBAL", value: "Q1" },
      ],
      costCents: 0,
    }));
    const footprintEnrich = vi.fn(async () => ({
      matched: true,
      confidence: 1,
      attributes: {
        structured_products: ["Pump"],
        fit_evidence_version: "digital-footprint/v3",
      },
      costCents: 0,
    }));
    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
        strings.join("").includes('FROM "canonical_company"')
          ? []
          : [{ locked: true }],
      ),
      $executeRaw: vi.fn(async () => 1),
      rawSourceRecord: { findMany: async () => [{ id: "raw1" }] },
      identityLink: { findMany: async () => [{ canonicalId: "c1" }] },
      organizationIdentityConflictParty: { count: async () => 0 },
      organizationIdentifier: {
        findMany: async () => [],
        create: async ({ data }: { data: unknown }) => {
          identifiers.push(data);
          return {};
        },
        update: async () => ({}),
      },
      canonicalCompany: {
        findMany: async (args: {
          where?: { id?: { in?: string[] }; domain?: unknown };
        }) => {
          if (args.where?.domain)
            return state.domain ? [{ id: state.id, domain: state.domain }] : [];
          return [{ ...state }];
        },
        findUnique: async () => ({ ...state }),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          if (typeof data.domain === "string") state.domain = data.domain;
          if (data.attributes)
            state.attributes = data.attributes as Record<string, unknown>;
          if (typeof data.status === "string") state.status = data.status;
          return { count: 1 };
        },
      },
      suppressionRecord: { findMany: async () => [] },
      fieldEvidence: {
        findFirst: async () => null,
        create: async ({ data }: { data: unknown }) => {
          evidence.push(data);
          return {};
        },
      },
    };
    const deps = {
      prisma: {
        withWorkspace: async <T>(
          _ws: string,
          fn: (client: typeof tx) => Promise<T>,
        ) => fn(tx),
      },
      providers: {
        routeFitEvidenceEnrichment: async () => [
          { key: "wikidata", enrichCompany: wikidataEnrich },
          { key: "digital_footprint", enrichCompany: footprintEnrich },
        ],
      },
      gateway: {},
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];

    const result = await createDiscoveryActivities(deps).enrichRun({
      workspaceId: "ws-1",
      runId: "run-enrich-chain",
      icpId: "icp-1",
      phase: "pre_fit_evidence",
    });

    expect(footprintEnrich).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "acme.example",
        purpose: "fit_evidence",
      }),
      expect.any(Object),
    );
    expect(state.domain).toBe("acme.example");
    expect(state.dedupeKey).toBe("n:acme:gb");
    expect(identifiers).toHaveLength(2);
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "domain", value: "acme.example" }),
      ]),
    );
    expect(result).toMatchObject({
      enriched: 1,
      matched: 1,
      provider: "wikidata+digital_footprint",
    });
  });

  it("资格门前跑 registry 选出的 Wikidata + 官网证据源", async () => {
    const wikidataEnrich = vi.fn(async () => ({ matched: false }));
    const footprintEnrich = vi.fn(async () => ({ matched: false }));
    const deps = makeEnrichDeps([
      { key: "wikidata", enrichCompany: wikidataEnrich },
      { key: "digital_footprint", enrichCompany: footprintEnrich },
    ]);
    const acts = createDiscoveryActivities(deps);

    await acts.enrichRun({
      workspaceId: "ws-1",
      runId: "run-enrich-ok",
      icpId: "icp-1",
      phase: "pre_fit_evidence",
    });

    expect(wikidataEnrich).toHaveBeenCalledOnce();
    expect(footprintEnrich).toHaveBeenCalledOnce();
    expect(footprintEnrich).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "fit_evidence" }),
      expect.any(Object),
    );
  });

  it("旧公司只有数字足迹信号时懒升级产品证据，且不丢失原信号", async () => {
    const footprintEnrich = vi.fn(async () => ({
      matched: true,
      confidence: 1,
      attributes: { structured_products: ["Laser Cutting Machine X1"] },
      provenance: {
        sourceUrl: "https://c1.de/products/x1",
        fetchedAt: "2026-08-12T00:00:00.000Z",
        contentHash: "hash",
        parserVersion: "digital-footprint/v2",
      },
      costCents: 0,
    }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const deps = makeEnrichDeps(
      [{ key: "digital_footprint", enrichCompany: footprintEnrich }],
      {
        digital_footprint: {
          email_provider: "microsoft_365",
          _ts: "2026-08-01T00:00:00.000Z",
        },
      },
      updateMany,
    );
    const acts = createDiscoveryActivities(deps);

    await acts.enrichRun({
      workspaceId: "ws-1",
      runId: "run-enrich-ok",
      icpId: "icp-1",
      phase: "pre_fit_evidence",
    });

    expect(footprintEnrich).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({
            digital_footprint: expect.objectContaining({
              email_provider: "microsoft_365",
              structured_products: ["Laser Cutting Machine X1"],
            }),
          }),
        }),
      }),
    );
  });

  it("旧版已有产品但没有 v3 商业模式取证版本时仍懒升级并保留原信号", async () => {
    const footprintEnrich = vi.fn(async () => ({
      matched: true,
      confidence: 1,
      attributes: {
        structured_products: ["Laser Cutting Machine X1"],
        business_model: ["official_product_offer"],
        fit_evidence_version: "digital-footprint/v3",
      },
      provenance: {
        sourceUrl: "https://c1.de/products/x1",
        fetchedAt: "2026-08-12T00:00:00.000Z",
        contentHash: "hash-v3",
        parserVersion: "digital-footprint/v3",
      },
      costCents: 0,
    }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const deps = makeEnrichDeps(
      [{ key: "digital_footprint", enrichCompany: footprintEnrich }],
      {
        digital_footprint: {
          email_provider: "microsoft_365",
          structured_products: ["Laser Cutting Machine X1"],
          _ts: "2026-08-01T00:00:00.000Z",
        },
      },
      updateMany,
    );
    const acts = createDiscoveryActivities(deps);

    await acts.enrichRun({
      workspaceId: "ws-1",
      runId: "run-enrich-v3-upgrade",
      icpId: "icp-1",
      phase: "pre_fit_evidence",
    });

    expect(footprintEnrich).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attributes: expect.objectContaining({
            digital_footprint: expect.objectContaining({
              email_provider: "microsoft_365",
              business_model: ["official_product_offer"],
              fit_evidence_version: "digital-footprint/v3",
            }),
          }),
        }),
      }),
    );
  });

  it("富集源打穿 run 预算并被 fail-safe 吞掉 → enrichRun.budgetTruncated=true（不假 DONE）", async () => {
    const deps = makeEnrichDeps([budgetSwallowingEnricher]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.enrichRun({
      workspaceId: "ws-1",
      runId: "run-enrich-x",
      icpId: "icp-1",
    });
    expect(r.budgetTruncated).toBe(true);
  });

  it("富集正常 → enrichRun.budgetTruncated=false", async () => {
    const deps = makeEnrichDeps([
      { key: "gleif", enrichCompany: async () => ({ matched: false }) },
    ]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.enrichRun({
      workspaceId: "ws-1",
      runId: "run-enrich-ok",
      icpId: "icp-1",
    });
    expect(r.budgetTruncated).toBe(false);
  });

  it("信号富集源打穿 run 预算并被 fail-safe 吞掉 → enrichSignalsRun.budgetTruncated=true（与 enrichRun 对称）", async () => {
    const deps = makeEnrichDeps([budgetSwallowingEnricher]);
    const acts = createDiscoveryActivities(deps);
    const r = await acts.enrichSignalsRun({
      workspaceId: "ws-1",
      runId: "run-signal-x",
      icpId: "icp-1",
    });
    expect(r.budgetTruncated).toBe(true);
  });

  it("resetRunBudget 清除同 runId 残留的打穿标记（崩溃重试防误报截断）", async () => {
    const acts = createDiscoveryActivities(makeEnrichDeps([]));
    budgetLedger.open("run-leak", 10);
    try {
      budgetLedger.reserve("run-leak", 999);
    } catch {
      /* expected：打穿即打标 */
    }
    expect(budgetLedger.wasExhausted("run-leak")).toBe(true);
    await acts.resetRunBudget({ runId: "run-leak" });
    expect(budgetLedger.wasExhausted("run-leak")).toBe(false);
  });
});

describe("qualifyFitForRun —— 单家模型失败必须显性计数", () => {
  it("judgeFitCompany 返回 null 时不写伪 verdict，但 failed 增加", async () => {
    vi.mocked(judgeFitCompany).mockResolvedValueOnce(null);
    const company = {
      id: "c-fit-1",
      name: "Acme GmbH",
      domain: "acme.de",
      country: "DE",
      industry: "manufacturing",
      attributes: {},
      status: "NEW",
    };
    const tx = {
      $queryRaw: async () => [{ locked: true }],
      icpDefinition: {
        findUnique: async () => ({
          id: "icp-1",
          name: "Industrial buyers",
          company: null,
          companyAttributes: {},
          exclusions: {},
          targetMarkets: {},
        }),
      },
      rawSourceRecord: { findMany: async () => [{ id: "raw-fit-1" }] },
      identityLink: { findMany: async () => [{ canonicalId: company.id }] },
      canonicalCompany: {
        findMany: async () => [company],
        findUnique: async () => company,
        updateMany: async () => ({ count: 0 }),
      },
      suppressionRecord: { findMany: async () => [] },
      fieldEvidence: { findMany: async () => [] },
      lead: { findMany: async () => [], upsert: vi.fn() },
    };
    const prisma = {
      withWorkspace: async <T>(
        _workspaceId: string,
        callback: (client: typeof tx) => Promise<T>,
      ): Promise<T> => callback(tx),
      sourcePolicy: { findMany: async () => [] },
    };
    const activities = createDiscoveryActivities({
      prisma,
      providers: {},
      gateway: {},
    } as never);

    await expect(
      activities.qualifyFitForRun({
        workspaceId: "ws-1",
        runId: "run-fit-1",
        icpId: "icp-1",
      }),
    ).resolves.toEqual({
      judged: 0,
      failed: 1,
      verdicts: { match: 0, weak: 0, mismatch: 0 },
      skippedForBudget: 0,
    });
    expect(tx.lead.upsert).not.toHaveBeenCalled();
  });

  it("root 的 active alias 已有已判 Lead 时跳过候选，不做无意义模型调用", async () => {
    vi.mocked(judgeFitCompany).mockClear();
    const findCompanies = vi.fn(async () => {
      throw new Error(
        "already-judged identity group must not enter the fit candidate query",
      );
    });
    const tx = {
      icpDefinition: { findUnique: async () => null },
      rawSourceRecord: { findMany: async () => [{ id: "raw-root" }] },
      identityLink: { findMany: async () => [{ canonicalId: "root-b" }] },
      organizationCanonicalMapping: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          "canonicalCompanyId" in where
            ? [{ sourceCompanyId: "alias-a", canonicalCompanyId: "root-b" }]
            : [],
      },
      lead: {
        findMany: async () => [
          { id: "lead-a", canonicalCompanyId: "alias-a", fitVerdict: "match" },
        ],
      },
      canonicalCompany: { findMany: findCompanies },
      fieldEvidence: { findMany: async () => [] },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: async (
          _workspaceId: string,
          callback: (client: typeof tx) => unknown,
        ) => callback(tx),
      },
      providers: {},
      gateway: {},
    } as never);

    await expect(
      activities.qualifyFitForRun({
        workspaceId: "ws-1",
        runId: "run-fit-alias-skip",
        icpId: "icp-x",
      }),
    ).resolves.toEqual({
      judged: 0,
      failed: 0,
      verdicts: { match: 0, weak: 0, mismatch: 0 },
      skippedForBudget: 0,
    });
    expect(findCompanies).not.toHaveBeenCalled();
    expect(judgeFitCompany).not.toHaveBeenCalled();
  });

  it("merge 后 root 再 fit 时复用 alias 的唯一未判 Lead，不创建 root Lead", async () => {
    vi.mocked(judgeFitCompany).mockResolvedValueOnce({
      verdict: "match",
      fitReasons: {
        material: "pass",
        role: "pass",
        process: "pass",
        business_model: "pass",
        reasons: ["grounded"],
      },
    });
    const leadUpdate = vi.fn(async () => ({}));
    const leadUpsert = vi.fn(async () => ({}));
    const companies = new Map([
      [
        "root-b",
        {
          id: "root-b",
          name: "Root B",
          domain: "root.example",
          country: "DE",
          industry: null,
          attributes: {},
          status: "NEW",
        },
      ],
      [
        "alias-a",
        {
          id: "alias-a",
          name: "Alias A",
          domain: "alias.example",
          country: "DE",
          industry: null,
          attributes: {},
          status: "NEW",
        },
      ],
    ]);
    const tx = {
      $queryRaw: async () => [],
      $executeRaw: async () => 1,
      icpDefinition: { findUnique: async () => null },
      rawSourceRecord: { findMany: async () => [{ id: "raw-root" }] },
      identityLink: { findMany: async () => [{ canonicalId: "root-b" }] },
      organizationCanonicalMapping: {
        findFirst: async () => null,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          "canonicalCompanyId" in where
            ? [{ sourceCompanyId: "alias-a", canonicalCompanyId: "root-b" }]
            : [],
      },
      organizationIdentityConflictParty: { count: async () => 0 },
      lead: {
        findMany: async () => [
          { id: "lead-a", canonicalCompanyId: "alias-a", fitVerdict: null },
        ],
        update: leadUpdate,
        upsert: leadUpsert,
      },
      canonicalCompany: {
        findMany: async ({
          where,
        }: { where?: { id?: { in?: string[] } } } = {}) => {
          const ids = where?.id?.in;
          return ids
            ? ids.map((id) => companies.get(id)).filter(Boolean)
            : [companies.get("root-b")];
        },
        findUnique: async ({ where }: { where: { id: string } }) =>
          companies.get(where.id) ?? null,
        updateMany: async () => ({ count: 0 }),
      },
      suppressionRecord: { findMany: async () => [] },
      fieldEvidence: { findMany: async () => [] },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: async <T>(
          _workspaceId: string,
          callback: (client: typeof tx) => Promise<T>,
        ): Promise<T> => callback(tx),
        sourcePolicy: { findMany: async () => [] },
      },
      providers: {},
      gateway: {},
    } as never);

    await expect(
      activities.qualifyFitForRun({
        workspaceId: "ws-1",
        runId: "run-fit-alias-update",
        icpId: "icp-x",
      }),
    ).resolves.toMatchObject({ judged: 1, failed: 0, verdicts: { match: 1 } });
    expect(leadUpdate).toHaveBeenCalledWith({
      where: { id: "lead-a" },
      data: expect.objectContaining({ fitVerdict: "match" }),
    });
    expect(leadUpsert).not.toHaveBeenCalled();
  });

  it("identity group 已有多条同 ICP Lead 时 fail closed，不调用模型", async () => {
    vi.mocked(judgeFitCompany).mockClear();
    const tx = {
      icpDefinition: { findUnique: async () => null },
      rawSourceRecord: { findMany: async () => [{ id: "raw-root" }] },
      identityLink: { findMany: async () => [{ canonicalId: "root-b" }] },
      organizationCanonicalMapping: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          "canonicalCompanyId" in where
            ? [{ sourceCompanyId: "alias-a", canonicalCompanyId: "root-b" }]
            : [],
      },
      lead: {
        findMany: async () => [
          { id: "lead-a", canonicalCompanyId: "alias-a", fitVerdict: null },
          { id: "lead-b", canonicalCompanyId: "root-b", fitVerdict: null },
        ],
      },
    };
    const activities = createDiscoveryActivities({
      prisma: {
        withWorkspace: async (
          _workspaceId: string,
          callback: (client: typeof tx) => unknown,
        ) => callback(tx),
      },
      providers: {},
      gateway: {},
    } as never);

    await expect(
      activities.qualifyFitForRun({
        workspaceId: "ws-1",
        runId: "run-fit-duplicate",
        icpId: "icp-x",
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_GROUP_LEAD_CONFLICT" });
    expect(judgeFitCompany).not.toHaveBeenCalled();
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
  it("Raw 数据被隔离或拒绝 → PARTIAL，不冒充完整成功", () => {
    expect(
      resolveRunStatus({
        failures: 0,
        totalQueries: 3,
        budgetTruncated: false,
        dataQualityBlocked: true,
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
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    const acts = createDiscoveryActivities(deps);
    const res = await acts.enqueuePatentLookupsForRun({
      workspaceId: "ws",
      runId: "run",
      icpId: "icp",
    });
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
    } as unknown as Parameters<typeof createDiscoveryActivities>[0];
    const acts = createDiscoveryActivities(deps);
    const res = await acts.enqueuePatentLookupsForRun({
      workspaceId: "ws",
      runId: "run",
      icpId: "icp",
    });
    expect(res).toEqual({ candidates: 1, enqueued: 1 });
    expect(upserts).toHaveLength(1);
  });
});
