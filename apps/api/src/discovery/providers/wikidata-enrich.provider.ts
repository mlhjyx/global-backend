import { createHash } from 'node:crypto';
import {
  CompanyEnrichmentAdapter,
  CompanyEnrichmentInput,
  EnrichmentResult,
} from '../provider-contract';
import {
  wikidataSearchEntity,
  wikidataGetEntities,
  parseCompanyFacts,
  referencedQids,
  WikidataCompanyFacts,
} from '../../adapters/wikidata';
import { pickBestByName } from '../name-match';

const PARSER_VERSION = 'wikidata-enrich/v1';
const ACCEPT_THRESHOLD = 0.72; // 低于此不贴（宁缺毋滥）
const AMBIGUITY_MARGIN = 0.1; // 最佳须甩开次佳，否则歧义 → 不贴
const MAX_CANDIDATES = 7;

/**
 * Wikidata 商业事实富集 Provider（REST API：www.wikidata.org/w/api.php，CC0）。
 * 与 GLEIF 互补 —— GLEIF 给法律身份/母子关系，这里给：行业 / 产品 / 员工数 / 成立年 /
 * 母公司 / 子公司数 / 官网 / LEI / ISIN / 上市交易所 / 总部 / 国家。
 * 走 REST（wbsearchentities + wbgetentities），不依赖偶发不可达的 SPARQL 端点。
 *
 * 匹配纪律（复用 name-match）：搜候选 → 只留"是公司/组织"的 → 规范化名最佳匹配
 * + 置信门槛 + 歧义边距（从"Trumpf"的家族名/影院/公司里挑出真公司，绝不贴错）。
 */
export class WikidataEnrichmentProvider implements CompanyEnrichmentAdapter {
  readonly key = 'wikidata';

  async enrichCompany(input: CompanyEnrichmentInput): Promise<EnrichmentResult> {
    let candidates: { qid: string; label: string }[];
    try {
      candidates = await wikidataSearchEntity(input.name, MAX_CANDIDATES);
    } catch {
      return miss();
    }
    if (!candidates.length) return miss();

    // 取候选实体的 claims+labels，只保留"是公司/组织"的
    let entities: Awaited<ReturnType<typeof wikidataGetEntities>>;
    try {
      entities = await wikidataGetEntities(candidates.map((c) => c.qid));
    } catch {
      return miss();
    }
    const companyFacts = candidates
      .map((c) => (entities[c.qid] ? parseCompanyFacts(c.qid, entities[c.qid], {}) : null))
      .filter((f): f is WikidataCompanyFacts => !!f && f.isCompany);
    if (!companyFacts.length) return miss();

    // 最佳匹配 + 歧义护栏。Wikidata 搜索结果按知名度排序（强先验），pickBestByName 稳定
    // 排序在并列时取排名靠前者 → 精确命中(=1)可凭排名消歧、豁免 margin（如"Siemens"里德国
    // 集团 Q81230 排在捷克同名公司之前）；模糊命中(<1)仍需甩开次佳，防贴错。
    const best = pickBestByName(input.name, companyFacts, (f) => f.label);
    if (!best || best.score < ACCEPT_THRESHOLD) return miss();
    if (best.score < 0.999 && best.margin < AMBIGUITY_MARGIN) return miss();

    // 解析被引 QID（行业/产品/母公司/国家/总部/交易所）的英文标签，再完整解析事实
    const winnerEntity = entities[best.item.qid];
    let refLabels: Record<string, string> = {};
    try {
      const refs = referencedQids(winnerEntity);
      if (refs.length) {
        const labelEntities = await wikidataGetEntities([...new Set(refs)], 'labels');
        refLabels = Object.fromEntries(
          Object.entries(labelEntities).map(([qid, e]) => [qid, e.labels?.en?.value ?? qid]),
        );
      }
    } catch {
      // 标签解析失败：仍可返回带 QID 的事实（降级不致命）
    }
    const facts = parseCompanyFacts(best.item.qid, winnerEntity, refLabels);

    const attributes: Record<string, unknown> = {
      qid: facts.qid,
      label: facts.label,
      website: facts.website ? normalizeToDomain(facts.website) : undefined,
      industries: facts.industries.length ? facts.industries : undefined,
      products: facts.products.length ? facts.products : undefined,
      employees: facts.employees,
      inception_year: facts.inceptionYear,
      parent_name: facts.parentName,
      parent_qid: facts.parentQid,
      subsidiary_count: facts.subsidiaryCount,
      lei: facts.lei,
      isin: facts.isin,
      country: facts.countryName,
      headquarters: facts.headquartersName,
      stock_exchange: facts.stockExchangeName,
      match_confidence: Number(best.score.toFixed(2)),
    };

    return {
      matched: true,
      confidence: best.score,
      attributes: prune(attributes),
      provenance: {
        sourceUrl: `https://www.wikidata.org/wiki/${facts.qid}`,
        fetchedAt: new Date().toISOString(),
        contentHash: createHash('sha256').update(`${facts.qid}:${facts.label}`).digest('hex'),
        parserVersion: PARSER_VERSION,
      },
      costCents: 0,
    };
  }
}

function miss(): EnrichmentResult {
  return { matched: false, confidence: 0, attributes: {}, costCents: 0 };
}

function normalizeToDomain(website: string): string | undefined {
  try {
    const u = website.includes('://') ? new URL(website) : new URL(`https://${website}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function prune(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}
