import { Prisma } from '@prisma/client';

/**
 * P1-08：contact_enrichment_attempt 读写（富集尝试账，计划 §2.3.4.5/§2.3.4.6）。
 *
 * 每次 finder 调用一行——hit / miss / error / skipped_budget / skipped_compliance 都记、
 * 成本照记。三层复用口径（都不是「永久幂等」，避免一次 miss 永久堵死）：
 *  1) **同输入版本**（request_hash 相同）的 hit：90 天内直接复用（不重扣）；
 *  2) **同输入版本**的 miss/error/skipped_*：24 小时内复用（同日重跑不重烧配额，
 *     次日允许重试——覆盖崩溃恢复与当天重试，又不会把长尾永远判死）；
 *  3) **同联系人同 provider 的最近 hit**（输入版本不同）：90 天内复用——
 *     计划 §2.3.4.1「同一个联系人 90 天内不重复购买」。
 *
 * 并发纪律同验证事件账：唯一键冲突用 SAVEPOINT 回滚点包围 INSERT，回读安全；
 * 竞态对手未提交时回读为空（id=null、duplicate=true），调用方按「已有尝试」跳过调用。
 */

export const ENRICHMENT_HIT_CACHE_MS = 90 * 24 * 3_600_000;
export const ENRICHMENT_MISS_CACHE_MS = 24 * 3_600_000;

export const ENRICHMENT_ATTEMPT_OUTCOMES = [
  'hit',
  'miss',
  'error',
  'skipped_budget',
  'skipped_compliance',
] as const;
export type EnrichmentAttemptOutcome = (typeof ENRICHMENT_ATTEMPT_OUTCOMES)[number];

export interface RecordEnrichmentAttemptInput {
  workspaceId: string;
  contactId: string;
  providerKey: string;
  requestHash: string;
  outcome: EnrichmentAttemptOutcome;
  errorCode?: string | null;
  retryable?: boolean | null;
  /** 微美元；非有限值一律 0。 */
  costMicrousd?: number;
  latencyMs?: number;
  emailState?: string | null;
  evidence?: Record<string, unknown> | null;
  runId?: string | null;
  accountKey: string;
  attemptedAt?: Date;
}

export interface EnrichmentAttemptSnapshot {
  id: string;
  providerKey: string;
  requestHash: string;
  outcome: string;
  errorCode: string | null;
  emailState: string | null;
  costMicrousd: number;
  attemptedAt: Date;
}

function safeCostMicrousd(raw: number | undefined): bigint {
  const value = raw ?? 0;
  if (!Number.isFinite(value)) return 0n;
  return BigInt(Math.max(0, Math.round(value)));
}

const SNAPSHOT_SELECT = {
  id: true,
  providerKey: true,
  requestHash: true,
  outcome: true,
  errorCode: true,
  emailState: true,
  costMicrousd: true,
  attemptedAt: true,
} as const;

function toSnapshot(row: {
  id: string;
  providerKey: string;
  requestHash: string;
  outcome: string;
  errorCode: string | null;
  emailState: string | null;
  costMicrousd: bigint;
  attemptedAt: Date;
}): EnrichmentAttemptSnapshot {
  return {
    id: row.id,
    providerKey: row.providerKey,
    requestHash: row.requestHash,
    outcome: row.outcome,
    errorCode: row.errorCode,
    emailState: row.emailState,
    costMicrousd: Number(row.costMicrousd),
    attemptedAt: row.attemptedAt,
  };
}

/**
 * 写入一行尝试（幂等）。已存在同 (workspace, provider, request_hash) 的行 → 返回
 * duplicate=true 与该行快照（供应商重试不重复记费）。
 */
export async function recordEnrichmentAttempt(
  tx: Prisma.TransactionClient,
  input: RecordEnrichmentAttemptInput,
): Promise<{ duplicate: boolean; attempt: EnrichmentAttemptSnapshot | null }> {
  const where = {
    workspaceId_providerKey_requestHash: {
      workspaceId: input.workspaceId,
      providerKey: input.providerKey,
      requestHash: input.requestHash,
    },
  } as const;
  await tx.$executeRawUnsafe('SAVEPOINT cea_write');
  try {
    const row = await tx.contactEnrichmentAttempt.create({
      data: {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        providerKey: input.providerKey,
        requestHash: input.requestHash,
        outcome: input.outcome,
        errorCode: input.errorCode ?? null,
        retryable: input.retryable ?? null,
        costMicrousd: safeCostMicrousd(input.costMicrousd),
        latencyMs: Math.max(0, Math.round(input.latencyMs ?? 0)),
        emailState: input.emailState ?? null,
        evidence:
          input.evidence === null || input.evidence === undefined
            ? Prisma.JsonNull
            : (input.evidence as Prisma.InputJsonValue),
        runId: input.runId ?? null,
        accountKey: input.accountKey,
        ...(input.attemptedAt ? { attemptedAt: input.attemptedAt } : {}),
      },
      select: SNAPSHOT_SELECT,
    });
    return { duplicate: false, attempt: toSnapshot(row) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT cea_write');
      const raced = await tx.contactEnrichmentAttempt.findUnique({
        where,
        select: SNAPSHOT_SELECT,
      });
      return { duplicate: true, attempt: raced ? toSnapshot(raced) : null };
    }
    throw error;
  }
}

/**
 * 本地复用预查（调用供应商之前跑）：
 *  1) 同 request_hash 的行在 TTL 内（hit 90 天；其余 24 小时）→ 直接复用；
 *  2) 同联系人同 provider 的最近 hit 在 90 天内（换输入版本也算）→ 复用。
 * 命中返回快照，否则 null。
 */
export async function findReusableAttempt(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    contactId: string;
    providerKey: string;
    requestHash: string;
    now: Date;
  },
): Promise<EnrichmentAttemptSnapshot | null> {
  const exact = await tx.contactEnrichmentAttempt.findUnique({
    where: {
      workspaceId_providerKey_requestHash: {
        workspaceId: input.workspaceId,
        providerKey: input.providerKey,
        requestHash: input.requestHash,
      },
    },
    select: SNAPSHOT_SELECT,
  });
  if (exact) {
    const ttl = exact.outcome === 'hit' ? ENRICHMENT_HIT_CACHE_MS : ENRICHMENT_MISS_CACHE_MS;
    if (input.now.getTime() - exact.attemptedAt.getTime() < ttl) return toSnapshot(exact);
  }
  const recentHit = await tx.contactEnrichmentAttempt.findFirst({
    where: {
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      providerKey: input.providerKey,
      outcome: 'hit',
      attemptedAt: { gte: new Date(input.now.getTime() - ENRICHMENT_HIT_CACHE_MS) },
    },
    orderBy: { attemptedAt: 'desc' },
    select: SNAPSHOT_SELECT,
  });
  return recentHit ? toSnapshot(recentHit) : null;
}

/** 验证瀑布完成后回填最终四态（未验证保持 NULL）。 */
export async function updateAttemptEmailState(
  tx: Prisma.TransactionClient,
  attemptId: string,
  emailState: string | null,
): Promise<void> {
  await tx.contactEnrichmentAttempt.update({
    where: { id: attemptId },
    data: { emailState },
  });
}
