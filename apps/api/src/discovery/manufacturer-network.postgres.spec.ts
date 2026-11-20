import { fetchPageHttpFirst } from "../adapters/http-first-fetch";
import {
  loadReviewedManufacturerLegalNames,
  manufacturerIdentityValueSha256,
} from "./manufacturer-network-identity";
import { readFileSync } from "node:fs";
import { S3Client } from "@aws-sdk/client-s3";
import { DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION } from "./discovery-company-materialization-ctx";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("../model-runtime/structured-task-runtime-bridge", () => ({
  executeStructuredTaskWithRuntime: vi.fn(),
}));
import { executeStructuredTaskWithRuntime } from "../model-runtime/structured-task-runtime-bridge";
import { PrismaService } from "../prisma/prisma.service";
import { PostgresBudgetStore } from "../tools/budget-store";
import { ToolBroker } from "../tools/tool-broker";
import { ToolRegistry } from "../tools/tool-registry";
import { RateLimiter } from "../tools/rate-limiter";
import {
  searxngSearchTool,
  createCrawl4aiFetchTool,
} from "../tools/builtin-tools";
import { GenericOperationArtifactExecution } from "../durable-results/artifact/generic-operation-artifact.execution";
import { GenericOperationArtifactRepository } from "../durable-results/artifact/generic-operation-artifact.repository";
import { GenericOperationArtifactService } from "../durable-results/artifact/generic-operation-artifact.service";
import {
  S3GenericOperationArtifactStore,
  ArtifactStorageError,
} from "../durable-results/artifact/generic-operation-artifact.store";
import {
  MemoryS3Client,
  BUCKET,
} from "../durable-results/artifact/generic-operation-artifact.store.spec-helper";
import { productArtifactMaterializerRegistry } from "../durable-results/artifact/generic-operation-artifact.runtime";
import { ArtifactSubjectBindingContract } from "../durable-results/artifact/artifact-subject-binding.contract";
import { ManufacturerNetworkProvider } from "./providers/manufacturer-network.provider";
import { corroborateCompanyBeforeFit } from "./run2/corroboration-enrichment";
import { loadManufacturerEvidence } from "./manufacturer-network-store";
import { judgeFitV2 } from "./fit-judge-v2";
import { currentEvidenceBundle } from "./evidence-bundle";
import { manufacturerNetworkExecutionSnapshot } from "./manufacturer-network-execution";
import { workspaceExecutionBudgetRequestScope } from "../execution-budget/execution-budget-request-scope";
import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import { CRITERION_IDS } from "./judgment/fit-rubric";
import {
  MANUFACTURER_CONFLICT_PROFILES,
  CONFIG,
  POLICY_ROW,
  COMPANY_INPUT,
  PAGE_URL,
  TEXT,
  SPAN,
} from "./manufacturer-network.test-fixture";

const ownerUrl = process.env.MANUFACTURER_TEST_DATABASE_URL;
const appUrl = process.env.MANUFACTURER_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl))
  throw new Error("MANUFACTURER_TEST_DATABASE_URL_PAIR_REQUIRED");
for (const value of [ownerUrl, appUrl])
  if (value) {
    const u = new URL(value);
    if (
      u.protocol !== "postgresql:" ||
      u.hostname !== "127.0.0.1" ||
      u.pathname !== "/global_test" ||
      u.port === "15433"
    )
      throw new Error("MANUFACTURER_DISPOSABLE_DATABASE_REQUIRED");
  }

describe.runIf(Boolean(ownerUrl && appUrl))(
  "manufacturer real Broker, persisted artifact, PG ACK and judgment",
  { timeout: 60000 },
  () => {
    let owner: PrismaClient;
    let app: PrismaService;
    let broker: ToolBroker;
    let provider: ManufacturerNetworkProvider;
    let budgets: PostgresBudgetStore;
    let artifactStore: S3GenericOperationArtifactStore;
    let realS3: S3Client | undefined;
    const workspaceId = randomUUID(),
      companyId = randomUUID(),
      runId = randomUUID(),
      planId = randomUUID(),
      icpId = randomUUID(),
      sellerId = randomUUID(),
      authorityId = randomUUID();
    const snapshot = manufacturerNetworkExecutionSnapshot(planId, {
      attemptId: randomUUID(),
      manufacturerNetworkRevision: "manufacturer-network/v2" as const,
    })!;
    const scope = workspaceExecutionBudgetRequestScope({
      operation: "POST /query-plans/:planId/execute",
      planId,
      body: snapshot.body,
    });
    const binding: ExecutionBudgetBinding = {
      ...scope,
      scopeKey: workspaceId,
      authorityId,
      accountKey: `workspace:${scope.requestSha256}`,
      replay: false,
    };
    const args = {
      workspaceId,
      companyId,
      runId,
      icpId,
      enrichmentSlot: 0,
      manufacturerNetworkExecution: snapshot,
    };
    let searchWires = 0,
      fetchWires = 0;
    const config = {
      ...CONFIG,
      independenceAttestations: CONFIG.independenceAttestations.map((a) => ({
        ...a,
        workspaceId,
        companyId,
      })),
    };
    const admitProbe = (phase: "lookup" | "fetch", identitySha256: string) =>
      app.withWorkspace(workspaceId, async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ admitted: boolean }>
        >`SELECT public.admit_manufacturer_network_probe_v1(${workspaceId}::uuid,${companyId}::uuid,${runId}::uuid,${authorityId}::uuid,${phase},${identitySha256}) AS admitted`;
        return rows[0]?.admitted === true;
      });
    let sourcePage: { url: string; text: string } | undefined;
    let firstEvidence: unknown;
    beforeAll(async () => {
      owner = new PrismaClient({ datasourceUrl: ownerUrl });
      const old = process.env.APP_DATABASE_URL;
      process.env.APP_DATABASE_URL = appUrl;
      try {
        app = new PrismaService();
      } finally {
        if (old === undefined) delete process.env.APP_DATABASE_URL;
        else process.env.APP_DATABASE_URL = old;
      }
      const [role] = await app.$queryRaw<
        Array<{ superuser: string; bypass: boolean }>
      >`SELECT current_setting('is_superuser') AS superuser,(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass`;
      expect(role).toEqual({ superuser: "off", bypass: false });
      await owner.workspace.create({
        data: { id: workspaceId, name: "Manufacturer isolated synthetic test" },
      });
      await owner.companyProfile.create({
        data: { id: sellerId, workspaceId, name: "Seller GmbH" },
      });
      await owner.icpDefinition.create({
        data: {
          id: icpId,
          workspaceId,
          companyId: sellerId,
          name: "German pump distribution",
          targetMarkets: ["DE"],
        },
      });
      await owner.discoveryQueryPlan.create({
        data: {
          id: planId,
          workspaceId,
          icpId,
          status: "READY",
          queries: [{ filters: { procurement_scenario: "distribution" } }],
        },
      });
      await owner.discoveryRun.create({
        data: {
          id: runId,
          workspaceId,
          planId,
          icpId,
          status: "RUNNING",
          materializationContractVersion:
            DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION,
        },
      });
      await owner.canonicalCompany.create({
        data: {
          ...COMPANY_INPUT,
          id: companyId,
          workspaceId,
          dedupeKey: "d:acme.example",
        },
      });
      await owner.discoveryCompanyJob.create({
        data: {
          workspaceId,
          runId,
          canonicalCompanyId: companyId,
          stage: "profiling",
          verdictQuick: "match",
        },
      });
      await owner.dataProvider.upsert({
        where: { key: "manufacturer_network" },
        create: {
          key: "manufacturer_network",
          class: "industry_data",
          status: "ENABLED",
          config,
        },
        update: { status: "ENABLED", config },
      });
      await owner.sourcePolicy.upsert({
        where: { domain: POLICY_ROW.domain },
        create: {
          ...POLICY_ROW,
          allowedPurpose: ["enrichment"],
          allowedPaths: ["/en/locations/europe/de"],
          disallowedPaths: undefined,
        },
        update: { reviewStatus: "APPROVED" },
      });
      await owner.$executeRaw`INSERT INTO execution_budget_authority(id,scope_key,authority_kind,workspace_id,issuer,audience,jti,token_sha256,schema_version,purpose,subject_type,subject_id,request_sha256,currency,unit,cap_microusd,runs_consumed,issued_at,not_before,expires_at,consumed_at)
  VALUES(${authorityId}::uuid,${workspaceId},'WORKSPACE_GRANT',${workspaceId}::uuid,'https://control.example','global-backend:execution-budget',${randomUUID()}::uuid,${"f".repeat(64)},'execution-budget-grant/v1','discovery.run','discovery_run',${scope.subjectId},${scope.requestSha256},'USD','microusd',1000000,0,now()-interval '30 seconds',now()-interval '20 seconds',now()+interval '4 minutes',now()-interval '10 seconds')`;
      budgets = new PostgresBudgetStore(app);
      await budgets.open({
        scopeKey: workspaceId,
        authorityId,
        accountKey: binding.accountKey,
      });
      const s3ConfigFile = process.env.MANUFACTURER_TEST_S3_CONFIG_FILE;
      const s3Config = s3ConfigFile
        ? (JSON.parse(readFileSync(s3ConfigFile, "utf8")) as {
            endpoint: string;
            accessKeyId: string;
            secretAccessKey: string;
            bucket: string;
          })
        : undefined;
      if (
        s3Config &&
        (new URL(s3Config.endpoint).hostname !== "127.0.0.1" ||
          !/^manufacturer-network-[a-f0-9]{8}$/u.test(s3Config.bucket))
      )
        throw new Error("MANUFACTURER_ISOLATED_S3_REQUIRED");
      realS3 = s3Config
        ? new S3Client({
            endpoint: s3Config.endpoint,
            region: "us-east-1",
            forcePathStyle: true,
            credentials: {
              accessKeyId: s3Config.accessKeyId,
              secretAccessKey: s3Config.secretAccessKey,
            },
            maxAttempts: 1,
            requestChecksumCalculation: "WHEN_REQUIRED",
          })
        : undefined;
      const store = (artifactStore = new S3GenericOperationArtifactStore({
        client: realS3 ?? new MemoryS3Client(),
        bucket: s3Config?.bucket ?? BUCKET,
      }));
      const artifactExecution = new GenericOperationArtifactExecution({
        withWorkspace: (w, fn) => app.withWorkspace(w, fn),
        binding: new ArtifactSubjectBindingContract(),
        service: new GenericOperationArtifactService(
          new GenericOperationArtifactRepository(app),
          store,
          budgets,
        ),
        materializers: productArtifactMaterializerRegistry(),
      });
      const registry = new ToolRegistry();
      registry.register({
        ...searxngSearchTool,
        execute: async (_input, ctx) => {
          await ctx.beforePhysicalWire?.();
          searchWires++;
          return {
            data: { results: [{ url: sourcePage?.url ?? PAGE_URL }] },
            costCents: 0,
          };
        },
      });
      process.env.HTTP_FIRST_FETCH = "on";
      registry.register(
        createCrawl4aiFetchTool({
          isAllowedByRobots: async () => true,
          crawlUrl: async () => {
            throw new Error("MANUFACTURER_RENDERER_FORBIDDEN");
          },
          fetchHttpFirst: (url, options) =>
            fetchPageHttpFirst(url, {
              ...options,
              fetchHtml: async () => {
                if (
                  options?.hooks?.authorizeExternalAction &&
                  !(await options.hooks.authorizeExternalAction())
                )
                  return null;
                await options?.hooks?.beforePhysicalWire?.();
                fetchWires++;
                const text = sourcePage?.text ?? TEXT;
                const markup = text
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => {
                    const h = /^(#{1,6})\s+(.*)$/u.exec(line);
                    return h
                      ? h[2] === "Location types"
                        ? '<div class="field--label field--label--inline">Location types</div>'
                        : `<h${h[1]!.length}><div>${h[2]}</div></h${h[1]!.length}>`
                      : `<p>${line.replace(/\[([^\]]+)\]\((https:[^)]+)\)/gu, '<a href="$2">$1</a>')}</p>`;
                  })
                  .join("");
                const filler =
                  "Industrial distribution support and profile description. ".repeat(
                    6,
                  );
                return {
                  status: 200,
                  contentType: "text/html",
                  body: Buffer.from(
                    `<html><head><title>${text.split("\n")[0]?.replace(/^#+ /u, "")}</title></head><body class="path-node page-node-type-locations"><div class="dialog-off-canvas-main-canvas"><div class="preface"><div class="page-title">${/<h1>.*?<\/h1>/u.exec(markup)?.[0] ?? ""}</div></div><main class="container-fluid g-0"><section><article class="locations full clearfix"><p>${filler}</p>${markup.replace(/<h1>.*?<\/h1>/u, "")}<button class="close"><span>×</span></button></article></section><h2>Unrelated section</h2></main></div></body></html>`,
                  ),
                };
              },
            }),
        }),
      );
      broker = new ToolBroker({
        registry,
        budgetStore: budgets,
        limiter: new RateLimiter(),
        artifactExecution,
        sourcePolicyReader: async () => ({
          suspended: false,
          allowedPurpose: ["enrichment"],
        }),
      });
      provider = new ManufacturerNetworkProvider({
        broker,
        readIdentityAliases: (subject, references) =>
          app.withWorkspace(subject.workspaceId, (tx) =>
            loadReviewedManufacturerLegalNames(tx, subject, references),
          ),
        readArtifactSubject: (w, c, id) =>
          app.withWorkspace(w, async (tx) => {
            const rows = await tx.$queryRaw<
              Array<{ bound: boolean }>
            >`SELECT EXISTS(SELECT 1 FROM find_workspace_generic_operation_artifacts_by_subject_v1(${w}::uuid,'company',${c}::uuid) WHERE artifact_id=${id}::uuid) AS bound`;
            return rows[0]?.bound === true;
          }),
        loadConfiguration: async () => {
          const row = await app.dataProvider.findUnique({
            where: { key: "manufacturer_network" },
            select: { status: true, config: true },
          });
          if (!row) return undefined;
          return { ...row, policies: await app.sourcePolicy.findMany() };
        },
      });
    });
    afterAll(async () => {
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
      realS3?.destroy();
    });
    it("fails closed for legacy calls, then persists real receipts and ACKs atomically into the qualified view", async () => {
      const deps = {
        prisma: app,
        providers: { routeEnrichment: async () => [provider] } as never,
      };
      await corroborateCompanyBeforeFit(
        deps,
        { ...args, manufacturerNetworkExecution: undefined },
        binding,
      );
      expect([searchWires, fetchWires]).toEqual([0, 0]);
      // Inject a local failure after the real proof/FieldEvidence/ACK writes, before commit.
      // Retry must replay durable bytes and atomically apply the entire business batch.
      let failAfterProof = true;
      const faultingPrisma = {
        withWorkspace: <T>(
          w: string,
          fn: (
            tx: import("@prisma/client").Prisma.TransactionClient,
          ) => Promise<T>,
        ) =>
          app.withWorkspace(w, async (tx) => {
            const value = await fn(tx);
            const count = await tx.manufacturerNetworkEvidence.count({
              where: { workspaceId, companyId, runId },
            });
            if (failAfterProof && count === 1) {
              failAfterProof = false;
              throw new Error("MANUFACTURER_TEST_ATOMIC_ROLLBACK");
            }
            return value;
          }),
      };
      await expect(
        corroborateCompanyBeforeFit(
          { ...deps, prisma: faultingPrisma as never },
          args,
          binding,
        ),
      ).rejects.toThrow("MANUFACTURER_TEST_ATOMIC_ROLLBACK");
      expect(
        await owner.manufacturerNetworkEvidence.count({
          where: { workspaceId, companyId, runId },
        }),
      ).toBe(0);
      expect(
        await owner.fieldEvidence.count({
          where: {
            workspaceId,
            entityId: companyId,
            providerKey: "manufacturer_network",
          },
        }),
      ).toBe(0);
      const rolledBackAcks = await owner.$queryRaw<
        Array<{ n: bigint }>
      >`SELECT count(*) AS n FROM execution_domain_ack WHERE scope_key=${workspaceId} AND domain_ack_key=encode(public.digest(${companyId}||':'||operation_id::text||':enrichment','sha256'),'hex')`;
      expect(rolledBackAcks[0]!.n).toBe(0n);
      expect([searchWires, fetchWires]).toEqual([1, 1]);
      await corroborateCompanyBeforeFit(deps, args, binding);
      expect([searchWires, fetchWires]).toEqual([1, 1]);
      const company = await owner.canonicalCompany.findUniqueOrThrow({
        where: { id: companyId },
      });
      firstEvidence = await app.withWorkspace(workspaceId, (tx) =>
        loadManufacturerEvidence(tx, args, company),
      );
      expect(firstEvidence).toMatchObject({
        schemaVersion: "manufacturer-network-evidence/v1",
        companyId,
        sourceUrl: PAGE_URL,
        spans: [SPAN],
      });
      const rows = await owner.$queryRaw<
        Array<{ n: bigint }>
      >`SELECT count(*) AS n FROM execution_domain_ack WHERE scope_key=${workspaceId} AND consumer IN ('SearchDiscoveryProvider','WebCrawlKnowledgeSource') AND domain_ack_key=encode(public.digest(${companyId}||':'||operation_id::text||':enrichment','sha256'),'hex')`;
      expect(rows[0]!.n).toBe(2n);
      expect(
        await owner.fieldEvidence.findFirst({
          where: {
            workspaceId,
            entityId: companyId,
            field: "manufacturer_network.evidence",
          },
        }),
      ).toMatchObject({
        sourceUrl: PAGE_URL,
        license: "Reviewed source-specific terms",
        allowedActions: ["display", "match"],
      });
      await corroborateCompanyBeforeFit(deps, args, binding);
      expect([searchWires, fetchWires]).toEqual([1, 1]);
    });
    it("reads verified artifact bytes on Broker replay without refreshing manifest capture time", async () => {
      const account = await budgets.attestAuthorized({
        scopeKey: workspaceId,
        authorityId,
        accountKey: binding.accountKey,
      });
      const result = await provider.enrichCompany(COMPANY_INPUT, {
        workspaceId,
        runId: binding.accountKey,
        manufacturerNetworkRevision: "manufacturer-network/v2" as const,
        artifactSubject: { subjectType: "company", subjectId: companyId },
        durableBudgetAuthority: account,
        admitManufacturerProbe: admitProbe,
      });
      expect(result.manufacturerEvidence).toEqual(firstEvidence);
      await expect(
        provider.enrichCompany(COMPANY_INPUT, {
          workspaceId,
          runId: binding.accountKey,
          manufacturerNetworkRevision: "manufacturer-network/v1",
          artifactSubject: { subjectType: "company", subjectId: companyId },
          durableBudgetAuthority: account,
          admitManufacturerProbe: admitProbe,
        }),
      ).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH");

      expect([searchWires, fetchWires]).toEqual([1, 1]);
      await expect(
        provider.enrichCompany(COMPANY_INPUT, {
          workspaceId,
          runId: binding.accountKey,
          manufacturerNetworkRevision: "manufacturer-network/v2" as const,
          artifactSubject: { subjectType: "company", subjectId: randomUUID() },
          durableBudgetAuthority: account,
          admitManufacturerProbe: admitProbe,
        }),
      ).resolves.toMatchObject({ matched: false });
    });
    it("keeps fixed operation identities replayable and rejects changed query/name/source/URL digests", async () => {
      const rows = await owner.$queryRaw<
        Array<{ phase: string; identity_sha256: string }>
      >`SELECT phase,identity_sha256 FROM manufacturer_network_probe WHERE workspace_id=${workspaceId}::uuid AND company_id=${companyId}::uuid AND run_id=${runId}::uuid`;
      expect(rows.map((x) => x.phase).sort()).toEqual(["fetch", "lookup"]);
      for (const row of rows) {
        expect(
          await admitProbe(
            row.phase as "lookup" | "fetch",
            row.identity_sha256,
          ),
        ).toBe(true);
        expect(
          await admitProbe(row.phase as "lookup" | "fetch", "e".repeat(64)),
        ).toBe(false);
      }
      const account = await budgets.attestAuthorized({
        scopeKey: workspaceId,
        authorityId,
        accountKey: binding.accountKey,
      });
      await expect(
        provider.enrichCompany(
          { ...COMPANY_INPUT, name: "Renamed Pumps GmbH" },
          {
            workspaceId,
            runId: binding.accountKey,
            manufacturerNetworkRevision: "manufacturer-network/v2" as const,
            artifactSubject: { subjectType: "company", subjectId: companyId },
            durableBudgetAuthority: account,
            admitManufacturerProbe: admitProbe,
          },
        ),
      ).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH");
      await owner.dataProvider.update({
        where: { key: "manufacturer_network" },
        data: {
          config: {
            ...config,
            sources: [
              {
                ...config.sources[0]!,
                domain: "another-manufacturer.example",
                knownCorporateDomains: ["another-manufacturer.example"],
              },
            ],
          },
        },
      });
      await expect(
        provider.enrichCompany(COMPANY_INPUT, {
          workspaceId,
          runId: binding.accountKey,
          manufacturerNetworkRevision: "manufacturer-network/v2" as const,
          artifactSubject: { subjectType: "company", subjectId: companyId },
          durableBudgetAuthority: account,
          admitManufacturerProbe: admitProbe,
        }),
      ).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH");
      expect([searchWires, fetchWires]).toEqual([1, 1]);
      await owner.dataProvider.update({
        where: { key: "manufacturer_network" },
        data: { config },
      });
      await expect(
        app.withWorkspace(
          workspaceId,
          (tx) =>
            tx.$executeRaw`UPDATE manufacturer_network_probe SET identity_sha256=${"e".repeat(64)} WHERE company_id=${companyId}::uuid`,
        ),
      ).rejects.toThrow();
    });

    it("rejects the same persisted URL for another company even with an explicit target review", async () => {
      const otherId = randomUUID();
      await owner.canonicalCompany.create({
        data: {
          ...COMPANY_INPUT,
          id: otherId,
          workspaceId,
          dedupeKey: "test:duplicate-domain-subject",
        },
      });
      await owner.dataProvider.update({
        where: { key: "manufacturer_network" },
        data: {
          config: {
            ...config,
            independenceAttestations: [
              ...config.independenceAttestations,
              { ...config.independenceAttestations[0]!, companyId: otherId },
            ],
          },
        },
      });
      const account = await budgets.attestAuthorized({
        scopeKey: workspaceId,
        authorityId,
        accountKey: binding.accountKey,
      });
      await expect(
        provider.enrichCompany(COMPANY_INPUT, {
          workspaceId,
          runId: binding.accountKey,
          manufacturerNetworkRevision: "manufacturer-network/v2" as const,
          artifactSubject: { subjectType: "company", subjectId: otherId },
          durableBudgetAuthority: account,
          admitManufacturerProbe: admitProbe,
        }),
      ).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH");
      expect([searchWires, fetchWires]).toEqual([1, 1]);
      await owner.dataProvider.update({
        where: { key: "manufacturer_network" },
        data: { config },
      });
    });

    it("runs the actual v2 judgment with T2 and blocks forged page citations", async () => {
      const company = await owner.canonicalCompany.findUniqueOrThrow({
        where: { id: companyId },
      });
      const manufacturerEvidence = await app.withWorkspace(workspaceId, (tx) =>
        loadManufacturerEvidence(tx, args, company),
      );
      expect(
        currentEvidenceBundle({ ...company, manufacturerEvidence }).coverage
          .corroborated,
      ).toBe(true);
      const data = {
        criteria: CRITERION_IDS.map((id) => ({
          id,
          applicable: true,
          score: 9,
          label: "pass",
          rationale: "Synthetic fixture",
          evidence: [{ kind: "directory", url: PAGE_URL, span: SPAN }],
        })),
        evidence_completeness: true,
        verdict_proposed: "FIT",
        refusal: { is_refusal: false, reason: null },
      };
      vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
        provider: "test",
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        data,
      } as never);
      const judgment = await judgeFitV2(
        {} as never,
        workspaceId,
        { seller: "Seller", seller_summary: "Industrial pumps" },
        { ...company, manufacturerEvidence },
        { judgePanelMode: "off", judgeCorroborationMode: "enforce" },
      );
      expect(judgment?.verdict).toBe("match");
      vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
        provider: "test",
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        data: {
          ...data,
          criteria: data.criteria.map((c) => ({
            ...c,
            evidence: [
              { kind: "directory", url: PAGE_URL, span: "distributor" },
            ],
          })),
        },
      } as never);
      // The actual v2 aggregator must preserve a genuine website quotation even
      // when manufacturer evidence contains exactly the same words.
      vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
        provider: "test",
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        data: {
          ...data,
          criteria: data.criteria.map((c) => ({
            ...c,
            evidence: [
              { kind: "website", url: "https://acme.example/", span: SPAN },
            ],
          })),
        },
      } as never);
      const sharedCompany = {
        ...company,
        attributes: {
          ...(company.attributes as object),
          website_profile: {
            trade_role: "distributor",
            own_manufacturing: false,
            evidence: [SPAN],
          },
        },
        manufacturerEvidence,
      };
      expect(
        (
          await judgeFitV2(
            {} as never,
            workspaceId,
            { seller: "Seller", seller_summary: "Industrial pumps" },
            sharedCompany,
            { judgePanelMode: "off", judgeCorroborationMode: "enforce" },
          )
        )?.verdict,
      ).toBe("match");
      // 'distributor' remains a literal source span. A made-up first-party quote must fail.
      vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
        provider: "test",
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        data: {
          ...data,
          criteria: data.criteria.map((c) => ({
            ...c,
            evidence: [
              {
                kind: "directory",
                url: PAGE_URL,
                span: "We supply every pump factory worldwide.",
              },
            ],
          })),
        },
      } as never);
      expect(
        (
          await judgeFitV2(
            {} as never,
            workspaceId,
            { seller: "Seller", seller_summary: null },
            { ...company, manufacturerEvidence },
            { judgePanelMode: "off" },
          )
        )?.verdict,
      ).toBe("weak");
    });
    it("enforces SQL sanitizer parity and rejects forged producer, subject, URL and workspace tuples", async () => {
      const evidence =
        firstEvidence as import("./manufacturer-network-evidence").ManufacturerNetworkEvidence;
      const [parity] = await owner.$queryRaw<
        Array<{ value: unknown }>
      >`SELECT public.sanitize_canonical_company_attributes_v3(${JSON.stringify({ manufacturer_network: { evidence } })}::jsonb) AS value`;
      expect(parity!.value).toEqual({ manufacturer_network: { evidence } });
      for (const mutation of [
        { ...evidence, workspaceId: randomUUID() },
        { ...evidence, operationId: randomUUID() },
        { ...evidence, artifactId: randomUUID() },
        { ...evidence, sourceUrl: PAGE_URL + "/other" },
      ]) {
        await expect(
          app.withWorkspace(
            workspaceId,
            (tx) =>
              tx.$queryRaw`SELECT public.commit_manufacturer_network_evidence_v1(${workspaceId}::uuid,${companyId}::uuid,${runId}::uuid,${authorityId}::uuid,${randomUUID()}::uuid,${JSON.stringify(mutation)}::jsonb)`,
          ),
        ).rejects.toThrow();
      }
      const [invalid] = await owner.$queryRaw<
        Array<{ value: unknown }>
      >`SELECT public.sanitize_canonical_company_attributes_v3(${JSON.stringify({ manufacturer_network: { evidence: { ...evidence, spans: ["person@acme.example"] } } })}::jsonb) AS value`;
      expect(invalid!.value).toEqual({});
    });

    it("cannot qualify forged raw attributes, another run/company/workspace, revoked source or suppressed subject", async () => {
      const company = await owner.canonicalCompany.findUniqueOrThrow({
        where: { id: companyId },
      });
      expect(
        currentEvidenceBundle({
          ...company,
          manufacturerEvidence: undefined,
        }).entries.some((e) => e.source_key === "manufacturer_network"),
      ).toBe(false);
      expect(
        await app.withWorkspace(workspaceId, (tx) =>
          loadManufacturerEvidence(
            tx,
            { ...args, runId: randomUUID() },
            company,
          ),
        ),
      ).toBeUndefined();
      expect(
        await app.withWorkspace(randomUUID(), (tx) =>
          loadManufacturerEvidence(tx, args, company),
        ),
      ).toBeUndefined();
      await owner.sourcePolicy.update({
        where: { domain: POLICY_ROW.domain },
        data: { reviewStatus: "SUSPENDED" },
      });
      expect(
        await app.withWorkspace(workspaceId, (tx) =>
          loadManufacturerEvidence(tx, args, company),
        ),
      ).toBeUndefined();
      await owner.sourcePolicy.update({
        where: { domain: POLICY_ROW.domain },
        data: { reviewStatus: "APPROVED" },
      });
      await owner.canonicalCompany.update({
        where: { id: companyId },
        data: { status: "SUPPRESSED" },
      });
      expect(
        await app.withWorkspace(workspaceId, (tx) =>
          loadManufacturerEvidence(tx, args, company),
        ),
      ).toBeUndefined();
      await owner.canonicalCompany.update({
        where: { id: companyId },
        data: { status: "NEW" },
      });
      await expect(
        app.withWorkspace(
          workspaceId,
          (tx) =>
            tx.$executeRaw`UPDATE manufacturer_network_evidence SET evidence='{}'::jsonb WHERE company_id=${companyId}::uuid`,
        ),
      ).rejects.toThrow();
    });
    it("qualifies a short canonical name only through referenced independent legal-name evidence and fails closed on drift", async () => {
      const aliasCompany = randomUUID();
      const fieldId = randomUUID();
      const legalName = "Alpine IndustrialSupply GmbH";
      const reference = {
        fieldEvidenceId: fieldId,
        valueSha256: manufacturerIdentityValueSha256(legalName),
      };
      await owner.canonicalCompany.create({
        data: {
          ...COMPANY_INPUT,
          id: aliasCompany,
          workspaceId,
          name: "Alpine",
          domain: "alpine.example",
          dedupeKey: "d:alpine.example",
        },
      });
      await owner.discoveryCompanyJob.create({
        data: {
          workspaceId,
          runId,
          canonicalCompanyId: aliasCompany,
          stage: "profiling",
          verdictQuick: "match",
        },
      });
      await owner.fieldEvidence.create({
        data: {
          id: fieldId,
          workspaceId,
          entityType: "company",
          entityId: aliasCompany,
          field: "website_profile.legal_name",
          value: legalName,
          providerKey: "website_profile",
          license: "public",
          allowedActions: ["display", "match"],
          dataClass: "green",
          sourceUrl: "https://alpine.example/impressum",
          fetchedAt: new Date(),
        },
      });
      await owner.dataProvider.update({
        where: { key: "manufacturer_network" },
        data: {
          config: {
            ...config,
            independenceAttestations: [
              ...config.independenceAttestations,
              {
                ...config.independenceAttestations[0]!,
                companyId: aliasCompany,
                targetDomain: "alpine.example",
                identityEvidenceRefs: [reference],
              },
            ],
          },
        },
      });
      sourcePage = {
        url: PAGE_URL.replace("/acme", "/alpine"),
        text: "# Alpine Industrial Supply GMBH\nCountry: Germany\nemployee@alpine.example\n## Location types\nService Centre\nDistributor",
      };
      const targetArgs = {
        ...args,
        companyId: aliasCompany,
        enrichmentSlot: 1,
      };
      await corroborateCompanyBeforeFit(
        {
          prisma: app,
          providers: { routeEnrichment: async () => [provider] } as never,
        },
        targetArgs,
        binding,
      );
      const company = await owner.canonicalCompany.findUniqueOrThrow({
        where: { id: aliasCompany },
      });
      expect(company.name).toBe("Alpine");
      const proof = await app.withWorkspace(workspaceId, (tx) =>
        loadManufacturerEvidence(tx, targetArgs, company),
      );
      expect(proof).toMatchObject({
        targetName: "Alpine",
        companyId: aliasCompany,
        identityEvidenceRefs: [reference],
        spans: ["Distributor"],
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of await artifactStore.read(
        (proof as { resultDigest: string }).resultDigest,
        "PERSONAL_DATA",
      ))
        chunks.push(chunk);
      const storedText = Buffer.concat(chunks).toString("utf8");
      expect(storedText).toContain('"emailDomains":["alpine.example"]');
      expect(storedText).not.toContain("employee@");
      expect(storedText).toContain("# Alpine Industrial Supply GMBH");

      expect(
        currentEvidenceBundle({ ...company, manufacturerEvidence: proof })
          .coverage.corroborated,
      ).toBe(true);
      await owner.fieldEvidence.update({
        where: { id: fieldId },
        data: { value: "Drifted Legal Name GmbH" },
      });
      expect(
        await app.withWorkspace(workspaceId, (tx) =>
          loadManufacturerEvidence(tx, targetArgs, company),
        ),
      ).toBeUndefined();
      await owner.fieldEvidence.update({
        where: { id: fieldId },
        data: { value: legalName, dataClass: "red" },
      });
      expect(
        await app.withWorkspace(workspaceId, (tx) =>
          loadManufacturerEvidence(tx, targetArgs, company),
        ),
      ).toBeUndefined();
      await owner.fieldEvidence.update({
        where: { id: fieldId },
        data: {
          dataClass: "green",
          sourceUrl: "https://manufacturer.example/alpine",
        },
      });
      expect(
        await app.withWorkspace(workspaceId, (tx) =>
          loadManufacturerEvidence(tx, targetArgs, company),
        ),
      ).toBeUndefined();
      sourcePage = undefined;
    });
    it("does not persist or qualify negated and wrong-profile relationships through real Broker receipts", async () => {
      const oversized = [
        {
          id: "oversized-tool-expired",
          repeats: 1800,
          tail: "Status: Expired",
        },
        {
          id: "oversized-normalizer-expired",
          repeats: 2200,
          tail: "Status: Expired",
        },
        { id: "oversized-tool-other", repeats: 1800, tail: "## Other Pumps" },
      ].map((c) => ({
        id: c.id,
        text: `${TEXT}\n${"Industrial distribution information. ".repeat(c.repeats)}\n${c.tail}`,
      }));
      for (const [index, fixture] of [
        ...MANUFACTURER_CONFLICT_PROFILES,
        ...oversized,
      ].entries()) {
        const targetId = randomUUID();
        const domain = `acme-fix-${index}.example`;
        await owner.canonicalCompany.create({
          data: {
            ...COMPANY_INPUT,
            id: targetId,
            workspaceId,
            domain,
            dedupeKey: `d:${domain}`,
          },
        });
        await owner.discoveryCompanyJob.create({
          data: {
            workspaceId,
            runId,
            canonicalCompanyId: targetId,
            stage: "profiling",
            verdictQuick: "match",
          },
        });
        await owner.dataProvider.update({
          where: { key: "manufacturer_network" },
          data: {
            config: {
              ...config,
              independenceAttestations: [
                ...config.independenceAttestations,
                {
                  ...config.independenceAttestations[0]!,
                  companyId: targetId,
                  targetDomain: domain,
                },
              ],
            },
          },
        });
        sourcePage = {
          url: PAGE_URL.replace("/acme", `/fix-${fixture.id}`),
          text: fixture.text.replaceAll(
            "https://acme.example/",
            `https://${domain}/`,
          ),
        };
        const targetArgs = {
          ...args,
          companyId: targetId,
          enrichmentSlot: index + 2,
        };
        const beforeWires = [searchWires, fetchWires];
        await corroborateCompanyBeforeFit(
          {
            prisma: app,
            providers: { routeEnrichment: async () => [provider] } as never,
          },
          targetArgs,
          binding,
        );
        expect(
          await owner.manufacturerNetworkEvidence.count({
            where: { workspaceId, companyId: targetId, runId },
          }),
          fixture.id,
        ).toBe(0);
        expect(
          await owner.fieldEvidence.count({
            where: {
              workspaceId,
              entityId: targetId,
              providerKey: "manufacturer_network",
            },
          }),
          fixture.id,
        ).toBe(0);
        const target = await owner.canonicalCompany.findUniqueOrThrow({
          where: { id: targetId },
        });
        expect(
          await app.withWorkspace(workspaceId, (tx) =>
            loadManufacturerEvidence(tx, targetArgs, target),
          ),
          fixture.id,
        ).toBeUndefined();
        const events = await owner.runEvent.findMany({
          where: {
            workspaceId,
            runId,
            type: "company_enrichment_observed",
            payload: { path: ["companyId"], equals: targetId },
          },
          select: { payload: true },
        });
        expect(
          events.map((e) => (e.payload as { status: string }).status),
          fixture.id,
        ).toEqual(["miss"]);
        expect(
          currentEvidenceBundle(target).entries.some(
            (e) => e.source_key === "manufacturer_network",
          ),
          fixture.id,
        ).toBe(false);
        if (fixture.id.startsWith("oversized-")) {
          expect(target.attributes).not.toHaveProperty("manufacturer_network");
          const account = await budgets.attestAuthorized({
            scopeKey: workspaceId,
            authorityId,
            accountKey: binding.accountKey,
          });
          const replay = await provider.enrichCompany(
            { ...COMPANY_INPUT, domain },
            {
              workspaceId,
              runId: binding.accountKey,
              manufacturerNetworkRevision: "manufacturer-network/v2",
              artifactSubject: { subjectType: "company", subjectId: targetId },
              durableBudgetAuthority: account,
              admitManufacturerProbe: (phase, identity) =>
                app.withWorkspace(workspaceId, async (tx) => {
                  const rows = await tx.$queryRaw<
                    Array<{ admitted: boolean }>
                  >`SELECT public.admit_manufacturer_network_probe_v1(${workspaceId}::uuid,${targetId}::uuid,${runId}::uuid,${authorityId}::uuid,${phase},${identity}) AS admitted`;
                  return rows[0]?.admitted === true;
                }),
            },
          );
          expect(replay.matched).toBe(false);
          expect([searchWires, fetchWires]).toEqual([
            beforeWires[0]! + 1,
            beforeWires[1]! + 1,
          ]);
          const artifacts = await owner.$queryRaw<
            Array<{ sha256: string }>
          >`SELECT m.sha256 FROM generic_operation_artifact m JOIN tool_budget_operation o ON o.id=m.operation_id JOIN manufacturer_network_probe p ON p.identity_sha256=o.operation_key AND p.workspace_id::text=o.scope_key WHERE p.workspace_id=${workspaceId}::uuid AND p.company_id=${targetId}::uuid AND p.phase='fetch'`;
          expect(artifacts).toHaveLength(1);
          const chunks: Uint8Array[] = [];
          for await (const chunk of await artifactStore.read(
            artifacts[0]!.sha256,
            "PERSONAL_DATA",
          ))
            chunks.push(chunk);
          expect(Buffer.concat(chunks).toString("utf8")).toBe("");
        }
        // Give the real v2 aggregator otherwise valid first-party evidence. It
        // must still abstain without an independent manufacturer proof/tier.
        vi.mocked(executeStructuredTaskWithRuntime).mockResolvedValue({
          provider: "test",
          model: "test",
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          data: {
            criteria: CRITERION_IDS.map((id) => ({
              id,
              applicable: true,
              score: 9,
              label: "pass",
              rationale: "Synthetic first-party fixture",
              evidence: [
                { kind: "website", url: `https://${domain}/`, span: SPAN },
              ],
            })),
            evidence_completeness: true,
            verdict_proposed: "FIT",
            refusal: { is_refusal: false, reason: null },
          },
        } as never);
        const firstParty = {
          ...target,
          attributes: {
            ...(target.attributes as object),
            website_profile: {
              trade_role: "distributor",
              own_manufacturing: false,
              evidence: [SPAN],
            },
          },
        };
        const rejected = await judgeFitV2(
          {} as never,
          workspaceId,
          { seller: "Seller", seller_summary: "Industrial pumps" },
          firstParty,
          { judgePanelMode: "off", judgeCorroborationMode: "enforce" },
        );
        expect(rejected?.verdict, fixture.id).toBe("weak");
        expect(
          (
            rejected?.judgmentRecord.sampling as {
              corroboration: { reason: string };
            }
          ).corroboration.reason,
          fixture.id,
        ).toBe("INSUFFICIENT_TIERS");
      }
      sourcePage = undefined;
    });

    it("keeps an unknown v2 capture under the same probe identity without a second physical wire", async () => {
      const targetId = randomUUID();
      const domain = "acme-unknown.example";
      await owner.canonicalCompany.create({
        data: {
          ...COMPANY_INPUT,
          id: targetId,
          workspaceId,
          domain,
          dedupeKey: `d:${domain}`,
        },
      });
      await owner.discoveryCompanyJob.create({
        data: {
          workspaceId,
          runId,
          canonicalCompanyId: targetId,
          stage: "profiling",
          verdictQuick: "match",
        },
      });
      await owner.dataProvider.update({
        where: { key: "manufacturer_network" },
        data: {
          config: {
            ...config,
            independenceAttestations: [
              ...config.independenceAttestations,
              {
                ...config.independenceAttestations[0]!,
                companyId: targetId,
                targetDomain: domain,
              },
            ],
          },
        },
      });
      sourcePage = {
        url: PAGE_URL.replace("/acme", "/unknown"),
        text: TEXT.replaceAll("acme.example", domain),
      };
      const before = [searchWires, fetchWires];
      const account = await budgets.attestAuthorized({
        scopeKey: workspaceId,
        authorityId,
        accountKey: binding.accountKey,
      });
      const ctx = {
        workspaceId,
        runId: binding.accountKey,
        manufacturerNetworkRevision: "manufacturer-network/v2" as const,
        artifactSubject: {
          subjectType: "company" as const,
          subjectId: targetId,
        },
        durableBudgetAuthority: account,
        admitManufacturerProbe: (phase: "lookup" | "fetch", identity: string) =>
          app.withWorkspace(workspaceId, async (tx) => {
            const rows = await tx.$queryRaw<
              Array<{ admitted: boolean }>
            >`SELECT public.admit_manufacturer_network_probe_v1(${workspaceId}::uuid,${targetId}::uuid,${runId}::uuid,${authorityId}::uuid,${phase},${identity}) AS admitted`;
            return rows[0]?.admitted === true;
          }),
      };
      const fault = vi
        .spyOn(artifactStore, "promote")
        .mockRejectedValueOnce(
          new ArtifactStorageError(
            "GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE",
          ),
        );
      try {
        await expect(
          provider.enrichCompany({ ...COMPANY_INPUT, domain }, ctx),
        ).rejects.toThrow();
      } finally {
        fault.mockRestore();
      }
      expect([searchWires, fetchWires]).toEqual([
        before[0]! + 1,
        before[1]! + 1,
      ]);
      const rows = await owner.$queryRaw<
        Array<{ status: string }>
      >`SELECT o.status::text FROM tool_budget_operation o JOIN manufacturer_network_probe p ON p.identity_sha256=o.operation_key AND p.workspace_id::text=o.scope_key WHERE p.workspace_id=${workspaceId}::uuid AND p.company_id=${targetId}::uuid AND p.phase='fetch'`;
      expect(rows).toEqual([{ status: "RESULT_UNKNOWN" }]);
      await expect(
        provider.enrichCompany({ ...COMPANY_INPUT, domain }, ctx),
      ).rejects.toThrow();
      await expect(
        provider.enrichCompany(
          { ...COMPANY_INPUT, domain },
          { ...ctx, manufacturerNetworkRevision: "manufacturer-network/v1" },
        ),
      ).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH");
      expect([searchWires, fetchWires]).toEqual([
        before[0]! + 1,
        before[1]! + 1,
      ]);
      sourcePage = undefined;
    });
  },
);
