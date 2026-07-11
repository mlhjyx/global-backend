import { Prisma } from '@prisma/client';
import type { SourceSignal } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toAlpha2 } from '../discovery/providers/ted.provider';
import { TENDER_PUBLISHED, TENDER_STRENGTH } from '../signals/signal-mappers';
import { mergeIntent, sameIntent, IntentAttr, IntentEvent } from './intent-projection.service';

// 单一真值在 signals/signal-mappers（摄取层先用）；此处 re-export 保持既有 import 路径不破。
export { TENDER_PUBLISHED, TENDER_STRENGTH };

const DEFAULT_SINCE_DAYS = 30;
const DEFAULT_MAX_COMPANIES = 100; // 单 ICP 单轮投影的公司上限（有界，绝不 grind 全量）
const SIGNAL_SCAN_LIMIT = 2000; // 单页扫描上限（防超大窗全表拉入内存）
const SIGNAL_SCAN_MAX_PAGES = 10; // CPV 匹配分页扫描的页数硬顶（最多 10×2000 条/国别窗/ICP，防病态窗无界扫）
const TED_ATTRIBUTION = 'Source: TED — © European Union; reused under CC BY 4.0'; // CC BY 4.0 署名义务（§3.1）

export interface ProjectTendersResult {
  signalsMatched: number;
  companiesTouched: number;
  eventsProjected: number;
  /** maxCompanies 触顶后被排除的主体数（可观测，不静默；游标化根治随缺口#8 fast-follow）。 */
  subjectsTruncated: number;
}

interface BuyerDemand {
  name: string;
  country: string; // alpha-2（摄取层已保证）
  publicationDateIso: string; // 事件时间（source_signal.occurredAt 的 UTC ISO）
  cpvCodes: string[];
  publicationNumber?: string;
}

/**
 * TED 招标 intent 投影（收口⑤反转）：**只读平台层 `source_signal`**（TENDER_PUBLISHED，
 * SignalIngestService 已 ingest-once 落库），本 service 不再出网——fetch 与投影彻底拆层。
 * 按 ICP 的 CPV 码（去尾零前缀双向匹配子树）× 买方国别（ISO-3 → alpha-2 归一）过滤 ACTIVE 信号，
 * 按买方身份归并取最新发布日 → upsert canonical（有则更新、无则建为线索）→ append TENDER_PUBLISHED
 * 事件（形状不变，评分零改动）。attributes.intent 自此为**可复算投影**（recompute 见 intent-recompute）。
 * 状态机：只投影 status='ACTIVE'（EXPIRED/REVOKED 剔除）；已投影的历史事件由评分新近度衰减自然老化。
 * 幂等：合并结果与既有 intent 实质相同 → 不 bump version / 不堆 field_evidence（同一信号每 sweep 复现时）。
 * 合规：招标/CPV/买方组织事实 🟢 CC BY 4.0（租户侧履行署名义务：intent 证据行 + 新建时 identity 署名行）。
 */
export class TedIntentProjectionService {
  constructor(private readonly deps: { prisma: PrismaService }) {}

  async projectTenders(
    workspaceId: string,
    params: { cpvCodes: string[]; buyerCountries: string[]; sinceDays?: number; maxCompanies?: number },
  ): Promise<ProjectTendersResult> {
    const base: ProjectTendersResult = { signalsMatched: 0, companiesTouched: 0, eventsProjected: 0, subjectsTruncated: 0 };
    if (!params.cpvCodes.length || !params.buyerCountries.length) return base; // 无码/无国别 → 本 ICP 无匹配面

    const since = new Date(Date.now() - (params.sinceDays ?? DEFAULT_SINCE_DAYS) * 86_400_000);
    const countries = [...new Set(params.buyerCountries.map((c) => toAlpha2(c)).filter((c): c is string => !!c))];
    const maxCompanies = params.maxCompanies ?? DEFAULT_MAX_COMPANIES;

    // CPV 子树前缀无法像 FDA 精确码那样下推 jsonb 过滤（记档：归一前缀列+GIN 为根治）——故**分页扫描**国别/时间窗，
    // **每页先做 CPV 匹配再累积**，把上限施加到"匹配后"的信号。否则 >单页(SIGNAL_SCAN_LIMIT) 条 ACTIVE 信号（跨
    // 全部 CPV）时，只取最新一页会把更旧的 CPV 匹配信号截断在窗外（#56 P2）。稳定游标 (occurredAt desc, id desc)
    // 处理同发布日并列；页数硬顶 SIGNAL_SCAN_MAX_PAGES 防病态窗无界扫（触顶仍未扫尽 → 显性告警不静默）。
    const matched: SourceSignal[] = [];
    const seenSubjects = new Set<string>();
    let cursorId: string | undefined;
    let windowExhausted = false;
    for (let page = 0; page < SIGNAL_SCAN_MAX_PAGES; page += 1) {
      const rows: SourceSignal[] = await this.deps.prisma.sourceSignal.findMany({
        where: {
          providerKey: 'ted',
          signalType: TENDER_PUBLISHED,
          status: 'ACTIVE', // 状态机：过期/撤回信号不再投影
          occurredAt: { gte: since },
          subjectCountry: { in: countries },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: SIGNAL_SCAN_LIMIT,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
      if (!rows.length) { windowExhausted = true; break; }
      for (const s of rows) {
        const keys = Array.isArray(s.taxonomyKeys) ? (s.taxonomyKeys as string[]) : [];
        if (keys.some((k) => params.cpvCodes.some((icpCode) => cpvOverlap(icpCode, k)))) {
          matched.push(s);
          seenSubjects.add(s.subjectKey);
        }
      }
      cursorId = rows[rows.length - 1].id;
      // rows 按 occurredAt desc → 主体首见即最新；已凑够 maxCompanies 个不同买方 → 更旧信号不会带来新主体 → 可停。
      if (seenSubjects.size >= maxCompanies) break;
      if (rows.length < SIGNAL_SCAN_LIMIT) { windowExhausted = true; break; }
    }
    if (!windowExhausted && seenSubjects.size < maxCompanies) {
      console.warn(`[ted-intent] CPV 匹配分页达页上限(${SIGNAL_SCAN_MAX_PAGES}×${SIGNAL_SCAN_LIMIT})仍未扫尽窗口——更旧匹配信号可能仍被截断（记档：CPV 前缀列+GIN 根治）`);
    }
    base.signalsMatched = matched.length;
    if (!matched.length) return base;

    // 按买方身份归并（同买方多招标 → 取最新发布日代表其最新需求）。rows 已按 occurredAt desc → 首见即最新。
    const byKey = new Map<string, BuyerDemand>();
    const overflow = new Set<string>(); // 触顶后被排除的主体（可观测，不静默丢；复审 MEDIUM）
    for (const s of matched) {
      if (byKey.has(s.subjectKey) || overflow.has(s.subjectKey)) continue;
      if (byKey.size >= maxCompanies) { overflow.add(s.subjectKey); continue; }
      const payload = (s.payload ?? {}) as Record<string, unknown>;
      byKey.set(s.subjectKey, {
        name: s.subjectName,
        country: s.subjectCountry,
        publicationDateIso: s.occurredAt.toISOString(),
        cpvCodes: Array.isArray(payload.cpv) ? (payload.cpv as string[]) : [],
        publicationNumber: typeof payload.notice === 'string' ? payload.notice : s.externalId,
      });
    }
    base.subjectsTruncated = overflow.size;
    if (overflow.size) {
      console.warn(`[ted-intent] maxCompanies=${maxCompanies} 触顶，${overflow.size} 个主体本轮未投影（游标化根治随缺口#8）`);
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
        at: demand.publicationDateIso, // §8.6：source_signal.occurredAt 保证合法时间
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
}

/**
 * CPV 子树重叠（去尾零前缀，双向）：ICP 码 '42120000' ↔ 信号键 'cpv:42122130' 视为同子树。
 * 双向前缀（而非仅 ICP→信号）——信号可能带比 ICP 更粗的码，拉取端既按该码检索到，投影端不应反而丢弃。
 */
export function cpvOverlap(icpCode: string, signalKey: string): boolean {
  if (!signalKey.startsWith('cpv:')) return false;
  const sig = signalKey.slice(4).replace(/0+$/, '');
  const icp = icpCode.trim().replace(/0+$/, '');
  if (!sig || !icp) return false;
  return sig.startsWith(icp) || icp.startsWith(sig);
}
