import { createHash } from 'node:crypto';
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  SourceClass,
} from '../provider-contract';
import type { ExecutionBroker, ToolResult } from '../../tools/tool-contract';
import type {
  FranceCompanySearchInput,
  FranceCompanySearchOutput,
  NppesSearchInput,
  NppesSearchOutput,
  RorSearchInput,
  RorSearchOutput,
  SecEdgarDirectorySearchInput,
  SecEdgarDirectorySearchOutput,
} from '../../tools/source-tools';
import { ROR_ORGANIZATION_TYPES } from '../../adapters/official-organization-registries';
import { normalizeCikIdentifier, normalizeRorIdentifier } from '../organization-identity-v2';

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function country(query: CompanyDiscoveryQuery): string | undefined {
  return list(query.filters.country ?? query.filters.countries ?? query.filters.region)[0]?.toUpperCase();
}

function terms(query: CompanyDiscoveryQuery): string {
  return [...query.keywords, ...list(query.filters.organization_name ?? query.filters.company_name ?? query.filters.name)]
    .map((item) => item.trim()).filter(Boolean).join(' ').slice(0, 300);
}

abstract class OfficialOrganizationProvider implements CompanyDiscoveryAdapter {
  abstract readonly key: string;
  readonly classes: SourceClass[] = ['company_registry'];
  constructor(protected readonly deps?: { broker?: ExecutionBroker }) {}

  protected async invoke<I, O>(toolId: string, input: I, ctx: ExecutionContext): Promise<ToolResult<O> | null> {
    if (!this.deps?.broker) return null;
    return this.deps.broker.invoke<I, O>(
      toolId,
      input,
      { ...ctx, purpose: 'discovery' },
    );
  }

  abstract discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult>;
}

function requiredProvenance(
  result: ToolResult<unknown>,
  expectedHost: string,
  expectedParserVersion: string,
): NonNullable<ToolResult<unknown>['provenance']> & {
  sourceUrl: string;
  contentHash: string;
} {
  const provenance = result.provenance;
  if (
    !provenance?.sourceUrl ||
    !provenance.contentHash ||
    !/^[a-f0-9]{64}$/u.test(provenance.contentHash) ||
    provenance.parserVersion !== expectedParserVersion ||
    Number.isNaN(new Date(provenance.fetchedAt).getTime())
  ) {
    throw new Error('OFFICIAL_ORGANIZATION_PROVENANCE_REQUIRED');
  }
  try {
    const url = new URL(provenance.sourceUrl);
    if (url.protocol !== 'https:' || url.hostname !== expectedHost) throw new Error('unexpected source');
  } catch {
    throw new Error('OFFICIAL_ORGANIZATION_PROVENANCE_REQUIRED');
  }
  return {
    sourceUrl: provenance.sourceUrl,
    fetchedAt: provenance.fetchedAt,
    contentHash: provenance.contentHash,
    parserVersion: provenance.parserVersion,
  };
}

export class FranceOfficialOrganizationDiscoveryProvider extends OfficialOrganizationProvider {
  readonly key = 'fr_company';
  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext): Promise<DiscoveryResult> {
    const siren = list(query.filters.siren)[0];
    if (!siren && country(query) !== 'FR') return { records: [], costCents: 0 };
    const queryText = siren ?? terms(query);
    if (!queryText || !this.deps?.broker) return { records: [], costCents: 0 };
    const output = await this.invoke<FranceCompanySearchInput, FranceCompanySearchOutput>('fr-company.search', { query: queryText, limit: Math.min(query.limit, 25) }, ctx);
    if (!output) return { records: [], costCents: 0 };
    const provenance = requiredProvenance(output, 'recherche-entreprises.api.gouv.fr', 'recherche-entreprises/1');
    const organizations = siren
      ? output.data.organizations.filter((item) => item.siren === siren.replace(/\s+/gu, ''))
      : output.data.organizations;
    return {
      records: organizations.map((item) => ({
        externalId: `fr-company:${item.siren}`,
        name: item.name,
        country: 'FR',
        region: item.city,
        industry: item.activityCode,
        identifiers: [{ scheme: 'siren', jurisdiction: 'FR', value: item.siren }],
        identifier: { scheme: 'siren', jurisdiction: 'FR', value: item.siren },
        attributes: { france_official: { siren: item.siren, activity_code: item.activityCode, city: item.city, postal_code: item.postalCode } },
        license: 'ETALAB-2.0',
        provenance,
      })),
      costCents: output.costCents,
    };
  }
}

export class NppesOrganizationDiscoveryProvider extends OfficialOrganizationProvider {
  readonly key = 'nppes';
  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext): Promise<DiscoveryResult> {
    const npi = list(query.filters.npi)[0];
    const healthcare = query.filters.healthcare === true || list(query.filters.organization_types).some((item) => /health|hospital|clinic/iu.test(item));
    if (country(query) !== 'US' || !healthcare) return { records: [], costCents: 0 };
    const organizationName = npi ? undefined : terms(query);
    if (!npi && !organizationName || !this.deps?.broker) return { records: [], costCents: 0 };
    const state = list(query.filters.state)[0];
    const output = await this.invoke<NppesSearchInput, NppesSearchOutput>('nppes.search', {
      ...(npi ? { npi } : {}),
      ...(organizationName ? { organizationName } : {}),
      ...(state ? { state } : {}),
      limit: Math.min(query.limit, 200),
    }, ctx);
    if (!output) return { records: [], costCents: 0 };
    const provenance = requiredProvenance(output, 'npiregistry.cms.hhs.gov', 'nppes-v2.1/1');
    if (output.data.organizations.some((item) => !['A', 'D'].includes(item.status?.toUpperCase() ?? ''))) {
      throw new Error('NPPES_STATUS_UNKNOWN');
    }
    const organizations = output.data.organizations.filter((item) => {
      const status = item.status?.toUpperCase();
      // Name search remains an acquisition-discovery surface and therefore
      // admits only current NPI-2 units. An exact NPI lookup is also a lifecycle
      // observation: retain D so the commit stage can revoke the old binding
      // instead of misreporting an authoritative deactivation as zero results.
      return status === 'A' || (Boolean(npi) && status === 'D');
    });
    return {
      records: organizations.map((item) => ({
        externalId: `nppes:${item.npi}`,
        name: item.name,
        country: 'US',
        region: item.state,
        industry: item.taxonomyDescriptions[0],
        identifiers: [{ scheme: 'us_npi', jurisdiction: 'US', value: item.npi }],
        identifier: { scheme: 'us_npi', jurisdiction: 'US', value: item.npi },
        attributes: { nppes: { npi: item.npi, entity_type: 'NPI-2', status: item.status, candidate_eligible: item.status?.toUpperCase() === 'A', observation_scope: npi ? 'exact_npi' : 'search', city: item.city, state: item.state, taxonomies: item.taxonomyDescriptions, disclaimer: 'NPI issuance does not establish licensure or credentialing.' } },
        license: 'US-GOV-PUBLIC-DOMAIN',
        provenance,
      })),
      costCents: output.costCents,
    };
  }
}

export class RorOrganizationDiscoveryProvider extends OfficialOrganizationProvider {
  readonly key = 'ror';

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext, opts?: DiscoveryOptions): Promise<DiscoveryResult> {
    if (
      typeof query.filters.source_hint !== 'string' ||
      query.filters.source_hint.trim().toLowerCase() !== this.key
    ) {
      return { records: [], costCents: 0 };
    }
    const queryText = terms(query);
    const queryCountry = country(query);
    const types = list(query.filters.organization_types ?? query.filters.organization_type)
      .map((value) => value.toLowerCase());
    if (
      !queryText || !queryCountry || !/^[A-Z]{2}$/u.test(queryCountry) || types.length !== 1 ||
      types.some((value) => !(ROR_ORGANIZATION_TYPES as readonly string[]).includes(value)) || !this.deps?.broker
    ) return { records: [], costCents: 0 };
    const fingerprint = createHash('sha256').update(JSON.stringify({ queryText, queryCountry, types })).digest('hex');
    const page = decodeRorCursor(opts?.cursor, fingerprint);
    const output = await this.invoke<RorSearchInput, RorSearchOutput>('ror.search', {
      query: queryText,
      country: queryCountry,
      types: [types[0]!],
      limit: Math.min(query.limit, 20),
      page,
    }, ctx);
    if (!output) return { records: [], costCents: 0 };
    const provenance = requiredProvenance(output, 'api.ror.org', 'ror-v2.1/2');
    if (output.data.organizations.some((item) =>
      !item.name?.trim() || item.name.length > 300 || item.country !== queryCountry ||
      !Array.isArray(item.types) || item.types.length === 0 || item.types.length > 16 ||
      item.types.some((value) => !(ROR_ORGANIZATION_TYPES as readonly string[]).includes(value)) ||
      !types.every((value) => item.types.includes(value)) ||
      !Array.isArray(item.reportedDomains) || item.reportedDomains.length > 10 ||
      item.reportedDomains.some((value) =>
        typeof value !== 'string' || value.length > 253 || !/^[a-z0-9.-]+$/u.test(value) ||
        !value.includes('.') || value.includes('..') || value === 'localhost' || /^\d+(?:\.\d+){3}$/u.test(value)
      )
    )) throw new Error('ROR_BROKER_RESULT_INVALID');
    const records = output.data.organizations.map((item) => {
      const rorId = normalizeRorIdentifier(item.rorId);
      if (!rorId) throw new Error('ROR_ID_INVALID');
      return {
        externalId: `ror:${rorId.slice(-9)}`,
        name: item.name,
        country: item.country,
        identifiers: [{ scheme: 'ror-id', jurisdiction: 'GLOBAL', value: rorId }],
        identifier: { scheme: 'ror-id', jurisdiction: 'GLOBAL', value: rorId },
        attributes: {
          ror: {
            ror_id: rorId,
            status: 'active',
            organization_types: item.types,
            reported_domain_candidates: item.reportedDomains,
            domain_identity_status: 'source_reported_evidence_only',
          },
        },
        license: 'CC0-1.0',
        provenance,
      };
    });
    return {
      records,
      costCents: output.costCents,
      ...(output.data.nextCursor ? { nextCursor: encodeRorCursor(Number(output.data.nextCursor), fingerprint) } : {}),
    };
  }
}

export class SecEdgarOrganizationDiscoveryProvider extends OfficialOrganizationProvider {
  readonly key = 'sec_edgar';

  async discoverCompanies(query: CompanyDiscoveryQuery, ctx: ExecutionContext): Promise<DiscoveryResult> {
    if (
      typeof query.filters.source_hint !== 'string' ||
      query.filters.source_hint.trim().toLowerCase() !== this.key ||
      !this.deps?.broker
    ) {
      return { records: [], costCents: 0 };
    }
    const filterTerms = list(
      query.filters.ticker ?? query.filters.organization_name ?? query.filters.company_name ?? query.filters.name,
    );
    const candidates = filterTerms.length > 0 ? filterTerms : query.keywords.map((value) => value.trim()).filter(Boolean);
    if (candidates.length !== 1 || candidates[0]!.length > 300) return { records: [], costCents: 0 };

    const exactQuery = candidates[0]!;
    const output = await this.invoke<SecEdgarDirectorySearchInput, SecEdgarDirectorySearchOutput>(
      'sec-edgar.company-directory.search',
      { query: exactQuery, limit: Math.min(query.limit, 5) },
      ctx,
    );
    if (!output) return { records: [], costCents: 0 };
    const provenance = requiredProvenance(
      output,
      'www.sec.gov',
      'sec-edgar-company-tickers-exchange/1',
    );
    const records = output.data.organizations.map((item) => {
      const cik = normalizeCikIdentifier(item.cik);
      if (
        !cik || !item.name?.trim() || item.name.length > 300 ||
        (item.ticker !== undefined && !/^[A-Z0-9.-]{1,16}$/u.test(item.ticker)) ||
        (item.exchange !== undefined && (!item.exchange.trim() || item.exchange.length > 80))
      ) {
        throw new Error('SEC_EDGAR_BROKER_RESULT_INVALID');
      }
      return {
        externalId: `sec-edgar:${cik}`,
        name: item.name,
        identifiers: [{ scheme: 'cik', jurisdiction: 'US', value: cik }],
        identifier: { scheme: 'cik', jurisdiction: 'US', value: cik },
        attributes: {
          sec_edgar: {
            cik,
            ticker: item.ticker,
            exchange: item.exchange,
            identity_scope: 'US securities filer namespace',
            disclaimer: 'A CIK identifies an SEC filer and does not establish US domicile or commercial fit.',
          },
        },
        license: 'US-GOV-PUBLIC-INFO',
        provenance,
      };
    });
    return { records, costCents: output.costCents };
  }
}

function encodeRorCursor(page: number, fingerprint: string): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > 500) throw new Error('ROR_CURSOR_INVALID');
  return Buffer.from(JSON.stringify({ page, fingerprint }), 'utf8').toString('base64url');
}

function decodeRorCursor(cursor: string | undefined, fingerprint: string): number {
  if (!cursor) return 1;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (value.fingerprint !== fingerprint || !Number.isSafeInteger(value.page) || Number(value.page) < 2 || Number(value.page) > 500) {
      throw new Error('invalid');
    }
    return Number(value.page);
  } catch {
    throw new Error('ROR_CURSOR_INVALID');
  }
}
