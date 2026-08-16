import { createHash } from 'node:crypto';

export const ORGANIZATION_IDENTITY_RESOLVER_VERSION = 'organization-identity-v2';

/** Schemes that may have only one active value per organization and jurisdiction. */
export const ORGANIZATION_SINGLETON_IDENTIFIER_SCHEMES: ReadonlySet<string> = new Set([
  'lei',
  'siren',
  'cik',
  'uei',
  'ted-natid',
  'wikidata-qid',
  'uk-company-number',
  'br-cnpj',
  'ror-id',
  'usdot',
]);

const SAFE_NAMESPACE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SAFE_JURISDICTION = /^[A-Z0-9][A-Z0-9._:-]{0,31}$/;
const MAX_IDENTIFIER_INPUTS = 64;
const MAX_IDENTIFIER_VALUE_BYTES = 512;

export type OrganizationIdentifierValidator =
  | 'domain-v1'
  | 'lei-v1'
  | 'siren-v1'
  | 'npi-v1'
  | 'uk-company-number-v1'
  | 'cnpj-v1'
  | 'ror-id-v1'
  | 'cik-v1'
  | 'usdot-v1'
  | 'opaque-v1';

export interface OrganizationIdentityAuthorityRule {
  scheme: string;
  jurisdictions: readonly string[];
  validator: OrganizationIdentifierValidator;
}

export type OrganizationIdentityAuthorityProfileVersion =
  | 'v1'
  | 'identity-authority-v1'
  | 'identity-authority-v2'
  | 'identity-authority-none-v1';

export interface OrganizationIdentityAuthorityProfile {
  providerKey: string;
  profileVersion: OrganizationIdentityAuthorityProfileVersion;
  rules: readonly OrganizationIdentityAuthorityRule[];
}

export interface OrganizationIdentifierInput {
  scheme: string;
  value: string;
  jurisdiction?: string | null;
}

export interface NormalizedOrganizationIdentifier {
  scheme: string;
  jurisdiction: string;
  normalizedValue: string;
  validatorVersion: OrganizationIdentifierValidator;
  normalizerVersion: typeof ORGANIZATION_IDENTITY_RESOLVER_VERSION;
  key: string;
}

export type OrganizationIdentityConflictType = 'identifier_split' | 'blocking_key_disagreement' | 'binding_conflict';

export type OrganizationIdentityResolutionPlan =
  | {
      kind: 'create_new';
      identifiers: NormalizedOrganizationIdentifier[];
    }
  | {
      kind: 'lazy_upgrade';
      companyId: string;
      identifiers: NormalizedOrganizationIdentifier[];
    }
  | {
      kind: 'match';
      companyId: string;
      identifiers: NormalizedOrganizationIdentifier[];
    }
  | {
      kind: 'conflict';
      conflictType: OrganizationIdentityConflictType;
      companyIds: string[];
      identifierKeys: string[];
    };

export class OrganizationIdentityV2Error extends Error {
  constructor(
    public readonly code: 'IDENTITY_IDENTIFIER_INVALID' | 'IDENTITY_IDENTIFIER_NOT_AUTHORIZED' | 'IDENTITY_AUTHORITY_PROFILE_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'OrganizationIdentityV2Error';
  }
}

function invalidProfile(message: string): never {
  throw new OrganizationIdentityV2Error('IDENTITY_AUTHORITY_PROFILE_INVALID', message);
}

function invalidIdentifier(message: string): never {
  throw new OrganizationIdentityV2Error('IDENTITY_IDENTIFIER_INVALID', message);
}

function normalizedNamespace(value: string, label: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (!SAFE_NAMESPACE.test(normalized)) invalidProfile(label + ' is invalid');
  return normalized;
}

function normalizedJurisdiction(value: string): string {
  const normalized = value.trim().toLocaleUpperCase('en-US');
  if (!SAFE_JURISDICTION.test(normalized)) {
    invalidIdentifier('identifier jurisdiction is invalid');
  }
  return normalized;
}

function normalizedDomain(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_VALUE_BYTES) {
    invalidIdentifier('domain identifier is too large');
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : 'https://' + value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
      invalidIdentifier('domain identifier is invalid');
    }
    const hostname = url.hostname
      .replace(/^www\./iu, '')
      .replace(/\.$/u, '')
      .toLocaleLowerCase('en-US');
    if (!hostname || hostname.length > 253 || hostname.includes('..') || hostname.startsWith('.') || hostname.endsWith('.')) {
      invalidIdentifier('domain identifier is invalid');
    }
    return hostname;
  } catch (error) {
    if (error instanceof OrganizationIdentityV2Error) throw error;
    invalidIdentifier('domain identifier is invalid');
  }
}

function validLei(value: string): boolean {
  if (!/^[A-Z0-9]{20}$/u.test(value)) return false;
  const expanded = [...value].map((character) => (/[A-Z]/u.test(character) ? String(character.charCodeAt(0) - 55) : character)).join('');
  let remainder = 0;
  for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

export function isValidSirenIdentifier(value: string): boolean {
  if (!/^\d{9}$/u.test(value)) return false;
  // INSEE documents La Poste's historical SIREN as the sole official
  // exception to the ordinary Luhn rule.
  if (value === '356000000') return true;
  let sum = 0;
  let positionFromRight = 0;
  for (let index = value.length - 1; index >= 0; index -= 1, positionFromRight += 1) {
    let digit = Number(value[index]);
    if (positionFromRight % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function isValidNpiIdentifier(value: string): boolean {
  if (!/^[12]\d{9}$/u.test(value)) return false;
  // CMS defines the tenth digit using Luhn as if the first nine NPI digits
  // were prefixed by the health-card issuer prefix 80840.
  const payload = `80840${value.slice(0, 9)}`;
  let sum = 0;
  for (let index = payload.length - 1, double = true; index >= 0; index -= 1, double = !double) {
    let digit = Number(payload[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10 === Number(value[9]);
}

export function isValidCnpjIdentifier(value: string): boolean {
  if (!/^\d{14}$/u.test(value) || /^(\d)\1{13}$/u.test(value)) return false;
  const checkDigit = (payload: string, weights: readonly number[]): number => {
    const total = [...payload].reduce((sum, digit, index) => sum + Number(digit) * (weights[index] ?? 0), 0);
    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const first = checkDigit(value.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (first !== Number(value[12])) return false;
  const second = checkDigit(value.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return second === Number(value[13]);
}

export function normalizeRorIdentifier(value: string): string | null {
  const match = value.trim().normalize('NFKC').toLocaleLowerCase('en-US')
    .match(/^(?:https:\/\/)?(?:ror\.org\/)?(0[0-9a-hjkmnp-tv-z]{6}[0-9]{2})$/u);
  if (!match?.[1]) return null;
  const identifier = match[1];
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let numericBody = 0;
  for (const character of identifier.slice(1, 7)) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    numericBody = numericBody * 32 + digit;
  }
  const checksum = String(98 - ((numericBody * 100) % 97)).padStart(2, '0');
  return identifier.endsWith(checksum) ? `https://ror.org/${identifier}` : null;
}

export function normalizeCikIdentifier(value: string): string | null {
  const digits = value.trim();
  if (!/^\d{1,10}$/u.test(digits) || /^0+$/u.test(digits)) return null;
  return digits.padStart(10, '0');
}

export function normalizeUsdotIdentifier(value: string): string | null {
  const digits = value.normalize('NFKC').trim();
  return /^[1-9]\d{0,7}$/u.test(digits) ? digits : null;
}

function normalizeValue(value: string, validator: OrganizationIdentifierValidator): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_VALUE_BYTES) {
    invalidIdentifier('identifier value is invalid');
  }
  if (validator === 'domain-v1') return normalizedDomain(value);
  if (validator === 'ror-id-v1') {
    const rorId = normalizeRorIdentifier(value);
    if (!rorId) invalidIdentifier('ROR ID checksum is invalid');
    return rorId;
  }
  if (validator === 'cik-v1') {
    const cik = normalizeCikIdentifier(value);
    if (!cik) invalidIdentifier('CIK is invalid');
    return cik;
  }
  if (validator === 'usdot-v1') {
    const usdot = normalizeUsdotIdentifier(value);
    if (!usdot) invalidIdentifier('USDOT is invalid');
    return usdot;
  }
  if (validator === 'npi-v1') {
    const normalizedNpi = value.trim();
    if (!isValidNpiIdentifier(normalizedNpi)) invalidIdentifier('NPI checksum is invalid');
    return normalizedNpi;
  }
  const normalized = value
    .normalize('NFC')
    .toLocaleUpperCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  if (!normalized) invalidIdentifier('identifier value is invalid');
  if (validator === 'lei-v1' && !validLei(normalized)) {
    invalidIdentifier('LEI checksum is invalid');
  }
  if (validator === 'siren-v1' && !isValidSirenIdentifier(normalized)) {
    invalidIdentifier('SIREN checksum is invalid');
  }
  if (validator === 'uk-company-number-v1' && !/^[A-Z0-9]{8}$/u.test(normalized)) {
    invalidIdentifier('UK company number is invalid');
  }
  if (validator === 'cnpj-v1' && !isValidCnpjIdentifier(normalized)) {
    invalidIdentifier('CNPJ checksum is invalid');
  }
  return normalized;
}

function normalizedProfile(profile: OrganizationIdentityAuthorityProfile) {
  const providerKey = normalizedNamespace(profile.providerKey, 'provider key');
  const profileVersion = profile.profileVersion.trim();
  if (!['v1', 'identity-authority-v1', 'identity-authority-v2', 'identity-authority-none-v1'].includes(profileVersion)) {
    invalidProfile('profile version is invalid');
  }
  const noIdentifierAuthority = profileVersion === 'identity-authority-none-v1';
  if (
    !Array.isArray(profile.rules) ||
    profile.rules.length > 64 ||
    (noIdentifierAuthority ? profile.rules.length !== 0 : profile.rules.length === 0)
  ) {
    invalidProfile('authority rules are invalid');
  }
  const rules = profile.rules.map((rule) => {
    const scheme = normalizedNamespace(rule.scheme, 'identifier scheme');
    if (
      !Array.isArray(rule.jurisdictions) ||
      rule.jurisdictions.length === 0 ||
      !['domain-v1', 'lei-v1', 'siren-v1', 'npi-v1', 'uk-company-number-v1', 'cnpj-v1', 'ror-id-v1', 'cik-v1', 'usdot-v1', 'opaque-v1'].includes(rule.validator)
    ) {
      invalidProfile('authority rule is invalid');
    }
    const jurisdictions: string[] = [
      ...new Set<string>(rule.jurisdictions.map((item: string) => (item === '*' ? '*' : normalizedJurisdiction(item)))),
    ].sort();
    return { scheme, jurisdictions, validator: rule.validator };
  });
  return { providerKey, profileVersion, rules };
}

function ruleFor(
  rules: ReturnType<typeof normalizedProfile>['rules'],
  rawScheme: string,
  rawJurisdiction?: string | null,
): {
  scheme: string;
  jurisdiction: string;
  validator: OrganizationIdentifierValidator;
} {
  const scheme = normalizedNamespace(rawScheme, 'identifier scheme');
  const [baseScheme, schemeJurisdiction] = scheme.split(':', 2);
  const rule = rules.find((candidate) => candidate.scheme === scheme) ?? rules.find((candidate) => candidate.scheme === baseScheme);
  if (!rule) {
    throw new OrganizationIdentityV2Error(
      'IDENTITY_IDENTIFIER_NOT_AUTHORIZED',
      'identifier scheme is not authorized by provider authority profile',
    );
  }
  const jurisdiction: string = rawJurisdiction
    ? normalizedJurisdiction(rawJurisdiction)
    : schemeJurisdiction
      ? normalizedJurisdiction(schemeJurisdiction)
      : rule.jurisdictions.includes('GLOBAL')
        ? 'GLOBAL'
        : rule.jurisdictions.length === 1 && rule.jurisdictions[0] !== '*'
          ? rule.jurisdictions[0]
          : '';
  if (!jurisdiction || (!rule.jurisdictions.includes('*') && !rule.jurisdictions.includes(jurisdiction))) {
    throw new OrganizationIdentityV2Error(
      'IDENTITY_IDENTIFIER_NOT_AUTHORIZED',
      'identifier jurisdiction is not authorized by provider authority profile',
    );
  }
  return { scheme: rule.scheme, jurisdiction, validator: rule.validator };
}

export function normalizeAuthorityIdentifiers(
  profile: OrganizationIdentityAuthorityProfile,
  inputs: readonly OrganizationIdentifierInput[],
): NormalizedOrganizationIdentifier[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_IDENTIFIER_INPUTS) {
    invalidIdentifier('identifier list is invalid');
  }
  const authority = normalizedProfile(profile);
  const byKey = new Map<string, NormalizedOrganizationIdentifier>();
  for (const input of inputs) {
    const rule = ruleFor(authority.rules, input.scheme, input.jurisdiction);
    const normalizedValue = normalizeValue(input.value, rule.validator);
    const key = rule.scheme + ':' + rule.jurisdiction + ':' + normalizedValue;
    byKey.set(key, {
      scheme: rule.scheme,
      jurisdiction: rule.jurisdiction,
      normalizedValue,
      validatorVersion: rule.validator,
      normalizerVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
      key,
    });
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function canonicalRoot(companyId: string, roots: ReadonlyMap<string, string>): string {
  return roots.get(companyId) ?? companyId;
}

export function planOrganizationIdentityResolution(input: {
  identifiers: readonly NormalizedOrganizationIdentifier[];
  legacyCandidateCompanyId: string | null;
  bindings: ReadonlyMap<string, string>;
  roots: ReadonlyMap<string, string>;
}): OrganizationIdentityResolutionPlan {
  const identifiers = [...input.identifiers].sort((left, right) => left.key.localeCompare(right.key));
  const boundRoots = [
    ...new Set(
      identifiers
        .map((identifier) => input.bindings.get(identifier.key))
        .filter((value): value is string => Boolean(value))
        .map((companyId) => canonicalRoot(companyId, input.roots)),
    ),
  ].sort();
  const legacyRoot = input.legacyCandidateCompanyId ? canonicalRoot(input.legacyCandidateCompanyId, input.roots) : null;

  if (boundRoots.length > 1) {
    return {
      kind: 'conflict',
      conflictType: 'identifier_split',
      companyIds: boundRoots,
      identifierKeys: identifiers.map((identifier) => identifier.key),
    };
  }
  if (boundRoots.length === 1 && legacyRoot && boundRoots[0] !== legacyRoot) {
    return {
      kind: 'conflict',
      conflictType: 'blocking_key_disagreement',
      companyIds: [boundRoots[0], legacyRoot].sort(),
      identifierKeys: identifiers.map((identifier) => identifier.key),
    };
  }
  if (boundRoots.length === 1) {
    return { kind: 'match', companyId: boundRoots[0], identifiers };
  }
  if (legacyRoot) {
    return { kind: 'lazy_upgrade', companyId: legacyRoot, identifiers };
  }
  return { kind: 'create_new', identifiers };
}

function canonicalFingerprintPayload(input: {
  rawRecordId: string;
  resolverVersion: string;
  conflictType: OrganizationIdentityConflictType;
  companyIds: readonly string[];
  identifierKeys: readonly string[];
}) {
  return JSON.stringify({
    resolverVersion: input.resolverVersion,
    conflictType: input.conflictType,
    companyIds: [...new Set(input.companyIds)].sort(),
    identifierKeys: [...new Set(input.identifierKeys)].sort(),
  });
}

export function identityConflictFingerprint(input: {
  rawRecordId: string;
  resolverVersion: string;
  conflictType: OrganizationIdentityConflictType;
  companyIds: readonly string[];
  identifierKeys: readonly string[];
}): string {
  return createHash('sha256').update(canonicalFingerprintPayload(input)).digest('hex');
}
