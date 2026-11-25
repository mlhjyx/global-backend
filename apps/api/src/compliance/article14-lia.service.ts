/**
 * GDPR Art.14 通知编排 + LIA（Legitimate Interest Assessment）记录与个人数据留存清理（Batch 1.3-B）：
 *
 * 严格遵循数据最小化与租户 RLS：
 *  - `article14_notice` 与 `lia_record` 仅存主体 UUID 引用与法域/来源类别，绝不嵌人名/邮箱明文；
 *  - EU / UK 自然人数据入库自动排期 30 天履行截止（`dueAt = acquiredAt + 30d`），首联时可原地标记 `FULFILLED`；
 *  - LIA 查验按 `contact → company → workspace` 逐级查找 `ACTIVE` 有效记录；
 *  - 留存期扫描按 `RED_RETENTION_DAYS = 730` 定位到期 `canonical_contact` 供 DSR 擦除工作流受理。
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeJurisdiction } from './jurisdiction';

export const ARTICLE14_DEADLINE_DAYS = 30;
export const PERSONAL_CONTACT_RETENTION_DAYS = 730;
const DAY_MS = 86_400_000;

/**
 * 面向中国出海 B2B 企业的标准合法利益评估（LIA）默认模板（Batch 1.5-A）。
 * 供租户在启用欧盟/英国市场时一键激活留档，避免前台要求非法律人员手工起草 LIA 文档。
 */
export const DEFAULT_B2B_OUTREACH_LIA_TEMPLATE = Object.freeze({
  basis: 'legitimate_interest' as const,
  purpose: 'B2B corporate procurement and supply-chain partnership outreach in EU/UK markets',
  necessityNote:
    'Limited to publicly disclosed corporate role/decision-maker business contact data strictly necessary to initiate B2B commercial inquiries.',
  balancingNote:
    'Low privacy impact (work-context data only, no consumer profiling); mitigated by Art.14 compact disclosure in first contact, one-click opt-out, permanent suppression, and Art.17 erasure.',
  ref: 'LIA-B2B-DEFAULT-V1',
});

/** 事务内幂等激活工作区级默认 B2B LIA 记录（已有 ACTIVE 记录时直接复用，不重复写入）。 */
export async function ensureDefaultWorkspaceLiaInTransaction(
  tx: Prisma.TransactionClient,
  input: { readonly workspaceId: string; readonly recordedBy: string },
): Promise<{ id: string; created: boolean; ref: string | null }> {
  const existing = await tx.liaRecord.findFirst({
    where: {
      workspaceId: input.workspaceId,
      scope: 'workspace',
      scopeRef: null,
      status: 'ACTIVE',
    },
    select: { id: true, ref: true },
    orderBy: { effectiveAt: 'desc' },
  });
  if (existing) {
    return { id: existing.id, created: false, ref: existing.ref };
  }
  const created = await tx.liaRecord.create({
    data: {
      workspaceId: input.workspaceId,
      scope: 'workspace',
      scopeRef: null,
      basis: DEFAULT_B2B_OUTREACH_LIA_TEMPLATE.basis,
      purpose: DEFAULT_B2B_OUTREACH_LIA_TEMPLATE.purpose,
      necessityNote: DEFAULT_B2B_OUTREACH_LIA_TEMPLATE.necessityNote,
      balancingNote: DEFAULT_B2B_OUTREACH_LIA_TEMPLATE.balancingNote,
      ref: DEFAULT_B2B_OUTREACH_LIA_TEMPLATE.ref,
      recordedBy: input.recordedBy,
      status: 'ACTIVE',
    },
    select: { id: true, ref: true },
  });
  return { id: created.id, created: true, ref: created.ref };
}

export interface ScheduleArticle14Input {
  readonly workspaceId: string;
  readonly subjectId: string;
  readonly subjectType?: 'contact';
  readonly country: string | null | undefined;
  readonly sourceCategory: string;
  readonly acquiredAt?: Date;
}

export interface FulfillArticle14Input {
  readonly workspaceId: string;
  readonly subjectId: string;
  readonly channel: 'email' | 'first_contact' | 'linkedin' | 'portal';
  readonly note?: string;
  readonly fulfilledAt?: Date;
}

export interface RecordLiaInput {
  readonly workspaceId: string;
  readonly scope: 'workspace' | 'company' | 'contact';
  readonly scopeRef?: string | null;
  readonly basis?: 'legitimate_interest' | 'consent' | 'contract' | 'legal_obligation';
  readonly purpose: string;
  readonly necessityNote?: string;
  readonly balancingNote?: string;
  readonly ref?: string;
  readonly recordedBy: string;
}

/** 仅 EU / UK 间接采集的自然人数据触发 GDPR Art.14 通知义务。 */
export function requiresArticle14ForCountry(country: string | null | undefined): 'EU' | 'UK' | null {
  const jurisdiction = normalizeJurisdiction(country);
  return jurisdiction === 'EU' || jurisdiction === 'UK' ? jurisdiction : null;
}

/** 事务内幂等排期 Art.14 通知（30 天截止）；非 EU/UK 返回 null。 */
export async function scheduleArticle14NoticeInTransaction(
  tx: Prisma.TransactionClient,
  input: ScheduleArticle14Input,
): Promise<{ id: string; jurisdiction: 'EU' | 'UK'; dueAt: Date; created: boolean } | null> {
  const jurisdiction = requiresArticle14ForCountry(input.country);
  if (!jurisdiction) return null;
  const subjectType = input.subjectType ?? 'contact';
  const existing = await tx.article14Notice.findFirst({
    where: {
      workspaceId: input.workspaceId,
      subjectType,
      subjectId: input.subjectId,
      status: { in: ['PENDING', 'FULFILLED', 'EXEMPTED'] },
    },
    select: { id: true, dueAt: true },
  });
  if (existing) {
    return { id: existing.id, jurisdiction, dueAt: existing.dueAt, created: false };
  }
  const acquiredAt = input.acquiredAt ?? new Date();
  const dueAt = new Date(acquiredAt.getTime() + ARTICLE14_DEADLINE_DAYS * DAY_MS);
  const created = await tx.article14Notice.create({
    data: {
      workspaceId: input.workspaceId,
      subjectType,
      subjectId: input.subjectId,
      jurisdiction,
      obligation: 'REQUIRED',
      dueAt,
      status: 'PENDING',
      note: `source:${input.sourceCategory.trim().slice(0, 120)}`,
    },
    select: { id: true, dueAt: true },
  });
  return { id: created.id, jurisdiction, dueAt: created.dueAt, created: true };
}

/** 首次外联触达时将 PENDING 的 Art.14 通知标记为已履行（FULFILLED）。 */
export async function fulfillArticle14NoticeInTransaction(
  tx: Prisma.TransactionClient,
  input: FulfillArticle14Input,
): Promise<number> {
  const result = await tx.article14Notice.updateMany({
    where: {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      status: 'PENDING',
    },
    data: {
      status: 'FULFILLED',
      fulfilledAt: input.fulfilledAt ?? new Date(),
      channel: input.channel,
      ...(input.note ? { note: input.note.slice(0, 240) } : {}),
    },
  });
  return result.count;
}

/** 按 contact → company → workspace 逐级查找有效 ACTIVE LIA 记录。 */
export async function findActiveLiaRecordInTransaction(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; companyId?: string | null; contactId?: string | null },
): Promise<{ id: string; scope: string; basis: string; ref: string | null } | null> {
  const candidates: Array<{ scope: string; scopeRef: string | null }> = [];
  if (input.contactId) candidates.push({ scope: 'contact', scopeRef: input.contactId });
  if (input.companyId) candidates.push({ scope: 'company', scopeRef: input.companyId });
  candidates.push({ scope: 'workspace', scopeRef: null });

  const rows = await tx.liaRecord.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: 'ACTIVE',
      OR: candidates.map((c) => ({ scope: c.scope, scopeRef: c.scopeRef })),
    },
    select: { id: true, scope: true, scopeRef: true, basis: true, ref: true },
    orderBy: { effectiveAt: 'desc' },
  });
  for (const target of candidates) {
    const match = rows.find((row) => row.scope === target.scope && row.scopeRef === target.scopeRef);
    if (match) return { id: match.id, scope: match.scope, basis: match.basis, ref: match.ref };
  }
  return null;
}

/** 扫描超过留存期上限（默认 730 天）的个人联系人 ID 供 DSR 清理流程受理。 */
export async function findRetentionExpiredContactIdsInTransaction(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; now?: Date; retentionDays?: number; limit?: number },
): Promise<string[]> {
  const now = input.now ?? new Date();
  const days = Math.max(1, input.retentionDays ?? PERSONAL_CONTACT_RETENTION_DAYS);
  const take = Math.max(1, Math.min(input.limit ?? 100, 500));
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const rows = await tx.canonicalContact.findMany({
    where: { workspaceId: input.workspaceId, createdAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take,
  });
  return rows.map((row) => row.id);
}

@Injectable()
export class Article14LiaService {
  constructor(private readonly prisma: PrismaService) {}

  scheduleNotice(input: ScheduleArticle14Input) {
    return this.prisma.withWorkspace(input.workspaceId, (tx) =>
      scheduleArticle14NoticeInTransaction(tx, input),
    );
  }

  fulfillNotice(input: FulfillArticle14Input) {
    return this.prisma.withWorkspace(input.workspaceId, (tx) =>
      fulfillArticle14NoticeInTransaction(tx, input),
    );
  }

  recordLia(input: RecordLiaInput) {
    return this.prisma.withWorkspace(input.workspaceId, (tx) =>
      tx.liaRecord.create({
        data: {
          workspaceId: input.workspaceId,
          scope: input.scope,
          scopeRef: input.scope === 'workspace' ? null : (input.scopeRef ?? null),
          basis: input.basis ?? 'legitimate_interest',
          purpose: input.purpose.trim().slice(0, 500),
          necessityNote: input.necessityNote?.trim().slice(0, 1000) ?? null,
          balancingNote: input.balancingNote?.trim().slice(0, 1000) ?? null,
          ref: input.ref?.trim().slice(0, 200) ?? null,
          recordedBy: input.recordedBy,
          status: 'ACTIVE',
        },
        select: { id: true, scope: true, basis: true, ref: true, status: true },
      }),
    );
  }

  findActiveLia(workspaceId: string, opts?: { companyId?: string | null; contactId?: string | null }) {
    return this.prisma.withWorkspace(workspaceId, (tx) =>
      findActiveLiaRecordInTransaction(tx, { workspaceId, ...opts }),
    );
  }
}
