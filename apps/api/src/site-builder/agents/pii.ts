/** SMTPUTF8/IDN-aware email matching without a broad `\S+@\S+` overmatch. */
const EMAIL_RE =
  /(?<![\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~.-])[\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~-]+)*@[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?(?:\.[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?)*\.[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])(?![\p{L}\p{N}\p{M}-])/giu;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;

export function scrubPii(text: string): string {
  return text
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, "[redacted-phone]");
}

/**
 * Company-profile variant (G3 5.4 + Batch 1.7B): the same email/phone redaction,
 * but a valid EU/CH VAT identifier (DE136695976, IT05503370289, CHE-123.456.789)
 * or an explicit Italian P.IVA with valid Mod-10 checksum (P.IVA e C.F. 04553650989)
 * is a company tax identifier, not a phone number, and is kept.
 *
 * Security invariant: country prefixes are strictly uppercase (never matching
 * lowercase prepositions like "at"/"de"/"it") and every candidate must pass
 * country-specific VAT format + checksum rules so phone numbers never slip through.
 * Site Builder evidence keeps using `scrubPii` unchanged.
 */
const TAX_PREFIX_BEFORE_RE =
  /(?<![A-Za-z0-9])(ATU|CHE|BE|BG|CH|CY|CZ|DE|DK|EE|EL|ES|FI|FR|GR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|XI)[\s.-]?$/u;
const PHONE_CUE_BEFORE_PREFIX_RE =
  /\b(?:tel(?:efon|ephone|efono)?|phone|fax|call|mob(?:il|ile)?|fon|handy|cell(?:ulare)?)\s*\.?\s*[:#-]?\s*$/iu;
const ITALIAN_PIVA_LABEL_BEFORE_RE =
  /(?:P\.?\s*IVA(?:\s*(?:e|\/|&)\s*(?:C\.?\s*F\.?|Cod\.?\s*Fisc\.?))?|Partita\s+IVA|C\.?\s*F\.?\s*(?:e|\/|&)\s*P\.?\s*IVA)\s*[:.#-]?\s*$/iu;

const SIMPLE_PREFIX_BODY_PATTERNS: Readonly<Record<string, RegExp>> = {
  ATU: /^\d{8}$/u,
  BG: /^\d{9,10}$/u,
  CH: /^\d{9}$/u,
  CHE: /^\d{9}$/u,
  CY: /^\d{8}[A-Z]$/u,
  CZ: /^\d{8,10}$/u,
  DK: /^\d{8}$/u,
  EE: /^\d{9}$/u,
  EL: /^\d{9}$/u,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/u,
  FI: /^\d{8}$/u,
  GR: /^\d{9}$/u,
  HR: /^\d{11}$/u,
  HU: /^\d{8}$/u,
  IE: /^(?:\d[A-Z0-9+*]\d{5}[A-Z]|\d{7}[A-Z]{1,2})$/u,
  LT: /^(?:\d{9}|\d{12})$/u,
  LU: /^\d{8}$/u,
  LV: /^\d{11}$/u,
  MT: /^\d{8}$/u,
  PT: /^\d{9}$/u,
  RO: /^\d{2,10}$/u,
  SE: /^\d{12}$/u,
  SI: /^\d{8}$/u,
  SK: /^\d{10}$/u,
  XI: /^(?:\d{9}|\d{12})$/u,
};

function isValidGermanVatDigits(digits: string): boolean {
  if (!/^[1-9]\d{8}$/u.test(digits)) return false;
  let product = 10;
  for (let i = 0; i < 8; i++) {
    let sum = (Number(digits[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  const check = (11 - product) % 10;
  return check === Number(digits[8]);
}

function isValidItalianVatDigits(digits: string): boolean {
  if (!/^\d{11}$/u.test(digits) || /^0+$/u.test(digits.slice(0, 7))) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const d = Number(digits[i]);
    if (i % 2 === 0) {
      sum += d;
    } else {
      const doubled = d * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    }
  }
  return (10 - (sum % 10)) % 10 === Number(digits[10]);
}

function isValidBelgianVatDigits(digits: string): boolean {
  if (!/^[01]\d{9}$/u.test(digits)) return false;
  const base = Number(digits.slice(0, 8));
  const check = Number(digits.slice(8));
  return base > 0 && 97 - (base % 97) === check;
}

function isValidPolishVatDigits(digits: string): boolean {
  if (!/^\d{10}$/u.test(digits) || /^0+$/u.test(digits)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(digits[i]) * weights[i]!;
  }
  const mod = sum % 11;
  return mod < 10 && mod === Number(digits[9]);
}

function isValidFrenchVatBody(body: string): boolean {
  if (!/^[0-9A-HJ-NP-Z]{2}\d{9}$/u.test(body)) return false;
  if (!/^\d{11}$/u.test(body)) return true;
  const key = Number(body.slice(0, 2));
  const siren = Number(body.slice(2));
  return siren > 0 && (12 + 3 * (siren % 97)) % 97 === key;
}

function isValidDutchVatBody(body: string): boolean {
  const match = /^(\d{9})B(\d{2})$/u.exec(body);
  if (!match || /^0+$/u.test(match[1]!) || match[2] === "00") return false;
  const digits = match[1]!.split("").map(Number);
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
  return BigInt(`2321${match[1]!}11${match[2]!}`) % 97n === 1n;
}

function isValidPrefixedTaxBody(prefix: string, body: string): boolean {
  if (prefix === "DE") return isValidGermanVatDigits(body);
  if (prefix === "IT") return isValidItalianVatDigits(body);
  if (prefix === "BE") return isValidBelgianVatDigits(body);
  if (prefix === "PL") return isValidPolishVatDigits(body);
  if (prefix === "FR") return isValidFrenchVatBody(body);
  if (prefix === "NL") return isValidDutchVatBody(body);
  const pattern = SIMPLE_PREFIX_BODY_PATTERNS[prefix];
  return pattern ? pattern.test(body) : false;
}

function trailingVatSuffix(source: string, endOffset: number): string {
  const after = source.slice(endOffset, endOffset + 4);
  const tail = after.match(/^(?:B\d{2}|[A-Z]{1,2})(?![A-Za-z0-9])/u);
  return tail ? tail[0] : "";
}

function isPreservedCompanyTaxId(match: string, offset: number, source: string): boolean {
  if (match.startsWith("+") || /[\r\n()]/u.test(match)) return false;
  if (offset > 0 && /\d/u.test(source[offset - 1]!)) return false;
  const before = source.slice(Math.max(0, offset - 40), offset);
  const compact = match.replace(/[\s.-]+/gu, "").toUpperCase();
  const prefixMatch = before.match(TAX_PREFIX_BEFORE_RE);
  if (prefixMatch) {
    const prefix = prefixMatch[1]!;
    const beforePrefix = before.slice(0, before.length - prefixMatch[0].length);
    if (!PHONE_CUE_BEFORE_PREFIX_RE.test(beforePrefix)) {
      const suffix = trailingVatSuffix(source, offset + match.length);
      if (isValidPrefixedTaxBody(prefix, compact + suffix)) return true;
    }
  }
  const compactDigits = match.replace(/[\s.]+/gu, "");
  return (
    ITALIAN_PIVA_LABEL_BEFORE_RE.test(before) &&
    isValidItalianVatDigits(compactDigits)
  );
}

export function scrubPiiKeepingTaxIds(text: string): string {
  return text
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, (match, offset: number, source: string) =>
      isPreservedCompanyTaxId(match, offset, source) ? match : "[redacted-phone]",
    );
}
