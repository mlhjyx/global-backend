import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import type { HttpFirstCachePort } from '../../adapters/http-first-fetch';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ExecutionBroker } from '../../tools/tool-contract';
import { BudgetExceededError, BudgetOperationReplayError } from '../../tools/budget-store';
import { companyMayUseExternalProcessing } from '../company-suppression-gate';
import {
  extractCompanyWebsiteStreaming,
  type StreamingCompanyExtraction,
} from './raw-http-extractor';
import {
  normalizeCompanyDomain,
  type SharedFactsStreamingHook,
} from './shared-facts-hook';

/** Social platforms, registries, directories, marketplaces, and news sites that are not a company's own website. */
const EXCLUDED_OFFICIAL_HOST_SUFFIXES = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
  'youtube.com', 'tiktok.com', 'xing.com', 'pinterest.com', 'reddit.com',
  'wikipedia.org', 'wikidata.org', 'wikimedia.org', 'bloomberg.com', 'reuters.com',
  'crunchbase.com', 'pitchbook.com', 'dnb.com', 'zoominfo.com', 'apollo.io',
  'rocketreach.co', 'signalhire.com', 'lusha.com', 'glassdoor.com', 'indeed.com',
  'opencorporates.com', 'companieshouse.gov.uk', 'service.gov.uk', 'gov.uk',
  'northdata.com', 'northdata.de', 'companycheck.co.uk', 'endole.co.uk',
  'pomanda.com', 'bizdb.co.uk', 'kompass.com', 'europages.com', 'europages.co.uk',
  'europages.de', 'wlw.de', 'gelbeseiten.de', '11880.com', 'firmenwissen.de',
  'unternehmensregister.de', 'handelsregister.de', 'creditreform.de', 'implisense.com',
  'pappers.fr', 'societe.com', 'verif.com', 'infogreffe.fr', 'registroimprese.it',
  'ufficiocamerale.it', 'kvk.nl', 'drimble.nl', 'oozo.nl', 'yelp.com', 'trustpilot.com',
  'amazon.com', 'alibaba.com', '1688.com', 'made-in-china.com', 'globalsources.com',
  'tradekey.com', 'ec21.com', 'google.com', 'bing.com', 'yahoo.com', 'baidu.com',
  'qcc.com', 'qichacha.com', 'tianyancha.com', 'enfsolar.com', 'intersolar.de',
  'solarquotes.com.au', 'pv-magazine.com', 'pv-tech.org', 'sec.gov', 'europa.eu',
] as const;

const LEGAL_SUFFIX_TOKENS = new Set([
  'gmbh', 'mbh', 'ag', 'kg', 'ohg', 'ug', 'gbr', 'ev', 'ltd', 'limited', 'plc', 'llp',
  'inc', 'incorporated', 'llc', 'corp', 'corporation', 'co', 'company', 'bv', 'nv',
  'sa', 'sas', 'sarl', 'srl', 'spa', 'sl', 'slu', 'aps', 'as', 'ab', 'oy', 'pty',
  'lda', 'kft', 'zrt', 'sro', 'sp', 'zoo', 'spzoo', 'bhd', 'sdn', 'pte', 'kk', 'se',
]);

const GENERIC_COMPANY_TOKENS = new Set([
  'the', 'and', 'for', 'von', 'der', 'die', 'das', 'und', 'de', 'del', 'la', 'le', 'les',
  'group', 'holding', 'holdings', 'international', 'europe', 'europa', 'global',
  'deutschland', 'germany', 'uk', 'france', 'italia', 'italy', 'nederland', 'netherlands',
  'brasil', 'brazil', 'australia', 'canada', 'malaysia', 'turkey', 'turkiye',
  'energy', 'energie', 'solar', 'photovoltaik', 'photovoltaic', 'power', 'tech',
  'technologies', 'technology', 'solutions', 'systems', 'trading', 'services', 'service',
  'engineering', 'industries', 'industrial', 'electric', 'electrical', 'distribution',
]);

const COUNTRY_CCTLD_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  DE: ['.de'],
  AT: ['.at'],
  CH: ['.ch'],
  GB: ['.co.uk', '.uk'],
  UK: ['.co.uk', '.uk'],
  NL: ['.nl'],
  FR: ['.fr'],
  IT: ['.it'],
  ES: ['.es'],
  BR: ['.com.br', '.br'],
  AU: ['.com.au', '.au'],
  CA: ['.ca'],
  MY: ['.com.my', '.my'],
  TR: ['.com.tr', '.tr'],
  BE: ['.be'],
  PL: ['.pl'],
  PT: ['.pt'],
  JP: ['.co.jp', '.jp'],
});

const COUNTRY_NAME_HINTS: Readonly<Record<string, string>> = Object.freeze({
  DE: 'Germany',
  GB: 'UK',
  NL: 'Netherlands',
  BR: 'Brazil',
  AU: 'Australia',
  CA: 'Canada',
  MY: 'Malaysia',
  TR: 'Turkey',
  FR: 'France',
  IT: 'Italy',
  ES: 'Spain',
  AT: 'Austria',
  CH: 'Switzerland',
});

const CJK_RE = /[\u3400-\u9fff]/u;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const HOMEPAGE_PATH_RE = /^\/(?:(?:en|de|fr|it|es|nl|pt|tr|zh|ja)(?:-[a-z]{2})?\/?)?$/iu;

export type MissingDomainResolutionSource = 'existing' | 'attributes' | 'searxng' | 'conflict' | 'none';

export interface SearchResultCandidate {
  readonly url: string;
  readonly title?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shouldRethrowBrokerError(error: unknown): boolean {
  return (
    isExecutionControlError(error) ||
    error instanceof BudgetExceededError ||
    error instanceof BudgetOperationReplayError
  );
}

export function isExcludedOfficialHost(host: string): boolean {
  const lower = host.trim().toLowerCase().replace(/^www\./u, '');
  if (!lower || IPV4_RE.test(lower) || !lower.includes('.')) return true;
  if (lower.endsWith('.gov') || lower.includes('.gov.')) return true;
  return EXCLUDED_OFFICIAL_HOST_SUFFIXES.some(
    (suffix) => lower === suffix || lower.endsWith(`.${suffix}`),
  );
}

function parseCandidateUrl(rawUrl: string): { host: string; pathname: string } | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = normalizeCompanyDomain(parsed.hostname);
    if (!host || isExcludedOfficialHost(host)) return null;
    return { host, pathname: parsed.pathname || '/' };
  } catch {
    return null;
  }
}

function tokenizeNormalized(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

function extractCompanyTokens(companyName: string): {
  coreTokens: string[];
  distinctiveTokens: string[];
  joinedCore: string;
  joinedDistinctive: string;
} {
  const all = tokenizeNormalized(companyName);
  const withoutLegal = all.filter((token) => !LEGAL_SUFFIX_TOKENS.has(token));
  const coreTokens = withoutLegal.length > 0 ? withoutLegal : all;
  const distinctiveTokens = coreTokens.filter((token) => !GENERIC_COMPANY_TOKENS.has(token));
  return {
    coreTokens,
    distinctiveTokens,
    joinedCore: coreTokens.join(''),
    joinedDistinctive: distinctiveTokens.join(''),
  };
}

function domainLabelWithoutHyphens(host: string): string {
  const firstLabel = host.split('.')[0] ?? '';
  return firstLabel.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function matchesCountryCcTld(host: string, country?: string | null): boolean {
  if (!country) return false;
  const suffixes = COUNTRY_CCTLD_MAP[country.trim().toUpperCase()];
  if (!suffixes) return false;
  return suffixes.some((suffix) => host.endsWith(suffix));
}

function scoreHostAgainstTokens(
  sld: string,
  tokens: ReturnType<typeof extractCompanyTokens>,
): { score: number; matched: boolean } {
  if (!sld || sld.length < 3) return { score: 0, matched: false };
  const exactTargets = [tokens.joinedCore, tokens.joinedDistinctive].filter((t) => t.length >= 4);
  if (exactTargets.some((target) => sld === target || sld.includes(target) || target.includes(sld) && sld.length >= 5)) {
    return { score: 12, matched: true };
  }
  const strongDistinctive = tokens.distinctiveTokens.filter((t) => t.length >= 4);
  if (strongDistinctive.some((t) => sld.includes(t))) {
    return { score: 8, matched: true };
  }
  const matchingCore = tokens.coreTokens.filter((t) => t.length >= 4 && sld.includes(t));
  if (matchingCore.length >= 2) {
    return { score: 9, matched: true };
  }
  if (matchingCore.length === 1 && tokens.distinctiveTokens.length === 0) {
    return { score: 6, matched: true };
  }
  return { score: 0, matched: false };
}

function scoreTitleAgainstTokens(
  title: string,
  tokens: ReturnType<typeof extractCompanyTokens>,
): { score: number; fullCoreMatch: boolean } {
  const titleTokens = tokenizeNormalized(title);
  if (titleTokens.length === 0) return { score: 0, fullCoreMatch: false };
  const joinedTitle = titleTokens.join('');
  const fullCoreMatch =
    (tokens.joinedCore.length >= 4 && joinedTitle.includes(tokens.joinedCore)) ||
    (tokens.joinedDistinctive.length >= 5 && joinedTitle.includes(tokens.joinedDistinctive));
  if (fullCoreMatch) return { score: 6, fullCoreMatch: true };
  const titleSet = new Set(titleTokens);
  const distinctiveHits = tokens.distinctiveTokens.filter((t) => t.length >= 3 && titleSet.has(t)).length;
  if (distinctiveHits >= 2 || (distinctiveHits === 1 && tokens.distinctiveTokens.length === 1)) {
    return { score: 3, fullCoreMatch: false };
  }
  return { score: 0, fullCoreMatch: false };
}

export function extractDomainFromAttributes(attributes: unknown): string | null {
  if (!isPlainRecord(attributes)) return null;
  const rawNested = isPlainRecord(attributes.raw) ? attributes.raw : null;
  const candidates: unknown[] = [
    attributes.website,
    attributes.websiteUrl,
    attributes.homepage,
    attributes.homepageUrl,
    attributes.url,
    attributes.domain,
    rawNested?.website,
    rawNested?.websiteUrl,
    rawNested?.homepage,
    rawNested?.url,
  ];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const normalized = normalizeCompanyDomain(value);
    if (normalized && !isExcludedOfficialHost(normalized)) {
      return normalized;
    }
  }
  return null;
}

export function buildDomainLookupQuery(companyName: string, country?: string | null): string {
  const cleanName = companyName.replace(/["<>]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!cleanName) return '';
  if (CJK_RE.test(cleanName)) return `${cleanName} 官网`;
  const hint = country ? COUNTRY_NAME_HINTS[country.trim().toUpperCase()] : undefined;
  return hint ? `"${cleanName}" ${hint} official website` : `"${cleanName}" official website`;
}

/** Pure scorer: pick the highest-confidence official corporate domain from search results. */
export function pickOfficialDomainFromSearchResults(
  results: readonly SearchResultCandidate[],
  companyName: string,
  country?: string | null,
): string | null {
  const tokens = extractCompanyTokens(companyName);
  if (tokens.coreTokens.length === 0) return null;

  const bestByHost = new Map<string, number>();
  for (const item of results) {
    const parsed = parseCandidateUrl(item.url);
    if (!parsed) continue;
    const sld = domainLabelWithoutHyphens(parsed.host);
    const hostMatch = scoreHostAgainstTokens(sld, tokens);
    const titleMatch = scoreTitleAgainstTokens(item.title ?? '', tokens);
    const isHomepage = HOMEPAGE_PATH_RE.test(parsed.pathname);
    if (!hostMatch.matched && !(titleMatch.fullCoreMatch && isHomepage)) continue;
    const score =
      hostMatch.score +
      titleMatch.score +
      (isHomepage ? 2 : 0) +
      (matchesCountryCcTld(parsed.host, country) ? 2 : 0);
    if (score < 8) continue;
    const prev = bestByHost.get(parsed.host) ?? 0;
    if (score > prev) bestByHost.set(parsed.host, score);
  }

  let bestHost: string | null = null;
  let bestScore = 0;
  for (const [host, score] of bestByHost.entries()) {
    if (score > bestScore) {
      bestScore = score;
      bestHost = host;
    }
  }
  return bestHost;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'P2002' || code === '23505';
}

async function persistResolvedDomainSafely(
  prisma: PrismaService,
  workspaceId: string,
  companyId: string,
  domain: string,
): Promise<'saved' | 'conflict' | 'skipped'> {
  try {
    const updated = await prisma.withWorkspace(workspaceId, (tx) =>
      tx.canonicalCompany.updateMany({
        where: { id: companyId, domain: null, status: { not: 'SUPPRESSED' } },
        data: { domain, version: { increment: 1 } },
      }),
    );
    return updated.count === 1 ? 'saved' : 'skipped';
  } catch (error) {
    if (isUniqueConstraintError(error)) return 'conflict';
    throw error;
  }
}

export async function resolveMissingCompanyDomain(input: {
  broker: ExecutionBroker;
  prisma: PrismaService;
  workspaceId: string;
  companyId: string;
  runAccountKey: string;
  company: {
    name: string;
    domain: string | null;
    country: string | null;
    attributes: unknown;
  };
  authorizeExternalAction?: () => Promise<boolean>;
}): Promise<{ domain: string | null; source: MissingDomainResolutionSource }> {
  const existing = normalizeCompanyDomain(input.company.domain);
  if (existing) return { domain: existing, source: 'existing' };

  const fromAttrs = extractDomainFromAttributes(input.company.attributes);
  if (fromAttrs) {
    const outcome = await persistResolvedDomainSafely(
      input.prisma,
      input.workspaceId,
      input.companyId,
      fromAttrs,
    );
    return outcome === 'saved'
      ? { domain: fromAttrs, source: 'attributes' }
      : { domain: null, source: outcome === 'conflict' ? 'conflict' : 'none' };
  }

  const query = buildDomainLookupQuery(input.company.name, input.company.country);
  if (!query) return { domain: null, source: 'none' };
  if (input.authorizeExternalAction && !(await input.authorizeExternalAction())) {
    return { domain: null, source: 'none' };
  }

  let results: SearchResultCandidate[];
  try {
    const response = await input.broker.invoke<
      { q: string; categories?: string[] },
      { results?: SearchResultCandidate[] }
    >(
      'searxng.search',
      { q: query, categories: ['general'] },
      {
        workspaceId: input.workspaceId,
        taskContractId: 'discovery.extract_company',
        correlationId: `${input.runAccountKey}:${input.companyId}:l05-domain`,
        purpose: ['discovery'],
        runId: input.runAccountKey,
        ...(input.authorizeExternalAction ? { authorizeExternalAction: input.authorizeExternalAction } : {}),
      },
    );
    results = Array.isArray(response.data?.results) ? response.data.results : [];
  } catch (error) {
    if (shouldRethrowBrokerError(error)) throw error;
    return { domain: null, source: 'none' };
  }

  const picked = pickOfficialDomainFromSearchResults(
    results,
    input.company.name,
    input.company.country,
  );
  if (!picked) return { domain: null, source: 'none' };

  const outcome = await persistResolvedDomainSafely(
    input.prisma,
    input.workspaceId,
    input.companyId,
    picked,
  );
  return outcome === 'saved'
    ? { domain: picked, source: 'searxng' }
    : { domain: null, source: outcome === 'conflict' ? 'conflict' : 'none' };
}

export async function resolveL1ExtractionWithSharedFacts(input: {
  sharedFacts: SharedFactsStreamingHook;
  broker: ExecutionBroker;
  prisma: PrismaService;
  workspaceId: string;
  companyId: string;
  runAccountKey: string;
  company: {
    name: string;
    domain: string | null;
    country: string | null;
    attributes: unknown;
  };
  isImportedBuyer: boolean;
  urlContentCache?: HttpFirstCachePort;
}): Promise<{
  domain: string | null;
  domainResolutionSource: MissingDomainResolutionSource;
  extraction: StreamingCompanyExtraction | null;
  sharedFactHit: boolean;
  cooldownFlagged: boolean;
  cooldownRetryAfterDays: number | null;
}> {
  const authorizeExternalAction = () =>
    input.prisma.withWorkspace(input.workspaceId, (tx) =>
      companyMayUseExternalProcessing(tx, input.workspaceId, input.companyId),
    );
  const resolved = await resolveMissingCompanyDomain({
    broker: input.broker,
    prisma: input.prisma,
    workspaceId: input.workspaceId,
    companyId: input.companyId,
    runAccountKey: input.runAccountKey,
    company: input.company,
    authorizeExternalAction,
  });
  const effectiveDomain = resolved.domain;

  const preFetch = await input.sharedFacts.lookupL1PreFetch({
    domain: effectiveDomain,
  });
  const cooldownFlagged = preFetch.cooldown.cooledDown;
  const cooldownRetryAfterDays = cooldownFlagged ? preFetch.cooldown.retryAfterDays : null;

  if (preFetch.hit && preFetch.syntheticExtraction) {
    return {
      domain: effectiveDomain,
      domainResolutionSource: resolved.source,
      extraction: preFetch.syntheticExtraction,
      sharedFactHit: true,
      cooldownFlagged,
      cooldownRetryAfterDays,
    };
  }

  let extraction: StreamingCompanyExtraction | null = null;
  if (effectiveDomain) {
    extraction = await extractCompanyWebsiteStreaming({
      broker: input.broker,
      workspaceId: input.workspaceId,
      companyId: input.companyId,
      runId: input.runAccountKey,
      domain: effectiveDomain,
      authorizeExternalAction,
      ...(input.urlContentCache ? { urlContentCache: input.urlContentCache } : {}),
    });
    if (extraction.pagesFetched.length > 0) {
      await input.sharedFacts.writeBackFromStreamingExtraction({
        domain: effectiveDomain,
        legalName: input.company.name,
        country: input.company.country,
        extraction,
        isImportedBuyer: input.isImportedBuyer,
        companyAttributes: isPlainRecord(input.company.attributes)
          ? input.company.attributes
          : null,
      });
    }
  }

  return {
    domain: effectiveDomain,
    domainResolutionSource: resolved.source,
    extraction,
    sharedFactHit: false,
    cooldownFlagged,
    cooldownRetryAfterDays,
  };
}
