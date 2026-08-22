import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { CreateCompanyDto } from './dto/create-company.dto';
import { assertPublicHttpUrl } from '../adapters/url-guard';
import {
  ExecutionBudgetAuthorityService,
  assertFreshExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-authority.service';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import { workspaceExecutionBudgetRequestScope } from '../execution-budget/execution-budget-request-scope';

type CompanyRow = Prisma.CompanyProfileGetPayload<Record<string, never>>;

type StoredCompanyReplay = Readonly<{
  schemaVersion: 'company-authority-replay/v1';
  requestSha256: string;
  authorityTokenSha256: string;
  company: CompanyRow & { createdAt: string; updatedAt: string };
}>;

function restoreCompany(value: unknown): CompanyRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const candidate =
    record.schemaVersion === 'company-authority-replay/v1'
      ? record.company
      : record;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const stored = candidate as CompanyRow & {
    createdAt: string | Date;
    updatedAt: string | Date;
  };
  if (typeof stored.id !== 'string') return null;
  return {
    ...stored,
    createdAt: new Date(stored.createdAt),
    updatedAt: new Date(stored.updatedAt),
  } as CompanyRow;
}

function storedReplay(value: unknown): StoredCompanyReplay | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 'company-authority-replay/v1' ||
    typeof record.requestSha256 !== 'string' ||
    typeof record.authorityTokenSha256 !== 'string'
  ) {
    return null;
  }
  return value as StoredCompanyReplay;
}

function idempotencyConflict(): ConflictException {
  return new ConflictException({
    error: {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'idempotency key is already bound to another request',
    },
  });
}

@Injectable()
export class CompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: ExecutionBudgetAuthorityService,
  ) {}

  /**
   * Create a DRAFT profile and append the event that will drive understanding.
   * website 先过我方侧 SSRF 守卫（PRD 10.7.3）；Idempotency-Key 重放返回首个结果
   * （PRD 11.16）。
   */
  async create(
    ctx: RequestContext,
    dto: CreateCompanyDto,
    idempotencyKey?: string,
    compactJws?: string,
  ): Promise<{ company: CompanyRow; replayed: boolean }> {
    const scope = workspaceExecutionBudgetRequestScope({
      operation: 'POST /companies',
      body: {
        website: dto.website,
        ...(dto.name !== undefined ? { name: dto.name } : {}),
      },
    });
    let verified;
    try {
      verified = await this.authority.verifyWorkspaceGrant({
        compactJws,
        identity: ctx,
        scope,
      });
    } catch (error) {
      if (
        error instanceof ExecutionBudgetGrantError &&
        error.code === 'EXECUTION_BUDGET_GRANT_EXPIRED' &&
        idempotencyKey &&
        typeof compactJws === 'string'
      ) {
        const prior = await this.readPrior(ctx, idempotencyKey);
        const stored = storedReplay(prior?.response);
        const tokenSha256 = createHash('sha256')
          .update(compactJws)
          .digest('hex');
        const company = restoreCompany(prior?.response);
        if (
          prior?.requestHash === scope.requestSha256 &&
          stored?.requestSha256 === scope.requestSha256 &&
          stored.authorityTokenSha256 === tokenSha256 &&
          company
        ) {
          return { company, replayed: true };
        }
      }
      throw error;
    }

    if (idempotencyKey) {
      const prior = await this.readPrior(ctx, idempotencyKey);
      if (prior) return this.replay(prior, scope.requestSha256);
    }

    await assertPublicHttpUrl(dto.website);
    const companyId = randomUUID();

    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      if (idempotencyKey) {
        const prior = await tx.idempotencyKey.findUnique({
          where: {
            workspaceId_endpoint_key: {
              workspaceId: ctx.workspaceId,
              endpoint: 'POST /companies',
              key: idempotencyKey,
            },
          },
        });
        if (prior) {
          return this.replay(prior, scope.requestSha256);
        }
      }

      // JIT-provision the tenant anchor so domain FKs resolve.
      await tx.workspace.upsert({
        where: { id: ctx.workspaceId },
        update: {},
        create: { id: ctx.workspaceId },
      });

      const binding = await this.authority.consumeVerifiedWorkspaceGrantInTransaction(
        verified,
        tx,
      );
      assertFreshExecutionBudgetBinding(binding);

      const company = await tx.companyProfile.create({
        data: {
          id: companyId,
          workspaceId: ctx.workspaceId,
          name: dto.name ?? new URL(dto.website).hostname,
          website: dto.website,
          status: 'DRAFT',
        },
      });

      // Transactional outbox (ADR-009): understanding pipeline consumes this.
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'CompanyProfileCreated',
          aggregateType: 'CompanyProfile',
          aggregateId: company.id,
          payload: {
            website: dto.website,
            executionBudget: this.outboxBinding(binding),
          },
        },
      });

      if (idempotencyKey) {
        await tx.idempotencyKey.create({
          data: {
            workspaceId: ctx.workspaceId,
            endpoint: 'POST /companies',
            key: idempotencyKey,
            requestHash: scope.requestSha256,
            response: {
              schemaVersion: 'company-authority-replay/v1',
              requestSha256: scope.requestSha256,
              authorityTokenSha256: verified.tokenSha256,
              company,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }

      return { company, replayed: false };
    });
  }

  private readPrior(ctx: RequestContext, idempotencyKey: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.idempotencyKey.findUnique({
        where: {
          workspaceId_endpoint_key: {
            workspaceId: ctx.workspaceId,
            endpoint: 'POST /companies',
            key: idempotencyKey,
          },
        },
      }),
    );
  }

  private replay(
    prior: { response: Prisma.JsonValue; requestHash: string | null },
    requestSha256: string,
  ): { company: CompanyRow; replayed: true } {
    const company = restoreCompany(prior.response);
    if (prior.requestHash !== requestSha256 || !company) {
      throw idempotencyConflict();
    }
    return { company, replayed: true };
  }

  private outboxBinding(binding: ExecutionBudgetBinding) {
    return {
      authorityId: binding.authorityId,
      replay: binding.replay,
      scopeKey: binding.scopeKey,
      accountKey: binding.accountKey,
      purpose: binding.purpose,
      subjectType: binding.subjectType,
      subjectId: binding.subjectId,
      requestSha256: binding.requestSha256,
    };
  }

  async list(ctx: RequestContext, limit: number, cursor?: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.companyProfile.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return {
        data,
        nextCursor: hasMore ? data[data.length - 1].id : null,
        hasMore,
      };
    });
  }

  async get(ctx: RequestContext, id: string) {
    // RLS confines findUnique to this workspace → cross-tenant reads return null → 404.
    const company = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.companyProfile.findUnique({ where: { id } }),
    );
    if (!company) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
    }
    return company;
  }

  /** 完整度视图（5.2.7）：企业当前可用性的量化依据。 */
  async completeness(ctx: RequestContext, id: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!company) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      const [approved, pending, offerings, conflictsOpen] = await Promise.all([
        tx.claim.count({ where: { companyId: id, status: 'APPROVED' } }),
        tx.claim.count({ where: { companyId: id, status: 'NEEDS_REVIEW' } }),
        tx.offering.count({ where: { companyId: id } }),
        tx.knowledgeConflict.count({ where: { companyId: id, status: 'OPEN' } }),
      ]);
      return { status: company.status, approvedClaims: approved, pendingClaims: pending, offerings, conflictsOpen };
    });
  }

  /** 人工确认（5.2.4 Gate 的显式出口）：REVIEW → ACTIVE，不等审批阈值。 */
  async confirm(ctx: RequestContext, id: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id } });
      if (!company) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      if (company.status !== 'REVIEW') {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `company is ${company.status}; only REVIEW can be confirmed` },
        });
      }
      return tx.companyProfile.update({ where: { id }, data: { status: 'ACTIVE', version: { increment: 1 } } });
    });
  }

  /** 结构化产品/服务（理解工作流抽取，带溯源）。company 不存在时 404。 */
  async listOfferings(ctx: RequestContext, companyId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      return tx.offering.findMany({
        where: { companyId },
        orderBy: [{ confidence: 'desc' }, { name: 'asc' }],
      });
    });
  }
}
