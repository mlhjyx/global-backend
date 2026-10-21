import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetLedger, InMemoryBudgetStoreAdapter } from "@global/test-support";
import { requestPublicHttp } from "../adapters/guarded-http";
import type { DomainAckRecord } from "../durable-results/domain-ack";
import type { DurableExecutionReceipt } from "../durable-results/durable-execution-receipt";
import type { EnrichmentResult } from "../discovery/provider";
import type { ExecutionContext } from "../tools/tool-broker";
import type { BudgetStore } from "../tools/budget-store";
import { createDiscoveryActivities } from "./discovery.activities";

/**
 * Signal enrichment across an activity retry, with the real domain ACK binding helpers and only
 * the Postgres row store replaced: an ACK row written by attempt 1 is REPLAYED on attempt 2, and a
 * company transaction that throws takes its ACK rows with it. Run c6b09756 (xin, 2026-10-20) failed
 * exactly this way: attempt 1 died on one site's TLS reset, and attempt 2 found a company whose
 * receipts were half old, half new.
 */
const ackStore = vi.hoisted(() => ({
  rows: new Set<string>(),
  log: [] as Array<{ operationId: string; status: "APPLIED" | "REPLAYED" }>,
}));

vi.mock("@temporalio/activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@temporalio/activity")>()),
  heartbeat: vi.fn(),
}));

vi.mock("../durable-results/domain-ack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../durable-results/domain-ack")>();
  class InMemoryDomainAckRepository {
    constructor(private readonly transaction: unknown) {}

    async apply<T>(record: DomainAckRecord, apply: (transaction: unknown) => Promise<T>) {
      const key = [
        record.operationId,
        record.consumer,
        record.domainAggregateType,
        record.domainAckKey,
        record.domainRevision,
      ].join("|");
      if (ackStore.rows.has(key)) {
        ackStore.log.push({ operationId: record.operationId, status: "REPLAYED" });
        return Object.freeze({ status: "REPLAYED" as const, ack: record, value: undefined });
      }
      ackStore.rows.add(key);
      ackStore.log.push({ operationId: record.operationId, status: "APPLIED" });
      const value = await apply(this.transaction);
      return Object.freeze({ status: "APPLIED" as const, ack: record, value });
    }
  }
  return { ...actual, PostgresDomainAckRepository: InMemoryDomainAckRepository };
});

const BINDING = Object.freeze({
  authorityId: "20000000-0000-4000-8000-000000000002",
  replay: false,
  scopeKey: "10000000-0000-4000-8000-000000000001",
  accountKey: `discovery.run:discovery_run:request:${"b".repeat(64)}:${"b".repeat(64)}`,
  purpose: "discovery.run" as const,
  subjectType: "discovery_run",
  subjectId: `request:${"b".repeat(64)}`,
  requestSha256: "b".repeat(64),
});

const ARGS = {
  workspaceId: BINDING.scopeKey,
  runId: "70000000-0000-4000-8000-000000000001",
  planId: "50000000-0000-4000-8000-000000000001",
  icpId: "icp-1",
  executionContractVersion: 2 as const,
  executionBudget: BINDING,
};

const ledger = new BudgetLedger();

function budgetStore(): BudgetStore {
  const store = new InMemoryBudgetStoreAdapter(ledger);
  if (!Number.isFinite(ledger.remainingCents(BINDING.accountKey))) {
    ledger.open(BINDING.accountKey, 100);
  }
  store.attestAuthorized = vi.fn(async (input) => ({
    accountId: "40000000-0000-4000-8000-000000000004",
    authorityId: input.authorityId,
    authorizedCapMicrousd: 1_000_000n,
    generation: 1,
  }));
  return store;
}

function receipt(n: number, producer: "http.get" | "crawl4ai.render"): DurableExecutionReceipt {
  const suffix = String(n).padStart(12, "0");
  return Object.freeze({
    schemaVersion: "durable-execution-receipt/v1",
    scopeKey: BINDING.scopeKey,
    authorityId: BINDING.authorityId,
    accountId: "30000000-0000-4000-8000-000000000001",
    operationId: `40000000-0000-4000-8000-${suffix}`,
    operationKey: `signal-operation-${n}`,
    resultStrategy: "artifact_reference",
    resultSchema: producer === "http.get" ? "http-get/v1" : "crawl4ai-render/v1",
    resultDigest: createHash("sha256").update(String(n)).digest("hex"),
    artifactId: `60000000-0000-4000-8000-${suffix}`,
    usage: { currency: "USD", unit: "microusd", callCount: 1, upperBoundMicrousd: "10000" },
    costBasis: "estimated_upper_bound",
    status: "SETTLED",
  }) as DurableExecutionReceipt;
}

/** A read that settled: the broker hands its receipt to the activity, as a replay does too. */
function read(ctx: ExecutionContext, n: number, producer: "http.get" | "crawl4ai.render" = "http.get"): void {
  ctx.onDurableReceipt?.(producer, receipt(n, producer));
}

const MISS = { matched: false, confidence: 0, attributes: {}, costCents: 0 } as EnrichmentResult;
const harvestHit = { matched: true, confidence: 0.9, attributes: { sitemap_url_count: 12 }, costCents: 0 } as unknown as EnrichmentResult;
const footprintHit = { matched: true, confidence: 0.9, attributes: { tech_platform: "shopify" }, costCents: 0 } as unknown as EnrichmentResult;

/** What crawl4ai or any non-guarded path throws: shaped like a socket error, so it fails closed. */
function unmarkedSocketError(): Error {
  return Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", host: "c2.de", port: 443 });
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** A real error from the guarded transport: a site that resets the TLS handshake. */
async function siteResetError(): Promise<unknown> {
  const server = createServer((socket) => socket.destroy());
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return requestPublicHttp(`https://c1.de:${address.port}/sitemap.xml`, { timeoutMs: 5_000 }, {
    resolver: async (raw) => ({ url: new URL(raw), ip: "127.0.0.1", family: 4, addresses: [{ address: "127.0.0.1", family: 4 }] }),
  }).then(() => { throw new Error("expected the reset"); }, (error: unknown) => error);
}

interface CompanyRow {
  id: string;
  name: string;
  domain: string;
  country: string;
  region: null;
  status: string;
  attributes: Record<string, unknown>;
}

/** One workspace's companies and transactions; a transaction that throws rolls back rows and ACKs. */
function world(ids: string[], enrichers: unknown[]) {
  ackStore.rows.clear();
  ackStore.log.length = 0;
  const companies = new Map<string, CompanyRow>(
    ids.map((id) => [id, { id, name: id.toUpperCase(), domain: `${id}.de`, country: "DE", region: null, status: "NEW", attributes: {} }]),
  );
  const copy = (row: CompanyRow): CompanyRow => ({ ...row, attributes: structuredClone(row.attributes) });
  const listCompanies = vi.fn(async () => [...companies.values()].map(copy));
  const tx = {
    $queryRaw: async () => [{ locked: true }],
    rawSourceRecord: { findMany: async () => [{ id: "raw1" }] },
    identityLink: { findMany: async () => ids.map((canonicalId) => ({ canonicalId })) },
    canonicalCompany: {
      findMany: listCompanies,
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = companies.get(where.id);
        return row ? copy(row) : null;
      },
      updateMany: async ({ where, data }: { where: { id: string }; data: { attributes?: Record<string, unknown> } }) => {
        const row = companies.get(where.id);
        if (!row) return { count: 0 };
        if (data.attributes) row.attributes = structuredClone(data.attributes);
        return { count: 1 };
      },
      update: async () => ({}),
    },
    suppressionRecord: { findMany: async () => [] },
    fieldEvidence: { create: async () => ({}) },
  };
  const prisma = {
    sourcePolicy: { findMany: async () => [] as { domain: string }[] },
    withWorkspace: async <T>(_workspaceId: string, fn: (transaction: unknown) => Promise<T>): Promise<T> => {
      const rows = new Set(ackStore.rows);
      const snapshot = [...companies.values()].map(copy);
      try {
        return await fn(tx);
      } catch (error) {
        ackStore.rows.clear();
        rows.forEach((row) => ackStore.rows.add(row));
        snapshot.forEach((row) => companies.set(row.id, row));
        throw error;
      }
    },
  };
  const activities = createDiscoveryActivities({
    prisma,
    providers: { routeEnrichment: async () => enrichers, routeSignalEnrichment: async () => enrichers },
    gateway: {},
    budgetStore: budgetStore(),
  } as unknown as Parameters<typeof createDiscoveryActivities>[0]);
  return { activities, companies, listCompanies };
}

describe("enrichSignalsRun across an activity retry", () => {
  it("acknowledges a missed company whose second attempt reads one page more than its first", async () => {
    let attempt = 1;
    const harvest = {
      key: "structured_harvest",
      enrichCompany: vi.fn(async (company: { name: string }, ctx: ExecutionContext) => {
        if (company.name === "C1") {
          read(ctx, 1);
          if (attempt === 2) read(ctx, 2); // the robots precheck let one more read through
          return MISS;
        }
        if (attempt === 1) throw unmarkedSocketError();
        read(ctx, 3);
        return MISS;
      }),
    };
    const { activities } = world(["c1", "c2"], [harvest]);

    await expect(activities.enrichSignalsRun(ARGS)).rejects.toMatchObject({ code: "ECONNRESET" });
    attempt = 2;
    const result = await activities.enrichSignalsRun(ARGS);

    expect(result).toEqual({
      enriched: 2,
      matched: 0,
      provider: null,
      budgetTruncated: false,
      skippedSubjects: 0,
      unreplayable: 0,
    });
  });

  it("commits a hit on retry even though the same enricher's earlier reads were acknowledged as a miss", async () => {
    let attempt = 1;
    const harvest = {
      key: "structured_harvest",
      enrichCompany: vi.fn(async (company: { name: string }, ctx: ExecutionContext) => {
        if (company.name === "C1") {
          read(ctx, 1);
          if (attempt === 1) return MISS;
          read(ctx, 2);
          return harvestHit;
        }
        if (attempt === 1) throw unmarkedSocketError();
        return MISS;
      }),
    };
    const { activities, companies } = world(["c1", "c2"], [harvest]);

    await expect(activities.enrichSignalsRun(ARGS)).rejects.toMatchObject({ code: "ECONNRESET" });
    attempt = 2;
    const result = await activities.enrichSignalsRun(ARGS);

    expect(result).toMatchObject({ matched: 1, provider: "structured_harvest" });
    expect(companies.get("c1")?.attributes.structured_harvest).toMatchObject({ sitemap_url_count: 12 });
  });

  it("acknowledges an operation once per write when two reads of one company return it", async () => {
    const footprint = {
      key: "digital_footprint",
      enrichCompany: vi.fn(async (_company: unknown, ctx: ExecutionContext) => {
        read(ctx, 1, "crawl4ai.render");
        return footprintHit;
      }),
    };
    const harvest = {
      key: "structured_harvest",
      enrichCompany: vi.fn(async (_company: unknown, ctx: ExecutionContext) => {
        read(ctx, 1, "crawl4ai.render"); // the careers page is the home page footprint rendered
        read(ctx, 2);
        read(ctx, 2); // two sitemap roots list the same child
        return harvestHit;
      }),
    };
    const { activities, companies } = world(["c1"], [footprint, harvest]);

    const result = await activities.enrichSignalsRun(ARGS);

    expect(result).toMatchObject({ matched: 1, provider: "digital_footprint+structured_harvest" });
    expect(companies.get("c1")?.attributes).toMatchObject({
      digital_footprint: { tech_platform: "shopify" },
      structured_harvest: { sitemap_url_count: 12 },
    });
    expect(ackStore.log.every(({ status }) => status === "APPLIED")).toBe(true);
  });

  it("acknowledges every receipt of a company it skips, and replays them cleanly on retry", async () => {
    let attempt = 1;
    const harvest = {
      key: "structured_harvest",
      enrichCompany: vi.fn(async (company: { name: string }, ctx: ExecutionContext) => {
        if (company.name === "C2" && attempt === 1) throw unmarkedSocketError();
        read(ctx, company.name === "C1" ? 1 : 2);
        return MISS;
      }),
    };
    const { activities } = world(["c1", "c2"], [harvest]);

    await expect(activities.enrichSignalsRun(ARGS)).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(ackStore.log).toEqual([{ operationId: receipt(1, "http.get").operationId, status: "APPLIED" }]);
    attempt = 2;
    await activities.enrichSignalsRun(ARGS);

    expect(ackStore.log.slice(1)).toEqual([
      { operationId: receipt(1, "http.get").operationId, status: "REPLAYED" },
      { operationId: receipt(2, "http.get").operationId, status: "APPLIED" },
    ]);
  });

  it("visits companies in id order, so a retry meets them in the same order", async () => {
    const { activities, listCompanies } = world(["c1"], [{ key: "structured_harvest", enrichCompany: async () => MISS }]);

    await activities.enrichSignalsRun(ARGS);

    expect(listCompanies).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { id: "asc" } }));
  });
});

describe("enrichSignalsRun when one site drops the connection", () => {
  it("counts that company's lost enricher, keeps its other enrichers and goes on to the next company", async () => {
    const reset = await siteResetError();
    const harvest = {
      key: "structured_harvest",
      enrichCompany: vi.fn(async (company: { name: string }, ctx: ExecutionContext) => {
        if (company.name === "C1") {
          read(ctx, 1);
          throw reset;
        }
        read(ctx, 2);
        return harvestHit;
      }),
    };
    const footprint = {
      key: "digital_footprint",
      enrichCompany: vi.fn(async (company: { name: string }, ctx: ExecutionContext) => {
        read(ctx, company.name === "C1" ? 3 : 4, "crawl4ai.render");
        return footprintHit;
      }),
    };
    const { activities, companies } = world(["c1", "c2"], [harvest, footprint]);

    const result = await activities.enrichSignalsRun(ARGS);

    expect(result).toMatchObject({ enriched: 2, matched: 2, transportFailed: 1, unreplayable: 0 });
    expect(footprint.enrichCompany).toHaveBeenCalledTimes(2);
    expect(companies.get("c1")?.attributes).toHaveProperty("digital_footprint");
    expect(companies.get("c1")?.attributes).not.toHaveProperty("structured_harvest");
    expect(ackStore.log).toContainEqual({ operationId: receipt(1, "http.get").operationId, status: "APPLIED" });
  });

  it("still stops on an error that only looks like a socket failure", async () => {
    const harvest = {
      key: "structured_harvest",
      enrichCompany: vi.fn(async () => {
        throw unmarkedSocketError();
      }),
    };
    const { activities } = world(["c1"], [harvest]);

    await expect(activities.enrichSignalsRun(ARGS)).rejects.toMatchObject({ code: "ECONNRESET" });
  });

  it("leaves transportFailed out of a pass where no site dropped the connection", async () => {
    const { activities } = world(["c1"], [{ key: "structured_harvest", enrichCompany: async () => MISS }]);

    const result = await activities.enrichSignalsRun(ARGS);

    expect(result).not.toHaveProperty("transportFailed");
  });
});
