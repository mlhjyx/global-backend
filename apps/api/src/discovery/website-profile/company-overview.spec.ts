import { describe, expect, it, vi } from 'vitest';
import { companyWebsiteDisplayAllowed, prepareCompanyOverviewPage, extractCompanyWebsiteOverview } from './company-overview';

const APPROVED = {
  sourceType: 'official_website',
  reviewStatus: 'APPROVED',
  termsStatus: 'REVIEWED_OK',
  allowedPurpose: ['enrichment'],
  allowedPaths: ['/products'],
  disallowedPaths: ['/products/internal'],
};
type GateDb = Parameters<typeof companyWebsiteDisplayAllowed>[0];

function gate(rows: unknown[], resultUrl = 'https://www.buyer-firm.de/products/pumps') {
  const findMany = vi.fn(async () => rows);
  return companyWebsiteDisplayAllowed({ sourcePolicy: { findMany } } as unknown as GateDb, resultUrl);
}

describe('first-party company overview', () => {
  it('requires an explicit reviewed website for the observed URL and respects both host variants', async () => {
    expect(await gate([APPROVED])).toBe(true);
    expect(await gate([])).toBe(false);
    expect(await gate([{ ...APPROVED, termsStatus: 'REVIEWED_RESTRICTED' }])).toBe(false);
    expect(await gate([{ ...APPROVED, allowedPurpose: ['discovery'] }])).toBe(false);
    expect(await gate([APPROVED, { ...APPROVED, reviewStatus: 'SUSPENDED' }])).toBe(false);
    expect(await gate([APPROVED], 'https://www.buyer-firm.de/about')).toBe(false);
    expect(await gate([APPROVED], 'https://www.buyer-firm.de/products/internal')).toBe(false);
    expect(await gate([APPROVED], 'https://www.buyer-firm.de/products/pumps?token=hidden')).toBe(false);
  });

  it('drops human contact or instructions inside even exact matches', () => {
    const page = prepareCompanyOverviewPage({
      url: 'https://buyer-firm.de/',
      text: 'Managing director John Doe has a published bio. Contact person Jane Doe. Industrial pumps.',
      fetchedAt: '2026-11-27T08:57:00.000Z',
    }, 'buyer-firm.de');
    const output = extractCompanyWebsiteOverview({
      description: 'Managing director John Doe has a published bio.',
      main_business: ['Contact person Jane Doe', 'Industrial pumps'],
    }, page);
    expect(output).toEqual({
      description: null,
      main_business: ['Industrial pumps'],
      source_url: 'https://buyer-firm.de/',
      fetched_at: '2026-11-27T08:57:00.000Z',
    });
  });
});
