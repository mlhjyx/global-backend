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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    const key = [
      usage.source,
      usage.siteVersionId ?? '',
      usage.page,
      usage.component,
      usage.fieldPath,
    ].join('\0');
    unique.set(key, usage);
  }
  return [...unique.values()].sort((left, right) =>
    [
      left.source,
      left.siteVersionId ?? '',
      left.page,
      left.component,
      left.fieldPath,
    ]
      .join('\0')
      .localeCompare(
        [
          right.source,
          right.siteVersionId ?? '',
          right.page,
          right.component,
          right.fieldPath,
        ].join('\0'),
      ),
  );
}

interface SiteSpecReferenceSurface {
  version: '1.0.0' | '1.1.0';
  assets: Record<
    string,
    {
      source: 'tenant' | 'catalog';
      assetId?: string;
      kind?: string;
      hash: string;
    }
  >;
  pages: Array<{
    id: string;
    puck: {
      rootProps?: unknown;
      content: Array<{ type: string; props: unknown }>;
    };
  }>;
}

function parseSiteSpecReferenceSurface(
  value: unknown,
): SiteSpecReferenceSurface {
  if (
    !isRecord(value) ||
    (value.specVersion !== '1.0.0' && value.specVersion !== '1.1.0')
  ) {
    throw new AssetReferenceScanError(
      'active SiteSpec version is malformed or unsupported',
    );
  }
  const version = value.specVersion;
  if (!isRecord(value.assets) || !Array.isArray(value.pages)) {
    throw new AssetReferenceScanError(
      'active SiteSpec reference surface is malformed',
    );
  }
  const assets: SiteSpecReferenceSurface['assets'] = {};
  for (const [referenceId, assetRef] of Object.entries(value.assets)) {
    if (!isRecord(assetRef)) {
      throw new AssetReferenceScanError(
        'active SiteSpec asset manifest is malformed',
      );
    }
    if (version === '1.0.0') {
      if (
        !UUID_RE.test(referenceId) ||
        typeof assetRef.kind !== 'string' ||
        !assetRef.kind ||
        typeof assetRef.hash !== 'string' ||
        !SHA256_RE.test(assetRef.hash)
      ) {
        throw new AssetReferenceScanError(
          'active SiteSpec asset manifest is malformed',
        );
      }
      const canonicalAssetId = referenceId.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(assets, canonicalAssetId)) {
        throw new AssetReferenceScanError(
          'active SiteSpec asset manifest contains a duplicate UUID',
        );
      }
      assets[canonicalAssetId] = {
        source: 'tenant',
        assetId: canonicalAssetId,
        kind: assetRef.kind,
        hash: assetRef.hash,
      };
      continue;
    }
    if (
      referenceId.length === 0 ||
      referenceId.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(referenceId) ||
      (assetRef.source !== 'tenant' && assetRef.source !== 'catalog')
    ) {
      throw new AssetReferenceScanError(
        'active SiteSpec 1.1 asset manifest is malformed',
      );
    }
    if (assetRef.source === 'tenant') {
      if (
        !UUID_RE.test(assetRef.assetId as string) ||
        typeof assetRef.kind !== 'string' ||
        !assetRef.kind ||
        !SHA256_RE.test(assetRef.contentHash as string) ||
        !UUID_RE.test(assetRef.variantId as string) ||
        !SHA256_RE.test(assetRef.variantHash as string)
      ) {
        throw new AssetReferenceScanError(
          'active SiteSpec 1.1 tenant asset is malformed',
        );
      }
      assets[referenceId] = {
        source: 'tenant',
        assetId: (assetRef.assetId as string).toLowerCase(),
        kind: assetRef.kind,
        hash: assetRef.contentHash as string,
      };
    } else {
      if (
        typeof assetRef.catalogAssetId !== 'string' ||
        !assetRef.catalogAssetId ||
        !SHA256_RE.test(assetRef.sha256 as string)
      ) {
        throw new AssetReferenceScanError(
          'active SiteSpec 1.1 catalog asset is malformed',
        );
      }
      assets[referenceId] = {
        source: 'catalog',
        hash: assetRef.sha256 as string,
      };
    }
  }
  const pages = value.pages.map((pageValue, pageIndex) => {
    if (
      !isRecord(pageValue) ||
      typeof pageValue.id !== 'string' ||
      !isRecord(pageValue.puck) ||
      !isRecord(pageValue.puck.root) ||
      !Array.isArray(pageValue.puck.content)
    ) {
      throw new AssetReferenceScanError(
        `active SiteSpec page ${pageIndex} is malformed`,
      );
    }
    const rootProps = pageValue.puck.root.props;
    if (rootProps !== undefined && !isRecord(rootProps)) {
      throw new AssetReferenceScanError(
        `active SiteSpec root props ${pageIndex} are malformed`,
      );
    }
    const content = pageValue.puck.content.map((blockValue, blockIndex) => {
      if (
        !isRecord(blockValue) ||
        typeof blockValue.type !== 'string' ||
        !isRecord(blockValue.props)
      ) {
        throw new AssetReferenceScanError(
          `active SiteSpec block ${pageIndex}/${blockIndex} is malformed`,
        );
      }
      return { type: blockValue.type, props: blockValue.props };
    });
    return { id: pageValue.id, puck: { rootProps, content } };
  });
  return { version, assets, pages };
}

type AssetReferenceCardinality = 'one' | 'many' | null;

function assetReferenceCardinality(
  key: string,
  parentKey: string | undefined,
): AssetReferenceCardinality {
  if (key === 'assetIds' || key.endsWith('AssetIds')) return 'many';
  if (
    key === 'assetId' ||
    key.endsWith('AssetId') ||
    (parentKey === 'videoRef' &&
      ['video', 'poster', 'caption', 'reducedMotionFallback'].includes(key))
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
  allowLogicalIds = false,
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_SCAN_NODES || depth > MAX_SCAN_DEPTH) {
    throw new AssetReferenceScanError(
      'asset reference surface exceeds the bounded scan budget',
    );
  }
  if (cardinality === 'one') {
    if (
      typeof value !== 'string' ||
      (allowLogicalIds
        ? !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
        : !UUID_RE.test(value))
    ) {
      throw new AssetReferenceScanError(
        'active SiteSpec contains a malformed singular Asset reference',
      );
    }
    add(allowLogicalIds ? value : value.toLowerCase(), path);
    return;
  }
  if (cardinality === 'many') {
    if (
      !Array.isArray(value) ||
      value.some(
        (item) =>
          typeof item !== 'string' ||
          (allowLogicalIds
            ? !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item)
            : !UUID_RE.test(item)),
      )
    ) {
      throw new AssetReferenceScanError(
        'active SiteSpec contains a malformed Asset reference list',
      );
    }
    budget.nodes += value.length;
    if (budget.nodes > MAX_SCAN_NODES) {
      throw new AssetReferenceScanError(
        'asset reference surface exceeds the bounded scan budget',
      );
    }
    value.forEach((item, index) =>
      add(
        allowLogicalIds ? (item as string) : (item as string).toLowerCase(),
        `${path}/${pointerSegment(index)}`,
      ),
    );
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
        allowLogicalIds,
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
      allowLogicalIds,
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
    throw new AssetReferenceScanError(
      'asset reference surface exceeds the bounded scan budget',
    );
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
      scanExactValue(
        item,
        targetAssetId,
        `${path}/${pointerSegment(index)}`,
        add,
        budget,
        depth + 1,
      ),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    scanExactValue(
      child,
      targetAssetId,
      `${path}/${pointerSegment(key)}`,
      add,
      budget,
      depth + 1,
    );
  }
}

/**
 * Version-aware asset scanner. v1 manifest keys are tenant UUIDs; v1.1 keys are
 * logical references whose source may be tenant or catalog. DELETE protection
 * only follows tenant sources and never locks catalog assets.
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
  const referenceIds = Object.entries(surface.assets)
    .filter(
      ([, asset]) =>
        asset.source === 'tenant' && asset.assetId === canonicalTargetAssetId,
    )
    .map(([referenceId]) => referenceId);
  if (referenceIds.length > 0) {
    usages.push({
      ...base,
      page: '$site',
      component: '$assets',
      fieldPath: `/assets/${pointerSegment(referenceIds[0]!)}`,
    });
  }

  surface.pages.forEach((pageValue, pageIndex) => {
    const page = pageValue.id;
    if (pageValue.puck.rootProps !== undefined) {
      visitAssetReferences(
        pageValue.puck.rootProps,
        `/pages/${pageIndex}/puck/root/props`,
        (assetId, fieldPath) => {
          if (referenceIds.includes(assetId)) {
            usages.push({ ...base, page, component: '$root', fieldPath });
          }
        },
        budget,
        0,
        null,
        undefined,
        surface.version === '1.1.0',
      );
    }

    pageValue.puck.content.forEach((blockValue, blockIndex) => {
      const props = blockValue.props as Record<string, unknown>;
      const component =
        typeof props.id === 'string'
          ? props.id
          : `${blockValue.type}:${blockIndex}`;
      visitAssetReferences(
        blockValue.props,
        `/pages/${pageIndex}/puck/content/${blockIndex}/props`,
        (assetId, fieldPath) => {
          if (referenceIds.includes(assetId))
            usages.push({ ...base, page, component, fieldPath });
        },
        budget,
        0,
        null,
        undefined,
        surface.version === '1.1.0',
      );
    });
  });
  return stableUsages(usages);
}

/** Tenant Asset ids declared by either manifest version. Catalog refs are excluded. */
export function siteSpecManifestAssetIds(value: unknown): string[] {
  const surface = parseSiteSpecReferenceSurface(value);
  return [
    ...new Set(
      Object.values(surface.assets)
        .filter((asset) => asset.source === 'tenant')
        .map((asset) => asset.assetId!),
    ),
  ].sort();
}

/** Asset-reference UUIDs in known SiteSpec media fields. Component/business UUIDs such as `id`
 * and `offeringRef` are deliberately excluded; every returned id must exist in the manifest. */
export function siteSpecPotentialAssetIds(value: unknown): {
  manifestIds: string[];
  manifestRefs: Record<string, { kind: string; hash: string }>;
  propAssetIds: string[];
  undeclaredAssetRefs: string[];
} {
  const surface = parseSiteSpecReferenceSurface(value);
  const references = new Set<string>();
  const budget = { nodes: 0 };
  const allowLogicalIds = surface.version === '1.1.0';
  for (const page of surface.pages) {
    if (page.puck.rootProps !== undefined) {
      visitAssetReferences(
        page.puck.rootProps,
        '/root',
        (assetId) => references.add(assetId),
        budget,
        0,
        null,
        undefined,
        allowLogicalIds,
      );
    }
    page.puck.content.forEach((block) =>
      visitAssetReferences(
        block.props,
        '/content',
        (assetId) => references.add(assetId),
        budget,
        0,
        null,
        undefined,
        allowLogicalIds,
      ),
    );
  }
  const undeclaredAssetRefs = [...references].filter(
    (referenceId) =>
      !Object.prototype.hasOwnProperty.call(surface.assets, referenceId),
  );
  const tenantEntries = Object.entries(surface.assets).filter(
    ([, asset]) => asset.source === 'tenant',
  );
  const manifestRefs = Object.fromEntries(
    tenantEntries.map(([, asset]) => [
      asset.assetId!,
      { kind: asset.kind!, hash: asset.hash },
    ]),
  );
  const usedTenantIds = [...references]
    .map((referenceId) => surface.assets[referenceId])
    .filter((asset) => asset?.source === 'tenant')
    .map((asset) => asset!.assetId!);
  return {
    manifestIds: Object.keys(manifestRefs).sort(),
    manifestRefs,
    propAssetIds: [...new Set(usedTenantIds)].sort(),
    undeclaredAssetRefs: undeclaredAssetRefs.sort(),
  };
}

/** Profile's complete as-built asset surface (R2-A3), shared by PATCH and DELETE. */
export function extractProfileAssetReferences(
  value: unknown,
): ProfileAssetReference[] {
  if (!isRecord(value)) return [];
  const references: ProfileAssetReference[] = [];
  const brand = isRecord(value.brand) ? value.brand : undefined;
  if (brand && typeof brand.logoAssetId === 'string') {
    references.push({
      source: 'profile',
      assetId: UUID_RE.test(brand.logoAssetId)
        ? brand.logoAssetId.toLowerCase()
        : brand.logoAssetId,
      expectedKind: 'logo',
      page: '$profile',
      component: 'brand',
      fieldPath: '/brand/logoAssetId',
    });
  }

  const trust = isRecord(value.trustAssets) ? value.trustAssets : undefined;
  const certifications =
    trust && Array.isArray(trust.certifications) ? trust.certifications : [];
  certifications.forEach((candidate, certificationIndex) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.certificateAssetIds))
      return;
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
  const customerCases =
    trust && Array.isArray(trust.customerCases) ? trust.customerCases : [];
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
    [left.assetId, left.fieldPath]
      .join('\0')
      .localeCompare([right.assetId, right.fieldPath].join('\0')),
  );
}

export function profileUsagesForAsset(
  value: unknown,
  assetId: string,
): AssetReferenceUsage[] {
  const canonicalAssetId = UUID_RE.test(assetId)
    ? assetId.toLowerCase()
    : assetId;
  const usages = extractProfileAssetReferences(value)
    .filter((reference) => reference.assetId === canonicalAssetId)
    .map(
      ({ assetId: _assetId, expectedKind: _expectedKind, ...usage }) => usage,
    );

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
const _siteSpecCompatibility: (
  value: SiteSpec,
  assetId: string,
) => AssetReferenceUsage[] = scanSiteSpecAssetReferences;
void _siteSpecCompatibility;
