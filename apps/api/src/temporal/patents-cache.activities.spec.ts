import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { BudgetStore } from '../tools/budget-store';
import type { ExecutionBroker } from '../tools/tool-contract';
import { PATENT_CACHE_BROKER_MAX_ANCHORS, createPatentsCacheActivities } from './patents-cache.activities';
import { PLATFORM_SCHEDULE_AUTHORITY_SCOPES } from './platform-schedule-authority';
import { googlePatentsSearchTool } from '../tools/source-tools';

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
  it('does not copy personal patent names into the generic budget replay JSON', () => {
    expect(googlePatentsSearchTool.compliance.personalData).toBe(true);
    expect(googlePatentsSearchTool.durableReplayResult).toBeUndefined();
  });

  it('caps product refresh fan-out independently of a larger schedule payload', () => {
    expect(PATENT_CACHE_BROKER_MAX_ANCHORS).toBe(25);
  });

  it('contains no direct BigQuery singleton import or batch scanner call', async () => {
    const [activitySource, scannerSource] = await Promise.all([
      readFile(new URL('./patents-cache.activities.ts', import.meta.url), 'utf8'),
      readFile(new URL('./patent-cache-broker-scanner.ts', import.meta.url), 'utf8'),
    ]);
    expect(activitySource).not.toContain("from '../adapters/bigquery-patents'");
    expect(activitySource).not.toContain('bigqueryPatents');
    expect(scannerSource).not.toContain('bigqueryPatents');
    expect(scannerSource).toContain('google_patents.search');
    expect(scannerSource).toContain('input.broker.invoke');
  });

  it('parks a pending pre-cutover activity before cache mutation or broker invocation', async () => {
    const deleteMany = vi.fn();
    const broker = { invoke: vi.fn() } as unknown as ExecutionBroker;
    const activities = createPatentsCacheActivities({
      ownerDb: { patentInventorCache: { deleteMany } } as unknown as PrismaClient,
      broker,
      budgetStore: { attestAuthorized: vi.fn() } as unknown as BudgetStore,
      activityRunId: () => 'workflow-run-1',
    });
    await expect(activities.refreshPatentCacheActivity()).rejects.toMatchObject({ type: 'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED', nonRetryable: true });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(broker.invoke).not.toHaveBeenCalled();
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
      activityRunId: () => 'workflow-run-1',
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
