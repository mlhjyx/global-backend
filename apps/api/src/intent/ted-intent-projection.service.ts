import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { companyIdentity } from '../discovery/identity';
import { toAlpha2 } from '../discovery/providers/ted.provider';
import type { TedContractNotice } from '../adapters/ted-api';
import type { TedSearchInput, TedSearchOutput } from '../tools/source-tools';
import type { ExecutionBroker } from '../tools/tool-contract';
import { mergeIntent, sameIntent, IntentAttr, IntentEvent } from './intent-projection.service';

/** TED 招标公告 intent 类型 + 强度（开放招标 = 很强的实时需求信号，仅次于 web_watch SOURCING_OPENED=1）。 */
export const TENDER_PUBLISHED = 'TENDER_PUBLISHED';
export const TENDER_STRENGTH = 0.9;
const DEFAULT_SINCE_DAYS = 30;
const DEFAULT_MAX_NOTICES = 100; // 有界样本（绝不 grind 全量）
const TED_ATTRIBUTION = 'Source: TED — © European Union; reused under CC BY 4.0'; // CC BY 4.0 署名义务（§3.1）

export interface ProjectTendersResult {
  noticesFetched: number;
  companiesTouched: number;
  eventsProjected: number;
  skippedNoBuyer: number;
  skippedNoCountry: number;
  skippedNoDate: number;
}

interface BuyerDemand {
  name: string;
  country: string; // alpha-2（必有——无国别的招标跳过，防跨国同名误并）
  publicationDateIso: string; // §8.6 合法 ISO（必有——无有效发布日的招标跳过，无可靠时机信号）
  cpvCodes: string[];
  publicationNumber?: string;
}

/**
 * TED 招标公告 → Intent 投影（spec §4.1a / §5.3 P3）。方向：**招标公告 = 买方需求**——买方（采购机构）
 * 是卖家的潜在客户，其发布招标 = 实时需求/时机。按买方身份解析 canonical（有则更新、无则建为线索），
 * append `attributes.intent.events[{type:'TENDER_PUBLISHED', at:<发布日 ISO>, strength}]` → 动六维 Intent 维。
 *
 * §8.6：发布日经 `tedDateToIso` 归一（mapContractNotice 已做）；**无合法发布日的招标直接跳过**（绝不写 NaN
 *   触发 0 分，亦不用 now 兜底——now 每 sweep 变 → 跨 sweep 同招标重复堆事件）。
 * §8.8（收口②：Broker 单点判定）：ted.search 是 required 工具——直连 api.ted.europa.eu（personalData=true）
 *   一律经 ExecutionBroker，SUSPENDED / 未登记 / 用途不符 / 无 reader 由闸门 fail-closed（不发请求）。
 *   无 broker = 不允许直连（零投影返回）——与 P1 provider 同一 DAT-011 kill-switch。
 * 幂等：合并结果与既有 intent 实质相同 → 不 bump version / 不堆 field_evidence（开放招标每日 sweep 复现时）。
 * 合规：招标/CPV/买方组织事实 🟢 CC BY 4.0（买方=法人）；不摄入具名联系人。fail-safe：无 CPV/拉取失败 → 零结果不抛。
 */
export class TedIntentProjectionService {
  constructor(private readonly deps: { prisma: PrismaService; broker?: ExecutionBroker }) {}

  async projectTenders(
    workspaceId: string,
    params: { cpvCodes: string[]; buyerCountries: string[]; sinceDays?: number; maxNotices?: number },
  ): Promise<ProjectTendersResult> {
    const base: ProjectTendersResult = {
      noticesFetched: 0, companiesTouched: 0, eventsProjected: 0, skippedNoBuyer: 0, skippedNoCountry: 0, skippedNoDate: 0,
    };
    if (!params.cpvCodes.length) return base; // 无 CPV → 不启动（绝不裸拉全库）

    // §8.8 合规门（收口②：Broker 单点判定）：ted.search 是 required 工具——SUSPENDED/未登记/用途不符/
    // 无 reader 一律 fail-closed。无 broker = 不允许直连（生产由调用方注入）。
    if (!this.deps.broker) {
       
      console.warn('[ted-intent] broker unavailable, fail-closed (no raw egress)');
      return base;
    }

    let notices: TedContractNotice[];
    try {
      const res = await this.deps.broker.invoke<TedSearchInput, TedSearchOutput>(
        'ted.search',
        {
          kind: 'contract',
          params: {
            cpvCodes: params.cpvCodes,
            buyerCountries: params.buyerCountries,
            sinceDays: params.sinceDays ?? DEFAULT_SINCE_DAYS,
            scope: 'ACTIVE', // 当前开放的招标 = 有效需求窗口
            maxRecords: params.maxNotices ?? DEFAULT_MAX_NOTICES,
          },
        },
        { workspaceId, correlationId: 'ted-intent' },
      );
      notices = res.data.notices ?? [];
    } catch (err) {
      // fail-safe：拉取失败/闸门拒绝零投影不抛（拒绝原因已入 Broker DENIED trace）
       
      console.warn(`[ted-intent] fetch failed: ${String(err).slice(0, 150)}`);
      return base;
    }
    base.noticesFetched = notices.length;

    // 按买方身份归并（同买方多招标 → 取最新发布日代表其最新需求；dedupeKey 与其它源一致 name+alpha-2）。
    // 无买方名 / 无国别 / 无合法发布日的招标各自跳过并计数（可审计），绝不降级成不可靠身份或时间。
    const byKey = new Map<string, BuyerDemand>();
    for (const n of notices) {
      const name = n.buyerNames[0]?.trim();
      if (!name) { base.skippedNoBuyer += 1; continue; }
      const country = toAlpha2(n.buyerCountries[0]);
      if (!country) { base.skippedNoCountry += 1; continue; } // §8.4：无国别 → name-only 键会跨国误并
      if (!n.publicationDateIso) { base.skippedNoDate += 1; continue; } // §8.6：无有效发布日 → 无可靠时机信号
      const demand: BuyerDemand = { name, country, publicationDateIso: n.publicationDateIso, cpvCodes: n.cpvCodes, publicationNumber: n.publicationNumber };
      const key = companyIdentity({ name, country }).dedupeKey;
      const prior = byKey.get(key);
      if (!prior || demand.publicationDateIso > prior.publicationDateIso) byKey.set(key, demand); // ISO 字典序 = 时间序
    }

    for (const [dedupeKey, demand] of byKey) {
      const touched = await this.projectOne(workspaceId, dedupeKey, demand);
      if (touched) {
        base.companiesTouched += 1;
        base.eventsProjected += 1;
      }
    }
    return base;
  }

  /**
   * 单买方：upsert canonical（有则更新、无则建为线索）+ append TENDER_PUBLISHED intent。
   * SUPPRESSED 跳过。**幂等**：合并结果与既有实质相同（仅 _ts 变）→ 不写（返回 false，指标不虚报）。
   * 新建买方额外写一条身份事实 field_evidence（CC BY 4.0 署名，仅建时一次）——买方名/国别是 TED 再发布绿事实。
   */
  private async projectOne(workspaceId: string, dedupeKey: string, demand: BuyerDemand): Promise<boolean> {
    return this.deps.prisma.withWorkspace(workspaceId, async (tx) => {
      const prior = await tx.canonicalCompany.findUnique({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
        select: { id: true, attributes: true, status: true },
      });
      if (prior?.status === 'SUPPRESSED') return false;

      const priorAttrs = ((prior?.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const priorIntent = priorAttrs.intent as IntentAttr | undefined;
      const event: IntentEvent = {
        type: TENDER_PUBLISHED,
        at: demand.publicationDateIso, // §8.6：必为合法 ISO（无合法发布日的招标在归并阶段已跳过）
        strength: TENDER_STRENGTH,
        evidence: { cpv: demand.cpvCodes, notice: demand.publicationNumber, source: 'ted' },
      };
      const intent = mergeIntent(priorIntent, [event]);
      // 幂等门：既有买方且合并后 intent 实质未变（同一开放招标每日 sweep 复现）→ 不 bump version、不堆 evidence 行。
      if (prior && priorIntent && sameIntent(priorIntent, intent)) return false;

      const saved = await tx.canonicalCompany.upsert({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
        create: {
          workspaceId,
          name: demand.name,
          country: demand.country,
          dedupeKey,
          status: 'NEW',
          attributes: { ted_buyer: true, intent } as unknown as Prisma.InputJsonValue, // 标记来源=招标买方
        },
        update: {
          attributes: { ...priorAttrs, ted_buyer: true, intent } as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
        select: { id: true },
      });

      // 🟢 intent 招标事实证据（CC BY 4.0，买方=法人；不落具名联系人）
      await tx.fieldEvidence.create({
        data: {
          workspaceId,
          entityType: 'company',
          entityId: saved.id,
          field: 'intent.tender',
          value: intent as unknown as Prisma.InputJsonValue,
          providerKey: 'ted',
          confidence: 1,
          license: 'CC BY 4.0',
          allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
        },
      });
      // 🟢 买方身份事实署名（CC BY 4.0）——仅新建时写一次（幂等，避免每 sweep 堆行）。
      if (!prior) {
        await tx.fieldEvidence.create({
          data: {
            workspaceId,
            entityType: 'company',
            entityId: saved.id,
            field: 'identity',
            value: { name: demand.name, country: demand.country, source: 'ted', notice: demand.publicationNumber, attribution: TED_ATTRIBUTION } as unknown as Prisma.InputJsonValue,
            providerKey: 'ted',
            confidence: 1,
            license: 'CC BY 4.0',
            allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return true;
    });
  }

  // 幂等门用的 sameIntent / canonicalize 已上移到 intent-projection.service.ts（DRY，与 openFDA intent 投影共享）。
  // 手写 §8.8 purposeAllowed 镜像已删除（收口②）：ted.search 为 required 工具，SUSPENDED/未登记/用途不符/
  // 无 reader 由 ExecutionBroker 单点 fail-closed（原镜像存在「无 reader fail-open」缺陷）。
}
