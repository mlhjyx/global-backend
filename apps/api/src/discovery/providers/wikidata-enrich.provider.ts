import { createHash } from 'node:crypto';
import {
  CompanyEnrichmentAdapter,
  CompanyEnrichmentInput,
  EnrichmentResult,
  ExecutionContext,
} from '../provider-contract';
import { parseCompanyFacts, referencedQids, WikidataCompanyFacts } from '../../adapters/wikidata';
import type { RawEntity, WikidataEntitySummary } from '../../adapters/wikidata';
import type { WikidataEntityInput, WikidataEntityOutput } from '../../tools/source-tools';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import { pickBestByName } from '../name-match';
import { countryAlpha2 } from '../country-code';

export const WIKIDATA_ENRICH_PARSER_VERSION = 'wikidata-enrich/v3';
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

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async enrichCompany(input: CompanyEnrichmentInput, ctx: ExecutionContext): Promise<EnrichmentResult> {
    // 收口②：wikidata.entity 是 required 工具——出网只经 Broker（source_policy/预算/限流/Trace 单点强制）。
    // 无 broker → 诚实降级返回 miss（不直连；生产 registry 注入）。
    const broker = this.deps?.broker;
    if (!broker) {
       
      console.warn('[wikidata] broker unavailable, skip enrichment (no raw egress)');
      return miss();
    }
    // A strong Wikidata identity needs an independent jurisdiction or domain
    // anchor. Name-only enrichment remains a safe miss.
    if (!input.country && !input.domain) return miss();
    const toolCtx: ToolContext = { ...ctx };
    let candidates: WikidataEntitySummary[];
    try {
      candidates = await searchEntityViaBroker(broker, input.name, MAX_CANDIDATES, toolCtx);
    } catch {
      return miss();
    }
    if (!candidates.length) return miss();

    // 取候选实体的 claims+labels，只保留"是公司/组织"的
    let entities: Record<string, RawEntity>;
    try {
      entities = await getEntitiesViaBroker(broker, candidates.map((c) => c.qid), undefined, toolCtx,
      );
    } catch {
      return miss();
    }
    const unlabeledCompanyFacts = candidates
      .map((c) => (entities[c.qid] ? parseCompanyFacts(c.qid, entities[c.qid], {}) : null))
      .filter((f): f is WikidataCompanyFacts => !!f && f.isCompany);
    if (!unlabeledCompanyFacts.length) return miss();

    // Identity admission is country-aware. Resolve referenced labels for every
    // viable candidate before ranking so search popularity can never choose a
    // same-name organization from another jurisdiction.
    let refLabels: Record<string, string> = {};
    try {
      const refs = [
        ...new Set(
          unlabeledCompanyFacts.flatMap((facts) =>
            referencedQids(entities[facts.qid]),
          ),
        ),
      ];
      if (refs.length) {
        const labelEntities = await getEntitiesViaBroker(broker, refs, 'labels', toolCtx);
        refLabels = Object.fromEntries(
          Object.entries(labelEntities).map(([qid, entity]) => [qid, entity.labels?.en?.value ?? qid]),
        );
      }
    } catch {
      // Country is an identity gate. If the caller supplied one, unresolved
      // candidate countries must fail closed rather than degrade to name-only.
      if (input.country) return miss();
    }
    const expectedCountry = input.country ? countryAlpha2(input.country) : null;
    if (input.country && !expectedCountry) return miss();
    const companyFacts = unlabeledCompanyFacts
      .map((facts) => parseCompanyFacts(facts.qid, entities[facts.qid], refLabels))
      .filter((facts) => {
        if (!expectedCountry) return true;
        return countryAlpha2(facts.countryName) === expectedCountry;
      })
      .filter((facts) => {
        if (!input.domain) return true;
        return !!facts.website && normalizeToDomain(facts.website) === normalizeToDomain(input.domain);
      })
      .filter((facts) => identifiersAgree(input, facts));
    if (!companyFacts.length) return miss();

    // 最佳匹配 + 歧义护栏。Wikidata 搜索结果按知名度排序（强先验），pickBestByName 稳定
    // 搜索排名不能作为强身份依据。即使名称完全相同，多候选仍必须满足歧义边距。
    const best = pickBestByName(input.name, companyFacts, (f) => f.label);
    if (!best || best.score < ACCEPT_THRESHOLD) return miss();
    if (best.margin < AMBIGUITY_MARGIN) return miss();

    // 解析被引 QID（行业/产品/母公司/国家/总部/交易所）的英文标签，再完整解析事实
    const winnerEntity = entities[best.item.qid];
    const facts = parseCompanyFacts(best.item.qid, winnerEntity, refLabels);
    const domain = facts.website ? normalizeToDomain(facts.website) : undefined;

    const attributes: Record<string, unknown> = {
      qid: facts.qid,
      label: facts.label,
      website: domain,
      industries: facts.industries.length ? facts.industries : undefined,
      products: facts.products.length ? facts.products : undefined,
      employees: facts.employees,
      inception_year: facts.inceptionYear,
      parent_name: facts.parentName,
      parent_qid: facts.parentQid,
      subsidiary_count: facts.subsidiaryCount,
      lei: facts.lei,
      siren: facts.siren,
      isin: facts.isin,
      country: facts.countryName,
      headquarters: facts.headquartersName,
      stock_exchange: facts.stockExchangeName,
      match_confidence: Number(best.score.toFixed(2)),
      identity_evidence_version: WIKIDATA_ENRICH_PARSER_VERSION,
    };

    return {
      matched: true,
      confidence: best.score,
      attributes: prune(attributes),
      identifiers: [
        ...(domain ? [{ scheme: 'domain', jurisdiction: 'GLOBAL', value: domain }] : []),
        { scheme: 'wikidata-qid', jurisdiction: 'GLOBAL', value: facts.qid },
        ...(facts.lei ? [{ scheme: 'lei', jurisdiction: 'GLOBAL', value: facts.lei }] : []),
        ...(facts.siren ? [{ scheme: 'siren', jurisdiction: 'FR', value: facts.siren }] : []),
      ],
      provenance: {
        sourceUrl: `https://www.wikidata.org/wiki/${facts.qid}`,
        fetchedAt: new Date().toISOString(),
        contentHash: createHash('sha256')
          .update(JSON.stringify({ qid: facts.qid, entity: winnerEntity }))
          .digest('hex'),
        parserVersion: WIKIDATA_ENRICH_PARSER_VERSION,
      },
      costCents: 0,
    };
  }
}

function identifiersAgree(input: CompanyEnrichmentInput, facts: WikidataCompanyFacts): boolean {
  const existing = input.identifiers ?? [];
  const legalIdentifiers = existing.filter((identifier) =>
    !['domain', 'wikidata-qid'].includes(identifier.scheme.toLocaleLowerCase('en-US')),
  );
  for (const identifier of legalIdentifiers) {
    const scheme = identifier.scheme.toLocaleLowerCase('en-US');
    if (scheme === 'lei') {
      if (!facts.lei || compact(facts.lei) !== compact(identifier.value)) return false;
      continue;
    }
    if (scheme === 'siren') {
      if (!facts.siren || digits(facts.siren) !== digits(identifier.value)) return false;
      continue;
    }
    // Wikidata does not expose a trusted crosswalk for this registry scheme in
    // the current adapter. Never turn a name match into a legal identity link.
    return false;
  }
  const qids = existing
    .filter((identifier) => identifier.scheme.toLocaleLowerCase('en-US') === 'wikidata-qid')
    .map((identifier) => compact(identifier.value));
  return qids.length === 0 || qids.includes(compact(facts.qid));
}

function compact(value: string): string {
  return value.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '').toLocaleUpperCase('en-US');
}

function digits(value: string): string {
  return value.replace(/\D+/gu, '');
}

function miss(): EnrichmentResult {
  return { matched: false, confidence: 0, attributes: {}, costCents: 0 };
}

/** 实体搜索经 Broker（wikidata.entity op=search）；错误上抛由调用点 miss()。 */
async function searchEntityViaBroker(
  broker: ExecutionBroker,
  name: string,
  limit: number,
  ctx: ToolContext,
): Promise<WikidataEntitySummary[]> {
  const res = await broker.invoke<WikidataEntityInput, WikidataEntityOutput>(
    'wikidata.entity',
    { op: 'search', name, limit },
    ctx,
  );
  return res.data.search ?? [];
}

/** 实体取回经 Broker（wikidata.entity op=get）；错误上抛由调用点处置（claims 致命 / labels 降级）。 */
async function getEntitiesViaBroker(
  broker: ExecutionBroker,
  qids: string[],
  props: string | undefined,
  ctx: ToolContext,
): Promise<Record<string, RawEntity>> {
  const res = await broker.invoke<WikidataEntityInput, WikidataEntityOutput>(
    'wikidata.entity',
    { op: 'get', qids, props },
    ctx,
  );
  return res.data.entities ?? {};
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
