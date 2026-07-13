import type { TedContractNotice } from '../adapters/ted-api';
import { OPENFDA_LICENSE, type Fda510kClearance } from '../adapters/openfda-api';
import type { SamSourcesSought } from '../adapters/sam-api';
import { companyIdentity } from '../discovery/identity';
import { toAlpha2 } from '../discovery/providers/ted.provider';

/**
 * 外部源记录 → 一等 Signal 行（source_signal）的纯映射层（收口⑤）。
 * 🔴 GDPR 红线：source_signal 是**平台级无 RLS 绿库**——payload 由白名单显式构造（TED_PAYLOAD_KEYS /
 * FDA_PAYLOAD_KEYS），上游扩字段（buyer-email / contact / us_agent）在此结构性拦截；§6 个体户自然人
 * 申请人在**摄取层**即拒（不落任何平台行），投影层再留防御纵深。
 * 缺幂等锚（externalId）/ 缺身份键（国别）/ 缺时机（日期）/ 缺匹配键（分类码）的记录各自跳过并计数。
 */

// intent 事件类型 + 基准强度的单一真值（intent 两投影 service 从此 re-export，方向 signals ← intent 防循环依赖）。
export const TENDER_PUBLISHED = 'TENDER_PUBLISHED';
export const TENDER_STRENGTH = 0.9; // 开放招标 = 很强的实时需求信号（仅次于 web_watch SOURCING_OPENED=1）
export const FDA_CLEARANCE = 'FDA_CLEARANCE';
export const FDA_CLEARANCE_STRENGTH = 0.85; // 清关 = 新品/上市时机（略弱于开放招标）
export const US_FED_SOURCES_SOUGHT = 'US_FED_SOURCES_SOUGHT';
export const SOURCES_SOUGHT_STRENGTH = 0.7; // Sources Sought = 招标前市场调研（最早但最软，低于开放招标 0.9）

export const TED_PAYLOAD_KEYS = ['cpv', 'notice', 'source'] as const;
export const FDA_PAYLOAD_KEYS = ['product_code', 'k_number', 'device', 'source'] as const;
// 🔴 GDPR 白名单：SAM 只透传机构/公告绿字段——绝不含 PrimaryContact*/SecondaryContact*（联系官）/Awardee。
export const SAM_PAYLOAD_KEYS = ['naics', 'notice', 'notice_type', 'response_deadline', 'source'] as const;

const DAY_MS = 86_400_000;
const DEFAULT_TENDER_TTL_DAYS = 90; // 招标窗口关闭 → 需求信号过期
const DEFAULT_CLEARANCE_TTL_DAYS = 365; // 上市时机长尾
const DEFAULT_SOURCES_SOUGHT_TTL_DAYS = 120; // Sources Sought → 真 RFP 常隔数月，意图窗比招标(90)更长

function envDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** TENDER_PUBLISHED 的 TTL（天）：env SIGNAL_TTL_TENDER_DAYS，默认 90。 */
export function tenderTtlDays(): number {
  return envDays('SIGNAL_TTL_TENDER_DAYS', DEFAULT_TENDER_TTL_DAYS);
}

/** FDA_CLEARANCE 的 TTL（天）：env SIGNAL_TTL_CLEARANCE_DAYS，默认 365。 */
export function clearanceTtlDays(): number {
  return envDays('SIGNAL_TTL_CLEARANCE_DAYS', DEFAULT_CLEARANCE_TTL_DAYS);
}

/** US_FED_SOURCES_SOUGHT 的 TTL（天）：env SIGNAL_TTL_SOURCES_SOUGHT_DAYS，默认 120。 */
export function sourcesSoughtTtlDays(): number {
  return envDays('SIGNAL_TTL_SOURCES_SOUGHT_DAYS', DEFAULT_SOURCES_SOUGHT_TTL_DAYS);
}

/** source_signal 行草稿（persist 层转 Prisma create 输入）。 */
export interface SignalDraft {
  providerKey: 'ted' | 'openfda' | 'samgov';
  signalType: string;
  externalId: string;
  subjectName: string;
  subjectCountry: string; // alpha-2
  subjectKey: string; // 与租户 canonical 同规范化（companyIdentity.dedupeKey）
  taxonomyKeys: string[]; // 带 scheme 前缀（'cpv:42122000' / 'fda:LLZ'）
  strength: number;
  occurredAt: Date;
  observedAt: Date;
  payload: Record<string, unknown>;
  license: string;
  jurisdiction: string;
  expiresAt: Date;
}

export type MapOutcome = { row: SignalDraft; skip?: undefined } | { row?: undefined; skip: string };

/**
 * TED 招标公告 → Signal 行。ISO-3 国别归 alpha-2（§8.4）；发布日必为合法 ISO（§8.6）。
 * 买方自然人风险论证（对抗复审固化）：contract notice 的买方=公共采购主体（Directive 2014/24/EU
 * Art.2(1)(1)：国家/地方当局/受公法支配机构，法律构造上皆为法人；残余面仅 Art.13 受补贴私人工程的
 * 极端情形），故**不套** isLikelyIndividualApplicant——高精度人名判定会误伤真实公共买方
 *（如慕尼黑「Dr. von Haunersches Kinderspital」）。⚠️ 若未来摄取 TED **award**（中标方可为个体户
 * 自然人），绝不可复用本 mapper 路径——必须走 FDA 同款个体户拒收。
 */
export function mapTedNotice(n: TedContractNotice, observedAt: Date): MapOutcome {
  const name = n.buyerNames[0]?.trim();
  if (!name) return { skip: 'no_buyer' };
  const country = toAlpha2(n.buyerCountries[0]);
  if (!country) return { skip: 'no_country' };
  const occurredAt = n.publicationDateIso ? new Date(n.publicationDateIso) : undefined;
  if (!occurredAt || !Number.isFinite(occurredAt.getTime())) return { skip: 'no_date' };
  const externalId = n.publicationNumber?.trim();
  if (!externalId) return { skip: 'no_external_id' }; // 无稳定外部 id → 无幂等锚，绝不落库
  const cpv = n.cpvCodes.filter(Boolean);
  if (!cpv.length) return { skip: 'no_taxonomy' }; // 无分类码 → 投影永远匹配不到，属死重
  return {
    row: {
      providerKey: 'ted',
      signalType: TENDER_PUBLISHED,
      externalId,
      subjectName: name,
      subjectCountry: country,
      subjectKey: companyIdentity({ name, country }).dedupeKey,
      taxonomyKeys: cpv.map((c) => `cpv:${c}`),
      strength: TENDER_STRENGTH,
      occurredAt,
      observedAt,
      payload: { cpv, notice: externalId, source: 'ted' }, // 白名单 TED_PAYLOAD_KEYS——绝不透传上游其它字段
      license: 'CC BY 4.0', // 与 field_evidence 既有行一致（租户投影侧履行署名义务）
      jurisdiction: 'EU',
      expiresAt: new Date(occurredAt.getTime() + tenderTtlDays() * DAY_MS),
    },
  };
}

/** openFDA 510(k) 清关 → Signal 行。§6 个体户自然人在摄取层即拒（绿库红线）。 */
export function mapFdaClearance(c: Fda510kClearance, observedAt: Date): MapOutcome {
  if (isLikelyIndividualApplicant(c.applicant)) return { skip: 'individual' };
  const country = c.country?.trim();
  if (!country) return { skip: 'no_country' };
  const occurredAt = c.decisionDateIso ? new Date(c.decisionDateIso) : undefined;
  if (!occurredAt || !Number.isFinite(occurredAt.getTime())) return { skip: 'no_date' };
  const externalId = c.kNumber?.trim();
  if (!externalId) return { skip: 'no_external_id' };
  const productCode = c.productCode?.trim();
  if (!productCode) return { skip: 'no_taxonomy' };
  const name = c.applicant.trim();
  return {
    row: {
      providerKey: 'openfda',
      signalType: FDA_CLEARANCE,
      externalId,
      subjectName: name,
      subjectCountry: country,
      subjectKey: companyIdentity({ name, country }).dedupeKey,
      taxonomyKeys: [`fda:${productCode}`],
      strength: FDA_CLEARANCE_STRENGTH,
      occurredAt,
      observedAt,
      payload: { product_code: productCode, k_number: externalId, device: c.deviceName, source: 'openfda' },
      license: OPENFDA_LICENSE, // CC0：署名非义务，存 provenance
      jurisdiction: 'US',
      expiresAt: new Date(occurredAt.getTime() + clearanceTtlDays() * DAY_MS),
    },
  };
}

/**
 * SAM.gov Sources Sought → Signal 行。买方 = 联邦机构（法人组织，🟢）：**不套** isLikelyIndividualApplicant
 *（机构永远非个体户自然人，同 TED buyer 论证）。country 恒 'US'（美国联邦市场）。
 * payload **白名单**（SAM_PAYLOAD_KEYS）——🔴 上游 CSV 的联系官具名字段（PrimaryContact / SecondaryContact）已在
 * adapter 层结构性剔除，此处再守一道：绝不透传具名个人。许可 = 美国政府作品公共领域（17 U.S.C. §105，署名非义务）。
 * 缺幂等锚(noticeId)/缺买方名/缺时机(postedDate)/缺分类码(naics) 各自跳过并计数。
 */
export function mapSamSourcesSought(n: SamSourcesSought, observedAt: Date): MapOutcome {
  const name = samBuyerName(n);
  if (!name) return { skip: 'no_buyer' };
  const externalId = n.noticeId?.trim();
  if (!externalId) return { skip: 'no_external_id' }; // 无稳定外部 id → 无幂等锚
  const occurredAt = n.postedDateIso ? new Date(n.postedDateIso) : undefined;
  if (!occurredAt || !Number.isFinite(occurredAt.getTime())) return { skip: 'no_date' };
  const naics = n.naicsCode?.trim();
  if (!naics) return { skip: 'no_taxonomy' }; // 无分类码 → 投影永远匹配不到
  return {
    row: {
      providerKey: 'samgov',
      signalType: US_FED_SOURCES_SOUGHT,
      externalId,
      subjectName: name,
      subjectCountry: 'US', // 美国联邦市场恒定
      subjectKey: companyIdentity({ name, country: 'US' }).dedupeKey,
      taxonomyKeys: [`naics:${naics}`],
      strength: SOURCES_SOUGHT_STRENGTH,
      occurredAt,
      observedAt,
      // 白名单 SAM_PAYLOAD_KEYS——绝不透传联系官/中标方等上游字段。naics 存**数组**（与 TED payload.cpv
      // 同形 → 投影/复算证据同形 → sameIntent 幂等不动点成立）。
      payload: {
        naics: [naics],
        notice: externalId,
        notice_type: 'Sources Sought',
        response_deadline: n.responseDeadlineIso ?? undefined,
        source: 'samgov',
      },
      license: 'Public Domain (U.S. Government Work)', // 17 U.S.C. §105：署名非义务（同 openFDA CC0 档）
      jurisdiction: 'US',
      expiresAt: new Date(occurredAt.getTime() + sourcesSoughtTtlDays() * DAY_MS),
    },
  };
}

/** SAM 买方身份名：`Department — Sub-Tier`（Sub-Tier 缺则退 Department；都缺 → 空跳过）。 */
function samBuyerName(n: SamSourcesSought): string {
  const dept = n.department?.trim();
  const sub = n.subTier?.trim();
  if (dept && sub) return `${dept} — ${sub}`;
  return sub || dept || '';
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
 * 裸「John Smith」式**不**自动判个体（会误伤真公司）；风险有界——本源从不落 contact/邮箱等具名个人字段，
 * applicant 是公开 510(k) 备案的主体名、绝大多数为组织。空名视作不可入库。
 *（收口⑤上移自 openfda-intent-projection.service：摄取层需先于投影拒收，投影层 re-export 保留防御纵深。）
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
