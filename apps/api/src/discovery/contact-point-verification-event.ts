import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  type CatchAllClass,
  type VerificationEventVerdict,
} from './contact-point-verification-state';

/**
 * P1：contact_point_verification_event 的写入器（append-only 事件账）。
 *
 * 每次验证尝试一行——成功、失败、被合规门拦截都记（G9：审计完整率 100%）。幂等键
 * (workspace, point, provider, request_hash)：同一输入版本重复调用（供应商重试 / 脚本
 * 崩溃后重跑）只记一行、不重复记费。`request_hash` 由 {@link buildVerificationRequestHash}
 * 生成——输入版本对请求预算路径是 requestSha256，对批处理是点值密文 + 周期桶。
 */

export const VERIFICATION_EVENT_METHODS = [
  'third_party_api',
  'smtp_rcpt',
  'operator',
  'import',
  'pattern_guess',
] as const;
export type VerificationEventMethod = (typeof VERIFICATION_EVENT_METHODS)[number];

export interface RecordVerificationEventInput {
  workspaceId: string;
  contactPointId: string;
  providerKey: string;
  method: VerificationEventMethod;
  verdict: VerificationEventVerdict;
  detail?: string | null;
  catchAll?: 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown' | null;
  catchAllClass?: CatchAllClass | null;
  score?: number | null;
  /** 微美元（$0.00178 = 1780）。 */
  costMicrousd?: number;
  lawfulBasis?: Record<string, unknown> | null;
  actorId: string;
  requestHash: string;
  latencyMs?: number | null;
}

/**
 * 幂等键：sha256(pointId | providerKey | inputVersion)。各段带长度前缀，避免裸 `|`
 * 拼接在字段含分隔符时产生跨元组碰撞（防御性；当前各段来源均受控）。
 */
export function buildVerificationRequestHash(
  pointId: string,
  providerKey: string,
  inputVersion: string,
): string {
  const join = (...parts: string[]) =>
    parts.map((part) => `${part.length}:${part}`).join('|');
  return createHash('sha256').update(join(pointId, providerKey, inputVersion)).digest('hex');
}

/** `cost_microusd` 的安全换算：非有限值（NaN/Infinity/类型漂移）一律 0，绝不抛。 */
function safeCostMicrousd(raw: number | undefined): bigint {
  const value = raw ?? 0;
  if (!Number.isFinite(value)) return 0n;
  return BigInt(Math.max(0, Math.round(value)));
}

/**
 * 写入一行验证事件（幂等）。已存在同 (point, provider, request_hash) 的行 → 复用已存在行
 * 返回 duplicate=true（供应商重试不重复记费）。
 *
 * 并发纪律：唯一键冲突用 **SAVEPOINT 回滚点** 包围 INSERT——PostgreSQL 里语句错误会中止
 * 整个事务，裸 catch P2002 后再读同一 tx 会撞 25P02；ROLLBACK TO SAVEPOINT 让回读安全。
 * 竞态对手未提交时回读可能为空（id=null），调用方跳过 lastVerificationEventId 即可。
 * **不做**写前 findUnique（常见路径省一次往返；调用方若需在供应商调用前预查，自己查）。
 */
export async function recordContactPointVerificationEvent(
  tx: Prisma.TransactionClient,
  input: RecordVerificationEventInput,
): Promise<{ id: string | null; duplicate: boolean }> {
  const where = {
    workspaceId_contactPointId_providerKey_requestHash: {
      workspaceId: input.workspaceId,
      contactPointId: input.contactPointId,
      providerKey: input.providerKey,
      requestHash: input.requestHash,
    },
  } as const;
  const attemptNo =
    (await tx.contactPointVerificationEvent.count({
      where: { workspaceId: input.workspaceId, contactPointId: input.contactPointId },
    })) + 1;
  await tx.$executeRawUnsafe('SAVEPOINT cpve_write');
  try {
    const event = await tx.contactPointVerificationEvent.create({
      data: {
        workspaceId: input.workspaceId,
        contactPointId: input.contactPointId,
        attemptNo,
        providerKey: input.providerKey,
        method: input.method,
        verdict: input.verdict,
        detail: input.detail ?? null,
        catchAll: input.catchAll ?? null,
        catchAllClass: input.catchAllClass ?? null,
        score: input.score ?? null,
        costMicrousd: safeCostMicrousd(input.costMicrousd),
        lawfulBasis:
          input.lawfulBasis === null || input.lawfulBasis === undefined
            ? Prisma.JsonNull
            : (input.lawfulBasis as Prisma.InputJsonValue),
        actorId: input.actorId,
        requestHash: input.requestHash,
        latencyMs: input.latencyMs ?? null,
      },
      select: { id: true },
    });
    return { id: event.id, duplicate: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT cpve_write');
      const raced = await tx.contactPointVerificationEvent.findUnique({
        where,
        select: { id: true },
      });
      return { id: raced?.id ?? null, duplicate: true };
    }
    throw error;
  }
}
