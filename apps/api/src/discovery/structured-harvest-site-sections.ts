import { isContactFreeText } from "./raw-source-provider-normalizer";

export const STRUCTURED_HARVEST_SITE_SECTION_KEYS = Object.freeze([
  ".well-known",
  "about",
  "blog",
  "careers",
  "company",
  "docs",
  "downloads",
  "events",
  "industries",
  "insights",
  "jobs",
  "news",
  "partners",
  "press",
  "products",
  "publications",
  "resources",
  "services",
  "solutions",
  "support",
  "sustainability",
  "technology",
] as const);

export const MAX_STRUCTURED_HARVEST_SITE_SECTION_KEYS = 20;
export const MAX_STRUCTURED_HARVEST_SITE_SECTION_COUNT = 5_000;
export const MAX_STRUCTURED_HARVEST_SITE_SECTION_KEY_BYTES = 24;

const admittedSiteSectionKeys = new Set<string>(
  STRUCTURED_HARVEST_SITE_SECTION_KEYS,
);

/**
 * Sitemap path segments are untrusted input and become JSON keys. Admit only
 * an exact, contact/secret-free coarse section vocabulary used by the current
 * tally producer; ambiguous dynamic segments fail closed.
 */
export function isStructuredHarvestSiteSectionKey(value: string): boolean {
  return (
    value.normalize("NFKC") === value &&
    Buffer.byteLength(value, "utf8") <=
      MAX_STRUCTURED_HARVEST_SITE_SECTION_KEY_BYTES &&
    isContactFreeText(value) &&
    admittedSiteSectionKeys.has(value)
  );
}

export function sanitizeStructuredHarvestSiteSections(
  value: unknown,
): Record<string, number> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length === 0 ||
    entries.length > MAX_STRUCTURED_HARVEST_SITE_SECTION_KEYS
  ) {
    return undefined;
  }
  const admitted = entries
    .filter(
      (entry): entry is [string, number] =>
        isStructuredHarvestSiteSectionKey(entry[0]) &&
        Number.isSafeInteger(entry[1]) &&
        Number(entry[1]) >= 1 &&
        Number(entry[1]) <= MAX_STRUCTURED_HARVEST_SITE_SECTION_COUNT,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return admitted.length ? Object.fromEntries(admitted) : undefined;
}
