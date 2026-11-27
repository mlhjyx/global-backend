import { PLATFORM_ALGOLIA_PAGES_PER_SOURCE_MAX } from '../platform-authority/platform-execution-contract';
import { requestDiscoverySourceJson, type DiscoverySourceDispatch } from './discovery-v3-source-http';
import { mapAlgoliaExhibitor, type AlgoliaFairConfig, type FairExhibitor } from './trade-fair-algolia';

export const ALGOLIA_PAGE_NATIVE_TIMEOUT_MS = 25_000;
export const ALGOLIA_NATIVE_MAX_PAGE_SIZE = 50;
export const ALGOLIA_NATIVE_MAX_PAGES = PLATFORM_ALGOLIA_PAGES_PER_SOURCE_MAX;

const COMPANY_ATTRIBUTES = [
  'objectID', 'id', 'companyName', 'exhibitorName', 'website', 'countryName', 'standReference', 'products.name',
] as const;
type CompanyAttribute = (typeof COMPANY_ATTRIBUTES)[number];
type CompanyHit = Pick<Parameters<typeof mapAlgoliaExhibitor>[0], Exclude<CompanyAttribute, 'products.name'> | 'products'>;

/** Each page from a registered fair needs its own native operation. */
export async function queryAlgoliaExhibitorPage(
  cfg: AlgoliaFairConfig,
  page: number,
  limit: number = ALGOLIA_NATIVE_MAX_PAGE_SIZE,
  dispatch: DiscoverySourceDispatch,
): Promise<{ exhibitors: FairExhibitor[]; hasNextPage: boolean }> {
  if (!Number.isSafeInteger(page) || page < 0 || page >= PLATFORM_ALGOLIA_PAGES_PER_SOURCE_MAX ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > ALGOLIA_NATIVE_MAX_PAGE_SIZE ||
      !/^[a-z0-9]{5,16}$/iu.test(cfg.appId)) {
    throw new Error('ALGOLIA_NATIVE_PAGE_INVALID');
  }
  const locale = cfg.locale ?? 'en-gb';
  const endpoint = `https://${cfg.appId.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(cfg.indexName)}/query`;
  const params = new URLSearchParams({
    query: '',
    page: String(page),
    hitsPerPage: String(limit),
    filters: `recordType:exhibitor AND locale:${locale} AND eventEditionId:${cfg.eventEditionId}`,
    attributesToRetrieve: COMPANY_ATTRIBUTES.join(','),
    attributesToHighlight: '',
    attributesToSnippet: '',
  });
  const result = await requestDiscoverySourceJson<{ hits?: CompanyHit[]; nbPages?: number }>(endpoint, {
    source: 'ALGOLIA', method: 'POST', timeoutMs: ALGOLIA_PAGE_NATIVE_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Algolia-Application-Id': cfg.appId,
      'X-Algolia-API-Key': cfg.apiKey,
    },
    body: JSON.stringify({ params: params.toString() }),
  }, dispatch);
  const { hits, nbPages } = result;
  if (!Array.isArray(hits) || hits.length > limit || typeof nbPages !== 'number' ||
      !Number.isSafeInteger(nbPages) || nbPages < 0) throw new Error('ALGOLIA_NATIVE_RESPONSE_INVALID');
  const exhibitors = new Map<string, FairExhibitor>();
  for (const { objectID, id, companyName, exhibitorName, website, countryName, standReference, products } of hits) {
    const exhibitor = mapAlgoliaExhibitor({ objectID, id, companyName, exhibitorName, website, countryName, standReference, products });
    if (!exhibitor || exhibitors.has(exhibitor.externalId)) continue;
    exhibitors.set(exhibitor.externalId, {
      externalId: exhibitor.externalId,
      companyName: exhibitor.companyName,
      website: exhibitor.website,
      country: exhibitor.country,
      stand: exhibitor.stand,
      products: exhibitor.products,
    });
  }
  return { exhibitors: [...exhibitors.values()], hasNextPage: hits.length > 0 && page + 1 < nbPages };
}
