import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { companyIdentity } from '../discovery/identity';
import { toAlpha2 } from '../discovery/providers/ted.provider';
import { searchContractNotices, TedContractNotice } from '../adapters/ted-api';
import { mergeIntent, IntentAttr, IntentEvent } from './intent-projection.service';

/** TED 招标公告 intent 类型 + 强度（开放招标 = 很强的实时需求信号，仅次于 web_watch SOURCING_OPENED=1）。 */
export const TENDER_PUBLISHED = 'TENDER_PUBLISHED';
export const TENDER_STRENGTH = 0.9;
const DEFAULT_SINCE_DAYS = 30;
const DEFAULT_MAX_NOTICES = 100; // 有界样本（绝不 grind 全量）

export interface ProjectTendersResult {
  noticesFetched: number;
  companiesTouched: number;
  eventsProjected: number;
  skippedNoBuyer: number;
}

interface BuyerDemand {
  name: string;
  country?: string; // alpha-2
  publicationDateIso?: string;
  cpvCodes: string[];
  publicationNumber?: string;
}

/**
 * TED 招标公告 → Intent 投影（spec §4.1a / §5.3 P3）。方向：**招标公告 = 买方需求**——买方（采购机构）
 * 是卖家的潜在客户，其发布招标 = 实时需求/时机。按买方身份解析 canonical（有则更新、无则建为线索），
 * append `attributes.intent.events[{type:'TENDER_PUBLISHED', at:<发布日 ISO>, strength}]` → 动六维 Intent 维。
 *
 * §8.6：发布日经 `tedDateToIso` 归一（mapContractNotice 已做）；`at` 不可解析则回退 now（绝不写 NaN 触发 0 分）。
 * 合规：招标/CPV/买方组织事实 🟢 CC BY 4.0（买方=法人）；不摄入具名联系人。fail-safe：无 CPV/拉取失败 → 零结果不抛。
 */
export class TedIntentProjectionService {
  constructor(private readonly deps: { prisma: PrismaService }) {}

  async projectTenders(
    workspaceId: string,
    params: { cpvCodes: string[]; buyerCountries: string[]; sinceDays?: number; maxNotices?: number },
  ): Promise<ProjectTendersResult> {
    const base: ProjectTendersResult = { noticesFetched: 0, companiesTouched: 0, eventsProjected: 0, skippedNoBuyer: 0 };
    if (!params.cpvCodes.length) return base; // 无 CPV → 不启动（绝不裸拉全库）

    let notices: TedContractNotice[];
    try {
      notices = await searchContractNotices({
        cpvCodes: params.cpvCodes,
        buyerCountries: params.buyerCountries,
        sinceDays: params.sinceDays ?? DEFAULT_SINCE_DAYS,
        scope: 'ACTIVE', // 当前开放的招标 = 有效需求窗口
        maxRecords: params.maxNotices ?? DEFAULT_MAX_NOTICES,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[ted-intent] fetch failed: ${String(err).slice(0, 150)}`);
      return base;
    }
    base.noticesFetched = notices.length;

    // 按买方身份归并（同买方多招标 → 取最新发布日代表其最新需求；dedupeKey 与其它源一致 name+alpha-2）
    const byKey = new Map<string, BuyerDemand>();
    for (const n of notices) {
      const demand = toBuyerDemand(n);
      if (!demand) {
        base.skippedNoBuyer += 1;
        continue;
      }
      const key = companyIdentity({ name: demand.name, country: demand.country }).dedupeKey;
      const prior = byKey.get(key);
      if (!prior || isNewer(demand.publicationDateIso, prior.publicationDateIso)) byKey.set(key, demand);
    }

    const now = new Date().toISOString();
    for (const [dedupeKey, demand] of byKey) {
      const touched = await this.projectOne(workspaceId, dedupeKey, demand, now);
      if (touched) {
        base.companiesTouched += 1;
        base.eventsProjected += 1;
      }
    }
    return base;
  }

  /** 单买方：upsert canonical（有则更新、无则建为线索）+ append TENDER_PUBLISHED intent。SUPPRESSED 跳过。 */
  private async projectOne(workspaceId: string, dedupeKey: string, demand: BuyerDemand, now: string): Promise<boolean> {
    return this.deps.prisma.withWorkspace(workspaceId, async (tx) => {
      const canonical = await tx.canonicalCompany.upsert({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
        update: {},
        create: {
          workspaceId,
          name: demand.name,
          country: demand.country ?? null,
          dedupeKey,
          status: 'NEW',
          attributes: { ted_buyer: true } as unknown as Prisma.InputJsonValue, // 标记来源=招标买方（可区分公共采购方线索）
        },
        select: { id: true, attributes: true, status: true },
      });
      if (canonical.status === 'SUPPRESSED') return false;

      // §8.6：at 用归一 ISO；不可解析（缺发布日）回退 now，绝不写 NaN。
      const at = demand.publicationDateIso ?? now;
      const event: IntentEvent = {
        type: TENDER_PUBLISHED,
        at,
        strength: TENDER_STRENGTH,
        evidence: { cpv: demand.cpvCodes, notice: demand.publicationNumber, source: 'ted' },
      };
      const existing = ((canonical.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const intent = mergeIntent(existing.intent as IntentAttr | undefined, [event]);

      await tx.canonicalCompany.update({
        where: { id: canonical.id },
        data: {
          attributes: { ...existing, ted_buyer: true, intent } as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
      // 🟢 招标事实证据（CC BY 4.0，买方=法人；不落具名联系人）
      await tx.fieldEvidence.create({
        data: {
          workspaceId,
          entityType: 'company',
          entityId: canonical.id,
          field: 'intent.tender',
          value: intent as unknown as Prisma.InputJsonValue,
          providerKey: 'ted',
          confidence: 1,
          license: 'CC BY 4.0',
          allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
        },
      });
      return true;
    });
  }
}

/** 一条招标公告 → 买方需求（首个买方名 + alpha-2 国别）。无买方名 → null（跳过）。 */
function toBuyerDemand(n: TedContractNotice): BuyerDemand | null {
  const name = n.buyerNames[0]?.trim();
  if (!name) return null;
  return {
    name,
    country: toAlpha2(n.buyerCountries[0]),
    publicationDateIso: n.publicationDateIso,
    cpvCodes: n.cpvCodes,
    publicationNumber: n.publicationNumber,
  };
}

/** a 比 b 新（ISO 字符串可字典序比较）；b 缺失则 a 视为更新。 */
function isNewer(a?: string, b?: string): boolean {
  if (!a) return false;
  if (!b) return true;
  return a > b;
}
