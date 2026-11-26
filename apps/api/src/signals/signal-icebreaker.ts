import type { LeadPackageSignalItem } from './enrichment-signal-projection';

/**
 * 信号驱动的外联破冰首句生成器（Phase 3 Track 3B）。
 *
 * 严格约束：
 * - 零捏造：只基于真实观测到的 `company_signal` / `intent.events` 信号生成，无信号返回空数组 `[]`；
 * - 零 PII：彻底剥离邮箱、电话与个人领英 `/in/` 链接，绝不猜测或提及自然人姓名；
 * - 安全链接：仅保留 `https://` URL，其余（`http:`/`javascript:`/`data:` 等）置为 `null`。
 */

export interface SignalIcebreakerSuggestion {
  readonly signalType: string;
  readonly signalTitle: string;
  readonly signalUrl: string | null;
  readonly detectedAt: string;
  readonly openerZh: string;
  readonly openerEn: string;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,18}\d)/gu;
const PERSONAL_LINKEDIN_RE = /https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[^\s,;)"]+/giu;

function safeHttpsUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    if ((host === 'linkedin.com' || host.endsWith('.linkedin.com')) && /^\/in\//iu.test(parsed.pathname)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function scrubPiiText(raw: string, maxLen = 140): string {
  return raw
    .replace(PERSONAL_LINKEDIN_RE, '')
    .replace(EMAIL_RE, '')
    .replace(PHONE_RE, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLen);
}

function defaultTitleForSignal(signalType: string): string {
  switch (signalType) {
    case 'TENDER_AWARDED':
      return '公开招投标项目中标动态';
    case 'TENDER_PUBLISHED':
      return '公开采购招标动态';
    case 'HIRING_BUYING_ROLE':
      return '采购与供应链岗位招聘中';
    case 'HIRING_UP':
      return '公司近期团队扩招动态';
    case 'AD_CAMPAIGN_ACTIVE':
      return '线上商业推广持续投放中';
    case 'NEWS_MENTION':
      return '行业媒体与新闻动态';
    case 'SOURCING_OPENED':
      return '公开寻源与供应商招募信息';
    case 'PAGE_CHANGE':
    case 'WEBSITE_CHANGE':
      return '官网页面与业务内容更新';
    default:
      return '近期公开业务动态';
  }
}

function normalizeSignalType(signal: LeadPackageSignalItem): string {
  const raw = (signal.type ?? '').trim().toUpperCase();
  if (raw) return raw;
  if (signal.provider === 'changedetection') return 'PAGE_CHANGE';
  if (signal.provider === 'rsshub' || signal.provider === 'rss') return 'NEWS_MENTION';
  if (signal.provider === 'ted') return 'TENDER_AWARDED';
  return 'WEBSITE_CHANGE';
}

function buildOpeners(
  signalType: string,
  companyName: string,
  cleanTitle: string,
): { openerZh: string; openerEn: string } {
  const refZh = cleanTitle ? `（${cleanTitle}）` : '';
  const refEn = cleanTitle && /^[\x20-\x7E]+$/u.test(cleanTitle) ? ` ("${cleanTitle}")` : '';

  switch (signalType) {
    case 'TENDER_AWARDED':
      return {
        openerZh: `祝贺 ${companyName} 近期在公开项目中中标${refZh}。项目进入交付备料阶段通常对核心设备供货周期要求紧，希望能分享我们的现货规格与交期供贵司评估。`,
        openerEn: `Congratulations to the ${companyName} team on your recent public project award${refEn}. As you move into project procurement and delivery planning, we would be glad to share our core equipment specs and lead times for reference.`,
      };
    case 'TENDER_PUBLISHED':
    case 'SOURCING_OPENED':
      return {
        openerZh: `注意到 ${companyName} 近期发布了公开采购/寻源动态${refZh}。我们长期向同类海外客户提供直供产品与技术资料，想确认是否可将产品目录发给贵司采购团队参考。`,
        openerEn: `We noticed ${companyName}'s recent public sourcing update${refEn}. We supply similar buyers with direct technical specs and reliable lead times, and would be happy to share our catalog with your procurement team.`,
      };
    case 'HIRING_BUYING_ROLE':
      return {
        openerZh: `看到 ${companyName} 官网近期在招聘采购与供应链岗位${refZh}，说明贵司业务与备货需求正在扩张。方便的话，希望能把我们的主打规格和报价区间发给贵司采购团队备用。`,
        openerEn: `Noticed ${companyName} is currently hiring for procurement and supply chain roles${refEn}, which usually signals expanding sourcing needs. We would be glad to send over our core product specs and indicative pricing for your sourcing team.`,
      };
    case 'HIRING_UP':
      return {
        openerZh: `看到 ${companyName} 近期在官网开放多个新岗位${refZh}，业务增长势头很稳。若贵司近期在评估新增备选供应商，我们很乐意提供针对贵司品类的规格资料与交期说明。`,
        openerEn: `Noticed ${companyName} has open positions listed on your site${refEn}, pointing to steady team growth. If you are reviewing backup suppliers for upcoming orders, we can share concise product specs and lead times.`,
      };
    case 'AD_CAMPAIGN_ACTIVE':
      return {
        openerZh: `关注到 ${companyName} 近期在线上持续开展产品推广${refZh}，可见该品类市场需求活跃。如贵司需要稳定的货源补充或更具优势的成本方案，欢迎了解我们的供货清单。`,
        openerEn: `We noticed ${companyName} is actively promoting products online${refEn}, suggesting strong market demand. If your team is looking to strengthen supply capacity or benchmark landed costs, we would be happy to share our lineup.`,
      };
    case 'NEWS_MENTION':
      return {
        openerZh: `最近在公开资讯中看到 ${companyName} 的最新动态${refZh}。结合贵司当前的业务拓展方向，想与贵司团队分享我们在该品类的供货能力与常规交期，供后续选型参考。`,
        openerEn: `We saw the recent news update regarding ${companyName}${refEn}. Given your team's current expansion, we would welcome the chance to share our product availability and standard lead times for future sourcing needs.`,
      };
    case 'PAGE_CHANGE':
    case 'WEBSITE_CHANGE':
    default:
      return {
        openerZh: `近期关注到 ${companyName} 官网页面有新的业务更新${refZh}。如贵司正在扩充相关产品线或寻找稳定供货伙伴，希望能向贵司团队发送一份简明产品资料供参考。`,
        openerEn: `We noticed recent updates on ${companyName}'s website${refEn}. If your team is expanding product lines or evaluating reliable supply partners, we would be glad to share a brief product overview for reference.`,
      };
  }
}

export function buildSignalIcebreakers(input: {
  readonly companyName: string;
  readonly signals: readonly LeadPackageSignalItem[];
  readonly maxSuggestions?: number;
}): readonly SignalIcebreakerSuggestion[] {
  const max = Math.max(0, Math.min(5, input.maxSuggestions ?? 3));
  if (max === 0 || !input.signals || input.signals.length === 0) return [];

  const companyName = scrubPiiText(input.companyName || '贵司', 120) || '贵司';
  const sorted = [...input.signals].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const seen = new Set<string>();
  const out: SignalIcebreakerSuggestion[] = [];

  for (const signal of sorted) {
    if (!signal.at || Number.isNaN(Date.parse(signal.at))) continue;
    const signalType = normalizeSignalType(signal);
    const signalUrl = safeHttpsUrl(signal.url);
    const rawTitle = scrubPiiText(signal.title ?? '', 120);
    const signalTitle = rawTitle || defaultTitleForSignal(signalType);

    const dedupeKey = `${signalType}\n${signalUrl ?? ''}\n${signalTitle.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const { openerZh, openerEn } = buildOpeners(signalType, companyName, signalTitle);
    out.push(
      Object.freeze({
        signalType,
        signalTitle,
        signalUrl,
        detectedAt: signal.at,
        openerZh,
        openerEn,
      }),
    );
    if (out.length >= max) break;
  }

  return Object.freeze(out);
}
