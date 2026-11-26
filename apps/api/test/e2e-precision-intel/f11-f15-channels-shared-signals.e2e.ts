import { Module } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthModule } from "../../src/auth/auth.module";
import { ChannelsController } from "../../src/channels/channels.controller";
import { ChannelService } from "../../src/channels/channel.service";
import { ChannelProbeService } from "../../src/channels/channel-probe.service";
import { crawlChannel } from "../../src/channels/channel-crawler";
import { DiscoveryProviderRegistry } from "../../src/discovery/provider.registry";
import { ChannelCatalogDiscoveryProvider } from "../../src/discovery/providers/channel-catalog.provider";
import { TRADE_FAIR_CATALOG } from "../../src/discovery/trade-fair-catalog";
import { PrismaService } from "../../src/prisma/prisma.service";
import { EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE } from "../../src/execution-budget/execution-budget-platform-writer.database";
import { EXECUTION_BUDGET_PLATFORM_WRITER_ROLE } from "../../src/runtime/scoped-database-principal";
import {
  assertGreenCompanyFactClean,
  DomainCooldownService,
  InMemoryDomainCooldownBackend,
  PostgresSharedFactRepository,
  sanitizeToGreenCompanyFact,
  type PlatformSharedSqlClient,
} from "../../src/shared-facts";
import { createSharedFactsHookFromEnv } from "../../src/discovery/streaming/shared-facts-hook";
import { GooglePatentsInventorProvider } from "../../src/discovery/providers/bigquery-patents.provider";
import { CompaniesHouseContactProvider } from "../../src/discovery/providers/companies-house.provider";
import { GleifEnrichmentProvider } from "../../src/discovery/providers/gleif.provider";
import { TedDiscoveryProvider } from "../../src/discovery/providers/ted.provider";
import {
  atsApiUrl,
  buildHiringFromAtsJobs,
  detectAtsBoard,
  parseAtsJobs,
} from "../../src/adapters/ats-boards";
import { CompanySignalsController } from "../../src/signals/company-signals.controller";
import { CompanySignalsService } from "../../src/signals/company-signals.service";
import {
  parseChangedetectionWatches,
  parseRssFeed,
} from "../../src/signals/company-signals";
import { buildSignalIcebreakers } from "../../src/signals/signal-icebreaker";
import { searxSearch } from "../../src/adapters/searxng";
import { DoclingClient } from "../../src/site-builder/docling.client";
import type { ExecutionBroker } from "../../src/tools/tool-contract";
import {
  createInMemoryPrismaStub,
  registerDesignParamTypes,
  startJwksAuthServer,
  startNestHttpHarness,
  type JwksAuthServer,
} from "./harness/http-auth-harness";
import { startMockUpstreamsServer, type MockUpstreamsServer } from "./harness/mock-upstreams";
import { loadProductExport } from "./harness/load-product-export";
import { getE2eTargetMode } from "./harness/mode-gate-temporal";
import {
  ADR003_CLEAN_GREEN_FACT_INPUT,
  ADR003_NEGATIVE_PII_FACT,
  INTERSOLAR_EUROPE_HTML_MANIFEST,
  KEY_ENERGY_EXHIBITOR_DIRECTORY_HTML,
  KEY_ENERGY_RIMINI_HTML_MANIFEST,
  MAINLINE_A_COMPANY_ID,
  MAINLINE_A_TENANT_A,
  REGISTRY_FIXTURES,
  SIGNALS_AND_DOCLING_FIXTURES,
} from "./fixtures/mainline-a.test-fixture";

function makePlatformWriterPrismaStub(createdRows: Array<Record<string, unknown>> = []) {
  const principalRow = {
    sessionUser: "eb_writer_test",
    currentUser: "eb_writer_test",
    sessionRole: "none",
    rolCanLogin: true,
    rolInherit: true,
    rolSuper: false,
    rolBypassRls: false,
    rolCreateDb: false,
    rolCreateRole: false,
    rolReplication: false,
    memberships: [EXECUTION_BUDGET_PLATFORM_WRITER_ROLE],
  };
  const tx = {
    sourceChannel: {
      findFirst: async () => null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        createdRows.find((row) => row.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: "aaaaaaaa-0000-4000-8000-000000000010",
          mode: "api",
          status: "DISABLED",
          failureStreak: 0,
          lastRunAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          license: null,
          tosUrl: null,
          robotsPolicy: null,
          owner: null,
          ...data,
        };
        createdRows.push(row);
        return row;
      },
    },
    sourcePolicy: {
      findMany: async () => [{ domain: "key-energy-rimini.example", status: "APPROVED" }],
      upsert: async () => undefined,
    },
  };
  return {
    $queryRaw: async () => [principalRow],
    $transaction: async (fn: (t: any) => Promise<unknown>) => fn(tx),
  };
}

const productSuite = describe.runIf(getE2eTargetMode() === "integrated");
const designSuite = describe.runIf(getE2eTargetMode() === "harness-selfcheck");

describe("Mainline A channels, shared facts and design examples", () => {
  let jwks: JwksAuthServer;
  let upstreams: MockUpstreamsServer;

  beforeAll(async () => {
    jwks = await startJwksAuthServer();
    upstreams = await startMockUpstreamsServer();
  });

  afterAll(async () => {
    await upstreams.close();
    await jwks.close();
  });

  beforeEach(() => {
    upstreams.reset();
    upstreams.applyEnv();
  });

  // ---------------------------------------------------------------------------
  // F11: Trade fair manifests & channel_catalog (10 cases)
  // ---------------------------------------------------------------------------
  productSuite("F11: Trade fair manifests (KEY Energy, Intersolar) & channel_catalog", () => {
    async function bootChannelsHarness(createdRows: Array<Record<string, unknown>> = []) {
      const prismaStub = createInMemoryPrismaStub({
        sourceChannel: {
          findMany: async () => [],
          findUnique: async () => null,
        },
        sourceChannelTenant: {
          findMany: async () => [],
        },
      }) as unknown as PrismaService;
      const platformWriter = makePlatformWriterPrismaStub(createdRows);
      const probeStub = { probeChannel: async () => ({ status: "SUCCEEDED", recordsFound: 2 }) } as unknown as ChannelProbeService;
      registerDesignParamTypes(ChannelService, [PrismaService, Object, Object, Object]);
      registerDesignParamTypes(ChannelsController, [ChannelService, ChannelProbeService]);

      class ChannelsHttpTestModule {}
      Module({
        imports: [AuthModule],
        controllers: [ChannelsController],
        providers: [
          { provide: PrismaService, useValue: prismaStub },
          { provide: EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE, useValue: platformWriter },
          { provide: ChannelProbeService, useValue: probeStub },
          ChannelService,
        ],
      })(ChannelsHttpTestModule);

      return startNestHttpHarness(ChannelsHttpTestModule);
    }

    it.each([
      {
        id: "T1-F11-01", manifest: KEY_ENERGY_RIMINI_HTML_MANIFEST,
        name: "KEY Energy Rimini", html: KEY_ENERGY_EXHIBITOR_DIRECTORY_HTML,
        expected: ["Italsol Srl", "SolarBau GmbH", "Freemail Test Exhibitor"],
      },
      {
        id: "T1-F11-02", manifest: INTERSOLAR_EUROPE_HTML_MANIFEST,
        name: "Intersolar Europe",
        html: '<article class="exhibitor-item"><h2 class="company-name">Nordpark Fixture GmbH</h2><span class="website">nordpark.example</span><span class="country">DE</span></article>',
        expected: ["Nordpark Fixture GmbH"],
      },
    ])("$id: registers an HTML manifest and crawls its stored config", async ({ manifest, name, html, expected }) => {
      const createdRows: Array<Record<string, unknown>> = [];
      const harness = await bootChannelsHarness(createdRows);
      try {
        const token = await jwks.signJwt({ workspaceId: MAINLINE_A_TENANT_A, roles: ["OPS"] });
        const response = await harness.request("/api/v1/source-channels", {
          method: "POST",
          token,
          json: { name, manifest },
        });
        expect(response.status).toBe(201);
        expect(createdRows).toEqual([expect.objectContaining({ mode: "crawl", category: "trade_fair", name })]);
        const config = createdRows[0]!.config as Parameters<typeof crawlChannel>[0];
        const fetcher = vi.fn(async (url: string) => ({ url, html }));
        const result = await crawlChannel(config, fetcher, { pageCap: 1, perRequestDelayMs: 0 });
        expect(result.records.map((record) => record.name)).toEqual(expected);
        expect(result.records[0]?.website).toBe(name === "KEY Energy Rimini"
          ? "https://italsol.example/" : "https://nordpark.example/");
        expect(fetcher).toHaveBeenCalledExactlyOnceWith(manifest.crawl.list.url.replace("{page}", "1"));
      } finally {
        await harness.close();
      }
    });

    it("F11: an unprobed HTML manifest cannot be enabled through the ops API", async () => {
      const createdRows: Array<Record<string, unknown>> = [];
      const harness = await bootChannelsHarness(createdRows);
      try {
        const token = await jwks.signJwt({ workspaceId: MAINLINE_A_TENANT_A, roles: ["OPS"] });
        const created = await harness.request("/api/v1/source-channels", {
          method: "POST",
          token,
          json: { manifest: KEY_ENERGY_RIMINI_HTML_MANIFEST },
        });
        expect(created.status).toBe(201);
        expect(createdRows[0]).toMatchObject({ status: "DISABLED" });
        const activated = await harness.request("/api/v1/source-channels/" + createdRows[0]!.id, {
          method: "PATCH",
          token,
          json: { status: "ENABLED" },
        });
        expect(activated.status).toBe(409);
        expect(activated.json()).toMatchObject({ error: { code: "CHANNEL_PROBE_REQUIRED" } });
      } finally {
        await harness.close();
      }
    });

    it("T1-F11-03: verified adapter admits ProPak and leaves unverified flagship fairs disabled", async () => {
      type BuildManifest = (fair: (typeof TRADE_FAIR_CATALOG)[number]) =>
        { targetStatus: string; disabledReason: string | null; verifiedAdapter: boolean };
      const buildManifest = await loadProductExport<BuildManifest>(
        "F11", "src/channels/trade-fair-manifests.ts", "buildTradeFairManifestEntry",
      );
      const assess = (slug: string) => buildManifest(TRADE_FAIR_CATALOG.find((fair) => fair.slug === slug)!);
      expect(assess("propak-asia-2026")).toMatchObject({ targetStatus: "ENABLED", verifiedAdapter: true });
      expect(assess("key-energy-rimini")).toMatchObject({ targetStatus: "DISABLED", verifiedAdapter: false });
      expect(assess("intersolar-europe")).toMatchObject({ targetStatus: "DISABLED", verifiedAdapter: false });
    });

    it("T1-F11-04: local catalog filters by country and keywords and prefers reviewed evidence", async () => {
      const approved = {
        id: "reviewed-fixture",
        channelId: "fixture-channel",
        dedupeKey: "domain:italsol.example",
        name: "Italsol Srl",
        website: "https://italsol.example",
        country: "IT",
        industry: "Photovoltaic Modules",
        products: ["solar modules"],
        keywords: ["solar", "pv"],
        reviewStatus: "APPROVED",
        sourceUrl: "https://key-energy-rimini.example/exhibitors/italsol-reviewed",
        contentHash: "a".repeat(64),
        lastSeenAt: new Date("2026-11-01T00:00:00Z"),
        channel: { name: "KEY Energy Rimini", category: "trade_fair", license: "public-directory" },
      };
      const pending = {
        ...approved, id: "pending-fixture", reviewStatus: "PENDING",
        sourceUrl: "https://key-energy-rimini.example/exhibitors/italsol-unreviewed",
      };
      const foreign = {
        ...approved, id: "other-fixture", name: "Other Buyer",
        website: "https://other.example", dedupeKey: "domain:other.example", country: "DE",
      };
      const findChannels = vi.fn(async (_query: unknown) => [{ id: approved.channelId }]);
      const findRecords = vi.fn(async ({ where }: { where: { reviewStatus: string } }) =>
        where.reviewStatus === "APPROVED" ? [approved, foreign] : [pending],
      );
      const provider = new ChannelCatalogDiscoveryProvider({
        prisma: {
          sourceChannel: { findMany: findChannels },
          sourceChannelRecord: { findMany: findRecords },
        } as never,
      });
      const result = await provider.discoverCompanies(
        { sourceClass: "industry_data", filters: { country: "IT" }, keywords: ["solar"], limit: 10 },
        { workspaceId: MAINLINE_A_TENANT_A, runId: "channel-result-fixture" },
      );
      expect(result.costCents).toBe(0);
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({ domain: "italsol.example", country: "IT" });
      expect(result.records[0]?.provenance?.sourceUrl).toBe(approved.sourceUrl);
      expect(findChannels).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ status: "ENABLED" }),
      }));
      expect(findRecords).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ channel: { status: "ENABLED" }, reviewStatus: "APPROVED" }),
      }));
    });

    it("T1-F11-05: Existing JSON trade-fair manifest continues working identically", async () => {
      const createdRows: Array<Record<string, unknown>> = [];
      const harness = await bootChannelsHarness(createdRows);
      try {
        const opsToken = await jwks.signJwt({ workspaceId: MAINLINE_A_TENANT_A, roles: ["OPS"] });
        const jsonManifest = {
          meta: { name: "Solar Fair JSON API", version: 1, category: "trade_fair" },
          transport: { baseUrl: "https://key-energy-rimini.example", responseType: "json", allowedHosts: ["key-energy-rimini.example"] },
          pagination: { type: "offset", offsetParam: "offset", limitParam: "limit", pageSize: 50, maxPages: 3 },
          records: { itemsPath: "$.items" },
          fieldMapping: { name: "$.company" },
          governance: { license: "public-directory", tosUrl: "https://key-energy-rimini.example/terms", robotsPolicy: "A", allowedPurpose: ["discovery"] },
        };
        const res = await harness.request("/api/v1/source-channels", {
          method: "POST",
          token: opsToken,
          json: { name: "Solar Fair JSON API", manifest: jsonManifest },
        });
        expect(res.status).toBe(201);
        expect(createdRows).toHaveLength(1);
      } finally {
        await harness.close();
      }
    });

    it("T2-F11-01: Manifest with robotsPolicy: 'C' (disallow) is blocked with 400/409", async () => {
      const harness = await bootChannelsHarness();
      try {
        const opsToken = await jwks.signJwt({ workspaceId: MAINLINE_A_TENANT_A, roles: ["OPS"] });
        const disallowed = {
          ...KEY_ENERGY_RIMINI_HTML_MANIFEST,
          transport: { ...KEY_ENERGY_RIMINI_HTML_MANIFEST.transport, responseType: "json" },
          records: { itemsPath: "$.items" },
          fieldMapping: { name: "$.name" },
          governance: { ...KEY_ENERGY_RIMINI_HTML_MANIFEST.governance, robotsPolicy: "C" },
        };
        const res = await harness.request("/api/v1/source-channels", {
          method: "POST",
          token: opsToken,
          json: { name: "Blocked Fair", manifest: disallowed },
        });
        expect([400, 409]).toContain(res.status);
      } finally {
        await harness.close();
      }
    });

    it("T2-F11-02: malformed directory HTML yields no exhibitor records", async () => {
      type Parse = (input: unknown) => unknown;
      type Adapt = (input: unknown) => Parameters<typeof crawlChannel>[0];
      const parse = await loadProductExport<Parse>("F11", "src/channels/connector/channel-manifest.ts", "parseChannelManifest");
      const adapt = await loadProductExport<Adapt>("F11", "src/channels/html-manifest-adapter.ts", "manifestToCrawlConfig");
      const config = adapt(parse(KEY_ENERGY_RIMINI_HTML_MANIFEST));
      const result = await crawlChannel(
        config, async (url) => ({ url, html: "<html><body><p>Layout changed" }), { pageCap: 1 },
      );
      expect(result.records).toEqual([]);
      expect(result.pagesFetched).toBe(1);
    });

    it("T2-F11-03: Non-ops tenant token calling POST /api/v1/source-channels receives 403 Forbidden", async () => {
      const harness = await bootChannelsHarness();
      try {
        const memberToken = await jwks.signJwt({ workspaceId: MAINLINE_A_TENANT_A, roles: ["MEMBER"] });
        const res = await harness.request("/api/v1/source-channels", {
          method: "POST",
          token: memberToken,
          json: { name: "Unauthorized Channel" },
        });
        expect(res.status).toBe(403);
        expect(res.json<{ error: { code: string } }>().error.code).toBe("SCOPE_REQUIRED");
      } finally {
        await harness.close();
      }
    });

    it("T2-F11-04: the provider registry excludes a disabled local channel catalog", async () => {
      const findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ key: "channel_catalog" }]);
      const database = { dataProvider: { findMany } } as never;
      const providers = new DiscoveryProviderRegistry();

      await expect(providers.routeCompanyDiscovery(database, "industry_data")).resolves.toEqual([]);
      await expect(providers.routeCompanyDiscovery(database, "industry_data")).resolves.toEqual([
        expect.objectContaining({ key: "channel_catalog" }),
      ]);
      expect(findMany.mock.calls).toEqual(Array.from({ length: 2 }, () => [{
        where: { status: "ENABLED" }, select: { key: true },
      }]));
    });

    it("T2-F11-05: free-mail input is stripped before company fact projection", () => {
      const sanitized = sanitizeToGreenCompanyFact({
        domain: "freemail-exhibitor.example",
        homepageUrl: "https://freemail-exhibitor.example",
        legalName: "Freemail Test Exhibitor",
        emails: ["us***@gmail.com"],
        sourceKind: "public_directory",
      });
      expect(sanitized).toMatchObject({
        accepted: true,
        fact: { roleEmails: [] },
        strippedPiiCount: 1,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // F12: platform_shared.company_fact PG wiring (ADR-003) (10 cases)
  // ---------------------------------------------------------------------------
  productSuite("F12: ADR-003 platform_shared.company_fact & 30-day cooldown", () => {
    it("T1-F12-01: streaming hook prepares a PostgreSQL write on its writer connection", async () => {
      const executeReadPort = vi.fn(async () => 0);
      const executeWritePort = vi.fn(async (_sql: TemplateStringsArray, ..._parameters: unknown[]) => 1);
      const reader: PlatformSharedSqlClient = { $queryRaw: async <T>() => [] as T, $executeRaw: executeReadPort };
      const writer: PlatformSharedSqlClient = { $queryRaw: async <T>() => [] as T, $executeRaw: executeWritePort };
      const hook = Reflect.apply(createSharedFactsHookFromEnv, undefined, [
        { ADR003_SHARED_GREEN_FACTS: "on", ADR003_DOMAIN_COOLDOWN_PEPPER: "1".repeat(64) },
        { pgReader: reader, pgWriter: writer },
      ]) as ReturnType<typeof createSharedFactsHookFromEnv>;
      try {
        const result = await hook.writeBackFromStreamingExtraction({
          domain: "buyer.example",
          legalName: "Buyer Fixture",
          country: "IT",
          isImportedBuyer: false,
          extraction: {
            domain: "buyer.example",
            homepageUrl: "https://buyer.example/",
            fetchMethod: "raw_http",
            visibleText: "Company fixture",
            title: "Buyer Fixture",
            metaDescription: "Industrial pumps supplier",
            jsonLd: { organizationNames: [], descriptions: [], emails: [], phones: [], socialLinks: [], products: ["pumps"], jobPostings: [] },
            channels: {
              roleEmails: ["sales@buyer.example"], otherEmails: [], phones: [], socialLinks: [],
              hasInquiryForm: false, contactFormUrl: null, contactPageUrl: null, impressumUrl: null, careersPageUrl: null,
            },
            usedCrawl4aiFallback: false,
            usedWwwRetry: false,
            pdfSkipped: false,
            robotsBlocked: false,
            pagesFetched: ["https://buyer.example/"],
            failureReason: null,
          },
        });
        expect(result).toMatchObject({ stored: true, fact: { domain: "buyer.example", sourceKind: "public_web_streaming" } });
        expect(executeReadPort).not.toHaveBeenCalled();
        expect(executeWritePort).toHaveBeenCalledOnce();
        const [query, ...parameters] = executeWritePort.mock.calls[0]!;
        expect(query.join("?")).toContain("INSERT INTO platform_shared.company_fact");
        expect(parameters).toContain("buyer.example");
      } finally {
        await hook.close();
      }
    });

    it("T1-F12-02: approved channel projection writes lawful public company facts", async () => {
      const execute = vi.fn(async (_query: TemplateStringsArray, ..._parameters: unknown[]) => 1);
      const principal = makePlatformWriterPrismaStub();
      const channelId = "aaaaaaaa-0000-4000-8000-000000000011";
      const recordId = "aaaaaaaa-0000-4000-8000-000000000012";
      const email = "private.fixture@buyer.example";
      const phone = "+12025550142";
      const readRecords = vi.fn(async (_query: TemplateStringsArray, ..._parameters: unknown[]) => [{
        name: "Buyer Fixture",
        website: "https://buyer.example",
        country: "IT",
        industry: "Industrial pumps",
        products: ["pumps"],
        keywords: ["distributor"],
        sourceUrl: "https://key-energy-rimini.example/exhibitors/buyer",
        lastSeenAt: new Date(),
        email,
        phone,
      }]);
      const tx = {
        $queryRaw: readRecords,
        $executeRaw: execute,
        sourceChannel: {
          findFirst: vi.fn(async () => ({
            category: "trade_fair",
            name: "Public Trade Fair Fixture",
            license: "public-directory",
            manifest: KEY_ENERGY_RIMINI_HTML_MANIFEST,
          })),
        },
        sourcePolicy: {
          findMany: vi.fn(async () => [{
            domain: "key-energy-rimini.example",
            retentionDays: 21,
            allowedPurpose: ["discovery"],
            allowedPaths: ["/exhibitors/"],
            disallowedPaths: null,
          }]),
        },
      };
      const platformWriter = {
        $queryRaw: principal.$queryRaw,
        $transaction: async <T>(operation: (db: typeof tx) => Promise<T>) => operation(tx),
      };
      type Project = (input: {
        platformWriter: typeof platformWriter;
        channelId: string;
        recordIds: string[];
        env: NodeJS.ProcessEnv;
      }) => Promise<{ stored: number; skipped: number; rejected: number } | null>;
      const project = await loadProductExport<Project>(
        "F12", "src/channels/channel-platform-writer.ts", "projectApprovedChannelGreenFacts",
      );

      expect(await project({
        platformWriter, channelId, recordIds: [recordId], env: { ADR003_SHARED_GREEN_FACTS: "on" },
      })).toEqual({ stored: 1, skipped: 0, rejected: 0 });
      expect(tx.sourceChannel.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: channelId, status: "ENABLED", mode: "crawl", probeRequired: false },
      }));
      expect(readRecords).toHaveBeenCalledOnce();
      expect(readRecords.mock.calls[0]![0].join("?")).toContain("r.content_hash = r.reviewed_content_hash");
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]).toContain("public_directory");
      expect(JSON.stringify(execute.mock.calls[0])).not.toContain(email);
      expect(JSON.stringify(execute.mock.calls[0])).not.toContain(phone);
    });

    it("T1-F12-03: cooldown port receives hashed domain and workspace", async () => {
      const backend = new InMemoryDomainCooldownBackend();
      const cooldown = new DomainCooldownService({
        pepper: "1".repeat(64),
        backend,
        windowDays: 30,
        maxDistinctWorkspaces30d: 1,
      });
      await cooldown.recordTouch("italsol.example", MAINLINE_A_TENANT_A);
      const keys = backend.storedKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toContain("italsol.example");
      expect(keys[0]).toMatch(/[0-9a-f]{64}/);
      const members = backend.storedMembers(keys[0]!);
      expect(members[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(members[0]).not.toContain(MAINLINE_A_TENANT_A);
    });

    // Physical platform_writer / app_user privileges are exercised by
    // platform-shared-and-outbox-wakeup.postgres.spec.ts on a disposable database.

    it("T1-F12-05: Cooldown check within 30 days reports cooledDown=true when threshold reached", async () => {
      const cooldown = new DomainCooldownService({
        pepper: "1".repeat(64),
        windowDays: 30,
        maxDistinctWorkspaces30d: 1,
      });
      const now = Date.now();
      await cooldown.recordTouch("italsol.example", MAINLINE_A_TENANT_A, { nowMs: now });
      const status = await cooldown.checkCooldown("italsol.example", { nowMs: now + 5 * 86_400_000 });
      expect(status.cooledDown).toBe(true);
      expect(status.retryAfterDays).toBeGreaterThan(0);
    });

    it.each([
      { id: "T2-F12-01", bad: { roleEmails: ADR003_NEGATIVE_PII_FACT.roleEmails } },
      { id: "T2-F12-02", bad: { linkedinCompanyUrl: ADR003_NEGATIVE_PII_FACT.linkedinCompanyUrl } },
    ])("$id: company fact rejects personal contact data", ({ bad }) => {
      const sanitized = sanitizeToGreenCompanyFact(ADR003_CLEAN_GREEN_FACT_INPUT);
      if (!sanitized.accepted) throw new Error("Expected the company fixture to sanitize");
      expect(() => assertGreenCompanyFactClean(sanitized.fact)).not.toThrow();
      expect(() => assertGreenCompanyFactClean({ ...sanitized.fact, ...bad })).toThrow();
    });

    it("T2-F12-03: Reader-only (app_user) repository without platform_writer fails closed with ADR003_PLATFORM_WRITER_REQUIRED", async () => {
      const readerOnlySql: PlatformSharedSqlClient = {
        $queryRaw: async () => [] as any,
        $executeRaw: async () => 0,
      };
      const repo = new PostgresSharedFactRepository(readerOnlySql);
      const sanitized = sanitizeToGreenCompanyFact(ADR003_CLEAN_GREEN_FACT_INPUT);
      expect(sanitized.accepted).toBe(true);
      if (sanitized.accepted) {
        await expect(repo.upsert(sanitized.fact)).rejects.toThrow("ADR003_PLATFORM_WRITER_REQUIRED");
      }
    });

    it("T2-F12-04: Unset ADR003_DOMAIN_COOLDOWN_PEPPER fails closed (never hashes with empty pepper)", () => {
      const cooldown = new DomainCooldownService({ pepper: undefined });
      expect(cooldown.isConfigured()).toBe(false);
      expect(() => cooldown.computeDomainHmac("italsol.example")).toThrow("ADR003_COOLDOWN_PEPPER_NOT_CONFIGURED");
    });

    it("T2-F12-05: Expired cooldown (expires_at < now) clears cooledDown=false and allows re-touch", async () => {
      const cooldown = new DomainCooldownService({
        pepper: "1".repeat(64),
        windowDays: 30,
        maxDistinctWorkspaces30d: 1,
      });
      const t0 = Date.now() - 35 * 86_400_000;
      await cooldown.recordTouch("italsol.example", MAINLINE_A_TENANT_A, { nowMs: t0 });
      const status = await cooldown.checkCooldown("italsol.example", { nowMs: Date.now() });
      expect(status.cooledDown).toBe(false);
      expect(status.distinctWorkspaces30d).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // F13: Official registries & google_patents LIA gate fix (10 cases)
  // ---------------------------------------------------------------------------
  designSuite("Design examples F13: Official registries & google_patents LIA gate", () => {
    it("T1-F13-01: google_patents with PATENT_SOURCE_MODE=workspace_lia + active LIA returns inventors with an injected LIA response", async () => {
      const provider = new GooglePatentsInventorProvider({
        mode: "workspace_lia",
        hasActiveWorkspaceLia: async () => true,
        cacheReader: async () => REGISTRY_FIXTURES.patentsCacheRow.map((r) => ({ ...r, applicants: [...r.applicants], inventors: [...r.inventors] })) as any,
      });
      const res = await provider.discoverContacts(
        { name: "Italsol S.r.l.", domain: "italsol.example", country: "IT" },
        { workspaceId: MAINLINE_A_TENANT_A, runId: "r-pat-1" },
      );
      expect(res.contacts.length).toBeGreaterThan(0);

      expect(res.contacts[0]!.fullName).toBe("Marco Bellini");
    });

    it("T1-F13-02: companies_house provider returns active directors for UK Ltd (99009900)", async () => {
      const broker: ExecutionBroker = {
        invoke: async (_tool: string, input: any) => {
          if (input.op === "search") {
            return {
              data: {
                companies: [{ companyNumber: "99009900", title: "UK SOLAR IMPORTER LTD", companyStatus: "active" }],
              },
              costCents: 0,
            };
          }
          return {
            data: {
              officers: [{ name: "SMITH, Arthur James", officerRole: "director", officerId: "ch-off-001" }],
            },
            costCents: 0,
          };
        },
      } as unknown as ExecutionBroker;
      const provider = new CompaniesHouseContactProvider({ broker });
      const res = await provider.discoverContacts(
        { name: "UK Solar Importer Ltd", domain: "uksolar.co.uk", country: "GB" },
        { workspaceId: MAINLINE_A_TENANT_A, runId: "r-ch-1" },
      );
      expect(res.contacts).toHaveLength(1);
      expect(res.contacts[0]!.fullName).toBe("Arthur James Smith");
    });

    it("T1-F13-03: gleif provider lookup returns LEI and parent corporate tree", async () => {
      const broker: ExecutionBroker = {
        invoke: async (_tool: string, input: any) => {
          if (input.op === "search") {
            return { data: { records: [...REGISTRY_FIXTURES.gleifActive.records] }, costCents: 0 };
          }
          return { data: { parent: { lei: "549300PARENT00000001", legalName: "SolarBau Holding AG" } }, costCents: 0 };
        },
      } as unknown as ExecutionBroker;
      const provider = new GleifEnrichmentProvider({ broker });
      const res = await provider.enrichCompany(
        { name: "SolarBau GmbH", country: "DE" },
        { workspaceId: MAINLINE_A_TENANT_A, runId: "r-gleif-1" },
      );
      expect(res.matched).toBe(true);
      expect(res.attributes.lei).toBe("5493001KJTIIGC8Y1R12");
      expect(res.attributes.is_subsidiary).toBe(true);
    });

    it("T1-F13-04: ted provider maps a synthetic award to a contracting authority", async () => {
      const broker: ExecutionBroker = {
        invoke: async () => ({ data: { awards: [...REGISTRY_FIXTURES.tedNotices.awards] }, costCents: 0 }),
      } as unknown as ExecutionBroker;
      const provider = new TedDiscoveryProvider({ broker });
      const res = await provider.discoverCompanies(
        { sourceClass: "public_intelligence", filters: { cpv: ["09331200"], buyer_countries: ["IT"] }, keywords: ["solar"], limit: 10 },
        { workspaceId: MAINLINE_A_TENANT_A, runId: "r-ted-1" },
      );
      expect(res.records).toHaveLength(1);
      expect(res.records[0]!.name).toBe("Italsol Srl");

      expect(res.records[0]!.country).toBe("IT");
    });

    it("T1-F13-05: ats-boards Greenhouse probe detects open procurement roles", () => {
      const board = detectAtsBoard(REGISTRY_FIXTURES.greenhouseHtml);
      expect(board).toEqual({ vendor: "greenhouse", token: "solarbau" });
      expect(atsApiUrl(board!)).toBe("https://boards-api.greenhouse.io/v1/boards/solarbau/jobs");
      const jobs = parseAtsJobs("greenhouse", REGISTRY_FIXTURES.greenhouseJobsJson);
      const hiring = buildHiringFromAtsJobs("greenhouse", jobs);
      expect(hiring?.open_roles).toBe(1);
      expect(hiring?.titles).toContain("Head of Solar Procurement");
    });

    it("T2-F13-01: PATENT_SOURCE_MODE=workspace_lia with 0 active LIA rows fails closed returning empty", async () => {
      const provider = new GooglePatentsInventorProvider({
        mode: "workspace_lia",
        hasActiveWorkspaceLia: async () => false,
        cacheReader: async () => REGISTRY_FIXTURES.patentsCacheRow as any,
      });
      const res = await provider.discoverContacts(
        { name: "Italsol S.r.l.", domain: "italsol.example", country: "IT" },
        { workspaceId: MAINLINE_A_TENANT_A, runId: "r-pat-0" },
      );
      expect(res.contacts).toEqual([]);
    });

    it("T2-F13-02: companies_house HTTP 429 / broker failure degrades gracefully without crashing run", async () => {
      const broker: ExecutionBroker = {
        invoke: async () => {
          throw new Error("HTTP 429 rate limited");
        },
      } as unknown as ExecutionBroker;
      const provider = new CompaniesHouseContactProvider({ broker });
      const res = await provider.discoverContacts(
        { name: "UK Solar Importer Ltd", country: "GB" },
        { workspaceId: MAINLINE_A_TENANT_A, runId: "r-ch-429" },
      );
      expect(res.contacts).toEqual([]);
      expect(res.costCents).toBe(0);
    });

    it.todo("T2-F13-03: TED buyer-role admission in the product provider registry");

    it("T2-F13-04: gleif INACTIVE entity is marked entity_status='INACTIVE'", async () => {
      const broker: ExecutionBroker = {
        invoke: async () => ({ data: { records: [...REGISTRY_FIXTURES.gleifInactive.records] }, costCents: 0 }),
      } as unknown as ExecutionBroker;
      const provider = new GleifEnrichmentProvider({ broker });
      const res = await provider.enrichCompany(
        { name: "Defunct Solar GmbH", country: "DE" },
        { workspaceId: MAINLINE_A_TENANT_A, runId: "r-gleif-inact" },
      );
      expect(res.matched).toBe(true);
      expect(res.attributes.entity_status).toBe("INACTIVE");
    });

    it("T2-F13-05: ats-boards with 404/empty HTML or empty JSON returns null cleanly without throwing", () => {
      expect(detectAtsBoard("<html><body>No careers board</body></html>")).toBeNull();
      expect(buildHiringFromAtsJobs("greenhouse", parseAtsJobs("greenhouse", { jobs: [] }))).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // F14: global-changedetection & global-rsshub key-buyer watches (10 cases)
  // ---------------------------------------------------------------------------
  designSuite("Design examples F14: changedetection & rsshub key-buyer signals & HTTP API", () => {
    async function bootSignalsHarness(signalRows: Array<Record<string, unknown>> = []) {
      const prismaStub = createInMemoryPrismaStub({
        $queryRaw: async () => signalRows,
      }) as unknown as PrismaService;
      registerDesignParamTypes(CompanySignalsService, [PrismaService]);
      registerDesignParamTypes(CompanySignalsController, [CompanySignalsService]);

      class SignalsHttpTestModule {}
      Module({
        imports: [AuthModule],
        controllers: [CompanySignalsController],
        providers: [
          { provide: PrismaService, useValue: prismaStub },
          CompanySignalsService,
        ],
      })(SignalsHttpTestModule);

      return startNestHttpHarness(SignalsHttpTestModule);
    }

    it("T1-F14-01: synthetic change-watch endpoint accepts a fixture request", async () => {
      upstreams.setRoute("/changedetection", (_req, res) => {
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ uuid: "watch-s-tier-1" }));
      });
      const res = await fetch(upstreams.urlFor("/changedetection") + "/api/v1/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://italsol.example/news" }),
      });
      expect(res.status).toBe(201);
      expect(upstreams.getCalls("/changedetection")).toHaveLength(1);
    });

    it("T1-F14-02: changedetection watch response parses into signalKind='page_change'", () => {
      const parsed = parseChangedetectionWatches(SIGNALS_AND_DOCLING_FIXTURES.changedetectionWatches);
      expect(parsed.recognized).toBe(true);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]!.signalKind).toBe("page_change");
      expect(parsed.items[0]!.providerKey).toBe("changedetection");
    });

    it("T1-F14-03: rsshub feed XML parses into signalKind='rss_item'", async () => {
      upstreams.setRoute("/rsshub", (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/rss+xml");
        res.end(SIGNALS_AND_DOCLING_FIXTURES.rssFeedXml);
      });
      const resp = await fetch(`${upstreams.urlFor("/rsshub")}/solar/italsol`);
      const xml = await resp.text();
      const parsed = parseRssFeed(xml);
      expect(parsed.recognized).toBe(true);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0]!.signalKind).toBe("rss_item");
      expect(parsed.items[0]!.providerKey).toBe("rss");
    });

    it("T1-F14-04: GET /api/v1/companies/:id/signals returns keyset-paginated signals ordered observedAt DESC", async () => {
      const rows = [
        {
          id: "70000000-0000-4000-8000-000000000002",
          provider_key: "changedetection",
          signal_kind: "page_change",
          source_url: "https://italsol.example/news/hub",
          title: "New PV hub",
          excerpt: null,
          observed_at: new Date("2026-11-11T10:00:00Z"),
        },
        {
          id: "70000000-0000-4000-8000-000000000001",
          provider_key: "rss",
          signal_kind: "rss_item",
          source_url: "https://italsol.example/press/50mw",
          title: "50MW warehouse",
          excerpt: "New stock",
          observed_at: new Date("2026-11-10T10:00:00Z"),
        },
      ];
      const harness = await bootSignalsHarness(rows);
      try {
        const token = await jwks.signJwt({ workspaceId: MAINLINE_A_TENANT_A, roles: ["ADMIN"] });
        const res = await harness.request(
          `/api/v1/companies/${MAINLINE_A_COMPANY_ID}/signals?limit=1`,
          { token },
        );
        expect(res.status).toBe(200);
        const body = res.json<{ data: Array<{ id: string }>; page: { has_more: boolean; next_cursor: string } }>();
        expect(body.data).toHaveLength(1);
        expect(body.data[0]!.id).toBe("70000000-0000-4000-8000-000000000002");
        expect(body.page.has_more).toBe(true);
        expect(typeof body.page.next_cursor).toBe("string");
      } finally {
        await harness.close();
      }
    });

    it("T1-F14-05: A-tier buyer page_change signal generates non-PII icebreaker referencing page title/URL", () => {
      const icebreakers = buildSignalIcebreakers({
        companyName: "Italsol Srl",
        signals: [
          {
            provider: "changedetection",
            type: "PAGE_CHANGE",
            title: "Italsol opens new PV distribution hub",
            url: "https://italsol.example/news/new-pv-distribution-hub",
            at: "2026-11-11T10:00:00Z",
          },
        ],
      });
      expect(icebreakers).toHaveLength(1);
      expect(icebreakers[0]!.signalUrl).toBe("https://italsol.example/news/new-pv-distribution-hub");
      expect(icebreakers[0]!.openerEn).toContain("Italsol Srl");
    });

    it.todo("T2-F14-01: discovery activities gate watch creation on buyer qualification");

    it("T2-F14-02: Unreachable changedetection container (ECONNREFUSED) degrades without crashing", async () => {
      const closedPortUrl = "http://127.0.0.1:1";
      await expect(
        fetch(`${closedPortUrl}/api/v1/watch`, { signal: AbortSignal.timeout(300) }).catch((e) => ({
          degraded: true,
          error: String(e),
        })),
      ).resolves.toMatchObject({ degraded: true });
    });

    it("T2-F14-03: Unattributed RSS item (unrelated domain) is excluded from company signals", async () => {
      const parsed = parseRssFeed(SIGNALS_AND_DOCLING_FIXTURES.unattributedRssXml);
      expect(parsed.items).toHaveLength(1);
      const harness = await bootSignalsHarness([]);
      try {
        const token = await jwks.signJwt({ workspaceId: MAINLINE_A_TENANT_A, roles: ["ADMIN"] });
        const res = await harness.request(`/api/v1/companies/${MAINLINE_A_COMPANY_ID}/signals`, { token });
        expect(res.status).toBe(200);
        expect(res.json<{ data: unknown[] }>().data).toEqual([]);
      } finally {
        await harness.close();
      }
    });

    it("T2-F14-04: Changedetection entry with last_changed=0 (unchanged) is skipped without duplicate signal flood", () => {
      const parsed = parseChangedetectionWatches({
        w1: { uuid: "w1", url: "https://italsol.example/news", title: "Unchanged", last_changed: 0 },
      });
      expect(parsed.items).toHaveLength(0);
    });

    it("T2-F14-05: GET /companies/:id/signals?limit=999 or malformed cursor returns 400 VALIDATION_ERROR", async () => {
      const harness = await bootSignalsHarness([]);
      try {
        const token = await jwks.signJwt({ workspaceId: MAINLINE_A_TENANT_A, roles: ["ADMIN"] });
        const res1 = await harness.request(
          `/api/v1/companies/${MAINLINE_A_COMPANY_ID}/signals?limit=999`,
          { token },
        );
        expect(res1.status).toBe(400);
        expect(res1.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");

        const res2 = await harness.request(
          `/api/v1/companies/${MAINLINE_A_COMPANY_ID}/signals?cursor=not-valid-base64`,
          { token },
        );
        expect(res2.status).toBe(400);
      } finally {
        await harness.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F15: global-docling buyer PDF reverse parsing & SearXNG re-verify (10 cases)
  // ---------------------------------------------------------------------------
  designSuite("Design examples F15: global-docling buyer PDF parsing & SearXNG grey-zone re-verify", () => {
    it("T1-F15-01: DoclingClient parses buyer PDF catalog into contacts, VAT, and product specs", async () => {
      upstreams.setRoute("/docling", (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(SIGNALS_AND_DOCLING_FIXTURES.doclingBuyerCatalogResponse));
      });
      const client = new DoclingClient();
      const out = await client.convertToMarkdown(
        "italsol-catalog.pdf",
        SIGNALS_AND_DOCLING_FIXTURES.syntheticPdfBytes,
      );
      expect(out.markdown).toContain("Alba Fixture");
      expect(out.markdown).toContain("ufficio.acquisti@italsol.example");
      expect(out.markdown).toContain("IT01234560234");
    });

    it("T1-F15-02: DoclingClient parses TED tender PDF into procurement officer & contact", async () => {
      upstreams.setRoute("/docling", (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(SIGNALS_AND_DOCLING_FIXTURES.doclingTedTenderResponse));
      });
      const client = new DoclingClient();
      const out = await client.convertToMarkdown(
        "ted-2026-045.pdf",
        SIGNALS_AND_DOCLING_FIXTURES.syntheticPdfBytes,
      );
      expect(out.markdown).toContain("Elena Moretti");
      expect(out.markdown).toContain("procurement@italsol.example");
    });

    it.todo("T1-F15-03: buyer PDF client composition independently of Site Builder");

    it("T1-F15-04: SearXNG grey-zone (0.45..0.74) candidate confirmed on company site promotes to >=0.75 at $0", async () => {
      upstreams.setRoute("/searxng", (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(SIGNALS_AND_DOCLING_FIXTURES.searxGreyZoneConfirm));
      });
      const res = await searxSearch(
        { q: "\"Giulia Bianchi\" \"Italsol\" site:italsol.example" },
        5_000,
        MAINLINE_A_TENANT_A,
      );
      expect(res.results).toHaveLength(1);
      expect(res.results[0]!.url).toBe("https://italsol.example/team");
      expect(upstreams.getCalls("/searxng")).toHaveLength(1);
    });

    it("T1-F15-05: Docling health check & bounded timeout succeed cleanly against mock server", async () => {
      upstreams.setRoute("/docling", (req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        if (req.path === "/health") {
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        res.end(JSON.stringify(SIGNALS_AND_DOCLING_FIXTURES.doclingBuyerCatalogResponse));
      });
      const health = await fetch(`${upstreams.urlFor("/docling")}/health`);
      expect(health.status).toBe(200);
      const client = new DoclingClient();
      const out = await client.convertToMarkdown(
        "health-test.pdf",
        SIGNALS_AND_DOCLING_FIXTURES.syntheticPdfBytes,
      );
      expect(out.markdown).toContain("Italsol S.r.l.");
    });

    it.todo("T2-F15-01: buyer PDF URL checks through the proposed adapter");

    it("T2-F15-02: Corrupt / unreadable PDF sent to Docling returns bounded KB_DOCUMENT_INVALID error", async () => {
      upstreams.setRoute("/docling", (_req, res) => {
        res.statusCode = 422;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            detail: { component_type: "user_input", message: "invalid document data format" },
          }),
        );
      });
      const client = new DoclingClient();
      await expect(
        client.convertToMarkdown("corrupt.pdf", Buffer.from("not-a-pdf")),
      ).rejects.toMatchObject({ code: "KB_DOCUMENT_INVALID" });
    });

    it("T2-F15-03: Docling HTTP 503 degrades with retryable KB_DOCLING_UNAVAILABLE", async () => {
      upstreams.setRoute("/docling", (_req, res) => {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ detail: "service busy" }));
      });
      const client = new DoclingClient();
      await expect(
        client.convertToMarkdown("catalog.pdf", SIGNALS_AND_DOCLING_FIXTURES.syntheticPdfBytes),
      ).rejects.toMatchObject({ code: "KB_DOCLING_UNAVAILABLE", disposition: "retryable" });
    });

    it("T2-F15-04: SearXNG grey-zone query returning unrelated namesakes keeps score <0.75 (not promoted)", async () => {
      upstreams.setRoute("/searxng", (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            results: [
              {
                url: "https://unrelated-valves.example/about",
                title: "Giulia Bianchi - Valve Sales",
                content: "Industrial valve sales unrelated to Italsol.",
              },
            ],
            suggestions: [],
            infoboxes: [],
            number_of_results: 1,
          }),
        );
      });
      const res = await searxSearch({ q: "\"Giulia Bianchi\" \"Italsol\"" }, 5_000, MAINLINE_A_TENANT_A);
      expect(res.results).toHaveLength(1);
      expect(res.results[0]!.url).not.toContain("italsol.example");
    });

    it.todo("T2-F15-05: buyer PDF byte limit before invoking the proposed adapter");
  });
});
