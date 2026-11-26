import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import type {
  FeedbackOutcome,
  FeedbackRejectionReason,
  RecordIcpFeedbackDto,
} from './dto/feedback-learning.dto';
import {
  applyFeedbackEvolutionToAttributes,
  buildFeedbackLearningSummary,
  normalizeFeedbackDomain,
  type IcpFeedbackLearningSummary,
} from './icp-three-layer';

export interface RecordFeedbackResult {
  readonly icpId: string;
  readonly icpVersion: number;
  readonly recorded: {
    readonly outcome: FeedbackOutcome;
    readonly rejectionReason: FeedbackRejectionReason | null;
    readonly domain: string | null;
    readonly companyId: string | null;
    readonly leadId: string | null;
    readonly recordedAt: string;
  };
  readonly appliedRules: {
    readonly addedExcludedDomain: string | null;
    readonly addedExcludedKeywords: string[];
    readonly addedCounterExample: boolean;
  };
  readonly summary: IcpFeedbackLearningSummary;
}

@Injectable()
export class FeedbackLearningService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(ctx: RequestContext, icpId: string): Promise<IcpFeedbackLearningSummary> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const icp = await tx.icpDefinition.findUnique({
        where: { id: icpId },
        select: { id: true, name: true, version: true, exclusions: true, companyAttributes: true },
      });
      if (!icp) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
      }
      return buildFeedbackLearningSummary(icp);
    });
  }

  async recordFeedback(
    ctx: RequestContext,
    icpId: string,
    input: RecordIcpFeedbackDto,
  ): Promise<RecordFeedbackResult> {
    const recordedAt = new Date().toISOString();
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM icp_definition WHERE id = ${icpId}::uuid FOR UPDATE`;
      const icp = await tx.icpDefinition.findUnique({
        where: { id: icpId },
        select: { id: true, name: true, version: true, exclusions: true, companyAttributes: true },
      });
      if (!icp) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
      }

      const resolved = await this.resolveCompanyContext(tx, input);
      const evolution = applyFeedbackEvolutionToAttributes({
        existingAttributes: icp.companyAttributes,
        exclusions: icp.exclusions,
        outcome: input.outcome,
        rejectionReason: input.rejectionReason ?? null,
        domain: resolved.domain,
        companyName: resolved.companyName,
        industry: resolved.industry,
        excludedKeywords: input.excludedKeywords,
        note: input.note ?? null,
        recordedAt,
      });

      const updated = await tx.icpDefinition.update({
        where: { id: icpId },
        data: {
          companyAttributes: evolution.nextAttributes as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
        select: { id: true, name: true, version: true, exclusions: true, companyAttributes: true },
      });

      const summary = buildFeedbackLearningSummary(updated);
      return {
        icpId: updated.id,
        icpVersion: updated.version,
        recorded: {
          outcome: input.outcome,
          rejectionReason: input.rejectionReason ?? null,
          domain: resolved.domain,
          companyId: resolved.companyId,
          leadId: input.leadId ?? null,
          recordedAt,
        },
        appliedRules: evolution.appliedRules,
        summary,
      };
    });
  }

  private async resolveCompanyContext(
    tx: Prisma.TransactionClient,
    input: RecordIcpFeedbackDto,
  ): Promise<{
    companyId: string | null;
    domain: string | null;
    companyName: string | null;
    industry: string | null;
  }> {
    let companyId = input.companyId ?? null;
    if (!companyId && input.leadId) {
      const lead = await tx.lead.findUnique({
        where: { id: input.leadId },
        select: { canonicalCompanyId: true },
      });
      companyId = lead?.canonicalCompanyId ?? null;
    }

    let dbCompany: { name: string; domain: string | null; industry: string | null } | null = null;
    if (companyId && (!input.domain || !input.companyName || !input.industry)) {
      dbCompany = await tx.canonicalCompany.findUnique({
        where: { id: companyId },
        select: { name: true, domain: true, industry: true },
      });
    }

    return {
      companyId,
      domain: normalizeFeedbackDomain(input.domain ?? dbCompany?.domain ?? null),
      companyName: (input.companyName ?? dbCompany?.name ?? '').trim().slice(0, 200) || null,
      industry: (input.industry ?? dbCompany?.industry ?? '').trim().slice(0, 120) || null,
    };
  }
}
