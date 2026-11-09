import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { recordPersonalDataAccess } from '../compliance/personal-data-access-audit';
import {
  ExecutionBudgetAuthorityService,
  assertFreshExecutionBudgetBinding,
} from '../execution-budget/execution-budget-authority.service';
import { enrichContactsExecutionBudgetRequestScope } from '../execution-budget/execution-budget-request-scope';
import { type BudgetStore, TOOL_BUDGET_STORE, UnavailableBudgetStore } from '../tools/budget-store';
import { TOOL_BROKER } from '../tools/tool-broker.tokens';
import type { ExecutionBroker } from '../tools/tool-contract';
import {
  enrichCompanyContacts,
  type EnrichCompanyContactsResult,
} from '../enrichment/waterfall/enrich-company-contacts';
import { CapBudget } from '../enrichment/waterfall/enrichment-budget';
import { PrismaCircuitBreakerStore } from '../enrichment/waterfall/circuit-breaker';
import {
  resolveConfiguredFinderProviders,
  resolveConfiguredTailFinderProviders,
} from '../enrichment/finders/finder-pool';
import { isValidLawfulBasis, stampLawfulBasis } from './compliance/email-verification-gate';
import { LawfulBasis } from './provider-contract';

/**
 * P1-10a：公司级邮箱富集（付费 finder 瀑布：Hunter → Findymail → Prospeo，A 档追加 Apollo/PDL）。
 *
 * 从 DiscoveryService 拆出（G9 文件预算门：discovery.service.ts 已达基线棘轮上限）：
 * Grant（purpose contact.enrich，subject=company）一次性消费；预算以授权 cap 为硬上限
 * （CapBudget 忠实执行——cap 不足如实 skipped_budget，绝不超支）；lawfulBasis 必填
 * （把具名联系人 + 公司域送给第三方处理器是个人数据处理）。PII 访问审计与请求同留痕。
 */
@Injectable()
export class ContactEnrichmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: ExecutionBudgetAuthorityService,
    @Optional() @Inject(TOOL_BUDGET_STORE) private readonly budgetStore?: BudgetStore,
    /** SMTP 兜底票（验证瀑布第二票）的出网闸门；未装配时兜底票不参与。 */
    @Optional() @Inject(TOOL_BROKER) private readonly toolBroker?: ExecutionBroker,
  ) {}

  private budgets(): BudgetStore {
    return (
      this.budgetStore ??
      new UnavailableBudgetStore('ContactEnrichmentService requires an authoritative BudgetStore')
    );
  }

  async enrichContacts(
    ctx: RequestContext,
    companyId: string,
    opts: {
      lawfulBasis?: LawfulBasis;
      contactIds?: string[];
      maxProviders?: number;
      maxProbe?: number;
      attemptId?: string;
    },
    compactJws?: string,
  ): Promise<EnrichCompanyContactsResult> {
    if (!isValidLawfulBasis(opts?.lawfulBasis)) {
      throw new ForbiddenException({
        error: {
          code: 'CONTACT_ENRICH_LAWFUL_BASIS_REQUIRED',
          message: 'an explicit lawful basis is required for external contact enrichment',
        },
      });
    }
    const recordedBasis = stampLawfulBasis(
      opts.lawfulBasis,
      ctx.userId,
      new Date().toISOString(),
    );
    const binding = await this.authority.consumeWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope: enrichContactsExecutionBudgetRequestScope(companyId, {
        attemptId: opts.attemptId,
      }),
    });
    assertFreshExecutionBudgetBinding(binding);
    const authorization = await this.budgets().attestAuthorized({
      authorityId: binding.authorityId,
      scopeKey: binding.scopeKey,
      accountKey: binding.accountKey,
    });
    const result = await enrichCompanyContacts(
      {
        prisma: this.prisma,
        ownerPrisma: this.prisma,
        finders: resolveConfiguredFinderProviders(),
        tailFinders: resolveConfiguredTailFinderProviders(),
        circuits: new PrismaCircuitBreakerStore(this.prisma),
        budget: new CapBudget(Number(authorization.authorizedCapMicrousd)),
        actorId: ctx.userId,
        ...(this.toolBroker ? { verificationBroker: this.toolBroker } : {}),
      },
      {
        workspaceId: ctx.workspaceId,
        companyId,
        accountKey: binding.accountKey,
        lawfulBasis: recordedBasis,
        ...(opts.contactIds ? { contactIds: opts.contactIds } : {}),
        ...(opts.maxProviders !== undefined
          ? { maxProvidersPerContact: opts.maxProviders }
          : {}),
        ...(opts.maxProbe !== undefined ? { maxVerificationCalls: opts.maxProbe } : {}),
      },
    );
    await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      recordPersonalDataAccess(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        actorKind: 'user',
        purpose: 'contact_discovery',
        companyId,
        fieldClasses: ['person_name', 'email'],
        subjectCount: result.attempted,
        lawfulBasisRef: opts.lawfulBasis?.ref ?? null,
      }),
    );
    return result;
  }
}
