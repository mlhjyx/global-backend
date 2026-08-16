import countries from 'world-countries';

type CountryRow = {
  cca2: string;
  cca3: string;
  name: { common: string; official: string };
  altSpellings: string[];
};

const COUNTRY_TO_ALPHA2 = new Map<string, string>();
for (const country of countries as CountryRow[]) {
  for (const alias of [
    country.cca2,
    country.cca3,
    country.name.common,
    country.name.official,
    ...(country.altSpellings ?? []),
  ]) {
    if (alias) COUNTRY_TO_ALPHA2.set(alias.normalize('NFC').trim().toLocaleLowerCase('en-US'), country.cca2);
  }
}

/** Strict ISO alpha-2 normalization for identity decisions. Unknown values stay unknown. */
export function countryAlpha2(value: string | null | undefined): string | null {
  if (!value) return null;
  return COUNTRY_TO_ALPHA2.get(value.normalize('NFC').trim().toLocaleLowerCase('en-US')) ?? null;
}
