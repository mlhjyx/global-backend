import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OPENFDA_ATTRIBUTION, OPENFDA_LICENSE, FDA_REGISTRATION_DISCLAIMER } from '../adapters/openfda-api';
import { FDA_CLEARANCE, FDA_CLEARANCE_STRENGTH, isLikelyIndividualApplicant } from '../signals/signal-mappers';
import { mergeIntent, sameIntent, IntentAttr, IntentEvent } from './intent-projection.service';

// 单一真值在 signals/signal-mappers（摄取层先用：§6 个体户在摄取层即拒）；re-export 保持既有 import 路径不破。
export { FDA_CLEARANCE, FDA_CLEARANCE_STRENGTH, isLikelyIndividualApplicant };

const DEFAULT_SINCE_DAYS = 365; // 清关比招标稀疏 → 更宽窗口
const DEFAULT_MAX_COMPANIES = 200; // 单 ICP 单轮投影的公司上限（有界，绝不 grind 全量）
const SIGNAL_SCAN_LIMIT = 2000;

export interface ProjectClearancesResult {
  signalsMatched: number;
  companiesTouched: number;
  eventsProjected: number;
  skippedIndividual: number; // §6 防御纵深：摄取层已拒，投影层再守一道
  /** maxCompanies 触顶后被排除的主体数（可观测，不静默；游标化根治随缺口#8 fast-follow）。 */
  subjectsTruncated: number;
}

export interface ProjectClearancesParams {
  productCodes: string[]; // ICP→FDA 产品码（必填，无码=本 ICP 无匹配面）
  applicantCountries?: string[]; // 申请人 country（alpha-2）过滤；空=不限国别（全美市场语义）
  sinceDays?: number;
  maxCompanies?: number;
}

interface Clearance {
  applicant: string;
  country: string; // alpha-2
  decisionDateIso: string; // 事件时间（source_signal.occurredAt 的 UTC ISO）
  productCode?: string;
  kNumber?: string;
  deviceName?: string;
}

/**
 * openFDA 510(k) 清关 intent 投影（收口⑤反转，镜像 TED）：**只读平台层 `source_signal`**
 *（FDA_CLEARANCE，SignalIngestService 已 ingest-once 落库），本 service 不再出网。
 * 按 ICP 的 FDA 产品码（'fda:CODE' 精确匹配——3 字母码无前缀层级）过滤 ACTIVE 信号，按申请人身份归并
 * 取最新决定日 → upsert canonical + FDA_CLEARANCE 事件（形状不变，评分零改动）。
 * 「清关≠核准」红线：attributes.fda.disclaimer 恒置。§6：个体户自然人摄取层已拒，此处防御纵深再判。
 * 合规：CC0 公共领域（署名非义务，存 provenance）；不摄入 contact/us_agent 具名个人。
 */
export class OpenFdaIntentProjectionService {
  constructor(private readonly deps: { prisma: PrismaService }) {}

  async projectClearances(workspaceId: string, params: ProjectClearancesParams): Promise<ProjectClearancesResult> {
    const base: ProjectClearancesResult = { signalsMatched: 0, companiesTouched: 0, eventsProjected: 0, skippedIndividual: 0, subjectsTruncated: 0 };
    if (!params.productCodes.length) return base;

    const since = new Date(Date.now() - (params.sinceDays ?? DEFAULT_SINCE_DAYS) * 86_400_000);
    // 码集大写归一；匹配时剥 'fda:' 前缀后按码比（绝不对整键 toUpperCase——前缀是小写，整键大写化会永不相等）。
    const wantedCodes = new Set(params.productCodes.map((c) => c.trim().toUpperCase()).filter(Boolean));
    const countries = params.applicantCountries?.length
      ? [...new Set(params.applicantCountries.map((c) => c.trim().toUpperCase()).filter(Boolean))]
      : undefined;
    const signals = await this.deps.prisma.sourceSignal.findMany({
      where: {
        providerKey: 'openfda',
        signalType: FDA_CLEARANCE,
        status: 'ACTIVE', // 状态机：过期/撤回信号不再投影
        occurredAt: { gte: since },
        ...(countries ? { subjectCountry: { in: countries } } : {}),
        // 码过滤下推 SQL（jsonb @> 任一码；复审：过滤放截断后会让无关码/他租户信号挤占扫描窗，
        // 匹配信号被静默截丢）。内存 filter 仍保留作防御纵深（大小写容错）。
        OR: [...wantedCodes].map((code) => ({ taxonomyKeys: { array_contains: [`fda:${code}`] } })),
      },
      orderBy: { occurredAt: 'desc' },
      take: SIGNAL_SCAN_LIMIT,
    });
    if (signals.length === SIGNAL_SCAN_LIMIT) {
      console.warn(`[openfda-intent] signal scan window saturated (limit=${SIGNAL_SCAN_LIMIT}) — 更旧的匹配信号可能被截断`);
    }

    const matched = signals.filter((s) => {
      const keys = Array.isArray(s.taxonomyKeys) ? (s.taxonomyKeys as string[]) : [];
      return keys.some((k) => k.startsWith('fda:') && wantedCodes.has(k.slice(4).toUpperCase()));
    });
    base.signalsMatched = matched.length;
    if (!matched.length) return base;

    // 按申请人身份归并（同申请人多次清关 → 取最新决定日）。rows 已按 occurredAt desc → 首见即最新。
    const byKey = new Map<string, Clearance>();
    const maxCompanies = params.maxCompanies ?? DEFAULT_MAX_COMPANIES;
    const overflow = new Set<string>(); // 触顶后被排除的主体（可观测，不静默丢；复审 MEDIUM）
    for (const s of matched) {
      if (byKey.has(s.subjectKey) || overflow.has(s.subjectKey)) continue;
      if (isLikelyIndividualApplicant(s.subjectName)) { base.skippedIndividual += 1; continue; } // 防御纵深
      if (byKey.size >= maxCompanies) { overflow.add(s.subjectKey); continue; }
      const payload = (s.payload ?? {}) as Record<string, unknown>;
      byKey.set(s.subjectKey, {
        applicant: s.subjectName,
        country: s.subjectCountry,
        decisionDateIso: s.occurredAt.toISOString(),
        productCode: typeof payload.product_code === 'string' ? payload.product_code : undefined,
        kNumber: typeof payload.k_number === 'string' ? payload.k_number : s.externalId,
        deviceName: typeof payload.device === 'string' ? payload.device : undefined,
      });
    }
    base.subjectsTruncated = overflow.size;
    if (overflow.size) {
      console.warn(`[openfda-intent] maxCompanies=${maxCompanies} 触顶，${overflow.size} 个主体本轮未投影（游标化根治随缺口#8）`);
    }

    for (const [dedupeKey, clearance] of byKey) {
      const touched = await this.projectOne(workspaceId, dedupeKey, clearance);
      if (touched) {
        base.companiesTouched += 1;
        base.eventsProjected += 1;
      }
    }
    return base;
  }

  /**
   * 单申请人：upsert canonical（有则更新、无则建为线索）+ append FDA_CLEARANCE intent。
   * SUPPRESSED 跳过。**幂等**：合并结果与既有实质相同（仅 _ts 变）→ 不写（返回 false，指标不虚报）。
   * 「注册/清关≠核准」红线：canonical.attributes.fda.disclaimer 恒置（绝不呈现为 FDA 认证/批准）。
   * 新建申请人额外写一条身份事实 field_evidence（CC0 provenance，仅建时一次）。
   */
  private async projectOne(workspaceId: string, dedupeKey: string, c: Clearance): Promise<boolean> {
    return this.deps.prisma.withWorkspace(workspaceId, async (tx) => {
      const prior = await tx.canonicalCompany.findUnique({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
        select: { id: true, attributes: true, status: true },
      });
      if (prior?.status === 'SUPPRESSED') return false;

      const priorAttrs = ((prior?.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const priorIntent = priorAttrs.intent as IntentAttr | undefined;
      const event: IntentEvent = {
        type: FDA_CLEARANCE,
        at: c.decisionDateIso, // §8.6：source_signal.occurredAt 保证合法时间
        strength: FDA_CLEARANCE_STRENGTH,
        evidence: { product_code: c.productCode, k_number: c.kNumber, device: c.deviceName, source: 'openfda' },
      };
      const intent = mergeIntent(priorIntent, [event]);
      // 幂等门：既有申请人且合并后 intent 实质未变（同一清关每 sweep 复现）→ 不 bump version、不堆 evidence 行。
      if (prior && priorIntent && sameIntent(priorIntent, intent)) return false;

      // 「清关≠核准」红线：恒置 disclaimer（保留 prior.fda 其它字段）。
      const priorFda = (priorAttrs.fda as Record<string, unknown> | undefined) ?? {};
      const fda = { ...priorFda, disclaimer: FDA_REGISTRATION_DISCLAIMER };

      const saved = await tx.canonicalCompany.upsert({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
        create: {
          workspaceId,
          name: c.applicant,
          country: c.country,
          dedupeKey,
          status: 'NEW',
          attributes: { fda_applicant: true, fda, intent } as unknown as Prisma.InputJsonValue, // 标记来源=510k 申请人
        },
        update: {
          attributes: { ...priorAttrs, fda_applicant: true, fda, intent } as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
        select: { id: true },
      });

      // 🟢 intent 清关事实证据（CC0：署名非义务但存 provenance；不落具名 contact）。
      // **只存本 provider 贡献的清关事件**，不存 mergeIntent 的跨源合并对象——否则既有 TED/web_watch 事件会被
      // 一并记进 providerKey='openfda'/CC0 证据行、在公司详情里误标成 openFDA/CC0 来源（Codex 复审）。
      await tx.fieldEvidence.create({
        data: {
          workspaceId,
          entityType: 'company',
          entityId: saved.id,
          field: 'intent.clearance',
          value: event as unknown as Prisma.InputJsonValue,
          providerKey: 'openfda',
          confidence: 1,
          license: OPENFDA_LICENSE,
          allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
        },
      });
      // 🟢 申请人身份事实 provenance（CC0）——仅新建时写一次（幂等，避免每 sweep 堆行）。
      if (!prior) {
        await tx.fieldEvidence.create({
          data: {
            workspaceId,
            entityType: 'company',
            entityId: saved.id,
            field: 'identity',
            value: { name: c.applicant, country: c.country, source: 'openfda', k_number: c.kNumber, attribution: OPENFDA_ATTRIBUTION, disclaimer: FDA_REGISTRATION_DISCLAIMER } as unknown as Prisma.InputJsonValue,
            providerKey: 'openfda',
            confidence: 1,
            license: OPENFDA_LICENSE,
            allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return true;
    });
  }
}
