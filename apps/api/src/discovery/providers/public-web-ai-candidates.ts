export interface AiCompanyCandidateHypotheses {
  candidates?: Array<{
    name?: unknown;
    country?: unknown;
    /** Deliberately ignored: model-proposed domains are not evidence. */
    domain?: unknown;
  }>;
}

const MAX_AI_CANDIDATES = 5;
const MAX_NAME_CHARS = 160;
const MAX_COUNTRY_CHARS = 80;

export function resolveAiCandidateExpansionEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('');
  return withoutControls
    .replace(/["“”]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

/**
 * AI output is a hypothesis list only. This function intentionally discards
 * model-proposed domains and turns names into exact web verification searches;
 * persistence remains exclusively downstream of search + crawl + extraction.
 */
export function buildVerifiedCandidateSearchQueries(
  value: AiCompanyCandidateHypotheses,
): string[] {
  const queries: string[] = [];
  for (const candidate of value.candidates ?? []) {
    if (typeof candidate.name !== 'string' || candidate.name.trim().length > MAX_NAME_CHARS) continue;
    const name = clean(candidate.name, MAX_NAME_CHARS);
    if (!name) continue;
    const country = clean(candidate.country, MAX_COUNTRY_CHARS);
    const query = `"${name}" official company${country ? ` ${country}` : ''}`;
    if (!queries.includes(query)) queries.push(query);
    if (queries.length >= MAX_AI_CANDIDATES) break;
  }
  return queries;
}
