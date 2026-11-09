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
  legacyCatchAllFromClass,
  transitionVerificationState,
  verifiedAtStateColumns,
  type EmailVerificationState,
  type VerificationEventVerdict,
} from '../../discovery/contact-point-verification-state';
import type { LawfulBasis, LawfulBasisKind } from '../../discovery/provider-contract';
import { setEmailPointState } from '../../discovery/contact-point-writer';
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
import { scoreEmailPoint } from './verification-policy';
import type { EmailVerificationProvider } from './email-verification-provider';
import {
  eventVerdictFromProviderResult,
  runVerificationWaterfall,
} from './verification-waterfall';

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

/** 供应商前置门：data_provider ENABLED + source_policy 已登记未 SUSPENDED（与 finder 共用）。 */
export { checkProviderGates } from '../provider-gates';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 再验证主循环（导出供后续 Schedule activity 复用）。
 * 对每个候选：幂等预查 → suppression → 合规门 → 供应商调用（限流）→ 投票裁决 →
 * 事件账 + 点状态回写（同一事务）。
 */
export async function runReverifySweep(input: {
  prisma: PrismaClient;
  /** 可用验证器（有序：主验在前）。调用方负责过滤未配置者并逐家过 data_provider/source_policy 门。 */
  providers: EmailVerificationProvider[];
  options: ReverifyOptions;
  states?: EmailVerificationState[];
  now?: () => Date;
  /** 事件账 actor（CLI / Schedule 各用自己的标识；缺省 'reverify-sweep'）。 */
  actorId?: string;
}): Promise<ReverifySummary> {
  const { prisma, options } = input;
  const actorId = input.actorId ?? 'reverify-sweep';
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
  if (input.providers.length === 0) return summary;
  const candidates = await selectCandidates(prisma, options, states);
  summary.selected = candidates.length;
  if (options.dryRun) return summary;

  // suppression 快照（每轮一次，按候选涉及的租户过滤；批内新增由提交侧复核兜底）。
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

  /** 幂等键（每 provider 一个）：sha256(pointId | providerKey | 输入版本)。 */
  const requestHashFor = (pointId: string, providerKey: string, value: string) =>
    buildVerificationRequestHash(pointId, providerKey, `${value}|${options.requestBucket}`);

  for (const point of candidates) {
    const candidateHashes = input.providers.map((provider) => ({
      provider,
      requestHash: requestHashFor(point.id, provider.key, point.value),
    }));
    // 幂等预查（逐 provider）：同桶已处理过的验证器不再调用/不再计费；
    // 崩溃恢复时只补跑缺失的那几家（部分完成后重跑不会重复买主验）。
    const existingRows = await prisma.contactPointVerificationEvent.findMany({
      where: {
        workspaceId: point.workspaceId,
        contactPointId: point.id,
        OR: [
          ...candidateHashes.map(({ provider, requestHash }) => ({
            providerKey: provider.key,
            requestHash,
          })),
          {
            providerKey: 'compliance_gate',
            requestHash: requestHashFor(point.id, 'compliance_gate', point.value),
          },
        ],
      },
      select: { providerKey: true, requestHash: true, verdict: true, catchAllClass: true },
    });
    const doneKeys = new Set(existingRows.map((row) => row.providerKey));
    // 合规门拦截也按桶幂等：同桶已记过 blocked（provider=compliance_gate）的点不再重复处理，
    // 避免永久被拦的点每轮吃掉 limit、挤占真正可验证的候选。
    if (doneKeys.has('compliance_gate')) {
      summary.duplicates += 1;
      continue;
    }
    const pendingProviders = candidateHashes.filter(({ provider }) => !doneKeys.has(provider.key));
    if (pendingProviders.length === 0) {
      summary.duplicates += 1;
      continue;
    }
    // 部分恢复：把本轮之外**已记录**的 provider 票重建回投票矩阵（否则只有第二票 pending 时
    // 会被当成主验、单票永远凑不齐双正）。blocked/error 行不构成投票。
    const priorVotes = existingRows
      .filter((row) => row.providerKey !== 'compliance_gate' && row.verdict !== 'blocked')
      .map((row) => ({
        providerKey: row.providerKey,
        state:
          row.verdict === 'valid'
            ? ('VALID' as const)
            : row.verdict === 'invalid'
              ? ('INVALID' as const)
              : row.verdict === 'catch_all'
                ? ('CATCH_ALL_RISKY' as const)
                : ('UNKNOWN' as const),
        catchAllClass: (row.catchAllClass ?? 'unknown') as never,
        acceptAll: null,
      }));

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
      // 合规门拦截：只记事件（verdict=blocked，provider=compliance_gate），状态不变。
      summary.skippedSuppressed += suppressed ? 1 : 0;
      summary.skippedCompliance += suppressed ? 0 : 1;
      await prisma.$transaction(async (tx) => {
        await recordContactPointVerificationEvent(tx, {
          workspaceId: point.workspaceId,
          contactPointId: point.id,
          providerKey: 'compliance_gate',
          method: 'third_party_api',
          verdict: 'blocked',
          detail: `lawful_basis_gate:${gate.reason}`,
          lawfulBasis: (lawfulBasis ?? null) as Record<string, unknown> | null,
          actorId,
          requestHash: requestHashFor(point.id, 'compliance_gate', point.value),
        });
      });
      continue;
    }

    // 成本护栏：达到本轮上限即停（候选保持 due，下一轮再取；限流/幂等保证不重复计费）。
    if (options.maxCostMicrousd !== undefined && summary.costMicrousd >= options.maxCostMicrousd) {
      summary.skippedBudget += 1;
      break;
    }

    // 验证瀑布：主验 → （主验 VALID 时）二次确认 → （未收敛时）仲裁。
    // 限流在 beforeCall 里做（只统计真实供应商调用）。
    const minInterval = Math.ceil(1000 / options.ratePerSecond);
    const remainingBudget =
      options.maxCostMicrousd === undefined
        ? undefined
        : Math.max(0, options.maxCostMicrousd - summary.costMicrousd);
    const outcome = await runVerificationWaterfall({
      email,
      providers: pendingProviders.map(({ provider }) => provider),
      priorVotes,
      maxCalls: 6,
      maxCostMicrousd: remainingBudget,
      beforeCall: async () => {
        const wait = lastCallAt + minInterval - Date.now();
        if (wait > 0) await sleep(wait);
        lastCallAt = Date.now();
      },
    });
    if (outcome.steps.length === 0) {
      summary.skippedBudget += 1;
      continue;
    }
    summary.providerCalls += outcome.providerCalls;
    summary.costMicrousd += outcome.costMicrousd;

    const resolved = outcome.resolved;
    const transitionVerdict: VerificationEventVerdict =
      resolved.state === 'VALID'
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
    // 归因：最后一个有效步骤（供应商错误的那步不配署名——它没产出裁决）。
    const lastStep =
      [...outcome.steps].reverse().find((step) => step.result.error === null) ??
      outcome.steps[outcome.steps.length - 1];

    await prisma.$transaction(async (tx) => {
      let lastEventId: string | null = null;
      for (const [index, step] of outcome.steps.entries()) {
        const isLast = index === outcome.steps.length - 1;
        const rawVerdict = eventVerdictFromProviderResult(step.result);
        const event = await recordContactPointVerificationEvent(tx, {
          workspaceId: point.workspaceId,
          contactPointId: point.id,
          providerKey: step.providerKey,
          method: 'third_party_api',
          verdict: rawVerdict,
          detail:
            `${step.result.detail}${step.result.error ? `;error=${step.result.error}` : ''}` +
            (isLast ? `;resolved=${resolved.state}/${resolved.reason}` : ''),
          catchAll: step.result.catchAll,
          catchAllClass: step.result.catchAllClass,
          score: scoreEmailPoint({
            state: step.result.state,
            catchAllClass: step.result.catchAllClass,
          }),
          costMicrousd: step.result.costMicrousd,
          lawfulBasis: (lawfulBasis ?? null) as Record<string, unknown> | null,
          actorId,
          requestHash: requestHashFor(point.id, step.providerKey, point.value),
          latencyMs: step.result.latencyMs,
        });
        if (event.id) lastEventId = event.id;
      }
      if (!lastEventId) return;
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
      const columns = verifiedAtStateColumns(transition);
      await setEmailPointState(tx, {
        pointId: point.id,
        state: columns.verificationState,
        status: columns.status,
        validSince: columns.validSince,
        verifiedAt: columns.verifiedAt,
        nextReverifyAt: columns.nextReverifyAt,
        confidence: columns.confidence,
        verificationProvider: lastStep.providerKey,
        verificationMethod: 'third_party_api',
        ...(resolved.state === 'INVALID'
          ? { catchAll: 'unknown' as const, catchAllClass: null }
          : resolved.state === 'UNKNOWN'
            ? {}
            : {
                catchAll: legacyCatchAllFromClass(resolved.catchAllClass),
                catchAllClass: resolved.catchAllClass,
              }),
        lastVerificationEventId: lastEventId,
      });
    });
    if (outcome.steps.some((step) => step.result.error !== null)) summary.errors += 1;
    summary.byState[transition.state] += 1;
  }
  return summary;
}
