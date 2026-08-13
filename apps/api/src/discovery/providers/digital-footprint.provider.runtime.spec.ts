import { resolveMx } from 'node:dns/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowedByRobots } from '../../adapters/robots';
import {
  classifyMxProvider,
  DigitalFootprintProvider,
  extractJsonLd,
} from './digital-footprint.provider';

vi.mock('node:dns/promises', () => ({ resolveMx: vi.fn() }));
vi.mock('../../adapters/robots', () => ({ isAllowedByRobots: vi.fn() }));

const ctx = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: 'run-1',
  correlationId: 'company-1',
  authorizeExternalAction: vi.fn(async () => true),
};

describe('DigitalFootprintProvider runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAllowedByRobots).mockResolvedValue(true);
  });

  it('fails closed for missing input, broker, robots permission, failed/blocked/short rendering', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const noBroker = new DigitalFootprintProvider();
    await expect(noBroker.enrichCompany({ name: 'No domain' }, ctx)).resolves.toMatchObject({ matched: false });
    await expect(noBroker.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx)).resolves.toMatchObject({ matched: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broker unavailable'));
    warn.mockRestore();

    vi.mocked(isAllowedByRobots).mockResolvedValueOnce(false);
    const never = { invoke: vi.fn() };
    await expect(new DigitalFootprintProvider({ broker: never as any }).enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx))
      .resolves.toMatchObject({ matched: false });
    expect(never.invoke).not.toHaveBeenCalled();

    for (const result of [
      Promise.reject(new Error('render failed')),
      Promise.resolve({ data: { html: 'x'.repeat(300), robotsBlocked: true }, costCents: 0 }),
      Promise.resolve({ data: { html: 'short', headers: {} }, costCents: 0 }),
    ]) {
      const broker = { invoke: vi.fn(() => result) };
      await expect(new DigitalFootprintProvider({ broker: broker as any }).enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx))
        .resolves.toMatchObject({ matched: false });
    }
  });

  it('extracts structured facts, ad intent, platforms, markets, jobs, and MX provider', async () => {
    vi.mocked(resolveMx).mockResolvedValue([{ exchange: 'aspmx.l.google.com', priority: 10 }]);
    const html = `${'x'.repeat(220)}
      <script src="https://connect.facebook.net/en_US/fbevents.js"></script>
      <script src="https://www.googletagmanager.com/gtm.js"></script>
      <script src="https://cdn.shopify.com/theme.js"></script>
      <link hreflang="de-DE"><link hreflang="en-US">
      <script type="application/ld+json">${JSON.stringify({
        '@graph': [
          {
            '@type': 'Organization',
            name: 'Pump GmbH',
            url: 'https://pump.example',
            foundingDate: '1999',
            numberOfEmployees: { value: 'about 42 people' },
            address: { addressCountry: 'DE' },
            sameAs: Array.from({ length: 10 }, (_, index) => `https://social.example/${index}`),
          },
          { '@type': 'Product', name: 'Centrifugal Pump' },
          { '@type': 'Product', name: 'Centrifugal Pump' },
          { '@type': 'JobPosting', title: 'Strategic Buyer', datePosted: '2026-08-01' },
        ],
      })}</script>`;
    const broker = {
      invoke: vi.fn(async () => ({ data: { html, headers: { 'x-shopify-shop-api-call-limit': '1/40' } }, costCents: 0 })),
    };
    const provider = new DigitalFootprintProvider({ broker: broker as any });

    const result = await provider.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx);

    expect(result).toMatchObject({
      matched: true,
      confidence: 1,
      attributes: {
        tech_platform: ['shopify'],
        ad_pixels: ['meta_pixel', 'google_tag_manager'],
        is_advertiser: true,
        served_markets: ['DE', 'US'],
        served_langs: ['de', 'en'],
        hiring_signal: { open_roles: 1, titles: ['Strategic Buyer'] },
        structured_org: {
          name: 'Pump GmbH',
          url: 'https://pump.example',
          founding_date: '1999',
          employees: 42,
          country: 'DE',
        },
        structured_products: ['Centrifugal Pump'],
        email_provider: 'google_workspace',
      },
      costCents: 0,
    });
    expect(result.provenance?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(broker.invoke).toHaveBeenCalledWith(
      'crawl4ai.render',
      { url: 'https://pump.example/' },
      ctx,
    );
  });

  it('returns a miss when a full page has no attributable facts', async () => {
    vi.mocked(resolveMx).mockResolvedValue([]);
    const broker = { invoke: vi.fn(async () => ({ data: { html: 'plain text '.repeat(30), headers: {} }, costCents: 0 })) };
    const provider = new DigitalFootprintProvider({ broker: broker as any });
    await expect(provider.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx)).resolves.toMatchObject({
      matched: false,
      attributes: {},
    });
  });

  it('tolerates robots and MX resolver failures conservatively', async () => {
    vi.mocked(isAllowedByRobots).mockRejectedValueOnce(new Error('robots unavailable'));
    const broker = {
      invoke: vi.fn(async () => ({
        data: { html: `${'x'.repeat(220)}<script src="https://static.wixstatic.com/site.js"></script>`, headers: {} },
        costCents: 0,
      })),
    };
    const provider = new DigitalFootprintProvider({ broker: broker as any });
    await expect(provider.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx)).resolves.toMatchObject({
      matched: false,
      attributes: {},
    });
    expect(broker.invoke).not.toHaveBeenCalled();

    vi.mocked(isAllowedByRobots).mockResolvedValueOnce(true);
    vi.mocked(resolveMx).mockRejectedValueOnce(new Error('dns unavailable'));
    await expect(provider.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx)).resolves.toMatchObject({
      matched: true,
      attributes: { tech_platform: ['wix'] },
    });
  });
});

describe('digital-footprint edge parsing and MX classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.authorizeExternalAction.mockResolvedValue(true);
  });

  it('accepts top-level JSON-LD arrays and ignores primitive graph members', () => {
    const facts = extractJsonLd(`<script type="application/ld+json">${JSON.stringify([
      null,
      'text',
      { '@type': ['Corporation', 'Organization'], name: 'First', numberOfEmployees: 12 },
      { '@type': 'Organization', name: 'Ignored second org' },
      { '@type': 'Product', name: ' ' },
      { '@type': 'JobPosting', title: ' ' },
    ])}</script>`);
    expect(facts.organization).toMatchObject({ name: 'First', employees: 12 });
    expect(facts.products).toEqual([]);
    expect(facts.jobPostings).toEqual([]);
  });

  it.each([
    ['aspmx.l.google.com', 'google_workspace'],
    ['tenant.protection.outlook.com', 'microsoft_365'],
    ['mx.pphosted.com', 'proofpoint'],
    ['eu.mimecast.com', 'mimecast'],
    ['smtp.secureserver.net', 'godaddy'],
    ['mx.zoho.com', 'zoho'],
    ['mx.barracuda.com', 'barracuda'],
    ['mail.pump.example', 'other_or_self_hosted'],
  ])('classifies %s as %s', async (exchange, expected) => {
    vi.mocked(resolveMx).mockResolvedValueOnce([{ exchange, priority: 10 }]);
    await expect(classifyMxProvider('pump.example', ctx)).resolves.toBe(expected);
  });

  it('returns undefined for empty or failed MX resolution', async () => {
    vi.mocked(resolveMx).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('dns'));
    await expect(classifyMxProvider('pump.example', ctx)).resolves.toBeUndefined();
    await expect(classifyMxProvider('pump.example', ctx)).resolves.toBeUndefined();
  });
});
