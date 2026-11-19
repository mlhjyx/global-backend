import countries from 'world-countries';
import { normalizeCountryValue } from './company-normalization';
import { normalizeDomain } from './identity';
import { mapCountryToQid } from './vocab';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function countryIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeCountryValue(value);
  if (normalized) return normalized;
  const name = value.normalize('NFKC').trim().toLowerCase();
  return countries.find((country) =>
    [country.name.common, country.name.official, country.cca2, country.cca3]
      .some((alias) => alias.toLowerCase() === name))?.cca2 ?? null;
}

function countryQidUnconfirmed(expectedCountry: string | null, key: string, facts: Record<string, unknown>): boolean {
  if (key !== 'wikidata' || !expectedCountry) return false;
  const declared = facts.country_qid ??
    (typeof facts.country === 'string' && /^Q\d+$/u.test(facts.country) ? facts.country : undefined);
  if (declared === undefined) return false;
  const knownCountry = countries.find((country) => country.cca2 === expectedCountry);
  const expectedQid = mapCountryToQid(expectedCountry) ?? mapCountryToQid(knownCountry?.name.common ?? '');
  return !expectedQid || declared !== expectedQid;
}

/** Out-of-scope or unverifiable country identities do not count as independent corroboration. */
export function enrichmentIdentityConflicts(
  company: { country: string | null; domain: string | null }, key: string, attributes: unknown,
): boolean {
  const facts = object(attributes);
  if (!facts) return false;
  const expectedCountry = countryIso(company.country);
  const actualCountry = countryIso(key === 'gleif' ? facts.registered_country : facts.country);
  if (countryQidUnconfirmed(expectedCountry, key, facts)) return true;
  if (expectedCountry && actualCountry && expectedCountry !== actualCountry) return true;
  const website = typeof facts.website === 'string' ? normalizeDomain(facts.website) : null;
  const domain = normalizeDomain(company.domain);
  return Boolean(domain && website && domain !== website);
}

/** Keep historical attributes intact; conflicting identities do not enter this fit snapshot. */
export function scopeIndependentEnrichment(
  company: { country: string | null; domain: string | null; attributes: unknown },
): unknown {
  const attributes = object(company.attributes);
  if (!attributes) return company.attributes;
  const conflicts = ['gleif', 'wikidata'].filter((key) =>
    Object.hasOwn(attributes, key) && enrichmentIdentityConflicts(company, key, attributes[key]));
  if (!conflicts.length) return company.attributes;
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => !conflicts.includes(key)));
}
