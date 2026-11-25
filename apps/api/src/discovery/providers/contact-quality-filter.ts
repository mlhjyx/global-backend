import { GENERIC_CONTACT_TITLE } from '../provider-contract';

/**
 * 联系人质量守卫（跨公司串名、法律声明误抓、非采购噪音岗位、空职位无渠道噪音）：
 * 供 `social_presence` / `decision_maker` / 读模型与导出共享。
 */

const UNRELATED_BUSINESS_MODIFIERS = new Set([
  'fitness', 'gym', 'wellness', 'salon', 'spa', 'beauty', 'barbershop', 'cosmetics',
  'restaurant', 'bistro', 'cafe', 'coffee', 'bakery', 'pizzeria', 'hotel', 'motel', 'resort',
  'school', 'academy', 'university', 'college', 'church', 'ministry', 'charity',
  'photography', 'photo', 'studio', 'music', 'records', 'entertainment', 'gaming',
  'oilfield', 'drilling', 'trucking', 'freight', 'realty', 'dental', 'clinic', 'hospital',
  'veterinary', 'pharmacy', 'boutique', 'jewelry', 'fashion', 'apparel', 'motors', 'auto',
]);

const US_CORPORATE_SUFFIX_RE = /\b(?:corp\.?|corporation|llc|inc\.?)\b/iu;
const EU_NON_US_COUNTRIES = new Set([
  'IT', 'DE', 'AT', 'CH', 'FR', 'ES', 'NL', 'BE', 'PL', 'PT', 'SE', 'DK', 'FI', 'NO',
  'CZ', 'HU', 'RO', 'SK', 'SI', 'HR', 'GR', 'IE', 'LU', 'GB', 'UK',
]);

const LEGAL_DISCLAIMER_RE =
  /(?:§\s*\d+|rstv|mdstv|datenschutz(?:beauftragte[rn]?)?|verantwortlich\s+im\s+sinne|impressum|partita\s+iva|\bp\.?\s*iva\b|codice\s+fiscale|registro\s+imprese|privacy\s+policy|cookie\s+policy|terms\s+of\s+use|all\s+rights\s+reserved)/iu;

const NON_BUYER_JUNK_ROLE_RE =
  /(?:^|[\s/|,;()–—-])(?:hr[\s-]*manager(?:in)?|human\s+resources|recruiter|recruiting|talent\s+acquisition|personalreferent(?:in)?|personalleiter(?:in)?|personalwesen|praktikant(?:in)?|werkstudent(?:in)?|trainee|intern(?:ship)?|student(?:in)?|auszubildende[rn]?|azubi|buchhaltung|lohnbuchhaltung|payroll|accountant|controller|controlling|treasury|receptionist|empfang|sekretariat|monteur(?:in)?|lattoniere|operaio|magazziniere|autista|driver|cleaner|housekeeping|security\s+guard|personal\s+trainer|fitness\s+(?:coach|instructor|trainer))(?=$|[\s/|,;()–—-])/iu;

function foldTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ß/gu, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/**
 * 识别社媒标题里的「同名异企」串名：
 * 1) 紧跟在公司核心词后面出现完全无关的商业后缀词（例如 `K-Energy` 撞上 `K-Energy Fitness`）；
 * 2) 目标公司为欧洲企业且自身名称不含 `Corp/LLC/Inc`，但社媒标题紧跟 `Services Corp.` / `LLC` / `Inc.`
 *   （例如意大利 `FAST ENERGY` 撞上美国 `Fast Energy Services Corp.`）。
 */
export function isCrossCompanySocialMismatch(
  headlineRemainder: string,
  company: { name: string; domain?: string; country?: string },
): boolean {
  const companyTokens = foldTokens(company.name);
  const companySet = new Set(companyTokens);
  const headTokens = foldTokens(headlineRemainder);
  if (companyTokens.length === 0 || headTokens.length === 0) return false;

  // 1) 公司核心词（去掉常见法律形态）在标题中出现后，紧邻 1-2 个词内带无关商业行业词且公司本身不含该词
  const anchorTokens = companyTokens.filter(
    (token) => token.length >= 3 && !['srl', 'spa', 'gmbh', 'ag', 'ltd', 'sas', 'bv', 'nv', 'group', 'italia', 'italy'].includes(token),
  );
  if (anchorTokens.length > 0) {
    const lastAnchor = anchorTokens[anchorTokens.length - 1]!;
    for (let i = 0; i < headTokens.length; i += 1) {
      if (headTokens[i] !== lastAnchor) continue;
      const window = headTokens.slice(i + 1, i + 3);
      if (window.some((word) => UNRELATED_BUSINESS_MODIFIERS.has(word) && !companySet.has(word))) {
        return true;
      }
    }
  }

  // 2) 欧洲本地公司不含 US 法律后缀，但标题里明确挂载 Corp./LLC/Inc.
  const country = (company.country ?? '').trim().toUpperCase();
  const companyHasUsSuffix = US_CORPORATE_SUFFIX_RE.test(company.name);
  if (country && EU_NON_US_COUNTRIES.has(country) && !companyHasUsSuffix && US_CORPORATE_SUFFIX_RE.test(headlineRemainder)) {
    return true;
  }

  return false;
}

/**
 * 判断社媒或官网抽取到的联系人是否属于明确的非买家噪音：
 * - 法律免责声明/隐私条款文本被当成姓名或职位（`§55 RStV`、`Datenschutz`、`P.IVA` 等）；
 * - 明确的 HR / 实习生 / 财务出纳 / 一线施工工种 / 健身教练等非采购决策岗位；
 * - 既无职位又无任何可达联系点（邮箱/电话/LinkedIn 全空）的空白占位人（如 Centroplan 的 21 条空壳人）。
 */
export function isJunkContactCandidate(candidate: {
  fullName?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedin?: string | null;
  requireSignalOrTitle?: boolean;
}): boolean {
  const name = (candidate.fullName ?? '').trim();
  const title = (candidate.title ?? '').trim();

  if (name && LEGAL_DISCLAIMER_RE.test(name)) return true;
  if (title && LEGAL_DISCLAIMER_RE.test(title)) return true;
  if (title && NON_BUYER_JUNK_ROLE_RE.test(title)) return true;

  if (candidate.requireSignalOrTitle) {
    const hasChannel = Boolean(
      candidate.email?.trim() || candidate.phone?.trim() || candidate.linkedin?.trim(),
    );
    if (!title && !hasChannel) return true;
  }

  return false;
}

/** 是否为 `public_web` 生成的通用总机占位记录（非具名决策人）。 */
export function isGenericSwitchboardContact(contact: {
  fullName?: string | null;
  title?: string | null;
}): boolean {
  const title = (contact.title ?? '').trim().toLowerCase();
  if (title === GENERIC_CONTACT_TITLE) return true;
  const name = (contact.fullName ?? '').trim();
  if (name.startsWith('公开联系点')) return true;
  const lowerName = name.toLowerCase();
  return lowerName === 'company switchboard' || lowerName === 'switchboard';
}
