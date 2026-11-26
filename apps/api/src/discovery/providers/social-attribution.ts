import { cleanPersonName } from './contact-extraction';
import { isCrossCompanySocialMismatch, isJunkContactCandidate } from './contact-quality-filter';
import {
  companyMatchLevel,
  companyNameTokens,
  foldRoleText,
  hasDistinctiveCompanyEvidence,
  hasRoleEvidence,
  LEGAL_FORM_TOKENS,
  textContainsCompanyPhrase,
  textMentionsDomain,
  type CompanyMatchLevel,
} from './social-role-lexicon';

export interface SocialAttributionCompany {
  name: string;
  domain?: string;
  country?: string;
}

export interface SocialAttributionInput {
  url: string;
  title?: string;
  snippet?: string;
  highlights?: readonly string[];
}

export type SocialAttributionDecision = 'ACCEPTED' | 'REVIEW' | 'REJECTED';
export type SocialAttributionDropReason =
  | 'namesake'
  | 'organisation'
  | 'uninformative'
  | 'generic_name';

export interface SocialAttributionResult {
  decision: SocialAttributionDecision;
  score: number;
  dropReason?: SocialAttributionDropReason;
  fullName?: string;
  parsedTitle?: string;
  matchedFeatures: readonly string[];
}

const HEADLINE_SEGMENT_RE = /\s*[|·]\s*|\s+[–—-]\s+/u;
const PREVIOUS_EMPLOYMENT_RE = /\b(?:former(?:ly)?|previously|ex[-\s]|ehemalig\p{L}*|ancien(?:ne)?|precedentemente)\b/iu;
const ACCEPT_THRESHOLD = 0.75;
const REVIEW_THRESHOLD = 0.45;

function sigmoid(logOdds: number): number {
  return 1 / (1 + Math.exp(-logOdds));
}

function parseHeadline(title: string): { fullName: string; title?: string } | null {
  const segments = title
    .split(HEADLINE_SEGMENT_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !/^(linkedin|xing)$/iu.test(segment));
  if (!segments.length) return null;
  const fullName = segments[0]!;
  const words = fullName.split(/\s+/u).filter(Boolean);
  if (words.length < 2 || words.length > 6) return null;
  const role = segments.length > 1 ? segments[1] : undefined;
  return { fullName, ...(role ? { title: role } : {}) };
}

function extractLastSlugSegment(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? '';
  } catch {
    return '';
  }
}

function evaluateSlugSignals(
  rawUrl: string,
  personNames: readonly string[],
  company: SocialAttributionCompany,
): { slugCompanyMatch: CompanyMatchLevel; slugPersonMatch: boolean } {
  const lastSegment = extractLastSlugSegment(rawUrl);
  if (!lastSegment) {
    return { slugCompanyMatch: 'none', slugPersonMatch: false };
  }
  const foldSlug = lastSegment.toLowerCase().replace(/[^a-z0-9]/gu, '');
  const rawSlugTokens = lastSegment.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);

  const personTokens = new Set<string>();
  for (const name of personNames) {
    for (const token of foldRoleText(name).split(' ')) {
      const alnum = token.replace(/[^a-z0-9]/gu, '');
      if (alnum.length >= 3) personTokens.add(alnum);
    }
  }

  let slugPersonMatch = false;
  let slugResidual = foldSlug;
  for (const token of personTokens) {
    if (foldSlug.includes(token)) {
      slugPersonMatch = true;
      slugResidual = slugResidual.split(token).join('');
    }
  }
  const residualRawTokens = rawSlugTokens.filter((token) => !personTokens.has(token));

  const tokens = companyNameTokens(company);
  const companyPhraseSlug = tokens
    .map((t) => t.folded.replace(/[^a-z0-9]/gu, ''))
    .filter(Boolean)
    .join('');

  if (companyPhraseSlug.length >= 6 && slugResidual.includes(companyPhraseSlug)) {
    return { slugCompanyMatch: 'distinctive', slugPersonMatch };
  }

  let slugCompanyMatch: CompanyMatchLevel = 'none';
  for (const token of tokens) {
    const alnum = token.raw.replace(/[^a-z0-9]/gu, '');
    if (alnum.length < 3 || LEGAL_FORM_TOKENS.has(alnum)) continue;
    const hit =
      (alnum.length >= 4 && slugResidual.includes(alnum)) ||
      residualRawTokens.includes(alnum);
    if (!hit) continue;
    const level = companyMatchLevel(alnum, company);
    if (level === 'distinctive') {
      return { slugCompanyMatch: 'distinctive', slugPersonMatch };
    }
    if (level === 'generic') slugCompanyMatch = 'generic';
  }

  const domainRoot = company.domain?.toLowerCase().split('.')[0]?.replace(/[^a-z0-9]/gu, '');
  if (
    domainRoot &&
    domainRoot.length >= 4 &&
    (slugResidual.includes(domainRoot) || residualRawTokens.includes(domainRoot))
  ) {
    const level = companyMatchLevel(domainRoot, company);
    if (level === 'distinctive') {
      return { slugCompanyMatch: 'distinctive', slugPersonMatch };
    }
    if (level === 'generic') slugCompanyMatch = 'generic';
  }

  return { slugCompanyMatch, slugPersonMatch };
}

function stripNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of names) {
    if (name) out = out.split(name).join(' ');
  }
  return out;
}

function scoreWithEmploymentHistory(
  rawScore: number,
  company: SocialAttributionCompany,
  headline: string,
  headlineCompanyMatch: CompanyMatchLevel,
  contextParts: readonly string[],
) {
  const text = headlineCompanyMatch === 'distinctive' ? [headline] : [headline, ...contextParts];
  const previousAffiliation = text
    .flatMap((part) => part.split(/(?<=[.!?])\s+|[;,\n|]+/u))
    .some((clause) => PREVIOUS_EMPLOYMENT_RE.test(clause) && companyMatchLevel(clause, company) === 'distinctive');
  return {
    previousAffiliation,
    score: previousAffiliation ? Math.min(rawScore, ACCEPT_THRESHOLD - 0.01) : rawScore,
  };
}

/** Heuristic log-odds ranking from company, role and profile evidence. */
export function scoreSocialAttribution(
  input: SocialAttributionInput,
  company: SocialAttributionCompany,
): SocialAttributionResult {
  const headline = (input.title ?? '').trim();
  if (!headline) {
    return { decision: 'REJECTED', score: 0, dropReason: 'uninformative', matchedFeatures: [] };
  }
  const parsed = parseHeadline(headline);
  if (!parsed) {
    return { decision: 'REJECTED', score: 0, dropReason: 'uninformative', matchedFeatures: [] };
  }
  const fullName = cleanPersonName(parsed.fullName);
  if (fullName === null) {
    return { decision: 'REJECTED', score: 0.05, dropReason: 'organisation', matchedFeatures: [] };
  }

  const personNames = parsed.fullName === fullName ? [fullName] : [parsed.fullName, fullName];
  const headlineRemainder = stripNames(headline, personNames);
  const contextParts = [input.snippet ?? '', ...(input.highlights ?? [])]
    .map((part) => part.trim())
    .filter(Boolean);
  const contextRaw = contextParts.join(' ');
  const contextRemainder = stripNames(contextRaw, personNames);
  const combinedRemainder = `${headlineRemainder} ${contextRemainder}`.trim();
  const combinedText = `${headline} ${contextRaw}`.trim();

  const { slugCompanyMatch, slugPersonMatch } = evaluateSlugSignals(input.url, personNames, company);
  const headlineCompanyMatch = companyMatchLevel(headlineRemainder, company);
  const contextCompanyMatch = contextRemainder
    ? companyMatchLevel(contextRemainder, company)
    : 'none';
  const domainMatch = textMentionsDomain(combinedRemainder, company.domain);
  const companyPhraseMatch = textContainsCompanyPhrase(combinedRemainder, company);
  const hasDistinctiveCombined =
    hasDistinctiveCompanyEvidence(combinedRemainder, company) ||
    headlineCompanyMatch === 'distinctive' ||
    contextCompanyMatch === 'distinctive' ||
    slugCompanyMatch === 'distinctive';
  const crossCompanyMismatch = isCrossCompanySocialMismatch(combinedRemainder, company);
  const roleInHeadline = hasRoleEvidence(headline, parsed.fullName, company);
  const roleInCombined = roleInHeadline || hasRoleEvidence(combinedText, parsed.fullName, company);
  const junkCandidate = isJunkContactCandidate({ fullName, title: parsed.title });

  const matchedFeatures: string[] = [];
  let logOdds = -1.2;

  if (slugCompanyMatch === 'distinctive') {
    logOdds += 2.4;
    matchedFeatures.push('slug_company_distinctive');
  } else if (slugCompanyMatch === 'generic') {
    logOdds += 0.6;
    matchedFeatures.push('slug_company_generic');
  }

  if (domainMatch) {
    logOdds += 2.3;
    matchedFeatures.push('domain_match');
  }
  if (companyPhraseMatch) {
    logOdds += 2.0;
    matchedFeatures.push('company_phrase_match');
  }

  if (headlineCompanyMatch === 'distinctive') {
    logOdds += 1.85;
    matchedFeatures.push('headline_company_distinctive');
  } else if (headlineCompanyMatch === 'generic') {
    logOdds += 0.4;
    matchedFeatures.push('headline_company_generic');
  }

  if (contextCompanyMatch === 'distinctive') {
    logOdds += 1.65;
    matchedFeatures.push('context_company_distinctive');
  } else if (contextCompanyMatch === 'generic') {
    logOdds += 0.35;
    matchedFeatures.push('context_company_generic');
  }

  if (roleInHeadline) {
    logOdds += 1.35;
    matchedFeatures.push('role_headline');
  } else if (roleInCombined) {
    logOdds += 1.05;
    matchedFeatures.push('role_context');
  }

  if (slugPersonMatch) {
    logOdds += 0.35;
    matchedFeatures.push('slug_person');
  }

  if (crossCompanyMismatch) {
    logOdds -= 3.5;
    matchedFeatures.push('cross_company_mismatch');
  }

  const rawScore = Number(sigmoid(logOdds).toFixed(4));
  const anyCompanyEvidence =
    headlineCompanyMatch !== 'none' ||
    contextCompanyMatch !== 'none' ||
    slugCompanyMatch !== 'none';

  // Reject unanchored, generic and role-free matches before assigning a confidence.
  if (!anyCompanyEvidence || crossCompanyMismatch) {
    return {
      decision: 'REJECTED',
      score: Math.min(rawScore, 0.25),
      dropReason: 'namesake',
      fullName,
      ...(parsed.title ? { parsedTitle: parsed.title } : {}),
      matchedFeatures,
    };
  }
  if (!hasDistinctiveCombined) {
    return {
      decision: 'REJECTED',
      score: Math.min(rawScore, 0.35),
      dropReason: 'generic_name',
      fullName,
      ...(parsed.title ? { parsedTitle: parsed.title } : {}),
      matchedFeatures,
    };
  }
  if (!roleInCombined || junkCandidate) {
    return {
      decision: 'REJECTED',
      score: Math.min(rawScore, 0.35),
      dropReason: 'uninformative',
      fullName,
      ...(parsed.title ? { parsedTitle: parsed.title } : {}),
      matchedFeatures,
    };
  }

  const { score, previousAffiliation } = scoreWithEmploymentHistory(
    rawScore, company, headlineRemainder, headlineCompanyMatch, contextParts,
  );
  if (previousAffiliation) matchedFeatures.push('previous_affiliation');
  const decision: SocialAttributionDecision =
    score >= ACCEPT_THRESHOLD ? 'ACCEPTED' : score >= REVIEW_THRESHOLD ? 'REVIEW' : 'REJECTED';

  return {
    decision,
    score,
    ...(decision === 'REJECTED' ? { dropReason: 'namesake' as const } : {}),
    fullName,
    ...(parsed.title ? { parsedTitle: parsed.title } : {}),
    matchedFeatures,
  };
}
