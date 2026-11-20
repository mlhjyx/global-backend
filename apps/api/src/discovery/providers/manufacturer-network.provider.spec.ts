import { describe, expect, it, vi } from "vitest";
import { ManufacturerNetworkProvider } from "./manufacturer-network.provider";
import {
  CONFIG,
  POLICY_ROW,
  COMPANY_INPUT,
  NOW,
  TEXT,
  WS,
  COMPANY,
  AUTHORITY,
  ACCOUNT,
  SEARCH,
  FETCH,
  ARTIFACT,
  PAGE_URL,
} from "../manufacturer-network.test-fixture";
import { MANUFACTURER_NETWORK_REVISION } from "../manufacturer-network-execution";
import type { DurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";
const searchReceipt: DurableExecutionReceipt = {
  schemaVersion: "durable-execution-receipt/v1",
  scopeKey: WS,
  authorityId: AUTHORITY,
  accountId: ACCOUNT,
  operationId: SEARCH,
  operationKey: "search",
  resultStrategy: "typed_projection",
  resultSchema: "searxng-search/v1",
  resultDigest: "a".repeat(64),
  artifactId: null,
  usage: {
    currency: "USD",
    unit: "microusd",
    callCount: 1,
    upperBoundMicrousd: "0",
  },
  costBasis: "estimated_upper_bound",
  status: "SETTLED",
};
const fetchReceipt: DurableExecutionReceipt = {
  ...searchReceipt,
  operationId: FETCH,
  operationKey: "fetch",
  resultStrategy: "artifact_reference",
  resultSchema: "crawl4ai-fetch/v1",
  artifactId: ARTIFACT,
};
const ctx = {
  admitManufacturerProbe: async () => true,
  workspaceId: WS,
  runId: "run",
  manufacturerNetworkRevision: MANUFACTURER_NETWORK_REVISION,
  artifactSubject: { subjectType: "company" as const, subjectId: COMPANY },
  durableBudgetAuthority: { authorityId: AUTHORITY, accountId: ACCOUNT },
};
function harness(
  opts: {
    configuration?: unknown;
    status?: string;
    policy?: unknown;
    search?: unknown;
    fetch?: unknown;
    nextConfig?: unknown;
  } = {},
) {
  const invoke = vi.fn(async (id: string) =>
    id === "searxng.search"
      ? (opts.search ?? {
          data: {
            results: [
              { url: PAGE_URL, title: "search summaries are not facts" },
            ],
          },
          costCents: 0,
          durableReceipt: searchReceipt,
        })
      : (opts.fetch ?? {
          data: { url: PAGE_URL, text: TEXT, contentHash: "b".repeat(24) },
          costCents: 1,
          durableReceipt: fetchReceipt,
          provenance: {
            sourceUrl: PAGE_URL,
            fetchedAt: NOW.toISOString(),
            artifactExpiresAt: "2026-11-21T09:59:59.000Z",
            contentHash: "b".repeat(24),
            parserVersion: "artifact/crawl4ai-fetch/v1",
          },
        }),
  );
  let calls = 0;
  const loadConfiguration = vi.fn(async () => ({
    status: opts.status ?? "ENABLED",
    config:
      ++calls > 1 && opts.nextConfig !== undefined
        ? opts.nextConfig
        : (opts.configuration ?? CONFIG),
    policies: [opts.policy ?? POLICY_ROW],
  }));
  const provider = new ManufacturerNetworkProvider({
    broker: { invoke } as never,
    readArtifactSubject: async () => true,
    loadConfiguration: loadConfiguration as never,
    now: () => NOW,
  });
  return { provider, invoke };
}
describe("manufacturer deterministic adapter", () => {
  it("uses existing tools once each without an AI task identity and keeps original capture", async () => {
    const h = harness();
    const result = await h.provider.enrichCompany(COMPANY_INPUT, ctx);
    expect(result).toMatchObject({
      matched: true,
      manufacturerEvidence: {
        fetchedAt: NOW.toISOString(),
        expiresAt: "2026-11-21T09:59:59.000Z",
        sourceUrl: PAGE_URL,
      },
    });
    expect(h.invoke.mock.calls.map((c) => c[0])).toEqual([
      "searxng.search",
      "crawl4ai.fetch",
    ]);
    expect(h.invoke.mock.calls[0]![1]).toMatchObject({
      q: expect.stringContaining("acme.example"),
      pages: 1,
    });
    expect(h.invoke.mock.calls[1]![1]).toMatchObject({
      url: PAGE_URL,
      exactHtml: true,
      maxChars: 60000,
    });
    expect(h.invoke.mock.calls[0]![2]).not.toHaveProperty("taskContractId");
  });
  it.each([
    { ...ctx, manufacturerNetworkRevision: undefined },
    { ...ctx, artifactSubject: undefined },
    { ...ctx, artifactSubject: { subjectType: "company", subjectId: WS } },
  ])(
    "does no lookup without revision, subject or independent target attestation",
    async (c) => {
      const h = harness();
      expect(
        (await h.provider.enrichCompany(COMPANY_INPUT, c as never)).matched,
      ).toBe(false);
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );
  it.each([
    { status: "DISABLED" },
    { configuration: {} },
    { configuration: { ...CONFIG, independenceAttestations: [] } },
    {
      configuration: {
        ...CONFIG,
        sources: [
          { ...CONFIG.sources[0], expiresAt: "2026-11-19T00:00:00.000Z" },
        ],
      },
    },
    {
      configuration: {
        ...CONFIG,
        sources: [
          {
            ...CONFIG.sources[0],
            knownCorporateDomains: ["manufacturer.example", "acme.example"],
          },
        ],
      },
    },
  ])(
    "does not authorize from disabled/missing/expired/self-controlled config",
    async (opts) => {
      const h = harness(opts);
      expect((await h.provider.enrichCompany(COMPANY_INPUT, ctx)).matched).toBe(
        false,
      );
      expect(h.invoke).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...POLICY_ROW, reviewStatus: "SUSPENDED" },
    { ...POLICY_ROW, allowedPaths: ["/other"] },
    { ...POLICY_ROW, allowedPurpose: ["discovery"] },
  ])(
    "does not fetch a source outside current path/purpose policy",
    async (policy) => {
      const h = harness({ policy });
      expect((await h.provider.enrichCompany(COMPANY_INPUT, ctx)).matched).toBe(
        false,
      );
      expect(h.invoke).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { ...searchReceipt, resultSchema: "wikidata-entity/v1" },
    { ...searchReceipt, scopeKey: COMPANY },
    { ...searchReceipt, authorityId: COMPANY },
    { ...searchReceipt, accountId: COMPANY },
    {
      ...searchReceipt,
      resultStrategy: "artifact_reference",
      artifactId: ARTIFACT,
    },
  ])(
    "rejects wrong search receipt schema/scope/authority/account/strategy",
    async (durableReceipt) => {
      const h = harness({
        search: {
          data: { results: [{ url: PAGE_URL }] },
          costCents: 0,
          durableReceipt,
        },
      });
      await expect(
        h.provider.enrichCompany(COMPANY_INPUT, ctx),
      ).rejects.toThrow();
      expect(h.invoke).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses missing durable references", async () => {
    const h = harness({
      search: { data: { results: [{ url: PAGE_URL }] }, costCents: 0 },
    });
    await expect(h.provider.enrichCompany(COMPANY_INPUT, ctx)).rejects.toThrow(
      "DURABLE_EXECUTION_RECEIPT_MISSING",
    );
  });
  it("does not turn a search title/snippet into relationship evidence", async () => {
    const h = harness({
      fetch: {
        data: {
          url: PAGE_URL,
          text: "# Acme Pumps GmbH\nGermany\nhttps://acme.example/",
          contentHash: "b".repeat(24),
        },
        costCents: 1,
        durableReceipt: fetchReceipt,
        provenance: {
          sourceUrl: PAGE_URL,
          fetchedAt: NOW.toISOString(),
          artifactExpiresAt: "2026-11-21T09:59:59.000Z",
          contentHash: "b".repeat(24),
          parserVersion: "artifact/crawl4ai-fetch/v1",
        },
      },
    });
    expect((await h.provider.enrichCompany(COMPANY_INPUT, ctx)).matched).toBe(
      false,
    );
  });
  it("rechecks revocation after fetching", async () => {
    const h = harness({
      nextConfig: { ...CONFIG, independenceAttestations: [] },
    });
    expect((await h.provider.enrichCompany(COMPANY_INPUT, ctx)).matched).toBe(
      false,
    );
  });
  it("keeps no unreceipted fallback when the broker is absent", async () => {
    expect(
      (
        await new ManufacturerNetworkProvider({}).enrichCompany(
          COMPANY_INPUT,
          ctx,
        )
      ).matched,
    ).toBe(false);
  });
});
