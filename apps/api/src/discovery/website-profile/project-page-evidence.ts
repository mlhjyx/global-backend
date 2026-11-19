import { isContactFreeText, isStableSafeHttpsUrl } from '../raw-source-provider-normalizer';

const MAX_SPANS = 6;
export const PROJECT_PAGE_MAX_SPAN_CHARS = 400;

export interface ProjectPageEvidence {
  readonly source_url: string;
  readonly fetched_at: string;
  readonly spans: readonly string[];
}

/** A single first-party HTML detail page. No parameters, aliases other than www, or file downloads. */
export function companyProjectPageUrl(raw: unknown, companyDomain?: string): string | null {
  if (typeof raw !== 'string' || raw.length > 1_024 || !isStableSafeHttpsUrl(raw) ||
      !isContactFreeText(raw.replace(/_/gu, ' '))) return null;
  const url = new URL(raw);
  if (url.href !== raw || url.search || url.hash || url.pathname === '/' || url.pathname.includes('%') ||
      /\.(?!html?$|php$|aspx?$)[a-z0-9]{1,8}\/?$/iu.test(url.pathname) ||
      /(?:^|\/)(?:impressum|imprint|legal-notice|privacy|datenschutz|kontakt|contact)(?:[/.]|$)/iu.test(url.pathname)) return null;
  if (companyDomain && url.hostname.replace(/^www\./u, '') !== companyDomain.replace(/^www\./u, '').toLowerCase()) {
    return null;
  }
  return raw;
}

/** Preserves the original text after the caller's person-line scrub; rejects unsafe or malformed facts. */
export function validProjectEvidenceSpan(value: unknown): value is string {
  return typeof value === 'string' && value === value.normalize('NFKC') &&
    value.length >= 30 && value.length <= PROJECT_PAGE_MAX_SPAN_CHARS &&
    Buffer.byteLength(value, 'utf8') <= 1_024 && isContactFreeText(value);
}

export function readProjectPageEvidence(value: unknown, domain?: string): ProjectPageEvidence | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { source_url, fetched_at, spans } = value as Record<string, unknown>;
  const url = companyProjectPageUrl(source_url, domain);
  if (!url || typeof fetched_at !== 'string' || !Number.isFinite(Date.parse(fetched_at)) ||
      !Array.isArray(spans) || spans.length === 0 || spans.length > MAX_SPANS || !spans.every(validProjectEvidenceSpan)) {
    return undefined;
  }
  return { source_url: url, fetched_at, spans: [...new Set(spans)] };
}
