import { describe, expect, it, vi } from 'vitest';
import type { BudgetStore } from '../tools/budget-store';
import { IcpService } from './icp.service';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const COMPANY_ID = '20000000-0000-4000-8000-000000000001';
const binding = Object.freeze({
  authorityId: '30000000-0000-4000-8000-000000000001',
  replay: false,
  scopeKey: WORKSPACE_ID,
  accountKey: `icp.design:company:${COMPANY_ID}:${'a'.repeat(64)}`,
  purpose: 'icp.design' as const,
  subjectType: 'company',
  subjectId: COMPANY_ID,
  requestSha256: 'a'.repeat(64),
});

describe('IcpService receipt-aware domain consumer', () => {
  it('persists an unreceipted pre-cutover model result in the existing workspace transaction', async () => {
    const icpCreate = vi.fn(async () => ({ id: '40000000-0000-4000-8000-000000000001' }));
    const personaCreate = vi.fn(async () => ({}));
    const roleCreate = vi.fn(async () => ({}));
    const ruleCreate = vi.fn(async () => ({}));
    const tx = {
      companyProfile: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === COMPANY_ID
            ? { id: COMPANY_ID, name: 'Pump GmbH', website: 'https://pump.example' }
            : null),
      },
      claim: { findMany: vi.fn(async () => [{ type: 'product', statement: 'Makes pumps' }]) },
      offering: { findMany: vi.fn(async () => []) },
      icpDefinition: {
        create: icpCreate,
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id, name: 'Pump buyers', personas: [], roles: [], rules: [],
        })),
      },
      persona: { create: personaCreate },
      buyingCommitteeRole: { create: roleCreate },
      qualificationRule: { create: ruleCreate },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, callback: (value: typeof tx) => unknown) =>
        callback(tx)),
    };
    const generateStructured = vi.fn(async () => ({
      data: {
        name: 'Pump buyers', company_attributes: {}, pain_points: [],
        trigger_signals: [], exclusions: [], value_props: [], target_markets: [],
        personas: [{ title: 'Plant manager', goals: [], pain_points: [] }],
        buying_committee: [{ role: 'buyer', title: 'Plant manager', concerns: [] }],
        qualification_rules: [{
          kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'industrial',
          weight: 1, rationale: 'Industrial buyer',
        }],
      },
      provider: 'test',
      model: 'test-model',
    }));
    const authority = { consumeWorkspaceGrant: vi.fn(async () => binding) };
    const budgetStore = {
      attestAuthorized: vi.fn(async () => ({})),
    } as unknown as BudgetStore;
    const service = new IcpService(
      prisma as never,
      { generateStructured } as never,
      {} as never,
      authority as never,
      budgetStore,
    );

    await expect(service.generateFromCompany({
      workspaceId: WORKSPACE_ID,
      userId: '50000000-0000-4000-8000-000000000001',
    } as never, COMPANY_ID, 'signed-grant')).resolves.toMatchObject({
      name: 'Pump buyers',
    });
    expect(icpCreate).toHaveBeenCalledOnce();
    expect(personaCreate).toHaveBeenCalledOnce();
    expect(roleCreate).toHaveBeenCalledOnce();
    expect(ruleCreate).toHaveBeenCalledOnce();
    expect(budgetStore.attestAuthorized).toHaveBeenCalledWith({
      authorityId: binding.authorityId,
      scopeKey: binding.scopeKey,
      accountKey: binding.accountKey,
    });
  });

  it('persists an unreceipted query plan through the same transaction', async () => {
    const icpId = '60000000-0000-4000-8000-000000000001';
    const queryBinding = {
      ...binding,
      accountKey: `icp.query_plan:icp:${icpId}:${'b'.repeat(64)}`,
      purpose: 'icp.query_plan' as const,
      subjectType: 'icp',
      subjectId: icpId,
      requestSha256: 'b'.repeat(64),
    };
    const planCreate = vi.fn(async () => ({
      id: '70000000-0000-4000-8000-000000000001',
      icpId,
      status: 'DRAFT',
    }));
    const tx = {
      icpDefinition: { findUnique: vi.fn(async () => ({
        id: icpId,
        name: 'Pump buyers',
        status: 'ACTIVE',
        companyAttributes: {},
        targetMarkets: [],
        triggerSignals: [],
        exclusions: [],
        rules: [],
      })) },
      discoveryQueryPlan: {
        create: planCreate,
        findUniqueOrThrow: vi.fn(),
      },
      canonicalTaxonomy: { findMany: vi.fn(async () => []) },
      termAlias: { findUnique: vi.fn(async () => null) },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, callback: (value: typeof tx) => unknown) =>
        callback(tx)),
    };
    const gateway = { generateStructured: vi.fn(async () => ({
      data: { queries: [], estimated_volume: 0 },
      provider: 'test', model: 'test-model',
    })) };
    const authority = { consumeWorkspaceGrant: vi.fn(async () => queryBinding) };
    const budgetStore = { attestAuthorized: vi.fn(async () => ({})) } as unknown as BudgetStore;
    const service = new IcpService(
      prisma as never,
      gateway as never,
      {} as never,
      authority as never,
      budgetStore,
    );

    await expect(service.generateQueryPlan({
      workspaceId: WORKSPACE_ID,
      userId: '50000000-0000-4000-8000-000000000001',
    } as never, icpId, 'signed-grant')).resolves.toMatchObject({
      icpId, status: 'DRAFT',
    });
    expect(planCreate).toHaveBeenCalledOnce();
  });
});
