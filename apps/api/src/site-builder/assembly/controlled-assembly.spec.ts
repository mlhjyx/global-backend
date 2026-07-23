import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  finalizeDesignCatalogV2,
  finalizeDesignBriefV2,
  finalizeCopyBundle,
  demoVisualPackV2Digest,
  type AssetRefV1_1,
  type DesignCatalogV2,
  type DesignCatalogV2Draft,
  type SiteSpecComponentType,
} from '@global/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  CopyBundleService,
  neutralCopySlotContent,
} from '../copy-bundle.service';
import type { PublishableClaimSnapshot } from '../publishable-claim-snapshot';
import { STATIC_DESIGN_CATALOG_V2 } from '../design/catalog';
import {
  DESIGN_SPEC_INPUT_VERSION,
  M1_E_A_COMPONENT_LIBRARY_VERSION,
  DesignBriefProducer,
  type DesignBriefTaskLedger,
  type DesignSpecInputV1,
} from '../design/design-brief-producer';
import {
  CONTROLLED_ASSEMBLY_COMPONENT_TYPES,
  assertControlledAssemblyAdapterCoverage,
  buildControlledComponentProps,
} from './component-assembly-adapters';
import {
  ControlledAssemblyService,
  type AssemblySelectionGenerator,
} from './controlled-assembly.service';
import {
  deriveCopySlotDefinitions,
  type QualifiedComponentTemplateRepository,
} from './copy-slot-derivation';
import { validateControlledAssembly } from './controlled-assembly-validator';
import {
  controlledAssetUrls,
  materializeControlledAssetOverlay,
} from '../controlled-asset-materializer';
import { buildDemoSpec } from '../demo-spec';
import {
  buildReleaseArtifact,
  releaseManifestDigest,
  validateReleaseManifest,
} from '../release-artifact';
import { SitePreviewArtifactService } from '../site-preview-artifact.service';

const ROOT = path.resolve(process.cwd(), '../..');

function approvedCatalog(): DesignCatalogV2 {
  const { digest: _digest, ...raw } = structuredClone(STATIC_DESIGN_CATALOG_V2);
  const draft = raw as DesignCatalogV2Draft;
  draft.catalogVersion = 'm1-e-b-b5-approved-test/1';
  draft.stylePresets.forEach((item) => {
    item.status = 'approved';
  });
  draft.demoVisualPacks.forEach((item) => {
    item.status = 'approved';
  });
  draft.families.forEach((item) => {
    item.status = 'approved';
  });
  return finalizeDesignCatalogV2(draft);
}

class Ledger implements DesignBriefTaskLedger {
  async claimTaskAttempt() {
    return {
      kind: 'claimed' as const,
      attempt: { id: 'attempt-b5', fenceToken: 'fence-b5' },
    };
  }
  async freezeTaskInput<T extends Record<string, unknown>>(
    _fence: unknown,
    candidate: T,
  ) {
    return { inputHash: 'a'.repeat(64), input: candidate, replayed: false };
  }
  async storeTaskOutput() {}
  async completeTask() {}
  async releaseTask() {}
}

const templates: QualifiedComponentTemplateRepository = {
  get(componentType) {
    const slug = componentType
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();
    const fixture = JSON.parse(
      readFileSync(
        path.join(
          ROOT,
          `apps/site-renderer/fixtures/component-qualification/${slug}-spec.json`,
        ),
        'utf8',
      ),
    ) as {
      pages: Array<{
        puck: {
          content: Array<{ type: string; props: Record<string, unknown> }>;
        };
      }>;
    };
    const block = fixture.pages
      .flatMap((page) => page.puck.content)
      .find((candidate) => candidate.type === componentType);
    if (!block) throw new Error(`missing fixture for ${componentType}`);
    return structuredClone(block.props);
  },
};

function designInput(catalog: DesignCatalogV2): DesignSpecInputV1 {
  return {
    schemaVersion: DESIGN_SPEC_INPUT_VERSION,
    workspaceId: '11111111-1111-4111-8111-111111111111',
    siteId: '22222222-2222-4222-8222-222222222222',
    buildRunId: '33333333-3333-4333-8333-333333333333',
    brandProfile: {
      industryTags: ['oem', 'fabrication'],
      businessType: 'custom OEM',
      frozenFactCount: 0,
    },
    frozenIntake: {},
    assetCapabilities: { assets: [] },
    locales: ['en'],
    catalogDigest: catalog.digest,
    componentLibraryVersion: M1_E_A_COMPONENT_LIBRARY_VERSION,
    rendererVersion: 'site-renderer@test',
  };
}

const snapshot: PublishableClaimSnapshot = {
  schemaVersion: 'site-builder-publishable-claim-snapshot/v1',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  siteId: '22222222-2222-4222-8222-222222222222',
  companyProfileId: '44444444-4444-4444-8444-444444444444',
  buildRunId: '33333333-3333-4333-8333-333333333333',
  capturedAt: '2026-07-23T00:00:00.000Z',
  digest: 'b'.repeat(64),
  items: [],
};

async function fixture() {
  const catalog = approvedCatalog();
  const { designBrief } = await new DesignBriefProducer({
    ledger: new Ledger(),
    catalog,
    executeTask: async (input) => ({
      candidateId: input.candidates[0]!.id,
      reasons: [],
      warnings: [],
    }),
  }).produce(designInput(catalog));
  const slots = deriveCopySlotDefinitions({
    brief: designBrief,
    catalog,
    templates,
  });
  const copyBundleSet = (
    await new CopyBundleService({
      generateSlot: async ({ slot, locale }) => ({
        content: neutralCopySlotContent(slot.key, locale),
        claimRefs: [],
      }),
    }).generate({
      locales: ['en'],
      sourceLocale: 'en',
      snapshotId: 'snapshot-b5',
      snapshot,
      slots,
      approvedOutboundDomains: [],
    })
  ).set;
  const pack = catalog.demoVisualPacks.find(
    (candidate) => candidate.id === designBrief.assetStrategy.demoVisualPackId,
  )!;
  const assets: Record<string, AssetRefV1_1> = Object.fromEntries(
    pack.assets.map((asset) => [
      asset.id,
      {
        source: 'catalog',
        packId: pack.id,
        packVersion: pack.version,
        catalogAssetId: asset.id,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
      },
    ]),
  );
  const assetUrls = controlledAssetUrls(assets);
  return { catalog, designBrief, slots, copyBundleSet, assets, assetUrls };
}

function refreshBundleDigest(
  set: Awaited<ReturnType<typeof fixture>>['copyBundleSet'],
  locale: string,
): void {
  const bundle = set.bundles[locale]!;
  const { digest: _digest, ...draft } = bundle;
  set.bundles[locale] = finalizeCopyBundle(draft, {
    supportedLocales: Object.keys(set.bundles),
    claims: new Map(),
    approvedOutboundDomains: [],
  });
}

describe('M1-e-B controlled assembly', () => {
  it('covers every component referenced by all six Families', () => {
    const referenced = STATIC_DESIGN_CATALOG_V2.families.flatMap((family) =>
      Object.values(family.blueprints).flatMap((blueprints) =>
        blueprints.flatMap((blueprint) =>
          blueprint.sections.map((section) => section.componentType),
        ),
      ),
    );
    expect(() =>
      assertControlledAssemblyAdapterCoverage(referenced),
    ).not.toThrow();
    expect(new Set(referenced)).toEqual(
      new Set(CONTROLLED_ASSEMBLY_COMPONENT_TYPES),
    );
  });

  it('derives stable copy slots with the smaller component/family budget', async () => {
    const { catalog, designBrief, slots } = await fixture();
    const repeated = deriveCopySlotDefinitions({
      brief: designBrief,
      catalog,
      templates,
    });
    expect(repeated).toEqual(slots);
    expect(new Set(slots.map((slot) => slot.key)).size).toBe(slots.length);
    const family = catalog.families.find(
      (candidate) => candidate.id === designBrief.familyId,
    )!;
    for (const slot of slots.filter(
      (candidate) => candidate.key.split('.').length > 3,
    )) {
      const sectionId = slot.key.split('.')[1]!;
      const section = Object.values(family.blueprints)
        .flat()
        .flatMap((blueprint) => blueprint.sections)
        .find((candidate) => candidate.id.toLowerCase() === sectionId);
      if (section) {
        expect(slot.maxGraphemes).toBeLessThanOrEqual(
          family.contentBudgets[section.contentBudgetKey]!.maximum,
        );
      }
    }
  });

  it('never merges model props, component types, CSS, HTML, or paths', async () => {
    const { catalog, designBrief, copyBundleSet, assets, assetUrls } =
      await fixture();
    const generator: AssemblySelectionGenerator = {
      generate: vi.fn(async () => ({
        sections: [],
        props: { class: 'injected', html: '<script />' },
        componentType: 'InventedHero',
        path: '../../escape',
      })),
    };
    const result = await new ControlledAssemblyService(generator).assemble({
      brief: designBrief,
      catalog,
      copyBundleSet,
      templates,
      assets,
      assetUrls,
      claimSnapshot: snapshot,
      siteName: 'B5 Test',
    });
    const serialized = JSON.stringify(result.spec);
    expect(serialized).not.toContain('InventedHero');
    expect(serialized).not.toContain('injected');
    expect(serialized).not.toContain('<script');
    expect(serialized).not.toContain('../../escape');
    expect(result.spec.specVersion).toBe('1.1.0');
    expect(result.spec.site.familyId).toBe(designBrief.familyId);
  });

  it('rejects a server template that violates the qualified props shape', () => {
    const section =
      STATIC_DESIGN_CATALOG_V2.families[0]!.blueprints.home![0]!.sections[0]!;
    expect(() =>
      buildControlledComponentProps({
        pageKey: 'home',
        section,
        serverTemplate: { id: 'x', invented: true },
        pageIds: ['home'],
        assetReferenceIds: [],
        assetUrls: {},
      }),
    ).toThrow();
  });

  it('does not fallback across a budget kill or unknown settlement', async () => {
    const data = await fixture();
    for (const marker of ['BUDGET_KILL_SWITCH', 'TASK_SETTLEMENT_UNKNOWN']) {
      const service = new ControlledAssemblyService({
        generate: async () => {
          throw new Error(marker);
        },
      });
      await expect(
        service.assemble({
          brief: data.designBrief,
          catalog: data.catalog,
          copyBundleSet: data.copyBundleSet,
          templates,
          assets: data.assets,
          assetUrls: data.assetUrls,
          claimSnapshot: snapshot,
          siteName: 'B5 Test',
        }),
      ).rejects.toThrow(marker);
    }
  });

  it('reports schema, reference, semantic, and compatibility findings separately', async () => {
    const data = await fixture();
    const valid = await new ControlledAssemblyService({
      generate: async () => ({ sections: [] }),
    }).assemble({
      brief: data.designBrief,
      catalog: data.catalog,
      copyBundleSet: data.copyBundleSet,
      templates,
      assets: data.assets,
      assetUrls: data.assetUrls,
      claimSnapshot: snapshot,
      siteName: 'B5 Test',
    });
    expect(
      validateControlledAssembly({
        spec: valid.spec,
        brief: valid.designBrief,
        catalog: data.catalog,
        claimSnapshot: snapshot,
        copySlots: data.slots,
      }),
    ).toEqual([]);

    const overBudget = structuredClone(valid.spec);
    const firstBundle = overBudget.copyBundleSet!.bundles.en!;
    const firstSlot = Object.values(firstBundle.slots)[0]!;
    firstSlot.maxGraphemes += 1;
    expect(
      validateControlledAssembly({
        spec: overBudget,
        brief: valid.designBrief,
        catalog: data.catalog,
        claimSnapshot: snapshot,
        copySlots: data.slots,
      }).map((item) => item.code),
    ).toContain('COPY_BUNDLE_INVALID');

    const reference = structuredClone(valid.spec);
    reference.pages[0]!.seo.titleKey = 'unknown.copy';
    expect(
      validateControlledAssembly({
        spec: reference,
        brief: valid.designBrief,
        catalog: data.catalog,
        claimSnapshot: snapshot,
        copySlots: data.slots,
      }).map((item) => item.layer),
    ).toContain('reference');

    const wrongPack = structuredClone(valid.spec);
    const catalogRef = Object.values(wrongPack.assets).find(
      (asset) => asset.source === 'catalog',
    )!;
    if (catalogRef.source === 'catalog') catalogRef.packId = 'invented-pack';
    expect(
      validateControlledAssembly({
        spec: wrongPack,
        brief: valid.designBrief,
        catalog: data.catalog,
        claimSnapshot: snapshot,
        copySlots: data.slots,
      }).map((item) => item.code),
    ).toContain('CATALOG_ASSET_OUTSIDE_FIXED_PACK');

    const semantic = structuredClone(valid.spec);
    semantic.pages[0]!.puck.content = semantic.pages[0]!.puck.content.filter(
      (block) => !/Hero$|HeroBanner|HeroFull/.test(block.type),
    );
    expect(
      validateControlledAssembly({
        spec: semantic,
        brief: valid.designBrief,
        catalog: data.catalog,
        claimSnapshot: snapshot,
        copySlots: data.slots,
      }).map((item) => item.layer),
    ).toContain('semantic');

    const compatibility = structuredClone(valid.spec);
    compatibility.site.familyId = 'invented-family';
    expect(
      validateControlledAssembly({
        spec: compatibility,
        brief: valid.designBrief,
        catalog: data.catalog,
        claimSnapshot: snapshot,
        copySlots: data.slots,
      }).map((item) => item.layer),
    ).toContain('compatibility');

    const schema = {
      ...structuredClone(valid.spec),
      injected: true,
    };
    expect(
      validateControlledAssembly({
        spec: schema as never,
        brief: valid.designBrief,
        catalog: data.catalog,
        claimSnapshot: snapshot,
        copySlots: data.slots,
      }).map((item) => item.layer),
    ).toEqual(['schema']);
  });

  it('runs exactly three repair tasks before the same-family safe Blueprint', async () => {
    const data = await fixture();
    const set = structuredClone(data.copyBundleSet);
    delete set.bundles.en!.slots['home.oem-home-proof-hero.file'];
    refreshBundleDigest(set, 'en');
    const generator = { generate: vi.fn(async () => ({ sections: [] })) };
    const result = await new ControlledAssemblyService(generator).assemble({
      brief: data.designBrief,
      catalog: data.catalog,
      copyBundleSet: set,
      templates,
      assets: data.assets,
      assetUrls: data.assetUrls,
      claimSnapshot: snapshot,
      siteName: 'B5 Test',
    });
    expect(generator.generate).toHaveBeenCalledTimes(4);
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts.map((attempt) => attempt.taskId)).toEqual([
      'site_builder.assemble',
      'site_builder.assembly_fix:1',
      'site_builder.assembly_fix:2',
      'site_builder.assembly_fix:3',
      'same-family-safe-fallback',
    ]);
    expect(result.designBrief.familyId).toBe(data.designBrief.familyId);
    expect(result.designBrief.stylePresetId).toBe(
      data.designBrief.stylePresetId,
    );
    expect(JSON.stringify(result.spec)).toContain('/assets/catalog/');
  });

  it('returns CONTROLLED_ASSEMBLY_INVALID when repair and safe fallback both fail', async () => {
    const data = await fixture();
    const set = structuredClone(data.copyBundleSet);
    delete set.bundles.en!.slots['footer.tagline'];
    await expect(
      new ControlledAssemblyService({
        generate: async () => ({ sections: [] }),
      }).assemble({
        brief: data.designBrief,
        catalog: data.catalog,
        copyBundleSet: set,
        templates,
        assets: data.assets,
        assetUrls: data.assetUrls,
        claimSnapshot: snapshot,
        siteName: 'B5 Test',
      }),
    ).rejects.toMatchObject({ code: 'CONTROLLED_ASSEMBLY_INVALID' });
  });
});

describe('M1-e-B controlled asset materialization', () => {
  it('materializes mixed tenant/catalog bytes to content-addressed paths', async () => {
    const data = await fixture();
    const tenantBytes = Buffer.from('tenant-variant');
    const tenantHash = createHash('sha256').update(tenantBytes).digest('hex');
    const tenantId = '55555555-5555-4555-8555-555555555555';
    const variantId = '66666666-6666-4666-8666-666666666666';
    const assets = {
      ...data.assets,
      tenant: {
        source: 'tenant',
        assetId: tenantId,
        kind: 'product_image',
        contentHash: 'c'.repeat(64),
        variantId,
        variantHash: tenantHash,
        mimeType: 'image/webp',
      },
    } satisfies Record<string, AssetRefV1_1>;
    const assembly = await new ControlledAssemblyService({
      generate: async () => ({ sections: [] }),
    }).assemble({
      brief: data.designBrief,
      catalog: data.catalog,
      copyBundleSet: data.copyBundleSet,
      templates,
      assets,
      assetUrls: {},
      claimSnapshot: snapshot,
      siteName: 'B5 Test',
    });
    const overlay = await materializeControlledAssetOverlay({
      workspaceId: snapshot.workspaceId,
      siteId: snapshot.siteId,
      spec: assembly.spec,
      designBrief: data.designBrief,
      catalog: data.catalog,
      repositoryRoot: ROOT,
      tenantReader: {
        readReadyVariant: async () => ({
          data: tenantBytes,
          assetId: tenantId,
          kind: 'product_image',
          contentHash: 'c'.repeat(64),
          variantId,
          variantHash: tenantHash,
          mimeType: 'image/webp',
        }),
      },
    });
    expect(overlay.urls.tenant).toBe(
      `/assets/tenant/${tenantId}/${tenantHash}.webp`,
    );
    expect(overlay.urls[Object.keys(data.assets)[0]!]).toMatch(
      /^\/assets\/catalog\/[a-f0-9]{64}\.svg$/,
    );
    await overlay.cleanup();

    const firstCatalog = Object.values(data.assets)[0]!;
    const duplicateOverlay = await materializeControlledAssetOverlay({
      workspaceId: snapshot.workspaceId,
      siteId: snapshot.siteId,
      spec: {
        ...assembly.spec,
        assets: {
          original: firstCatalog,
          alias: structuredClone(firstCatalog),
        },
      },
      designBrief: data.designBrief,
      catalog: data.catalog,
      repositoryRoot: ROOT,
      tenantReader: { readReadyVariant: async () => null },
    });
    expect(duplicateOverlay.urls.alias).toBe(duplicateOverlay.urls.original);
    await duplicateOverlay.cleanup();
  });

  it('fails closed on tenant hash drift and forbidden catalog paths', async () => {
    const data = await fixture();
    const tenantId = '55555555-5555-4555-8555-555555555555';
    const variantId = '66666666-6666-4666-8666-666666666666';
    const assets = {
      tenant: {
        source: 'tenant',
        assetId: tenantId,
        kind: 'product_image',
        contentHash: 'c'.repeat(64),
        variantId,
        variantHash: 'd'.repeat(64),
        mimeType: 'image/webp',
      },
    } satisfies Record<string, AssetRefV1_1>;
    const spec = {
      specVersion: '1.1.0',
      componentLibraryVersion: data.designBrief.componentLibraryVersion,
      rendererVersion: data.designBrief.rendererVersion,
      site: {
        defaultLocale: 'en',
        locales: ['en'],
        archetype: data.designBrief.archetype,
        familyId: data.designBrief.familyId,
        dirByLocale: { en: 'ltr' },
        theme: { preset: 'industrial-power' },
        nav: [],
        seoGlobal: { siteName: 'B5' },
      },
      pages: [],
      assets,
      copyBundles: { en: {} },
    } as const;
    await expect(
      materializeControlledAssetOverlay({
        workspaceId: snapshot.workspaceId,
        siteId: snapshot.siteId,
        spec,
        designBrief: data.designBrief,
        catalog: data.catalog,
        repositoryRoot: ROOT,
        tenantReader: {
          readReadyVariant: async () => ({
            data: Buffer.from('wrong'),
            assetId: tenantId,
            kind: 'product_image',
            contentHash: 'c'.repeat(64),
            variantId,
            variantHash: 'd'.repeat(64),
            mimeType: 'image/webp',
          }),
        },
      }),
    ).rejects.toThrow('CONTROLLED_ASSET_TENANT_INVALID');

    const temp = await mkdtemp(path.join(tmpdir(), 'b5-symlink-'));
    try {
      const approved = path.join(
        temp,
        'apps/site-renderer/fixtures/design-demo-visuals',
      );
      await mkdir(approved, { recursive: true });
      await writeFile(path.join(temp, 'target.svg'), '<svg/>');
      await symlink(
        path.join(temp, 'target.svg'),
        path.join(approved, 'link.svg'),
      );
      const catalog = structuredClone(data.catalog);
      const pack = catalog.demoVisualPacks.find(
        (candidate) =>
          candidate.id === data.designBrief.assetStrategy.demoVisualPackId,
      )!;
      const bytes = Buffer.from('<svg/>');
      const hash = createHash('sha256').update(bytes).digest('hex');
      pack.assets[0]!.repositoryPath =
        'apps/site-renderer/fixtures/design-demo-visuals/link.svg';
      pack.assets[0]!.sha256 = hash;
      const { digest: _digest, ...draft } = data.designBrief;
      const brief = finalizeDesignBriefV2({
        ...draft,
        assetStrategy: {
          ...draft.assetStrategy,
          demoVisualPackDigest: demoVisualPackV2Digest(pack),
        },
      });
      const catalogRef = {
        source: 'catalog',
        packId: pack.id,
        packVersion: pack.version,
        catalogAssetId: pack.assets[0]!.id,
        sha256: hash,
        mimeType: 'image/svg+xml',
      } as const;
      await expect(
        materializeControlledAssetOverlay({
          workspaceId: snapshot.workspaceId,
          siteId: snapshot.siteId,
          spec: { ...spec, assets: { linked: catalogRef } },
          designBrief: brief,
          catalog,
          repositoryRoot: temp,
          tenantReader: { readReadyVariant: async () => null },
        }),
      ).rejects.toThrow('CONTROLLED_ASSET_PATH_FORBIDDEN');

      for (const repositoryPath of [
        'apps/site-renderer/fixtures/design-demo-visuals-private/secret.svg',
        'apps/site-renderer/fixtures/design-demo-visuals/../../../.env',
      ]) {
        pack.assets[0]!.repositoryPath = repositoryPath;
        const { digest: _briefDigest, ...briefDraft } = brief;
        const maliciousBrief = finalizeDesignBriefV2({
          ...briefDraft,
          assetStrategy: {
            ...briefDraft.assetStrategy,
            demoVisualPackDigest: demoVisualPackV2Digest(pack),
          },
        });
        await expect(
          materializeControlledAssetOverlay({
            workspaceId: snapshot.workspaceId,
            siteId: snapshot.siteId,
            spec: { ...spec, assets: { linked: catalogRef } },
            designBrief: maliciousBrief,
            catalog,
            repositoryRoot: temp,
            tenantReader: { readReadyVariant: async () => null },
          }),
        ).rejects.toThrow('CONTROLLED_ASSET_PATH_FORBIDDEN');
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe('M1-e-B ReleaseManifest v2', () => {
  it('binds SiteSpec 1.1, the complete DesignBrief, versions, and files', async () => {
    const data = await fixture();
    const legacy = buildDemoSpec({
      siteName: 'Acme',
      intake: {
        company: { nameZh: '艾克米', nameEn: 'Acme' },
        industry: 'machinery',
        products: ['pump'],
        targetMarkets: ['DE'],
        hasWebsite: false,
        businessEmail: 'sales@example.test',
      },
    });
    const spec = {
      ...legacy,
      specVersion: '1.1.0',
      componentLibraryVersion: data.designBrief.componentLibraryVersion,
      rendererVersion: data.designBrief.rendererVersion,
      site: {
        ...legacy.site,
        archetype: data.designBrief.archetype,
        familyId: data.designBrief.familyId,
        dirByLocale: { en: 'ltr' },
      },
      assets: {},
    } as const;
    const root = await mkdtemp(path.join(tmpdir(), 'b5-release-v2-'));
    try {
      await writeFile(path.join(root, 'index.html'), '<h1>Acme</h1>');
      const release = await buildReleaseArtifact({
        root,
        spec,
        storedSpecVersion: '1.1.0',
        designBrief: data.designBrief,
        releaseId: '50000000-0000-4000-8000-000000000001',
        workspaceId: snapshot.workspaceId,
        siteId: snapshot.siteId,
        siteVersionId: '70000000-0000-4000-8000-000000000001',
        buildRunId: snapshot.buildRunId,
        producerToken: '80000000-0000-4000-8000-000000000001',
        artifactPrefix:
          'sites/22222222-2222-4222-8222-222222222222/releases/50000000-0000-4000-8000-000000000001',
        releaseCreatedAt: new Date('2026-07-23T00:00:00.000Z'),
        buildIdentity: 'site-renderer@test',
      });
      expect(release.manifest).toMatchObject({
        schemaVersion: 'site-builder-release-manifest/v2',
        specVersion: '1.1.0',
        componentLibraryVersion: data.designBrief.componentLibraryVersion,
        rendererVersion: data.designBrief.rendererVersion,
        designBriefDigest: data.designBrief.digest,
      });
      expect(validateReleaseManifest(release.manifest)).toEqual(
        release.manifest,
      );
      const preview = new SitePreviewArtifactService(
        {
          $queryRaw: async () => [
            {
              artifactKey: `release:${release.manifest.releaseId}`,
              releaseId: release.manifest.releaseId,
              artifactPrefix: release.manifest.artifactPrefix,
              artifactDigest: release.manifest.artifactDigest,
              manifest: release.manifest,
              manifestDigest: releaseManifestDigest(release.manifest),
            },
          ],
        } as never,
        {
          getBufferBounded: async () => Buffer.from('<h1>Acme</h1>'),
        } as never,
      );
      await expect(preview.get('acme', '')).resolves.toMatchObject({
        contentType: 'text/html; charset=utf-8',
      });
      expect(() =>
        validateReleaseManifest({
          ...release.manifest,
          injected: true,
        }),
      ).toThrow('SITE_RELEASE_MANIFEST_INVALID');
      await expect(
        buildReleaseArtifact({
          root,
          spec,
          storedSpecVersion: '1.1.0',
          releaseId: '50000000-0000-4000-8000-000000000001',
          workspaceId: snapshot.workspaceId,
          siteId: snapshot.siteId,
          siteVersionId: '70000000-0000-4000-8000-000000000001',
          buildRunId: snapshot.buildRunId,
          producerToken: '80000000-0000-4000-8000-000000000001',
          artifactPrefix:
            'sites/22222222-2222-4222-8222-222222222222/releases/50000000-0000-4000-8000-000000000001',
          releaseCreatedAt: new Date('2026-07-23T00:00:00.000Z'),
          buildIdentity: 'site-renderer@test',
        }),
      ).rejects.toThrow('SITE_RELEASE_DESIGN_BRIEF_VERSION_MISMATCH');
      const { digest: _digest, ...briefDraft } = data.designBrief;
      const mismatchedBrief = finalizeDesignBriefV2({
        ...briefDraft,
        rendererVersion: 'site-renderer@other',
      });
      await expect(
        buildReleaseArtifact({
          root,
          spec,
          storedSpecVersion: '1.1.0',
          designBrief: mismatchedBrief,
          releaseId: '50000000-0000-4000-8000-000000000001',
          workspaceId: snapshot.workspaceId,
          siteId: snapshot.siteId,
          siteVersionId: '70000000-0000-4000-8000-000000000001',
          buildRunId: snapshot.buildRunId,
          producerToken: '80000000-0000-4000-8000-000000000001',
          artifactPrefix:
            'sites/22222222-2222-4222-8222-222222222222/releases/50000000-0000-4000-8000-000000000001',
          releaseCreatedAt: new Date('2026-07-23T00:00:00.000Z'),
          buildIdentity: 'site-renderer@test',
        }),
      ).rejects.toThrow('SITE_RELEASE_DESIGN_BRIEF_IDENTITY_MISMATCH');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
