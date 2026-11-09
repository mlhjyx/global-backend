/**
 * M1 渠道配置（配置即渠道）：api / crawl / import 三形态的解析与校验。
 * 校验失败抛 `ChannelConfigError`（HTTP 层映射 400 CHANNEL_CONFIG_INVALID），绝不带病运行。
 */

export interface CrawlListConfig {
  /** 列表页 URL；含 `{page}` 占位符或配合 pageParam 翻页。 */
  url: string;
  maxPages: number;
  itemSelector: string;
  itemUrlSelector?: string;
  pageParam?: string;
}

export interface CrawlDetailConfig {
  enabled: boolean;
  /** 字段 → 选择器（值可带 ::attr(x)/::text 后缀）。 */
  fields: Record<string, string>;
}

export interface ChannelCrawlConfig {
  mode: 'crawl';
  list: CrawlListConfig;
  detail: CrawlDetailConfig;
}

export type ChannelConfig =
  | ChannelCrawlConfig
  | { mode: 'api'; adapter: string }
  | { mode: 'import'; columns?: Record<string, string> };

/** 渠道记录允许抽取的字段（公司属性 + 联系人字段）。 */
export const CHANNEL_FIELD_KEYS = [
  'name',
  'website',
  'country',
  'industry',
  'products',
  'keywords',
  'contactName',
  'contactTitle',
  'email',
  'phone',
] as const;
export type ChannelFieldKey = (typeof CHANNEL_FIELD_KEYS)[number];

/** 联系人字段（PII）：只允许在详情页模式下抽取，防止列表页作用域把同一值复制给整页条目。 */
export const CHANNEL_CONTACT_FIELD_KEYS = ['contactName', 'contactTitle', 'email', 'phone'] as const;
export type ChannelContactFieldKey = (typeof CHANNEL_CONTACT_FIELD_KEYS)[number];

export const CHANNEL_MODES = ['api', 'crawl', 'import'] as const;
export const CHANNEL_CATEGORIES = ['trade_fair', 'customs', 'association', 'directory', 'tender', 'other'] as const;
export const CHANNEL_STATUSES = ['DISABLED', 'ENABLED', 'AUTO_DISABLED'] as const;
export const CHANNEL_ROBOTS_POLICIES = ['A', 'B', 'C'] as const;
/** CH-7 观察名单：新观测 PENDING，人工抽检置 APPROVED/REJECTED。 */
export const CHANNEL_RECORD_REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

/** 单次运行页数上限（试跑取 1 页）与每渠道每日页数上限（设计默认 500 页/天）。 */
export const CHANNEL_RUN_MAX_PAGES = 50;
export const CHANNEL_DAILY_PAGE_CAP = 500;

export class ChannelConfigError extends Error {
  readonly code = 'CHANNEL_CONFIG_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ChannelConfigError';
  }
}

function invalid(message: string): never {
  throw new ChannelConfigError(message);
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  const text = value.trim();
  if (text.length === 0 || text.length > maximum) invalid(`${field} must be 1–${maximum} chars`);
  return text;
}

/** 只允许 https、无凭据、无片段的抓取 URL。 */
function httpsUrl(value: unknown, field: string): string {
  const text = boundedString(value, field, 2048);
  let url: URL;
  try {
    url = new URL(text.replace('{page}', '1'));
  } catch {
    invalid(`${field} must be a valid URL`);
  }
  if (url.protocol !== 'https:') invalid(`${field} must use https`);
  if (url.username || url.password || url.hash) invalid(`${field} must not carry credentials or fragments`);
  return text;
}

function selector(value: unknown, field: string): string {
  return boundedString(value, field, 200);
}

export function parseChannelConfig(mode: string, raw: unknown): ChannelConfig {
  if (!(CHANNEL_MODES as readonly string[]).includes(mode)) invalid(`mode must be one of ${CHANNEL_MODES.join(', ')}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('config must be an object');
  const record = raw as Record<string, unknown>;

  if (mode === 'import') {
    const columns = record.columns;
    if (columns !== undefined && (typeof columns !== 'object' || columns === null || Array.isArray(columns))) {
      invalid('config.columns must be an object');
    }
    return { mode: 'import' };
  }
  if (mode === 'api') {
    return { mode: 'api', adapter: boundedString(record.adapter, 'config.adapter', 64) };
  }

  const list = record.list;
  if (!list || typeof list !== 'object' || Array.isArray(list)) invalid('config.list is required for crawl channels');
  const listRecord = list as Record<string, unknown>;
  const maxPages = listRecord.maxPages;
  if (typeof maxPages !== 'number' || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) {
    invalid('config.list.maxPages must be an integer in 1–50');
  }
  const url = httpsUrl(listRecord.url, 'config.list.url');
  if (!url.includes('{page}') && typeof listRecord.pageParam !== 'string') {
    invalid('config.list.url needs a {page} placeholder or a pageParam');
  }
  const parsedList: CrawlListConfig = {
    url,
    maxPages,
    itemSelector: selector(listRecord.itemSelector, 'config.list.itemSelector'),
    ...(listRecord.itemUrlSelector === undefined
      ? {}
      : { itemUrlSelector: selector(listRecord.itemUrlSelector, 'config.list.itemUrlSelector') }),
    ...(listRecord.pageParam === undefined
      ? {}
      : { pageParam: boundedString(listRecord.pageParam, 'config.list.pageParam', 32) }),
  };

  const detail = record.detail;
  let parsedDetail: CrawlDetailConfig = { enabled: false, fields: {} };
  if (detail !== undefined) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) invalid('config.detail must be an object');
    const detailRecord = detail as Record<string, unknown>;
    if (detailRecord.fields !== undefined) {
      if (!detailRecord.fields || typeof detailRecord.fields !== 'object' || Array.isArray(detailRecord.fields)) {
        invalid('config.detail.fields must be an object');
      }
      // 只把白名单字段写进显式属性（不用动态键赋值，避免原型污染类风险）。
      const parsedFields: {
        name?: string;
        website?: string;
        country?: string;
        industry?: string;
        products?: string;
        keywords?: string;
        contactName?: string;
        contactTitle?: string;
        email?: string;
        phone?: string;
      } = {};
      for (const [key, value] of Object.entries(detailRecord.fields as Record<string, unknown>)) {
        const selectorValue = selector(value, `config.detail.fields.${key}`);
        switch (key) {
          case 'name':
            parsedFields.name = selectorValue;
            break;
          case 'website':
            parsedFields.website = selectorValue;
            break;
          case 'country':
            parsedFields.country = selectorValue;
            break;
          case 'industry':
            parsedFields.industry = selectorValue;
            break;
          case 'products':
            parsedFields.products = selectorValue;
            break;
          case 'keywords':
            parsedFields.keywords = selectorValue;
            break;
          case 'contactName':
            parsedFields.contactName = selectorValue;
            break;
          case 'contactTitle':
            parsedFields.contactTitle = selectorValue;
            break;
          case 'email':
            parsedFields.email = selectorValue;
            break;
          case 'phone':
            parsedFields.phone = selectorValue;
            break;
          default:
            invalid(`config.detail.fields.${key} is not a channel field (${CHANNEL_FIELD_KEYS.join(', ')})`);
        }
      }
      const fields: Record<string, string> = { ...parsedFields };
      parsedDetail = { enabled: detailRecord.enabled === true, fields };
      // 联系人字段专项防线：只允许详情页模式（detail.enabled 且逐条详情 URL）。
      // 列表页回退时 detail.fields 选择器是对整张列表页匹配，同一值会被复制给整页条目。
      const usesContactField = CHANNEL_CONTACT_FIELD_KEYS.some((key) => key in fields);
      if (usesContactField && (!parsedDetail.enabled || !parsedList.itemUrlSelector)) {
        invalid(
          'contact fields (contactName/contactTitle/email/phone) require detail.enabled=true and list.itemUrlSelector (detail-page mode)',
        );
      }
    }
  }
  return { mode: 'crawl', list: parsedList, detail: parsedDetail };
}

/** 列表页 URL 序列（最多 maxPages；受每日页数配额截断）。 */
export function crawlPageUrls(config: ChannelCrawlConfig, pageCap: number): string[] {
  const pages = Math.max(0, Math.min(config.list.maxPages, pageCap));
  const urls: string[] = [];
  for (let page = 1; page <= pages; page += 1) {
    if (config.list.url.includes('{page}')) {
      urls.push(config.list.url.replace(/\{page\}/gu, String(page)));
    } else {
      const url = new URL(config.list.url);
      url.searchParams.set(config.list.pageParam!, String(page));
      urls.push(url.toString());
    }
  }
  return urls;
}
