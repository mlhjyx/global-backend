import { describe, expect, it, vi } from 'vitest';
import {
  parseKonepsContractBuyerResponse,
  searchKonepsContractBuyers,
} from './koneps-contracts';
import type { PublicHttpRequestOptions, PublicHttpResponse } from './guarded-http';

const officialRow = {
  untyCntrctNo: '2026000000001',
  cntrctNm: '철도용승강장안전발판 구매',
  cntrctCnclsDate: '20260801',
  cntrctInsttCd: '1230121',
  cntrctInsttNm: '조달청',
  totCntrctAmt: '2500000',
  pubPrcrmntClsfcNm: '철도용승강장안전발판',
  cntrctInsttOfclNm: 'MUST_NOT_SURVIVE',
  cntrctInsttOfclTelNo: '010-1234-5678',
  cntrctInsttOfclFaxNo: '02-1234-5678',
  cntrctInsttChrgDeptNm: 'Private Department',
  crdtrNm: 'Private Creditor',
  corpList: 'Private Supplier List',
  unknown: 'UNKNOWN_PRIVATE_FIELD',
};

function envelope(items: unknown, totalCount = '1') {
  return { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE' }, body: { items: { item: items }, totalCount } };
}

function response(value: unknown, finalUrl: string): PublicHttpResponse {
  const body = Buffer.from(JSON.stringify(value));
  return {
    status: 200,
    ok: true,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body,
    text: body.toString(),
    finalUrl,
  };
}

describe('KONEPS contract buyer adapter', () => {
  it('projects only exact buyer organization and contract evidence', () => {
    const result = parseKonepsContractBuyerResponse(envelope([
      officialRow,
      { ...officialRow, untyCntrctNo: '2026000000002', cntrctInsttNm: '다른 기관' },
    ]), '조달청', 10);
    expect(result.records).toEqual([{
      contractNumber: '2026000000001',
      contractName: '철도용승강장안전발판 구매',
      buyerCode: '1230121',
      buyerName: '조달청',
      contractDate: '2026-08-01',
      totalAmount: 2500000,
      procurementClassName: '철도용승강장안전발판',
    }]);
    expect(JSON.stringify(result)).not.toMatch(
      /MUST_NOT_SURVIVE|010-1234-5678|Private Department|Private Creditor|Private Supplier|UNKNOWN_PRIVATE_FIELD/u,
    );
  });

  it('uses the official goods contract search operation and never returns the service key in provenance', async () => {
    const serviceKey = 'SECRET%2BENCODED';
    const request = vi.fn(async (raw: string, options?: PublicHttpRequestOptions) => {
      const url = new URL(raw);
      expect(url.origin).toBe('https://apis.data.go.kr');
      expect(url.pathname).toBe('/1230000/ao/CntrctInfoService/getCntrctInfoListThngPPSSrch');
      expect(url.searchParams.get('serviceKey')).toBe(serviceKey);
      expect([...url.searchParams.keys()]).toEqual([
        'pageNo', 'numOfRows', 'inqryDiv', 'inqryBgnDate', 'inqryEndDate',
        'insttNm', 'prdctClsfcNoNm', 'type', 'serviceKey',
      ]);
      expect(options).toMatchObject({ maxRedirects: 0, maxBytes: 2 * 1024 * 1024 });
      return response(envelope([officialRow]), raw);
    });
    const page = await searchKonepsContractBuyers({
      organizationName: '조달청',
      productName: '철도용승강장안전발판',
      fromDate: '2026-08-01',
      toDate: '2026-08-07',
      page: 1,
      limit: 1,
    }, serviceKey, undefined, { request: request as never });
    expect(page.records).toHaveLength(1);
    expect(page.nextCursor).toBe('2');
    expect(page.provenance.sourceUrl).not.toContain(serviceKey);
    expect(page.provenance.sourceUrl).not.toMatch(/serviceKey/iu);
  });

  it('fails before egress for broad input, unbounded dates, pages, or a missing key', async () => {
    const request = vi.fn();
    const base = {
      organizationName: '조달청', productName: '철도용승강장안전발판',
      fromDate: '2026-08-01', toDate: '2026-08-07', page: 1, limit: 10,
    };
    for (const [input, key] of [
      [{ ...base, organizationName: '전체' }, 'key'],
      [{ ...base, productName: '*' }, 'key'],
      [{ ...base, toDate: '2026-10-01' }, 'key'],
      [{ ...base, page: 11 }, 'key'],
      [base, ''],
    ] as const) {
      await expect(searchKonepsContractBuyers(input, key, undefined, { request }))
        .rejects.toThrow(/KONEPS_/u);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed on a non-success official envelope', () => {
    expect(() => parseKonepsContractBuyerResponse({
      header: { resultCode: '20', resultMsg: 'SERVICE KEY ERROR' },
      body: {},
    }, '조달청')).toThrow('KONEPS_SCHEMA_CHANGED');
  });

  it('redacts transport failures from the public error chain', async () => {
    const request = vi.fn(async (raw: string) => {
      throw new Error(`transport failed at ${raw}`);
    });
    const promise = searchKonepsContractBuyers({
      organizationName: '조달청', productName: '철도용승강장안전발판',
      fromDate: '2026-08-01', toDate: '2026-08-07', page: 1, limit: 10,
    }, 'TOP_SECRET_KEY', undefined, { request: request as never });
    const error = await promise.catch((value: unknown) => value) as Error & { cause?: unknown };
    expect(error.message).toBe('KONEPS_REQUEST_FAILED');
    expect(error.cause).toEqual(expect.objectContaining({ message: 'KONEPS_TRANSPORT_REDACTED' }));
    expect(JSON.stringify(error)).not.toContain('TOP_SECRET_KEY');
  });
});
