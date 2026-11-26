import { isPdfDocumentUrl } from '../../adapters/pdf-url-guard';
import { parseWildcardDisallow } from '../../adapters/robots';
import { isCrawl4aiRenderEmptyHtml, type CrawlHtmlResult } from '../../adapters/web-crawler';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import { artifactSubjectSkipReason } from '../../tools/artifact-subject-denial';
import { BudgetExceededError, BudgetOperationReplayError } from '../../tools/budget-store';
import type { HttpGetInput, HttpGetOutput } from '../../tools/source-tools';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import {
  extractHtmlChannelsAndLinks,
  extractJsonLdFacts,
  extractVisibleBodyText,
  isPdfBodyContent,
  isThinHtmlPage,
  type JsonLdFacts,
} from './raw-html-parser';

export {
  extractHtmlChannelsAndLinks,
  extractJsonLdFacts,
  extractVisibleBodyText,
  isPdfBodyContent,
  isThinHtmlPage,
  THIN_VISIBLE_TEXT_THRESHOLD,
} from './raw-html-parser';

const WWW_RETRY_CODE_RE =
  /ERR_TLS_CERT_ALTNAME_INVALID|UND_ERR_SOCKET|ERR_TLS_CERT_ALTNAME|CERT_COMMON_NAME_INVALID|HOSTNAME_MISMATCH|ECONNRESET|EPROTO/iu;

const MAX_COMBINED_TEXT_CHARS = 12_000;

export interface StreamingExtractionChannels {
  readonly roleEmails: readonly string[];
  readonly otherEmails: readonly string[];
  readonly phones: readonly string[];
  readonly socialLinks: readonly string[];
  readonly hasInquiryForm: boolean;
  readonly contactFormUrl: string | null;
  readonly contactPageUrl: string | null;
  readonly impressumUrl: string | null;
  readonly careersPageUrl: string | null;
}

export interface StreamingCompanyExtraction {
  readonly domain: string;
  readonly homepageUrl: string;
  readonly fetchMethod: 'raw_http' | 'crawl4ai' | 'skipped';
  readonly usedCrawl4aiFallback: boolean;
  readonly usedWwwRetry: boolean;
  readonly pdfSkipped: boolean;
  readonly robotsBlocked: boolean;
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly visibleText: string;
  readonly jsonLd: JsonLdFacts;
  readonly channels: StreamingExtractionChannels;
  readonly pagesFetched: readonly string[];
  readonly failureReason: string | null;
}

export interface ExtractCompanyWebsiteStreamingInput {
  readonly broker: ExecutionBroker;
  readonly workspaceId: string;
  readonly companyId: string;
  readonly runId: string;
  readonly domain: string;
  readonly homepageUrl?: string;
  readonly robotsCache?: Map<string, readonly string[]>;
  readonly authorizeExternalAction?: () => Promise<boolean>;
}

interface PageFetchOutcome {
  readonly html: string;
  readonly finalUrl: string;
  readonly method: 'raw_http' | 'crawl4ai' | 'skipped';
  readonly usedCrawl4aiFallback: boolean;
  readonly usedWwwRetry: boolean;
  readonly pdfSkipped: boolean;
  readonly robotsBlocked: boolean;
  readonly failureReason: string | null;
}

function shouldRethrowBrokerError(error: unknown): boolean {
  return (
    isExecutionControlError(error) ||
    error instanceof BudgetExceededError ||
    error instanceof BudgetOperationReplayError
  );
}

/** Law 2 (#30): detect apex TLS/socket failures eligible for single www. prefix retry. */
export function isWwwRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
  const parts = [err.code, err.message, err.cause?.code, err.cause?.message]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  return WWW_RETRY_CODE_RE.test(parts);
}

export function buildWwwFallbackUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname || /^www\./iu.test(parsed.hostname) || !parsed.hostname.includes('.')) {
      return null;
    }
    parsed.hostname = `www.${parsed.hostname}`;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeHomepageUrl(domain: string, override?: string): string {
  if (override && /^https?:\/\//iu.test(override.trim())) {
    return override.trim();
  }
  const cleanDomain = domain.trim().replace(/^https?:\/\//iu, '').replace(/\/.*$/u, '').toLowerCase();
  return `https://${cleanDomain}/`;
}

function toolCtx(input: ExtractCompanyWebsiteStreamingInput, correlationKey: string): ToolContext {
  return {
    workspaceId: input.workspaceId,
    taskContractId: 'discovery.classify_trade_role',
    correlationId: `${input.runId}:${input.companyId}:${correlationKey}`,
    purpose: ['discovery', 'enrichment'],
    runId: input.runId,
    artifactSubject: { subjectType: 'company', subjectId: input.companyId },
    ...(input.authorizeExternalAction ? { authorizeExternalAction: input.authorizeExternalAction } : {}),
  };
}

async function isPathAllowedByRobotsViaBroker(
  input: ExtractCompanyWebsiteStreamingInput,
  targetUrl: string,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  const origin = parsed.origin;
  const cache = input.robotsCache;
  let disallow = cache?.get(origin);
  if (!disallow) {
    try {
      const res = await input.broker.invoke<HttpGetInput, HttpGetOutput>(
        'http.get',
        { url: `${origin}/robots.txt`, timeoutMs: 5_000 },
        toolCtx(input, `robots:${origin}`),
      );
      if (res.data.blocked) {
        disallow = ['/'];
      } else if (res.data.ok && res.data.text) {
        disallow = parseWildcardDisallow(res.data.text);
      } else {
        disallow = [];
      }
    } catch (error) {
      if (shouldRethrowBrokerError(error)) throw error;
      if (artifactSubjectSkipReason(error)) return false;
      // Network/TLS errors on robots.txt degrade to allow-homepage-only (same RFC convention).
      disallow = [];
    }
    cache?.set(origin, disallow);
  }
  const pathWithQuery = `${parsed.pathname}${parsed.search}`;
  return !disallow.some((prefix) => prefix === '/' || pathWithQuery.startsWith(prefix));
}

async function invokeRawHttpWithWwwRetry(
  input: ExtractCompanyWebsiteStreamingInput,
  url: string,
  tag: string,
): Promise<{ output: HttpGetOutput | null; finalUrl: string; usedWwwRetry: boolean; failureReason: string | null }> {
  const attempt = async (target: string, suffix: string) =>
    input.broker.invoke<HttpGetInput, HttpGetOutput>(
      'http.get',
      {
        url: target,
        timeoutMs: 12_000,
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      },
      toolCtx(input, `${tag}:${suffix}`),
    );

  try {
    const res = await attempt(url, 'raw');
    return { output: res.data, finalUrl: res.data.finalUrl || url, usedWwwRetry: false, failureReason: null };
  } catch (error) {
    if (shouldRethrowBrokerError(error)) throw error;
    const subjectReason = artifactSubjectSkipReason(error);
    if (subjectReason) {
      return { output: null, finalUrl: url, usedWwwRetry: false, failureReason: subjectReason };
    }
    if (isWwwRetryableError(error)) {
      const wwwUrl = buildWwwFallbackUrl(url);
      if (wwwUrl) {
        try {
          const retry = await attempt(wwwUrl, 'www');
          return {
            output: retry.data,
            finalUrl: retry.data.finalUrl || wwwUrl,
            usedWwwRetry: true,
            failureReason: null,
          };
        } catch (retryError) {
          if (shouldRethrowBrokerError(retryError)) throw retryError;
          return {
            output: null,
            finalUrl: wwwUrl,
            usedWwwRetry: true,
            failureReason: retryError instanceof Error ? retryError.message.slice(0, 120) : 'HTTP_WWW_RETRY_FAILED',
          };
        }
      }
    }
    return {
      output: null,
      finalUrl: url,
      usedWwwRetry: false,
      failureReason: error instanceof Error ? error.message.slice(0, 120) : 'HTTP_FETCH_FAILED',
    };
  }
}

async function fetchSinglePageHtml(
  input: ExtractCompanyWebsiteStreamingInput,
  targetUrl: string,
  tag: string,
  allowCrawl4aiFallback: boolean,
): Promise<PageFetchOutcome> {
  if (isPdfDocumentUrl(targetUrl)) {
    return {
      html: '',
      finalUrl: targetUrl,
      method: 'skipped',
      usedCrawl4aiFallback: false,
      usedWwwRetry: false,
      pdfSkipped: true,
      robotsBlocked: false,
      failureReason: 'PDF_URL_SKIPPED',
    };
  }

  const allowed = await isPathAllowedByRobotsViaBroker(input, targetUrl);
  if (!allowed) {
    return {
      html: '',
      finalUrl: targetUrl,
      method: 'skipped',
      usedCrawl4aiFallback: false,
      usedWwwRetry: false,
      pdfSkipped: false,
      robotsBlocked: true,
      failureReason: 'ROBOTS_BLOCKED',
    };
  }

  const raw = await invokeRawHttpWithWwwRetry(input, targetUrl, tag);
  if (raw.output?.blocked) {
    return {
      html: '',
      finalUrl: raw.finalUrl,
      method: 'skipped',
      usedCrawl4aiFallback: false,
      usedWwwRetry: raw.usedWwwRetry,
      pdfSkipped: false,
      robotsBlocked: false,
      failureReason: raw.output.blocked,
    };
  }

  const rawText = raw.output?.ok ? raw.output.text : '';
  if (rawText && isPdfBodyContent(rawText)) {
    return {
      html: '',
      finalUrl: raw.finalUrl,
      method: 'skipped',
      usedCrawl4aiFallback: false,
      usedWwwRetry: raw.usedWwwRetry,
      pdfSkipped: true,
      robotsBlocked: false,
      failureReason: 'PDF_BODY_SKIPPED',
    };
  }

  if (raw.failureReason && /HTTP_GET_ARTIFACT_UTF8_INVALID/iu.test(raw.failureReason)) {
    return {
      html: '',
      finalUrl: raw.finalUrl,
      method: 'skipped',
      usedCrawl4aiFallback: false,
      usedWwwRetry: raw.usedWwwRetry,
      pdfSkipped: true,
      robotsBlocked: false,
      failureReason: 'BINARY_BODY_SKIPPED',
    };
  }

  if (rawText && !isThinHtmlPage(extractVisibleBodyText(rawText))) {
    return {
      html: rawText,
      finalUrl: raw.finalUrl,
      method: 'raw_http',
      usedCrawl4aiFallback: false,
      usedWwwRetry: raw.usedWwwRetry,
      pdfSkipped: false,
      robotsBlocked: false,
      failureReason: null,
    };
  }

  if (!allowCrawl4aiFallback || isPdfDocumentUrl(raw.finalUrl)) {
    return {
      html: rawText,
      finalUrl: raw.finalUrl,
      method: rawText ? 'raw_http' : 'skipped',
      usedCrawl4aiFallback: false,
      usedWwwRetry: raw.usedWwwRetry,
      pdfSkipped: false,
      robotsBlocked: false,
      failureReason: rawText ? null : raw.failureReason ?? 'HTTP_EMPTY',
    };
  }

  try {
    const rendered = await input.broker.invoke<{ url: string }, CrawlHtmlResult & { robotsBlocked?: boolean }>(
      'crawl4ai.render',
      { url: raw.finalUrl },
      toolCtx(input, `${tag}:render`),
    );
    if (rendered.data.robotsBlocked) {
      return {
        html: '',
        finalUrl: raw.finalUrl,
        method: 'skipped',
        usedCrawl4aiFallback: true,
        usedWwwRetry: raw.usedWwwRetry,
        pdfSkipped: false,
        robotsBlocked: true,
        failureReason: 'ROBOTS_BLOCKED',
      };
    }
    const html = isCrawl4aiRenderEmptyHtml(rendered.data.html) ? '' : rendered.data.html;
    if (html) {
      return {
        html,
        finalUrl: rendered.data.url || raw.finalUrl,
        method: 'crawl4ai',
        usedCrawl4aiFallback: true,
        usedWwwRetry: raw.usedWwwRetry,
        pdfSkipped: false,
        robotsBlocked: false,
        failureReason: null,
      };
    }
  } catch (error) {
    if (shouldRethrowBrokerError(error)) throw error;
  }

  return {
    html: rawText,
    finalUrl: raw.finalUrl,
    method: rawText ? 'raw_http' : 'skipped',
    usedCrawl4aiFallback: true,
    usedWwwRetry: raw.usedWwwRetry,
    pdfSkipped: false,
    robotsBlocked: false,
    failureReason: rawText ? null : raw.failureReason ?? 'RENDER_EMPTY',
  };
}

function mergeUnique(a: readonly string[], b: readonly string[], cap = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...a, ...b]) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Plan B single-activity extractor: Raw HTTP first -> in-memory HTML parse ->
 * thin-page (<200 visible chars) Crawl4AI fallback -> bounded 1-hop contact page merge.
 */
export async function extractCompanyWebsiteStreaming(
  input: ExtractCompanyWebsiteStreamingInput,
): Promise<StreamingCompanyExtraction> {
  const robotsCache = input.robotsCache ?? new Map<string, readonly string[]>();
  const scopedInput: ExtractCompanyWebsiteStreamingInput = { ...input, robotsCache };
  const initialUrl = normalizeHomepageUrl(input.domain, input.homepageUrl);

  const home = await fetchSinglePageHtml(scopedInput, initialUrl, 'home', true);
  if (!home.html) {
    return {
      domain: input.domain,
      homepageUrl: home.finalUrl,
      fetchMethod: 'skipped',
      usedCrawl4aiFallback: home.usedCrawl4aiFallback,
      usedWwwRetry: home.usedWwwRetry,
      pdfSkipped: home.pdfSkipped,
      robotsBlocked: home.robotsBlocked,
      title: null,
      metaDescription: null,
      visibleText: '',
      jsonLd: {
        organizationNames: [],
        descriptions: [],
        emails: [],
        phones: [],
        socialLinks: [],
        products: [],
        jobPostings: [],
      },
      channels: {
        roleEmails: [],
        otherEmails: [],
        phones: [],
        socialLinks: [],
        hasInquiryForm: false,
        contactFormUrl: null,
        contactPageUrl: null,
        impressumUrl: null,
        careersPageUrl: null,
      },
      pagesFetched: [],
      failureReason: home.failureReason,
    };
  }

  const homeText = extractVisibleBodyText(home.html);
  const homeJsonLd = extractJsonLdFacts(home.html);
  const homeChannels = extractHtmlChannelsAndLinks(home.html, home.finalUrl, input.domain);
  const pagesFetched = [home.finalUrl];

  let combinedText = homeText;
  let mergedJsonLd = homeJsonLd;
  let roleEmails = [...homeChannels.roleEmails];
  let otherEmails = [...homeChannels.otherEmails];
  let phones = [...homeChannels.phones];
  let socialLinks = [...homeChannels.socialLinks];
  let hasInquiryForm = homeChannels.hasInquiryForm;
  let contactFormUrl = homeChannels.hasInquiryForm ? home.finalUrl : null;
  let usedCrawl4aiFallback = home.usedCrawl4aiFallback;
  let usedWwwRetry = home.usedWwwRetry;
  let pdfSkipped = home.pdfSkipped;

  if (homeChannels.contactPageUrl) {
    const needRenderOnContact = roleEmails.length === 0 && !hasInquiryForm;
    const contact = await fetchSinglePageHtml(
      scopedInput,
      homeChannels.contactPageUrl,
      'contact',
      needRenderOnContact,
    );
    usedCrawl4aiFallback = usedCrawl4aiFallback || contact.usedCrawl4aiFallback;
    usedWwwRetry = usedWwwRetry || contact.usedWwwRetry;
    pdfSkipped = pdfSkipped || contact.pdfSkipped;
    if (contact.html) {
      pagesFetched.push(contact.finalUrl);
      const contactText = extractVisibleBodyText(contact.html);
      if (contactText) {
        combinedText = `${combinedText}\n\n[CONTACT_PAGE]\n${contactText}`.slice(0, MAX_COMBINED_TEXT_CHARS);
      }
      const contactJsonLd = extractJsonLdFacts(contact.html);
      const contactParsed = extractHtmlChannelsAndLinks(contact.html, contact.finalUrl, input.domain);
      mergedJsonLd = {
        organizationNames: mergeUnique(homeJsonLd.organizationNames, contactJsonLd.organizationNames, 10),
        descriptions: mergeUnique(homeJsonLd.descriptions, contactJsonLd.descriptions, 5),
        emails: mergeUnique(homeJsonLd.emails, contactJsonLd.emails, 15),
        phones: mergeUnique(homeJsonLd.phones, contactJsonLd.phones, 10),
        socialLinks: mergeUnique(homeJsonLd.socialLinks, contactJsonLd.socialLinks, 10),
        products: mergeUnique(homeJsonLd.products, contactJsonLd.products, 20),
        jobPostings: [...homeJsonLd.jobPostings, ...contactJsonLd.jobPostings].slice(0, 10),
      };
      roleEmails = mergeUnique(roleEmails, contactParsed.roleEmails, 15);
      otherEmails = mergeUnique(otherEmails, contactParsed.otherEmails, 15);
      phones = mergeUnique(phones, contactParsed.phones, 15);
      socialLinks = mergeUnique(socialLinks, contactParsed.socialLinks, 15);
      if (contactParsed.hasInquiryForm && !hasInquiryForm) {
        hasInquiryForm = true;
        contactFormUrl = contact.finalUrl;
      }
    }
  }

  return {
    domain: input.domain,
    homepageUrl: home.finalUrl,
    fetchMethod: home.method,
    usedCrawl4aiFallback,
    usedWwwRetry,
    pdfSkipped,
    robotsBlocked: false,
    title: homeChannels.title,
    metaDescription: homeChannels.metaDescription,
    visibleText: combinedText,
    jsonLd: mergedJsonLd,
    channels: {
      roleEmails,
      otherEmails,
      phones,
      socialLinks,
      hasInquiryForm,
      contactFormUrl,
      contactPageUrl: homeChannels.contactPageUrl,
      impressumUrl: homeChannels.impressumUrl,
      careersPageUrl: homeChannels.careersPageUrl,
    },
    pagesFetched,
    failureReason: null,
  };
}
