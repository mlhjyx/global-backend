import type { SiteSpec } from '@global/contracts';

export type AssetReferenceSource = 'site_spec' | 'profile' | 'claim_evidence';

export interface AssetReferenceUsage {
  source: AssetReferenceSource;
  siteVersionId?: string;
  page: string;
  component: string;
  fieldPath: string;
}

export interface ProfileAssetReference extends AssetReferenceUsage {
  assetId: string;
  expectedKind?: 'logo' | 'cert';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_NODES = 10_000;

export class AssetReferenceScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetReferenceScanError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pointerSegment(value: string | number): string {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function stableUsages(usages: AssetReferenceUsage[]): AssetReferenceUsage[] {
  const unique = new Map<string, AssetReferenceUsage>();
  for (const usage of usages) {
    const key = [usage.source, usage.siteVersionId ?? '', usage.page, usage.component, usage.fieldPath].join('\0');
    unique.set(key, usage);
  }
  return [...unique.values()].sort((left, right) =>
    [left.source, left.siteVersionId ?? '', left.page, left.component, left.fieldPath]
      .join('\0')
      .localeCompare(
        [right.source, right.siteVersionId ?? '', right.page, right.component, right.fieldPath].join('\0'),
      ),
  );
}

interface SiteSpecReferenceSurface {
  assets: Record<string, { kind: string; hash: string }>;
  pages: Array<{
    id: string;
    puck: {
      rootProps?: unknown;
      content: Array<{ type: string; props: unknown }>;
    };
  }>;
}

function parseSiteSpecReferenceSurface(value: unknown): SiteSpecReferenceSurface {
  if (!isRecord(value) || value.specVersion !== '1.0.0') {
    throw new AssetReferenceScanError('active SiteSpec version is malformed or unsupported');
  }
  if (!isRecord(value.assets) || !Array.isArray(value.pages)) {
    throw new AssetReferenceScanError('active SiteSpec reference surface is malformed');
  }
  const assets: SiteSpecReferenceSurface['assets'] = {};
  for (const [assetId, assetRef] of Object.entries(value.assets)) {
    if (
      !UUID_RE.test(assetId) ||
      !isRecord(assetRef) ||
      typeof assetRef.kind !== 'string' ||
      !assetRef.kind ||
      typeof assetRef.hash !== 'string' ||
      !SHA256_RE.test(assetRef.hash)
    ) {
      throw new AssetReferenceScanError('active SiteSpec asset manifest is malformed');
    }
    const canonicalAssetId = assetId.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(assets, canonicalAssetId)) {
      throw new AssetReferenceScanError('active SiteSpec asset manifest contains a duplicate UUID');
    }
    assets[canonicalAssetId] = {
      kind: assetRef.kind,
      hash: assetRef.hash,
    };
  }
  const pages = value.pages.map((pageValue, pageIndex) => {
    if (
      !isRecord(pageValue) ||
      typeof pageValue.id !== 'string' ||
      !isRecord(pageValue.puck) ||
      !isRecord(pageValue.puck.root) ||
      !Array.isArray(pageValue.puck.content)
    ) {
      throw new AssetReferenceScanError(`active SiteSpec page ${pageIndex} is malformed`);
    }
    const rootProps = pageValue.puck.root.props;
    if (rootProps !== undefined && !isRecord(rootProps)) {
      throw new AssetReferenceScanError(`active SiteSpec root props ${pageIndex} are malformed`);
    }
    const content = pageValue.puck.content.map((blockValue, blockIndex) => {
      if (!isRecord(blockValue) || typeof blockValue.type !== 'string' || !isRecord(blockValue.props)) {
        throw new AssetReferenceScanError(`active SiteSpec block ${pageIndex}/${blockIndex} is malformed`);
      }
      return { type: blockValue.type, props: blockValue.props };
    });
    return { id: pageValue.id, puck: { rootProps, content } };
  });
  return { assets, pages };
}

type AssetReferenceCardinality = 'one' | 'many' | null;

function assetReferenceCardinality(key: string, parentKey: string | undefined): AssetReferenceCardinality {
  if (key === 'assetIds' || key.endsWith('AssetIds')) return 'many';
  if (
    key === 'assetId' ||
    key.endsWith('AssetId') ||
    (parentKey === 'videoRef' && ['video', 'poster', 'caption', 'reducedMotionFallback'].includes(key))
  ) {
    return 'one';
  }
  return null;
}

function visitAssetReferences(
  value: unknown,
  path: string,
  add: (assetId: string, fieldPath: string) => void,
  budget: { nodes: number },
  depth = 0,
  cardinality: AssetReferenceCardinality = null,
  parentKey?: string,
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) {
    throw new AssetReferenceScanError('asset reference surface exceeds the bounded scan budget');
  }
  if (cardinality === 'one') {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new AssetReferenceScanError('active SiteSpec contains a malformed singular Asset reference');
    }
    add(value.toLowerCase(), path);
    return;
  }
  if (cardinality === 'many') {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !UUID_RE.test(item))) {
      throw new AssetReferenceScanError('active SiteSpec contains a malformed Asset reference list');
    }
    budget.nodes += value.length;
    if (budget.nodes > MAX_SCAN_NODES) {
      throw new AssetReferenceScanError('asset reference surface exceeds the bounded scan budget');
    }
    value.forEach((item, index) => add((item as string).toLowerCase(), `${path}/${pointerSegment(index)}`));
    return;
  }
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      visitAssetReferences(
        item,
        `${path}/${pointerSegment(index)}`,
        add,
        budget,
        depth + 1,
        null,
        parentKey,
      ),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visitAssetReferences(
      child,
      `${path}/${pointerSegment(key)}`,
      add,
      budget,
      depth + 1,
      assetReferenceCardinality(key, parentKey),
      key,
    );
  }
}

function scanExactValue(
  value: unknown,
  targetAssetId: string,
  path: string,
  add: (fieldPath: string) => void,
  budget: { nodes: number },
  depth = 0,
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) {
    throw new AssetReferenceScanError('asset reference surface exceeds the bounded scan budget');
  }
  if (
    typeof value === 'string' &&
    UUID_RE.test(value) &&
    value.toLowerCase() === targetAssetId.toLowerCase()
  ) {
    add(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      scanExactValue(item, targetAssetId, `${path}/${pointerSegment(index)}`, add, budget, depth + 1),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    scanExactValue(child, targetAssetId, `${path}/${pointerSegment(key)}`, add, budget, depth + 1);
  }
}

/**
 * SiteSpec 1.0.0 keeps component props open (`Record<string, unknown>`). The scanner therefore
 * protects the manifest key and recursively searches only Puck props/root.props for an exact
 * asset id. It deliberately does not search copyBundles or arbitrary prose.
 */
export function scanSiteSpecAssetReferences(
  value: unknown,
  targetAssetId: string,
  siteVersionId?: string,
): AssetReferenceUsage[] {
  const surface = parseSiteSpecReferenceSurface(value);
  const canonicalTargetAssetId = targetAssetId.toLowerCase();
  const usages: AssetReferenceUsage[] = [];
  const budget = { nodes: 0 };
  const base = {
    source: 'site_spec' as const,
    ...(siteVersionId ? { siteVersionId } : {}),
  };
  const assets = surface.assets;
  if (Object.prototype.hasOwnProperty.call(assets, canonicalTargetAssetId)) {
    usages.push({
      ...base,
      page: '$site',
      component: '$assets',
      fieldPath: `/assets/${pointerSegment(canonicalTargetAssetId)}`,
    });
  }

  surface.pages.forEach((pageValue, pageIndex) => {
    const page = pageValue.id;
    if (pageValue.puck.rootProps !== undefined) {
      visitAssetReferences(
        pageValue.puck.rootProps,
        `/pages/${pageIndex}/puck/root/props`,
        (assetId, fieldPath) => {
          if (assetId === canonicalTargetAssetId) {
            usages.push({ ...base, page, component: '$root', fieldPath });
          }
        },
        budget,
      );
    }

    pageValue.puck.content.forEach((blockValue, blockIndex) => {
      const props = blockValue.props as Record<string, unknown>;
      const component = typeof props.id === 'string' ? props.id : `${blockValue.type}:${blockIndex}`;
      visitAssetReferences(
        blockValue.props,
        `/pages/${pageIndex}/puck/content/${blockIndex}/props`,
        (assetId, fieldPath) => {
          if (assetId === canonicalTargetAssetId) usages.push({ ...base, page, component, fieldPath });
        },
        budget,
      );
    });
  });
  return stableUsages(usages);
}

/** Asset ids declared by the 1.0.0 manifest; pointer activation locks and revalidates these. */
export function siteSpecManifestAssetIds(value: unknown): string[] {
  return Object.keys(parseSiteSpecReferenceSurface(value).assets).sort();
}

/** Asset-reference UUIDs in known SiteSpec media fields. Component/business UUIDs such as `id`
 * and `offeringRef` are deliberately excluded; every returned id must exist in the manifest. */
export function siteSpecPotentialAssetIds(value: unknown): {
  manifestIds: string[];
  manifestRefs: Record<string, { kind: string; hash: string }>;
  propAssetIds: string[];
} {
  const surface = parseSiteSpecReferenceSurface(value);
  const candidates = new Set<string>();
  const budget = { nodes: 0 };
  for (const page of surface.pages) {
    if (page.puck.rootProps !== undefined) {
      visitAssetReferences(page.puck.rootProps, '/root', (assetId) => candidates.add(assetId), budget);
    }
    page.puck.content.forEach((block) =>
      visitAssetReferences(block.props, '/content', (assetId) => candidates.add(assetId), budget),
    );
  }
  return {
    manifestIds: Object.keys(surface.assets).sort(),
    manifestRefs: surface.assets,
    propAssetIds: [...candidates].sort(),
  };
}

/** Profile's complete as-built asset surface (R2-A3), shared by PATCH and DELETE. */
export function extractProfileAssetReferences(value: unknown): ProfileAssetReference[] {
  if (!isRecord(value)) return [];
  const references: ProfileAssetReference[] = [];
  const brand = isRecord(value.brand) ? value.brand : undefined;
  if (brand && typeof brand.logoAssetId === 'string') {
    references.push({
      source: 'profile',
      assetId: UUID_RE.test(brand.logoAssetId) ? brand.logoAssetId.toLowerCase() : brand.logoAssetId,
      expectedKind: 'logo',
      page: '$profile',
      component: 'brand',
      fieldPath: '/brand/logoAssetId',
    });
  }

  const trust = isRecord(value.trustAssets) ? value.trustAssets : undefined;
  const certifications = trust && Array.isArray(trust.certifications) ? trust.certifications : [];
  certifications.forEach((candidate, certificationIndex) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.certificateAssetIds)) return;
    candidate.certificateAssetIds.forEach((assetId, assetIndex) => {
      if (typeof assetId !== 'string') return;
      references.push({
        source: 'profile',
        assetId: UUID_RE.test(assetId) ? assetId.toLowerCase() : assetId,
        expectedKind: 'cert',
        page: '$profile',
        component: 'trustAssets',
        fieldPath: `/trustAssets/certifications/${certificationIndex}/certificateAssetIds/${assetIndex}`,
      });
    });
  });
  const customerCases = trust && Array.isArray(trust.customerCases) ? trust.customerCases : [];
  customerCases.forEach((candidate, caseIndex) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.assetIds)) return;
    candidate.assetIds.forEach((assetId, assetIndex) => {
      if (typeof assetId !== 'string') return;
      references.push({
        source: 'profile',
        assetId: UUID_RE.test(assetId) ? assetId.toLowerCase() : assetId,
        page: '$profile',
        component: 'trustAssets',
        fieldPath: `/trustAssets/customerCases/${caseIndex}/assetIds/${assetIndex}`,
      });
    });
  });
  return references.sort((left, right) =>
    [left.assetId, left.fieldPath].join('\0').localeCompare([right.assetId, right.fieldPath].join('\0')),
  );
}

export function profileUsagesForAsset(value: unknown, assetId: string): AssetReferenceUsage[] {
  const canonicalAssetId = UUID_RE.test(assetId) ? assetId.toLowerCase() : assetId;
  const usages = extractProfileAssetReferences(value)
    .filter((reference) => reference.assetId === canonicalAssetId)
    .map(({ assetId: _assetId, expectedKind: _expectedKind, ...usage }) => usage);

  // Historical M0 Profile JSON was open-ended. Scan the complete bounded JSON surface for the
  // exact UUID so an unknown legacy field can only make deletion more conservative, never leave
  // a dangling reference. Known R2-A3 paths dedupe with the structured usages above.
  const budget = { nodes: 0 };
  scanExactValue(
    value,
    canonicalAssetId,
    '',
    (fieldPath) => {
      const component = fieldPath.split('/').filter(Boolean)[0] ?? '$profile';
      usages.push({
        source: 'profile',
        page: '$profile',
        component,
        fieldPath: fieldPath || '/',
      });
    },
    budget,
  );
  return stableUsages(usages);
}

// Compile-time drift guard: scanner accepts the code-fact SiteSpec while remaining runtime-safe.
const _siteSpecCompatibility: (value: SiteSpec, assetId: string) => AssetReferenceUsage[] = scanSiteSpecAssetReferences;
void _siteSpecCompatibility;
