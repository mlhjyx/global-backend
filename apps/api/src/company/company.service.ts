import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
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
  ): Promise<{
    company: CompanyRow;
    replayed: boolean;
    understanding: 'started' | 'not_started';
  }> {
    if (!dto.website && !dto.name) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'website 与 name 至少提供一个',
        },
      });
    }
    const scope = workspaceExecutionBudgetRequestScope({
      operation: 'POST /companies',
      body: {
        ...(dto.website !== undefined ? { website: dto.website } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.industry !== undefined ? { industry: dto.industry } : {}),
        ...(dto.targetMarkets !== undefined
          ? { targetMarkets: dto.targetMarkets }
          : {}),
        ...(dto.products !== undefined ? { products: dto.products } : {}),
        ...(dto.businessEmail !== undefined
          ? { businessEmail: dto.businessEmail }
          : {}),
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
          return {
            company,
            replayed: true,
            understanding: dto.website ? 'started' : 'not_started',
          };
        }
      }
      throw error;
    }

    if (idempotencyKey) {
      const prior = await this.readPrior(ctx, idempotencyKey);
      if (prior) return this.replay(prior, scope.requestSha256);
    }

    if (dto.website) {
      await assertPublicHttpUrl(dto.website);
    }
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

      // 无官网即无理解（D17）：不消费 Grant、不发 CompanyProfileCreated——
      // 档案字段（行业/产品/目标市场/业务邮箱）照常落库，下游 ICP 以它们为输入。
      let binding: ExecutionBudgetBinding | null = null;
      if (dto.website) {
        binding = await this.authority.consumeVerifiedWorkspaceGrantInTransaction(
          verified,
          tx,
        );
        assertFreshExecutionBudgetBinding(binding);
      }

      const company = await tx.companyProfile.create({
        data: {
          id: companyId,
          workspaceId: ctx.workspaceId,
          name:
            dto.name ??
            (dto.website ? new URL(dto.website).hostname : '未命名企业'),
          website: dto.website ?? null,
          ...(dto.industry !== undefined ? { industry: dto.industry } : {}),
          ...(dto.targetMarkets !== undefined
            ? { targetMarkets: dto.targetMarkets }
            : {}),
          ...(dto.businessEmail !== undefined
            ? { businessEmail: dto.businessEmail }
            : {}),
          status: 'DRAFT',
        },
      });

      // 注册引导填写的主营产品即卖家事实 SoR（D16）：落 Offering(source=onboarding)。
      if (dto.products && dto.products.length > 0) {
        await tx.offering.createMany({
          data: dto.products.map((name) => ({
            workspaceId: ctx.workspaceId,
            companyId: company.id,
            name,
            source: 'onboarding',
          })),
          skipDuplicates: true,
        });
      }

      // Transactional outbox (ADR-009): understanding pipeline consumes this.
      if (binding && dto.website) {
        await tx.outboxEvent.create({
          data: {
            workspaceId: ctx.workspaceId,
            eventType: 'CompanyProfileCreated',
            schemaVersion: 2,
            aggregateType: 'CompanyProfile',
            aggregateId: company.id,
            payload: {
              website: dto.website,
              executionBudget: this.outboxBinding(binding),
            },
          },
        });
      }

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

      return {
        company,
        replayed: false,
        understanding: dto.website
          ? ('started' as const)
          : ('not_started' as const),
      };
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
  ): {
    company: CompanyRow;
    replayed: true;
    understanding: 'started' | 'not_started';
  } {
    const company = restoreCompany(prior.response);
    if (prior.requestHash !== requestSha256 || !company) {
      throw idempotencyConflict();
    }
    return {
      company,
      replayed: true,
      understanding: company.website ? 'started' : 'not_started',
    };
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
        where: { deletedAt: null },
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
    if (!company || company.deletedAt) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
    }
    return company;
  }

  /**
   * 编辑公司档案（2026-11-03）：只开放卖家自查事实（D16）与官网；DRAFT 内可改。
   * 补官网后由调用方另取 quote/Grant 调 retry 端点启动理解——PATCH 本身不消费 Grant。
   */
  async update(ctx: RequestContext, id: string, dto: UpdateCompanyDto) {
    if (dto.website !== undefined) {
      await assertPublicHttpUrl(dto.website);
    }
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id } });
      if (!company || company.deletedAt) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      if (company.status !== 'DRAFT') {
        throw new ConflictException({
          error: { code: 'COMPANY_NOT_EDITABLE', message: '只有 DRAFT 档案可以编辑' },
        });
      }
      const data: Prisma.CompanyProfileUpdateInput = { version: { increment: 1 } };
      if (dto.name !== undefined) data.name = dto.name.trim();
      if (dto.website !== undefined) data.website = dto.website;
      if (dto.industry !== undefined) data.industry = dto.industry.trim();
      if (dto.targetMarkets !== undefined) data.targetMarkets = dto.targetMarkets;
      if (dto.businessEmail !== undefined) data.businessEmail = dto.businessEmail.trim();
      return tx.companyProfile.update({ where: { id }, data });
    });
  }

  /** 软删除 DRAFT 档案（2026-11-03）：行保留、列表/详情不再可见；物理删除归 owner/DSR。 */
  async remove(ctx: RequestContext, id: string): Promise<{ id: string }> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id } });
      if (!company || company.deletedAt) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      if (company.status !== 'DRAFT') {
        throw new ConflictException({
          error: { code: 'COMPANY_NOT_DELETABLE', message: '只有 DRAFT 档案可以删除' },
        });
      }
      await tx.companyProfile.update({
        where: { id },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });
      return { id };
    });
  }

  /** 完整度视图（5.2.7）：企业当前可用性的量化依据。 */
  async completeness(ctx: RequestContext, id: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({
        where: { id },
        select: { id: true, status: true, deletedAt: true },
      });
      if (!company || company.deletedAt) {
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

  /**
   * 重新驱动一次理解：只允许对「最近一次理解失败、仍为 DRAFT」的档案使用。
   * 需要调用方带来一份**新的** workspace Execution Budget Grant（原 Grant 在创建时
   * 已消费，重试不能复用）；事件与创建路径同形（CompanyProfileCreated v2），
   * outbox relay 以同一个 workflowId 重启工作流——Temporal 默认只允许复用已失败
   * 的 workflowId，而这里恰好只在失败后开放重试。
   */
  async retryUnderstanding(
    ctx: RequestContext,
    companyId: string,
    attemptId: string,
    compactJws?: string,
  ): Promise<{ company: CompanyRow }> {
    const scope = workspaceExecutionBudgetRequestScope({
      operation: 'POST /companies/:companyId/understanding/retry',
      companyId,
      body: { attemptId },
    });
    const verified = await this.authority.verifyWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope,
    });
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id: companyId } });
      if (!company || company.deletedAt) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      if (company.status !== 'DRAFT') {
        throw new ConflictException({
          error: {
            code: 'UNDERSTANDING_RETRY_NOT_ALLOWED',
            message: '只在 DRAFT 档案上允许启动/重试理解',
          },
        });
      }
      if (!company.website) {
        throw new ConflictException({
          error: {
            code: 'UNDERSTANDING_WEBSITE_REQUIRED',
            message: '先补企业官网，才能启动理解',
          },
        });
      }
      // 失败过的档案直接允许重试；从未失败的档案要防重复启动（10 分钟内的排队事件算已排队）。
      if (company.understandingFailedAt === null) {
        const pending = await tx.outboxEvent.findFirst({
          where: {
            aggregateId: companyId,
            eventType: 'CompanyProfileCreated',
            occurredAt: { gt: new Date(Date.now() - 10 * 60_000) },
          },
          orderBy: { occurredAt: 'desc' },
        });
        if (pending) {
          throw new ConflictException({
            error: {
              code: 'UNDERSTANDING_ALREADY_PENDING',
              message: '理解已排队或正在进行，请稍后刷新状态',
            },
          });
        }
      }
      const binding = await this.authority.consumeVerifiedWorkspaceGrantInTransaction(
        verified,
        tx,
      );
      assertFreshExecutionBudgetBinding(binding);
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'CompanyProfileCreated',
          schemaVersion: 2,
          aggregateType: 'CompanyProfile',
          aggregateId: company.id,
          payload: {
            website: company.website,
            executionBudget: this.outboxBinding(binding),
          },
        },
      });
      return { company };
    });
  }

  /** 结构化产品/服务（理解工作流抽取，带溯源）。company 不存在时 404。 */
  async listOfferings(ctx: RequestContext, companyId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({
        where: { id: companyId },
        select: { id: true, deletedAt: true },
      });
      if (!company || company.deletedAt) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      return tx.offering.findMany({
        where: { companyId },
        orderBy: [{ confidence: 'desc' }, { name: 'asc' }],
      });
    });
  }
}
