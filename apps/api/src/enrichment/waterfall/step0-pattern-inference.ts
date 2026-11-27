/**
 * P0 Fix #3：Step 0 零成本邮箱格式反推 + 验证落库（Batch 1.4-C）。
 *
 * 在触发付费 finder（Hunter/Findymail/Prospeo）之前，先读取同公司已有 VALID 个人邮箱样本，
 * 用 `inferEmailPattern` + `applyLearnedPattern` 推断当前联系人的候选邮箱，经抑制门、
 * 合法性依据门（personal/other 一律 fail-closed）与验证瀑布核验：
 *  - 仅当验证瀑布明确裁决 `VALID` 时才零 finder 成本落库（provider = 'pattern_inferred'，
 *    finderAttempts = 0）并在 EU/UK 同步排期 GDPR Art.14 通知；
 *  - 未命中格式、或验证非 VALID（INVALID / CATCH_ALL_RISKY / UNKNOWN）时直接回退付费 finder 瀑布，
 *    绝不误存低置信度猜邮。
 */
import type { Prisma } from '@prisma/client';
import { scheduleArticle14NoticeInTransaction } from '../../compliance/article14-lia.service';
import {
  evaluateEmailGate,
  resolveEmailVerificationPolicy,
} from '../../discovery/compliance/email-verification-gate';
import { classifyContactEmail, type ContactEmailType } from '../../discovery/contact-classifier';
import {
  buildVerificationRequestHash,
  recordContactPointVerificationEvent,
} from '../../discovery/contact-point-verification-event';
import {
  legacyCatchAllFromClass,
  transitionVerificationState,
  verifiedAtStateColumns,
} from '../../discovery/contact-point-verification-state';
import { setEmailPointState, upsertProviderEmailPoint } from '../../discovery/contact-point-writer';
import {
  conservativeCountryCodeForFallback,
  inferConservativeEuUkFallback,
  resolveCompanyJurisdiction,
} from '../../discovery/jurisdiction-resolver';
import {
  applyLearnedPattern,
  inferEmailPattern,
  type KnownEmailSample,
} from '../../discovery/email-format-learning';
import type { LawfulBasis } from '../../discovery/provider-contract';
import { canonicalizeSuppressionValue } from '../../discovery/suppression-value';
import type { EmailVerificationProvider } from '../verification/email-verification-provider';
import { scoreEmailPoint } from '../verification/verification-policy';
import {
  eventVerdictFromProviderResult,
  runVerificationWaterfall,
} from '../verification/verification-waterfall';
import type { EnrichmentBudget } from './enrichment-budget';

const MAX_STEP0_CANDIDATES = 2;

export interface Step0InferenceDeps {
  readonly prisma: {
    withWorkspace<T>(workspaceId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  };
  readonly verifiers: EmailVerificationProvider[];
  readonly budget: EnrichmentBudget;
  readonly clock: () => Date;
  readonly actorId: string;
  readonly maxVerificationCalls: number;
  readonly onRateLimited?: () => void;
  readonly onValidEmail?: (email: string) => void;
}

export interface Step0InferenceInput {
  readonly workspaceId: string;
  readonly contactId: string;
  readonly fullName: string;
  readonly domain: string;
  readonly country?: string | null;
  readonly runId?: string;
  readonly accountKey: string;
  readonly lawfulBasis?: LawfulBasis;
  readonly knownCompanyEmailSamples: readonly KnownEmailSample[];
}

export interface Step0StoredOutcome {
  readonly status: 'stored';
  readonly pointId: string;
  readonly state: 'VALID';
  readonly provider: 'pattern_inferred';
  readonly costMicrousd: number;
  readonly finderAttempts: 0;
  readonly verificationEventId: string | null;
}

export function isPersonalOrOtherEmailType(emailType: ContactEmailType): boolean {
  return emailType === 'personal' || emailType === 'other';
}

export function hasAnyEnrichmentPath(
  findersCount: number,
  knownSamples: readonly KnownEmailSample[] | undefined,
  verifiersCount: number,
): boolean {
  return findersCount > 0 || (Boolean(knownSamples?.length) && verifiersCount > 0);
}

/** EU/UK 具名邮箱（personal/other）入库时同事务排期 GDPR Art.14 通知（缺国别时对明确欧洲信号保守 Fail-Closed）。 */
export async function maybeScheduleEnrichedArticle14(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    contactId: string;
    companyName?: string | null;
    country?: string | null;
    domain?: string | null;
    emailType: ContactEmailType;
    sourceCategory: string;
    acquiredAt: Date;
  },
): Promise<void> {
  if (!isPersonalOrOtherEmailType(args.emailType)) return;
  const noticeModel = (tx as { article14Notice?: { findFirst?: unknown } }).article14Notice;
  if (typeof noticeModel?.findFirst !== 'function') return;
  const resolved = resolveCompanyJurisdiction({
    name: args.companyName,
    domain: args.domain,
    country: args.country,
  })?.iso;
  const fallback = resolved
    ? null
    : inferConservativeEuUkFallback({ name: args.companyName, domain: args.domain });
  const effectiveCountry = resolved ?? (fallback ? conservativeCountryCodeForFallback(fallback) : null);
  if (!effectiveCountry) return;
  await scheduleArticle14NoticeInTransaction(tx, {
    workspaceId: args.workspaceId,
    subjectId: args.contactId,
    country: effectiveCountry,
    sourceCategory: fallback ? `${args.sourceCategory}:conservative_eu_fallback` : args.sourceCategory,
    acquiredAt: args.acquiredAt,
  });
}

/** VALID 个人邮箱入库后在进程内回传给同公司后续联系人用于格式学习。 */
export function maybeNotifyValidPersonalEmail(
  email: string,
  emailType: ContactEmailType,
  state: string,
  onValidEmail?: (email: string) => void,
): void {
  if (state === 'VALID' && isPersonalOrOtherEmailType(emailType)) {
    onValidEmail?.(email);
  }
}

/** 条件执行 Step 0：无样本或无验证器时直接跳过；若无 finder 且未命中则给出 not_found 终态。 */
export async function runStep0IfEligible(
  deps: Omit<Step0InferenceDeps, 'maxVerificationCalls'> & { readonly maxVerificationCalls?: number },
  input: Omit<Step0InferenceInput, 'knownCompanyEmailSamples'> & {
    readonly knownCompanyEmailSamples?: readonly KnownEmailSample[];
  },
  hasFinders: boolean,
): Promise<{
  outcome: Step0StoredOutcome | { status: 'not_found'; costMicrousd: number; finderAttempts: 0 } | null;
  costMicrousd: number;
}> {
  const samples = input.knownCompanyEmailSamples;
  if (!samples?.length || deps.verifiers.length === 0) {
    return { outcome: null, costMicrousd: 0 };
  }
  const step0 = await tryStep0PatternInference(
    {
      ...deps,
      maxVerificationCalls: Math.max(1, Math.min(6, deps.maxVerificationCalls ?? 6)),
    },
    { ...input, knownCompanyEmailSamples: samples },
  );
  if (step0.outcome) return step0;
  if (!hasFinders) {
    return {
      outcome: { status: 'not_found', costMicrousd: step0.costMicrousd, finderAttempts: 0 },
      costMicrousd: step0.costMicrousd,
    };
  }
  return step0;
}

/** 读取公司国别、候选联系人职位与既有领英 URL（独立于冻结的 loadContactEnrichmentTargets 合同）。 */
export async function loadCompanyEnrichmentMeta(
  tx: Prisma.TransactionClient,
  companyId: string,
  contactIds: readonly string[],
): Promise<{
  country: string | null;
  titleByContactId: Map<string, string | null>;
  linkedinUrlByContactId: Map<string, string>;
}> {
  const titleByContactId = new Map<string, string | null>();
  const linkedinUrlByContactId = new Map<string, string>();
  let country: string | null = null;
  const companyModel = (tx as { canonicalCompany?: { findFirst?: unknown } }).canonicalCompany;
  if (companyModel && typeof companyModel.findFirst === 'function') {
    const row = await tx.canonicalCompany.findFirst({
      where: { id: companyId },
      select: { name: true, country: true, domain: true, attributes: true },
    });
    country =
      row?.country ??
      resolveCompanyJurisdiction({
        name: row?.name,
        domain: row?.domain,
        country: row?.country,
        attributes: row?.attributes,
      })?.iso ??
      null;
  }
  if (contactIds.length > 0 && typeof tx.canonicalContact?.findMany === 'function') {
    const rows = await tx.canonicalContact.findMany({
      where: { id: { in: [...contactIds] } },
      select: { id: true, title: true },
    });
    for (const row of rows) {
      if (row && typeof row.id === 'string' && 'title' in row) {
        titleByContactId.set(row.id, (row as { title?: string | null }).title ?? null);
      }
    }
  }
  const contactPointModel = (tx as { contactPoint?: { findMany?: unknown } }).contactPoint;
  if (contactIds.length > 0 && contactPointModel && typeof contactPointModel.findMany === 'function') {
    const rows = await tx.contactPoint.findMany({
      where: { contactId: { in: [...contactIds] }, type: 'linkedin' },
      select: { contactId: true, value: true },
    });
    for (const row of rows) {
      const url = typeof row.value === 'string' ? row.value.trim() : '';
      if (
        typeof row.contactId === 'string' &&
        /^https:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/in\/[^\s?#]+/iu.test(url) &&
        !linkedinUrlByContactId.has(row.contactId)
      ) {
        linkedinUrlByContactId.set(row.contactId, url);
      }
    }
  }
  return { country, titleByContactId, linkedinUrlByContactId };
}

/** 读取同公司已有 VALID 个人邮箱样本（经 Prisma PII 扩展自动解密）；轻量 mock tx 缺 findMany 时返回空。 */
export async function loadKnownCompanyEmailSamples(
  tx: Prisma.TransactionClient,
  companyId: string,
): Promise<KnownEmailSample[]> {
  const contactPointModel = (tx as { contactPoint?: { findMany?: unknown } }).contactPoint;
  if (!contactPointModel || typeof contactPointModel.findMany !== 'function') {
    return [];
  }
  const rows = await tx.contactPoint.findMany({
    where: {
      type: 'email',
      verificationState: 'VALID',
      contact: { companyId },
    },
    select: {
      value: true,
      contact: { select: { fullName: true } },
    },
    take: 20,
  });
  const samples: KnownEmailSample[] = [];
  for (const row of rows) {
    const email = typeof row.value === 'string' ? row.value.trim().toLowerCase() : '';
    const fullName = typeof row.contact?.fullName === 'string' ? row.contact.fullName.trim() : '';
    if (!email || !fullName) continue;
    const emailType = classifyContactEmail(email).emailType;
    if (emailType !== 'personal' && emailType !== 'other') continue;
    samples.push({ fullName, email });
  }
  return samples;
}

/** 尝试 Step 0 零 finder 成本模式推断；仅在验证器明确判 VALID 时落库并返回结果，否则返回 null 交回付费瀑布。 */
export async function tryStep0PatternInference(
  deps: Step0InferenceDeps,
  input: Step0InferenceInput,
): Promise<{ outcome: Step0StoredOutcome | null; costMicrousd: number }> {
  if (deps.verifiers.length === 0 || input.knownCompanyEmailSamples.length === 0) {
    return { outcome: null, costMicrousd: 0 };
  }
  const learned = inferEmailPattern([...input.knownCompanyEmailSamples]);
  if (!learned) return { outcome: null, costMicrousd: 0 };

  const candidates = applyLearnedPattern(learned, input.fullName, input.domain).slice(
    0,
    MAX_STEP0_CANDIDATES,
  );
  if (candidates.length === 0) return { outcome: null, costMicrousd: 0 };

  let totalCostMicrousd = 0;
  for (const candidate of candidates) {
    const email = candidate.email;
    const emailType: ContactEmailType = classifyContactEmail(email).emailType;
    const gateAllowed = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const suppressed = await tx.suppressionRecord.findFirst({
        where: { type: 'email', value: canonicalizeSuppressionValue('email', email) ?? email },
        select: { id: true },
      });
      if (suppressed) return false;
      const decision = evaluateEmailGate({
        email,
        kind: emailType === 'personal' || emailType === 'other' ? 'personal' : 'role',
        lawfulBasis: input.lawfulBasis,
        suppressed: false,
        policy: resolveEmailVerificationPolicy(),
      });
      return decision.allowed;
    });
    if (!gateAllowed) continue;

    const verification = await runVerificationWaterfall({
      email,
      providers: deps.verifiers,
      workspaceId: input.workspaceId,
      runId: input.runId,
      maxCalls: deps.maxVerificationCalls,
    });
    if (verification.steps.some((step) => step.result.error === 'rate_limited')) deps.onRateLimited?.();
    totalCostMicrousd += verification.costMicrousd;
    deps.budget.settle(0, verification.costMicrousd);

    if (verification.resolved?.state !== 'VALID' || verification.steps.length === 0) {
      continue;
    }

    const stored = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const point = await upsertProviderEmailPoint(tx, {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        email,
        emailType,
        ...(input.lawfulBasis ? { legalBasis: input.lawfulBasis.basis } : {}),
      });
      const attemptedAt = deps.clock();
      let lastEventId: string | null = null;
      let lastVotedProvider: string | null = null;
      let lastVotedMethod = 'third_party_api';
      for (const step of verification.steps) {
        const event = await recordContactPointVerificationEvent(tx, {
          workspaceId: input.workspaceId,
          contactPointId: point.id,
          providerKey: step.providerKey,
          method: step.result.method ?? 'third_party_api',
          verdict: eventVerdictFromProviderResult(step.result),
          detail: `step0_pattern:${learned.pattern};${step.result.detail}${step.result.error ? `;error=${step.result.error}` : ''}`,
          catchAll: step.result.catchAll,
          catchAllClass: step.result.catchAllClass,
          score: scoreEmailPoint({
            state: step.result.state,
            catchAllClass: step.result.catchAllClass,
          }),
          costMicrousd: step.result.costMicrousd,
          lawfulBasis: (input.lawfulBasis ?? null) as Record<string, unknown> | null,
          actorId: deps.actorId,
          requestHash: buildVerificationRequestHash(
            point.id,
            step.providerKey,
            `step0|${email}|${input.runId ?? input.accountKey}`,
          ),
          latencyMs: step.result.latencyMs,
        });
        if (event.id) lastEventId = event.id;
        if (step.result.error === null) {
          lastVotedProvider = step.providerKey;
          lastVotedMethod = step.result.method ?? 'third_party_api';
        }
      }
      const transition = transitionVerificationState(
        {
          state: point.verificationState,
          validSince: point.validSince,
          nextReverifyAt: point.nextReverifyAt,
        },
        { verdict: 'valid', catchAllClass: verification.resolved.catchAllClass },
        attemptedAt,
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
        verificationProvider: lastVotedProvider ?? 'pattern_inferred',
        verificationMethod: lastVotedMethod,
        catchAll: legacyCatchAllFromClass(verification.resolved.catchAllClass),
        catchAllClass: verification.resolved.catchAllClass,
        lastVerificationEventId: lastEventId,
      });
      const resolvedCountry = resolveCompanyJurisdiction({
        domain: input.domain,
        country: input.country,
      })?.iso;
      const euFallback = resolvedCountry
        ? null
        : inferConservativeEuUkFallback({ domain: input.domain });
      const effectiveCountry =
        resolvedCountry ?? (euFallback ? conservativeCountryCodeForFallback(euFallback) : null);
      if (
        effectiveCountry &&
        (emailType === 'personal' || emailType === 'other') &&
        typeof (tx as { article14Notice?: { findFirst?: unknown } }).article14Notice?.findFirst === 'function'
      ) {
        await scheduleArticle14NoticeInTransaction(tx, {
          workspaceId: input.workspaceId,
          subjectId: input.contactId,
          country: effectiveCountry,
          sourceCategory: euFallback ? 'pattern_inferred:conservative_eu_fallback' : 'pattern_inferred',
          acquiredAt: attemptedAt,
        });
      }
      return { pointId: point.id, lastEventId };
    });

    deps.onValidEmail?.(email);
    return {
      costMicrousd: totalCostMicrousd,
      outcome: {
        status: 'stored',
        pointId: stored.pointId,
        state: 'VALID',
        provider: 'pattern_inferred',
        costMicrousd: totalCostMicrousd,
        finderAttempts: 0,
        verificationEventId: stored.lastEventId,
      },
    };
  }

  return { outcome: null, costMicrousd: totalCostMicrousd };
}
