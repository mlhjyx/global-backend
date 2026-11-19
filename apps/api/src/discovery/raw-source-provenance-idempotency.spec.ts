import { describe, expect, it } from 'vitest';
import { mapNoticeToRecords } from './providers/ted.provider';
import { mapOsmPlaceToRecord } from './providers/osm.provider';
import { validateRawSourceProviderPayload } from './raw-source-provider-schema';

const NOW = '2026-11-19T00:00:00.000Z';
const fixtures = {
  ted: () => mapNoticeToRecords({
    publicationNumber: '123456789-2026', publicationDate: '2026-11-19', noticeType: 'can-standard',
    cpvCodes: ['42122000'], buyerNames: ['Fixture Municipality'], buyerCountries: ['DEU'],
    winners: [{ name: 'Fixture Pump Company', country: 'NLD', identifier: 'NL-REG-ALPHA' }],
  }, NOW)[0]!,
  openstreetmap: () => mapOsmPlaceToRecord({
    place: { osmId: 'node/12345678901234567890', name: 'Fixture Pump Company',
      countryCode: 'DE', latitude: 52, longitude: 13, tags: { industrial: 'factory' } },
    sourceClass: 'industry_data', fetchedAt: NOW,
  }),
};
const canonical = {
  ted: 'https://api.ted.europa.eu/v3/notices/search',
  openstreetmap: 'https://overpass-api.de/api/interpreter',
};

for (const provider of ['ted', 'openstreetmap'] as const) {
  describe(`${provider} source provenance round-trip`, () => {
    it('accepts its own normalized payload without losing source facts', () => {
      const first = validateRawSourceProviderPayload(provider, fixtures[provider]());
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('fixture invalid');
      expect((first.value.provenance as Record<string, unknown>).sourceUrl).toBe(canonical[provider]);
      expect(validateRawSourceProviderPayload(provider, first.value)).toEqual(first);
    });

    it('accepts the exact canonical endpoint with the original identity binding', () => {
      const input = fixtures[provider]();
      input.provenance!.sourceUrl = canonical[provider];
      expect(validateRawSourceProviderPayload(provider, input).ok).toBe(true);
    });

    it.each([
      (url: string) => url.replace('https://', 'https://user:password@'),
      (url: string) => `${url}?page=1`,
      (url: string) => `${url}#section`,
      (url: string) => url.replace('https://', 'http://'),
      (url: string) => url.replace(/(https:\/\/[^/]+)/u, '$1:8443'),
      (url: string) => url.replace(/(https:\/\/[^/]+)/u, '$1.evil.example'),
      (url: string) => `${url}/extra`,
    ])('rejects dangerous canonical URLs before replacing them', (change) => {
      const input = fixtures[provider]();
      input.provenance!.sourceUrl = change(canonical[provider]);
      expect(validateRawSourceProviderPayload(provider, input).ok).toBe(false);
    });

    it.each(['?page=1', '#section', '?', '#'])('rejects unsafe original page suffix %s', (suffix) => {
      const input = fixtures[provider]();
      input.provenance!.sourceUrl += suffix;
      expect(validateRawSourceProviderPayload(provider, input).ok).toBe(false);
    });

    it.each(['user:password@', '@'])('rejects credentials in the original page before normalization', (credentials) => {
      const input = fixtures[provider]();
      input.provenance!.sourceUrl = input.provenance!.sourceUrl.replace('https://', `https://${credentials}`);
      expect(validateRawSourceProviderPayload(provider, input).ok).toBe(false);
    });

    it('keeps the record identity binding on canonical input', () => {
      const input = fixtures[provider]();
      input.provenance!.sourceUrl = canonical[provider];
      input.externalId = provider === 'ted' ? 'ted:654321-2026:0' : 'osm:node/654321';
      expect(validateRawSourceProviderPayload(provider, input).ok).toBe(false);
    });
  });
}
