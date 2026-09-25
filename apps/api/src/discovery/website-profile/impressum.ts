/**
 * Deterministic Impressum parsing (G3 spec 2026-09-24 §3 ⑤/⑥): company-level
 * identifiers only. Never extracts managing directors, owners or any person
 * line; a sole-trader firm name (e.K.) is a personal name and is rejected.
 */

export interface ImpressumRegister {
  readonly type: 'HRA' | 'HRB';
  readonly number: string;
  readonly court: string | null;
  /** Secondary dedupe key, e.g. `de-hrb:muenchen:98765`. */
  readonly key: string;
}

export interface ParsedImpressum {
  readonly legalName: string | null;
  readonly register: ImpressumRegister | null;
  readonly vatId: string | null;
}

const REGISTER_RE = /\bH\s?R\s?([AB])\b\s*(?:Nr\.?|-?Nummer)?\s*[:.]?\s*(\d{1,6})(?:\s?([A-Z]{1,2})\b)?/u;
const COURT_RE = /Amtsgericht\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]*(?:[ -][A-ZÄÖÜ][A-Za-zÄÖÜäöüß.-]*)?(?:\s*\([^)\n]{1,40}\))?)/u;
const VAT_RE = /\bDE\s?(\d{3})\s?(\d{3})\s?(\d{3})\b/gu;
const CAPITAL_FORM_RE =
  /\b(?:GmbH\s*&\s*Co\.?\s*KG(?:aA)?|GmbH|gGmbH|AG|SE|KGaA|UG\s*\(haftungsbeschränkt\)|eG)(?![\p{L}\p{N}])/u;
const NON_NAME_LINE_RE =
  /gesch(?:ä|ae)ftsf(?:ü|ue)hr|vorstand|inhaber|vertreten|aufsichtsrat|amtsgericht|registergericht|handelsregister|registernummer|\bust\b|ust-?id|umsatzsteuer|steuernummer|steuer-?nr|telefon|\btel\b|\bfax\b|e-?mail|\bsitz\b|copyright|©|datenschutz|http|www\.|verantwortlich|§/iu;
const MAX_NAME_LENGTH = 120;

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
  const key = `de-${type.toLowerCase()}:${court ? slug(court) : 'unknown'}:${number.replace(/\s+/gu, '').toLowerCase()}`;
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
    if (!CAPITAL_FORM_RE.test(line)) continue;
    if (/:/u.test(line)) continue;
    return line;
  }
  return null;
}

export function parseImpressum(text: string): ParsedImpressum {
  return {
    legalName: parseLegalName(text),
    register: parseRegister(text),
    vatId: parseVat(text),
  };
}
