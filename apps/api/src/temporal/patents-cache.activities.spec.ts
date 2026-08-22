import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { BudgetStore } from '../tools/budget-store';
import type { ExecutionBroker } from '../tools/tool-contract';
import { createPatentsCacheActivities } from './patents-cache.activities';
import { PLATFORM_SCHEDULE_AUTHORITY_SCOPES } from './platform-schedule-authority';

const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['patents-cache-refresh'];
const binding = {
  authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  scopeKey: 'platform' as const,
  accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
  ...scope,
  workflowRunId: 'workflow-run-1',
  admissionReplay: false,
};

describe('patents cache schedule authority and ToolBroker route', () => {
  it('contains no direct BigQuery singleton import or batch scanner call', async () => {
    const source = await readFile(new URL('./patents-cache.activities.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("from '../adapters/bigquery-patents'");
    expect(source).not.toContain('bigqueryPatents');
    expect(source).not.toContain('searchInventorsForAnchorsWithStats');
    expect(source).toContain("broker.invoke('google_patents.search'");
  });

  it('attests before any cache read/write or ToolBroker invocation', async () => {
    const order: string[] = [];
    const attestAuthorized = vi.fn(async () => {
      order.push('attest');
      return {
        accountId: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
        authorityId: binding.authorityId,
        authorizedCapMicrousd: 1_000_000n,
        generation: 1,
      };
    });
    const ownerDb = {
      patentInventorCache: { deleteMany: vi.fn(async () => { order.push('db'); return { count: 0 }; }) },
      dataProvider: { findUnique: vi.fn(async () => ({ status: 'DISABLED' })) },
      patentCacheRefreshAudit: { create: vi.fn(async () => ({})) },
    } as unknown as PrismaClient;
    const broker = { invoke: vi.fn(async () => { order.push('wire'); return { data: { patents: [] }, costCents: 0 }; }) } as unknown as ExecutionBroker;
    const activities = createPatentsCacheActivities({
      ownerDb,
      broker,
      budgetStore: { attestAuthorized } as unknown as BudgetStore,
    });

    await expect(activities.refreshPatentCacheActivity({
      executionContractVersion: 1,
      executionBudget: binding,
      maxAnchors: 1,
    })).resolves.toMatchObject({ status: 'DISABLED' });
    expect(order[0]).toBe('attest');
    expect(broker.invoke).not.toHaveBeenCalled();
  });
});
