import { Prisma } from '@prisma/client';
import { GuessResult } from './email-guesser';
import { LawfulBasis } from './provider-contract';
import { blindContactKey, encryptPii } from '../compliance/pii-crypto';
import { companyMatchesSuppression, canonicalizeSuppressionValue, canonicalizeSuppressionValues,
} from './suppression-value';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';
import { contactSuppressionKeys } from './identity';
import {
  catchAllClassFromEmailVerdictDetail,
  catchAllFromVerdictDetail,
  confidenceForState,
  eventVerdictFromEmailVerdict,
  nextReverifyAtForState,
  stateFromEmailVerdict,
  verificationMethodFromVerdictDetail,
} from './contact-point-verification-state';
import {
  buildVerificationRequestHash,
  recordContactPointVerificationEvent,
} from './contact-point-verification-event';
import { linkLastVerificationEvent, upsertGuessedEmailPoint } from './contact-point-writer';

/**
 * 邮箱猜测结果的落库（选项 B · P0.3）——把 {@link EmailGuesser} 猜到的决策人邮箱写进
 * `contact_point`（带验证态）+ `field_evidence`（email.guess 证据），接回既有联系人链路。
 *
 * 🔴 诚实/合规落库纪律：
 *  - 只落 **verified(SMTP VALID)** 与 **unverified(RISKY 猜测)**；blocked/exhausted/no_candidates/
 *    undeliverable_domain **不落**（没可用地址就别造记录）。
 *  - contact_point.status = VALID(已证实) / RISKY(未证实猜测)；**RISKY 的 allowedActions 不含 outreach**
 *    —— 未经 SMTP 证实的猜测**绝不可群发**，只可展示/匹配。
 *  - suppression 命中的地址一律不落（对外动作第一道检查）。
 *  - 猜出的邮箱=人名邮箱（personalData），证据带 lawful_basis + personal_data 标记，下游触达门前置。
 */

/** 落库计划（纯，可测）：null=不落。 */
export interface GuessWritePlan {
  email: string;
  pointStatus: 'VALID' | 'RISKY';
  verified: boolean;
  pattern: string;
  confidence: number;
  reason: string;
  verificationDetail: string | null;
  /** A4：把验证 verdict.detail 归类成 catch-all 三态（+unknown）。 */
  catchAll: 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown';
  /** A4：RCPT/域级探测真的跑过才记 smtp_rcpt；没触网（gate 不可用/发件人被拒/不可达）如实记 pattern_guess。 */
  verificationMethod: 'smtp_rcpt' | 'pattern_guess';
}

/** 猜测结果 → 落库计划。只 verified/unverified-with-best 才落；其余返回 null（不落）。 */
export function guessedEmailWritePlan(result: GuessResult): GuessWritePlan | null {
  if (!result.best) return null;
  if (result.status !== 'verified' && result.status !== 'unverified') return null;
  const verified = result.status === 'verified';
  return {
    email: result.best.email,
    pointStatus: verified ? 'VALID' : 'RISKY',
    verified,
    pattern: result.best.pattern,
    confidence: result.best.confidence,
    reason: result.reason,
    verificationDetail: result.best.verdict.detail ?? null,
    catchAll: catchAllFromVerdictDetail(result.best.verdict.detail),
    verificationMethod: verificationMethodFromVerdictDetail(result.best.verdict.detail),
  };
}

/** 猜测邮箱的 allowedActions：VALID(已证实) 才可 outreach；RISKY(未证实) 只展示/匹配。 */
export function allowedActionsForGuess(status: 'VALID' | 'RISKY'): string[] {
  return status === 'VALID' ? ['display', 'match', 'outreach'] : ['display', 'match'];
}

export interface PersistGuessOutcome {
  persisted: boolean;
  email?: string;
  status?: 'VALID' | 'RISKY';
  reason: string;
}

export async function readbackGuessedEmail(
  tx: Prisma.TransactionClient,
  args: { contactId: string; result: GuessResult },
): Promise<PersistGuessOutcome> {
  const plan = guessedEmailWritePlan(args.result);
  if (!plan) return { persisted: false, reason: args.result.reason };
  const email = canonicalizeSuppressionValue('email', plan.email);
  if (!email) return { persisted: false, reason: 'suppressed' };
  const point = await tx.contactPoint.findUnique({
    where: {
      contactId_type_value: {
        contactId: args.contactId,
        type: 'email',
        value: email,
      },
    },
    select: { status: true },
  });
  if (!point || (point.status !== 'VALID' && point.status !== 'RISKY')) {
    return { persisted: false, reason: 'authoritative_readback_missing' };
  }
  return {
    persisted: true,
    email,
    status: point.status,
    reason: plan.reason,
  };
}

/**
 * 把单个联系人的邮箱猜测结果落库。contact 必须已存在（有 contactId）。now 由调用方传入（可测/不读时钟）。
 */
export async function persistGuessedEmail(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    contactId: string;
    result: GuessResult;
    suppressedEmails: Set<string>;
    lawfulBasis?: LawfulBasis;
    now: Date;
  },
): Promise<PersistGuessOutcome> {
  const plan = guessedEmailWritePlan(args.result);
  if (!plan) return { persisted: false, reason: args.result.reason };

  await lockWorkspaceSuppressionPolicy(tx, args.workspaceId);

  // Commit-side terminal gate: the SMTP call can take minutes, so the load-time company/email
  // suppression snapshot is not authoritative here. Lock and reread the owning company, then
  // consume current append-only suppression rows before creating any contact point or PII evidence.
  const companies = await tx.$queryRaw<{ id: string; name: string; domain: string | null; status: string }[]>`
    SELECT co.id, co.name, co.domain, co.status
    FROM canonical_contact ct
    JOIN canonical_company co ON co.id = ct.company_id
    WHERE ct.id = ${args.contactId}::uuid
    FOR SHARE OF co`;
  const company = companies[0];
  if (!company || company.status === 'SUPPRESSED') return { persisted: false, reason: 'suppressed' };

  const currentSuppressions = await tx.suppressionRecord.findMany({
    where: { type: { in: ['domain', 'company_name', 'email', 'contact_key'] } },
    select: { type: true, value: true },
  });
  if (companyMatchesSuppression(currentSuppressions, company)) {
    await tx.canonicalCompany.updateMany({
      where: { id: company.id, status: { not: 'SUPPRESSED' } },
      data: { status: 'SUPPRESSED', version: { increment: 1 } },
    });
    return { persisted: false, reason: 'suppressed' };
  }

  const email = canonicalizeSuppressionValue('email', plan.email);
  const contact = await tx.canonicalContact.findUnique({
    where: { id: args.contactId },
    select: { fullName: true, company: { select: { dedupeKey: true } } },
  });
  if (!contact) return { persisted: false, reason: 'suppressed' };
  const suppressedContactKeys = new Set(
    currentSuppressions.filter((row) => row.type === 'contact_key').map((row) => row.value.toLowerCase()),
  );
  const contactKeys = contactSuppressionKeys(contact.fullName, contact.company.dedupeKey).map((value) =>
    blindContactKey(value).toLowerCase(),
  );
  const suppressedDomains = canonicalizeSuppressionValues(
    'domain',
    currentSuppressions.filter((row) => row.type === 'domain').map((row) => row.value),
  );
  const emailDomain = email ? canonicalizeSuppressionValue('domain', email.split('@')[1]) : null;
  const effectiveSuppressedEmails = new Set([
    ...args.suppressedEmails,
    ...canonicalizeSuppressionValues(
      'email',
      currentSuppressions.filter((row) => row.type === 'email').map((row) => row.value),
    ),
  ]);
  if (
    !email ||
    effectiveSuppressedEmails.has(email) ||
    (!!emailDomain && suppressedDomains.has(emailDomain)) ||
    contactKeys.some((value) => suppressedContactKeys.has(value))
  ) {
    return { persisted: false, reason: 'suppressed' };
  }

  // P1 四态：VALID(已证实) / CATCH_ALL_RISKY(catch_all 域或反枚举 provider) /
  // UNKNOWN(其余未证实猜测)。口径与 verifyContactPoint 同一映射函数（stateFromEmailVerdict）：
  // 反枚举（M365/GWS…）与 true catch-all 是同风险层、不同子类。
  // 注意：猜测管线每次都是**完整重验**（学格式→SMTP 探）——VALID 重验成功刷新
  // valid_since/verifiedAt 为本次尝试（与 transition 的 VALID→VALID 保留不同：那是重试，
  // 这是新证据）；弱证据重观测按该管线既有纪律保守降级（status/verifiedAt 同样处理，不改写）。
  const verificationState =
    plan.pointStatus === 'VALID'
      ? ('VALID' as const)
      : (stateFromEmailVerdict('RISKY', plan.verificationDetail) ?? ('UNKNOWN' as const));
  const stateFields = {
    verificationState,
    catchAllClass:
      plan.pointStatus === 'VALID'
        ? ('not_catch_all' as const)
        : (catchAllClassFromEmailVerdictDetail(plan.verificationDetail) ?? ('unknown' as const)),
    verificationProvider: plan.verificationMethod === 'smtp_rcpt' ? 'smtp_self' : 'email_guess',
    confidence: confidenceForState(verificationState),
    validSince: verificationState === 'VALID' ? args.now : null,
    nextReverifyAt: nextReverifyAtForState(verificationState, args.now),
  };
  const point = await upsertGuessedEmailPoint(tx, {
    workspaceId: args.workspaceId,
    contactId: args.contactId,
    email,
    status: plan.pointStatus,
    verifiedAt: plan.verified ? args.now : null,
    emailType: 'personal',
    sourceType: 'pattern_guess',
    verificationMethod: plan.verificationMethod,
    catchAll: plan.catchAll,
    ...(args.lawfulBasis ? { legalBasis: args.lawfulBasis.basis } : {}),
    ...stateFields,
  });
  // P1：猜测路径同样进事件账（G9 每一次验证尝试一行）——事件账是验证事实的唯一来源，
  // 不能在「猜测 + SMTP 复验」这条产出 VALID 的主路径上留白。
  const eventProvider = plan.verificationMethod === 'smtp_rcpt' ? 'smtp_self' : 'email_guess';
  const computedEventVerdict = eventVerdictFromEmailVerdict(
    plan.pointStatus === 'VALID' ? 'VALID' : 'RISKY',
    plan.verificationDetail,
  );
  const verificationEvent = await recordContactPointVerificationEvent(tx, {
    workspaceId: args.workspaceId,
    contactPointId: point.id,
    providerKey: eventProvider,
    method: plan.verificationMethod,
    verdict: computedEventVerdict,
    detail: plan.verificationDetail,
    catchAll: plan.catchAll,
    catchAllClass: stateFields.catchAllClass,
    score: stateFields.confidence,
    costMicrousd: 0,
    lawfulBasis: (args.lawfulBasis ?? null) as Record<string, unknown> | null,
    actorId: 'email-guess:pipeline',
    requestHash: buildVerificationRequestHash(
      point.id,
      eventProvider,
      `${email}|${plan.verificationDetail ?? ''}|${args.now.toISOString()}`,
    ),
  });
  if (verificationEvent.id) {
    await linkLastVerificationEvent(tx, { pointId: point.id, eventId: verificationEvent.id });
  }

  await tx.fieldEvidence.create({
    data: {
      workspaceId: args.workspaceId,
      entityType: 'contact',
      entityId: args.contactId,
      field: 'email.guess',
      value: {
        // 收口⑥：证据里的人名邮箱=第二份 PII → 加密落库（确定性，与 contact_point 密文一致）。
        email: encryptPii(email),
        pattern: plan.pattern,
        confidence: plan.confidence,
        status: plan.pointStatus,
        verified: plan.verified,
        reason: plan.reason,
        verification_detail: plan.verificationDetail,
        lawful_basis: args.lawfulBasis ?? null,
        personal_data: true,
      } as unknown as Prisma.InputJsonValue,
      providerKey: 'email_guess',
      license: 'derived',
      allowedActions: allowedActionsForGuess(plan.pointStatus) as unknown as Prisma.InputJsonValue,
      dataClass: 'red', // 猜出的人名邮箱=个人数据
    },
  });

  return {
    persisted: true,
    email,
    status: plan.pointStatus,
    reason: plan.reason,
  };
}
