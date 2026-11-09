import type { Prisma } from '@prisma/client';
import { classifyContactEmail, type ContactEmailType } from '../../discovery/contact-classifier';
import {
  legacyCatchAllFromClass,
  transitionVerificationState,
  verifiedAtStateColumns,
  type EmailVerificationState,
  type VerificationEventVerdict,
} from '../../discovery/contact-point-verification-state';
import {
  buildVerificationRequestHash,
  recordContactPointVerificationEvent,
} from '../../discovery/contact-point-verification-event';
import {
  setEmailPointState,
  upsertProviderEmailPoint,
} from '../../discovery/contact-point-writer';
import { contactMayUseExternalProcessing } from '../../discovery/company-suppression-gate';
import {
  evaluateEmailGate,
  isValidLawfulBasis,
  resolveEmailVerificationPolicy,
} from '../../discovery/compliance/email-verification-gate';
import type { LawfulBasis, LawfulBasisKind } from '../../discovery/provider-contract';
import { canonicalizeSuppressionValue } from '../../discovery/suppression-value';
import type { EmailEnrichmentAdapter, FindEmailInput } from '../finders/email-enrichment-provider';
import type { EmailVerificationProvider } from '../verification/email-verification-provider';
import { scoreEmailPoint } from '../verification/verification-policy';
import {
  eventVerdictFromProviderResult,
  runVerificationWaterfall,
} from '../verification/verification-waterfall';
import {
  applyCircuitOutcome,
  circuitAllowsCall,
  emptyCircuitState,
  type CircuitBreakerStore,
} from './circuit-breaker';
import { CapBudget, DEFAULT_PER_CONTACT_CAP_MICROUSD, type EnrichmentBudget } from './enrichment-budget';
import {
  findReusableAttempt,
  recordEnrichmentAttempt,
  updateAttemptEmailState,
} from './enrichment-attempt';

/**
 * P1-08：单个联系人的邮箱富集编排（计划 §2.3.4.2 停止规则 / §2.3.4.5 数据流）。
 *
 * 语义（按顺序）：
 *  0) 合规前置（`contactMayUseExternalProcessing`，短事务线性化点）：联系人/公司被抑制 →
 *     不调任何 finder，返回 skipped_compliance。
 *  1) 依序 finder（Hunter → Findymail → Prospeo…）：每家先过 data_provider/source_policy 门
 *     （跳过的记 skipped_compliance 尝试行）与熔断器（OPEN → circuit_open 错误行，不调用）。
 *  2) 本地复用（attempt 账，§2.3.4.5）：同输入版本 90 天 hit / 24h miss-error；同联系人同
 *     provider 90 天 hit——命中即复用，不发请求、不计费。
 *  3) 预算 reserve/settle；预留不足 → skipped_budget（停该联系人，不阻断其它公司）。
 *  4) hit → 验证瀑布（双正规则）→ 同事务：upsert 邮箱点（sourceType=provider）+ 每步事件账
 *     + 状态机回写 + attempt.emailState 回填。
 *  5) 命中≠成功：验证 INVALID → 继续下一家 finder；UNKNOWN/CATCH_ALL_RISKY 落库并停止
 *     （换 finder 解决不了验证侧未知，转 24h 重验队列）；finder 尝试上限 3 家。
 *  6) 全部 miss/INVALID → not_found / invalid_all（联系人保持无邮箱点或既有状态）。
 *
 * 出网纪律：finder 与验证器一律走各自适配器的注入 fetch；本模块不直接 fetch。
 * PII 纪律：邮箱明文只在进程内流转（写入器透明加密）；日志与证据 JSON 不含明文。
 */

export interface EnrichContactInput {
  workspaceId: string;
  contactId: string;
  fullName: string;
  /** 已归一、无 www 的公司域（小写）。 */
  domain: string;
  companyName?: string;
  linkedinUrl?: string;
  runId?: string;
  accountKey: string;
  /** 验证阶段处理个人邮箱的合法性依据（缺省则按 evaluateEmailGate 的策略门判定）。 */
  lawfulBasis?: string;
}

export interface EnrichContactDeps {
  /** PrismaService 或 owner 连接；必须实现 withWorkspace（RLS 事务边界）。 */
  prisma: { withWorkspace<T>(workspaceId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> };
  /** 有序 finder（瀑布顺序；调用方已按凭据过滤）。 */
  finders: EmailEnrichmentAdapter[];
  /** 有序验证器（主验在前；调用方已按凭据 + data_provider/source_policy 门过滤）。 */
  verifiers: EmailVerificationProvider[];
  /** 每家 finder 的前置门（data_provider ENABLED + source_policy 已登记；见 checkProviderGates）。 */
  gate: (finder: EmailEnrichmentAdapter) => Promise<{ ok: boolean; reason?: string }>;
  /** 熔断器存储（缺省 = 不熔断，单测/CLI dry 路径用）。 */
  circuits?: CircuitBreakerStore;
  /** 预算端口；缺省 = CapBudget(perContactCapMicrousd ?? $0.15)。 */
  budget?: EnrichmentBudget;
  /** 合规前置（缺省 contactMayUseExternalProcessing；测试注入假实现）。 */
  mayUseExternalProcessing?: (tx: Prisma.TransactionClient) => Promise<boolean>;
  clock?: () => Date;
  actorId?: string;
  /** finder 尝试上限（计划 ≤3；调用方传更小值收紧，传更大值被截到 3）。 */
  maxFinderAttempts?: number;
  perContactCapMicrousd?: number;
  /** 验证瀑布单地址调用上限（计划 ≤6）。 */
  maxVerificationCalls?: number;
}

export type EnrichContactResult =
  | {
      status: 'stored';
      pointId: string;
      state: EmailVerificationState;
      provider: string;
      costMicrousd: number;
      finderAttempts: number;
      verificationEventId: string | null;
      /** 未验证即落库时的诚实原因（无验证器 / 验证门拦截 / suppressed）。 */
      note?: string;
    }
  | {
      status: 'reused';
      state: EmailVerificationState | null;
      provider: string;
      costMicrousd: 0;
      finderAttempts: number;
    }
  | { status: 'invalid_all'; costMicrousd: number; finderAttempts: number }
  | { status: 'not_found'; costMicrousd: number; finderAttempts: number }
  | { status: 'skipped_budget'; costMicrousd: number; finderAttempts: number }
  | { status: 'skipped_compliance'; reason: string }
  | { status: 'no_finders' };

export const MAX_FINDER_ATTEMPTS = 3;
const UNVERIFIED_RETRY_MS = 24 * 3_600_000;

function storedBasisOf(raw: string | undefined): LawfulBasis | undefined {
  if (!raw) return undefined;
  const basis = { basis: raw as LawfulBasisKind } satisfies LawfulBasis;
  return isValidLawfulBasis(basis) ? basis : undefined;
}

export async function enrichContactEmail(
  deps: EnrichContactDeps,
  input: EnrichContactInput,
): Promise<EnrichContactResult> {
  if (deps.finders.length === 0) return { status: 'no_finders' };
  const now = deps.clock ?? (() => new Date());
  const actorId = deps.actorId ?? 'enrich-contact-email';
  const attemptsCap = Math.max(1, Math.min(MAX_FINDER_ATTEMPTS, deps.maxFinderAttempts ?? MAX_FINDER_ATTEMPTS));
  const budget =
    deps.budget ??
    new CapBudget(deps.perContactCapMicrousd ?? DEFAULT_PER_CONTACT_CAP_MICROUSD);
  const lawfulBasis = storedBasisOf(input.lawfulBasis);
  const findInput: FindEmailInput = {
    workspaceId: input.workspaceId,
    contactId: input.contactId,
    fullName: input.fullName,
    domain: input.domain,
    ...(input.companyName ? { companyName: input.companyName } : {}),
    ...(input.linkedinUrl ? { linkedinUrl: input.linkedinUrl } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    accountKey: input.accountKey,
  };

  // 0) 合规前置：联系人/公司抑制检查（短事务；之后不再持锁跨网络）。
  const mayUse =
    deps.mayUseExternalProcessing ??
    ((tx: Prisma.TransactionClient) =>
      contactMayUseExternalProcessing(tx, {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
      }));
  const allowed = await deps.prisma.withWorkspace(input.workspaceId, mayUse);
  if (!allowed) {
    return { status: 'skipped_compliance', reason: 'suppressed_contact_or_company' };
  }

  let attempts = 0;
  let costMicrousd = 0;
  let sawInvalidHit = false;

  for (const finder of deps.finders) {
    if (attempts >= attemptsCap) break;
    const attemptedAt = now();
    const requestHash = finder.requestHash(findInput);

    // data_provider / source_policy 门（跳过的也记账——审计完整率 100%）。
    const gate = await deps.gate(finder);
    if (!gate.ok) {
      await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
        recordEnrichmentAttempt(tx, {
          workspaceId: input.workspaceId,
          contactId: input.contactId,
          providerKey: finder.key,
          requestHash,
          outcome: 'skipped_compliance',
          errorCode: 'provider_gate_closed',
          evidence: { reason: gate.reason ?? null },
          runId: input.runId ?? null,
          accountKey: input.accountKey,
          attemptedAt,
        }),
      );
      continue;
    }

    // 熔断器（OPEN 且未到期 → 不调用；不计入 finder 尝试数）。
    const circuit = deps.circuits ? await deps.circuits.load(finder.key) : emptyCircuitState();
    if (!circuitAllowsCall(circuit, attemptedAt)) {
      await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
        recordEnrichmentAttempt(tx, {
          workspaceId: input.workspaceId,
          contactId: input.contactId,
          providerKey: finder.key,
          requestHash,
          outcome: 'error',
          errorCode: 'circuit_open',
          retryable: true,
          runId: input.runId ?? null,
          accountKey: input.accountKey,
          attemptedAt,
        }),
      );
      continue;
    }

    // 本地复用（attempt 账）：同一输入版本 TTL 内 / 同联系人同 provider 90 天 hit。
    const reusable = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
      findReusableAttempt(tx, {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        providerKey: finder.key,
        requestHash,
        now: attemptedAt,
      }),
    );
    if (reusable) {
      if (reusable.outcome === 'hit') {
        return {
          status: 'reused',
          state: (reusable.emailState as EmailVerificationState | null) ?? null,
          provider: finder.key,
          costMicrousd: 0,
          finderAttempts: attempts,
        };
      }
      // 24h 内的 miss/error/skipped：不重复购买，跳到下一家（不占尝试数）。
      continue;
    }

    if (!budget.reserve(finder.costMicrousd)) {
      await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
        recordEnrichmentAttempt(tx, {
          workspaceId: input.workspaceId,
          contactId: input.contactId,
          providerKey: finder.key,
          requestHash,
          outcome: 'skipped_budget',
          runId: input.runId ?? null,
          accountKey: input.accountKey,
          attemptedAt,
        }),
      );
      return { status: 'skipped_budget', costMicrousd, finderAttempts: attempts };
    }

    attempts += 1;
    const outcome = await finder.findEmail(findInput);
    budget.settle(finder.costMicrousd, outcome.costMicrousd);
    costMicrousd += outcome.costMicrousd;

    if (deps.circuits) {
      // provider_unconfigured 是本地配置问题，不进熔断统计；其余 error 计失败。
      if (!(outcome.status === 'error' && outcome.errorCode === 'provider_unconfigured')) {
        const nextCircuit = applyCircuitOutcome(
          circuit,
          outcome.status === 'error' ? 'failure' : 'success',
          now(),
        );
        await deps.circuits.save(finder.key, nextCircuit);
      }
    }

    const attempted = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
      recordEnrichmentAttempt(tx, {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        providerKey: finder.key,
        requestHash,
        outcome: outcome.status,
        errorCode: outcome.status === 'error' ? outcome.errorCode : null,
        retryable: outcome.status === 'error' ? outcome.retryable : null,
        costMicrousd: outcome.costMicrousd,
        latencyMs: outcome.latencyMs,
        evidence:
          outcome.status === 'hit'
            ? { ...(outcome.hit.raw ?? {}), email_type: classifyContactEmail(outcome.hit.email).emailType }
            : { detail: outcome.detail },
        runId: input.runId ?? null,
        accountKey: input.accountKey,
        attemptedAt,
      }),
    );
    const attemptId = attempted.attempt?.id ?? null;

    if (outcome.status !== 'hit') continue;

    // 命中≠成功：先验证，再决定是否继续买下一家。
    const email = outcome.hit.email;
    const emailType: ContactEmailType = classifyContactEmail(email).emailType;
    const verificationGate = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
      // 抑制先于依据：地址被抑制时不送第三方（无论 lawful basis 是否存在）。
      const suppressed = await tx.suppressionRecord.findFirst({
        where: { type: 'email', value: canonicalizeSuppressionValue('email', email) ?? email },
        select: { id: true },
      });
      if (suppressed) return { allowed: false, reason: 'suppressed_email' };
      const decision = evaluateEmailGate({
        email,
        kind: emailType === 'personal' ? 'personal' : 'role',
        lawfulBasis,
        suppressed: false,
        policy: resolveEmailVerificationPolicy(),
      });
      return { allowed: decision.allowed, reason: decision.reason };
    });

    const verification = verificationGate.allowed
      ? await runVerificationWaterfall({
          email,
          providers: deps.verifiers,
          // 工具型验证器（SMTP 兜底票）的 broker 归账/合规上下文。
          workspaceId: input.workspaceId,
          runId: input.runId,
          maxCalls: Math.max(1, Math.min(6, deps.maxVerificationCalls ?? 6)),
        })
      : null;
    if (verification) {
      costMicrousd += verification.costMicrousd;
      budget.settle(0, verification.costMicrousd);
    }

    const resolved = verification?.resolved ?? null;
    if (resolved?.state === 'INVALID') {
      // 买到假邮箱：计 scorecard、继续下一家 finder（总尝试上限不放宽）。
      sawInvalidHit = true;
      if (attemptId) {
        await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
          updateAttemptEmailState(tx, attemptId, 'INVALID'),
        );
      }
      continue;
    }

    // 落库（VALID / CATCH_ALL_RISKY / UNKNOWN / 未验证）：同事务写事件账 + 状态 + attempt 回填。
    const transitionVerdict: VerificationEventVerdict =
      resolved === null
        ? 'unknown'
        : resolved.state === 'VALID'
          ? 'valid'
          : resolved.state === 'CATCH_ALL_RISKY'
            ? 'catch_all'
            : 'unknown';
    const steps = verification?.steps ?? [];

    const stored = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const point = await upsertProviderEmailPoint(tx, {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        email,
        emailType,
        ...(lawfulBasis ? { legalBasis: lawfulBasis.basis } : {}),
      });
      const attemptedAtPersist = now();
      let lastEventId: string | null = null;
      let lastVotedProvider: string | null = null;
      let lastVotedMethod: string = 'third_party_api';
      for (const step of steps) {
        const event = await recordContactPointVerificationEvent(tx, {
          workspaceId: input.workspaceId,
          contactPointId: point.id,
          providerKey: step.providerKey,
          // 工具型验证器（SMTP 兜底票）如实记 smtp_rcpt；第三方 API 缺省 third_party_api。
          method: step.result.method ?? 'third_party_api',
          verdict: eventVerdictFromProviderResult(step.result),
          detail: `${step.result.detail}${step.result.error ? `;error=${step.result.error}` : ''}`,
          catchAll: step.result.catchAll,
          catchAllClass: step.result.catchAllClass,
          score: scoreEmailPoint({
            state: step.result.state,
            catchAllClass: step.result.catchAllClass,
          }),
          costMicrousd: step.result.costMicrousd,
          lawfulBasis: (lawfulBasis ?? null) as Record<string, unknown> | null,
          actorId,
          requestHash: buildVerificationRequestHash(
            point.id,
            step.providerKey,
            `${email}|${input.runId ?? input.accountKey}`,
          ),
          latencyMs: step.result.latencyMs,
        });
        if (event.id) lastEventId = event.id;
        if (step.result.error === null) {
          lastVotedProvider = step.providerKey;
          lastVotedMethod = step.result.method ?? 'third_party_api';
        }
      }

      if (resolved === null || steps.length === 0) {
        // 未验证（无验证器 / 验证门拦截 / 抑制）：UNKNOWN + 24h 重验队列，绝不冒充已验证。
        await setEmailPointState(tx, {
          pointId: point.id,
          state: 'UNKNOWN',
          status: 'UNVERIFIED',
          validSince: null,
          verifiedAt: attemptedAtPersist,
          nextReverifyAt: new Date(attemptedAtPersist.getTime() + UNVERIFIED_RETRY_MS),
          confidence: 20,
          catchAll: 'unknown',
          catchAllClass: null,
          lastVerificationEventId: null,
        });
      } else {
        const transition = transitionVerificationState(
          {
            state: point.verificationState,
            validSince: point.validSince,
            nextReverifyAt: point.nextReverifyAt,
          },
          { verdict: transitionVerdict, catchAllClass: resolved.catchAllClass },
          attemptedAtPersist,
        );
        const columns = verifiedAtStateColumns(transition);
        await setEmailPointState(tx, {
          pointId: point.id,
          state: columns.verificationState,
          status: columns.status,
          validSince: columns.validSince,
          verifiedAt: columns.verifiedAt,
          nextReverifyAt: columns.nextReverifyAt,
          confidence: columns.confidence,
          verificationProvider: lastVotedProvider ?? finder.key,
          verificationMethod: lastVotedMethod,
          ...(resolved.state === 'UNKNOWN'
            ? {}
            : {
                catchAll: legacyCatchAllFromClass(resolved.catchAllClass),
                catchAllClass: resolved.catchAllClass,
              }),
          lastVerificationEventId: lastEventId,
        });
      }
      if (attemptId) {
        await updateAttemptEmailState(tx, attemptId, resolved?.state ?? 'UNKNOWN');
      }
      return {
        pointId: point.id,
        state: (resolved?.state ?? 'UNKNOWN') as EmailVerificationState,
        lastEventId,
      };
    });

    return {
      status: 'stored',
      pointId: stored.pointId,
      state: stored.state,
      provider: finder.key,
      costMicrousd,
      finderAttempts: attempts,
      verificationEventId: stored.lastEventId,
      ...(resolved === null || steps.length === 0
        ? { note: verificationGate.allowed ? 'no_configured_verifiers' : verificationGate.reason }
        : {}),
    };
  }

  return {
    status: sawInvalidHit ? 'invalid_all' : 'not_found',
    costMicrousd,
    finderAttempts: attempts,
  };
}
