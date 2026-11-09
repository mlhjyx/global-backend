/**
 * P1-19：存量邮箱再验证的**核心编排**（CLI 与 CONTACT_REVERIFY_SWEEP Schedule 共用）。
 *
 * 集成点：
 *  - 发现 run 内（temporal/discovery.run2.pipeline.activities.ts 的 contactsCompanyOnce →
 *    discoverContactsCore + email-guess）负责**新联系人的首验**；本模块负责**存量点的再验证**
 *    （迁移回填进 UNKNOWN 队列的邮箱、90 天 TTL 到期的 VALID、catch-all 复检）。
 *  - 手动单点验证走 DiscoveryService.verifyContactPoint（同一条事件账、同一状态机）；
 *    批处理入口是 apps/api/scripts/reverify-contact-points.mts（CLI）与
 *    temporal/contact-reverify.activities.ts（每日 Schedule，paused 默认）。
 *  - 事件账 contact_point_verification_event 是唯一验证事实；供应商原始裁决与投票裁决后的
 *    四态分别落事件与点状态（同事务）。
 *
 * 安全/合规门（任一不满足即 fail-closed）：
 *  1) PII_ENCRYPTION_KEY 必须配置（解密 contact_point.value 才能在内存里得到地址）；
 *  2) data_provider.<provider> 行必须 ENABLED（kill switch）；默认 seed 为 DISABLED；
 *  3) source_policy.api.millionverifier.com 必须已登记且未 SUSPENDED、允许 enrichment/discovery 用途；
 *  4) 每个地址过 evaluateEmailGate（人名邮箱需 lawful_basis 或显式开关），命中 suppression 不触网；
 *     提交侧还会锁租户策略并重读抑制（供应商调用窗口内的新抑制只留事件、不写状态）；
 *  5) 幂等键 = sha256(pointId | providerKey | value密文 | 周期桶)；调用供应商前预查事件账，
 *     同桶内重跑不重复计费。
 *
 * 日志纪律：只打印点 id 与统计，绝不打印邮箱/域明文。
 */
import type { PrismaClient } from '@prisma/client';
import { blindContactKey, decryptPii } from '../../compliance/pii-crypto';
import { cleanEmail } from '../../acquisition/clean';
import {
  emailDomainOfAddress,
  transitionVerificationState,
  verifiedAtStateColumns,
  type EmailVerificationState,
  type VerificationEventVerdict,
} from '../../discovery/contact-point-verification-state';
import type { LawfulBasis, LawfulBasisKind } from '../../discovery/provider-contract';
import {
  buildVerificationRequestHash,
  recordContactPointVerificationEvent,
} from '../../discovery/contact-point-verification-event';
import {
  evaluateEmailGate,
  isValidLawfulBasis,
  resolveEmailVerificationPolicy,
} from '../../discovery/compliance/email-verification-gate';
import {
  canonicalizeSuppressionValue,
  companyMatchesSuppression,
} from '../../discovery/suppression-value';
import { contactSuppressionKeys } from '../../discovery/identity';
import { lockWorkspaceSuppressionPolicy } from '../../discovery/suppression-policy-lock';
import { resolveVerificationVotes, scoreEmailPoint } from './verification-policy';
import type { EmailVerificationProvider } from './email-verification-provider';

export interface ReverifyOptions {
  dryRun: boolean;
  limit: number;
  ratePerSecond: number;
  workspaceId: string | null;
  /** 忽略 next_reverify_at 排期，直接按状态取（迁移后首跑用）。 */
  ignoreSchedule: boolean;
  /** 幂等周期桶（默认 UTC 日期 YYYY-MM-DD）。 */
  requestBucket: string;
  /** 每轮供应商成本上限（微美元）；达到即停本轮剩余候选（保持 due，下一轮再取）。undefined=不限。 */
  maxCostMicrousd?: number;
}

export interface ReverifySummary {
  selected: number;
  duplicates: number;
  skippedSuppressed: number;
  skippedCompliance: number;
  providerCalls: number;
  errors: number;
  byState: Record<EmailVerificationState, number>;
  costMicrousd: number;
  /** 本轮因成本上限提前停下时，被跳过的候选数（>0 表示还有 due 未处理）。 */
  skippedBudget: number;
}

/** 选点：email 点 + 四态过滤 + 排期过滤（RLS 由 owner 连接绕过——跨租户批处理是预期）。 */
async function selectCandidates(
  prisma: PrismaClient,
  options: ReverifyOptions,
  states: EmailVerificationState[],
): Promise<
  Array<{
    id: string;
    workspaceId: string;
    value: string;
    verificationState: string;
    validSince: Date | null;
    nextReverifyAt: Date | null;
    legalBasis: string | null;
    contact: {
      fullName: string;
      company: { name: string; domain: string | null; status: string; dedupeKey: string };
    };
  }>
> {
  return prisma.contactPoint.findMany({
    where: {
      type: 'email',
      verificationState: { in: states },
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.ignoreSchedule ? {} : { nextReverifyAt: { lte: new Date() } }),
    },
    select: {
      id: true,
      workspaceId: true,
      value: true,
      verificationState: true,
      validSince: true,
      nextReverifyAt: true,
      legalBasis: true,
      contact: {
        select: {
          fullName: true,
          company: { select: { name: true, domain: true, status: true, dedupeKey: true } },
        },
      },
    },
    orderBy: [{ nextReverifyAt: 'asc' }, { id: 'asc' }],
    take: options.limit,
  });
}

/** 供应商前置门：data_provider ENABLED + source_policy 已登记未 SUSPENDED。 */
export async function checkProviderGates(
  prisma: PrismaClient,
  provider: EmailVerificationProvider,
): Promise<{ ok: boolean; reason?: string }> {
  const dataProvider = await prisma.dataProvider.findUnique({
    where: { key: provider.key },
    select: { status: true },
  });
  if (!dataProvider || dataProvider.status !== 'ENABLED') {
    return {
      ok: false,
      reason: `data_provider.${provider.key} 未启用（kill switch）——先由运维翻 ENABLED`,
    };
  }
  const policy = await prisma.sourcePolicy.findUnique({
    where: { domain: provider.domain },
    select: { reviewStatus: true, allowedPurpose: true },
  });
  if (!policy) {
    return { ok: false, reason: `source_policy.${provider.domain} 未登记（未登记 = 未批准）` };
  }
  if (policy.reviewStatus === 'SUSPENDED') {
    return { ok: false, reason: `source_policy.${provider.domain} 已 SUSPENDED` };
  }
  const purposes = Array.isArray(policy.allowedPurpose) ? policy.allowedPurpose : [];
  if (purposes.length > 0 && !purposes.some((p) => p === 'enrichment' || p === 'discovery')) {
    return { ok: false, reason: `source_policy.${provider.domain} 用途门拒绝（allowedPurpose 不含 enrichment/discovery）` };
  }
  return { ok: true };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 再验证主循环（导出供后续 Schedule activity 复用）。
 * 对每个候选：幂等预查 → suppression → 合规门 → 供应商调用（限流）→ 投票裁决 →
 * 事件账 + 点状态回写（同一事务）。
 */
export async function runReverifySweep(input: {
  prisma: PrismaClient;
  provider: EmailVerificationProvider;
  options: ReverifyOptions;
  states?: EmailVerificationState[];
  now?: () => Date;
}): Promise<ReverifySummary> {
  const { prisma, provider, options } = input;
  const now = input.now ?? (() => new Date());
  const states = input.states ?? ['UNKNOWN', 'CATCH_ALL_RISKY'];
  const summary: ReverifySummary = {
    selected: 0,
    duplicates: 0,
    skippedSuppressed: 0,
    skippedCompliance: 0,
    providerCalls: 0,
    errors: 0,
    byState: { VALID: 0, INVALID: 0, CATCH_ALL_RISKY: 0, UNKNOWN: 0 },
    costMicrousd: 0,
    skippedBudget: 0,
  };
  const candidates = await selectCandidates(prisma, options, states);
  summary.selected = candidates.length;
  if (options.dryRun) return summary;

  // suppression 快照（每轮一次，按候选涉及的租户过滤；批内新增由提交侧复核兜底）。
  // 与 email-guess-persist 同口径：email/domain/company_name/contact_key 四类都查，
  // 公司被抑制 / 公司名命中 / person-key（盲值）命中都视为抑制——任何一类命中都不触网。
  // 🔴 按租户分组匹配：owner 连接跨租户读，合并成一个池会把 A 租户的抑制应用到 B 的点上。
  type SuppressionRow = { workspaceId: string; type: string; value: string };
  const suppressionRows = await prisma.suppressionRecord.findMany({
    where: {
      type: { in: ['email', 'domain', 'company_name', 'contact_key'] },
      workspaceId: { in: [...new Set(candidates.map((point) => point.workspaceId))] },
    },
    select: { workspaceId: true, type: true, value: true },
  });
  const suppressionByWorkspace = new Map<string, SuppressionRow[]>();
  for (const row of suppressionRows) {
    const bucket = suppressionByWorkspace.get(row.workspaceId) ?? [];
    bucket.push(row);
    suppressionByWorkspace.set(row.workspaceId, bucket);
  }
  const suppressionSets = (
    rows: ReadonlyArray<{ type: string; value: string }>,
  ): {
    emails: Set<string>;
    domains: Set<string>;
    contactKeys: Set<string>;
  } => {
    const canonicalizeAll = (type: string) =>
      new Set(
        rows
          .filter((row) => row.type === type)
          .map((row) => canonicalizeSuppressionValue(type, row.value))
          .filter((value): value is string => value !== null),
      );
    return {
      emails: canonicalizeAll('email'),
      domains: canonicalizeAll('domain'),
      contactKeys: new Set(
        rows.filter((row) => row.type === 'contact_key').map((row) => row.value.toLowerCase()),
      ),
    };
  };

  const gatePolicy = resolveEmailVerificationPolicy();
  let lastCallAt = 0;

  for (const point of candidates) {
    const requestHash = buildVerificationRequestHash(
      point.id,
      provider.key,
      `${point.value}|${options.requestBucket}`,
    );
    // 幂等预查：同桶已处理 → 不重复调用供应商、不重复计费。
    const existing = await prisma.contactPointVerificationEvent.findUnique({
      where: {
        workspaceId_contactPointId_providerKey_requestHash: {
          workspaceId: point.workspaceId,
          contactPointId: point.id,
          providerKey: provider.key,
          requestHash,
        },
      },
      select: { id: true },
    });
    if (existing) {
      summary.duplicates += 1;
      continue;
    }

    let email: string;
    try {
      email = decryptPii(point.value);
    } catch {
      console.warn(`跳过无法解密的点 ${point.id}（密钥/密文不匹配）`);
      summary.errors += 1;
      continue;
    }
    const canonicalEmail = canonicalizeSuppressionValue('email', email);
    const domain = canonicalEmail
      ? canonicalizeSuppressionValue('domain', emailDomainOfAddress(canonicalEmail) ?? '')
      : null;
    const company = point.contact.company;
    // 只在本租户的抑制集合里匹配（owner 连接跨租户读，合并成池会把 A 的抑制误用到 B）。
    const wsSuppressionRows = suppressionByWorkspace.get(point.workspaceId) ?? [];
    const wsSuppression = suppressionSets(wsSuppressionRows);
    const isSuppressedBy = (
      rows: ReadonlyArray<{ type: string; value: string }>,
      sets: ReturnType<typeof suppressionSets>,
    ): boolean => {
      const companySuppressed =
        company.status === 'SUPPRESSED' || companyMatchesSuppression(rows, company);
      const personSuppressed = contactSuppressionKeys(point.contact.fullName, company.dedupeKey)
        .map((key) => blindContactKey(key).toLowerCase())
        .some((key) => sets.contactKeys.has(key));
      return (
        !canonicalEmail ||
        companySuppressed ||
        personSuppressed ||
        sets.emails.has(canonicalEmail) ||
        (!!domain && sets.domains.has(domain))
      );
    };
    const suppressed = isSuppressedBy(wsSuppressionRows, wsSuppression);
    const classified = cleanEmail(email);
    // contact_point.legal_basis 是 DB CHECK 约束过的四种 basis 之一；人名邮箱无 basis 且未开
    // EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS 时，合规门拦截（不触网、不送第三方）。
    const storedBasis: LawfulBasis | undefined = point.legalBasis
      ? ({ basis: point.legalBasis as LawfulBasisKind } satisfies LawfulBasis)
      : undefined;
    const lawfulBasis = isValidLawfulBasis(storedBasis) ? storedBasis : undefined;
    const gate = evaluateEmailGate({
      email,
      kind: classified?.kind,
      lawfulBasis,
      suppressed,
      policy: gatePolicy,
    });

    const attemptedAt = now();
    if (!gate.allowed) {
      // 合规门拦截：只记事件（verdict=blocked），状态不变——与 verifyContactPoint 同一纪律。
      summary.skippedSuppressed += suppressed ? 1 : 0;
      summary.skippedCompliance += suppressed ? 0 : 1;
      await prisma.$transaction(async (tx) => {
        await recordContactPointVerificationEvent(tx, {
          workspaceId: point.workspaceId,
          contactPointId: point.id,
          providerKey: provider.key,
          method: 'third_party_api',
          verdict: 'blocked',
          detail: `lawful_basis_gate:${gate.reason}`,
          lawfulBasis: (lawfulBasis ?? null) as Record<string, unknown> | null,
          actorId: 'reverify-sweep:cli',
          requestHash,
        });
      });
      continue;
    }

    // 成本护栏：达到本轮上限即停（候选保持 due，下一轮再取；限流/幂等保证不重复计费）。
    if (options.maxCostMicrousd !== undefined && summary.costMicrousd >= options.maxCostMicrousd) {
      summary.skippedBudget += 1;
      break;
    }
    // 限流（只统计真实供应商调用）。
    const minInterval = Math.ceil(1000 / options.ratePerSecond);
    const wait = lastCallAt + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    summary.providerCalls += 1;
    const result = await provider.verify({ email });
    summary.costMicrousd += result.costMicrousd;

    // 事件账记录**供应商原始**裁决（验证事实）；状态机施加**投票裁决后**的四态
    // （单验证器 positive 只记 UNKNOWN，等第二票——双正规则）。
    const resolved = resolveVerificationVotes([
      {
        providerKey: result.providerKey,
        state: result.state,
        catchAllClass: result.catchAllClass,
        acceptAll: result.acceptAll,
      },
    ]);
    const eventVerdict: VerificationEventVerdict =
      result.error !== null
        ? 'error'
        : result.state === 'VALID'
          ? 'valid'
          : result.state === 'INVALID'
            ? 'invalid'
            : result.state === 'CATCH_ALL_RISKY'
              ? 'catch_all'
              : 'unknown';
    const transitionVerdict: VerificationEventVerdict =
      result.error !== null
        ? 'error'
        : resolved.state === 'VALID'
          ? 'valid'
          : resolved.state === 'INVALID'
            ? 'invalid'
            : resolved.state === 'CATCH_ALL_RISKY'
              ? 'catch_all'
              : 'unknown';
    const transition = transitionVerificationState(
      {
        state: point.verificationState as EmailVerificationState,
        validSince: point.validSince,
        nextReverifyAt: point.nextReverifyAt,
      },
      { verdict: transitionVerdict, catchAllClass: resolved.catchAllClass },
      attemptedAt,
    );
    const score = scoreEmailPoint({
      state: transition.state,
      catchAllClass: resolved.catchAllClass,
      positiveVotes: result.state === 'VALID' ? 1 : 0,
      verifiedAt: attemptedAt,
      now: attemptedAt,
    });

    await prisma.$transaction(async (tx) => {
      const event = await recordContactPointVerificationEvent(tx, {
        workspaceId: point.workspaceId,
        contactPointId: point.id,
        providerKey: provider.key,
        method: 'third_party_api',
        verdict: eventVerdict,
        detail: `${result.detail}${result.error ? `;error=${result.error}` : ''};resolved=${resolved.reason}`,
        catchAll: result.catchAll,
        catchAllClass: result.catchAllClass,
        score,
        costMicrousd: result.costMicrousd,
        lawfulBasis: (lawfulBasis ?? null) as Record<string, unknown> | null,
        actorId: 'reverify-sweep:cli',
        requestHash,
        latencyMs: result.latencyMs,
      });
      if (event.duplicate) return;
      // 提交侧复核（与 email-guess-persist 同纪律：供应商调用可耗时数秒，载入快照不权威）：
      // 锁租户抑制策略 → 重读四类抑制 → 已在本轮调用期间被抑制则只留事件、不写状态。
      await lockWorkspaceSuppressionPolicy(tx, point.workspaceId);
      const freshRows = await tx.suppressionRecord.findMany({
        where: {
          workspaceId: point.workspaceId,
          type: { in: ['email', 'domain', 'company_name', 'contact_key'] },
        },
        select: { type: true, value: true },
      });
      if (isSuppressedBy(freshRows, suppressionSets(freshRows))) {
        summary.skippedSuppressed += 1;
        return;
      }
      await tx.contactPoint.update({
        where: { id: point.id },
        data: {
          ...verifiedAtStateColumns(transition),
          verificationProvider: provider.key,
          verificationMethod: 'third_party_api',
          // 供应商错误/unknown 不覆盖既有的 catch-all 分类（那是上一次有效验证的知识）。
          ...(eventVerdict === 'error' || eventVerdict === 'unknown'
            ? {}
            : { catchAll: result.catchAll, catchAllClass: result.catchAllClass }),
          lastVerificationEventId: event.id,
        },
      });
    });
    if (result.error !== null) summary.errors += 1;
    summary.byState[transition.state] += 1;
  }
  return summary;
}
