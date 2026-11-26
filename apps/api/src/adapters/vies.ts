/**
 * Official EU VIES VAT REST API adapter (zero-cost, no API key required).
 * Endpoint: GET https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{countryCode}/vat/{vatNumber}
 *
 * Security & privacy invariants:
 *  - Uses guarded public HTTP (pinned DNS, no redirects, bounded response body).
 *  - Never returns raw street address (`address` is stripped; at most a conservative city is extracted).
 *  - Classifies both HTTP 200 `userError` and HTTP 4xx/5xx `errorWrappers[].error` so outages/rate limits
 *    never misclassify a VAT number as deterministically `INVALID`.
 */
import { splitViesVat } from '../discovery/website-profile/eu-vat';
import {
  EgressBlockedError,
  ExternalHttpActionDeniedError,
  ExternalHttpPhysicalWireDeniedError,
  requestPublicHttp,
} from './guarded-http';

const VIES_BASE_URL = (
  process.env.VIES_API_BASE_URL ?? 'https://ec.europa.eu/taxation_customs/vies/rest-api'
).replace(/\/+$/u, '');
const VIES_USER_AGENT =
  process.env.VIES_UA ?? 'GlobalDiscoveryBot/1.0 (+https://github.com/mlhjyx/global-backend)';
const VIES_TIMEOUT_MS = 10_000;
const VIES_MAX_BYTES = 64 * 1024;
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const UNAVAILABLE_COOLDOWN_MS = 60_000;

const RATE_LIMIT_CODES = new Set([
  'MS_MAX_CONCURRENT_REQ',
  'GLOBAL_MAX_CONCURRENT_REQ',
  'SERVER_BUSY',
]);
const UNAVAILABLE_CODES = new Set([
  'MS_UNAVAILABLE',
  'TIMEOUT',
  'SERVICE_UNAVAILABLE',
  'INVALID_REQUESTER_INFO',
]);

const countryCooldownUntil = new Map<string, number>();

export type ViesTransientErrorCode =
  | 'VIES_RATE_LIMITED'
  | 'VIES_RATE_LIMITED_COOLDOWN'
  | 'VIES_UNAVAILABLE';

const transientErrorCountry = new WeakMap<ViesTransientError, string>();

/**
 * Keeps only standard Error/PLAIN_FAILURE_KEYS (`name`, `message`, `code`, `stack`)
 * so `isExecutionControlError` classifies transient VIES outages as non-control failures.
 */
export class ViesTransientError extends Error {
  readonly code: ViesTransientErrorCode;

  constructor(code: ViesTransientErrorCode, countryCode: string, detail?: string) {
    super(detail ? `${code} (${countryCode}): ${detail}` : `${code} (${countryCode})`);
    this.name = 'ViesTransientError';
    this.code = code;
    transientErrorCountry.set(this, countryCode);
  }
}

export function viesTransientErrorCountry(error: ViesTransientError): string | undefined {
  return transientErrorCountry.get(error);
}

export interface ViesCheckInput {
  readonly countryCode: string;
  readonly vatNumber: string;
}

export interface ViesCheckResult {
  readonly status: 'VALID' | 'INVALID';
  readonly countryCode: string;
  readonly isoCountry: string;
  readonly vatNumber: string;
  readonly vatId: string;
  readonly requestDate?: string;
  readonly legalName?: string;
  readonly registeredCity?: string;
  readonly nameRedacted: boolean;
}

export interface ViesHttpClient {
  (
    url: string,
    options: {
      timeoutMs: number;
      maxRedirects: number;
      maxBytes: number;
      headers: Record<string, string>;
    },
  ): Promise<{ status: number; ok: boolean; text: string }>;
}

export interface ViesCheckDependencies {
  readonly authorizeExternalAction?: () => Promise<boolean>;
  readonly beforePhysicalWire?: () => Promise<void>;
  readonly httpClient?: ViesHttpClient;
  readonly nowMs?: () => number;
}

interface ViesApiPayload {
  isValid?: unknown;
  actionSucceed?: unknown;
  requestDate?: unknown;
  userError?: unknown;
  name?: unknown;
  address?: unknown;
  errorWrappers?: unknown;
}

const REDACTED_NAME_RE = /^(?:[-–—.\s]+|n\/?a|not\s+available)$/iu;
const EU_POSTAL_CITY_RE =
  /(?:^|[\s,])(?:\d{4}\s?[A-Z]{2}|\d{2}-\d{3}|\d{4}-\d{3}|\d{3}\s\d{2}|\d{4,5})\s+([\p{L}][\p{L}'’.\- ()]{1,65})$/u;
const STREET_WORD_RE =
  /\b(?:VIA|VIALE|PIAZZA|CORSO|STRADA|LOCALITA|STRASSE|STR\.|WEG|PLATZ|ALLEE|RUE|AVENUE|BOULEVARD|CALLE|AVENIDA|ROAD|STREET)\b/iu;

/**
 * Conservatively extracts only the city name from a VIES address line.
 * Never returns street names, house numbers, or raw address strings.
 */
export function extractRegisteredCityFromViesAddress(rawAddress: unknown): string | undefined {
  if (typeof rawAddress !== 'string') return undefined;
  const trimmed = rawAddress.trim();
  if (!trimmed || REDACTED_NAME_RE.test(trimmed)) return undefined;
  const segments = trimmed
    .split(/[\r\n,]+/u)
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const match = EU_POSTAL_CITY_RE.exec(segments[i]!);
    if (!match) continue;
    let candidate = match[1]!.replace(/\s*\([A-Z]{2}\)\s*$/u, '').trim();
    const strippedProvince = candidate.replace(/\s+[A-Z]{2}$/u, '').trim();
    if (strippedProvince.length >= 2) candidate = strippedProvince;
    candidate = candidate.replace(/^[\s.,-]+|[\s.,-]+$/gu, '').trim();
    if (
      candidate.length >= 2 &&
      candidate.length <= 60 &&
      !/\d/u.test(candidate) &&
      !STREET_WORD_RE.test(candidate) &&
      /^[\p{L}][\p{L}'’.\- ]+$/u.test(candidate)
    ) {
      return candidate.normalize('NFC');
    }
  }
  return undefined;
}

function parseLegalName(rawName: unknown): { legalName?: string; nameRedacted: boolean } {
  if (typeof rawName !== 'string') return { nameRedacted: true };
  const cleaned = rawName.replace(/\s+/gu, ' ').trim();
  if (cleaned.length < 2 || REDACTED_NAME_RE.test(cleaned)) {
    return { nameRedacted: true };
  }
  return { legalName: cleaned.normalize('NFC').slice(0, 300), nameRedacted: false };
}

function parseRequestDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(raw.trim());
  return match ? match[1] : undefined;
}

function extractErrorCodes(body: ViesApiPayload | null): string[] {
  if (!body) return [];
  const codes: string[] = [];
  if (typeof body.userError === 'string' && body.userError.trim()) {
    codes.push(body.userError.trim().toUpperCase());
  }
  if (Array.isArray(body.errorWrappers)) {
    for (const item of body.errorWrappers) {
      if (item && typeof item === 'object') {
        const code = (item as { error?: unknown }).error;
        if (typeof code === 'string' && code.trim()) {
          codes.push(code.trim().toUpperCase());
        }
      }
    }
  }
  return codes;
}

function parseJsonBody(text: string): ViesApiPayload | null {
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ViesApiPayload)
      : null;
  } catch {
    return null;
  }
}

function isNonTransientControlError(error: unknown): boolean {
  return (
    error instanceof ExternalHttpActionDeniedError ||
    error instanceof ExternalHttpPhysicalWireDeniedError ||
    error instanceof EgressBlockedError
  );
}

function setCooldown(countryCode: string, now: number, durationMs: number): void {
  const until = now + durationMs;
  const existing = countryCooldownUntil.get(countryCode) ?? 0;
  if (until > existing) countryCooldownUntil.set(countryCode, until);
}

/**
 * Checks one EU VAT number against the official European Commission VIES REST API.
 */
export async function checkViesVat(
  input: ViesCheckInput,
  deps?: ViesCheckDependencies,
): Promise<ViesCheckResult> {
  const split = splitViesVat(`${input.countryCode}${input.vatNumber}`);
  if (!split) {
    throw new Error('VIES_INVALID_VAT_INPUT');
  }
  const now = (deps?.nowMs ?? Date.now)();
  if ((countryCooldownUntil.get(split.countryCode) ?? 0) > now) {
    throw new ViesTransientError('VIES_RATE_LIMITED_COOLDOWN', split.countryCode);
  }

  const url = `${VIES_BASE_URL}/ms/${encodeURIComponent(split.countryCode)}/vat/${encodeURIComponent(split.vatNumber)}`;
  const reqOpts = {
    timeoutMs: VIES_TIMEOUT_MS,
    maxRedirects: 0,
    maxBytes: VIES_MAX_BYTES,
    headers: {
      Accept: 'application/json',
      'User-Agent': VIES_USER_AGENT,
    },
  };

  let response: { status: number; ok: boolean; text: string };
  try {
    response = deps?.httpClient
      ? await deps.httpClient(url, reqOpts)
      : await requestPublicHttp(
          url,
          { method: 'GET', ...reqOpts },
          {
            authorizeExternalAction: deps?.authorizeExternalAction,
            beforePhysicalWire: deps?.beforePhysicalWire,
          },
        );
  } catch (error) {
    if (isNonTransientControlError(error)) throw error;
    setCooldown(split.countryCode, now, UNAVAILABLE_COOLDOWN_MS);
    throw new ViesTransientError('VIES_UNAVAILABLE', split.countryCode);
  }

  const body = parseJsonBody(response.text);
  const errorCodes = extractErrorCodes(body);
  if (response.status === 429 || errorCodes.some((code) => RATE_LIMIT_CODES.has(code))) {
    setCooldown(split.countryCode, now, RATE_LIMIT_COOLDOWN_MS);
    throw new ViesTransientError('VIES_RATE_LIMITED', split.countryCode);
  }
  if (response.status >= 500 || errorCodes.some((code) => UNAVAILABLE_CODES.has(code))) {
    setCooldown(split.countryCode, now, UNAVAILABLE_COOLDOWN_MS);
    throw new ViesTransientError('VIES_UNAVAILABLE', split.countryCode);
  }

  const hasErrorWrappers = Array.isArray(body?.errorWrappers) && body.errorWrappers.length > 0;
  const requestDate = parseRequestDate(body?.requestDate);

  if (response.status === 200 && body && body.actionSucceed !== false && !hasErrorWrappers) {
    if (body.isValid === true) {
      const { legalName, nameRedacted } = parseLegalName(body.name);
      const registeredCity = nameRedacted
        ? undefined
        : extractRegisteredCityFromViesAddress(body.address);
      return {
        status: 'VALID',
        countryCode: split.countryCode,
        isoCountry: split.isoCountry,
        vatNumber: split.vatNumber,
        vatId: split.vatId,
        ...(requestDate ? { requestDate } : {}),
        ...(legalName ? { legalName } : {}),
        ...(registeredCity ? { registeredCity } : {}),
        nameRedacted,
      };
    }
    if (
      body.isValid === false &&
      typeof body.userError === 'string' &&
      body.userError.trim().toUpperCase() === 'INVALID'
    ) {
      return {
        status: 'INVALID',
        countryCode: split.countryCode,
        isoCountry: split.isoCountry,
        vatNumber: split.vatNumber,
        vatId: split.vatId,
        ...(requestDate ? { requestDate } : {}),
        nameRedacted: true,
      };
    }
  }

  setCooldown(split.countryCode, now, UNAVAILABLE_COOLDOWN_MS);
  throw new ViesTransientError('VIES_UNAVAILABLE', split.countryCode, `http_${response.status}`);
}
