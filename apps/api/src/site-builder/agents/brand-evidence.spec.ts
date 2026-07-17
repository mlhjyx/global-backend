import { describe, expect, it } from 'vitest';
import { prepareBrandEvidenceSources } from './brand-evidence';

const BASE = {
  siteId: '11111111-1111-4111-8111-111111111111',
  profileVersionId: '22222222-2222-4222-8222-222222222222',
  intake: {
    company: { nameZh: '艾克米', nameEn: 'Acme' },
    industry: 'industrial pumps',
    products: ['centrifugal pumps'],
    targetMarkets: ['DE'],
    hasWebsite: true,
    websiteUrl: 'https://acme.example',
    businessEmail: 'private@example.com',
  },
  profile: undefined,
};

describe('prepareBrandEvidenceSources — immutable metadata minimization', () => {
  it('scrubs KB titles and drops third-party search titles before freezing provenance', () => {
    const prepared = prepareBrandEvidenceSources({
      ...BASE,
      kb: [
        {
          source: 'upload',
          title: 'Catalog alice@example.com',
          text: 'Pumps up to 400 bar.',
          documentId: '33333333-3333-4333-8333-333333333333',
          assetId: null,
          upstreamContentHash: null,
          chunks: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              seq: 0,
              textHash: 'a'.repeat(64),
            },
          ],
        },
      ],
      research: [
        {
          sourceType: 'web_research',
          sourceRole: 'research_hint',
          url: 'https://directory.example/acme',
          title: `Call +49 30 1234567 ${'x'.repeat(600)}`,
          content: 'Acme exhibited at Pump Expo.',
          fetchedAt: '2026-07-17T00:00:00.000Z',
          upstreamContentHash: 'b'.repeat(64),
          parserVersion: 'searxng-snippet/1',
        },
      ],
    });

    expect(prepared.kb[0].provenance.title).toBe(
      'Catalog [redacted-email]',
    );
    expect(prepared.research[0].provenance).not.toHaveProperty('title');
    expect(prepared.research[0].provenance.kind).toBe('search_origin_hint');
  });
});
