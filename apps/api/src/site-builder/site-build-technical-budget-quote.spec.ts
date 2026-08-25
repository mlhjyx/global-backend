import { describe, expect, it, vi } from 'vitest';
import { intakeRequestHash, type IntakeInput } from './intake.service';
import {
  SiteBuildTechnicalBudgetQuoteService,
  type TechnicalBudgetRoute,
} from './site-build-technical-budget-quote';
import { buildRequestHash, normalizeBuildRequest } from './build-request-contract';

const NOW = new Date('2026-08-26T00:00:00.000Z');
const SITE_ID = 'c9db2194-82b8-4a53-b328-a19d0d3b216e';

const INTAKE: IntakeInput = {
  company: { nameZh: '阿尔法泵业', nameEn: 'Alpha Pumps' },
  industry: 'isic-2813',
  products: ['industrial pump'],
  targetMarkets: ['DE'],
  hasWebsite: false,
  websiteUrl: null,
  businessEmail: 'sales@example.test',
};

const ROUTES: Record<string, TechnicalBudgetRoute> = {
  'site_builder.brand_profile': {
    primary: 'gpt-5.6-terra',
    fallbacks: ['claude-sonnet-5'],
    maxCostCents: 40,
    maxTokens: 12_000,
  },
  'site_builder.copy': {
    primary: 'claude-sonnet-5',
    fallbacks: [],
    maxCostCents: 20,
    maxTokens: 4_000,
  },
};

function service(
  routeOverrides: Partial<Record<string, TechnicalBudgetRoute>> = {},
): SiteBuildTechnicalBudgetQuoteService {
  return new SiteBuildTechnicalBudgetQuoteService({}, {
    now: () => NOW,
    resolveRoute: (taskId) => routeOverrides[taskId] ?? ROUTES[taskId]!,
  });
}

describe('SiteBuildTechnicalBudgetQuoteService', () => {
  it('quotes deterministic intake with the canonical request hash and no commercial amount', () => {
    const quote = service().quoteIntake(intakeRequestHash(INTAKE));

    expect(quote).toEqual({
      schemaVersion: 'site-builder-technical-budget-quote/v1',
      operation: 'intake',
      siteId: null,
      requestSha256: intakeRequestHash(INTAKE),
      currency: 'USD',
      unit: 'microusd',
      requiredCapMicrousd: '1',
      policyRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
      expiresAt: '2026-08-26T00:05:00.000Z',
    });
  });

  it('derives refurbish cap from route fallbacks, one repair wire, Temporal retry and locale fan-out', () => {
    const request = normalizeBuildRequest({ scope: 'site' });
    const quote = service().quoteRefurbish(
      SITE_ID,
      buildRequestHash(SITE_ID, request),
    );

    // brand model: 2 routes * 2 wires * 40 cents * 2 Activity attempts = 320 cents
    // research tools: (crawl4ai 1 cent + searxng 0) * 2 Activity attempts = 2 cents
    // copy model: 2 locales * 1 route * 2 wires * 20 cents * 2 Activity attempts = 160 cents
    expect(quote.requiredCapMicrousd).toBe('4820000');
    expect(quote).toMatchObject({
      operation: 'refurbish',
      siteId: SITE_ID,
      requestSha256: buildRequestHash(SITE_ID, request),
      expiresAt: '2026-08-26T00:05:00.000Z',
    });
    expect(quote.policyRevision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes policy revision and cap when the approved route envelope changes', () => {
    const requestHash = buildRequestHash(
      SITE_ID,
      normalizeBuildRequest({ scope: 'site' }),
    );
    const current = service().quoteRefurbish(SITE_ID, requestHash);
    const expanded = service({
      'site_builder.copy': {
        ...ROUTES['site_builder.copy']!,
        fallbacks: ['copy-fallback'],
      },
    }).quoteRefurbish(SITE_ID, requestHash);

    expect(expanded.requiredCapMicrousd).toBe('6420000');
    expect(expanded.policyRevision).not.toBe(current.policyRevision);
  });

  it.each([
    ['missing route', () => undefined as never],
    [
      'too many route aliases',
      () => ({
        ...ROUTES['site_builder.brand_profile']!,
        fallbacks: ['a', 'b', 'c', 'd'],
      }),
    ],
    [
      'non-canonical cost ceiling',
      () => ({ ...ROUTES['site_builder.brand_profile']!, maxCostCents: 0 }),
    ],
  ])('fails closed when %s makes the technical envelope unprovable', (_name, brandRoute) => {
    const quoteService = new SiteBuildTechnicalBudgetQuoteService({}, {
      now: () => NOW,
      resolveRoute: (taskId) =>
        taskId === 'site_builder.brand_profile'
          ? brandRoute()
          : ROUTES[taskId]!,
    });

    expect(() =>
      quoteService.quoteRefurbish(
        SITE_ID,
        buildRequestHash(SITE_ID, normalizeBuildRequest({ scope: 'site' })),
      ),
    ).toThrow('SITE_BUILD_BUDGET_QUOTE_UNAVAILABLE');
  });

  it('does not perform database, workflow, provider or network calls', () => {
    const resolveRoute = vi.fn((taskId: string) => ROUTES[taskId]!);
    const quoteService = new SiteBuildTechnicalBudgetQuoteService({}, {
      now: () => NOW,
      resolveRoute,
    });

    quoteService.quoteRefurbish(
      SITE_ID,
      buildRequestHash(SITE_ID, normalizeBuildRequest({ scope: 'site' })),
    );

    expect(resolveRoute).toHaveBeenCalledTimes(2);
  });
});
