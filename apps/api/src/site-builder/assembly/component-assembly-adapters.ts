import {
  QUALIFIED_COMPONENT_CONTENT_BUDGETS,
  validateBlock,
  type BlueprintSectionV2,
  type SiteSpecComponentType,
} from '@global/contracts';

export const CONTROLLED_ASSEMBLY_COMPONENT_TYPES = [
  'ArticleGrid',
  'AxiomHero',
  'CertWall',
  'ChapterShowcase',
  'CollectionCards',
  'CtaBanner',
  'CtaCenter',
  'DishesShowcase',
  'DispatchHero',
  'EditorialHero',
  'FaqAccordion',
  'FaqSplit',
  'FarmhouseHero',
  'FeatureCards',
  'FeaturedSpotlight',
  'HeroBanner',
  'HeroFull',
  'IndustrialHero',
  'InquiryForm',
  'LedgerStats',
  'MaterialsLibrary',
  'MinimalHero',
  'PhotoGallery',
  'ProcessSteps',
  'ProcessTimeline',
  'ProductGrid',
  'ProductShowcaseAlt',
  'ProjectsGrid',
  'ServicesEditorial',
  'ServicesGrid',
  'StatementBlock',
  'StatsBand',
  'StoryChapters',
  'TechSystems',
  'TrustSplit',
  'WarmHero',
] as const satisfies readonly SiteSpecComponentType[];

type ControlledComponentType =
  (typeof CONTROLLED_ASSEMBLY_COMPONENT_TYPES)[number];

export interface ComponentAdapterPolicy {
  componentType: ControlledComponentType;
  /** Props are produced only from a server-owned qualified template. */
  propsShape: 'm1-e-a-qualified-fixture';
  ctaPolicy: 'none' | 'internal-page-only' | 'internal-or-approved-https';
  evidencePolicy: 'optional' | 'required-when-section-requires-evidence';
  minItems: number;
  maxItems: number;
  copyLimits: Readonly<Record<string, number>>;
}

export interface BuildAdapterPropsInput {
  pageKey: string;
  section: BlueprintSectionV2;
  serverTemplate: Record<string, unknown>;
  pageIds: readonly string[];
  assetReferenceIds: readonly string[];
  assetUrls: Readonly<Record<string, string>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyLimitsFor(
  type: ControlledComponentType,
): Readonly<Record<string, number>> {
  const budget = QUALIFIED_COMPONENT_CONTENT_BUDGETS[type] as Record<
    string,
    number
  >;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(budget).filter(
        ([key]) =>
          !/^min|^max/.test(key) && !key.toLowerCase().endsWith('words'),
      ),
    ),
  );
}

function itemBounds(type: ControlledComponentType): {
  minItems: number;
  maxItems: number;
} {
  const budget = QUALIFIED_COMPONENT_CONTENT_BUDGETS[type] as Record<
    string,
    number
  >;
  const minimum =
    budget.minItems ??
    budget.minStats ??
    budget.minPlans ??
    budget.minClients ??
    0;
  const maximum =
    budget.maxItems ??
    budget.maxStats ??
    budget.maxPlans ??
    budget.maxClients ??
    1;
  return { minItems: minimum, maxItems: maximum };
}

const CTA_COMPONENTS = new Set<ControlledComponentType>([
  'CtaBanner',
  'CtaCenter',
  'DispatchHero',
  'EditorialHero',
  'FarmhouseHero',
  'HeroBanner',
  'HeroFull',
  'IndustrialHero',
  'InquiryForm',
  'MaterialsLibrary',
  'MinimalHero',
  'ProductShowcaseAlt',
  'ServicesEditorial',
  'WarmHero',
]);

export const COMPONENT_ASSEMBLY_ADAPTERS: Readonly<
  Record<ControlledComponentType, ComponentAdapterPolicy>
> = Object.freeze(
  Object.fromEntries(
    CONTROLLED_ASSEMBLY_COMPONENT_TYPES.map((componentType) => {
      const bounds = itemBounds(componentType);
      return [
        componentType,
        Object.freeze({
          componentType,
          propsShape: 'm1-e-a-qualified-fixture',
          ctaPolicy: CTA_COMPONENTS.has(componentType)
            ? 'internal-page-only'
            : 'none',
          evidencePolicy: 'required-when-section-requires-evidence',
          ...bounds,
          copyLimits: copyLimitsFor(componentType),
        } satisfies ComponentAdapterPolicy),
      ];
    }),
  ) as Record<ControlledComponentType, ComponentAdapterPolicy>,
);

function stableSlotKey(
  pageKey: string,
  sectionId: string,
  semanticPath: readonly (string | number)[],
): string {
  const semantic = semanticPath
    .map(String)
    .join('.')
    .replace(/key$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-');
  return `${pageKey}.${sectionId}.${semantic}`.toLowerCase();
}

function controlledClone(
  value: unknown,
  input: BuildAdapterPropsInput,
  path: Array<string | number> = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      controlledClone(item, input, [...path, index]),
    );
  }
  if (!record(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const fieldPath = [...path, key];
    if (key === 'id') {
      result[key] =
        `${input.section.componentType}-${input.pageKey}-${input.section.id}`;
    } else if (key === 'variant') {
      result[key] = input.section.variant;
    } else if (
      (key === 'assetId' || key.endsWith('AssetId')) &&
      typeof child === 'string' &&
      input.assetReferenceIds.length > 0
    ) {
      const index = path.filter((part) => typeof part === 'number').at(-1) ?? 0;
      result[key] =
        input.assetReferenceIds[index % input.assetReferenceIds.length];
    } else if (key.endsWith('Key') && typeof child === 'string') {
      result[key] = stableSlotKey(input.pageKey, input.section.id, fieldPath);
    } else if (
      (key === 'pageId' || key.endsWith('PageId')) &&
      typeof child === 'string'
    ) {
      result[key] = input.pageIds.includes(child)
        ? child
        : input.pageIds.includes('contact')
          ? 'contact'
          : input.pageIds[0];
    } else if (key === 'variantUrl' && typeof child === 'string') {
      const index = path.filter((part) => typeof part === 'number').at(-1) ?? 0;
      const assetId =
        input.assetReferenceIds[index % input.assetReferenceIds.length] ??
        (typeof value.assetId === 'string' ? value.assetId : '');
      result[key] = input.assetUrls[assetId] ?? child;
    } else {
      result[key] = controlledClone(child, input, fieldPath);
    }
  }
  return result;
}

function controlledAsset(
  input: BuildAdapterPropsInput,
  index: number,
): { assetId: string; variantUrl?: string } | undefined {
  const assetId =
    input.assetReferenceIds[index % input.assetReferenceIds.length];
  if (!assetId) return undefined;
  const variantUrl = input.assetUrls[assetId];
  return {
    assetId,
    ...(variantUrl ? { variantUrl } : {}),
  };
}

function attachControlledAssets(
  props: Record<string, unknown>,
  input: BuildAdapterPropsInput,
): void {
  if (input.assetReferenceIds.length === 0) return;
  if (input.section.componentType === 'PhotoGallery') {
    const items = Array.isArray(props.items) ? props.items : [];
    props.items = items.map((item, index) =>
      record(item)
        ? { ...item, ...controlledAsset(input, index) }
        : controlledAsset(input, index),
    );
    return;
  }
  const field =
    input.section.componentType === 'ProductShowcaseAlt'
      ? 'products'
      : ['CollectionCards', 'MaterialsLibrary', 'ProjectsGrid'].includes(
            input.section.componentType,
          )
        ? 'items'
        : undefined;
  if (!field || !Array.isArray(props[field])) return;
  props[field] = props[field].map((item, index) =>
    record(item) ? { ...item, asset: controlledAsset(input, index) } : item,
  );
}

function containsExternalUrl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsExternalUrl);
  if (!record(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      (key === 'url' && typeof child === 'string') ||
      containsExternalUrl(child),
  );
}

/**
 * Pure adapter boundary: neither model output nor arbitrary caller props are
 * merged. The server template is cloned, bounded substitutions are applied,
 * then the qualified component schema is revalidated.
 */
export function buildControlledComponentProps(
  input: BuildAdapterPropsInput,
): Record<string, unknown> {
  const adapter =
    COMPONENT_ASSEMBLY_ADAPTERS[
      input.section.componentType as ControlledComponentType
    ];
  if (!adapter || !record(input.serverTemplate)) {
    throw new Error(
      `CONTROLLED_ASSEMBLY_ADAPTER_MISSING: ${input.section.componentType}`,
    );
  }
  const props = controlledClone(input.serverTemplate, input) as Record<
    string,
    unknown
  >;
  attachControlledAssets(props, input);
  if (
    adapter.ctaPolicy === 'internal-page-only' &&
    containsExternalUrl(props)
  ) {
    throw new Error(
      `CONTROLLED_ASSEMBLY_EXTERNAL_CTA_FORBIDDEN: ${input.section.componentType}`,
    );
  }
  validateBlock({ type: input.section.componentType, props });
  return props;
}

export function assertControlledAssemblyAdapterCoverage(
  componentTypes: Iterable<SiteSpecComponentType>,
): void {
  const missing = [...new Set(componentTypes)].filter(
    (type) =>
      !Object.prototype.hasOwnProperty.call(COMPONENT_ASSEMBLY_ADAPTERS, type),
  );
  if (missing.length > 0) {
    throw new Error(
      `CONTROLLED_ASSEMBLY_ADAPTER_MISSING: ${missing.sort().join(',')}`,
    );
  }
}
