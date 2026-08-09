import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { cleanEmail, cleanName } from '../acquisition/clean';
import { normalizeDomain } from './identity';

export const SUPPRESSION_TYPES = ['email', 'domain', 'company_name'] as const;
export type SuppressionType = (typeof SUPPRESSION_TYPES)[number];

const MAX_EMAIL_LENGTH = 254;
const MAX_DOMAIN_INPUT_LENGTH = 2048;
const MAX_DOMAIN_LENGTH = 253;
const MAX_COMPANY_NAME_LENGTH = 256;

function hasForbiddenCompanyControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      codePoint === 0x7f
    );
  });
}

function canonicalDomain(raw: string): string | null {
  if (!raw.trim() || raw.length > MAX_DOMAIN_INPUT_LENGTH) return null;
  const normalized = normalizeDomain(raw);
  if (!normalized) return null;
  const ascii = domainToASCII(normalized).toLowerCase().replace(/\.+$/, '');
  if (!ascii || ascii.length > MAX_DOMAIN_LENGTH || !ascii.includes('.') || isIP(ascii) !== 0) return null;
  const labels = ascii.split('.');
  if (labels.some((label) =>
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  return ascii;
}

/**
 * Canonical key shared by suppression writes and company matching.
 * Invalid or unbounded values return null so callers can fail closed before persistence.
 */
export function canonicalizeSuppressionValue(type: string, raw: string): string | null {
  if (typeof raw !== 'string') return null;
  if (type === 'email') {
    if (raw.length > MAX_EMAIL_LENGTH + 2) return null;
    const email = cleanEmail(raw)?.value ?? null;
    if (!email || email.length > MAX_EMAIL_LENGTH) return null;
    const separator = email.lastIndexOf('@');
    const local = email.slice(0, separator);
    if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
    const domain = canonicalDomain(email.slice(separator + 1));
    return domain ? `${local}@${domain}` : null;
  }
  if (type === 'domain') return canonicalDomain(raw);
  if (type === 'company_name') {
    if (raw.length > MAX_DOMAIN_INPUT_LENGTH || hasForbiddenCompanyControl(raw)) return null;
    const name = cleanName(raw.normalize('NFC')).toLowerCase();
    return name && name.length <= MAX_COMPANY_NAME_LENGTH ? name : null;
  }
  return null;
}

/** Canonicalize legacy stored values at each read boundary; invalid rows stay visible for manual governance. */
export function canonicalizeSuppressionValues(type: string, values: Iterable<string>): Set<string> {
  const canonical = new Set<string>();
  for (const value of values) {
    const normalized = canonicalizeSuppressionValue(type, value);
    if (normalized) canonical.add(normalized);
  }
  return canonical;
}

export function companyMatchesSuppression(
  rows: ReadonlyArray<{ type: string; value: string }>,
  company: { domain?: string | null; name: string },
): boolean {
  const domain = company.domain ? canonicalizeSuppressionValue('domain', company.domain) : null;
  const name = canonicalizeSuppressionValue('company_name', company.name);
  const domains = canonicalizeSuppressionValues(
    'domain',
    rows.filter((row) => row.type === 'domain').map((row) => row.value),
  );
  const names = canonicalizeSuppressionValues(
    'company_name',
    rows.filter((row) => row.type === 'company_name').map((row) => row.value),
  );
  return (!!domain && domains.has(domain)) || (!!name && names.has(name));
}
