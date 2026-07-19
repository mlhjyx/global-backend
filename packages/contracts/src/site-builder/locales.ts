export const SITE_LOCALE_REGISTRY = [
  {
    tag: "en",
    direction: "ltr",
    copyGeneration: true,
    fontFamily: "Noto Sans",
  },
  {
    tag: "de-DE",
    direction: "ltr",
    copyGeneration: true,
    fontFamily: "Noto Sans",
  },
  {
    tag: "ar",
    direction: "rtl",
    copyGeneration: false,
    fontFamily: "Noto Sans Arabic",
  },
] as const;

export type SiteLocaleDefinition = (typeof SITE_LOCALE_REGISTRY)[number];
export type SiteRendererLocale = SiteLocaleDefinition["tag"];

export const RENDERER_LOCALES = SITE_LOCALE_REGISTRY.map(
  (locale) => locale.tag,
) as SiteRendererLocale[];

export const COPY_GENERATION_LOCALES = SITE_LOCALE_REGISTRY.filter(
  (locale) => locale.copyGeneration,
).map((locale) => locale.tag);

export function resolveSiteLocale(tag: string): SiteLocaleDefinition | null {
  let canonical: string;
  try {
    [canonical] = Intl.getCanonicalLocales(tag);
  } catch {
    return null;
  }
  if (canonical !== tag) return null;
  return SITE_LOCALE_REGISTRY.find((locale) => locale.tag === tag) ?? null;
}
