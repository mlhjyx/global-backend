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
/** Register, tax and contact lines are company facts of another kind, never part of the address. */
const ADDRESS_OTHER_FACT =
  /\bH\s?R\s?[AB]\b|Amtsgericht|Registergericht|Handelsregister|Registernummer|\bUSt\b|Umsatzsteuer|Steuernummer|Steuer-?Nr|\bTel\b|\bFax\b|Telefon|Mobil|E-?Mail|@/iu;
/** A German postal code followed by the city: 5 digits, whitespace, then a capitalised name. */
const ADDRESS_POSTAL_CITY =
  /(?<!\d)(\d{5})\s+([A-ZÄÖÜ][\p{L}.\- ]{0,60})(?:,\s*[A-ZÄÖÜ][\p{L}.\- ]{0,40})?$/u;
const ADDRESS_PHONE_LIKE = /(?:\+?\p{Nd}[\s().\-/]*){7,}/u;
const MAX_ADDRESS_BYTES = 200;

/**
 * Whether a string is a company postal address worth storing: bounded, no email /
 * URL / phone / person / register markers, and ending in a German postal code (5 digits)
 * followed by the city. Used by the Impressum parser and the canonical-attribute sanitizer.
 */
export function isRegisteredAddressText(value: string): boolean {
  if (value.normalize('NFKC') !== value) return false;
  if (Buffer.byteLength(value, 'utf8') > MAX_ADDRESS_BYTES) return false;
  if (/https?:\/\//iu.test(value) || /\bwww\./iu.test(value)) return false;
  if (ADDRESS_PERSON.test(value) || ADDRESS_OTHER_FACT.test(value) || ADDRESS_PHONE_LIKE.test(value)) return false;
  const postal = ADDRESS_POSTAL_CITY.exec(value);
  if (!postal) return false;
  // Something street-like must precede the postal code ("Musterstraße 1", "Postfach 12").
  const before = value.slice(0, postal.index);
  return /[\p{L}]{3,}/u.test(before) && /\d/u.test(before);
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

function cleanedAddress(candidate: string): string {
  return candidate.replace(/^[,;:\-\s]+|[,;:\-\s]+$/gu, '').replace(/\s+/gu, ' ').trim();
}

/**
 * The address after the first usable label. The value may sit on the label line, continue on
 * the next one ("Anschrift: Musterstraße 1" / "12345 Musterstadt"), or follow a bare label;
 * a line about a person or another company fact ends the candidate instead of being merged.
 */
function parseRegisteredAddress(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[*_#>`|]/gu, ' ').replace(/\s+/gu, ' ').trim());
  const continues = (line: string | undefined): line is string =>
    !!line && !ADDRESS_PERSON.test(line) && !ADDRESS_OTHER_FACT.test(line);
  for (let index = 0; index < lines.length; index += 1) {
    const match = ADDRESS_LABEL.exec(lines[index] ?? '');
    if (!match) continue;
    const inline = match[1]!.trim();
    const next = [lines[index + 1], lines[index + 2]];
    const candidates = [
      inline && continues(next[0]) ? `${inline}, ${next[0]}` : '',
      inline,
      !inline && continues(next[0]) && continues(next[1]) ? `${next[0]}, ${next[1]}` : '',
      !inline && continues(next[0]) ? next[0]! : '',
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const cleaned = cleanedAddress(candidate);
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
