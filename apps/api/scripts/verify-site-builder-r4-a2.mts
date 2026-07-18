/**
 * R4-A2 Claim/Evidence truth bridge verification against the real Ubuntu
 * development PostgreSQL roles. Creates isolated UUID fixtures and removes
 * them in finally; no external model call is required for this storage gate.
 *
 * Run from apps/api:
 *   ALLOW_DEV_DB_VERIFIER=true node --import tsx scripts/verify-site-builder-r4-a2.mts
 */
import "dotenv/config";
import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { ClaimService } from "../src/claim/claim.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaClaimEvidenceBridgeRepository } from "../src/site-builder/claim-evidence-bridge.prisma";
import { ClaimEvidenceBridgeService } from "../src/site-builder/claim-evidence-bridge.service";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`  ✅ ${message}`);
}

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
      "refusing R4-A2 verifier: require ALLOW_DEV_DB_VERIFIER=true and non-production NODE_ENV",
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

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

async function main(): Promise<void> {
  requireDevelopmentDatabase();
  const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const app = new PrismaService();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const companyProfileId = randomUUID();
  const otherCompanyProfileId = randomUUID();
  const siteId = randomUUID();
  const otherSiteId = randomUUID();
  const certAssetId = randomUUID();
  const capabilitySnapshotId = randomUUID();
  const certSnapshotId = randomUUID();
  const capabilityText =
    "Industrial pumps reach a maximum pressure of 400 bar.";
  const certText = "The company holds an ISO 9001 certified quality system.";
  let verificationError: unknown;

  try {
    await Promise.all([owner.$connect(), app.$connect()]);

    console.log("① role, FORCE RLS and append-only grants");
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
    const security = await owner.$queryRaw<
      { rowSecurity: boolean; forceRowSecurity: boolean }[]
    >`
      SELECT c.relrowsecurity AS "rowSecurity",
             c.relforcerowsecurity AS "forceRowSecurity"
        FROM pg_class c
       WHERE c.oid = 'brand_profile_claim_bridge'::regclass`;
    check(
      security[0]?.rowSecurity && security[0]?.forceRowSecurity,
      "brand_profile_claim_bridge is ENABLE + FORCE RLS",
    );
    const privileges = await owner.$queryRaw<{ privilege: string }[]>`
      SELECT privilege_type AS privilege
        FROM information_schema.role_table_grants
       WHERE grantee = 'app_user'
         AND table_name = 'brand_profile_claim_bridge'
       ORDER BY privilege_type`;
    check(
      privileges.map((row) => row.privilege).join(",") === "INSERT,SELECT",
      "app_user has SELECT+INSERT only on the immutable bridge",
    );

    console.log("② isolated tenant graph and exact frozen facts");
    await owner.workspace.createMany({
      data: [
        { id: workspaceId, name: "verify-r4-a2" },
        { id: otherWorkspaceId, name: "verify-r4-a2-other" },
      ],
    });
    await owner.companyProfile.createMany({
      data: [
        {
          id: companyProfileId,
          workspaceId,
          name: "R4-A2 Pump Verification",
        },
        {
          id: otherCompanyProfileId,
          workspaceId: otherWorkspaceId,
          name: "R4-A2 Other Tenant",
        },
      ],
    });
    await owner.site.createMany({
      data: [
        {
          id: siteId,
          workspaceId,
          companyProfileId,
          name: "R4-A2 Pump Verification",
          slug: `verify-r4-a2-${siteId.slice(0, 8)}`,
          status: "building",
          intake: { company: { nameZh: "R4-A2 泵业" } },
        },
        {
          id: otherSiteId,
          workspaceId: otherWorkspaceId,
          companyProfileId: null,
          name: "R4-A2 Legacy Unlinked",
          slug: `verify-r4-a2-other-${otherSiteId.slice(0, 8)}`,
          status: "setup_failed",
          intake: { company: { nameZh: "旧站" } },
        },
      ],
    });
    await owner.asset.create({
      data: {
        id: certAssetId,
        workspaceId,
        siteId,
        kind: "cert",
        filename: "iso-9001-certificate.pdf",
        mime: "application/pdf",
        sizeBytes: 1024,
        objectKey: `ws/${workspaceId}/${siteId}/cert/${certAssetId}.pdf`,
        contentHash: sha256("isolated cert fixture"),
        processingStatus: "ready",
      },
    });
    await owner.siteEvidenceSourceSnapshot.createMany({
      data: [
        {
          id: capabilitySnapshotId,
          workspaceId,
          siteId,
          sourceKey: "verify-r4-a2:capability",
          sourceType: "upload",
          sourceRole: "fact_candidate",
          contentHash: sha256(capabilityText),
          normalizationVersion: "evidence-text/1",
          snapshotText: capabilityText,
          provenance: { kind: "r4_a2_verifier" },
          dedupeKey: sha256(`${siteId}:capability`),
        },
        {
          id: certSnapshotId,
          workspaceId,
          siteId,
          sourceKey: "verify-r4-a2:certification",
          sourceType: "upload",
          sourceRole: "fact_candidate",
          contentHash: sha256(certText),
          normalizationVersion: "evidence-text/1",
          snapshotText: certText,
          provenance: { kind: "r4_a2_verifier", assetId: certAssetId },
          dedupeKey: sha256(`${siteId}:certification`),
        },
      ],
    });

    const createProfile = async (version: number): Promise<string> => {
      const brandProfileId = randomUUID();
      const capabilityRefId = randomUUID();
      const certRefId = randomUUID();
      const capabilityQuote = "maximum pressure of 400 bar";
      const certQuote = "ISO 9001 certified quality system";
      await owner.$transaction(async (tx) => {
        await tx.brandProfile.create({
          data: {
            id: brandProfileId,
            workspaceId,
            siteId,
            version,
            evidenceSchemaVersion: 2,
            factSheet: [
              {
                key: "maximum_pressure",
                value: "Maximum pressure: 400 bar",
                evidence: {
                  version: 2,
                  evidenceRefId: capabilityRefId,
                  sourceId: capabilitySnapshotId,
                  sourceType: "upload",
                  sourceRole: "fact_candidate",
                  hashAlgorithm: "sha256",
                  contentHash: sha256(capabilityText),
                  quote: capabilityQuote,
                  selector: {
                    start: Array.from(
                      capabilityText.slice(
                        0,
                        capabilityText.indexOf(capabilityQuote),
                      ),
                    ).length,
                    end:
                      Array.from(
                        capabilityText.slice(
                          0,
                          capabilityText.indexOf(capabilityQuote),
                        ),
                      ).length + Array.from(capabilityQuote).length,
                  },
                },
              },
              {
                key: "certifications",
                value: "ISO 9001 certified",
                evidence: {
                  version: 2,
                  evidenceRefId: certRefId,
                  sourceId: certSnapshotId,
                  sourceType: "upload",
                  sourceRole: "fact_candidate",
                  hashAlgorithm: "sha256",
                  contentHash: sha256(certText),
                  quote: certQuote,
                  selector: {
                    start: Array.from(
                      certText.slice(0, certText.indexOf(certQuote)),
                    ).length,
                    end:
                      Array.from(certText.slice(0, certText.indexOf(certQuote)))
                        .length + Array.from(certQuote).length,
                  },
                  assetId: certAssetId,
                },
              },
            ] as Prisma.InputJsonValue,
            gaps: [] as Prisma.InputJsonValue,
          },
        });
        for (const [factIndex, ref] of [
          {
            id: capabilityRefId,
            factKey: "maximum_pressure",
            sourceSnapshotId: capabilitySnapshotId,
            sourceContentHash: sha256(capabilityText),
            quote: capabilityQuote,
            quoteStart: Array.from(
              capabilityText.slice(0, capabilityText.indexOf(capabilityQuote)),
            ).length,
          },
          {
            id: certRefId,
            factKey: "certifications",
            sourceSnapshotId: certSnapshotId,
            sourceContentHash: sha256(certText),
            quote: certQuote,
            quoteStart: Array.from(
              certText.slice(0, certText.indexOf(certQuote)),
            ).length,
          },
        ].entries()) {
          await tx.brandProfileEvidenceRef.create({
            data: {
              ...ref,
              workspaceId,
              siteId,
              brandProfileId,
              factIndex,
              quoteEnd: ref.quoteStart + Array.from(ref.quote).length,
            },
          });
        }
      });
      return brandProfileId;
    };

    console.log("③ atomic projection, replay reuse and NEEDS_REVIEW default");
    const firstProfileId = await createProfile(1);
    const projectProfile = (brandProfileId: string) =>
      app.withWorkspace(workspaceId, async (tx) => {
        const bridge = new ClaimEvidenceBridgeService(
          new PrismaClaimEvidenceBridgeRepository(tx),
        );
        return Promise.all([
          bridge.projectFact(
            { workspaceId, userId: "verifier", roles: [] },
            { siteId, brandProfileId, factIndex: 0 },
          ),
          bridge.projectFact(
            { workspaceId, userId: "verifier", roles: [] },
            { siteId, brandProfileId, factIndex: 1 },
          ),
        ]);
      });
    const firstProjection = await projectProfile(firstProfileId);
    check(
      firstProjection.every(
        (result) =>
          result.kind === "projected" && result.claim.status === "NEEDS_REVIEW",
      ),
      "generated capability and certification Claims start NEEDS_REVIEW",
    );
    const firstClaims = await owner.claim.findMany({
      where: { companyId: companyProfileId, originKey: { not: null } },
      orderBy: { type: "asc" },
    });
    check(firstClaims.length === 2, "two public Claims were created");
    check(
      (await owner.evidence.count({
        where: { claimId: { in: firstClaims.map((claim) => claim.id) } },
      })) === 2,
      "two exact public Evidence rows were created",
    );
    check(
      (await owner.brandProfileClaimBridge.count({
        where: { brandProfileId: firstProfileId },
      })) === 2,
      "every frozen fact has one immutable bridge edge",
    );

    const reviewer = new ClaimService(app);
    for (const claim of firstClaims) {
      await reviewer.transition(
        { workspaceId, userId: "human-reviewer", roles: [] },
        claim.id,
        "APPROVED",
        claim.version,
      );
    }
    const approved = await owner.claim.findMany({
      where: { id: { in: firstClaims.map((claim) => claim.id) } },
    });
    check(
      approved.every(
        (claim) =>
          claim.status === "APPROVED" &&
          claim.verifiedBy === "human-reviewer" &&
          claim.verifiedAt !== null &&
          claim.verificationMethod === "human_review" &&
          claim.verificationProof !== null,
      ),
      "approval persists actor/server time/method/proof",
    );

    const secondProfileId = await createProfile(2);
    const replayProjection = await projectProfile(secondProfileId);
    check(
      replayProjection.every(
        (result) =>
          result.kind === "projected" && result.claim.status === "APPROVED",
      ),
      "replay reuses reviewed Claims without downgrading status",
    );
    check(
      (await owner.claim.count({
        where: { companyId: companyProfileId, originKey: { not: null } },
      })) === 2,
      "new BrandProfile version reuses stable Claim identities",
    );
    check(
      (await owner.evidence.count({
        where: { claimId: { in: firstClaims.map((claim) => claim.id) } },
      })) === 2,
      "new BrandProfile version reuses exact Evidence identities",
    );
    check(
      (await owner.brandProfileClaimBridge.count({ where: { siteId } })) === 4,
      "each BrandProfile version retains its own exact bridge edges",
    );

    console.log("④ approved-effective read gate and revocation/expiry");
    const listApproved = () =>
      app.withWorkspace(workspaceId, (tx) =>
        new ClaimEvidenceBridgeService(
          new PrismaClaimEvidenceBridgeRepository(tx),
        ).listApprovedEffectiveClaims(
          { workspaceId, userId: "reader", roles: [] },
          { siteId },
        ),
      );
    check(
      (await listApproved()).length === 2,
      "both approved Claims are effective",
    );
    const certification = approved.find(
      (claim) => claim.type === "certification",
    );
    const capability = approved.find((claim) => claim.type === "param");
    check(
      certification && capability,
      "typed capability/certification Claims exist",
    );
    await reviewer.revoke(
      { workspaceId, userId: "human-reviewer", roles: [] },
      certification.id,
      certification.version,
    );
    const revoked = await owner.claim.findUniqueOrThrow({
      where: { id: certification.id },
    });
    check(
      revoked.status === "REVOKED" &&
        revoked.verifiedBy === "human-reviewer" &&
        revoked.verificationMethod === "human_review",
      "revocation retains the original human verification audit",
    );
    check((await listApproved()).length === 1, "revoked Claim is excluded");
    await owner.claim.update({
      where: { id: capability.id },
      data: { validUntil: new Date(Date.now() - 1_000) },
    });
    check(
      (await listApproved()).length === 0,
      "time-expired Claim is excluded",
    );
    const otherVisible = await app.withWorkspace(otherWorkspaceId, (tx) =>
      new ClaimEvidenceBridgeService(
        new PrismaClaimEvidenceBridgeRepository(tx),
      ).listApprovedEffectiveClaims(
        { workspaceId: otherWorkspaceId, userId: "other", roles: [] },
        { siteId: otherSiteId },
      ),
    );
    check(otherVisible.length === 0, "legacy unlinked Site reads fail closed");

    console.log("⑤ RLS isolation, immutable trigger and composite FK");
    const visibleA = await app.withWorkspace(workspaceId, (tx) =>
      tx.brandProfileClaimBridge.count({ where: { siteId } }),
    );
    const visibleB = await app.withWorkspace(otherWorkspaceId, (tx) =>
      tx.brandProfileClaimBridge.count({ where: { siteId } }),
    );
    const visibleUnset = await app.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
        FROM brand_profile_claim_bridge
       WHERE site_id = ${siteId}::uuid`;
    check(visibleA === 4, "workspace A reads its four bridge edges");
    check(visibleB === 0, "workspace B cannot read workspace A bridge edges");
    check(
      Number(visibleUnset[0]?.count ?? -1) === 0,
      "unset workspace sees zero bridge edges",
    );
    const firstBridge = await owner.brandProfileClaimBridge.findFirstOrThrow({
      where: { siteId },
    });
    let appUpdateRejected = false;
    try {
      await app.withWorkspace(workspaceId, (tx) =>
        tx.brandProfileClaimBridge.update({
          where: { id: firstBridge.id },
          data: { bridgeKey: "f".repeat(64) },
        }),
      );
    } catch {
      appUpdateRejected = true;
    }
    check(appUpdateRejected, "app_user cannot mutate a bridge edge");
    let ownerUpdateRejected = false;
    try {
      await owner.brandProfileClaimBridge.update({
        where: { id: firstBridge.id },
        data: { bridgeKey: "e".repeat(64) },
      });
    } catch {
      ownerUpdateRejected = true;
    }
    check(ownerUpdateRejected, "owner is stopped by the immutable trigger");
    let crossTenantRejected = false;
    try {
      await owner.site.update({
        where: { id: otherSiteId },
        data: { companyProfileId },
      });
    } catch {
      crossTenantRejected = true;
    }
    check(
      crossTenantRejected,
      "Site→CompanyProfile cross-tenant link is rejected",
    );

    console.log("\n🎉 verify-site-builder-r4-a2 all sections passed");
  } catch (error) {
    verificationError = error;
    throw error;
  } finally {
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
    await cleanup("sites", () =>
      owner.site.deleteMany({ where: { id: { in: [siteId, otherSiteId] } } }),
    );
    await cleanup("companies", () =>
      owner.companyProfile.deleteMany({
        where: { id: { in: [companyProfileId, otherCompanyProfileId] } },
      }),
    );
    await cleanup("workspaces", () =>
      owner.workspace.deleteMany({
        where: { id: { in: [workspaceId, otherWorkspaceId] } },
      }),
    );
    await cleanup("residual fixture assertion", async () => {
      const [sites, companies, bridges, claims] = await Promise.all([
        owner.site.count({ where: { id: { in: [siteId, otherSiteId] } } }),
        owner.companyProfile.count({
          where: { id: { in: [companyProfileId, otherCompanyProfileId] } },
        }),
        owner.brandProfileClaimBridge.count({ where: { siteId } }),
        owner.claim.count({ where: { companyId: companyProfileId } }),
      ]);
      if (sites + companies + bridges + claims !== 0) {
        throw new Error(
          `residual fixtures: sites=${sites}, companies=${companies}, bridges=${bridges}, claims=${claims}`,
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
        "R4-A2 verifier cleanup failed:",
        new AggregateError(cleanupErrors),
      );
      if (!verificationError) {
        throw new AggregateError(
          cleanupErrors,
          "R4-A2 verifier passed but fixture cleanup failed",
        );
      }
    } else {
      console.log("  ✅ isolated verification fixtures removed");
    }
  }
}

main().catch((error) => {
  console.error("💥 R4-A2 verification failed:", error);
  process.exitCode = 1;
});
