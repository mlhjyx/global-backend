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
  /**
   * The bare name is also an ordinary word or first name (Leo, DAB, Zenit …):
   * it counts only on a line that mentions pumps or another, unambiguous brand.
   * Aliases always count.
   */
  readonly ambiguous?: boolean;
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
  { name: 'DAB', country: 'it', aliases: ['DAB Pumps', 'DAB Pumpen'], ambiguous: true },
  { name: 'Calpeda', country: 'it' },
  { name: 'Speroni', country: 'it' },
  { name: 'Saer', country: 'it', ambiguous: true },
  { name: 'Zenit', country: 'it', ambiguous: true },
  { name: 'Ebara', country: 'jp' },
  { name: 'Tsurumi', country: 'jp' },
  { name: 'Espa', country: 'es', ambiguous: true },
  { name: 'Flygt', country: 'se' },
  { name: 'Xylem', country: 'us' },
  { name: 'Pentair', country: 'us' },
  { name: 'Franklin Electric', country: 'us' },
  { name: 'Sulzer', country: 'ch' },
  { name: 'Verder', country: 'nl', ambiguous: true },
  { name: 'Leo', country: 'cn', aliases: ['Leo Pumps', 'Leo Pumpen', 'LEO Group'], ambiguous: true },
  { name: 'Shimge', country: 'cn' },
  { name: 'Taifu', country: 'cn' },
  { name: 'CNP', country: 'cn', aliases: ['Nanfang Pump'], ambiguous: true },
  { name: 'Shakti', country: 'in', ambiguous: true },
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

/** Whole-word, case-insensitive occurrences of `term` (start indexes). */
function occurrences(text: string, term: string): number[] {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'giu');
  return [...text.matchAll(pattern)].map((match) => match.index ?? 0);
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? text.length : end);
}

const PUMP_TERM = /pump/iu;

/** A word-like brand name counts on a line about pumps or naming another, unambiguous brand. */
function inBrandContext(line: string, brand: KnownBrand, dictionary: readonly KnownBrand[]): boolean {
  if (PUMP_TERM.test(line)) return true;
  return dictionary.some(
    (other) =>
      other !== brand &&
      !other.ambiguous &&
      [other.name, ...(other.aliases ?? [])].some((term) => occurrences(line, term).length > 0),
  );
}

function firstMention(text: string, brand: KnownBrand, dictionary: readonly KnownBrand[]): number {
  const aliasHits = (brand.aliases ?? []).flatMap((alias) => occurrences(text, alias));
  const nameHits = occurrences(text, brand.name).filter(
    (index) => !brand.ambiguous || inBrandContext(lineAt(text, index), brand, dictionary),
  );
  const hits = [...aliasHits, ...nameHits];
  return hits.length ? Math.min(...hits) : Number.POSITIVE_INFINITY;
}

/** Brands in order of first mention; `homeCountry` is the target market (ISO alpha-2). */
export function matchCarriedBrands(
  text: string,
  homeCountry: string,
  dictionary: readonly KnownBrand[] = KNOWN_PUMP_BRANDS,
): CarriedBrandMatch {
  const found = dictionary
    .map((brand) => ({ brand, at: firstMention(text, brand, dictionary) }))
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
