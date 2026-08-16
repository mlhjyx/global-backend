function normalizedTokens(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .split(/[^\p{L}\p{N}]+/gu)
    .filter(Boolean);
}

const WORLD_BANK_QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'of',
  'on',
  'or',
  'per',
  'the',
  'to',
  'via',
  'with',
]);

function isInformativeQueryToken(token: string): boolean {
  return [...token].length >= 3 && !WORLD_BANK_QUERY_STOP_WORDS.has(token);
}

function conservativeEnglishVariants(token: string): Set<string> {
  const variants = new Set([token]);

  if (/[^aeiou]ies$/u.test(token)) {
    variants.add(`${token.slice(0, -3)}y`);
  } else if (/(?:sses|xes|zes|ches|shes)$/u.test(token)) {
    variants.add(token.slice(0, -2));
  } else if (token.endsWith('s')) {
    // Only a plain trailing s is reversed. Words ending in -is/-us/-ss/-ous
    // are kept exact so analysis, business and status are never truncated.
    if (!/(?:ss|is|us|ous)$/u.test(token)) variants.add(token.slice(0, -1));
  } else if (/[^aeiou]y$/u.test(token)) {
    variants.add(`${token.slice(0, -1)}ies`);
  } else if (/(?:x|z|ch|sh)$/u.test(token)) {
    variants.add(`${token}es`);
  } else {
    variants.add(`${token}s`);
  }

  return variants;
}

/**
 * World Bank qterm is OR/full-text recall, not a business-evidence predicate.
 * A record is a local positive when at least one informative token from any
 * non-empty query keyword occurs as a complete token (or a conservative English
 * singular/plural variant) in the organization, notice title, or project name.
 * Country, stop words and tokens shorter than three characters are intentionally
 * excluded from the query evidence.
 */
export function worldBankBusinessEvidenceMatches(
  facts: { organizationName?: string; title?: string; projectName?: string },
  keywords: readonly string[],
): boolean {
  const requiredTokens = new Set(keywords.flatMap(normalizedTokens).filter(isInformativeQueryToken));
  if (!requiredTokens.size) return false;
  const evidenceTokens = new Set(
    [facts.organizationName, facts.title, facts.projectName]
      .filter((value): value is string => Boolean(value))
      .flatMap(normalizedTokens),
  );
  return [...requiredTokens].some((token) => {
    const variants = conservativeEnglishVariants(token);
    return [...variants].some((variant) => evidenceTokens.has(variant));
  });
}
