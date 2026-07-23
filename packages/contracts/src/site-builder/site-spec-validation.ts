import { validateBlock } from "./component-schema";
import { resolveSiteLocale } from "./locales";
import {
  SITE_SPEC_COMPONENT_TYPES,
  SITE_SPEC_V1_1_VERSION,
  SITE_SPEC_V1_VERSION,
  type AssetRefV1_1,
  type SiteSpec,
  type SiteSpecV1,
  type SiteSpecV1_1,
} from "./site-spec";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const MIME = /^[-\w.]+\/[-+\w.]+$/;

export type SiteSpecContractErrorCode =
  | "SITE_SPEC_INVALID"
  | "SITE_SPEC_UNSUPPORTED_VERSION"
  | "SITE_SPEC_LOCALE_INVALID"
  | "SITE_SPEC_ASSET_INVALID";

export class SiteSpecContractError extends Error {
  constructor(
    readonly code: SiteSpecContractErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SiteSpecContractError";
  }
}

function fail(code: SiteSpecContractErrorCode, message: string): never {
  throw new SiteSpecContractError(code, message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function nonBlank(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0
  );
}

function assertCommon(value: Record<string, unknown>): void {
  if (
    !record(value.site) ||
    !Array.isArray(value.pages) ||
    !record(value.assets)
  ) {
    fail("SITE_SPEC_INVALID", "site, pages, and assets are required");
  }
  const site = value.site;
  if (
    !nonBlank(site.defaultLocale) ||
    !Array.isArray(site.locales) ||
    site.locales.length === 0 ||
    !site.locales.every(nonBlank) ||
    new Set(site.locales).size !== site.locales.length ||
    !record(site.theme) ||
    !exactKeys(site.theme, ["preset"], ["tokenOverrides"]) ||
    !nonBlank(site.theme.preset) ||
    (site.theme.tokenOverrides !== undefined &&
      (!record(site.theme.tokenOverrides) ||
        !Object.values(site.theme.tokenOverrides).every(
          (token) => typeof token === "string",
        ))) ||
    !Array.isArray(site.nav) ||
    !record(site.seoGlobal) ||
    !exactKeys(site.seoGlobal, ["siteName"]) ||
    !nonBlank(site.seoGlobal.siteName)
  ) {
    fail(
      "SITE_SPEC_INVALID",
      "site identity, theme, locales, or navigation is invalid",
    );
  }
  if (
    site.outboundDomains !== undefined &&
    (!Array.isArray(site.outboundDomains) ||
      !site.outboundDomains.every(nonBlank))
  ) {
    fail("SITE_SPEC_INVALID", "outboundDomains must be a string array");
  }
  if (!site.locales.includes(site.defaultLocale)) {
    fail("SITE_SPEC_LOCALE_INVALID", "default locale is not in the locale set");
  }
  const locales = site.locales as string[];
  for (const locale of locales) {
    if (!resolveSiteLocale(locale)) {
      fail("SITE_SPEC_LOCALE_INVALID", `unsupported locale ${locale}`);
    }
  }
  const pageIds = new Set<string>();
  const paths = new Set<string>();
  for (const pageValue of value.pages) {
    if (
      !record(pageValue) ||
      !exactKeys(pageValue, ["id", "path", "puck", "seo"]) ||
      !nonBlank(pageValue.id) ||
      !IDENTIFIER.test(pageValue.id) ||
      !nonBlank(pageValue.path) ||
      !pageValue.path.startsWith("/") ||
      !record(pageValue.puck) ||
      !exactKeys(pageValue.puck, ["content", "root"]) ||
      !Array.isArray(pageValue.puck.content) ||
      !record(pageValue.puck.root) ||
      !exactKeys(pageValue.puck.root, [], ["props"]) ||
      (pageValue.puck.root.props !== undefined &&
        !record(pageValue.puck.root.props)) ||
      !record(pageValue.seo) ||
      !exactKeys(pageValue.seo, ["titleKey", "descriptionKey"]) ||
      !nonBlank(pageValue.seo.titleKey) ||
      !nonBlank(pageValue.seo.descriptionKey)
    ) {
      fail("SITE_SPEC_INVALID", "page envelope is malformed");
    }
    if (pageIds.has(pageValue.id) || paths.has(pageValue.path)) {
      fail("SITE_SPEC_INVALID", "page ids and paths must be unique");
    }
    pageIds.add(pageValue.id);
    paths.add(pageValue.path);
    for (const block of pageValue.puck.content) {
      if (
        !record(block) ||
        !exactKeys(block, ["type", "props"]) ||
        !nonBlank(block.type) ||
        !record(block.props)
      ) {
        fail("SITE_SPEC_INVALID", "component envelope is malformed");
      }
      validateBlock(
        block as unknown as {
          type: (typeof SITE_SPEC_COMPONENT_TYPES)[number];
          props: Record<string, unknown>;
        },
      );
    }
  }
  for (const nav of site.nav) {
    if (
      !record(nav) ||
      !exactKeys(nav, ["labelKey", "pageId"]) ||
      !nonBlank(nav.labelKey) ||
      !nonBlank(nav.pageId) ||
      !pageIds.has(nav.pageId)
    ) {
      fail("SITE_SPEC_INVALID", "navigation references an unknown page");
    }
  }
  if (
    !record(value.copyBundles) ||
    !Object.entries(value.copyBundles).every(
      ([locale, bundle]) =>
        locales.includes(locale) &&
        record(bundle) &&
        Object.values(bundle).every((copy) => typeof copy === "string"),
    )
  ) {
    fail("SITE_SPEC_INVALID", "copy bundles are malformed");
  }
}

function assertAssetV1_1(
  key: string,
  value: unknown,
): asserts value is AssetRefV1_1 {
  if (!record(value) || !nonBlank(key)) {
    fail("SITE_SPEC_ASSET_INVALID", "asset entry is malformed");
  }
  if (value.source === "tenant") {
    if (
      !exactKeys(value, [
        "source",
        "assetId",
        "kind",
        "contentHash",
        "variantId",
        "variantHash",
        "mimeType",
      ]) ||
      !UUID.test(value.assetId as string) ||
      !nonBlank(value.kind) ||
      !SHA256.test(value.contentHash as string) ||
      !UUID.test(value.variantId as string) ||
      !SHA256.test(value.variantHash as string) ||
      !MIME.test(value.mimeType as string)
    ) {
      fail("SITE_SPEC_ASSET_INVALID", `invalid tenant asset ${key}`);
    }
    return;
  }
  if (value.source === "catalog") {
    if (
      !exactKeys(value, [
        "source",
        "packId",
        "packVersion",
        "catalogAssetId",
        "sha256",
        "mimeType",
      ]) ||
      !nonBlank(value.packId) ||
      !nonBlank(value.packVersion) ||
      !nonBlank(value.catalogAssetId) ||
      !SHA256.test(value.sha256 as string) ||
      !MIME.test(value.mimeType as string)
    ) {
      fail("SITE_SPEC_ASSET_INVALID", `invalid catalog asset ${key}`);
    }
    return;
  }
  fail("SITE_SPEC_ASSET_INVALID", `unknown asset source for ${key}`);
}

export function siteDirectionMap(
  locales: readonly string[],
): Record<string, "ltr" | "rtl"> {
  const result: Record<string, "ltr" | "rtl"> = {};
  for (const locale of locales) {
    const definition = resolveSiteLocale(locale);
    if (!definition) {
      fail("SITE_SPEC_LOCALE_INVALID", `unsupported locale ${locale}`);
    }
    result[locale] = definition.direction;
  }
  return result;
}

export function validateSiteSpecV1(value: unknown): SiteSpecV1 {
  if (
    !record(value) ||
    value.specVersion !== SITE_SPEC_V1_VERSION ||
    !exactKeys(
      value,
      ["specVersion", "site", "pages", "assets", "copyBundles"],
      ["copyBundleSet"],
    )
  ) {
    fail("SITE_SPEC_INVALID", "SiteSpec v1 envelope is not closed");
  }
  assertCommon(value);
  const site = value.site as Record<string, unknown>;
  if (
    !exactKeys(
      site,
      ["defaultLocale", "locales", "theme", "nav", "seoGlobal"],
      ["outboundDomains"],
    )
  ) {
    fail("SITE_SPEC_INVALID", "SiteSpec v1 site envelope is not closed");
  }
  for (const [assetId, asset] of Object.entries(value.assets as object)) {
    if (
      !UUID.test(assetId) ||
      !record(asset) ||
      !exactKeys(asset, ["kind", "hash"]) ||
      !nonBlank(asset.kind) ||
      !SHA256.test(asset.hash as string)
    ) {
      fail("SITE_SPEC_ASSET_INVALID", `invalid v1 asset ${assetId}`);
    }
  }
  return value as unknown as SiteSpecV1;
}

export function validateSiteSpecV1_1(value: unknown): SiteSpecV1_1 {
  if (
    !record(value) ||
    value.specVersion !== SITE_SPEC_V1_1_VERSION ||
    !exactKeys(
      value,
      [
        "specVersion",
        "componentLibraryVersion",
        "rendererVersion",
        "site",
        "pages",
        "assets",
        "copyBundles",
      ],
      ["copyBundleSet"],
    ) ||
    !nonBlank(value.componentLibraryVersion) ||
    !nonBlank(value.rendererVersion)
  ) {
    fail("SITE_SPEC_INVALID", "SiteSpec v1.1 envelope is not closed");
  }
  assertCommon(value);
  const site = value.site as Record<string, unknown>;
  if (
    !exactKeys(
      site,
      [
        "defaultLocale",
        "locales",
        "theme",
        "nav",
        "seoGlobal",
        "archetype",
        "familyId",
        "dirByLocale",
      ],
      ["outboundDomains"],
    ) ||
    !nonBlank(site.archetype) ||
    !nonBlank(site.familyId) ||
    !record(site.dirByLocale)
  ) {
    fail("SITE_SPEC_INVALID", "SiteSpec v1.1 design identity is malformed");
  }
  const expectedDirections = siteDirectionMap(site.locales as string[]);
  if (JSON.stringify(site.dirByLocale) !== JSON.stringify(expectedDirections)) {
    fail(
      "SITE_SPEC_LOCALE_INVALID",
      "dirByLocale must come from locale registry",
    );
  }
  for (const [key, asset] of Object.entries(value.assets as object)) {
    assertAssetV1_1(key, asset);
  }
  return value as unknown as SiteSpecV1_1;
}

export function validateSiteSpec(value: unknown): SiteSpec {
  if (!record(value)) fail("SITE_SPEC_INVALID", "SiteSpec must be an object");
  if (value.specVersion === SITE_SPEC_V1_VERSION)
    return validateSiteSpecV1(value);
  if (value.specVersion === SITE_SPEC_V1_1_VERSION) {
    return validateSiteSpecV1_1(value);
  }
  fail("SITE_SPEC_UNSUPPORTED_VERSION", String(value.specVersion ?? ""));
}
