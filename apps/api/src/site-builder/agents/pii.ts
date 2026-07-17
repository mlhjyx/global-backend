/** SMTPUTF8/IDN-aware email matching without a broad `\S+@\S+` overmatch. */
const EMAIL_RE =
  /(?<![\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~.-])[\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~-]+)*@[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?(?:\.[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?)*\.[\p{L}\p{N}\p{M}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])(?![\p{L}\p{N}\p{M}-])/giu;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;

export function scrubPii(text: string): string {
  return text
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(PHONE_RE, "[redacted-phone]");
}
