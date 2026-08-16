import { createHash } from 'node:crypto';
import type { KonepsContractBuyer } from '../../adapters/koneps-contracts';
import type { ExecutionBroker, ToolResult } from '../../tools/tool-contract';
import type {
  KonepsContractSearchInput,
  KonepsContractSearchOutput,
} from '../../tools/source-tools-koneps';
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  ExecutionContext,
  SourceClass,
} from '../provider-contract';

const exact = (value: string): string =>
  value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('ko-KR');

function exactTerm(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
  if (
    normalized.length < 2 || normalized.length > 200 || /[*?;,]/u.test(normalized) ||
    ['all', 'any', '전체', '모두'].includes(exact(normalized))
  ) return undefined;
  return normalized;
}

function date(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function scope(input: Omit<KonepsContractSearchInput, 'page' | 'limit'>): string {
  return createHash('sha256').update(JSON.stringify({
    organizationName: exact(input.organizationName),
    productName: exact(input.productName),
    fromDate: input.fromDate,
    toDate: input.toDate,
    country: 'KR',
  })).digest('hex');
}

function encodeCursor(page: number, fingerprint: string): string {
  if (!Number.isSafeInteger(page) || page < 2 || page > 10) throw new Error('KONEPS_CURSOR_INVALID');
  return Buffer.from(JSON.stringify({ page, scope: fingerprint }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, fingerprint: string): number {
  if (!cursor) return 1;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      parsed.scope !== fingerprint || !Number.isSafeInteger(parsed.page) ||
      Number(parsed.page) < 2 || Number(parsed.page) > 10
    ) throw new Error('invalid');
    return Number(parsed.page);
  } catch {
    throw new Error('KONEPS_CURSOR_INVALID');
  }
}

function validateBuyer(value: unknown, expectedName: string): asserts value is KonepsContractBuyer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('KONEPS_BROKER_RESULT_INVALID');
  const buyer = value as KonepsContractBuyer;
  if (
    !buyer.contractNumber || !/^[\p{L}\p{N}._-]+$/u.test(buyer.contractNumber) ||
    !buyer.contractName || buyer.contractName.length > 500 ||
    !buyer.buyerCode || !/^[\p{L}\p{N}._-]+$/u.test(buyer.buyerCode) ||
    !buyer.buyerName || buyer.buyerName.length > 255 || exact(buyer.buyerName) !== exact(expectedName) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(buyer.contractDate) ||
    (buyer.totalAmount !== undefined && (!Number.isFinite(buyer.totalAmount) || buyer.totalAmount < 0)) ||
    (buyer.procurementClassName !== undefined && buyer.procurementClassName.length > 300)
  ) throw new Error('KONEPS_BROKER_RESULT_INVALID');
}

function provenance(
  result: ToolResult<unknown>,
  input: KonepsContractSearchInput,
) {
  const value = result.provenance;
  if (
    !value?.sourceUrl || !value.contentHash || !/^[a-f0-9]{64}$/u.test(value.contentHash) ||
    value.parserVersion !== 'koneps-contract-buyers-v1/1' || Number.isNaN(new Date(value.fetchedAt).getTime())
  ) throw new Error('KONEPS_PROVENANCE_REQUIRED');
  let url: URL;
  try {
    url = new URL(value.sourceUrl);
  } catch {
    throw new Error('KONEPS_PROVENANCE_REQUIRED');
  }
  if (
    url.protocol !== 'https:' || url.hostname !== 'apis.data.go.kr' ||
    url.pathname !== '/1230000/ao/CntrctInfoService/getCntrctInfoListThngPPSSrch' ||
    url.username || url.password || url.hash || url.searchParams.has('serviceKey') || url.searchParams.size !== 8 ||
    url.searchParams.get('pageNo') !== String(input.page) || url.searchParams.get('numOfRows') !== String(input.limit) ||
    url.searchParams.get('inqryDiv') !== '1' || url.searchParams.get('inqryBgnDate') !== input.fromDate.replaceAll('-', '') ||
    url.searchParams.get('inqryEndDate') !== input.toDate.replaceAll('-', '') ||
    url.searchParams.get('insttNm') !== input.organizationName ||
    url.searchParams.get('prdctClsfcNoNm') !== input.productName || url.searchParams.get('type') !== 'json'
  ) throw new Error('KONEPS_PROVENANCE_REQUIRED');
  return {
    sourceUrl: value.sourceUrl,
    fetchedAt: value.fetchedAt,
    contentHash: value.contentHash,
    parserVersion: value.parserVersion,
  };
}

export class KonepsContractBuyerDiscoveryProvider implements CompanyDiscoveryAdapter {
  readonly key = 'koneps';
  readonly classes: SourceClass[] = ['public_intelligence'];

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async discoverCompanies(
    query: CompanyDiscoveryQuery,
    ctx: ExecutionContext,
    opts?: DiscoveryOptions,
  ): Promise<DiscoveryResult> {
    if (query.sourceClass !== 'public_intelligence') return { records: [], costCents: 0 };
    if (typeof query.filters.source_hint !== 'string' || exact(query.filters.source_hint) !== this.key) {
      return { records: [], costCents: 0 };
    }
    if (
      typeof query.filters.country !== 'string' ||
      !['kr', 'kor', 'south korea', 'republic of korea', '대한민국'].includes(exact(query.filters.country))
    ) throw new Error('KONEPS_COUNTRY_SCOPE_INVALID');
    const organizationName = exactTerm(query.filters.organization_name);
    if (!organizationName) throw new Error('KONEPS_EXACT_ORGANIZATION_REQUIRED');
    if (query.keywords.length !== 1) throw new Error('KONEPS_EXACT_KEYWORD_REQUIRED');
    const productName = exactTerm(query.keywords[0]);
    if (!productName) throw new Error('KONEPS_EXACT_KEYWORD_REQUIRED');
    const fromDate = date(query.filters.from_date);
    const toDate = date(query.filters.to_date);
    if (!fromDate || !toDate) throw new Error('KONEPS_DATE_WINDOW_INVALID');
    const span = Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`);
    if (span < 0 || span > 31 * 86_400_000) throw new Error('KONEPS_DATE_WINDOW_INVALID');
    if (!this.deps?.broker) throw new Error('KONEPS_BROKER_REQUIRED');
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) throw new Error('KONEPS_LIMIT_INVALID');

    const baseInput = { organizationName, productName, fromDate, toDate };
    const fingerprint = scope(baseInput);
    const page = decodeCursor(opts?.cursor, fingerprint);
    const limit = Math.min(query.limit, 10);
    const input = { ...baseInput, page, limit };
    const output = await this.deps.broker.invoke<KonepsContractSearchInput, KonepsContractSearchOutput>(
      'koneps.contract-buyers.search', input, { ...ctx, purpose: 'discovery' },
    );
    const safeProvenance = provenance(output, input);
    if (!output.data || !Array.isArray(output.data.buyers) || output.data.buyers.length > limit) {
      throw new Error('KONEPS_BROKER_RESULT_INVALID');
    }
    output.data.buyers.forEach((buyer) => validateBuyer(buyer, organizationName));
    let nextCursor: string | undefined;
    if (output.data.nextCursor !== undefined) {
      if (!/^\d{1,2}$/u.test(output.data.nextCursor)) throw new Error('KONEPS_CURSOR_INVALID');
      const nextPage = Number(output.data.nextCursor);
      if (nextPage !== page + 1 || nextPage > 10) throw new Error('KONEPS_CURSOR_INVALID');
      nextCursor = encodeCursor(nextPage, fingerprint);
    }

    return {
      records: output.data.buyers.map((buyer) => ({
        externalId: `koneps-contract-buyer:${createHash('sha256').update(`${buyer.contractNumber}\0${buyer.buyerCode}`).digest('hex')}`,
        name: buyer.buyerName,
        country: 'KR',
        attributes: {
          procurement_role: 'buyer',
          signal_stage: 'contracted',
          koneps_contract: {
            contract_number: buyer.contractNumber,
            contract_name: buyer.contractName,
            contract_date: buyer.contractDate,
            buyer_code: buyer.buyerCode,
            total_amount_krw: buyer.totalAmount,
            procurement_class_name: buyer.procurementClassName,
            identity_status: 'source_metadata_not_promoted',
            transformation_notice: 'Buyer-organization projection by global-backend; supplier lists, creditor names, named officers, department names, phone/fax numbers and unknown upstream fields are excluded.',
          },
        },
        license: 'KOREA_PUBLIC_DATA_UNRESTRICTED',
        provenance: safeProvenance,
      })),
      costCents: output.costCents,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }
}
