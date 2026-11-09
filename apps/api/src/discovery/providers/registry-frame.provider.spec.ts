import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { parseDiscoveryCompanyResultLineage } from '../company-discovery-lineage';
import { parseDurableExecutionReceipt } from '../../durable-results/durable-execution-receipt';
import { buildGovernedDiscoveryQueryExecutionPlan } from '../../temporal/discovery-query-governed-execution';
import type { RegistryQueryRow } from '../../registry/query';
import type { CompanyDiscoveryQuery, ExecutionContext } from '../provider-contract';
import { RegistryFrameDiscoveryProvider } from './registry-frame.provider';

const ctx = { workspaceId: '11111111-1111-4111-8111-111111111111' } as ExecutionContext;

const row: RegistryQueryRow = {
  scheme: 'fr_siren',
  regNumber: '529990001',
  country: 'FR',
  name: 'POMPES MARTIN SAS',
  region: null,
  nace: '28.13',
  naceVersion: 'NAF-rev2',
  employeeBand: '10-49',
  legalForm: 'sas',
  status: 'ACTIVE',
  website: null,
  identifiers: null,
  attributes: { diffusionCommerciale: 'true' },
  lastSnapshotId: 'snap-1',
  sourceFrame: { frameKey: 'fr_sirene', licence: 'Licence-Ouverte-2.0' },
};

function query(filters: Record<string, unknown>): CompanyDiscoveryQuery {
  return { sourceClass: 'company_registry', filters, keywords: [], limit: 25 };
}

describe('RegistryFrameDiscoveryProvider (T3-09 registration surface)', () => {
  it('is a company_registry source that deliberately declares no company lineage', () => {
    const provider = new RegistryFrameDiscoveryProvider();
    expect(provider.key).toBe('registry_frame');
    expect(provider.classes).toEqual(['company_registry']);
    // 零出网 → 无 durable 回执 → 不能声明血缘；路由闸门因此恒排除它（有测试钉死）。
    expect(provider.companyResultLineage).toBeUndefined();
  });

  it('returns empty honestly without a database client', async () => {
    const provider = new RegistryFrameDiscoveryProvider();
    await expect(provider.discoverCompanies(query({ country: 'FR' }), ctx)).resolves.toEqual({
      records: [],
      costCents: 0,
    });
  });

  it('maps whitelisted plan filters to the local query and costs zero', async () => {
    const calls: unknown[] = [];
    const prisma = {
      registryEntity: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return [row];
        },
      },
    } as unknown as PrismaClient;
    const provider = new RegistryFrameDiscoveryProvider({ prisma });

    const result = await provider.discoverCompanies(
      query({
        country: 'fr',
        nace_prefix: ['28.13'],
        employee_band: ['10-49'],
        legal_form: ['sas'],
        postal_prefix: '69',
        // 计划侧归一注入的自由字段必须被忽略，而不是拒绝整条查询。
        industry: 'pumps',
        _industryCodes: ['C28'],
        source_hint: 'registry_frame',
      }),
      ctx,
    );

    expect(result.costCents).toBe(0);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      externalId: 'fr_siren:529990001',
      country: 'FR',
      employeeCount: 25,
      license: 'Licence-Ouverte-2.0',
      identifier: { scheme: 'fr_siren', value: '529990001' },
      attributes: {
        registry: expect.objectContaining({
          sourceAttributes: { diffusionCommerciale: 'true' },
        }),
      },
    });
    expect(calls).toHaveLength(1);
    const args = calls[0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
      take: number;
    };
    expect(args.where).toMatchObject({
      country: 'FR',
      status: 'ACTIVE',
      withdrawnAt: null,
      employeeBand: { in: ['10-49'] },
      postalCode: { startsWith: '69' },
    });
    expect(args.orderBy).toEqual([{ scheme: 'asc' }, { regNumber: 'asc' }]);
    expect(args.take).toBe(25);
  });

  it('derives NACE prefixes from ICP industry terms / taxonomy codes when no explicit prefix is given', async () => {
    const calls: Array<{ where: Record<string, unknown> }> = [];
    const prisma = {
      registryEntity: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          calls.push(args);
          return [];
        },
      },
    } as unknown as PrismaClient;
    const provider = new RegistryFrameDiscoveryProvider({ prisma });

    await provider.discoverCompanies(query({ country: 'DE', industry: 'Kreiselpumpen' }), ctx);
    // ISIC C28（机械制造/泵/阀）→ NACE 前缀 28（含无点号与点号两种形态由 query 层展开）。
    expect(calls[0]!.where.OR).toEqual([
      { nace: { startsWith: '28' } },
    ]);

    await provider.discoverCompanies(query({ country: 'DE', _industryCodes: ['28'] }), ctx);
    expect(calls[1]!.where.OR).toEqual([{ nace: { startsWith: '28' } }]);

    // 显式 nace_prefix 优先，不再看行业词。
    await provider.discoverCompanies(
      query({ country: 'DE', industry: 'Kreiselpumpen', nace_prefix: ['2813'] }),
      ctx,
    );
    // 显式 4 位码先归一到 NACE 类目形态，与库内点号存储精确对齐。
    expect(calls[2]!.where.OR).toEqual([{ nace: { startsWith: '28.13' } }]);
  });

  it('fails safe to an empty result when the filters cannot satisfy the contract', async () => {
    const prisma = {
      registryEntity: {
        findMany: async () => {
          throw new Error('must not query with invalid filters');
        },
      },
    } as unknown as PrismaClient;
    const provider = new RegistryFrameDiscoveryProvider({ prisma });
    await expect(provider.discoverCompanies(query({ country: 'Germany' }), ctx)).resolves.toEqual({
      records: [],
      costCents: 0,
    });
  });
});

describe('local_query lineage mode (A 方案)', () => {
  const AUTHORITY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  const prismaReturning = (rows: RegistryQueryRow[]) =>
    ({
      registryEntity: { findMany: async () => rows },
    }) as unknown as PrismaClient;

  const lineageCtx = () => {
    const receipts: Array<{ producerId: string; receipt: unknown }> = [];
    return {
      receipts,
      ctx: {
        workspaceId: AUTHORITY,
        runId: RUN,
        durableBudgetAuthority: { authorityId: AUTHORITY, accountId: ACCOUNT },
        onDurableReceipt: (producerId: string, receipt: unknown) => {
          receipts.push({ producerId, receipt });
        },
      } as ExecutionContext,
    };
  };

  it('declares company lineage only when the flag is on', () => {
    expect(new RegistryFrameDiscoveryProvider().companyResultLineage).toBeUndefined();
    expect(
      new RegistryFrameDiscoveryProvider({ lineageEnabled: true }).companyResultLineage,
    ).toBe('discovery-company-result-lineage/v1');
  });

  it('emits a deterministic local receipt + lineage and reports it through the callback', async () => {
    const provider = new RegistryFrameDiscoveryProvider({
      prisma: prismaReturning([row]),
      lineageEnabled: true,
    });
    const first = lineageCtx();
    const resultOnce = await provider.discoverCompanies(query({ country: 'FR' }), first.ctx);
    const second = lineageCtx();
    const resultTwice = await provider.discoverCompanies(query({ country: 'FR' }), second.ctx);

    expect(resultOnce.records).toHaveLength(1);
    expect(resultOnce.costCents).toBe(0);
    expect(first.receipts).toHaveLength(1);
    expect(first.receipts[0]!.producerId).toBe('registry.query');

    const parsedLineage = parseDiscoveryCompanyResultLineage(resultOnce.lineage, 'registry_frame');
    expect(parsedLineage.recordCount).toBe(1);
    expect(parsedLineage.receiptCoverage[0]!.recordIndexes).toEqual([0]);
    const receipt = parseDurableExecutionReceipt(first.receipts[0]!.receipt);
    expect(receipt.operationId).toBe(parsedLineage.receiptCoverage[0]!.receipt.operationId);

    // 同一 query + 同一数据 → 同一回执身份与 digest（可回放/可复算）。
    const parsedTwice = parseDiscoveryCompanyResultLineage(resultTwice.lineage, 'registry_frame');
    expect(parsedTwice.receiptCoverage[0]!.receipt.operationId).toBe(receipt.operationId);
    expect(parsedTwice.receiptCoverage[0]!.receipt.resultDigest).toBe(receipt.resultDigest);
  });

  it('fails closed without the run budget authority (no forged receipts)', async () => {
    const provider = new RegistryFrameDiscoveryProvider({
      prisma: prismaReturning([row]),
      lineageEnabled: true,
    });
    const result = await provider.discoverCompanies(query({ country: 'FR' }), {
      workspaceId: AUTHORITY,
      runId: RUN,
    } as ExecutionContext);
    expect(result.records).toEqual([]);
    expect(result.costCents).toBe(0);
    expect(parseDiscoveryCompanyResultLineage(result.lineage, 'registry_frame').recordCount).toBe(0);
  });

  it('keeps a valid empty lineage when filters cannot satisfy the contract', async () => {
    const provider = new RegistryFrameDiscoveryProvider({
      prisma: prismaReturning([row]),
      lineageEnabled: true,
    });
    const { ctx, receipts } = lineageCtx();
    const result = await provider.discoverCompanies(query({ country: 'Germany' }), ctx);
    expect(result.records).toEqual([]);
    expect(receipts).toEqual([]);
    expect(parseDiscoveryCompanyResultLineage(result.lineage, 'registry_frame').recordCount).toBe(0);
  });

  it('is accepted by the governed execution plan end to end (in-memory)', async () => {
    const provider = new RegistryFrameDiscoveryProvider({
      prisma: prismaReturning([row]),
      lineageEnabled: true,
    });
    const { ctx, receipts } = lineageCtx();
    const result = await provider.discoverCompanies(query({ country: 'FR' }), ctx);
    const plan = buildGovernedDiscoveryQueryExecutionPlan({
      lineageEnabled: true,
      adapters: [provider],
      settled: [
        {
          status: 'fulfilled',
          value: {
            key: 'registry_frame',
            r: result,
            durableReceipts: receipts as never,
          },
        },
      ],
    });
    expect(plan.mode).toBe('governed');
    if (plan.mode !== 'governed') return;
    expect(plan.providerPlan.providers).toEqual(['registry_frame']);
    expect(plan.providerPlan.attempts).toHaveLength(1);
    expect(plan.providerPlan.attempts[0]).toMatchObject({
      providerKey: 'registry_frame',
      producerId: 'registry.query',
      recordIndexes: [0],
      providerRecordCount: 1,
    });
  });
});
