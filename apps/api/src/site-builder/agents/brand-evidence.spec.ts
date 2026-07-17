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

  it('sanitizes the intake website URL before it enters the immutable corpus', () => {
    const prepared = prepareBrandEvidenceSources({
      ...BASE,
      intake: {
        ...BASE.intake,
        websiteUrl:
          'https://alice:secret@acme.example/private/alice@example.com?token=top-secret&contact=alice@example.com#Jane-Smith',
      },
      kb: [],
      research: [],
    });

    expect(prepared.intake.snapshotText).not.toMatch(
      /alice:secret|top-secret|alice@example\.com|Jane-Smith/,
    );
    expect(prepared.intake.snapshotText).toContain('https://acme.example/');
    expect(prepared.intake.snapshotText).toContain('token=%5Bredacted%5D');
  });

  it('re-minimizes direct web research inputs at the persistence boundary', () => {
    const prepared = prepareBrandEvidenceSources({
      ...BASE,
      kb: [],
      research: [
        {
          sourceType: 'web_research',
          sourceRole: 'research_hint',
          url: 'https://news.example/people/jane-smith?author=Jane+Smith',
          title: 'CEO Jane Smith',
          content: 'CEO Jane Smith announced a private acquisition.',
          fetchedAt: '2026-07-17T00:00:00.000Z',
          upstreamContentHash: 'c'.repeat(64),
          parserVersion: 'legacy-searxng-snippet/1',
        },
      ],
    });

    expect(prepared.research[0].displayUrl).toBe('https://news.example/');
    expect(prepared.research[0].snapshotText).not.toMatch(
      /Jane Smith|CEO|private acquisition/i,
    );
    expect(prepared.research[0].snapshotText).toContain('Acme');
    expect(prepared.research[0].provenance).not.toHaveProperty('title');
  });

  it('does not re-freeze legacy web-research KB bodies with unbounded third-party data', () => {
    const prepared = prepareBrandEvidenceSources({
      ...BASE,
      kb: [
        {
          source: 'web_research',
          title: 'CEO Jane Smith',
          text: 'CEO Jane Smith announced a private acquisition.',
          documentId: '55555555-5555-4555-8555-555555555555',
          assetId: null,
          upstreamContentHash: 'd'.repeat(64),
          chunks: [
            {
              id: '66666666-6666-4666-8666-666666666666',
              seq: 0,
              textHash: 'e'.repeat(64),
            },
          ],
        },
        {
          source: 'upload',
          title: 'catalog.pdf',
          text: 'Acme pumps support 400 bar.',
          documentId: '77777777-7777-4777-8777-777777777777',
          assetId: null,
          upstreamContentHash: null,
          chunks: [
            {
              id: '88888888-8888-4888-8888-888888888888',
              seq: 0,
              textHash: 'f'.repeat(64),
            },
          ],
        },
      ],
      research: [],
    });

    expect(prepared.kb).toHaveLength(1);
    expect(prepared.kb[0].sourceType).toBe('upload');
    expect(prepared.kb[0].snapshotText).not.toContain('Jane Smith');
  });
});
