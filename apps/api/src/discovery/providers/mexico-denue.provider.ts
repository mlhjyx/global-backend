import { createHash } from 'node:crypto';
import { isValidPublishedClee, type MexicoDenueOrganization } from '../../adapters/mexico-denue';
import type { ExecutionBroker, ToolResult } from '../../tools/tool-contract';
import type { MexicoDenueSearchInput, MexicoDenueSearchOutput } from '../../tools/source-tools-mexico-denue';
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  SourceClass,
} from '../provider-contract';

function exact(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('es-MX');
}

function requiredProvenance(result: ToolResult<unknown>, expectedPath: string) {
  const provenance = result.provenance;
  if (
    !provenance?.sourceUrl || !provenance.contentHash || !/^[a-f0-9]{64}$/u.test(provenance.contentHash) ||
    provenance.parserVersion !== 'denue-nombre-v1/1' || Number.isNaN(new Date(provenance.fetchedAt).getTime())
  ) throw new Error('DENUE_PROVENANCE_REQUIRED');
  let url: URL;
  try {
    url = new URL(provenance.sourceUrl);
  } catch {
    throw new Error('DENUE_PROVENANCE_REQUIRED');
  }
  if (
    url.protocol !== 'https:' || url.hostname !== 'www.inegi.org.mx' ||
    url.pathname !== expectedPath || url.search || url.hash
  ) throw new Error('DENUE_PROVENANCE_REQUIRED');
  return {
    sourceUrl: provenance.sourceUrl,
    fetchedAt: provenance.fetchedAt,
    contentHash: provenance.contentHash,
    parserVersion: provenance.parserVersion,
  };
}

function validateResult(item: MexicoDenueOrganization, query: string): void {
  if (
    !isValidPublishedClee(item.clee) || !/^\d{10}$/u.test(item.denueId) ||
    !item.name?.trim() || item.name.length > 300 || !item.legalName?.trim() || item.legalName.length > 300 ||
    ![item.name, item.legalName].some((value) => exact(value) === exact(query))
  ) throw new Error('DENUE_BROKER_RESULT_INVALID');
}

function fingerprint(query: string, stateCode: string): string {
  return createHash('sha256').update(JSON.stringify({ query: exact(query), stateCode })).digest('hex');
}

function encodeCursor(start: number, scope: string): string {
  if (!Number.isSafeInteger(start) || start < 2 || start > 481) throw new Error('DENUE_CURSOR_INVALID');
  return Buffer.from(JSON.stringify({ start, scope }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, scope: string): number {
  if (!cursor) return 1;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.scope !== scope || !Number.isSafeInteger(parsed.start) || Number(parsed.start) < 2 || Number(parsed.start) > 481) {
      throw new Error('invalid');
    }
    return Number(parsed.start);
  } catch {
    throw new Error('DENUE_CURSOR_INVALID');
  }
}

export class MexicoDenueOrganizationDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'mexico_denue';
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
    if (typeof query.filters.country !== 'string' || !['mx', 'mexico', 'méxico'].includes(exact(query.filters.country))) {
      throw new Error('DENUE_COUNTRY_SCOPE_INVALID');
    }
    if (typeof query.filters.organization_name !== 'string' || !query.filters.organization_name.trim()) {
      throw new Error('DENUE_EXACT_QUERY_REQUIRED');
    }
    if (typeof query.filters.state_code !== 'string' || !/^(?:0[1-9]|[12]\d|3[0-2])$/u.test(query.filters.state_code)) {
      throw new Error('DENUE_STATE_CODE_INVALID');
    }
    if (!this.deps?.broker) throw new Error('DENUE_BROKER_REQUIRED');
    const organizationName = query.filters.organization_name.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
    if (organizationName.length > 200 || exact(organizationName) === 'todos' || /[*?,;]/u.test(organizationName)) {
      throw new Error('DENUE_EXACT_QUERY_REQUIRED');
    }
    const stateCode = query.filters.state_code;
    const scope = fingerprint(organizationName, stateCode);
    const start = decodeCursor(opts?.cursor, scope);
    const output = await this.deps.broker.invoke<MexicoDenueSearchInput, MexicoDenueSearchOutput>(
      'mexico-denue.search',
      { query: organizationName, stateCode, start, limit: Math.min(Math.max(query.limit, 1), 20) },
      { ...ctx, purpose: 'discovery' },
    );
    const end = start + Math.min(Math.max(query.limit, 1), 20) - 1;
    const expectedPath = `/app/api/denue/v1/consulta/Nombre/${encodeURIComponent(organizationName)}/${stateCode}/${start}/${end}/REDACTED_TOKEN`;
    const provenance = requiredProvenance(output, expectedPath);
    output.data.organizations.forEach((item) => validateResult(item, organizationName));
    return {
      records: output.data.organizations.map((item) => ({
        externalId: `mexico-denue:${item.denueId}`,
        name: item.legalName,
        country: 'MX',
        region: item.state,
        industry: item.economicActivity,
        attributes: {
          mexico_denue: {
            clee: item.clee,
            denue_id: item.denueId,
            trade_name: item.name,
            legal_name: item.legalName,
            economic_activity: item.economicActivity,
            employee_band: item.size,
            state: item.state,
            municipality: item.municipality,
            locality: item.locality,
            establishment_type: item.establishmentType,
            reported_website_candidate: item.website,
            identity_status: 'source_native_establishment_evidence_only',
            disclaimer: 'DENUE CLEE and Id identify a statistical establishment; neither is promoted as a validated Mexican legal-entity identifier.',
            attribution: 'Fuente: INEGI, Directorio Estadístico Nacional de Unidades Económicas (DENUE).',
            transformation_notice: 'Organization-only projection normalized by global-backend; contact, detailed address, coordinate, and unknown upstream fields are excluded.',
            no_endorsement: 'This transformed projection does not imply endorsement by INEGI.',
          },
        },
        license: 'INEGI_FREE_USE_WITH_ATTRIBUTION',
        provenance,
      })),
      costCents: output.costCents,
      ...(output.data.nextCursor
        ? { nextCursor: encodeCursor(Number(output.data.nextCursor), scope) }
        : {}),
    };
  }
}
