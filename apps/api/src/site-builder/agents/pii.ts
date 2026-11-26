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
 * but a digit run right after an EU/CH VAT country prefix (DE136695976, IT05503370289)
 * or an explicit Italian P.IVA label (P.IVA e C.F. 04553650989) is a company tax
 * identifier, not a phone number, and is kept. Site Builder evidence keeps using
 * `scrubPii` unchanged.
 */
const TAX_PREFIX_BEFORE_RE =
  /\b(?:AT|ATU|BE|BG|CH|CHE|CY|CZ|DE|DK|EE|EL|ES|FI|FR|GR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|XI)[\s.-]?$/iu;
const ITALIAN_PIVA_LABEL_BEFORE_RE =
  /(?:P\.?\s*IVA(?:\s*(?:e|\/|&)\s*(?:C\.?\s*F\.?|Cod\.?\s*Fisc\.?))?|Partita\s+IVA|C\.?\s*F\.?\s*(?:e|\/|&)\s*P\.?\s*IVA)\s*[:.#-]?\s*$/iu;

function isPreservedCompanyTaxId(match: string, offset: number, source: string): boolean {
  if (match.startsWith("+") || /[\r\n]/u.test(match)) return false;
  if (offset > 0 && /\d/u.test(source[offset - 1]!)) return false;
  const before = source.slice(Math.max(0, offset - 40), offset);
  if (TAX_PREFIX_BEFORE_RE.test(before)) return true;
  const compactDigits = match.replace(/[\s.]+/gu, "");
  return /^\d{11}$/u.test(compactDigits) && ITALIAN_PIVA_LABEL_BEFORE_RE.test(before);
}

export function scrubPiiKeepingTaxIds(text: string): string {
  return text
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, (match, offset: number, source: string) =>
      isPreservedCompanyTaxId(match, offset, source) ? match : "[redacted-phone]",
    );
}
