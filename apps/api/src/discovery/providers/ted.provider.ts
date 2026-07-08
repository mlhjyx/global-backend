import { createHash } from 'node:crypto';
import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import { searchAwardNotices, TedAwardNotice } from '../../adapters/ted-api';
import { companyIdentity, normalizeDomain } from '../identity';

const PARSER_VERSION = 'ted/v1';
const NOTICE_DETAIL_BASE = 'https://ted.europa.eu/en/notice/-/detail/';
// CC BY 4.0 / 2011/833/EU：绿事实可商用但**署名是 license 义务，不可省**（spec §3.1）。
const TED_ATTRIBUTION = 'Source: TED — © European Union; reused under CC BY 4.0';
const NOTICE_CAP = 250; // 有界样本上限（绝不 grind 全量；全量是 Schedule 增量蚕食的活）
const DEFAULT_SINCE_DAYS = 30;

/**
 * TED 中标发现 Provider（归 public_intelligence 类，复用 discovery→fit→enrich→score 全管线）。
 * 中标公告 → 每个具名中标供应商一条 canonical 线索。以 winner-name + winner-identifier（税号）
 * 为主解析键；有 winner-internet-address 才做域名 key，否则退 name+country（识别未见 → 不臆造）。
 *
 * 合规：只落 🟢 公司/组织/CPV/日期绿事实（带 CC BY 4.0 provenance + 署名）；
 * winner-email 等 🔴 具名联系点**不进本记录**（个人数据隔离，走后续 contact-persist 路径）。
 *
 * CPV 过滤缺失时直接返回空（fail-safe）——ICP→CPV 映射（P2）落地前，CPV 由 filters 显式带入。
 */
export class TedDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'ted';
  readonly classes: SourceClass[] = ['public_intelligence'];

  async discoverCompanies(query: CompanyDiscoveryQuery, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const filters = query.filters ?? {};
    const cpvCodes = readCpvCodes(filters);
    if (!cpvCodes.length) return { records: [], costCents: 0 }; // 无 CPV → 不启动（绝不裸拉全库）

    let notices: TedAwardNotice[];
    try {
      notices = await searchAwardNotices({
        cpvCodes,
        buyerCountries: readBuyerCountries(filters),
        sinceDays: readSinceDays(filters),
        maxRecords: Math.min(Math.max(query.limit ?? 25, 50), NOTICE_CAP),
      });
    } catch (err) {
      // fail-safe：单源失败不阻断其余源（CLAUDE.md §5）
      // eslint-disable-next-line no-console
      console.warn(`[ted] discover failed: ${String(err).slice(0, 150)}`);
      return { records: [], costCents: 0 };
    }

    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const now = new Date().toISOString();
    const dedup = new Map<string, ProviderCompanyRecord>();
    for (const notice of notices) {
      for (const rec of mapNoticeToRecords(notice, now)) {
        if (rec.domain && blocked.has(rec.domain)) continue;
        const key = companyIdentity({ name: rec.name, domain: rec.domain, country: rec.country }).dedupeKey;
        if (!dedup.has(key)) dedup.set(key, rec); // 先到优先（SORT DESC → 最新在前）
      }
    }
    return { records: [...dedup.values()], costCents: 0 };
  }
}

/**
 * 一条中标公告 → 每个中标方一条 ProviderCompanyRecord（🟢 公司/组织事实）。
 * 绝不写入 winner-email 等 🔴 具名联系点（个人数据隔离）。
 */
export function mapNoticeToRecords(notice: TedAwardNotice, now: string): ProviderCompanyRecord[] {
  return notice.winners
    .filter((w) => w.name.trim())
    .map((w, i) => {
      const domain = w.internetAddress ? normalizeDomain(w.internetAddress) ?? undefined : undefined;
      const ted = prune({
        publication_number: notice.publicationNumber,
        publication_date: notice.publicationDate,
        notice_type: notice.noticeType,
        cpv: notice.cpvCodes.length ? notice.cpvCodes : undefined,
        buyer_names: notice.buyerNames.length ? notice.buyerNames : undefined,
        buyer_countries: notice.buyerCountries.length ? notice.buyerCountries : undefined,
        winner_identifier: w.identifier,
        winner_city: w.city,
        license: 'CC-BY-4.0',
        attribution: TED_ATTRIBUTION,
      });
      return {
        externalId: `ted:${notice.publicationNumber ?? 'na'}:${i}`,
        name: w.name.trim(),
        domain,
        country: w.country,
        attributes: { ted },
        provenance: {
          sourceUrl: notice.publicationNumber ? `${NOTICE_DETAIL_BASE}${notice.publicationNumber}` : NOTICE_DETAIL_BASE,
          fetchedAt: now,
          contentHash: createHash('sha256')
            .update(`ted:${notice.publicationNumber ?? ''}:${w.name}:${w.identifier ?? ''}`)
            .digest('hex'),
          parserVersion: PARSER_VERSION,
        },
      };
    });
}

function readCpvCodes(filters: Record<string, unknown>): string[] {
  return csvList(filters.cpv ?? filters._cpvCodes ?? filters.classification_cpv);
}

function readBuyerCountries(filters: Record<string, unknown>): string[] {
  return csvList(filters.buyer_country ?? filters.buyer_countries ?? filters._buyerCountries).map((c) =>
    c.toUpperCase(),
  );
}

function readSinceDays(filters: Record<string, unknown>): number {
  const v = Number(filters.since_days ?? filters.sinceDays);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SINCE_DAYS;
}

/** 逗号串或数组 → 去空 trim 后的字符串数组。 */
function csvList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => String(x).trim()).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, val]) => val != null));
}
