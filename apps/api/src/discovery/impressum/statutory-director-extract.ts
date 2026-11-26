import { looksLikeOrganizationName } from '../providers/contact-extraction';

export type StatutoryJurisdictionHint = 'DE' | 'IT' | 'FR' | 'JP' | 'KR';

export interface StatutoryDirector {
  readonly name: string;
  readonly role: string;
  readonly sourceUrl: string;
  readonly jurisdictionHint: StatutoryJurisdictionHint;
}

const MAX_STATUTORY_DIRECTORS = 8;

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  szlig: 'ß',
  agrave: 'à',
  egrave: 'è',
  eacute: 'é',
  igrave: 'ì',
  ograve: 'ò',
  ugrave: 'ù',
});

function decodeEntitiesOnce(input: string): string {
  return input.replace(/&(?:([a-z]+)|#(\d+)|#x([0-9a-f]+));/giu, (match, name, dec, hex) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    if (dec) {
      const code = Number(dec);
      return Number.isInteger(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return Number.isInteger(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return match;
  });
}

function htmlToLinesPreservingFooter(html: string): string[] {
  if (!html) return [];
  const stripped = html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1[^>]*>/giu, ' ')
    .replace(/<(strong|b)\b[^>]*>([^<>]{1,64})<\/\1>(?!\s*[:：\-–—])(?=\s+[^<\s])/giu, (tag, _element, label: string) => {
      const role = decodeEntitiesOnce(label).trim();
      return STATUTORY_PATTERNS.some((pattern) => pattern.re.exec(role)?.[2] === '')
        ? `${tag}: `
        : tag;
    })
    .replace(/<br\b[^>]*>/giu, '\n')
    .replace(/<\/?(?:p|div|li|tr|td|th|h[1-6]|dt|dd|section|article|address|footer)\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  return decodeEntitiesOnce(stripped)
    .split(/\r?\n/u)
    .map((line) => line.replace(/[\t ]+/gu, ' ').trim())
    .filter((line) => line.length > 0);
}

interface StatutoryRolePattern {
  readonly jurisdiction: StatutoryJurisdictionHint;
  readonly re: RegExp;
}

const STATUTORY_PATTERNS: readonly StatutoryRolePattern[] = [
  // DE
  {
    jurisdiction: 'DE',
    re: /^(?:vertreten\s+durch\s+(?:den|die)\s+)?(geschäftsführer(?:in)?|geschäftsführung|vertreten\s+durch|vorstand(?:svorsitzender)?|inhaber(?:in)?)\s*(?:[:：\-–—]\s*|$)(.*)$/iu,
  },
  // IT
  {
    jurisdiction: 'IT',
    re: /^(legale\s+rappresentante|rappresentante\s+legale|amministratore\s+(?:delegato|unico)|presidente\s+del\s+c\.?d\.?a\.?)\s*(?:[:：\-–—]\s*|$)(.*)$/iu,
  },
  // FR
  {
    jurisdiction: 'FR',
    re: /^(directeur\s+général|directrice\s+générale|gérant(?:e)?|représentant\s+légal|président(?:e)?)\s*(?:[:：\-–—]\s*|$)(.*)$/iu,
  },
  // JP
  {
    jurisdiction: 'JP',
    re: /^(代表取締役(?:社長|会長)?|代表社員|取締役社長|代表者)\s*[:：\-–—\s]*(.*)$/u,
  },
  // KR
  {
    jurisdiction: 'KR',
    re: /^(대표자(?:\s*성명)?|대표이사)\s*[:：\-–—\s]*(.*)$/u,
  },
];

const LATIN_HONORIFIC_RE = /^(?:herr|frau|dr\.?|prof\.?|dott\.?|ing\.?|avv\.?|sig\.?|m\.|mme|mr\.?|ms\.?|mrs\.?)\s+/iu;
const LEGAL_NOISE_RE =
  /(?:§\s*\d+|rstv|mdstv|tmg|ddg|datenschutz|impressum|partita\s+iva|\bp\.?\s*iva\b|codice\s+fiscale|registro\s+imprese|privacy|cookie|http|www\.|@|tel\.?|fax|telefon|e-?mail|via\s+\p{L}|str(?:aße|asse)\b|plz|\d{4,})/iu;
const NON_EXECUTIVE_DISCLOSURE_RE =
  /^(?:verantwortlich(?:e[rn]?)?\b|redaktion(?:ell\p{L}*)?\b|(?:responsabile|titolare)\s+del\s+trattamento\b|direct(?:eur|rice)\s+de\s+la\s+publication\b|délégué(?:e)?\s+à\s+la\s+protection\b)/iu;
const JP_ORG_RE = /(?:株式会社|有限会社|合同会社|株式會社|法人|会社|住所|電話|資本金|事業|〒)/u;
const KR_ORG_RE = /(?:주식회사|유한회사|\(주\)|사업자|주소|전화|팩스)/u;

const JP_NAME_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,8}(?:\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{1,6})?$/u;
const KR_NAME_RE = /^[\p{Script=Hangul}]{2,5}(?:\s+[\p{Script=Hangul}]{1,3})?$/u;
const LATIN_WORD_RE = /^[\p{Script=Latin}][\p{Script=Latin}'’.-]*$/u;

function validateStatutoryPersonName(
  rawCandidate: string,
  jurisdiction: StatutoryJurisdictionHint,
): string | null {
  let candidate = rawCandidate
    .replace(/[(（][^()（）]*[)）]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!candidate || candidate.length > 80) return null;
  if (LEGAL_NOISE_RE.test(candidate) || NON_EXECUTIVE_DISCLOSURE_RE.test(candidate)) return null;

  if (jurisdiction === 'JP') {
    const cleanedJp = candidate.replace(/[\u3000\s]+/gu, ' ').trim();
    if (JP_ORG_RE.test(cleanedJp)) return null;
    if (JP_NAME_RE.test(cleanedJp)) return cleanedJp;
  }
  if (jurisdiction === 'KR') {
    const cleanedKr = candidate.replace(/\s+/gu, ' ').trim();
    if (KR_ORG_RE.test(cleanedKr)) return null;
    if (KR_NAME_RE.test(cleanedKr)) return cleanedKr;
  }

  for (let i = 0; i < 3; i += 1) {
    candidate = candidate.replace(LATIN_HONORIFIC_RE, '').trim();
  }
  if (!candidate || looksLikeOrganizationName(candidate)) return null;
  const words = candidate.split(/\s+/u).filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;
  if (!words.every((w) => LATIN_WORD_RE.test(w))) return null;
  return words.join(' ');
}

function splitCandidateNames(rawValue: string): string[] {
  const truncated = rawValue.split(/\s+[–—-]\s+|\s*\|\s*/u, 1)[0] ?? '';
  return truncated
    .split(/\s*(?:,|;|\/|\band\b|\bund\b|\bet\b)\s*/iu)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Deterministic `$0` statutory disclosure director extractor for DE/IT/FR/JP/KR pages.
 * Parses raw HTML BEFORE `<footer>` stripping so footer Impressum/Privacy disclosures remain intact.
 */
export function extractStatutoryDirectorsFromHtml(
  html: string,
  sourceUrl: string,
): StatutoryDirector[] {
  const lines = htmlToLinesPreservingFooter(html);
  const out: StatutoryDirector[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    if (out.length >= MAX_STATUTORY_DIRECTORS) break;
    const line = lines[i]!;
    if (line.length > 260) continue;

    for (const pattern of STATUTORY_PATTERNS) {
      const match = pattern.re.exec(line);
      if (!match) continue;
      const role = match[1]!.replace(/\s+/gu, ' ');
      let tail = (match[2] ?? '').trim();
      if (!tail && i + 1 < lines.length) {
        const nextLine = lines[i + 1]!;
        if (nextLine.length <= 120 && !STATUTORY_PATTERNS.some((p) => p.re.test(nextLine))) {
          tail = nextLine;
        }
      }
      if (!tail) continue;
      for (const rawName of splitCandidateNames(tail)) {
        const valid = validateStatutoryPersonName(rawName, pattern.jurisdiction);
        if (!valid) continue;
        const key = valid.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          name: valid,
          role: /^vertreten durch$/iu.test(role) ? 'Vertretungsberechtigte Person' : role,
          sourceUrl,
          jurisdictionHint: pattern.jurisdiction,
        });
        if (out.length >= MAX_STATUTORY_DIRECTORS) break;
      }
      break;
    }
  }

  return out;
}
