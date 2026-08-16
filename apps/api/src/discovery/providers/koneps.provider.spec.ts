import { describe, expect, it, vi } from 'vitest';
import { KonepsContractBuyerDiscoveryProvider } from './koneps.provider';

const CTX = { workspaceId: 'workspace-1', runId: 'run-1' };
const PROVENANCE = {
  sourceUrl: 'https://apis.data.go.kr/1230000/ao/CntrctInfoService/getCntrctInfoListThngPPSSrch?pageNo=1&numOfRows=10&inqryDiv=1&inqryBgnDate=20260801&inqryEndDate=20260807&insttNm=%EC%A1%B0%EB%8B%AC%EC%B2%AD&prdctClsfcNoNm=%EC%B2%A0%EB%8F%84%EC%9A%A9%EC%8A%B9%EA%B0%95%EC%9E%A5%EC%95%88%EC%A0%84%EB%B0%9C%ED%8C%90&type=json',
  fetchedAt: '2026-08-16T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  parserVersion: 'koneps-contract-buyers-v1/1',
};
const buyer = {
  contractNumber: '2026000000001',
  contractName: '철도용승강장안전발판 구매',
  buyerCode: '1230121',
  buyerName: '조달청',
  contractDate: '2026-08-01',
  totalAmount: 2500000,
  procurementClassName: '철도용승강장안전발판',
};

function query(overrides: Record<string, unknown> = {}) {
  return {
    sourceClass: 'public_intelligence' as const,
    filters: {
      source_hint: 'koneps', country: 'KR', organization_name: '조달청',
      from_date: '2026-08-01', to_date: '2026-08-07',
      ...overrides,
    },
    keywords: ['철도용승강장안전발판'],
    limit: 10,
  };
}

describe('KONEPS contract buyer discovery provider', () => {
  it('requires exact hint, KR scope, one keyword, buyer name and a maximum 31-day window', async () => {
    const broker = { invoke: vi.fn() };
    const provider = new KonepsContractBuyerDiscoveryProvider({ broker: broker as never });
    await expect(provider.discoverCompanies({ ...query(), filters: { country: 'KR' } }, CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
    await expect(provider.discoverCompanies({ ...query(), sourceClass: 'company_registry' }, CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
    await expect(provider.discoverCompanies(query({ country: 'US' }), CTX))
      .rejects.toThrow('KONEPS_COUNTRY_SCOPE_INVALID');
    await expect(provider.discoverCompanies({ ...query(), keywords: ['one', 'two'] }, CTX))
      .rejects.toThrow('KONEPS_EXACT_KEYWORD_REQUIRED');
    await expect(provider.discoverCompanies(query({ to_date: '2026-10-01' }), CTX))
      .rejects.toThrow('KONEPS_DATE_WINDOW_INVALID');
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('maps buyer-side contract evidence without supplier, contact, domain, or strong identity fields', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { buyers: [buyer] }, costCents: 0, provenance: PROVENANCE,
    })) };
    const result = await new KonepsContractBuyerDiscoveryProvider({ broker: broker as never })
      .discoverCompanies(query(), CTX);
    expect(broker.invoke).toHaveBeenCalledWith('koneps.contract-buyers.search', {
      organizationName: '조달청',
      productName: '철도용승강장안전발판',
      fromDate: '2026-08-01',
      toDate: '2026-08-07',
      page: 1,
      limit: 10,
    }, expect.objectContaining({ purpose: 'discovery' }));
    expect(result.records).toEqual([expect.objectContaining({
      name: '조달청', country: 'KR', license: 'KOREA_PUBLIC_DATA_UNRESTRICTED', provenance: PROVENANCE,
    })]);
    expect(result.records[0]).not.toHaveProperty('identifier');
    expect(result.records[0]).not.toHaveProperty('identifiers');
    expect(result.records[0]).not.toHaveProperty('domain');
    expect(Object.keys(result.records[0]?.attributes?.koneps_contract as Record<string, unknown>))
      .not.toEqual(expect.arrayContaining([
        'corpList', 'crdtrNm', 'cntrctInsttOfclNm', 'cntrctInsttOfclTelNo',
        'cntrctInsttOfclFaxNo', 'cntrctInsttChrgDeptNm',
      ]));
  });

  it('rejects malformed Broker rows and provenance containing a service key', async () => {
    for (const badBuyer of [
      { ...buyer, buyerName: '다른 기관' },
      { ...buyer, buyerCode: 'bad/code' },
      { ...buyer, contractDate: 'not-a-date' },
    ]) {
      const broker = { invoke: vi.fn(async () => ({
        data: { buyers: [badBuyer] }, costCents: 0, provenance: PROVENANCE,
      })) };
      await expect(new KonepsContractBuyerDiscoveryProvider({ broker: broker as never })
        .discoverCompanies(query(), CTX)).rejects.toThrow('KONEPS_BROKER_RESULT_INVALID');
    }
    const leaked = { invoke: vi.fn(async () => ({
      data: { buyers: [buyer] }, costCents: 0,
      provenance: { ...PROVENANCE, sourceUrl: `${PROVENANCE.sourceUrl}&serviceKey=SECRET` },
    })) };
    await expect(new KonepsContractBuyerDiscoveryProvider({ broker: leaked as never })
      .discoverCompanies(query(), CTX)).rejects.toThrow('KONEPS_PROVENANCE_REQUIRED');
  });

  it('binds opaque continuation to the exact query scope', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { buyers: [buyer], nextCursor: '2' }, costCents: 0, provenance: PROVENANCE,
    })) };
    const provider = new KonepsContractBuyerDiscoveryProvider({ broker: broker as never });
    const first = await provider.discoverCompanies(query(), CTX);
    expect(first.nextCursor).toBeTruthy();
    await expect(provider.discoverCompanies(query({ organization_name: '다른 기관' }), CTX, {
      cursor: first.nextCursor,
    })).rejects.toThrow('KONEPS_CURSOR_INVALID');
  });
});
