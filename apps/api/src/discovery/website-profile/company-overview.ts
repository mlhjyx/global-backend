import type { Prisma } from '@prisma/client';

import { scrubPii } from '../../common/pii-scrub';
import { isCompanyWebsitePageUrl } from '../impressum/find-legal-pages';
import { isContactFreeText, isStableSafeHttpsUrl } from '../raw-source-provider-normalizer';

const COMPANY_OVERVIEW_DESCRIPTION_MAX = 360;
const COMPANY_OVERVIEW_BUSINESS_LIMIT = 6;
const COMPANY_OVERVIEW_BUSINESS_MAX = 100;
const OVERVIEW_SOURCE_MAX = 2_400;
const PRIVATE_OR_INSTRUCTION_TEXT =
  /(?:\b(?:ceo|founder|owner|director|contact person|managing director|email|phone|ignore.{0,24}instructions|system prompt)\b|geschäftsführ|ansprechpartner|负责人|联系人|电子邮件|联系电话|忽略.{0,12}指令|\[redacted)/iu;

export interface CompanyOverviewPage {
  readonly url: string;
  readonly text: string;
  readonly fetchedAt: string;
}

export interface CompanyWebsiteOverview {
  readonly description: string | null;
  readonly main_business: readonly string[];
  readonly source_url: string;
  readonly fetched_at: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function publicText(value: unknown, max: number, min: number): string | null {
  if (typeof value !== 'string') return null;
  const text = normalizedText(value);
  if (text.length < min || text.length > max || !/\p{L}/u.test(text) ||
      /[<>\p{Cc}\p{Cf}]/u.test(text) || !isContactFreeText(text) ||
      PRIVATE_OR_INSTRUCTION_TEXT.test(text)) return null;
  return text;
}

export function companyWebsiteSource(url: unknown, domain: string | null): string | null {
  return domain && isStableSafeHttpsUrl(url) && isCompanyWebsitePageUrl(url, domain) ? url : null;
}

export const COMPANY_OVERVIEW_EVIDENCE_FIELD = 'company_website_overview';

function approvedPaths(value: Prisma.JsonValue | null): string[] | null {
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.startsWith('/'))) return null;
  return value as string[];
}

/** Advisory fetch permission alone does not authorize re-display of the website's prose. */
export async function companyWebsiteDisplayAllowed(
  db: Pick<Prisma.TransactionClient, 'sourcePolicy'>,
  sourceUrl: string,
): Promise<boolean> {
  if (!isStableSafeHttpsUrl(sourceUrl)) return false;
  const site = new URL(sourceUrl);
  const apex = site.hostname.replace(/^www\./u, '');
  const policies = await db.sourcePolicy.findMany({
    where: { domain: { in: [apex, 'www.' + apex] } },
    select: {
      sourceType: true, reviewStatus: true, termsStatus: true,
      allowedPurpose: true, allowedPaths: true, disallowedPaths: true,
    },
  });
  return policies.length > 0 && policies.every((policy) => {
    const allow = approvedPaths(policy.allowedPaths);
    const deny = approvedPaths(policy.disallowedPaths);
    const purpose = policy.allowedPurpose;
    return policy.sourceType === 'official_website' && policy.reviewStatus === 'APPROVED' &&
      policy.termsStatus === 'REVIEWED_OK' &&
      (purpose === null || (Array.isArray(purpose) && purpose.includes('enrichment'))) &&
      allow !== null && deny !== null &&
      (allow.length === 0 || allow.some((prefix) => site.pathname.startsWith(prefix))) &&
      !deny.some((prefix) => site.pathname.startsWith(prefix));
  });
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

export function prepareCompanyOverviewPage(
  page: CompanyOverviewPage | undefined,
  domain: string | null,
): CompanyOverviewPage | undefined {
  if (!page || !companyWebsiteSource(page.url, domain) || !validTimestamp(page.fetchedAt)) return undefined;
  const text = normalizedText(scrubPii(page.text)).slice(0, OVERVIEW_SOURCE_MAX);
  return text.length >= 24 ? { ...page, text } : undefined;
}

/** Only publish extracts verifiably present in the first-party homepage supplied to the model. */
export function extractCompanyWebsiteOverview(
  value: unknown,
  page: CompanyOverviewPage | undefined,
): CompanyWebsiteOverview | undefined {
  const output = record(value);
  if (!output || !page) return undefined;
  const description = publicText(output.description, COMPANY_OVERVIEW_DESCRIPTION_MAX, 24);
  const business = Array.isArray(output.main_business) ? output.main_business : [];
  const overview = readCompanyWebsiteOverview({
    description: description && page.text.includes(description) ? description : null,
    main_business: business.slice(0, COMPANY_OVERVIEW_BUSINESS_LIMIT).flatMap((item: unknown) => {
      const label = publicText(item, COMPANY_OVERVIEW_BUSINESS_MAX, 2);
      return label && page.text.includes(label) ? [label] : [];
    }),
    source_url: page.url,
    fetched_at: page.fetchedAt,
  });
  return overview?.description || overview?.main_business.length ? overview : undefined;
}

/** Validate stored facts at both the canonical-attributes and API boundaries. */
export function readCompanyWebsiteOverview(
  value: unknown,
  domain?: string | null,
): CompanyWebsiteOverview | undefined {
  const facts = record(value);
  if (!facts) return undefined;
  const { source_url, fetched_at } = facts;
  if (!isStableSafeHttpsUrl(source_url) ||
      (domain !== undefined && !companyWebsiteSource(source_url, domain)) ||
      !validTimestamp(fetched_at)) return undefined;
  const description = publicText(facts.description, COMPANY_OVERVIEW_DESCRIPTION_MAX, 24);
  const labels = Array.isArray(facts.main_business) ? facts.main_business : [];
  const mainBusiness = [...new Set(labels.slice(0, COMPANY_OVERVIEW_BUSINESS_LIMIT).flatMap((value: unknown) => {
    const label = publicText(value, COMPANY_OVERVIEW_BUSINESS_MAX, 2);
    return label ? [label] : [];
  }))];
  return { description, main_business: mainBusiness, source_url, fetched_at };
}

export function nextCompanyWebsiteOverview(
  currentValue: unknown,
  candidateValue: CompanyWebsiteOverview | undefined,
  domain: string | null,
): CompanyWebsiteOverview | undefined {
  const candidate = readCompanyWebsiteOverview(candidateValue, domain);
  if (!candidate) return undefined;
  const current = readCompanyWebsiteOverview(currentValue, domain);
  if (current && (
    current.fetched_at >= candidate.fetched_at ||
    (current.description && !candidate.description) ||
    (current.main_business.length > 0 && candidate.main_business.length === 0)
  )) return undefined;
  return candidate;
}

export async function loadCompanyOverviewPublication(
  tx: Pick<Prisma.TransactionClient, 'sourcePolicy' | 'fieldEvidence'>,
  workspaceId: string,
  company: { id: string; domain: string | null; attributes: unknown },
) {
  const attributes = record(company.attributes);
  const overview = readCompanyWebsiteOverview(attributes?.company_website_overview, company.domain);
  const previousProfile = record(attributes?.website_profile);
  const legacyUrl = companyWebsiteSource(previousProfile?.source_url, company.domain);
  const sourceUrls = new Set([overview?.source_url, legacyUrl].filter((url) => url != null));
  const allowedUrls: string[] = [];
  for (const url of sourceUrls) {
    if (await companyWebsiteDisplayAllowed(tx, url)) allowedUrls.push(url);
  }
  // The exact publication proof can be older than the activity evidence shown to the user.
  const proof = overview && allowedUrls.includes(overview.source_url)
    ? await tx.fieldEvidence.findFirst({
      where: {
        workspaceId, entityType: 'company', entityId: company.id,
        field: COMPANY_OVERVIEW_EVIDENCE_FIELD, sourceUrl: overview.source_url,
        fetchedAt: new Date(overview.fetched_at),
        dataClass: 'green', allowedActions: { array_contains: ['display'] },
      },
      select: { field: true, sourceUrl: true, fetchedAt: true, allowedActions: true },
    })
    : null;
  return { allowedUrls, proof };
}
