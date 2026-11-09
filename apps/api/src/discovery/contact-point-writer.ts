import type { Prisma } from '@prisma/client';
import { projectLegacyStatus, type EmailVerificationState } from './contact-point-verification-state';

/**
 * contact_point 的**唯一写入器**（P1-02）。所有写路径必须经由本模块——
 * `contact-point-writer.guard.spec.ts` 会扫描 `apps/api/src/**`，发现任何直接
 * `tx.contactPoint.create/upsert/update/…` 即失败（本文件自身除外）。
 *
 * 为什么必须单一写入器（ch02 §2.3.2.5）：四态列、legacy status 投影、valid_since
 * 等价约束、catch-all 子类与验证事件账是**一个**不变量集合；三路写入各写各的必然分叉
 * （2026-11 就出现过 RISKY 清 verifiedAt 而 INVALID 留时间戳、状态与事件账不一致）。
 *
 * 读路径（findMany/findUnique）不受本守卫限制；DSR 擦除经 canonical_contact 级联删除，
 * 不直接写 contact_point（删除动作本身也不在本模块）。
 *
 * 三类写入者：
 *  1. 联系人发现（contact-persist）——`upsertObservedContactPoint`（首见优先，`update: {}`）；
 *  2. 邮箱猜测（email-guess-persist）——`upsertGuessedEmailPoint` + `linkLastVerificationEvent`；
 *  3. 验证回写（DiscoveryService.verifyContactPoint / 再验证 sweep）——`setEmailPointState`。
 */

export interface ObservedContactPointInput {
  workspaceId: string;
  contactId: string;
  type: string;
  value: string;
  /** 迁移 20261109120000 起 NOT NULL（来源分类见 sourceTypeForContactObservation）。 */
  sourceType: string;
  /** 仅 email 点：role | generic_sales | … | personal | other。 */
  emailType?: string;
  /** 仅 email 点：发现来源为 provider 上报（provider_reported）。 */
  verificationMethod?: string;
  legalBasis?: string;
  sourceUrl?: string;
}

/**
 * 观察型写入（发现链路）：按 (contactId, type, value) 幂等 upsert；重复观测**不覆盖**
 * 既有分类（首见来源优先，`update: {}`）。四态列走 DB 默认（UNKNOWN、confidence NULL、
 * next_reverify_at NULL）——发现阶段不做验证断言。
 */
export async function upsertObservedContactPoint(
  tx: Prisma.TransactionClient,
  input: ObservedContactPointInput,
): Promise<void> {
  await tx.contactPoint.upsert({
    where: {
      contactId_type_value: { contactId: input.contactId, type: input.type, value: input.value },
    },
    update: {},
    create: {
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      type: input.type,
      value: input.value,
      sourceType: input.sourceType,
      ...(input.emailType ? { emailType: input.emailType } : {}),
      ...(input.verificationMethod ? { verificationMethod: input.verificationMethod } : {}),
      ...(input.legalBasis ? { legalBasis: input.legalBasis } : {}),
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    },
  });
}

export interface GuessedEmailPointInput {
  workspaceId: string;
  contactId: string;
  email: string;
  status: 'VALID' | 'RISKY';
  verifiedAt: Date | null;
  emailType: 'personal';
  sourceType: 'pattern_guess';
  verificationMethod: 'smtp_rcpt' | 'pattern_guess';
  catchAll: 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown';
  legalBasis?: string;
  verificationState: EmailVerificationState;
  catchAllClass: string;
  verificationProvider: string;
  confidence: number;
  validSince: Date | null;
  nextReverifyAt: Date | null;
}

/**
 * 邮箱猜测写入：create 落来源（pattern_guess）与全部四态列；update 刷新验证元数据并
 * **显式清 verifiedAt**（守住「RISKY 无 verifiedAt」既有不变式）。
 * 返回点 id（事件账关联用）。
 */
export async function upsertGuessedEmailPoint(
  tx: Prisma.TransactionClient,
  input: GuessedEmailPointInput,
): Promise<{ id: string }> {
  const stateFields = {
    verificationState: input.verificationState,
    catchAllClass: input.catchAllClass,
    verificationProvider: input.verificationProvider,
    confidence: input.confidence,
    validSince: input.validSince,
    nextReverifyAt: input.nextReverifyAt,
  };
  return tx.contactPoint.upsert({
    where: {
      contactId_type_value: { contactId: input.contactId, type: 'email', value: input.email },
    },
    update: {
      status: input.status,
      verifiedAt: input.verifiedAt,
      emailType: input.emailType,
      verificationMethod: input.verificationMethod,
      catchAll: input.catchAll,
      ...stateFields,
      ...(input.legalBasis ? { legalBasis: input.legalBasis } : {}),
    },
    create: {
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      type: 'email',
      value: input.email,
      status: input.status,
      verifiedAt: input.verifiedAt,
      emailType: input.emailType,
      sourceType: input.sourceType,
      verificationMethod: input.verificationMethod,
      catchAll: input.catchAll,
      ...stateFields,
      ...(input.legalBasis ? { legalBasis: input.legalBasis } : {}),
    },
    select: { id: true },
  });
}

export interface EmailPointStateInput {
  pointId: string;
  /** 四态转换结果（状态机产出；BLOCKED 不推进状态列，调用方只传 status/verifiedAt 等）。 */
  state: EmailVerificationState;
  /** legacy status 投影（验证路径用 projectLegacyStatus；BLOCKED 处置写 'BLOCKED'）。 */
  status: string;
  validSince: Date | null;
  verifiedAt: Date;
  nextReverifyAt: Date | null;
  confidence: number;
  /** undefined = 不触碰（BLOCKED 处置与 unknown 结果保留既有值）。 */
  verificationProvider?: string;
  verificationMethod?: string;
  /** undefined = 不触碰；null = 置空；字符串 = 写入。 */
  catchAll?: string | null;
  catchAllClass?: string | null;
  lastVerificationEventId?: string | null;
  /** true = 只写处置列（status/verifiedAt/lastVerificationEventId），四态列保持不动（BLOCKED）。 */
  dispositionOnly?: boolean;
}

/**
 * 验证回写（HTTP verify 与再验证 sweep 共用）：一次事务内把状态机结果落到点行。
 * 不变量由 DB 约束兜底（VALID ⇔ valid_since、state evidence）；调用方负责矩阵裁决与
 * catch-all 覆盖策略（哪些结果可以覆盖既有分类）。
 */
export async function setEmailPointState(
  tx: Prisma.TransactionClient,
  input: EmailPointStateInput,
): Promise<Prisma.ContactPointGetPayload<Record<string, never>>> {
  return tx.contactPoint.update({
    where: { id: input.pointId },
    data: {
      status: input.status,
      verifiedAt: input.verifiedAt,
      ...(input.lastVerificationEventId !== undefined
        ? { lastVerificationEventId: input.lastVerificationEventId }
        : {}),
      ...(input.dispositionOnly
        ? {}
        : {
            verificationState: input.state,
            validSince: input.validSince,
            confidence: input.confidence,
            nextReverifyAt: input.nextReverifyAt,
            ...(input.verificationProvider !== undefined
              ? { verificationProvider: input.verificationProvider }
              : {}),
            ...(input.verificationMethod !== undefined
              ? { verificationMethod: input.verificationMethod }
              : {}),
            ...(input.catchAll !== undefined ? { catchAll: input.catchAll } : {}),
            ...(input.catchAllClass !== undefined ? { catchAllClass: input.catchAllClass } : {}),
          }),
    },
  });
}

/** 事件账 → 点的最后事件指针（猜测路径写完事件后用）。 */
export async function linkLastVerificationEvent(
  tx: Prisma.TransactionClient,
  input: { pointId: string; eventId: string },
): Promise<void> {
  await tx.contactPoint.update({
    where: { id: input.pointId },
    data: { lastVerificationEventId: input.eventId },
  });
}

/** 投影便捷导出：写入器是 legacy status 的唯一产地（守卫 spec 校验调用方不再自算 VALID/RISKY）。 */
export { projectLegacyStatus };
