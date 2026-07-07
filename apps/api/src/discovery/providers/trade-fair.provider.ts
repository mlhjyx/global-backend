import { createHash } from 'node:crypto';
import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import { queryAlgoliaExhibitors } from '../../adapters/trade-fair-algolia';
import { selectFairs, TradeFairTemplate } from '../trade-fairs';
import { normalizeDomain } from '../identity';

const PARSER_VERSION = 'trade_fair/v1';
const PER_FAIR_LIMIT = 400; // 单展会拉取上限（护栏；尊重 Algolia 限流）

/**
 * 展会参展商发现 Provider（PRD 7.4.11；逐站/逐平台模板）。按 ICP 行业词选相关展会
 * （trade-fairs.ts 注册表），直接打其托管搜索 API（RX/Algolia）拿参展商结构化名录：
 * 公司名 + 官网 + **公开邮箱/电话**（展会公示的商务联系点）+ 国家 + 展位 + 产品 + 招聘信号。
 * 大展会 SPA 的 JS 渲染短板由此绕开。属 industry_data 类；source_hint=trade_fair 二级路由。
 */
export class TradeFairDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'trade_fair';
  readonly classes: SourceClass[] = ['industry_data'];

  private log(msg: string): void {
     
    console.log(`[trade_fair] ${msg}`);
  }

  async discoverCompanies(query: CompanyDiscoveryQuery, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const f = query.filters ?? {};
    const industryTerms = [f.industry, f.sub_industry].flat().filter(Boolean).map(String);
    const fairs = selectFairs({ industryTerms, keywords: query.keywords, region: String(f.region ?? '') });
    if (!fairs.length) return { records: [], costCents: 0 };

    const blocked = new Set((opts?.blockedDomains ?? []).map((d) => d.toLowerCase()));
    const dedup = new Map<string, ProviderCompanyRecord>();
    const perFair = Math.min(PER_FAIR_LIMIT, Math.max(query.limit, 50));

    for (const fair of fairs) {
      let records: ProviderCompanyRecord[];
      try {
        records = await this.pullFair(fair, perFair, query.sourceClass);
      } catch (err) {
        this.log(`skip ${fair.slug}: ${String(err).slice(0, 100)}`);
        continue; // 单展会失败不影响其余（如 key 换届失效）
      }
      for (const rec of records) {
        if (rec.domain && blocked.has(rec.domain)) continue;
        const key = rec.domain ?? rec.externalId;
        if (!dedup.has(key)) dedup.set(key, rec);
      }
      this.log(`✓ ${fair.slug}: ${records.length} exhibitors`);
    }
    return { records: [...dedup.values()], costCents: 0 };
  }

  private async pullFair(
    fair: TradeFairTemplate,
    limit: number,
    sourceClass: SourceClass,
  ): Promise<ProviderCompanyRecord[]> {
    const exhibitors = await queryAlgoliaExhibitors(fair.algolia, limit);
    const now = new Date().toISOString();
    return exhibitors.map((e) => ({
      externalId: `${fair.slug}:${e.externalId}`,
      name: e.companyName,
      domain: e.website ? normalizeDomain(e.website) ?? undefined : undefined,
      country: e.country,
      attributes: {
        // 展会公示的公开商务联系点（非个人数据）——直接进 attributes，供后续按需晋级
        public_email: e.email ?? null,
        public_phone: e.phone ?? null,
        stand: e.stand ?? null,
        products: e.products,
        description: e.description ?? null,
        hiring_signal: e.hiring ?? false,
        source_fair: fair.slug,
        source_fair_name: fair.name,
        source_class: sourceClass,
      },
      provenance: {
        sourceUrl: fair.exhibitorUrl,
        fetchedAt: now,
        contentHash: createHash('sha256').update(`${fair.slug}:${e.externalId}`).digest('hex'),
        parserVersion: PARSER_VERSION,
      },
    }));
  }
}
