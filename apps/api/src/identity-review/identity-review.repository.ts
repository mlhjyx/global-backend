import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RequestContext } from "../auth/request-context";
import { PrismaService } from "../prisma/prisma.service";
import {
  normalizeSystemIdentityResolutionDecision,
  type IdentityEvidenceRef,
  type NormalizedHumanIdentityReviewRequest,
  type NormalizedSystemIdentityResolutionDecision,
} from "./identity-review.domain";

export interface IdentityResolutionDecisionRecord {
  id: string;
  workspaceId: string;
  canonicalCompanyId: string;
  linkedCanonicalCompanyId: string | null;
  decision: "AUTO_LINK" | "REVIEW_LINK" | "REJECT_LINK" | "SPLIT";
  ruleVersion: string;
  evidenceRefs: readonly IdentityEvidenceRef[];
  actorType: "SYSTEM" | "USER";
  actorId: string;
  decidedAt: Date;
  createdAt: Date;
}

function apiNotFound(code: string, message: string): NotFoundException {
  return new NotFoundException({ error: { code, message } });
}

function apiBadRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({ error: { code, message } });
}

function row(value: unknown): IdentityResolutionDecisionRecord {
  return value as IdentityResolutionDecisionRecord;
}

@Injectable()
export class IdentityReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async appendHuman(
    ctx: RequestContext,
    request: NormalizedHumanIdentityReviewRequest,
    decidedAt: Date,
  ): Promise<IdentityResolutionDecisionRecord> {
    if (request.linkedCanonicalCompanyId === request.canonicalCompanyId) {
      throw apiBadRequest("IDENTITY_SELF_LINK_FORBIDDEN", "a company cannot link to itself");
    }
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      await this.assertCompanies(
        tx,
        ctx.workspaceId,
        request.canonicalCompanyId,
        request.linkedCanonicalCompanyId,
      );
      await this.assertEvidenceRefs(tx, ctx.workspaceId, request.evidenceRefs, [
        request.canonicalCompanyId,
        ...(request.linkedCanonicalCompanyId
          ? [request.linkedCanonicalCompanyId]
          : []),
      ]);
      return row(
        await tx.identityResolutionDecision.create({
          data: {
            workspaceId: ctx.workspaceId,
            canonicalCompanyId: request.canonicalCompanyId,
            linkedCanonicalCompanyId: request.linkedCanonicalCompanyId,
            decision: request.decision,
            ruleVersion: request.ruleVersion,
            evidenceRefs: request.evidenceRefs as unknown as Prisma.InputJsonValue,
            actorType: "USER",
            actorId: ctx.userId,
            decidedAt,
          },
        }),
      );
    });
  }

  async appendSystem(
    input: NormalizedSystemIdentityResolutionDecision,
  ): Promise<IdentityResolutionDecisionRecord> {
    const request = normalizeSystemIdentityResolutionDecision(input);
    return this.prisma.withWorkspace(request.workspaceId, async (tx) => {
      await this.assertCompanies(
        tx,
        request.workspaceId,
        request.canonicalCompanyId,
        request.linkedCanonicalCompanyId,
      );
      await this.assertEvidenceRefs(tx, request.workspaceId, request.evidenceRefs);
      return row(
        await tx.identityResolutionDecision.create({
          data: {
            workspaceId: request.workspaceId,
            canonicalCompanyId: request.canonicalCompanyId,
            linkedCanonicalCompanyId: request.linkedCanonicalCompanyId,
            decision: request.decision,
            ruleVersion: request.ruleVersion,
            evidenceRefs: request.evidenceRefs as unknown as Prisma.InputJsonValue,
            actorType: "SYSTEM",
            actorId: request.actorId,
            decidedAt: request.decidedAt,
          },
        }),
      );
    });
  }

  async listByCompany(
    ctx: RequestContext,
    canonicalCompanyId: string,
    page: { cursor: string | null; limit: number },
  ): Promise<{
    records: IdentityResolutionDecisionRecord[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.canonicalCompany.findFirst({
        where: { id: canonicalCompanyId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!company) {
        throw apiNotFound(
          "CANONICAL_COMPANY_NOT_FOUND",
          "canonical company was not found in the active workspace",
        );
      }
      if (page.cursor) {
        const cursor = await tx.identityResolutionDecision.findFirst({
          where: {
            id: page.cursor,
            workspaceId: ctx.workspaceId,
            canonicalCompanyId,
          },
          select: { id: true },
        });
        if (!cursor) {
          throw apiBadRequest(
            "IDENTITY_DECISION_CURSOR_INVALID",
            "cursor is not part of this company decision history",
          );
        }
      }
      const rows = await tx.identityResolutionDecision.findMany({
        where: { workspaceId: ctx.workspaceId, canonicalCompanyId },
        orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
        take: page.limit + 1,
        ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > page.limit;
      const records = rows.slice(0, page.limit).map(row);
      return {
        records,
        nextCursor: hasMore ? records.at(-1)?.id ?? null : null,
        hasMore,
      };
    });
  }

  private async assertCompanies(
    tx: Parameters<Parameters<PrismaService["withWorkspace"]>[1]>[0],
    workspaceId: string,
    sourceId: string,
    targetId: string | null,
  ): Promise<void> {
    const ids = targetId ? [sourceId, targetId] : [sourceId];
    const companies = await tx.canonicalCompany.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true },
    });
    const found = new Set(companies.map((company) => company.id));
    if (!found.has(sourceId)) {
      throw apiNotFound(
        "CANONICAL_COMPANY_NOT_FOUND",
        "canonical company was not found in the active workspace",
      );
    }
    if (targetId && !found.has(targetId)) {
      throw apiNotFound(
        "LINKED_CANONICAL_COMPANY_NOT_FOUND",
        "linked canonical company was not found in the active workspace",
      );
    }
  }

  private async assertEvidenceRefs(
    tx: Parameters<Parameters<PrismaService["withWorkspace"]>[1]>[0],
    workspaceId: string,
    refs: readonly Readonly<IdentityEvidenceRef>[],
    companyIds?: readonly string[],
  ): Promise<void> {
    const ids = (type: IdentityEvidenceRef["type"]) =>
      refs.filter((ref) => ref.type === type).map((ref) => ref.id);
    const fieldIds = ids("FIELD_EVIDENCE");
    const rawIds = ids("RAW_RECORD");
    const signalIds = ids("SOURCE_SIGNAL");
    const [fields, raws, signals] = await Promise.all([
      fieldIds.length
        ? tx.fieldEvidence.findMany({
            where: {
              workspaceId,
              id: { in: fieldIds },
              ...(companyIds
                ? { entityType: "company", entityId: { in: [...companyIds] } }
                : {}),
            },
            select: { id: true },
          })
        : [],
      rawIds.length
        ? tx.rawSourceRecord.findMany({
            where: { workspaceId, id: { in: rawIds } },
            select: { id: true },
          })
        : [],
      signalIds.length
        ? tx.sourceSignal.findMany({
            where: { id: { in: signalIds } },
            select: { id: true },
          })
        : [],
    ]);
    const found = new Set([
      ...fields.map((value) => `FIELD_EVIDENCE:${value.id}`),
      ...raws.map((value) => `RAW_RECORD:${value.id}`),
      ...signals.map((value) => `SOURCE_SIGNAL:${value.id}`),
    ]);
    if (refs.some((ref) => !found.has(`${ref.type}:${ref.id}`))) {
      throw apiNotFound(
        "IDENTITY_EVIDENCE_NOT_FOUND",
        "one or more evidence references were not found",
      );
    }
  }
}
