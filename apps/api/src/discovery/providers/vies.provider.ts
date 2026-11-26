import { createHash } from 'node:crypto';
import type {
  CompanyEnrichmentAdapter,
  CompanyEnrichmentInput,
  EnrichmentResult,
  ExecutionContext,
} from '../provider-contract';
import type { ViesToolInput, ViesToolOutput } from '../../tools/vies-tools';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import { normalizeDomain } from '../identity';
import { nameScore, normForMatch } from '../name-match';
import { splitViesVat } from '../website-profile/eu-vat';

const PARSER_VERSION = 'vies/v1';
const ACCEPT_THRESHOLD = 0.72;
const BRAND_DOMAIN_CONFIDENCE = 0.85;

/** Generic industry/geography/legal tokens that cannot anchor a single-token subset match. */
const GENERIC_STOP_TOKENS = new Set([
  'solar', 'sol', 'sun', 'eco', 'energy', 'energia', 'green', 'power',
  'group', 'gruppo', 'italia', 'italy', 'europe', 'europa', 'euro',
  'service', 'services', 'solutions', 'systems', 'sistemi', 'tech', 'tec',
  'technology', 'trading', 'global', 'international', 'int', 'holding',
  'electric', 'elettrica', 'impianti', 'fotovoltaico', 'pv', 'renewable',
  'renewables', 'store', 'shop', 'market', 'trade', 'engineering', 'eng',
  'consulting', 'industrial', 'ind', 'distribuzione', 'distribution',
  'pro', 'new', 'top', 'net', 'com', 'srl', 'spa', 'sas', 'snc',
  'gmbh', 'ltd', 'inc',
]);

function extractSld(domain: string | undefined): string | null {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  // Handle common two-level public suffixes like .co.uk -> take parts[-3] if present.
  const secondLast = parts.at(-2)!;
  if (parts.length >= 3 && ['co', 'com', 'org', 'net', 'ltd', 'plc'].includes(secondLast)) {
    return parts.at(-3)!.toLowerCase();
  }
  return secondLast.toLowerCase();
}

function tokenAnchoredInDomain(
  token: string,
  domain: string | undefined,
  extraTokens: readonly string[],
): boolean {
  const sld = extractSld(domain);
  if (!sld) return false;
  if (token.length >= 4) {
    return sld.includes(token);
  }
  if (token.length === 3) {
    const segments = sld.split('-').filter(Boolean);
    if (segments.includes(token)) return true;
    const compactSld = sld.replaceAll('-', '');
    for (const extra of extraTokens) {
      if (compactSld.startsWith(extra) && compactSld.slice(extra.length) === token) return true;
      if (compactSld.endsWith(extra) && compactSld.slice(0, -extra.length) === token) return true;
    }
  }
  return false;
}

function subsetBrandDomainMatch(
  qTokens: Set<string>,
  nTokens: Set<string>,
  domain: string | undefined,
): boolean {
  if (!qTokens.size || !nTokens.size) return false;
  const qSubsetOfN = [...qTokens].every((t) => nTokens.has(t));
  const nSubsetOfQ = [...nTokens].every((t) => qTokens.has(t));
  if (!qSubsetOfN && !nSubsetOfQ) return false;

  const shared = [...qTokens].filter((t) => nTokens.has(t));
  const distinctive = shared.filter((t) => !GENERIC_STOP_TOKENS.has(t));
  if (distinctive.length >= 2) return true;
  if (distinctive.length === 0) return false;

  const extraTokens = [...new Set([...qTokens, ...nTokens])].filter((t) => !shared.includes(t));
  return distinctive.some((token) => tokenAnchoredInDomain(token, domain, extraTokens));
}

export function matchViesLegalName(
  input: Pick<CompanyEnrichmentInput, 'name' | 'legalName' | 'domain'>,
  viesLegalName: string,
): number | null {
  const candidates = [input.name, input.legalName].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  const n = normForMatch(viesLegalName);
  const nTokens = new Set(n.split(' ').filter(Boolean));
  if (!nTokens.size) return null;

  let bestScore = 0;
  let brandMatched = false;

  for (const candidate of candidates) {
    const q = normForMatch(candidate);
    const qTokens = new Set(q.split(' ').filter(Boolean));
    if (!qTokens.size) continue;
    const score = nameScore(q, qTokens, n, nTokens);
    if (score > bestScore) bestScore = score;
    if (subsetBrandDomainMatch(qTokens, nTokens, input.domain)) {
      brandMatched = true;
    }
  }

  if (bestScore >= ACCEPT_THRESHOLD) return bestScore;
  if (brandMatched) return Math.max(bestScore, BRAND_DOMAIN_CONFIDENCE);
  return null;
}

/**
 * Official free EU VIES VAT (P.IVA) T1 corroboration provider.
 * Verifies a website-extracted EU VAT ID through `ToolBroker('vies.check')`,
 * fails closed on redacted names (e.g. DE `"---"`) and name mismatches, and
 * persists address-free T1 legal identity facts under `attributes.vies`.
 */
export class ViesEnrichmentProvider implements CompanyEnrichmentAdapter {
  readonly key = 'vies';

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async enrichCompany(
    input: CompanyEnrichmentInput,
    ctx: ExecutionContext,
  ): Promise<EnrichmentResult> {
    const broker = this.deps?.broker;
    if (!broker || !input.vatId) return miss();

    const split = splitViesVat(input.vatId);
    if (!split) return miss();

    const toolCtx: ToolContext = { ...ctx, purpose: ['enrichment'] };
    const response = await broker.invoke<ViesToolInput, ViesToolOutput>(
      'vies.check',
      { countryCode: split.countryCode, vatNumber: split.vatNumber },
      toolCtx,
    );
    const data = response.data;
    if (!data || data.status !== 'VALID' || data.nameRedacted || !data.legalName) {
      return miss();
    }

    const confidence = matchViesLegalName(input, data.legalName);
    if (confidence === null) return miss();

    const attributes: Record<string, unknown> = prune({
      vat_id: data.vatId,
      legal_name: data.legalName,
      registered_country: data.isoCountry,
      registered_city: data.registeredCity,
      verified_status: 'VALID',
      request_date: data.requestDate,
      match_confidence: Number(confidence.toFixed(2)),
    });

    return {
      matched: true,
      confidence,
      attributes,
      provenance: {
        sourceUrl: 'https://ec.europa.eu/taxation_customs/vies/',
        fetchedAt: new Date().toISOString(),
        contentHash: createHash('sha256').update(`${data.vatId}:${data.legalName}`).digest('hex'),
        parserVersion: PARSER_VERSION,
      },
      costCents: 0,
    };
  }
}

function miss(): EnrichmentResult {
  return { matched: false, confidence: 0, attributes: {}, costCents: 0 };
}

function prune(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value != null));
}
