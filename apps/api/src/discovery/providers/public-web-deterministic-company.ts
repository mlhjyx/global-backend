import { isIP } from 'node:net';

const ACCEPTED_ORGANIZATION_TYPES = new Set([
  'Organization',
  'Corporation',
  'LocalBusiness',
]);
const MAX_JSON_LD_BLOCKS = 24;
const MAX_JSON_LD_BLOCK_CHARS = 100_000;
const MAX_NAME_CHARS = 240;
const MAX_COUNTRY_CHARS = 80;

export const PUBLIC_WEB_DETERMINISTIC_PARSER_VERSION =
  'public_web/deterministic-jsonld-v2';

export interface DeterministicPublicWebCompany {
  name: string;
  domain: string;
  country?: string;
  organizationType: 'Organization' | 'Corporation' | 'LocalBusiness';
  organizationUrl: string;
}

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- the evidence boundary replaces every ASCII control byte.
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned || cleaned.length > maximum) return null;
  return cleaned;
}

function cleanCountry(value: unknown): string | null {
  const country = cleanText(value, MAX_COUNTRY_CHARS);
  if (!country) return null;
  // schema.org permits free text here, and real pages sometimes place a postal
  // code in addressCountry. Keep ISO codes and human country names, but never
  // promote numeric/address fragments into canonical company country evidence.
  return /^\p{L}[\p{L}\p{M} .'-]*$/u.test(country) ? country : null;
}

function publicHostname(value: string): string | null {
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    if (
      !hostname.includes('.') ||
      hostname === 'localhost' ||
      isIP(hostname) !== 0 ||
      !/^[a-z0-9.-]+$/u.test(hostname) ||
      hostname.startsWith('.') ||
      hostname.endsWith('.') ||
      hostname.includes('..')
    ) return null;
    return hostname;
  } catch {
    return null;
  }
}

function exactOrganizationType(value: unknown): DeterministicPublicWebCompany['organizationType'] | null {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    if (typeof candidate !== 'string') continue;
    const suffix = candidate.trim().split(/[/#]/u).at(-1) ?? '';
    if (ACCEPTED_ORGANIZATION_TYPES.has(suffix)) {
      return suffix as DeterministicPublicWebCompany['organizationType'];
    }
  }
  return null;
}

function topLevelJsonLdNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script>/giu;
  let match: RegExpExecArray | null;
  let seenBlocks = 0;
  while ((match = scripts.exec(html)) && seenBlocks < MAX_JSON_LD_BLOCKS) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/iu.test(match[1] ?? '')) continue;
    seenBlocks += 1;
    const body = (match[2] ?? '').trim();
    if (!body || body.length > MAX_JSON_LD_BLOCK_CHARS) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const roots = Array.isArray(parsed) ? parsed : [parsed];
    for (const root of roots) {
      if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
      const record = root as Record<string, unknown>;
      const graph = record['@graph'];
      if (Array.isArray(graph)) {
        for (const item of graph) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            nodes.push(item as Record<string, unknown>);
          }
        }
      } else {
        nodes.push(record);
      }
    }
  }
  return nodes;
}

/**
 * Strict zero-model admission for a public_web search candidate.
 *
 * Search titles/snippets and query terms are deliberately ignored. A record is
 * admitted only when a top-level schema.org organization declaration carries
 * both a bounded name and an explicit URL whose normalized host exactly equals
 * the searched candidate host. Conflicting declarations fail closed.
 */
export function extractDeterministicPublicWebCompany(
  html: string,
  candidateDomain: string,
): DeterministicPublicWebCompany | null {
  const domain = publicHostname(candidateDomain);
  if (!domain) return null;

  const candidates: DeterministicPublicWebCompany[] = [];
  for (const node of topLevelJsonLdNodes(html)) {
    const organizationType = exactOrganizationType(node['@type']);
    if (!organizationType) continue;
    const name = cleanText(node.name, MAX_NAME_CHARS);
    const organizationUrl = cleanText(node.url, 2_048);
    if (!name || !organizationUrl || /^https?:\/\//iu.test(name)) continue;
    if (publicHostname(organizationUrl) !== domain) continue;
    const address = node.address && typeof node.address === 'object' && !Array.isArray(node.address)
      ? node.address as Record<string, unknown>
      : undefined;
    const country = cleanCountry(address?.addressCountry) ?? undefined;
    candidates.push({
      name,
      domain,
      ...(country ? { country } : {}),
      organizationType,
      organizationUrl,
    });
  }

  const unique = new Map<string, DeterministicPublicWebCompany>();
  for (const candidate of candidates) {
    const key = JSON.stringify({
      name: candidate.name.toLocaleLowerCase('und'),
      url: candidate.organizationUrl,
      country: candidate.country ?? null,
    });
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return unique.size === 1 ? [...unique.values()][0]! : null;
}
