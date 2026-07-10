import { Prisma } from '@prisma/client';
import { GuessResult } from './email-guesser';
import { LawfulBasis } from './provider-contract';

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
  if (args.suppressedEmails.has(plan.email.toLowerCase())) {
    return { persisted: false, reason: 'suppressed' };
  }

  await tx.contactPoint.upsert({
    where: { contactId_type_value: { contactId: args.contactId, type: 'email', value: plan.email } },
    update: { status: plan.pointStatus, ...(plan.verified ? { verifiedAt: args.now } : {}) },
    create: {
      workspaceId: args.workspaceId,
      contactId: args.contactId,
      type: 'email',
      value: plan.email,
      status: plan.pointStatus,
      verifiedAt: plan.verified ? args.now : null,
    },
  });

  await tx.fieldEvidence.create({
    data: {
      workspaceId: args.workspaceId,
      entityType: 'contact',
      entityId: args.contactId,
      field: 'email.guess',
      value: {
        email: plan.email,
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
    },
  });

  return { persisted: true, email: plan.email, status: plan.pointStatus, reason: plan.reason };
}
