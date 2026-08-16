import { createHash } from 'node:crypto';

import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  ProviderCompanyRecord,
  SourceClass,
} from '../provider-contract';
import type { ExecutionBroker } from '../../tools/tool-contract';
import type {
  BrazilPncpNotice,
  ContractsFinderOrganization,
  ProcurementPage,
  SingaporeGebizAward,
  UsaSpendingAward,
  UkProcurementOrganization,
  WorldBankNotice,
} from '../../adapters/public-procurement';
import { validatedPncpCnpjClaim } from '../../adapters/public-procurement';
import { worldBankBusinessEvidenceMatches } from './world-bank-keyword-match';

export const PROCUREMENT_TOOL_IDS = {
  worldBank: 'worldbank.procurement.search',
  usaSpending: 'usaspending.search',
  ukFts: 'uk_fts.search',
  brazilPncp: 'brazil_pncp.search',
  singaporeGebiz: 'singapore_gebiz.search',
  ukContractsFinder: 'uk_contracts_finder.search',
} as const;

// World Bank notices are filtered after the wire response (for example rows
// without contact_organization are rejected). Reading only the number of
// companies still needed therefore under-fills the bounded three-page scan.
// Keep the business result limit separate from the official wire page size so
// one page can absorb some expected filtering without raising the global page
// cap or persisting more than the confirmed query requested. Twenty-five is a
// bounded response-size compromise observed below the existing 8 MiB cap; it
// improves recall but does not guarantee that a three-page scan fills the
// requested business limit, so remaining continuation stays honestly PARTIAL.
const WORLD_BANK_WIRE_PAGE_LIMIT = 25;

// USAspending applies local buyer-role and business-evidence filters after its
// POST response. Read the official maximum page size so a small business limit
// is not under-filled by rejected rows, then slice to the caller-confirmed
// limit. The orchestrator still owns the global three-page cap and marks any
// remaining continuation PARTIAL.
const USA_SPENDING_WIRE_PAGE_LIMIT = 100;
const BRAZIL_PNCP_WIRE_PAGE_LIMIT = 50;

interface WorldBankToolInput {
  keywords: string[];
  country: string;
  offset: number;
  limit: number;
}

interface UsaSpendingToolInput {
  keywords: string[];
  startDate: string;
  endDate: string;
  page: number;
  limit: number;
}

interface UkFtsToolInput {
  updatedFrom: string;
  updatedTo?: string;
  cursor?: string;
  limit: number;
  stage: 'planning' | 'tender' | 'award';
}

interface BrazilPncpToolInput {
  dateFinal: string;
  page: number;
  pageSize: number;
  uf?: string;
}

interface SingaporeGebizToolInput {
  keywords: string[];
  offset: number;
  limit: number;
}

interface ContractsFinderToolInput {
  publishedFrom: string;
  publishedTo?: string;
  cursor?: string;
  limit: number;
  stage: 'planning' | 'tender' | 'award';
}

abstract class GovernedProcurementProvider implements CompanyDiscoveryAdapter {
  abstract readonly key: string;
  abstract readonly countries: ReadonlySet<string> | null;
  readonly classes: SourceClass[] = ['public_intelligence'];

  constructor(protected readonly deps?: { broker?: ExecutionBroker }) {}

  protected admitted(query: CompanyDiscoveryQuery): {
    keywords: string[];
    country: string;
    procurementRole: 'buyer' | 'supplier';
    ukRegion?: UkConstituent;
  } | null {
    if (query.sourceClass !== 'public_intelligence') return null;
    if (!hasExplicitProviderHint(query.filters, this.key)) return null;
    const country = explicitCountry(query.filters);
    if (!country || (this.countries && !this.countries.has(normalizeCountry(country)))) return null;
    const keywords = explicitKeywords(query);
    if (!keywords.length || !this.deps?.broker) return null;
    const requestedRole = explicitProcurementRole(query.filters);
    if (requestedRole === 'invalid') return null;
    const procurementRole = requestedRole ?? 'buyer';
    const ukRegion = requestedUkConstituent(query.filters, country);
    if (ukRegion === 'invalid') return null;
    return { keywords, country, procurementRole, ...(ukRegion ? { ukRegion } : {}) };
  }

  abstract discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult>;

  protected async invoke<I, T>(toolId: string, input: I, ctx: ExecutionContext): Promise<ProcurementPage<T> | null> {
    if (!this.deps?.broker) return null;
    return (
      await this.deps.broker.invoke<I, ProcurementPage<T>>(toolId, input, {
        ...ctx,
        purpose: 'discovery',
      })
    ).data;
  }
}

export class WorldBankProcurementDiscoveryProvider extends GovernedProcurementProvider {
  readonly key = 'world_bank_procurement';
  readonly countries = null;

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const gate = this.admitted(query);
    if (!gate || gate.procurementRole !== 'buyer') return empty();
    const resultLimit = boundedLimit(query.limit, 100);
    const page = await this.invoke<WorldBankToolInput, WorldBankNotice>(
      PROCUREMENT_TOOL_IDS.worldBank,
      {
        keywords: gate.keywords,
        country: gate.country,
        offset: decimalCursor(opts?.cursor, 'World Bank offset', 0, 10_000),
        limit: WORLD_BANK_WIRE_PAGE_LIMIT,
      },
      ctx,
    );
    if (!page) return empty();
    return recordsResult(page, page.records
      // qterm is full-text search, not a server-side country predicate. Treat
      // every returned country as untrusted and fail closed on absent/mismatch.
      .filter((notice) => notice.country && sameCountryText(notice.country, gate.country))
      .filter((notice) => worldBankBusinessEvidenceMatches({
        organizationName: notice.organizationName,
        title: notice.title,
        projectName: notice.projectName,
      }, gate.keywords))
      .slice(0, resultLimit)
      .map((notice) => ({
      externalId: `worldbank:${notice.id}`,
      name: notice.organizationName,
      country: notice.country,
      license: 'CC BY 4.0',
      attributes: {
        source_role: notice.organizationRole,
        signal_stage: notice.signalStage,
        procurement: prune({
          notice_id: notice.id,
          title: notice.title,
          project_id: notice.projectId,
          project_name: notice.projectName,
          project_country: notice.projectCountry,
          method: notice.method,
          deadline: notice.deadline,
        }),
      },
      provenance: page.provenance,
    })));
  }
}

export class UsaSpendingAwardsDiscoveryProvider extends GovernedProcurementProvider {
  readonly key = 'usaspending_awards';
  readonly countries = US_COUNTRIES;

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const gate = this.admitted(query);
    if (!gate) return empty();
    // Recipient Name may be a natural person/sole proprietor. Reject supplier mode before any egress.
    if (gate.procurementRole !== 'buyer') return empty();
    const resultLimit = boundedLimit(query.limit, 100);
    const sinceDays = integerFilter(query.filters, ['since_days', 'sinceDays'], 730, 1, 3_650);
    const window = usaSpendingWindow(gate.keywords, sinceDays, opts?.cursor);
    const page = await this.invoke<UsaSpendingToolInput, UsaSpendingAward>(
      PROCUREMENT_TOOL_IDS.usaSpending,
      {
        keywords: gate.keywords,
        startDate: window.startDate,
        endDate: window.endDate,
        page: window.page,
        limit: USA_SPENDING_WIRE_PAGE_LIMIT,
      },
      ctx,
    );
    if (!page) return empty();
    const records = page.records
      // Buyer discovery must be justified by buyer/award facts. Recipient Name
      // may be a person and must never be the sole reason a buyer is admitted.
      .map((award) => ({ award, matchBasis: usaSpendingMatchBasis(award, gate.keywords) }))
      .filter(({ matchBasis }) => matchBasis.length > 0)
      // Top-level agencies are historical parent accounts, not the actual buying organization.
      // Fail closed unless USAspending names a more specific awarding sub-agency.
      .filter(({ award }) => isDistinctUsaSpendingSubAgency(award.awardingAgency, award.awardingSubAgency))
      .slice(0, resultLimit)
      .map(({ award, matchBasis }): ProviderCompanyRecord => {
        const buyerName = usaSpendingBuyerDisplayName(award.awardingAgency, award.awardingSubAgency as string);
        return {
          externalId: `usaspending:${award.awardId}:buyer`,
          name: buyerName,
          country: 'US',
          license: 'USAspending public award data',
          attributes: {
            source_role: 'buyer',
            signal_stage: 'historical_award_buyer',
            procurement: prune({
              award_id: award.awardId,
              awarding_agency: award.awardingAgency,
              awarding_sub_agency: award.awardingSubAgency,
              // Buyer projection does not retain the supplier name; it may be a natural person.
              // Description is free text and may contain contacts. It participates
              // in the in-memory keyword gate above but never enters Raw/Evidence.
              amount_usd: award.amount,
              start_date: award.startDate,
              end_date: award.endDate,
              source_page: window.page,
              query_start_date: window.startDate,
              query_end_date: window.endDate,
              query_keywords: gate.keywords,
              query_match: true,
              match_basis: matchBasis,
              query_fingerprint: window.queryFingerprint,
            }),
          },
          // Award IDs identify commercial events, not organizations.
          provenance: page.provenance,
        };
      });
    return {
      records,
      costCents: 0,
      ...(page.nextCursor
        ? { nextCursor: encodeUsaSpendingCursor({ ...window, page: decimalCursor(page.nextCursor, 'USAspending page', 1, 100) }) }
        : {}),
    };
  }
}

export class UkFindATenderDiscoveryProvider extends GovernedProcurementProvider {
  readonly key = 'uk_find_a_tender';
  readonly countries = UK_COUNTRIES;

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const gate = this.admitted(query);
    if (!gate) return empty();
    const sinceDays = integerFilter(query.filters, ['since_days', 'sinceDays'], 30, 1, 366);
    const page = await this.invoke<UkFtsToolInput, UkProcurementOrganization>(
      PROCUREMENT_TOOL_IDS.ukFts,
      {
        updatedFrom: isoDaysAgo(sinceDays),
        cursor: opts?.cursor,
        // FTS does not support keyword search. Fetch a full wire page before
        // local filtering, otherwise query.limit=5 inspects only the five most
        // recent notices and commonly reports a false zero.
        limit: 100,
        // The live endpoint accepts a single stage value. A comma-separated
        // planning,tender,award value returns an empty release package.
        stage: gate.procurementRole === 'buyer' ? 'tender' : 'award',
      },
      ctx,
    );
    if (!page) return empty();
    return recordsResult(
      page,
      mapUkRecords('uk_fts', page, gate.keywords, gate.procurementRole, gate.ukRegion)
        .slice(0, boundedLimit(query.limit, 100)),
    );
  }
}

export class BrazilPncpDiscoveryProvider extends GovernedProcurementProvider {
  readonly key = 'brazil_pncp';
  readonly countries = BRAZIL_COUNTRIES;

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const gate = this.admitted(query);
    if (!gate || gate.procurementRole !== 'buyer') return empty();
    const state = requestedBrazilPncpState(query.filters);
    if (state === 'invalid') return empty();
    const resultLimit = boundedLimit(query.limit, 50);
    const window = brazilPncpWindow(gate.keywords, state, opts?.cursor);
    const page = await this.invoke<BrazilPncpToolInput, BrazilPncpNotice>(
      PROCUREMENT_TOOL_IDS.brazilPncp,
      {
        dateFinal: window.dateFinal,
        page: window.page,
        pageSize: window.wirePageSize,
        ...(window.state ? { uf: window.state } : {}),
      },
      ctx,
    );
    if (!page) return empty();
    const matched = page.records
      .filter((notice) => isFutureBrazilPncpDeadline(notice.deadline))
      .map((notice) => ({ notice, matchedKeywords: matchingBrazilPncpKeywords(notice.title, gate.keywords) }))
      .filter((item) => item.matchedKeywords.length > 0);
    const records = matched.slice(0, resultLimit).map(({ notice, matchedKeywords }) => {
      // Revalidate at the strong-identity projection boundary. Tool results can
      // be replayed or deserialized independently of the live wire adapter, so
      // the Provider must not trust an optional claim merely because it exists.
      const buyerCnpjClaim = validatedPncpCnpjClaim(notice.controlNumber, notice.buyerCnpjClaim);
      return ({
      externalId: `pncp:${notice.controlNumber}`,
      name: notice.organizationName,
      country: 'BR',
      license: 'Dados Abertos PNCP',
      attributes: {
        source_role: notice.organizationRole,
        signal_stage: notice.signalStage,
        procurement: prune({
          control_number: notice.controlNumber,
          title: notice.title,
          matched_query_terms: matchedKeywords,
          method: notice.method,
          deadline: notice.deadline,
          estimated_value_brl: notice.estimatedValue,
          notice_url: notice.noticeUrl,
          unit_location: prune({
            municipality: notice.unitMunicipality,
            state: notice.unitState,
            ibge_code: notice.unitIbgeCode,
          }),
          cnpj_claim: buyerCnpjClaim,
          cnpj_identity_status: buyerCnpjClaim ? 'validated_authority' : undefined,
          source_page: window.page,
          query_date_final: window.dateFinal,
          query_state: window.state,
          query_keywords: normalizedBrazilPncpKeywords(gate.keywords),
          query_fingerprint: window.queryFingerprint,
        }),
      },
      ...(buyerCnpjClaim
        ? { identifiers: [{ scheme: 'br-cnpj', jurisdiction: 'BR', value: buyerCnpjClaim }] }
        : {}),
      provenance: page.provenance,
      });
    });
    return {
      records,
      costCents: 0,
      ...(page.nextCursor
        ? { nextCursor: encodeBrazilPncpCursor({
            ...window,
            page: decimalCursor(page.nextCursor, 'PNCP page', 1, 200),
          }) }
        : {}),
    };
  }
}

export class SingaporeGebizDiscoveryProvider extends GovernedProcurementProvider {
  readonly key = 'singapore_gebiz';
  readonly countries = SINGAPORE_COUNTRIES;

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const gate = this.admitted(query);
    if (!gate || gate.procurementRole !== 'supplier') return empty();
    const page = await this.invoke<SingaporeGebizToolInput, SingaporeGebizAward>(
      PROCUREMENT_TOOL_IDS.singaporeGebiz,
      {
        keywords: gate.keywords,
        offset: decimalCursor(opts?.cursor, 'GeBIZ offset', 0, 10_000),
        limit: boundedLimit(query.limit, 100),
      },
      ctx,
    );
    if (!page) return empty();
    return recordsResult(page, page.records.slice(0, boundedLimit(query.limit, 100)).map((award) => ({
      externalId: `gebiz:${award.externalId}`,
      name: award.organizationName,
      country: 'SG',
      license: 'Singapore Open Data Licence',
      attributes: {
        source_role: award.organizationRole,
        signal_stage: award.signalStage,
        procurement: prune({
          tender_number: award.tenderNumber,
          title: award.title,
          buyer_agency: award.buyerAgency,
          award_date: award.awardDate,
          status: award.status,
          awarded_amount_sgd: award.amount,
        }),
      },
      provenance: page.provenance,
    })));
  }
}

export class UkContractsFinderDiscoveryProvider extends GovernedProcurementProvider {
  readonly key = 'uk_contracts_finder';
  readonly countries = UK_COUNTRIES;

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    const gate = this.admitted(query);
    // Contracts Finder is a current-buyer acquisition channel. Historical
    // suppliers remain available only through the separately governed FTS path.
    if (!gate || explicitProcurementRole(query.filters) !== 'buyer') return empty();
    const sinceDays = integerFilter(query.filters, ['since_days', 'sinceDays'], 30, 1, 366);
    const page = await this.invoke<ContractsFinderToolInput, ContractsFinderOrganization>(
      PROCUREMENT_TOOL_IDS.ukContractsFinder,
      {
        publishedFrom: isoDaysAgo(sinceDays),
        cursor: opts?.cursor,
        // Search a complete official page before local keyword filtering.
        // Mixing awards with tenders makes recent award traffic crowd active
        // buyer opportunities out of a small wire page.
        limit: 100,
        stage: 'tender',
      },
      ctx,
    );
    if (!page) return empty();
    return recordsResult(
      page,
      mapUkRecords('uk_contracts_finder', page, gate.keywords, 'buyer', gate.ukRegion)
        .slice(0, boundedLimit(query.limit, 100)),
    );
  }
}

function mapUkRecords(
  source: 'uk_fts' | 'uk_contracts_finder',
  page: ProcurementPage<UkProcurementOrganization>,
  keywords: string[],
  procurementRole: 'buyer' | 'supplier',
  requestedRegion?: UkConstituent,
): ProviderCompanyRecord[] {
  return page.records
    .filter((item) => item.organizationRole === procurementRole)
    .filter((item) =>
      procurementRole === 'supplier'
        ? item.signalStage === 'awarded'
        : item.signalStage === 'planning_or_tender'
          && item.status?.trim().toLocaleLowerCase('en-US') === 'active'
          && item.country === 'United Kingdom'
          && (source !== 'uk_contracts_finder' || isFutureDeadline(item.deadline)),
    )
    .filter((item) => !requestedRegion || item.region === requestedRegion)
    // Description is used nowhere beyond the wire adapter: live notices may
    // contain phone numbers, emails and contact names. Acquisition matching and
    // persisted green evidence are intentionally limited to buyer name + title.
    .filter((item) => matchesKeywords(`${item.organizationName} ${item.title}`, keywords))
    .map((item) => ({
      externalId: `${source}:${item.externalId}`,
      name: item.organizationName,
      country: item.country,
      region: item.country === 'United Kingdom' ? item.region : undefined,
      license: 'OGL-UK-3.0',
      attributes: {
        source_role: item.organizationRole,
        signal_stage: item.signalStage,
        procurement: prune({
          ocid: item.ocid,
          release_id: item.releaseId,
          source_party_id: item.sourcePartyId,
          declared_url: item.declaredUrl,
          title: item.title,
          status: item.status,
          date: item.date,
          notice_url: item.noticeUrl,
          deadline: item.deadline,
          estimated_value: item.estimatedValue,
          currency: item.currency,
          cpv_codes: item.classificationIds,
        }),
      },
      // sourcePartyId and declaredUrl are not strong identity assertions.
      provenance: page.provenance,
    }));
}

const UK_COUNTRIES = new Set([
  'gb', 'uk', 'united kingdom', 'great britain', 'england', 'scotland', 'wales', 'northern ireland',
  '英国', '英格兰', '苏格兰', '威尔士', '北爱尔兰',
]);
type UkConstituent = 'England' | 'Scotland' | 'Wales' | 'Northern Ireland';

function normalizeUkConstituent(value: unknown): UkConstituent | undefined {
  const normalized = String(value ?? '').trim().toLocaleLowerCase('en-US');
  if (normalized === 'england' || normalized === '英格兰') return 'England';
  if (normalized === 'scotland' || normalized === '苏格兰') return 'Scotland';
  if (normalized === 'wales' || normalized === '威尔士') return 'Wales';
  if (normalized === 'northern ireland' || normalized === '北爱尔兰') return 'Northern Ireland';
  return undefined;
}

function requestedUkConstituent(
  filters: Record<string, unknown>,
  country: string,
): UkConstituent | 'invalid' | undefined {
  const countryRegion = normalizeUkConstituent(country);
  const rawRegion = filters.region ?? filters.target_region ?? filters.buyer_region;
  const regionText = rawRegion == null ? '' : String(Array.isArray(rawRegion) ? rawRegion[0] : rawRegion).trim();
  const filterRegion = regionText ? normalizeUkConstituent(regionText) : undefined;
  if (regionText && !filterRegion) return 'invalid';
  if (countryRegion && filterRegion && countryRegion !== filterRegion) return 'invalid';
  return filterRegion ?? countryRegion;
}
const US_COUNTRIES = new Set(['us', 'usa', 'united states', 'united states of america', '美国']);
const BRAZIL_COUNTRIES = new Set(['br', 'brazil', 'brasil', '巴西']);
const SINGAPORE_COUNTRIES = new Set(['sg', 'singapore', '新加坡']);

function hasExplicitProviderHint(filters: Record<string, unknown>, key: string): boolean {
  const values = [filters.source_hint, filters.provider, filters.provider_key, filters._provider]
    .flat()
    .filter((value) => value != null)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim().toLocaleLowerCase('en-US'))
    .filter(Boolean);
  return values.includes(key);
}

function explicitCountry(filters: Record<string, unknown>): string | null {
  for (const raw of [filters.country, filters.target_country, filters.buyer_country]) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function explicitKeywords(query: CompanyDiscoveryQuery): string[] {
  const filterTerms = [query.filters.product, query.filters.product_keyword, query.filters.procurement_keyword]
    .flat()
    .filter((value) => value != null)
    .map(String);
  return [...new Set([...query.keywords, ...filterTerms].map((value) => value.trim()).filter(Boolean))].slice(0, 8);
}

function explicitProcurementRole(filters: Record<string, unknown>): 'buyer' | 'supplier' | 'invalid' | null {
  const raw = filters.procurement_role ?? filters.organization_role ?? filters.source_role;
  if (raw == null || !String(raw).trim()) return null;
  const normalized = String(raw).trim().toLocaleLowerCase('en-US');
  if (normalized === 'buyer' || normalized === 'supplier') return normalized;
  return 'invalid';
}

function normalizeCountry(country: string): string {
  return country.normalize('NFKC').trim().toLocaleLowerCase('en-US').replaceAll(/\s+/gu, ' ');
}

function sameCountryText(left: string, right: string): boolean {
  return normalizeCountry(left) === normalizeCountry(right);
}

function boundedLimit(limit: number, maximum: number): number {
  const integer = Number.isFinite(limit) ? Math.trunc(limit) : 25;
  return Math.min(Math.max(integer, 1), maximum);
}

function integerFilter(
  filters: Record<string, unknown>,
  keys: string[],
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = keys.map((key) => filters[key]).find((value) => value != null);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), minimum), maximum) : fallback;
}

function matchesKeywords(value: string, keywords: string[]): boolean {
  const haystack = value.toLocaleLowerCase('en-US');
  return keywords.some((keyword) => haystack.includes(keyword.toLocaleLowerCase('en-US')));
}

type UsaSpendingMatchBasis = 'description' | 'awarding_agency' | 'awarding_sub_agency';

function usaSpendingMatchBasis(award: UsaSpendingAward, keywords: string[]): UsaSpendingMatchBasis[] {
  const candidates: readonly [UsaSpendingMatchBasis, string | undefined][] = [
    ['description', award.description],
    ['awarding_agency', award.awardingAgency],
    ['awarding_sub_agency', award.awardingSubAgency],
  ];
  return candidates
    .filter((entry): entry is [UsaSpendingMatchBasis, string] => Boolean(entry[1]))
    .filter(([, value]) => matchesKeywords(value, keywords))
    .map(([basis]) => basis);
}

function matchingBrazilPncpKeywords(value: string, keywords: string[]): string[] {
  const haystack = value.normalize('NFKC').toLocaleLowerCase('pt-BR');
  return [...new Set(keywords
    .map((keyword) => keyword.normalize('NFKC').trim().toLocaleLowerCase('pt-BR'))
    .filter((keyword) => keyword && haystack.includes(keyword)))];
}

function isFutureDeadline(value: string | undefined): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function isDistinctUsaSpendingSubAgency(agency: string, subAgency?: string): subAgency is string {
  if (!subAgency?.trim()) return false;
  const normalize = (value: string) => value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return normalize(subAgency) !== normalize(agency);
}

function usaSpendingBuyerDisplayName(agency: string, subAgency: string): string {
  const display = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return `${display(agency)} / ${display(subAgency)}`;
}

function isoDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 19);
}

function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

interface UsaSpendingCursor {
  page: number;
  startDate: string;
  endDate: string;
  queryFingerprint: string;
}

function usaSpendingQueryFingerprint(
  keywords: string[],
  sinceDays: number,
  startDate: string,
  endDate: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      keywords: keywords.map((value) => value.trim().toLocaleLowerCase('en-US')).sort(),
      sinceDays,
      startDate,
      endDate,
    }))
    .digest('hex');
}

function usaSpendingWindow(keywords: string[], sinceDays: number, cursor?: string): UsaSpendingCursor {
  if (!cursor) {
    const startDate = isoDateDaysAgo(sinceDays);
    const endDate = new Date().toISOString().slice(0, 10);
    return {
      page: 1,
      startDate,
      endDate,
      queryFingerprint: usaSpendingQueryFingerprint(keywords, sinceDays, startDate, endDate),
    };
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<UsaSpendingCursor>;
    const validDates = typeof decoded.startDate === 'string'
      && typeof decoded.endDate === 'string'
      && /^\d{4}-\d{2}-\d{2}$/u.test(decoded.startDate)
      && /^\d{4}-\d{2}-\d{2}$/u.test(decoded.endDate);
    const expectedFingerprint = validDates
      ? usaSpendingQueryFingerprint(keywords, sinceDays, decoded.startDate as string, decoded.endDate as string)
      : null;
    if (
      !validDates ||
      decoded.queryFingerprint !== expectedFingerprint ||
      !Number.isSafeInteger(decoded.page) ||
      (decoded.page as number) < 1 ||
      (decoded.page as number) > 100
    ) {
      throw new Error('invalid');
    }
    return decoded as UsaSpendingCursor;
  } catch (error) {
    throw new Error('USAspending cursor is invalid', { cause: error });
  }
}

function encodeUsaSpendingCursor(cursor: UsaSpendingCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

interface BrazilPncpCursor {
  page: number;
  dateFinal: string;
  queryFingerprint: string;
  wirePageSize: number;
  state?: string;
}

function brazilPncpWindow(keywords: string[], state: string | undefined, cursor?: string): BrazilPncpCursor {
  if (!cursor) {
    const dateFinal = braziliaToday();
    return {
      page: 1,
      dateFinal,
      wirePageSize: BRAZIL_PNCP_WIRE_PAGE_LIMIT,
      state,
      queryFingerprint: brazilPncpQueryFingerprint(keywords, dateFinal, state, BRAZIL_PNCP_WIRE_PAGE_LIMIT),
    };
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<BrazilPncpCursor>;
    const validDate = typeof decoded.dateFinal === 'string' && validCompactCalendarDate(decoded.dateFinal);
    const expectedFingerprint = validDate && decoded.wirePageSize === BRAZIL_PNCP_WIRE_PAGE_LIMIT
      ? brazilPncpQueryFingerprint(keywords, decoded.dateFinal as string, decoded.state, decoded.wirePageSize)
      : null;
    if (
      decoded.queryFingerprint !== expectedFingerprint
      || decoded.state !== state
      || !Number.isSafeInteger(decoded.page)
      || (decoded.page as number) < 1
      || (decoded.page as number) > 200
    ) throw new Error('invalid');
    return decoded as BrazilPncpCursor;
  } catch (error) {
    throw new Error('PNCP cursor is invalid', { cause: error });
  }
}

function brazilPncpQueryFingerprint(
  keywords: string[],
  dateFinal: string,
  state: string | undefined,
  wirePageSize: number,
): string {
  return createHash('sha256').update(JSON.stringify({
    keywords: normalizedBrazilPncpKeywords(keywords),
    dateFinal,
    state: state ?? null,
    wirePageSize,
  })).digest('hex');
}

function normalizedBrazilPncpKeywords(keywords: string[]): string[] {
  return [...new Set(keywords
    .map((value) => value.normalize('NFKC').trim().toLocaleLowerCase('pt-BR'))
    .filter(Boolean))].sort();
}

function validCompactCalendarDate(value: string): boolean {
  const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requestedBrazilPncpState(filters: Record<string, unknown>): string | 'invalid' | undefined {
  const raw = filters.uf ?? filters.state ?? filters.buyer_state;
  if (raw == null || !String(raw).trim()) return undefined;
  const state = String(Array.isArray(raw) ? raw[0] : raw).normalize('NFKC').trim().toLocaleUpperCase('pt-BR');
  return /^[A-Z]{2}$/u.test(state) ? state : 'invalid';
}

function encodeBrazilPncpCursor(cursor: BrazilPncpCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function braziliaToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}

function isFutureBrazilPncpDeadline(value: string | undefined): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u.test(value)) return false;
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second] = timePart.split('.')[0].split(':').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59
  ) return false;
  const timestamp = Date.parse(`${value}-03:00`);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function recordsResult(page: ProcurementPage<unknown>, records: ProviderCompanyRecord[]): DiscoveryResult {
  return { records, costCents: 0, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

function empty(): DiscoveryResult {
  return { records: [], costCents: 0 };
}

function decimalCursor(value: string | undefined, field: string, minimum: number, maximum: number): number {
  if (value == null) return minimum;
  if (!/^\d{1,10}$/u.test(value)) throw new Error(`${field} cursor is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} cursor is invalid`);
  }
  return parsed;
}

function prune(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}
