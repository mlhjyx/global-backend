import { createHash } from 'node:crypto';
import type { SbirSttrCompany } from '../../adapters/sbir-sttr-companies';
import type { ExecutionBroker, ToolResult } from '../../tools/tool-contract';
import type {
  SbirSttrCompanySearchInput,
  SbirSttrCompanySearchOutput,
} from '../../tools/source-tools-sbir';
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  SourceClass,
} from '../provider-contract';

function exact(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function fingerprint(query: string): string {
  return createHash('sha256').update(JSON.stringify({ query: exact(query), country: 'US' })).digest('hex');
}

function encodeCursor(start: number, scope: string): string {
  if (!Number.isSafeInteger(start) || start < 1 || start > 49) throw new Error('SBIR_CURSOR_INVALID');
  return Buffer.from(JSON.stringify({ start, scope }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, scope: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      parsed.scope !== scope || !Number.isSafeInteger(parsed.start) ||
      Number(parsed.start) < 1 || Number(parsed.start) > 49
    ) throw new Error('invalid');
    return Number(parsed.start);
  } catch {
    throw new Error('SBIR_CURSOR_INVALID');
  }
}

function requiredProvenance(result: ToolResult<unknown>, query: string, start: number, limit: number) {
  const provenance = result.provenance;
  if (
    !provenance?.sourceUrl || !provenance.contentHash || !/^[a-f0-9]{64}$/u.test(provenance.contentHash) ||
    provenance.parserVersion !== 'sbir-sttr-company-v1/1' || Number.isNaN(new Date(provenance.fetchedAt).getTime())
  ) throw new Error('SBIR_PROVENANCE_REQUIRED');
  let url: URL;
  try {
    url = new URL(provenance.sourceUrl);
  } catch {
    throw new Error('SBIR_PROVENANCE_REQUIRED');
  }
  if (
    url.protocol !== 'https:' || url.hostname !== 'api.www.sbir.gov' || url.pathname !== '/public/api/firm' ||
    url.username || url.password || url.hash || url.searchParams.size !== 5 ||
    url.searchParams.get('name') !== query || url.searchParams.get('rows') !== String(limit) ||
    url.searchParams.get('start') !== String(start) || url.searchParams.get('format') !== 'json' ||
    url.searchParams.get('sort') !== 'name'
  ) throw new Error('SBIR_PROVENANCE_REQUIRED');
  return {
    sourceUrl: provenance.sourceUrl,
    fetchedAt: provenance.fetchedAt,
    contentHash: provenance.contentHash,
    parserVersion: provenance.parserVersion,
  };
}

function validateResult(value: unknown, query: string): asserts value is SbirSttrCompany {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SBIR_BROKER_RESULT_INVALID');
  }
  const item = value as SbirSttrCompany;
  if (
    !/^[1-9]\d{0,17}$/u.test(item.sourceId) || !item.companyName || item.companyName.length > 255 ||
    exact(item.companyName) !== exact(query) ||
    (item.state !== undefined && !/^[A-Z]{2}$/u.test(item.state)) ||
    (item.uei !== undefined && !/^[A-Z0-9]{12}$/u.test(item.uei)) ||
    (item.awardCount !== undefined && (!Number.isSafeInteger(item.awardCount) || item.awardCount < 0 || item.awardCount > 999_999)) ||
    (item.officialProfileUrl !== undefined && !/^https:\/\/www\.sbir\.gov\/portfolio\/\d+\/?$/u.test(item.officialProfileUrl))
  ) throw new Error('SBIR_BROKER_RESULT_INVALID');
}

export class SbirSttrCompanyDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'sbir_sttr_companies';
  readonly classes: SourceClass[] = ['public_intelligence'];

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    if (query.sourceClass !== 'public_intelligence') return { records: [], costCents: 0 };
    if (typeof query.filters.source_hint !== 'string' || exact(query.filters.source_hint) !== this.key) {
      return { records: [], costCents: 0 };
    }
    if (
      typeof query.filters.country !== 'string' ||
      !['us', 'usa', 'united states', 'united states of america'].includes(exact(query.filters.country))
    ) throw new Error('SBIR_COUNTRY_SCOPE_INVALID');
    if (typeof query.filters.organization_name !== 'string' || !query.filters.organization_name.trim()) {
      throw new Error('SBIR_EXACT_QUERY_REQUIRED');
    }
    if (!this.deps?.broker) throw new Error('SBIR_BROKER_REQUIRED');
    const organizationName = query.filters.organization_name.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
    if (
      !organizationName || organizationName.length > 200 ||
      ['all', 'any', 'companies', 'businesses'].includes(exact(organizationName)) || /[*?,;]/u.test(organizationName)
    ) throw new Error('SBIR_EXACT_QUERY_REQUIRED');
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) throw new Error('SBIR_LIMIT_INVALID');

    const scope = fingerprint(organizationName);
    const start = decodeCursor(opts?.cursor, scope);
    const limit = Math.min(query.limit, 10);
    if (start + limit > 50) throw new Error('SBIR_CURSOR_INVALID');
    const output = await this.deps.broker.invoke<SbirSttrCompanySearchInput, SbirSttrCompanySearchOutput>(
      'sbir-sttr-companies.search',
      { query: organizationName, start, limit },
      { ...ctx, purpose: 'discovery' },
    );
    const provenance = requiredProvenance(output, organizationName, start, limit);
    if (!output.data || !Array.isArray(output.data.companies) || output.data.companies.length > limit) {
      throw new Error('SBIR_BROKER_RESULT_INVALID');
    }
    output.data.companies.forEach((item) => validateResult(item, organizationName));
    let nextCursor: string | undefined;
    if (output.data.nextCursor !== undefined) {
      if (!/^\d{1,2}$/u.test(output.data.nextCursor)) throw new Error('SBIR_CURSOR_INVALID');
      const nextStart = Number(output.data.nextCursor);
      if (nextStart !== start + limit || nextStart > 49) throw new Error('SBIR_CURSOR_INVALID');
      nextCursor = encodeCursor(nextStart, scope);
    }
    return {
      records: output.data.companies.map((item) => ({
        externalId: `sbir-sttr-company:${item.sourceId}`,
        name: item.companyName,
        country: 'US',
        region: item.state,
        attributes: {
          sbir_sttr_company: {
            firm_nid: item.sourceId,
            source_uei: item.uei,
            award_count: item.awardCount,
            official_profile_url: item.officialProfileUrl,
            identity_status: 'source_metadata_not_promoted',
            disclaimer: 'Directory presence proves historical SBIR/STTR award participation only; it does not prove current demand, eligibility, operating status, or commercial readiness.',
            transformation_notice: 'Organization-only projection normalized by global-backend; DUNS, street address, city, ZIP, company URL, ownership demographics, contacts, principal investigators and unknown upstream fields are excluded.',
          },
        },
        license: 'SOURCE_SPECIFIC',
        provenance,
      })),
      costCents: output.costCents,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
}
