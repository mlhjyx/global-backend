import type { PuckBlock, SitePage, SiteSpec } from '@global/contracts';
import type { NormalizedBuildRequest } from './build-request-contract';

export class BuildTargetNotFoundError extends Error {
  constructor(target: string) {
    super(
      `build target ${target} was not found in the active and generated SiteSpec`,
    );
    this.name = 'BuildTargetNotFoundError';
  }
}

export class BuildTargetAmbiguousError extends Error {
  constructor(target: string) {
    super(`build target ${target} is not unique in SiteSpec`);
    this.name = 'BuildTargetAmbiguousError';
  }
}

export class BuildActiveSpecInvalidError extends Error {
  constructor() {
    super('active SiteSpec is not structurally safe for a partial build');
    this.name = 'BuildActiveSpecInvalidError';
  }
}

function assertPartialSpecShape(value: SiteSpec): void {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.pages) ||
    !value.site ||
    typeof value.site !== 'object' ||
    Array.isArray(value.site) ||
    !value.copyBundles ||
    typeof value.copyBundles !== 'object' ||
    Array.isArray(value.copyBundles) ||
    value.pages.some(
      (page) =>
        !page ||
        typeof page !== 'object' ||
        typeof page.id !== 'string' ||
        !page.puck ||
        typeof page.puck !== 'object' ||
        Array.isArray(page.puck) ||
        !Array.isArray(page.puck.content) ||
        page.puck.content.some(
          (block) =>
            !block ||
            typeof block !== 'object' ||
            !block.props ||
            typeof block.props !== 'object' ||
            Array.isArray(block.props),
        ),
    )
  ) {
    throw new BuildActiveSpecInvalidError();
  }
}

export function assertActiveBuildTargets(
  active: SiteSpec | null,
  request: NormalizedBuildRequest,
): void {
  const ids = request.options?.pages;
  if (request.scope === 'site' && !ids) return;
  if (!active) {
    throw new BuildTargetNotFoundError(
      request.targetId ?? ids?.join(',') ?? 'active-version',
    );
  }
  assertPartialSpecShape(active);
  if (active.copyBundleSet) {
    const activeLocales = sortedUnique(active.site.locales);
    const requestedLocales = sortedUnique(request.options?.locales ?? ['en']);
    if (
      !activeLocales ||
      !requestedLocales ||
      JSON.stringify(requestedLocales) !== JSON.stringify(activeLocales)
    ) {
      throw new BuildActiveSpecInvalidError();
    }
  }
  const pages = pageMap(active);
  if (request.scope === 'page' || ids) {
    for (const id of ids ?? [request.targetId!]) {
      if (!pages.has(id)) throw new BuildTargetNotFoundError(id);
    }
    return;
  }
  findBlock(active, request.targetId!);
}

function pageMap(spec: SiteSpec): Map<string, SitePage> {
  const pages = new Map<string, SitePage>();
  for (const page of spec.pages) {
    if (pages.has(page.id)) throw new BuildTargetAmbiguousError(page.id);
    pages.set(page.id, page);
  }
  return pages;
}

function blockId(block: PuckBlock): string | null {
  return typeof block.props.id === 'string' ? block.props.id : null;
}

function findBlock(
  spec: SiteSpec,
  targetId: string,
): { page: SitePage; index: number; block: PuckBlock } {
  const found: { page: SitePage; index: number; block: PuckBlock }[] = [];
  for (const page of spec.pages) {
    page.puck.content.forEach((block, index) => {
      if (blockId(block) === targetId) found.push({ page, index, block });
    });
  }
  if (found.length === 0) throw new BuildTargetNotFoundError(targetId);
  if (found.length > 1) throw new BuildTargetAmbiguousError(targetId);
  return found[0];
}

function collectKeys(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, out));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.endsWith('Key') && typeof child === 'string') out.add(child);
    else collectKeys(child, out);
  }
}

function mergeCopyKeys(
  active: SiteSpec,
  candidate: SiteSpec,
  keys: Set<string>,
): SiteSpec['copyBundles'] {
  const merged = structuredClone(active.copyBundles);
  for (const locale of candidate.site.locales) {
    const candidateBundle = candidate.copyBundles[locale];
    if (!candidateBundle) continue;
    const target = { ...(merged[locale] ?? {}) };
    for (const key of keys) {
      if (Object.hasOwn(candidateBundle, key))
        target[key] = candidateBundle[key];
    }
    merged[locale] = target;
  }
  return merged;
}

function sortedUnique(values: readonly string[]): string[] | null {
  const unique = [...new Set(values)].sort();
  return unique.length === values.length ? unique : null;
}

function assertCompleteAuthoritativeLocaleSet(
  active: SiteSpec,
  candidate: SiteSpec,
): void {
  if (!candidate.copyBundleSet) return;
  const activeLocales = sortedUnique(active.site.locales);
  const candidateLocales = sortedUnique(candidate.site.locales);
  const bundleLocales = sortedUnique(
    Object.keys(candidate.copyBundleSet.bundles),
  );
  if (
    !activeLocales ||
    !candidateLocales ||
    !bundleLocales ||
    JSON.stringify(candidateLocales) !== JSON.stringify(activeLocales) ||
    JSON.stringify(bundleLocales) !== JSON.stringify(activeLocales) ||
    candidate.site.defaultLocale !== active.site.defaultLocale ||
    candidate.copyBundleSet.sourceLocale !== active.site.defaultLocale
  ) {
    throw new BuildActiveSpecInvalidError();
  }
}

/** Applies a generated candidate only to the requested active SiteSpec surface. */
export function applyBuildScope(
  active: SiteSpec | null,
  candidate: SiteSpec,
  request: NormalizedBuildRequest,
): SiteSpec {
  const selectedPages = request.options?.pages;
  const fullSite = request.scope === 'site' && !selectedPages;
  if (fullSite) return candidate;
  assertActiveBuildTargets(active, request);
  if (!active) throw new BuildTargetNotFoundError('active-version');
  const base = active;
  if (base.specVersion !== candidate.specVersion) {
    throw new Error('active and generated SiteSpec versions are incompatible');
  }
  assertCompleteAuthoritativeLocaleSet(base, candidate);

  const activePages = pageMap(base);
  const candidatePages = pageMap(candidate);
  if (request.scope === 'page' || selectedPages) {
    const ids = selectedPages ?? [request.targetId!];
    const replacements = new Map<string, SitePage>();
    const keys = new Set<string>();
    for (const id of ids) {
      const current = activePages.get(id);
      const replacement = candidatePages.get(id);
      if (!current || !replacement) throw new BuildTargetNotFoundError(id);
      replacements.set(id, replacement);
      keys.add(replacement.seo.titleKey);
      keys.add(replacement.seo.descriptionKey);
      collectKeys(replacement.puck, keys);
    }
    return {
      ...structuredClone(base),
      site: candidate.copyBundleSet
        ? structuredClone(candidate.site)
        : structuredClone(base.site),
      pages: base.pages.map((page) => replacements.get(page.id) ?? page),
      copyBundles: mergeCopyKeys(base, candidate, keys),
      ...(candidate.copyBundleSet
        ? { copyBundleSet: structuredClone(candidate.copyBundleSet) }
        : {}),
    };
  }

  const targetId = request.targetId!;
  const current = findBlock(base, targetId);
  const replacement = findBlock(candidate, targetId);
  const keys = new Set<string>();
  collectKeys(replacement.block, keys);
  return {
    ...structuredClone(base),
    site: candidate.copyBundleSet
      ? structuredClone(candidate.site)
      : structuredClone(base.site),
    pages: base.pages.map((page) =>
      page.id !== current.page.id
        ? page
        : {
            ...page,
            puck: {
              ...page.puck,
              content: page.puck.content.map((block, index) =>
                index === current.index ? replacement.block : block,
              ),
            },
          },
    ),
    copyBundles: mergeCopyKeys(base, candidate, keys),
    ...(candidate.copyBundleSet
      ? { copyBundleSet: structuredClone(candidate.copyBundleSet) }
      : {}),
  };
}
