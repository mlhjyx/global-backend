import { describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from '../../durable-results/durable-execution-receipt';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import { parseDiscoveryCompanyResultLineage } from '../company-discovery-lineage';
import { WikidataDiscoveryProvider } from './wikidata.provider';

const CTX = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
};

let operationCounter = 200;
function receipt(resultSchema: string): DurableExecutionReceipt {
  operationCounter += 1;
  const suffix = (operationCounter % 256).toString(16).padStart(2, '0');
  return {
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: CTX.workspaceId,
    authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
    accountId: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
    operationId: `1b3d6096-b924-4bc8-bb4f-8436efb3${suffix}dd`,
    operationKey: `tool:${resultSchema}:${suffix}`,
    resultStrategy: 'typed_projection',
    resultSchema,
    resultDigest: 'a'.repeat(63) + (operationCounter % 10),
    artifactId: null,
    usage: {
      currency: 'USD',
      unit: 'microusd',
      callCount: 1,
      chargedMicrousd: '0',
      upperBoundMicrousd: '0',
    },
    costBasis: 'estimated_upper_bound',
    status: 'SETTLED',
  };
}

function fakeBroker(data: unknown = {
  companies: [
    { qid: 'Q1', name: 'Alpha GmbH', website: 'https://alpha.de' },
    { qid: 'Q2', name: 'Beta AG', website: 'https://beta.de' },
  ],
}): ExecutionBroker & { invokeMock: ReturnType<typeof vi.fn> } {
  const invokeMock = vi.fn(
    async (toolId: string, _input: unknown, ctx: ToolContext) => {
      if (toolId !== 'wikidata.sparql') throw new Error(`unexpected tool ${toolId}`);
      ctx.onDurableReceipt?.('wikidata.sparql', receipt('wikidata-sparql/v1'));
      return { data, costCents: 0 };
    },
  );
  return { invoke: invokeMock, invokeMock } as unknown as ExecutionBroker & {
    invokeMock: ReturnType<typeof vi.fn>;
  };
}

function query(filters: Record<string, unknown>, keywords: string[] = []) {
  return { sourceClass: 'company_registry' as const, filters, keywords, limit: 5 };
}

describe('wikidata provider：宽行业编号闸门', () => {
  it('窄编号正常出网，broker 收到该编号', async () => {
    const broker = fakeBroker();
    const res = await new WikidataDiscoveryProvider({ broker }).discoverCompanies(
      query({ _industryQids: ['Q192127'], _countryQid: 'Q183' }),
      CTX,
    );
    expect(res.records).toHaveLength(2);
    expect(res.outcome).toBeUndefined();
    expect(broker.invokeMock).toHaveBeenCalledOnce();
    expect(broker.invokeMock.mock.calls[0]![1]).toMatchObject({ industryQids: ['Q192127'], countryQid: 'Q183' });
  });

  it('只有宽编号时不出网，返回 EMPTY_RESULT/INDUSTRY_QID_TOO_BROAD（lineage 仍有效）', async () => {
    const broker = fakeBroker();
    const res = await new WikidataDiscoveryProvider({ broker }).discoverCompanies(
      query({ _industryQids: ['Q187939'], _countryQid: 'Q183' }),
      CTX,
    );
    expect(broker.invokeMock).not.toHaveBeenCalled();
    expect(res.records).toEqual([]);
    expect(res.outcome).toEqual({ errorClass: 'EMPTY_RESULT', reasonCode: 'INDUSTRY_QID_TOO_BROAD' });
    expect(parseDiscoveryCompanyResultLineage(res.lineage, 'wikidata').recordCount).toBe(0);
  });

  it('注入空列表是权威的：不回退到内置词表，并给出过宽原因', async () => {
    const broker = fakeBroker();
    const res = await new WikidataDiscoveryProvider({ broker }).discoverCompanies(
      query({ _industryQids: [], industry: '制造业', _countryQid: 'Q183' }),
      CTX,
    );
    expect(broker.invokeMock).not.toHaveBeenCalled();
    expect(res.records).toEqual([]);
    expect(res.outcome).toEqual({ errorClass: 'EMPTY_RESULT', reasonCode: 'INDUSTRY_QID_TOO_BROAD' });
  });

  it('回退词表产出的大类编号（如 Q1857831）同样被拒绝', async () => {
    const broker = fakeBroker();
    const res = await new WikidataDiscoveryProvider({ broker }).discoverCompanies(
      query({ industry: '机械制造', country: 'germany' }),
      CTX,
    );
    expect(broker.invokeMock).not.toHaveBeenCalled();
    expect(res.outcome).toEqual({ errorClass: 'EMPTY_RESULT', reasonCode: 'INDUSTRY_QID_TOO_BROAD' });
  });

  it('活动层注入的具体节点即使映射到宽 QID 也放行（钣金 2599 → Q1857831）', async () => {
    const broker = fakeBroker();
    const res = await new WikidataDiscoveryProvider({ broker }).discoverCompanies(
      query({ _industryQids: ['Q1857831'], _countryQid: 'Q183' }),
      CTX,
    );
    expect(broker.invokeMock).toHaveBeenCalledOnce();
    expect(broker.invokeMock.mock.calls[0]![1]).toMatchObject({ industryQids: ['Q1857831'] });
    expect(res.outcome).toBeUndefined();
  });

  it('混合列表只把窄编号传给 broker', async () => {
    const broker = fakeBroker();
    const res = await new WikidataDiscoveryProvider({ broker }).discoverCompanies(
      query({ _industryQids: ['Q187939', 'Q192127', 'Q187939'], _countryQid: 'Q183' }),
      CTX,
    );
    expect(res.outcome).toBeUndefined();
    expect(broker.invokeMock).toHaveBeenCalledOnce();
    expect(broker.invokeMock.mock.calls[0]![1]).toMatchObject({ industryQids: ['Q192127'] });
  });

  it('内置词表回退同样受闸门约束（制造业 → 空结果）', async () => {
    const broker = fakeBroker();
    const res = await new WikidataDiscoveryProvider({ broker }).discoverCompanies(
      query({ industry: '制造业', country: 'germany' }),
      CTX,
    );
    expect(broker.invokeMock).not.toHaveBeenCalled();
    expect(res.outcome).toEqual({ errorClass: 'EMPTY_RESULT', reasonCode: 'INDUSTRY_QID_TOO_BROAD' });
  });

  it('off 模式放行宽编号', async () => {
    const broker = fakeBroker();
    const res = await new WikidataDiscoveryProvider({ broker, broadIndustryMode: 'off' }).discoverCompanies(
      query({ _industryQids: ['Q187939'], _countryQid: 'Q183' }),
      CTX,
    );
    expect(broker.invokeMock).toHaveBeenCalledOnce();
    expect(broker.invokeMock.mock.calls[0]![1]).toMatchObject({ industryQids: ['Q187939'] });
    expect(res.outcome).toBeUndefined();
  });

  it('没有任何行业词时维持现状：空结果且无 outcome', async () => {
    const broker = fakeBroker();
    const res = await new WikidataDiscoveryProvider({ broker }).discoverCompanies(query({}), CTX);
    expect(broker.invokeMock).not.toHaveBeenCalled();
    expect(res.records).toEqual([]);
    expect(res.outcome).toBeUndefined();
  });

  it('无 broker 时维持 fail-closed', async () => {
    const res = await new WikidataDiscoveryProvider({}).discoverCompanies(
      query({ _industryQids: ['Q192127'], _countryQid: 'Q183' }),
      CTX,
    );
    expect(res.records).toEqual([]);
    expect(res.outcome).toBeUndefined();
  });
});
