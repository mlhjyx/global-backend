import { describe, expect, it, vi } from 'vitest';
import {
  isClearlyFmcsaOrganization,
  normalizeUsdotNumber,
  parseFmcsaQcmobileResponse,
  searchFmcsaQcmobile,
} from './fmcsa-qcmobile';
import type { PublicHttpRequestOptions, PublicHttpResponse } from './guarded-http';

const legalCarrier = {
  dotNumber: 1234567,
  legalName: 'ACME LOGISTICS LLC',
  dbaName: 'ACME FREIGHT',
  allowToOperate: 'Y',
  outOfService: 'N',
  phyCountry: 'US',
  phyState: 'TX',
  phyCity: 'Austin',
  phyStreet: 'MUST_NOT_SURVIVE',
  phyZipcode: '78701',
  telephone: '555-0100',
  emailAddress: 'private@example.test',
  unknown: 'SECRET_UNKNOWN_FIELD',
};

function response(value: unknown, finalUrl: string): PublicHttpResponse {
  const body = Buffer.from(JSON.stringify(value));
  return { status: 200, ok: true, headers: { 'content-type': 'application/json' }, body, text: body.toString(), finalUrl };
}

describe('FMCSA QCMobile official adapter', () => {
  it('accepts only bounded source-native USDOT numbers without claiming a checksum', () => {
    expect(normalizeUsdotNumber(1234567)).toBe('1234567');
    expect(normalizeUsdotNumber(' 12345678 ')).toBe('12345678');
    expect(normalizeUsdotNumber('0000000')).toBeUndefined();
    expect(normalizeUsdotNumber('01234567')).toBeUndefined();
    expect(normalizeUsdotNumber('123-456')).toBeUndefined();
    expect(normalizeUsdotNumber('123456789')).toBeUndefined();
  });

  it('admits clearly organizational carriers and structurally drops contact and precise-address fields', () => {
    expect(isClearlyFmcsaOrganization('ACME LOGISTICS LLC')).toBe(true);
    expect(isClearlyFmcsaOrganization('CITY OF AUSTIN')).toBe(true);
    expect(isClearlyFmcsaOrganization('JOHN SMITH')).toBe(false);
    expect(isClearlyFmcsaOrganization('JOHN SMITH CO')).toBe(false);
    expect(isClearlyFmcsaOrganization('JOHN SMITH COMPANY')).toBe(false);
    const records = parseFmcsaQcmobileResponse({ content: [
      { carrier: legalCarrier },
      { carrier: { ...legalCarrier, dotNumber: 1234568, legalName: 'JOHN SMITH' } },
      { carrier: { ...legalCarrier, dotNumber: 'bad' } },
    ] }, 10);
    expect(records).toEqual([{
      usdotNumber: '1234567',
      legalName: 'ACME LOGISTICS LLC',
      dbaName: 'ACME FREIGHT',
      allowedToOperate: 'Y',
      outOfService: 'N',
      state: 'TX',
    }]);
    expect(JSON.stringify(records)).not.toMatch(/private|telephone|email|street|zipcode|Austin|SECRET_UNKNOWN_FIELD|MUST_NOT_SURVIVE/iu);
  });

  it('uses a bounded name page and redacts WebKey from provenance', async () => {
    const webKey = 'secret-fmcsa-web-key';
    const request = vi.fn(async (raw: string, options?: PublicHttpRequestOptions) => {
      const url = new URL(raw);
      expect(url.pathname).toBe('/qc/services/carriers/name/ACME%20LOGISTICS%20LLC');
      expect(url.searchParams.get('start')).toBe('0');
      expect(url.searchParams.get('size')).toBe('2');
      expect(url.searchParams.get('webKey')).toBe(webKey);
      expect(options).toMatchObject({ maxRedirects: 0, maxBytes: 2 * 1024 * 1024 });
      return response({ content: [{ carrier: legalCarrier }] }, raw);
    });
    const page = await searchFmcsaQcmobile(
      { query: 'ACME LOGISTICS LLC', start: 0, limit: 2 },
      undefined,
      { request: request as never, env: { FMCSA_QCMOBILE_WEB_KEY: webKey } },
    );
    expect(page.records).toHaveLength(1);
    expect(page.provenance.sourceUrl).toContain('webKey=REDACTED');
    expect(JSON.stringify(page)).not.toContain(webKey);
  });

  it('hashes only the organization allowlist so discarded PII does not create drift', async () => {
    const webKey = 'secret-fmcsa-web-key';
    const makeRequest = (emailAddress: string) => vi.fn(async (raw: string) => response({
      content: [{ carrier: { ...legalCarrier, emailAddress } }],
    }, raw));
    const first = await searchFmcsaQcmobile(
      { query: 'ACME LOGISTICS LLC', start: 0, limit: 2 }, undefined,
      { request: makeRequest('first@example.test') as never, env: { FMCSA_QCMOBILE_WEB_KEY: webKey } },
    );
    const second = await searchFmcsaQcmobile(
      { query: 'ACME LOGISTICS LLC', start: 0, limit: 2 }, undefined,
      { request: makeRequest('second@example.test') as never, env: { FMCSA_QCMOBILE_WEB_KEY: webKey } },
    );
    expect(first.provenance.contentHash).toBe(second.provenance.contentHash);
  });

  it('fails before egress for missing credentials, broad terms, or invalid page bounds', async () => {
    const request = vi.fn();
    const valid = { query: 'ACME LOGISTICS LLC', start: 0, limit: 2 };
    await expect(searchFmcsaQcmobile(valid, undefined, { request, env: {} })).rejects.toThrow('FMCSA_WEB_KEY_REQUIRED');
    for (const input of [
      { ...valid, query: 'all' },
      { ...valid, query: 'logistics, freight' },
      { ...valid, start: -1 },
      { ...valid, limit: 11 },
      { ...valid, start: 49, limit: 2 },
    ]) {
      await expect(searchFmcsaQcmobile(input, undefined, {
        request, env: { FMCSA_QCMOBILE_WEB_KEY: 'key' },
      })).rejects.toThrow(/FMCSA_(?:EXACT_QUERY_REQUIRED|PAGE_INVALID)/u);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('returns a stable transport error without leaking WebKey', async () => {
    const webKey = 'secret-fmcsa-web-key';
    const request = vi.fn(async () => { throw new Error(`failed URL containing ${webKey}`); });
    let captured: unknown;
    try {
      await searchFmcsaQcmobile(
        { query: 'ACME LOGISTICS LLC', start: 0, limit: 2 }, undefined,
        { request: request as never, env: { FMCSA_QCMOBILE_WEB_KEY: webKey } },
      );
    } catch (error) {
      captured = error;
    }
    expect(String(captured)).toContain('FMCSA_REQUEST_FAILED');
    expect(String(captured)).not.toContain(webKey);
  });
});
