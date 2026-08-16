import { createHash } from 'node:crypto';
import {
  ExternalHttpActionDeniedError,
  requestPublicHttp,
  type PublicHttpResponse,
} from './guarded-http';

export interface KonepsContractBuyer {
  contractNumber: string;
  contractName: string;
  buyerCode: string;
  buyerName: string;
  contractDate: string;
  totalAmount?: number;
  procurementClassName?: string;
}

export interface KonepsContractBuyerPage {
  records: KonepsContractBuyer[];
  nextCursor?: string;
  total?: number;
  provenance: {
    sourceUrl: string;
    fetchedAt: string;
    contentHash: string;
    parserVersion: 'koneps-contract-buyers-v1/1';
  };
}

export interface KonepsContractDependencies {
  request?: typeof requestPublicHttp;
}

const BASE_URL = 'https://apis.data.go.kr/1230000/ao/CntrctInfoService/getCntrctInfoListThngPPSSrch';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).normalize('NFKC').trim().replaceAll(/\s+/gu, ' ');
  return normalized && normalized.length <= max ? normalized : undefined;
};

const exact = (value: string): string =>
  value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('ko-KR');

function safeExactTerm(value: unknown, maximum: number): string | undefined {
  const normalized = text(value, maximum);
  if (
    !normalized || normalized.length < 2 || /[*?;,]/u.test(normalized) ||
    ['all', 'any', '전체', '모두'].includes(exact(normalized))
  ) return undefined;
  return normalized;
}

function compactDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value.replaceAll('-', '')
    : undefined;
}

function boundedWindow(fromDate: string, toDate: string): { from: string; to: string } | undefined {
  const from = compactDate(fromDate);
  const to = compactDate(toDate);
  if (!from || !to) return undefined;
  const span = Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`);
  return span >= 0 && span <= 31 * 86_400_000 ? { from, to } : undefined;
}

function amount(value: unknown): number | undefined {
  const candidate = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{1,18}(?:\.\d{1,2})?$/u.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isFinite(candidate) && candidate >= 0 && candidate <= Number.MAX_SAFE_INTEGER
    ? candidate
    : undefined;
}

function contractDate(value: unknown): string | undefined {
  const candidate = text(value, 10)?.replaceAll('-', '');
  if (!candidate || !/^\d{8}$/u.test(candidate)) return undefined;
  const iso = `${candidate.slice(0, 4)}-${candidate.slice(4, 6)}-${candidate.slice(6, 8)}`;
  return compactDate(iso) ? iso : undefined;
}

function officialItems(value: unknown, maximumRows: number): { rows: unknown[]; total?: number } {
  const root = object(value);
  const header = object(root?.header);
  const body = object(root?.body);
  if (!root || !header || !body || text(header.resultCode, 20) !== '00') {
    throw new Error('KONEPS_SCHEMA_CHANGED');
  }
  const item = object(body.items)?.item;
  const rows = item === undefined || item === null ? [] : Array.isArray(item) ? item : [item];
  if (rows.length > maximumRows) throw new Error('KONEPS_SCHEMA_CHANGED');
  const rawTotal = text(body.totalCount, 20);
  const total = rawTotal && /^\d{1,12}$/u.test(rawTotal) ? Number(rawTotal) : undefined;
  return { rows, total };
}

function redactedTransportError(): Error {
  return new Error('KONEPS_REQUEST_FAILED', { cause: new Error('KONEPS_TRANSPORT_REDACTED') });
}

/**
 * The official contract schema contains named officers, phone/fax numbers,
 * creditor and supplier-list fields. Only buyer-organization and contract
 * evidence on this allowlist crosses the adapter boundary.
 */
export function parseKonepsContractBuyerResponse(
  value: unknown,
  expectedBuyerName: string,
  maximumRows = 10,
): { records: KonepsContractBuyer[]; total?: number; wireCount: number } {
  const { rows, total } = officialItems(value, maximumRows);
  const records = rows.flatMap((raw): KonepsContractBuyer[] => {
    const row = object(raw);
    const buyerName = text(row?.cntrctInsttNm, 255);
    const buyerCode = text(row?.cntrctInsttCd, 80);
    const contractNumber = text(row?.untyCntrctNo, 100);
    const contractName = text(row?.cntrctNm, 500);
    const signedOn = contractDate(row?.cntrctCnclsDate ?? row?.cntrctDate);
    if (
      !row || !buyerName || exact(buyerName) !== exact(expectedBuyerName) ||
      !buyerCode || !/^[\p{L}\p{N}._-]+$/u.test(buyerCode) ||
      !contractNumber || !/^[\p{L}\p{N}._-]+$/u.test(contractNumber) || !contractName || !signedOn
    ) return [];
    return [{
      contractNumber,
      contractName,
      buyerCode,
      buyerName,
      contractDate: signedOn,
      totalAmount: amount(row.totCntrctAmt),
      procurementClassName: text(row.pubPrcrmntClsfcNm, 300),
    }];
  });
  return { records, total, wireCount: rows.length };
}

export async function searchKonepsContractBuyers(
  input: {
    organizationName: string;
    productName: string;
    fromDate: string;
    toDate: string;
    page: number;
    limit: number;
  },
  serviceKey: string,
  beforeRequest?: () => Promise<void>,
  dependencies: KonepsContractDependencies = {},
): Promise<KonepsContractBuyerPage> {
  const organizationName = safeExactTerm(input.organizationName, 200);
  const productName = safeExactTerm(input.productName, 200);
  const window = boundedWindow(input.fromDate, input.toDate);
  if (!organizationName || !productName) throw new Error('KONEPS_EXACT_QUERY_REQUIRED');
  if (!window) throw new Error('KONEPS_DATE_WINDOW_INVALID');
  if (
    !Number.isSafeInteger(input.page) || input.page < 1 || input.page > 10 ||
    !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10
  ) throw new Error('KONEPS_PAGE_INVALID');
  const key = serviceKey.trim();
  if (!key || key.length > 1000 || /[\r\n]/u.test(key)) throw new Error('KONEPS_SERVICE_KEY_REQUIRED');

  const safeUrl = new URL(BASE_URL);
  safeUrl.searchParams.set('pageNo', String(input.page));
  safeUrl.searchParams.set('numOfRows', String(input.limit));
  safeUrl.searchParams.set('inqryDiv', '1');
  safeUrl.searchParams.set('inqryBgnDate', window.from);
  safeUrl.searchParams.set('inqryEndDate', window.to);
  safeUrl.searchParams.set('insttNm', organizationName);
  safeUrl.searchParams.set('prdctClsfcNoNm', productName);
  safeUrl.searchParams.set('type', 'json');
  const requestUrl = new URL(safeUrl);
  requestUrl.searchParams.set('serviceKey', key);

  let response: PublicHttpResponse;
  try {
    response = await (dependencies.request ?? requestPublicHttp)(requestUrl.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: 20_000,
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
    }, {
      authorizeExternalAction: async () => {
        await beforeRequest?.();
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ExternalHttpActionDeniedError) throw error;
    // The guarded HTTP error may include the credential-bearing request URL.
    // Replace it before preserving the causal chain required by lint/telemetry.
    throw redactedTransportError();
  }
  if (response.finalUrl !== requestUrl.toString()) throw new Error('KONEPS_FINAL_URL_INVALID');
  if (!response.ok) throw new Error(`KONEPS_HTTP_${response.status}`);
  if (!response.headers['content-type']?.toLowerCase().includes('json')) {
    throw new Error('KONEPS_CONTENT_TYPE_INVALID');
  }
  if (response.body.byteLength > MAX_RESPONSE_BYTES) throw new Error('KONEPS_RESPONSE_TOO_LARGE');

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)) as unknown;
  } catch {
    throw new Error('KONEPS_INVALID_JSON');
  }
  const { records, total, wireCount } = parseKonepsContractBuyerResponse(raw, organizationName, input.limit);
  const hasMore = input.page < 10 && (
    (total !== undefined && input.page * input.limit < total) || wireCount === input.limit
  );
  return {
    records,
    ...(hasMore ? { nextCursor: String(input.page + 1) } : {}),
    ...(total === undefined ? {} : { total }),
    provenance: {
      sourceUrl: safeUrl.toString(),
      fetchedAt: new Date().toISOString(),
      contentHash: createHash('sha256').update(JSON.stringify(records)).digest('hex'),
      parserVersion: 'koneps-contract-buyers-v1/1',
    },
  };
}
