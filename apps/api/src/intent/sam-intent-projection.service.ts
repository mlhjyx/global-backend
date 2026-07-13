import { Prisma } from '@prisma/client';
import type { SourceSignal } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { US_FED_SOURCES_SOUGHT, SOURCES_SOUGHT_STRENGTH } from '../signals/signal-mappers';
import { mergeIntent, sameIntent, IntentAttr, IntentEvent } from './intent-projection.service';

// 单一真值在 signals/signal-mappers；此处 re-export 保持既有 import 路径不破。
export { US_FED_SOURCES_SOUGHT, SOURCES_SOUGHT_STRENGTH };

const DEFAULT_SINCE_DAYS = 120;
const DEFAULT_MAX_COMPANIES = 100; // 单 ICP 单轮投影公司上限（有界）
const SIGNAL_SCAN_LIMIT = 2000;
const SIGNAL_SCAN_MAX_PAGES = 10;
/** 美国政府作品公共领域（17 U.S.C. §105）——署名非义务（同 openFDA CC0，异于 TED CC BY）。 */
export const SAM_LICENSE = 'Public Domain (U.S. Government Work)';
/** 市场信号免责声明（同 openFDA「注册≠核准」）——恒置于 canonical.attributes。 */
export const SAM_DISCLAIMER =
  'Sources Sought=市场调研阶段，非既有招标/合同；外企投美国联邦标有法定门槛（Buy American/TAA/SAM 注册）；本条为品类需求信号，非可直接成单线索';

export interface ProjectSourcesSoughtResult {
  signalsMatched: number;
  companiesTouched: number;
  eventsProjected: number;
  /** maxCompanies 触顶后被排除的主体数（可观测，不静默）。 */
  subjectsTruncated: number;
}

interface FederalDemand {
  name: string;
  publicationDateIso: string; // 事件时间（source_signal.occurredAt 的 UTC ISO）
  naicsCodes: string[];
  noticeId?: string;
}

/**
 * SAM.gov Sources Sought intent 投影（镜像 TED P3）：**只读平台层 `source_signal`**（US_FED_SOURCES_SOUGHT，
 * SignalIngestService 已 ingest-once 落库），本 service 不出网。按 ICP 的 NAICS 码（前缀双向子树）过滤 ACTIVE 信号
 * （**无国别过滤**——SAM 恒美国联邦市场），按机构买方归并取最新发布日 → upsert canonical（有则更新、无则建线索）
 * → append US_FED_SOURCES_SOUGHT 事件（动六维 Intent 维，形状不变评分零改动）。
 * 状态机：只投影 status='ACTIVE'（EXPIRED/REVOKED 剔除）。幂等：合并结果与既有实质相同 → 不 bump/不堆 evidence。
 * 合规：美国政府作品公共领域（署名非义务）；买方=联邦机构（法人组织，🟢）；联系官 🔴 已在摄取层剔除。
 * 定位：`government_buyer`+`sam_market_signal`+`disclaimer` 标记——纯品类需求情报，非可直接成单联邦线索。
 */
export class SamIntentProjectionService {
  constructor(private readonly deps: { prisma: PrismaService }) {}

  async projectSourcesSought(
    workspaceId: string,
    params: { naicsCodes: string[]; sinceDays?: number; maxCompanies?: number },
  ): Promise<ProjectSourcesSoughtResult> {
    const base: ProjectSourcesSoughtResult = { signalsMatched: 0, companiesTouched: 0, eventsProjected: 0, subjectsTruncated: 0 };
    if (!params.naicsCodes.length) return base; // 无码 → 本 ICP 无匹配面

    const since = new Date(Date.now() - (params.sinceDays ?? DEFAULT_SINCE_DAYS) * 86_400_000);
    const maxCompanies = params.maxCompanies ?? DEFAULT_MAX_COMPANIES;

    // NAICS 前缀子树无法下推 jsonb → **分页扫描**时间窗（无国别过滤：SAM 恒 US），每页先 NAICS 匹配再累积。
    // 稳定游标 (occurredAt desc, id desc)；页数硬顶防病态窗无界扫（触顶显性告警）。
    const matched: SourceSignal[] = [];
    const seenSubjects = new Set<string>();
    let cursorId: string | undefined;
    let windowExhausted = false;
    for (let page = 0; page < SIGNAL_SCAN_MAX_PAGES; page += 1) {
      const rows: SourceSignal[] = await this.deps.prisma.sourceSignal.findMany({
        where: {
          providerKey: 'samgov',
          signalType: US_FED_SOURCES_SOUGHT,
          status: 'ACTIVE', // 状态机：过期/撤回信号不再投影
          occurredAt: { gte: since },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: SIGNAL_SCAN_LIMIT,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
      if (!rows.length) {
        windowExhausted = true;
        break;
      }
      for (const s of rows) {
        const keys = Array.isArray(s.taxonomyKeys) ? (s.taxonomyKeys as string[]) : [];
        if (keys.some((k) => params.naicsCodes.some((icpCode) => naicsOverlap(icpCode, k)))) {
          matched.push(s);
          seenSubjects.add(s.subjectKey);
        }
      }
      cursorId = rows[rows.length - 1].id;
      if (seenSubjects.size >= maxCompanies) break;
      if (rows.length < SIGNAL_SCAN_LIMIT) {
        windowExhausted = true;
        break;
      }
    }
    if (!windowExhausted && seenSubjects.size < maxCompanies) {
      console.warn(`[sam-intent] NAICS 匹配分页达页上限(${SIGNAL_SCAN_MAX_PAGES}×${SIGNAL_SCAN_LIMIT})仍未扫尽——更旧匹配信号可能被截断（记档：NAICS 前缀列+GIN 根治）`);
    }
    base.signalsMatched = matched.length;
    if (!matched.length) return base;

    // 按机构买方归并（同机构多 Sources Sought → 取最新发布日）。rows 已按 occurredAt desc → 首见即最新。
    const byKey = new Map<string, FederalDemand>();
    const overflow = new Set<string>();
    for (const s of matched) {
      if (byKey.has(s.subjectKey) || overflow.has(s.subjectKey)) continue;
      if (byKey.size >= maxCompanies) {
        overflow.add(s.subjectKey);
        continue;
      }
      const payload = (s.payload ?? {}) as Record<string, unknown>;
      byKey.set(s.subjectKey, {
        name: s.subjectName,
        publicationDateIso: s.occurredAt.toISOString(),
        naicsCodes: Array.isArray(payload.naics) ? (payload.naics as string[]) : [],
        noticeId: typeof payload.notice === 'string' ? payload.notice : s.externalId,
      });
    }
    base.subjectsTruncated = overflow.size;
    if (overflow.size) {
      console.warn(`[sam-intent] maxCompanies=${maxCompanies} 触顶，${overflow.size} 个主体本轮未投影`);
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
   * 单机构买方：upsert canonical（有则更新、无则建为线索）+ append US_FED_SOURCES_SOUGHT intent。
   * SUPPRESSED 跳过。**幂等**：合并结果与既有实质相同 → 不写（返回 false，指标不虚报）。
   * 标记 government_buyer/sam_market_signal + disclaimer——定位为品类需求情报，非可直接成单线索。
   */
  private async projectOne(workspaceId: string, dedupeKey: string, demand: FederalDemand): Promise<boolean> {
    return this.deps.prisma.withWorkspace(workspaceId, async (tx) => {
      const prior = await tx.canonicalCompany.findUnique({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
        select: { id: true, attributes: true, status: true },
      });
      if (prior?.status === 'SUPPRESSED') return false;

      const priorAttrs = ((prior?.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const priorIntent = priorAttrs.intent as IntentAttr | undefined;
      const event: IntentEvent = {
        type: US_FED_SOURCES_SOUGHT,
        at: demand.publicationDateIso, // §8.6：source_signal.occurredAt 保证合法时间
        strength: SOURCES_SOUGHT_STRENGTH,
        evidence: { naics: demand.naicsCodes, notice: demand.noticeId, source: 'samgov' },
      };
      const intent = mergeIntent(priorIntent, [event]);
      // 幂等门：既有买方且合并后 intent 实质未变（同一 Sources Sought 每 sweep 复现）→ 不 bump、不堆 evidence。
      if (prior && priorIntent && sameIntent(priorIntent, intent)) return false;

      const marker = { government_buyer: true, sam_market_signal: true, sam_disclaimer: SAM_DISCLAIMER };
      const saved = await tx.canonicalCompany.upsert({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
        create: {
          workspaceId,
          name: demand.name,
          country: 'US', // 联邦机构恒美国
          dedupeKey,
          status: 'NEW',
          attributes: { ...marker, intent } as unknown as Prisma.InputJsonValue,
        },
        update: {
          attributes: { ...priorAttrs, ...marker, intent } as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
        select: { id: true },
      });

      // 🟢 intent 事实证据（美国政府作品公共领域，署名非义务；买方=机构，不落具名联系人）
      await tx.fieldEvidence.create({
        data: {
          workspaceId,
          entityType: 'company',
          entityId: saved.id,
          field: 'intent.sources_sought',
          value: intent as unknown as Prisma.InputJsonValue,
          providerKey: 'samgov',
          confidence: 1,
          license: SAM_LICENSE,
          allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
        },
      });
      // 🟢 机构买方身份事实——仅新建时写一次（幂等，避免每 sweep 堆行）。
      if (!prior) {
        await tx.fieldEvidence.create({
          data: {
            workspaceId,
            entityType: 'company',
            entityId: saved.id,
            field: 'identity',
            value: { name: demand.name, country: 'US', source: 'samgov', notice: demand.noticeId, disclaimer: SAM_DISCLAIMER } as unknown as Prisma.InputJsonValue,
            providerKey: 'samgov',
            confidence: 1,
            license: SAM_LICENSE,
            allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return true;
    });
  }
}

/**
 * NAICS 子树重叠（前缀双向，**无尾零**——NAICS 是变长 2–6 位前缀层级，异于 CPV 定长 8 位尾零占位）：
 * ICP 码 '3339' ↔ 信号键 'naics:333914' 视为同子树。双向前缀：信号可能带比 ICP 更粗/更细的码。
 */
export function naicsOverlap(icpCode: string, signalKey: string): boolean {
  if (!signalKey.startsWith('naics:')) return false;
  const sig = signalKey.slice(6).trim();
  const icp = icpCode.trim();
  if (!sig || !icp) return false;
  return sig.startsWith(icp) || icp.startsWith(sig);
}
