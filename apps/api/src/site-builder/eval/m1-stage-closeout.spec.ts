import { describe, expect, it } from 'vitest';
import type { SiteSpecV1_1 } from '@global/contracts';
import {
  evaluateM1CrossSiteGenericness,
  verifyM1GoldenSuite,
  type M1GoldenFixture,
} from './m1-stage-closeout';

function fixture(
  index: number,
  overrides: Partial<M1GoldenFixture> = {},
): M1GoldenFixture {
  const familyIndex = Math.floor(index / 2);
  const mode = index % 2 === 0 ? 'sparse' : 'rich';
  return {
    id: `family-${familyIndex}-${mode}`,
    familyId: `family-${familyIndex}`,
    mode,
    spec: {
      specVersion: '1.1.0',
      site: {
        name: 'Synthetic',
        slug: `synthetic-${index}`,
        locales: ['en'],
        defaultLocale: 'en',
        familyId: `family-${familyIndex}`,
        designBriefDigest: 'a'.repeat(64),
      },
      pages: [
        {
          id: 'home',
          path: '/',
          title: 'Home',
          seo: { titleKey: 'seo.title', descriptionKey: 'seo.description' },
          puck: {
            root: {},
            content: [
              {
                type: `Hero${familyIndex}-${mode}` as never,
                props: { id: `hero-${index}`, variant: 'technical-grid' },
              },
              {
                type: 'StatementBlock',
                props: { id: `statement-${index}` },
              },
            ],
          },
        },
      ],
      assets: {},
    } as SiteSpecV1_1,
    ...overrides,
  };
}

describe('M1-g stage closeout gates', () => {
  it('accepts six sparse/rich pairs with distinct structures and no facts', () => {
    const result = verifyM1GoldenSuite(
      Array.from({ length: 12 }, (_, index) => fixture(index)),
    );
    expect(result).toMatchObject({
      fixtureCount: 12,
      familyCount: 6,
      factSafetyFindingCount: 0,
    });
    expect(result.genericness.distinctHomeStructureCount).toBeGreaterThan(4);
  });

  it('rejects unsupported client, certification, and numeric literals', () => {
    const fixtures = Array.from({ length: 12 }, (_, index) => fixture(index));
    fixtures[0]!.spec.pages[0]!.puck.content.push({
      type: 'TrustSplit',
      props: {
        id: 'trust',
        stats: [{ value: 'ISO 9001', labelKey: 'trust.label' }],
        badges: ['Certified'],
      },
    } as never);
    expect(() => verifyM1GoldenSuite(fixtures)).toThrowError(
      /M1_G_UNSUPPORTED_FACT_LITERAL/,
    );
  });

  it('rejects fixture-only geography, product, and article metadata', () => {
    const fixtures = Array.from({ length: 12 }, (_, index) => fixture(index));
    fixtures[0]!.spec.pages[0]!.puck.content.push(
      {
        type: 'DispatchHero',
        props: { marqueeItems: ['North district', 'Harbor corridor'] },
      },
      {
        type: 'ProductShowcaseAlt',
        props: { products: [{ code: 'PX-24' }] },
      },
      {
        type: 'ArticleGrid',
        props: {
          items: [{ cat: 'Guides', readTime: '4 min read' }],
        },
      },
    ) as never;
    expect(() => verifyM1GoldenSuite(fixtures)).toThrowError(
      /M1_G_UNSUPPORTED_FACT_LITERAL/,
    );
  });

  it('rejects a ten-site batch that only changes identity and color', () => {
    const fixtures = Array.from({ length: 10 }, (_, index) => {
      const item = fixture(index);
      item.spec.pages[0]!.puck.content[0]!.type = 'HeroBanner';
      return item;
    });
    expect(() => evaluateM1CrossSiteGenericness(fixtures)).toThrowError(
      /M1_G_GENERICNESS_(STRUCTURE_COUNT|IDENTICAL_HOME)_FAILED/,
    );
  });

  it('rejects a home page dominated by card sections', () => {
    const fixtures = Array.from({ length: 10 }, (_, index) => fixture(index));
    fixtures[0]!.spec.pages[0]!.puck.content = [
      { type: 'HeroBanner', props: {} },
      { type: 'ProductGrid', props: {} },
      { type: 'FeatureCards', props: {} },
    ] as never;
    expect(() => evaluateM1CrossSiteGenericness(fixtures)).toThrowError(
      /M1_G_GENERICNESS_CARD_RATIO_FAILED/,
    );
  });
});
