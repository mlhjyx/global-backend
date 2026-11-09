import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
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
  nace: '28.13Z',
  naceVersion: null,
  employeeBand: '10-49',
  legalForm: 'sas',
  status: 'ACTIVE',
  website: null,
  identifiers: null,
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
