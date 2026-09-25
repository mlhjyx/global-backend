/**
 * Carried-brand dictionary (G3 5.4): a foreign brand on a distributor's site
 * is an import signal; a Chinese brand is the strongest one. Brand names are
 * company-level facts. Extend by adding entries; matching is whole-word.
 */

export interface KnownBrand {
  readonly name: string;
  /** ISO-3166 alpha-2 home country, lower case. */
  readonly country: string;
  readonly aliases?: readonly string[];
}

export const KNOWN_PUMP_BRANDS: readonly KnownBrand[] = Object.freeze([
  { name: 'Grundfos', country: 'dk' },
  { name: 'Wilo', country: 'de' },
  { name: 'KSB', country: 'de' },
  { name: 'Allweiler', country: 'de' },
  { name: 'Netzsch', country: 'de' },
  { name: 'Seepex', country: 'de' },
  { name: 'ProMinent', country: 'de' },
  { name: 'Lowara', country: 'it' },
  { name: 'Pedrollo', country: 'it' },
  { name: 'DAB', country: 'it', aliases: ['DAB Pumps'] },
  { name: 'Calpeda', country: 'it' },
  { name: 'Speroni', country: 'it' },
  { name: 'Saer', country: 'it' },
  { name: 'Zenit', country: 'it' },
  { name: 'Ebara', country: 'jp' },
  { name: 'Tsurumi', country: 'jp' },
  { name: 'Espa', country: 'es' },
  { name: 'Flygt', country: 'se' },
  { name: 'Xylem', country: 'us' },
  { name: 'Pentair', country: 'us' },
  { name: 'Franklin Electric', country: 'us' },
  { name: 'Sulzer', country: 'ch' },
  { name: 'Verder', country: 'nl' },
  { name: 'Leo', country: 'cn', aliases: ['Leo Pumps', 'Leo Pumpen', 'LEO Group'] },
  { name: 'Shimge', country: 'cn' },
  { name: 'Taifu', country: 'cn' },
  { name: 'CNP', country: 'cn', aliases: ['Nanfang Pump'] },
  { name: 'Shakti', country: 'in' },
]);

export interface CarriedBrand {
  readonly name: string;
  readonly country: string;
}

export interface CarriedBrandMatch {
  readonly brands: readonly CarriedBrand[];
  readonly carriesChineseBrand: boolean;
  readonly carriesForeignBrand: boolean;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function mentions(text: string, term: string): number {
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
  return match ? match.index : -1;
}

/** Brands in order of first mention; `homeCountry` is the target market (ISO alpha-2). */
export function matchCarriedBrands(
  text: string,
  homeCountry: string,
  dictionary: readonly KnownBrand[] = KNOWN_PUMP_BRANDS,
): CarriedBrandMatch {
  const found = dictionary
    .map((brand) => ({
      brand,
      at: Math.min(
        ...[brand.name, ...(brand.aliases ?? [])]
          .map((term) => mentions(text, term))
          .map((index) => (index < 0 ? Number.POSITIVE_INFINITY : index)),
      ),
    }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at)
    .map(({ brand }) => ({ name: brand.name, country: brand.country }));
  const home = homeCountry.toLowerCase();
  return {
    brands: found,
    carriesChineseBrand: found.some((b) => b.country === 'cn'),
    carriesForeignBrand: found.some((b) => b.country !== home),
  };
}
