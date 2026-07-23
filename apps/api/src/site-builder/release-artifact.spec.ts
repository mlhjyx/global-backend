import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SiteSpec } from '@global/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  R1_RENDERER_COMPONENT_TYPES,
  assertReleaseContract,
  buildReleaseArtifact,
  uploadReleaseArtifact,
} from './release-artifact';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function spec(
  types: readonly string[] = ['HeroBanner'],
  blockProps: Record<string, unknown> = { headlineKey: 'hero.headline' },
): SiteSpec {
  return {
    specVersion: '1.0.0',
    site: {
      defaultLocale: 'en',
      locales: ['en'],
      theme: { preset: 'precision-light' },
      nav: [{ labelKey: 'nav.home', pageId: 'home' }],
      seoGlobal: { siteName: 'Acme' },
    },
    pages: [
      {
        id: 'home',
        path: '/',
        puck: {
          root: {},
          content: types.map((type, index) => ({
            type,
            props: { id: `block-${index}`, ...blockProps },
          })),
        },
        seo: { titleKey: 'seo.title', descriptionKey: 'seo.description' },
      },
    ],
    assets: {},
    copyBundles: {
      en: {
        'nav.home': 'Home',
        'seo.title': 'Acme',
        'seo.description': 'Acme site',
      },
    },
  };
}

const identity = {
  releaseId: '50000000-0000-0000-0000-000000000001',
  workspaceId: '10000000-0000-0000-0000-000000000001',
  siteId: '20000000-0000-0000-0000-000000000001',
  siteVersionId: '40000000-0000-0000-0000-000000000001',
  buildRunId: '30000000-0000-0000-0000-000000000001',
  producerToken: '60000000-0000-0000-0000-000000000001',
  artifactPrefix:
    'sites/20000000-0000-0000-0000-000000000001/releases/50000000-0000-0000-0000-000000000001',
  releaseCreatedAt: new Date('2026-07-20T00:00:00.000Z'),
  buildIdentity: 'site-renderer@1.0.0+test',
};

describe('R1 release contract gate', () => {
  it('accepts only the current release-eligible component registry', () => {
    expect(R1_RENDERER_COMPONENT_TYPES).toEqual([
      'AboutBlock',
      'ArticleGrid',
      'AreaMarquee',
      'AreaGallery',
      'DishesShowcase',
      'EditorialHero',
      'CollectionCards',
      'ChapterShowcase',
      'FarmhouseHero',
      'FeaturedSpotlight',
      'LedgerStats',
      'CertWall',
      'CtaBanner',
      'CtaCenter',
      'FeatureCards',
      'FaqAccordion',
      'FaqSplit',
      'HeroBanner',
      'InquiryForm',
      'MapLocation',
      'MaterialsLibrary',
      'LogoMarquee',
      'MediaCta',
      'ProcessTimeline',
      'PricingTable',
      'PricingTiers',
      'ProcessSteps',
      'ProductGrid',
      'ProductShowcaseAlt',
      'ProjectsGrid',
      'PhotoGallery',
      'ServicesGrid',
      'ServicesDark',
      'ServiceRows',
      'SplitAbout',
      'StatsBand',
      'StatsCountup',
      'StatementBlock',
      'StoryChapters',
      'TechSystems',
      'Testimonials',
      'TrustSplit',
      'ValueStrip',
      'WarmHero',
      'DispatchHero',
      'ServicesEditorial',
      'DispatchTimeline',
      'CrewGrid',
      'CoverageMap',
    ]);
    expect(() =>
      assertReleaseContract(spec(['HeroBanner']), '1.0.0'),
    ).not.toThrow();
  });

  it('accepts a qualified gallery component', () => {
    expect(() => assertReleaseContract(spec(['AreaGallery'], {
      eyebrowKey: 'areas.eyebrow', titleKey: 'areas.title', titleAccentKey: 'areas.accent',
      areas: [{ name: 'North', noteKey: 'areas.north' }], variant: 'technical-grid',
    }), '1.0.0')).not.toThrow();
  });

  it('rejects a PricingTable CTA whose internal target page does not exist', () => {
    const pricing = spec(['PricingTable'], {
      eyebrowKey: 'pricing.eyebrow',
      titleKey: 'pricing.title',
      titleAccentKey: 'pricing.accent',
      introKey: 'pricing.intro',
      serviceColumnKey: 'pricing.serviceColumn',
      fromColumnKey: 'pricing.fromColumn',
      primaryCta: { labelKey: 'pricing.contact', pageId: 'missing' },
      rows: [
        {
          icon: 'ri-settings-line',
          serviceKey: 'pricing.service',
          noteKey: 'pricing.note',
          fromKey: 'pricing.from',
        },
      ],
      footnoteKey: 'pricing.footnote',
      variant: 'technical-grid',
    });

    expect(() => assertReleaseContract(pricing, '1.0.0')).toThrow(
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: PricingTable.primaryCta.pageId=missing',
    );
  });

  it.each([
    [
      'AreaGallery.allPageId',
      'AreaGallery',
      {
        eyebrowKey: 'areas.eyebrow', titleKey: 'areas.title', titleAccentKey: 'areas.accent',
        areas: [], allLabelKey: 'areas.all', allPageId: 'missing', variant: 'technical-grid',
      },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: AreaGallery.allPageId.pageId=missing',
    ],
    [
      'ProjectsGrid.allPageId',
      'ProjectsGrid',
      { titleKey: 'projects.title', items: [], allLabelKey: 'projects.all', allPageId: 'missing', variant: 'technical-grid' },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: ProjectsGrid.allPageId.pageId=missing',
    ],
    [
      'CollectionCards.allPageId',
      'CollectionCards',
      { eyebrowKey: 'collections.eyebrow', titleKey: 'collections.title', items: [], allPageId: 'missing', variant: 'technical-grid' },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: CollectionCards.allPageId.pageId=missing',
    ],
    [
      'MaterialsLibrary.defaultPageId',
      'MaterialsLibrary',
      {
        eyebrowKey: 'materials.eyebrow', titleKey: 'materials.title', titleAccentKey: 'materials.accent', introKey: 'materials.intro',
        items: [], ctaPrimaryLabelKey: 'materials.cta', ctaSecondaryLabelKey: 'materials.more',
      },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: MaterialsLibrary.ctaPrimaryPageId.pageId=contact',
    ],
    [
      'DishesShowcase.defaultPageId',
      'DishesShowcase',
      {
        eyebrowKey: 'dishes.eyebrow', titleKey: 'dishes.title', titleAccentKey: 'dishes.accent',
        dishes: [], variant: 'technical-grid',
      },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: DishesShowcase.addPageId.pageId=services',
    ],
    [
      'MaterialsLibrary.ctaPrimaryPageId',
      'MaterialsLibrary',
      {
        eyebrowKey: 'materials.eyebrow', titleKey: 'materials.title', titleAccentKey: 'materials.accent', introKey: 'materials.intro',
        items: [{ no: '01', nameKey: 'materials.one', weightKey: 'materials.weight', noteKey: 'materials.note' }],
        ctaPrimaryLabelKey: 'materials.cta', ctaSecondaryLabelKey: 'materials.more', ctaPrimaryPageId: 'missing',
      },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: MaterialsLibrary.ctaPrimaryPageId.pageId=missing',
    ],
    [
      'ProductShowcaseAlt.configureCta',
      'ProductShowcaseAlt',
      {
        chapterKey: 'product.chapter', titleKey: 'product.title', titleAccentKey: 'product.accent', introKey: 'product.intro',
        products: [{ code: 'PX', nameKey: 'product.name', taglineKey: 'product.tagline', capacityKey: 'product.capacity', weightKey: 'product.weight', cyclesKey: 'product.cycles', priceKey: 'product.price' }],
        configureCta: { labelKey: 'product.cta', pageId: 'missing' }, variant: 'technical-grid',
      },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: ProductShowcaseAlt.configureCta.pageId=missing',
    ],
    [
      'CtaCenter.primaryCta',
      'CtaCenter',
      {
        eyebrowKey: 'cta.eyebrow',
        titleKey: 'cta.title',
        subtitleKey: 'cta.subtitle',
        primaryCta: { labelKey: 'cta.primary', pageId: 'missing' },
      },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: CtaCenter.primaryCta.pageId=missing',
    ],
    [
      'CtaCenter.secondaryCta',
      'CtaCenter',
      {
        eyebrowKey: 'cta.eyebrow',
        titleKey: 'cta.title',
        subtitleKey: 'cta.subtitle',
        primaryCta: { labelKey: 'cta.primary', pageId: 'home' },
        secondaryCta: { labelKey: 'cta.secondary', pageId: 'missing' },
      },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: CtaCenter.secondaryCta.pageId=missing',
    ],
    [
      'ServicesDark.allCta',
      'ServicesDark',
      {
        eyebrowKey: 'services.eyebrow',
        titleKey: 'services.title',
        titleAccentKey: 'services.accent',
        allCta: { labelKey: 'services.cta', pageId: 'missing' },
        services: [{ icon: 'ri-settings-line', titleKey: 'services.one', descKey: 'services.description' }],
      },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: ServicesDark.allCta.pageId=missing',
    ],
    [
      'ServiceRows.cta',
      'ServiceRows',
      {
        eyebrowKey: 'services.eyebrow',
        titleKey: 'services.title',
        titleAccentKey: 'services.accent',
        introKey: 'services.intro',
        fromLabelKey: 'services.from',
        cta: { labelKey: 'services.cta', pageId: 'missing' },
        services: [{ icon: 'ri-settings-line', titleKey: 'services.one', descKey: 'services.description', fromKey: 'services.price', unitKey: 'services.unit' }],
      },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: ServiceRows.cta.pageId=missing',
    ],
    [
      'DispatchHero.cta1PageId',
      'DispatchHero',
      { fileKey: 'dispatch.file', chapterKey: 'dispatch.chapter', eyebrowKey: 'dispatch.eyebrow', h1aKey: 'dispatch.one', h1bKey: 'dispatch.two', bodyKey: 'dispatch.body', cta1Key: 'dispatch.book', cta1PageId: 'missing', cta2Key: 'dispatch.call', cta2PhoneKey: 'dispatch.phone', trustOpenKey: 'dispatch.open', trustLicKey: 'dispatch.license', coverageLabelKey: 'dispatch.coverage', coverageValueKey: 'dispatch.value', etaLabelKey: 'dispatch.eta', etaValueKey: 'dispatch.window', marqueeItems: ['North', 'Harbor'], variant: 'technical-grid' },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: DispatchHero.cta1PageId.pageId=missing',
    ],
    [
      'ServicesEditorial.bookPageId',
      'ServicesEditorial',
      { chapterKey: 'services.chapter', services: [{ code: '01', titleKey: 'services.title', bodyKey: 'services.body', specKey: 'services.spec' }], bookLabelKey: 'services.book', bookPageId: 'missing', variant: 'technical-grid' },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: ServicesEditorial.bookPageId.pageId=missing',
    ],
    [
      'DispatchTimeline.ctaPageId',
      'DispatchTimeline',
      { chapterKey: 'timeline.chapter', titleKey: 'timeline.title', titleAccentKey: 'timeline.accent', bodyKey: 'timeline.body', ctaKey: 'timeline.book', ctaPageId: 'missing', callKey: 'timeline.call', callPhoneKey: 'timeline.phone', steps: [{ t: '01', titleKey: 'timeline.one', bodyKey: 'timeline.one.body' }], variant: 'technical-grid' },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: DispatchTimeline.ctaPageId.pageId=missing',
    ],
    [
      'CrewGrid.requestPageId',
      'CrewGrid',
      { chapterKey: 'crew.chapter', h1aKey: 'crew.one', h1bKey: 'crew.two', bodyKey: 'crew.body', stats: [{ labelKey: 'crew.stat', value: '24', subKey: 'crew.sub' }], members: [{ nameKey: 'crew.name', roleKey: 'crew.role', years: '8', regionsKey: 'crew.regions', quoteKey: 'crew.quote', truckKey: 'crew.unit', authorizedProfile: true }], footnoteKey: 'crew.footnote', requestKey: 'crew.book', requestPageId: 'missing', variant: 'technical-grid' },
      'SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: CrewGrid.requestPageId.pageId=missing',
    ],
  ])('rejects unknown internal page target for %s', (_label, type, props, expected) => {
    expect(() => assertReleaseContract(spec([type], props), '1.0.0')).toThrow(expected);
  });

  it('keeps the legacy CollectionCards home target releaseable', () => {
    expect(() => assertReleaseContract(spec(['CollectionCards'], {
      eyebrowKey: 'collections.eyebrow', titleKey: 'collections.title', items: [], variant: 'technical-grid',
    }), '1.0.0')).not.toThrow();
  });

  it('does not require a booking page when ServicesEditorial renders no CTA', () => {
    expect(() => assertReleaseContract(spec(['ServicesEditorial'], {
      chapterKey: 'services.chapter', services: [{ code: '01', titleKey: 'services.title', bodyKey: 'services.body', specKey: 'services.spec' }], variant: 'technical-grid',
    }), '1.0.0')).not.toThrow();
  });

  it('rejects blank internal CTA page IDs before publication', () => {
    expect(() => assertReleaseContract(spec(['CtaCenter'], {
      eyebrowKey: 'cta.eyebrow', titleKey: 'cta.title', subtitleKey: 'cta.subtitle',
      primaryCta: { labelKey: 'cta.primary', pageId: '' },
    }), '1.0.0')).toThrow('INVALID_BLOCK_PROPS: CtaCenter');
  });

  it('keeps an explicit legacy external CTA URL releaseable', () => {
    const external = spec(['CtaCenter'], {
      eyebrowKey: 'cta.eyebrow', titleKey: 'cta.title', subtitleKey: 'cta.subtitle',
      primaryCta: { labelKey: 'cta.primary', url: 'https://example.test/contact' },
    });
    external.site.outboundDomains = ['example.test'];
    expect(() => assertReleaseContract(external, '1.0.0')).not.toThrow();
  });

  it('rejects unsafe external CTA protocols before publication', () => {
    expect(() => assertReleaseContract(spec(['CtaCenter'], {
      eyebrowKey: 'cta.eyebrow', titleKey: 'cta.title', subtitleKey: 'cta.subtitle',
      primaryCta: { labelKey: 'cta.primary', url: 'javascript:alert(1)' },
    }), '1.0.0')).toThrow('INVALID_BLOCK_PROPS: CtaCenter');
  });

  it('requires MediaCta WhatsApp links to be paired and allowlisted', () => {
    const props = {
      eyebrowKey: 'cta.eyebrow', titleKey: 'cta.title', titleAccentKey: 'cta.accent', subKey: 'cta.sub',
      primaryCta: { labelKey: 'cta.primary', pageId: 'home' }, whatsappLabelKey: 'cta.whatsapp', whatsappUrl: 'https://wa.me/15551234567',
    };
    expect(() => assertReleaseContract(spec(['MediaCta'], props), '1.0.0')).toThrow('SITE_RELEASE_OUTBOUND_DOMAIN_FORBIDDEN: MediaCta.whatsappUrl');
    const allowed = spec(['MediaCta'], props);
    allowed.site.outboundDomains = ['wa.me'];
    expect(() => assertReleaseContract(allowed, '1.0.0')).not.toThrow();
  });

  it('rejects a free-form HeroBanner variant before release publication', () => {
    expect(() =>
      assertReleaseContract(
        spec(['HeroBanner'], {
          headlineKey: 'hero.headline',
          variant: 'invented-layout',
        }),
        '1.0.0',
      ),
    ).toThrow('INVALID_BLOCK_PROPS');
  });

  it('rejects unknown fields nested inside component props', () => {
    expect(() =>
      assertReleaseContract(
        spec(['HeroBanner'], {
          headlineKey: 'hero.headline',
          cta: {
            labelKey: 'hero.cta',
            pageId: 'inquiry',
            injected: 'must-not-pass',
          },
        }),
        '1.0.0',
      ),
    ).toThrow('INVALID_BLOCK_PROPS');
  });

  it('fails closed on an unknown component before renderer publication', () => {
    expect(() =>
      assertReleaseContract(spec(['InventedWidget']), '1.0.0'),
    ).toThrow('UNKNOWN_COMPONENT_TYPE: InventedWidget');
  });

  it('fails closed when either stored or embedded specVersion is unsupported', () => {
    expect(() => assertReleaseContract(spec(), '2.0.0')).toThrow(
      'SITE_RELEASE_UNSUPPORTED_SPEC_VERSION',
    );
    const mismatched = spec();
    mismatched.specVersion = '1.1.0';
    expect(() => assertReleaseContract(mismatched, '1.0.0')).toThrow(
      'SITE_RELEASE_UNSUPPORTED_SPEC_VERSION',
    );
  });
});

describe('R1 deterministic release artifact', () => {
  it('sorts files, freezes digests, and isolates keys by producer token', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'r1-release-'));
    roots.push(root);
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'z.html'), '<h1>Z</h1>');
    await writeFile(path.join(root, 'assets', 'app.css'), 'body{}');

    const first = await buildReleaseArtifact({
      ...identity,
      root,
      spec: spec(),
      storedSpecVersion: '1.0.0',
    });
    const replay = await buildReleaseArtifact({
      ...identity,
      root,
      spec: spec(),
      storedSpecVersion: '1.0.0',
    });

    expect(first.files.map((file) => file.path)).toEqual([
      'assets/app.css',
      'z.html',
    ]);
    expect(first.files[0]?.objectKey).toBe(
      `${identity.artifactPrefix}/attempts/${identity.producerToken}/files/assets/app.css`,
    );
    expect(first.manifestObjectKey).toBe(
      `${identity.artifactPrefix}/attempts/${identity.producerToken}/release-manifest.json`,
    );
    expect(first.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.manifest.files).toEqual(
      first.files.map(({ data: _data, ...file }) => file),
    );
    expect(replay.manifestBytes).toEqual(first.manifestBytes);
    expect(replay.manifestDigest).toBe(first.manifestDigest);
  });

  it('rejects symlinks instead of escaping or aliasing the renderer output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'r1-release-'));
    roots.push(root);
    await writeFile(path.join(root, 'index.html'), 'safe');
    await symlink(path.join(root, 'index.html'), path.join(root, 'alias.html'));

    await expect(
      buildReleaseArtifact({
        ...identity,
        root,
        spec: spec(),
        storedSpecVersion: '1.0.0',
      }),
    ).rejects.toThrow('SITE_RELEASE_SYMLINK_FORBIDDEN');
  });

  it('makes ACK-loss retries idempotent and verifies every stored digest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'r1-release-'));
    roots.push(root);
    await writeFile(path.join(root, 'index.html'), 'hello');
    const release = await buildReleaseArtifact({
      ...identity,
      root,
      spec: spec(),
      storedSpecVersion: '1.0.0',
    });
    const objects = new Map<string, Buffer>();
    const storage = {
      putBufferImmutable: vi.fn(
        async (key: string, data: Buffer): Promise<'created' | 'exists'> => {
          if (objects.has(key)) return 'exists';
          objects.set(key, Buffer.from(data));
          return 'created';
        },
      ),
      hashObject: vi.fn(async (key: string) => {
        const data = objects.get(key);
        if (!data) throw new Error(`missing ${key}`);
        return {
          sha256: createHash('sha256').update(data).digest('hex'),
          head: data.subarray(0, 16),
          size: data.length,
        };
      }),
    };

    await uploadReleaseArtifact(release, storage);
    await uploadReleaseArtifact(release, storage);

    expect(objects.size).toBe(2);
    expect(storage.putBufferImmutable).toHaveBeenCalledTimes(4);
    expect(storage.hashObject).toHaveBeenCalledTimes(4);
  });

  it('fails closed when an existing object does not match its manifest digest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'r1-release-'));
    roots.push(root);
    await writeFile(path.join(root, 'index.html'), 'expected');
    const release = await buildReleaseArtifact({
      ...identity,
      root,
      spec: spec(),
      storedSpecVersion: '1.0.0',
    });
    const storage = {
      putBufferImmutable: vi.fn(async () => 'exists' as const),
      hashObject: vi.fn(async () => ({
        sha256: createHash('sha256').update('different').digest('hex'),
        head: Buffer.alloc(0),
        size: 9,
      })),
    };

    await expect(uploadReleaseArtifact(release, storage)).rejects.toThrow(
      'SITE_RELEASE_OBJECT_INTEGRITY_MISMATCH',
    );
  });
});
