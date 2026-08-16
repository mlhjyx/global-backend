import { createHash } from 'node:crypto';
import {
  isClearlyEuEcolabelOrganization,
  normalizeEuEcolabelCountry,
  type EuEcolabelProduct,
} from '../../adapters/eu-ecolabel';
import type { ExecutionBroker, ToolResult } from '../../tools/tool-contract';
import type {
  EuEcolabelProductsSearchInput,
  EuEcolabelProductsSearchOutput,
} from '../../tools/source-tools-eu-ecolabel';
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  SourceClass,
} from '../provider-contract';

const SAFE_FIELDS = 'licence_number,expiration_date,decision,group_name,licence_holder,licence_holder_country,item_id,product_name';

function exact(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function expectedSourceUrl(organizationName: string, country: string, offset: number, limit: number): string {
  const url = new URL('https://apps.data.env.service.ec.europa.eu/dataquery/v2/ecolabel/products');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', SAFE_FIELDS);
  url.searchParams.set('order_by', 'licence_number,item_id');
  url.searchParams.set('licence_holder', organizationName);
  url.searchParams.set('licence_holder_country', country);
  return url.toString();
}

function requiredProvenance(
  result: ToolResult<unknown>,
  organizationName: string,
  country: string,
  offset: number,
  limit: number,
) {
  const provenance = result.provenance;
  if (
    !provenance?.sourceUrl || provenance.sourceUrl !== expectedSourceUrl(organizationName, country, offset, limit) ||
    !provenance.contentHash || !/^[a-f0-9]{64}$/u.test(provenance.contentHash) ||
    provenance.parserVersion !== 'ec-env-data-ecolabel-products-v2/1' ||
    Number.isNaN(new Date(provenance.fetchedAt).getTime())
  ) throw new Error('EU_ECOLABEL_PROVENANCE_REQUIRED');
  return {
    sourceUrl: provenance.sourceUrl,
    fetchedAt: provenance.fetchedAt,
    contentHash: provenance.contentHash,
    parserVersion: provenance.parserVersion,
  };
}

function validateResult(item: unknown, organizationName: string, countryCode: string): asserts item is EuEcolabelProduct {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new Error('EU_ECOLABEL_BROKER_RESULT_INVALID');
  }
  const candidate = item as Record<string, unknown>;
  if (
    typeof candidate.licenceHolder !== 'string' ||
    typeof candidate.licenceHolderCountryCode !== 'string' ||
    typeof candidate.licenceNumber !== 'string' ||
    typeof candidate.itemId !== 'string' ||
    !isClearlyEuEcolabelOrganization(candidate.licenceHolder) ||
    exact(candidate.licenceHolder) !== exact(organizationName) || candidate.licenceHolderCountryCode !== countryCode ||
    !candidate.licenceNumber || candidate.licenceNumber.length > 80 || !/^[1-9]\d{0,15}$/u.test(candidate.itemId) ||
    (candidate.expirationDate !== undefined &&
      (typeof candidate.expirationDate !== 'string' || Number.isNaN(new Date(candidate.expirationDate).getTime())))
  ) throw new Error('EU_ECOLABEL_BROKER_RESULT_INVALID');
}

function fingerprint(organizationName: string, country: string): string {
  return createHash('sha256').update(JSON.stringify({
    organizationName: exact(organizationName), country: exact(country),
  })).digest('hex');
}

function encodeCursor(offset: number, scope: string): string {
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > 99) throw new Error('EU_ECOLABEL_CURSOR_INVALID');
  return Buffer.from(JSON.stringify({ offset, scope }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, scope: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      parsed.scope !== scope || !Number.isSafeInteger(parsed.offset) ||
      Number(parsed.offset) < 1 || Number(parsed.offset) > 99
    ) throw new Error('invalid');
    return Number(parsed.offset);
  } catch {
    throw new Error('EU_ECOLABEL_CURSOR_INVALID');
  }
}

export class EuEcolabelOrganizationDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'eu_ecolabel';
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
    const country = typeof query.filters.country === 'string'
      ? normalizeEuEcolabelCountry(query.filters.country)
      : undefined;
    if (!country) {
      throw new Error('EU_ECOLABEL_COUNTRY_REQUIRED');
    }
    const organizationName = typeof query.filters.organization_name === 'string'
      ? query.filters.organization_name.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ')
      : '';
    if (!isClearlyEuEcolabelOrganization(organizationName) || /[*?,;]/u.test(organizationName)) {
      throw new Error('EU_ECOLABEL_EXACT_ORGANIZATION_REQUIRED');
    }
    if (!this.deps?.broker) throw new Error('EU_ECOLABEL_BROKER_REQUIRED');

    if (!Number.isSafeInteger(query.limit) || query.limit <= 0) throw new Error('EU_ECOLABEL_LIMIT_INVALID');
    const limit = Math.min(Math.max(query.limit, 1), 20);
    const scope = fingerprint(organizationName, country.code);
    const offset = decodeCursor(opts?.cursor, scope);
    if (offset + limit > 100) throw new Error('EU_ECOLABEL_CURSOR_INVALID');
    const output = await this.deps.broker.invoke<EuEcolabelProductsSearchInput, EuEcolabelProductsSearchOutput>(
      'ec-env-data.ecolabel-products.search',
      { organizationName, country: country.sourceName, offset, limit },
      { ...ctx, purpose: 'discovery' },
    );
    if (!output.data || !Array.isArray(output.data.products) || output.data.products.length > limit) {
      throw new Error('EU_ECOLABEL_BROKER_RESULT_INVALID');
    }
    const provenance = requiredProvenance(output, organizationName, country.sourceName, offset, limit);
    output.data.products.forEach((item) => validateResult(item, organizationName, country.code));
    let nextCursor: string | undefined;
    if (output.data.nextCursor !== undefined) {
      const nextOffset = Number(output.data.nextCursor);
      if (!Number.isSafeInteger(nextOffset) || nextOffset !== offset + limit || nextOffset >= 100) {
        throw new Error('EU_ECOLABEL_CURSOR_INVALID');
      }
      nextCursor = encodeCursor(nextOffset, scope);
    }
    return {
      records: output.data.products.map((item) => ({
        externalId: `eu-ecolabel:${encodeURIComponent(item.licenceNumber)}:${item.itemId}`,
        name: item.licenceHolder,
        country: item.licenceHolderCountryCode,
        industry: item.groupName,
        attributes: {
          eu_ecolabel: {
            licence_number: item.licenceNumber,
            expiration_date: item.expirationDate,
            decision: item.decision,
            product_group: item.groupName,
            item_id: item.itemId,
            product_name: item.productName,
            licence_holder_country_source: item.licenceHolderCountry,
            country_normalization: 'bounded-eea-country-map-v1',
            certification_scope: 'product_award_not_organization_certification',
            completeness_disclaimer: 'ECAT is licence-holder maintained and may be non-exhaustive.',
            source_accuracy_disclaimer: 'Catalogue facts are supplied by licence holders and remain subject to official verification and correction.',
            transformation_notice: 'Organization/product-award projection normalized by global-backend; VAT, phone, email, exact address, coordinates, images, GTIN and unknown upstream fields are excluded.',
            rights_notice: 'European Commission reuse terms require attribution and change indication; no trademark, logo, endorsement, or certification right is granted.',
          },
        },
        license: 'EC-REUSE-CC-BY-4.0',
        provenance,
      })),
      costCents: output.costCents,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
}
