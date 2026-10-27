/**
 * Deterministic Impressum parsing (G3 spec 2026-09-24 §3 ⑤/⑥): company-level
 * identifiers only. Never extracts managing directors, owners or any person
 * line; a sole-trader firm name (e.K.) is a personal name and is rejected.
 */

export interface ImpressumRegister {
  readonly type: 'HRA' | 'HRB';
  readonly number: string;
  readonly court: string | null;
  /**
   * Secondary dedupe key, e.g. `de-hrb:muenchen:98765`. Null when the court is
   * unknown: register numbers are only unique per court, so a court-less key
   * could merge different companies.
   */
  readonly key: string | null;
}

export interface ParsedImpressum {
  readonly legalName: string | null;
  readonly register: ImpressumRegister | null;
  readonly vatId: string | null;
  /**
   * BI-15 / L6: the company's registered address (mailing address for letters or
   * catalogues). Null for sole traders (no capital form) and whenever the page
   * does not state a postal address — a person's home address is never stored.
   */
  readonly registeredAddress: string | null;
}

const REGISTER_RE = /\bH\s?R\s?([AB])\b\s*(?:Nr\.?|-?Nummer)?\s*[:.]?\s*(\d{1,6})(?:\s?([A-Z]{1,2})\b)?/u;
// "Amtsgericht München", "des Amtsgerichts München", "Registergericht: München",
// "Registergericht: AG Köln"; a bare "Registergericht:" before "Amtsgericht …" defers to it.
const COURT_RE = /(?:Amtsgerichts?|Registergericht):?\s+(?:AG\s+)?(?!Amtsgericht)([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]*(?:[ -](?!H\s?R\s?[AB]\b)[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]*)?(?:\s*\([^)\n]{1,40}\))?)/u;
const VAT_RE = /\bDE\s?(\d{3})\s?(\d{3})\s?(\d{3})\b/gu;
const CAPITAL_FORM_RE =
  /\b(?:GmbH\s*&\s*Co\.?\s*KG(?:aA)?|GmbH|gGmbH|AG|SE|KGaA|UG\s*\(haftungsbeschränkt\)|eG)(?![\p{L}\p{N}])/u;
const NON_NAME_LINE_RE =
  /gesch(?:ä|ae)ftsf(?:ü|ue)hr|vorstand|inhaber|vertreten|aufsichtsrat|amtsgericht|registergericht|handelsregister|registernummer|\bust\b|ust-?id|umsatzsteuer|steuernummer|steuer-?nr|telefon|\btel\b|\bfax\b|e-?mail|\bsitz\b|copyright|©|datenschutz|http|www\.|verantwortlich|§/iu;
const MAX_NAME_LENGTH = 120;

/** German Impressum labels whose value is the company's postal address. */
const ADDRESS_LABEL =
  /^\s*(?:sitz(?:\s+der\s+gesellschaft)?|firmensitz|hauptsitz|anschrift|adresse|postanschrift)\b\s*:?\s*(.*)$/iu;
/** Address candidates mentioning a person are dropped, never stored. */
const ADDRESS_PERSON =
  /gesch(?:ä|ae)ftsf(?:ü|ue)hr|inhaber|vertreten|ansprechpartner|vorstand|\b(?:herr|frau|mr|mrs|ms|dr)\.?\s/iu;
const ADDRESS_POSTAL_CODE = /(?<!\d)\d{4,5}(?!\d)/u;
const ADDRESS_PHONE_LIKE = /(?:\+?\p{Nd}[\s().\-/]*){7,}/u;
const MAX_ADDRESS_BYTES = 200;

/**
 * Whether a string is a company postal address worth storing: bounded, no email /
 * URL / phone / person markers, and carrying a 4–5 digit postal code next to a city.
 * Used by the Impressum parser and the canonical-attribute sanitizer.
 */
export function isRegisteredAddressText(value: string): boolean {
  if (value.normalize('NFKC') !== value) return false;
  if (Buffer.byteLength(value, 'utf8') > MAX_ADDRESS_BYTES) return false;
  if (/@/u.test(value) || /https?:\/\//iu.test(value) || /\bwww\./iu.test(value)) return false;
  if (ADDRESS_PERSON.test(value) || ADDRESS_PHONE_LIKE.test(value)) return false;
  const postal = ADDRESS_POSTAL_CODE.exec(value);
  if (!postal) return false;
  const after = value.slice(postal.index + postal[0].length);
  const before = value.slice(0, postal.index);
  return /[A-Za-zÄÖÜäöüß]/u.test(after) || /[A-Za-zÄÖÜäöüß]/u.test(before);
}

/** German VAT id check digit (ISO 7064 MOD 11,10). */
export function isValidGermanVat(value: string): boolean {
  const match = /^DE(\d{9})$/u.exec(value);
  if (!match) return false;
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

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/ß/gu, 'ss')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

function parseRegister(text: string): ImpressumRegister | null {
  const match = REGISTER_RE.exec(text);
  if (!match) return null;
  const type = `HR${match[1]}` as 'HRA' | 'HRB';
  const number = match[3] ? `${match[2]} ${match[3]}` : match[2]!;
  const window = text.slice(Math.max(0, match.index - 160), match.index + match[0].length + 160);
  const court = COURT_RE.exec(window)?.[1]?.trim() ?? null;
  const key = court
    ? `de-${type.toLowerCase()}:${slug(court)}:${number.replace(/\s+/gu, '').toLowerCase()}`
    : null;
  return { type, number, court, key };
}

function parseVat(text: string): string | null {
  for (const match of text.matchAll(VAT_RE)) {
    const candidate = `DE${match[1]}${match[2]}${match[3]}`;
    if (isValidGermanVat(candidate)) return candidate;
  }
  return null;
}

function cleanLine(line: string): string {
  return line
    .replace(/[*_#>`|]/gu, ' ')
    .replace(/^\s*(?:firma|name|anbieter|unternehmen|betreiber)\s*:\s*/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function parseLegalName(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = cleanLine(raw);
    if (!line || line.length > MAX_NAME_LENGTH) continue;
    if (NON_NAME_LINE_RE.test(line)) continue;
    const form = CAPITAL_FORM_RE.exec(line);
    if (!form) continue;
    // A legal name ends with its company form: drop taglines after it.
    const name = line.slice(0, form.index + form[0].length).trim();
    if (/:/u.test(name)) continue;
    return name;
  }
  return null;
}

/** The address after the first usable label, possibly continued on the next lines. */
function parseRegisteredAddress(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[*_#>`|]/gu, ' ').replace(/\s+/gu, ' ').trim());
  for (let index = 0; index < lines.length; index += 1) {
    const match = ADDRESS_LABEL.exec(lines[index] ?? '');
    if (!match) continue;
    const inline = match[1]!.trim();
    const candidates: string[] = inline ? [inline] : [];
    if (!inline) {
      const following: string[] = [];
      for (let next = index + 1; next < lines.length && following.length < 2; next += 1) {
        if (lines[next]) following.push(lines[next]!);
      }
      if (following.length >= 2) candidates.push(`${following[0]}, ${following[1]}`);
      if (following.length >= 1) candidates.push(following[0]!);
    }
    for (const candidate of candidates) {
      const cleaned = candidate
        .replace(/^[,;:\-\s]+|[,;:\-\s]+$/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
      if (isRegisteredAddressText(cleaned)) return cleaned;
    }
  }
  return null;
}

export function parseImpressum(text: string): ParsedImpressum {
  const legalName = parseLegalName(text);
  return {
    legalName,
    register: parseRegister(text),
    vatId: parseVat(text),
    // A sole trader's address is a personal address: only store it with a company form.
    registeredAddress: legalName ? parseRegisteredAddress(text) : null,
  };
}
