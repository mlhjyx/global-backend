import { describe, expect, it, vi } from 'vitest';
import {
  CompaniesHouseRegistryDiscoveryProvider,
  mapCompanyHitToRecord,
  readQueryText,
} from './companies-house-registry.provider';
import type { ChCompanyHit } from '../../adapters/companies-house';
import { COMPANIES_HOUSE_LICENSE } from '../../adapters/companies-house';
import { companyIdentity } from '../identity';
import { CompanyDiscoveryQuery, ExecutionContext } from '../provider-contract';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import type { CompaniesHouseOutput } from '../../tools/source-tools';
import { BudgetOperationReplayError } from '../../tools/budget-store';

const NOW = '2026-11-10T00:00:00.000Z';
const CTX: ExecutionContext = { workspaceId: 'ws-1', runId: 'run-1' };
const ENV_ON = { COMPANIES_HOUSE_REGISTRY_PROVIDER: 'on' } as NodeJS.ProcessEnv;

function fakeBroker(
  impl: () => Promise<CompaniesHouseOutput>,
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

function hit(overrides: Partial<ChCompanyHit> = {}): ChCompanyHit {
  return {
    companyNumber: 'SC123456',
    title: 'ACME PUMPS LTD',
    companyStatus: 'active',
    ...overrides,
  };
}

function q(filters: Record<string, unknown>, keywords: string[] = []): CompanyDiscoveryQuery {
  return { sourceClass: 'company_registry', filters, keywords, limit: 25 };
}

describe('CH 命中 → ProviderCompanyRecord（mapCompanyHitToRecord）', () => {
  it('注册号 + GB 国别是法人身份键；状态入 attributes + OGL 署名', () => {
    const rec = mapCompanyHitToRecord(hit(), NOW)!;
    expect(rec.name).toBe('ACME PUMPS LTD');
    expect(rec.country).toBe('GB');
    expect(rec.identifier).toEqual({ scheme: 'ch-company-number', value: 'SC123456' });
    expect(rec.externalId).toBe('companies_house_registry:SC123456');
    expect(rec.license).toBe(COMPANIES_HOUSE_LICENSE);
    const ch = rec.attributes?.ch_registry as Record<string, unknown>;
    expect(ch.company_number).toBe('SC123456');
    expect(ch.company_status).toBe('active');
    expect(String(ch.attribution)).toMatch(/Companies House/);
    expect(rec.provenance?.parserVersion).toBe('companies_house_registry/v1');
    // 来源锚定到无查询串的受治理 API 端点（raw-source provenance 契约）。
    expect(rec.provenance?.sourceUrl).toBe(
      'https://api.company-information.service.gov.uk/search/companies',
    );
  });

  it('缺名称/注册号 → null（主键缺失，不臆造）；注册号归一为大写', () => {
    expect(mapCompanyHitToRecord(hit({ title: ' ' }), NOW)).toBeNull();
    expect(mapCompanyHitToRecord(hit({ companyNumber: '' }), NOW)).toBeNull();
    const lower = mapCompanyHitToRecord(hit({ companyNumber: 'sc123456' }), NOW)!;
    expect(lower.identifier).toEqual({ scheme: 'ch-company-number', value: 'SC123456' });
    expect(lower.externalId).toBe('companies_house_registry:SC123456');
  });

  it('🔴 合规：记录里绝不含 officers/个人数据字段', () => {
    const serialized = JSON.stringify(mapCompanyHitToRecord(hit(), NOW)).toLowerCase();
    expect(serialized).not.toContain('officer');
    expect(serialized).not.toContain('director');
    expect(serialized).not.toContain('person');
  });

  it('不同注册号 → 不同 dedupeKey（按注册号消歧，防同名误并）', () => {
    const a = mapCompanyHitToRecord(hit({ companyNumber: 'SC111111' }), NOW)!;
    const b = mapCompanyHitToRecord(hit({ companyNumber: 'SC222222' }), NOW)!;
    expect(companyIdentity({ name: a.name, country: a.country, identifier: a.identifier }).dedupeKey)
      .not.toBe(companyIdentity({ name: b.name, country: b.country, identifier: b.identifier }).dedupeKey);
  });
});

describe('readQueryText', () => {
  it('keywords 优先 + 行业词，剥离非目标语言词，去重限量', () => {
    expect(readQueryText(q({ country: 'United Kingdom' }, ['Pumps', 'Valves']))).toBe('Pumps Valves');
    expect(readQueryText(q({ industry: '工业泵', country: '英国' }))).toBe('');
    expect(readQueryText(q({ industry: 'pumps', product: 'valves' }))).toBe('pumps valves');
  });
});

describe('CompaniesHouseRegistryDiscoveryProvider 契约与三重闸门', () => {
  it('key/class/血缘：env off 不声明血缘（不路由）；on 声明受治理血缘', () => {
    const off = new CompaniesHouseRegistryDiscoveryProvider({ env: {} as NodeJS.ProcessEnv });
    expect(off.key).toBe('companies_house_registry');
    expect(off.classes).toEqual(['company_registry']);
    expect(off.companyResultLineage).toBeUndefined();
    const on = new CompaniesHouseRegistryDiscoveryProvider({ env: ENV_ON });
    expect(on.companyResultLineage).toBe('discovery-company-result-lineage/v1');
  });

  it('env off → 空结果且零出网（不发生任何 broker 调用）', async () => {
    const broker = fakeBroker(async () => ({ companies: [hit()] }));
    const p = new CompaniesHouseRegistryDiscoveryProvider({ broker, env: {} as NodeJS.ProcessEnv });
    const res = await p.discoverCompanies(q({ country: 'United Kingdom' }, ['Pumps']), CTX);
    expect(res).toEqual({ records: [], costCents: 0 });
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('非 GB 目标查询 → 空（CH 只覆盖英国辖区，fail-safe 不发请求）', async () => {
    const broker = fakeBroker(async () => ({ companies: [hit()] }));
    const p = new CompaniesHouseRegistryDiscoveryProvider({ broker, env: ENV_ON });
    expect((await p.discoverCompanies(q({ country: 'Germany' }, ['Pumpen']), CTX)).records).toEqual([]);
    expect((await p.discoverCompanies(q({}, ['Pumps']), CTX)).records).toEqual([]);
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('无检索词 → 空（绝不裸拉全库）', async () => {
    const broker = fakeBroker(async () => ({ companies: [hit()] }));
    const p = new CompaniesHouseRegistryDiscoveryProvider({ broker, env: ENV_ON });
    expect((await p.discoverCompanies(q({ country: 'UK' }), CTX)).records).toEqual([]);
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('无 broker → fail-closed：空且零出网', async () => {
    const p = new CompaniesHouseRegistryDiscoveryProvider({ env: ENV_ON });
    const res = await p.discoverCompanies(q({ country: 'uk' }, ['Pumps']), CTX);
    expect(res.records).toEqual([]);
    expect(res.lineage).toMatchObject({ recordCount: 0 });
  });

  it('Broker 放行 → 经 companies_house.search（op=search）检索并映射，透传归属与 purpose=discovery', async () => {
    const broker = fakeBroker(async () => ({ companies: [hit()] }));
    const p = new CompaniesHouseRegistryDiscoveryProvider({ broker, env: ENV_ON });
    const res = await p.discoverCompanies(q({ country: 'United Kingdom' }, ['Pumps']), CTX);
    expect(broker.invokeMock).toHaveBeenCalledOnce();
    const [toolId, input, toolCtx] = broker.invokeMock.mock.calls[0] as [
      string,
      { op: string; query: string; limit: number },
      ToolContext,
    ];
    expect(toolId).toBe('companies_house.search');
    expect(input).toMatchObject({ op: 'search', query: 'Pumps', limit: 25 });
    expect(toolCtx).toMatchObject({ workspaceId: 'ws-1', runId: 'run-1', purpose: 'discovery' });
    expect(res.records).toHaveLength(1);
    expect(res.records[0]!.name).toBe('ACME PUMPS LTD');
  });

  it('Broker 拒绝（SUSPENDED/未登记/用途门 → invoke 抛错）→ fail-safe 空结果', async () => {
    const broker = fakeBroker(async () => {
      throw new Error(
        'tool companies_house.search denied: source_policy unregistered: api.company-information.service.gov.uk',
      );
    });
    const p = new CompaniesHouseRegistryDiscoveryProvider({ broker, env: ENV_ON });
    const res = await p.discoverCompanies(q({ country: 'uk' }, ['Pumps']), CTX);
    expect(res.records).toEqual([]);
    expect(res.costCents).toBe(0);
    expect(broker.invokeMock).toHaveBeenCalledOnce();
  });

  it('回放不可用（BudgetOperationReplayError）绝不转成空成功源结果', async () => {
    const broker = fakeBroker(async () => {
      throw new BudgetOperationReplayError('ch-op');
    });
    const p = new CompaniesHouseRegistryDiscoveryProvider({ broker, env: ENV_ON });
    await expect(p.discoverCompanies(q({ country: 'uk' }, ['Pumps']), CTX)).rejects.toBeInstanceOf(
      BudgetOperationReplayError,
    );
  });
});
