import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { companyIdentity } from '../discovery/identity';
import {
  search510kClearances,
  Fda510kClearance,
  OPENFDA_ATTRIBUTION,
  OPENFDA_LICENSE,
  FDA_REGISTRATION_DISCLAIMER,
} from '../adapters/openfda-api';
import { SourcePolicyReader } from '../tools/tool-broker.factory';
import { mergeIntent, sameIntent, IntentAttr, IntentEvent } from './intent-projection.service';

/** 510(k) 清关 intent 类型 + 强度：具名申请人清关 = 新品/上市时机（略弱于 TED 开放招标 0.9=正在采购）。 */
export const FDA_CLEARANCE = 'FDA_CLEARANCE';
export const FDA_CLEARANCE_STRENGTH = 0.85;
const DEFAULT_SINCE_DAYS = 365; // 清关比招标稀疏 → 更宽窗口
const DEFAULT_MAX_RECORDS = 200; // 有界样本（绝不 grind 17 万全量）
const FDA_API_DOMAIN = 'api.fda.gov'; // §8.8 source_policy 门锚点（与 openfda.provider 同）
// 510k intent 投影 = 对 openFDA discovery 端点同源、同绿字段的读取；openFDA source_policy 用途 seed=['discovery','enrichment']，
// 故接受 intent/discovery 任一（既有 seed 有 discovery 即放行，未来显式列 intent 亦放行）。
const ALLOWED_PURPOSES = ['intent', 'discovery'];

export interface ProjectClearancesResult {
  clearancesFetched: number;
  companiesTouched: number;
  eventsProjected: number;
  skippedNoCountry: number;
  skippedNoDate: number;
  skippedIndividual: number; // §6 边界：疑似个体户自然人申请人（不入绿库）
}

export interface ProjectClearancesParams {
  productCodes: string[]; // ICP→FDA 产品码（必填，绝不裸拉全库）
  applicantCountries?: string[]; // 申请人 country_code（alpha-2）过滤；空=不限国别
  sinceDays?: number;
  maxRecords?: number;
}

interface Clearance {
  applicant: string;
  country: string; // alpha-2（必有——无国别跳过，防跨国同名误并）
  decisionDateIso: string; // 必有（无合法决定日跳过，无可靠时机信号）
  productCode?: string;
  kNumber?: string;
  deviceName?: string;
}

/**
 * openFDA 510(k) 清关 → Intent 投影（spec §4.1/§5.3 P3，镜像 TED 招标 intent 投影）。方向：**具名申请人清关 =
 * 该公司刚把一款新器械合规带上美国市场 = 新品/上市时机信号**。按申请人身份解析 canonical（有则更新、无则建为线索），
 * append `attributes.intent.events[{type:'FDA_CLEARANCE', at:<决定日 ISO>, strength}]` → 动六维 Intent 维。
 *
 * §8.6：决定日经 `fdaDateToIso` 归一（search510kClearances 已做）；**无合法决定日的记录直接跳过**（绝不写 NaN
 *   触发 0 分，亦不用 now 兜底）。
 * §8.8：直连 api.fda.gov（personalData=true）前必过 source_policy 门（SUSPENDED / 策略缺失 / 用途不含 →
 *   fail-closed，不发请求）——与 P1 provider 同一 DAT-011 kill-switch。
 * §8.6 清关码：`search510kClearances(clearedOnly=true)` 只返正向清关（SE 家族/DENG），NSE/被拒/撤回绝不投。
 * §6 边界：疑似个体户自然人申请人跳过（不把自然人名当绿事实入库）。
 * 幂等：合并结果与既有 intent 实质相同 → 不 bump version / 不堆 field_evidence（同一清关每 sweep 复现时）。
 * 合规（**与 TED 关键差异**）：CC0 公共领域，**署名非义务**（license='CC0-1.0'）；「注册/清关≠核准」文案红线
 *   （attributes.fda.disclaimer）；不摄入 contact/us_agent 具名个人。fail-safe：无产品码/拉取失败 → 零结果不抛。
 */
export class OpenFdaIntentProjectionService {
  constructor(private readonly deps: { prisma: PrismaService; sourcePolicyReader?: SourcePolicyReader }) {}

  async projectClearances(workspaceId: string, params: ProjectClearancesParams): Promise<ProjectClearancesResult> {
    const base: ProjectClearancesResult = {
      clearancesFetched: 0, companiesTouched: 0, eventsProjected: 0, skippedNoCountry: 0, skippedNoDate: 0, skippedIndividual: 0,
    };
    if (!params.productCodes.length) return base; // 无产品码 → 不启动（绝不裸拉全库）
    if (!(await this.purposeAllowed())) return base; // §8.8 用途/SUSPENDED 门（fail-closed，不发请求）

    let clearances: Fda510kClearance[];
    try {
      clearances = await search510kClearances({
        productCodes: params.productCodes,
        countries: params.applicantCountries,
        sinceDays: params.sinceDays ?? DEFAULT_SINCE_DAYS,
        maxRecords: params.maxRecords ?? DEFAULT_MAX_RECORDS,
        clearedOnly: true, // §8.6：只要正向清关
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[openfda-intent] fetch failed: ${String(err).slice(0, 150)}`);
      return base;
    }
    base.clearancesFetched = clearances.length;

    // 按申请人身份归并（同申请人多次清关 → 取最新决定日代表其最新上市动作；dedupeKey 与其它源一致 name+alpha-2）。
    // 无国别 / 无合法决定日 / 疑似个体户 各自跳过并计数（可审计），绝不降级成不可靠身份或时间、绝不把自然人入绿库。
    const byKey = new Map<string, Clearance>();
    for (const c of clearances) {
      if (!c.country) { base.skippedNoCountry += 1; continue; } // §8.4：无国别 → name-only 键会跨国误并
      if (!c.decisionDateIso) { base.skippedNoDate += 1; continue; } // §8.6：无合法决定日 → 无可靠时机信号
      if (isLikelyIndividualApplicant(c.applicant)) { base.skippedIndividual += 1; continue; } // §6：个体户自然人不入绿库
      const demand: Clearance = {
        applicant: c.applicant, country: c.country, decisionDateIso: c.decisionDateIso,
        productCode: c.productCode, kNumber: c.kNumber, deviceName: c.deviceName,
      };
      const key = companyIdentity({ name: c.applicant, country: c.country }).dedupeKey;
      const prior = byKey.get(key);
      if (!prior || demand.decisionDateIso > prior.decisionDateIso) byKey.set(key, demand); // ISO 字典序 = 时间序
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
        at: c.decisionDateIso, // §8.6：必为合法 ISO（无合法决定日的记录在归并阶段已跳过）
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

  /**
   * §8.8 用途门（镜像 openfda.provider.purposeAllowed）：reader 在场时校验 source_policy(api.fda.gov)——
   * SUSPENDED / 策略缺失 / 用途不含 intent|discovery / reader 抛错 一律 fail-closed（不发请求）。
   * 无 reader（单测/直连探针）→ fail-open（生产由调用方注入 sourcePolicyReaderFrom(prisma)）。
   */
  private async purposeAllowed(): Promise<boolean> {
    const reader = this.deps.sourcePolicyReader;
    if (!reader) return true;
    let policy: { suspended: boolean; allowedPurpose?: string[] } | null;
    try {
      policy = await reader(FDA_API_DOMAIN);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[openfda-intent] source_policy 读取失败，fail-closed: ${String(err).slice(0, 120)}`);
      return false;
    }
    if (!policy || policy.suspended) {
      // eslint-disable-next-line no-console
      console.warn(`[openfda-intent] source_policy 未批准/缺失/SUSPENDED，跳过直连（${FDA_API_DOMAIN}）`);
      return false;
    }
    if (policy.allowedPurpose && !policy.allowedPurpose.some((p) => ALLOWED_PURPOSES.includes(p))) {
      // eslint-disable-next-line no-console
      console.warn('[openfda-intent] source_policy 用途不含 intent/discovery，跳过直连');
      return false;
    }
    return true;
  }
}

const PERSON_TITLE = /^(dr|mr|mrs|ms|prof|sir|dame)\.?\s+\S/i; // 人称头衔前缀
const SURNAME_COMMA_GIVEN = /^[A-Za-z][A-Za-z'’-]+,\s*[A-Za-z][A-Za-z'’-]+(\s+[A-Za-z]\.?)?$/; // "Surname, Given [M.]"
const ORG_MARKER = /\b(inc|llc|ltd|co|corp|corporation|company|gmbh|ag|sa|sas|bv|srl|plc|pty|kg|oy|oyj|ab|nv|spa|limited|llp|lp|kk)\b/i;

/**
 * §6 边界：疑似**个体户自然人**申请人（不入绿库）。**高精度**判定——只在明确的人名格式上触发，绝不用宽松的
 * 「几个大写词」形状去误伤真公司（"GE Precision Healthcare"/"Karl Storz Endoscopy" 都是 3 词却是公司；按形状
 * 误伤=丢真线索，直接损害核心功能）。触发条件：
 *  · 人称头衔前缀（Dr./Mr./Mrs./Ms./Prof./Sir/Dame）；或
 *  · "Surname, Given [M.]" 逗号姓名格式（两段纯字母、无组织标记）。
 * 裸「John Smith」式**不**自动判个体（会误伤真公司）；风险有界——本 provider 从不落 contact/邮箱等具名个人字段，
 * applicant 是公开 510(k) 备案的主体名、绝大多数为组织。空名视作不可入库。
 */
export function isLikelyIndividualApplicant(name: string): boolean {
  const s = name.trim();
  if (!s) return true; // 空名不入库
  // 组织标记**先判**：带法人后缀的一律保留，即便以头衔起头（"Dr. Mach GmbH & Co. KG" 是真公司；Codex 复审）。
  if (ORG_MARKER.test(s)) return false;
  if (PERSON_TITLE.test(s)) return true; // Dr./Mr./… 头衔（无组织标记）
  if (SURNAME_COMMA_GIVEN.test(s)) return true; // "Smith, John"（无组织标记）
  return false;
}
