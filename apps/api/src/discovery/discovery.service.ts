import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { DiscoveryProviderRegistry } from './provider.registry';
import { persistDiscoveredContacts } from './contact-persist';
import { EmailGuesser, GuessResult } from './email-guesser';
import { persistGuessedEmail } from './email-guess-persist';
import { buildGuessTargets } from './email-guess-targets';
import { EmailVerdict, EmailVerifyContext, LawfulBasis, ProviderContactRecord } from './provider-contract';
import { cleanEmail } from '../acquisition/clean';
import { evaluateEmailGate, resolveEmailVerificationPolicy, stampLawfulBasis,
} from './compliance/email-verification-gate';
import {
  canonicalizeSuppressionValue,
  canonicalizeSuppressionValues,
  companyMatchesSuppression,
} from './suppression-value';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';
import { companyMayUseExternalProcessing, contactMayUseExternalProcessing } from './company-suppression-gate';
import { type BudgetStore, TOOL_BUDGET_STORE, UnavailableBudgetStore } from '../tools/budget-store';
import {
  assertProductDiscoveryProvenance,
  isSyntheticDiscoveryProvenance,
} from './evidence-license';
import { collectProductReadPage } from './product-read-pagination';
import {
  ExecutionBudgetAuthorityService,
  assertFreshExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-authority.service';
import {
  guessEmailsExecutionBudgetRequestScope,
  verifyContactPointExecutionBudgetRequestScope,
  workspaceExecutionBudgetRequestScope,
  type GuessEmailsHttpRequestBody,
  type VerifyContactPointHttpRequestBody,
} from '../execution-budget/execution-budget-request-scope';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import { applyDomainAckConsumerTransactions } from '../durable-results/domain-ack-consumer-bindings';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const PREFERENCE_SUPPRESSION_REASONS = new Set(['manual', 'bounce']);
const CONTACT_DISCOVERY_RECEIPT_PRODUCERS = Object.freeze([
  'crawl4ai.fetch',
  'companies_house.search',
  'inpi_rne.search',
  'google_patents.search',
  'contact.find_decision_makers',
] as const);
type ContactDiscoveryReceiptProducer =
  (typeof CONTACT_DISCOVERY_RECEIPT_PRODUCERS)[number];
export const SUPPRESSION_DECISIONS = ['RELEASE_REQUESTED', 'IDENTITY_CORRECTION_REQUESTED'] as const;
export const SUPPRESSION_DECISION_REASONS = [
  'USER_PREFERENCE_CHANGED',
  'BOUNCE_CLASSIFICATION_ERROR',
  'IDENTITY_MISASSOCIATION',
  'DUPLICATE_RECORD',
  'OTHER',
] as const;

export type SuppressionDecisionRequest = {
  requestId: string;
  decision: (typeof SUPPRESSION_DECISIONS)[number];
  reasonCode: (typeof SUPPRESSION_DECISION_REASONS)[number];
};

export type SuppressionPageRequest = { cursor?: string; limit?: number };

function contactReceiptProducer(
  producerId: string,
): producerId is ContactDiscoveryReceiptProducer {
  return CONTACT_DISCOVERY_RECEIPT_PRODUCERS.includes(
    producerId as ContactDiscoveryReceiptProducer,
  );
}

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: DiscoveryProviderRegistry,
    private readonly authority: ExecutionBudgetAuthorityService,
    @Optional() @Inject(TOOL_BUDGET_STORE) private readonly budgetStore?: BudgetStore,
  ) {}

  private budgets(): BudgetStore {
    return this.budgetStore ?? new UnavailableBudgetStore('DiscoveryService requires an authoritative BudgetStore');
  }

  /** 触发执行：READY 计划 → DiscoveryRun + outbox 事件（relay 启动 Temporal workflow）。 */
  async executePlan(ctx: RequestContext, planId: string, compactJws?: string) {
    const verified = await this.authority.verifyWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope: workspaceExecutionBudgetRequestScope({
        operation: 'POST /query-plans/:planId/execute',
        planId,
      }),
    });
    const runId = randomUUID();
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const binding = await this.authority.consumeVerifiedWorkspaceGrantInTransaction(
        verified,
        tx,
      );
      assertFreshExecutionBudgetBinding(binding);
      const plan = await tx.discoveryQueryPlan.findUnique({ where: { id: planId },
      });
      if (!plan) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'query plan not found' },
        });
      if (plan.status !== 'READY') {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `plan is ${plan.status}; confirm it (READY) before executing`,
          },
        });
      }
      const run = await tx.discoveryRun.create({
        data: { id: runId, workspaceId: ctx.workspaceId, planId, icpId: plan.icpId },
      });
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'DiscoveryRunRequested',
          schemaVersion: 2,
          aggregateType: 'DiscoveryRun',
          aggregateId: run.id,
          payload: {
            planId,
            icpId: plan.icpId,
            executionBudget: this.outboxBinding(binding),
          },
        },
      });
      return run;
    });
  }

  async getRun(ctx: RequestContext, runId: string) {
    const run = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.discoveryRun.findUnique({ where: { id: runId } }),
    );
    if (!run)
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: 'run not found' },
      });
    return run;
  }

  listCanonicalCompanies(ctx: RequestContext, opts: { status?: string; limit: number; cursor?: string }) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      return collectProductReadPage({
        limit: opts.limit,
        cursor: opts.cursor,
        fetchBatch: (cursor, take) =>
          tx.canonicalCompany.findMany({
            where: opts.status ? { status: opts.status } : {},
            take,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
        projectProductRows: async (rows) => {
          const provenance = await tx.fieldEvidence.findMany({
            where: {
              entityType: 'company',
              entityId: { in: rows.map((company) => company.id) },
            },
            select: { entityId: true, providerKey: true, license: true },
          });
          const quarantinedIds = new Set(
            provenance
              .filter(isSyntheticDiscoveryProvenance)
              .map((evidence) => evidence.entityId),
          );
          return rows
            .filter((company) => !quarantinedIds.has(company.id))
            .map((company) => ({ cursor: company.id, value: company }));
        },
      });
    });
  }

  async getCanonicalCompany(ctx: RequestContext, id: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.canonicalCompany.findUnique({
        where: { id },
        include: { contacts: { include: { contactPoints: true } } },
      });
      if (!company)
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'company not found' },
        });
      const evidence = await tx.fieldEvidence.findMany({
        where: {
          entityId: {
            in: [company.id, ...company.contacts.map((contact) => contact.id)],
          },
        },
        orderBy: { fetchedAt: 'desc' },
      });
      if (evidence.some(isSyntheticDiscoveryProvenance)) {
        throw new ConflictException({
          error: {
            code: 'SYNTHETIC_PROVENANCE_QUARANTINED',
            message: 'historical synthetic discovery evidence is quarantined from product reads',
          },
        });
      }
      return { company, evidence };
    });
  }

  /**
   * Waterfall 第 5 步（PRD 7.4.8）：仅对已选中的高价值企业按需发现联系人。
   * Suppression 在写入前检查（PRD 12.6 最小化：被禁邮箱直接不入库）。
   * 短事务①载入 → **事务外**网络发现（decision_maker 抓多页 + LLM，可达数分钟，绝不持 DB 事务跨这段）
   * → 短事务②持久化（与 verifyContactPoint 同一纪律）。
   */
  async discoverContacts(
    ctx: RequestContext,
    companyId: string,
    compactJws?: string,
  ) {
    const binding = await this.authority.consumeWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope: workspaceExecutionBudgetRequestScope({
        operation: 'POST /canonical-companies/:id/discover-contacts',
        companyId,
      }),
    });
    assertFreshExecutionBudgetBinding(binding);
    const loaded = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.canonicalCompany.findUnique({
        where: { id: companyId },
      });
      if (!company)
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'company not found' },
        });
      const evidenceRows = await tx.fieldEvidence.findMany({
        where: {
          entityType: 'company',
          entityId: companyId,
        },
        select: { providerKey: true, license: true },
      });
      if (evidenceRows.some(isSyntheticDiscoveryProvenance)) {
        throw new ConflictException({
          error: {
            code: 'SYNTHETIC_PROVENANCE_QUARANTINED',
            message: 'historical synthetic discovery evidence is quarantined from product actions',
          },
        });
      }
      const companySuppressions = await tx.suppressionRecord.findMany({
        where: { type: { in: ['domain', 'company_name'] } },
        select: { type: true, value: true },
      });
      if (company.status === 'SUPPRESSED' || companyMatchesSuppression(companySuppressions, company)) {
        throw new ConflictException({
          error: {
            code: 'SUPPRESSED',
            message: 'company is suppressed; contact discovery blocked',
          },
        });
      }
      const adapters = await this.providers.routeContactDiscovery(tx as never);
      if (!adapters.length) {
        throw new ConflictException({
          error: {
            code: 'NO_PROVIDER',
            message: 'no contact discovery provider enabled',
          },
        });
      }
      const suppressedEmails = canonicalizeSuppressionValues(
        'email',
        (await tx.suppressionRecord.findMany({ where: { type: 'email' } })).map((s) => s.value),
      );
      return { company, adapters, suppressedEmails };
    });

    // 事务外 fan-out：遍历全部 enabled 的联系人 adapter（decision_maker/public_web/companies_house…）。
    // 🔴 单 adapter 失败/闸门拒绝不阻断其余（fail-safe）；各自保留自己的 adapterKey。
    const perAdapter: {
      key: string;
      contacts: ProviderContactRecord[];
      costCents: number;
      durableReceipts: Array<{
        producerId: ContactDiscoveryReceiptProducer;
        receipt: DurableExecutionReceipt;
      }>;
    }[] = [];
    const authorizeExternalAction = () =>
      this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
        companyMayUseExternalProcessing(tx, ctx.workspaceId, companyId),
      );
    const accountKey = binding.accountKey;
    const budgets = this.budgets();
    await budgets.attestAuthorized({
      authorityId: binding.authorityId,
      scopeKey: binding.scopeKey,
      accountKey,
    });
    for (const adapter of loaded.adapters) {
        try {
          const authorized = await authorizeExternalAction();
          if (!authorized) break;
          const durableReceipts: Array<{
            producerId: ContactDiscoveryReceiptProducer;
            receipt: DurableExecutionReceipt;
          }> = [];
          const captureContactReceipt = (
            producerId: string,
            receipt: DurableExecutionReceipt,
          ): void => {
            if (!contactReceiptProducer(producerId)) {
              throw new Error('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
            }
            durableReceipts.push({ producerId, receipt });
          };
          const result = await adapter.discoverContacts(
            {
              name: loaded.company.name,
              domain: loaded.company.domain ?? undefined,
              country: loaded.company.country ?? undefined,
            },
            {
              workspaceId: binding.scopeKey,
              runId: accountKey,
              correlationId: companyId,
              authorizeExternalAction,
              onDurableReceipt: captureContactReceipt,
            },
          );
          perAdapter.push({
            key: adapter.key,
            contacts: result.contacts,
            costCents: result.costCents,
            durableReceipts,
          });
        } catch (err) {
          if (
            isExecutionControlError(err) ||
            err instanceof Error &&
              err.message === 'DOMAIN_ACK_CONSUMER_BINDING_MISSING'
          ) throw err;
          console.warn(`[discoverContacts] adapter ${adapter.key} failed for ${companyId}: ${String(err).slice(0, 150)}`);
        }
        if ((await budgets.status({ workspaceId: binding.scopeKey, accountKey })).exhausted) break;
    }

    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const persisted = await applyDomainAckConsumerTransactions({
        transaction: tx,
        acknowledgements: perAdapter.flatMap((adapterResult) =>
          adapterResult.durableReceipts.map(({ producerId, receipt }) => ({
            producerId,
            receipt,
            domainAckKey:
              `contact:${loaded.company.id}:${adapterResult.key}:${receipt.operationId}`,
            domainRevision: receipt.resultDigest,
          }))),
        apply: async (transaction) => {
          // 同一 tx 内顺序 persist：后一 adapter 的 resolve 看得到前一 adapter 刚插入的行 →
          // 同一人经 resolvePersonIdentity 合并（decision_maker 的 email + CH 的 officer_id 落同一条）。
          let skippedSuppressed = 0;
          let skippedInvalid = 0;
          for (const pa of perAdapter) {
            const res = await persistDiscoveredContacts(transaction, {
              workspaceId: ctx.workspaceId,
              company: {
                id: loaded.company.id,
                dedupeKey: loaded.company.dedupeKey,
              },
              adapterKey: pa.key,
              contacts: pa.contacts,
              suppressedEmails: loaded.suppressedEmails,
            });
            skippedSuppressed += res.skippedSuppressed;
            skippedInvalid += res.skippedInvalid;
            if (pa.costCents > 0) {
              await transaction.usageLedger.create({
                data: {
                  workspaceId: ctx.workspaceId,
                  resourceType: 'provider_call',
                  quantity: pa.contacts.length,
                  costUsd: pa.costCents / 100,
                  refType: 'canonical_company',
                  refId: loaded.company.id,
                  meta: { provider: pa.key, op: 'contact_discovery' },
                },
              });
            }
          }
          const contacts = await transaction.canonicalContact.findMany({
            where: { companyId: loaded.company.id },
            include: { contactPoints: true },
          });
          return { contacts, skippedSuppressed, skippedInvalid };
        },
      });
      if (persisted) return persisted;
      return {
        contacts: await tx.canonicalContact.findMany({
          where: { companyId: loaded.company.id },
          include: { contactPoints: true },
        }),
        skippedSuppressed: 0,
        skippedInvalid: 0,
      };
    });
  }

  /**
   * 选项 B · P0.3：对某公司**缺邮箱的具名决策人**批量猜测邮箱并落库。
   * 复用 discoverContacts 纪律：短事务①载入（公司+联系人+已知样本+禁联）→ **事务外**网络
   * （EmailGuesser 逐人 SMTP 验证，可数分钟，绝不持 DB 事务）→ 短事务②落库（persistGuessedEmail）。
   *
   * 🔴 合规：猜出的都是人名邮箱，需 lawfulBasis 或显式开关（否则 guesser 返回 blocked、零探测）；
   *    RISKY 未证实猜测落库但 allowedActions 不含 outreach；suppression 命中不落。
   */
  async guessEmailsForCompany(
    ctx: RequestContext,
    companyId: string,
    opts?: {
      lawfulBasis?: LawfulBasis;
      allowPersonalWithoutBasis?: boolean;
      maxContacts?: number;
      maxProbe?: number;
    },
    compactJws?: string,
    publicRequestBody?: GuessEmailsHttpRequestBody,
  ) {
    const binding = await this.authority.consumeWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope: guessEmailsExecutionBudgetRequestScope(
        companyId,
        publicRequestBody,
      ),
    });
    assertFreshExecutionBudgetBinding(binding);
    const loaded = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.canonicalCompany.findUnique({
        where: { id: companyId },
      });
      if (!company)
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'company not found' },
        });
      const companySuppressions = await tx.suppressionRecord.findMany({
        where: { type: { in: ['domain', 'company_name'] } },
        select: { type: true, value: true },
      });
      if (company.status === 'SUPPRESSED' || companyMatchesSuppression(companySuppressions, company)) {
        throw new ConflictException({
          error: {
            code: 'SUPPRESSED',
            message: 'company suppressed; email guessing blocked',
          },
        });
      }
      if (!company.domain) {
        throw new ConflictException({
          error: {
            code: 'NO_DOMAIN',
            message: 'company has no domain; cannot guess emails',
          },
        });
      }
      const adapters = await this.providers.routeEmailVerification(tx as never);
      if (!adapters.length) {
        throw new ConflictException({
          error: {
            code: 'NO_PROVIDER',
            message: 'no email verification provider enabled',
          },
        });
      }
      const contacts = await tx.canonicalContact.findMany({
        where: { companyId },
        include: { contactPoints: true },
      });
      const suppressedEmails = canonicalizeSuppressionValues(
        'email',
        (await tx.suppressionRecord.findMany({ where: { type: 'email' } })).map((s) => s.value),
      );
      return {
        company,
        domain: company.domain,
        adapter: adapters[0],
        contacts,
        suppressedEmails,
      };
    });

    const domain = loaded.domain;
    // 格式学习样本（同域非-RISKY，全公司合并）+ 缺邮箱决策人（有界，默认 25）——与 backlog 阶段⑤b 共用
    // 纯件 buildGuessTargets（复审 MEDIUM：消 service/backlog 逐字重复漂移 + 统一 per-company cap）。
    const {
      knownSamples,
      emailless: targets,
      emaillessTotal,
    } = buildGuessTargets(loaded.contacts, domain, opts?.maxContacts);

    // 事务外：逐人 SMTP 猜测（adapter 单例不绑 tx）
    const guesser = new EmailGuesser(loaded.adapter);
    const results: {
      contactId: string;
      fullName: string;
      result: GuessResult;
      durableReceipts: DurableExecutionReceipt[];
    }[] = [];
    const accountKey = binding.accountKey;
    const budgets = this.budgets();
    await budgets.attestAuthorized({
      authorityId: binding.authorityId,
      scopeKey: binding.scopeKey,
      accountKey,
    });
    for (const c of targets) {
        const authorized = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
          contactMayUseExternalProcessing(tx, {
            workspaceId: binding.scopeKey,
            contactId: c.contactId,
          }),
        );
        if (!authorized) {
          results.push({
            contactId: c.contactId,
            fullName: c.fullName,
            result: {
              status: 'blocked',
              triedCount: 0,
              candidates: [],
              reason: 'suppression_action_gate',
            },
            durableReceipts: [],
          });
          continue;
        }
        const durableReceipts: DurableExecutionReceipt[] = [];
        const result = await guesser.guess(
          { fullName: c.fullName, domain, knownSamples },
          {
            workspaceId: ctx.workspaceId,
            runId: accountKey,
            lawfulBasis: opts?.lawfulBasis,
            allowPersonalWithoutBasis: opts?.allowPersonalWithoutBasis,
            actor: ctx.userId,
            maxProbe: opts?.maxProbe,
            suppressedEmails: loaded.suppressedEmails,
            authorizeCandidate: (email) =>
              this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
                contactMayUseExternalProcessing(tx, {
                  workspaceId: ctx.workspaceId,
                  contactId: c.contactId,
                  email,
                }),
              ),
            onDurableReceipt: (producerId, receipt) => {
              if (producerId !== 'smtp.rcpt_probe') {
                throw new Error('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
              }
              durableReceipts.push(receipt);
            },
          },
        );
        results.push({
          contactId: c.contactId,
          fullName: c.fullName,
          result,
          durableReceipts,
        });
        if ((await budgets.status({ workspaceId: binding.scopeKey, accountKey })).exhausted) break;
    }

    // 短事务②：落库
    const now = new Date();
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const summary = {
        emaillessContacts: emaillessTotal,
        attempted: targets.length,
        persisted: 0,
        verified: 0,
        unverified: 0,
        blocked: 0,
        perContact: [] as {
          fullName: string;
          status: GuessResult['status'];
          email: string | null;
          pointStatus: string | null;
        }[],
      };
      for (const r of results) {
        const out = await applyDomainAckConsumerTransactions({
          transaction: tx,
          acknowledgements: r.durableReceipts.map((receipt) => ({
            producerId: 'smtp.rcpt_probe',
            receipt,
            domainAckKey:
              `contact-guess:${r.contactId}:${receipt.operationId}`,
            domainRevision: receipt.resultDigest,
          })),
          apply: (transaction) => persistGuessedEmail(transaction, {
            workspaceId: ctx.workspaceId,
            contactId: r.contactId,
            result: r.result,
            suppressedEmails: loaded.suppressedEmails,
            // 用门**实际采用**的（已 stamp）依据，而非调用方原始入参——开关合成的 override 依据也在此，
            // 否则 allowPersonalWithoutBasis 路径会 personal_data=true 却 lawful_basis=null（复审 HIGH）。
            lawfulBasis: r.result.lawfulBasis ?? opts?.lawfulBasis,
            now,
          }),
        });
        if (out?.persisted) {
          summary.persisted += 1;
          if (out.status === 'VALID') summary.verified += 1;
          else summary.unverified += 1;
        }
        if (r.result.status === 'blocked') summary.blocked += 1;
        summary.perContact.push({
          fullName: r.fullName,
          status: r.result.status,
          email: out?.email ?? null,
          pointStatus: out?.status ?? null,
        });
      }
      return summary;
    });
  }

  /**
   * Waterfall 第 7 步：发送前邮箱验证（按需触发，状态回写 ContactPoint）。
   *
   * 🔴 合规门：探测**人名邮箱**=处理个人数据（GDPR）。职能邮箱默认自动验证；人名邮箱需显式
   * `lawfulBasis`（LIA/同意/合同）或开关 `allowPersonalWithoutBasis` 才探测，否则 BLOCKED（不触网）。
   * 禁联名单命中一律 BLOCKED。门在**服务层、先于选择/调用任何验证器**裁决（provider 无关，防 kill-switch
   * 落到忽略 ctx 的 public_web/sandbox 绕过）。每次验证写 field_evidence 留痕（含所依据的合法性基础）。
   */
  async verifyContactPoint(
    ctx: RequestContext,
    pointId: string,
    opts?: { lawfulBasis?: LawfulBasis; allowPersonalWithoutBasis?: boolean },
    compactJws?: string,
    publicRequestBody?: VerifyContactPointHttpRequestBody,
  ) {
    const binding = await this.authority.consumeWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope: verifyContactPointExecutionBudgetRequestScope(
        pointId,
        publicRequestBody,
      ),
    });
    assertFreshExecutionBudgetBinding(binding);
    // 短事务①：载入 point + 分级 + 禁联命中 + 选定验证器。**不**在事务内做网络验证——邮箱验证可能经
    // ToolBroker 走 SMTP 出网（含限流等待 + 最长 8s 探测），持 DB 连接跨这段会拖垮连接池/触发事务超时。
    const loaded = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const point = await tx.contactPoint.findUnique({
        where: { id: pointId },
        select: {
          value: true,
          type: true,
          contactId: true,
          contact: {
            select: {
              company: {
                select: { id: true, name: true, domain: true, status: true },
              },
            },
          },
        },
      });
      if (!point)
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'contact point not found' },
        });
      if (point.type !== 'email') {
        throw new ConflictException({
          error: {
            code: 'INVALID_TYPE',
            message: 'only email points can be verified',
          },
        });
      }
      const emailKey = canonicalizeSuppressionValue('email', point.value);
      const domainKey = emailKey ? canonicalizeSuppressionValue('domain', emailKey.split('@')[1]) : null;
      const suppressionRows = await tx.suppressionRecord.findMany({
        where: { type: { in: ['email', 'domain', 'company_name'] } },
        select: { type: true, value: true },
      });
      const suppressedEmails = canonicalizeSuppressionValues(
        'email',
        suppressionRows.filter((row) => row.type === 'email').map((row) => row.value),
      );
      const suppressedDomains = canonicalizeSuppressionValues(
        'domain',
        suppressionRows.filter((row) => row.type === 'domain').map((row) => row.value),
      );
      const company = point.contact.company;
      const matchedCompanySuppression = companyMatchesSuppression(suppressionRows, company);
      if (matchedCompanySuppression && company.status !== 'SUPPRESSED') {
        await tx.canonicalCompany.update({
          where: { id: company.id },
          data: { status: 'SUPPRESSED', version: { increment: 1 } },
        });
      }
      const suppressed =
        company.status === 'SUPPRESSED' ||
        matchedCompanySuppression ||
        (!!emailKey && suppressedEmails.has(emailKey)) ||
        (!!domainKey && suppressedDomains.has(domainKey));
      // 禁联先于 provider 路由和任何外部处理；BLOCKED 路径不需要发现/选择 SMTP adapter。
      const adapters = suppressed ? [] : await this.providers.routeEmailVerification(tx as never);
      return {
        pointValue: point.value,
        contactId: point.contactId,
        kind: cleanEmail(point.value)?.kind,
        suppressed,
        adapter: adapters[0] as (typeof adapters)[number] | undefined,
      };
    });

    // 🔴 合规门裁决（纯逻辑，先于任何网络/验证器调用）。
    const gate = evaluateEmailGate({
      email: loaded.pointValue,
      kind: loaded.kind,
      lawfulBasis: opts?.lawfulBasis,
      suppressed: loaded.suppressed,
      policy: resolveEmailVerificationPolicy({
        allowPersonalWithoutBasis: opts?.allowPersonalWithoutBasis,
      }),
    });
    const gateKind = gate.kind === 'invalid' ? undefined : gate.kind;
    // 将被落库的合法性基础统一补断言人/时间——覆盖操作者显式断言的**与开关合成的**（后者无 who/when），
    // 否则 override 路径的审计记录缺断言人（Codex #13 P2）。
    const recordedBasis = gate.lawfulBasis
      ? stampLawfulBasis(gate.lawfulBasis, ctx.userId, new Date().toISOString())
      : undefined;

    // 事务外：门放行才做网络验证（adapter 单例，不绑 tx，失败诚实降级为 verdict，不抛，§5 fail-safe）；
    // 门拦截则合成 BLOCKED，**不路由/不触任何验证器**（即便 smtp_self 被 kill-switch 关掉也不绕过）。
    let verdict: EmailVerdict;
    let providerKey: string;
    const smtpReceipts: DurableExecutionReceipt[] = [];
    const captureSmtpReceipt = (
      producerId: string,
      receipt: DurableExecutionReceipt,
    ): void => {
      if (producerId !== 'smtp.rcpt_probe') {
        throw new Error('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
      }
      smtpReceipts.push(receipt);
    };
    const actionAuthorized = gate.allowed
      ? await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
          contactMayUseExternalProcessing(tx, {
            workspaceId: ctx.workspaceId,
            contactId: loaded.contactId,
            email: loaded.pointValue,
          }),
        )
      : false;
    if (!gate.allowed || !actionAuthorized) {
      verdict = {
        status: 'BLOCKED',
        detail: `lawful_basis_gate:${gate.reason}`,
        costCents: 0,
        kind: gateKind,
      };
      if (gate.allowed && !actionAuthorized) verdict.detail = 'suppression_action_gate';
      providerKey = 'compliance_gate';
    } else {
      if (!loaded.adapter) {
        throw new ConflictException({
          error: {
            code: 'NO_PROVIDER',
            message: 'no email verification provider enabled',
          },
        });
      }
      assertProductDiscoveryProvenance({ providerKey: loaded.adapter.key });
      const verifyCtx: EmailVerifyContext = {
        workspaceId: ctx.workspaceId,
        runId: binding.accountKey,
        kind: loaded.kind,
        lawfulBasis: recordedBasis,
        allowPersonalWithoutBasis: opts?.allowPersonalWithoutBasis,
        suppressed: loaded.suppressed,
        authorizeExternalAction: () =>
          this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
            contactMayUseExternalProcessing(tx, {
              workspaceId: ctx.workspaceId,
              contactId: loaded.contactId,
              email: loaded.pointValue,
            }),
          ),
        onDurableReceipt: captureSmtpReceipt,
      };
      const accountKey = binding.accountKey;
      const budgets = this.budgets();
      await budgets.attestAuthorized({
        authorityId: binding.authorityId,
        scopeKey: binding.scopeKey,
        accountKey,
      });
      verdict = await loaded.adapter.verifyEmail(loaded.pointValue, verifyCtx);
      providerKey = loaded.adapter.key;
    }
    assertProductDiscoveryProvenance({ providerKey });

    // 短事务②：审计留痕（裁决 + 合法性基础）+ 回写状态。返回 point + verification 元数据供前端判断。
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const persisted = await applyDomainAckConsumerTransactions({
        transaction: tx,
        acknowledgements: smtpReceipts.map((receipt) => ({
          producerId: 'smtp.rcpt_probe',
          receipt,
          domainAckKey: `contact-point:${pointId}:${receipt.operationId}`,
          domainRevision: receipt.resultDigest,
        })),
        apply: async (transaction) => {
      await lockWorkspaceSuppressionPolicy(transaction, ctx.workspaceId);
      const currentPoint = await transaction.contactPoint.findUnique({
        where: { id: pointId },
        select: {
          value: true,
          contact: {
            select: {
              company: {
                select: { id: true, name: true, domain: true, status: true },
              },
            },
          },
        },
      });
      if (!currentPoint) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'contact point not found' },
        });
      }
      const currentSuppressions = await transaction.suppressionRecord.findMany({
        where: { type: { in: ['email', 'domain', 'company_name'] } },
        select: { type: true, value: true },
      });
      const currentEmail = canonicalizeSuppressionValue('email', currentPoint.value);
      const currentDomain = currentEmail ? canonicalizeSuppressionValue('domain', currentEmail.split('@')[1]) : null;
      const currentCompany = currentPoint.contact.company;
      const currentCompanySuppressed = companyMatchesSuppression(currentSuppressions, currentCompany);
      if (currentCompanySuppressed && currentCompany.status !== 'SUPPRESSED') {
        await transaction.canonicalCompany.update({
          where: { id: currentCompany.id },
          data: { status: 'SUPPRESSED', version: { increment: 1 } },
        });
      }
      const currentlySuppressed =
        currentCompany.status === 'SUPPRESSED' ||
        currentCompanySuppressed ||
        (!!currentEmail &&
          canonicalizeSuppressionValues(
            'email',
            currentSuppressions.filter((row) => row.type === 'email').map((row) => row.value),
          ).has(currentEmail)) ||
        (!!currentDomain &&
          canonicalizeSuppressionValues(
            'domain',
            currentSuppressions.filter((row) => row.type === 'domain').map((row) => row.value),
          ).has(currentDomain));
      const committedVerdict: EmailVerdict = currentlySuppressed
        ? {
            status: 'BLOCKED',
            detail: 'suppression_committed_before_verification_write',
            costCents: verdict.costCents,
            kind: verdict.kind ?? gateKind ?? loaded.kind,
            lawfulBasis: verdict.lawfulBasis ?? recordedBasis,
          }
        : verdict;
      const committedProviderKey = currentlySuppressed ? 'compliance_gate' : providerKey;
      await transaction.fieldEvidence.create({
        data: {
          workspaceId: ctx.workspaceId,
          entityType: 'contact',
          entityId: loaded.contactId,
          field: 'email.verification',
          value: {
            status: committedVerdict.status,
            detail: committedVerdict.detail ?? null,
            kind: committedVerdict.kind ?? gateKind ?? loaded.kind ?? null,
            lawfulBasis: committedVerdict.lawfulBasis ?? recordedBasis ?? null,
            suppressed: currentlySuppressed || loaded.suppressed,
          } as unknown as Prisma.InputJsonValue,
          providerKey: committedProviderKey,
          license: 'public',
          allowedActions: allowedActionsFor(committedVerdict.status) as unknown as Prisma.InputJsonValue,
        },
      });
      const updated = await transaction.contactPoint.update({
        where: { id: pointId },
        data: { status: committedVerdict.status, verifiedAt: new Date() },
      });
      return {
        ...updated,
        verification: {
          status: committedVerdict.status,
          detail: committedVerdict.detail ?? null,
          kind: committedVerdict.kind ?? gateKind ?? loaded.kind ?? null,
          providerKey: committedProviderKey,
          lawfulBasis: committedVerdict.lawfulBasis ?? recordedBasis ?? null,
        },
      };
        },
      });
      if (persisted) return persisted;
      const replayedPoint = await tx.contactPoint.findUnique({
        where: { id: pointId },
      });
      if (!replayedPoint) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'contact point not found' },
        });
      }
      return {
        ...replayedPoint,
        verification: {
          status: verdict.status,
          detail: verdict.detail ?? null,
          kind: verdict.kind ?? gateKind ?? loaded.kind ?? null,
          providerKey,
          lawfulBasis: verdict.lawfulBasis ?? recordedBasis ?? null,
        },
      };
    });
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

  // ── Suppression 治理 ──────────────────────────────────────────────────────

  async addSuppression(ctx: RequestContext, entry: { type: string; value: string; reason?: string }) {
    const canonicalValue = canonicalizeSuppressionValue(entry.type, entry.value);
    if (!canonicalValue) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_SUPPRESSION_VALUE',
          message: 'suppression type/value is invalid',
        },
      });
    }
    const rec = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      await lockWorkspaceSuppressionPolicy(tx, ctx.workspaceId);
      const reason = entry.reason ?? 'manual';
      // Fail closed: only the explicitly reviewed preference reasons are releasable.
      // Unknown/future reasons retain the stronger legal protection until policy is updated.
      const protectionClass = PREFERENCE_SUPPRESSION_REASONS.has(reason) ? 'PREFERENCE' : 'LEGAL';
      const rec = await tx.suppressionRecord.upsert({
        where: {
          workspaceId_type_value: {
            workspaceId: ctx.workspaceId,
            type: entry.type,
            value: canonicalValue,
          },
        },
        // suppression facts are immutable. A repeated write may only strengthen protection.
        update: protectionClass === 'LEGAL' ? { protectionClass: 'LEGAL' } : {},
        create: {
          workspaceId: ctx.workspaceId,
          type: entry.type,
          value: canonicalValue,
          reason,
          protectionClass,
        },
      });
      return rec;
    });
    // The append-only fact is authoritative immediately. Derived reconciliation runs in a second
    // transaction and reacquires the workspace policy lock before scanning/writing, so external
    // action admissions cannot interleave with mailbox/status repair. The authority fact remains
    // committed even if this best-effort derived projection later fails.
    if (entry.type === 'domain' || entry.type === 'company_name' || entry.type === 'email') {
      await this.reconcileCanonicalSuppression(
        ctx.workspaceId,
        entry.type as 'domain' | 'company_name' | 'email',
        canonicalValue,
      );
    }
    return rec;
  }

  listSuppressions(ctx: RequestContext, page?: SuppressionPageRequest) {
    const pagination = suppressionPagination(page);
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.suppressionRecord
        .findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: pagination.limit + 1,
          ...(pagination.cursor ? { cursor: { id: pagination.cursor }, skip: 1 } : {}),
        })
        .then((rows) => suppressionPage(rows, pagination.limit)),
    );
  }

  listSuppressionDecisions(ctx: RequestContext, id: string, page?: SuppressionPageRequest) {
    const pagination = suppressionPagination(page);
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rec = await tx.suppressionRecord.findUnique({ where: { id } });
      if (!rec)
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'suppression not found' },
        });
      const rows = await tx.suppressionDecision.findMany({
        where: { suppressionId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: pagination.limit + 1,
        ...(pagination.cursor ? { cursor: { id: pagination.cursor }, skip: 1 } : {}),
      });
      return suppressionPage(rows, pagination.limit);
    });
  }

  private async reconcileCanonicalSuppression(
    workspaceId: string,
    type: 'domain' | 'company_name' | 'email',
    canonicalValue: string,
  ): Promise<void> {
    const batchSize = 50;
    let afterId: string | undefined;
    for (;;) {
      const rows = await this.prisma.withWorkspace(
        workspaceId,
        async (tx) => {
          await lockWorkspaceSuppressionPolicy(tx, workspaceId);
          const page = await tx.canonicalCompany.findMany({
            ...(afterId ? { where: { id: { gt: afterId } } } : {}),
            orderBy: { id: 'asc' },
            take: batchSize,
            select: { id: true, domain: true, name: true, status: true, attributes: true },
          });
          for (const row of page) {
            const attributes = jsonRecord(row.attributes);
            const mailbox = canonicalizeSuppressionValue(
              'email',
              typeof attributes.contact_email === 'string' ? attributes.contact_email : '',
            );
            const mailboxDomain = mailbox ? canonicalizeSuppressionValue('domain', mailbox.split('@')[1]) : null;
            const companyMatches =
              type !== 'email' &&
              canonicalizeSuppressionValue(type, type === 'domain' ? (row.domain ?? '') : row.name) ===
                canonicalValue;
            const mailboxMatches =
              (type === 'email' && mailbox === canonicalValue) ||
              (type === 'domain' && mailboxDomain === canonicalValue);
            if (!companyMatches && !mailboxMatches) continue;
            const { contact_email: _removedMailbox, ...safeAttributes } = attributes;
            await tx.canonicalCompany.updateMany({
              where: { id: row.id },
              data: {
                ...(companyMatches ? { status: 'SUPPRESSED' as const } : {}),
                ...(mailboxMatches || companyMatches
                  ? { attributes: safeAttributes as Prisma.InputJsonValue }
                  : {}),
                version: { increment: 1 },
              },
            });
          }
          return page;
        },
        { maxWait: 1_000, timeout: 5_000 },
      );
      if (rows.length < batchSize) return;
      afterId = rows[rows.length - 1].id;
    }
  }

  async requestSuppressionDecision(ctx: RequestContext, id: string, request: SuppressionDecisionRequest) {
    validateSuppressionDecisionRequest(request);
    const outcome = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      await lockWorkspaceSuppressionPolicy(tx, ctx.workspaceId);
      const rec = await tx.suppressionRecord.findUnique({ where: { id } });
      if (!rec)
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'suppression not found' },
        });

      const existing = await tx.suppressionDecision.findUnique({
        where: {
          workspaceId_requestId: {
            workspaceId: ctx.workspaceId,
            requestId: request.requestId,
          },
        },
      });
      if (existing) {
        assertSameSuppressionCommand(existing, {
          id,
          request,
          actorId: ctx.userId,
        });
        return {
          denied: existing.decision === 'RELEASE_REQUEST_DENIED',
          record: existing,
        };
      }

      const denied = request.decision === 'RELEASE_REQUESTED' && rec.protectionClass === 'LEGAL';
      const decision = denied ? 'RELEASE_REQUEST_DENIED' : request.decision;
      const reasonCode = denied ? 'LEGAL_SUPPRESSION_IMMUTABLE' : request.reasonCode;
      // createMany(skipDuplicates) maps to INSERT ... ON CONFLICT DO NOTHING. Unlike catching P2002 after
      // create(), it leaves the PostgreSQL transaction usable so a concurrent winner can be read safely.
      await tx.suppressionDecision.createMany({
        data: [
          {
            workspaceId: ctx.workspaceId,
            suppressionId: id,
            requestId: request.requestId,
            requestedDecision: request.decision,
            requestedReasonCode: request.reasonCode,
            decision,
            reasonCode,
            actorId: ctx.userId,
          },
        ],
        skipDuplicates: true,
      });
      const record = await tx.suppressionDecision.findUnique({
        where: {
          workspaceId_requestId: {
            workspaceId: ctx.workspaceId,
            requestId: request.requestId,
          },
        },
      });
      if (!record) {
        throw new ConflictException({
          error: {
            code: 'DECISION_NOT_PERSISTED',
            message: 'suppression decision could not be persisted',
          },
        });
      }
      assertSameSuppressionCommand(record, {
        id,
        request,
        actorId: ctx.userId,
      });
      return { denied: record.decision === 'RELEASE_REQUEST_DENIED', record };
    });

    if (outcome.denied) {
      throw new ConflictException({
        error: {
          code: 'LEGAL_SUPPRESSION_IMMUTABLE',
          message: 'legal suppression cannot be released by the ordinary API',
          decisionId: outcome.record.id,
        },
      });
    }
    return outcome.record;
  }

  /** Deprecated compatibility path: records a request and always reports deleted=false. */
  async removeSuppression(ctx: RequestContext, id: string) {
    const decision = await this.requestSuppressionDecision(ctx, id, {
      requestId: `legacy-delete-v1:${id}`,
      decision: 'RELEASE_REQUESTED',
      reasonCode: 'USER_PREFERENCE_CHANGED',
    });
    return { deleted: false, releaseRequested: true, decisionId: decision.id };
  }

  listProviders(ctx: RequestContext) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) => tx.dataProvider.findMany({ orderBy: { key: 'asc' } }));
  }
}

function assertSameSuppressionCommand(
  record: {
    suppressionId: string;
    requestedDecision: string;
    requestedReasonCode: string;
    actorId: string;
  },
  expected: {
    id: string;
    request: SuppressionDecisionRequest;
    actorId: string;
  },
): void {
  const same =
    record.suppressionId === expected.id &&
    record.requestedDecision === expected.request.decision &&
    record.requestedReasonCode === expected.request.reasonCode &&
    record.actorId === expected.actorId;
  if (!same) {
    throw new ConflictException({
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'requestId was already used with a different decision',
      },
    });
  }
}

function validateSuppressionDecisionRequest(request: SuppressionDecisionRequest): void {
  const requestId = request.requestId;
  const hasControlCharacter =
    typeof requestId === 'string' &&
    Array.from(requestId).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
  if (typeof requestId !== 'string' || !requestId || requestId.length > 128 || hasControlCharacter) {
    throw new BadRequestException({
      error: { code: 'INVALID_REQUEST_ID', message: 'requestId is invalid' },
    });
  }
  if (!(SUPPRESSION_DECISIONS as readonly string[]).includes(request.decision)) {
    throw new BadRequestException({
      error: {
        code: 'INVALID_DECISION',
        message: 'unsupported suppression decision',
      },
    });
  }
  if (!(SUPPRESSION_DECISION_REASONS as readonly string[]).includes(request.reasonCode)) {
    throw new BadRequestException({
      error: {
        code: 'INVALID_REASON',
        message: 'unsupported suppression reason',
      },
    });
  }
  const correctionReason = ['IDENTITY_MISASSOCIATION', 'DUPLICATE_RECORD', 'OTHER'].includes(request.reasonCode);
  const releaseReason = ['USER_PREFERENCE_CHANGED', 'BOUNCE_CLASSIFICATION_ERROR', 'OTHER'].includes(
    request.reasonCode,
  );
  if (
    (request.decision === 'IDENTITY_CORRECTION_REQUESTED' && !correctionReason) ||
    (request.decision === 'RELEASE_REQUESTED' && !releaseReason)
  ) {
    throw new BadRequestException({
      error: {
        code: 'INVALID_REASON',
        message: 'reason is invalid for this decision',
      },
    });
  }
}

function suppressionPagination(page?: SuppressionPageRequest): {
  cursor?: string;
  limit: number;
} {
  const requested = Number.isInteger(page?.limit) ? Number(page?.limit) : 50;
  return {
    ...(page?.cursor ? { cursor: page.cursor } : {}),
    limit: Math.min(100, Math.max(1, requested)),
  };
}

function suppressionPage<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: visible,
    hasMore,
    nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 验证裁决 → field_evidence.allowed_actions（诚实：BLOCKED 不授予任何动作；仅 VALID 授 outreach）。 */
function allowedActionsFor(status: string): string[] {
  if (status === 'BLOCKED') return [];
  if (status === 'VALID') return ['display', 'match', 'outreach'];
  return ['display', 'match'];
}
