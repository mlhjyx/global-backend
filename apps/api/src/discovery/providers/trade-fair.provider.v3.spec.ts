import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryV3Dispatch } from '../../runtime/discovery-v3-dispatch-contract';
import type { ExecutionBroker, ToolResult } from '../../tools/tool-contract';
import { withDiscoveryV3OperationScope } from '../discovery-v3-operation-scope';
import { DiscoveryV3OperationStore } from '../discovery-v3-operations';
import type { CompanyDiscoveryQuery } from '../provider-contract';
import { TradeFairDiscoveryProvider } from './trade-fair.provider';

const command: DiscoveryV3Dispatch = {
  executionContractVersion: 3,
  workspaceId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  runId: '693de0dc-5474-4d19-9270-83694bfeea09',
  planId: '26bdf359-1954-4838-9d88-7bdf6c46f899',
  icpId: '5254f63d-4423-4e90-8153-2809f2fe0d86',
  attemptId: '5d27c20b-e46d-450a-bf45-9f5bd42296a3',
  requestSha256: '0'.repeat(64),
  taskQueue: 'batch-discovery',
  dispatchExpiresAt: '2026-11-27T12:00:00.000Z',
};

const query: CompanyDiscoveryQuery = {
  sourceClass: 'industry_data', filters: { industry: 'sheet metal working' }, keywords: ['laser cutting'], limit: 200,
};
const fairSlug = 'euroblech-2026';

function discover(invoke: ExecutionBroker['invoke']) {
  const provider = new TradeFairDiscoveryProvider({ broker: {
    invoke, checkSourcePolicy: async () => ({ allowed: true }),
  } });
  const context = { workspaceId: command.workspaceId, runId: command.runId };
  const store = new DiscoveryV3OperationStore({ withWorkspace: async () => { throw new Error('unexpected operation-store call'); } });
  return withDiscoveryV3OperationScope({
    command, step: 'query/0/trade_fair', store, signal: new AbortController().signal,
  }, () => provider.discoverCompanies(query, context));
}

function fairPage(page: number, hasNextPage: boolean, slug = fairSlug): ToolResult<unknown> {
  return {
    data: {
      exhibitors: [{ externalId: String(page), companyName: `Fixture company ${page}`, products: [] }],
      pagination: { fairSlug: slug, page, hasNextPage },
    },
    costCents: 0,
  };
}

describe('native Algolia provider paging', () => {
  it('uses a stable page size and stops when the recorded result exhausts the fair', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(fairPage(0, true)).mockResolvedValueOnce(fairPage(1, false));
    const result = await discover(invoke);
    expect(invoke.mock.calls.map(([id, input]) => [id, { fairSlug: input.fairSlug, page: input.page, limit: input.limit }])).toEqual([
      ['tradefair.algolia', { fairSlug, page: 0, limit: 50 }],
      ['tradefair.algolia', { fairSlug, page: 1, limit: 50 }],
    ]);
    expect(result.records.map((record) => record.externalId)).toEqual([`${fairSlug}:0`, `${fairSlug}:1`]);
  });

  it('halts when a result cannot prove it belongs to the requested fair page', async () => {
    const invoke = vi.fn().mockResolvedValue(fairPage(0, true, 'unregistered-fair'));
    await expect(discover(invoke)).rejects.toThrow('DISCOVERY_V3_ALGOLIA_PAGE_BINDING_MISMATCH');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('does not resend a failed page or advance past it', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(fairPage(0, true)).mockRejectedValueOnce(new Error('fixture wire unresolved'));
    await expect(discover(invoke)).rejects.toThrow('fixture wire unresolved');
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
