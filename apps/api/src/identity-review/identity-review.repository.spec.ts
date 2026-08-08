import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../auth/request-context";
import type { PrismaService } from "../prisma/prisma.service";
import { COMPANY_IDENTITY_RULE_VERSION } from "./identity-review.domain";
import { IdentityReviewRepository } from "./identity-review.repository";

const CTX: RequestContext = {
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "reviewer-from-token",
  roles: ["identity.reviewer"],
};
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const DECISION_ID = "33333333-3333-4333-8333-333333333333";
const EVIDENCE_ID = "44444444-4444-4444-8444-444444444444";
const DECIDED_AT = new Date("2026-08-08T12:00:00.000Z");

const HUMAN_REQUEST = {
  canonicalCompanyId: SOURCE_ID,
  linkedCanonicalCompanyId: TARGET_ID,
  decision: "REVIEW_LINK",
  ruleVersion: COMPANY_IDENTITY_RULE_VERSION,
  evidenceRefs: [{ type: "FIELD_EVIDENCE", id: EVIDENCE_ID }],
} as const;

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DECISION_ID,
    workspaceId: CTX.workspaceId,
    canonicalCompanyId: SOURCE_ID,
    linkedCanonicalCompanyId: TARGET_ID,
    decision: "REVIEW_LINK",
    ruleVersion: COMPANY_IDENTITY_RULE_VERSION,
    evidenceRefs: HUMAN_REQUEST.evidenceRefs,
    actorType: "USER",
    actorId: CTX.userId,
    decidedAt: DECIDED_AT,
    createdAt: new Date("2026-08-08T12:00:01.000Z"),
    ...overrides,
  };
}

function harness(options: {
  companyIds?: string[];
  evidenceIds?: string[];
  rows?: ReturnType<typeof decisionRow>[];
  cursorExists?: boolean;
} = {}) {
  const companyIds = options.companyIds ?? [SOURCE_ID, TARGET_ID];
  const evidenceIds = options.evidenceIds ?? [EVIDENCE_ID];
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
    decisionRow(data),
  );
  const tx = {
    canonicalCompany: {
      findMany: vi.fn(async () => companyIds.map((id) => ({ id }))),
      findFirst: vi.fn(async () =>
        companyIds.includes(SOURCE_ID) ? { id: SOURCE_ID } : null,
      ),
    },
    identityResolutionDecision: {
      create,
      findFirst: vi.fn(async () =>
        options.cursorExists === false ? null : { id: DECISION_ID },
      ),
      findMany: vi.fn(async () => options.rows ?? [decisionRow()]),
    },
    fieldEvidence: {
      findMany: vi.fn(async () => evidenceIds.map((id) => ({ id }))),
    },
    rawSourceRecord: {
      findMany: vi.fn(async () => evidenceIds.map((id) => ({ id }))),
    },
    sourceSignal: {
      findMany: vi.fn(async () => evidenceIds.map((id) => ({ id }))),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(
      async (_workspaceId: string, work: (value: typeof tx) => unknown) =>
        work(tx),
    ),
  } as unknown as PrismaService;
  return { repository: new IdentityReviewRepository(prisma), prisma, tx, create };
}

describe("IdentityReviewRepository.appendHuman", () => {
  it("derives workspace and actor from the token context, validates both companies, and appends only", async () => {
    const h = harness();
    await expect(
      h.repository.appendHuman(CTX, HUMAN_REQUEST, DECIDED_AT),
    ).resolves.toMatchObject({
      decision: "REVIEW_LINK",
      actorType: "USER",
      actorId: CTX.userId,
    });

    expect(h.prisma.withWorkspace).toHaveBeenCalledWith(
      CTX.workspaceId,
      expect.any(Function),
    );
    expect(h.tx.canonicalCompany.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: CTX.workspaceId,
        id: { in: [SOURCE_ID, TARGET_ID] },
      },
      select: { id: true },
    });
    expect(h.create).toHaveBeenCalledWith({
      data: {
        workspaceId: CTX.workspaceId,
        canonicalCompanyId: SOURCE_ID,
        linkedCanonicalCompanyId: TARGET_ID,
        decision: "REVIEW_LINK",
        ruleVersion: COMPANY_IDENTITY_RULE_VERSION,
        evidenceRefs: HUMAN_REQUEST.evidenceRefs,
        actorType: "USER",
        actorId: CTX.userId,
        decidedAt: DECIDED_AT,
      },
    });
    expect(h.tx.canonicalCompany).not.toHaveProperty("update");
    expect(h.tx.canonicalCompany).not.toHaveProperty("delete");
    expect(h.tx.identityResolutionDecision).not.toHaveProperty("update");
    expect(h.tx.identityResolutionDecision).not.toHaveProperty("delete");
  });

  it("returns indistinguishable NOT_FOUND for a missing or cross-workspace target", async () => {
    const h = harness({ companyIds: [SOURCE_ID] });
    await expect(
      h.repository.appendHuman(CTX, HUMAN_REQUEST, DECIDED_AT),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      h.repository.appendHuman(CTX, HUMAN_REQUEST, DECIDED_AT),
    ).rejects.toMatchObject({
      response: { error: { code: "LINKED_CANONICAL_COMPANY_NOT_FOUND" } },
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("fails closed when the source company is outside the active workspace", async () => {
    const h = harness({ companyIds: [TARGET_ID] });
    await expect(
      h.repository.appendHuman(CTX, HUMAN_REQUEST, DECIDED_AT),
    ).rejects.toMatchObject({
      response: { error: { code: "CANONICAL_COMPANY_NOT_FOUND" } },
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("rejects fabricated or cross-workspace evidence references", async () => {
    const h = harness({ evidenceIds: [] });
    await expect(
      h.repository.appendHuman(CTX, HUMAN_REQUEST, DECIDED_AT),
    ).rejects.toMatchObject({
      response: { error: { code: "IDENTITY_EVIDENCE_NOT_FOUND" } },
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("defends against self-linking even if a caller bypasses the DTO", async () => {
    const h = harness();
    await expect(
      h.repository.appendHuman(
        CTX,
        { ...HUMAN_REQUEST, linkedCanonicalCompanyId: SOURCE_ID },
        DECIDED_AT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("appends repeated review facts instead of replacing historical rows", async () => {
    const h = harness();
    await h.repository.appendHuman(CTX, HUMAN_REQUEST, DECIDED_AT);
    await h.repository.appendHuman(
      CTX,
      { ...HUMAN_REQUEST, decision: "REJECT_LINK" },
      new Date("2026-08-08T12:05:00.000Z"),
    );
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.tx.identityResolutionDecision).not.toHaveProperty("upsert");
  });
});

describe("IdentityReviewRepository.appendSystem", () => {
  it("keeps AUTO_LINK on an internal SYSTEM-only append seam", async () => {
    const h = harness({ companyIds: [SOURCE_ID] });
    await expect(
      h.repository.appendSystem({
        workspaceId: CTX.workspaceId,
        canonicalCompanyId: SOURCE_ID,
        linkedCanonicalCompanyId: null,
        decision: "AUTO_LINK",
        ruleVersion: COMPANY_IDENTITY_RULE_VERSION,
        evidenceRefs: [{ type: "RAW_RECORD", id: EVIDENCE_ID }],
        actorId: "company-identity-resolver",
        decidedAt: DECIDED_AT,
      }),
    ).resolves.toMatchObject({ decision: "AUTO_LINK", actorType: "SYSTEM" });
    expect(h.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: CTX.workspaceId,
        actorType: "SYSTEM",
        actorId: "company-identity-resolver",
      }),
    });
  });
});

describe("IdentityReviewRepository.listByCompany", () => {
  it("reads history only in the token workspace with bounded cursor pagination", async () => {
    const rows = [
      decisionRow(),
      decisionRow({ id: "55555555-5555-4555-8555-555555555555" }),
    ];
    const h = harness({ rows });
    await expect(
      h.repository.listByCompany(CTX, SOURCE_ID, { limit: 1, cursor: DECISION_ID }),
    ).resolves.toMatchObject({
      records: [rows[0]],
      nextCursor: rows[0].id,
      hasMore: true,
    });
    expect(h.tx.identityResolutionDecision.findMany).toHaveBeenCalledWith({
      where: { workspaceId: CTX.workspaceId, canonicalCompanyId: SOURCE_ID },
      orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
      take: 2,
      cursor: { id: DECISION_ID },
      skip: 1,
    });
  });

  it("rejects a cursor that is not part of this workspace/company history", async () => {
    const h = harness({ cursorExists: false });
    await expect(
      h.repository.listByCompany(CTX, SOURCE_ID, {
        limit: 50,
        cursor: DECISION_ID,
      }),
    ).rejects.toMatchObject({
      response: { error: { code: "IDENTITY_DECISION_CURSOR_INVALID" } },
    });
    expect(h.tx.identityResolutionDecision.findMany).not.toHaveBeenCalled();
  });
});
