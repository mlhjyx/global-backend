import { describe, expect, it, vi } from 'vitest';
import {
  isClearlyEuEcolabelOrganization,
  normalizeEuEcolabelCountry,
  parseEuEcolabelProductsResponse,
  searchEuEcolabelProducts,
} from './eu-ecolabel';
import type { PublicHttpRequestOptions, PublicHttpResponse } from './guarded-http';

const safeRow = {
  licence_number: 'AT/004/001',
  expiration_date: '2028-12-31T00:00:00',
  decision: '(EU) 2019/70',
  group_name: 'Tissue Paper and Tissue Products',
  licence_holder: 'Hagleitner Hygiene International GmbH',
  licence_holder_country: 'Austria',
  item_id: 124717,
  product_name: 'multiROLL handTUCH X2.2 L',
  licence_holder_vat: 'MUST_NOT_SURVIVE',
  service_email: 'private@example.test',
  service_phone: '+43 000 000',
  service_street: 'MUST_NOT_SURVIVE',
  unknown: 'SECRET_UNKNOWN_FIELD',
};

function apiResponse(data: unknown[], offset = 0, limit = 10, total = data.length) {
  return {
    data,
    meta: { total, count: data.length, offset, limit },
    criteria: {
      selected_fields: [
        'licence_number', 'expiration_date', 'decision', 'group_name',
        'licence_holder', 'licence_holder_country', 'item_id', 'product_name',
      ],
      filters: [],
      grouped_by: [],
      aggregated_with: null,
      ordered_by: [
        { field: 'licence_number', direction: 'asc' },
        { field: 'item_id', direction: 'asc' },
      ],
    },
  };
}

function response(value: unknown, finalUrl: string): PublicHttpResponse {
  const body = Buffer.from(JSON.stringify(value));
  return { status: 200, ok: true, headers: { 'content-type': 'application/json' }, body, text: body.toString(), finalUrl };
}

describe('European Commission EU Ecolabel adapter', () => {
  it('accepts only clearly organizational licence holders', () => {
    expect(isClearlyEuEcolabelOrganization('Hagleitner Hygiene International GmbH')).toBe(true);
    expect(isClearlyEuEcolabelOrganization('ACME S.A.')).toBe(true);
    expect(isClearlyEuEcolabelOrganization('University of Example')).toBe(true);
    expect(isClearlyEuEcolabelOrganization('John Smith')).toBe(false);
    expect(isClearlyEuEcolabelOrganization('all')).toBe(false);
    expect(normalizeEuEcolabelCountry('Austria')).toEqual({ code: 'AT', sourceName: 'Austria' });
    expect(normalizeEuEcolabelCountry('AT')).toEqual({ code: 'AT', sourceName: 'Austria' });
    expect(normalizeEuEcolabelCountry('Canada')).toBeUndefined();
  });

  it('projects only organization, product, and award fields and drops VAT/contact/address/unknown fields', () => {
    const parsed = parseEuEcolabelProductsResponse(apiResponse([
      safeRow,
      { ...safeRow, licence_number: 'AT/004/002', item_id: 124718, licence_holder: 'John Smith' },
    ], 0, 10, 2), 0, 10);
    expect(parsed).toEqual({
      total: 2,
      records: [{
        licenceNumber: 'AT/004/001',
        expirationDate: '2028-12-31T00:00:00',
        decision: '(EU) 2019/70',
        groupName: 'Tissue Paper and Tissue Products',
        licenceHolder: 'Hagleitner Hygiene International GmbH',
        licenceHolderCountry: 'Austria',
        licenceHolderCountryCode: 'AT',
        itemId: '124717',
        productName: 'multiROLL handTUCH X2.2 L',
      }],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/MUST_NOT_SURVIVE|private@example|service_phone|SECRET_UNKNOWN_FIELD|licence_holder_vat/iu);
  });

  it('uses only the current v2 API, exact holder/country filters, and a safe field allowlist', async () => {
    const request = vi.fn(async (raw: string, options?: PublicHttpRequestOptions) => {
      const url = new URL(raw);
      expect(url.origin).toBe('https://apps.data.env.service.ec.europa.eu');
      expect(url.pathname).toBe('/dataquery/v2/ecolabel/products');
      expect(url.searchParams.get('licence_holder')).toBe('Hagleitner Hygiene International GmbH');
      expect(url.searchParams.get('licence_holder_country')).toBe('Austria');
      expect(url.searchParams.get('offset')).toBe('0');
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.get('fields')).not.toMatch(/vat|email|phone|street|postal|longitude|latitude/iu);
      expect(options).toMatchObject({ maxRedirects: 0, maxBytes: 2 * 1024 * 1024 });
      return response(apiResponse([safeRow], 0, 10, 11), raw);
    });
    const page = await searchEuEcolabelProducts({
      organizationName: 'Hagleitner Hygiene International GmbH', country: 'Austria', offset: 0, limit: 10,
    }, undefined, { request: request as never });
    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toBe('10');
    expect(page.provenance.parserVersion).toBe('ec-env-data-ecolabel-products-v2/1');
  });

  it('fails before egress for broad/non-organizational queries, missing country, or bulk page bounds', async () => {
    const request = vi.fn();
    for (const input of [
      { organizationName: 'all', country: 'Austria', offset: 0, limit: 10 },
      { organizationName: 'John Smith', country: 'Austria', offset: 0, limit: 10 },
      { organizationName: 'ACME GmbH', country: '', offset: 0, limit: 10 },
      { organizationName: 'ACME GmbH', country: 'Austria', offset: -1, limit: 10 },
      { organizationName: 'ACME GmbH', country: 'Austria', offset: 0, limit: 21 },
      { organizationName: 'ACME GmbH', country: 'Austria', offset: 90, limit: 20 },
    ]) {
      await expect(searchEuEcolabelProducts(input, undefined, { request })).rejects.toThrow(/EU_ECOLABEL_(?:EXACT_ORGANIZATION_REQUIRED|COUNTRY_REQUIRED|PAGE_INVALID)/u);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed on v2 response metadata drift', () => {
    expect(() => parseEuEcolabelProductsResponse(apiResponse([safeRow], 10, 10, 11), 0, 10)).toThrow('EU_ECOLABEL_SCHEMA_CHANGED');
    expect(() => parseEuEcolabelProductsResponse({ data: [safeRow], meta: { total: 1 } }, 0, 10)).toThrow('EU_ECOLABEL_SCHEMA_CHANGED');
  });
});
