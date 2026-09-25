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
 * Company-profile variant (G3 5.4): the same email/phone redaction, but a
 * digit run right after an EU VAT country prefix (DE136695976, DE 136695976)
 * is a company tax identifier, not a phone number, and is kept. Site Builder
 * evidence keeps using `scrubPii` unchanged.
 */
const PHONE_KEEPING_TAX_IDS_RE =
  /(?<!\d)(?<!\b(?:DE|AT|ATU|CH|CHE|FR|IT|NL|PL|ES|BE|LU|DK|CZ|SE)\s?)(?:\+?\d[\d\s().-]{7,}\d)/g;

export function scrubPiiKeepingTaxIds(text: string): string {
  return text
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_KEEPING_TAX_IDS_RE, "[redacted-phone]");
}
