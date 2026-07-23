import {
  COPY_BUNDLE_SET_SCHEMA_VERSION,
  copyBundleToLegacyStrings,
  finalizeCopyBundle,
  validateDesignBriefV2AgainstCatalog,
  validateSiteSpecV1_1,
  type DesignBriefV2,
  type DesignCatalogV2,
  type SiteSpecV1_1,
} from '@global/contracts';
import type { PublishableClaimSnapshot } from '../publishable-claim-snapshot';
import {
  protectedFactTokens,
  type CopySlotDefinition,
} from '../copy-bundle.service';
import { assertControlledAssemblyAdapterCoverage } from './component-assembly-adapters';

export type AssemblyValidationLayer =
  'schema' | 'reference' | 'semantic' | 'compatibility';

export interface AssemblyFinding {
  layer: AssemblyValidationLayer;
  code: string;
  path: string;
  message: string;
}

export class ControlledAssemblyValidationError extends Error {
  constructor(readonly findings: readonly AssemblyFinding[]) {
    super(
      `CONTROLLED_ASSEMBLY_INVALID: ${findings
        .map((finding) => `${finding.layer}/${finding.code}@${finding.path}`)
        .join(', ')}`,
    );
    this.name = 'ControlledAssemblyValidationError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectReferences(
  value: unknown,
  output: {
    copy: Set<string>;
    assets: Set<string>;
    pages: Set<string>;
    outbound: string[];
  },
  parentKey?: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferences(item, output, parentKey));
    return;
  }
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith('Key') && typeof child === 'string') {
      output.copy.add(child);
    } else if (
      (key === 'assetId' || key.endsWith('AssetId')) &&
      typeof child === 'string'
    ) {
      output.assets.add(child);
    } else if (
      (key === 'pageId' || key.endsWith('PageId')) &&
      typeof child === 'string'
    ) {
      output.pages.add(child);
    } else if (key === 'url' && typeof child === 'string') {
      output.outbound.push(child);
    }
    collectReferences(child, output, key);
  }
}

function missingAssetAltPaths(
  value: unknown,
  path = '',
  parent?: Record<string, unknown>,
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      missingAssetAltPaths(item, `${path}/${index}`, parent),
    );
  }
  if (!record(value)) return [];
  const output: string[] = [];
  if (
    typeof value.assetId === 'string' &&
    typeof value.variantUrl === 'string' &&
    ![value, parent]
      .filter((candidate): candidate is Record<string, unknown> =>
        Boolean(candidate),
      )
      .some((candidate) =>
        ['altKey', 'nameKey', 'titleKey', 'labelKey'].some(
          (key) =>
            typeof candidate[key] === 'string' &&
            (candidate[key] as string).length > 0,
        ),
      )
  ) {
    output.push(path || '/');
  }
  for (const [key, child] of Object.entries(value)) {
    output.push(...missingAssetAltPaths(child, `${path}/${key}`, value));
  }
  return output;
}

const HERO_TYPES = new Set([
  'AxiomHero',
  'DispatchHero',
  'EditorialHero',
  'FarmhouseHero',
  'HeroBanner',
  'HeroFull',
  'IndustrialHero',
  'MinimalHero',
  'WarmHero',
]);
const INQUIRY_TYPES = new Set([
  'CtaBanner',
  'CtaCenter',
  'DispatchHero',
  'EditorialHero',
  'FarmhouseHero',
  'HeroBanner',
  'HeroFull',
  'IndustrialHero',
  'InquiryForm',
  'MinimalHero',
  'WarmHero',
]);
const FULL_BLEED_TYPES = new Set([
  'HeroFull',
  'IndustrialHero',
  'FarmhouseHero',
]);
const CARD_GRID_TYPES = new Set([
  'ArticleGrid',
  'CollectionCards',
  'FeatureCards',
  'ProductGrid',
  'ProjectsGrid',
  'ServicesGrid',
]);
const DARK_SURFACE_TYPES = new Set([
  'AxiomHero',
  'DispatchHero',
  'IndustrialHero',
]);

function consecutiveMaximum(
  types: readonly string[],
  set: Set<string>,
): number {
  let maximum = 0;
  let current = 0;
  for (const type of types) {
    current = set.has(type) ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function availableAssetRoles(
  spec: SiteSpecV1_1,
  brief: DesignBriefV2,
  catalog: DesignCatalogV2,
): Set<string> {
  const roles = new Set<string>();
  const pack = catalog.demoVisualPacks.find(
    (candidate) =>
      candidate.id === brief.assetStrategy.demoVisualPackId &&
      candidate.version === brief.assetStrategy.demoVisualPackVersion,
  );
  for (const asset of Object.values(spec.assets)) {
    if (asset.source === 'catalog') {
      const candidate = pack?.assets.find(
        (item) => item.id === asset.catalogAssetId,
      );
      if (candidate) roles.add(candidate.role);
      continue;
    }
    if (asset.kind === 'logo') roles.add('logo');
    if (asset.kind === 'product_image') roles.add('generic-product');
    if (asset.kind === 'factory_image') {
      roles.add('hero');
      roles.add('generic-process');
    }
    if (asset.kind === 'cert') roles.add('evidence');
  }
  return roles;
}

function finding(
  findings: AssemblyFinding[],
  layer: AssemblyValidationLayer,
  code: string,
  path: string,
  message: string,
): void {
  findings.push({ layer, code, path, message });
}

export function validateControlledAssembly(input: {
  spec: SiteSpecV1_1;
  brief: DesignBriefV2;
  catalog: DesignCatalogV2;
  claimSnapshot: PublishableClaimSnapshot;
  copySlots: readonly CopySlotDefinition[];
}): AssemblyFinding[] {
  const findings: AssemblyFinding[] = [];
  let spec: SiteSpecV1_1;
  try {
    spec = validateSiteSpecV1_1(input.spec);
  } catch (error) {
    finding(
      findings,
      'schema',
      'SITE_SPEC_INVALID',
      '/',
      error instanceof Error ? error.message : String(error),
    );
    return findings;
  }
  let family;
  try {
    family = validateDesignBriefV2AgainstCatalog(input.catalog, input.brief);
  } catch (error) {
    finding(
      findings,
      'compatibility',
      'DESIGN_BRIEF_INVALID',
      '/designBrief',
      error instanceof Error ? error.message : String(error),
    );
    return findings;
  }
  try {
    assertControlledAssemblyAdapterCoverage(
      spec.pages.flatMap((page) =>
        page.puck.content.map((block) => block.type),
      ),
    );
  } catch (error) {
    finding(
      findings,
      'compatibility',
      'ADAPTER_MISSING',
      '/pages',
      error instanceof Error ? error.message : String(error),
    );
  }

  const pageIds = new Set(spec.pages.map((page) => page.id));
  const copyByLocale = new Map(
    Object.entries(spec.copyBundles).map(([locale, bundle]) => [
      locale,
      new Set(Object.keys(bundle)),
    ]),
  );
  const manifestIds = new Set(Object.keys(spec.assets));
  const approvedDomains = new Set(
    (spec.site.outboundDomains ?? []).map((domain) => domain.toLowerCase()),
  );
  for (const [pageIndex, page] of spec.pages.entries()) {
    const refs = {
      copy: new Set<string>([page.seo.titleKey, page.seo.descriptionKey]),
      assets: new Set<string>(),
      pages: new Set<string>(),
      outbound: [] as string[],
    };
    collectReferences(page.puck, refs);
    for (const key of refs.copy) {
      for (const locale of spec.site.locales) {
        if (!copyByLocale.get(locale)?.has(key)) {
          finding(
            findings,
            'reference',
            'COPY_KEY_UNKNOWN',
            `/pages/${pageIndex}`,
            `${locale}/${key}`,
          );
        }
      }
    }
    for (const assetId of refs.assets) {
      if (!manifestIds.has(assetId)) {
        finding(
          findings,
          'reference',
          'ASSET_REF_UNKNOWN',
          `/pages/${pageIndex}`,
          assetId,
        );
      }
    }
    for (const target of refs.pages) {
      if (!pageIds.has(target)) {
        finding(
          findings,
          'reference',
          'PAGE_REF_UNKNOWN',
          `/pages/${pageIndex}`,
          target,
        );
      }
    }
    for (const raw of refs.outbound) {
      try {
        const url = new URL(raw);
        if (
          url.protocol !== 'https:' ||
          !approvedDomains.has(url.hostname.toLowerCase())
        ) {
          throw new Error('not approved');
        }
      } catch {
        finding(
          findings,
          'reference',
          'OUTBOUND_URL_FORBIDDEN',
          `/pages/${pageIndex}`,
          raw,
        );
      }
    }
    for (const path of missingAssetAltPaths(page.puck)) {
      finding(
        findings,
        'semantic',
        'ASSET_ALT_MISSING',
        `/pages/${pageIndex}/puck${path}`,
        'materialized image needs altKey or adjacent semantic copy',
      );
    }
    const heroCount = page.puck.content.filter((block) =>
      HERO_TYPES.has(block.type),
    ).length;
    if (heroCount !== 1) {
      finding(
        findings,
        'semantic',
        'PAGE_H1_COUNT_INVALID',
        `/pages/${pageIndex}`,
        `expected one hero/H1 owner, got ${heroCount}`,
      );
    }
    if (
      !page.puck.content.some((block) => INQUIRY_TYPES.has(block.type)) &&
      !spec.site.nav.some(
        (item) =>
          item.pageId !== page.id &&
          spec.pages
            .find((candidate) => candidate.id === item.pageId)
            ?.puck.content.some((block) => INQUIRY_TYPES.has(block.type)),
      )
    ) {
      finding(
        findings,
        'semantic',
        'INQUIRY_PATH_TOO_DEEP',
        `/pages/${pageIndex}`,
        'no inquiry entry on page or one-click navigation target',
      );
    }
  }
  const serialized = JSON.stringify(spec);
  if (/⟦[^⟧]*⟧/.test(serialized)) {
    finding(
      findings,
      'semantic',
      'UNRESOLVED_COPY_MARKER',
      '/',
      'unresolved copy marker remains',
    );
  }
  if (
    !Object.values(spec.copyBundles).every(
      (bundle) => 'footer.tagline' in bundle,
    )
  ) {
    finding(
      findings,
      'semantic',
      'FOOTER_COPY_MISSING',
      '/copyBundles',
      'footer.tagline is required in every locale',
    );
  }
  if (
    spec.componentLibraryVersion !== input.brief.componentLibraryVersion ||
    spec.rendererVersion !== input.brief.rendererVersion ||
    spec.site.familyId !== input.brief.familyId ||
    spec.site.archetype !== input.brief.archetype
  ) {
    finding(
      findings,
      'compatibility',
      'DESIGN_IDENTITY_MISMATCH',
      '/',
      'brief/spec design identity differs',
    );
  }
  const preset = input.catalog.stylePresets.find(
    (candidate) =>
      candidate.id === input.brief.stylePresetId &&
      candidate.version === input.brief.stylePresetVersion,
  );
  if (!preset || spec.site.theme.preset !== preset.rendererPresetId) {
    finding(
      findings,
      'compatibility',
      'STYLE_PRESET_MISMATCH',
      '/site/theme/preset',
      spec.site.theme.preset,
    );
  }
  const claimIds = new Set(
    input.claimSnapshot.items.map((item) => item.claimId),
  );
  const claims = new Map(
    input.claimSnapshot.items.map((item) => [
      item.claimId,
      {
        statement: item.statement,
        protectedTokens: protectedFactTokens(item),
      },
    ]),
  );
  const slotDefinitions = new Map(
    input.copySlots.map((slot) => [slot.key, slot]),
  );
  if (
    !spec.copyBundleSet ||
    spec.copyBundleSet.schemaVersion !== COPY_BUNDLE_SET_SCHEMA_VERSION ||
    spec.copyBundleSet.sourceLocale !== spec.site.defaultLocale
  ) {
    finding(
      findings,
      'schema',
      'COPY_BUNDLE_SET_INVALID',
      '/copyBundleSet',
      'controlled assembly requires the authoritative CopyBundleSet v1',
    );
  } else {
    const bundleLocales = Object.keys(spec.copyBundleSet.bundles).sort();
    const legacyLocales = Object.keys(spec.copyBundles).sort();
    const expectedLocales = [...spec.site.locales].sort();
    if (
      JSON.stringify(bundleLocales) !== JSON.stringify(expectedLocales) ||
      JSON.stringify(legacyLocales) !== JSON.stringify(expectedLocales)
    ) {
      finding(
        findings,
        'schema',
        'COPY_LOCALE_SET_MISMATCH',
        '/copyBundleSet/bundles',
        'SiteSpec locales and both copy projections must match exactly',
      );
    }
    for (const [locale, bundle] of Object.entries(spec.copyBundleSet.bundles)) {
      try {
        const { digest: observedDigest, ...draft } = bundle;
        const finalized = finalizeCopyBundle(draft, {
          supportedLocales: spec.site.locales,
          claims,
          approvedOutboundDomains: spec.site.outboundDomains ?? [],
        });
        if (finalized.digest !== observedDigest) {
          throw new Error('CopyBundle digest changed');
        }
        for (const [key, slot] of Object.entries(bundle.slots)) {
          const definition = slotDefinitions.get(key);
          if (
            !definition ||
            slot.type !== definition.type ||
            slot.maxGraphemes !== definition.maxGraphemes
          ) {
            throw new Error(`slot ${key} is outside its derived budget`);
          }
        }
        if (
          JSON.stringify(copyBundleToLegacyStrings(bundle)) !==
          JSON.stringify(spec.copyBundles[locale])
        ) {
          throw new Error(`legacy copy projection differs for ${locale}`);
        }
        if (bundle.claimSnapshot.digest !== input.claimSnapshot.digest) {
          throw new Error(`ClaimSnapshot digest differs for ${locale}`);
        }
      } catch (error) {
        finding(
          findings,
          'schema',
          'COPY_BUNDLE_INVALID',
          `/copyBundleSet/bundles/${locale}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
  const assetRoles = availableAssetRoles(spec, input.brief, input.catalog);
  const fixedPack = input.catalog.demoVisualPacks.find(
    (candidate) =>
      candidate.id === input.brief.assetStrategy.demoVisualPackId &&
      candidate.version === input.brief.assetStrategy.demoVisualPackVersion,
  );
  for (const [referenceId, asset] of Object.entries(spec.assets)) {
    if (asset.source !== 'catalog') continue;
    const catalogAsset = fixedPack?.assets.find(
      (candidate) => candidate.id === asset.catalogAssetId,
    );
    if (
      asset.packId !== input.brief.assetStrategy.demoVisualPackId ||
      asset.packVersion !== input.brief.assetStrategy.demoVisualPackVersion ||
      !catalogAsset ||
      catalogAsset.sha256 !== asset.sha256 ||
      catalogAsset.mimeType !== asset.mimeType
    ) {
      finding(
        findings,
        'reference',
        'CATALOG_ASSET_OUTSIDE_FIXED_PACK',
        `/assets/${referenceId}`,
        'catalog asset is not byte-bound to the DesignBrief pack',
      );
    }
  }
  for (const [locale, bundle] of Object.entries(
    spec.copyBundleSet?.bundles ?? {},
  )) {
    for (const [key, slot] of Object.entries(bundle.slots)) {
      if (slot.claimRefs.some((claimId) => !claimIds.has(claimId))) {
        finding(
          findings,
          'reference',
          'CLAIM_REF_UNKNOWN',
          `/copyBundleSet/${locale}/${key}`,
          'claim is outside the frozen snapshot',
        );
      }
    }
  }

  for (const [pageKey, blueprintId] of Object.entries(
    input.brief.blueprintIds,
  )) {
    const page = spec.pages.find((candidate) => candidate.id === pageKey);
    const blueprint = family.blueprints[pageKey]?.find(
      (candidate) => candidate.id === blueprintId,
    );
    if (!page || !blueprint) {
      finding(
        findings,
        'compatibility',
        'BLUEPRINT_PAGE_MISSING',
        `/pages/${pageKey}`,
        blueprintId,
      );
      continue;
    }
    const expected = blueprint.sections;
    for (const section of expected) {
      for (const role of section.assetRoles) {
        if (!assetRoles.has(role)) {
          finding(
            findings,
            'compatibility',
            'ASSET_ROLE_UNSATISFIED',
            `/pages/${pageKey}/${section.id}`,
            role,
          );
        }
      }
    }
    const actual = page.puck.content;
    if (
      actual.length !== expected.length ||
      actual.some(
        (block, index) =>
          block.type !== expected[index]?.componentType ||
          (block.props.variant !== undefined &&
            block.props.variant !== expected[index]?.variant),
      )
    ) {
      finding(
        findings,
        'compatibility',
        'BLUEPRINT_STRUCTURE_MISMATCH',
        `/pages/${pageKey}`,
        blueprintId,
      );
    }
    const types = actual.map((block) => block.type);
    for (const rule of family.compatibilityRules) {
      if (
        rule.code === 'no_adjacent_full_bleed' &&
        consecutiveMaximum(types, FULL_BLEED_TYPES) > 1
      ) {
        finding(
          findings,
          'compatibility',
          rule.code,
          `/pages/${pageKey}`,
          'adjacent full bleed',
        );
      }
      if (
        rule.code === 'max_consecutive_card_grid' &&
        consecutiveMaximum(types, CARD_GRID_TYPES) > rule.maximum
      ) {
        finding(
          findings,
          'compatibility',
          rule.code,
          `/pages/${pageKey}`,
          'card grid run too long',
        );
      }
      if (
        rule.code === 'max_consecutive_dark_surface' &&
        consecutiveMaximum(types, DARK_SURFACE_TYPES) > rule.maximum
      ) {
        finding(
          findings,
          'compatibility',
          rule.code,
          `/pages/${pageKey}`,
          'dark surface run too long',
        );
      }
    }
  }
  return findings;
}

export function assertControlledAssemblyValid(
  input: Parameters<typeof validateControlledAssembly>[0],
): void {
  const findings = validateControlledAssembly(input);
  if (findings.length > 0)
    throw new ControlledAssemblyValidationError(findings);
}
