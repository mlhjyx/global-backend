import { describe, expect, it, vi } from "vitest";
import { buildClaimApprovalProof } from "../claim/claim-verification";
import { buildPublishableClaimSnapshot } from "./publishable-claim-snapshot";
import { PrismaPublishableClaimSnapshotRepository } from "./publishable-claim-snapshot.prisma";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SITE_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const BUILD_RUN_ID = "44444444-4444-4444-8444-444444444444";

function tx() {
  return {
    site: { findFirst: vi.fn() },
    brandProfileClaimBridge: { findMany: vi.fn() },
    sitePublishableClaimSnapshot: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    siteId: SITE_ID,
    companyProfileId: COMPANY_ID,
    buildRunId: BUILD_RUN_ID,
    schemaVersion: "site-builder-publishable-claim-snapshot/v1",
    capturedAt: new Date("2026-07-19T12:00:00.000Z"),
    snapshotDigest: "a".repeat(64),
    items: [
      {
        claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        claimVersion: 2,
        factKey: "main_products",
        claimType: "capability",
        statement: "Industrial pumps",
        validUntil: new Date("2026-08-19T12:00:00.000Z"),
        approvedBy: "reviewer-1",
        approvedAt: new Date("2026-07-19T10:00:00.000Z"),
        bridgeId: "bridge-1",
        brandProfileId: "profile-1",
        evidenceRefId: "ref-1",
        evidenceId: "evidence-1",
        sourceSnapshotId: "source-1",
        sourceContentHash: "b".repeat(64),
        quote: "Industrial pumps",
        quoteStart: 0,
        quoteEnd: 16,
        quotePrefix: "prefix",
        quoteSuffix: null,
        certAssetId: null,
      },
    ],
    ...overrides,
  };
}

function bridgeRow(overrides: Record<string, unknown> = {}) {
  const claim = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: WORKSPACE_ID,
    companyId: COMPANY_ID,
    sourceId: null,
    originKey: "origin-1",
    factKey: "main_products",
    type: "capability",
    statement: "Industrial pumps",
    status: "APPROVED",
    version: 2,
    validUntil: new Date("2026-08-19T12:00:00.000Z"),
    verifiedBy: "reviewer-1",
    verifiedAt: new Date("2026-07-19T10:00:00.000Z"),
    verificationMethod: "human_review",
    verificationProof: null as unknown,
  };
  claim.verificationProof = buildClaimApprovalProof(claim, claim.version, {
    verifiedBy: claim.verifiedBy,
    verifiedAt: claim.verifiedAt,
    verificationMethod: "human_review",
  });
  return {
    id: "bridge-1",
    brandProfileId: "profile-1",
    evidenceRefId: "ref-1",
    evidenceId: "evidence-1",
    certAssetId: null,
    claim,
    evidenceRef: {
      sourceSnapshotId: "source-1",
      sourceContentHash: "b".repeat(64),
      quote: "Industrial pumps",
      quoteStart: 0,
      quoteEnd: 16,
      quotePrefix: null,
      quoteSuffix: "suffix",
    },
    certAsset: null,
    ...overrides,
  };
}

describe("PrismaPublishableClaimSnapshotRepository", () => {
  it("returns null or a normalized immutable snapshot from either lookup", async () => {
    const client = tx();
    const repository = new PrismaPublishableClaimSnapshotRepository(client as never);
    client.sitePublishableClaimSnapshot.findFirst.mockResolvedValueOnce(null);
    await expect(repository.findByBuildRun(WORKSPACE_ID, BUILD_RUN_ID)).resolves.toBeNull();
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);

    client.sitePublishableClaimSnapshot.findFirst.mockResolvedValueOnce(storedRow());
    await expect(repository.findById(WORKSPACE_ID, "snapshot-1")).resolves.toEqual({
      schemaVersion: "site-builder-publishable-claim-snapshot/v1",
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      companyProfileId: COMPANY_ID,
      buildRunId: BUILD_RUN_ID,
      capturedAt: "2026-07-19T12:00:00.000Z",
      digest: "a".repeat(64),
      items: [
        expect.objectContaining({
          claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          validUntil: "2026-08-19T12:00:00.000Z",
          selector: { start: 0, end: 16, prefix: "prefix" },
        }),
      ],
    });

    client.sitePublishableClaimSnapshot.findFirst.mockResolvedValueOnce(
      storedRow({ items: [{ ...storedRow().items[0], validUntil: null, quotePrefix: null, quoteSuffix: "suffix", certAssetId: "asset-1" }] }),
    );
    const byRun = await repository.findByBuildRun(WORKSPACE_ID, BUILD_RUN_ID);
    expect(byRun?.items[0]).toMatchObject({
      validUntil: null,
      selector: { start: 0, end: 16, suffix: "suffix" },
      certAssetId: "asset-1",
    });
  });

  it("resolves a Site company profile or null inside the exact workspace", async () => {
    const client = tx();
    const repository = new PrismaPublishableClaimSnapshotRepository(client as never);
    client.site.findFirst.mockResolvedValueOnce({ companyProfileId: COMPANY_ID }).mockResolvedValueOnce(null);
    await expect(repository.getSiteCompanyProfileId(WORKSPACE_ID, SITE_ID)).resolves.toBe(COMPANY_ID);
    await expect(repository.getSiteCompanyProfileId(WORKSPACE_ID, SITE_ID)).resolves.toBeNull();
  });

  it("queries only exact Site and CompanyProfile bridge candidates", async () => {
    const client = tx();
    client.brandProfileClaimBridge.findMany.mockResolvedValue([]);
    const repository = new PrismaPublishableClaimSnapshotRepository(
      client as never,
    );

    await expect(
      repository.listCandidates(
        WORKSPACE_ID,
        SITE_ID,
        COMPANY_ID,
        new Date("2026-07-19T12:00:00Z"),
      ),
    ).resolves.toEqual([]);
    expect(client.brandProfileClaimBridge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          siteId: SITE_ID,
          companyProfileId: COMPANY_ID,
          claim: expect.objectContaining({ status: "APPROVED" }),
        }),
      }),
    );
  });

  it("persists even an empty snapshot as an immutable run record", async () => {
    const client = tx();
    const snapshot = buildPublishableClaimSnapshot({
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      companyProfileId: COMPANY_ID,
      buildRunId: BUILD_RUN_ID,
      capturedAt: new Date("2026-07-19T12:00:00Z"),
      candidates: [],
    });
    client.sitePublishableClaimSnapshot.create.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
    });
    const repository = new PrismaPublishableClaimSnapshotRepository(
      client as never,
    );

    await expect(repository.persist(snapshot)).resolves.toEqual(snapshot);
    expect(client.sitePublishableClaimSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        buildRunId: BUILD_RUN_ID,
        items: { create: [] },
      }),
      select: { id: true },
    });
  });

  it("filters duplicate and unaudited bridge candidates while admitting a valid certification asset", async () => {
    const client = tx();
    const valid = bridgeRow();
    const duplicate = bridgeRow({ id: "bridge-duplicate" });
    const invalid = bridgeRow({
      id: "bridge-invalid",
      claim: { ...bridgeRow().claim, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", factKey: null },
    });
    const certBase = bridgeRow();
    const certClaim = {
      ...certBase.claim,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      factKey: "quality_certification",
      type: "certification",
      statement: "ISO 9001 certified",
    };
    certClaim.verificationProof = buildClaimApprovalProof(certClaim, certClaim.version, {
      verifiedBy: certClaim.verifiedBy,
      verifiedAt: certClaim.verifiedAt,
      verificationMethod: "human_review",
    });
    const cert = bridgeRow({
      id: "bridge-cert",
      claim: certClaim,
      certAssetId: "asset-cert",
      certAsset: { kind: "cert", processingStatus: "ready", deletedAt: null },
    });
    client.brandProfileClaimBridge.findMany.mockResolvedValue([valid, duplicate, invalid, cert]);
    const repository = new PrismaPublishableClaimSnapshotRepository(client as never);

    const result = await repository.listCandidates(
      WORKSPACE_ID,
      SITE_ID,
      COMPANY_ID,
      new Date("2026-07-19T12:00:00.000Z"),
    );
    expect(result.map((item) => item.claimId)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ]);
    expect(result[1]).toMatchObject({ certAssetId: "asset-cert", certificationProofValid: true });
  });

  it("rejects certification rows without a live cert asset", async () => {
    const client = tx();
    const base = bridgeRow();
    const claim = {
      ...base.claim,
      type: "certification",
      factKey: "certification",
      statement: "CE certified",
    };
    claim.verificationProof = buildClaimApprovalProof(claim, claim.version, {
      verifiedBy: claim.verifiedBy,
      verifiedAt: claim.verifiedAt,
      verificationMethod: "human_review",
    });
    client.brandProfileClaimBridge.findMany.mockResolvedValue([
      bridgeRow({ claim, certAssetId: "asset-bad", certAsset: { kind: "image", processingStatus: "ready", deletedAt: null } }),
    ]);
    const repository = new PrismaPublishableClaimSnapshotRepository(client as never);
    await expect(
      repository.listCandidates(WORKSPACE_ID, SITE_ID, COMPANY_ID, new Date("2026-07-19T12:00:00.000Z")),
    ).resolves.toEqual([]);
  });

  it("persists optional snapshot item fields and lists current locked states", async () => {
    const client = tx();
    const repository = new PrismaPublishableClaimSnapshotRepository(client as never);
    const item = storedRow().items[0];
    const snapshot = {
      schemaVersion: "site-builder-publishable-claim-snapshot/v1" as const,
      workspaceId: WORKSPACE_ID,
      siteId: SITE_ID,
      companyProfileId: COMPANY_ID,
      buildRunId: BUILD_RUN_ID,
      capturedAt: "2026-07-19T12:00:00.000Z",
      digest: "a".repeat(64),
      items: [
        {
          claimId: item.claimId,
          claimVersion: item.claimVersion,
          factKey: item.factKey,
          claimType: item.claimType,
          statement: item.statement,
          validUntil: null,
          approvedBy: item.approvedBy,
          approvedAt: item.approvedAt.toISOString(),
          bridgeId: item.bridgeId,
          brandProfileId: item.brandProfileId,
          evidenceRefId: item.evidenceRefId,
          evidenceId: item.evidenceId,
          sourceSnapshotId: item.sourceSnapshotId,
          sourceContentHash: item.sourceContentHash,
          quote: item.quote,
          selector: { start: 0, end: 16 },
        },
      ],
    };
    client.sitePublishableClaimSnapshot.create.mockResolvedValue({ id: "snapshot-1" });
    await expect(repository.persist(snapshot)).resolves.toBe(snapshot);
    expect(client.sitePublishableClaimSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        items: {
          create: [expect.objectContaining({ validUntil: null, quotePrefix: undefined, quoteSuffix: undefined, certAssetId: undefined })],
        },
      }),
      select: { id: true },
    });

    client.brandProfileClaimBridge.findMany.mockResolvedValue([bridgeRow()]);
    await expect(repository.listCurrentStates(WORKSPACE_ID, SITE_ID, snapshot)).resolves.toEqual([
      expect.objectContaining({
        claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "APPROVED",
        certificationProofValid: false,
      }),
    ]);
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
