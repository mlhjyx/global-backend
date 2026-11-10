import { describe, expect, it, vi } from 'vitest';
import {
  OpenCorporatesDiscoveryProvider,
  mapCompanyToRecord,
  readJurisdiction,
  readQueryText,
} from './opencorporates.provider';
import type { OpenCorporatesCompanyHit } from '../../adapters/opencorporates-api';
import { companyIdentity } from '../identity';
import { CompanyDiscoveryQuery, ExecutionContext } from '../provider-contract';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import type { OpenCorporatesSearchOutput } from '../../tools/source-tools';
import { BudgetOperationReplayError } from '../../tools/budget-store';

const NOW = '2026-11-10T00:00:00.000Z';
const CTX: ExecutionContext = { workspaceId: 'ws-1', runId: 'run-1' };
const ENV_ON = { OPENCORPORATES_PROVIDER: 'on' } as NodeJS.ProcessEnv;

/** 假 Broker：记录 invoke 调用；impl 抛错=闸门拒绝/工具失败。 */
function fakeBroker(
  impl: () => Promise<OpenCorporatesSearchOutput>,
): ExecutionBroker & { invokeMock: ReturnType<typeof vi.fn> } {
  const invokeMock = vi.fn(
    async (_toolId: string, _input: unknown, _ctx: ToolContext): Promise<ToolResult<unknown>> => {
      return { data: await impl(), costCents: 0 };
    },
  );
  return {
    invokeMock,
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: invokeMock as ExecutionBroker['invoke'],
  };
}

function hit(overrides: Partial<OpenCorporatesCompanyHit> = {}): OpenCorporatesCompanyHit {
  return {
    name: 'Müller Pumpen GmbH',
    companyNumber: 'HRB 12345',
    jurisdictionCode: 'de',
    status: 'Active',
    companyType: 'Private Limited Company',
    incorporationDate: '2001-04-12',
    registeredAddress: 'Musterstraße 1, 80331 München',
    opencorporatesUrl: 'https://opencorporates.com/companies/de/HRB12345',
    ...overrides,
  };
}

function q(filters: Record<string, unknown>, keywords: string[] = []): CompanyDiscoveryQuery {
  return { sourceClass: 'company_registry', filters, keywords, limit: 25 };
}

describe('OpenCorporates 命中 → ProviderCompanyRecord（mapCompanyToRecord）', () => {
  it('注册号 + 辖区是法人身份键；状态/地址/类型入 attributes + ODbL 署名', () => {
    const rec = mapCompanyToRecord(hit(), NOW)!;
    expect(rec.name).toBe('Müller Pumpen GmbH');
    expect(rec.country).toBe('DE'); // 辖区 'de' → 国家 DE
    expect(rec.identifier).toEqual({ scheme: 'oc-company-number:de', value: 'HRB 12345' });
    expect(rec.externalId).toMatch(/^opencorporates:[0-9a-f]{64}$/u);
    // 摘要确定：同辖区同注册号 → 同 externalId（重跑/分页去重稳定）。
    expect(mapCompanyToRecord(hit(), NOW)!.externalId).toBe(rec.externalId);
    // 不同辖区同号 → 不同 externalId（摘要含辖区）。
    expect(mapCompanyToRecord(hit({ jurisdictionCode: 'fr' }), NOW)!.externalId).not.toBe(rec.externalId);
    expect(rec.license).toBe('ODbL-1.0');
    const oc = rec.attributes?.opencorporates as Record<string, unknown>;
    expect(oc.company_number).toBe('HRB 12345');
    expect(oc.status).toBe('Active');
    expect(oc.registered_address).toBe('Musterstraße 1, 80331 München');
    expect(oc.license).toBe('ODbL-1.0');
    expect(String(oc.attribution)).toMatch(/OpenCorporates/);
    expect(rec.provenance?.parserVersion).toBe('opencorporates/v1');
    expect(rec.provenance?.sourceUrl).toBe('https://opencorporates.com/companies/de/HRB12345');
  });

  it("美国州级辖区：'us_de' → 国家 US，scheme 带州级辖区", () => {
    const rec = mapCompanyToRecord(
      hit({ companyNumber: 'C1234567', jurisdictionCode: 'us_de', opencorporatesUrl: undefined }),
      NOW,
    )!;
    expect(rec.country).toBe('US');
    expect(rec.identifier).toEqual({ scheme: 'oc-company-number:us_de', value: 'C1234567' });
    expect(rec.provenance?.sourceUrl).toContain('jurisdiction_code=us_de');
  });

  it('不同辖区的同号 → 不同 dedupeKey（绝不跨辖区误并）', () => {
    const de = mapCompanyToRecord(hit({ companyNumber: '12345', jurisdictionCode: 'de' }), NOW)!;
    const fr = mapCompanyToRecord(hit({ companyNumber: '12345', jurisdictionCode: 'fr' }), NOW)!;
    const kDe = companyIdentity({ name: de.name, country: de.country, identifier: de.identifier }).dedupeKey;
    const kFr = companyIdentity({ name: fr.name, country: fr.country, identifier: fr.identifier }).dedupeKey;
    expect(kDe).not.toBe(kFr);
  });

  it('缺 name/注册号/辖区 → null（主键缺失，不臆造）', () => {
    expect(mapCompanyToRecord(hit({ name: ' ' }), NOW)).toBeNull();
    expect(mapCompanyToRecord(hit({ companyNumber: '' }), NOW)).toBeNull();
    expect(mapCompanyToRecord(hit({ jurisdictionCode: '' }), NOW)).toBeNull();
  });

  it('🔴 合规：记录里绝不含高管/个人数据字段（只映射公司字段）', () => {
    const rec = mapCompanyToRecord(hit(), NOW)!;
    const serialized = JSON.stringify(rec).toLowerCase();
    expect(serialized).not.toContain('officer');
    expect(serialized).not.toContain('director');
    expect(serialized).not.toContain('person');
  });
});

describe('辖区与检索词读取（readJurisdiction / readQueryText）', () => {
  it('显式 jurisdiction_code 优先（含州级）', () => {
    expect(readJurisdiction({ jurisdiction_code: 'us_de' })).toEqual({ jurisdictionCode: 'us_de' });
    expect(readJurisdiction({ jurisdiction_code: 'DE', country: 'fr' })).toEqual({ jurisdictionCode: 'de' });
    expect(readJurisdiction({ jurisdiction_code: 'not a code!' })).toBeUndefined();
  });

  it('country_code / country 过滤 → 国家码；美国无国家级辖区 → undefined（fail-safe 不猜）', () => {
    expect(readJurisdiction({ country_code: 'de' })).toEqual({ countryCode: 'de' });
    expect(readJurisdiction({ country: '德国' })).toEqual({ countryCode: 'de' });
    expect(readJurisdiction({ country_code: 'us' })).toBeUndefined();
    expect(readJurisdiction({ country: '美国' })).toBeUndefined();
    expect(readJurisdiction({})).toBeUndefined();
  });

  it('检索词：keywords 优先 + 行业词，剥离中文词，去重限量', () => {
    expect(readQueryText(q({ country: '德国' }, ['Pumpen', 'Kreiselpumpen']))).toBe('Pumpen Kreiselpumpen');
    expect(readQueryText(q({ industry: '工业泵', country: '德国' }))).toBe('');
    expect(readQueryText(q({ industry: 'Pumpen', product: 'Kreiselpumpen' }))).toBe('Pumpen Kreiselpumpen');
  });
});

describe('OpenCorporatesDiscoveryProvider 契约与闸门', () => {
  it('key=opencorporates，class=company_registry，声明受治理公司血缘', () => {
    const p = new OpenCorporatesDiscoveryProvider();
    expect(p.key).toBe('opencorporates');
    expect(p.classes).toEqual(['company_registry']);
    expect(p.companyResultLineage).toBe('discovery-company-result-lineage/v1');
  });

  it('OPENCORPORATES_PROVIDER 缺省 off → 有效空血缘，零出网', async () => {
    const broker = fakeBroker(async () => ({ companies: [hit()] }));
    const p = new OpenCorporatesDiscoveryProvider({ broker, env: {} as NodeJS.ProcessEnv });
    const res = await p.discoverCompanies(q({ country: 'de' }, ['Pumpen']), CTX);
    expect(res.records).toEqual([]);
    expect(res.costCents).toBe(0);
    expect(res.lineage).toMatchObject({ recordCount: 0 });
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('开=on 但无检索词或无辖区 → 空（绝不裸拉全库）', async () => {
    const broker = fakeBroker(async () => ({ companies: [hit()] }));
    const p = new OpenCorporatesDiscoveryProvider({ broker, env: ENV_ON });
    expect((await p.discoverCompanies(q({ country: 'de' }), CTX)).records).toEqual([]);
    expect((await p.discoverCompanies(q({}, ['Pumpen']), CTX)).records).toEqual([]);
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('无 broker → fail-closed：空且零出网', async () => {
    const p = new OpenCorporatesDiscoveryProvider({ env: ENV_ON });
    const res = await p.discoverCompanies(q({ country: 'de' }, ['Pumpen']), CTX);
    expect(res.records).toEqual([]);
    expect(res.lineage).toMatchObject({ recordCount: 0 });
  });

  it('Broker 放行 → 经 opencorporates.search 发请求并映射，透传真 workspace/run 归属与 purpose=discovery', async () => {
    const broker = fakeBroker(async () => ({ companies: [hit()] }));
    const p = new OpenCorporatesDiscoveryProvider({ broker, env: ENV_ON });
    const res = await p.discoverCompanies(q({ country: 'de' }, ['Pumpen']), CTX);
    expect(broker.invokeMock).toHaveBeenCalledOnce();
    const [toolId, input, toolCtx] = broker.invokeMock.mock.calls[0] as [
      string,
      { query: string; countryCode?: string; limit: number },
      ToolContext,
    ];
    expect(toolId).toBe('opencorporates.search');
    expect(input).toMatchObject({ query: 'Pumpen', countryCode: 'de', limit: 25 });
    expect(toolCtx).toMatchObject({ workspaceId: 'ws-1', runId: 'run-1', purpose: 'discovery' });
    expect(res.records).toHaveLength(1);
    expect(res.records[0]!.name).toBe('Müller Pumpen GmbH');
  });

  it('Broker 拒绝（SUSPENDED/未登记/源合规矩阵未批准 → invoke 抛错）→ fail-safe 空结果', async () => {
    const broker = fakeBroker(async () => {
      throw new Error(
        'tool opencorporates.search denied: source compliance not approved: opencorporates',
      );
    });
    const p = new OpenCorporatesDiscoveryProvider({ broker, env: ENV_ON });
    const res = await p.discoverCompanies(q({ country: 'de' }, ['Pumpen']), CTX);
    expect(res.records).toEqual([]);
    expect(res.costCents).toBe(0);
    expect(broker.invokeMock).toHaveBeenCalledOnce();
  });

  it('回放不可用（BudgetOperationReplayError）绝不转成空成功源结果', async () => {
    const broker = fakeBroker(async () => {
      throw new BudgetOperationReplayError('oc-op');
    });
    const p = new OpenCorporatesDiscoveryProvider({ broker, env: ENV_ON });
    await expect(p.discoverCompanies(q({ country: 'de' }, ['Pumpen']), CTX)).rejects.toBeInstanceOf(
      BudgetOperationReplayError,
    );
  });
});
