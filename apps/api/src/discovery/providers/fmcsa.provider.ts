import { createHash } from 'node:crypto';
import {
  isClearlyFmcsaOrganization,
  normalizeUsdotNumber,
  type FmcsaQcmobileCarrier,
} from '../../adapters/fmcsa-qcmobile';
import type { ExecutionBroker, ToolResult } from '../../tools/tool-contract';
import type { FmcsaQcmobileSearchInput, FmcsaQcmobileSearchOutput } from '../../tools/source-tools-fmcsa';
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  SourceClass,
} from '../provider-contract';

function exact(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function requiredProvenance(result: ToolResult<unknown>, query: string, start: number, limit: number) {
  const provenance = result.provenance;
  if (
    !provenance?.sourceUrl || !provenance.contentHash || !/^[a-f0-9]{64}$/u.test(provenance.contentHash) ||
    provenance.parserVersion !== 'fmcsa-qcmobile-v1/1' || Number.isNaN(new Date(provenance.fetchedAt).getTime())
  ) throw new Error('FMCSA_PROVENANCE_REQUIRED');
  let url: URL;
  try {
    url = new URL(provenance.sourceUrl);
  } catch {
    throw new Error('FMCSA_PROVENANCE_REQUIRED');
  }
  const expectedPath = `/qc/services/carriers/name/${encodeURIComponent(query)}`;
  if (
    url.protocol !== 'https:' || url.hostname !== 'mobile.fmcsa.dot.gov' || url.pathname !== expectedPath || url.hash ||
    url.searchParams.size !== 3 || url.searchParams.get('start') !== String(start) ||
    url.searchParams.get('size') !== String(limit) || url.searchParams.get('webKey') !== 'REDACTED'
  ) throw new Error('FMCSA_PROVENANCE_REQUIRED');
  return {
    sourceUrl: provenance.sourceUrl,
    fetchedAt: provenance.fetchedAt,
    contentHash: provenance.contentHash,
    parserVersion: provenance.parserVersion,
  };
}

function validateResult(item: FmcsaQcmobileCarrier, query: string): void {
  if (
    normalizeUsdotNumber(item.usdotNumber) !== item.usdotNumber ||
    !item.legalName?.trim() || item.legalName.length > 200 || !isClearlyFmcsaOrganization(item.legalName) ||
    ![item.legalName, item.dbaName].some((value) => typeof value === 'string' && exact(value) === exact(query)) ||
    (item.state !== undefined && !/^[A-Z]{2}$/u.test(item.state)) ||
    (item.allowedToOperate !== undefined && !['Y', 'N'].includes(item.allowedToOperate)) ||
    (item.outOfService !== undefined && !['Y', 'N'].includes(item.outOfService))
  ) throw new Error('FMCSA_BROKER_RESULT_INVALID');
}

function fingerprint(query: string): string {
  return createHash('sha256').update(JSON.stringify({ query: exact(query), country: 'US' })).digest('hex');
}

function encodeCursor(start: number, scope: string): string {
  if (!Number.isSafeInteger(start) || start < 1 || start > 49) throw new Error('FMCSA_CURSOR_INVALID');
  return Buffer.from(JSON.stringify({ start, scope }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, scope: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.scope !== scope || !Number.isSafeInteger(parsed.start) || Number(parsed.start) < 1 || Number(parsed.start) > 49) {
      throw new Error('invalid');
    }
    return Number(parsed.start);
  } catch {
    throw new Error('FMCSA_CURSOR_INVALID');
  }
}

export class FmcsaQcmobileOrganizationDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'fmcsa_qcmobile';
  readonly classes: SourceClass[] = ['company_registry'];

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    if (typeof query.filters.source_hint !== 'string' || exact(query.filters.source_hint) !== this.key) {
      return { records: [], costCents: 0 };
    }
    if (typeof query.filters.country !== 'string' || !['us', 'usa', 'united states', 'united states of america'].includes(exact(query.filters.country))) {
      throw new Error('FMCSA_COUNTRY_SCOPE_INVALID');
    }
    if (typeof query.filters.organization_name !== 'string' || !query.filters.organization_name.trim()) {
      throw new Error('FMCSA_EXACT_QUERY_REQUIRED');
    }
    if (!this.deps?.broker) throw new Error('FMCSA_BROKER_REQUIRED');
    const organizationName = query.filters.organization_name.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
    if (!organizationName || organizationName.length > 200 || ['all', 'any', 'carriers'].includes(exact(organizationName)) || /[*?,;]/u.test(organizationName)) {
      throw new Error('FMCSA_EXACT_QUERY_REQUIRED');
    }
    const scope = fingerprint(organizationName);
    const start = decodeCursor(opts?.cursor, scope);
    const limit = Math.min(Math.max(query.limit, 1), 10);
    if (start + limit > 50) throw new Error('FMCSA_CURSOR_INVALID');
    const output = await this.deps.broker.invoke<FmcsaQcmobileSearchInput, FmcsaQcmobileSearchOutput>(
      'fmcsa-qcmobile.search',
      { query: organizationName, start, limit },
      { ...ctx, purpose: 'discovery' },
    );
    const provenance = requiredProvenance(output, organizationName, start, limit);
    output.data.carriers.forEach((item) => validateResult(item, organizationName));
    return {
      records: output.data.carriers.map((item) => ({
        externalId: `fmcsa-qcmobile:${item.usdotNumber}`,
        name: item.legalName,
        country: 'US',
        region: item.state,
        identifiers: [{ scheme: 'usdot', jurisdiction: 'US', value: item.usdotNumber }],
        attributes: {
          fmcsa_qcmobile: {
            usdot_number: item.usdotNumber,
            dba_name: item.dbaName,
            allowed_to_operate: item.allowedToOperate,
            out_of_service: item.outOfService,
            state: item.state,
            identity_status: 'validated_usdot_v1_source_identifier',
            disclaimer: 'usdot-v1 accepts only the current 1..8 digit QCMobile number form; it claims no checksum, operating authority, or support for future identifier formats.',
            transformation_notice: 'Organization-only projection normalized by global-backend; phone, email, exact address, sole-proprietor and unknown upstream fields are excluded.',
          },
        },
        license: 'SOURCE_SPECIFIC',
        provenance,
      })),
      costCents: output.costCents,
      ...(output.data.nextCursor ? { nextCursor: encodeCursor(Number(output.data.nextCursor), scope) } : {}),
    };
  }
}
