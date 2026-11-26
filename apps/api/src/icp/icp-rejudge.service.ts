import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { judgeContractMode } from '../discovery/fit-judge-v2';
import { selectRejudgeCandidates } from '../discovery/judgment/rejudge-candidates';
import { planRejudgeBatches, RejudgePlanError } from '../discovery/judgment/rejudge-plan';
import {
  assertFreshExecutionBudgetBinding,
  ExecutionBudgetAuthorityService,
} from '../execution-budget/execution-budget-authority.service';
import { icpRejudgeExecutionBudgetRequestScope } from '../execution-budget/execution-budget-request-scope';
import {
  canonicalIcpRejudgeRequestMaterialBody,
  normalizeIcpRejudgeBudgetBody,
  type IcpRejudgeHttpRequestBody,
} from '../execution-budget/icp-rejudge-budget-request';
import {
  toPlainRejudgeRequestBody,
  type RejudgeIcpLeadsDto,
  type RejudgeIcpLeadsResponseDto,
} from './icp-rejudge.dto';

function badRequest(): never {
  throw new BadRequestException({
    error: {
      code: 'EXECUTION_BUDGET_REQUEST_INVALID',
      message: 'rejudge request parameters are invalid',
    },
  });
}

@Injectable()
export class IcpRejudgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budgets: ExecutionBudgetAuthorityService,
  ) {}

  async requestRejudge(
    ctx: RequestContext,
    icpId: string,
    body: RejudgeIcpLeadsDto | IcpRejudgeHttpRequestBody,
    compactJws?: string,
  ): Promise<RejudgeIcpLeadsResponseDto> {
    if (judgeContractMode() !== 'enforce') {
      throw new ConflictException({
        error: {
          code: 'INVALID_STATE',
          message: 'audited historical lead rejudge requires JUDGE_CONTRACT_MODE=enforce',
        },
      });
    }

    const normalized = normalizeIcpRejudgeBudgetBody(
      toPlainRejudgeRequestBody(body),
      badRequest,
    );
    const scope = icpRejudgeExecutionBudgetRequestScope(
      icpId,
      canonicalIcpRejudgeRequestMaterialBody(normalized),
    );
    // Stage 1: verify grant signature & scope WITHOUT consuming it yet so preflight rejections burn zero budget.
    const authority = await this.budgets.verifyWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope,
    });

    const candidates = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const icp = await tx.icpDefinition.findUnique({
        where: { id: icpId },
        select: { id: true, status: true },
      });
      if (!icp) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'icp not found' },
        });
      }
      if (icp.status !== 'ACTIVE') {
        throw new ConflictException({
          error: {
            code: 'INVALID_STATE',
            message: `icp is ${icp.status}; rejudge requires ACTIVE`,
          },
        });
      }
      return selectRejudgeCandidates(tx, {
        workspaceId: ctx.workspaceId,
        icpId,
        companyIds: normalized.companyIds,
        refreshWebsiteProfile: normalized.refreshWebsiteProfile,
        refreshCorroboration: normalized.refreshCorroboration,
        includeFresh: normalized.includeFresh,
      });
    });

    if (candidates.length === 0) {
      throw new ConflictException({
        error: {
          code: 'NO_REJUDGE_CANDIDATES',
          message: 'no active candidates require rejudge for this ICP',
        },
      });
    }

    let plan: ReturnType<typeof planRejudgeBatches>;
    try {
      plan = planRejudgeBatches(candidates, {
        maxCompanies: normalized.maxCompanies,
        batchSize: normalized.batchSize,
        costCapMicros: authority.capMicrousd ?? 0n,
      });
    } catch (error) {
      if (error instanceof RejudgePlanError) {
        throw new ConflictException({
          error: { code: error.code, message: error.message },
        });
      }
      throw error;
    }

    const rejudgeId = randomUUID();
    const batches = plan.batches.map((batch) => ({
      index: batch.index,
      companyIds: batch.candidates.map((candidate) => candidate.canonicalCompanyId),
    }));

    // Stage 2: consume the verified grant + write LeadRejudgeRequested outbox atomically in one transaction.
    await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const icp = await tx.icpDefinition.findUnique({
        where: { id: icpId },
        select: { id: true, status: true },
      });
      if (!icp) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'icp not found' },
        });
      }
      if (icp.status !== 'ACTIVE') {
        throw new ConflictException({
          error: {
            code: 'INVALID_STATE',
            message: `icp is ${icp.status}; rejudge requires ACTIVE`,
          },
        });
      }
      const binding = await this.budgets.consumeVerifiedWorkspaceGrantInTransaction(
        authority,
        tx,
      );
      assertFreshExecutionBudgetBinding(binding);
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'LeadRejudgeRequested',
          schemaVersion: 2,
          aggregateType: 'ICP',
          aggregateId: icpId,
          payload: {
            rejudgeId,
            workspaceId: ctx.workspaceId,
            icpId,
            executionContractVersion: 2,
            budgetBinding: binding,
            batches,
            refreshCorroboration: normalized.refreshCorroboration,
            refreshWebsiteProfile: normalized.refreshWebsiteProfile,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });

    return {
      rejudgeId,
      icpId,
      status: 'ACCEPTED',
      candidateCount: plan.totalCandidates,
      batchCount: plan.batches.length,
      estimatedCostMicros: plan.estimatedCostMicros.toString(),
      refreshCorroboration: normalized.refreshCorroboration,
      refreshWebsiteProfile: normalized.refreshWebsiteProfile,
    };
  }
}
