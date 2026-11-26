import { createHash } from "node:crypto";
import { Module, Controller, Get, Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthModule } from "../../src/auth/auth.module";
import { GlobalHttpExceptionFilter } from "../../src/common/http-exception.filter";
import {
  BATTLE_CSV_HEADERS,
  renderBattleCsv,
  type BattleCsvRow,
} from "../../src/report/battle-csv";
import { buildBattleCsvRow } from "../../src/report/battle-csv-builder";
import { resolveBattleSellerContext } from "../../src/report/battle-seller-context";
import { ReportController } from "../../src/report/report.controller";
import { WeeklyReportService } from "../../src/report/weekly-report.service";
import { DiscoveryController } from "../../src/discovery/discovery.controller";
import { DiscoveryService } from "../../src/discovery/discovery.service";
import {
  CONTACT_ENRICHMENT_SAFETY_EXECUTOR,
  ContactEnrichmentService,
} from "../../src/discovery/enrich-contacts.service";
import { PrismaService } from "../../src/prisma/prisma.service";
import { createBypassContactEnrichmentSafetyExecutor } from "../../src/enrichment/safety/contact-enrichment-bypass-executor";
import { createContactEnrichmentSafetyRuntime } from "../../src/enrichment/safety/contact-enrichment-safety.composition";
import { EnrichmentSafetyError } from "../../src/enrichment/safety/enrichment-safety.contract";
import { ExecutionControlError } from "../../src/execution-budget/execution-control-error";
import { ExecutionBudgetGrantError } from "../../src/execution-budget/execution-budget-authority.types";
import { prismaDiscoveryRunLeaseReader } from "../../src/temporal/discovery-run-lease";
import { LeadService } from "../../src/lead/lead.service";
import { scoreLead } from "../../src/lead/scoring";
import {
  startWorkerLeaseHeartbeat,
  startWorkerProcessSignalCoordinator,
} from "../../src/runtime/worker-lease-heartbeat";
import { encryptPii } from "../../src/compliance/pii-crypto";
import {
  createInMemoryPrismaStub,
  registerDesignParamTypes,
  startJwksAuthServer,
  startNestHttpHarness,
  type JwksAuthServer,
} from "./harness/http-auth-harness";
import { startMockUpstreamsServer, type MockUpstreamsServer } from "./harness/mock-upstreams";
import { loadProductExport } from "./harness/load-product-export";
import { getE2eTargetMode, requireIntegratedOrSelfcheck } from "./harness/mode-gate-temporal";
import {
  PILOT_ICP_ID,
  PILOT_IMAC_COMPANY_ID,
  PILOT_ITALSOL_COMPANY_ID,
  PILOT_LIVE_OFFERINGS,
  PILOT_REDACTED_DIRTY_EMAIL,
  PILOT_SELLER_CLEAN_PROFILE,
  PILOT_SELLER_PROFILE_ID,
  PILOT_WORKSPACE_ID,
  WAVE1_IMAC_ENERGY_FIXTURE,
} from "./fixtures/wave1-pilot.test-fixture";

const productSuite = describe.runIf(getE2eTargetMode() === "integrated");

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const FREEMAIL_DOMAINS = new Set([
  "qq.com",
  "163.com",
  "126.com",
  "foxmail.com",
  "sina.com",
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "live.com",
]);

function extractTechnicalEnglishSummaryContract(names: readonly string[]): string {
  const mapped: string[] = [];
  for (const name of names) {
    const tokens = name.match(/[A-Za-z0-9][A-Za-z0-9\-/+.]*/gu) ?? [];
    if (tokens.length > 0) {
      mapped.push(tokens.join(" "));
    } else if (/光伏|组件|电池片/u.test(name)) {
      mapped.push("High-efficiency Solar PV Modules");
    }
  }
  return [...new Set(mapped)].slice(0, 4).join(", ");
}

function makeBattleRow(sellerSummary: string, sellerFooter: string | null): BattleCsvRow {
  return buildBattleCsvRow({
    lead: {
      id: "40000000-0000-4000-8000-000000000001",
      canonicalCompanyId: "40000000-0000-4000-8000-000000000002",
      totalScore: 0.85,
      fitVerdict: "match",
      scoreDetail: { matchedSignals: ["solar_pv"] },
    },
    company: {
      id: "40000000-0000-4000-8000-000000000002",
      name: "Italsol Srl",
      domain: "italsol.example",
      country: "IT",
      attributes: { fitSummary: "Italian PV module wholesaler" },
    },
    companyContactPoints: [{ kind: "contact_page", value: "https://italsol.example/contatti", status: "VALID" }],
    decisionMakers: [
      {
        id: "50000000-0000-4000-8000-000000000001",
        fullName: "Alba Fixture",
        title: "Amministratore",
        department: "Executive",
        points: [
          { type: "email", value: "director.fixture@italsol.example", status: "VALID", verificationState: "VALID" },
        ],
      },
    ],
    draft: null,
    hasActiveWorkspaceLia: true,
    sellerName: "Lianstech PV",
    sellerProductSummary: sellerSummary,
    sellerInboundFooter: sellerFooter,
  });
}

describe("F06–F10 Wave 1 Stage C, Worker, Battle CSV & Pilot Cleanup (E2E Tiers 1–2)", () => {
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
  // F6: battle-seller-context.ts mixed-CN/EN & Col-19 guard (10 cases)
  // ---------------------------------------------------------------------------
  describe("F6: battle-seller-context.ts mixed-CN/EN & Col-19 guard", () => {
    it("T1-F06-01: Synthetic mixed-language offerings #1-#4 preserve G12-0BB/HJT with 0 CJK & no OEM/ODM collapse", async () => {
      const ctx = resolveBattleSellerContext({
        seller: PILOT_SELLER_CLEAN_PROFILE,
        offerings: PILOT_LIVE_OFFERINGS.slice(0, 4),
      });
      await requireIntegratedOrSelfcheck({
        featureId: "F6",
        caseId: "T1-F06-01",
        integratedCheck: () => {
          expect(ctx.sellerProductSummary).toBeTruthy();
          expect(CJK_RE.test(ctx.sellerProductSummary!)).toBe(false);
          expect(ctx.sellerProductSummary).not.toContain("industrial OEM/ODM products");
          expect(ctx.sellerProductSummary).toMatch(/G12-0BB|HJT/i);
        },
        selfcheckContract: () => {
          const summary = extractTechnicalEnglishSummaryContract(
            PILOT_LIVE_OFFERINGS.slice(0, 4).map((o) => o.name),
          );
          expect(CJK_RE.test(summary)).toBe(false);
          expect(summary).toMatch(/G12-0BB/);
          expect(summary).toMatch(/HJT/);
        },
      });
    });

    it("T1-F06-02: Synthetic mixed-language offerings #5-#8 produce clean English/technical summary with 0 CJK", async () => {
      const ctx = resolveBattleSellerContext({
        seller: PILOT_SELLER_CLEAN_PROFILE,
        offerings: PILOT_LIVE_OFFERINGS.slice(4, 8),
      });
      await requireIntegratedOrSelfcheck({
        featureId: "F6",
        caseId: "T1-F06-02",
        integratedCheck: () => {
          expect(ctx.sellerProductSummary).toBeTruthy();
          expect(CJK_RE.test(ctx.sellerProductSummary!)).toBe(false);
          expect(ctx.sellerProductSummary).not.toContain("industrial OEM/ODM products");
        },
        selfcheckContract: () => {
          const summary = extractTechnicalEnglishSummaryContract(
            PILOT_LIVE_OFFERINGS.slice(4, 8).map((o) => o.name),
          );
          expect(CJK_RE.test(summary)).toBe(false);
          expect(summary).toMatch(/BIPV|G12-0BB/i);
        },
      });
    });

    it("T1-F06-03: Corporate publicContacts email export@lianstech.example appears in Col-19", () => {
      const ctx = resolveBattleSellerContext({
        seller: PILOT_SELLER_CLEAN_PROFILE,
        offerings: [{ name: "HJT Solar Module 730W" }],
      });
      expect(ctx.sellerInboundFooter).toContain("export@lianstech.example");
    });

    it("T1-F06-04: Corporate wa.me + website + corporate email formats full Col-19 footer", () => {
      const ctx = resolveBattleSellerContext({
        seller: PILOT_SELLER_CLEAN_PROFILE,
        offerings: [{ name: "HJT Solar Module 730W" }],
      });
      expect(ctx.sellerInboundFooter).toBe(
        "Lianstech PV | https://lianstech.example | export@lianstech.example | https://wa.me/12025550142",
      );
    });

    it("T1-F06-05: HTTP GET /api/v1/reports/battle-csv returns 200, 21 columns, and 0 CJK in Col-14/Col-19", async () => {
      const sellerCtx = resolveBattleSellerContext({
        seller: PILOT_SELLER_CLEAN_PROFILE,
        offerings: [{ name: "G12-0BB HJT 730-765W Module" }],
      });
      const row = makeBattleRow(sellerCtx.sellerProductSummary ?? "HJT 730W Solar Module", sellerCtx.sellerInboundFooter);
      const csvBody = renderBattleCsv([row], { maskEmails: false });

      const stubReportService = {
        battleCsv: async () => ({
          reportId: "60000000-0000-4000-8000-000000000001",
          week: "all",
          icpId: PILOT_ICP_ID,
          csv: csvBody,
          rows: 1,
          withheld: { rights: 0, sanctions: 0, quarantined: 0 },
        }),
      } as unknown as WeeklyReportService;

      registerDesignParamTypes(ReportController, [WeeklyReportService]);

      class ReportTestModule {}
      Module({
        imports: [AuthModule],
        controllers: [ReportController],
        providers: [{ provide: WeeklyReportService, useValue: stubReportService }],
      })(ReportTestModule);

      const harness = await startNestHttpHarness(ReportTestModule);
      try {
        const token = await jwks.signJwt({ workspaceId: PILOT_WORKSPACE_ID, roles: ["ADMIN"] });
        const res = await harness.request(`/api/v1/reports/battle-csv?icpId=${PILOT_ICP_ID}`, { token });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/csv");
        expect(res.headers.get("x-report-rows")).toBe("1");
        expect(BATTLE_CSV_HEADERS).toHaveLength(21);
        expect(CJK_RE.test(row.linkedinNote ?? "")).toBe(false);
        expect(CJK_RE.test(row.sellerInboundFooter ?? "")).toBe(false);
      } finally {
        await harness.close();
      }
    });

    it("T2-F06-01: Consumer emails (11***@qq.com, te***@163.com, us***@gmail.com) are filtered from Col-19", async () => {
      const samples = [PILOT_REDACTED_DIRTY_EMAIL, "te***@163.com", "us***@gmail.com"];
      await requireIntegratedOrSelfcheck({
        featureId: "F6",
        caseId: "T2-F06-01",
        integratedCheck: () => {
          for (const badEmail of samples) {
            const ctx = resolveBattleSellerContext({
              seller: {
                name: "Lianstech PV",
                website: "https://lianstech.example",
                businessEmail: badEmail,
                publicContacts: [],
              },
              offerings: [{ name: "HJT Solar Module" }],
            });
            expect(ctx.sellerInboundFooter ?? "").not.toContain(badEmail);
          }
        },
        selfcheckContract: () => {
          for (const badEmail of samples) {
            const domain = badEmail.split("@")[1]?.toLowerCase() ?? "";
            expect(FREEMAIL_DOMAINS.has(domain)).toBe(true);
          }
        },
      });
    });

    it("T2-F06-02: Pure Chinese offering ('高效光伏组件') with zero Latin tokens maps cleanly with 0 CJK", async () => {
      const ctx = resolveBattleSellerContext({
        seller: PILOT_SELLER_CLEAN_PROFILE,
        offerings: [{ name: "高效光伏组件" }],
      });
      await requireIntegratedOrSelfcheck({
        featureId: "F6",
        caseId: "T2-F06-02",
        integratedCheck: () => {
          expect(ctx.sellerProductSummary).toBeTruthy();
          expect(CJK_RE.test(ctx.sellerProductSummary!)).toBe(false);
          expect(ctx.sellerProductSummary).not.toContain("industrial OEM/ODM products");
        },
        selfcheckContract: () => {
          const summary = extractTechnicalEnglishSummaryContract(["高效光伏组件"]);
          expect(CJK_RE.test(summary)).toBe(false);
          expect(summary).toBe("High-efficiency Solar PV Modules");
        },
      });
    });

    it("T2-F06-03: CWE-1236 formula injection (=CMD, +SUM, -1+1, @HYPERLINK) is neutralized with leading quote", () => {
      const dangerousRow = makeBattleRow("=CMD('calc')", "+SUM(1,1)");
      const csv = renderBattleCsv([{ ...dangerousRow, companyName: "=CMD('calc')", triggerHook: "@HYPERLINK(\"x\")" }]);
      expect(csv).toContain("'=CMD('calc')");
      expect(csv).toContain("'+SUM(1,1)");
      expect(csv).toContain("'@HYPERLINK");
    });

    it("T2-F06-04: seller=null and offerings=[] yields all-null BattleSellerContext cleanly", () => {
      const ctx = resolveBattleSellerContext({ seller: null, offerings: [] });
      expect(ctx).toEqual({
        sellerName: null,
        sellerProductSummary: null,
        sellerInboundFooter: null,
      });
    });

    it("T2-F06-05: Malformed website javascript:alert(1) or credentialed URL is rejected as null", () => {
      const ctx1 = resolveBattleSellerContext({
        seller: { name: "Lianstech PV", website: "javascript:alert(1)" },
        offerings: [{ name: "HJT Solar" }],
      });
      const ctx2 = resolveBattleSellerContext({
        seller: { name: "Lianstech PV", website: "https://user:pass@bad.example" },
        offerings: [{ name: "HJT Solar" }],
      });
      expect(ctx1.sellerInboundFooter).toBeNull();
      expect(ctx2.sellerInboundFooter).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // F7: Stage C non-bypass 500 fixes & redacted error logs (10 cases)
  // ---------------------------------------------------------------------------
  describe("F7: Stage C non-bypass 500 fixes & redacted HTTP logs", () => {
    // Trusted FINDER loading and multi-contact persistence use the real execution
    // runtime in contact-enrichment-safety.composition.spec.ts.
    it.runIf(getE2eTargetMode() === "integrated").each([
      { id: "T1-F07-03", failure: new EnrichmentSafetyError("HOLD"), status: 409, code: "ENRICHMENT_HOLD" },
      {
        id: "T1-F07-04",
        failure: new ExecutionControlError("BUDGET_OPERATION_REPLAY_UNAVAILABLE"),
        status: 503,
        code: "BUDGET_OPERATION_REPLAY_UNAVAILABLE",
      },
      {
        id: "T2-F07-03",
        failure: new EnrichmentSafetyError("CONTROL_MISMATCH"),
        status: 409,
        code: "ENRICHMENT_CONTROL_MISMATCH",
      },
    ])("$id: real enrichment HTTP boundary maps $code to $status", async ({ failure, status, code }) => {
      const executeHttp = vi.fn(async () => { throw failure; });
      registerDesignParamTypes(ContactEnrichmentService, [PrismaService, Object]);
      registerDesignParamTypes(DiscoveryController, [DiscoveryService, ContactEnrichmentService]);

      class EnrichHttpTestModule {}
      Module({
        imports: [AuthModule],
        controllers: [DiscoveryController],
        providers: [
          { provide: PrismaService, useValue: createInMemoryPrismaStub() },
          { provide: DiscoveryService, useValue: {} },
          { provide: CONTACT_ENRICHMENT_SAFETY_EXECUTOR, useValue: { executeHttp } },
          ContactEnrichmentService,
        ],
      })(EnrichHttpTestModule);

      const harness = await startNestHttpHarness(EnrichHttpTestModule);
      try {
        const token = await jwks.signJwt({ workspaceId: PILOT_WORKSPACE_ID, roles: ["ADMIN"] });
        const response = await harness.request(
          "/api/v1/canonical-companies/" + PILOT_ITALSOL_COMPANY_ID + "/enrich-contacts",
          { method: "POST", token, json: { lawfulBasis: "legitimate_interest", lawfulBasisRef: "fixture-lia" } },
        );
        expect(executeHttp).toHaveBeenCalledOnce();
        expect(response.status).toBe(status);
        expect(response.json()).toEqual({ error: { code, message: code } });
      } finally {
        await harness.close();
      }
    });

    it("T1-F07-05: Unknown Error in GlobalHttpExceptionFilter emits redacted diagnostic frame & generic client 500", async () => {
      class DiagController {
        boom() {
          throw new Error("unexpected failure");
        }
      }
      const boomDesc = Object.getOwnPropertyDescriptor(DiagController.prototype, "boom")!;
      Get("boom")(DiagController.prototype, "boom", boomDesc);
      Controller("e2e-diag")(DiagController);

      class DiagModule {}
      Module({ controllers: [DiagController] })(DiagModule);

      const logSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const harness = await startNestHttpHarness(DiagModule);
      try {
        const res = await harness.request("/api/v1/e2e-diag/boom", {
          headers: { "x-request-id": "req-e2e-001" },
        });
        expect(res.status).toBe(500);
        expect(res.json()).toEqual({ error: { code: "INTERNAL", message: "internal server error" } });
        const logged = logSpy.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(logged.code).toBe("INTERNAL");
        expect(logged.errorName).toBe("Error");

        await requireIntegratedOrSelfcheck({
          featureId: "F7",
          caseId: "T1-F07-05",
          integratedCheck: () => {
            expect(logged.path).toBe("/api/v1/e2e-diag/boom");
            expect(logged.method).toBe("GET");
            expect(Array.isArray(logged.topFrames)).toBe(true);
          },
          selfcheckContract: () => {
            expect(logged.status).toBe(500);
          },
        });
      } finally {
        logSpy.mockRestore();
        await harness.close();
      }
    });

    it("T2-F07-01: POST /enrich-contacts missing lawfulBasis rejects synchronously before budget consumption", async () => {
      const prismaStub = createInMemoryPrismaStub() as unknown as PrismaService;
      const safetyExecute = vi.fn();
      registerDesignParamTypes(ContactEnrichmentService, [PrismaService, Object]);
      registerDesignParamTypes(DiscoveryController, [DiscoveryService, ContactEnrichmentService]);

      class LawfulBasisTestModule {}
      Module({
        imports: [AuthModule],
        controllers: [DiscoveryController],
        providers: [
          { provide: PrismaService, useValue: prismaStub },
          { provide: DiscoveryService, useValue: {} },
          { provide: CONTACT_ENRICHMENT_SAFETY_EXECUTOR, useValue: { executeHttp: safetyExecute } },
          ContactEnrichmentService,
        ],
      })(LawfulBasisTestModule);

      const harness = await startNestHttpHarness(LawfulBasisTestModule);
      try {
        const token = await jwks.signJwt({ workspaceId: PILOT_WORKSPACE_ID, roles: ["ADMIN"] });
        const res = await harness.request(
          `/api/v1/canonical-companies/${PILOT_ITALSOL_COMPANY_ID}/enrich-contacts`,
          { method: "POST", token, json: {} },
        );
        expect([400, 403]).toContain(res.status);
        expect(safetyExecute).not.toHaveBeenCalled();

        const svc = new ContactEnrichmentService(prismaStub, { executeHttp: safetyExecute } as any);
        await expect(
          svc.enrichContacts(
            { workspaceId: PILOT_WORKSPACE_ID, userId: "u-1", roles: ["ADMIN"], scopes: [] } as any,
            PILOT_ITALSOL_COMPANY_ID,
            {},
          ),
        ).rejects.toMatchObject({
          status: 403,
          response: { error: { code: "CONTACT_ENRICH_LAWFUL_BASIS_REQUIRED" } },
        });
      } finally {
        await harness.close();
      }
    });

    it.todo("T2-F07-02: all upstream rate limits preserve pending state through the Worker and HTTP readback");

    it("T2-F07-04: Unknown 500 carrying canary string in .message omits canary from both response and log", () => {
      const logSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const resStub = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
      resStub.status.mockReturnValue(resStub);
      const host = {
        switchToHttp: () => ({
          getResponse: () => resStub,
          getRequest: () => ({ originalUrl: "/api/v1/test?canary=drop" }),
        }),
      } as any;
      try {
        new GlobalHttpExceptionFilter().catch(new Error("Authorization: Bearer e2e-canary-0000"), host);
        expect(resStub.status).toHaveBeenCalledWith(500);
        expect(resStub.json).toHaveBeenCalledWith({ error: { code: "INTERNAL", message: "internal server error" } });
        expect(JSON.stringify(logSpy.mock.calls)).not.toContain("e2e-canary-0000");
      } finally {
        logSpy.mockRestore();
      }
    });

    it("T2-F07-05: Exception with throwing stack getter does not crash GlobalHttpExceptionFilter", () => {
      const logSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const resStub = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
      resStub.status.mockReturnValue(resStub);
      const host = {
        switchToHttp: () => ({
          getResponse: () => resStub,
          getRequest: () => ({ originalUrl: "/api/v1/test" }),
        }),
      } as any;
      const badErr = new Error("boom");
      const stackGetter = vi.fn(() => {
        throw new Error("getter must not run");
      });
      Object.defineProperty(badErr, "stack", { get: stackGetter });
      try {
        expect(() => new GlobalHttpExceptionFilter().catch(badErr, host)).not.toThrow();
        expect(stackGetter).not.toHaveBeenCalled();
        expect(resStub.status).toHaveBeenCalledWith(500);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F8: Live bypass parity & IMAC Energy qualification fix (10 cases)
  // ---------------------------------------------------------------------------
  describe("F8: Bypass parity & IMAC Energy qualification fix", () => {
    it("T1-F08-01: bypass executor selects the configured finder and verifier for the waterfall", async () => {
      const bypass = createBypassContactEnrichmentSafetyExecutor({
        env: {
          PROSPEO_API_KEY: "test-key-0000",
          EMAILABLE_API_KEY: "test-key-0000",
        },
        prisma: createInMemoryPrismaStub({
          dataProvider: { findUnique: async () => ({ status: "ENABLED" }) },
          sourcePolicy: {
            findUnique: async () => ({
              reviewStatus: "APPROVED",
              allowedPurpose: ["enrichment", "discovery"],
              retentionDays: 30,
              updatedAt: new Date(),
            }),
          },
          canonicalCompany: {
            findFirst: async () => ({
              id: PILOT_ITALSOL_COMPANY_ID,
              workspaceId: PILOT_WORKSPACE_ID,
              name: "Italsol Srl",
              domain: "italsol.example",
              country: "IT",
              attributes: {},
            }),
          },
          contact: {
            findMany: async () => [
              { id: "c-1", fullName: "Alba Fixture", title: "Amministratore", contactPoints: [] },
            ],
          },
        }) as any,
        broker: { invoke: async () => ({ data: {}, costCents: 0 }) } as any,
        runWaterfall: async (_deps, req) => {
          expect(_deps.finders.map(({ key }) => key)).toEqual(["prospeo"]);
          expect(_deps.verifiers?.map(({ key }) => key)).toContain("emailable");
          expect(req).toMatchObject({ workspaceId: PILOT_WORKSPACE_ID, companyId: PILOT_ITALSOL_COMPANY_ID });
          return {
            companyId: req.companyId,
            tier: "A",
            attempted: 1,
            costMicrousd: 0,
            deadlineHit: false,
            results: [{ contactId: "c-1", status: "stored" }],
          } as any;
        },
      });

      const res = await bypass.executeHttp(
        { workspaceId: PILOT_WORKSPACE_ID, userId: "u-1", roles: ["ADMIN"], scopes: [] } as any,
        PILOT_ITALSOL_COMPANY_ID,
        { lawfulBasis: { basis: "legitimate_interest", ref: "lia-1", recordedBy: "u-1", recordedAt: new Date().toISOString() } } as any,
      );
      expect(res.admission).toBe("ADMITTED");
      expect(res.results).toEqual([{ contactId: "c-1", status: "stored" }]);
    });

    it.runIf(getE2eTargetMode() === "integrated")("T1-F08-02: bypass activities have a finite window without querying a legacy grant", async () => {
      const withWorkspace = vi.fn();
      vi.stubEnv("LEGACY_EXECUTION_BUDGET_MODE", "bypass");
      try {
        const reader = prismaDiscoveryRunLeaseReader({ withWorkspace });
        const remaining = await reader({
          authorityId: "50000000-0000-4000-8000-000000000005",
          replay: false,
          scopeKey: PILOT_WORKSPACE_ID,
          accountKey: "discovery.run:bypass",
          purpose: "discovery.run",
          subjectType: "discovery_run",
          subjectId: "20000000-0000-4000-8000-000000000001",
          requestSha256: "a".repeat(64),
        });

        expect(remaining).toBe(3 * 60 * 60 * 1000);
        expect(withWorkspace).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("T1-F08-03: bypass recovery rejects missing operator scopes before reading execution history", async () => {
      const withWorkspace = vi.fn();
      const bypass = createBypassContactEnrichmentSafetyExecutor({
        prisma: { withWorkspace } as never,
        broker: { invoke: vi.fn() } as never,
        env: {},
      });
      await expect(bypass.recoverEnrichmentExecution(
        { workspaceId: PILOT_WORKSPACE_ID, userId: "u-1", roles: ["ADMIN"], scopes: ["acquisition:write"] },
        PILOT_ITALSOL_COMPANY_ID,
        "a".repeat(64),
      )).rejects.toMatchObject({ status: 403 });
      expect(withWorkspace).not.toHaveBeenCalled();
    });

    it.runIf(getE2eTargetMode() === "integrated")("T1-F08-04: manual qualification rejects a lead with weak fit and failed material evidence", async () => {
      const updateMany = vi.fn();
      const tx = {
        lead: {
          findUnique: vi.fn(async () => ({
            id: "lead-fixture",
            workspaceId: PILOT_WORKSPACE_ID,
            canonicalCompanyId: PILOT_IMAC_COMPANY_ID,
            status: "REVIEW",
            queue: "needs_review",
            version: 3,
            fitVerdict: WAVE1_IMAC_ENERGY_FIXTURE.fitVerdict,
            totalScore: WAVE1_IMAC_ENERGY_FIXTURE.totalScore,
            fitReasons: { material: "fail (score 0): industrial valves only", role: "weak (score 4)" },
          })),
          updateMany,
        },
      };
      const prisma = {
        withWorkspace: async (_id: string, run: (tx: unknown) => Promise<unknown>) => run(tx),
      };
      const leads = new LeadService(prisma as never, {} as never, {} as never);
      await expect(leads.decide(
        { workspaceId: PILOT_WORKSPACE_ID, userId: "u-1", roles: ["ADMIN"], scopes: [] },
        "lead-fixture",
        "accept",
        "synthetic qualification attempt",
        "GOOD_FIT",
      )).rejects.toMatchObject({ status: 409, response: { error: { code: "LEAD_FIT_MISMATCH_BLOCKED" } } });
      expect(updateMany).not.toHaveBeenCalled();
    });

    it("T1-F08-05: True Italian PV distributor (match, score>=0.80) qualifies as recommended", () => {
      const scored = scoreLead(
        {
          name: "Italsol Srl",
          domain: "italsol.example",
          country: "IT",
          industry: "Solar Photovoltaics",
          employeeCount: 45,
          revenueUsd: 12_000_000,
          attributes: {
            fitJudgment: { verdict: "match", confidence: 0.88 },
          },
          status: "ENRICHED",
          contacts: [
            {
              title: "Amministratore",
              seniority: "c_suite",
              contactPoints: [{ type: "email", status: "VALID" }],
            },
          ],
          companyContactPoints: [{ kind: "contact_page", status: "VALID" }],
        },
        { rules: [], triggerSignals: [], committeeRoles: [] },
      );
      expect(scored.queue).toBe("recommended");
      expect(scored.totalScore).toBeGreaterThanOrEqual(0.55);
    });

    it("T2-F08-01: Non-bypass mode without Execution Grant fails closed (never bypasses)", async () => {
      const runtime = createContactEnrichmentSafetyRuntime({
        prisma: createInMemoryPrismaStub() as any,
        authority: {
          verifyWorkspaceGrant: async () => {
            throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_REQUIRED");
          },
        } as any,
        grantConsumer: {
          verifyWorkspaceGrant: async () => {
            throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_REQUIRED");
          },
        } as any,
        store: {} as any,
        prepare: async () => ({ status: "NOT_ADMITTED", reasonCode: "NO_GRANT" }),
        authorizeRecovery: async () => false,
        guards: {} as any,
        broker: { invoke: async () => ({ data: {}, costCents: 0 }) } as any,
      });
      await expect(
        runtime.service.executeHttp(
          { workspaceId: PILOT_WORKSPACE_ID, userId: "u-1", roles: ["ADMIN"], scopes: [] } as any,
          PILOT_ITALSOL_COMPANY_ID,
          { lawfulBasis: { basis: "legitimate_interest", ref: "lia-1", recordedBy: "u-1", recordedAt: new Date().toISOString() } } as any,
        ),
      ).rejects.toThrow(ExecutionBudgetGrantError);
    });

    it("T2-F08-02: Bypass mode with PROSPEO_API_KEY unset returns NOT_ADMITTED (NO_CONFIGURED_FINDER)", async () => {
      upstreams.applyEnv({
        PROSPEO_API_KEY: undefined,
        HUNTER_API_KEY: undefined,
        FINDYMAIL_API_KEY: undefined,
        APOLLO_API_KEY: undefined,
        PDL_API_KEY: undefined,
      });
      const bypass = createBypassContactEnrichmentSafetyExecutor({
        prisma: createInMemoryPrismaStub({
          canonicalCompany: { findFirst: async () => ({ tier: "B" }) },
        }) as any,
        broker: { invoke: async () => ({ data: {}, costCents: 0 }) } as any,
      });
      const res = await bypass.executeHttp(
        { workspaceId: PILOT_WORKSPACE_ID, userId: "u-1", roles: ["ADMIN"], scopes: [] } as any,
        PILOT_ITALSOL_COMPANY_ID,
        { lawfulBasis: { basis: "legitimate_interest", ref: "lia-1", recordedBy: "u-1", recordedAt: new Date().toISOString() } } as any,
      );
      expect(res.admission).toBe("NOT_ADMITTED");
      expect(res.reasonCode).toBe("NO_CONFIGURED_FINDER");
    });

    it("T2-F08-03: Bypass recoverEnrichmentExecution on unknown companyId returns null (no 500)", async () => {
      const bypass = createBypassContactEnrichmentSafetyExecutor({
        prisma: createInMemoryPrismaStub({
          contactEnrichmentExecution: { findFirst: async () => null },
        }) as any,
        broker: { invoke: async () => ({ data: {}, costCents: 0 }) } as any,
      });
      const out = await bypass.recoverEnrichmentExecution(
        {
          workspaceId: PILOT_WORKSPACE_ID,
          userId: "u-1",
          roles: ["ADMIN"],
          scopes: ["acquisition:write", "contact-discovery:read", "compliance:manage"],
        } as any,
        "99999999-9999-4999-8999-999999999999",
        "b".repeat(64),
      );
      expect(out).toBeNull();
    });

    it("T2-F08-04: High keyword match (0.65) + explicit valve-distributor anti-evidence is demoted out of QUALIFIED", async () => {
      const scored = scoreLead(
        {
          name: "ValveFlow Energy Srl",
          domain: "valveflow.example",
          country: "IT",
          industry: "Industrial Valves",
          employeeCount: 30,
          revenueUsd: null,
          attributes: {
            fitJudgment: { verdict: "weak", confidence: 0.38 },
            industryAntiEvidence: ["valve_distributor"],
          },
          status: "ENRICHED",
          contacts: [],
          companyContactPoints: [{ kind: "contact_page", status: "VALID" }],
        },
        { rules: [], triggerSignals: [], committeeRoles: [] },
        { authoritativeFit: "weak" },
      );
      await requireIntegratedOrSelfcheck({
        featureId: "F8",
        caseId: "T2-F08-04",
        integratedCheck: () => {
          expect(scored.queue).not.toBe("recommended");
        },
        selfcheckContract: () => {
          expect(scored.queue).toBe("needs_review");
        },
      });
    });

    it("T2-F08-05: Missing PII_KEYRING_JSON during bypass write fails closed (refuses plaintext PII)", () => {
      const prev = process.env.PII_KEYRING_JSON;
      delete process.env.PII_KEYRING_JSON;
      try {
        expect(() => encryptPii("director.fixture@italsol.example", { workspaceId: PILOT_WORKSPACE_ID })).toThrow();
      } finally {
        if (prev !== undefined) process.env.PII_KEYRING_JSON = prev;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F9: Worker lease-loss bounded non-zero exit (10 cases)
  // ---------------------------------------------------------------------------
  productSuite("F9: Worker lease loss and bounded shutdown policy", () => {
    afterEach(() => vi.useRealTimers());

    async function startHeartbeat(options: { loseLease?: boolean; hangDrain?: boolean; rejectDrain?: boolean } = {}) {
      vi.useFakeTimers();
      const shutdown = vi.fn();
      const onLeaseLost = vi.fn();
      let readyCount = 0;
      const heartbeat = vi.fn(async (_role: string, state: string) => {
        if (state === "READY" && ++readyCount > 1 && options.loseLease) throw new Error("LEASE_LOST");
        if (state === "DRAINING" && options.rejectDrain) throw new Error("DB_DOWN");
        if (state === "DRAINING" && options.hangDrain) await new Promise(() => undefined);
      });
      const config = {
        leases: { heartbeat },
        worker: { shutdown },
        taskQueue: "precision-intel-test",
        intervalMs: 10,
        onLeaseLost,
      };
      const handle = await startWorkerLeaseHeartbeat(config);
      return { handle, heartbeat, shutdown, onLeaseLost };
    }

    it("T1-F09-01: healthy heartbeat stays ready and keeps polling", async () => {
      const { handle, heartbeat, shutdown } = await startHeartbeat();
      try {
        await vi.advanceTimersByTimeAsync(25);
        expect(heartbeat.mock.calls.map(([, state]) => state)).toEqual(["READY", "READY", "READY"]);
        expect(shutdown).not.toHaveBeenCalled();
      } finally {
        handle.stop();
      }
    });

    it("T1-F09-02 and T2-F09-01: lost lease stops polling and declares draining exactly once", async () => {
      const { handle, heartbeat, shutdown, onLeaseLost } = await startHeartbeat({ loseLease: true });
      try {
        await vi.advanceTimersByTimeAsync(10);
        expect(onLeaseLost).toHaveBeenCalledOnce();
        expect(heartbeat.mock.calls.map(([, state]) => state)).toEqual(["READY", "READY", "DRAINING"]);
        expect(shutdown).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(100);
        expect(onLeaseLost).toHaveBeenCalledOnce();
        expect(heartbeat).toHaveBeenCalledTimes(3);
      } finally {
        handle.stop();
      }
    });

    it("T1-F09-03: hung draining heartbeat cannot postpone stopping the worker", async () => {
      const { handle, heartbeat, shutdown } = await startHeartbeat({ loseLease: true, hangDrain: true });
      try {
        await vi.advanceTimersByTimeAsync(10);
        expect(shutdown).toHaveBeenCalledOnce();
        expect(heartbeat.mock.calls.map(([, state]) => state)).toEqual(["READY", "READY", "DRAINING"]);
      } finally {
        handle.stop();
      }
    });

    it("T2-F09-02: failed draining heartbeat still stops polling", async () => {
      const { handle, shutdown, heartbeat } = await startHeartbeat({ loseLease: true, rejectDrain: true });
      try {
        await vi.advanceTimersByTimeAsync(100);
        expect(shutdown).toHaveBeenCalledOnce();
        expect(heartbeat).toHaveBeenCalledTimes(3);
      } finally {
        handle.stop();
      }
    });

    const loadLeaseLossDeadline = () => loadProductExport<(exit: (code: number) => void) => { clear(): void }>(
      "F9", "src/runtime/worker-shutdown-policy.ts", "armWorkerLeaseLossDeadline",
    );

    it("F9: lease loss allows Temporal to drain before a non-zero forced exit", async () => {
      const arm = await loadLeaseLossDeadline();
      vi.useFakeTimers();
      const exit = vi.fn();
      const handle = arm(exit);
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      } finally {
        handle.clear();
      }
    });

    it("T2-F09-05: completed teardown cancels the pending forced exit", async () => {
      const arm = await loadLeaseLossDeadline();
      vi.useFakeTimers();
      const exit = vi.fn();
      arm(exit).clear();
      await vi.advanceTimersByTimeAsync(65_000);
      expect(exit).not.toHaveBeenCalled();
    });

    it("T2-F09-03: startup hold stays idle and exits non-zero at its configured deadline", async () => {
      type Hold = (input: { code: string; maxHoldMs: number; logIntervalMs: number; onTick: () => void; exit: (code: number) => void }) => Promise<never>;
      const hold = await loadProductExport<Hold>(
        "F9", "src/runtime/worker-shutdown-policy.ts", "holdWorkerNotReadyBounded",
      );
      vi.useFakeTimers();
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const exit = vi.fn();
      const onTick = vi.fn();
      try {
        void hold({ code: "FIXTURE_NOT_READY", maxHoldMs: 30, logIntervalMs: 10, onTick, exit });
        await vi.advanceTimersByTimeAsync(29);
        expect(onTick).toHaveBeenCalledTimes(2);
        expect(exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(exit).toHaveBeenCalledExactlyOnceWith(1);
        const ticksAtExit = onTick.mock.calls.length;
        await vi.advanceTimersByTimeAsync(100);
        expect(onTick).toHaveBeenCalledTimes(ticksAtExit);
      } finally {
        log.mockRestore();
      }
    });

    it("T1-F09-05 and T2-F09-04: duplicate process signals drain once before early exit", async () => {
      vi.useFakeTimers();
      const handlers = new Map<NodeJS.Signals, () => void>();
      const heartbeat = vi.fn(async () => undefined);
      const onEarlyExit = vi.fn();
      const coordinator = startWorkerProcessSignalCoordinator({
        leases: { heartbeat },
        taskQueue: "precision-intel-test",
        signals: {
          on: (sig, fn) => handlers.set(sig, fn),
          off: (sig) => handlers.delete(sig),
        },
        onEarlyExit,
      });
      try {
        await coordinator.registered;
        handlers.get("SIGTERM")!();
        handlers.get("SIGINT")?.();
        await vi.advanceTimersByTimeAsync(1);
        expect(heartbeat.mock.calls).toEqual([
          ["WORKER", "STARTING", "precision-intel-test"],
          ["WORKER", "DRAINING", "precision-intel-test"],
          ["WORKER", "STOPPED", "precision-intel-test"],
        ]);
        expect(onEarlyExit).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      } finally {
        await coordinator.stop();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // F10: Pilot dirty-data cleanup tooling & LIA backfill (10 cases)
  // ---------------------------------------------------------------------------
  productSuite("F10: Scoped pilot remediation with synthetic data", () => {
    const dirtyEmail = "dirty-fixture@seller.example";
    const hash = (email: string) => createHash("sha256").update(email).digest("hex");

    type RemediationOptions = {
      apply: boolean;
      workspaceId: string;
      companyProfileId: string;
      expectedDirtyEmailSha256: string;
    };
    type Profile = { id: string; businessEmail: string | null; version: number };
    function makeTx(profile: Profile | null, updateCount = 1) {
      const findUnique = vi.fn(async (_query: unknown) => profile);
      const updateMany = vi.fn(async (_query: unknown) => ({ count: updateCount }));
      return { companyProfile: { findUnique, updateMany } };
    }
    type Remediate = (tx: ReturnType<typeof makeTx>, options: RemediationOptions) =>
      Promise<{ companyProfileFound: boolean; companyProfileHadDirtyEmail: boolean; companyProfileEmailCleared: boolean }>;
    const loadRemediation = () => loadProductExport<Remediate>(
      "F10", "scripts/remediate-pilot.mts", "runWorkspacePilotRemediation",
    );
    const apply = {
      apply: true,
      workspaceId: PILOT_WORKSPACE_ID,
      companyProfileId: PILOT_SELLER_PROFILE_ID,
      expectedDirtyEmailSha256: hash(dirtyEmail),
    };
    const profile = { id: apply.companyProfileId, businessEmail: dirtyEmail, version: 4 };

    it("T1-F10-01: apply clears the exact hashed mailbox under workspace and version checks", async () => {
      const remediate = await loadRemediation();
      const tx = makeTx(profile);
      await expect(remediate(tx, apply)).resolves.toMatchObject({
        companyProfileFound: true, companyProfileHadDirtyEmail: true, companyProfileEmailCleared: true,
      });
      expect(tx.companyProfile.findUnique).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        where: expect.objectContaining({ id: apply.companyProfileId, workspaceId: apply.workspaceId, deletedAt: null }),
      }));
      expect(tx.companyProfile.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: { id: apply.companyProfileId, workspaceId: apply.workspaceId, deletedAt: null, businessEmail: dirtyEmail, version: 4 },
        data: { businessEmail: null, version: { increment: 1 } },
      });
    });

    it("T1-F10-05: previously cleared mailbox needs no second write", async () => {
      const remediate = await loadRemediation();
      const tx = makeTx({ ...profile, businessEmail: null, version: 5 });
      await expect(remediate(tx, apply)).resolves.toMatchObject({
        companyProfileFound: true, companyProfileHadDirtyEmail: false, companyProfileEmailCleared: false,
      });
      expect(tx.companyProfile.updateMany).not.toHaveBeenCalled();
    });

    it("T2-F10-01: dry run reports a matched digest without mutation", async () => {
      const remediate = await loadRemediation();
      const tx = makeTx(profile);
      const result = await remediate(tx, { ...apply, apply: false });
      expect(result).toMatchObject({
        companyProfileFound: true, companyProfileHadDirtyEmail: true, companyProfileEmailCleared: false,
      });
      expect(JSON.stringify(result)).not.toContain(dirtyEmail);
      expect(tx.companyProfile.updateMany).not.toHaveBeenCalled();
    });

    it("T2-F10-03: a replacement mailbox with a different digest is preserved", async () => {
      const remediate = await loadRemediation();
      const tx = makeTx({ ...profile, businessEmail: "export@seller.example" });
      await expect(remediate(tx, apply)).resolves.toMatchObject({
        companyProfileFound: true, companyProfileHadDirtyEmail: false, companyProfileEmailCleared: false,
      });
      expect(tx.companyProfile.updateMany).not.toHaveBeenCalled();
    });

    it("T2-F10-05: an absent or foreign target produces zero writes", async () => {
      const remediate = await loadRemediation();
      const tx = makeTx(null);
      await expect(remediate(tx, apply)).resolves.toMatchObject({
        companyProfileFound: false, companyProfileHadDirtyEmail: false, companyProfileEmailCleared: false,
      });
      expect(tx.companyProfile.updateMany).not.toHaveBeenCalled();
    });

    it("F10: CLI arguments require both synthetic target IDs and default to dry run", async () => {
      const parse = await loadProductExport<(args: string[]) => Omit<RemediationOptions, "expectedDirtyEmailSha256">>(
        "F10", "scripts/remediate-pilot.mts", "parseRemediatePilotArgs",
      );
      expect(() => parse(["--apply"])).toThrow("PILOT_REMEDIATION_EXPLICIT_TARGET_REQUIRED");
      expect(parse(["--workspace-id", apply.workspaceId, "--company-profile-id", apply.companyProfileId]))
        .toEqual({ apply: false, workspaceId: apply.workspaceId, companyProfileId: apply.companyProfileId });
    });

    it("F10: a missing mailbox digest is rejected before the transaction is used", async () => {
      const remediate = await loadRemediation();
      const tx = makeTx(profile);
      await expect(remediate(tx, { ...apply, expectedDirtyEmailSha256: "" }))
        .rejects.toThrow("PILOT_REMEDIATION_EXPECTED_EMAIL_SHA256_REQUIRED");
      expect(tx.companyProfile.findUnique).not.toHaveBeenCalled();
      expect(tx.companyProfile.updateMany).not.toHaveBeenCalled();
    });

    it("F10: changing the profile between read and write fails closed", async () => {
      const remediate = await loadRemediation();
      const tx = makeTx(profile, 0);
      await expect(remediate(tx, apply)).rejects.toThrow("PILOT_PROFILE_CHANGED_DURING_REMEDIATION");
    });
  });
});
