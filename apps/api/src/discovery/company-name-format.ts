/** © ® ℠ ™ */
const TRADEMARK_SIGNS = /[\u{a9}\u{ae}\u{2120}\u{2122}]/gu;
/** ` ʻ ʼ ‘ ’ ‚ ‛ ′ (´ is handled before NFKC) */
const APOSTROPHES = /[`\u{2bb}\u{2bc}\u{2018}\u{2019}\u{201a}\u{201b}\u{2032}]/gu;
/** ‐ ‑ ‒ – — ― − */
const DASHES = /[\u{2010}-\u{2015}\u{2212}]/gu;
/** Separators that search titles put between a company name and a slogan: | ¦ · • ‧ ∙ ⋅ */
const TITLE_SEPARATORS = /[|\u{a6}\u{b7}\u{2022}\u{2027}\u{2219}\u{22c5}]/gu;
/** " « » “ ” „ ‟ ‹ › */
const DOUBLE_QUOTES = /["\u{ab}\u{bb}\u{201c}-\u{201f}\u{2039}\u{203a}]/gu;
/** Single quotes around a word or phrase ('Pumpen' GmbH): quotation marks, unlike the apostrophe in O'Brien. */
const QUOTED_PHRASE = /(^|[\s(])'([^']+)'(?=$|[\s),.:/-])/gu;

/**
 * Normalizes a candidate company name for the Raw boundary: NFKC text of letters,
 * digits, spaces and `._+&'(),/#:-`. Typographic apostrophes, dashes and title
 * separators become plain forms; quotes, trademark signs and format controls are
 * stripped; "_" becomes a space; whitespace collapses. Names containing phone
 * numbers, emails or URLs are intentionally left untouched so Raw rejects them.
 */
export function normalizeCompanyNameTypography(raw: string): string {
  return raw
    // Before NFKC, which spells ™ and ℠ out as "TM" and "SM" and splits ´ into a space and a combining accent.
    .replace(TRADEMARK_SIGNS, '')
    .replace(/\u{b4}/gu, "'")
    .normalize('NFKC')
    .replace(APOSTROPHES, "'")
    .replace(DASHES, '-')
    .replace(TITLE_SEPARATORS, '-')
    .replace(DOUBLE_QUOTES, '')
    .replace(/\p{Cf}/gu, '')
    // The database writer's contact rules read "_" as a word break, so "Pumpen_Secret" must reach the
    // TypeScript boundary as "Pumpen Secret": both then refuse it, instead of the writer raising alone.
    .replace(/_/gu, ' ')
    .replace(QUOTED_PHRASE, '$1$2')
    .replace(/\s+/gu, ' ')
    .trim();
}
