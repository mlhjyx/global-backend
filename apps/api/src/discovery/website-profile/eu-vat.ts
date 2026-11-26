/**
 * EU VAT (including Italian P.IVA) validation, normalization, and high-precision
 * extraction for company websites and EU VIES corroboration.
 */

export const VIES_PUBLIC_NAME_REDACTED_COUNTRIES: ReadonlySet<string> = new Set(['DE']);

const EU_FORMAT_RES: Readonly<Record<string, RegExp>> = Object.freeze({
  AT: /^ATU\d{8}$/u,
  BE: /^BE[01]\d{9}$/u,
  BG: /^BG\d{9,10}$/u,
  CY: /^CY\d{8}[A-Z]$/u,
  CZ: /^CZ\d{8,10}$/u,
  DE: /^DE\d{9}$/u,
  DK: /^DK\d{8}$/u,
  EE: /^EE\d{9}$/u,
  EL: /^EL\d{9}$/u,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/u,
  FI: /^FI\d{8}$/u,
  FR: /^FR[A-HJ-NP-Z0-9]{2}\d{9}$/u,
  GR: /^GR\d{9}$/u,
  HR: /^HR\d{11}$/u,
  HU: /^HU\d{8}$/u,
  IE: /^IE(?:\d{7}[A-Z]{1,2}|\d[A-Z+*]\d{5}[A-Z])$/u,
  IT: /^IT\d{11}$/u,
  LT: /^LT(?:\d{9}|\d{12})$/u,
  LU: /^LU\d{8}$/u,
  LV: /^LV\d{11}$/u,
  MT: /^MT\d{8}$/u,
  NL: /^NL\d{9}B\d{2}$/u,
  PL: /^PL\d{10}$/u,
  PT: /^PT\d{9}$/u,
  RO: /^RO\d{2,10}$/u,
  SE: /^SE\d{12}$/u,
  SI: /^SI\d{8}$/u,
  SK: /^SK\d{10}$/u,
  XI: /^XI(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/u,
});

function hasNonZeroDigit(body: string): boolean {
  return /[1-9]/u.test(body);
}

/** German VAT id check digit (ISO 7064 MOD 11,10). */
export function isValidGermanVat(value: string): boolean {
  const match = /^DE(\d{9})$/u.exec(value);
  if (!match || !hasNonZeroDigit(match[1]!)) return false;
  const digits = match[1]!.split('').map(Number);
  let product = 10;
  for (const digit of digits.slice(0, 8)) {
    let sum = (digit + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  const check = (11 - product) % 10;
  return check === digits[8];
}

/** Italian Partita IVA check digit (Agenzia delle Entrate 11-digit Luhn variant). */
export function isValidItalianVat(value: string): boolean {
  const match = /^IT(\d{11})$/u.exec(value);
  if (!match || !hasNonZeroDigit(match[1]!.slice(0, 7))) return false;
  const digits = match[1]!.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const d = digits[i]!;
    if (i % 2 === 0) {
      sum += d;
    } else {
      const doubled = d * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    }
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits[10];
}

function isValidFrenchVat(value: string): boolean {
  const match = /^FR([A-HJ-NP-Z0-9]{2})(\d{9})$/u.exec(value);
  if (!match || !hasNonZeroDigit(match[2]!)) return false;
  const [, key, siren] = match;
  if (/^\d{2}$/u.test(key!)) {
    return (12 + 3 * (Number(siren) % 97)) % 97 === Number(key);
  }
  return true;
}

function isValidBelgianVat(value: string): boolean {
  const match = /^BE([01]\d{9})$/u.exec(value);
  if (!match) return false;
  const body = match[1]!;
  const head = Number(body.slice(0, 8));
  const check = Number(body.slice(8));
  return head > 0 && 97 - (head % 97) === check;
}

function isValidDutchVat(value: string): boolean {
  const match = /^NL(\d{9})B(\d{2})$/u.exec(value);
  if (!match || !hasNonZeroDigit(match[1]!) || match[2] === '00') return false;
  const digits = match[1]!.split('').map(Number);
  const elevenProef =
    digits[0]! * 9 +
    digits[1]! * 8 +
    digits[2]! * 7 +
    digits[3]! * 6 +
    digits[4]! * 5 +
    digits[5]! * 4 +
    digits[6]! * 3 +
    digits[7]! * 2 -
    digits[8]!;
  if (elevenProef > 0 && elevenProef % 11 === 0) return true;
  // 2020 Dutch sole-proprietor VAT IDs use IBAN-style Mod 97 (N=23, L=21, B=11).
  const expanded = `2321${match[1]!}11${match[2]!}`;
  return BigInt(expanded) % 97n === 1n;
}

function isValidPolishVat(value: string): boolean {
  const match = /^PL(\d{10})$/u.exec(value);
  if (!match || !hasNonZeroDigit(match[1]!)) return false;
  const digits = match[1]!.split('').map(Number);
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = weights.reduce((acc, weight, idx) => acc + weight * digits[idx]!, 0);
  const mod = sum % 11;
  return mod < 10 && mod === digits[9];
}

/** Validates an already-canonical uppercase compact EU VAT ID (27 EU + XI, plus GR alias). */
export function isValidEuVat(value: string): boolean {
  if (typeof value !== 'string' || value.length < 4 || value.length > 16) return false;
  const prefix = value.slice(0, 2);
  const pattern = EU_FORMAT_RES[prefix];
  if (!pattern || !pattern.test(value)) return false;
  if (!hasNonZeroDigit(value.slice(2))) return false;
  if (prefix === 'DE') return isValidGermanVat(value);
  if (prefix === 'IT') return isValidItalianVat(value);
  if (prefix === 'FR') return isValidFrenchVat(value);
  if (prefix === 'BE') return isValidBelgianVat(value);
  if (prefix === 'NL') return isValidDutchVat(value);
  if (prefix === 'PL') return isValidPolishVat(value);
  return true;
}

/** Normalizes separators/case and maps Greece GR -> EL for VIES compatibility. */
export function normalizeEuVat(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let compact = raw.replace(/[\s.-]+/gu, '').toUpperCase();
  if (/^GR\d{9}$/u.test(compact)) {
    compact = `EL${compact.slice(2)}`;
  }
  return isValidEuVat(compact) ? compact : null;
}

export interface SplitViesVat {
  readonly countryCode: string;
  readonly vatNumber: string;
  readonly isoCountry: string;
  readonly vatId: string;
}

export function splitViesVat(raw: string): SplitViesVat | null {
  const vatId = normalizeEuVat(raw);
  if (!vatId) return null;
  const countryCode = vatId.slice(0, 2);
  const vatNumber = vatId.slice(2);
  const isoCountry = countryCode === 'EL' ? 'GR' : countryCode === 'XI' ? 'GB' : countryCode;
  return { countryCode, vatNumber, isoCountry, vatId };
}

export interface ExtractEuVatOptions {
  readonly domain?: string | null;
  readonly countryHint?: string | null;
}

const JSONLD_VAT_RE = /"vatID"\s*:\s*"([A-Za-z]{2}[A-Za-z0-9\s.+-]{6,18})"/giu;
const VAT_LABEL_RE =
  /(?:P\.?\s*IVA(?:\s*(?:e|\/|&)\s*(?:C\.?\s*F\.?|Cod\.?\s*Fisc\.?))?|Partita\s+IVA|USt-?IdNr|UID-?Nr|Umsatzsteuer-?(?:Identifikationsnummer|ID)|TVA(?:\s+intracommunautaire)?|BTW|NIF|CIF|VAT(?:\s*(?:ID|No\.?|Number|Reg\.?|Code))?|NIP|C\.?\s*F\.?\s*(?:e|\/|&)\s*P\.?\s*IVA)/giu;
const PREFIXED_EU_VAT_RE =
  /\b(AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|GR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|XI)[\s.-]?([A-Z0-9](?:[\s.-]?[A-Z0-9]){6,13})\b/gu;
const STANDALONE_CHECKSUM_VAT_RE =
  /\b(?:DE[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{3}|IT[\s.-]?\d{11}|BE[\s.-]?[01]\d{3}[\s.-]?\d{3}[\s.-]?\d{3}|NL[\s.-]?\d{9}[\s.-]?B\d{2}|PL[\s.-]?\d{10}|ATU[\s.-]?\d{8}|FR[\s.-]?\d{2}[\s.-]?\d{9})\b/gu;
const ITALIAN_PIVA_LABELED_RE =
  /(?:P\.?\s*IVA(?:\s*(?:e|\/|&)\s*(?:C\.?\s*F\.?|Cod\.?\s*Fisc\.?))?|Partita\s+IVA|C\.?\s*F\.?\s*(?:e|\/|&)\s*P\.?\s*IVA)\s*[:.#-]?\s*(\d[\d\s.]{9,13}\d)(?!\d)/giu;
const ITALIAN_TEXT_CLUE_RE =
  /\bS\.?\s*r\.?\s*l\.?s?\.?\b|\bS\.?\s*p\.?\s*A\.?\b|\bS\.?\s*a\.?\s*s\.?\b|\bS\.?\s*n\.?\s*c\.?\b|\b\d{5}\s+[A-ZÀ-Ü][A-Za-zÀ-ü' -]{2,30}\s*\(?[A-Z]{2}\)?/u;

function hasItalianClue(text: string, opts?: ExtractEuVatOptions): boolean {
  if (opts?.countryHint && opts.countryHint.trim().toUpperCase() === 'IT') return true;
  if (opts?.domain) {
    const host = opts.domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//u, '')
      .replace(/\/.*$/u, '')
      .replace(/\.$/u, '');
    if (host.endsWith('.it')) return true;
  }
  return ITALIAN_TEXT_CLUE_RE.test(text);
}

/**
 * Extracts a validated EU VAT ID from webpage text.
 * Priority: JSON-LD vatID > labeled EU prefixed VAT > standalone checksum-verified VAT
 * > labeled prefix-less Italian P.IVA (only with an Italian country/domain/legal clue).
 */
export function extractEuVat(text: string, opts?: ExtractEuVatOptions): string | undefined {
  if (!text) return undefined;

  for (const match of text.matchAll(JSONLD_VAT_RE)) {
    const vat = normalizeEuVat(match[1]!);
    if (vat) return vat;
  }

  for (const labelMatch of text.matchAll(VAT_LABEL_RE)) {
    const start = (labelMatch.index ?? 0) + labelMatch[0].length;
    const window = text.slice(start, start + 60);
    for (const vatMatch of window.matchAll(PREFIXED_EU_VAT_RE)) {
      const vat = normalizeEuVat(`${vatMatch[1]}${vatMatch[2]}`);
      if (vat) return vat;
    }
  }

  for (const match of text.matchAll(STANDALONE_CHECKSUM_VAT_RE)) {
    const vat = normalizeEuVat(match[0]);
    if (vat) return vat;
  }

  if (hasItalianClue(text, opts)) {
    for (const match of text.matchAll(ITALIAN_PIVA_LABELED_RE)) {
      const digits = match[1]!.replace(/[\s.]+/gu, '');
      if (/^\d{11}$/u.test(digits)) {
        const candidate = `IT${digits}`;
        if (isValidItalianVat(candidate)) return candidate;
      }
    }
  }

  return undefined;
}
