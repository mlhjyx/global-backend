/**
 * R4-A1 Evidence 2.0 verification against the real Ubuntu development services.
 * Creates isolated UUID fixtures and removes them in finally.
 *
 * Run from apps/api:
 *   ALLOW_DEV_DB_VERIFIER=true DOTENV_CONFIG_PATH=/global/backend/apps/api/.env \
 *     node --import tsx scripts/verify-site-builder-r4-a1.mts
 */
import "dotenv/config";
import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type { EvidenceRefV2 } from "@global/contracts";
import { PrismaService } from "../src/prisma/prisma.service";
import { StorageService } from "../src/site-builder/storage.service";
import { EmbeddingsClient } from "../src/site-builder/embeddings.client";
import { DoclingClient } from "../src/site-builder/docling.client";
import { KbService } from "../src/site-builder/kb.service";
import { researchBrand } from "../src/site-builder/agents/brand-research";
import { createSiteBuilderActivities } from "../src/temporal/site-builder.activities";
import { ModelProviderRegistry } from "../src/model-gateway/model-provider.registry";
import { ModelRouter } from "../src/model-gateway/model-router";
import { RouterModelGateway } from "../src/model-gateway/router-model-gateway";
import { AiTraceSink } from "../src/model-gateway/ai-trace.sink";
import { buildGatewayProvider } from "../src/model-gateway/model-providers.config";
import {
  buildToolBroker,
  sourcePolicyReaderFrom,
} from "../src/tools/tool-broker.factory";
import { budgetLedger } from "../src/tools/budget";

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    hostname.toLowerCase(),
  );
}

function requireDevelopmentDatabase(): void {
  if (
    process.env.ALLOW_DEV_DB_VERIFIER !== "true" ||
    process.env.NODE_ENV === "production"
  ) {
    throw new Error(
      "refusing R4-A1 verifier: require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV",
    );
  }
  for (const [name, raw] of [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["APP_DATABASE_URL", process.env.APP_DATABASE_URL],
  ] as const) {
    if (!raw) throw new Error(`${name} is required`);
    const target = new URL(raw);
    if (!isLoopback(target.hostname) || target.pathname !== "/global_dev") {
      throw new Error(
        `refusing ${name} target ${target.hostname}${target.pathname}; require loopback/global_dev`,
      );
    }
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`  ✅ ${message}`);
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

interface StoredFact {
  key: string;
  value: string;
  evidence: EvidenceRefV2;
}

async function verifyImmutableLedgerRls(args: {
  owner: PrismaClient;
  app: PrismaService;
  workspaceId: string;
  otherWorkspaceId: string;
  siteId: string;
}): Promise<void> {
  const { owner, app, workspaceId, otherWorkspaceId, siteId } = args;
  const [sourceCount, refCount, firstSnapshot, firstRef] = await Promise.all([
    owner.siteEvidenceSourceSnapshot.count({ where: { siteId } }),
    owner.brandProfileEvidenceRef.count({ where: { siteId } }),
    owner.siteEvidenceSourceSnapshot.findFirstOrThrow({ where: { siteId } }),
    owner.brandProfileEvidenceRef.findFirstOrThrow({ where: { siteId } }),
  ]);
  const visibleA = await app.withWorkspace(workspaceId, (tx) =>
    tx.siteEvidenceSourceSnapshot.count({ where: { siteId } }),
  );
  const visibleB = await app.withWorkspace(otherWorkspaceId, (tx) =>
    tx.siteEvidenceSourceSnapshot.count({ where: { siteId } }),
  );
  const visibleUnset = await app.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count
      FROM site_evidence_source_snapshot
     WHERE site_id = ${siteId}::uuid`;
  const visibleRefsA = await app.withWorkspace(workspaceId, (tx) =>
    tx.brandProfileEvidenceRef.count({ where: { siteId } }),
  );
  const visibleRefsB = await app.withWorkspace(otherWorkspaceId, (tx) =>
    tx.brandProfileEvidenceRef.count({ where: { siteId } }),
  );
  const visibleRefsUnset = await app.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count
      FROM brand_profile_evidence_ref
     WHERE site_id = ${siteId}::uuid`;
  check(visibleA === sourceCount, "workspace A can read its snapshots");
  check(visibleB === 0, "workspace B cannot read workspace A snapshots");
  check(
    Number(visibleUnset[0]?.count ?? -1) === 0,
    "unset workspace sees zero snapshots",
  );
  check(visibleRefsA === refCount, "workspace A can read its evidence refs");
  check(
    visibleRefsB === 0,
    "workspace B cannot read workspace A evidence refs",
  );
  check(
    Number(visibleRefsUnset[0]?.count ?? -1) === 0,
    "unset workspace sees zero evidence refs",
  );

  let crossTenantRejected = false;
  try {
    await app.withWorkspace(otherWorkspaceId, (tx) =>
      tx.siteEvidenceSourceSnapshot.create({
        data: {
          id: randomUUID(),
          workspaceId: otherWorkspaceId,
          siteId,
          sourceKey: "cross-tenant-negative",
          sourceType: "intake",
          sourceRole: "fact_candidate",
          contentHash: "a".repeat(64),
          normalizationVersion: "evidence-text/1",
          snapshotText: "cross tenant fixture text",
          provenance: { test: true },
          dedupeKey: "b".repeat(64),
        },
      }),
    );
  } catch {
    crossTenantRejected = true;
  }
  check(crossTenantRejected, "cross-tenant snapshot provenance is rejected");

  let crossTenantRefRejected = false;
  try {
    await app.withWorkspace(otherWorkspaceId, (tx) =>
      tx.brandProfileEvidenceRef.create({
        data: {
          id: randomUUID(),
          workspaceId: otherWorkspaceId,
          siteId,
          brandProfileId: firstRef.brandProfileId,
          factIndex: 999,
          factKey: "cross_tenant_negative",
          sourceSnapshotId: firstRef.sourceSnapshotId,
          sourceContentHash: firstRef.sourceContentHash,
          quote: firstRef.quote,
          quoteStart: firstRef.quoteStart,
          quoteEnd: firstRef.quoteEnd,
          quotePrefix: firstRef.quotePrefix,
          quoteSuffix: firstRef.quoteSuffix,
        },
      }),
    );
  } catch {
    crossTenantRefRejected = true;
  }
  check(
    crossTenantRefRejected,
    "cross-tenant evidence ref provenance is rejected",
  );

  let updateRejected = false;
  try {
    await app.withWorkspace(workspaceId, (tx) =>
      tx.siteEvidenceSourceSnapshot.update({
        where: { id: firstSnapshot.id },
        data: { sourceKey: "tampered" },
      }),
    );
  } catch {
    updateRejected = true;
  }
  check(updateRejected, "app_user cannot mutate a frozen source snapshot");

  let refUpdateRejected = false;
  try {
    await app.withWorkspace(workspaceId, (tx) =>
      tx.brandProfileEvidenceRef.update({
        where: { id: firstRef.id },
        data: { factKey: "tampered" },
      }),
    );
  } catch {
    refUpdateRejected = true;
  }
  check(refUpdateRejected, "app_user cannot mutate a frozen evidence ref");
}

async function main(): Promise<void> {
  requireDevelopmentDatabase();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const app = new PrismaService();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const siteId = randomUUID();
  const runIds: string[] = [];
  let storage: StorageService | undefined;
  let verificationError: unknown;

  try {
    await Promise.all([owner.$connect(), app.$connect()]);

    console.log("① PostgreSQL role, FORCE RLS and grants");
    const role = await app.$queryRaw<
      { currentUser: string; isSuper: boolean; bypassRls: boolean }[]
    >`
      SELECT current_user AS "currentUser",
             r.rolsuper AS "isSuper",
             r.rolbypassrls AS "bypassRls"
        FROM pg_roles r
       WHERE r.rolname = current_user`;
    check(
      role[0]?.isSuper === false && role[0]?.bypassRls === false,
      `${role[0]?.currentUser} is non-superuser/non-BYPASSRLS`,
    );
    const tableSecurity = await owner.$queryRaw<
      { tableName: string; rowSecurity: boolean; forceRowSecurity: boolean }[]
    >`
      SELECT c.relname AS "tableName",
             c.relrowsecurity AS "rowSecurity",
             c.relforcerowsecurity AS "forceRowSecurity"
        FROM pg_class c
       WHERE c.oid IN (
         'site_evidence_source_snapshot'::regclass,
         'brand_profile_evidence_ref'::regclass
       )
       ORDER BY c.relname`;
    check(
      tableSecurity.length === 2 &&
        tableSecurity.every(
          (table) => table.rowSecurity && table.forceRowSecurity,
        ),
      "both Evidence 2.0 tables are ENABLE + FORCE RLS",
    );
    const grants = await owner.$queryRaw<
      { tableName: string; privileges: string[] }[]
    >`
      SELECT table_name AS "tableName",
             array_agg(privilege_type ORDER BY privilege_type)::text[] AS privileges
        FROM information_schema.role_table_grants
       WHERE grantee = 'app_user'
         AND table_name IN (
           'site_evidence_source_snapshot',
           'brand_profile_evidence_ref'
         )
       GROUP BY table_name
       ORDER BY table_name`;
    check(
      grants.length === 2 &&
        grants.every((grant) => grant.privileges.join(",") === "INSERT,SELECT"),
      "app_user has SELECT+INSERT only on immutable evidence ledgers",
    );

    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: "verify-r4-a1" },
        { id: otherWorkspaceId, name: "verify-r4-a1-other" },
      ],
    });
    await owner.site.create({
      data: {
        id: siteId,
        workspaceId,
        name: "KSB Evidence 2.0 Verification",
        slug: `verify-r4-a1-${siteId.slice(0, 8)}`,
        status: "building",
        intake: {
          company: { nameZh: "凯士比", nameEn: "KSB SE & Co. KGaA" },
          industry: "industrial pumps and valves",
          products: ["centrifugal pumps", "industrial valves"],
          targetMarkets: ["DE", "US"],
          hasWebsite: true,
          websiteUrl: "https://www.ksb.com",
          businessEmail: "private-verifier@example.com",
        } as Prisma.InputJsonValue,
        profile: {
          companyProfile: { positioning: "Industrial pump manufacturer" },
          contact: {
            email: "private-profile@example.com",
            phone: "+49 123 4567890",
          },
        } as Prisma.InputJsonValue,
      },
    });

    console.log("② real PostgreSQL RLS/FK/immutability for both ledgers");
    const ledgerText = "Verified Evidence 2.0 immutable ledger fixture.";
    const ledgerHash = sha256(ledgerText);
    const ledgerSnapshotId = randomUUID();
    const ledgerProfileId = randomUUID();
    const ledgerRefId = randomUUID();
    const ledgerEvidence: EvidenceRefV2 = {
      version: 2,
      evidenceRefId: ledgerRefId,
      sourceId: ledgerSnapshotId,
      sourceType: "intake",
      sourceRole: "fact_candidate",
      hashAlgorithm: "sha256",
      contentHash: ledgerHash,
      quote: ledgerText,
      selector: { start: 0, end: Array.from(ledgerText).length },
    };
    await owner.$transaction(async (tx) => {
      await tx.siteEvidenceSourceSnapshot.create({
        data: {
          id: ledgerSnapshotId,
          workspaceId,
          siteId,
          sourceKey: "verify:rls-ledger",
          sourceType: "intake",
          sourceRole: "fact_candidate",
          contentHash: ledgerHash,
          normalizationVersion: "evidence-text/1",
          snapshotText: ledgerText,
          provenance: { kind: "rls_verifier_fixture" },
          dedupeKey: sha256(`verify:rls-ledger:${siteId}`),
        },
      });
      await tx.brandProfile.create({
        data: {
          id: ledgerProfileId,
          workspaceId,
          siteId,
          version: 1,
          evidenceSchemaVersion: 2,
          factSheet: [
            {
              key: "rls_fixture",
              value: "Evidence ledger fixture",
              evidence: ledgerEvidence,
            },
          ] as Prisma.InputJsonValue,
          gaps: [] as Prisma.InputJsonValue,
        },
      });
      await tx.brandProfileEvidenceRef.create({
        data: {
          id: ledgerRefId,
          workspaceId,
          siteId,
          brandProfileId: ledgerProfileId,
          factIndex: 0,
          factKey: "rls_fixture",
          sourceSnapshotId: ledgerSnapshotId,
          sourceContentHash: ledgerHash,
          quote: ledgerText,
          quoteStart: 0,
          quoteEnd: Array.from(ledgerText).length,
        },
      });
    });
    await verifyImmutableLedgerRls({
      owner,
      app,
      workspaceId,
      otherWorkspaceId,
      siteId,
    });

    console.log("③ real SearXNG + Crawl4AI + provenance metadata");
    const broker = buildToolBroker({
      sourcePolicyReader: sourcePolicyReaderFrom(app),
    });
    const liveResearch = await researchBrand(
      { broker },
      {
        workspaceId,
        runId: randomUUID(),
        companyName: "KSB SE & Co. KGaA",
        industry: "industrial pumps and valves",
        websiteUrl: "https://www.ksb.com",
      },
    );
    check(
      liveResearch.sources.length > 0,
      "real research returned at least one source",
    );
    for (const source of liveResearch.sources) {
      check(
        /^[0-9a-f]{64}$/.test(source.upstreamContentHash),
        `${source.sourceType} carries an upstream SHA-256`,
      );
      check(
        source.sourceRole ===
          (source.sourceType === "web_research"
            ? "research_hint"
            : "fact_candidate"),
        `${source.sourceType} has the bounded source role`,
      );
      if (source.sourceType === "web_research") {
        const url = new URL(source.url);
        check(
          url.pathname === "/" && !url.search && !url.hash,
          "web_research retains external origin only",
        );
        check(
          source.title === undefined &&
            source.parserVersion === "searxng-origin-hint/1",
          "web_research omits raw title/snippet provenance",
        );
      }
    }

    console.log(
      "④ real BGE-M3 + model gateway + full buildBrandProfile activity",
    );
    storage = new StorageService();
    await storage.onModuleInit();
    const kb = new KbService(
      app,
      new EmbeddingsClient(),
      new DoclingClient(),
      storage,
    );
    const kbText = [
      "KSB manufactures centrifugal pumps and industrial valves.",
      "The company serves water, energy, mining and building-service applications.",
      "KSB has operated since 1871.",
      "For verification contact private-document@example.com.",
    ].join("\n");
    const assetId = randomUUID();
    const assetHash = sha256(kbText);
    await owner.asset.create({
      data: {
        id: assetId,
        workspaceId,
        siteId,
        kind: "doc",
        filename: "ksb-company-brief.txt",
        mime: "text/plain",
        sizeBytes: Buffer.byteLength(kbText),
        objectKey: `ws/${workspaceId}/${siteId}/doc/${assetHash}.txt`,
        contentHash: assetHash,
        processingStatus: "ready",
      },
    });
    await kb.ingestText(
      { userId: "verify-r4-a1", workspaceId, roles: [] },
      {
        siteId,
        source: "upload",
        title: "ksb-company-brief.txt",
        text: kbText,
        assetId,
      },
    );
    const registry = new ModelProviderRegistry();
    const provider = buildGatewayProvider();
    if (!provider) throw new Error("real model gateway is not configured");
    registry.register(provider);
    const gateway = new RouterModelGateway(
      new ModelRouter(registry),
      new AiTraceSink(app),
    );
    const activities = createSiteBuilderActivities({
      prisma: app,
      gateway,
      broker,
      kb,
    });
    const makeRun = async (): Promise<string> => {
      const id = randomUUID();
      runIds.push(id);
      await owner.siteBuildRun.create({
        data: {
          id,
          workspaceId,
          siteId,
          kind: "refurbish",
          status: "running",
        },
      });
      return id;
    };
    const first = await activities.buildBrandProfile({
      workspaceId,
      siteId,
      buildRunId: await makeRun(),
    });
    await owner.siteBuildRun.update({
      where: { id: runIds[0] },
      data: { status: "succeeded", finishedAt: new Date() },
    });
    check(
      first.version === 2,
      "first activity appended BrandProfile v2 after the isolated RLS fixture",
    );
    const profile = await owner.brandProfile.findFirstOrThrow({
      where: { siteId },
      orderBy: { version: "desc" },
      include: { evidenceRefs: true },
    });
    check(
      profile.evidenceSchemaVersion === 2,
      "new BrandProfile write is evidence_schema_version=2",
    );
    const facts = (profile.factSheet as unknown as StoredFact[] | null) ?? [];
    check(
      facts.length > 0,
      "real model produced at least one evidence-gated fact",
    );
    check(
      profile.evidenceRefs.length === facts.length,
      "every fact has exactly one relational EvidenceRef row",
    );
    const snapshots = await owner.siteEvidenceSourceSnapshot.findMany({
      where: { siteId },
      orderBy: { createdAt: "asc" },
    });
    check(
      snapshots.length >= 2,
      "intake and KB frozen snapshots were persisted",
    );
    for (const snapshot of snapshots) {
      check(
        snapshot.contentHash === sha256(snapshot.snapshotText),
        `snapshot ${snapshot.id} hash binds exact UTF-8 prompt text`,
      );
      check(
        !snapshot.snapshotText.includes("private-verifier@example.com") &&
          !snapshot.snapshotText.includes("private-profile@example.com") &&
          !snapshot.snapshotText.includes("private-document@example.com"),
        `snapshot ${snapshot.id} contains no raw fixture PII`,
      );
    }
    const snapshotById = new Map(
      snapshots.map((snapshot) => [snapshot.id, snapshot]),
    );
    for (const [index, fact] of facts.entries()) {
      const source = snapshotById.get(fact.evidence.sourceId);
      check(Boolean(source), `fact ${index} resolves to a frozen source`);
      if (!source) continue;
      const selected = Array.from(source.snapshotText)
        .slice(fact.evidence.selector.start, fact.evidence.selector.end)
        .join("");
      check(
        selected === fact.evidence.quote,
        `fact ${index} selector reproduces exact quote`,
      );
      check(
        fact.evidence.contentHash === source.contentHash,
        `fact ${index} hash matches its source FK`,
      );
    }

    console.log("⑤ snapshot idempotency and honest BrandProfile append debt");
    const sourceCount = snapshots.length;
    const noResearchActivities = createSiteBuilderActivities({
      prisma: app,
      gateway,
      kb,
    });
    const second = await noResearchActivities.buildBrandProfile({
      workspaceId,
      siteId,
      buildRunId: await makeRun(),
    });
    check(
      second.version === 3,
      "rerun appends BrandProfile v3 (R4-B debt remains explicit)",
    );
    const sourceCountAfter = await owner.siteEvidenceSourceSnapshot.count({
      where: { siteId },
    });
    check(
      sourceCountAfter === sourceCount,
      "identical intake/KB snapshots dedupe without mutable upsert",
    );

    console.log("\n🎉 verify-site-builder-r4-a1 all sections passed");
  } catch (error) {
    verificationError = error;
    throw error;
  } finally {
    for (const runId of runIds) budgetLedger.close(runId, { force: true });
    const cleanupErrors: unknown[] = [];
    const cleanup = async (
      label: string,
      operation: () => Promise<unknown>,
    ): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(
          new Error(`cleanup ${label} failed`, { cause: error }),
        );
      }
    };
    await cleanup("ai_trace", () =>
      owner.aiTrace.deleteMany({ where: { workspaceId } }),
    );
    await cleanup("site cascade", () =>
      owner.site.deleteMany({ where: { id: siteId } }),
    );
    await cleanup("workspaces", () =>
      owner.workspace.deleteMany({
        where: { id: { in: [workspaceId, otherWorkspaceId] } },
      }),
    );
    await cleanup("residual fixture assertion", async () => {
      const [sites, workspaces, refs, snapshots] = await Promise.all([
        owner.site.count({ where: { id: siteId } }),
        owner.workspace.count({
          where: { id: { in: [workspaceId, otherWorkspaceId] } },
        }),
        owner.brandProfileEvidenceRef.count({ where: { siteId } }),
        owner.siteEvidenceSourceSnapshot.count({ where: { siteId } }),
      ]);
      if (sites + workspaces + refs + snapshots !== 0) {
        throw new Error(
          `cleanup verification found residual R4-A1 fixtures: sites=${sites}, workspaces=${workspaces}, refs=${refs}, snapshots=${snapshots}`,
        );
      }
    });
    for (const result of await Promise.allSettled([
      owner.$disconnect(),
      app.$disconnect(),
    ])) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    if (cleanupErrors.length > 0) {
      console.error(
        "R4-A1 verifier cleanup failed:",
        new AggregateError(cleanupErrors),
      );
      if (!verificationError) {
        throw new AggregateError(
          cleanupErrors,
          "R4-A1 verifier passed but fixture cleanup failed",
        );
      }
    } else {
      console.log("  ✅ isolated verification fixtures removed");
    }
  }
}

main().catch((error) => {
  console.error("💥 R4-A1 verification failed:", error);
  process.exitCode = 1;
});
